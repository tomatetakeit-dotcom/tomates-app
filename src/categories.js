/* =====================================================================
   Tomates — Administrar categorías de Gastos y Compras
   Cambiar nombre, editar subcategorías, unir duplicadas y borrar.
   Todo pasa por la función manage_category de la base, que también actualiza
   los gastos/compras que usan el nombre (para que los informes cuadren).
===================================================================== */
(function(){
  const TOM = window.TOM;
  const escH = (s)=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const SCOPES = { gastos:{ perm:'gastos.gestionar', title:'Categorías de gastos', tab:'tab-gastos', list:'pendingExpensesBox', records:()=>state.expenses||[] },
                   compras:{ perm:'compras.gestionar', title:'Categorías de compras', tab:'tab-compras', list:'purchasesList', records:()=>state.purchases||[] } };
  const isLocked = (c)=> c.scope==='gastos' && c.name==='Domicilios';
  const norm = (t)=> String(t||'').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');

  Object.entries(SCOPES).forEach(([scope, cfg])=>{
    const sec = document.getElementById(cfg.tab); if(!sec) return;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'secondary'; btn.id = 'catMgr_'+scope;
    btn.style.cssText = 'width:100%;margin:0 0 12px;display:none';
    btn.textContent = '🗂️ ' + cfg.title;
    btn.onclick = ()=>openCategoryManager(scope);
    sec.insertBefore(btn, document.getElementById(cfg.list));
  });
  function paintButtons(){ Object.entries(SCOPES).forEach(([scope, cfg])=>{ const b = document.getElementById('catMgr_'+scope); if(b) b.style.display = TOM.can(cfg.perm) ? '' : 'none'; }); }

  const usage = (scope, name)=> SCOPES[scope].records().filter(r=>r.category===name).length;

  window.openCategoryManager = function(scope){
    const cfg = SCOPES[scope];
    const cats = (state.categories||[]).filter(c=>c.scope===scope).sort((a,b)=>String(a.name).localeCompare(String(b.name),'es'));
    const dupKeys = {}; cats.forEach(c=>{ const k = norm(c.name); dupKeys[k] = (dupKeys[k]||0)+1; });
    modalBody.innerHTML = `<h3>${escH(cfg.title)}</h3>
      <div class="item-meta">Toca una categoría para cambiarle el nombre, editar sus subcategorías, unirla con otra o borrarla. Al cambiar un nombre también se actualizan los registros que lo usan.</div>
      <div style="margin-top:10px">${cats.length ? cats.map(c=>{
          const n = usage(scope, c.name);
          return `<div class="card" style="cursor:pointer" onclick="openCategoryEdit('${c.id}')">
            <div class="row"><div class="item-name">${escH(c.name)}${isLocked(c)?' 🔒':''}</div>
              ${dupKeys[norm(c.name)]>1 ? '<span class="pill warn">Repetida</span>' : ''}</div>
            <div class="item-meta">${(c.subcategories||[]).length ? escH((c.subcategories||[]).join(' · ')) : 'Sin subcategorías'} · ${n} registro${n===1?'':'s'}</div>
          </div>`; }).join('') : '<div class="empty">No hay categorías.</div>'}</div>
      <div class="modal-actions"><button class="secondary" onclick="closeModal()">Cerrar</button></div>`;
    modalBg.classList.add('open');
  };

  window.openCategoryEdit = function(id){
    const c = (state.categories||[]).find(x=>x.id===id); if(!c) return;
    const scope = c.scope, locked = isLocked(c), n = usage(scope, c.name);
    const others = (state.categories||[]).filter(x=>x.scope===scope && x.id!==id).sort((a,b)=>String(a.name).localeCompare(String(b.name),'es'));
    modalBody.innerHTML = `<h3>Editar categoría</h3>
      <div class="item-meta">${n===1 ? '1 registro usa' : n+' registros usan'} esta categoría.${locked ? ' 🔒 La app la usa para los pagos a domiciliarios: solo se pueden editar sus subcategorías.' : ''}</div>
      <label for="ceName">Nombre</label>
      <input id="ceName" maxlength="60" value="${escH(c.name)}" ${locked?'disabled':''}>
      <label>Subcategorías</label>
      <div id="ceSubs">${(c.subcategories||[]).map((s,i)=>`<div class="row ce-sub" style="gap:6px;margin-bottom:6px" data-from="${escH(s)}">
          <input class="ce-sub-in" maxlength="60" value="${escH(s)}" style="flex:1" aria-label="Subcategoría ${i+1}">
          <button type="button" class="ghost" onclick="this.parentElement.remove()" aria-label="Quitar subcategoría">🗑️</button></div>`).join('')}</div>
      <button type="button" class="ghost" onclick="addCategorySubRow()">＋ Agregar subcategoría</button>
      <div id="ceErr" class="item-meta" style="color:var(--bad);font-weight:700;margin-top:6px"></div>
      <div class="modal-actions">
        <button class="secondary" onclick="openCategoryManager('${scope}')">Volver</button>
        <button class="primary" id="ceSave" onclick="saveCategoryEdit('${id}')">Guardar</button>
      </div>
      ${locked ? '' : `<div class="card" style="margin-top:14px">
        <div class="item-name">Unir con otra categoría</div>
        <div class="item-meta">Para categorías repetidas: ${n===1 ? 'el registro pasa' : 'los '+n+' registros pasan'} a la categoría elegida y esta se borra.</div>
        <div class="row" style="gap:8px;margin-top:8px">
          <select id="ceTarget" style="flex:1"><option value="">— elegir —</option>${others.map(o=>`<option value="${o.id}">${escH(o.name)}</option>`).join('')}</select>
          <button class="secondary" type="button" onclick="mergeCategory('${id}')">Unir</button>
        </div>
      </div>
      <div class="card" style="margin-top:10px">
        <div class="item-name">Borrar categoría</div>
        <div class="item-meta">${n ? `${n===1 ? 'El registro que la usa conserva' : 'Los '+n+' registros que la usan conservan'} el nombre como texto. Si es una categoría repetida, mejor únela con la otra.` : 'Ningún registro la usa.'}</div>
        <button class="secondary" type="button" style="margin-top:8px;color:var(--bad)" id="ceDel" onclick="deleteCategory('${id}')">🗑️ Borrar categoría</button>
      </div>`}`;
    modalBg.classList.add('open');
  };
  window.addCategorySubRow = function(){
    const wrap = document.getElementById('ceSubs');
    const div = document.createElement('div'); div.className = 'row ce-sub'; div.style.cssText = 'gap:6px;margin-bottom:6px'; div.dataset.from = '';
    div.innerHTML = `<input class="ce-sub-in" maxlength="60" placeholder="Nueva subcategoría" style="flex:1"><button type="button" class="ghost" onclick="this.parentElement.remove()" aria-label="Quitar subcategoría">🗑️</button>`;
    wrap.appendChild(div); div.querySelector('input').focus();
  };
  const done = async (msg)=>{ toast(msg, 'ok'); await TOM.reloadTable('categories'); await Promise.all(['expenses','purchases','pending_expenses'].map(t=>TOM.reloadTable(t))); };
  window.saveCategoryEdit = async function(id){
    const c = (state.categories||[]).find(x=>x.id===id); if(!c) return;
    const err = (m)=>{ document.getElementById('ceErr').textContent = m; };
    const name = document.getElementById('ceName').value.trim();
    if(!name) return err('Escribe el nombre de la categoría.');
    const rows = [...document.querySelectorAll('#ceSubs .ce-sub')].map(r=>({ from: r.dataset.from || '', to: r.querySelector('input').value.trim() }));
    const tos = rows.map(r=>r.to).filter(Boolean);
    if(new Set(tos.map(norm)).size !== tos.length) return err('Hay subcategorías repetidas.');
    const kept = new Set(rows.map(r=>r.from).filter(Boolean));
    const subs = rows.filter(r=>r.from ? r.from!==r.to : r.to)
      .concat((c.subcategories||[]).filter(s=>!kept.has(s)).map(s=>({ from:s, to:'' })));
    const btn = document.getElementById('ceSave'); btn.disabled = true;
    try{ await TOM.rpc('manage_category', { p_id:id, p_action:'rename', p_name:name, p_subs:subs }); }
    catch(e){ btn.disabled = false; return err(e.message || String(e)); }
    await done('Categoría guardada'); openCategoryManager(c.scope);
  };
  window.mergeCategory = async function(id){
    const c = (state.categories||[]).find(x=>x.id===id); if(!c) return;
    const target = document.getElementById('ceTarget').value;
    const t = (state.categories||[]).find(x=>x.id===target);
    if(!t) return document.getElementById('ceErr').textContent = 'Elige con cuál categoría unirla.';
    if(!confirmInline('ceTarget', `¿Unir "${c.name}" con "${t.name}"? Toca Unir otra vez para confirmar.`)) return;
    try{ await TOM.rpc('manage_category', { p_id:id, p_action:'merge', p_target:target }); }
    catch(e){ return document.getElementById('ceErr').textContent = e.message || String(e); }
    await done(`Unida con "${t.name}"`); openCategoryManager(c.scope);
  };
  window.deleteCategory = async function(id){
    const c = (state.categories||[]).find(x=>x.id===id); if(!c) return;
    if(!confirmInline('ceDel', '¿Seguro? Toca Borrar otra vez para confirmar.')) return;
    try{ await TOM.rpc('manage_category', { p_id:id, p_action:'delete' }); }
    catch(e){ return document.getElementById('ceErr').textContent = e.message || String(e); }
    await done('Categoría borrada'); openCategoryManager(c.scope);
  };
  // Confirmación en dos toques (sin ventanas del navegador)
  let armed = null;
  function confirmInline(key, msg){
    if(armed && armed.key===key && Date.now()-armed.at < 6000){ armed = null; return true; }
    armed = { key, at: Date.now() }; document.getElementById('ceErr').textContent = msg; return false;
  }

  const _renderAll = window.renderAll;
  window.renderAll = function(){ _renderAll(); paintButtons(); };
})();
