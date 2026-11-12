"""Construye site/index.html a partir de la app original + adaptador Supabase.
Uso: python3 -I build.py <app_original.html> <carpeta_salida> [--mock]
Cada reemplazo debe existir exactamente las veces indicadas; si no, falla.
"""
import sys, pathlib

src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
out_dir = pathlib.Path(sys.argv[2]); out_dir.mkdir(parents=True, exist_ok=True)
mock = "--mock" in sys.argv
here = pathlib.Path(__file__).parent

def rep(s, old, new, count=1):
    n = s.count(old)
    if n != count:
        raise SystemExit(f"Esperaba {count} coincidencia(s) y hay {n}: {old[:80]!r}")
    return s.replace(old, new)

# 1) Chequeos de rol -> permisos
s = src
s = rep(s, "if(myRole!=='admin'){ wrap.innerHTML=''; return; }", "if(!can('ventas.aprobar_cambios')){ wrap.innerHTML=''; return; }")
s = rep(s, "const needsApproval = editingOrderId && myRole!=='admin';", "const needsApproval = editingOrderId && !can('ventas.editar');")
s = rep(s, "    if(myRole==='admin'){\n      await db.collection('orders').doc(editingOrderId)", "    if(can('ventas.editar')){\n      await db.collection('orders').doc(editingOrderId)")
s = rep(s, "  const today = todayStr();\n  const isAdmin = myRole==='admin';\n  const L = buildCashLedger();", "  const today = todayStr();\n  const isAdmin = can('caja.cuadrar');\n  const L = buildCashLedger();")
s = rep(s, "  const isAdmin = myRole==='admin';\n  if(!isAdmin) ventasView = 'pedidos';", "  const isAdmin = can('informes.ver');\n  if(!isAdmin) ventasView = 'pedidos';")
s = rep(s, "if(ventasView!=='historial' || myRole!=='admin')", "if(ventasView!=='historial' || !can('informes.ver'))")
s = rep(s, "let myRole = 'admin'; // por defecto admin si no hay control de usuarios disponible", "let myRole = ''; // lo define el inicio de sesión")
# Las solicitudes de cambio deben llevar el id de quien las pide (regla de la base de datos)
s = rep(s, "requestedBy: myUid||null,", "requestedBy: myUid,")
# La categoría Domicilios solo la crea quien puede gestionar gastos
s = rep(s, "    if(!db) return;\n    const exists = state.categories.some(c=>c.scope==='gastos' && c.name==='Domicilios');",
           "    if(!db || !can('gastos.gestionar')) return;\n    const exists = state.categories.some(c=>c.scope==='gastos' && c.name==='Domicilios');")

# Menú: sin costo ni margen (esa información es solo del administrador, en la pestaña Análisis)
s = rep(s, """      ${cost!==null ? `<div class="row" style="margin-top:6px">
          <span class="item-meta">Costo: ${fmt(cost)}</span>
          <span class="pill ${marginPct>=40?'good':marginPct>=20?'warn':'bad'}">Margen ${marginPct}%</span>
        </div>` : ''}
""", "")

# Domicilio: $2.000 y $5.000 fijos; tarifa escrita a mano (servicio externo) solo con permiso ventas.domicilio_manual
s = rep(s, "const DELIVERY_FEE_OPTIONS = [2000, 5000, 7000];",
"""const DELIVERY_FEE_OPTIONS = [2000, 5000];
let orderDeliveryManual = false;   // tarifa escrita a mano (domicilio por servicio externo)
let orderDeliveryService = '';""")
s = rep(s, """function selectDeliveryFee(v){
  orderDeliveryFee = v;
  renderOrderMainScreen();
}""", """function selectDeliveryFee(v){
  orderDeliveryFee = v;
  orderDeliveryManual = false; orderDeliveryService = '';
  renderOrderMainScreen();
}
function selectManualDeliveryFee(){
  if(!can('ventas.domicilio_manual')) return;
  if(!orderDeliveryManual){ orderDeliveryManual = true; orderDeliveryFee = 0; orderDeliveryService = ''; }
  renderOrderMainScreen();
  setTimeout(()=>{ const el = document.getElementById('orderDeliveryManualFee'); if(el) el.focus(); }, 0);
}
function onManualDeliveryInput(){
  const el = document.getElementById('orderDeliveryManualFee');
  orderDeliveryFee = Math.round(Number(String(el ? el.value : '').replace(/[^0-9]/g,'')) || 0);
  const sv = document.getElementById('orderDeliveryService');
  orderDeliveryService = sv ? sv.value.trim().slice(0,60) : '';
  const er = document.getElementById('orderDeliveryErr'); if(er) er.textContent = '';
  updateOrderTotalPreview();
}""")
s = rep(s, """    orderDeliveryFee = o ? (o.deliveryFee||0) : 0;
  } else {
    orderCart = [];
    orderDeliveryFee = 0;
  }""", """    orderDeliveryFee = o ? (o.deliveryFee||0) : 0;
    orderDeliveryManual = !!(o && (o.deliveryService || (orderDeliveryFee>0 && !DELIVERY_FEE_OPTIONS.includes(orderDeliveryFee))));
    orderDeliveryService = (o && o.deliveryService) || '';
  } else {
    orderCart = [];
    orderDeliveryFee = 0;
    orderDeliveryManual = false; orderDeliveryService = '';
  }""")
