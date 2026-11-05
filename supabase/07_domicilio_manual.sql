-- 07 · Tarifa de domicilio escrita a mano (servicio externo)
-- En "Nuevo pedido" las tarifas fijas son $2.000 y $5.000. "Otra tarifa (externo)" deja escribir el valor
-- y el nombre del servicio; solo para quien tenga el permiso ventas.domicilio_manual
-- (el administrador siempre; por defecto también el cajero/vendedor).

insert into public.permissions (key, module, label, sort) values
  ('ventas.domicilio_manual', 'Ventas', 'Escribir la tarifa del domicilio (servicio externo)', 17)
on conflict (key) do update set module = excluded.module, label = excluded.label, sort = excluded.sort;

insert into public.role_permissions (role, permission) values ('cajero', 'ventas.domicilio_manual')
on conflict do nothing;

-- Regla en la base de datos: una tarifa distinta de 0, 2.000 o 5.000 exige el permiso
create or replace function public.check_delivery_fee() returns trigger
language plpgsql security definer set search_path = public as $$
declare fee numeric;
begin
  if auth.uid() is null then return new; end if;
  if tg_table_name = 'edit_requests' then
    fee := coalesce((new.data->>'proposedDeliveryFee')::numeric, 0);
  else
    fee := coalesce((new.data->>'deliveryFee')::numeric, 0);
    if tg_op = 'UPDATE' then
      if (old.data->'deliveryFee') is not distinct from (new.data->'deliveryFee') then return new; end if;
      -- quien aprueba un cambio ya revisado no necesita el permiso
      if public.has_perm('ventas.aprobar_cambios') then return new; end if;
    end if;
  end if;
  if fee < 0 then raise exception 'La tarifa del domicilio no puede ser negativa'; end if;
  if fee not in (0, 2000, 5000) and not public.has_perm('ventas.domicilio_manual') then
    raise exception 'Solo el administrador o el vendedor pueden escribir la tarifa del domicilio' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists t_check_delivery_fee on public.orders;
create trigger t_check_delivery_fee before insert or update on public.orders
  for each row execute function public.check_delivery_fee();
drop trigger if exists t_check_delivery_fee on public.edit_requests;
create trigger t_check_delivery_fee before insert on public.edit_requests
  for each row execute function public.check_delivery_fee();

-- Al aprobar un cambio también pasa el nombre del servicio externo
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
   where id = r->>'orderId';
  update public.edit_requests set data = data || jsonb_build_object('status','aprobada','reviewedBy', auth.uid())
   where id = p_request_id;
end $$;

select key, label, (select array_agg(role) from public.role_permissions where permission = key) as roles
  from public.permissions where key = 'ventas.domicilio_manual';
