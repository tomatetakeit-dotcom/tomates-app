-- 12 · Menú web público y pedidos por WhatsApp Business
-- - public_menu(): menú y datos del negocio para la página pública (sin iniciar sesión).
-- - submit_web_order(): el cliente arma su pedido en la página; entra a la app como
--   "pedido web por confirmar" (no pasa a cocina hasta que el vendedor lo confirma).
--   Los precios se toman de la base de datos, nunca de la página.
-- - confirm_web_order(): el vendedor confirma (con la tarifa del domicilio) o rechaza.
-- Configuración en config/web: whatsapp, open, message, hiddenCategories (lo edita quien tenga config.gestionar).
-- Se puede volver a ejecutar sin problema.

-- 1) Guardar o actualizar cliente (núcleo sin permisos; solo lo usan otras funciones)
create or replace function public.upsert_customer_core(p_phone text, p_wa_user text, p_name text, p_address text)
returns text language plpgsql security definer set search_path = public as $$
declare d text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
        w text := lower(regexp_replace(coalesce(p_wa_user, ''), '\s', '', 'g'));
        a text := btrim(coalesce(p_address, ''));
        an text; cid text;
begin
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
revoke all on function public.upsert_customer_core(text, text, text, text) from public, anon, authenticated;

create or replace function public.upsert_customer(p_phone text, p_wa_user text, p_name text, p_address text)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not (public.has_perm('ventas.crear') or public.has_perm('clientes.editar')) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
  return public.upsert_customer_core(p_phone, p_wa_user, p_name, p_address);
end $$;
revoke all on function public.upsert_customer(text, text, text, text) from public, anon;
grant execute on function public.upsert_customer(text, text, text, text) to authenticated;

-- 2) Menú público
create or replace function public.public_menu() returns jsonb
language sql stable security definer set search_path = public as $$
  with cfg as (select coalesce((select data from public.config where id = 'web'), '{}'::jsonb) as c)
  select jsonb_build_object(
    'business', jsonb_build_object(
      'name', 'Tomates Pizza',
      'whatsapp', coalesce((select c->>'whatsapp' from cfg), ''),
      'open', coalesce((select (c->>'open')::boolean from cfg), false),
      'message', coalesce((select c->>'message' from cfg), ''),
      'spots', '["Mesa 1","Mesa 2","Mesa 3","Barra 1","Barra 2","Barra 3","Barra 4"]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.data->>'name', 'category', coalesce(p.data->>'category','Otros'),
                                          'price', coalesce((p.data->>'price')::numeric, 0),
                                          'half', coalesce((p.data->>'isPizza6')::boolean, false))
                       order by coalesce(p.data->>'category','Otros'), p.data->>'name')
        from public.products p
       where coalesce((p.data->>'price')::numeric, 0) > 0
         and coalesce(p.data->>'category','Otros') <> all (
               coalesce((select array(select jsonb_array_elements_text(c->'hiddenCategories')) from cfg), '{}'::text[]))
    ), '[]'::jsonb))
$$;
revoke all on function public.public_menu() from public;
grant execute on function public.public_menu() to anon, authenticated;

-- 3) Recibir pedido web
create or replace function public.submit_web_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cfg jsonb; typ text; spot text; name text; phone text; wa text; addr text; note text; pay text;
        it jsonb; q int; pa record; pb record; items jsonb := '[]'::jsonb; sub numeric := 0; price numeric;
        cid text; oid text; today text := to_char((now() at time zone 'America/Bogota')::date, 'YYYY-MM-DD');
        now_ms bigint := (extract(epoch from clock_timestamp())*1000)::bigint; n_pending int; n_recent int;