s = rep(s, """      <div class="prod-tile${!orderDeliveryFee?' prod-tile-selected':''}" onclick="selectDeliveryFee(0)">""",
           """      <div class="prod-tile${!orderDeliveryFee && !orderDeliveryManual?' prod-tile-selected':''}" onclick="selectDeliveryFee(0)">""")
s = rep(s, """        <div class="prod-tile${orderDeliveryFee===v?' prod-tile-selected':''}" onclick="selectDeliveryFee(${v})">""",
           """        <div class="prod-tile${!orderDeliveryManual && orderDeliveryFee===v?' prod-tile-selected':''}" onclick="selectDeliveryFee(${v})">""")
s = rep(s, """      `).join('')}
    </div>
    <label>Cliente (opcional""", """      `).join('')}
      ${(can('ventas.domicilio_manual') || orderDeliveryManual) ? `
        <div class="prod-tile${orderDeliveryManual?' prod-tile-selected':''}" onclick="selectManualDeliveryFee()">
          <div style="width:48px;height:48px;border-radius:10px;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:22px">✍️</div>
          <div class="prod-tile-name">Otra tarifa<br>(externo)</div>
        </div>` : ''}
    </div>
    ${orderDeliveryManual ? `
      <div class="row" style="gap:10px;align-items:flex-end;flex-wrap:wrap">
        <div style="flex:1;min-width:140px"><label>Tarifa del domicilio ($)</label>
          <input id="orderDeliveryManualFee" type="text" inputmode="numeric" placeholder="Ej: 9000" value="${orderDeliveryFee||''}" oninput="onManualDeliveryInput()" ${can('ventas.domicilio_manual')?'':'readonly'}></div>
        <div style="flex:1;min-width:140px"><label>Servicio (opcional)</label>
          <input id="orderDeliveryService" type="text" maxlength="60" placeholder="Ej: Rappi, mensajería" value="${esc(orderDeliveryService)}" oninput="onManualDeliveryInput()" ${can('ventas.domicilio_manual')?'':'readonly'}></div>
      </div>
      <div id="orderDeliveryErr" class="item-meta" style="color:var(--bad)"></div>` : ''}
    <label>Cliente (opcional""")
s = rep(s, """  const deliveryFee = orderDeliveryFee||0;
  const total = orderCart.reduce((s,l)=>s+l.price*l.qty,0) + deliveryFee;""",
"""  const deliveryFee = orderDeliveryFee||0;
  if(orderDeliveryManual && !(deliveryFee>0)){
    const er = document.getElementById('orderDeliveryErr');
    if(er) er.textContent = 'Escribe la tarifa del domicilio externo o elige otra opción.';
    const el = document.getElementById('orderDeliveryManualFee'); if(el) el.focus();
    return;
  }
  const deliveryService = orderDeliveryManual ? (orderDeliveryService || 'Servicio externo') : '';
  const total = orderCart.reduce((s,l)=>s+l.price*l.qty,0) + deliveryFee;""")
s = rep(s, "update({ items, total, deliveryFee });", "update({ items, total, deliveryFee, deliveryService });")
s = rep(s, "proposedDeliveryFee: deliveryFee,", "proposedDeliveryFee: deliveryFee, proposedDeliveryService: deliveryService,")
s = rep(s, "items, total, deliveryFee, status:'pendiente', createdAt: Date.now()", "items, total, deliveryFee, deliveryService, status:'pendiente', createdAt: Date.now()")
s = rep(s, """  orderCart = [];
  orderDeliveryFee = 0;
  closeModal();""", """  orderCart = [];
  orderDeliveryFee = 0;
  orderDeliveryManual = false; orderDeliveryService = '';
  closeModal();""")
s = rep(s, "${o.deliveryFee? `<div class=\"item-meta\">🛵 Domicilio: ${fmt(o.deliveryFee)}</div>`:''}",
           "${o.deliveryFee? `<div class=\"item-meta\">🛵 Domicilio: ${fmt(o.deliveryFee)}${o.deliveryService?' · '+esc(o.deliveryService):''}</div>`:''}")

