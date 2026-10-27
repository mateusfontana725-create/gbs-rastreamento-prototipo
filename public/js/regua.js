/* =====================================================================
 * Régua circular: uma régua graduada em volta do centro da tela. Os números
 * são a distância até o centro (o raio); o diâmetro aparece na legenda.
 * Recalculada a cada zoom. Só visual: não grava nada.
 * Escala de Web Mercator (tiles de 256 px): m/px = 156543,03 · cos(lat) / 2^zoom.
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var RAIO_MIN_PX = 80, RAIO_MAX_PX = 150;   // o anel externo (raio) fica entre estes tamanhos na tela
  var PASSOS_M = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000, 200000];
  var MARCAS = 5;                            // marcas por raio (uma a cada 1/5 do raio externo)
  var MARGEM_LATERAL = 64;                   // espaço para os números à esquerda e à direita

  var est = { mapa: null, div: null, aoMover: null };

  function metrosPorPixel(mapa) {
    var c = mapa.getCenter();
    return 156543.03392 * Math.cos(c.lat * Math.PI / 180) / Math.pow(2, mapa.getZoom());
  }

  // Raio "redondo" (em metros) cujo anel externo cabe na faixa de tamanho na tela.
  function raioAdequado(mpp) {
    var cabe = PASSOS_M.filter(function (m) { return m / mpp >= RAIO_MIN_PX && m / mpp <= RAIO_MAX_PX; });
    if (cabe.length) return cabe[cabe.length - 1];
    // nenhum passo cai na faixa (zoom muito de perto ou muito de longe): o menor que não estoura
    var menores = PASSOS_M.filter(function (m) { return m / mpp <= RAIO_MAX_PX; });
    return menores.length ? menores[menores.length - 1] : PASSOS_M[0];
  }

  function rotulo(m) {
    if (m >= 1000) return (m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' km';
    return m + ' m';
  }

  function desenhar() {
    if (!est.div || !est.mapa) return;
    var raioM = raioAdequado(metrosPorPixel(est.mapa));
    var R = raioM / metrosPorPixel(est.mapa);
    var meio = R / 2, marca = R / MARCAS;
    var W = Math.ceil(2 * R + 2 * MARGEM_LATERAL), H = Math.ceil(2 * R + 28);
    var cx = W / 2, cy = H / 2;
    var svg = est.div.querySelector('svg');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

    var s = '';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" class="regua-anel"/>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + meio + '" class="regua-anel regua-anel-meio"/>';
    // eixos da régua (horizontal e vertical) com marcas a cada 1/5 do raio
    s += '<line x1="' + (cx - R) + '" y1="' + cy + '" x2="' + (cx + R) + '" y2="' + cy + '" class="regua-eixo"/>';
    s += '<line x1="' + cx + '" y1="' + (cy - R) + '" x2="' + cx + '" y2="' + (cy + R) + '" class="regua-eixo"/>';
    for (var k = -MARCAS; k <= MARCAS; k++) {
      if (k === 0) continue;
      var d = k * marca, maior = Math.abs(k) === MARCAS ? 7 : 4;   // marca maior na borda do anel externo
      s += '<line x1="' + (cx + d) + '" y1="' + (cy - maior) + '" x2="' + (cx + d) + '" y2="' + (cy + maior) + '" class="regua-marca"/>';
      s += '<line x1="' + (cx - maior) + '" y1="' + (cy + d) + '" x2="' + (cx + maior) + '" y2="' + (cy + d) + '" class="regua-marca"/>';
    }
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="2.5" class="regua-centro"/>';
    // números nos dois lados: a distância de cada anel até o centro (o raio)
    [[meio, raioM / 2], [R, raioM]].forEach(function (par) {
      var r = par[0], m = par[1];
      s += '<text x="' + (cx + r + 4) + '" y="' + (cy - 5) + '" text-anchor="start" class="regua-rot">' + rotulo(m) + '</text>';
      s += '<text x="' + (cx - r - 4) + '" y="' + (cy - 5) + '" text-anchor="end" class="regua-rot">' + rotulo(m) + '</text>';
    });
    svg.innerHTML = s;
    est.legenda.innerHTML = 'Números = <b>raio</b> (distância do centro). Diâmetro = 2 × raio = <b>' + rotulo(raioM * 2) + '</b>';
  }

  function ligar(mapa) {
    if (est.mapa) return;
    est.mapa = mapa;
    var div = document.createElement('div');
    div.className = 'regua-circular';
    div.setAttribute('aria-hidden', 'true');
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"></svg><div class="regua-legenda"></div>';
    mapa.getContainer().appendChild(div);
    est.div = div;
    est.legenda = div.querySelector('.regua-legenda');
    est.aoMover = desenhar;
    mapa.on('zoomend moveend resize', est.aoMover);
    desenhar();
  }

  function desligar() {
    if (!est.mapa) return;
    est.mapa.off('zoomend moveend resize', est.aoMover);
    if (est.div && est.div.parentNode) est.div.parentNode.removeChild(est.div);
    est.mapa = est.div = est.aoMover = est.legenda = null;
  }

  // Devolve true se ficou ligada.
  function alternar(mapa) {
    if (est.mapa) { desligar(); return false; }
    ligar(mapa);
    return true;
  }

  raiz.Regua = { alternar: alternar, ligada: function () { return Boolean(est.mapa); }, desligar: desligar };
})(typeof window !== 'undefined' ? window : globalThis);
