-- TOMATES APP — v3: actualización parcial de documentos (equivale a update() de la app)
-- Respeta las reglas de acceso (security invoker): solo actualiza si la política lo permite.
create or replace function public.merge_doc(p_table text, p_id text, p_patch jsonb)
returns void language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  if p_table not in ('ingredients','recipes','products','categories','purchases','orders','expenses',
                     'pending_expenses','counts','customers','edit_requests','cash_register',
                     'cash_movements','config') then
    raise exception 'Tabla no permitida';
  end if;
  execute format('update public.%I set data = data || $1 where id = $2', p_table) using p_patch, p_id;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'No tienes permiso o el registro no existe' using errcode = '42501';
  end if;
end $$;
revoke all on function public.merge_doc(text,text,jsonb) from public, anon;
grant execute on function public.merge_doc(text,text,jsonb) to authenticated;

-- Última vez que la persona entró (para saber si ya aceptó su invitación)
alter table public.profiles add column if not exists last_seen_at timestamptz;
create or replace function public.touch_last_seen() returns void
language sql security definer set search_path = public as $$
  update public.profiles set last_seen_at = now() where id = auth.uid();
  update public.invitations set accepted_at = coalesce(accepted_at, now())
   where email = (select email from public.profiles where id = auth.uid());
$$;
revoke all on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;

-- La invitación se marca aceptada cuando la persona entra por primera vez, no al crearse la cuenta
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
  return new;
end $$;