# Tipo de pedido (v6): Domicilio o Mesa/Barra del local. Domicilio exige celular, nombre y dirección y
# guarda/actualiza el cliente (celular = llave) con la función upsert_customer.
s = rep(s, "let orderDeliveryService = '';", """let orderDeliveryService = '';
const ORDER_SPOTS = ['Mesa 1','Mesa 2','Mesa 3','Barra 1','Barra 2','Barra 3','Barra 4'];
let orderType = '';   // 'domicilio' | 'local'
let orderSpot = '';   // Mesa 1 … Barra 4
let orderCust = { phone:'', waUser:'', name:'', address:'', id:null, auto:false };
function phoneLast10(v){ return String(v||'').replace(/\\D/g,'').slice(-10); }
function normPhoneCO(v){ let d = String(v||'').replace(/\\D/g,''); if(d.length===10) d = '57'+d; return (d.length===12 && d.startsWith('57')) ? d : ''; }
function findCustomerByPhone(v){ const k = phoneLast10(v); if(k.length<10) return null; return state.customers.find(c=>phoneLast10(c.phone)===k) || null; }
// Usuario de WhatsApp: empieza con @; letras, números, punto o guion bajo. '' = vacío, null = inválido
function normWaUser(v){ let w = String(v||'').replace(/\\s/g,'').toLowerCase(); if(!w) return ''; if(w[0]!=='@') w = '@'+w; return /^@[a-z0-9._]{3,30}$/.test(w) ? w : null; }
function normAddr(v){ return String(v||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }
// Busca el cliente por celular, luego por @usuario y luego por dirección
function findCustomerMatch(){
  const byPhone = findCustomerByPhone(orderCust.phone); if(byPhone) return byPhone;
  const w = normWaUser(orderCust.waUser);
  if(w){ const c = state.customers.find(x=>String(x.waUser||'').toLowerCase()===w); if(c) return c; }
  const a = normAddr(orderCust.address);
  if(a.length>=6){ const c = state.customers.find(x=>normAddr(x.address)===a); if(c) return c; }
  return null;
}
function orderCustInfoText(){
  const c = findCustomerMatch();
  if(c){ const n = customerStats(c.id).count; return '✔ Cliente registrado' + (n ? ' · '+n+' pedido'+(n===1?'':'s') : '') + (c.waUser ? ' · '+c.waUser : '') + '. Si cambias los datos, se actualizan.'; }
  if(orderCust.waUser && normWaUser(orderCust.waUser)===null) return 'El usuario de WhatsApp empieza con @ y usa letras, números, punto o guion bajo.';
  const has = phoneLast10(orderCust.phone).length===10 || normWaUser(orderCust.waUser) || normAddr(orderCust.address).length>=6;
  return has ? 'Cliente nuevo: quedará guardado con estos datos.' : 'Identifícalo con su usuario de WhatsApp (@…) o su dirección. El celular es opcional.';
}
function selectOrderType(t, spot){
  orderType = t; orderSpot = t==='local' ? (spot||'') : '';
  if(t!=='domicilio'){ orderDeliveryFee = 0; orderDeliveryManual = false; orderDeliveryService = ''; }
  renderOrderMainScreen();
  if(t==='domicilio') setTimeout(()=>{ const el = document.getElementById('ordCustWa'); if(el && !el.value) el.focus(); }, 0);
}
function onOrderCustInput(field){
  const ids = { phone:'ordCustPhone', waUser:'ordCustWa', name:'ordCustName', address:'ordCustAddress' };
  const el = document.getElementById(ids[field]);
  orderCust[field] = el ? el.value : '';
  if(field==='name') orderCust.auto = false;
  if(field!=='name'){
    const c = findCustomerMatch();
    if(c){
      if(orderCust.id!==c.id && (orderCust.auto || !orderCust.name)){
        const set = (k, id, v)=>{ if(k===field) return; if(orderCust[k] && !orderCust.auto) return; orderCust[k] = v||''; const x = document.getElementById(id); if(x) x.value = orderCust[k]; };
        set('name','ordCustName', c.name); set('address','ordCustAddress', c.address);
        set('waUser','ordCustWa', c.waUser); set('phone','ordCustPhone', c.phone ? phoneLast10(c.phone) : '');
        orderCust.auto = true;
      }
      orderCust.id = c.id;
    } else { orderCust.id = null; }
  }
  const info = document.getElementById('ordCustInfo'); if(info) info.textContent = orderCustInfoText();
  setOrderErr('');
}
function setOrderErr(msg, focusId){
  const er = document.getElementById('orderSaveErr'); if(er) er.textContent = msg||'';
  if(focusId){ const el = document.getElementById(focusId); if(el) el.focus(); }
}""")

