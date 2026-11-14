/* =====================================================================
   Tomates — Editar pedidos sin aprobación (vendedor) + historial de cambios
   El vendedor (ventas.crear) agrega o quita productos mientras el pedido no esté
   entregado ni cobrado; el administrador (ventas.editar) también si ya está cobrado.
   Todo pasa por la función edit_order de la base, que valida precios y guarda el historial.
===================================================================== */
(function(){
  const TOM = window.TOM;
  const escH = (s)=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isPaid = (o)=> (o.paymentStatus==='pagado' || o.paymentStatus==='por_confirmar') && o.paymentMethod!=='cortesia';

  window.canDirectEditOrder = function(id){
    const o = id && state.orders.find(x=>x.id===id); if(!o) return false;
    if(o.status==='entregado' || o.webStatus==='por_confirmar') return false;
    if(TOM.can('ventas.editar')) return true;
    return TOM.can('ventas.crear') && !isPaid(o);
  };
  window.orderEditBannerHtml = function(id){
    const o = id && state.orders.find(x=>x.id===id); if(!o) return '';
    if(TOM.can('ventas.editar')) return isPaid(o) ? '<div class="banner">Este pedido ya está cobrado. Si cambias el total, revisa la diferencia con el cliente.</div>' : '';
    if(canDirectEditOrder(id)) return `<div class="banner">Puedes agregar o quitar productos. El cambio queda registrado${o.status==='listo'?' y, si agregas productos, el pedido vuelve a cocina':''}.</div>`;
    return '<div class="banner">Este pedido ya está cobrado: el cambio quedará pendiente de aprobación del administrador.</div>';
  };
  window.saveOrderEditDirect = async function(id, patch){
    await TOM.rpc('edit_order', { p_order_id:id, p_patch:patch });
  };

  window.orderEditInfoHtml = function(o){
    const log = o.editLog || []; if(!log.length) return '';
    const last = log[log.length-1];
    return `<div class="item-meta" style="margin-top:4px;cursor:pointer;text-decoration:underline dotted" onclick="openOrderEditLog('${o.id}')">✏️ Modificado por ${escH(last.byName||'')} · ${fmtTime(last.at)}${log.length>1?` · ${log.length} cambios`:''}</div>`;
  };
  window.openOrderEditLog = function(id){
    const o = state.orders.find(x=>x.id===id); if(!o) return;
    const log = (o.editLog||[]).slice().reverse();
    modalBody.innerHTML = `<h3>Cambios del pedido #${escH(id.slice(0,5))}</h3>
      ${log.map(e=>`<div class="card">
        <div class="row"><div class="item-name" style="font-size:14px">${escH(e.byName||'')}</div><span class="item-meta">${fmtTime(e.at)}</span></div>
        <div class="item-meta"><b>Antes:</b> ${escH(e.before)} — ${fmt(e.beforeTotal)}</div>
        <div class="item-meta" style="color:var(--fg)"><b>Después:</b> ${escH(e.after)} — ${fmt(e.afterTotal)}</div>
      </div>`).join('') || '<div class="empty">Sin cambios.</div>'}
      <div class="modal-actions"><button class="secondary" onclick="closeModal()">Cerrar</button></div>`;
    modalBg.classList.add('open');
  };
})();
