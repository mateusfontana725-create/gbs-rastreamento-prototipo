/*
 * Probabilidades de busca: POD, POA e POS. Cálculo puro, sem tela (testado em testes/pod.test.js).
 *
 * Modelo (Koopman, "Search and Screening", 1980; manual IAMSAR, vol. II):
 *   - A área dos setores vira uma grade de células de c metros.
 *   - POA inicial da célula: uniforme sobre a área dos setores (q0 = 1 / nº de células).
 *   - Esforço numa célula: L = metros de trilha GPS dentro dela, durante a busca.
 *   - Cobertura: C = W · L / c²  (W = largura de varredura, em metros).
 *   - POD da célula: POD = 1 − e^(−C). Trilhas que se sobrepõem somam L dentro do expoente,
 *     então sobreposição nunca é contada duas vezes e o POD nunca passa de 100%.
 *   - POS da busca (condicional: a pessoa ainda não foi achada): POS_b = Σ q_j · POD_j.
 *   - Depois da busca, q_j ← q_j · (1 − POD_j) / Σ q·(1 − POD): a probabilidade migra para
 *     as áreas não vistas. O POA atual de um setor é Σ q_j nas células dele.
 *   - POD médio do setor na busca: Σ_setor q·POD / Σ_setor q.
 *   - POS acumulado (todas as buscas): 1 − Π(1 − POS_b) = Σ_j q0_j · Π_b (1 − POD_jb).
 *     É calculado por célula, então área coberta por dois setores ou duas buscas conta uma vez.
 *   - POS de um setor = POA inicial × POD acumulado do setor (soma das células dele).
 */
