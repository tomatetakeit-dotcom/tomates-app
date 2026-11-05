-- =====================================================================
-- TOMATES APP — esquema Supabase (v1, 2026-11-05)
-- Cada colección de la app es una tabla con:  id (text) + data (jsonb)
-- para migrar la app sin reescribir su lógica. Roles: admin / cajero /
-- pendiente (cuentas nuevas esperan aprobación del administrador).
-- =====================================================================

-- ---------- Roles y perfiles ----------
do $$ begin
  create type public.app_role as enum ('admin','cajero','pendiente');
exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  email text not null default '',
  role public.app_role not null default 'pendiente',
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create or replace function public.my_role() returns public.app_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
$$;
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('admin','cajero') from public.profiles where id = auth.uid()), false)
$$;

-- La primera cuenta queda como administrador; las demás esperan aprobación.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'name', split_part(coalesce(new.email,''), '@', 1)),
    case when exists (select 1 from public.profiles where role = 'admin')
         then 'pendiente'::public.app_role else 'admin'::public.app_role end
  );
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());
drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists profiles_self_name on public.profiles;
create policy profiles_self_name on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and role = public.my_role());
drop policy if exists profiles_admin_delete on public.profiles;
create policy profiles_admin_delete on public.profiles for delete to authenticated
  using (public.is_admin() and id <> auth.uid());

-- ---------- Tablas de documentos (una por colección de la app) ----------
create or replace function public.touch_row() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['ingredients','recipes','products','categories','purchases',
    'orders','expenses','pending_expenses','counts','customers','edit_requests',
    'cash_register','cash_movements','config']
  loop
    execute format($f$
      create table if not exists public.%1$I (
        id text primary key default gen_random_uuid()::text,
        data jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        updated_by uuid default auth.uid()
      );
      alter table public.%1$I enable row level security;
      alter table public.%1$I replica identity full;
      drop trigger if exists touch on public.%1$I;
      create trigger touch before update on public.%1$I for each row execute function public.touch_row();
      drop policy if exists staff_read on public.%1$I;
      create policy staff_read on public.%1$I for select to authenticated using (public.is_staff());
      drop policy if exists admin_all on public.%1$I;
      create policy admin_all on public.%1$I for all to authenticated
        using (public.is_admin()) with check (public.is_admin());
    $f$, t);
  end loop;
end $$;

-- Índices útiles para informes
create index if not exists orders_date_idx on public.orders ((data->>'date'));
create index if not exists orders_status_idx on public.orders ((data->>'status'));
create index if not exists orders_customer_idx on public.orders ((data->>'customerId'));
create index if not exists expenses_date_idx on public.expenses ((data->>'date'));
create index if not exists purchases_date_idx on public.purchases ((data->>'date'));
create index if not exists cash_mov_date_idx on public.cash_movements ((data->>'date'));

-- ---------- Lo que puede hacer el cajero ----------
-- Pedidos: crear y actualizar estado/cobro. No puede cambiar productos ni total
-- (para eso existe la solicitud de cambio que aprueba el administrador).
drop policy if exists cajero_orders_insert on public.orders;
create policy cajero_orders_insert on public.orders for insert to authenticated
  with check (public.is_staff());
drop policy if exists cajero_orders_update on public.orders;
create policy cajero_orders_update on public.orders for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

create or replace function public.guard_order_edit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and auth.uid() is not null then
    if (old.data->'items') is distinct from (new.data->'items')
       or (old.data->'total') is distinct from (new.data->'total')
       or (old.data->'deliveryFee') is distinct from (new.data->'deliveryFee') then
      raise exception 'Solo el administrador puede cambiar productos o total de un pedido'
        using errcode = '42501';
    end if;
    if (old.data->>'status') = 'entregado' and (new.data->>'status') is distinct from 'entregado' then
      raise exception 'Un pedido entregado no se puede devolver a otro estado' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_order_edit on public.orders;
create trigger guard_order_edit before update on public.orders
  for each row execute function public.guard_order_edit();

drop policy if exists cajero_customers_insert on public.customers;
create policy cajero_customers_insert on public.customers for insert to authenticated
  with check (public.is_staff());
drop policy if exists cajero_customers_update on public.customers;
create policy cajero_customers_update on public.customers for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
drop policy if exists cajero_edit_requests_insert on public.edit_requests;
create policy cajero_edit_requests_insert on public.edit_requests for insert to authenticated
  with check (public.is_staff() and data->>'status' = 'pendiente');