s = rep(s, """    orderDeliveryService = (o && o.deliveryService) || '';
  } else {""", """    orderDeliveryService = (o && o.deliveryService) || '';
    orderType = (o && o.orderType) || ''; orderSpot = (o && o.spot) || '';
    orderCust = { phone: o && o.orderType==='domicilio' ? phoneLast10(o.customerPhone) : '', waUser: (o && o.customerWaUser) || '', name: (o && o.orderType==='domicilio' && o.customerName) || '',
                  address: (o && o.customerAddress) || '', id: (o && o.customerId) || null, auto:false };
  } else {""")
s = rep(s, """    orderDeliveryManual = false; orderDeliveryService = '';
  }""", """    orderDeliveryManual = false; orderDeliveryService = '';
    orderType = ''; orderSpot = ''; orderCust = { phone:'', waUser:'', name:'', address:'', id:null, auto:false };
  }""")

# Selector arriba del formulario
s = rep(s, """    ${backButtonHtml}
    <div class="prod-grid">${gridHtml}</div>""", """    <label style="margin-top:4px">¿Dónde es el pedido? *</label>
    <div class="ot-chips">
      <button type="button" class="ot-chip${orderType==='domicilio'?' on':''}" onclick="selectOrderType('domicilio')">🛵 Domicilio</button>
      <button type="button" class="ot-chip${orderType==='llevar'?' on':''}" onclick="selectOrderType('llevar')">🥡 Para llevar</button>
      ${ORDER_SPOTS.map(sp=>`<button type="button" class="ot-chip${orderType==='local'&&orderSpot===sp?' on':''}" onclick="selectOrderType('local','${sp}')">${sp}</button>`).join('')}
    </div>
    ${backButtonHtml}
    <div class="prod-grid">${gridHtml}</div>""")

# Datos del cliente y tarifa: solo en Domicilio (sin la opción "Sin domicilio")
s = rep(s, """    <label>Domicilio (opcional, se paga en su totalidad al domiciliario)</label>
    <div class="prod-grid" style="grid-template-columns:repeat(4,1fr)">
      <div class="prod-tile${!orderDeliveryFee && !orderDeliveryManual?' prod-tile-selected':''}" onclick="selectDeliveryFee(0)">
        <div style="width:48px;height:48px;border-radius:10px;background:var(--bg);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:20px">🚫</div>
        <div class="prod-tile-name">Sin<br>domicilio</div>
      </div>""", """    ${orderType==='domicilio' ? `
    <div class="ot-cust">
      <label style="margin-top:0">Usuario de WhatsApp</label>
      <input id="ordCustWa" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="@usuario" value="${esc(orderCust.waUser)}" oninput="onOrderCustInput('waUser')">
      <label>Celular (opcional)</label>
      <input id="ordCustPhone" type="tel" inputmode="numeric" autocomplete="off" placeholder="3001234567" value="${esc(orderCust.phone)}" oninput="onOrderCustInput('phone')">
      <div id="ordCustInfo" class="item-meta" style="margin-top:4px">${esc(orderCustInfoText())}</div>
      <label>Nombre *</label>
      <input id="ordCustName" autocomplete="off" placeholder="Nombre del cliente" value="${esc(orderCust.name)}" oninput="onOrderCustInput('name')">
      <label>Dirección *</label>
      <input id="ordCustAddress" autocomplete="off" placeholder="Calle, número, barrio e indicaciones" value="${esc(orderCust.address)}" oninput="onOrderCustInput('address')">
    </div>
    <label>Tarifa del domicilio * (se paga en su totalidad al domiciliario)</label>
    <div class="prod-grid" style="grid-template-columns:repeat(3,1fr)">""")
s = rep(s, """      <div id="orderDeliveryErr" class="item-meta" style="color:var(--bad)"></div>` : ''}
    <label>Cliente (opcional, para enviar el pedido por WhatsApp)</label>""", """      <div id="orderDeliveryErr" class="item-meta" style="color:var(--bad)"></div>` : ''}
    ` : ''}
    ${orderType!=='domicilio' ? `<label>Cliente (opcional, para enviar el pedido por WhatsApp)</label>""")
s = rep(s, """    </div>
    <label>Total</label>""", """    </div>` : ''}
    <label>Total</label>""")
s = rep(s, """    <div class="modal-actions">
      <button class="secondary" onclick="closeModal()">Cancelar</button>
      <button class="primary" onclick="saveOrder()">""", """    <div id="orderSaveErr" class="item-meta" style="color:var(--bad);font-weight:700;margin-top:8px"></div>
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal()">Cancelar</button>
      <button class="primary" onclick="saveOrder()">""")

