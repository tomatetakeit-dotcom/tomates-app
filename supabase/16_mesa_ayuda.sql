-- 16 · Mesa de ayuda (Lucas, 19 nov 2026)
--  1) Categoría "Domicilios" repetida: se dejan una sola (id fijo 'gastos-domicilios') y se puede
--     borrar o unir una repetida mientras quede otra.
--  2) Gasto de domicilio AUTOMÁTICO: al marcar Entregado un pedido con tarifa de domicilio se crea
--     el gasto "Domicilios" (efectivo, pagado al domiciliario). Id fijo 'dom-<pedido>' para no duplicar.
--  3) cancel_order: el administrador cancela cualquier pedido (se borra sin registro, decisión de
--     Lucas). Si ya estaba entregado, se devuelve el inventario. Borra también el gasto automático.
--  4) Descuento del vendedor "por aprobar": el vendedor puede dar un descuento libre que queda
--     pendiente; el administrador lo aprueba o rechaza (review_discount). Si lo rechaza y el pedido
--     ya estaba cobrado, queda "Falta cobrar $X" (balanceDue) y se cobra con settle_balance.
--  5) Facturas por foto también desde Gastos (permiso gastos.gestionar).
-- Se puede volver a ejecutar sin problema.

-- ============ 1) Domicilios: una sola categoría ============
do $$
declare subs jsonb;
begin
  select coalesce(jsonb_agg(distinct x), '[]'::jsonb) into subs
    from public.categories c, jsonb_array_elements_text(coalesce(c.data->'subcategories','[]'::jsonb)) x
   where c.data->>'scope' = 'gastos' and c.data->>'name' = 'Domicilios';
  if exists (select 1 from public.categories where data->>'scope' = 'gastos' and data->>'name' = 'Domicilios') then
    insert into public.categories (id, data)
    values ('gastos-domicilios', jsonb_build_object('scope','gastos','name','Domicilios','subcategories', subs))
    on conflict (id) do update set data = excluded.data;
    delete from public.categories where data->>'scope' = 'gastos' and data->>'name' = 'Domicilios' and id <> 'gastos-domicilios';
  end if;
end $$;

