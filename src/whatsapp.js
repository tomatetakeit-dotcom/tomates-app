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
  banner.id = 'webPendingBanner'; banner.className = 'banner'; banner.style.display = 'none';
  if(ventas){ const h = ventas.querySelector('.section-title'); ventas.insertBefore(banner, h ? h.nextSibling : ventas.firstChild); }

  /* ---------- Alerta sonora de pedidos web ----------
     Suena al entrar un pedido web y se repite cada 20 s mientras haya pedidos sin confirmar.
     Funciona en cualquier pestaña de la app (para quien puede confirmar pedidos).
     Los navegadores solo permiten sonido después de que la persona toca la pantalla una vez. */
  const REPEAT_MS = 20000;
  let soundOn = true; try{ soundOn = localStorage.getItem('webSound')!=='0'; }catch(_){}
  let actx = null, seen = null, lastAlarm = 0, baseTitle = document.title;
  const audio = ()=>{ try{ actx = actx || new (window.AudioContext||window.webkitAudioContext)(); }catch(_){} return actx; };
  const unlock = ()=>{ const was = audioBlocked(); const ac = audio(); if(!ac) return;
    if(ac.state==='suspended') ac.resume().then(renderWebBanner).catch(()=>{}); else if(was) renderWebBanner(); };
  ['pointerdown','keydown','touchstart'].forEach(ev=>document.addEventListener(ev, unlock, { passive:true }));
  const audioBlocked = ()=> !actx || actx.state!=='running';
  // Sonido largo y fuerte (~4,5 s): fanfarria "ta-ta-ta-táaa" tres veces, con compresor para que suene a todo volumen
  let master = null;
  function out(ac){
    if(master) return master;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 6; comp.ratio.value = 8; comp.attack.value = 0.003; comp.release.value = 0.15;
    const g = ac.createGain(); g.gain.value = 1.0;
    comp.connect(g); g.connect(ac.destination);
    return (master = comp);
  }
  function tone(ac, t0, f, dur, vol){
    // dos osciladores (cuadrada + triangular una octava abajo) para un sonido más lleno y audible
    [['square', f, vol*0.55], ['triangle', f/2, vol]].forEach(([type, fr, v])=>{
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(fr, t0);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(v, t0+0.015);
      g.gain.setValueAtTime(v, t0+dur*0.7); g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
      o.connect(g); g.connect(out(ac)); o.start(t0); o.stop(t0+dur+0.02);
    });
  }
  function chime(){
    const ac = audio(); if(!ac || ac.state!=='running') return false;
    const now = ac.currentTime + 0.05;
    const phrase = [[0,784,.14],[.16,988,.14],[.32,1175,.14],[.48,1568,.55]]; // sol-si-re-SOL
    [0, 1.5, 3.0].forEach(off=> phrase.forEach(([t,f,d])=> tone(ac, now+off+t, f, d, 0.9)));
    return true;
  }
  function alarm(list, isNew){
    lastAlarm = Date.now();
    if(soundOn) chime();
    try{ navigator.vibrate && navigator.vibrate([500,200,500,200,800]); }catch(_){}
    if(isNew) showCatAlert(list);
    if(isNew && soundOn && 'Notification' in window && Notification.permission==='granted' && document.visibilityState!=='visible'){
      try{ const o = list[list.length-1]; new Notification('🌐 Nuevo pedido web — Tomates Pizza', { body: `${o.customerName||''} · ${fmt(o.subtotal||o.total)} · ${orderPlaceLabel(o)}`, tag:'pedido-web', renotify:true, icon: CAT }); }catch(_){}
    }
  }

  /* ---------- Sticker del gato: "¡Nuevo pedido!" ---------- */
  const CAT = 'data:image/webp;base64,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';
  const catStyle = document.createElement('style');
  catStyle.textContent = `
    #webCatAlert{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);padding:16px}
    #webCatAlert.open{display:flex}
    #webCatAlert .cat-card{background:var(--card,#fff);color:var(--fg,#111);border:4px solid #FF3035;border-radius:22px;max-width:360px;width:100%;padding:18px 16px 16px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.45);animation:catPop .45s cubic-bezier(.2,1.6,.4,1)}
    #webCatAlert img{width:190px;height:auto;display:block;margin:-70px auto 4px;filter:drop-shadow(0 8px 14px rgba(0,0,0,.35));transform-origin:50% 90%;animation:catWave 1.1s ease-in-out infinite}
    #webCatAlert h2{font-family:Anton,Impact,sans-serif;text-transform:uppercase;letter-spacing:.02em;font-weight:400;font-size:30px;margin:4px 0 2px;color:#FF3035}
    #webCatAlert .cat-sub{font-size:15px;margin:2px 0}
    #webCatAlert .cat-items{font-size:13.5px;opacity:.85;margin:6px 0 12px}
    #webCatAlert .cat-actions{display:flex;gap:8px}
    #webCatAlert .cat-actions button{flex:1;min-height:48px;border-radius:12px;font-weight:800;font-size:15px}
    @keyframes catPop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
    @keyframes catWave{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg) translateY(-6px)}}
    @media (prefers-reduced-motion: reduce){#webCatAlert .cat-card,#webCatAlert img{animation:none}}`;
  document.head.appendChild(catStyle);
  const catBox = document.createElement('div');
  catBox.id = 'webCatAlert'; catBox.setAttribute('role','alertdialog'); catBox.setAttribute('aria-modal','true'); catBox.setAttribute('aria-labelledby','catTitle');
  document.body.appendChild(catBox);
  catBox.addEventListener('click', (e)=>{ if(e.target===catBox) closeCatAlert(); });
  document.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && catBox.classList.contains('open')) closeCatAlert(); });
  function showCatAlert(list){
    const o = list[list.length-1]; if(!o) return;
    const n = list.length;
    catBox.innerHTML = `<div class="cat-card">
        <img src="${CAT}" alt="Gato de Tomates Pizza con la pala de pizza">
        <h2 id="catTitle">¡Nuevo pedido!</h2>
        <div class="cat-sub"><b>${escH(o.customerName||'Cliente')}</b> · ${escH(orderPlaceLabel(o))}</div>
        <div class="cat-sub">Productos: <b>${fmt(o.subtotal||o.total)}</b></div>
        <div class="cat-items">${(o.items||[]).map(it=>`${it.qty}× ${escH(it.name)}`).join(', ')}</div>
        ${n>1 ? `<div class="cat-sub" style="color:#FF3035;font-weight:800">Hay ${n} pedidos web por confirmar</div>` : ''}
        <div class="cat-actions">
          <button type="button" class="secondary" onclick="closeCatAlert()">Cerrar</button>
          <button type="button" class="primary" onclick="openWebFromCat('${o.id}')">👀 Ver pedido</button>
        </div></div>`;
    catBox.classList.add('open');
    setTimeout(()=>{ const b = catBox.querySelector('.primary'); if(b) b.focus(); }, 50);
  }
  window.closeCatAlert = function(){ catBox.classList.remove('open'); };
  window.openWebFromCat = function(id){
    closeCatAlert();
    const tab = document.querySelector('nav.tabbar button[data-tab="pedidos"]'); if(tab) tab.click();
    setTimeout(()=>{ if(state.orders.some(x=>x.id===id && x.webStatus==='por_confirmar')) openConfirmWeb(id); }, 150);
  };
  window.toggleWebSound = function(ev){
    if(ev) ev.stopPropagation();
    soundOn = !soundOn; try{ localStorage.setItem('webSound', soundOn?'1':'0'); }catch(_){}
    if(soundOn){ unlock(); setTimeout(chime, 50); try{ if('Notification' in window && Notification.permission==='default') Notification.requestPermission(); }catch(_){} }
    renderWebBanner();
  };
  window.testWebSound = function(ev){ if(ev) ev.stopPropagation(); unlock(); setTimeout(()=>{ if(!chime()) toast('Toca la pantalla y vuelve a probar'); }, 80); };
  setInterval(()=>{
    if(!TOM.profile || !TOM.can('ventas.crear')) return;
    const list = pendingWeb();
    if(list.length && Date.now() - lastAlarm >= REPEAT_MS) alarm(list, false);
  }, 2000);
  // Título de la pestaña parpadea mientras haya pedidos web sin confirmar
  let blink = false;
  setInterval(()=>{
    const n = (TOM.profile && TOM.can('ventas.crear')) ? pendingWeb().length : 0;
    if(!n){ if(document.title!==baseTitle) document.title = baseTitle; return; }
    blink = !blink; document.title = blink ? `(${n}) 🌐 Pedido web` : baseTitle;
  }, 1200);

  function renderWebBanner(){
    if(!TOM.profile || !TOM.can('ventas.crear')){ banner.style.display = 'none'; return; }
    const list = pendingWeb(), ids = new Set(list.map(o=>o.id));
    if(seen && list.some(o=>!seen.has(o.id))) alarm(list, true);
    seen = ids;
    banner.style.display = '';
    const btn = (txt, fn)=>`<button type="button" class="ghost" style="padding:4px 10px;font-size:12.5px" onclick="${fn}(event)">${txt}</button>`;
    const ctl = `<span style="display:inline-flex;gap:6px;margin-left:6px;vertical-align:middle">${btn(soundOn?'🔔 Sonido activo':'🔕 Sonido apagado','toggleWebSound')}${soundOn?btn('▶ Probar','testWebSound'):''}</span>`;
    const warn = soundOn && audioBlocked() ? `<div class="item-meta" style="margin-top:4px;font-weight:700">⚠️ Toca cualquier parte de la pantalla para que el aviso pueda sonar.</div>` : '';
    banner.style.cursor = list.length ? 'pointer' : 'default';
    banner.onclick = list.length ? ()=>{ const el = document.getElementById('ordersList'); if(el) el.scrollIntoView({ behavior:'smooth' }); } : null;
    banner.innerHTML = list.length
      ? `🌐 <b>${list.length} pedido${list.length===1?'':'s'} web</b> por confirmar.${soundOn?' Sonará cada 20 s hasta confirmarlo.':''}${ctl}${warn}`
      : `<span class="item-meta">🌐 Pedidos web: alerta sonora</span>${ctl}${warn}`;
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
  /* ---------- Rechazar / cancelar pedidos web ----------
     Un pedido de la página se puede cancelar hasta antes de entregarlo; se borra por completo.
     Si ya tiene un pago registrado, solo el administrador (pagos.confirmar) puede cancelarlo. */
  const isPaid = (o)=> (o.paymentStatus==='pagado' || o.paymentStatus==='por_confirmar') && o.paymentMethod!=='cortesia';
  window.webCancelBtnHtml = function(o){
    if(o.source!=='web' || o.webStatus==='por_confirmar' || o.status==='entregado' || !TOM.can('ventas.crear')) return '';
    return `<button class="ghost" style="color:var(--bad)" onclick="openRejectWeb('${o.id}')">🚫 Cancelar</button>`;
  };
  window.openRejectWeb = function(id){
    const o = state.orders.find(x=>x.id===id); if(!o) return;
    const pending = o.webStatus==='por_confirmar';
    const verb = pending ? 'Rechazar' : 'Cancelar';
    const paid = isPaid(o), allowed = !paid || TOM.can('pagos.confirmar');
    const cooking = !pending && (o.status==='listo' || o.kitchenStage==='preparacion' || o.kitchenStage==='horno');
    modalBody.innerHTML = `<h3>${verb} pedido web #${escH(id.slice(0,5))}</h3>
      <div class="item-meta">${escH(o.customerName||'')} · ${escH(orderPlaceLabel(o))} · ${fmt(o.total)}</div>
      <div class="item-meta" style="margin-top:6px;color:var(--fg)">${(o.items||[]).map(it=>`${it.qty}× ${escH(it.name)}`).join(', ')}</div>
      <div class="item-meta" style="margin-top:8px">El pedido se borra por completo de Ventas y de Cocina, y no queda registro. Si el cliente dejó su WhatsApp, avísale.</div>
      ${cooking ? `<div class="item-meta" style="margin-top:6px;color:var(--bad);font-weight:700">⚠️ Cocina ya ${o.status==='listo'?'lo tiene listo':'lo está preparando'}. Avísales.</div>` : ''}
      ${paid ? `<div class="item-meta" style="margin-top:6px;color:var(--bad);font-weight:700">⚠️ Tiene un pago registrado (${escH(o.paymentMethodLabel||o.paymentMethod||'')} ${fmt(o.paymentAmount||o.total)}). Al cancelarlo ese ingreso sale de la caja: devuelve el dinero al cliente.${allowed?'':' Solo el administrador puede cancelarlo.'}</div>` : ''}
      <div class="modal-actions">
        <button class="secondary" onclick="closeModal()">Volver</button>
        ${(o.customerPhone||o.customerWaUser) ? `<button class="secondary" onclick="sendOrderWhatsApp('${o.id}','${pending?'rechazado':'cancelado'}')">📲 Avisar</button>` : ''}
        ${allowed ? `<button class="primary" style="background:var(--bad)" id="rjBtn" onclick="doRejectWeb('${o.id}')">${verb} y borrar</button>` : ''}
      </div>`;
    modalBg.classList.add('open');
  };
  window.doRejectWeb = async function(id){
    const o = state.orders.find(x=>x.id===id); const pending = o && o.webStatus==='por_confirmar';
    const btn = document.getElementById('rjBtn'); if(btn){ btn.disabled = true; btn.textContent = 'Borrando…'; }
    try{ await TOM.rpc('cancel_web_order', { p_order_id:id }); }
    catch(e){ if(btn){ btn.disabled = false; btn.textContent = (pending?'Rechazar':'Cancelar')+' y borrar'; } toast(e.message || String(e)); return; }
    closeModal(); toast(pending ? 'Pedido web rechazado' : 'Pedido web cancelado', 'ok');
  };

  /* ---------- Aviso al cliente por WhatsApp según el estado ---------- */
  function orderMessage(o, forced){
    const hi = `Hola ${(o.customerName||'').split(' ')[0]}! 🍕 Tomates Pizza`;
    const items = (o.items||[]).map(it=>`- ${it.qty}x ${it.name}`).join('\n');
    const money = `${items}${o.discountAmount>0?'\nDescuento: −'+fmt(o.discountAmount):''}${o.deliveryFee?'\nDomicilio: '+fmt(Math.max(0,(o.deliveryFee||0)-(o.deliveryDiscount||0))):''}\nTotal: ${fmt(o.total)}`;
    const id = '#'+(o.id||'').slice(0,5);
    if(forced==='cancelado') return `${hi}. Tu pedido ${id} fue cancelado. Si tienes alguna duda, escríbenos por aquí.`;
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
