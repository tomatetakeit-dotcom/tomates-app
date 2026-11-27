-- ============================================================
-- 17) Cobro parcial de la diferencia ("Falta cobrar")
--     settle_balance ahora acepta un monto. Si el monto es menor
--     que la diferencia, el pedido queda con el saldo restante.
--     Sin monto, cobra toda la diferencia (comportamiento anterior).
--     Se puede volver a ejecutar sin problema.
-- ============================================================

drop function if exists public.settle_balance(text, text);

create or replace function public.settle_balance(p_order_id text, p_method text, p_amount numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o jsonb;
  due numeric;
  pay numeric;
  left_due numeric;
  now_ms bigint := (extract(epoch from clock_timestamp())*1000)::bigint;
  today text := (now() at time zone 'America/Bogota')::date::text;
begin
  if not public.has_perm('ventas.cobrar') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  if p_method not in ('efectivo','qr','datafono') then raise exception 'Elige cómo se cobró'; end if;

  select data into o from public.orders where id = p_order_id for update;
  if o is null then raise exception 'El pedido ya no existe'; end if;

  due := coalesce((o->>'balanceDue')::numeric, 0);
  if due <= 0 then raise exception 'Este pedido no tiene diferencia por cobrar'; end if;

  pay := coalesce(p_amount, due);
  if pay <= 0 then raise exception 'El monto a cobrar debe ser mayor que cero'; end if;
  if pay > due + 1 then raise exception 'El monto supera la diferencia por cobrar'; end if;
  if pay > due then pay := due; end if;

  left_due := due - pay;

  o := o - 'balanceDue';
  if left_due > 0 then
    o := o || jsonb_build_object('balanceDue', left_due);
  end if;

  o := o || jsonb_build_object('extraPayments',
         coalesce(o->'extraPayments','[]'::jsonb) || jsonb_build_array(
           jsonb_build_object('amount', pay, 'method', p_method, 'date', today, 'at', now_ms, 'by', auth.uid())));

  perform set_config('tomates.via_rpc', 'on', true);
  update public.orders set data = o where id = p_order_id;
  perform set_config('tomates.via_rpc', 'off', true);
  return o;
end $$;

revoke all on function public.settle_balance(text, text, numeric) from public, anon;
grant execute on function public.settle_balance(text, text, numeric) to authenticated;
