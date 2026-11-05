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
      return data;
    }
  };
  window.can = (p)=>TOM.can(p);

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

  let chanSeq = 0;
  function watchTable(table, onRows, onErr, mapRow){
    const rows = new Map();
    const emit = ()=>{ try{ onRows([...rows.values()]); }catch(e){ console.error(e); } };
    let alive = true;
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
    const ch = sb.channel('t_'+table+'_'+(++chanSeq))
      .on('postgres_changes', { event:'*', schema:'public', table }, (p)=>{
        if(p.eventType==='DELETE'){ const id = p.old && p.old.id; if(id!=null) rows.delete(id); }
        else if(p.new && p.new.id!=null){ rows.set(p.new.id, mapRow(p.new)); }
        emit();
      })
      .subscribe((status)=>{ if(status==='SUBSCRIBED') load(); });
    load();
    TOM._reloaders = TOM._reloaders || [];
    TOM._reloaders.push(load);
    return ()=>{ alive=false; try{ sb.removeChannel(ch); }catch(e){} };
  }

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
      async set(obj){ const { error } = await sb.from(table).upsert({ id, data: obj }); if(error) throw wrapErr(error); },
      async update(patch){ await TOM.rpc('merge_doc', { p_table: table, p_id: id, p_patch: patch }); },
      async delete(){ const { error } = await sb.from(table).delete().eq('id', id); if(error) throw wrapErr(error); },
      onSnapshot(cb, err){
        return watchTable(table, rows=>{ const r = rows.find(x=>x.id===id); cb(snapDoc(id, r ? r.data : undefined)); }, err, r=>({ id:r.id, data:r.data }));
      }
    });
    return {
      doc: docRef,
      async add(obj){ const { data, error } = await sb.from(table).insert({ data: obj }).select('id').single(); if(error) throw wrapErr(error); return docRef(data.id); },
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