create or replace function public.manage_category(p_id text, p_action text, p_name text default null,
                                                  p_subs jsonb default '[]'::jsonb, p_target text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c jsonb; t jsonb; scope text; old_name text; new_name text; perm text; s jsonb; subs jsonb; n_moved int := 0; tbls text[];
        tb text; cnt int; n_same int;
begin
  select data into c from public.categories where id = p_id for update;
  if c is null then raise exception 'La categoría ya no existe'; end if;
  scope := coalesce(c->>'scope','');
  perm := case scope when 'gastos' then 'gastos.gestionar' when 'compras' then 'compras.gestionar' else 'menu.gestionar' end;
  if not public.has_perm(perm) then raise exception 'Sin permiso' using errcode = '42501'; end if;
  old_name := coalesce(c->>'name','');
  tbls := case scope when 'gastos' then array['expenses','pending_expenses'] when 'compras' then array['purchases'] else array[]::text[] end;
  select count(*) into n_same from public.categories where data->>'scope' = scope and data->>'name' = old_name;

  if p_action in ('delete','merge') and scope = 'gastos' and old_name = 'Domicilios' and n_same <= 1 then
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
    if t->>'name' <> old_name then
      foreach tb in array tbls loop
        execute format('update public.%I set data = jsonb_set(data, ''{category}'', to_jsonb($1::text)) where data->>''category'' = $2', tb)
          using t->>'name', old_name;
        get diagnostics cnt = row_count; n_moved := n_moved + cnt;
      end loop;
    end if;
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

-- ============ 2) Entregar: gasto automático del domicilio ============
create or replace function public.set_order_status(p_order_id text, p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o jsonb; it jsonb; now_ms bigint := (extract(epoch from clock_timestamp())*1000)::bigint;
        is_delivery boolean; fee numeric; today text := (now() at time zone 'America/Bogota')::date::text;
begin
  if p_status not in ('pendiente','listo','entregado') then raise exception 'Estado no válido'; end if;
  select data into o from public.orders where id = p_order_id for update;
  if o is null then raise exception 'Pedido no encontrado'; end if;
  fee := coalesce((o->>'deliveryFee')::numeric, 0);
  is_delivery := fee > 0;
  if not (public.has_perm('ventas.estado')
          or (p_status = 'entregado' and is_delivery and o->>'status' = 'listo'
              and public.has_perm('domicilios.entregar'))) then
    raise exception 'Sin permiso para cambiar este pedido' using errcode = '42501';
  end if;
  if coalesce(o->>'webStatus','') = 'por_confirmar' then raise exception 'Primero confirma el pedido web'; end if;
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
    -- El domiciliario se paga con la tarifa completa: queda como gasto en efectivo
    if is_delivery then
      insert into public.expenses (id, data) values ('dom-' || p_order_id, jsonb_build_object(
          'category','Domicilios',
          'subcategory', case when coalesce(o->>'deliveryService','') <> '' then o->>'deliveryService'
                              else '$' || replace(to_char(fee, 'FM999,999,999'), ',', '.') end,
          'amount', fee, 'paymentMethod','efectivo', 'date', today,
          'description', 'Domicilio pedido #' || left(p_order_id, 5) || coalesce(' — ' || nullif(o->>'customerName',''), ''),
          'auto', true, 'orderId', p_order_id, 'createdAt', now_ms))
      on conflict (id) do nothing;
    end if;
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
revoke all on function public.set_order_status(text,text) from public, anon;
grant execute on function public.set_order_status(text,text) to authenticated;

-- ============ 3) Cancelar cualquier pedido (administrador) ============
create or replace function public.cancel_order(p_order_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o jsonb; it jsonb; is_admin boolean := public.has_perm('ventas.editar');
begin
  select data into o from public.orders where id = p_order_id for update;
  if o is null then raise exception 'El pedido ya no existe'; end if;
  if not is_admin then
    -- sin ser administrador: solo pedidos web sin entregar (y sin pago, salvo quien confirma pagos)
    if not public.has_perm('ventas.crear') or coalesce(o->>'source','') <> 'web' or coalesce(o->>'status','') = 'entregado' then
      raise exception 'Solo el administrador puede cancelar este pedido' using errcode = '42501';
    end if;
    if coalesce(o->>'paymentStatus','') in ('pagado','por_confirmar') and coalesce(o->>'paymentMethod','') <> 'cortesia'
       and not public.has_perm('pagos.confirmar') then
      raise exception 'Este pedido ya tiene un pago registrado. Solo el administrador puede cancelarlo' using errcode = '42501';
    end if;
  end if;
  -- Si ya se había entregado, el inventario se devuelve
  if coalesce(o->>'status','') = 'entregado' then
    for it in select * from jsonb_array_elements(coalesce(o->'items','[]'::jsonb)) loop
      if it->>'type' = 'mitad' then
        perform public.deduct_product(it->>'flavorAId', -coalesce((it->>'qty')::numeric,0) * 0.5);
        perform public.deduct_product(it->>'flavorBId', -coalesce((it->>'qty')::numeric,0) * 0.5);
      else
        perform public.deduct_product(it->>'productId', -coalesce((it->>'qty')::numeric,0));
      end if;
    end loop;
  end if;
  delete from public.expenses where id = 'dom-' || p_order_id;
  delete from public.edit_requests where data->>'orderId' = p_order_id;
  delete from public.orders where id = p_order_id;
  return jsonb_build_object('deleted', true);
end $$;
revoke all on function public.cancel_order(text) from public, anon;
grant execute on function public.cancel_order(text) to authenticated;

-- El botón de pedidos web sigue usando cancel_web_order: ahora es la misma regla
create or replace function public.cancel_web_order(p_order_id text)
returns jsonb language sql security definer set search_path = public as $$ select public.cancel_order(p_order_id) $$;
revoke all on function public.cancel_web_order(text) from public, anon;
grant execute on function public.cancel_web_order(text) to authenticated;

-- ============ 4) Descuento del vendedor por aprobar ============
create or replace function public.check_order_discount() returns trigger
language plpgsql security definer set search_path = public as $$
declare d jsonb; od jsonb; items jsonb; amt numeric; sub numeric; dd numeric; fee numeric; p public.promotions; expected numeric;
begin
  if auth.uid() is null then return new; end if;
  if tg_table_name = 'edit_requests' then
    d := new.data->'proposedDiscount'; items := coalesce(new.data->'proposedItems','[]'::jsonb);
    dd := coalesce((new.data->>'proposedDeliveryDiscount')::numeric, 0);
    fee := coalesce((new.data->>'proposedDeliveryFee')::numeric, 0);
  else
    d := new.data->'discount'; items := coalesce(new.data->'items','[]'::jsonb);
    dd := coalesce((new.data->>'deliveryDiscount')::numeric, 0);
    fee := coalesce((new.data->>'deliveryFee')::numeric, 0);
    if tg_op = 'UPDATE' then
      od := old.data->'discount';
      if od is not distinct from d and (old.data->'items') is not distinct from (new.data->'items')
         and (old.data->'deliveryDiscount') is not distinct from (new.data->'deliveryDiscount')
         and (old.data->'deliveryFee') is not distinct from (new.data->'deliveryFee') then return new; end if;
      if public.has_perm('ventas.aprobar_cambios') and current_setting('tomates.via_rpc', true) = 'on' then return new; end if;
    end if;
  end if;
  if dd > 0 then
    if not (coalesce(d->>'kind','') = 'pct' and coalesce((d->>'value')::numeric, 0) >= 100) then
      raise exception 'Solo un descuento del 100%% deja gratis el domicilio';
    end if;
    if dd > fee + 1 then raise exception 'El descuento del domicilio no puede ser mayor que la tarifa'; end if;
  end if;
  amt := coalesce((d->>'amount')::numeric, 0);
  if amt <= 0 then return new; end if;
  select coalesce(sum(coalesce((it->>'price')::numeric,0) * coalesce((it->>'qty')::numeric,0)),0) into sub
    from jsonb_array_elements(items) it;
  if amt > sub + 1 then raise exception 'El descuento no puede ser mayor que el valor de los productos'; end if;
  if coalesce(d->>'promoId','') <> '' then
    select * into p from public.promotions where id = d->>'promoId';
    if p.id is null then raise exception 'La promoción ya no existe'; end if;
    if tg_op = 'INSERT' and not public.promo_valid_today(p) then raise exception 'La promoción "%" no está vigente hoy', p.name; end if;
    expected := case p.kind when 'pct' then round(sub * p.value / 100) else least(p.value, sub) end;
    if abs(expected - amt) > 1 then raise exception 'El descuento no coincide con la promoción "%"', p.name; end if;
  elsif not public.has_perm('ventas.descuento_libre') then
    if coalesce(d->>'status','') = 'por_aprobar' then
      if coalesce(btrim(d->>'reason'),'') = '' then raise exception 'Escribe el motivo del descuento'; end if;
    elsif tg_op = 'UPDATE' and tg_table_name = 'orders'
          and (od->>'kind') is not distinct from (d->>'kind') and (od->>'value') is not distinct from (d->>'value')
          and coalesce(od->>'status','') = coalesce(d->>'status','') then
      null; -- el mismo descuento que ya estaba (dado o aprobado por el administrador)
    else
      raise exception 'El descuento libre del vendedor queda por aprobar del administrador' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create or replace function public.review_discount(p_order_id text, p_ok boolean, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare o jsonb; d jsonb; sub numeric; fee numeric; total numeric; paid numeric; now_ms bigint := (extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if not public.has_perm('ventas.descuento_libre') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  select data into o from public.orders where id = p_order_id for update;
  if o is null then raise exception 'El pedido ya no existe'; end if;
  d := o->'discount';
  if coalesce(d->>'status','') <> 'por_aprobar' then raise exception 'Este descuento ya fue revisado'; end if;
  if p_ok then
    o := o || jsonb_build_object('discount', d || jsonb_build_object('status','aprobado','reviewedBy', auth.uid(), 'reviewedAt', now_ms));
  else
    select coalesce(sum(coalesce((it->>'price')::numeric,0) * coalesce((it->>'qty')::numeric,0)),0) into sub
      from jsonb_array_elements(coalesce(o->'items','[]'::jsonb)) it;
    fee := coalesce((o->>'deliveryFee')::numeric, 0);
    total := sub + fee;
    o := o || jsonb_build_object('discount', null, 'discountAmount', 0, 'deliveryDiscount', 0, 'subtotal', sub, 'total', total,
                                 'discountRejected', d || jsonb_build_object('status','rechazado','reviewedBy', auth.uid(), 'reviewedAt', now_ms, 'note', left(coalesce(p_note,''),120)));
    if coalesce(o->>'paymentMethod','') = 'cortesia' then
      -- era cortesía por el 100%: vuelve a quedar sin cobrar
      o := o - 'paymentStatus' - 'paymentMethod' - 'paymentMethodLabel' - 'paymentAmount' - 'paidAt' - 'paidDate';
    elsif coalesce(o->>'paymentStatus','') in ('pagado','por_confirmar') then
      paid := coalesce((o->>'paymentAmount')::numeric, 0) + coalesce((select sum((x->>'amount')::numeric) from jsonb_array_elements(coalesce(o->'extraPayments','[]'::jsonb)) x), 0);
      if total - paid > 0 then o := o || jsonb_build_object('balanceDue', total - paid); end if;
    end if;
  end if;
  perform set_config('tomates.via_rpc', 'on', true);
  update public.orders set data = o where id = p_order_id;
  perform set_config('tomates.via_rpc', 'off', true);
  return o;
end $$;
revoke all on function public.review_discount(text, boolean, text) from public, anon;
grant execute on function public.review_discount(text, boolean, text) to authenticated;

-- Cobrar la diferencia que quedó pendiente
create or replace function public.settle_balance(p_order_id text, p_method text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o jsonb; due numeric; now_ms bigint := (extract(epoch from clock_timestamp())*1000)::bigint;
        today text := (now() at time zone 'America/Bogota')::date::text;
begin
  if not public.has_perm('ventas.cobrar') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  if p_method not in ('efectivo','qr','datafono') then raise exception 'Elige cómo se cobró'; end if;
  select data into o from public.orders where id = p_order_id for update;
  if o is null then raise exception 'El pedido ya no existe'; end if;
  due := coalesce((o->>'balanceDue')::numeric, 0);
  if due <= 0 then raise exception 'Este pedido no tiene diferencia por cobrar'; end if;
  o := (o - 'balanceDue') || jsonb_build_object('extraPayments', coalesce(o->'extraPayments','[]'::jsonb) || jsonb_build_array(
         jsonb_build_object('amount', due, 'method', p_method, 'date', today, 'at', now_ms, 'by', auth.uid())));
  perform set_config('tomates.via_rpc', 'on', true);
  update public.orders set data = o where id = p_order_id;
  perform set_config('tomates.via_rpc', 'off', true);
  return o;
end $$;
revoke all on function public.settle_balance(text, text) from public, anon;
grant execute on function public.settle_balance(text, text) to authenticated;

-- ============ 5) Facturas por foto también desde Gastos ============
drop policy if exists fact_insert on storage.objects;
drop policy if exists fact_read on storage.objects;
create policy fact_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'facturas' and (public.has_perm('compras.gestionar') or public.has_perm('gastos.gestionar')));
create policy fact_read on storage.objects for select to authenticated
  using (bucket_id = 'facturas' and (public.has_perm('compras.gestionar') or public.has_perm('gastos.gestionar')));
drop policy if exists p_read on public.invoices;
drop policy if exists p_insert on public.invoices;
create policy p_read on public.invoices for select to authenticated using (public.has_perm('compras.gestionar') or public.has_perm('gastos.gestionar'));
create policy p_insert on public.invoices for insert to authenticated with check (public.has_perm('compras.gestionar') or public.has_perm('gastos.gestionar'));

select 'ok' as resultado;