# Guardar: validar tipo y cliente; guardar/actualizar el cliente por celular
s = rep(s, """  const deliveryService = orderDeliveryManual ? (orderDeliveryService || 'Servicio externo') : '';""",
"""  const deliveryService = orderDeliveryManual ? (orderDeliveryService || 'Servicio externo') : '';
  if(orderType!=='domicilio' && orderType!=='llevar' && !(orderType==='local' && orderSpot)){ setOrderErr('Elige si el pedido es Domicilio, Para llevar o una mesa/barra del local (arriba).'); return; }
  let dom = null, custFields = {};
  if(orderType==='domicilio'){
    const phoneRaw = String(orderCust.phone||'').replace(/\\D/g,''), phone = phoneRaw ? normPhoneCO(phoneRaw) : '';
    const waUser = normWaUser(orderCust.waUser), name = (orderCust.name||'').trim(), address = (orderCust.address||'').trim();
    if(waUser===null){ setOrderErr('El usuario de WhatsApp empieza con @ y usa letras, números, punto o guion bajo.', 'ordCustWa'); return; }
    if(phoneRaw && !phone){ setOrderErr('El celular debe tener 10 dígitos (o déjalo vacío).', 'ordCustPhone'); return; }
    if(!name){ setOrderErr('Escribe el nombre del cliente.', 'ordCustName'); return; }
    if(!address){ setOrderErr('Escribe la dirección del domicilio.', 'ordCustAddress'); return; }
    if(!(deliveryFee>0)){ setOrderErr('Elige la tarifa del domicilio.'); return; }
    let cid = null;
    try{ cid = await TOM.rpc('upsert_customer', { p_phone: phone, p_wa_user: waUser, p_name: name, p_address: address }); }
    catch(e){ setOrderErr('No se pudo guardar el cliente: ' + ((e && e.message) || e)); return; }
    dom = { phone, waUser, name, address };
    custFields = { customerId: cid, customerName: name, customerPhone: phone, customerWaUser: waUser, customerAddress: address };
  }
  const placeFields = { orderType, spot: orderType==='local' ? orderSpot : '' };""")
s = rep(s, "update({ items, total, deliveryFee, deliveryService });", "update({ items, total, subtotal, discount, discountAmount, deliveryFee, deliveryService, ...placeFields, ...custFields });")
s = rep(s, "proposedDeliveryFee: deliveryFee, proposedDeliveryService: deliveryService,",
           "proposedDeliveryFee: deliveryFee, proposedDeliveryService: deliveryService, proposedPlace: placeFields, proposedCustomer: custFields, proposedDiscount: discount,")
s = rep(s, """  } else if(custSel && custSel.value){
    const c = state.customers.find(x=>x.id===custSel.value);
    if(c){ customerId = c.id; customerName = c.name; customerPhone = c.phone||''; }
  }""", """  } else if(custSel && custSel.value){
    const c = state.customers.find(x=>x.id===custSel.value);
    if(c){ customerId = c.id; customerName = c.name; customerPhone = c.phone||''; }
  }
  if(dom){ customerId = custFields.customerId; customerName = dom.name; customerPhone = dom.phone; }""")
s = rep(s, "status:'pendiente', createdAt: Date.now(), customerId, customerName, customerPhone });",
           "status:'pendiente', createdAt: Date.now(), customerId, customerName, customerPhone, customerAddress: dom ? dom.address : '', customerWaUser: dom ? dom.waUser : '', subtotal, discount, discountAmount, ...placeFields });")
s = rep(s, """  orderDeliveryManual = false; orderDeliveryService = '';
  closeModal();""", """  orderDeliveryManual = false; orderDeliveryService = '';
  orderType = ''; orderSpot = ''; orderCust = { phone:'', waUser:'', name:'', address:'', id:null, auto:false };
  closeModal();""")

# Lista de pedidos: mesa/barra o dirección
s = rep(s, "const title = o.customerName ? o.customerName : ('Pedido #'+(o.id||'').slice(0,5));",
           "const title = o.customerName ? o.customerName : (o.spot || (o.orderType==='llevar' ? 'Para llevar' : ('Pedido #'+(o.id||'').slice(0,5))));")
s = rep(s, "      ${o.deliveryFee? `<div class=\"item-meta\">🛵 Domicilio: ${fmt(o.deliveryFee)}${o.deliveryService?' · '+esc(o.deliveryService):''}</div>`:''}",
"""      ${o.orderType==='local' && o.spot ? `<div class="item-meta" style="color:var(--fg);font-weight:700">🍽️ ${esc(o.spot)}</div>`:''}
      ${o.orderType==='llevar' ? `<div class="item-meta" style="color:var(--fg);font-weight:700">🥡 Para llevar (recoge en el local)</div>`:''}
      ${o.orderType==='domicilio' && o.customerAddress ? `<div class="item-meta" style="color:var(--fg)">📍 ${esc(o.customerAddress)}${o.customerWaUser?' · 💬 '+esc(o.customerWaUser):''}${o.customerPhone?' · 📱 '+esc(phoneLast10(o.customerPhone)):''}</div>`:''}
      ${o.deliveryFee? `<div class="item-meta">🛵 Domicilio: ${fmt(o.deliveryFee)}${o.deliveryService?' · '+esc(o.deliveryService):''}</div>`:''}""")
