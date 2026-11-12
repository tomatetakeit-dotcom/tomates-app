/* =====================================================================
   Tomates — adaptador Supabase
   Ofrece la misma interfaz que usaba la app (claude.use('db'|'user'|...))
   pero guarda todo en Supabase. Va ANTES del script principal.
===================================================================== */
(function(){
  const SUPABASE_URL = 'https://ztvhtrfzycrocpknpsrr.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_miOBDR7THWpucIkoXgapTA_-kRkZS5G';

  // Colección de la app -> tabla de Supabase
  const TABLES = {
    ingredients:'ingredients', recipes:'recipes', products:'products', purchases:'purchases',
    orders:'orders', expenses:'expenses', counts:'counts', customers:'customers',
    categories:'categories', editRequests:'edit_requests', cashRegister:'cash_register',
    pendingExpenses:'pending_expenses', cashMovements:'cash_movements', config:'config'
  };

  // Captura el tipo de enlace (invitación o recuperación) antes de que la librería limpie la URL
  const hashParams = new URLSearchParams((location.hash||'').replace(/^#/, ''));
  const searchParams = new URLSearchParams(location.search||'');
  const LINK_TYPE = hashParams.get('type') || searchParams.get('type') || '';
  const LINK_ERROR = hashParams.get('error_description') || searchParams.get('error_description') || '';

  const sb = (window.__TOMATES_SB_FACTORY__ || ((u,k,o)=>window.supabase.createClient(u,k,o)))(
    SUPABASE_URL, SUPABASE_KEY,
    { auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, flowType:'implicit' } }
  );

  const TOM = window.TOM = {
    sb, user:null, profile:null, perms:new Set(), ready:false,
    linkType: LINK_TYPE, linkError: LINK_ERROR,
    can(p){ return TOM.profile && (TOM.profile.role==='admin' || TOM.perms.has(p)); },
    async loadProfile(){
      const { data, error } = await sb.from('profiles').select('*').eq('id', TOM.user.id).maybeSingle();
      if(error) throw error;
      TOM.profile = data;
      const r = await sb.rpc('my_permissions');
      TOM.perms = new Set((r && r.data) || []);
      return data;
    },
    async rpc(fn, args){
      const { data, error } = await sb.rpc(fn, args||{});
      if(error) throw wrapErr(error);
      // Funciones que cambian un pedido: se relee para verlo al instante en este equipo
      if(args && args.p_order_id && TOM.refetchRow) TOM.refetchRow('orders', args.p_order_id);
      if(fn==='approve_edit_request' && TOM.reloadTable){ TOM.reloadTable('orders'); TOM.reloadTable('edit_requests'); }
      return data;
    }
  };
  window.can = (p)=>TOM.can(p);
  // Costos por gramo o por unidad: con decimales cuando el valor es pequeño
  window.fmtCost = (n)=>{ n = Number(n)||0; return '$' + n.toLocaleString('es-CO', { maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 }); };

  function wrapErr(error){
    const e = new Error(friendly(error));
    e.code = error.code || 'error';
    e.raw = error;
    return e;
  }
  function friendly(error){
    const m = (error && (error.message||error.msg||'')) + '';
    if(/row-level security|permission denied|Sin permiso|42501/i.test(m) || (error && error.code==='42501'))
      return m.includes('Sin permiso') || m.includes('aprobación') || m.includes('botones') ? m : 'No tienes permiso para esta acción.';
    if(/Failed to fetch|NetworkError|network/i.test(m)) return 'Sin conexión. Revisa el internet e intenta de nuevo.';
    return m || 'No se pudo completar la acción.';
  }
  TOM.friendly = friendly;

  /* ---------------- Documentos estilo Firestore ---------------- */
  function snapDoc(id, data){ return { id, exists: data!==undefined && data!==null, data: ()=> data ? JSON.parse(JSON.stringify(data)) : undefined }; }

  async function fetchAll(table){
    const out = []; const page = 1000;
    for(let from=0; ; from+=page){
      const { data, error } = await sb.from(table).select('id,data,created_at').order('created_at', { ascending:true }).range(from, from+page-1);
      if(error) throw wrapErr(error);
      out.push(...(data||[]));
      if(!data || data.length < page) break;
    }
    return out;
  }

  /* ---------- Datos en vivo ----------
     Cada tabla se carga completa y luego escucha cambios por Realtime. Si el equipo se
     duerme, pierde internet o vence la sesión, el canal se cae sin avisar: por eso se
     revisa la conexión al volver a la app, cada 30 s, y se recargan los datos. Además,
     después de cada cambio hecho desde este equipo se relee esa fila de inmediato. */
  let chanSeq = 0;
  const WATCHERS = {};          // tabla -> [{ rows, emit, mapRow, load, resub }]
  function watchTable(table, onRows, onErr, mapRow){
    const rows = new Map();
    const emit = ()=>{ try{ onRows([...rows.values()]); }catch(e){ console.error(e); } };
    let alive = true, ch = null;
    const load = async ()=>{
      try{
        const sel = table==='profiles'
          ? await sb.from('profiles').select('*').order('created_at',{ascending:true})
          : { data: await fetchAll(table), error:null };
        if(sel.error) throw wrapErr(sel.error);
        rows.clear();
        (sel.data||[]).forEach(r=>rows.set(r.id, mapRow(r)));
        if(alive) emit();
      }catch(e){ onErr && onErr(e); }
    };
    const subscribe = ()=>{
      if(ch){ try{ sb.removeChannel(ch); }catch(e){} }
      ch = sb.channel('t_'+table+'_'+(++chanSeq))
        .on('postgres_changes', { event:'*', schema:'public', table }, (p)=>{
          if(p.eventType==='DELETE'){ const id = p.old && p.old.id; if(id!=null) rows.delete(id); }
          else if(p.new && p.new.id!=null){ rows.set(p.new.id, mapRow(p.new)); }
          emit();
        })
        .subscribe((status)=>{ if(status==='SUBSCRIBED') load(); setLive(); });
      w.ch = ch;
    };
    const w = { rows, emit, mapRow, load, resub: subscribe, ch:null, get alive(){ return alive; } };
    (WATCHERS[table] = WATCHERS[table] || []).push(w);
    subscribe();
    load();
    TOM._reloaders = TOM._reloaders || [];
    TOM._reloaders.push(load);
    return ()=>{ alive=false; try{ sb.removeChannel(ch); }catch(e){} };
  }
  // Aplica una fila nueva o actualizada (o la borra si row es null) en todas las vistas
  function applyRow(table, id, row){
    (WATCHERS[table]||[]).forEach(w=>{
      if(!w.alive) return;
      if(row) w.rows.set(id, w.mapRow(row)); else w.rows.delete(id);
      w.emit();
    });
  }
  async function refetchRow(table, id){
    if(!WATCHERS[table] || id==null) return;
    try{
      const { data } = await sb.from(table).select('id,data,created_at').eq('id', id).maybeSingle();
      applyRow(table, id, data || null);
    }catch(e){}
  }
  TOM.refetchRow = refetchRow;
  TOM.reloadTable = (table)=> Promise.all((WATCHERS[table]||[]).filter(w=>w.alive).map(w=>w.load()));

  // Estado de la conexión en vivo
  let lastLive = null;
  function isLive(){
    const rt = sb.realtime;
    if(!rt || typeof rt.isConnected!=='function') return true;
    if(!rt.isConnected()) return false;
    const all = Object.values(WATCHERS).flat().filter(w=>w.alive && w.ch);
    return all.every(w=>w.ch.state==='joined');
  }
  function setLive(){
    const v = isLive();
    if(v!==lastLive){ lastLive = v; TOM.live = v; try{ window.dispatchEvent(new CustomEvent('tomates:live', { detail:v })); }catch(e){} }
  }
  let resyncing = false, lastResync = 0;
  async function resync(force){
    if(resyncing || !TOM.user) return;
    if(!force && Date.now()-lastResync < 5000) return;
    resyncing = true; lastResync = Date.now();
    try{
      const { data } = await sb.auth.getSession();          // renueva la sesión si venció
      const token = data && data.session && data.session.access_token;
      if(token && sb.realtime && sb.realtime.setAuth) sb.realtime.setAuth(token);
      if(sb.realtime && sb.realtime.isConnected && !sb.realtime.isConnected()){ sb.realtime.connect(); await new Promise(r=>setTimeout(r, 2500)); }
      Object.values(WATCHERS).flat().filter(w=>w.alive && (!w.ch || w.ch.state!=='joined')).forEach(w=>w.resub());
      // Otros canales (permisos, promociones, facturas…): volver a unirse si quedaron cerrados
      const mine = new Set(Object.values(WATCHERS).flat().map(w=>w.ch));
      (sb.getChannels ? sb.getChannels() : []).filter(c=>!mine.has(c) && !/^realtime:t_/.test(c.topic) && (c.state==='closed' || c.state==='errored'))
        .forEach(c=>{ try{ c.subscribe(); }catch(e){} });
      await Promise.all(Object.values(WATCHERS).flat().filter(w=>w.alive).map(w=>w.load()));
      try{ window.dispatchEvent(new Event('tomates:resynced')); }catch(e){}
    }catch(e){ console.warn('resync', e); }
    finally{ resyncing = false; setLive(); }
  }
  TOM.resync = resync;
  sb.auth.onAuthStateChange((ev, session)=>{
    if(session && session.access_token && (ev==='TOKEN_REFRESHED' || ev==='SIGNED_IN') && sb.realtime && sb.realtime.setAuth) sb.realtime.setAuth(session.access_token);
  });
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') resync(); });
  window.addEventListener('focus', ()=>resync());
  window.addEventListener('online', ()=>resync(true));
  window.addEventListener('pageshow', (e)=>{ if(e.persisted) resync(true); });
  setInterval(()=>{
    if(document.visibilityState!=='visible' || !TOM.user) return;
    setLive();
    if(!isLive()) resync(true);
  }, 30000);
  // Red de seguridad: los pedidos se releen cada minuto mientras la app está a la vista
  setInterval(()=>{ if(document.visibilityState==='visible' && TOM.user && WATCHERS.orders) TOM.reloadTable('orders'); }, 60000);

  function rolesCollection(){
    return {
      onSnapshot(cb, err){
        return watchTable('profiles', rows=>cb({ docs: rows.map(r=>snapDoc(r.id, r)) }), err,
          r=>({ id:r.id, role:r.role, name:r.name||r.email, email:r.email, phone:r.phone||'', lastSeenAt:r.last_seen_at||null }));
      },
      doc(id){ return {
        async update(patch){ if(patch.role) await TOM.rpc('set_user_role', { p_user:id, p_role:patch.role }); },
        async set(){ /* los perfiles los crea el servidor */ },
        async delete(){ const { error } = await sb.from('profiles').delete().eq('id', id); if(error) throw wrapErr(error); }
      }; }
    };
  }

  function collection(name){
    if(name==='roles') return rolesCollection();
    const table = TABLES[name];
    if(!table) throw new Error('Colección desconocida: '+name);
    const docRef = (id)=>({
      id,
      async get(){ const { data, error } = await sb.from(table).select('data').eq('id', id).maybeSingle(); if(error) throw wrapErr(error); return snapDoc(id, data ? data.data : undefined); },
      async set(obj){ const { error } = await sb.from(table).upsert({ id, data: obj }); if(error) throw wrapErr(error); refetchRow(table, id); },
      async update(patch){ await TOM.rpc('merge_doc', { p_table: table, p_id: id, p_patch: patch }); refetchRow(table, id); },
      async delete(){ const { error } = await sb.from(table).delete().eq('id', id); if(error) throw wrapErr(error); applyRow(table, id, null); },
      onSnapshot(cb, err){
        return watchTable(table, rows=>{ const r = rows.find(x=>x.id===id); cb(snapDoc(id, r ? r.data : undefined)); }, err, r=>({ id:r.id, data:r.data }));
      }
    });
    return {
      doc: docRef,
      async add(obj){ const { data, error } = await sb.from(table).insert({ data: obj }).select('id').single(); if(error) throw wrapErr(error); refetchRow(table, data.id); return docRef(data.id); },
      onSnapshot(cb, err){ return watchTable(table, rows=>cb({ docs: rows.map(r=>snapDoc(r.id, r.data)) }), err, r=>({ id:r.id, data:r.data })); },
      orderBy(){ return this; }
    };
  }

  const db = {
    collection,
    doc(path){ const [c, id] = path.split('/'); return collection(c).doc(id); }
  };

  const userApi = {
    async id(){ return TOM.user ? TOM.user.id : null; },
    async me(){ return { id: TOM.user && TOM.user.id, name: (TOM.profile && TOM.profile.name) || '', email: TOM.user && TOM.user.email }; },
    async profiles(ids){
      const out = {}; if(!ids || !ids.length) return out;
      const { data } = await sb.from('profiles').select('id,name,email').in('id', ids);
      (data||[]).forEach(p=>{ out[p.id] = { name: p.name || p.email || '' }; });
      return out;
    },
    isOwner(){ return TOM.profile && TOM.profile.role==='admin'; },
    canEdit(){ return TOM.profile && TOM.profile.role==='admin'; }
  };

  const downloadsApi = {
    async save({ filename, data }){
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename || 'archivo';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 4000);
      return { saved:true };
    }
  };

  // La app pide estas capacidades al arrancar; se entregan cuando hay sesión iniciada.
  let resolveReady; const readyP = new Promise(r=>resolveReady=r);
  TOM.whenReady = readyP;
  TOM._markReady = ()=>{ TOM.ready = true; resolveReady(); };
  window.claude = {
    async use(name){
      await readyP;
      if(name==='db') return db;
      if(name==='user') return userApi;
      if(name==='downloads') return downloadsApi;
      return null;
    }
  };
})();
