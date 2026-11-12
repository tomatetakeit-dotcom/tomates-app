/* Tomates Pizza — service worker
   Guarda solo la interfaz y la marca (caché versionada). Nunca guarda
   respuestas de Supabase (datos del negocio, sesiones ni pedidos). */
const VERSION = 'tomates-shell-2026-11-12-3';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './brand/logo/tomates-logo-440.webp',
  './brand/icons/tomates-192.png',
  './brand/icons/tomates-512.png',
  './brand/icons/favicon-48.png',
  './brand/icons/apple-touch-icon.png'
];
// Librerías con versión fija (no cambian): se pueden guardar
const PINNED_LIBS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('tomates-shell-') && k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Página: primero la red (siempre la versión publicada); sin red, la última guardada
  // (el menú público menu.html no se guarda: siempre va a la red)
  const isApp = /\/(index\.html)?$/.test(url.pathname);
  if (req.mode === 'navigate' && url.origin === self.location.origin && !isApp) return;
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(VERSION);
        c.put('./index.html', fresh.clone());
        return fresh;
      } catch (e) {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Marca e iconos propios: de la caché, y si no están, de la red
  if (url.origin === self.location.origin) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    return;
  }

  // Librerías con versión fija
  if (PINNED_LIBS.some((p) => req.url.startsWith(p))) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      const c = await caches.open(VERSION);
      c.put(req, res.clone());
      return res;
    })());
  }
  // Todo lo demás (Supabase, etc.) pasa directo a la red, sin guardarse.
});
