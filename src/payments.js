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

  /* ---------- Registrar comprobante ---------- */
  let proofBlob = null;
  window.openQrProofModal = function(orderId){
    const o = state.orders.find(x=>x.id===orderId); if(!o) return;
    proofBlob = null;
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
        paymentProof: { ref, path, at: now, by: myUid, byName: (mine && mine.name) || '' },
        ...(verified ? { paymentConfirmedBy: myUid, paymentConfirmedAt: now } : {}),
      });
      closeModal();
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
      <div class="item-meta">Revisa en la app del banco que cada valor haya llegado y confirma o rechaza.</div>
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
    try{ await TOM.rpc('confirm_qr_payment', { p_order_id:id, p_ok:ok, p_note:note }); toast(ok ? 'Pago confirmado' : 'Pago rechazado', 'ok'); }
    catch(e){ toast(e.message); return; }
    setTimeout(()=>openQrReview(), 300);
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
