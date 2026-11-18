/* =====================================================================
 * giro-mapa.js — contas do giro do mapa conforme a direção do celular (página do participante).
 *   O plugin leaflet-rotate gira o mapa no sentido horário: setBearing(90) leva o norte para a direita. Para a frente do
 *   celular ficar para cima, o mapa gira o contrário do rumo: bearing = 360 − rumo (rumo 90° = apontando para o leste →
 *   bearing 270°, o leste fica em cima).
 *   Funções puras (testes/giro_mapa.test.js). API: window.GiroMapa.
 * ===================================================================== */
(function (raiz) {
  'use strict';

  function normalizar(g) { var r = g % 360; return r < 0 ? r + 360 : r; }
  // diferença com sinal de a até b pelo caminho mais curto, em (-180, 180]
  function diferenca(a, b) {
    var d = normalizar(b - a);
    return d > 180 ? d - 360 : d;
  }
  function bearingParaRumo(rumo) { return normalizar(360 - rumo); }
  // anda uma fração (0..1) do caminho de atual até alvo pelo lado mais curto (suaviza o tremor do sensor)
  function suavizar(atual, alvo, fator) { return normalizar(atual + diferenca(atual, alvo) * fator); }
  // só vale redesenhar o mapa quando a mudança passa de um mínimo (o sensor oscila alguns graus parado)
  function mudouBastante(atual, alvo, minimo) { return Math.abs(diferenca(atual, alvo)) >= (minimo == null ? 2 : minimo); }

  var api = { normalizar: normalizar, diferenca: diferenca, bearingParaRumo: bearingParaRumo, suavizar: suavizar, mudouBastante: mudouBastante };
  raiz.GiroMapa = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
