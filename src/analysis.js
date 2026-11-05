/* =====================================================================
   Tomates — pestaña "Análisis" (solo administrador, permiso analisis.ver)
   Ventas contra compras por día, semana o mes, costo teórico de lo
   vendido según recetas y márgenes por producto.
===================================================================== */
(function(){
  const TOM = window.TOM; const sb = TOM.sb;
  const escH = (s)=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const MES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const pad = (n)=>String(n).padStart(2,'0');
  const toDate = (s)=>{ const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
  const ds = (d)=> d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
  const addDays = (s,n)=>{ const d = toDate(s); d.setDate(d.getDate()+n); return ds(d); };
  const monday = (s)=>{ const d = toDate(s); const w = (d.getDay()+6)%7; d.setDate(d.getDate()-w); return ds(d); };
  const pctTxt = (p)=> p==null||!isFinite(p) ? '—' : p.toLocaleString('es-CO',{maximumFractionDigits:1})+' %';

  let group = 'semana';
  let costHist = null; // ingredient_cost_history ordenado

  /* ---------- Pestaña y botón ---------- */
  const main = document.querySelector('main');
  const sec = document.createElement('section');
  sec.className = 'tab'; sec.id = 'tab-analisis';
  sec.innerHTML = `
    <h2 class="section-title">Análisis</h2>
    <div class="banner">Solo para el administrador: ventas contra compras, costo de lo vendido y márgenes.</div>
    <div class="segmented" id="anGroup">
      <button data-g="dia">Día</button><button data-g="semana" class="active">Semana</button><button data-g="mes">Mes</button>
    </div>
    <div class="grid2">
      <div><label for="anFrom">Desde</label><input id="anFrom" type="date"></div>
      <div><label for="anTo">Hasta</label><input id="anTo" type="date"></div>
    </div>
    <div id="anBody" style="margin-top:14px"><div class="empty">Cargando…</div></div>`;
  main.appendChild(sec);

  const nav = document.querySelector('nav.tabbar');
  const btn = document.createElement('button');
  btn.dataset.tab = 'analisis'; btn.style.display = 'none';
  btn.innerHTML = '<span class="ic">📈</span>Análisis';
  const usuariosBtn = nav.querySelector('button[data-tab="usuarios"]');
  nav.insertBefore(btn, usuariosBtn);
  btn.addEventListener('click', ()=>{
    nav.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    btn.classList.add('active'); sec.classList.add('active');
    updateTopAction('analisis');
    renderAnalysis();
  });

  function setDefaults(){
    const to = todayStr();
    const from = group==='dia' ? addDays(to,-13) : group==='semana' ? addDays(monday(to),-7*7) : (()=>{ const d = toDate(to); d.setMonth(d.getMonth()-5); d.setDate(1); return ds(d); })();
    document.getElementById('anFrom').value = from; document.getElementById('anTo').value = to;
  }
  setDefaults();
  sec.querySelectorAll('#anGroup button').forEach(b=>b.addEventListener('click', ()=>{
    group = b.dataset.g;
    sec.querySelectorAll('#anGroup button').forEach(x=>x.classList.toggle('active', x===b));
    setDefaults(); renderAnalysis();
  }));
  ['anFrom','anTo'].forEach(id=>document.getElementById(id).addEventListener('change', ()=>renderAnalysis()));

  /* ---------- Costos según la fecha (historial de costos) ---------- */
  async function loadCostHist(){
    const { data, error } = await sb.from('ingredient_cost_history').select('ingredient_id,cost,effective_date,created_at')
      .order('effective_date',{ascending:true}).order('created_at',{ascending:true}).limit(10000);
    if(error) throw new Error(TOM.friendly(error));
    const by = {}; (data||[]).forEach(h=>{ (by[h.ingredient_id] = by[h.ingredient_id] || []).push(h); });
    costHist = by;
  }
  function ingCostAt(id, date){
    const hs = costHist && costHist[id];
    if(hs && hs.length){ let c = null; for(const h of hs){ if(h.effective_date <= date) c = h; else break; } if(c) return Number(c.cost); return Number(hs[0].cost); }
    const ing = ingredientById(id); return ing ? Number(ing.currentCost||0) : 0;
  }
  function recipeCostAt(rid, date, seen){
    const r = recipeById(rid); if(!r || !r.items) return 0;
    seen = seen || new Set(); if(seen.has(rid)) return 0; seen.add(rid);
    const tot = r.items.reduce((s,it)=> s + (it.qty||0) * (it.subRecipeId ? recipeCostAt(it.subRecipeId, date, new Set(seen)) : ingCostAt(it.ingredientId, date)), 0);
    return tot / ((r.yieldQty)||1);
  }
  function productCostAt(pid, date){
    const p = productById(pid); if(!p) return 0;
    if(p.ingredientId) return ingCostAt(p.ingredientId, date);
    if(p.recipeId) return recipeCostAt(p.recipeId, date);
    return 0;
  }

  /* ---------- Agrupación ---------- */
  const keyOf = (d)=> group==='dia' ? d : group==='semana' ? monday(d) : d.slice(0,7);
  function labelOf(k){
    if(group==='mes'){ const [y,m] = k.split('-'); return `${MES[Number(m)-1]} ${y}`; }
    const d = toDate(k);
    if(group==='dia') return `${['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d.getDay()]} ${d.getDate()} ${MES[d.getMonth()]}`;
    const e = toDate(addDays(k,6));
    return `${d.getDate()} ${MES[d.getMonth()]} – ${e.getDate()} ${MES[e.getMonth()]}`;
  }
  function bucketKeys(from, to){
    const out = []; let k = keyOf(from);
    while(k <= keyOf(to)){ out.push(k);
      if(group==='dia') k = addDays(k,1);
      else if(group==='semana') k = addDays(k,7);
      else { const d = toDate(k+'-01'); d.setMonth(d.getMonth()+1); k = ds(d).slice(0,7); }
      if(out.length > 400) break; }
    return out;
  }

  /* ---------- Gráfico de barras: ventas vs compras ---------- */
  function barChart(rows){
    if(!rows.length) return '';
    if(!rows.some(r=>r.sales>0 || r.purchases>0)) return '<div class="item-meta" style="margin:10px 0">Aún no hay ventas entregadas ni compras registradas en este rango.</div>';
    const bw = 14, gap = 4, groupW = bw*2 + gap + 16, padL = 54, padB = 34, padT = 10, H = 190;
    const W = Math.max(320, padL + rows.length*groupW + 8);
    const max = Math.max(1, ...rows.map(r=>Math.max(r.sales, r.purchases)));
    const Y = (v)=> padT + (1 - v/max) * (H - padT - padB);
    const ticks = [0, max/2, max].map(v=>`<line x1="${padL}" x2="${W-4}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" style="stroke:var(--border)"/><text x="${padL-6}" y="${(Y(v)+4).toFixed(1)}" text-anchor="end" style="fill:var(--muted);font-size:10px">${escH(fmt(v))}</text>`).join('');
    const bars = rows.map((r,i)=>{
      const x = padL + 8 + i*groupW;
      const lab = r.label.length > 12 ? r.label.slice(0,12) : r.label;
      return `<rect x="${x}" y="${Y(r.sales).toFixed(1)}" width="${bw}" height="${(Y(0)-Y(r.sales)).toFixed(1)}" style="fill:var(--tm-red)"><title>Ventas ${escH(r.label)}: ${escH(fmt(r.sales))}</title></rect>
        <rect x="${x+bw+gap}" y="${Y(r.purchases).toFixed(1)}" width="${bw}" height="${(Y(0)-Y(r.purchases)).toFixed(1)}" style="fill:var(--fg)"><title>Compras ${escH(r.label)}: ${escH(fmt(r.purchases))}</title></rect>
        <text x="${x+bw+gap/2}" y="${H-padB+14}" text-anchor="middle" style="fill:var(--muted);font-size:9.5px">${escH(lab)}</text>`;
    }).join('');
    return `<div style="display:flex;gap:14px;font-size:12.5px;margin:6px 0">
        <span><i style="display:inline-block;width:10px;height:10px;background:var(--tm-red);margin-right:5px"></i>Ventas</span>
        <span><i style="display:inline-block;width:10px;height:10px;background:var(--fg);margin-right:5px"></i>Compras</span></div>
      <div style="overflow-x:auto;border:1px solid var(--border);border-radius:0.75rem;background:var(--card)">
        <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Ventas y compras por periodo" style="display:block">${ticks}${bars}</svg></div>`;
  }

  /* ---------- Render ---------- */
  window.renderAnalysis = async function(){
    if(!sec.classList.contains('active') || !TOM.can('analisis.ver')) return;
    const body = document.getElementById('anBody');
    let from = document.getElementById('anFrom').value, to = document.getElementById('anTo').value;
    if(!from || !to){ setDefaults(); from = document.getElementById('anFrom').value; to = document.getElementById('anTo').value; }
    if(from > to){ body.innerHTML = '<div class="banner">La fecha "Desde" debe ser anterior a "Hasta".</div>'; return; }
    try{ if(!costHist) await loadCostHist(); }catch(e){ body.innerHTML = `<div class="banner">${escH(e.message)}</div>`; return; }

    const keys = bucketKeys(from, to);
    const B = {}; keys.forEach(k=> B[k] = { key:k, label:labelOf(k), orders:0, sales:0, purchases:0, cogs:0 });
    const prod = {};
    const addProd = (pid, units, revenue, cost)=>{ if(!pid) return; const p = prod[pid] = prod[pid] || { units:0, revenue:0, cost:0 }; p.units += units; p.revenue += revenue; p.cost += cost; };

    (state.orders||[]).filter(o=>o.status==='entregado' && o.date && o.date>=from && o.date<=to).forEach(o=>{
      const b = B[keyOf(o.date)]; if(!b) return;
      b.orders += 1; b.sales += (o.total||0) - (o.deliveryFee||0);
      (o.items||[]).forEach(it=>{
        const q = it.qty||0, price = (it.price||0)*q;
        if(it.type==='mitad'){
          const ca = productCostAt(it.flavorAId, o.date)*q*0.5, cb = productCostAt(it.flavorBId, o.date)*q*0.5;
          b.cogs += ca + cb; addProd(it.flavorAId, q*0.5, price/2, ca); addProd(it.flavorBId, q*0.5, price/2, cb);
        } else {
          const c = productCostAt(it.productId, o.date)*q; b.cogs += c; addProd(it.productId, q, price, c);
        }
      });
    });
    (state.purchases||[]).filter(p=>p.date && p.date>=from && p.date<=to).forEach(p=>{ const b = B[keyOf(p.date)]; if(b) b.purchases += p.totalCost||0; });

    const rows = keys.map(k=>B[k]);
    const T = rows.reduce((t,r)=>({ orders:t.orders+r.orders, sales:t.sales+r.sales, purchases:t.purchases+r.purchases, cogs:t.cogs+r.cogs }), {orders:0,sales:0,purchases:0,cogs:0});
    const diff = T.sales - T.purchases;
    const kpi = (v,l,cls)=>`<div class="kpi"><div class="v"${cls?` style="color:${cls}"`:''}>${v}</div><div class="l">${l}</div></div>`;

    const prodRows = Object.entries(prod).map(([pid,v])=>({ p: productById(pid), ...v })).filter(x=>x.p)
      .sort((a,b)=> (b.revenue-b.cost) - (a.revenue-a.cost));
    const allMargins = (state.products||[]).map(p=>{ const c = productCostAt(p.id, to); return { p, c, m: p.price>0 ? (p.price-c)/p.price*100 : null }; })
      .sort((a,b)=> (a.p.category||'').localeCompare(b.p.category||'') || a.p.name.localeCompare(b.p.name));

    body.innerHTML = `
      <div class="kpi-grid">
        ${kpi(fmt(T.sales),'Ventas (sin domicilios)')}
        ${kpi(fmt(T.purchases),'Compras')}
        ${kpi(fmt(diff),'Ventas − compras', diff<0?'var(--tm-red)':'')}
        ${kpi(pctTxt(T.sales>0 ? T.purchases/T.sales*100 : null),'Compras / ventas')}
        ${kpi(fmt(T.cogs),'Costo teórico de lo vendido')}
        ${kpi(pctTxt(T.sales>0 ? (T.sales-T.cogs)/T.sales*100 : null),'Margen bruto teórico')}
      </div>
      <div class="item-meta" style="margin-bottom:6px">${T.orders} pedido${T.orders===1?'':'s'} entregado${T.orders===1?'':'s'} entre ${escH(labelOf(keyOf(from)))} y ${escH(labelOf(keyOf(to)))}.</div>
      ${barChart(rows)}
      <h3 class="section-title" style="font-size:20px;margin-top:18px">Por ${group==='dia'?'día':group==='semana'?'semana':'mes'}</h3>
      <div class="perm-wrap"><table class="perm-table" style="min-width:560px">
        <thead><tr><th style="text-align:left">Periodo</th><th>Pedidos</th><th>Ventas</th><th>Compras</th><th>Ventas − compras</th><th>Costo teórico</th></tr></thead>
        <tbody>${rows.slice().reverse().map(r=>`<tr>
          <td>${escH(r.label)}</td><td style="text-align:right">${r.orders}</td>
          <td style="text-align:right">${escH(fmt(r.sales))}</td><td style="text-align:right">${escH(fmt(r.purchases))}</td>
          <td style="text-align:right;${r.sales-r.purchases<0?'color:var(--tm-red);font-weight:700':''}">${escH(fmt(r.sales-r.purchases))}</td>
          <td style="text-align:right">${escH(fmt(r.cogs))}</td></tr>`).join('')}
          <tr style="font-weight:700"><td>Total</td><td style="text-align:right">${T.orders}</td><td style="text-align:right">${escH(fmt(T.sales))}</td><td style="text-align:right">${escH(fmt(T.purchases))}</td><td style="text-align:right">${escH(fmt(diff))}</td><td style="text-align:right">${escH(fmt(T.cogs))}</td></tr>
        </tbody></table></div>

      <h3 class="section-title" style="font-size:20px;margin-top:18px">Productos vendidos</h3>
      ${prodRows.length ? `<div class="perm-wrap"><table class="perm-table" style="min-width:520px">
        <thead><tr><th style="text-align:left">Producto</th><th>Unidades</th><th>Ventas</th><th>Costo</th><th>Utilidad bruta</th><th>Margen</th></tr></thead>
        <tbody>${prodRows.map(x=>`<tr><td>${escH(x.p.name)}</td><td style="text-align:right">${fmtQty(x.units)}</td>
          <td style="text-align:right">${escH(fmt(x.revenue))}</td><td style="text-align:right">${escH(fmt(x.cost))}</td>
          <td style="text-align:right">${escH(fmt(x.revenue-x.cost))}</td><td style="text-align:right">${pctTxt(x.revenue>0?(x.revenue-x.cost)/x.revenue*100:null)}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty" style="padding:14px">No hay ventas entregadas en este rango.</div>'}

      <h3 class="section-title" style="font-size:20px;margin-top:18px">Margen por producto del menú</h3>
      <div class="item-meta" style="margin-bottom:6px">Precio de venta frente al costo de la receta con los precios de insumos vigentes al ${escH(labelOf(to))}.</div>
      <div class="perm-wrap"><table class="perm-table" style="min-width:460px">
        <thead><tr><th style="text-align:left">Producto</th><th>Precio</th><th>Costo</th><th>Margen</th></tr></thead>
        <tbody>${allMargins.map(x=>`<tr><td>${escH(x.p.name)}<div class="item-meta">${escH(x.p.category||'')}</div></td>
          <td style="text-align:right">${escH(fmt(x.p.price))}</td><td style="text-align:right">${escH(fmt(x.c))}</td>
          <td style="text-align:right"><span class="pill ${x.m==null?'':x.m>=40?'good':x.m>=20?'warn':'bad'}">${pctTxt(x.m)}</span></td></tr>`).join('')}</tbody></table></div>

      <div class="item-meta" style="margin-top:12px">Ventas: pedidos entregados en su fecha, sin el valor del domicilio. Compras: registro de compras por fecha de compra. Costo teórico: lo que debió consumirse según las recetas, con el costo de cada insumo vigente el día de la venta.</div>`;
  };

  // Mantener actualizado con los datos en vivo
  const _renderAll = window.renderAll;
  window.renderAll = function(){ _renderAll(); if(sec.classList.contains('active')) renderAnalysis(); };
  TOM.whenReady.then(()=>{
    if(!TOM.can('analisis.ver')) return;
    sb.channel('an_cost_watch').on('postgres_changes', { event:'INSERT', schema:'public', table:'ingredient_cost_history' }, ()=>{ costHist = null; if(sec.classList.contains('active')) renderAnalysis(); }).subscribe();
  });
})();
