-- 10 · Clientes por @usuario de WhatsApp o dirección · Promociones y descuentos ·
--      Pagos por QR con comprobante · Facturas leídas por foto
-- Se puede volver a ejecutar sin problema.

-- ============ 1) Clientes: celular, @usuario de WhatsApp o dirección ============
create or replace function public.norm_addr(t text) returns text
language sql immutable as $$
  select btrim(regexp_replace(translate(lower(coalesce(t,'')), 'áéíóúüñ', 'aeiouun'), '[^a-z0-9]+', ' ', 'g'))
$$;

drop function if exists public.upsert_customer(text, text, text);
create or replace function public.upsert_customer(p_phone text, p_wa_user text, p_name text, p_address text)
returns text language plpgsql security definer set search_path = public as $$
declare d text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
        w text := lower(regexp_replace(coalesce(p_wa_user, ''), '\s', '', 'g'));
        a text := btrim(coalesce(p_address, ''));
        an text; cid text;
begin
  if not (public.has_perm('ventas.crear') or public.has_perm('clientes.editar')) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Falta el nombre del cliente'; end if;
  if d <> '' then
    if length(d) = 10 then d := '57' || d; end if;
    if not (length(d) = 12 and d like '57%') then raise exception 'Celular inválido: deben ser 10 dígitos'; end if;
  end if;
  if w <> '' then
    if left(w, 1) <> '@' then w := '@' || w; end if;
    if w !~ '^@[a-z0-9._]{3,30}$' then
      raise exception 'Usuario de WhatsApp inválido: empieza con @ y usa letras, números, punto o guion bajo (3 a 30)';
    end if;
  end if;
  an := public.norm_addr(a);
  if d = '' and w = '' and an = '' then
    raise exception 'Escribe la dirección, el usuario de WhatsApp o el celular del cliente';
  end if;
  perform pg_advisory_xact_lock(hashtext('tomates-customers'));
  if d <> '' then
    select id into cid from public.customers
     where right(regexp_replace(coalesce(data->>'phone',''), '\D', '', 'g'), 10) = right(d, 10)
     order by created_at limit 1;
  end if;
  if cid is null and w <> '' then
    select id into cid from public.customers where lower(coalesce(data->>'waUser','')) = w order by created_at limit 1;
  end if;
  if cid is null and an <> '' then
    select id into cid from public.customers where public.norm_addr(data->>'address') = an order by created_at limit 1;
  end if;
  if cid is null then
    insert into public.customers (data)
    values (jsonb_build_object('name', btrim(p_name), 'phone', d, 'waUser', w, 'address', a, 'notes', ''))
    returning id into cid;
  else
    update public.customers
       set data = data || jsonb_build_object('name', btrim(p_name))
                       || case when a <> '' then jsonb_build_object('address', a) else '{}'::jsonb end
                       || case when d <> '' then jsonb_build_object('phone', d) else '{}'::jsonb end
                       || case when w <> '' then jsonb_build_object('waUser', w) else '{}'::jsonb end
     where id = cid;
  end if;
  return cid;
end $$;
revoke all on function public.upsert_customer(text, text, text, text) from public, anon;
grant execute on function public.upsert_customer(text, text, text, text) to authenticated;

-- ============ 2) Permisos nuevos ============
insert into public.permissions (key, module, label, sort) values
  ('promos.gestionar',        'Ventas', 'Crear y editar promociones', 18),
  ('ventas.descuento_libre',  'Ventas', 'Dar descuentos libres (sin promoción)', 19),
  ('pagos.confirmar',         'Ventas', 'Confirmar o rechazar pagos por QR', 20)
on conflict (key) do update set module = excluded.module, label = excluded.label, sort = excluded.sort;
-- Por defecto solo el administrador (lo tiene todo). Se pueden dar a otros roles en Usuarios → permisos.

-- ============ 3) Promociones ============
create table if not exists public.promotions (
  id text primary key default gen_random_uuid()::text,
  name text not null check (length(btrim(name)) > 0),
  kind text not null check (kind in ('pct','fixed')),
  value numeric not null check (value > 0),
  active boolean not null default true,
  starts_on date,
  ends_on date,
  weekdays int[] not null default '{}',   -- 1 = lunes … 7 = domingo; vacío = todos los días
  note text not null default '',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  check (kind <> 'pct' or value <= 100)
);
alter table public.promotions enable row level security;
drop policy if exists p_read on public.promotions;
drop policy if exists p_write on public.promotions;
create policy p_read on public.promotions for select to authenticated using (public.is_staff());
create policy p_write on public.promotions for all to authenticated
  using (public.has_perm('promos.gestionar')) with check (public.has_perm('promos.gestionar'));
