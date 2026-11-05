/* =====================================================================
   Tomates — app instalable (PWA): service worker, aviso de nueva versión
   y aviso de conexión. No guarda datos del negocio en el teléfono.
===================================================================== */
(function(){
  // Aviso de conexión
  const net = document.createElement('div');
  net.className = 'net-banner'; net.setAttribute('role','status'); net.hidden = navigator.onLine !== false;
  net.textContent = 'Estás sin conexión. Lo que hagas no se guardará hasta que vuelva el internet.';
  document.body.insertBefore(net, document.body.firstChild);
  addEventListener('offline', ()=>{ net.hidden = false; });
  addEventListener('online', ()=>{ net.hidden = true; });

  if(!('serviceWorker' in navigator) || location.protocol !== 'https:') return;

  // Aviso de nueva versión: nunca recarga sola en medio de un pedido
  const bar = document.createElement('div');
  bar.className = 'update-bar'; bar.hidden = true; bar.setAttribute('role','status');
  bar.innerHTML = '<span>Hay una nueva versión.</span><button class="primary" type="button">Actualizar</button>';
  document.body.appendChild(bar);
  let waiting = null, reloading = false;
  bar.querySelector('button').addEventListener('click', ()=>{
    const modalOpen = document.querySelector('.modal-bg.open');
    if(modalOpen && !confirmSafe()) return;
    if(waiting) waiting.postMessage('SKIP_WAITING');
  });
  function confirmSafe(){ if(typeof toast==='function') toast('Termina o cierra la ventana abierta antes de actualizar.'); return false; }
  const offer = (w)=>{ waiting = w; bar.hidden = false; };
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{ if(reloading) return; reloading = true; location.reload(); });

  addEventListener('load', async ()=>{
    try{
      const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
      if(reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', ()=>{
        const nw = reg.installing; if(!nw) return;
        nw.addEventListener('statechange', ()=>{ if(nw.state==='installed' && navigator.serviceWorker.controller) offer(nw); });
      });
      // Revisa si hay versión nueva cada vez que la app vuelve a primer plano
      document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') reg.update().catch(()=>{}); });
    }catch(e){ /* sin service worker la app sigue funcionando en línea */ }
  });
})();
