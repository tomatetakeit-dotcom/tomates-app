-- ============================================================
-- 18) Ajuste de pagos por el administrador
--     Permite corregir el monto cobrado de un pedido cuando no
--     coincide con lo real (por ejemplo, un pedido dividido a mano).
--     Exige permiso pagos.confirmar, un motivo y deja registro
--     (valor anterior, valor nuevo, quién y cuándo).
--     Se puede volver a ejecutar sin problema.
-- ============================================================

create or replace function public.admin_adjust_payment(p_order_id text, p_amount numeric, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o jsonb;
  before_amt numeric;
  now_ms bigint := (extract(epoch from clock_timestamp())*1000)::bigint;
  adj jsonb;
begin
  if not public.has_perm('pagos.confirmar') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'El monto debe ser cero o mayor'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Escribe el motivo del ajuste'; end if;

  select data into o from public.orders where id = p_order_id for update;
  if o is null then raise exception 'El pedido ya no existe'; end if;

  before_amt := coalesce((o->>'paymentAmount')::numeric, 0);
  adj := jsonb_build_object('at', now_ms, 'by', auth.uid(), 'before', before_amt, 'after', p_amount, 'reason', trim(p_reason));

  o := o || jsonb_build_object(
         'paymentAmount', p_amount,
         'paymentAdjustments', coalesce(o->'paymentAdjustments', '[]'::jsonb) || jsonb_build_array(adj));

  perform set_config('tomates.via_rpc', 'on', true);
  update public.orders set data = o where id = p_order_id;
  perform set_config('tomates.via_rpc', 'off', true);
  return o;
end $$;

revoke all on function public.admin_adjust_payment(text, numeric, text) from public, anon;
grant execute on function public.admin_adjust_payment(text, numeric, text) to authenticated;
