/* =====================================================================
   Tomates — Pedidos web y avisos por WhatsApp (gratis, con WhatsApp Business)
   - Los pedidos que hace el cliente en menu.html llegan como "pedido web por confirmar".
     El vendedor los confirma (y pone la tarifa del domicilio) o los rechaza.
   - "📲 Avisar" abre WhatsApp con un mensaje según el estado del pedido.
   - El administrador (config.gestionar) abre o cierra el menú web, pone el número
     de WhatsApp del negocio y obtiene el enlace y los QR de las mesas.
===================================================================== */
(function(){
  const TOM = window.TOM; const sb = TOM.sb;
  const escH = (s)=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const PAY = { efectivo:'Efectivo', qr:'Transferencia / QR', datafono:'Tarjeta (datáfono)' };
  const SPOTS = ['Mesa 1','Mesa 2','Mesa 3','Barra 1','Barra 2','Barra 3','Barra 4'];
  let webCfg = { whatsapp:'', open:false, message:'', hiddenCategories:[] };
  const menuUrl = ()=> location.origin + location.pathname.replace(/[^/]*$/, '') + 'menu.html';

  async function loadWebCfg(){
    const { data } = await sb.from('config').select('data').eq('id','web').maybeSingle();
    webCfg = Object.assign({ whatsapp:'', open:false, message:'', hiddenCategories:[] }, (data && data.data) || {});
    renderWebBits();
  }
  TOM.whenReady.then(()=>{
    loadWebCfg();
    sb.channel('webcfg_watch').on('postgres_changes', { event:'*', schema:'public', table:'config' }, loadWebCfg).subscribe();
    window.addEventListener('tomates:resynced', loadWebCfg);
  });

  /* ---------- Pedidos web por confirmar ---------- */
  const pendingWeb = ()=> (state.orders||[]).filter(o=>o.webStatus==='por_confirmar').sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
  const ventas = document.getElementById('tab-pedidos');
  const banner = document.createElement('div');
  banner.id = 'webPendingBanner'; banner.className = 'banner'; banner.style.display = 'none'; banner.style.cursor = 'pointer';
  banner.onclick = ()=>{ const el = document.getElementById('ordersList'); if(el) el.scrollIntoView({ behavior:'smooth' }); };
  if(ventas){ const h = ventas.querySelector('.section-title'); ventas.insertBefore(banner, h ? h.nextSibling : ventas.firstChild); }
  let seen = null;
  function beep(){
    try{ const C = window.AudioContext || window.webkitAudioContext; const ac = new C(); [0, .22].forEach(t=>{ const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = 988; g.gain.setValueAtTime(.2, ac.currentTime+t); g.gain.exponentialRampToValueAtTime(.001, ac.currentTime+t+.18);
      o.connect(g); g.connect(ac.destination); o.start(ac.currentTime+t); o.stop(ac.currentTime+t+.2); }); }catch(e){}
  }
  function renderWebBanner(){
    if(!TOM.profile || !TOM.can('ventas.crear')){ banner.style.display = 'none'; return; }
    const list = pendingWeb(), ids = new Set(list.map(o=>o.id));
    if(seen && list.some(o=>!seen.has(o.id))) beep();
    seen = ids;
    banner.style.display = list.length ? '' : 'none';
    banner.innerHTML = `🌐 <b>${list.length} pedido${list.length===1?'':'s'} web</b> por confirmar. Revisa y confirma para que pasen a cocina.`;
  }

  window.webOrderInfoHtml = function(o){
    if(o.source!=='web') return '';
    return `<div class="item-meta" style="color:var(--fg)">🌐 Pedido web${o.webPay?' · paga con '+escH(PAY[o.webPay]||o.webPay):''}${o.webNote?' · 📝 '+escH(o.webNote):''}</div>`;
  };
  window.webOrderButtonsHtml = function(o){
    if(!TOM.can('ventas.crear')) return `<div class="row" style="margin-top:8px"><span class="pill warn">🌐 Esperando confirmación</span></div>`;
    return `<div class="row" style="margin-top:8px;gap:8px">
        <button class="primary" style="flex:1;padding:11px" onclick="openConfirmWeb('${o.id}')">✅ Confirmar pedido</button>
        <button class="secondary" style="flex:1;padding:11px" onclick="openRejectWeb('${o.id}')">❌ Rechazar</button>
      </div>`;
  };
  let cwFee = 0;
  window.openConfirmWeb = function(id){
    const o = state.orders.find(x=>x.id===id); if(!o) return;
    const dom = o.orderType==='domicilio', manual = TOM.can('ventas.domicilio_manual');
    cwFee = 0;
    modalBody.innerHTML = `<h3>Confirmar pedido web #${escH(id.slice(0,5))}</h3>
      <div class="item-meta">${escH(o.customerName||'')} · ${escH(orderPlaceLabel(o))}${o.customerAddress?' · 📍 '+escH(o.customerAddress):''}</div>
      <div class="item-meta" style="margin-top:6px;color:var(--fg)">${(o.items||[]).map(it=>`${it.qty}× ${escH(it.name)}`).join(', ')}</div>
      <div class="item-meta">Productos: <b>${fmt(o.subtotal||o.total)}</b>${o.webPay?' · paga con '+escH(PAY[o.webPay]||o.webPay):''}</div>
      ${o.webNote ? `<div class="item-meta">📝 ${escH(o.webNote)}</div>` : ''}
      ${dom ? `<label>Tarifa del domicilio</label>
        <div class="ot-chips" id="cwFees">
          <button type="button" class="ot-chip" data-f="2000">$2.000</button>
          <button type="button" class="ot-chip" data-f="5000">$5.000</button>
          ${manual ? '<button type="button" class="ot-chip" data-f="otra">Otra (servicio externo)</button>' : ''}
        </div>
        <div id="cwManual" style="display:none">
          <label for="cwFeeIn">Valor del domicilio</label><input id="cwFeeIn" type="number" inputmode="numeric" min="0" step="500" placeholder="7000">
          <label for="cwSvc">Servicio de domicilio (opcional)</label><input id="cwSvc" maxlength="60" placeholder="Ej: Rappi, Picap">
        </div>` : ''}
      <div class="item-meta" id="cwTot" style="margin-top:10px;font-weight:700;color:var(--fg)">Total: ${fmt(o.subtotal||o.total)}</div>
      <div id="cwErr" class="item-meta" style="color:var(--bad);font-weight:700"></div>
      <div class="modal-actions">
        <button class="secondary" onclick="closeModal()">Cancelar</button>
        <button class="primary" id="cwBtn" onclick="doConfirmWeb('${o.id}')">Confirmar y enviar a cocina</button>
      </div>`;
    const sub = Number(o.subtotal||o.total)||0;
    const upd = ()=>{ const f = cwFee==='otra' ? (Number((document.getElementById('cwFeeIn')||{}).value)||0) : cwFee; document.getElementById('cwTot').textContent = 'Total: ' + fmt(sub + (Number(f)||0)); };
    modalBody.querySelectorAll('#cwFees .ot-chip').forEach(b=>b.onclick=()=>{
      modalBody.querySelectorAll('#cwFees .ot-chip').forEach(x=>x.classList.toggle('on', x===b));
      cwFee = b.dataset.f==='otra' ? 'otra' : Number(b.dataset.f);
      document.getElementById('cwManual').style.display = cwFee==='otra' ? '' : 'none';
      if(cwFee==='otra') document.getElementById('cwFeeIn').focus();
      upd();
    });
    const fi = document.getElementById('cwFeeIn'); if(fi) fi.oninput = upd;
    modalBg.classList.add('open');
  };
  window.doConfirmWeb = async function(id){
    const o = state.orders.find(x=>x.id===id); if(!o) return closeModal();
    const err = (m)=>{ document.getElementById('cwErr').textContent = m; };
    let fee = 0, svc = '';
    if(o.orderType==='domicilio'){
      if(!cwFee) return err('Elige la tarifa del domicilio.');
      if(cwFee==='otra'){ fee = Math.round(Number(document.getElementById('cwFeeIn').value)||0); svc = document.getElementById('cwSvc').value.trim(); if(!(fee>0)) return err('Escribe el valor del domicilio.'); }
      else fee = cwFee;
    }
    const btn = document.getElementById('cwBtn'); btn.disabled = true; btn.textContent = 'Confirmando…';
    try{ await TOM.rpc('confirm_web_order', { p_order_id:id, p_accept:true, p_delivery_fee:fee, p_delivery_service:svc }); }
    catch(e){ btn.disabled = false; btn.textContent = 'Confirmar y enviar a cocina'; return err(e.message || String(e)); }
    closeModal();
    const has = o.customerPhone || o.customerWaUser;
    toast('Pedido confirmado y enviado a cocina' + (has ? '. Avísale al cliente con 📲' : ''), 'ok');
  };
  window.openRejectWeb = function(id){
    const o = state.orders.find(x=>x.id===id); if(!o) return;
    modalBody.innerHTML = `<h3>Rechazar pedido web #${escH(id.slice(0,5))}</h3>
      <div class="item-meta">El pedido se borra. Si el cliente dejó su WhatsApp, avísale el motivo.</div>
      <div class="modal-actions">
        <button class="secondary" onclick="closeModal()">Volver</button>
        ${(o.customerPhone||o.customerWaUser) ? `<button class="secondary" onclick="sendOrderWhatsApp('${o.id}','rechazado')">📲 Avisar</button>` : ''}
        <button class="primary" style="background:var(--bad)" onclick="doRejectWeb('${o.id}')">Rechazar y borrar</button>
      </div>`;
    modalBg.classList.add('open');
  };
  window.doRejectWeb = async function(id){
    try{ await TOM.rpc('confirm_web_order', { p_order_id:id, p_accept:false }); }
    catch(e){ toast(e.message || String(e)); return; }
    closeModal(); toast('Pedido web rechazado', 'ok');
  };

  /* ---------- Aviso al cliente por WhatsApp según el estado ---------- */
  function orderMessage(o, forced){
    const hi = `Hola ${(o.customerName||'').split(' ')[0]}! 🍕 Tomates Pizza`;
    const items = (o.items||[]).map(it=>`- ${it.qty}x ${it.name}`).join('\n');
    const money = `${items}${o.discountAmount>0?'\nDescuento: −'+fmt(o.discountAmount):''}${o.deliveryFee?'\nDomicilio: '+fmt(Math.max(0,(o.deliveryFee||0)-(o.deliveryDiscount||0))):''}\nTotal: ${fmt(o.total)}`;
    const id = '#'+(o.id||'').slice(0,5);
    if(forced==='rechazado') return `${hi}. Lo sentimos, no podemos atender tu pedido ${id} en este momento.`;
    if(o.webStatus==='por_confirmar') return `${hi}. Recibimos tu pedido ${id}:\n${items}\nProductos: ${fmt(o.subtotal||o.total)}${o.orderType==='domicilio'?'\nEn un momento te confirmamos el valor del domicilio.':''}`;
    if(o.status==='entregado') return `${hi}. Tu pedido ${id} fue entregado. ¡Gracias por preferirnos! 🙌`;
    if(o.status==='listo'){
      if(o.orderType==='domicilio') return `${hi}. Tu pedido ${id} está listo y sale en camino 🛵.\nTotal a pagar: ${fmt(o.total)}`;
      if(o.orderType==='llevar') return `${hi}. Tu pedido ${id} está listo para recoger en el local 🥡.\nTotal: ${fmt(o.total)}`;
      return `${hi}. Tu pedido ${id} está listo.`;
    }
    const pay = o.paymentStatus==='pagado' ? '\nPago recibido ✅' : (o.webPay==='qr' || o.paymentMethod==='qr') ? '\nPuedes pagar por transferencia/QR y enviarnos el comprobante por aquí.' : '';
    return `${hi}. Confirmamos tu pedido ${id} y ya está en preparación:\n${money}${pay}`;
  }
  window.sendOrderWhatsApp = function(orderId, forced){
    const o = state.orders.find(x=>x.id===orderId); if(!o) return;
    const msg = orderMessage(o, forced);
    let phone = String(o.customerPhone||'').replace(/\D/g,''); if(phone.length===10) phone = '57'+phone;
    if(phone){ window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank'); return; }
    if(o.customerWaUser){
      // Sin celular: WhatsApp no abre chats por usuario desde un enlace. Se copia el mensaje y se abre WhatsApp para elegir el chat.
      try{ navigator.clipboard && navigator.clipboard.writeText(msg); }catch(e){}
      window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
      toast(`Busca a ${o.customerWaUser} en WhatsApp. El mensaje también quedó copiado.`, 'ok');
    }
  };

  /* ---------- Ajustes del menú web (administrador) ---------- */
  const menuSec = document.getElementById('tab-menu');
  if(menuSec){
    const btn = document.createElement('button');
    btn.id = 'webCfgBtn'; btn.className = 'secondary'; btn.type = 'button';
    btn.style.cssText = 'width:100%;margin:0 0 12px;display:none';
    btn.textContent = '🌐 Menú web y WhatsApp';
    btn.onclick = ()=>openWebSettings();
    menuSec.insertBefore(btn, document.getElementById('productsList'));
  }
  function renderWebBits(){
    const b = document.getElementById('webCfgBtn');
    if(b){ b.style.display = TOM.can('config.gestionar') ? '' : 'none'; b.textContent = '🌐 Menú web y WhatsApp · ' + (webCfg.open ? 'abierto' : 'cerrado'); }
  }
  const productCats = ()=> [...new Set((state.products||[]).map(p=>p.category).filter(Boolean))].sort();
  window.openWebSettings = function(){
    const hidden = new Set(webCfg.hiddenCategories||[]);
    const url = menuUrl();
    modalBody.innerHTML = `<h3>Menú web y WhatsApp</h3>
      <div class="item-meta">Los clientes arman su pedido en la página, llega aquí como <b>pedido web por confirmar</b> y después lo envían a tu WhatsApp.</div>
      <label style="display:flex;gap:8px;align-items:center;margin-top:12px;font-size:15px"><input type="checkbox" id="wcOpen" style="width:auto" ${webCfg.open?'checked':''}> Recibir pedidos por la página</label>
      <label for="wcWa">WhatsApp del negocio (con indicativo)</label>
      <input id="wcWa" inputmode="numeric" placeholder="573001234567" value="${escH(webCfg.whatsapp||'')}">
      <label for="wcMsg">Mensaje en la página (opcional)</label>
      <input id="wcMsg" maxlength="140" placeholder="Ej: Domicilios de 5:00 a 10:00 p. m." value="${escH(webCfg.message||'')}">
      <label>Categorías que se muestran</label>
      <div class="ot-chips" id="wcCats">${productCats().map(c=>`<button type="button" class="ot-chip${hidden.has(c)?'':' on'}" data-c="${escH(c)}">${escH(c)}</button>`).join('') || '<span class="item-meta">Sin categorías</span>'}</div>
      <div id="wcErr" class="item-meta" style="color:var(--bad);font-weight:700"></div>
      <div class="modal-actions"><button class="secondary" onclick="closeModal()">Cerrar</button><button class="primary" id="wcSave" onclick="saveWebSettings()">Guardar</button></div>
      <div class="card" style="margin-top:14px">
        <div class="item-name">Enlace para compartir</div>
        <div class="item-meta" style="word-break:break-all">${escH(url)}</div>
        <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">
          <button class="ghost" onclick="copyWebLink('${escH(url)}')">📋 Copiar enlace</button>
          <a class="ghost" href="${escH(url)}" target="_blank" rel="noopener" style="text-decoration:none">👀 Ver página</a>
          <button class="ghost" onclick="showWebQrs()">🔳 QR del menú y de las mesas</button>
        </div>
        <div class="item-meta" style="margin-top:6px">Ponlo en el perfil de WhatsApp Business, en Instagram y en la respuesta automática.</div>
        <div id="wcQrs" class="grid2" style="margin-top:10px"></div>
      </div>`;
    modalBody.querySelectorAll('#wcCats .ot-chip').forEach(b=>b.onclick=()=>b.classList.toggle('on'));
    modalBg.classList.add('open');
  };
  window.saveWebSettings = async function(){
    const err = (m)=>{ document.getElementById('wcErr').textContent = m; };
    let wa = document.getElementById('wcWa').value.replace(/\D/g,'');
    if(wa.length===10) wa = '57'+wa;
    const open = document.getElementById('wcOpen').checked;
    if(wa && !(wa.length>=11 && wa.length<=15)) return err('Revisa el número: indicativo + celular, ej. 573001234567.');
    if(open && !wa) return err('Escribe el WhatsApp del negocio para abrir los pedidos web.');
    const hiddenCategories = [...modalBody.querySelectorAll('#wcCats .ot-chip:not(.on)')].map(b=>b.dataset.c);
    const data = { whatsapp: wa, open, message: document.getElementById('wcMsg').value.trim().slice(0,140), hiddenCategories, updatedAt: Date.now() };
    const btn = document.getElementById('wcSave'); btn.disabled = true;
    const { error } = await sb.from('config').upsert({ id:'web', data });
    btn.disabled = false;
    if(error) return err(TOM.friendly(error));
    webCfg = data; renderWebBits();
    toast(open ? 'Menú web abierto' : 'Guardado. El menú web está cerrado.', 'ok');
    closeModal();
  };
  window.copyWebLink = function(u){ try{ navigator.clipboard.writeText(u); toast('Enlace copiado', 'ok'); }catch(e){ toast(u); } };
  function loadQrLib(){
    if(window.QRCode) return Promise.resolve();
    return new Promise((res, rej)=>{ const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'; s.onload = res; s.onerror = ()=>rej(new Error('No se pudo cargar el generador de QR')); document.head.appendChild(s); });
  }
  window.showWebQrs = async function(){
    const wrap = document.getElementById('wcQrs'); if(!wrap) return;
    try{ await loadQrLib(); }catch(e){ wrap.innerHTML = `<div class="item-meta">${escH(e.message)}</div>`; return; }
    const list = [['Menú (domicilio y para llevar)', menuUrl()]].concat(SPOTS.map(sp=>[sp, menuUrl()+'?mesa='+encodeURIComponent(sp)]));
    wrap.innerHTML = list.map((x,i)=>`<div style="text-align:center"><div id="wq${i}" style="display:inline-block;background:#fff;padding:8px;border-radius:8px"></div>
      <div class="item-meta" style="font-weight:700;color:var(--fg)">${escH(x[0])}</div><a class="item-meta" id="wqd${i}" download="QR ${escH(x[0])}.png">Descargar</a></div>`).join('');
    list.forEach((x,i)=>{ new QRCode(document.getElementById('wq'+i), { text:x[1], width:150, height:150, correctLevel: QRCode.CorrectLevel.M });
      setTimeout(()=>{ const c = document.querySelector('#wq'+i+' canvas'); const a = document.getElementById('wqd'+i); if(c && a) a.href = c.toDataURL('image/png'); }, 60); });
  };

  const _renderAll = window.renderAll;
  window.renderAll = function(){ _renderAll(); renderWebBanner(); renderWebBits(); };
})();