-- ---------- Entregar pedido: descuenta inventario según recetas ----------
create or replace function public.deduct_recipe(p_recipe_id text, p_amount numeric, p_depth int default 0)
returns void language plpgsql security definer set search_path = public as $$
declare r jsonb; it jsonb; y numeric; q numeric;
begin
  if p_depth > 10 or p_recipe_id is null then return; end if;
  select data into r from public.recipes where id = p_recipe_id;
  if r is null then return; end if;
  y := coalesce(nullif((r->>'yieldQty')::numeric, 0), 1);
  for it in select * from jsonb_array_elements(coalesce(r->'items','[]'::jsonb)) loop
    q := coalesce((it->>'qty')::numeric, 0) * p_amount / y;
    if it ? 'subRecipeId' and nullif(it->>'subRecipeId','') is not null then
      perform public.deduct_recipe(it->>'subRecipeId', q, p_depth + 1);
    elsif nullif(it->>'ingredientId','') is not null then
      update public.ingredients
         set data = jsonb_set(data, '{stock}', to_jsonb(coalesce((data->>'stock')::numeric,0) - q))
       where id = it->>'ingredientId';
    end if;
  end loop;
end $$;

create or replace function public.deduct_product(p_product_id text, p_qty numeric)
returns void language plpgsql security definer set search_path = public as $$
declare p jsonb;
begin
  select data into p from public.products where id = p_product_id;
  if p is null then return; end if;
  if nullif(p->>'ingredientId','') is not null then
    update public.ingredients
       set data = jsonb_set(data, '{stock}', to_jsonb(coalesce((data->>'stock')::numeric,0) - p_qty))
     where id = p->>'ingredientId';
  elsif nullif(p->>'recipeId','') is not null then
    perform public.deduct_recipe(p->>'recipeId', p_qty);
  end if;
end $$;