s = rep(s, "${o.customerName||('Pedido #'+(o.id||'').slice(0,5))}", "${o.customerName||o.spot||('Pedido #'+(o.id||'').slice(0,5))}")

# Clientes: dirección
s = rep(s, """    <label>WhatsApp (con indicativo, ej. 573001234567)</label><input id="cuPhone" value="${c?c.phone||'':''}" placeholder="573001234567">""",
"""    <label>WhatsApp (con indicativo, ej. 573001234567)</label><input id="cuPhone" value="${c?c.phone||'':''}" placeholder="573001234567">
    <label>Dirección</label><input id="cuAddress" value="${c?esc(c.address||''):''}" placeholder="Calle, número, barrio e indicaciones">""")
s = rep(s, """    notes: document.getElementById('cuNotes').value.trim(),
  };""", """    notes: document.getElementById('cuNotes').value.trim(),
    address: document.getElementById('cuAddress').value.trim(),
  };""")
s = rep(s, """      <div class="item-meta">${c.phone||'Sin WhatsApp'}${st.lastDate?(' · último pedido '+st.lastDate):''}</div>""",
"""      <div class="item-meta">${c.phone||'Sin WhatsApp'}${st.lastDate?(' · último pedido '+st.lastDate):''}</div>
      ${c.address ? `<div class="item-meta">📍 ${esc(c.address)}</div>` : ''}""")

# Excel
s = rep(s, "    id: o.id, fecha: o.date, cliente: o.customerName||'', telefono: o.customerPhone||'',",
           "    id: o.id, fecha: o.date, tipo: o.orderType==='domicilio' ? 'Domicilio' : o.orderType==='llevar' ? 'Para llevar' : (o.orderType==='local' ? 'Local' : ''), ubicacion: o.spot||'', cliente: o.customerName||'', telefono: o.customerPhone||'', direccion: o.customerAddress||'',")
s = rep(s, "return { id: c.id, nombre: c.name, telefono: c.phone||'', notas: c.notes||'',",
           "return { id: c.id, nombre: c.name, telefono: c.phone||'', direccion: c.address||'', notas: c.notes||'',")

# v8: descuentos/promociones en el pedido, @usuario de WhatsApp en clientes, pago QR con comprobante
s = rep(s, "    orderType = (o && o.orderType) || ''; orderSpot = (o && o.spot) || '';",
           "    orderType = (o && o.orderType) || ''; orderSpot = (o && o.spot) || '';\n    orderDiscount = o && o.discount && o.discount.amount>0 ? { promoId:o.discount.promoId||'', name:o.discount.name||'', kind:o.discount.kind, value:o.discount.value, reason:'' } : null;")
s = rep(s, "orderType = ''; orderSpot = ''; orderCust = { phone:'', waUser:'', name:'', address:'', id:null, auto:false };",
           "orderType = ''; orderSpot = ''; orderDiscount = null; orderCust = { phone:'', waUser:'', name:'', address:'', id:null, auto:false };", 2)
s = rep(s, """    <div id="cartWrap">${cartHtml}</div>""", """    <div id="cartWrap">${cartHtml}</div>
    ${orderCart.length && (activePromos().length || can('ventas.descuento_libre') || orderDiscount) ? `
    <label>Descuento / promoción</label>
    <div class="ot-chips">
      <button type="button" class="ot-chip${!orderDiscount?' on':''}" onclick="selectOrderDiscount(null)">Sin descuento</button>
      ${activePromos().map(p=>`<button type="button" class="ot-chip${orderDiscount&&orderDiscount.promoId===p.id?' on':''}" onclick="selectOrderDiscount('${p.id}')">🏷️ ${esc(p.name)} (−${esc(promoLabel(p))})</button>`).join('')}
      ${orderDiscount && orderDiscount.promoId && !activePromos().some(p=>p.id===orderDiscount.promoId) ? `<button type="button" class="ot-chip on">🏷️ ${esc(orderDiscount.name)}</button>` : ''}
      ${can('ventas.descuento_libre') ? `<button type="button" class="ot-chip${orderDiscount&&!orderDiscount.promoId?' on':''}" onclick="selectOrderDiscount('libre')">✍️ Descuento libre</button>` : ''}
    </div>
    ${orderDiscount && !orderDiscount.promoId ? (can('ventas.descuento_libre') ? `
      <div class="row" style="gap:10px;align-items:flex-end;flex-wrap:wrap">
        <div style="flex:1;min-width:120px"><label>Tipo</label><select id="odKind" onchange="onFreeDiscountInput()"><option value="pct" ${orderDiscount.kind==='pct'?'selected':''}>Porcentaje %</option><option value="fixed" ${orderDiscount.kind==='fixed'?'selected':''}>Valor $</option></select></div>
        <div style="flex:1;min-width:110px"><label>Valor</label><input id="odValue" type="number" inputmode="decimal" min="0" value="${orderDiscount.value||''}" oninput="onFreeDiscountInput()"></div>
        <div style="flex:2;min-width:160px"><label>Motivo</label><input id="odReason" maxlength="80" placeholder="Ej: cliente frecuente" value="${esc(orderDiscount.reason||'')}" oninput="onFreeDiscountInput()"></div>
      </div>` : `<div class="item-meta">Descuento libre aplicado por el administrador.</div>`) : ''}` : ''}""")
