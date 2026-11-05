-- =====================================================================
-- TOMATES APP — v2: roles, permisos por módulo e invitaciones
-- Se aplica DESPUÉS de tomates_schema.sql. Es idempotente.
-- Roles: admin, supervisor, cajero, asesor, domiciliario, pendiente, inactivo
-- =====================================================================

-- ---------- 1. El rol pasa de enum a texto (para poder crecer) ----------
drop policy if exists profiles_self_name on public.profiles;
drop function if exists public.my_role() cascade;

do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='profiles' and column_name='role'
               and udt_name='app_role') then
    alter table public.profiles alter column role drop default;
    alter table public.profiles alter column role type text using role::text;
  end if;
end $$;
alter table public.profiles alter column role set default 'pendiente';
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin','supervisor','cajero','asesor','domiciliario','pendiente','inactivo'));
alter table public.profiles add column if not exists phone text not null default '';
alter table public.profiles add column if not exists invited_by uuid references public.profiles(id) on delete set null;
drop type if exists public.app_role;

-- ---------- 2. Catálogo de permisos y matriz por rol ----------
create table if not exists public.permissions (
  key text primary key,
  module text not null,
  label text not null,
  sort int not null default 0
);
create table if not exists public.role_permissions (
  role text not null check (role in ('admin','supervisor','cajero','asesor','domiciliario')),
  permission text not null references public.permissions(key) on delete cascade,
  primary key (role, permission)
);
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;

insert into public.permissions (key, module, label, sort) values
  ('ventas.ver',             'Ventas',       'Ver todos los pedidos', 10),
  ('ventas.crear',           'Ventas',       'Tomar pedidos nuevos', 11),
  ('ventas.estado',          'Ventas',       'Marcar pedido listo o entregado', 12),
  ('ventas.cobrar',          'Ventas',       'Cobrar pedidos', 13),
  ('ventas.solicitar_cambio','Ventas',       'Pedir cambio de un pedido (requiere aprobación)', 14),
  ('ventas.editar',          'Ventas',       'Cambiar productos o total de un pedido directamente', 15),
  ('ventas.aprobar_cambios', 'Ventas',       'Aprobar o rechazar solicitudes de cambio', 16),
  ('domicilios.ver',         'Domicilios',   'Ver pedidos de domicilio listos', 20),
  ('domicilios.entregar',    'Domicilios',   'Marcar domicilio entregado', 21),
  ('crm.ver',                'WhatsApp',     'Ver conversaciones de WhatsApp', 30),
  ('crm.responder',          'WhatsApp',     'Responder y enviar menú por WhatsApp', 31),
  ('crm.estado',             'WhatsApp',     'Cambiar estado de conversaciones', 32),
  ('crm.plantillas',         'WhatsApp',     'Editar respuestas rápidas', 33),
  ('clientes.ver',           'Clientes',     'Ver clientes e historial', 40),
  ('clientes.editar',        'Clientes',     'Crear y editar clientes', 41),
  ('clientes.campanas',      'Clientes',     'Enviar campañas por WhatsApp', 42),
  ('menu.ver_costos',        'Menú',         'Ver costos, recetas y márgenes', 50),
  ('menu.gestionar',         'Menú',         'Crear y editar menú, precios, recetas e ingredientes', 51),
  ('inventario.ver',         'Inventario',   'Ver inventario', 60),
  ('inventario.conteo',      'Inventario',   'Registrar conteo físico', 61),
  ('compras.gestionar',      'Compras',      'Registrar compras', 70),
  ('gastos.gestionar',       'Gastos',       'Registrar gastos', 80),
  ('caja.ver',               'Caja',         'Ver caja diaria', 90),
  ('caja.cuadrar',           'Caja',         'Abrir, cerrar caja y registrar movimientos', 91),
  ('informes.ver',           'Informes',     'Ver informes y estado de resultados', 100),
  ('informes.exportar',      'Informes',     'Descargar respaldo en Excel', 101),
  ('usuarios.gestionar',     'Usuarios',     'Invitar usuarios y asignar roles', 110),
  ('registros.eliminar',     'Usuarios',     'Eliminar registros', 111),
  ('config.gestionar',       'Usuarios',     'Configuración del negocio (QR de cobro, etc.)', 112)
