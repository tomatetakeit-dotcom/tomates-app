/* =====================================================================
   Tomates — Pagos por QR con comprobante
   El vendedor registra la foto del comprobante y/o la referencia; el pago queda
   "por confirmar" hasta que el administrador (pagos.confirmar) lo verifica en el
   banco y lo confirma o lo rechaza. Las fotos se guardan privadas en Supabase.
===================================================================== */
(function(){
  const TOM = window.TOM; const sb = TOM.sb;
  const escH = (s)=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // Reduce una foto antes de subirla (lado mayor maxSide px, JPEG)
  window.tomatesCompressImage = function(file, maxSide, quality){
    return new Promise((resolve, reject)=>{
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = ()=>{
        const k = Math.min(1, (maxSide||1600) / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width*k); c.height = Math.round(img.height*k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(b=> b ? resolve(b) : reject(new Error('No se pudo procesar la foto')), 'image/jpeg', quality||0.82);
      };
      img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('Ese archivo no es una imagen válida')); };
      img.src = url;
    });
  };
  const blobToB64 = (b)=> new Promise((res, rej)=>{ const r = new FileReader(); r.onload = ()=>res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(b); });
  window.tomatesBlobToBase64 = blobToB64;

  window.paymentBadgeHtml = function(o){
    if(o.webStatus==='por_confirmar') return '';
    const cobrar = `<button class="secondary" style="width:auto;padding:6px 12px;font-size:12.5px" onclick="openCobroModal('${o.id}')">💰 Cobrar</button>`;
    if(o.paymentMethod==='cortesia' || (!(Number(o.total)>0) && (o.items||[]).length && o.paymentStatus!=='pagado')) return `<span class="pill good">🎁 Cortesía · sin cobro</span>`;
    if(o.paymentStatus==='pagado') return `<span class="pill good">Pagado · ${escH(o.paymentMethodLabel||'')}</span>`;
    if(o.paymentStatus==='por_confirmar') return `<span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
        <span class="pill warn">⏳ QR por confirmar</span>
        ${TOM.can('pagos.confirmar') ? `<button class="secondary" style="width:auto;padding:6px 12px;font-size:12.5px" onclick="openQrReview('${o.id}')">Revisar</button>` : ''}</span>`;
    if(o.paymentStatus==='rechazado') return `<span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
        <span class="pill bad" title="${escH(o.paymentRejectedNote||'')}">❌ QR rechazado</span>${cobrar}</span>`;
    return cobrar;
  };

  /* ---------- Lectura del comprobante con IA ----------
     La IA lee banco, valor, fecha, hora, referencia y destinatario. La app compara con el pedido
     y marca "✔ Coincide" o "⚠️ Revisar". El administrador siempre confirma (decisión de Lucas). */
  let payCfg = { accounts: [] };
  async function loadPayCfg(){ const { data } = await sb.from('config').select('data').eq('id','pagos').maybeSingle(); payCfg = Object.assign({ accounts: [] }, (data && data.data) || {}); }
  TOM.whenReady.then(loadPayCfg);
  const normRef = (t)=> String(t||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  const normTxt = (t)=> String(t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  window.checkPaymentProof = function(o, ai, ref){
    const issues = [], oks = [];
    const expected = Number(o.balanceDue)>0 ? Number(o.balanceDue) : Number(o.total)||0;
    if(!ai) return { ok:false, issues:['No se leyó con IA'], oks };
    if(ai.es_comprobante===false || ai.legible===false) issues.push('No parece un comprobante legible' + (ai.observaciones ? ': '+ai.observaciones : ''));
    if(ai.exitosa===false) issues.push('El comprobante no dice que la transacción fue exitosa');
    const v = Number(ai.valor)||0;
    if(!v) issues.push('No se ve el valor'); else if(Math.abs(v-expected) > 1) issues.push(`El comprobante dice ${fmt(v)} y el pedido es ${fmt(expected)}`); else oks.push('Valor ' + fmt(v));
    const today = todayStr(), yest = addDaysStr(today,-1);
    if(!ai.fecha) issues.push('No se ve la fecha'); else if(ai.fecha!==today && !(ai.fecha===yest && new Date().getHours()<3)) issues.push('La fecha del comprobante es ' + ai.fecha + ', no hoy'); else oks.push('Fecha de hoy');
    if(ai.hora && o.createdAt){ const [h,m] = String(ai.hora).split(':').map(Number); if(isFinite(h)){ const d = new Date(o.createdAt); const paid = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m||0).getTime(); if(ai.fecha===today && paid < o.createdAt - 30*60000) issues.push('El pago ('+ai.hora+') es anterior al pedido'); } }
    const r0 = normRef(ref || ai.referencia);
    if(!r0) issues.push('No se ve la referencia');
    else {
      const dup = (state.orders||[]).find(x=>x.id!==o.id && x.paymentProof && (normRef(x.paymentProof.ref)===r0 || (x.paymentProof.ai && normRef(x.paymentProof.ai.referencia)===r0)));
      if(dup) issues.push('Esa referencia ya se usó en el pedido #' + String(dup.id).slice(0,5)); else oks.push('Referencia nueva');
    }
    const accs = (payCfg.accounts||[]).filter(a=>a && (a.last4 || a.holder));
    if(!accs.length) issues.push('Configura las cuentas de Tomates para verificar quién recibe');
    else {
      const dest4 = String(ai.destinatario_cuenta||'').replace(/\D/g,'').slice(-4), destN = normTxt(ai.destinatario_nombre);
      const hit = accs.some(a=> (a.last4 && dest4 && String(a.last4).replace(/\D/g,'').slice(-4)===dest4) || (a.holder && destN && normTxt(a.holder).split(' ').filter(w=>w.length>2).every(w=>destN.includes(w))));
      if(hit) oks.push('Va a una cuenta de Tomates'); else issues.push('No se ve que el dinero vaya a una cuenta de Tomates' + (ai.destinatario_nombre||dest4 ? ' ('+[ai.destinatario_nombre, dest4 ? '…'+dest4 : ''].filter(Boolean).join(' ')+')' : ''));
    }
    if(ai.observaciones && /sospech|editad|superpuest|alterad/i.test(ai.observaciones)) issues.push('La IA nota algo raro: ' + ai.observaciones);
    return { ok: !issues.length, issues, oks };
  };
  const checkHtml = (c)=> !c ? '' : c.ok
    ? `<div class="item-meta" style="color:var(--good);font-weight:700">✔ La IA lo revisó: coincide (${c.oks.join(' · ')})</div>`
    : `<div class="item-meta" style="color:var(--bad);font-weight:700">⚠️ Revisar: ${c.issues.join(' · ')}</div>${c.oks.length ? `<div class="item-meta">✔ ${c.oks.join(' · ')}</div>` : ''}`;
  window.paymentCheckHtml = checkHtml;
  async function readProofWithAi(o, blob){
    const box = document.getElementById('qpAi'); if(!box) return null;
    box.innerHTML = '🤖 Leyendo el comprobante con IA… (unos segundos)';
    const isPdf = blob.type==='application/pdf';
    const expected = Number(o.balanceDue)>0 ? Number(o.balanceDue) : Number(o.total)||0;
    const { data, error } = await sb.functions.invoke('read-payment', { body: { file: await tomatesBlobToBase64(blob), mediaType: isPdf ? 'application/pdf' : 'image/jpeg',
      expected, accounts: (payCfg.accounts||[]).map(a=>({ nombre:a.label||'', titular:a.holder||'', ultimos4:a.last4||'' })), today: todayStr() } });
    if(error){
      let m = 'No se pudo leer con IA.'; try{ const j = await error.context.json(); if(j && j.error) m = j.error; }catch(_){}
      box.innerHTML = `<div class="item-meta">ℹ️ ${escH(m)} Escribe la referencia a mano.</div>`; return null;
    }
    return data && data.data;
  }

  /* ---------- Registrar comprobante ---------- */
  let proofBlob = null, proofAi = null;
  window.openQrProofModal = function(orderId){
    const o = state.orders.find(x=>x.id===orderId); if(!o) return;
    proofBlob = null; proofAi = null;
    const canConfirm = TOM.can('pagos.confirmar');
    modalBody.innerHTML = `
      <h3>Comprobante de pago QR — ${fmt(o.total)}</h3>
      <div class="item-meta">Toma la foto del comprobante que muestra el cliente (o una captura) y escribe la referencia si la tiene.
        ${canConfirm ? '' : 'El administrador confirmará el pago al verlo en la cuenta.'}</div>
      <label for="qpRef">Referencia o número de aprobación</label>
      <input id="qpRef" maxlength="40" autocomplete="off" placeholder="Ej: M1234567">
      <label>Foto del comprobante</label>
      <input type="file" id="qpCam" accept="image/*" capture="environment" style="display:none">
      <input type="file" id="qpFile" accept="image/*,application/pdf" style="display:none">
      <div class="row" style="gap:8px">
        <button type="button" class="secondary" style="flex:1" onclick="document.getElementById('qpCam').click()">📷 Tomar foto</button>
        <button type="button" class="secondary" style="flex:1" onclick="document.getElementById('qpFile').click()">🖼️ Galería o archivos</button>
      </div>
      <div class="item-meta">Puedes subir la captura de pantalla del pago, una foto o el PDF del banco.</div>
      <img id="qpPrev" alt="Vista previa del comprobante" style="display:none;max-width:100%;max-height:260px;margin:8px auto 0;border-radius:10px;border:1px solid var(--border)">
      <div id="qpPdf" class="item-meta" style="display:none;margin-top:8px;font-weight:700;color:var(--fg)"></div>
      <div id="qpAi" style="margin-top:8px"></div>
      ${canConfirm ? `<label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type="checkbox" id="qpVerified" style="width:auto"> Ya verifiqué que el dinero llegó a la cuenta</label>` : ''}
      <div id="qpErr" class="item-meta" style="color:var(--bad);font-weight:700"></div>
      <div class="modal-actions">
        <button class="secondary" onclick="openCobroModal('${o.id}')">Volver</button>
        <button class="primary" id="qpBtn" onclick="saveQrProof('${o.id}')">Guardar</button>
      </div>`;
    const onProof = async (e)=>{
      const f = e.target.files && e.target.files[0]; if(!f) return;
      const pv = document.getElementById('qpPrev'), pdf = document.getElementById('qpPdf');
      document.getElementById('qpErr').textContent = '';
      try{
        if(f.type==='application/pdf' || /\.pdf$/i.test(f.name)){
          if(f.size > 8*1024*1024) throw new Error('El PDF pesa más de 8 MB. Toma una captura de pantalla del pago.');
          proofBlob = f.slice(0, f.size, 'application/pdf'); pv.style.display = 'none';
          pdf.textContent = '📄 ' + f.name; pdf.style.display = 'block';
        } else {
          proofBlob = await tomatesCompressImage(f, 1400, 0.8);
          pv.src = URL.createObjectURL(proofBlob); pv.style.display = 'block'; pdf.style.display = 'none';
        }
      }catch(err){ proofBlob = null; document.getElementById('qpErr').textContent = err.message; }
      e.target.value = '';
      if(proofBlob){
        const ai = await readProofWithAi(o, proofBlob);
        if(ai){
          proofAi = ai;
          const refIn = document.getElementById('qpRef');
          if(refIn && !refIn.value.trim() && ai.referencia) refIn.value = String(ai.referencia).slice(0,40);
          const c = checkPaymentProof(o, ai, refIn && refIn.value);
          const box = document.getElementById('qpAi');
          if(box) box.innerHTML = `<div class="card" style="margin:0">
              <div class="item-meta">🤖 ${escH([ai.banco_app, ai.valor ? fmt(ai.valor) : '', ai.fecha, ai.hora].filter(Boolean).join(' · '))}${ai.destinatario_nombre ? ' · para '+escH(ai.destinatario_nombre) : ''}${ai.referencia ? ' · ref. '+escH(ai.referencia) : ''}</div>
              ${checkHtml(c)}</div>`;
        }
      }
    };
    document.getElementById('qpCam').addEventListener('change', onProof);
    document.getElementById('qpFile').addEventListener('change', onProof);
    modalBg.classList.add('open');
  };
  window.saveQrProof = async function(orderId){
    const o = state.orders.find(x=>x.id===orderId); if(!o) return;
    const ref = document.getElementById('qpRef').value.trim();
    const err = (m)=>{ document.getElementById('qpErr').textContent = m; };
    if(!ref && !proofBlob) return err('Toma la foto del comprobante o escribe la referencia.');
    const verified = !!(document.getElementById('qpVerified') && document.getElementById('qpVerified').checked);
    const btn = document.getElementById('qpBtn'); btn.disabled = true; btn.textContent = 'Guardando…';
    try{
      let path = '';
      if(proofBlob){
        const isPdf = proofBlob.type==='application/pdf';
        path = `${o.date||todayStr()}/${o.id}-${Date.now()}.${isPdf?'pdf':'jpg'}`;
        const { error } = await sb.storage.from('comprobantes').upload(path, proofBlob, { contentType: isPdf ? 'application/pdf' : 'image/jpeg', upsert:false });
        if(error) throw new Error('No se pudo subir la foto: ' + TOM.friendly(error));
      }
      const mine = state.roles.find(r=>r.id===myUid);
      const now = Date.now();
      await db.collection('orders').doc(orderId).update({
        paymentStatus: verified ? 'pagado' : 'por_confirmar',
        paymentMethod: 'qr', paymentMethodLabel: 'QR', paymentAmount: o.total,
        paidAt: now, paidDate: todayStr(),
        paymentProof: { ref, path, at: now, by: myUid, byName: (mine && mine.name) || '', ...(proofAi ? { ai: proofAi, check: checkPaymentProof(o, proofAi, ref) } : {}) },
        ...(verified ? { paymentConfirmedBy: myUid, paymentConfirmedAt: now } : {}),
      });
      const lo = state.orders.find(x=>x.id===orderId);
      if(lo){ lo.paymentStatus = verified ? 'pagado' : 'por_confirmar'; lo.paymentMethod = 'qr'; lo.paymentMethodLabel = 'QR'; lo.paymentAmount = o.total; lo.paidAt = now; }
      closeModal(); try{ renderAll(); }catch(_){}
      TOM.refetchRow('orders', orderId);
      toast(verified ? 'Pago confirmado' : 'Comprobante guardado. Queda por confirmar.', 'ok');
    }catch(e){ btn.disabled = false; btn.textContent = 'Guardar'; err(e.message || String(e)); }
  };

  /* ---------- Revisión del administrador ---------- */
  const signed = new Map();
  async function signedUrl(path){
    if(!path) return '';
    if(signed.has(path)) return signed.get(path);
    const { data } = await sb.storage.from('comprobantes').createSignedUrl(path, 3600);
    const u = (data && data.signedUrl) || ''; signed.set(path, u); return u;
  }
  const pendingQr = ()=> state.orders.filter(o=>o.paymentStatus==='por_confirmar').sort((a,b)=>(a.paidAt||0)-(b.paidAt||0));
  window.openQrReview = async function(onlyId){
    const list = pendingQr().filter(o=>!onlyId || o.id===onlyId);
    modalBody.innerHTML = `<h3>Pagos QR por confirmar</h3>
      <div class="item-meta">Revisa en la app del banco (o en Bold) que cada valor haya llegado y confirma o rechaza. La IA te ayuda a ver cuáles revisar con más cuidado.</div>
      ${TOM.can('config.gestionar') ? `<button class="ghost" type="button" onclick="openPayAccounts()">⚙️ Cuentas de Tomates para verificar (${(payCfg.accounts||[]).length})</button>` : ''}
      <div id="qrRevList">${list.length ? '' : '<div class="empty">No hay pagos pendientes.</div>'}</div>
      <div class="modal-actions"><button class="secondary" onclick="closeModal()">Cerrar</button></div>`;
    modalBg.classList.add('open');
    const wrap = document.getElementById('qrRevList');
    for(const o of list){
      const p = o.paymentProof || {};
      const url = await signedUrl(p.path);
      const card = document.createElement('div'); card.className = 'card';
      card.innerHTML = `
        <div class="row"><div class="item-name">${fmt(o.paymentAmount||o.total)}</div><span class="item-meta">#${escH((o.id||'').slice(0,5))}</span></div>
        <div class="item-meta">${escH(o.customerName || o.spot || '')} · ${o.paidAt ? fmtTime(o.paidAt) : ''} · registró ${escH(p.byName||'')}</div>
        <div class="item-meta">Referencia: <b>${escH(p.ref || '—')}</b></div>
        ${p.ai ? `<div class="item-meta">🤖 ${escH([p.ai.banco_app, p.ai.valor ? fmt(p.ai.valor) : '', p.ai.fecha, p.ai.hora].filter(Boolean).join(' · '))}${p.ai.destinatario_nombre ? ' · para '+escH(p.ai.destinatario_nombre) : ''}${p.ai.remitente_nombre ? ' · de '+escH(p.ai.remitente_nombre) : ''}</div>${checkHtml(checkPaymentProof(o, p.ai, p.ref))}` : '<div class="item-meta">Sin lectura con IA: revisa todo a mano.</div>'}
        ${url && /\.pdf$/i.test(p.path||'') ? `<a class="secondary" href="${url}" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px;padding:8px 12px;text-decoration:none">📄 Abrir PDF del comprobante</a>` : url ? `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Comprobante" style="max-width:100%;max-height:280px;margin-top:8px;border-radius:10px;border:1px solid var(--border)"></a>` : '<div class="item-meta">Sin foto</div>'}
        <input id="rj_${o.id}" placeholder="Motivo si lo rechazas (opcional)" maxlength="120" style="margin-top:8px">
        <div class="row" style="gap:8px;margin-top:8px">
          <button class="primary" style="flex:1" onclick="decideQr('${o.id}',true)">✅ Confirmar</button>
          <button class="secondary" style="flex:1" onclick="decideQr('${o.id}',false)">❌ Rechazar</button>
        </div>`;
      wrap.appendChild(card);
    }
  };
  window.decideQr = async function(id, ok){
    const note = (document.getElementById('rj_'+id)||{}).value || '';
    modalBody.querySelectorAll('button').forEach(b=>{ if(/decideQr\('/.test(b.getAttribute('onclick')||'') && (b.getAttribute('onclick')||'').includes(id)) b.disabled = true; });
    try{ await TOM.rpc('confirm_qr_payment', { p_order_id:id, p_ok:ok, p_note:note }); }
    catch(e){ toast(e.message); modalBody.querySelectorAll('button').forEach(b=>b.disabled=false); return; }
    // Se ve al instante en este equipo (sin esperar a la conexión en vivo)
    const o = state.orders.find(x=>x.id===id);
    if(o){ if(ok){ o.paymentStatus = 'pagado'; o.paymentConfirmedAt = Date.now(); } else { o.paymentStatus = 'rechazado'; o.paymentRejectedNote = note; } }
    try{ renderAll(); }catch(_){}
    toast(ok ? 'Pago confirmado' : 'Pago rechazado', 'ok');
    await TOM.refetchRow('orders', id);
    if(pendingQr().length) openQrReview(); else closeModal();
  };

  window.openPayAccounts = function(){
    const accs = (payCfg.accounts||[]).concat([{},{}]).slice(0, Math.max(3, (payCfg.accounts||[]).length+1));
    modalBody.innerHTML = `<h3>Cuentas de Tomates</h3>
      <div class="item-meta">La IA compara quién recibe el dinero en cada comprobante con estas cuentas. Escribe el nombre del titular como aparece en los comprobantes y/o los <b>últimos 4 dígitos</b> de la cuenta o celular (no hace falta el número completo).</div>
      ${accs.map((a,i)=>`<div class="card"><div class="grid2">
          <div><label for="pa_l${i}">Banco o app</label><input id="pa_l${i}" maxlength="30" placeholder="Ej: Bold, Bancolombia" value="${escH(a.label||'')}"></div>
          <div><label for="pa_4${i}">Últimos 4 dígitos</label><input id="pa_4${i}" inputmode="numeric" maxlength="4" placeholder="1234" value="${escH(a.last4||'')}"></div></div>
          <label for="pa_h${i}">Titular (como sale en el comprobante)</label><input id="pa_h${i}" maxlength="60" placeholder="Ej: Tomates Pizza SAS" value="${escH(a.holder||'')}"></div>`).join('')}
      <div id="paErr" class="item-meta" style="color:var(--bad);font-weight:700"></div>
      <div class="modal-actions"><button class="secondary" onclick="openQrReview()">Volver</button><button class="primary" onclick="savePayAccounts(${accs.length})">Guardar</button></div>`;
    modalBg.classList.add('open');
  };
  window.savePayAccounts = async function(n){
    const accounts = [];
    for(let i=0;i<n;i++){
      const label = document.getElementById('pa_l'+i).value.trim(), last4 = document.getElementById('pa_4'+i).value.replace(/\D/g,'').slice(-4), holder = document.getElementById('pa_h'+i).value.trim();
      if(label || last4 || holder) accounts.push({ label, last4, holder });
    }
    const { error } = await sb.from('config').upsert({ id:'pagos', data: Object.assign({}, payCfg, { accounts, updatedAt: Date.now() }) });
    if(error){ document.getElementById('paErr').textContent = TOM.friendly(error); return; }
    payCfg.accounts = accounts; toast('Cuentas guardadas', 'ok'); openQrReview();
  };

  // Aviso en Ventas para quien confirma pagos
  const ventas = document.getElementById('tab-pedidos');
  const banner = document.createElement('div');
  banner.id = 'qrPendingBanner'; banner.className = 'banner'; banner.style.display = 'none'; banner.style.cursor = 'pointer';
  banner.onclick = ()=>openQrReview();
  if(ventas){ const h = ventas.querySelector('.section-title'); ventas.insertBefore(banner, h ? h.nextSibling : ventas.firstChild); }
  function renderQrBanner(){
    if(!TOM.profile || !TOM.can('pagos.confirmar')){ banner.style.display = 'none'; return; }
    const n = pendingQr().length;
    banner.style.display = n ? '' : 'none';
    banner.innerHTML = `⏳ <b>${n} pago${n===1?'':'s'} por QR</b> esperando confirmación. Toca para revisar.`;
  }
  const _renderAll = window.renderAll;
  window.renderAll = function(){ _renderAll(); renderQrBanner(); };
})();
