-- 08 · Tipo de pedido (Domicilio / Mesa / Barra) y clientes de domicilio guardados por celular
-- Los pedidos guardan orderType ('domicilio' | 'local'), spot ('Mesa 1' … 'Barra 4') y customerAddress.
-- En un domicilio la app llama a upsert_customer: el celular es la llave del cliente; si ya existe,
-- actualiza su nombre y dirección; si no, lo crea.

create or replace function public.upsert_customer(p_phone text, p_name text, p_address text)
returns text language plpgsql security definer set search_path = public as $$
declare d text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
        k text; cid text;
begin
  if not (public.has_perm('ventas.crear') or public.has_perm('clientes.editar')) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
  if length(d) = 10 then d := '57' || d; end if;
  if not (length(d) = 12 and d like '57%') then raise exception 'Celular inválido: deben ser 10 dígitos'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Falta el nombre del cliente'; end if;
  k := right(d, 10);
  perform pg_advisory_xact_lock(hashtext('tomates-customer-' || k));
  select id into cid from public.customers
   where right(regexp_replace(coalesce(data->>'phone', ''), '\D', '', 'g'), 10) = k
   order by created_at limit 1;
  if cid is null then
    insert into public.customers (data)
    values (jsonb_build_object('name', trim(p_name), 'phone', d, 'address', trim(coalesce(p_address, '')), 'notes', ''))
    returning id into cid;
  else
    update public.customers
       set data = data || jsonb_build_object('name', trim(p_name), 'phone', d, 'address', trim(coalesce(p_address, '')))
     where id = cid;
  end if;
  return cid;
end $$;
revoke all on function public.upsert_customer(text, text, text) from public, anon;
grant execute on function public.upsert_customer(text, text, text) to authenticated;

-- Aprobar un cambio también pasa el tipo de pedido, la mesa/barra y los datos del cliente de domicilio
create or replace function public.approve_edit_request(p_request_id text)
returns void language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.has_perm('ventas.aprobar_cambios') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  select data into r from public.edit_requests where id = p_request_id for update;
  if r is null or r->>'status' <> 'pendiente' then raise exception 'Solicitud no disponible'; end if;
  update public.orders set data = data || jsonb_build_object(
      'items', r->'proposedItems', 'total', r->'proposedTotal',
      'deliveryFee', coalesce(r->'proposedDeliveryFee', '0'::jsonb),
      'deliveryService', coalesce(r->'proposedDeliveryService', '""'::jsonb))
      || jsonb_strip_nulls(jsonb_build_object(
           'orderType', r->'proposedPlace'->'orderType', 'spot', r->'proposedPlace'->'spot',
           'customerId', r->'proposedCustomer'->'customerId', 'customerName', r->'proposedCustomer'->'customerName',
           'customerPhone', r->'proposedCustomer'->'customerPhone', 'customerAddress', r->'proposedCustomer'->'customerAddress'))
   where id = r->>'orderId';
  update public.edit_requests set data = data || jsonb_build_object('status','aprobada','reviewedBy', auth.uid())
   where id = p_request_id;
end $$;

select proname from pg_proc where proname in ('upsert_customer', 'approve_edit_request') and pronamespace = 'public'::regnamespace;