on conflict (key) do update set module = excluded.module, label = excluded.label, sort = excluded.sort;

-- Matriz inicial (el administrador siempre tiene todo, aunque no esté en la tabla)
-- Solo se siembra la primera vez; después el administrador la ajusta desde la app.
do $$ begin
if not exists (select 1 from public.role_permissions) then
insert into public.role_permissions (role, permission)
select 'supervisor', key from public.permissions
 where key not in ('menu.gestionar','usuarios.gestionar','registros.eliminar','config.gestionar');
insert into public.role_permissions (role, permission) values
  ('cajero','ventas.ver'), ('cajero','ventas.crear'), ('cajero','ventas.estado'),
  ('cajero','ventas.cobrar'), ('cajero','ventas.solicitar_cambio'),
  ('cajero','domicilios.ver'), ('cajero','domicilios.entregar'),
  ('cajero','clientes.ver'), ('cajero','clientes.editar'),
  ('asesor','ventas.ver'), ('asesor','ventas.crear'), ('asesor','ventas.solicitar_cambio'),
  ('asesor','crm.ver'), ('asesor','crm.responder'), ('asesor','crm.estado'),
  ('asesor','clientes.ver'), ('asesor','clientes.editar'),
  ('domiciliario','domicilios.ver'), ('domiciliario','domicilios.entregar'), ('domiciliario','ventas.cobrar');
end if;
end $$;

-- ---------- 3. Funciones de permisos ----------
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
$$;
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('admin','supervisor','cajero','asesor','domiciliario')
                   from public.profiles where id = auth.uid()), false)
$$;
create or replace function public.has_perm(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select pr.role = 'admin'
        or exists (select 1 from public.role_permissions rp where rp.role = pr.role and rp.permission = p)
      from public.profiles pr where pr.id = auth.uid()), false)
$$;
-- Lista de permisos del usuario actual (la app la usa para mostrar u ocultar pestañas)
create or replace function public.my_permissions() returns text[]
language sql stable security definer set search_path = public as $$
  select case when public.my_role() = 'admin' then (select array_agg(key order by sort) from public.permissions)
              else coalesce((select array_agg(rp.permission) from public.role_permissions rp
                              where rp.role = public.my_role()), '{}') end
$$;
grant execute on function public.has_perm(text), public.my_permissions(), public.my_role(),
  public.is_admin(), public.is_staff() to authenticated;

-- ---------- 4. Invitaciones (solo entran personas invitadas) ----------
create table if not exists public.invitations (
  email text primary key check (email = lower(email)),
  name text not null default '',
  phone text not null default '',
  role text not null check (role in ('admin','supervisor','cajero','asesor','domiciliario')),
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);
alter table public.invitations enable row level security;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare inv public.invitations; r text;
begin
  select * into inv from public.invitations where email = lower(coalesce(new.email,''));
  if not exists (select 1 from public.profiles where role = 'admin') then
    r := 'admin';
  elsif inv.email is not null then
    r := inv.role;
  else
    r := 'pendiente';
  end if;
  insert into public.profiles (id, email, name, phone, role, invited_by)
  values (new.id, lower(coalesce(new.email,'')),
          coalesce(nullif(inv.name,''), split_part(coalesce(new.email,''), '@', 1)),
          coalesce(inv.phone,''), r, inv.invited_by)
  on conflict (id) do nothing;
  if inv.email is not null then
    update public.invitations set accepted_at = now() where email = inv.email;
  end if;
  return new;
end $$;

-- Cambiar rol (con reglas: nadie se cambia a sí mismo; solo un admin crea otro admin;
-- siempre debe quedar al menos un admin)
create or replace function public.set_user_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_perm('usuarios.gestionar') then raise exception 'Sin permiso' using errcode='42501'; end if;
  if p_user = auth.uid() then raise exception 'No puedes cambiar tu propio rol'; end if;
  if p_role not in ('admin','supervisor','cajero','asesor','domiciliario','pendiente','inactivo') then
    raise exception 'Rol no válido'; end if;
  if (p_role = 'admin' or (select role from public.profiles where id = p_user) = 'admin')
     and not public.is_admin() then
    raise exception 'Solo un administrador puede asignar o quitar el rol de administrador'; end if;
  update public.profiles set role = p_role where id = p_user;
  if (select count(*) from public.profiles where role = 'admin') = 0 then
    raise exception 'Debe quedar al menos un administrador'; end if;