-- La app llama:  supabase.rpc('set_order_status', {p_order_id, p_status})
create or replace function public.set_order_status(p_order_id text, p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o jsonb; it jsonb; now_ms bigint := (extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if not public.is_staff() then raise exception 'Sin permiso' using errcode = '42501'; end if;
  if p_status not in ('pendiente','listo','entregado') then raise exception 'Estado no válido'; end if;
  select data into o from public.orders where id = p_order_id for update;
  if o is null then raise exception 'Pedido no encontrado'; end if;
  if o->>'status' = 'entregado' or o->>'status' = p_status then return o; end if;
  if p_status = 'entregado' then
    for it in select * from jsonb_array_elements(coalesce(o->'items','[]'::jsonb)) loop
      if it->>'type' = 'mitad' then
        perform public.deduct_product(it->>'flavorAId', coalesce((it->>'qty')::numeric,0) * 0.5);
        perform public.deduct_product(it->>'flavorBId', coalesce((it->>'qty')::numeric,0) * 0.5);
      else
        perform public.deduct_product(it->>'productId', coalesce((it->>'qty')::numeric,0));
      end if;
    end loop;
    o := o || jsonb_build_object('status','entregado','deliveredAt', now_ms);
  elsif p_status = 'listo' then
    o := o || jsonb_build_object('status','listo','readyAt', now_ms);
  else
    o := o || jsonb_build_object('status', p_status);
  end if;
  update public.orders set data = o where id = p_order_id;
  return o;
end $$;

-- Aprobar solicitud de cambio (solo administrador), en una sola transacción
create or replace function public.approve_edit_request(p_request_id text)
returns void language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.is_admin() then raise exception 'Sin permiso' using errcode = '42501'; end if;
  select data into r from public.edit_requests where id = p_request_id for update;
  if r is null or r->>'status' <> 'pendiente' then raise exception 'Solicitud no disponible'; end if;
  update public.orders set data = data || jsonb_build_object(
      'items', r->'proposedItems', 'total', r->'proposedTotal',
      'deliveryFee', coalesce(r->'proposedDeliveryFee', '0'::jsonb))
   where id = r->>'orderId';
  update public.edit_requests set data = data || '{"status":"aprobada"}'::jsonb where id = p_request_id;
end $$;

-- Compra: guarda la compra, suma stock y actualiza costo actual (atómico)
create or replace function public.register_purchase(p_data jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare new_id text; q numeric := coalesce((p_data->>'qty')::numeric,0);
        tot numeric := coalesce((p_data->>'totalCost')::numeric,0);
begin
  if not public.is_admin() then raise exception 'Sin permiso' using errcode = '42501'; end if;
  if q <= 0 then raise exception 'La cantidad debe ser mayor que cero'; end if;
  insert into public.purchases (data) values (p_data || jsonb_build_object('unitCost', tot/q))
    returning id into new_id;
  update public.ingredients
     set data = data || jsonb_build_object(
        'stock', coalesce((data->>'stock')::numeric,0) + q,
        'currentCost', tot/q)
   where id = p_data->>'ingredientId';
  return new_id;
end $$;

-- Eliminar compra: ahora sí devuelve el stock que había sumado
create or replace function public.delete_purchase(p_purchase_id text)
returns void language plpgsql security definer set search_path = public as $$
declare p jsonb;
begin
  if not public.is_admin() then raise exception 'Sin permiso' using errcode = '42501'; end if;
  select data into p from public.purchases where id = p_purchase_id for update;
  if p is null then return; end if;
  update public.ingredients
     set data = jsonb_set(data, '{stock}', to_jsonb(coalesce((data->>'stock')::numeric,0) - coalesce((p->>'qty')::numeric,0)))
   where id = p->>'ingredientId';
  delete from public.purchases where id = p_purchase_id;
end $$;

revoke all on function public.deduct_recipe(text,numeric,int) from public, anon, authenticated;
revoke all on function public.deduct_product(text,numeric) from public, anon, authenticated;
revoke all on function public.set_order_status(text,text) from public, anon;
revoke all on function public.approve_edit_request(text) from public, anon;
revoke all on function public.register_purchase(jsonb) from public, anon;
revoke all on function public.delete_purchase(text) from public, anon;
grant execute on function public.set_order_status(text,text) to authenticated;
grant execute on function public.approve_edit_request(text) to authenticated;
grant execute on function public.register_purchase(jsonb) to authenticated;
grant execute on function public.delete_purchase(text) to authenticated;

-- ---------- CRM de WhatsApp ----------
create table if not exists public.wa_conversations (
  id uuid primary key default gen_random_uuid(),
  wa_id text not null unique,                 -- número del cliente en formato internacional (57300...)
  profile_name text not null default '',
  customer_id text references public.customers(id) on delete set null,
  status text not null default 'nuevo'
    check (status in ('nuevo','cotizado','confirmado','en_camino','entregado','cerrado')),
  order_id text references public.orders(id) on delete set null,
  assigned_to uuid references public.profiles(id) on delete set null,
  unread_count int not null default 0,
  last_message_at timestamptz,
  last_message_preview text not null default '',
  window_expires_at timestamptz,              -- 24 h desde el último mensaje del cliente (regla de Meta)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wa_conv_status_idx on public.wa_conversations (status, last_message_at desc);

create table if not exists public.wa_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.wa_conversations(id) on delete cascade,
  wa_message_id text unique,
  direction text not null check (direction in ('in','out')),
  type text not null default 'text',
  body text not null default '',
  media jsonb,
  status text not null default 'received',    -- received | sending | sent | delivered | read | failed
  error text,
  sent_by uuid references public.profiles(id) on delete set null,
  raw jsonb,
  created_at timestamptz not null default now()
);
create index if not exists wa_msg_conv_idx on public.wa_messages (conversation_id, created_at);

create table if not exists public.quick_replies (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.wa_conversations enable row level security;
alter table public.wa_messages enable row level security;
alter table public.quick_replies enable row level security;
alter table public.wa_conversations replica identity full;
alter table public.wa_messages replica identity full;

drop trigger if exists touch_conv on public.wa_conversations;
create or replace function public.touch_conv() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger touch_conv before update on public.wa_conversations
  for each row execute function public.touch_conv();

drop policy if exists staff_read on public.wa_conversations;
create policy staff_read on public.wa_conversations for select to authenticated using (public.is_staff());
drop policy if exists staff_update on public.wa_conversations;
create policy staff_update on public.wa_conversations for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
drop policy if exists staff_read on public.wa_messages;
create policy staff_read on public.wa_messages for select to authenticated using (public.is_staff());
-- Los mensajes entran y salen solo por las Edge Functions (service role).
drop policy if exists staff_read on public.quick_replies;
create policy staff_read on public.quick_replies for select to authenticated using (public.is_staff());
drop policy if exists admin_all on public.quick_replies;
create policy admin_all on public.quick_replies for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

insert into public.quick_replies (title, body, sort)
select * from (values
  ('Saludo', 'Hola {nombre}, bienvenido a Tomates 🍅 ¿Qué te provoca hoy? Te comparto el menú:', 1),
  ('Tiempo de entrega', 'Tu pedido estará listo en aproximadamente {minutos} minutos.', 2),
  ('Pedido confirmado', 'Confirmado {nombre}: {resumen}. Total {total}. ¡Gracias por pedir en Tomates!', 3),
  ('Pedido en camino', '{nombre}, tu pedido ya va en camino 🛵', 4),
  ('Datos de pago', 'Puedes pagar en efectivo al recibir o por transferencia al QR que te envío.', 5)
) v(title, body, sort)
where not exists (select 1 from public.quick_replies);

-- ---------- Imágenes (productos y QR de cobro) ----------
insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do nothing;
drop policy if exists media_admin_write on storage.objects;
create policy media_admin_write on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.is_admin());
drop policy if exists media_admin_update on storage.objects;
create policy media_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'media' and public.is_admin());
drop policy if exists media_admin_delete on storage.objects;
create policy media_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and public.is_admin());

-- ---------- Tiempo real ----------
do $$
declare t text;
begin
  foreach t in array array['profiles','ingredients','recipes','products','categories','purchases',
    'orders','expenses','pending_expenses','counts','customers','edit_requests','cash_register',
    'cash_movements','config','wa_conversations','wa_messages','quick_replies']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
