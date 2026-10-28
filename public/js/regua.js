/* =====================================================================
 * Régua circular: uma régua graduada (eixos com marcas e vários números) em
 * volta do centro da tela. Os números são a distância até o centro; o raio
 * aparece na ponta da régua e o diâmetro na legenda.
 * Recalculada a cada zoom. Só visual: não grava nada.
 * Escala de Web Mercator (tiles de 256 px): m/px = 156543,03 · cos(lat) / 2^zoom.
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var RAIO_MIN_PX = 80, RAIO_MAX_PX = 150;   // o anel externo (raio) fica entre estes tamanhos na tela
  var PASSOS_M = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000, 200000];
  var MARCAS = 5;                            // divisões numeradas por raio (uma a cada 1/5); entre elas há uma marca pequena
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

  // Número de uma marca da escala (sem unidade; a unidade vai na legenda): metros, ou km quando o raio passa de 1 km.
  function numero(m, emKm) {
    return emKm ? (m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : String(Math.round(m));
  }

  function linha(x1, y1, x2, y2, classe) {
    return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" class="' + classe + '"/>';
  }

  function texto(x, y, ancora, classe, conteudo) {
    return '<text x="' + x + '" y="' + y + '" text-anchor="' + ancora + '" class="' + classe + '">' + conteudo + '</text>';
  }

  function desenhar() {
    if (!est.div || !est.mapa) return;
    var raioM = raioAdequado(metrosPorPixel(est.mapa));
    var R = raioM / metrosPorPixel(est.mapa);
    var emKm = raioM >= 1000;
    var W = Math.ceil(2 * R + 2 * MARGEM_LATERAL), H = Math.ceil(2 * R + 28);
    var cx = W / 2, cy = H / 2;
    var svg = est.div.querySelector('svg');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

    var s = '';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" class="regua-anel"/>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (R / 2) + '" class="regua-anel regua-anel-meio"/>';
    // eixos (horizontal e vertical) em forma de régua
    s += linha(cx - R, cy, cx + R, cy, 'regua-eixo');
    s += linha(cx, cy - R, cx, cy + R, 'regua-eixo');

    // Marcas: uma a cada 1/10 do raio (pequena), a cada 1/5 (média, com número) e a do raio (grande).
    // Números apertados são pulados, sempre mantendo o do raio.
    var passoPx = R / MARCAS;
    var larguraNum = numero(raioM, emKm).length * 6.2 + 3;
    var salto = Math.max(1, Math.ceil(larguraNum / passoPx));
    var comNumero = {};
    for (var j = MARCAS; j >= 1; j -= salto) comNumero[j] = true;

    for (var k = 1; k <= MARCAS * 2; k++) {
      var d = k * R / (MARCAS * 2), quinto = k % 2 === 0, q = k / 2;
      var len = k === MARCAS * 2 ? 10 : (quinto ? 7 : 4);
      [1, -1].forEach(function (sinal) {
        s += linha(cx + sinal * d, cy - len, cx + sinal * d, cy + len, k === MARCAS * 2 ? 'regua-marca regua-marca-raio' : 'regua-marca');
        s += linha(cx - len, cy + sinal * d, cx + len, cy + sinal * d, k === MARCAS * 2 ? 'regua-marca regua-marca-raio' : 'regua-marca');
      });
      if (!quinto || !comNumero[q] || q === MARCAS) continue;
      var num = numero(raioM * q / MARCAS, emKm);
      // horizontal: abaixo do eixo, dos dois lados; vertical: ao lado do eixo, em cima e embaixo
      s += texto(cx + d, cy + 22, 'middle', 'regua-num', num);
      s += texto(cx - d, cy + 22, 'middle', 'regua-num', num);
      s += texto(cx + 13, cy - d + 4, 'start', 'regua-num', num);
      if (d >= 32) s += texto(cx + 13, cy + d + 4, 'start', 'regua-num', num);   // perto do centro bateria nos números horizontais
    }
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="2.5" class="regua-centro"/>';
    // o número do raio, com unidade, na ponta de cada lado da régua
    var rot = rotulo(raioM);
    s += texto(cx + R + 6, cy - 6, 'start', 'regua-rot', rot);
    s += texto(cx - R - 6, cy - 6, 'end', 'regua-rot', rot);
    svg.innerHTML = s;
    est.legenda.innerHTML = 'Escala em <b>' + (emKm ? 'km' : 'm') + '</b>, a partir do centro · Raio <b>' + rotulo(raioM) + '</b> · Diâmetro <b>' + rotulo(raioM * 2) + '</b>';
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
