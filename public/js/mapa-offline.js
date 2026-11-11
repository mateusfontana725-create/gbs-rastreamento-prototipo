/* =====================================================================
 * mapa-offline.js — mapa guardado no aparelho para usar sem internet
 * (página do participante; o service worker sw.js serve os quadros guardados).
 *
 *   - Ao ter a primeira posição boa (e ao se afastar mais de 1,5 km das áreas já guardadas,
 *     ou ao receber um destino), baixa os quadros do OpenStreetMap em volta do ponto.
 *   - Respeita a política de uso do tile.openstreetmap.org: no máximo 250 quadros por área
 *     em zoom 13 ou maior (aqui: até 240), um por vez, sem repetir o que já está guardado.
 *   - Guarda no máximo AREAS_MAX áreas; uma área nova apaga os quadros da mais antiga.
 *   - "Integridade": confere quantos quadros da área estão de fato no aparelho.
 * Com servidor próprio de mapas (APP_CONFIG.mapaOffline), o app guarda PACOTES de 10 km em volta do endereço da operação
 * (zoom até 17, camadas mapa/topo/satélite), reaproveitados nas próximas operações (veja a seção "Pacotes" abaixo).
 * Sem internet, o mapa mostra o que foi guardado; o registro da trilha não depende do mapa.
 * ===================================================================== */
