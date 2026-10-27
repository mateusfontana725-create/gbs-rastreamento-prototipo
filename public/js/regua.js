/* =====================================================================
 * Régua circular: um anel fixo no centro da tela com as distâncias reais
 * (em metros ou km) recalculadas a cada zoom. Só visual: não grava nada.
 * Escala de Web Mercator (tiles de 256 px): m/px = 156543,03 · cos(lat) / 2^zoom.
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var ANEL_MIN_PX = 60, ANEL_MAX_PX = 140;   // o anel externo fica entre estes tamanhos na tela
  var PASSOS_M = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000, 200000];

  var est = { mapa: null, div: null, aoMover: null };

  function metrosPorPixel(mapa) {
    var c = mapa.getCenter();
    return 156543.03392 * Math.cos(c.lat * Math.PI / 180) / Math.pow(2, mapa.getZoom());
  }

  // Passo "redondo" cujo anel externo cabe na faixa de tamanho na tela.
  function passoAdequado(mpp) {
    var escolhido = PASSOS_M[0];
    PASSOS_M.forEach(function (m) { if (m / mpp >= ANEL_MIN_PX && m / mpp <= ANEL_MAX_PX) escolhido = m; });
    if (escolhido / mpp > ANEL_MAX_PX) escolhido = PASSOS_M.filter(function (m) { return m / mpp <= ANEL_MAX_PX; }).pop() || PASSOS_M[0];
    return escolhido;
  }

  function rotulo(m) {
    if (m >= 1000) return (m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' km';
    return m + ' m';
  }

  function desenhar() {
    if (!est.div || !est.mapa) return;
    var mpp = metrosPorPixel(est.mapa);
    var u = passoAdequado(mpp);
    var raioExt = u / mpp, raioMeio = raioExt / 2;
    var tam = Math.ceil(raioExt * 2 + 40);
    var svg = est.div.querySelector('svg');
    svg.setAttribute('width', tam); svg.setAttribute('height', tam);
    svg.setAttribute('viewBox', '0 0 ' + tam + ' ' + tam);
    var c = tam / 2;
    svg.innerHTML =
      '<circle cx="' + c + '" cy="' + c + '" r="' + raioExt + '" class="regua-anel regua-anel-ext"/>' +
      '<circle cx="' + c + '" cy="' + c + '" r="' + raioMeio + '" class="regua-anel"/>' +
      '<line x1="' + (c - 8) + '" y1="' + c + '" x2="' + (c + 8) + '" y2="' + c + '" class="regua-cruz"/>' +
      '<line x1="' + c + '" y1="' + (c - 8) + '" x2="' + c + '" y2="' + (c + 8) + '" class="regua-cruz"/>' +
      '<text x="' + c + '" y="' + (c - raioExt - 4) + '" text-anchor="middle" class="regua-rot">' + rotulo(u) + '</text>' +
      '<text x="' + c + '" y="' + (c - raioMeio - 4) + '" text-anchor="middle" class="regua-rot regua-rot-meio">' + rotulo(u / 2) + '</text>';
    est.div.style.width = tam + 'px';
    est.div.style.height = tam + 'px';
  }

  function ligar(mapa) {
    if (est.mapa) return;
    est.mapa = mapa;
    var div = document.createElement('div');
    div.className = 'regua-circular';
    div.setAttribute('aria-hidden', 'true');
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    mapa.getContainer().appendChild(div);
    est.div = div;
    est.aoMover = desenhar;
    mapa.on('zoomend moveend resize', est.aoMover);
    desenhar();
  }

  function desligar() {
    if (!est.mapa) return;
    est.mapa.off('zoomend moveend resize', est.aoMover);
    if (est.div && est.div.parentNode) est.div.parentNode.removeChild(est.div);
    est.mapa = est.div = est.aoMover = null;
  }

  // Devolve true se ficou ligada.
  function alternar(mapa) {
    if (est.mapa) { desligar(); return false; }
    ligar(mapa);
    return true;
  }

  raiz.Regua = { alternar: alternar, ligada: function () { return Boolean(est.mapa); }, desligar: desligar };
})(typeof window !== 'undefined' ? window : globalThis);
