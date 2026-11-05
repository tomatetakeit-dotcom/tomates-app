-- 09 · Rol y pantalla de COCINA + pedidos "Para llevar"
-- Etapas de cocina: cola (nuevo) → preparacion → horno → listo. Cada paso guarda su hora en el pedido:
-- prepAt, ovenAt, readyAt (ms), para medir la cadena de producción.

-- 1) Rol nuevo "cocina"
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin','supervisor','cajero','asesor','domiciliario','cocina','pendiente','inactivo'));
alter table public.role_permissions drop constraint if exists role_permissions_role_check;
alter table public.role_permissions add constraint role_permissions_role_check
  check (role in ('admin','supervisor','cajero','asesor','domiciliario','cocina'));
alter table public.invitations drop constraint if exists invitations_role_check;
alter table public.invitations add constraint invitations_role_check
  check (role in ('admin','supervisor','cajero','asesor','domiciliario','cocina'));

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('admin','supervisor','cajero','asesor','domiciliario','cocina')
                   from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.set_user_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_perm('usuarios.gestionar') then raise exception 'Sin permiso' using errcode='42501'; end if;
  if p_user = auth.uid() then raise exception 'No puedes cambiar tu propio rol'; end if;
  if p_role not in ('admin','supervisor','cajero','asesor','domiciliario','cocina','pendiente','inactivo') then
    raise exception 'Rol no válido'; end if;
  if (p_role = 'admin' or (select role from public.profiles where id = p_user) = 'admin')
     and not public.is_admin() then
    raise exception 'Solo un administrador puede asignar o quitar el rol de administrador'; end if;
  update public.profiles set role = p_role where id = p_user;
  if (select count(*) from public.profiles where role = 'admin') = 0 then
    raise exception 'Debe quedar al menos un administrador'; end if;
end $$;

-- 2) Permisos
insert into public.permissions (key, module, label, sort) values
  ('cocina.ver',    'Cocina', 'Ver la pantalla de cocina (pedidos en vivo)', 30),
  ('cocina.operar', 'Cocina', 'Mover pedidos: preparación, horno y listo', 31)
on conflict (key) do update set module = excluded.module, label = excluded.label, sort = excluded.sort;
insert into public.role_permissions (role, permission) values
  ('cocina','cocina.ver'), ('cocina','cocina.operar'),
  ('supervisor','cocina.ver'), ('supervisor','cocina.operar')
on conflict do nothing;

-- 3) Cocina ve los pedidos de hoy y de ayer (para trabajar y calcular promedios)
drop policy if exists p_read_cocina on public.orders;
create policy p_read_cocina on public.orders for select to authenticated using (
  public.has_perm('cocina.ver')
  and data->>'date' >= to_char((now() at time zone 'America/Bogota')::date - 1, 'YYYY-MM-DD'));

-- 4) Mover un pedido entre etapas (también "atras" para deshacer un toque equivocado)
create or replace function public.set_kitchen_stage(p_order_id text, p_stage text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o jsonb; now_ms bigint := (extract(epoch from clock_timestamp())*1000)::bigint; st text; ks text;
begin
  if not (public.has_perm('cocina.operar') or public.has_perm('ventas.estado')) then
    raise exception 'Sin permiso para mover pedidos en cocina' using errcode = '42501';
  end if;
  if p_stage not in ('preparacion','horno','listo','atras') then raise exception 'Etapa no válida'; end if;
  select data into o from public.orders where id = p_order_id for update;
  if o is null then raise exception 'Pedido no encontrado'; end if;
  st := coalesce(o->>'status','pendiente'); ks := coalesce(o->>'kitchenStage','');
  if st = 'entregado' then raise exception 'El pedido ya fue entregado'; end if;

  if p_stage = 'preparacion' then
    if st <> 'pendiente' then return o; end if;
    o := o || jsonb_build_object('kitchenStage','preparacion','prepBy', auth.uid());
    if o->'prepAt' is null then o := o || jsonb_build_object('prepAt', now_ms); end if;
  elsif p_stage = 'horno' then
    if st <> 'pendiente' then return o; end if;
    if o->'prepAt' is null then o := o || jsonb_build_object('prepAt', now_ms); end if;
    o := o || jsonb_build_object('kitchenStage','horno','ovenAt', now_ms);
  elsif p_stage = 'listo' then
    if st <> 'pendiente' then return o; end if;
    if o->'prepAt' is null then o := o || jsonb_build_object('prepAt', now_ms); end if;
    o := o || jsonb_build_object('kitchenStage','listo','status','listo','readyAt', now_ms);
  else -- atras
    if st = 'listo' then
      o := (o - 'readyAt') || jsonb_build_object('status','pendiente',
             'kitchenStage', case when o ? 'ovenAt' then 'horno' else 'preparacion' end);
    elsif ks = 'horno' then
      o := (o - 'ovenAt') || jsonb_build_object('kitchenStage','preparacion');
    elsif ks = 'preparacion' then
      o := o - 'prepAt' - 'kitchenStage' - 'prepBy';
    else
      return o;
    end if;
  end if;
  perform set_config('tomates.via_rpc', 'on', true);
  update public.orders set data = o where id = p_order_id;
  perform set_config('tomates.via_rpc', 'off', true);
  return o;
end $$;
revoke all on function public.set_kitchen_stage(text, text) from public, anon;
grant execute on function public.set_kitchen_stage(text, text) to authenticated;

select key, (select array_agg(role order by role) from public.role_permissions where permission = key) roles
  from public.permissions where key like 'cocina.%' order by key;