do $$ begin
  begin alter publication supabase_realtime add table public.promotions; exception when others then null; end;
end $$;

create or replace function public.promo_valid_today(p public.promotions) returns boolean
language sql stable as $$
  select p.active
     and (p.starts_on is null or p.starts_on <= (now() at time zone 'America/Bogota')::date)
     and (p.ends_on   is null or p.ends_on   >= (now() at time zone 'America/Bogota')::date)
     and (coalesce(array_length(p.weekdays,1),0) = 0
          or extract(isodow from (now() at time zone 'America/Bogota'))::int = any(p.weekdays))
$$;

-- Regla: un descuento es de una promoción vigente (y coincide con su valor) o es libre (permiso ventas.descuento_libre)
create or replace function public.check_order_discount() returns trigger
language plpgsql security definer set search_path = public as $$
declare d jsonb; items jsonb; amt numeric; sub numeric; p public.promotions; expected numeric;
begin
  if auth.uid() is null then return new; end if;
  if tg_table_name = 'edit_requests' then
    d := new.data->'proposedDiscount'; items := coalesce(new.data->'proposedItems','[]'::jsonb);
  else
    d := new.data->'discount'; items := coalesce(new.data->'items','[]'::jsonb);
    if tg_op = 'UPDATE' then
      if (old.data->'discount') is not distinct from d and (old.data->'items') is not distinct from (new.data->'items') then return new; end if;
      if public.has_perm('ventas.aprobar_cambios') and current_setting('tomates.via_rpc', true) = 'on' then return new; end if;
    end if;
  end if;
  amt := coalesce((d->>'amount')::numeric, 0);
  if amt <= 0 then return new; end if;
  select coalesce(sum(coalesce((it->>'price')::numeric,0) * coalesce((it->>'qty')::numeric,0)),0) into sub
    from jsonb_array_elements(items) it;
  if amt > sub + 1 then raise exception 'El descuento no puede ser mayor que el valor de los productos'; end if;
  if coalesce(d->>'promoId','') <> '' then
    select * into p from public.promotions where id = d->>'promoId';
    if p.id is null then raise exception 'La promoción ya no existe'; end if;
    if tg_op = 'INSERT' and not public.promo_valid_today(p) then raise exception 'La promoción "%" no está vigente hoy', p.name; end if;
    expected := case p.kind when 'pct' then round(sub * p.value / 100) else least(p.value, sub) end;
    if abs(expected - amt) > 1 then raise exception 'El descuento no coincide con la promoción "%"', p.name; end if;
  elsif not public.has_perm('ventas.descuento_libre') then
    raise exception 'Solo el administrador puede dar descuentos sin promoción' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists t_check_discount on public.orders;
create trigger t_check_discount before insert or update on public.orders
  for each row execute function public.check_order_discount();
drop trigger if exists t_check_discount on public.edit_requests;
create trigger t_check_discount before insert on public.edit_requests
  for each row execute function public.check_order_discount();

-- Aprobar un cambio pasa también el descuento (marca via_rpc para que no se valide de nuevo)
create or replace function public.approve_edit_request(p_request_id text)
returns void language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.has_perm('ventas.aprobar_cambios') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  select data into r from public.edit_requests where id = p_request_id for update;
  if r is null or r->>'status' <> 'pendiente' then raise exception 'Solicitud no disponible'; end if;
  perform set_config('tomates.via_rpc', 'on', true);
  update public.orders set data = data || jsonb_build_object(
      'items', r->'proposedItems', 'total', r->'proposedTotal',
      'deliveryFee', coalesce(r->'proposedDeliveryFee', '0'::jsonb),
      'deliveryService', coalesce(r->'proposedDeliveryService', '""'::jsonb),
      'discount', coalesce(r->'proposedDiscount', 'null'::jsonb),
      'discountAmount', coalesce(r->'proposedDiscount'->'amount', '0'::jsonb))
      || jsonb_strip_nulls(jsonb_build_object(
           'orderType', r->'proposedPlace'->'orderType', 'spot', r->'proposedPlace'->'spot',
           'customerId', r->'proposedCustomer'->'customerId', 'customerName', r->'proposedCustomer'->'customerName',
           'customerPhone', r->'proposedCustomer'->'customerPhone', 'customerWaUser', r->'proposedCustomer'->'customerWaUser',
           'customerAddress', r->'proposedCustomer'->'customerAddress'))
   where id = r->>'orderId';
  perform set_config('tomates.via_rpc', 'off', true);
  update public.edit_requests set data = data || jsonb_build_object('status','aprobada','reviewedBy', auth.uid())
   where id = p_request_id;