end $$;
revoke all on function public.set_user_role(uuid,text) from public, anon;
grant execute on function public.set_user_role(uuid,text) to authenticated;

-- ---------- 5. Políticas: se rehacen todas por permiso ----------
do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- helper: (tabla, permiso de lectura, permiso de escritura, permiso de borrado)
do $$
declare t record;
begin
  for t in select * from (values
      ('recipes',          'menu.ver_costos',   'menu.gestionar',   'menu.gestionar'),
      ('purchases',        'compras.gestionar', 'compras.gestionar','registros.eliminar'),
      ('expenses',         'gastos.gestionar',  'gastos.gestionar', 'registros.eliminar'),
      ('pending_expenses', 'gastos.gestionar',  'gastos.gestionar', 'gastos.gestionar'),
      ('counts',           'inventario.ver',    'inventario.conteo','registros.eliminar'),
      ('customers',        'clientes.ver',      'clientes.editar',  'registros.eliminar'),
      ('cash_register',    'caja.ver',          'caja.cuadrar',     'caja.cuadrar'),
      ('cash_movements',   'caja.ver',          'caja.cuadrar',     'registros.eliminar')
    ) v(tbl, rd, wr, del)
  loop
    execute format('create policy p_read on public.%I for select to authenticated using (public.has_perm(%L))', t.tbl, t.rd);
    execute format('create policy p_insert on public.%I for insert to authenticated with check (public.has_perm(%L))', t.tbl, t.wr);
    execute format('create policy p_update on public.%I for update to authenticated using (public.has_perm(%L)) with check (public.has_perm(%L))', t.tbl, t.wr, t.wr);
    execute format('create policy p_delete on public.%I for delete to authenticated using (public.has_perm(%L))', t.tbl, t.del);
  end loop;
end $$;

-- Menú, categorías y configuración: todo el equipo los lee; los gestiona quien tenga permiso
create policy p_read on public.products for select to authenticated using (public.is_staff());
create policy p_write on public.products for all to authenticated
  using (public.has_perm('menu.gestionar')) with check (public.has_perm('menu.gestionar'));
create policy p_read on public.categories for select to authenticated using (public.is_staff());
create policy p_write on public.categories for all to authenticated
  using (public.has_perm('menu.gestionar') or public.has_perm('gastos.gestionar') or public.has_perm('compras.gestionar'))
  with check (public.has_perm('menu.gestionar') or public.has_perm('gastos.gestionar') or public.has_perm('compras.gestionar'));
create policy p_read on public.config for select to authenticated using (public.is_staff());
create policy p_write on public.config for all to authenticated
  using (public.has_perm('config.gestionar')) with check (public.has_perm('config.gestionar'));

-- Ingredientes: el stock solo cambia por compras, entregas y conteos (funciones)
create policy p_read on public.ingredients for select to authenticated
  using (public.has_perm('inventario.ver') or public.has_perm('menu.ver_costos'));
create policy p_write on public.ingredients for all to authenticated
  using (public.has_perm('menu.gestionar')) with check (public.has_perm('menu.gestionar'));

-- Pedidos
create policy p_read on public.orders for select to authenticated using (
  public.has_perm('ventas.ver')
  or (public.has_perm('domicilios.ver')
      and coalesce((data->>'deliveryFee')::numeric, 0) > 0
      and data->>'status' in ('listo','entregado')
      and data->>'date' >= to_char((now() at time zone 'America/Bogota')::date - 1, 'YYYY-MM-DD')));
create policy p_insert on public.orders for insert to authenticated
  with check (public.has_perm('ventas.crear') and coalesce(data->>'status','pendiente') = 'pendiente');
create policy p_update on public.orders for update to authenticated
  using (public.has_perm('ventas.cobrar') or public.has_perm('ventas.editar') or public.has_perm('ventas.estado'))
  with check (public.has_perm('ventas.cobrar') or public.has_perm('ventas.editar') or public.has_perm('ventas.estado'));
create policy p_delete on public.orders for delete to authenticated using (public.has_perm('registros.eliminar'));

