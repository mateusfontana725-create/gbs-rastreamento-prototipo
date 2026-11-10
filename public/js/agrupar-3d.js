/* =====================================================================
 * agrupar-3d.js — agrupamento dos itens na visão 3D (sem bibliotecas)
 *
 *   ALTURA_AGRUPAR_M                 → a partir desta altura da câmera (metros) os itens próximos se agrupam
 *   alturaCameraM({ lat, zoom, pitchGraus, alturaTelaPx })
 *                                    → altura aproximada da câmera acima do chão (mesma convenção do MapLibre:
 *                                      campo de visão vertical de 36,87°, tiles de 512 px)
 *   agruparPorTela(pontos, raioPx)   → pontos = [{ x, y, i }] (já projetados na tela); devolve os grupos
 *                                      [{ x, y, membros: [i…] }], juntando os que estão a menos de raioPx
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var ALTURA_AGRUPAR_M = 50;          // m — abaixo disso cada item aparece sozinho
  var FOV_GRAUS = 36.87;              // campo de visão vertical da câmera (padrão MapLibre / Mapbox)
  var LADO_TILE_PX = 512;             // lado do tile usado pelo MapLibre
  var CIRCUNFERENCIA_TERRA_M = 40075016.686;

  function alturaCameraM(o) {
    var rad = Math.PI / 180;
    var metrosPorPx = CIRCUNFERENCIA_TERRA_M * Math.cos(o.lat * rad) / (LADO_TILE_PX * Math.pow(2, o.zoom));
    // distância da câmera ao ponto no centro da tela, em pixels (metade da altura da tela sobre a tangente do FOV)
    var distanciaPx = (o.alturaTelaPx / 2) / Math.tan((FOV_GRAUS / 2) * rad);
    return distanciaPx * metrosPorPx * Math.cos((o.pitchGraus || 0) * rad);
  }

  // Agrupamento guloso: cada ponto entra no primeiro grupo a menos de raioPx do centro dele; senão abre um grupo.
  function agruparPorTela(pontos, raioPx) {
    var grupos = [];
    var r2 = raioPx * raioPx;
    (pontos || []).forEach(function (p) {
      var alvo = null, melhor = Infinity;
      grupos.forEach(function (g) {
        var dx = p.x - g.x, dy = p.y - g.y, d = dx * dx + dy * dy;
        if (d <= r2 && d < melhor) { melhor = d; alvo = g; }
      });
      if (!alvo) {
        grupos.push({ x: p.x, y: p.y, sx: p.x, sy: p.y, membros: [p.i] });
      } else {
        alvo.membros.push(p.i);
        alvo.sx += p.x; alvo.sy += p.y;
        alvo.x = alvo.sx / alvo.membros.length; alvo.y = alvo.sy / alvo.membros.length;
      }
    });
    return grupos.map(function (g) { return { x: g.x, y: g.y, membros: g.membros }; });
  }

  var api = { ALTURA_AGRUPAR_M: ALTURA_AGRUPAR_M, alturaCameraM: alturaCameraM, agruparPorTela: agruparPorTela };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.Agrupar3D = api;
})(typeof window !== 'undefined' ? window : globalThis);
