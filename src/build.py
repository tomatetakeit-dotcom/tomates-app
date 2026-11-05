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
let orderCust = { phone:'', name:'', address:'', id:null, auto:false };
function phoneLast10(v){ return String(v||'').replace(/\\D/g,'').slice(-10); }
function normPhoneCO(v){ let d = String(v||'').replace(/\\D/g,''); if(d.length===10) d = '57'+d; return (d.length===12 && d.startsWith('57')) ? d : ''; }
function findCustomerByPhone(v){ const k = phoneLast10(v); if(k.length<10) return null; return state.customers.find(c=>phoneLast10(c.phone)===k) || null; }
function orderCustInfoText(){
  const k = phoneLast10(orderCust.phone);
  if(k.length<10) return 'Escribe los 10 dígitos del celular.';
  const c = findCustomerByPhone(k);
  if(c){ const n = customerStats(c.id).count; return '✔ Cliente registrado' + (n ? ' · '+n+' pedido'+(n===1?'':'s') : '') + '. Si cambias el nombre o la dirección, se actualizan.'; }
  return 'Cliente nuevo: quedará guardado con este celular.';
}
function selectOrderType(t, spot){
  orderType = t; orderSpot = t==='local' ? (spot||'') : '';
  if(t!=='domicilio'){ orderDeliveryFee = 0; orderDeliveryManual = false; orderDeliveryService = ''; }
  renderOrderMainScreen();
  if(t==='domicilio') setTimeout(()=>{ const el = document.getElementById('ordCustPhone'); if(el && !el.value) el.focus(); }, 0);
}
function onOrderCustInput(field){
  const ids = { phone:'ordCustPhone', name:'ordCustName', address:'ordCustAddress' };
  const el = document.getElementById(ids[field]);
  orderCust[field] = el ? el.value : '';
  if(field!=='phone') orderCust.auto = false;
  if(field==='phone'){
    const c = findCustomerByPhone(orderCust.phone);
    if(c){
      if(orderCust.id!==c.id && (orderCust.auto || (!orderCust.name && !orderCust.address))){
        orderCust.name = c.name||''; orderCust.address = c.address||''; orderCust.auto = true;
        const n = document.getElementById('ordCustName'); if(n) n.value = orderCust.name;
        const a = document.getElementById('ordCustAddress'); if(a) a.value = orderCust.address;
      }
      orderCust.id = c.id;
    } else { orderCust.id = null; }
    const info = document.getElementById('ordCustInfo'); if(info) info.textContent = orderCustInfoText();
  }
  setOrderErr('');
}
function setOrderErr(msg, focusId){
  const er = document.getElementById('orderSaveErr'); if(er) er.textContent = msg||'';
  if(focusId){ const el = document.getElementById(focusId); if(el) el.focus(); }
}""")

s = rep(s, """    orderDeliveryService = (o && o.deliveryService) || '';
  } else {""", """    orderDeliveryService = (o && o.deliveryService) || '';
    orderType = (o && o.orderType) || ''; orderSpot = (o && o.spot) || '';
    orderCust = { phone: o && o.orderType==='domicilio' ? phoneLast10(o.customerPhone) : '', name: (o && o.orderType==='domicilio' && o.customerName) || '',
                  address: (o && o.customerAddress) || '', id: (o && o.customerId) || null, auto:false };
  } else {""")
s = rep(s, """    orderDeliveryManual = false; orderDeliveryService = '';
  }""", """    orderDeliveryManual = false; orderDeliveryService = '';
    orderType = ''; orderSpot = ''; orderCust = { phone:'', name:'', address:'', id:null, auto:false };
  }""")

# Selector arriba del formulario
s = rep(s, """    ${backButtonHtml}
    <div class="prod-grid">${gridHtml}</div>""", """    <label style="margin-top:4px">¿Dónde es el pedido? *</label>
    <div class="ot-chips">
      <button type="button" class="ot-chip${orderType==='domicilio'?' on':''}" onclick="selectOrderType('domicilio')">🛵 Domicilio</button>
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
      <label style="margin-top:0">Celular del cliente *</label>
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
  if(orderType!=='domicilio' && !(orderType==='local' && orderSpot)){ setOrderErr('Elige si el pedido es Domicilio o una mesa/barra del local (arriba).'); return; }
  let dom = null, custFields = {};
  if(orderType==='domicilio'){
    const phone = normPhoneCO(orderCust.phone), name = (orderCust.name||'').trim(), address = (orderCust.address||'').trim();
    if(!phone){ setOrderErr('Escribe el celular del cliente (10 dígitos).', 'ordCustPhone'); return; }
    if(!name){ setOrderErr('Escribe el nombre del cliente.', 'ordCustName'); return; }
    if(!address){ setOrderErr('Escribe la dirección del domicilio.', 'ordCustAddress'); return; }
    if(!(deliveryFee>0)){ setOrderErr('Elige la tarifa del domicilio.'); return; }
    let cid = null;
    try{ cid = await TOM.rpc('upsert_customer', { p_phone: phone, p_name: name, p_address: address }); }
    catch(e){ setOrderErr('No se pudo guardar el cliente: ' + ((e && e.message) || e)); return; }
    dom = { phone, name, address };
    custFields = { customerId: cid, customerName: name, customerPhone: phone, customerAddress: address };
  }
  const placeFields = { orderType, spot: orderType==='local' ? orderSpot : '' };""")
s = rep(s, "update({ items, total, deliveryFee, deliveryService });", "update({ items, total, deliveryFee, deliveryService, ...placeFields, ...custFields });")
s = rep(s, "proposedDeliveryFee: deliveryFee, proposedDeliveryService: deliveryService,",
           "proposedDeliveryFee: deliveryFee, proposedDeliveryService: deliveryService, proposedPlace: placeFields, proposedCustomer: custFields,")
s = rep(s, """  } else if(custSel && custSel.value){
    const c = state.customers.find(x=>x.id===custSel.value);
    if(c){ customerId = c.id; customerName = c.name; customerPhone = c.phone||''; }
  }""", """  } else if(custSel && custSel.value){
    const c = state.customers.find(x=>x.id===custSel.value);
    if(c){ customerId = c.id; customerName = c.name; customerPhone = c.phone||''; }
  }
  if(dom){ customerId = custFields.customerId; customerName = dom.name; customerPhone = dom.phone; }""")
s = rep(s, "status:'pendiente', createdAt: Date.now(), customerId, customerName, customerPhone });",
           "status:'pendiente', createdAt: Date.now(), customerId, customerName, customerPhone, customerAddress: dom ? dom.address : '', ...placeFields });")
s = rep(s, """  orderDeliveryManual = false; orderDeliveryService = '';
  closeModal();""", """  orderDeliveryManual = false; orderDeliveryService = '';
  orderType = ''; orderSpot = ''; orderCust = { phone:'', name:'', address:'', id:null, auto:false };
  closeModal();""")

# Lista de pedidos: mesa/barra o dirección
s = rep(s, "const title = o.customerName ? o.customerName : ('Pedido #'+(o.id||'').slice(0,5));",
           "const title = o.customerName ? o.customerName : (o.spot || ('Pedido #'+(o.id||'').slice(0,5)));")
s = rep(s, "      ${o.deliveryFee? `<div class=\"item-meta\">🛵 Domicilio: ${fmt(o.deliveryFee)}${o.deliveryService?' · '+esc(o.deliveryService):''}</div>`:''}",
"""      ${o.orderType==='local' && o.spot ? `<div class="item-meta" style="color:var(--fg);font-weight:700">🍽️ ${esc(o.spot)}</div>`:''}
      ${o.orderType==='domicilio' && o.customerAddress ? `<div class="item-meta" style="color:var(--fg)">📍 ${esc(o.customerAddress)}${o.customerPhone?' · 📱 '+esc(phoneLast10(o.customerPhone)):''}</div>`:''}
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
           "    id: o.id, fecha: o.date, tipo: o.orderType==='domicilio' ? 'Domicilio' : (o.orderType==='local' ? 'Local' : ''), ubicacion: o.spot||'', cliente: o.customerName||'', telefono: o.customerPhone||'', direccion: o.customerAddress||'',")
s = rep(s, "return { id: c.id, nombre: c.name, telefono: c.phone||'', notas: c.notes||'',",
           "return { id: c.id, nombre: c.name, telefono: c.phone||'', direccion: c.address||'', notas: c.notes||'',")

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