create or replace function public.guard_order_edit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if not public.has_perm('ventas.editar') and (
       (old.data->'items') is distinct from (new.data->'items')
    or (old.data->'total') is distinct from (new.data->'total')
    or (old.data->'deliveryFee') is distinct from (new.data->'deliveryFee')) then
    raise exception 'Necesitas aprobación para cambiar productos o total de un pedido' using errcode = '42501';
  end if;
  if (old.data->>'status') is distinct from (new.data->>'status')
     and current_setting('tomates.via_rpc', true) is distinct from 'on' then
    raise exception 'El estado del pedido se cambia con los botones de la app' using errcode = '42501';
  end if;
  return new;
end $$;

-- Solicitudes de cambio
create policy p_read on public.edit_requests for select to authenticated
  using (public.has_perm('ventas.aprobar_cambios') or (data->>'requestedBy') = auth.uid()::text);
create policy p_insert on public.edit_requests for insert to authenticated
  with check (public.has_perm('ventas.solicitar_cambio') and data->>'status' = 'pendiente'
              and (data->>'requestedBy') = auth.uid()::text);
create policy p_update on public.edit_requests for update to authenticated
  using (public.has_perm('ventas.aprobar_cambios')) with check (public.has_perm('ventas.aprobar_cambios'));

-- Perfiles, invitaciones y matriz de permisos
create policy p_read on public.profiles for select to authenticated using (id = auth.uid() or public.is_staff());
create policy p_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and role = public.my_role());
create policy p_delete on public.profiles for delete to authenticated
  using (public.is_admin() and id <> auth.uid());
create policy p_all on public.invitations for all to authenticated
  using (public.has_perm('usuarios.gestionar'))
  with check (public.has_perm('usuarios.gestionar') and (role <> 'admin' or public.is_admin()));
create policy p_read on public.permissions for select to authenticated using (public.is_staff());
create policy p_read on public.role_permissions for select to authenticated using (public.is_staff());
create policy p_write on public.role_permissions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- WhatsApp
create policy p_read on public.wa_conversations for select to authenticated using (public.has_perm('crm.ver'));
create policy p_update on public.wa_conversations for update to authenticated
  using (public.has_perm('crm.estado')) with check (public.has_perm('crm.estado'));
create policy p_read on public.wa_messages for select to authenticated using (public.has_perm('crm.ver'));
create policy p_read on public.quick_replies for select to authenticated using (public.has_perm('crm.ver'));
create policy p_write on public.quick_replies for all to authenticated
  using (public.has_perm('crm.plantillas')) with check (public.has_perm('crm.plantillas'));

-- Imágenes: quien gestiona menú o configuración
drop policy if exists media_admin_write on storage.objects;
drop policy if exists media_admin_update on storage.objects;
drop policy if exists media_admin_delete on storage.objects;
create policy media_admin_write on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (public.has_perm('menu.gestionar') or public.has_perm('config.gestionar')));
create policy media_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'media' and (public.has_perm('menu.gestionar') or public.has_perm('config.gestionar')));
create policy media_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (public.has_perm('menu.gestionar') or public.has_perm('config.gestionar')));

