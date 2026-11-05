/* Cliente Supabase SIMULADO solo para pruebas locales (no va en la versión publicada) */
(function(){
  const PERMS = {
    supervisor: ['ventas.ver','ventas.crear','ventas.estado','ventas.cobrar','ventas.solicitar_cambio','ventas.editar','ventas.aprobar_cambios','domicilios.ver','domicilios.entregar','crm.ver','crm.responder','crm.estado','crm.plantillas','clientes.ver','clientes.editar','clientes.campanas','menu.ver_costos','inventario.ver','inventario.conteo','compras.gestionar','gastos.gestionar','caja.ver','caja.cuadrar','informes.ver','informes.exportar'],
    cajero: ['ventas.ver','ventas.crear','ventas.estado','ventas.cobrar','ventas.solicitar_cambio','domicilios.ver','domicilios.entregar','clientes.ver','clientes.editar'],
    asesor: ['ventas.ver','ventas.crear','ventas.solicitar_cambio','crm.ver','crm.responder','crm.estado','clientes.ver','clientes.editar'],
    domiciliario: ['domicilios.ver','domicilios.entregar','ventas.cobrar'],
  };
  const ALL = [...new Set(Object.values(PERMS).flat().concat(['menu.gestionar','usuarios.gestionar','registros.eliminar','config.gestionar']))];
  const today = (()=>{ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); })();
  const T = window.__MOCK_TABLES__ = {
    profiles: [
      { id:'u-admin', email:'admin@test', name:'Admin Prueba', role:'admin', last_seen_at:'2026-01-01', created_at:'1' },
      { id:'u-caja', email:'caja@test', name:'Caja Prueba', role:'cajero', last_seen_at:'2026-01-01', created_at:'2' },
      { id:'u-nuevo', email:'nuevo@test', name:'Nuevo', role:'domiciliario', last_seen_at:null, created_at:'3' },
    ],
    ingredients: [ { id:'harina', data:{ name:'Harina', unit:'g', stock:5000, currentCost:5, minStock:1000 } },
                   { id:'queso', data:{ name:'Queso', unit:'g', stock:3000, currentCost:20 } } ],
    recipes: [ { id:'r1', data:{ name:'Pizza muzza', yieldQty:1, items:[{ingredientId:'harina',qty:250},{ingredientId:'queso',qty:150}] } } ],
    products: [ { id:'p1', data:{ name:'Muzzarella', category:'Pizzas', price:32000, recipeId:'r1' } } ],
    categories: [], purchases: [], expenses: [], pending_expenses: [], counts: [], customers: [ { id:'c1', data:{ name:'Ana', phone:'3001112233', notes:'' } } ],
    edit_requests: [], cash_register: [], cash_movements: [], config: [],
    orders: [ { id:'o1', data:{ date: today, status:'pendiente', total:32000, deliveryFee:0, createdAt: Date.now()-600000, items:[{productId:'p1',name:'Muzzarella',qty:1,price:32000}], customerName:'Ana' } } ],
    ingredient_cost_history: [
      { id:'h1', ingredient_id:'harina', cost:4, previous_cost:null, source:'inicial', effective_date:'2026-09-01', note:'Costo inicial', changed_by:null, created_at:'2026-09-01T10:00:00Z' },
      { id:'h2', ingredient_id:'harina', cost:4.4, previous_cost:4, source:'compra', effective_date:'2026-10-05', note:'Molino Z', changed_by:'u-admin', created_at:'2026-10-05T10:00:00Z' },
      { id:'h3', ingredient_id:'harina', cost:5, previous_cost:4.4, source:'manual', effective_date:'2026-10-28', note:'Alza proveedor', changed_by:'u-admin', created_at:'2026-10-28T10:00:00Z' },
      { id:'h4', ingredient_id:'queso', cost:20, previous_cost:null, source:'inicial', effective_date:'2026-09-01', note:'Costo inicial', changed_by:null, created_at:'2026-09-01T10:00:00Z' } ],
    invitations: [ { email:'nuevo@test', name:'Nuevo', phone:'', role:'domiciliario', accepted_at:null, created_at:'3' } ],
    permissions: ALL.map((k,i)=>({ key:k, module:k.split('.')[0], label:k, sort:i })),
    role_permissions: Object.entries(PERMS).flatMap(([r,ps])=>ps.map(p=>({ role:r, permission:p }))),
  };
  Object.keys(T).forEach(k=>T[k].forEach((r,i)=>{ if(!r.created_at) r.created_at = String(i).padStart(4,'0'); }));
  const calls = window.__MOCK_CALLS__ = [];
  const listeners = [];
  let session = null;
  const asUser = (localStorage.getItem('mockUser')||'');
  if(asUser){ session = { user:{ id:asUser, email:(T.profiles.find(p=>p.id===asUser)||{}).email } }; }
  const authCbs = [];
  const me = ()=> session && T.profiles.find(p=>p.id===session.user.id);
  const notify = (table, eventType, row, old)=> listeners.filter(l=>l.table===table).forEach(l=>setTimeout(()=>l.cb({ eventType, new:row, old:old||row }),0));
  const clone = (x)=>JSON.parse(JSON.stringify(x));

  function query(table){
    let rows = ()=> (T[table]||[]);
    const filters = []; let op = 'select', payload = null, single = null, rng = null;
    const b = {
      select(){ return b; }, order(){ return b; },
      eq(k,v){ filters.push(r=>r[k]===v); return b; },
      in(k,vs){ filters.push(r=>vs.includes(r[k])); return b; },
      range(a,z){ rng=[a,z]; return b; },
      limit(){ return b; },
      maybeSingle(){ single='maybe'; return b; }, single(){ single='one'; return b; },
      insert(obj){ op='insert'; payload=obj; return b; },
      upsert(obj){ op='upsert'; payload=obj; return b; },
      delete(){ op='delete'; return b; },
      then(res, rej){ return Promise.resolve(run()).then(res, rej); }
    };
    function run(){
      calls.push({ table, op, payload: payload && clone(payload) });
      const list = T[table] = T[table] || [];
      if(op==='insert'){
        const r = Object.assign({ id: payload.id || ('id'+Math.random().toString(36).slice(2,9)), created_at: String(Date.now()) }, clone(payload));
        list.push(r); notify(table,'INSERT',r);
        return { data: single ? { id:r.id } : [r], error:null };
      }
      if(op==='upsert'){
        const key = table==='invitations' ? 'email' : 'id';
        const i = list.findIndex(r=>r[key]===payload[key]);
        if(i>=0){ list[i] = Object.assign(list[i], clone(payload)); notify(table,'UPDATE',list[i]); }
        else { const r = Object.assign({ created_at:String(Date.now()) }, clone(payload)); list.push(r); notify(table,'INSERT',r); }
        return { data:null, error:null };
      }
      if(op==='delete'){
        const del = list.filter(r=>filters.every(f=>f(r)));
        T[table] = list.filter(r=>!del.includes(r)); del.forEach(r=>notify(table,'DELETE',null,r));
        return { data:null, error:null };
      }
      let out = list.filter(r=>filters.every(f=>f(r))).map(clone);
      if(rng) out = out.slice(rng[0], rng[1]+1);
      if(single) return { data: out[0]||null, error:null };
      return { data: out, error:null };
    }
    return b;
  }

  const rpcs = {
    my_permissions(){ const p=me(); return p.role==='admin' ? ALL : (PERMS[p.role]||[]); },
    touch_last_seen(){ const p=me(); p.last_seen_at = new Date().toISOString(); return null; },
    merge_doc({p_table,p_id,p_patch}){ const r=T[p_table].find(x=>x.id===p_id); if(!r) throw {message:'No tienes permiso o el registro no existe', code:'42501'}; Object.assign(r.data,p_patch); notify(p_table,'UPDATE',r); return null; },
    set_order_status({p_order_id,p_status}){ const r=T.orders.find(x=>x.id===p_order_id); r.data.status=p_status; if(p_status==='listo') r.data.readyAt=Date.now(); if(p_status==='entregado') r.data.deliveredAt=Date.now(); notify('orders','UPDATE',r); return r.data; },
    approve_edit_request({p_request_id}){ const q=T.edit_requests.find(x=>x.id===p_request_id); q.data.status='aprobada'; notify('edit_requests','UPDATE',q); return null; },
    register_purchase({p_data}){ const r={ id:'pu'+Date.now(), data:Object.assign({unitCost:p_data.totalCost/p_data.qty},p_data), created_at:String(Date.now()) }; T.purchases.push(r); notify('purchases','INSERT',r);
      const i=T.ingredients.find(x=>x.id===p_data.ingredientId); i.data.stock+=p_data.qty; i.data.currentCost=p_data.totalCost/p_data.qty; notify('ingredients','UPDATE',i); return r.id; },
    register_count({p_ingredient_id,p_counted}){ const i=T.ingredients.find(x=>x.id===p_ingredient_id); const c={id:'cn'+Date.now(),data:{ingredientId:i.id,counted:p_counted,theoretical:i.data.stock,difference:p_counted-i.data.stock,date:today},created_at:String(Date.now())}; T.counts.push(c); i.data.stock=p_counted; notify('counts','INSERT',c); notify('ingredients','UPDATE',i); return c.data; },
    delete_purchase({p_purchase_id}){ const p=T.purchases.find(x=>x.id===p_purchase_id); const i=T.ingredients.find(x=>x.id===p.data.ingredientId); i.data.stock-=p.data.qty; T.purchases=T.purchases.filter(x=>x!==p); notify('purchases','DELETE',null,p); notify('ingredients','UPDATE',i); return null; },
    set_ingredient_cost({p_ingredient_id,p_cost,p_date,p_note}){ const i=T.ingredients.find(x=>x.id===p_ingredient_id); const prev=i.data.currentCost; i.data.currentCost=p_cost;
      const h={id:'h'+Date.now(),ingredient_id:i.id,cost:p_cost,previous_cost:prev,source:'manual',effective_date:p_date,note:p_note,changed_by:session.user.id,created_at:new Date().toISOString()};
      T.ingredient_cost_history.push(h); notify('ingredients','UPDATE',i); notify('ingredient_cost_history','INSERT',h); return null; },
    set_user_role({p_user,p_role}){ const p=T.profiles.find(x=>x.id===p_user); p.role=p_role; notify('profiles','UPDATE',p); return null; },
  };

  window.__TOMATES_SB_FACTORY__ = function(){
    return {
      auth: {
        async getSession(){ return { data:{ session } }; },
        onAuthStateChange(cb){ authCbs.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; },
        async signInWithPassword({email}){ const p=T.profiles.find(x=>x.email===email); if(!p) return { error:{ message:'Invalid login credentials' } };
          session={ user:{ id:p.id, email } }; localStorage.setItem('mockUser',p.id); authCbs.forEach(cb=>cb('SIGNED_IN',session)); return { data:{ session }, error:null }; },
        async signOut(){ session=null; localStorage.removeItem('mockUser'); return {}; },
        async updateUser(){ return { error:null }; },
        async resetPasswordForEmail(){ return { error:null }; },
      },
      from: query,
      async rpc(fn,args){ calls.push({ rpc:fn, args:clone(args||{}) }); try{ return { data: rpcs[fn] ? rpcs[fn](args||{}) : null, error:null }; }catch(e){ return { data:null, error:e }; } },
      channel(){ const ch = { on(_t, f, cb){ listeners.push({ table:f.table, cb }); return ch; }, subscribe(cb){ setTimeout(()=>cb&&cb('SUBSCRIBED'),0); return ch; } }; return ch; },
      removeChannel(){},
      functions: { async invoke(name, {body}){ calls.push({ fn:name, body:clone(body) }); return { data:{ ok:true }, error:null }; } },
    };
  };
})();
