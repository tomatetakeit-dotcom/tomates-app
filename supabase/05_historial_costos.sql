-- =====================================================================
-- TOMATES APP — v5: historial de costos de insumos
-- Cada cambio del costo de un insumo queda guardado con su fecha, su
-- origen (inicial, compra o cambio manual) y quién lo hizo. Lo registra
-- la base de datos, así que no depende de la pantalla. Idempotente.
-- =====================================================================

create table if not exists public.ingredient_cost_history (
  id uuid primary key default gen_random_uuid(),
  ingredient_id text not null references public.ingredients(id) on delete cascade,
  cost numeric not null,
  previous_cost numeric,
  source text not null check (source in ('inicial','compra','manual')),
  purchase_id text,
  effective_date date not null default ((now() at time zone 'America/Bogota')::date),
  note text not null default '',
  changed_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists ich_ingredient_idx on public.ingredient_cost_history (ingredient_id, effective_date, created_at);
create index if not exists ich_date_idx on public.ingredient_cost_history (effective_date);
alter table public.ingredient_cost_history enable row level security;

drop policy if exists p_read on public.ingredient_cost_history;
create policy p_read on public.ingredient_cost_history for select to authenticated
  using (public.has_perm('inventario.ver') or public.has_perm('menu.ver_costos') or public.has_perm('compras.gestionar'));
-- Sin políticas de escritura: solo escribe el disparador (security definer).

-- Registra automáticamente cualquier cambio de costo
create or replace function public.log_ingredient_cost() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  new_cost numeric := nullif(new.data->>'currentCost','')::numeric;
  old_cost numeric := case when tg_op = 'UPDATE' then nullif(old.data->>'currentCost','')::numeric end;
  src text := coalesce(nullif(current_setting('tomates.cost_source', true), ''), case when tg_op = 'INSERT' then 'inicial' else 'manual' end);
  eff date := coalesce(nullif(current_setting('tomates.cost_date', true), '')::date, (now() at time zone 'America/Bogota')::date);
begin
  if new_cost is null then return new; end if;
  if tg_op = 'UPDATE' and old_cost is not distinct from new_cost then return new; end if;
  insert into public.ingredient_cost_history (ingredient_id, cost, previous_cost, source, purchase_id, effective_date, note, changed_by)
  values (new.id, new_cost, old_cost, src,
          nullif(current_setting('tomates.purchase_id', true), ''), eff,
          coalesce(current_setting('tomates.cost_note', true), ''), auth.uid());
  return new;
end $$;
drop trigger if exists log_ingredient_cost on public.ingredients;
create trigger log_ingredient_cost after insert or update on public.ingredients
  for each row execute function public.log_ingredient_cost();

-- Cambio manual de costo con fecha (lo usa la pantalla de Inventario)
create or replace function public.set_ingredient_cost(p_ingredient_id text, p_cost numeric, p_date date default null, p_note text default '')
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_perm('menu.gestionar') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  if p_cost is null or p_cost < 0 then raise exception 'El costo no es válido'; end if;
  if p_date is not null and p_date > (now() at time zone 'America/Bogota')::date + 1 then raise exception 'La fecha no puede ser futura'; end if;
  perform set_config('tomates.cost_source', 'manual', true);
  perform set_config('tomates.cost_date', coalesce(p_date, (now() at time zone 'America/Bogota')::date)::text, true);
  perform set_config('tomates.cost_note', coalesce(p_note, ''), true);
  update public.ingredients set data = data || jsonb_build_object('currentCost', p_cost) where id = p_ingredient_id;
  if not found then raise exception 'Insumo no encontrado'; end if;
end $$;
revoke all on function public.set_ingredient_cost(text,numeric,date,text) from public, anon;
grant execute on function public.set_ingredient_cost(text,numeric,date,text) to authenticated;

-- Las compras quedan en el historial con la fecha de la compra
create or replace function public.register_purchase(p_data jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare new_id text; q numeric := coalesce((p_data->>'qty')::numeric,0);
        tot numeric := coalesce((p_data->>'totalCost')::numeric,0);
        d date := coalesce(nullif(p_data->>'date','')::date, (now() at time zone 'America/Bogota')::date);
begin
  if not public.has_perm('compras.gestionar') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  if q <= 0 then raise exception 'La cantidad debe ser mayor que cero'; end if;
  insert into public.purchases (data) values (p_data || jsonb_build_object('unitCost', tot/q))
    returning id into new_id;
  perform set_config('tomates.cost_source', 'compra', true);
  perform set_config('tomates.cost_date', d::text, true);
  perform set_config('tomates.purchase_id', new_id, true);
  perform set_config('tomates.cost_note', coalesce(nullif(p_data->>'provider',''), ''), true);
  update public.ingredients
     set data = data || jsonb_build_object(
        'stock', coalesce((data->>'stock')::numeric,0) + q, 'currentCost', tot/q)
   where id = p_data->>'ingredientId';
  perform set_config('tomates.cost_source', '', true);
  perform set_config('tomates.purchase_id', '', true);
  return new_id;
end $$;
grant execute on function public.register_purchase(jsonb) to authenticated;

-- Punto de partida del historial: el costo que tiene hoy cada insumo
insert into public.ingredient_cost_history (ingredient_id, cost, previous_cost, source, effective_date, note, changed_by)
select i.id, (i.data->>'currentCost')::numeric, null, 'inicial',
       (now() at time zone 'America/Bogota')::date, 'Costo inicial (Costeo Tomates.xlsx)', null
from public.ingredients i
where nullif(i.data->>'currentCost','') is not null
  and not exists (select 1 from public.ingredient_cost_history h where h.ingredient_id = i.id);

do $$ begin
  alter publication supabase_realtime add table public.ingredient_cost_history;
exception when duplicate_object then null; end $$;

select count(*) as registros_historial from public.ingredient_cost_history;