end $$;

-- ============ 4) Pagos por QR: comprobante y confirmación ============
-- Un pago por QR queda "por_confirmar" hasta que alguien con pagos.confirmar lo revisa.
create or replace function public.check_payment_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if coalesce(new.data->>'paymentStatus','') = 'pagado'
     and coalesce(new.data->>'paymentMethod','') = 'qr'
     and (tg_op = 'INSERT' or coalesce(old.data->>'paymentStatus','') <> 'pagado')
     and current_setting('tomates.via_rpc', true) is distinct from 'on'
     and not public.has_perm('pagos.confirmar') then
    raise exception 'El pago por QR debe confirmarlo el administrador' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists t_check_payment on public.orders;
create trigger t_check_payment before insert or update on public.orders
  for each row execute function public.check_payment_status();

create or replace function public.confirm_qr_payment(p_order_id text, p_ok boolean, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare o jsonb; now_ms bigint := (extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if not public.has_perm('pagos.confirmar') then raise exception 'Sin permiso para confirmar pagos' using errcode = '42501'; end if;
  select data into o from public.orders where id = p_order_id for update;
  if o is null then raise exception 'Pedido no encontrado'; end if;
  if coalesce(o->>'paymentStatus','') <> 'por_confirmar' then raise exception 'Este pago no está pendiente de confirmación'; end if;
  if p_ok then
    o := o || jsonb_build_object('paymentStatus','pagado','paymentConfirmedBy', auth.uid(), 'paymentConfirmedAt', now_ms);
  else
    o := o || jsonb_build_object('paymentStatus','rechazado','paymentRejectedBy', auth.uid(), 'paymentRejectedAt', now_ms,
                                 'paymentRejectedNote', left(coalesce(p_note,''), 200));
  end if;
  perform set_config('tomates.via_rpc', 'on', true);
  update public.orders set data = o where id = p_order_id;
  perform set_config('tomates.via_rpc', 'off', true);
  return o;
end $$;
revoke all on function public.confirm_qr_payment(text, boolean, text) from public, anon;
grant execute on function public.confirm_qr_payment(text, boolean, text) to authenticated;

-- ============ 5) Archivos privados: comprobantes y facturas ============
insert into storage.buckets (id, name, public) values ('comprobantes', 'comprobantes', false), ('facturas', 'facturas', false)
on conflict (id) do nothing;
drop policy if exists comp_insert on storage.objects;
drop policy if exists comp_read on storage.objects;
drop policy if exists fact_insert on storage.objects;
drop policy if exists fact_read on storage.objects;
create policy comp_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'comprobantes' and (public.has_perm('ventas.cobrar') or public.has_perm('pagos.confirmar')));
create policy comp_read on storage.objects for select to authenticated
  using (bucket_id = 'comprobantes' and (public.has_perm('ventas.cobrar') or public.has_perm('pagos.confirmar')));
create policy fact_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'facturas' and public.has_perm('compras.gestionar'));
create policy fact_read on storage.objects for select to authenticated
  using (bucket_id = 'facturas' and public.has_perm('compras.gestionar'));

-- ============ 6) Facturas contabilizadas ============
create table if not exists public.invoices (
  id text primary key default gen_random_uuid()::text,
  supplier text not null default '',
  supplier_nit text not null default '',
  number text not null default '',
  invoice_date date,
  total numeric not null default 0,
  payment_method text not null default '',
  image_path text not null default '',
  read_by_ai boolean not null default false,
  data jsonb not null default '{}'::jsonb,       -- lo que leyó la IA y las líneas confirmadas
  purchase_ids text[] not null default '{}',
  expense_ids text[] not null default '{}',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.invoices enable row level security;
drop policy if exists p_read on public.invoices;
drop policy if exists p_insert on public.invoices;
drop policy if exists p_delete on public.invoices;
create policy p_read on public.invoices for select to authenticated using (public.has_perm('compras.gestionar'));
create policy p_insert on public.invoices for insert to authenticated with check (public.has_perm('compras.gestionar'));
create policy p_delete on public.invoices for delete to authenticated using (public.has_perm('registros.eliminar'));
do $$ begin
  begin alter publication supabase_realtime add table public.invoices; exception when others then null; end;
end $$;

select key, label from public.permissions where key in ('promos.gestionar','ventas.descuento_libre','pagos.confirmar') order by key;
