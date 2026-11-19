/* =====================================================================
   Tomates — Mesa de ayuda (v13, 19 nov 2026)
   - Borrador del pedido: si el celular recarga la app (por ir a WhatsApp), el pedido se recupera.
   - Adición: agregar productos a un pedido ya cobrado o entregado (queda como pedido nuevo enlazado).
   - El administrador cancela cualquier pedido (se borra; si estaba entregado vuelve el inventario).
   - Descuento del vendedor por aprobar + revisión del administrador + "Falta cobrar".
   - Listo / Entregado se ve al instante en este equipo.
   - Clientes con celular, @usuario y dirección; buscador.
   - Gastos: revisión de domicilios (el pago al domiciliario ahora es automático) y factura con foto.
===================================================================== */
var orderAddonOf = null; // id del pedido al que se le está haciendo una adición
(function(){
  const TOM = window.TOM;
  const escH = (s)=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const short = (id)=> String(id||'').slice(0,5);
  const isPaid = (o)=> (o.paymentStatus==='pagado' || o.paymentStatus==='por_confirmar') && o.paymentMethod!=='cortesia';
  const store = { get(k){ try{ return JSON.parse(localStorage.getItem('tp_'+k)||'null'); }catch(e){ return null; } },
                  set(k,v){ try{ localStorage.setItem('tp_'+k, JSON.stringify(v)); }catch(e){} },
                  del(k){ try{ localStorage.removeItem('tp_'+k); }catch(e){} } };
  window.fmtPhone = (p)=>{ const d = String(p||'').replace(/\D/g,'').slice(-10); return d.length===10 ? d.slice(0,3)+' '+d.slice(3,6)+' '+d.slice(6) : String(p||''); };

  /* ---------- 1) Listo / Entregado al instante ---------- */
  const _inner = window.setOrderStatusInner;
  window.setOrderStatusInner = async function(id, status){
    const o = state.orders.find(x=>x.id===id);
    if(o && o.status!=='entregado' && o.status!==status){
      o.status = status;
      if(status==='listo') o.readyAt = Date.now();
      if(status==='entregado') o.deliveredAt = Date.now();
      try{ renderAll(); }catch(e){}
    }
    try{ await _inner(id, status); } finally { TOM.refetchRow && TOM.refetchRow('orders', id); }
  };

  /* ---------- 2) Borrador del pedido ---------- */
  const orderModalOpen = ()=> modalBg.classList.contains('open') && !!document.getElementById('orderTotalPreview');
  const DRAFT = 'orderDraft:' + ((TOM.user && TOM.user.id) || '');
  function draftKey(){ return 'orderDraft:' + ((TOM.user && TOM.user.id) || ''); }
  setInterval(()=>{
    if(!orderModalOpen() || !Array.isArray(orderCart) || !orderCart.length) return;
    store.set(draftKey(), { at: Date.now(), editingOrderId, orderAddonOf, orderCart, orderType, orderSpot, orderCust, orderDiscount,
      orderDeliveryFee, orderDeliveryManual, orderDeliveryService,
      custSel: (document.getElementById('orderCustomer')||{}).value || '' });
  }, 1500);
  const _closeModal = window.closeModal;
  window.closeModal = function(){
    if(orderModalOpen()){ store.del(draftKey()); orderAddonOf = null; }
    return _closeModal.apply(this, arguments);
  };
  const _openOrderModal = window.openOrderModal;
  window.openOrderModal = function(id){ orderAddonOf = null; return _openOrderModal(id); };
  function restoreDraft(d){
    if(d.editingOrderId){
      const o = state.orders.find(x=>x.id===d.editingOrderId);
      if(!o || o.status==='entregado'){ store.del(draftKey()); toast('El pedido que estabas editando ya cambió; no se recuperó el borrador.'); return; }
      _openOrderModal(d.editingOrderId);
    } else _openOrderModal();
    orderCart = d.orderCart || []; orderType = d.orderType || ''; orderSpot = d.orderSpot || '';
    orderCust = d.orderCust || orderCust; orderDiscount = d.orderDiscount || null;
    orderDeliveryFee = d.orderDeliveryFee || 0; orderDeliveryManual = !!d.orderDeliveryManual; orderDeliveryService = d.orderDeliveryService || '';
    orderAddonOf = d.orderAddonOf || null;
    renderOrderMainScreen();
    if(d.custSel){ const s = document.getElementById('orderCustomer'); if(s) s.value = d.custSel; }
    toast('Recuperamos el pedido que estabas haciendo', 'ok');
  }
  const draftBanner = document.createElement('div');
  draftBanner.className = 'banner'; draftBanner.style.display = 'none';
  const ventas = document.getElementById('tab-pedidos');
  if(ventas){ const h = ventas.querySelector('.section-title'); ventas.insertBefore(draftBanner, h ? h.nextSibling : ventas.firstChild); }
  function paintDraftBanner(){
    const d = store.get(draftKey());
    if(!d || !d.orderCart || !d.orderCart.length || orderModalOpen()){ draftBanner.style.display = 'none'; return; }
    const n = d.orderCart.reduce((s,l)=>s+(l.qty||0),0);
    const where = d.orderType==='local' ? d.orderSpot : d.orderType==='domicilio' ? 'Domicilio' + (d.orderCust && d.orderCust.name ? ' · '+d.orderCust.name : '') : d.orderType==='llevar' ? 'Para llevar' : '';
    draftBanner.style.display = '';
    draftBanner.innerHTML = `📝 <b>Tienes un pedido sin terminar</b> (${n} producto${n===1?'':'s'}${where?' · '+escH(where):''}, ${fmtTime(d.at)}).
      <span style="display:inline-flex;gap:6px;margin-left:6px"><button class="primary" style="width:auto;padding:6px 12px" onclick="resumeOrderDraft()">Continuar</button>
      <button class="ghost" style="width:auto" onclick="discardOrderDraft()">Descartar</button></span>`;
  }
  window.resumeOrderDraft = ()=>{ const d = store.get(draftKey()); if(d) restoreDraft(d); paintDraftBanner(); };
  window.discardOrderDraft = ()=>{ store.del(draftKey()); paintDraftBanner(); };
  TOM.whenReady.then(()=>{
    // Si la app se recargó hace poco con un pedido a medias, se abre solo
    let tries = 0;
    const t = setInterval(()=>{
      tries++;
      if(!state.products.length && tries < 20) return;
      clearInterval(t);
      const d = store.get(draftKey());
      if(d && d.orderCart && d.orderCart.length && Date.now()-d.at < 30*60000 && !orderModalOpen()) restoreDraft(d);
      paintDraftBanner();
    }, 500);
  });

  /* ---------- 3) Adición a un pedido cobrado o entregado ---------- */
  window.openAddonOrder = function(parentId){
    const o = state.orders.find(x=>x.id===parentId); if(!o) return;
    _openOrderModal();
    orderAddonOf = parentId;
    orderType = o.orderType || 'llevar'; orderSpot = o.spot || '';
    orderDeliveryFee = 0; orderDeliveryManual = false; orderDeliveryService = '';
    orderCust = { phone: o.orderType==='domicilio' ? phoneLast10(o.customerPhone) : '', waUser: o.customerWaUser || '', name: o.orderType==='domicilio' ? (o.customerName||'') : '',
                  address: o.customerAddress || '', id: o.customerId || null, auto:false };
    renderOrderMainScreen();
    const s = document.getElementById('orderCustomer'); if(s && o.customerId) s.value = o.customerId;
  };
  window.addonBannerHtml = function(){
    const p = state.orders.find(x=>x.id===orderAddonOf);
    return `<div class="banner">➕ <b>Adición al pedido #${escH(short(orderAddonOf))}</b>${p ? ' ('+escH(p.customerName || p.spot || '')+')' : ''}. Se cobra aparte y va a cocina como pedido nuevo. Si es domicilio, la tarifa no se vuelve a cobrar.</div>`;
  };
  window.orderLinksHtml = function(o){
    const out = [];
    if(o.addonOf){ out.push(`➕ Adición del pedido #${escH(short(o.addonOf))}`); }
    const kids = (state.orders||[]).filter(x=>x.addonOf===o.id);
    if(kids.length) out.push(`➕ ${kids.length} adición${kids.length===1?'':'es'}: ` + kids.map(k=>'#'+escH(short(k.id))+' '+fmt(k.total)).join(', '));
    return out.length ? `<div class="item-meta" style="color:var(--fg);font-weight:700">${out.join(' · ')}</div>` : '';
  };

  /* ---------- 4) Botones extra en la tarjeta del pedido ---------- */
  window.orderExtraBtnsHtml = function(o){
    let h = '';
    if(TOM.can('ventas.crear') && o.webStatus!=='por_confirmar' && o.date===todayStr() && !canDirectEditOrder(o.id))
      h += `<button class="ghost" onclick="openAddonOrder('${o.id}')">➕ Agregar productos</button>`;
    if(TOM.can('ventas.editar') && o.webStatus!=='por_confirmar' && !(typeof webCancelBtnHtml==='function' && webCancelBtnHtml(o)))
      h += `<button class="ghost" style="color:var(--bad)" onclick="openCancelOrder('${o.id}')">🚫 Cancelar</button>`;
    return h;
  };
  window.openCancelOrder = function(id){
    const o = state.orders.find(x=>x.id===id); if(!o) return;
    const delivered = o.status==='entregado', paid = isPaid(o);
    const kids = state.orders.filter(x=>x.addonOf===id);
    modalBody.innerHTML = `<h3>Cancelar pedido #${escH(short(id))}</h3>
      <div class="item-meta">${escH(o.customerName || o.spot || '')} · ${escH(orderPlaceLabel(o))} · ${fmt(o.total)}</div>
      <div class="item-meta" style="margin-top:6px;color:var(--fg)">${(o.items||[]).map(it=>`${it.qty}× ${escH(it.name)}`).join(', ')}</div>
      <div class="item-meta" style="margin-top:8px">El pedido se borra por completo (ventas, cocina, caja e informes) y no queda registro.</div>
      ${delivered ? `<div class="item-meta" style="margin-top:6px;font-weight:700">↩️ Ya estaba entregado: el inventario que descontó se devuelve${o.deliveryFee ? ' y se borra el gasto automático del domicilio' : ''}.</div>` : ''}
      ${paid ? `<div class="item-meta" style="margin-top:6px;color:var(--bad);font-weight:700">⚠️ Tiene un pago registrado (${escH(o.paymentMethodLabel||o.paymentMethod||'')} ${fmt(o.paymentAmount||o.total)}). Al cancelarlo, ese ingreso sale de la caja: devuelve el dinero al cliente.</div>` : ''}
      ${kids.length ? `<div class="item-meta" style="margin-top:6px">Tiene ${kids.length} adición${kids.length===1?'':'es'}; esas no se cancelan solas.</div>` : ''}
      <div id="coErr" class="item-meta" style="color:var(--bad);font-weight:700"></div>
      <div class="modal-actions">
        <button class="secondary" onclick="closeModal()">Volver</button>
        ${(o.customerPhone||o.customerWaUser) ? `<button class="secondary" onclick="sendOrderWhatsApp('${o.id}','cancelado')">📲 Avisar</button>` : ''}
        <button class="primary" style="background:var(--bad)" id="coBtn" onclick="doCancelOrder('${o.id}')">Cancelar y borrar</button>
      </div>`;
    modalBg.classList.add('open');
  };
  window.doCancelOrder = async function(id){
    const btn = document.getElementById('coBtn'); if(btn){ btn.disabled = true; btn.textContent = 'Borrando…'; }
    try{ await TOM.rpc('cancel_order', { p_order_id:id }); }
    catch(e){ if(btn){ btn.disabled = false; btn.textContent = 'Cancelar y borrar'; } document.getElementById('coErr').textContent = e.message || String(e); return; }
    TOM.reloadTable && TOM.reloadTable('expenses');
    _closeModal(); toast('Pedido cancelado', 'ok');
  };

  /* ---------- 5) Descuento del vendedor por aprobar ---------- */
  window.freeDiscountEditable = (d)=> !!(d && (d.isNew || d.status==='por_aprobar'));
  window.discountExtraFields = function(d){
    if(!d || d.promoId) return {};
    const reason = String(d.reason||'').trim().slice(0,80);
    if(can('ventas.descuento_libre')) return { reason };
    const o = d.orig;
    if(o && !d.isNew && o.status!=='por_aprobar' && o.kind===d.kind && Number(o.value)===Number(d.value)) return { reason, status: o.status||'' };
    const mine = state.roles.find(r=>r.id===myUid);
    return { reason, status:'por_aprobar', requestedByName: (mine && mine.name) || '' };
  };
  const pendingDiscounts = ()=> (state.orders||[]).filter(o=>o.discount && o.discount.status==='por_aprobar');
  const dBanner = document.createElement('div');
  dBanner.className = 'banner'; dBanner.style.display = 'none'; dBanner.style.cursor = 'pointer';
  dBanner.onclick = ()=>openDiscountReview();
  if(ventas){ const h = ventas.querySelector('.section-title'); ventas.insertBefore(dBanner, h ? h.nextSibling : ventas.firstChild); }
  function paintDiscountBanner(){
    const n = TOM.profile && can('ventas.descuento_libre') ? pendingDiscounts().length : 0;
    dBanner.style.display = n ? '' : 'none';
    dBanner.innerHTML = `🏷️ <b>${n} descuento${n===1?'':'s'} por aprobar</b> de vendedores. Toca para revisar.`;
  }
  window.openDiscountReview = function(onlyId){
    const list = pendingDiscounts().filter(o=>!onlyId || o.id===onlyId);
    modalBody.innerHTML = `<h3>Descuentos por aprobar</h3>
      <div class="item-meta">Si rechazas un descuento, el pedido vuelve a su valor completo. Si ya estaba cobrado, queda "Falta cobrar" la diferencia.</div>
      ${list.length ? list.map(o=>{ const d = o.discount; return `<div class="card">
        <div class="row"><div class="item-name">#${escH(short(o.id))} · ${escH(o.customerName || o.spot || orderPlaceLabel(o))}</div><span class="item-meta">${fmtTime(o.createdAt)}</span></div>
        <div class="item-meta" style="color:var(--fg)">${(o.items||[]).map(it=>`${it.qty}× ${escH(it.name)}`).join(', ')}</div>
        <div class="item-meta">Descuento <b>${d.kind==='pct' ? Number(d.value)+'%' : fmt(d.value)}</b> = −${fmt(d.amount)}${o.deliveryDiscount>0?' (y domicilio gratis −'+fmt(o.deliveryDiscount)+')':''} · total ${fmt(o.total)}${isPaid(o)?' · ya cobrado':''}</div>
        <div class="item-meta">Motivo: <b>${escH(d.reason||'—')}</b> · lo dio ${escH(d.requestedByName||'')}</div>
        <input id="dr_${o.id}" placeholder="Nota si lo rechazas (opcional)" maxlength="120" style="margin-top:8px">
        <div class="row" style="gap:8px;margin-top:8px">
          <button class="primary" style="flex:1" onclick="decideDiscount('${o.id}',true)">✅ Aprobar</button>
          <button class="secondary" style="flex:1" onclick="decideDiscount('${o.id}',false)">❌ Rechazar</button>
        </div></div>`; }).join('') : '<div class="empty">No hay descuentos pendientes.</div>'}
      <div class="modal-actions"><button class="secondary" onclick="closeModal()">Cerrar</button></div>`;
    modalBg.classList.add('open');
  };
  window.decideDiscount = async function(id, ok){
    const note = (document.getElementById('dr_'+id)||{}).value || '';
    try{ await TOM.rpc('review_discount', { p_order_id:id, p_ok:ok, p_note:note }); }
    catch(e){ toast(e.message); return; }
    toast(ok ? 'Descuento aprobado' : 'Descuento rechazado', 'ok');
    setTimeout(()=>{ if(pendingDiscounts().length) openDiscountReview(); else _closeModal(); }, 400);
  };
  // Falta cobrar (descuento rechazado después de cobrar)
  window.openSettleBalance = function(id){
    const o = state.orders.find(x=>x.id===id); if(!o) return;
    modalBody.innerHTML = `<h3>Cobrar diferencia — ${fmt(o.balanceDue)}</h3>
      <div class="item-meta">El descuento de este pedido fue rechazado después de cobrarlo. Cobra la diferencia al cliente (o la responde quien dio el descuento).</div>
      <div class="segmented" id="sbM" style="margin-top:10px"><button type="button" data-m="efectivo" class="active">Efectivo</button><button type="button" data-m="qr">QR</button><button type="button" data-m="datafono">Datáfono</button></div>
      <div id="sbErr" class="item-meta" style="color:var(--bad);font-weight:700"></div>
      <div class="modal-actions"><button class="secondary" onclick="closeModal()">Cancelar</button><button class="primary" id="sbBtn" onclick="doSettleBalance('${o.id}')">Registrar cobro</button></div>`;
    modalBody.querySelectorAll('#sbM button').forEach(b=>b.onclick=()=>modalBody.querySelectorAll('#sbM button').forEach(x=>x.classList.toggle('active', x===b)));
    modalBg.classList.add('open');
  };
  window.doSettleBalance = async function(id){
    const m = (modalBody.querySelector('#sbM button.active')||{}).dataset?.m || 'efectivo';
    try{ await TOM.rpc('settle_balance', { p_order_id:id, p_method:m }); }
    catch(e){ document.getElementById('sbErr').textContent = e.message; return; }
    _closeModal(); toast('Diferencia cobrada', 'ok');
  };
  const _badge = window.paymentBadgeHtml;
  window.paymentBadgeHtml = function(o){
    const base = _badge(o);
    const extra = [];
    if(o.discount && o.discount.status==='por_aprobar')
      extra.push(`<span class="pill warn">⏳ Descuento por aprobar</span>` + (can('ventas.descuento_libre') ? `<button class="secondary" style="width:auto;padding:6px 12px;font-size:12.5px" onclick="openDiscountReview('${o.id}')">Revisar</button>` : ''));
    if(Number(o.balanceDue)>0)
      extra.push(`<span class="pill bad">⚠️ Falta cobrar ${fmt(o.balanceDue)}</span>` + (can('ventas.cobrar') ? `<button class="secondary" style="width:auto;padding:6px 12px;font-size:12.5px" onclick="openSettleBalance('${o.id}')">Cobrar diferencia</button>` : ''));
    if(o.discountRejected && !o.discount) extra.push(`<span class="pill" title="${escH(o.discountRejected.note||'')}">Descuento rechazado</span>`);
    if(!extra.length) return base;
    return `<span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end">${extra.join('')}${base}</span>`;
  };

  /* ---------- 6) Clientes: identificar bien a cada uno ---------- */
  window.customerLabel = function(c){
    const bits = [c.name || 'Sin nombre'];
    if(c.phone) bits.push('📱 ' + fmtPhone(c.phone));
    if(c.waUser) bits.push(c.waUser);
    if(c.address) bits.push(String(c.address).slice(0, 32));
    return bits.join(' · ');
  };
  const norm = (t)=> String(t||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  const custMatches = (q)=>{
    const n = norm(q).trim(), digits = String(q||'').replace(/\D/g,'');
    if(n.length < 2 && digits.length < 3) return [];
    return (state.customers||[]).filter(c=> norm(c.name).includes(n) || (digits.length>=3 && String(c.phone||'').includes(digits)) || norm(c.waUser).includes(n) || norm(c.address).includes(n)).slice(0, 6);
  };
  // Buscador en la pestaña Clientes
  const cl = document.getElementById('customersList');
  if(cl){
    const inp = document.createElement('input');
    inp.id = 'custSearch'; inp.placeholder = '🔎 Buscar por nombre, celular, @usuario o dirección'; inp.style.marginBottom = '10px';
    cl.parentNode.insertBefore(inp, cl);
    inp.addEventListener('input', filterCustomerCards);
  }
  function filterCustomerCards(){
    const q = norm((document.getElementById('custSearch')||{}).value||'').trim(), digits = ((document.getElementById('custSearch')||{}).value||'').replace(/\D/g,'');
    document.querySelectorAll('#customersList .card').forEach(c=>{
      const t = norm(c.innerText), td = c.innerText.replace(/\D/g,'');
      c.style.display = !q || t.includes(q) || (digits.length>=3 && td.includes(digits)) ? '' : 'none';
    });
  }
  // Buscador dentro del pedido a domicilio
  window.customerSearchHtml = function(){
    return `<label style="margin-top:0" for="ordCustSearch">🔎 Buscar cliente guardado</label>
      <input id="ordCustSearch" autocomplete="off" placeholder="Nombre, celular, @usuario o dirección" oninput="onOrderCustSearch()">
      <div id="ordCustResults"></div>`;
  };
  window.onOrderCustSearch = function(){
    const q = document.getElementById('ordCustSearch').value;
    const res = custMatches(q);
    document.getElementById('ordCustResults').innerHTML = res.map(c=>`<button type="button" class="ghost" style="display:block;width:100%;text-align:left;padding:8px;border-bottom:1px solid var(--border)" onclick="pickOrderCustomer('${c.id}')">
        <b>${escH(c.name||'')}</b> <span class="item-meta">${escH([c.phone?'📱 '+fmtPhone(c.phone):'', c.waUser||'', c.address||''].filter(Boolean).join(' · '))}</span></button>`).join('')
      || (q.trim().length>=2 ? '<div class="item-meta">Sin coincidencias: escribe sus datos abajo y quedará guardado.</div>' : '');
  };
  window.pickOrderCustomer = function(id){
    const c = state.customers.find(x=>x.id===id); if(!c) return;
    orderCust = { phone: phoneLast10(c.phone), waUser: c.waUser||'', name: c.name||'', address: c.address||'', id: c.id, auto:false };
    renderOrderMainScreen();
  };

  /* ---------- 7) Gastos: domicilios automáticos y factura con foto ---------- */
  const gastos = document.getElementById('tab-gastos');
  const gBox = document.createElement('div');
  gBox.id = 'gastosHelpBox';
  if(gastos){ gastos.insertBefore(gBox, document.getElementById('pendingExpensesBox')); }
  const localDate = (ms)=>{ const d = new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
  function paintGastosHelp(){
    if(!TOM.profile || !can('gastos.gestionar')){ gBox.innerHTML = ''; return; }
    const days = []; for(let i=0;i<7;i++) days.push(addDaysStr(todayStr(), -i));
    const rows = days.map(d=>{
      const dom = (state.orders||[]).filter(o=>o.status==='entregado' && Number(o.deliveryFee)>0 && o.deliveredAt && localDate(o.deliveredAt)===d);
      const cobrado = dom.reduce((s,o)=>s+(Number(o.deliveryFee)||0),0);
      const exp = (state.expenses||[]).filter(e=>e.category==='Domicilios' && e.date===d);
      const reg = exp.reduce((s,e)=>s+(Number(e.amount)||0),0);
      return { d, n: dom.length, cobrado, reg, auto: exp.filter(e=>e.auto).length, diff: reg - cobrado };
    }).filter(r=>r.n || r.reg);
    gBox.innerHTML = `<button class="primary" type="button" style="width:100%;margin-bottom:10px" onclick="openInvoiceCapture('gastos')">📷 Registrar factura de gasto con foto</button>
      <details class="card" style="margin-bottom:12px"><summary class="item-name" style="cursor:pointer">🛵 Domicilios: el pago al domiciliario ya es automático</summary>
        <div class="item-meta" style="margin-top:6px">Desde el 19 de noviembre, al marcar <b>Entregado</b> un domicilio la app registra sola el gasto "Domicilios" (efectivo, por la tarifa completa). <b>No lo agregues a mano</b> o quedará doble. Si se cancela el pedido, el gasto se borra.</div>
        ${rows.length ? `<div class="item-meta" style="margin-top:8px"><b>Revisión de los últimos 7 días</b> (domicilios entregados contra gastos "Domicilios"):</div>
          ${rows.map(r=>`<div class="row" style="margin-top:4px;gap:8px"><span class="item-meta">${escH(r.d)} · ${r.n} domicilio${r.n===1?'':'s'} = ${fmt(r.cobrado)}</span>
            <span class="item-meta" style="font-weight:700;color:${Math.abs(r.diff)<1?'var(--good)':'var(--bad)'}">gastos ${fmt(r.reg)}${Math.abs(r.diff)<1?' ✔':(r.diff>0?' · sobran '+fmt(r.diff):' · faltan '+fmt(-r.diff))}</span></div>`).join('')}
          <div class="item-meta" style="margin-top:6px">Si un día dice "faltan", ese día no se registró el pago a domiciliarios: agrega el gasto con esa fecha. Si dice "sobran", hay un gasto repetido.</div>` : ''}
      </details>`;
  }

  /* ---------- Refrescar todo con los datos ---------- */
  const _renderAll = window.renderAll;
  window.renderAll = function(){ _renderAll(); paintDraftBanner(); paintDiscountBanner(); paintGastosHelp(); filterCustomerCards(); };
})();