s = rep(s, "  if(el) el.textContent = fmt(cartTotal + (orderDeliveryFee||0));",
           "  const dsc = discountAmountFor(orderDiscount, cartTotal);\n  if(el) el.textContent = fmt(cartTotal - dsc + (orderDeliveryFee||0));\n  const br = document.getElementById('orderTotalBreak'); if(br) br.innerHTML = orderTotalBreakHtml(cartTotal, dsc);")
s = rep(s, "  const total = cartTotal + (orderDeliveryFee||0);",
           "  const total = cartTotal - discountAmountFor(orderDiscount, cartTotal) + (orderDeliveryFee||0);")
s = rep(s, """<div class="item-name" id="orderTotalPreview" style="font-size:18px">${fmt(total)}</div>""",
           """<div class="item-name" id="orderTotalPreview" style="font-size:18px">${fmt(total)}</div>
    <div id="orderTotalBreak" class="item-meta">${orderTotalBreakHtml(cartTotal, discountAmountFor(orderDiscount, cartTotal))}</div>""")
s = rep(s, "  const total = orderCart.reduce((s,l)=>s+l.price*l.qty,0) + deliveryFee;",
"""  const subtotal = orderCart.reduce((s,l)=>s+l.price*l.qty,0);
  if(orderDiscount && !orderDiscount.promoId && !(Number(orderDiscount.value)>0)){ setOrderErr('Escribe el valor del descuento o elige "Sin descuento".', 'odValue'); return; }
  if(orderDiscount && !orderDiscount.promoId && orderDiscount.kind==='pct' && Number(orderDiscount.value)>100){ setOrderErr('El porcentaje no puede pasar de 100.', 'odValue'); return; }
  const discountAmount = discountAmountFor(orderDiscount, subtotal);
  const discount = orderDiscount && discountAmount>0 ? { promoId: orderDiscount.promoId||'',
      name: orderDiscount.promoId ? orderDiscount.name : ('Descuento libre' + (orderDiscount.reason ? ': '+orderDiscount.reason : '')),
      kind: orderDiscount.kind, value: Number(orderDiscount.value), amount: discountAmount, by: myUid } : null;
  const total = subtotal - discountAmount + deliveryFee;""")
# Tarjeta del pedido: descuento y estado del pago
s = rep(s, "      ${o.deliveryFee? `<div class=\"item-meta\">🛵 Domicilio: ${fmt(o.deliveryFee)}${o.deliveryService?' · '+esc(o.deliveryService):''}</div>`:''}",
           "      ${o.deliveryFee? `<div class=\"item-meta\">🛵 Domicilio: ${fmt(o.deliveryFee)}${o.deliveryService?' · '+esc(o.deliveryService):''}</div>`:''}\n      ${o.discountAmount>0 ? `<div class=\"item-meta\">🏷️ ${esc((o.discount&&o.discount.name)||'Descuento')}: −${fmt(o.discountAmount)}</div>`:''}")
s = rep(s, """        ${o.paymentStatus==='pagado'
          ? `<span class="pill good">Pagado · ${o.paymentMethodLabel||''}</span>`
          : `<button class="secondary" style="width:auto;padding:6px 12px;font-size:12.5px" onclick="openCobroModal('${o.id}')">💰 Cobrar</button>`}""",
           """        ${paymentBadgeHtml(o)}""")
s = rep(s, """<button class="primary" onclick="confirmPayment('${o.id}','qr','QR')">✅ Confirmar pago recibido</button>""",
           """<button class="primary" onclick="openQrProofModal('${o.id}')">📎 Registrar comprobante del pago</button>""")
# Clientes: usuario de WhatsApp
s = rep(s, """    <label>Dirección</label><input id="cuAddress" value="${c?esc(c.address||''):''}" placeholder="Calle, número, barrio e indicaciones">""",
           """    <label>Usuario de WhatsApp</label><input id="cuWa" value="${c?esc(c.waUser||''):''}" placeholder="@usuario" autocapitalize="none" spellcheck="false">
    <label>Dirección</label><input id="cuAddress" value="${c?esc(c.address||''):''}" placeholder="Calle, número, barrio e indicaciones">""")
