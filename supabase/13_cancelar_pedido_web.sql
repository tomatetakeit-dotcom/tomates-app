-- 13 · Cancelar pedidos web (decisión de Lucas, 11 nov 2026)
-- Un pedido hecho en la página (source = 'web') se puede cancelar en cualquier momento
-- antes de entregarlo. Se borra por completo (sin registro), junto con sus solicitudes de cambio.
-- Quien toma pedidos (ventas.crear) puede cancelarlo; si ya tiene un pago registrado,
-- solo quien confirma pagos (pagos.confirmar, el administrador) puede hacerlo.
-- El inventario se descuenta al entregar, así que cancelar antes no lo afecta.
-- Se puede volver a ejecutar sin problema.

create or replace function public.cancel_web_order(p_order_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o jsonb;
begin
  if not public.has_perm('ventas.crear') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  select data into o from public.orders where id = p_order_id for update;
  if o is null then raise exception 'El pedido ya no existe'; end if;
  if coalesce(o->>'source','') <> 'web' then raise exception 'Solo se pueden cancelar así los pedidos hechos en la página'; end if;
  if coalesce(o->>'status','') = 'entregado' then raise exception 'El pedido ya fue entregado; no se puede cancelar'; end if;
  if coalesce(o->>'paymentStatus','') in ('pagado','por_confirmar')
     and coalesce(o->>'paymentMethod','') <> 'cortesia'
     and not public.has_perm('pagos.confirmar') then
    raise exception 'Este pedido ya tiene un pago registrado. Solo el administrador puede cancelarlo' using errcode = '42501';
  end if;
  delete from public.edit_requests where data->>'orderId' = p_order_id;
  delete from public.orders where id = p_order_id;
  return jsonb_build_object('deleted', true);
end $$;
revoke all on function public.cancel_web_order(text) from public, anon;
grant execute on function public.cancel_web_order(text) to authenticated;

select 'ok' as resultado;
