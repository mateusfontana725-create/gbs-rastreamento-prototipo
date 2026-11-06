/* =====================================================================
 * trilha-geo.js — geometria das trilhas desenhadas no painel (sem bibliotecas)
 *
 *   recortarForaDosCirculos(pts, circulos)  → partes da linha que ficam FORA dos círculos (áreas sem trilha)
 *   apagarComPincel(pts, centros, raioM)    → o que sobra da linha depois da borracha (várias partes)
 *   dividirNaBase(pontos)                   → separa os pontos de um rastro nos pontos de entrada na base
 *   dentroDeAlgum(lat, lng, circulos)       → o ponto está dentro de algum círculo?
 *
 * Linha = [[lat, lng], …]. Círculo = { lat, lng, raio_m }. Centro do pincel = [lat, lng].
 * As contas usam o plano local em metros (equirretangular), bom para distâncias de até alguns quilômetros.
 * ===================================================================== */
(function (global) {
  'use strict';

  var M_POR_GRAU = 111320;

  function plano(lat0) {
    var kx = M_POR_GRAU * Math.cos(lat0 * Math.PI / 180);
    return {
      x: function (lng) { return lng * kx; },
      y: function (lat) { return lat * M_POR_GRAU; },
      lng: function (x) { return x / kx; },
      lat: function (y) { return y / M_POR_GRAU; },
    };
  }

  // Trechos do segmento A→B (em t de 0 a 1) que ficam DENTRO do círculo de centro C e raio r (metros).
  // Devolve [t1, t2] ou null.
  function intervaloDentro(ax, ay, bx, by, cx, cy, r) {
    var dx = bx - ax, dy = by - ay;
    var fx = ax - cx, fy = ay - cy;
    var a = dx * dx + dy * dy;
    if (a === 0) return (fx * fx + fy * fy <= r * r) ? [0, 1] : null;
    var b = 2 * (fx * dx + fy * dy);
    var c = fx * fx + fy * fy - r * r;
    var disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    var raiz = Math.sqrt(disc);
    var t1 = (-b - raiz) / (2 * a), t2 = (-b + raiz) / (2 * a);
    if (t2 < 0 || t1 > 1) return null;
    return [Math.max(0, t1), Math.min(1, t2)];
  }

  // Parte comum: remove da linha tudo o que está dentro de qualquer um dos círculos (x, y em metros).
  function recortar(pts, circulos, P) {
    if (!pts || pts.length < 2) return [];
    var cs = (circulos || []).map(function (c) { return { x: P.x(c.lng), y: P.y(c.lat), r: c.raio_m }; });
    if (!cs.length) return [pts.map(function (p) { return [p[0], p[1]]; })];
    var partes = [], atual = [];
    function fecha() { if (atual.length >= 2) partes.push(atual); atual = []; }
    function junta(lat, lng) {
      var u = atual[atual.length - 1];
      if (!u || u[0] !== lat || u[1] !== lng) atual.push([lat, lng]);
    }
    for (var i = 0; i < pts.length - 1; i++) {
      var A = pts[i], B = pts[i + 1];
      var ax = P.x(A[1]), ay = P.y(A[0]), bx = P.x(B[1]), by = P.y(B[0]);
      // intervalos de t removidos pelos círculos, ordenados e unidos
      var rem = [];
      cs.forEach(function (c) { var iv = intervaloDentro(ax, ay, bx, by, c.x, c.y, c.r); if (iv) rem.push(iv); });
      rem.sort(function (p, q) { return p[0] - q[0]; });
      var uni = [];
      rem.forEach(function (iv) {
        var u = uni[uni.length - 1];
        if (u && iv[0] <= u[1]) u[1] = Math.max(u[1], iv[1]); else uni.push([iv[0], iv[1]]);
      });
      var t = 0;
      var pontoEm = function (tt) { return [A[0] + (B[0] - A[0]) * tt, A[1] + (B[1] - A[1]) * tt]; };
      if (!uni.length) {
        junta(A[0], A[1]); junta(B[0], B[1]);
        continue;
      }
      uni.forEach(function (iv) {
        if (iv[0] > t) {
          var p0 = pontoEm(t), p1 = pontoEm(iv[0]);
          junta(p0[0], p0[1]); junta(p1[0], p1[1]);
        }
        fecha();
        t = iv[1];
      });
      if (t < 1) {
        var q0 = pontoEm(t);
        junta(q0[0], q0[1]); junta(B[0], B[1]);
      } else {
        fecha();
      }
    }
    fecha();
    return partes;
  }

  function planoDe(pts, extra) {
    var soma = 0, n = 0;
    pts.forEach(function (p) { soma += p[0]; n++; });
    (extra || []).forEach(function (p) { soma += p.lat != null ? p.lat : p[0]; n++; });
    return plano(n ? soma / n : 0);
  }

  function recortarForaDosCirculos(pts, circulos) {
    if (!pts || pts.length < 2) return [];
    return recortar(pts, circulos, planoDe(pts, circulos));
  }

  // Borracha: apaga o que está a até raioM de qualquer centro do pincel. Sobram partes com 2+ pontos.
  function apagarComPincel(pts, centros, raioM) {
    if (!pts || pts.length < 2) return [];
    var cs = (centros || []).map(function (c) { return { lat: c[0], lng: c[1], raio_m: raioM }; });
    return recortar(pts, cs, planoDe(pts, centros));
  }

  function dentroDeAlgum(lat, lng, circulos) {
    if (!circulos || !circulos.length) return false;
    var P = plano(lat);
    var x = P.x(lng), y = P.y(lat);
    for (var i = 0; i < circulos.length; i++) {
      var c = circulos[i];
      var dx = x - P.x(c.lng), dy = y - P.y(c.lat);
      if (dx * dx + dy * dy <= c.raio_m * c.raio_m) return true;
    }
    return false;
  }

  // Rastro GPS: os pontos marcados na_base (entrada na base) não entram na linha; a linha se divide neles,
  // para a longa permanência na base não virar uma "falha" nem uma reta atravessando a base.
  // pontos = [{ na_base?, … }] em ordem de horário. Devolve as partes (cada uma sem pontos na_base).
  function dividirNaBase(pontos) {
    var partes = [], atual = [];
    (pontos || []).forEach(function (p) {
      if (p.na_base) { if (atual.length) partes.push(atual); atual = []; }
      else atual.push(p);
    });
    if (atual.length) partes.push(atual);
    return partes;
  }

  // Comprimento da linha em metros.
  function comprimentoM(pts) {
    var m = 0;
    if (!pts || pts.length < 2) return 0;
    var P = planoDe(pts);
    for (var i = 1; i < pts.length; i++) {
      var dx = P.x(pts[i][1]) - P.x(pts[i - 1][1]), dy = P.y(pts[i][0]) - P.y(pts[i - 1][0]);
      m += Math.sqrt(dx * dx + dy * dy);
    }
    return m;
  }

  global.TrilhaGeo = {
    recortarForaDosCirculos: recortarForaDosCirculos, apagarComPincel: apagarComPincel,
    dentroDeAlgum: dentroDeAlgum, dividirNaBase: dividirNaBase, comprimentoM: comprimentoM,
  };
})(typeof window !== 'undefined' ? window : globalThis);