s = rep(s, """    address: document.getElementById('cuAddress').value.trim(),
  };
  if(!data.name) return;""", """    address: document.getElementById('cuAddress').value.trim(),
    waUser: normWaUser(document.getElementById('cuWa').value),
  };
  if(!data.name){ toast('Escribe el nombre del cliente.'); return; }
  if(data.waUser===null){ toast('El usuario de WhatsApp empieza con @ y usa letras, números, punto o guion bajo.'); return; }""")
s = rep(s, "      ${c.address ? `<div class=\"item-meta\">📍 ${esc(c.address)}</div>` : ''}",
           "      ${c.waUser ? `<div class=\"item-meta\">💬 ${esc(c.waUser)}</div>` : ''}\n      ${c.address ? `<div class=\"item-meta\">📍 ${esc(c.address)}</div>` : ''}")
s = rep(s, "telefono: o.customerPhone||'', direccion: o.customerAddress||'',", "telefono: o.customerPhone||'', usuario_whatsapp: o.customerWaUser||'', direccion: o.customerAddress||'', descuento: o.discountAmount||0, promocion: (o.discount&&o.discount.name)||'', estado_pago: o.paymentStatus||'',")
s = rep(s, "telefono: c.phone||'', direccion: c.address||'',", "telefono: c.phone||'', usuario_whatsapp: c.waUser||'', direccion: c.address||'',")

# Etapa de cocina en la tarjeta del pedido (v7)
s = rep(s, "      : '<span class=\"pill warn\">En cocina</span>';",
           "      : (o.kitchenStage==='horno' ? '<span class=\"pill warn\">🔥 En horno</span>' : o.kitchenStage==='preparacion' ? '<span class=\"pill warn\">🔪 En preparación</span>' : '<span class=\"pill warn\">🧾 En cola</span>');")

# Costo por unidad con decimales (los insumos se costean por gramo)
s = rep(s, "Costo unit.: ${fmt(i.currentCost||0)}", "Costo: ${fmtCost(i.currentCost||0)} por ${i.unit}")

# 2) Estilos de acceso, chip de usuario y matriz de permisos
css = (here / "auth.css").read_text(encoding="utf-8") + "\n" + (here / "brand.css").read_text(encoding="utf-8")
head_extra = """<meta name="theme-color" content="#FF3035">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" sizes="48x48" href="brand/icons/favicon-48.png">
<link rel="apple-touch-icon" href="brand/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-title" content="Tomates">
<meta name="mobile-web-app-capable" content="yes">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&display=swap">
"""
s = rep(s, "</head>", f"{head_extra}<style>\n{css}\n</style>\n</head>")
s = rep(s, "<title>Tomates App</title>", "<title>Tomates Pizzería</title>")
s = rep(s, "<h1>Tomates App</h1>", "<h1>Tomates Pizzería</h1>")

# 3) Librería Supabase + adaptador antes del script principal; acceso y ajustes después
lib = '<script src="vendor/supabase.js"></script>' if mock else \
      '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/dist/umd/supabase.js"></script>'
pre = "" if mock else lib + "\n"
if mock:
    pre += "<script>\n" + (here / "mock.js").read_text(encoding="utf-8") + "\n</script>\n"
pre += "<script>\n" + (here / "adapter.js").read_text(encoding="utf-8") + "\n</script>\n"
marker = '<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>'
if mock:
    s = rep(s, marker, pre)  # sin internet en las pruebas
else:
    s = rep(s, marker, marker + "\n" + pre)
post = "<script>\n" + (here / "analysis.js").read_text(encoding="utf-8") + "\n</script>\n"
post += "<script>\n" + (here / "kitchen.js").read_text(encoding="utf-8") + "\n</script>\n"
for extra_js in ("promos.js", "payments.js", "invoices.js"):
    post += "<script>\n" + (here / extra_js).read_text(encoding="utf-8") + "\n</script>\n"
post += "<script>\n" + (here / "auth.js").read_text(encoding="utf-8") + "\n</script>\n"
post += "<script>\n" + (here / "history.js").read_text(encoding="utf-8") + "\n</script>\n"
post += "<script>\n" + (here / "pwa.js").read_text(encoding="utf-8") + "\n</script>\n"
s = rep(s, "</body>", post + "</body>")

(out_dir / "index.html").write_text(s, encoding="utf-8")
import shutil
for extra in (here.parent / "dist-static", here.parent / "brand"):
    if extra.exists():
        dst = out_dir if extra.name == "dist-static" else out_dir / "brand"
        shutil.copytree(extra, dst, dirs_exist_ok=True)
print("ok", len(s))
