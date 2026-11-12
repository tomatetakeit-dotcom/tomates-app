/* =====================================================================
   Tomates — Promociones y descuentos
   - El administrador (promos.gestionar) crea promociones: % o valor fijo, vigencia y días.
   - Al tomar un pedido se puede elegir una promoción vigente; el descuento libre
     solo lo da quien tenga ventas.descuento_libre (administrador).
   - El descuento aplica sobre los productos, nunca sobre el domicilio.
===================================================================== */
(function(){
  const TOM = window.TOM; const sb = TOM.sb;
  const escH = (s)=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const DAYS = [[1,'Lun'],[2,'Mar'],[3,'Mié'],[4,'Jue'],[5,'Vie'],[6,'Sáb'],[7,'Dom']];
  state.promos = [];

  async function loadPromos(){
    const { data, error } = await sb.from('promotions').select('*').order('created_at', { ascending:false });
    if(!error){ state.promos = data || []; renderPromoBits(); }
  }
  TOM.whenReady.then(()=>{
    loadPromos();
    sb.channel('promo_watch').on('postgres_changes', { event:'*', schema:'public', table:'promotions' }, loadPromos).subscribe();
    window.addEventListener('tomates:resynced', loadPromos);
  });
  function renderPromoBits(){
    const b = document.getElementById('promoBtn'); if(b) b.style.display = TOM.can('promos.gestionar') ? '' : 'none';
    if(document.getElementById('promoListModal')) openPromosModal();
  }

  const isoDow = (d)=> ((d.getDay()+6)%7)+1;
  window.promoValidToday = function(p){
    const t = todayStr();
    if(!p || !p.active) return false;
    if(p.starts_on && p.starts_on > t) return false;
    if(p.ends_on && p.ends_on < t) return false;
    if(p.weekdays && p.weekdays.length && !p.weekdays.includes(isoDow(new Date()))) return false;
    return true;
  };
  window.activePromos = ()=> (state.promos||[]).filter(promoValidToday);
  window.promoLabel = (p)=> p.kind==='pct' ? `${Number(p.value)}%` : fmt(Number(p.value));
  // Valor del descuento sobre el subtotal de productos
  window.discountAmountFor = function(disc, subtotal){
    if(!disc || !(subtotal>0)) return 0;
    const v = Number(disc.value)||0;
    const a = disc.kind==='pct' ? Math.round(subtotal * v / 100) : Math.min(v, subtotal);
    return Math.max(0, Math.min(a, subtotal));
  };

  /* ---------- Administrar promociones (botón en Menú) ---------- */
  const menuSec = document.getElementById('tab-menu');
  if(menuSec){
    const btn = document.createElement('button');
    btn.id = 'promoBtn'; btn.className = 'secondary'; btn.type = 'button';
    btn.style.cssText = 'width:100%;margin:0 0 12px;display:none';
    btn.textContent = '🏷️ Promociones y descuentos';
    btn.onclick = ()=>openPromosModal();
    const list = document.getElementById('productsList');
    menuSec.insertBefore(btn, list);
  }
  function vigencia(p){
    const parts = [];
    if(p.starts_on || p.ends_on) parts.push((p.starts_on||'…')+' a '+(p.ends_on||'…'));
    if(p.weekdays && p.weekdays.length) parts.push(DAYS.filter(([n])=>p.weekdays.includes(n)).map(([,l])=>l).join(', '));
    return parts.join(' · ') || 'Todos los días';
  }
  window.openPromosModal = function(){
    const list = state.promos||[];
    modalBody.innerHTML = `<div id="promoListModal"></div>
      <h3>Promociones</h3>
      <div class="item-meta">Las promociones activas aparecen al tomar un pedido. El descuento se aplica sobre los productos, no sobre el domicilio.</div>
      <button class="primary" style="width:100%;margin:12px 0" onclick="openPromoForm()">＋ Nueva promoción</button>
      ${list.length ? list.map(p=>`<div class="card">
          <div class="row"><div class="item-name">🏷️ ${escH(p.name)}</div>
            <span class="pill ${promoValidToday(p)?'good':(p.active?'warn':'')}">${promoValidToday(p)?'Vigente hoy':(p.active?'Activa (no hoy)':'Inactiva')}</span></div>
          <div class="item-meta">Descuento ${escH(promoLabel(p))} · ${escH(vigencia(p))}${p.note?' · '+escH(p.note):''}</div>
          <div class="row" style="margin-top:8px;gap:8px">
            <button class="ghost" onclick="openPromoForm('${p.id}')">Editar</button>
            <button class="ghost" onclick="togglePromo('${p.id}',${!p.active})">${p.active?'Desactivar':'Activar'}</button>
          </div></div>`).join('') : '<div class="empty">Aún no hay promociones.</div>'}
      <div class="modal-actions"><button class="secondary" onclick="closeModal()">Cerrar</button></div>`;
    modalBg.classList.add('open');
  };
  window.openPromoForm = function(id){
    const p = id ? (state.promos||[]).find(x=>x.id===id) : null;
    modalBody.innerHTML = `
      <h3>${p?'Editar promoción':'Nueva promoción'}</h3>
      <label for="prName">Nombre</label><input id="prName" maxlength="60" placeholder="Ej: Martes de pizza 10%" value="${escH(p?p.name:'')}">
      <label>Tipo de descuento</label>
      <div class="segmented" id="prKind">
        <button type="button" data-k="pct" class="${!p||p.kind==='pct'?'active':''}">Porcentaje %</button>
        <button type="button" data-k="fixed" class="${p&&p.kind==='fixed'?'active':''}">Valor fijo $</button>
      </div>
      <label for="prValue">Valor</label><input id="prValue" type="number" inputmode="decimal" min="1" placeholder="10" value="${p?Number(p.value):''}">
      <div class="grid2">
        <div><label for="prFrom">Desde (opcional)</label><input id="prFrom" type="date" value="${p&&p.starts_on||''}"></div>
        <div><label for="prTo">Hasta (opcional)</label><input id="prTo" type="date" value="${p&&p.ends_on||''}"></div>
      </div>
      <label>Días (ninguno = todos los días)</label>
      <div class="ot-chips" id="prDays">${DAYS.map(([n,l])=>`<button type="button" class="ot-chip${p&&p.weekdays&&p.weekdays.includes(n)?' on':''}" data-d="${n}">${l}</button>`).join('')}</div>
      <label for="prNote">Nota (opcional)</label><input id="prNote" maxlength="120" placeholder="Condiciones, ej: solo pizzas familiares" value="${escH(p?p.note:'')}">
      <label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type="checkbox" id="prActive" style="width:auto" ${!p||p.active?'checked':''}> Activa</label>
      <div id="prErr" class="item-meta" style="color:var(--bad);font-weight:700"></div>
      <div class="modal-actions">
        <button class="secondary" onclick="openPromosModal()">Volver</button>
        <button class="primary" onclick="savePromo('${p?p.id:''}')">Guardar</button>
      </div>`;
    modalBody.querySelectorAll('#prKind button').forEach(b=>b.onclick=()=>modalBody.querySelectorAll('#prKind button').forEach(x=>x.classList.toggle('active', x===b)));
    modalBody.querySelectorAll('#prDays button').forEach(b=>b.onclick=()=>b.classList.toggle('on'));
    modalBg.classList.add('open');
  };
  window.savePromo = async function(id){
    const err = (m)=>{ document.getElementById('prErr').textContent = m; };
    const name = document.getElementById('prName').value.trim();
    const kind = (modalBody.querySelector('#prKind button.active')||{}).dataset?.k || 'pct';
    const value = Number(document.getElementById('prValue').value);
    const starts_on = document.getElementById('prFrom').value || null, ends_on = document.getElementById('prTo').value || null;
    const weekdays = [...modalBody.querySelectorAll('#prDays button.on')].map(b=>Number(b.dataset.d));
    if(!name) return err('Escribe el nombre de la promoción.');
    if(!(value>0)) return err('Escribe el valor del descuento.');
    if(kind==='pct' && value>100) return err('El porcentaje no puede pasar de 100.');
    if(starts_on && ends_on && starts_on > ends_on) return err('La fecha "Desde" debe ser anterior a "Hasta".');
    const row = { name, kind, value, starts_on, ends_on, weekdays, note: document.getElementById('prNote').value.trim(), active: document.getElementById('prActive').checked };
    const q = id ? sb.from('promotions').update(row).eq('id', id) : sb.from('promotions').insert(row);
    const { error } = await q;
    if(error) return err(TOM.friendly(error));
    toast('Promoción guardada', 'ok'); await loadPromos(); openPromosModal();
  };
  window.togglePromo = async function(id, on){
    const { error } = await sb.from('promotions').update({ active:on }).eq('id', id);
    if(error) toast(TOM.friendly(error)); else loadPromos();
  };

  // Mostrar el botón cuando cambian los permisos
  const _renderAll = window.renderAll;
  window.renderAll = function(){ _renderAll(); const b = document.getElementById('promoBtn'); if(b) b.style.display = TOM.can('promos.gestionar') ? '' : 'none'; };
})();

