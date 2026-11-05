/* =====================================================================
   Tomates — inicio de sesión, permisos por rol y ajustes a la app
   Va DESPUÉS del script principal.
===================================================================== */
(function(){
  const TOM = window.TOM; const sb = TOM.sb;
  const ROLE_LABEL = { admin:'Administrador', supervisor:'Supervisor', cajero:'Cajero', asesor:'Asesor WhatsApp',
                       domiciliario:'Domiciliario', pendiente:'Pendiente', inactivo:'Inactivo' };
  window.ROLE_LABEL = ROLE_LABEL;
  const $ = (s)=>document.querySelector(s);
  const escH = (s)=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  /* ---------------- Pantalla de acceso ---------------- */
  const gate = document.createElement('div');
  gate.id = 'authGate';
  gate.innerHTML = `<div class="auth-card"><div id="authBody"><div class="item-meta">Cargando…</div></div></div>`;
  document.body.appendChild(gate);
  const body = ()=>$('#authBody');
  const logo = ()=> `<img src="brand/logo/tomates-logo-440.webp" width="200" height="200" alt="Tomates Pizzería" class="auth-logo">`;

  function showLogin(msg){
    gate.hidden = false;
    body().innerHTML = `${logo()}
      <h2>Hoy se come pizza.</h2>
      <p class="item-meta">Ingresa con el correo y la contraseña de tu invitación.</p>
      ${msg ? `<div class="auth-msg">${escH(msg)}</div>` : ''}
      <form id="loginForm" autocomplete="on">
        <label for="loginEmail">Correo</label>
        <input id="loginEmail" type="email" autocomplete="username" required>
        <label for="loginPass">Contraseña</label>
        <input id="loginPass" type="password" autocomplete="current-password" required>
        <button class="primary" type="submit" id="loginBtn" style="width:100%;margin-top:14px">Entrar</button>
      </form>
      <button class="ghost" type="button" id="forgotBtn" style="width:100%;margin-top:8px">Olvidé mi contraseña</button>`;
    $('#loginForm').addEventListener('submit', async (e)=>{
      e.preventDefault();
      const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = 'Entrando…';
      const { error } = await sb.auth.signInWithPassword({ email: $('#loginEmail').value.trim().toLowerCase(), password: $('#loginPass').value });
      if(error){ btn.disabled = false; btn.textContent = 'Entrar';
        showLogin(/invalid/i.test(error.message) ? 'Correo o contraseña incorrectos.' : TOM.friendly(error)); }
    });
    $('#forgotBtn').addEventListener('click', showForgot);
  }

  function showForgot(){
    body().innerHTML = `${logo()}
      <h2>Recuperar contraseña</h2>
      <p class="item-meta">Te enviaremos un enlace a tu correo para crear una contraseña nueva.</p>
      <form id="forgotForm">
        <label for="forgotEmail">Correo</label>
        <input id="forgotEmail" type="email" required>
        <button class="primary" type="submit" style="width:100%;margin-top:14px">Enviar enlace</button>
      </form>
      <button class="ghost" type="button" id="backBtn" style="width:100%;margin-top:8px">Volver</button>`;
    $('#backBtn').addEventListener('click', ()=>showLogin());
    $('#forgotForm').addEventListener('submit', async (e)=>{
      e.preventDefault();
      const email = $('#forgotEmail').value.trim().toLowerCase();
      await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      showLogin('Si el correo tiene una cuenta, te llegará un enlace en unos minutos. Revisa también la carpeta de spam.');
    });
  }

  function showSetPassword(isInvite){
    gate.hidden = false;
    body().innerHTML = `${logo()}
      <h2>${isInvite ? 'Bienvenido a Tomates' : 'Nueva contraseña'}</h2>
      <p class="item-meta">${isInvite ? 'Crea tu contraseña para entrar a la app.' : 'Escribe tu contraseña nueva.'}</p>
      <form id="passForm">
        <label for="newPass">Contraseña (mínimo 8 caracteres)</label>
        <input id="newPass" type="password" autocomplete="new-password" minlength="8" required>
        <label for="newPass2">Repite la contraseña</label>
        <input id="newPass2" type="password" autocomplete="new-password" minlength="8" required>
        <div id="passErr" class="auth-msg" hidden></div>
        <button class="primary" type="submit" id="passBtn" style="width:100%;margin-top:14px">Guardar y entrar</button>
      </form>`;
    $('#passForm').addEventListener('submit', async (e)=>{
      e.preventDefault();
      const p1 = $('#newPass').value, p2 = $('#newPass2').value, err = $('#passErr');
      if(p1 !== p2){ err.hidden = false; err.textContent = 'Las contraseñas no coinciden.'; return; }
      $('#passBtn').disabled = true;
      const { error } = await sb.auth.updateUser({ password: p1 });
      if(error){ $('#passBtn').disabled = false; err.hidden = false; err.textContent = TOM.friendly(error); return; }
      TOM.linkType = '';
      history.replaceState(null, '', location.pathname);
      enter();
    });
  }

  function showBlocked(role){
    gate.hidden = false;
    body().innerHTML = `${logo()}
      <h2>${role==='inactivo' ? 'Cuenta desactivada' : 'Cuenta en espera'}</h2>
      <p class="item-meta">${role==='inactivo'
        ? 'Tu acceso a Tomates App fue desactivado. Habla con el administrador si crees que es un error.'
        : 'Tu cuenta todavía no tiene un rol asignado. El administrador debe aprobarla.'}</p>
      <button class="secondary" type="button" id="outBtn" style="width:100%;margin-top:14px">Salir</button>`;
    $('#outBtn').addEventListener('click', logout);
  }

  async function logout(){ await sb.auth.signOut(); location.reload(); }
  window.tomatesLogout = logout;

  let entered = false;
  async function enter(){
    const { data } = await sb.auth.getSession();
    const session = data && data.session;
    if(!session){ showLogin(TOM.linkError ? 'El enlace ya no es válido o venció. Pide uno nuevo.' : ''); return; }
    TOM.user = session.user;
    if(TOM.linkType==='invite' || TOM.linkType==='recovery'){ showSetPassword(TOM.linkType==='invite'); return; }
    try{ await TOM.loadProfile(); }
    catch(e){ showLogin('No se pudo cargar tu perfil. ' + TOM.friendly(e)); return; }
    const role = TOM.profile && TOM.profile.role;
    if(!role || role==='pendiente' || role==='inactivo'){ showBlocked(role||'pendiente'); return; }
    if(entered) return; entered = true;
    gate.hidden = true;
    try{ await sb.rpc('touch_last_seen'); }catch(_){}
    renderUserChip();
    TOM._markReady();
  }

  function renderUserChip(){
    const h = document.querySelector('header');
    if(!h || document.getElementById('userChip')) return;
    const chip = document.createElement('div');
    chip.id = 'userChip';
    chip.innerHTML = `<div class="uc-name">${escH(TOM.profile.name || TOM.user.email)}</div>
      <div class="uc-role">${escH(ROLE_LABEL[TOM.profile.role]||TOM.profile.role)}</div>
      <button class="ghost uc-out" type="button" onclick="tomatesLogout()">Salir</button>`;
    h.appendChild(chip);
  }

  sb.auth.onAuthStateChange((event)=>{
    if(event==='PASSWORD_RECOVERY'){ TOM.linkType = 'recovery'; enter(); }
    else if(event==='SIGNED_IN' && !entered){ enter(); }
    else if(event==='SIGNED_OUT' && entered){ location.reload(); }
  });
  enter();

  /* ---------------- Permisos: qué pestañas ve cada rol ---------------- */
  const TAB_PERMS = {
    pedidos:['ventas.ver','domicilios.ver'], menu:['menu.gestionar','menu.ver_costos'], recetas:['menu.ver_costos'],
    inventario:['inventario.ver'], compras:['compras.gestionar'], gastos:['gastos.gestionar'], caja:['caja.ver'],
    clientes:['clientes.ver'], informes:['informes.ver'], analisis:['analisis.ver'], usuarios:['usuarios.gestionar']
  };
  const TOP_PERMS = { pedidos:'ventas.crear', menu:'menu.gestionar', recetas:'menu.gestionar', inventario:'menu.gestionar',
                      compras:'compras.gestionar', gastos:'gastos.gestionar', clientes:'clientes.editar' };
  const canTab = (t)=> (TAB_PERMS[t]||[]).some(p=>TOM.can(p));

  window.applyRoleUI = function(){
    if(!TOM.profile) return;
    document.querySelectorAll('nav.tabbar button').forEach(btn=>{ btn.style.display = canTab(btn.dataset.tab) ? '' : 'none'; });
    const active = document.querySelector('nav.tabbar button.active');
    if(!active || !canTab(active.dataset.tab)){
      const first = [...document.querySelectorAll('nav.tabbar button')].find(b=>canTab(b.dataset.tab));
      if(first) first.click();
    }
    syncTopAction();
  };
  function syncTopAction(){
    const t = fabBtn.dataset.tab; const p = TOP_PERMS[t];
    const show = p && TOM.can(p);
    document.getElementById('topAction').style.display = show ? 'flex' : 'none';
  }
  const _updateTopAction = window.updateTopAction;
  window.updateTopAction = function(tab){ _updateTopAction(tab); if(TOM.profile) syncTopAction(); };

  window.initRole = async function(){
    myUid = TOM.user.id;
    myRole = TOM.profile.role;
    applyRoleUI();
    renderAll();
  };

  // Si el administrador cambia permisos o roles, la app se ajusta sola
  async function refreshPerms(){
    try{
      const prevRole = TOM.profile && TOM.profile.role;
      await TOM.loadProfile();
      const role = TOM.profile && TOM.profile.role;
      if(!role || role==='pendiente' || role==='inactivo'){ location.reload(); return; }
      myRole = role;
      if(prevRole !== role){ const rc = document.querySelector('#userChip .uc-role'); if(rc) rc.textContent = ROLE_LABEL[role]||role; }
      applyRoleUI(); renderAll();
    }catch(e){}
  }
  TOM.whenReady.then(()=>{
    sb.channel('perm_watch')
      .on('postgres_changes', { event:'*', schema:'public', table:'role_permissions' }, refreshPerms)
      .on('postgres_changes', { event:'UPDATE', schema:'public', table:'profiles', filter:'id=eq.'+TOM.user.id }, refreshPerms)
      .subscribe();
  });

  /* ---------------- Inventario y pedidos: lo hace el servidor ---------------- */
  window.setOrderStatusInner = async function(id, status){
    if(!db) return;
    try{ await TOM.rpc('set_order_status', { p_order_id:id, p_status:status }); }
    catch(e){ toast(e.message); }
  };
  window.approveEditRequest = async function(reqId){
    try{ await TOM.rpc('approve_edit_request', { p_request_id:reqId }); }
    catch(e){ toast(e.message); }
  };
  window.rejectEditRequest = async function(reqId){
    try{ await db.collection('editRequests').doc(reqId).update({ status:'rechazada', reviewedBy: myUid }); }
    catch(e){ toast(e.message); }
  };

  window.savePurchase = function(){ return guarded('savePurchase', async ()=>{
    if(!db) return;
    const ingId = document.getElementById('puIng').value;
    const qty = Number(document.getElementById('puQty').value)||0;
    const totalCost = Number(document.getElementById('puTotal').value)||0;
    if(qty<=0){ toast('Escribe una cantidad mayor que cero.'); return; }
    const ing = ingredientById(ingId);
    const catInfo = readCategorySelection('pu');
    try{
      await TOM.rpc('register_purchase', { p_data: {
        ingredientId: ingId, ingredientName: ing?ing.name:'', unit: ing?ing.unit:'',
        qty, totalCost,
        provider: document.getElementById('puProvider').value.trim(),
        date: document.getElementById('puDate').value || todayStr(),
        paymentMethod: document.getElementById('puPayMethod').value,
        category: catInfo.categoryName, subcategory: catInfo.subcategoryName,
      }});
      closeModal();
    }catch(e){ toast(e.message); }
  }); };

  window.saveCount = function(id){ return guarded('saveCount', async ()=>{
    if(!db) return;
    const counted = Number(document.getElementById('cQty').value)||0;
    try{ await TOM.rpc('register_count', { p_ingredient_id:id, p_counted:counted }); closeModal(); }
    catch(e){ toast(e.message); }
  }); };

  window.deleteDoc = async function(col, id){
    if(!db) return;
    if(!(await askConfirm(col==='purchases' ? '¿Eliminar esta compra? Se descontará del inventario lo que había sumado.' : '¿Eliminar este registro?', 'Eliminar'))) return;
    try{
      if(col==='purchases') await TOM.rpc('delete_purchase', { p_purchase_id:id });
      else await db.collection(col).doc(id).delete();
      toast('Eliminado', 'ok');
    }catch(e){ toast(e.message || 'No se pudo eliminar. Intenta de nuevo.'); }
  };

  /* ---------------- Usuarios: invitar, cambiar rol, desactivar ---------------- */
  const ASSIGNABLE = ['supervisor','cajero','asesor','domiciliario'];
  let invitesCache = [];
  async function loadInvites(){
    if(!TOM.can('usuarios.gestionar')) return;
    const { data } = await sb.from('invitations').select('*').order('created_at', { ascending:false });
    invitesCache = data || [];
  }
  TOM.whenReady.then(()=>{
    if(!TOM.can('usuarios.gestionar')) return;
    loadInvites().then(()=>renderUsuarios());
    sb.channel('inv_watch').on('postgres_changes', { event:'*', schema:'public', table:'invitations' }, ()=>loadInvites().then(()=>renderUsuarios())).subscribe();
  });

  window.renderUsuarios = function(){
    const wrap = document.getElementById('usuariosList');
    if(!wrap) return;
    if(!TOM.can('usuarios.gestionar')){ wrap.innerHTML = ''; return; }
    const isAdmin = TOM.profile.role==='admin';
    const roleOpts = (cur)=> [...(isAdmin?['admin']:[]), ...ASSIGNABLE, 'inactivo']
      .map(r=>`<option value="${r}" ${cur===r?'selected':''}>${ROLE_LABEL[r]}</option>`).join('');
    const users = [...state.roles].sort((a,b)=> (a.role==='admin'?0:1)-(b.role==='admin'?0:1) || String(a.name).localeCompare(String(b.name)));
    const withProfile = new Set(users.map(u=>String(u.email||'').toLowerCase()));
    const pending = invitesCache.filter(i=>!i.accepted_at && !withProfile.has(i.email));
    wrap.innerHTML = `
      <button class="primary" style="width:100%;margin-bottom:12px" onclick="openInviteModal()">＋ Invitar persona</button>
      ${users.map(u=>`
        <div class="card">
          <div class="row">
            <div style="min-width:0">
              <div class="item-name">${escH(u.name||u.email)}${u.id===myUid?' (tú)':''}</div>
              <div class="item-meta">${escH(u.email||'')}</div>
            </div>
            <span class="pill ${u.role==='admin'?'accent':(u.role==='inactivo'||u.role==='pendiente'?'bad':'good')}">${escH(ROLE_LABEL[u.role]||u.role)}</span>
          </div>
          ${!u.lastSeenAt && u.id!==myUid ? `<div class="row" style="margin-top:6px;gap:8px"><span class="item-meta">Invitación enviada, aún no ha entrado.</span>
            <button class="ghost" style="width:auto" onclick="resendInvite('${escH(u.email)}')">Reenviar correo</button></div>` : ''}
          ${u.id!==myUid && (isAdmin || u.role!=='admin') ? `
          <div class="row" style="margin-top:8px;gap:8px">
            <select id="role_${u.id}" style="flex:1">${roleOpts(u.role)}</select>
            <button class="secondary" style="width:auto" onclick="changeUserRole('${u.id}')">Guardar</button>
          </div>` : (u.id===myUid ? '<div class="item-meta">Tu propio rol no se puede cambiar.</div>' : '')}
        </div>`).join('')}
      ${pending.length ? `<h3 class="section-title" style="margin-top:16px">Invitaciones pendientes</h3>` : ''}
      ${pending.map(i=>`
        <div class="card">
          <div class="row">
            <div style="min-width:0"><div class="item-name">${escH(i.name||i.email)}</div><div class="item-meta">${escH(i.email)}</div></div>
            <span class="pill">${escH(ROLE_LABEL[i.role]||i.role)}</span>
          </div>
          <div class="row" style="margin-top:8px;gap:8px">
            <button class="ghost" onclick="resendInvite('${escH(i.email)}')">Reenviar correo</button>
            <button class="ghost" onclick="cancelInvite('${escH(i.email)}')">Cancelar</button>
          </div>
        </div>`).join('')}
      ${renderPermMatrix()}`;
  };

  window.changeUserRole = async function(userId){
    const sel = document.getElementById('role_'+userId); if(!sel) return;
    const role = sel.value;
    const u = state.roles.find(r=>r.id===userId);
    const msg = role==='inactivo' ? `¿Desactivar a ${u?u.name:'esta persona'}? No podrá entrar a la app.` : `¿Cambiar el rol de ${u?u.name:'esta persona'} a ${ROLE_LABEL[role]}?`;
    if(!(await askConfirm(msg, 'Confirmar'))) { renderUsuarios(); return; }
    try{ await TOM.rpc('set_user_role', { p_user:userId, p_role:role }); toast('Rol actualizado', 'ok'); }
    catch(e){ toast(e.message); renderUsuarios(); }
  };
  window.setUserRole = (id, role)=>TOM.rpc('set_user_role', { p_user:id, p_role:role });

  window.openInviteModal = function(){
    const isAdmin = TOM.profile.role==='admin';
    modalBody.innerHTML = `
      <h3>Invitar persona</h3>
      <div class="item-meta">Le llegará un correo con un enlace para crear su contraseña.</div>
      <label for="invName">Nombre</label><input id="invName" placeholder="Nombre y apellido">
      <label for="invEmail">Correo</label><input id="invEmail" type="email" placeholder="correo@ejemplo.com">
      <label for="invPhone">Celular (opcional)</label><input id="invPhone" inputmode="tel" placeholder="300 000 0000">
      <label for="invRole">Rol</label>
      <select id="invRole">${[...(isAdmin?['admin']:[]), ...ASSIGNABLE].map(r=>`<option value="${r}" ${r==='cajero'?'selected':''}>${ROLE_LABEL[r]}</option>`).join('')}</select>
      <div class="modal-actions">
        <button class="secondary" onclick="closeModal()">Cancelar</button>
        <button class="primary" id="invBtn" onclick="sendInvite()">Enviar invitación</button>
      </div>`;
    modalBg.classList.add('open');
  };
  async function callInvite(payload){
    const { data, error } = await sb.functions.invoke('invite-user', { body: { ...payload, redirectTo: location.origin + location.pathname } });
    if(error){
      let msg = 'No se pudo enviar la invitación.';
      try{ const j = await error.context.json(); if(j && j.error) msg = j.error; }catch(_){}
      throw new Error(msg);
    }
    return data;
  }
  window.sendInvite = async function(){
    const email = document.getElementById('invEmail').value.trim().toLowerCase();
    const name = document.getElementById('invName').value.trim();
    const phone = document.getElementById('invPhone').value.trim();
    const role = document.getElementById('invRole').value;
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ toast('Escribe un correo válido.'); return; }
    const btn = document.getElementById('invBtn'); btn.disabled = true; btn.textContent = 'Enviando…';
    try{ await callInvite({ email, name, phone, role }); closeModal(); toast('Invitación enviada a '+email, 'ok'); loadInvites().then(renderUsuarios); }
    catch(e){ btn.disabled = false; btn.textContent = 'Enviar invitación'; toast(e.message); }
  };
  window.resendInvite = async function(email){
    const p = state.roles.find(r=>String(r.email).toLowerCase()===email);
    const i = invitesCache.find(x=>x.email===email) || (p && { email, name:p.name, phone:p.phone, role:p.role });
    if(!i) return;
    if(!(await askConfirm('¿Reenviar la invitación a '+email+'? El enlace anterior dejará de funcionar.', 'Reenviar'))) return;
    try{ await callInvite({ email:i.email, name:i.name, phone:i.phone, role:i.role }); toast('Correo reenviado', 'ok'); }
    catch(e){ toast(e.message); }
  };
  window.cancelInvite = async function(email){
    if(!(await askConfirm('¿Cancelar la invitación de '+email+'?', 'Cancelar invitación'))) return;
    const { error } = await sb.from('invitations').delete().eq('email', email);
    if(error) toast(TOM.friendly(error)); else { loadInvites().then(renderUsuarios); }
  };

  // Matriz de permisos editable (solo administrador)
  let permCatalog = null, rolePerms = null;
  async function loadMatrix(){
    const [a, b] = await Promise.all([ sb.from('permissions').select('*').order('sort'), sb.from('role_permissions').select('*') ]);
    permCatalog = a.data || []; rolePerms = new Set((b.data||[]).map(r=>r.role+'|'+r.permission));
  }
  TOM.whenReady.then(()=>{ if(TOM.profile.role==='admin') loadMatrix().then(()=>renderUsuarios()); });
  function renderPermMatrix(){
    if(TOM.profile.role!=='admin' || !permCatalog) return '';
    let lastModule = '';
    const rows = permCatalog.map(p=>{
      const head = p.module!==lastModule ? `<tr class="pm-mod"><td colspan="${ASSIGNABLE.length+1}">${escH(p.module)}</td></tr>` : '';
      lastModule = p.module;
      return head + `<tr><td>${escH(p.label)}</td>${ASSIGNABLE.map(r=>`<td style="text-align:center"><input type="checkbox" aria-label="${escH(ROLE_LABEL[r]+': '+p.label)}" ${rolePerms.has(r+'|'+p.key)?'checked':''} onchange="togglePerm('${r}','${p.key}',this.checked,this)"></td>`).join('')}</tr>`;
    }).join('');
    return `<h3 class="section-title" style="margin-top:16px">Permisos por rol</h3>
      <div class="item-meta" style="margin-bottom:8px">El administrador siempre tiene todos los permisos. Los cambios aplican de inmediato.</div>
      <div class="perm-wrap"><table class="perm-table"><thead><tr><th></th>${ASSIGNABLE.map(r=>`<th>${escH(ROLE_LABEL[r])}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  window.togglePerm = async function(role, perm, on, el){
    const q = on ? sb.from('role_permissions').insert({ role, permission:perm })
                 : sb.from('role_permissions').delete().eq('role', role).eq('permission', perm);
    const { error } = await q;
    if(error){ el.checked = !on; toast(TOM.friendly(error)); return; }
    if(on) rolePerms.add(role+'|'+perm); else rolePerms.delete(role+'|'+perm);
  };

  // Texto de la pestaña Usuarios
  const banner = document.querySelector('#tab-usuarios .banner');
  if(banner) banner.textContent = 'Invita a cada persona con su correo y asígnale un rol. Solo pueden entrar las personas invitadas.';

  // Estado de conexión
  TOM.whenReady.then(()=>{ const s = document.getElementById('dbStatus'); if(s) s.textContent = 'Conectado'; });
})();