(function () {
  'use strict';

  var W_PADRAO_M = 20;          // largura de varredura de uma pessoa em mata (ordem de grandeza da literatura)
  var MAX_CELULAS = 400000;     // limite da grade (busca grande ganha células maiores)
  var CELULA_MIN_M = 10, CELULA_MAX_M = 30;

  function projetor(lat0, lng0) {
    var R = 6371008.8, k = Math.PI / 180, cos0 = Math.cos(lat0 * k);
    return {
      xy: function (lat, lng) { return [(lng - lng0) * k * R * cos0, (lat - lat0) * k * R]; },
    };
  }

  function dentroDoPoligono(x, y, poli) {
    var dentro = false;
    for (var i = 0, j = poli.length - 1; i < poli.length; j = i++) {
      if (((poli[i][1] > y) !== (poli[j][1] > y)) &&
          (x < (poli[j][0] - poli[i][0]) * (y - poli[i][1]) / (poli[j][1] - poli[i][1]) + poli[i][0])) dentro = !dentro;
    }
    return dentro;
  }

  function areaPoligono(poli) {
    var a = 0;
    for (var i = 0, j = poli.length - 1; i < poli.length; j = i++) a += (poli[j][0] + poli[i][0]) * (poli[j][1] - poli[i][1]);
    return Math.abs(a / 2);
  }

  function vazio() {
    return { larguraM: W_PADRAO_M, celulaM: null, setores: [], buscas: [], posTotal: null };
  }

  /*
   * entrada:
   *   setores: [{ id, nome, poligono: [[lat, lng], …] }]            (círculos já convertidos em polígono)
   *   buscas:  [{ id, setorId, grupo, inicio, fim, trilhas: [[{ lat, lng, t }, …], …] }]
   *            inicio/fim em ms; fim nulo = busca ainda em andamento (usa agora)
   *   larguraM: largura de varredura W (opcional; padrão 20 m)
   *   agora:    ms, para buscas sem fim
   * Devolve { larguraM, celulaM, setores: [...], buscas: [...], posTotal }.
   */
  function calcular(entrada) {
    var W = entrada.larguraM > 0 ? entrada.larguraM : W_PADRAO_M;
    var agora = entrada.agora != null ? entrada.agora : Date.now();
    var setores = (entrada.setores || []).filter(function (s) { return s.poligono && s.poligono.length >= 3; });
    if (!setores.length) return vazio();

    // projeção local, centrada na média dos vértices dos setores
    var la = 0, ln = 0, nv = 0;
    setores.forEach(function (s) { s.poligono.forEach(function (p) { la += p[0]; ln += p[1]; nv++; }); });
    var pr = projetor(la / nv, ln / nv);
    var polis = setores.map(function (s) { return s.poligono.map(function (p) { return pr.xy(p[0], p[1]); }); });

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, menorArea = Infinity;
    polis.forEach(function (poli) {
      poli.forEach(function (q) { minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]); minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1]); });
      var a = areaPoligono(poli);
      if (a > 0) menorArea = Math.min(menorArea, a);
    });
    if (!(menorArea < Infinity)) return vazio();

    // tamanho da célula: ~1/5 da raiz da menor área (pelo menos 10 m, no máximo 30 m), grade limitada
    var c = Math.min(CELULA_MAX_M, Math.max(CELULA_MIN_M, Math.sqrt(menorArea) / 5));
    var bbox = (maxX - minX) * (maxY - minY);
    if (bbox / (c * c) > MAX_CELULAS) c = Math.sqrt(bbox / MAX_CELULAS);
    var nx = Math.floor((maxX - minX) / c) + 1, ny = Math.floor((maxY - minY) / c) + 1, n = nx * ny;

    var mascaras = polis.map(function (poli) {
      var m = new Uint8Array(n);
      for (var j = 0; j < ny; j++) for (var i = 0; i < nx; i++) {
        if (dentroDoPoligono(minX + (i + 0.5) * c, minY + (j + 0.5) * c, poli)) m[j * nx + i] = 1;
      }
      return m;
    });
    var uniao = new Uint8Array(n), nUniao = 0;
    mascaras.forEach(function (m) { for (var k = 0; k < n; k++) if (m[k] && !uniao[k]) { uniao[k] = 1; nUniao++; } });
    if (!nUniao) return vazio();

    var q0 = new Float64Array(n), q = new Float64Array(n), naoAchado = new Float64Array(n);
    for (var k0 = 0; k0 < n; k0++) { if (uniao[k0]) { q0[k0] = 1 / nUniao; q[k0] = 1 / nUniao; } naoAchado[k0] = 1; }

    var indicePorSetor = {};
    setores.forEach(function (s, i) { indicePorSetor[s.id] = i; });

    var buscas = (entrada.buscas || [])
      .filter(function (b) { return indicePorSetor[b.setorId] != null && b.inicio != null; })
      .map(function (b) { return { b: b, ini: b.inicio, fim: b.fim != null ? b.fim : agora }; })
      .sort(function (x, y) { return x.ini - y.ini || String(x.b.id).localeCompare(String(y.b.id)); });

    var resBuscas = buscas.map(function (x) {
      var b = x.b, m = mascaras[indicePorSetor[b.setorId]];
      var L = new Float64Array(n);
      var percorridoM = 0;
      (b.trilhas || []).forEach(function (trilha) {
        var pts = trilha.filter(function (p) { return p && p.t >= x.ini && p.t <= x.fim; });
        for (var i = 1; i < pts.length; i++) {
          var a = pr.xy(pts[i - 1].lat, pts[i - 1].lng), z = pr.xy(pts[i].lat, pts[i].lng);
          var dx = z[0] - a[0], dy = z[1] - a[1], d = Math.sqrt(dx * dx + dy * dy);
          if (!(d > 0)) continue;
          var passos = Math.max(1, Math.ceil(d / (c / 4))), tam = d / passos;
          for (var s = 0; s < passos; s++) {
            var f = (s + 0.5) / passos;
            var ci = Math.floor((a[0] + dx * f - minX) / c), cj = Math.floor((a[1] + dy * f - minY) / c);
            if (ci < 0 || cj < 0 || ci >= nx || cj >= ny) continue;
            var kk = cj * nx + ci;
            if (m[kk]) { L[kk] += tam; percorridoM += tam; }
          }
        }
      });

      // POD de cada célula do setor pesquisado, a partir do esforço (1 − e^(−C))
      var pod = new Float64Array(n), poaAntes = 0, pos = 0, podSoma = 0;
      for (var k = 0; k < n; k++) {
        if (!m[k]) continue;
        poaAntes += q[k];
        if (L[k] > 0) pod[k] = 1 - Math.exp(-W * L[k] / (c * c));
        pos += q[k] * pod[k];
        podSoma += q[k] * pod[k];
      }

      // atualização de Bayes: a probabilidade das células vistas cai, e tudo é renormalizado
      var z = 0;
      for (var k2 = 0; k2 < n; k2++) {
        if (!uniao[k2]) continue;
        naoAchado[k2] *= (1 - pod[k2]);
        q[k2] = q[k2] * (1 - pod[k2]);
        z += q[k2];
      }
      if (z > 0) for (var k3 = 0; k3 < n; k3++) if (uniao[k3]) q[k3] /= z;

      var poaDepois = 0;
      for (var k4 = 0; k4 < n; k4++) if (m[k4]) poaDepois += q[k4];

      return {
        id: b.id, setorId: b.setorId, grupo: b.grupo || '', inicio: x.ini, fim: b.fim != null ? b.fim : null,
        percorridoM: Math.round(percorridoM),
        pod: poaAntes > 0 ? podSoma / poaAntes : null,   // POD médio do setor nesta busca
        pos: pos,                                         // POS desta busca (condicional)
        poaAntes: poaAntes, poaDepois: poaDepois,
      };
    });

    var resSetores = setores.map(function (s, i) {
      var m = mascaras[i], poaInicial = 0, poaAtual = 0, posAcum = 0;
      for (var k = 0; k < n; k++) {
        if (!m[k]) continue;
        poaInicial += q0[k];
        poaAtual += q[k];
        posAcum += q0[k] * (1 - naoAchado[k]);
      }
      return {
        id: s.id, nome: s.nome,
        poaInicial: poaInicial,                             // fração da probabilidade inicial dentro do setor
        poa: poaAtual,                                      // fração atual (depois das buscas)
        pod: poaInicial > 0 ? posAcum / poaInicial : null,  // POD acumulado do setor
        pos: posAcum,                                       // POA inicial × POD acumulado
        buscas: resBuscas.filter(function (r) { return r.setorId === s.id; }),
      };
    });

    var posTotal = 0;
    for (var kt = 0; kt < n; kt++) if (uniao[kt]) posTotal += q0[kt] * (1 - naoAchado[kt]);

    return { larguraM: W, celulaM: Math.round(c * 10) / 10, setores: resSetores, buscas: resBuscas, posTotal: posTotal };
  }

  var alvo = typeof window !== 'undefined' ? window : globalThis;
  alvo.POD = { calcular: calcular, W_PADRAO_M: W_PADRAO_M };
})();