/* ---------- Descuento en el pedido (variables globales usadas por el formulario de pedido) ---------- */
let orderDiscount = null; // { promoId, name, kind:'pct'|'fixed', value, reason }
function selectOrderDiscount(id){
  if(!id) orderDiscount = null;
  else if(id==='libre'){ if(!can('ventas.descuento_libre')) return; orderDiscount = { promoId:'', name:'', kind:'pct', value:0, reason:'' }; }
  else { const p = (state.promos||[]).find(x=>x.id===id); if(!p) return; orderDiscount = { promoId:p.id, name:p.name, kind:p.kind, value:Number(p.value), reason:'' }; }
  renderOrderMainScreen();
  if(id==='libre') setTimeout(()=>{ const el = document.getElementById('odValue'); if(el) el.focus(); }, 0);
}
function onFreeDiscountInput(){
  if(!orderDiscount || orderDiscount.promoId) return;
  const k = document.getElementById('odKind'), v = document.getElementById('odValue'), r = document.getElementById('odReason');
  orderDiscount.kind = k ? k.value : 'pct';
  orderDiscount.value = v ? (Number(v.value)||0) : 0;
  orderDiscount.reason = r ? r.value.trim().slice(0,80) : '';
  updateOrderTotalPreview();
}
// Un descuento del 100% deja gratis también el domicilio (el negocio asume el pago al domiciliario)
function deliveryDiscountFor(disc, fee){ return disc && disc.kind==='pct' && Number(disc.value)>=100 ? (Number(fee)||0) : 0; }
function existingPaid(id){ const o = id && state.orders.find(x=>x.id===id); return !!(o && o.paymentStatus==='pagado' && o.paymentMethod!=='cortesia'); }
// Lo que el cliente pagó por domicilio (para informes: es valor de paso)
function deliveryCharged(o){ return Math.max(0, (Number(o.deliveryFee)||0) - (Number(o.deliveryDiscount)||0)); }
function orderTotalBreakHtml(sub, dsc){
  const fee = orderDeliveryFee||0, dd = deliveryDiscountFor(orderDiscount, fee);
  if(!dsc && !fee) return '';
  return 'Productos ' + fmt(sub) + (dsc ? ' · Descuento −' + fmt(dsc) : '') + (fee ? ' · Domicilio ' + fmt(fee) + (dd ? ' (gratis con el 100%)' : '') : '')
    + (sub - dsc + fee - dd <= 0 ? ' · <b>Cortesía: no se cobra</b>' : '');
}