(function (global) {
  'use strict';

  var CACHE_AREAS = 'gbs-mapa-areas-v1';     // mesmo nome usado no sw.js
  var URL_QUADRO = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  var MAX_QUADROS_Z13 = 240;                   // política OSM: até 250 quadros (zoom ≥ 13) por área
  var RAIO_PADRAO_M = 3000;
  var ZOOM_MIN = 10, ZOOM_MAX = 16;
  var AREAS_MAX = 4;
  var NOVA_AREA_A_M = 1500;                    // afastou mais que isso de todas as áreas: guarda outra

  function quadro(lat, lng, z) {
    var n = Math.pow(2, z), r = lat * Math.PI / 180;
    var x = Math.floor((lng + 180) / 360 * n);
    var y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
    return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
  }

  // Quadros que cobrem um círculo (aproximado por quadrado) em volta do ponto, do zoom zMin ao zMax.
  function quadrosDaArea(lat, lng, raioM, zMin, zMax) {
    var dLat = raioM / 111320, dLng = raioM / (111320 * Math.cos(lat * Math.PI / 180));
    var lista = [];
    for (var z = zMin; z <= zMax; z++) {
      var a = quadro(lat + dLat, lng - dLng, z), b = quadro(lat - dLat, lng + dLng, z);
      for (var x = a.x; x <= b.x; x++) for (var y = a.y; y <= b.y; y++) lista.push({ z: z, x: x, y: y });
    }
    return lista;
  }

  // Plano de uma área: diminui o raio do zoom mais próximo até caber no limite da política.
  function planejarArea(lat, lng, raioM) {
    var raio = raioM || RAIO_PADRAO_M, lista;
    // diminui até caber (sempre cabe: com raio pequeno são poucos quadros por zoom)
    for (;;) {
      lista = quadrosDaArea(lat, lng, raio, ZOOM_MIN, ZOOM_MAX);
      var altos = lista.filter(function (q) { return q.z >= 13; }).length;
      if (altos <= MAX_QUADROS_Z13 || raio <= 100) break;
      raio = Math.max(100, Math.round(raio * 0.8));
    }
    return { raioM: raio, quadros: lista, urls: lista.map(function (q) { return URL_QUADRO.replace('{z}', q.z).replace('{x}', q.x).replace('{y}', q.y); }) };
  }

  function distanciaM(lat1, lng1, lat2, lng2) {
    var R = 6371000, r = Math.PI / 180;
    var dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Precisa de outra área? (nenhuma guardada perto deste ponto)
  function precisaArea(areas, lat, lng) {
    return !(areas || []).some(function (a) { return distanciaM(a.lat, a.lng, lat, lng) <= NOVA_AREA_A_M; });
  }

  function disponivel() {
    return Boolean(global.caches && global.fetch && global.Promise);
  }

  // Baixa os quadros que ainda não estão guardados, um por vez. aoProgresso(feitos, total).
  async function baixar(urls, aoProgresso) {
    var cache = await global.caches.open(CACHE_AREAS);
    var feitos = 0, falhas = 0;
    for (var i = 0; i < urls.length; i++) {
      if (global.navigator && global.navigator.onLine === false) { falhas += urls.length - i; break; }
      try {
        var ja = await cache.match(urls[i]);
        if (!ja) {
          var r = await global.fetch(urls[i], { mode: 'cors', credentials: 'omit' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          await cache.put(urls[i], r);
        }
        feitos++;
      } catch (e) {
        falhas++;
        if (e && e.name === 'QuotaExceededError') { falhas += urls.length - i - 1; break; }
      }
      if (aoProgresso) aoProgresso(feitos, urls.length);
    }
    return { feitos: feitos, falhas: falhas, total: urls.length };
  }

  // Quantos quadros da lista estão de fato no aparelho (conferência de integridade).
  async function contar(urls) {
    if (!disponivel()) return 0;
    var cache = await global.caches.open(CACHE_AREAS);
    var n = 0;
    for (var i = 0; i < urls.length; i++) if (await cache.match(urls[i])) n++;
    return n;
  }

  async function apagar(urls) {
    if (!disponivel()) return;
    var cache = await global.caches.open(CACHE_AREAS);
    for (var i = 0; i < urls.length; i++) await cache.delete(urls[i]);
  }

  /* ---------- Pacotes de mapa (servidor próprio de mapas) ----------
   * Um pacote é um círculo de PACOTE.raioM em volta do endereço da operação (ou da primeira posição boa do participante),
   * com as camadas configuradas (mapa, topográfico, satélite) do zoom 10 ao 17. O pacote fica no aparelho e vale para as
   * próximas operações que ele cobrir: só baixa outro quando a nova operação não está bem dentro de nenhum (margem). */
  var PACOTE = { raioM: 10000, zoomMin: 10, zoomMax: 17, margemM: 2000, max: 3, paralelo: 6 };
  var KB_QUADRO = { osm: 15, topo: 25, satelite: 35, vetor: 22 };   // média aproximada de cada quadro (só para a estimativa de tamanho)

  // Quadros que tocam o círculo (o centro do quadro a até raio + meia diagonal dele), do zoom zMin ao zMax.
  function quadrosDoCirculo(lat, lng, raioM, zMin, zMax) {
    var dLat = raioM / 111320, dLng = raioM / (111320 * Math.cos(lat * Math.PI / 180));
    var lista = [];
    for (var z = zMin; z <= zMax; z++) {
      var n = Math.pow(2, z);
      var a = quadro(lat + dLat, lng - dLng, z), b = quadro(lat - dLat, lng + dLng, z);
      for (var x = a.x; x <= b.x; x++) {
        for (var y = a.y; y <= b.y; y++) {
          var cLng = (x + 0.5) / n * 360 - 180;
          var cLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI;
          var ladoM = 40075016 * Math.cos(cLat * Math.PI / 180) / n;
          if (distanciaM(cLat, cLng, lat, lng) <= raioM + ladoM * 0.7072) lista.push({ z: z, x: x, y: y });
        }
      }
    }
    return lista;
  }

  function urlDoQuadro(modelo, q) {
    return modelo.replace('{z}', q.z).replace('{x}', q.x).replace('{y}', q.y);
  }

  // modelos: { osm: 'https://…/{z}/{x}/{y}.png', topo: …, satelite: … } (só as camadas que existem).
  // Devolve { raioM, zoomMax, camadas, quadros, total, urls, mb } (mb: estimativa de tamanho).
  function planejarPacote(lat, lng, modelos, opc) {
    opc = opc || {};
    var raio = opc.raioM || PACOTE.raioM, zMin = opc.zoomMin || PACOTE.zoomMin, zMax = opc.zoomMax || PACOTE.zoomMax;
    var camadas = Object.keys(modelos || {}).filter(function (c) { return modelos[c]; });
    var quadros = quadrosDoCirculo(lat, lng, raio, zMin, zMax), urls = [], kb = 0;
    camadas.forEach(function (c) {
      quadros.forEach(function (q) { urls.push(urlDoQuadro(modelos[c], q)); });
      kb += quadros.length * (KB_QUADRO[c] || 25);
    });
    return { raioM: raio, zoomMax: zMax, camadas: camadas, quadros: quadros.length, total: urls.length, urls: urls, mb: Math.round(kb / 1024) };
  }

  // O novo ponto está bem dentro de algum pacote guardado? (margem: o pacote não pode ter o ponto na borda)
  function cobre(pacotes, lat, lng, margemM) {
    var m = margemM == null ? PACOTE.margemM : margemM;
    return (pacotes || []).some(function (p) { return distanciaM(p.lat, p.lng, lat, lng) <= p.raioM - m; });
  }

  // Baixa os quadros que faltam, vários ao mesmo tempo. opc: { paralelo, aoProgresso(feitos, total), cancelado(), buscar(url) }.
  // buscar: quem obtém cada quadro (padrão: fetch do endereço). O mapa vetorial (js/mapa-vetor.js) lê do arquivo PMTiles.
  // Retoma de onde parou (o que já está guardado não é baixado de novo). Para com "sem rede", "cota" cheia ou cancelamento.
  async function baixarPacote(urls, opc) {
    opc = opc || {};
    var cache = await global.caches.open(CACHE_AREAS);
    var proximo = 0, feitos = 0, falhas = 0, parar = false, motivo = null;
    async function trabalhador() {
      while (!parar) {
        var k = proximo++;
        if (k >= urls.length) return;
        if (opc.cancelado && opc.cancelado()) { parar = true; motivo = 'cancelado'; return; }
        if (global.navigator && global.navigator.onLine === false) { parar = true; motivo = 'sem_rede'; return; }
        try {
          if (!(await cache.match(urls[k]))) {
            var r;
            var buscar = opc.buscar || function (u) { return global.fetch(u, { mode: 'cors', credentials: 'omit' }); };
            try { r = await buscar(urls[k]); if (!r.ok) throw new Error('HTTP ' + r.status); }
            catch (e1) { r = await buscar(urls[k]); if (!r.ok) throw new Error('HTTP ' + r.status); }   // uma nova tentativa
            await cache.put(urls[k], r);
          }
          feitos++;
        } catch (e) {
          falhas++;
          if (e && e.name === 'QuotaExceededError') { parar = true; motivo = 'cota'; return; }
        }
        if (opc.aoProgresso) opc.aoProgresso(feitos, urls.length);
      }
    }
    var ts = [];
    for (var i = 0; i < (opc.paralelo || PACOTE.paralelo); i++) ts.push(trabalhador());
    await Promise.all(ts);
    return { feitos: feitos, falhas: falhas, total: urls.length, motivo: motivo };
  }

  // Quantos quadros da lista estão de fato guardados (uma só leitura da lista do cache, rápida mesmo com milhares).
  async function contarGuardados(urls) {
    if (!disponivel()) return 0;
    var cache = await global.caches.open(CACHE_AREAS);
    var chaves = await cache.keys(), tem = {};
    chaves.forEach(function (r) { tem[r.url] = true; });
    var n = 0;
    for (var i = 0; i < urls.length; i++) if (tem[urls[i]]) n++;
    return n;
  }

  // Apaga os quadros da lista, menos os que outro pacote ainda usa (manter: objeto { url: true }).
  async function apagarExceto(urls, manter) {
    if (!disponivel()) return 0;
    var cache = await global.caches.open(CACHE_AREAS), n = 0;
    for (var i = 0; i < urls.length; i++) if (!(manter && manter[urls[i]]) && await cache.delete(urls[i])) n++;
    return n;
  }

  var API = {
    CACHE_AREAS: CACHE_AREAS, AREAS_MAX: AREAS_MAX, NOVA_AREA_A_M: NOVA_AREA_A_M, MAX_QUADROS_Z13: MAX_QUADROS_Z13, RAIO_PADRAO_M: RAIO_PADRAO_M,
    quadro: quadro, quadrosDaArea: quadrosDaArea, planejarArea: planejarArea, precisaArea: precisaArea, distanciaM: distanciaM,
    disponivel: disponivel, baixar: baixar, contar: contar, apagar: apagar,
    PACOTE: PACOTE, quadrosDoCirculo: quadrosDoCirculo, planejarPacote: planejarPacote, cobre: cobre, baixarPacote: baixarPacote,
    contarGuardados: contarGuardados, apagarExceto: apagarExceto,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.MapaOffline = API;
})(typeof window !== 'undefined' ? window : globalThis);
