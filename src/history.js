/* =====================================================================
   Tomates — historial de costos de insumos
   · Al editar un insumo, el cambio de costo se guarda con la fecha elegida.
   · Botón "Precios" en cada insumo: gráfico y tabla de su historial.
   · En Informes: variación del costo de cada insumo en el rango de fechas.
   El registro lo hace la base de datos (tabla ingredient_cost_history).
===================================================================== */
(function(){
  const TOM = window.TOM; const sb = TOM.sb;
  const escH = (s)=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const SRC = { inicial:'Costo inicial', compra:'Compra', manual:'Cambio manual' };
  const pct = (a,b)=> (a>0 ? ((b-a)/a*100) : null);
  const fmtPct = (p)=> p==null ? '—' : (p>0?'+':'') + p.toLocaleString('es-CO',{maximumFractionDigits:1}) + ' %';
  const fmtDate = (d)=> { if(!d) return ''; const [y,m,dd] = String(d).slice(0,10).split('-'); return `${dd}/${m}/${y}`; };
  const canSeeCosts = ()=> TOM.can('inventario.ver') || TOM.can('menu.ver_costos') || TOM.can('compras.gestionar');

  async function loadHistory(ingredientId){
    let q = sb.from('ingredient_cost_history').select('*').order('effective_date', { ascending:true }).order('created_at', { ascending:true });
    if(ingredientId) q = q.eq('ingredient_id', ingredientId);
    const { data, error } = await q.limit(5000);
    if(error) throw new Error(TOM.friendly(error));
    return data || [];
  }
  const who = (uid)=>{ if(!uid) return ''; const r = (state.roles||[]).find(x=>x.id===uid); return r ? (r.name||r.email||'') : ''; };

  /* ---------- Gráfico escalonado del costo ---------- */
  function chartSvg(rows, unit){
    if(rows.length < 2) return '';
    const W = 320, H = 120, padL = 46, padR = 8, padT = 10, padB = 22;
    const t = rows.map(r=> new Date(r.effective_date+'T12:00:00').getTime());
    const today = Date.now();
    const t0 = Math.min(...t), t1 = Math.max(today, ...t);
    const v = rows.map(r=>Number(r.cost));
    let lo = Math.min(...v), hi = Math.max(...v); if(hi===lo){ hi = hi*1.1 || 1; lo = lo*0.9; }
    const X = (x)=> padL + (t1===t0 ? 0 : (x-t0)/(t1-t0)) * (W-padL-padR);
    const Y = (y)=> padT + (1-(y-lo)/(hi-lo)) * (H-padT-padB);
    let d = `M${X(t[0]).toFixed(1)},${Y(v[0]).toFixed(1)}`;
    for(let i=1;i<rows.length;i++){ d += ` H${X(t[i]).toFixed(1)} V${Y(v[i]).toFixed(1)}`; }
    d += ` H${X(t1).toFixed(1)}`;
    const dots = rows.map((r,i)=>`<circle cx="${X(t[i]).toFixed(1)}" cy="${Y(v[i]).toFixed(1)}" r="3.2" style="fill:var(--tm-red);stroke:var(--card);stroke-width:1.5"/>`).join('');
    const lab = (y)=>`<text x="${padL-6}" y="${(Y(y)+4).toFixed(1)}" text-anchor="end" style="fill:var(--muted);font-size:10px">${escH(fmtCost(y))}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Evolución del costo por ${escH(unit)}" style="display:block;max-width:100%;margin:6px 0 10px">
      <line x1="${padL}" x2="${W-padR}" y1="${Y(hi).toFixed(1)}" y2="${Y(hi).toFixed(1)}" style="stroke:var(--border)"/>
      <line x1="${padL}" x2="${W-padR}" y1="${Y(lo).toFixed(1)}" y2="${Y(lo).toFixed(1)}" style="stroke:var(--border)"/>
      ${lab(hi)}${lab(lo)}
      <path d="${d}" style="fill:none;stroke:var(--fg);stroke-width:2"/>
      ${dots}
      <text x="${padL}" y="${H-6}" style="fill:var(--muted);font-size:10px">${escH(fmtDate(rows[0].effective_date))}</text>
      <text x="${W-padR}" y="${H-6}" text-anchor="end" style="fill:var(--muted);font-size:10px">Hoy</text>
    </svg>`;
  }

  function historyTable(rows, unit){
    if(!rows.length) return '<div class="empty" style="padding:14px">Todavía no hay cambios de precio registrados.</div>';
    const first = Number(rows[0].cost), last = Number(rows[rows.length-1].cost);
    const list = [...rows].reverse().map(r=>{
      const p = r.previous_cost!=null ? pct(Number(r.previous_cost), Number(r.cost)) : null;
      const extra = [r.note, who(r.changed_by)].filter(Boolean).map(escH).join(' · ');
      return `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--border);align-items:flex-start">
        <div style="min-width:0">
          <div class="item-name" style="font-size:14px">${escH(fmtDate(r.effective_date))} · ${escH(SRC[r.source]||r.source)}</div>
          ${extra ? `<div class="item-meta">${extra}</div>` : ''}
        </div>
        <div style="text-align:right;white-space:nowrap">
          <div class="item-name" style="font-size:14px">${escH(fmtCost(r.cost))} / ${escH(unit)}</div>
          <div class="item-meta">${p==null ? '' : fmtPct(p)}</div>
        </div>
      </div>`;
    }).join('');
    return `<div class="row" style="margin:4px 0 2px"><span class="item-meta">Desde el primer registro</span><span class="pill ${last>first?'bad':'good'}">${fmtPct(pct(first,last))}</span></div>
      ${chartSvg(rows, unit)}
      <div class="subtle-list">${list}</div>`;
  }

  /* ---------- Ventana de historial de un insumo ---------- */
  window.openCostHistory = async function(id){
    const i = state.ingredients.find(x=>x.id===id); if(!i) return;
    modalBody.innerHTML = `<h3>Precios — ${escH(i.name)}</h3>
      <div class="item-meta">Costo vigente: <b>${escH(fmtCost(i.currentCost||0))}</b> por ${escH(i.unit)}</div>
      <div id="costHistBody" style="margin-top:8px"><div class="item-meta">Cargando historial…</div></div>
      <div class="modal-actions">
        <button class="secondary" onclick="closeModal()">Cerrar</button>
        ${TOM.can('menu.gestionar') ? `<button class="primary" onclick="openIngredientModal('${i.id}')">Cambiar precio</button>` : ''}
      </div>`;
    modalBg.classList.add('open');
    try{ const rows = await loadHistory(id); const b = document.getElementById('costHistBody'); if(b) b.innerHTML = historyTable(rows, i.unit); }
    catch(e){ const b = document.getElementById('costHistBody'); if(b) b.innerHTML = `<div class="banner">${escH(e.message)}</div>`; }
  };

  /* ---------- Editar insumo: fecha del precio + historial ---------- */
  const _openIng = window.openIngredientModal;
  window.openIngredientModal = function(id){
    _openIng(id);
    const i = id ? state.ingredients.find(x=>x.id===id) : null;
    const costInput = document.getElementById('iCost');
    if(costInput){
      costInput.step = 'any';
      const grid = costInput.closest('.grid2');
      const extra = document.createElement('div');
      extra.innerHTML = i ? `
        <div class="grid2">
          <div><label for="iCostDate">Fecha del precio</label><input id="iCostDate" type="date" value="${todayStr()}" max="${todayStr()}"></div>
          <div><label for="iCostNote">Motivo (opcional)</label><input id="iCostNote" placeholder="Proveedor, alza…" maxlength="120"></div>
        </div>
        <div class="item-meta" style="margin-top:6px">Si cambias el costo, el precio anterior queda guardado en el historial con esta fecha.</div>
        <h3 style="margin-top:16px;font-size:18px">Historial de precios</h3>
        <div id="costHistBody"><div class="item-meta">Cargando historial…</div></div>`
      : `<div class="item-meta" style="margin-top:6px">El costo inicial queda guardado como primer registro del historial.</div>`;
      grid.after(extra);
    }
    if(i){ loadHistory(id).then(rows=>{ const b = document.getElementById('costHistBody'); if(b) b.innerHTML = historyTable(rows, i.unit); })
             .catch(e=>{ const b = document.getElementById('costHistBody'); if(b) b.innerHTML = `<div class="banner">${escH(e.message)}</div>`; }); }
  };

  window.saveIngredient = function(id){ return guarded('saveIngredient', async ()=>{
    if(!db) return;
    const data = {
      name: document.getElementById('iName').value.trim(),
      unit: document.getElementById('iUnit').value.trim()||'unidad',
      stock: Number(document.getElementById('iStock').value)||0,
      minStock: Number(document.getElementById('iMin').value)||0,
    };
    const cost = Number(document.getElementById('iCost').value)||0;
    if(!data.name){ toast('Escribe el nombre del insumo.'); return; }
    try{
      if(id){
        const prev = state.ingredients.find(x=>x.id===id);
        await db.collection('ingredients').doc(id).update(data);
        if(!prev || Number(prev.currentCost||0) !== cost){
          const dEl = document.getElementById('iCostDate'), nEl = document.getElementById('iCostNote');
          await TOM.rpc('set_ingredient_cost', { p_ingredient_id:id, p_cost:cost,
            p_date: (dEl && dEl.value) || todayStr(), p_note: (nEl && nEl.value.trim()) || '' });
          toast('Precio actualizado y guardado en el historial', 'ok');
        }
      } else {
        await db.collection('ingredients').add({ ...data, currentCost: cost });
      }
      closeModal();
    }catch(e){ toast(e.message); }
  }); };

  /* ---------- Botón "Precios" en cada insumo ---------- */
  const _renderIng = window.renderIngredients;
  window.renderIngredients = function(){
    _renderIng();
    if(!canSeeCosts()) return;
    document.querySelectorAll('#ingredientsList button[onclick^="openIngredientModal("]').forEach(btn=>{
      const m = btn.getAttribute('onclick').match(/openIngredientModal\('([^']+)'\)/); if(!m) return;
      if(btn.parentElement.querySelector('[data-costhist]')) return;
      const b = document.createElement('button'); b.className = 'ghost'; b.textContent = 'Precios'; b.dataset.costhist = m[1];
      b.addEventListener('click', ()=>openCostHistory(m[1]));
      btn.before(b);
    });
  };

  /* ---------- Informes: variación de costos en el rango ---------- */
  const _renderReports = window.renderReports;
  window.renderReports = function(){
    const r = _renderReports.apply(this, arguments);
    if(!canSeeCosts() || !TOM.can('informes.ver')) return r;
    const body = document.getElementById('reportsBody'); if(!body) return r;
    const from = document.getElementById('repFrom').value, to = document.getElementById('repTo').value;
    const box = document.createElement('div'); box.className = 'card'; box.id = 'costVarBox';
    box.innerHTML = `<div class="item-name" style="font-size:16px">📈 Variación de costos de insumos</div>
      <div class="item-meta">Costo al inicio y al final del rango, según compras y cambios registrados.</div>
      <div id="costVarBody" style="margin-top:8px"><div class="item-meta">Calculando…</div></div>`;
    const old = document.getElementById('costVarBox'); if(old) old.remove();
    body.appendChild(box);
    loadHistory(null).then(rows=>{
      const byIng = {};
      rows.forEach(h=>{ (byIng[h.ingredient_id] = byIng[h.ingredient_id] || []).push(h); });
      const out = [];
      Object.entries(byIng).forEach(([iid, hs])=>{
        const ing = state.ingredients.find(x=>x.id===iid); if(!ing) return;
        const atOrBefore = (d)=>{ let c = null; hs.forEach(h=>{ if(h.effective_date <= d) c = h; }); return c; };
        const start = atOrBefore(from) || hs[0];
        const end = atOrBefore(to); if(!end) return;
        const changes = hs.filter(h=>h.effective_date >= from && h.effective_date <= to && h.source !== 'inicial').length;
        const p = pct(Number(start.cost), Number(end.cost));
        out.push({ ing, a:Number(start.cost), b:Number(end.cost), p, changes });
      });
      const changed = out.filter(x=>x.changes>0 || (x.p && Math.abs(x.p)>0.0001)).sort((x,y)=>Math.abs(y.p||0)-Math.abs(x.p||0));
      const el = document.getElementById('costVarBody'); if(!el) return;
      if(!changed.length){ el.innerHTML = `<div class="item-meta">Ningún insumo cambió de costo entre ${escH(fmtDate(from))} y ${escH(fmtDate(to))}.</div>`; return; }
      el.innerHTML = `<div class="subtle-list">` + changed.map(x=>`
        <div class="row" style="cursor:pointer" onclick="openCostHistory('${x.ing.id}')">
          <div style="min-width:0"><div class="item-name" style="font-size:14px">${escH(x.ing.name)}</div>
            <div class="item-meta">${escH(fmtCost(x.a))} → ${escH(fmtCost(x.b))} por ${escH(x.ing.unit)} · ${x.changes} cambio${x.changes===1?'':'s'}</div></div>
          <span class="pill ${x.p>0?'bad':'good'}">${fmtPct(x.p)}</span>
        </div>`).join('') + `</div>`;
    }).catch(e=>{ const el = document.getElementById('costVarBody'); if(el) el.innerHTML = `<div class="banner">${escH(e.message)}</div>`; });
    return r;
  };

  // Si llega un cambio de costo mientras la ventana de historial está abierta, se refresca
  TOM.whenReady.then(()=>{
    if(!canSeeCosts()) return;
    sb.channel('cost_hist_watch').on('postgres_changes', { event:'INSERT', schema:'public', table:'ingredient_cost_history' }, (p)=>{
      const b = document.getElementById('costHistBody'); if(!b || !p.new) return;
      const i = state.ingredients.find(x=>x.id===p.new.ingredient_id); if(!i) return;
      const title = document.querySelector('.modal h3'); if(!title || !title.textContent.includes(i.name)) return;
      loadHistory(i.id).then(rows=>{ b.innerHTML = historyTable(rows, i.unit); });
    }).subscribe();
  });
})();