begin
  select coalesce((select data from public.config where id = 'web'), '{}'::jsonb) into cfg;
  if not coalesce((cfg->>'open')::boolean, false) then raise exception 'En este momento no estamos recibiendo pedidos por la web. Escríbenos por WhatsApp.'; end if;
  if length(p::text) > 20000 then raise exception 'Pedido demasiado grande'; end if;

  typ  := coalesce(p->>'type', '');
  spot := btrim(coalesce(p->>'spot', ''));
  name := left(btrim(coalesce(p->>'name', '')), 80);
  phone := regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g');
  wa   := lower(regexp_replace(coalesce(p->>'waUser', ''), '\s', '', 'g'));
  addr := left(btrim(coalesce(p->>'address', '')), 200);
  note := left(btrim(coalesce(p->>'note', '')), 300);
  pay  := case when p->>'pay' in ('efectivo','qr','datafono') then p->>'pay' else '' end;

  if typ not in ('domicilio','llevar','local') then raise exception 'Elige si es domicilio, para recoger o en el local'; end if;
  if typ = 'local' and spot not in ('Mesa 1','Mesa 2','Mesa 3','Barra 1','Barra 2','Barra 3','Barra 4') then raise exception 'Mesa no válida'; end if;
  if name = '' then raise exception 'Escribe tu nombre'; end if;
  if typ <> 'local' and phone = '' and wa = '' then raise exception 'Escribe tu usuario de WhatsApp (@…) o tu celular'; end if;
  if typ = 'domicilio' and length(addr) < 6 then raise exception 'Escribe la dirección completa'; end if;

  -- Freno contra abusos
  select count(*) into n_pending from public.orders where data->>'webStatus' = 'por_confirmar';
  if n_pending >= 25 then raise exception 'Estamos recibiendo muchos pedidos. Escríbenos por WhatsApp, por favor.'; end if;
  select count(*) into n_recent from public.orders
   where data->>'source' = 'web' and created_at > now() - interval '30 minutes'
     and ((phone <> '' and right(regexp_replace(coalesce(data->>'customerPhone',''), '\D','','g'),10) = right(phone,10))
       or (wa <> '' and coalesce(data->>'customerWaUser','') = (case when left(wa,1)='@' then wa else '@'||wa end)));
  if n_recent >= 3 then raise exception 'Ya recibimos tus pedidos. Si necesitas algo más, escríbenos por WhatsApp.'; end if;

  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then raise exception 'Tu pedido está vacío'; end if;
  if jsonb_array_length(p->'items') > 30 then raise exception 'Demasiados productos en un solo pedido'; end if;
  for it in select * from jsonb_array_elements(p->'items') loop
    q := greatest(1, least(20, coalesce((it->>'qty')::int, 1)));
    if coalesce(it->>'type','entera') = 'mitad' then
      select id, data into pa from public.products where id = it->>'a' and coalesce((data->>'isPizza6')::boolean,false);
      select id, data into pb from public.products where id = it->>'b' and coalesce((data->>'isPizza6')::boolean,false);
      if pa.id is null or pb.id is null or pa.id = pb.id then raise exception 'Revisa la pizza mitad y mitad'; end if;
      price := greatest((pa.data->>'price')::numeric, (pb.data->>'price')::numeric);
      items := items || jsonb_build_array(jsonb_build_object('type','mitad','qty',q,'price',price,
                 'flavorAId',pa.id,'flavorAName',pa.data->>'name','flavorBId',pb.id,'flavorBName',pb.data->>'name',
                 'name','Mitad '||(pa.data->>'name')||' / Mitad '||(pb.data->>'name')));
    else
      select id, data into pa from public.products where id = it->>'productId';
      if pa.id is null or coalesce((pa.data->>'price')::numeric,0) <= 0 then raise exception 'Un producto ya no está disponible'; end if;
      price := (pa.data->>'price')::numeric;
      items := items || jsonb_build_array(jsonb_build_object('productId',pa.id,'name',pa.data->>'name','qty',q,'price',price));
    end if;
    sub := sub + price * q;
  end loop;

  if typ <> 'local' then
    cid := public.upsert_customer_core(phone, wa, name, case when typ='domicilio' then addr else '' end);
  end if;
  if phone <> '' and length(phone) = 10 then phone := '57' || phone; end if;
  if wa <> '' and left(wa,1) <> '@' then wa := '@' || wa; end if;

  insert into public.orders (data) values (jsonb_build_object(
      'date', today, 'createdAt', now_ms, 'status', 'pendiente',
      'source', 'web', 'webStatus', 'por_confirmar', 'webPay', pay, 'webNote', note,
      'orderType', typ, 'spot', case when typ='local' then spot else '' end,
      'items', items, 'subtotal', sub, 'total', sub, 'deliveryFee', 0, 'deliveryService', '',
      'customerId', cid, 'customerName', name, 'customerPhone', phone, 'customerWaUser', wa,
      'customerAddress', case when typ='domicilio' then addr else '' end))
    returning id into oid;
  return jsonb_build_object('id', oid, 'short', left(oid, 5), 'subtotal', sub, 'items', items);
