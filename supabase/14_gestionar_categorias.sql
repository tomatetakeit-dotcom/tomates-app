-- 14 · Editar, unir y borrar categorías de gastos y compras (pedido de Lucas, 13 nov 2026)
-- Los gastos y compras guardan el NOMBRE de la categoría y subcategoría, así que al cambiar
-- un nombre también se actualizan los registros que lo usan (para que los informes cuadren).
--   p_action = 'rename' : nuevo nombre y/o subcategorías. p_subs = [{"from":"viejo","to":"nuevo"}, …]
--                         (from vacío = subcategoría nueva; to vacío = quitarla de la lista).
--   p_action = 'merge'  : pasa todos los registros a la categoría p_target y borra esta (para duplicadas).
--   p_action = 'delete' : borra la categoría. Los registros viejos conservan el nombre como texto.
-- Permiso: gastos.gestionar (categorías de gastos) o compras.gestionar (de compras).
-- La categoría "Domicilios" de gastos la usa la app: no se borra ni se renombra.
-- Se puede volver a ejecutar sin problema.

create or replace function public.manage_category(p_id text, p_action text, p_name text default null,
                                                  p_subs jsonb default '[]'::jsonb, p_target text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c jsonb; t jsonb; scope text; old_name text; new_name text; perm text; s jsonb; subs jsonb; n_moved int := 0; tbls text[];
        tb text; cnt int;
begin
  select data into c from public.categories where id = p_id for update;
  if c is null then raise exception 'La categoría ya no existe'; end if;
  scope := coalesce(c->>'scope','');
  perm := case scope when 'gastos' then 'gastos.gestionar' when 'compras' then 'compras.gestionar' else 'menu.gestionar' end;
  if not public.has_perm(perm) then raise exception 'Sin permiso' using errcode = '42501'; end if;
  old_name := coalesce(c->>'name','');
  tbls := case scope when 'gastos' then array['expenses','pending_expenses'] when 'compras' then array['purchases'] else array[]::text[] end;

  if p_action in ('delete','merge') and scope = 'gastos' and old_name = 'Domicilios' then
    raise exception 'La categoría Domicilios la usa la app para los pagos a domiciliarios; no se puede borrar ni unir';
  end if;

  if p_action = 'rename' then
    new_name := btrim(coalesce(p_name, ''));
    if new_name = '' then raise exception 'Escribe el nombre de la categoría'; end if;
    if scope = 'gastos' and old_name = 'Domicilios' and new_name <> old_name then
      raise exception 'La categoría Domicilios no se puede renombrar';
    end if;
    if exists (select 1 from public.categories where id <> p_id and data->>'scope' = scope
               and lower(btrim(data->>'name')) = lower(new_name)) then
      raise exception 'Ya existe una categoría "%". Usa "Unir con…" para juntarlas', new_name;
    end if;
    -- subcategorías: aplicar renombres en la lista y en los registros
    subs := coalesce(c->'subcategories', '[]'::jsonb);
    for s in select * from jsonb_array_elements(coalesce(p_subs,'[]'::jsonb)) loop
      if coalesce(s->>'from','') = '' then
        if btrim(coalesce(s->>'to','')) <> '' and not subs ? btrim(s->>'to') then subs := subs || to_jsonb(btrim(s->>'to')); end if;
      elsif btrim(coalesce(s->>'to','')) = '' then
        subs := coalesce((select jsonb_agg(x) from jsonb_array_elements_text(subs) x where x <> s->>'from'), '[]'::jsonb);
      elsif s->>'from' <> btrim(s->>'to') then
        subs := coalesce((select jsonb_agg(y order by mi) from (
                  select case when x = s->>'from' then btrim(s->>'to') else x end as y, min(i) as mi
                    from jsonb_array_elements_text(subs) with ordinality as a(x, i) group by 1) q), '[]'::jsonb);
        foreach tb in array tbls loop
          execute format('update public.%I set data = jsonb_set(data, ''{subcategory}'', to_jsonb($1::text)) where data->>''category'' = $2 and data->>''subcategory'' = $3', tb)
            using btrim(s->>'to'), old_name, s->>'from';
        end loop;
      end if;
    end loop;
    update public.categories set data = data || jsonb_build_object('name', new_name, 'subcategories', subs) where id = p_id;
    if new_name <> old_name then
      foreach tb in array tbls loop
        execute format('update public.%I set data = jsonb_set(data, ''{category}'', to_jsonb($1::text)) where data->>''category'' = $2', tb)
          using new_name, old_name;
        get diagnostics cnt = row_count; n_moved := n_moved + cnt;
      end loop;
    end if;
    return jsonb_build_object('ok', true, 'updated', n_moved);

  elsif p_action = 'merge' then
    select data into t from public.categories where id = p_target for update;
    if t is null or p_target = p_id then raise exception 'Elige la categoría con la que quieres unirla'; end if;
    if coalesce(t->>'scope','') <> scope then raise exception 'Solo se pueden unir categorías del mismo tipo'; end if;
    foreach tb in array tbls loop
      execute format('update public.%I set data = jsonb_set(data, ''{category}'', to_jsonb($1::text)) where data->>''category'' = $2', tb)
        using t->>'name', old_name;
      get diagnostics cnt = row_count; n_moved := n_moved + cnt;
    end loop;
    subs := coalesce((select jsonb_agg(distinct x) from (
              select jsonb_array_elements_text(coalesce(t->'subcategories','[]'::jsonb)) x
              union select jsonb_array_elements_text(coalesce(c->'subcategories','[]'::jsonb))) q), '[]'::jsonb);
    update public.categories set data = data || jsonb_build_object('subcategories', subs) where id = p_target;
    delete from public.categories where id = p_id;
    return jsonb_build_object('ok', true, 'updated', n_moved);

  elsif p_action = 'delete' then
    delete from public.categories where id = p_id;
    return jsonb_build_object('ok', true);
  end if;
  raise exception 'Acción no válida';
end $$;
revoke all on function public.manage_category(text, text, text, jsonb, text) from public, anon;
grant execute on function public.manage_category(text, text, text, jsonb, text) to authenticated;

select 'ok' as resultado;
