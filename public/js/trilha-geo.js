/* =====================================================================
 * trilha-geo.js — geometria das trilhas desenhadas no painel (sem bibliotecas)
 *
 *   recortarForaDosCirculos(pts, circulos)  → partes da linha que ficam FORA dos círculos (áreas sem trilha)
 *   apagarComPincel(pts, centros, raioM)    → o que sobra da linha depois da borracha (várias partes)
 *   dividirNaBase(pontos)                   → separa os pontos de um rastro nos pontos de entrada na base
 *   dentroDeAlgum(lat, lng, circulos)       → o ponto está dentro de algum círculo?
 *   pontoNoPoligono / pontoNoCirculo        → um ponto está dentro da área? (seleção de elementos sobrepostos)
 *   circuloParaPoligono(lat, lng, raioM, n) → vértices de um círculo (para dividir um setor circular)
 *   dividirPorLinha(pts, a, b)              → divide um polígono em dois por uma linha reta (setores)
 *   dividirEmFatias(pts, n, anguloGraus)    → n fatias a partir do centro (rumo inicial em graus)
 *   dividirEmFaixas(pts, n, anguloGraus)    → n faixas paralelas ao rumo informado
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

  /* ---------- Áreas (setores) ---------- */
  function pontoNoPoligono(lat, lng, pts) {
    var dentro = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var yi = pts[i][0], xi = pts[i][1], yj = pts[j][0], xj = pts[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) dentro = !dentro;
    }
    return dentro;
  }
  function pontoNoCirculo(lat, lng, cLat, cLng, raioM) {
    var P = plano(lat);
    var dx = P.x(lng) - P.x(cLng), dy = P.y(lat) - P.y(cLat);
    return dx * dx + dy * dy <= raioM * raioM;
  }
  function circuloParaPoligono(lat, lng, raioM, n) {
    n = n || 48;
    var P = plano(lat), out = [];
    for (var i = 0; i < n; i++) {
      var a = 2 * Math.PI * i / n;
      out.push([lat + P.lat(raioM * Math.cos(a)), lng + P.lng(raioM * Math.sin(a))]);
    }
    return out;
  }

  // Polígono em metros [{x,y}] cortado por um semiplano: fica o que tem (p - o)·n >= 0 (Sutherland–Hodgman).
  function semiplano(poly, ox, oy, nx, ny) {
    var saida = [];
    for (var i = 0; i < poly.length; i++) {
      var A = poly[i], B = poly[(i + 1) % poly.length];
      var da = (A.x - ox) * nx + (A.y - oy) * ny, db = (B.x - ox) * nx + (B.y - oy) * ny;
      if (da >= 0) saida.push(A);
      if ((da >= 0) !== (db >= 0)) {
        var t = da / (da - db);
        saida.push({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t });
      }
    }
    return saida;
  }
  function areaM2(poly) {
    var s = 0;
    for (var i = 0; i < poly.length; i++) { var A = poly[i], B = poly[(i + 1) % poly.length]; s += A.x * B.y - B.x * A.y; }
    return Math.abs(s) / 2;
  }
  function paraPlano(pts, P) { return pts.map(function (p) { return { x: P.x(p[1]), y: P.y(p[0]) }; }); }
  function deVolta(poly, P) {
    // sem vértices repetidos em sequência; coordenadas com 7 casas (como o painel grava)
    var out = [];
    poly.forEach(function (q) {
      var v = [Math.round(P.lat(q.y) * 1e7) / 1e7, Math.round(P.lng(q.x) * 1e7) / 1e7];
      var u = out[out.length - 1];
      if (!u || u[0] !== v[0] || u[1] !== v[1]) out.push(v);
    });
    if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
    return out;
  }
  function resultado(partes, P) {
    return partes.filter(function (p) { return p.length >= 3 && areaM2(p) > 1; }).map(function (p) { return deVolta(p, P); })
      .filter(function (p) { return p.length >= 3; });
  }
  function centroide(poly) {
    var a = 0, cx = 0, cy = 0;
    for (var i = 0; i < poly.length; i++) {
      var A = poly[i], B = poly[(i + 1) % poly.length], c = A.x * B.y - B.x * A.y;
      a += c; cx += (A.x + B.x) * c; cy += (A.y + B.y) * c;
    }
    if (Math.abs(a) < 1e-9) {
      var sx = 0, sy = 0; poly.forEach(function (p) { sx += p.x; sy += p.y; });
      return { x: sx / poly.length, y: sy / poly.length };
    }
    return { x: cx / (3 * a), y: cy / (3 * a) };
  }

  // Divide o polígono pela reta que passa por a e b ([lat, lng]): devolve as partes de cada lado (2, ou 1 se a reta não o cruza).
  function dividirPorLinha(pts, a, b) {
    if (!pts || pts.length < 3) return [];
    var P = planoDe(pts), poly = paraPlano(pts, P);
    var ax = P.x(a[1]), ay = P.y(a[0]), bx = P.x(b[1]), by = P.y(b[0]);
    var nx = -(by - ay), ny = bx - ax;
    if (nx === 0 && ny === 0) return [pts.map(function (p) { return [p[0], p[1]]; })];
    return resultado([semiplano(poly, ax, ay, nx, ny), semiplano(poly, ax, ay, -nx, -ny)], P);
  }

  // n fatias a partir do centro do polígono; o rumo (graus, 0 = norte, sentido horário) é o da primeira divisa.
  function dividirEmFatias(pts, n, anguloGraus) {
    if (!pts || pts.length < 3 || !(n >= 2)) return [];
    var P = planoDe(pts), poly = paraPlano(pts, P), c = centroide(poly), partes = [];
    var passo = 360 / n;
    for (var k = 0; k < n; k++) {
      var t1 = (anguloGraus + k * passo) * Math.PI / 180, t2 = (anguloGraus + (k + 1) * passo) * Math.PI / 180;
      var d1 = { x: Math.sin(t1), y: Math.cos(t1) }, d2 = { x: Math.sin(t2), y: Math.cos(t2) };
      var p = semiplano(poly, c.x, c.y, d1.y, -d1.x);   // do lado horário da divisa inicial
      p = semiplano(p, c.x, c.y, -d2.y, d2.x);          // e do lado anti-horário da divisa final
      partes.push(p);
    }
    return resultado(partes, P);
  }

  // n faixas paralelas ao rumo informado (graus, 0 = norte), de largura igual.
  function dividirEmFaixas(pts, n, anguloGraus) {
    if (!pts || pts.length < 3 || !(n >= 2)) return [];
    var P = planoDe(pts), poly = paraPlano(pts, P);
    var t = anguloGraus * Math.PI / 180, mx = Math.cos(t), my = -Math.sin(t);   // perpendicular ao rumo
    var min = Infinity, max = -Infinity;
    poly.forEach(function (q) { var v = q.x * mx + q.y * my; if (v < min) min = v; if (v > max) max = v; });
    var larg = (max - min) / n, partes = [];
    for (var k = 0; k < n; k++) {
      var t0 = min + k * larg, t1 = min + (k + 1) * larg;
      var p = semiplano(poly, mx * t0, my * t0, mx, my);
      p = semiplano(p, mx * t1, my * t1, -mx, -my);
      partes.push(p);
    }
    return resultado(partes, P);
  }

  // Setas de sentido ao longo de uma linha já em pixels ([{x, y}], na ordem do percurso): uma a cada `espaco` px
  // (a primeira em espaco/2). O sentido vem de um trecho maior em volta da seta (de `janela` px antes a `janela`
  // px depois), não do trechinho onde ela cai: o tremor do GPS (pessoa parada, sinal ruim) fazia setas apontarem
  // para trás. Onde a linha vai e volta nesse trecho (vaivém), não há seta: ali não dá para saber o sentido.
  function setasAoLongo(pts, espaco, max, janela) {
    var r = [];
    if (!pts || pts.length < 2 || !(espaco > 0)) return r;
    max = max || 1000;
    janela = janela == null ? Math.max(10, espaco * 0.35) : janela;
    var acum = [0];
    for (var i = 1; i < pts.length; i++) {
      var dx0 = pts[i].x - pts[i - 1].x, dy0 = pts[i].y - pts[i - 1].y;
      acum.push(acum[i - 1] + Math.sqrt(dx0 * dx0 + dy0 * dy0));
    }
    var total = acum[acum.length - 1];
    if (!total) return r;
    var k = 0;
    function em(d) {   // ponto a d px do começo (d crescente na maior parte das chamadas: busca a partir do último)
      d = Math.max(0, Math.min(total, d));
      if (d < acum[k]) k = 0;
      while (k < acum.length - 2 && acum[k + 1] < d) k++;
      var seg = acum[k + 1] - acum[k], t = seg ? (d - acum[k]) / seg : 0;
      return { x: pts[k].x + (pts[k + 1].x - pts[k].x) * t, y: pts[k].y + (pts[k + 1].y - pts[k].y) * t };
    }
    for (var s = espaco / 2; s <= total && r.length < max; s += espaco) {
      var a = em(s - janela), b = em(s + janela), c = em(s);
      var dx = b.x - a.x, dy = b.y - a.y, corda = Math.sqrt(dx * dx + dy * dy);
      var caminho = Math.min(total, s + janela) - Math.max(0, s - janela);
      if (!corda || corda < caminho * 0.6) continue;   // vaivém: sem seta
      r.push({ x: c.x, y: c.y, ang: Math.atan2(dy, dx) });
    }
    return r;
  }

  // Vértices (pixels) de uma seta em forma de ponta (como no AlpineQuest), centrada na posição, apontando no ângulo.
  // tam = meio comprimento em px.
  function verticesSeta(s, tam) {
    var c = Math.cos(s.ang), si = Math.sin(s.ang);
    return [[tam, 0], [-tam * 0.8, tam * 0.85], [-tam * 0.35, 0], [-tam * 0.8, -tam * 0.85]].map(function (q) {
      return { x: s.x + q[0] * c - q[1] * si, y: s.y + q[0] * si + q[1] * c };
    });
  }

  global.TrilhaGeo = {
    setasAoLongo: setasAoLongo, verticesSeta: verticesSeta,
    recortarForaDosCirculos: recortarForaDosCirculos, apagarComPincel: apagarComPincel,
    dentroDeAlgum: dentroDeAlgum, dividirNaBase: dividirNaBase, comprimentoM: comprimentoM,
    pontoNoPoligono: pontoNoPoligono, pontoNoCirculo: pontoNoCirculo, circuloParaPoligono: circuloParaPoligono,
    dividirPorLinha: dividirPorLinha, dividirEmFatias: dividirEmFatias, dividirEmFaixas: dividirEmFaixas,
    areaPoligonoM2: function (pts) { var P = planoDe(pts); return areaM2(paraPlano(pts, P)); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
