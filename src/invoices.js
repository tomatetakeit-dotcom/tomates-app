/* =====================================================================
   Tomates — Facturas por foto (pestaña Compras, permiso compras.gestionar)
   1) Se toma la foto  2) La IA la lee (función read-invoice)  3) La persona revisa
   cada línea: insumo (entra al inventario como compra) o gasto  4) Se contabiliza.
   Sin llave de IA se puede registrar a mano con la foto como soporte.
===================================================================== */
(function(){
  const TOM = window.TOM; const sb = TOM.sb;
  const escH = (s)=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const PAY = [['efectivo','Efectivo'],['transferencia','Transferencia'],['tarjeta','Tarjeta / Datáfono'],['otro','Crédito / otro']];
  let inv = null;       // factura en revisión
  let invoices = [];    // últimas facturas registradas

  /* ---------- Sección en Compras ---------- */
  const sec = document.getElementById('tab-compras');
  const box = document.createElement('div');
  box.id = 'invoiceBox'; box.style.display = 'none';
  box.innerHTML = `<button class="primary" type="button" style="width:100%;margin-bottom:10px" onclick="openInvoiceCapture()">📷 Registrar factura con foto</button>
    <div id="invoiceList"></div>`;
  if(sec){ const list = document.getElementById('purchasesList'); sec.insertBefore(box, list); }

  async function loadInvoices(){
    if(!TOM.can('compras.gestionar')) return;
    const { data } = await sb.from('invoices').select('id,supplier,number,invoice_date,total,read_by_ai,image_path,purchase_ids,expense_ids,created_at').order('created_at', { ascending:false }).limit(15);
    invoices = data || []; renderInvoiceList();
  }
  function renderInvoiceList(){
    box.style.display = TOM.can('compras.gestionar') ? '' : 'none';
    const el = document.getElementById('invoiceList'); if(!el) return;
    if(!invoices.length){ el.innerHTML = ''; return; }
    el.innerHTML = `<details class="card" style="margin-bottom:12px"><summary class="item-name" style="cursor:pointer">🧾 Últimas facturas registradas (${invoices.length})</summary>
      ${invoices.map(f=>`<div class="row" style="margin-top:8px;gap:8px">
        <div style="min-width:0"><div class="item-name" style="font-size:14px">${escH(f.supplier||'Sin proveedor')} ${f.number?'· #'+escH(f.number):''}</div>
          <div class="item-meta">${escH(f.invoice_date||'')} · ${f.purchase_ids.length} compra${f.purchase_ids.length===1?'':'s'}, ${f.expense_ids.length} gasto${f.expense_ids.length===1?'':'s'}${f.read_by_ai?' · leída con IA':''}</div></div>
        <div style="text-align:right"><div class="item-name" style="font-size:14px">${fmt(f.total)}</div>
          ${f.image_path ? `<button class="ghost" style="width:auto" onclick="viewInvoiceImage('${escH(f.image_path)}')">Ver foto</button>` : ''}</div></div>`).join('')}</details>`;
  }
  window.viewInvoiceImage = async function(path){
    const { data } = await sb.storage.from('facturas').createSignedUrl(path, 3600);
    if(data && data.signedUrl) window.open(data.signedUrl, '_blank', 'noopener');
  };
  TOM.whenReady.then(()=>{
    loadInvoices();
    if(TOM.can('compras.gestionar')) sb.channel('inv_rt').on('postgres_changes', { event:'*', schema:'public', table:'invoices' }, loadInvoices).subscribe();
  });

  /* ---------- 1) Foto ---------- */
  window.openInvoiceCapture = function(){
    inv = null;
    modalBody.innerHTML = `
      <h3>Factura por foto</h3>
      <div class="item-meta">Toma la foto de frente, con buena luz y la factura completa. La IA lee los datos y tú los revisas antes de guardar.</div>
      <input type="file" id="ivCam" accept="image/*" capture="environment" style="display:none">
      <input type="file" id="ivFile" accept="image/*" style="display:none">
      <div class="row" style="gap:8px;margin-top:12px">
        <button type="button" class="primary" style="flex:1" onclick="document.getElementById('ivCam').click()">📷 Tomar foto</button>
        <button type="button" class="secondary" style="flex:1" onclick="document.getElementById('ivFile').click()">🖼️ Galería o archivos</button>
      </div>
      <img id="ivPrev" alt="Vista previa de la factura" style="display:none;max-width:100%;max-height:320px;margin:10px auto 0;border-radius:10px;border:1px solid var(--border)">
      <div id="ivMsg" class="item-meta" style="margin-top:8px"></div>
      <div class="modal-actions">
        <button class="secondary" onclick="closeModal()">Cancelar</button>
        <button class="secondary" onclick="startInvoiceReview(null)">Registrar a mano</button>
      </div>`;
    const onInvoiceFile = async (e)=>{
      const f = e.target.files && e.target.files[0]; if(!f) return;
      const msg = document.getElementById('ivMsg');
      try{
        const blob = await tomatesCompressImage(f, 1800, 0.85);
        const pv = document.getElementById('ivPrev'); pv.src = URL.createObjectURL(blob); pv.style.display = 'block';
        inv = { blob, data:null, ai:false };
        msg.textContent = '⏳ Leyendo la factura con IA… (unos segundos)';
        const ingredients = state.ingredients.map(i=>[i.id, i.name, i.unit]);
        const categories = categoriesFor('gastos').map(c=>c.name);
        const { data, error } = await sb.functions.invoke('read-invoice', { body: { image: await tomatesBlobToBase64(blob), mediaType:'image/jpeg', ingredients, categories } });
        if(error){
          let m = 'No se pudo leer la factura.'; let code = '';
          try{ const j = await error.context.json(); if(j && j.error){ m = j.error; code = j.code||''; } }catch(_){}
          msg.innerHTML = `⚠️ ${escH(m)} ${code==='no_key' ? 'Mientras tanto puedes registrarla a mano; la foto queda como soporte.' : 'Puedes intentar con otra foto o registrarla a mano.'}`;
          return;
        }
        inv.data = data && data.data; inv.ai = true;
        if(inv.data && inv.data.legible===false){ msg.textContent = '⚠️ ' + (inv.data.observaciones || 'La foto no se ve clara.') + ' Puedes revisar y corregir.'; }
        startInvoiceReview(inv.data);
      }catch(err){ msg.textContent = '⚠️ ' + (err.message || err); }
    };
    document.getElementById('ivCam').addEventListener('change', onInvoiceFile);
    document.getElementById('ivFile').addEventListener('change', onInvoiceFile);
    modalBg.classList.add('open');
  };

  /* ---------- 2) Revisión ---------- */
  const num = (v)=> Math.round(Number(String(v==null?'':v).replace(/[^0-9.,-]/g,'').replace(/\.(?=\d{3}(\D|$))/g,'').replace(',','.'))||0);
  window.startInvoiceReview = function(d){
    inv = inv || { blob:null, data:null, ai:false };
    d = d || {};
    const pm = { efectivo:'efectivo', transferencia:'transferencia', tarjeta:'tarjeta', credito:'otro' }[d.metodo_pago] || 'efectivo';
    inv.head = { supplier: d.proveedor||'', nit: d.nit||'', number: d.numero||'', date: /^\d{4}-\d{2}-\d{2}$/.test(d.fecha||'') ? d.fecha : todayStr(), pay: pm, total: num(d.total) };
    const ingIds = new Set(state.ingredients.map(i=>i.id));
    const cats = categoriesFor('gastos').map(c=>c.name);
    inv.lines = (Array.isArray(d.lineas) ? d.lineas : []).map(l=>{
      const isIng = l.tipo!=='gasto' && l.insumo_id && ingIds.has(l.insumo_id);
      return { desc: String(l.descripcion||'').slice(0,120), kind: isIng ? 'insumo' : (l.tipo==='gasto' ? 'gasto' : 'insumo'),
               ing: isIng ? l.insumo_id : '', qty: Number(l.cantidad_insumo)||'', raw: [l.cantidad, l.unidad].filter(Boolean).join(' '),
               cat: cats.includes(l.categoria_gasto) ? l.categoria_gasto : '', amount: num(l.valor_total) };
    });
    if(!inv.lines.length) inv.lines.push({ desc:'', kind:'insumo', ing:'', qty:'', raw:'', cat:'', amount:inv.head.total||0 });
    renderReview();
  };
  function lineHtml(l, i){
    const ing = state.ingredients.find(x=>x.id===l.ing);
    return `<div class="card" style="padding:10px">
      <div class="row" style="gap:8px">
        <input value="${escH(l.desc)}" placeholder="Descripción" oninput="invSet(${i},'desc',this.value)" style="flex:1">
        <button class="ghost" style="width:auto" title="Quitar línea" onclick="invDel(${i})">✕</button>
      </div>
      ${l.raw ? `<div class="item-meta">En la factura: ${escH(l.raw)}</div>` : ''}
      <div class="segmented" style="margin-top:6px">
        ${[['insumo','Insumo (inventario)'],['gasto','Gasto'],['ignorar','No registrar']].map(([k,t])=>`<button type="button" class="${l.kind===k?'active':''}" onclick="invSet(${i},'kind','${k}',true)">${t}</button>`).join('')}
      </div>
      ${l.kind==='insumo' ? `<div class="grid2">
          <div><label>Insumo</label><select onchange="invSet(${i},'ing',this.value,true)"><option value="">— elegir —</option>
            ${[...state.ingredients].sort((a,b)=>a.name.localeCompare(b.name)).map(x=>`<option value="${x.id}" ${x.id===l.ing?'selected':''}>${escH(x.name)} (${escH(x.unit)})</option>`).join('')}</select></div>
          <div><label>Cantidad${ing?' en '+escH(ing.unit):''}</label><input type="number" inputmode="decimal" value="${l.qty}" oninput="invSet(${i},'qty',this.value)"></div>
        </div>` : ''}
      ${l.kind==='gasto' ? `<label>Categoría del gasto</label><select onchange="invSet(${i},'cat',this.value)"><option value="">— elegir —</option>
          ${categoriesFor('gastos').map(c=>`<option ${c.name===l.cat?'selected':''}>${escH(c.name)}</option>`).join('')}</select>` : ''}
      ${l.kind!=='ignorar' ? `<label>Valor pagado por esta línea</label><input type="number" inputmode="numeric" value="${l.amount||''}" oninput="invSet(${i},'amount',this.value)">` : ''}
    </div>`;
  }
  function sums(){
    const s = inv.lines.filter(l=>l.kind!=='ignorar').reduce((a,l)=>a+(Number(l.amount)||0),0);
    return { s, diff: (Number(inv.head.total)||0) - s };
  }
  function renderSum(){
    const el = document.getElementById('ivSum'); if(!el) return;
    const { s, diff } = sums();
    el.innerHTML = `Suma de líneas: <b>${fmt(s)}</b> · Total factura: <b>${fmt(inv.head.total||0)}</b>` +
      (Math.abs(diff) > 1 ? ` · <span style="color:var(--bad);font-weight:700">Diferencia ${fmt(diff)}</span>` : ' · ✔ cuadra');
  }
  function renderReview(){
    const h = inv.head;
    modalBody.innerHTML = `
      <h3>Revisar factura</h3>
      ${inv.ai ? '<div class="banner">La IA llenó estos datos. Revísalos: lo que guardes entra a compras, inventario y gastos.</div>' : ''}
      <div class="grid2">
        <div><label>Proveedor</label><input id="ivSup" value="${escH(h.supplier)}" oninput="invHead('supplier',this.value)"></div>
        <div><label>NIT</label><input id="ivNit" value="${escH(h.nit)}" oninput="invHead('nit',this.value)"></div>
        <div><label>Número de factura</label><input id="ivNum" value="${escH(h.number)}" oninput="invHead('number',this.value)"></div>
        <div><label>Fecha de compra</label><input id="ivDate" type="date" value="${escH(h.date)}" oninput="invHead('date',this.value)"></div>
        <div><label>Forma de pago</label><select id="ivPay" onchange="invHead('pay',this.value)">${PAY.map(([v,t])=>`<option value="${v}" ${h.pay===v?'selected':''}>${t}</option>`).join('')}</select></div>
        <div><label>Total de la factura</label><input id="ivTotal" type="number" inputmode="numeric" value="${h.total||''}" oninput="invHead('total',this.value)"></div>
      </div>
      <h3 class="section-title" style="font-size:18px;margin-top:14px">Líneas</h3>
      <div id="ivLines">${inv.lines.map(lineHtml).join('')}</div>
      <button class="ghost" style="width:100%" onclick="invAdd()">＋ Agregar línea</button>
      <div id="ivSum" class="item-meta" style="margin-top:8px"></div>
      <div id="ivErr" class="item-meta" style="color:var(--bad);font-weight:700"></div>
      <div class="modal-actions">
        <button class="secondary" onclick="closeModal()">Cancelar</button>
        <button class="primary" id="ivSave" onclick="saveInvoice()">Contabilizar</button>
      </div>`;
    renderSum();
    modalBg.classList.add('open');
  }
  window.invHead = (k, v)=>{ inv.head[k] = k==='total' ? (Number(v)||0) : v; if(k==='total') renderSum(); };
  window.invSet = (i, k, v, rerender)=>{ inv.lines[i][k] = (k==='amount') ? (Number(v)||0) : v; if(rerender){ keepHead(); renderReview(); } else if(k==='amount') renderSum(); };
  window.invDel = (i)=>{ keepHead(); inv.lines.splice(i,1); renderReview(); };
  window.invAdd = ()=>{ keepHead(); inv.lines.push({ desc:'', kind:'insumo', ing:'', qty:'', raw:'', cat:'', amount:0 }); renderReview(); };
  function keepHead(){ /* los campos ya se guardan al escribir */ }

  /* ---------- 3) Contabilizar ---------- */
  window.saveInvoice = async function(){
    const h = inv.head, err = (m)=>{ document.getElementById('ivErr').textContent = m; };
    const lines = inv.lines.filter(l=>l.kind!=='ignorar');
    if(!lines.length) return err('No hay líneas para registrar.');
    for(const [i,l] of inv.lines.entries()){
      if(l.kind==='ignorar') continue;
      if(!(Number(l.amount)>0)) return err(`Línea ${i+1}: escribe el valor.`);
      if(l.kind==='insumo' && !l.ing) return err(`Línea ${i+1}: elige el insumo (o márcala como gasto).`);
      if(l.kind==='insumo' && !(Number(l.qty)>0)) return err(`Línea ${i+1}: escribe la cantidad en la unidad del insumo.`);
      if(l.kind==='gasto' && !l.cat) return err(`Línea ${i+1}: elige la categoría del gasto.`);
    }
    if(!h.date) return err('Escribe la fecha de la factura.');
    const { diff } = sums();
    if(h.total && Math.abs(diff) > Math.max(100, h.total*0.01)){
      if(!(await askConfirm(`Las líneas suman ${fmt(h.total - diff)} y la factura dice ${fmt(h.total)}. ¿Guardar de todas formas?`, 'Guardar'))) return;
    }
    if(h.number && h.supplier){
      const { data: dup } = await sb.from('invoices').select('id').eq('number', h.number).eq('supplier', h.supplier).limit(1);
      if(dup && dup.length && !(await askConfirm('Ya hay una factura de ese proveedor con ese número. ¿Registrarla otra vez?', 'Registrar'))) return;
    }
    const btn = document.getElementById('ivSave'); btn.disabled = true; btn.textContent = 'Guardando…';
    try{
      let image_path = '';
      if(inv.blob){
        image_path = `${h.date}/${Date.now()}-${Math.random().toString(36).slice(2,7)}.jpg`;
        const { error } = await sb.storage.from('facturas').upload(image_path, inv.blob, { contentType:'image/jpeg', upsert:false });
        if(error) throw new Error('No se pudo guardar la foto: ' + TOM.friendly(error));
      }
      const ref = [h.supplier, h.number ? 'Factura '+h.number : ''].filter(Boolean).join(' · ');
      const purchase_ids = [], expense_ids = [];
      for(const l of lines){
        if(l.kind==='insumo'){
          const ing = state.ingredients.find(x=>x.id===l.ing);
          const id = await TOM.rpc('register_purchase', { p_data: {
            ingredientId: l.ing, ingredientName: ing ? ing.name : '', unit: ing ? ing.unit : '',
            qty: Number(l.qty), totalCost: Number(l.amount), provider: h.supplier, date: h.date, paymentMethod: h.pay,
            category: 'Factura', subcategory: '', invoiceNumber: h.number, note: l.desc } });
          purchase_ids.push(String(id||''));
        } else {
          const r = await db.collection('expenses').add({ category: l.cat, subcategory: '', amount: Number(l.amount),
            description: [l.desc, ref].filter(Boolean).join(' — '), date: h.date, paymentMethod: h.pay, invoiceNumber: h.number });
          expense_ids.push(String((r && r.id) || ''));
        }
      }
      const { error: e2 } = await sb.from('invoices').insert({ supplier: h.supplier, supplier_nit: h.nit, number: h.number, invoice_date: h.date,
        total: Number(h.total)||lines.reduce((a,l)=>a+Number(l.amount),0), payment_method: h.pay, image_path, read_by_ai: !!inv.ai,
        data: { leido: inv.data || null, lineas: inv.lines }, purchase_ids: purchase_ids.filter(Boolean), expense_ids: expense_ids.filter(Boolean) });
      if(e2) throw new Error(TOM.friendly(e2));
      closeModal(); inv = null;
      toast(`Factura contabilizada: ${purchase_ids.length} compra${purchase_ids.length===1?'':'s'} y ${expense_ids.length} gasto${expense_ids.length===1?'':'s'}`, 'ok');
      loadInvoices();
    }catch(e){ btn.disabled = false; btn.textContent = 'Contabilizar'; err(e.message || String(e)); }
  };

  const _renderAll = window.renderAll;
  window.renderAll = function(){ _renderAll(); box.style.display = TOM.profile && TOM.can('compras.gestionar') ? '' : 'none'; };
})();
