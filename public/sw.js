/* Service worker da página do participante:
 *   - notificações de mensagens no Android (o Chrome exige um service worker) e, ao tocar, volta para a página;
 *   - página guardada para abrir sem internet: arquivos do próprio site com "rede primeiro" (online sempre vem
 *     a versão nova; sem rede, a última guardada) e bibliotecas fixadas (versão no endereço) do CDN;
 *   - mapa: quadros do OpenStreetMap guardados (área baixada por js/mapa-offline.js e os já vistos).
 * NÃO guarda chamadas ao servidor (Supabase, /api/*), nem dados pessoais. Não rastreia em segundo plano. */
var CACHE_APP = 'gbs-app-v1';
var CACHE_AREAS = 'gbs-mapa-areas-v1';        // áreas baixadas de propósito (js/mapa-offline.js)
var CACHE_VISTOS = 'gbs-mapa-vistos-v1';      // quadros vistos navegando no mapa
var MAX_VISTOS = 800;
var CDN = ['https://cdn.jsdelivr.net/npm/', 'https://unpkg.com/'];
var QUADROS = 'https://tile.openstreetmap.org/';

// A página do participante inteira, para abrir sem internet já na primeira vez (cada arquivo à parte: um que falhe não
// impede os outros). Online, a rede continua tendo prioridade (redePrimeiro).
var PAGINA = ['civil.html', 'css/estilos.css', '/api/config', 'js/comunicacao.js', 'js/interface.js', 'js/fotos.js', 'js/gps.js',
  'js/trilha-local.js', 'js/fila-estado.js', 'js/rotas.js', 'js/coords.js', 'js/mapa-offline.js', 'js/civil.js'];
var BIBLIOTECAS = ['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'];
self.addEventListener('install', function (ev) {
  ev.waitUntil(caches.open(CACHE_APP).then(function (c) {
    return Promise.all(PAGINA.map(function (u) { return c.add(u).catch(function () {}); })
      .concat(BIBLIOTECAS.map(function (u) { return c.add(new Request(u, { mode: 'cors', credentials: 'omit' })).catch(function () {}); })));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (ev) {
  ev.waitUntil(caches.keys().then(function (nomes) {
    // apaga só versões antigas destes caches
    return Promise.all(nomes.filter(function (n) { return /^gbs-/.test(n) && [CACHE_APP, CACHE_AREAS, CACHE_VISTOS].indexOf(n) === -1; })
      .map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

var gravacoes = 0;
function aparar() {
  return caches.open(CACHE_VISTOS).then(function (c) {
    return c.keys().then(function (ks) {
      var sobra = ks.length - MAX_VISTOS;
      return sobra > 0 ? Promise.all(ks.slice(0, sobra).map(function (k) { return c.delete(k); })) : null;
    });
  });
}

// Quadro do mapa: o guardado primeiro; senão a rede, e guarda o que veio (resposta CORS, não opaca).
function quadroDoMapa(req) {
  return caches.match(req.url).then(function (guardado) {
    if (guardado) return guardado;
    return fetch(req).then(function (r) {
      if (r.ok && r.type !== 'opaque') {
        var copia = r.clone();
        caches.open(CACHE_VISTOS).then(function (c) { return c.put(req.url, copia); }).then(function () { if (++gravacoes % 50 === 0) return aparar(); }).catch(function () { /* sem espaço: segue */ });
      }
      return r;
    });
  });
}

// Arquivos do site: rede primeiro; sem rede, o último guardado (a página abre sem internet).
function redePrimeiro(req) {
  return fetch(req).then(function (r) {
    if (r.ok && (r.type === 'basic' || r.type === 'cors')) {
      var copia = r.clone();
      caches.open(CACHE_APP).then(function (c) { return c.put(req, copia); }).catch(function () { /* sem espaço */ });
    }
    return r;
  }).catch(function (e) {
    return caches.match(req, { ignoreSearch: true }).then(function (g) {
      if (g) return g;
      throw e;
    });
  });
}

// Bibliotecas do CDN com versão fixa no endereço: o guardado primeiro.
function guardadoPrimeiro(req) {
  return caches.match(req).then(function (g) {
    if (g) return g;
    return fetch(req).then(function (r) {
      if (r.ok && r.type !== 'opaque') { var copia = r.clone(); caches.open(CACHE_APP).then(function (c) { return c.put(req, copia); }).catch(function () {}); }
      return r;
    });
  });
}

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;
  var url = req.url;
  if (url.indexOf(QUADROS) === 0) { ev.respondWith(quadroDoMapa(req)); return; }
  if (CDN.some(function (p) { return url.indexOf(p) === 0; })) { ev.respondWith(guardadoPrimeiro(req)); return; }
  var u = new URL(url);
  if (u.origin !== self.location.origin) return;                                   // Supabase e outros: direto, sem guardar
  if (u.pathname.indexOf('/api/') === 0 && u.pathname !== '/api/config') return;   // servidor: nunca guardado
  if (/versao\.json$/.test(u.pathname)) return;                                    // checagem de versão: sempre da rede
  ev.respondWith(redePrimeiro(req));
});

self.addEventListener('notificationclick', function (ev) {
  ev.notification.close();
  ev.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (lista) {
      for (var i = 0; i < lista.length; i++) {
        if (lista[i].url.indexOf('/civil.html') !== -1 && 'focus' in lista[i]) return lista[i].focus();
      }
      return self.clients.openWindow ? self.clients.openWindow('civil.html') : null;
    })
  );
});
