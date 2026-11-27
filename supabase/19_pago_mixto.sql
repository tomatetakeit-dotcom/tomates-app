-- ============================================================
-- 19) Pago mixto (efectivo + QR + tarjeta)
--     La parte QR de un pago mixto queda pendiente en mixedPending
--     hasta que el administrador confirme el comprobante. Al confirmar,
--     esa parte se agrega a extraPayments para que Caja la sume.
--     Se puede volver a ejecutar sin problema.
-- ============================================================

create or replace function public.confirm_qr_payment(p_order_id text, p_ok boolean, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o jsonb;
  qr_pending numeric;
  now_ms bigint := (extract(epoch from clock_timestamp())*1000)::bigint;
  today text := (now() at time zone 'America/Bogota')::date::text;
begin
  if not public.has_perm('pagos.confirmar') then raise exception 'Sin permiso para confirmar pagos' using errcode = '42501'; end if;
  select data into o from public.orders where id = p_order_id for update;
  if o is null then raise exception 'Pedido no encontrado'; end if;
  if coalesce(o->>'paymentStatus','') <> 'por_confirmar' then raise exception 'Este pago no está pendiente de confirmación'; end if;

  if p_ok then
    o := o || jsonb_build_object('paymentStatus','pagado','paymentConfirmedBy', auth.uid(), 'paymentConfirmedAt', now_ms);
    qr_pending := coalesce((o->'mixedPending'->>'qr')::numeric, 0);
    if qr_pending > 0 then
      o := (o - 'mixedPending') || jsonb_build_object('extraPayments',
             coalesce(o->'extraPayments','[]'::jsonb) || jsonb_build_array(
               jsonb_build_object('amount', qr_pending, 'method', 'qr', 'date', today, 'at', now_ms, 'by', auth.uid())));
    end if;
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
