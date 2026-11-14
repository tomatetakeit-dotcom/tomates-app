-- 15 · Editar pedidos sin aprobación (decisión de Lucas, 13 nov 2026)
-- El vendedor (ventas.crear) puede agregar o retirar productos de un pedido directamente,
-- mientras el pedido NO esté entregado ni cobrado. El administrador (ventas.editar) puede
-- además editar pedidos ya cobrados. Cada cambio queda en el historial del pedido (editLog:
-- quién, cuándo, antes y después) y la cocina ve el aviso "Modificado".
-- Si el pedido ya estaba "Listo" y se agregan productos, vuelve a cocina (En preparación).
-- Los precios se validan contra el menú (o el precio con que se vendió esa línea).
-- Se puede volver a ejecutar sin problema.

create or replace function public.edit_order(p_order_id text, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o jsonb; n jsonb; it jsonb; prod jsonb; pa jsonb; pb jsonb; old_line jsonb;
        sub numeric := 0; q int; price numeric; expected numeric; total numeric; dsc numeric; fee numeric; dd numeric;
        is_admin boolean := public.has_perm('ventas.editar'); paid boolean; added boolean := false;
        who text; log jsonb; now_ms bigint := (extract(epoch from clock_timestamp())*1000)::bigint;
        summ_before text; summ_after text; k text;
        allowed text[] := array['items','subtotal','total','discount','discountAmount','deliveryDiscount','deliveryFee','deliveryService',
                                'orderType','spot','customerId','customerName','customerPhone','customerWaUser','customerAddress'];
begin
  if not (is_admin or public.has_perm('ventas.crear')) then raise exception 'Sin permiso' using errcode = '42501'; end if;
  select data into o from public.orders where id = p_order_id for update;
  if o is null then raise exception 'El pedido ya no existe'; end if;
  if coalesce(o->>'status','') = 'entregado' then raise exception 'El pedido ya fue entregado; no se puede editar'; end if;
  if coalesce(o->>'webStatus','') = 'por_confirmar' then raise exception 'Primero confirma el pedido web'; end if;
  paid := coalesce(o->>'paymentStatus','') in ('pagado','por_confirmar') and coalesce(o->>'paymentMethod','') <> 'cortesia';
  if paid and not is_admin then
    raise exception 'El pedido ya está cobrado. Solo el administrador puede cambiarlo' using errcode = '42501';
  end if;

  -- Productos: validar cantidades y precios
  if jsonb_typeof(p_patch->'items') <> 'array' or jsonb_array_length(p_patch->'items') = 0 then
    raise exception 'El pedido debe tener al menos un producto (si no lo quieren, cancélalo)';
  end if;
  if jsonb_array_length(p_patch->'items') > 50 then raise exception 'Demasiados productos'; end if;
  for it in select * from jsonb_array_elements(p_patch->'items') loop
    q := coalesce((it->>'qty')::numeric, 0)::int;
    if q < 1 or q > 99 or (it->>'qty')::numeric <> q then raise exception 'Revisa las cantidades'; end if;
    price := coalesce((it->>'price')::numeric, -1);
    if coalesce(it->>'type','') = 'mitad' then
      select data into pa from public.products where id = it->>'flavorAId';
      select data into pb from public.products where id = it->>'flavorBId';
      expected := greatest(coalesce((pa->>'price')::numeric,0), coalesce((pb->>'price')::numeric,0));
      select x into old_line from jsonb_array_elements(coalesce(o->'items','[]'::jsonb)) x
        where x->>'type' = 'mitad' and x->>'flavorAId' = it->>'flavorAId' and x->>'flavorBId' = it->>'flavorBId' limit 1;
    else
      select data into prod from public.products where id = it->>'productId';
      expected := coalesce((prod->>'price')::numeric, -1);
      select x into old_line from jsonb_array_elements(coalesce(o->'items','[]'::jsonb)) x
        where coalesce(x->>'type','') <> 'mitad' and x->>'productId' = it->>'productId' limit 1;
    end if;
    if not (abs(price - expected) <= 1 or (old_line is not null and abs(price - (old_line->>'price')::numeric) <= 1)) then
      raise exception 'El precio de "%" no coincide con el menú', coalesce(it->>'name','un producto');
    end if;
    -- ¿se agregó algo? (línea nueva o más cantidad)
    if old_line is null or q > coalesce((old_line->>'qty')::numeric, 0) then added := true; end if;
    sub := sub + price * q;
    old_line := null;
  end loop;

  dsc := coalesce((p_patch->>'discountAmount')::numeric, 0);
  fee := coalesce((p_patch->>'deliveryFee')::numeric, 0);
  dd  := coalesce((p_patch->>'deliveryDiscount')::numeric, 0);
  total := coalesce((p_patch->>'total')::numeric, -1);
  if abs(total - greatest(0, sub - dsc + fee - dd)) > 1 then raise exception 'El total no cuadra con los productos'; end if;

  -- Solo se copian los campos permitidos
  n := o;
  foreach k in array allowed loop
    if p_patch ? k then n := n || jsonb_build_object(k, p_patch->k); end if;
  end loop;
  n := n || jsonb_build_object('subtotal', sub);
  -- Pedido en $0 sin cobrar → cortesía; si deja de estar en $0, se quita la cortesía
  if total <= 0 and not paid then
    n := n || jsonb_build_object('paymentStatus','pagado','paymentMethod','cortesia','paymentMethodLabel','Cortesía (100% descuento)','paymentAmount',0,'paidAt',now_ms);
  elsif total > 0 and coalesce(o->>'paymentMethod','') = 'cortesia' then
    n := n - 'paymentStatus' - 'paymentMethod' - 'paymentMethodLabel' - 'paymentAmount' - 'paidAt' - 'paidDate';
  end if;
  -- Volver a cocina si estaba listo y se agregaron productos
  if added and coalesce(o->>'status','') = 'listo' then
    n := (n - 'readyAt') || jsonb_build_object('status','pendiente','kitchenStage','preparacion');
  end if;

  select string_agg((x->>'qty') || '× ' || (x->>'name'), ', ') into summ_before from jsonb_array_elements(coalesce(o->'items','[]'::jsonb)) x;
  select string_agg((x->>'qty') || '× ' || (x->>'name'), ', ') into summ_after  from jsonb_array_elements(n->'items') x;
  select coalesce(nullif(name,''), email, 'Equipo') into who from public.profiles where id = auth.uid();
  log := coalesce(o->'editLog','[]'::jsonb) || jsonb_build_array(jsonb_build_object(
           'at', now_ms, 'by', auth.uid(), 'byName', coalesce(who,'Equipo'),
           'before', coalesce(summ_before,''), 'after', coalesce(summ_after,''),
           'beforeTotal', coalesce((o->>'total')::numeric,0), 'afterTotal', total));
  if jsonb_array_length(log) > 20 then log := (select jsonb_agg(x order by i) from (select x, i from jsonb_array_elements(log) with ordinality a(x,i) order by i desc limit 20) q); end if;
  n := n || jsonb_build_object('editLog', log, 'editedAt', now_ms, 'editedByName', coalesce(who,'Equipo'));

  perform set_config('tomates.via_rpc', 'on', true);
  update public.orders set data = n where id = p_order_id;
  perform set_config('tomates.via_rpc', 'off', true);
  return n;
end $$;
revoke all on function public.edit_order(text, jsonb) from public, anon;
grant execute on function public.edit_order(text, jsonb) to authenticated;

select 'ok' as resultado;