end $$;
revoke all on function public.submit_web_order(jsonb) from public;
grant execute on function public.submit_web_order(jsonb) to anon, authenticated;

-- 4) Confirmar o rechazar un pedido web
create or replace function public.confirm_web_order(p_order_id text, p_accept boolean, p_delivery_fee numeric default 0, p_delivery_service text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare o jsonb; fee numeric := greatest(0, coalesce(p_delivery_fee, 0)); now_ms bigint := (extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if not public.has_perm('ventas.crear') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  select data into o from public.orders where id = p_order_id for update;
  if o is null then raise exception 'Pedido no encontrado'; end if;
  if coalesce(o->>'webStatus','') <> 'por_confirmar' then raise exception 'Este pedido ya fue revisado'; end if;
  if not p_accept then
    delete from public.orders where id = p_order_id;
    return jsonb_build_object('deleted', true);
  end if;
  if o->>'orderType' = 'domicilio' then
    if fee <= 0 then raise exception 'Elige la tarifa del domicilio'; end if;
    if fee not in (2000, 5000) and not public.has_perm('ventas.domicilio_manual') then
      raise exception 'No tienes permiso para escribir esa tarifa' using errcode = '42501';
    end if;
  else
    fee := 0;
  end if;
  o := o || jsonb_build_object('webStatus','confirmado','confirmedAt', now_ms, 'confirmedBy', auth.uid(),
                               'deliveryFee', fee, 'deliveryService', left(coalesce(p_delivery_service,''), 60),
                               'total', coalesce((o->>'subtotal')::numeric, 0) + fee);
  perform set_config('tomates.via_rpc', 'on', true);
  update public.orders set data = o where id = p_order_id;
  perform set_config('tomates.via_rpc', 'off', true);
  return o;
end $$;
revoke all on function public.confirm_web_order(text, boolean, numeric, text) from public, anon;
grant execute on function public.confirm_web_order(text, boolean, numeric, text) to authenticated;

-- 5) Los cambios hechos por funciones de la app (confirmar pedido web, aprobar cambios, estados) no requieren ventas.editar
create or replace function public.guard_order_edit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if current_setting('tomates.via_rpc', true) = 'on' then return new; end if;
  if not public.has_perm('ventas.editar') and (
       (old.data->'items') is distinct from (new.data->'items')
    or (old.data->'total') is distinct from (new.data->'total')
    or (old.data->'deliveryFee') is distinct from (new.data->'deliveryFee')) then
    raise exception 'Necesitas aprobación para cambiar productos o total de un pedido' using errcode = '42501';
  end if;
  if (old.data->>'status') is distinct from (new.data->>'status') then
    raise exception 'El estado del pedido se cambia con los botones de la app' using errcode = '42501';
  end if;
  return new;
end $$;

-- Cocina no ve los pedidos web hasta que se confirman (la pantalla también los filtra)
select 'ok' as resultado;
