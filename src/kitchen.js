/* =====================================================================
   Tomates — pantalla de COCINA (permiso cocina.ver; mover pedidos: cocina.operar)
   Los pedidos llegan en vivo y pasan por: Nuevos → En preparación → Horno → Listo.
   Cada paso guarda su hora (prepAt, ovenAt, readyAt) para medir la cadena de producción.
===================================================================== */
(function(){
  const TOM = window.TOM;
  const escH = (s)=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const STAGES = [
    { key:'cola',        title:'Nuevos',          ic:'🧾', next:'preparacion', btn:'🔪 Empezar preparación' },
    { key:'preparacion', title:'En preparación',  ic:'🔪', next:'horno',       btn:'🔥 Pasar al horno', alt:{ to:'listo', label:'Listo sin horno' } },
    { key:'horno',       title:'En horno',        ic:'🔥', next:'listo',       btn:'✅ Listo' },
    { key:'listo',       title:'Listos',          ic:'✅' },
  ];
  // Alerta si un pedido lleva más de estos minutos en la etapa
  const LIMIT_MIN = { cola:5, preparacion:10, horno:12, listo:15 };

  window.kitchenStage = function(o){
    if(o.status==='entregado') return 'entregado';
    if(o.status==='listo') return 'listo';
    if(o.kitchenStage==='horno') return 'horno';
    if(o.kitchenStage==='preparacion') return 'preparacion';
    return 'cola';
  };
  const stageSince = (o, st)=> st==='cola' ? (o.confirmedAt||o.createdAt) : st==='preparacion' ? (o.prepAt||o.createdAt)
    : st==='horno' ? (o.ovenAt||o.prepAt||o.createdAt) : (o.readyAt||o.createdAt);
  window.orderPlaceLabel = function(o){
    if(o.orderType==='domicilio') return '🛵 Domicilio';
    if(o.orderType==='llevar') return '🥡 Para llevar';
    if(o.orderType==='local' && o.spot) return '🍽️ '+o.spot;
    return o.deliveryFee ? '🛵 Domicilio' : '';
  };
  const clock = (ms)=>{ if(!(ms>=0)) return '—'; const s = Math.floor(ms/1000); const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), x = s%60;
    return (h? h+':'+String(m).padStart(2,'0') : m)+':'+String(x).padStart(2,'0'); };
  const avg = (arr)=> arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;

  /* ---------- Pestaña ---------- */
  const main = document.querySelector('main');
  const sec = document.createElement('section');
  sec.className = 'tab'; sec.id = 'tab-cocina';
  sec.innerHTML = `
    <div class="kds-head">
      <h2 class="section-title" style="margin:0">Cocina</h2>
      <div class="kds-head-actions">
        <span class="kds-live" id="kdsClock">●</span>
        <button class="ghost" id="kdsSound" type="button">🔔 Sonido</button>
        <button class="ghost" id="kdsFull" type="button">⛶ Pantalla completa</button>
      </div>
    </div>
    <div class="kds-kpis" id="kdsKpis"></div>
    <div class="kds-board" id="kdsBoard"></div>`;
  main.appendChild(sec);

  const nav = document.querySelector('nav.tabbar');
  const btn = document.createElement('button');
  btn.dataset.tab = 'cocina'; btn.style.display = 'none';
  btn.innerHTML = '<span class="ic">👨‍🍳</span>Cocina';
  const after = nav.querySelector('button[data-tab="pedidos"]');
  nav.insertBefore(btn, after ? after.nextSibling : nav.firstChild);
  btn.addEventListener('click', ()=>{
    nav.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    btn.classList.add('active'); sec.classList.add('active');
    document.body.classList.add('kds-wide');
    updateTopAction('cocina');
    renderKitchen();
  });
  nav.addEventListener('click', (e)=>{ const b = e.target.closest('button'); if(b && b.dataset.tab!=='cocina') document.body.classList.remove('kds-wide'); });

  sec.querySelector('#kdsFull').addEventListener('click', ()=>{
    const el = document.documentElement;
    if(document.fullscreenElement) document.exitFullscreen(); else if(el.requestFullscreen) el.requestFullscreen().catch(()=>{});
  });

  /* ---------- Sonido al llegar un pedido nuevo ---------- */
  let soundOn = false, actx = null;
  try{ soundOn = localStorage.getItem('kdsSound')==='1'; }catch(_){}
  const soundBtn = sec.querySelector('#kdsSound');
  const paintSound = ()=>{ soundBtn.textContent = soundOn ? '🔔 Sonido activo' : '🔕 Activar sonido'; };
  paintSound();
  soundBtn.addEventListener('click', ()=>{
    soundOn = !soundOn; try{ localStorage.setItem('kdsSound', soundOn?'1':'0'); }catch(_){}
    paintSound(); if(soundOn) beep();
  });
  function beep(){
    try{
      actx = actx || new (window.AudioContext||window.webkitAudioContext)();
      [0, 0.22].forEach(t=>{
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.18;
        o.connect(g); g.connect(actx.destination);
        o.start(actx.currentTime + t); o.stop(actx.currentTime + t + 0.15);
      });
    }catch(_){}
  }

  /* ---------- Acciones ---------- */
  const busy = new Set();
  window.kitchenMove = async function(id, stage){
    if(busy.has(id)) return; busy.add(id);
    try{ await TOM.rpc('set_kitchen_stage', { p_order_id:id, p_stage:stage }); }
    catch(e){ toast((e && e.message) || 'No se pudo mover el pedido'); }
    finally{ busy.delete(id); }
  };

  /* ---------- Render ---------- */
  let known = null; // ids ya vistos, para resaltar los nuevos
  const fresh = new Map(); // id -> hasta cuándo resaltar
  function itemsHtml(o){
    return (o.items||[]).map(it=>`<li><b>${escH(it.qty)}×</b> ${escH(it.name)}</li>`).join('');
  }
  function cardHtml(o, st, canOp){
    const def = STAGES.find(s=>s.key===st);
    const since = stageSince(o, st);
    const who = o.customerName ? escH(o.customerName) : '';
    const place = orderPlaceLabel(o);
    const isFresh = fresh.has(o.id) && fresh.get(o.id) > Date.now();
    let actions = '';
    if(canOp && def.next){
      actions = `<button class="primary kds-go" onclick="kitchenMove('${o.id}','${def.next}')">${def.btn}</button>`;
      if(def.alt) actions += `<button class="ghost kds-alt" onclick="kitchenMove('${o.id}','${def.alt.to}')">${def.alt.label}</button>`;
    }
    if(canOp && st!=='cola') actions += `<button class="ghost kds-alt" onclick="kitchenMove('${o.id}','atras')" title="Devolver a la etapa anterior">↩︎ Atrás</button>`;
    const steps = [];
    if(o.prepAt) steps.push('espera '+clock(o.prepAt - (o.confirmedAt||o.createdAt)));
    if(o.prepAt && (o.ovenAt||o.readyAt)) steps.push('prep '+clock((o.ovenAt||o.readyAt) - o.prepAt));
    if(o.ovenAt && o.readyAt) steps.push('horno '+clock(o.readyAt - o.ovenAt));
    return `<div class="kds-card${isFresh?' kds-fresh':''}" data-id="${o.id}" data-since="${since||''}" data-limit="${LIMIT_MIN[st]}">
      <div class="kds-card-top">
        <span class="kds-num">#${escH((o.id||'').slice(0,5))}</span>
        <span class="kds-place">${escH(place)}</span>
      </div>
      ${who ? `<div class="kds-who">${who}</div>` : ''}
      ${o.editedAt && Date.now()-o.editedAt < 20*60000 ? `<div class="kds-who" style="color:var(--bad);font-weight:800">✏️ Modificado ${fmtTime(o.editedAt)}</div>` : ''}
      <ul class="kds-items">${itemsHtml(o)}</ul>
      <div class="kds-times">
        <span class="kds-timer" title="Tiempo en esta etapa">⏱ <b>${clock(Date.now()-since)}</b></span>
        <span class="item-meta">pedido ${o.createdAt? fmtTime(o.createdAt):''}${steps.length?' · '+steps.join(' · '):''}</span>
      </div>
      ${actions ? `<div class="kds-actions">${actions}</div>` : ''}
    </div>`;
  }

  const editSeen = new Map(); let editsReady = false;
  window.renderKitchen = function(){
    if(!sec.classList.contains('active')) return;
    const today = todayStr();
    const live = state.orders.filter(o=>o.status!=='entregado' && o.webStatus!=='por_confirmar' && o.date >= addDaysStr(today,-1));
    // pedidos nuevos (para sonido y resaltado)
    const ids = new Set(live.filter(o=>kitchenStage(o)==='cola').map(o=>o.id));
    if(known){ let any = false; ids.forEach(id=>{ if(!known.has(id)){ fresh.set(id, Date.now()+8000); any = true; } }); if(any && soundOn) beep(); }
    // pedidos modificados (agregaron o quitaron productos): resaltar y sonar
    let anyEdit = false;
    live.forEach(o=>{ if(!o.editedAt) return; const prev = editSeen.get(o.id); if(editsReady && prev !== o.editedAt){ fresh.set(o.id, Date.now()+8000); anyEdit = true; } editSeen.set(o.id, o.editedAt); });
    if(anyEdit && soundOn) beep();
    editsReady = true;
    known = new Set([...(known||[]), ...ids]);

    const canOp = TOM.can('cocina.operar');
    const by = { cola:[], preparacion:[], horno:[], listo:[] };
    live.forEach(o=>{ const st = kitchenStage(o); if(by[st]) by[st].push(o); });
    Object.keys(by).forEach(k=>by[k].sort((a,b)=>(stageSince(a,k)||0)-(stageSince(b,k)||0)));

    // Promedios de hoy
    const todays = state.orders.filter(o=>o.date===today);
    const wait = todays.filter(o=>o.prepAt).map(o=>o.prepAt-(o.confirmedAt||o.createdAt));
    const prep = todays.filter(o=>o.prepAt && (o.ovenAt||o.readyAt)).map(o=>(o.ovenAt||o.readyAt)-o.prepAt);
    const oven = todays.filter(o=>o.ovenAt && o.readyAt).map(o=>o.readyAt-o.ovenAt);
    const total = todays.filter(o=>o.readyAt).map(o=>o.readyAt-(o.confirmedAt||o.createdAt));
    const k = (v,l)=>`<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    const avgTxt = (a)=>{ const v = avg(a); return v==null ? '—' : clock(v); };
    document.getElementById('kdsKpis').innerHTML =
      k(by.cola.length,'🧾 Nuevos') + k(by.preparacion.length,'🔪 En preparación') + k(by.horno.length,'🔥 En horno') + k(by.listo.length,'✅ Listos sin entregar') +
      k(avgTxt(wait),'Espera promedio hoy') + k(avgTxt(prep),'Preparación promedio') + k(avgTxt(oven),'Horno promedio') + k(avgTxt(total),'Pedido → listo (promedio, '+total.length+')');

    document.getElementById('kdsBoard').innerHTML = STAGES.map(s=>`
      <div class="kds-col kds-col-${s.key}">
        <div class="kds-col-h">${s.ic} ${s.title} <span class="kds-count">${by[s.key].length}</span></div>
        ${by[s.key].length ? by[s.key].map(o=>cardHtml(o, s.key, canOp)).join('') : '<div class="kds-empty">Sin pedidos</div>'}
      </div>`).join('');
    tick();
  };
  function addDaysStr(s, n){ const [y,m,d] = s.split('-').map(Number); const t = new Date(y, m-1, d+n); return t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0'); }

  // Relojes en vivo, sin redibujar toda la pantalla
  function tick(){
    if(!sec.classList.contains('active')) return;
    const now = Date.now();
    sec.querySelectorAll('.kds-card').forEach(c=>{
      const since = Number(c.dataset.since); if(!since) return;
      const el = c.querySelector('.kds-timer b'); if(el) el.textContent = clock(now-since);
      c.classList.toggle('kds-late', (now-since) > Number(c.dataset.limit)*60000);
      if(c.classList.contains('kds-fresh') && !(fresh.get(c.dataset.id) > now)) c.classList.remove('kds-fresh');
    });
    const ck = document.getElementById('kdsClock'); if(ck) ck.textContent = '● En vivo · ' + fmtTime(now);
  }
  setInterval(tick, 1000);

  const _renderAll = window.renderAll;
  window.renderAll = function(){ _renderAll(); renderKitchen(); };
})();
