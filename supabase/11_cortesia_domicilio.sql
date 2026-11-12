-- 11 · Descuento del 100% = cortesía (incluye el domicilio) y pedidos en $0 sin cobro
-- - Un descuento del 100% (promoción o libre) deja gratis también el domicilio: el pedido guarda
--   deliveryDiscount = tarifa del domicilio y el total queda en $0. El domiciliario se sigue pagando.
-- - Un pedido en $0 queda pagado como "cortesia" sin pasar por cobro. Nadie puede marcar
--   como cortesía un pedido que vale más de $0.
-- Se puede volver a ejecutar sin problema.

create or replace function public.check_order_discount() returns trigger
language plpgsql security definer set search_path = public as $$
declare d jsonb; items jsonb; amt numeric; sub numeric; dd numeric; fee numeric; p public.promotions; expected numeric;
begin
  if auth.uid() is null then return new; end if;
  if tg_table_name = 'edit_requests' then
    d := new.data->'proposedDiscount'; items := coalesce(new.data->'proposedItems','[]'::jsonb);
    dd := coalesce((new.data->>'proposedDeliveryDiscount')::numeric, 0);
    fee := coalesce((new.data->>'proposedDeliveryFee')::numeric, 0);
  else
    d := new.data->'discount'; items := coalesce(new.data->'items','[]'::jsonb);
    dd := coalesce((new.data->>'deliveryDiscount')::numeric, 0);
    fee := coalesce((new.data->>'deliveryFee')::numeric, 0);
    if tg_op = 'UPDATE' then
      if (old.data->'discount') is not distinct from d and (old.data->'items') is not distinct from (new.data->'items')
         and (old.data->'deliveryDiscount') is not distinct from (new.data->'deliveryDiscount')
         and (old.data->'deliveryFee') is not distinct from (new.data->'deliveryFee') then return new; end if;
      if public.has_perm('ventas.aprobar_cambios') and current_setting('tomates.via_rpc', true) = 'on' then return new; end if;
    end if;
  end if;
  if dd > 0 then
    if not (coalesce(d->>'kind','') = 'pct' and coalesce((d->>'value')::numeric, 0) >= 100) then
      raise exception 'Solo un descuento del 100%% deja gratis el domicilio';
    end if;
    if dd > fee + 1 then raise exception 'El descuento del domicilio no puede ser mayor que la tarifa'; end if;
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

create or replace function public.check_payment_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if coalesce(new.data->>'paymentStatus','') = 'pagado'
     and coalesce(new.data->>'paymentMethod','') = 'cortesia'
     and coalesce((new.data->>'total')::numeric, 0) > 0 then
    raise exception 'Solo un pedido en $0 puede quedar como cortesía';
  end if;
  if coalesce(new.data->>'paymentStatus','') = 'pagado'
     and coalesce(new.data->>'paymentMethod','') = 'qr'
     and (tg_op = 'INSERT' or coalesce(old.data->>'paymentStatus','') <> 'pagado')
     and current_setting('tomates.via_rpc', true) is distinct from 'on'
     and not public.has_perm('pagos.confirmar') then
    raise exception 'El pago por QR debe confirmarlo el administrador' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.approve_edit_request(p_request_id text)
returns void language plpgsql security definer set search_path = public as $$
declare r jsonb; o jsonb; tot numeric;
begin
  if not public.has_perm('ventas.aprobar_cambios') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  select data into r from public.edit_requests where id = p_request_id for update;
  if r is null or r->>'status' <> 'pendiente' then raise exception 'Solicitud no disponible'; end if;
  tot := coalesce((r->>'proposedTotal')::numeric, 0);
  perform set_config('tomates.via_rpc', 'on', true);
  update public.orders set data = data || jsonb_build_object(
      'items', r->'proposedItems', 'total', r->'proposedTotal',
      'deliveryFee', coalesce(r->'proposedDeliveryFee', '0'::jsonb),
      'deliveryService', coalesce(r->'proposedDeliveryService', '""'::jsonb),
      'discount', coalesce(r->'proposedDiscount', 'null'::jsonb),
      'discountAmount', coalesce(r->'proposedDiscount'->'amount', '0'::jsonb),
      'deliveryDiscount', coalesce(r->'proposedDeliveryDiscount', '0'::jsonb))
      || jsonb_strip_nulls(jsonb_build_object(
           'orderType', r->'proposedPlace'->'orderType', 'spot', r->'proposedPlace'->'spot',
           'customerId', r->'proposedCustomer'->'customerId', 'customerName', r->'proposedCustomer'->'customerName',
           'customerPhone', r->'proposedCustomer'->'customerPhone', 'customerWaUser', r->'proposedCustomer'->'customerWaUser',
           'customerAddress', r->'proposedCustomer'->'customerAddress'))
      -- si el pedido queda en $0 y no estaba cobrado, pasa a cortesía
      || case when tot <= 0 and coalesce(data->>'paymentStatus','') <> 'pagado'
              then jsonb_build_object('paymentStatus','pagado','paymentMethod','cortesia','paymentMethodLabel','Cortesía (100% descuento)','paymentAmount',0)
              else '{}'::jsonb end
   where id = r->>'orderId';
  perform set_config('tomates.via_rpc', 'off', true);
  update public.edit_requests set data = data || jsonb_build_object('status','aprobada','reviewedBy', auth.uid())
   where id = p_request_id;
end $$;

select 'ok' as resultado;