-- ---------- 6. Funciones de negocio con permisos ----------
create or replace function public.set_order_status(p_order_id text, p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o jsonb; it jsonb; now_ms bigint := (extract(epoch from clock_timestamp())*1000)::bigint;
        is_delivery boolean;
begin
  if p_status not in ('pendiente','listo','entregado') then raise exception 'Estado no válido'; end if;
  select data into o from public.orders where id = p_order_id for update;
  if o is null then raise exception 'Pedido no encontrado'; end if;
  is_delivery := coalesce((o->>'deliveryFee')::numeric, 0) > 0;
  if not (public.has_perm('ventas.estado')
          or (p_status = 'entregado' and is_delivery and o->>'status' = 'listo'
              and public.has_perm('domicilios.entregar'))) then
    raise exception 'Sin permiso para cambiar este pedido' using errcode = '42501';
  end if;
  if o->>'status' = 'entregado' or o->>'status' = p_status then return o; end if;
  if p_status = 'entregado' then
    for it in select * from jsonb_array_elements(coalesce(o->'items','[]'::jsonb)) loop
      if it->>'type' = 'mitad' then
        perform public.deduct_product(it->>'flavorAId', coalesce((it->>'qty')::numeric,0) * 0.5);
        perform public.deduct_product(it->>'flavorBId', coalesce((it->>'qty')::numeric,0) * 0.5);
      else
        perform public.deduct_product(it->>'productId', coalesce((it->>'qty')::numeric,0));
      end if;
    end loop;
    o := o || jsonb_build_object('status','entregado','deliveredAt', now_ms, 'deliveredBy', auth.uid());
  elsif p_status = 'listo' then
    o := o || jsonb_build_object('status','listo','readyAt', now_ms);
  else
    o := o || jsonb_build_object('status', p_status);
  end if;
  perform set_config('tomates.via_rpc', 'on', true);
  update public.orders set data = o where id = p_order_id;
  perform set_config('tomates.via_rpc', 'off', true);
  return o;
end $$;

create or replace function public.approve_edit_request(p_request_id text)
returns void language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.has_perm('ventas.aprobar_cambios') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  select data into r from public.edit_requests where id = p_request_id for update;
  if r is null or r->>'status' <> 'pendiente' then raise exception 'Solicitud no disponible'; end if;
  update public.orders set data = data || jsonb_build_object(
      'items', r->'proposedItems', 'total', r->'proposedTotal',
      'deliveryFee', coalesce(r->'proposedDeliveryFee', '0'::jsonb))
   where id = r->>'orderId';
  update public.edit_requests set data = data || jsonb_build_object('status','aprobada','reviewedBy', auth.uid())
   where id = p_request_id;
end $$;

create or replace function public.register_purchase(p_data jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare new_id text; q numeric := coalesce((p_data->>'qty')::numeric,0);
        tot numeric := coalesce((p_data->>'totalCost')::numeric,0);
begin
  if not public.has_perm('compras.gestionar') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  if q <= 0 then raise exception 'La cantidad debe ser mayor que cero'; end if;
  insert into public.purchases (data) values (p_data || jsonb_build_object('unitCost', tot/q))
    returning id into new_id;
  update public.ingredients
     set data = data || jsonb_build_object(
        'stock', coalesce((data->>'stock')::numeric,0) + q, 'currentCost', tot/q)
   where id = p_data->>'ingredientId';
  return new_id;
end $$;

create or replace function public.delete_purchase(p_purchase_id text)
returns void language plpgsql security definer set search_path = public as $$
declare p jsonb;
begin
  if not public.has_perm('registros.eliminar') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  select data into p from public.purchases where id = p_purchase_id for update;
  if p is null then return; end if;
  update public.ingredients
     set data = jsonb_set(data, '{stock}', to_jsonb(coalesce((data->>'stock')::numeric,0) - coalesce((p->>'qty')::numeric,0)))
   where id = p->>'ingredientId';
  delete from public.purchases where id = p_purchase_id;
end $$;

-- Conteo físico: guarda el conteo y ajusta el stock en un solo paso
create or replace function public.register_count(p_ingredient_id text, p_counted numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i jsonb; c jsonb;
begin
  if not public.has_perm('inventario.conteo') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  select data into i from public.ingredients where id = p_ingredient_id for update;
  if i is null then raise exception 'Ingrediente no encontrado'; end if;
  c := jsonb_build_object('ingredientId', p_ingredient_id, 'ingredientName', i->>'name',
         'date', to_char((now() at time zone 'America/Bogota')::date, 'YYYY-MM-DD'),
         'counted', p_counted, 'theoretical', coalesce((i->>'stock')::numeric,0),
         'difference', p_counted - coalesce((i->>'stock')::numeric,0),
         'unit', i->>'unit', 'cost', coalesce((i->>'currentCost')::numeric,0), 'countedBy', auth.uid());
  insert into public.counts (data) values (c);
  update public.ingredients set data = jsonb_set(data, '{stock}', to_jsonb(p_counted)) where id = p_ingredient_id;
  return c;
end $$;

revoke all on function public.register_count(text,numeric) from public, anon;
grant execute on function public.register_count(text,numeric) to authenticated;
grant execute on function public.set_order_status(text,text), public.approve_edit_request(text),
  public.register_purchase(jsonb), public.delete_purchase(text) to authenticated;

-- ---------- 7. Tiempo real para las tablas nuevas ----------
do $$
declare t text;
begin
  foreach t in array array['invitations','role_permissions'] loop
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;
