/*
 * Probabilidades de busca: POA, POD e POS. Cálculo puro, sem tela (testado em testes/pod.test.js).
 *
 * De onde vem cada número:
 *   - POA (probabilidade de a pessoa estar no setor): decisão do responsável, por vítima, guardada
 *     numa versão APROVADA do cenário (com justificativa). O app nunca estima o POA inicial sozinho.
 *   - POD (probabilidade de a busca achar a pessoa, SE ela estiver no setor): vem do registro manual
 *     da busca. Nunca do GPS: a trilha mostra por onde a equipe passou, não o que ela observou.
 *
 * Desde a missão de busca (migração 039): cada missão negativa gera uma NOVA VERSÃO do cenário (posBusca, abaixo); o POD
 * pertence à missão e não é somado entre missões. As funções calcular/acumular valem só para os registros do formato antigo.
 *
 * O que o app calcula a partir deles (Koopman, "Search and Screening", 1980; IAMSAR, vol. II):
 *   - POD planejada (previsão) e POD não estimada (nulo, nunca zero) NÃO alteram o POA. Planejada só gera uma "POS prevista".
 *   - Só contam os registros lançados DEPOIS da aprovação da versão (a versão já incorpora o que se sabia
 *     até então), que não foram anulados e que valem para a vítima (registro sem vítima vale para todas).
 *   - POD acumulado do setor = 1 − Π(1 − POD de cada registro). Supõe buscas independentes: repetir o
 *     mesmo método no mesmo lugar tende a render menos do que esta conta, então é uma estimativa generosa.
 *   - POS do setor = POA × POD acumulado (chance de a pessoa estar lá E ter sido achada).
 *   - POS total = Σ POS dos setores = 1 − Z, onde Z é a probabilidade que sobra "não achada".
 *   - POA atual (depois das buscas, regra de Bayes): POA × (1 − POD acumulado), dividido por Z. A
 *     probabilidade migra para o que ainda não foi visto — inclusive para "fora dos setores".
 *   - "Fora dos setores" = 1 − Σ POA da versão (mais o POA de setores já excluídos). Tem POD 0.
 */
(function () {
  'use strict';

  function limitar01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  // 1 − Π(1 − p): probabilidade de ao menos uma das buscas achar a pessoa, se ela estiver no setor
  function acumular(pods) {
    var naoAchou = 1;
    (pods || []).forEach(function (p) { naoAchou *= (1 - limitar01(Number(p) || 0)); });
    return 1 - naoAchou;
  }

  /*
   * entrada:
   *   cenario:   { id, numero, aprovadaEm (ms), setores: [{ setorId, nome, poa, areaM2 }] }   (versão APROVADA)
   *   registros: [{ id, setorId, vitimaId (nulo = todas), finalidade ('pos_execucao'|'planejada'), pod (0–1 ou nulo = não estimada),
 *               coberturaFracao (busca em parte do setor), registradoEm (ms), anulado (bool) }]
   *   vitimaId:  a vítima do cenário
   * Devolve null sem cenário; senão:
   *   { versao, setores: [{ setorId, nome, poa, pod, pos, poaAtual, registros }],
   *     registros: [{ id, setorId, conta, motivo, pod, pos, poaAntes, poaDepois }],
   *     poaFora, poaForaAtual, posTotal, ordem: [setorId…] (do maior POA atual para o menor) }
   */
  function calcular(entrada) {
    var cen = entrada && entrada.cenario;
    if (!cen) return null;
    var vitimaId = entrada.vitimaId;

    // setores com vínculo; um setor excluído depois da aprovação deixa o POA dele em "fora dos setores"
    var ativos = (cen.setores || []).filter(function (s) { return s.setorId; });
    var somaAtivos = ativos.reduce(function (a, s) { return a + (Number(s.poa) || 0); }, 0);
    var poaFora = Math.max(0, 1 - somaAtivos);

    var indice = {};
    ativos.forEach(function (s) { indice[s.setorId] = s; });

    // quais registros contam
    var cronologico = (entrada.registros || []).slice().sort(function (a, b) {
      return (a.registradoEm - b.registradoEm) || String(a.id).localeCompare(String(b.id));
    });
    var resRegistros = cronologico.map(function (r) {
      var motivo = null;
      if (r.anulado) motivo = 'anulado';
      else if (r.vitimaId && r.vitimaId !== vitimaId) motivo = 'outra_vitima';
      else if (!r.setorId || !indice[r.setorId]) motivo = 'setor_fora_do_cenario';
      else if (r.finalidade === 'planejada') motivo = 'planejada';              // previsão: nunca altera o POA
      else if (cen.aprovadaEm != null && r.registradoEm < cen.aprovadaEm) motivo = 'anterior_a_versao';
      else if (r.pod == null) motivo = 'sem_estimativa';                         // POD não estimada ≠ POD zero
      // busca em parte do setor: POD do setor inteiro = POD da área coberta × fração coberta (a pessoa, se estiver
      // no setor, é suposta uniformemente distribuída nele — hipótese que a tela mostra)
      var fracao = r.coberturaFracao > 0 && r.coberturaFracao < 1 ? r.coberturaFracao : 1;
      return { id: r.id, setorId: r.setorId, conta: motivo === null, motivo: motivo, finalidade: r.finalidade || 'pos_execucao',
        pod: r.pod == null ? null : limitar01((Number(r.pod) || 0) * fracao), podInformado: r.pod == null ? null : limitar01(Number(r.pod) || 0),
        pos: 0, posPrevista: null, poaAntes: null, poaDepois: null, _r: r };
    });

    // Bayes em sequência: q = probabilidade atual (já normalizada) de cada setor e de "fora"
    var q = {};
    ativos.forEach(function (s) { q[s.setorId] = Number(s.poa) || 0; });
    var qFora = poaFora;
    var podsDoSetor = {};
    resRegistros.forEach(function (x) {
      if (!x.conta) return;
      var antes = q[x.setorId];
      // Z = probabilidade que sobra depois desta busca negativa. Z = 0 significa que "não achar" era impossível
      // (POD 100% onde estava toda a probabilidade): não há posterior; o registro não é aplicado e fica o aviso.
      var z = qFora - antes + antes * (1 - x.pod);
      Object.keys(q).forEach(function (id) { z += q[id]; });
      if (!(z > 1e-12)) { x.conta = false; x.motivo = 'inconsistente'; return; }
      x.poaAntes = antes;
      x.pos = antes * x.pod;                       // chance de achar nesta busca (dado que ainda não foi achada)
      q[x.setorId] = antes * (1 - x.pod);
      Object.keys(q).forEach(function (id) { q[id] /= z; });
      qFora /= z;
      x.poaDepois = q[x.setorId];
      (podsDoSetor[x.setorId] = podsDoSetor[x.setorId] || []).push(x.pod);
    });

    var semEstimativa = {};
    resRegistros.forEach(function (x) {
      if (x.motivo === 'sem_estimativa') semEstimativa[x.setorId] = (semEstimativa[x.setorId] || 0) + 1;
      // POS prevista de uma busca planejada: POA atual do setor × POD planejada (só informação, não altera nada)
      if (x.motivo === 'planejada' && x.pod != null) x.posPrevista = q[x.setorId] * x.pod;
    });
    var posTotal = 0;
    var resSetores = ativos.map(function (s) {
      var podAcum = podsDoSetor[s.setorId] ? acumular(podsDoSetor[s.setorId]) : null;
      var pos = (Number(s.poa) || 0) * (podAcum || 0);
      posTotal += pos;
      return { setorId: s.setorId, nome: s.nome, poa: Number(s.poa) || 0, pod: podAcum, pos: pos, poaAtual: q[s.setorId],
        registros: podsDoSetor[s.setorId] ? podsDoSetor[s.setorId].length : 0, semEstimativa: semEstimativa[s.setorId] || 0,
        areaM2: s.areaM2 > 0 ? s.areaM2 : null,
        // densidade de probabilidade: apoio ao planejamento (unidade: % por km²), nunca ordem automática
        pdenPorKm2: s.areaM2 > 0 ? (q[s.setorId] * 100) / (s.areaM2 / 1e6) : null };
    });
    resRegistros.forEach(function (x) { delete x._r; });

    return {
      versao: cen.numero,
      setores: resSetores,
      registros: resRegistros,
      poaFora: poaFora,
      poaForaAtual: qFora,
      posTotal: posTotal,
      ordem: resSetores.slice().sort(function (a, b) { return (b.poaAtual - a.poaAtual) || a.nome.localeCompare(b.nome, 'pt-BR'); })
        .map(function (s) { return s.setorId; }),
    };
  }

  /* ---------- Geometria: sobreposição de setores ----------------------------------------------
   * O mesmo cálculo existe no banco (busca_sobreposicao_fracao, migração 034), que é quem decide na aprovação.
   * Fração do MENOR setor que também está dentro do outro, por amostragem (grade 30 × 30). Acima de 2% = sobrepostos.
   */
  var R_TERRA = 6371008.8, LIMITE_SOBREPOSICAO = 0.02, GRADE = 30;

  // setor: { forma: 'circulo', centroLat, centroLng, raioM } ou { forma: 'poligono', pontos: [[lat, lng], …] } → [[lat, lng], …]
  function poligonoDoSetor(s) {
    if (s.forma === 'circulo') {
      var v = [];
      for (var i = 0; i < 48; i++) {
        var a = 2 * Math.PI * i / 48;
        v.push([s.centroLat + (s.raioM * Math.sin(a) / R_TERRA) * 180 / Math.PI,
          s.centroLng + (s.raioM * Math.cos(a) / (R_TERRA * Math.cos(s.centroLat * Math.PI / 180))) * 180 / Math.PI]);
      }
      return v;
    }
    return s.pontos || [];
  }

  function noPoligono(x, y, xs, ys) {
    var dentro = false;
    for (var i = 0, j = xs.length - 1; i < xs.length; j = i++) {
      if (((ys[i] > y) !== (ys[j] > y)) && (x < (xs[j] - xs[i]) * (y - ys[i]) / (ys[j] - ys[i]) + xs[i])) dentro = !dentro;
    }
    return dentro;
  }

  function sobreposicaoFracao(pa, pb) {
    if (pa.length < 3 || pb.length < 3) return 0;
    var la0 = pa[0][0], ln0 = pa[0][1], k = Math.cos(la0 * Math.PI / 180);
    function proj(p) {
      return { x: p.map(function (q) { return (q[1] - ln0) * Math.PI / 180 * R_TERRA * k; }), y: p.map(function (q) { return (q[0] - la0) * Math.PI / 180 * R_TERRA; }) };
    }
    function area(c) {
      var s = 0;
      for (var i = 0, j = c.x.length - 1; i < c.x.length; j = i++) s += (c.x[j] + c.x[i]) * (c.y[j] - c.y[i]);
      return s;
    }
    var a = proj(pa), b = proj(pb);
    var menor = Math.abs(area(a)) <= Math.abs(area(b)) ? a : b, maior = menor === a ? b : a;
    var minx = Math.min.apply(null, menor.x), maxx = Math.max.apply(null, menor.x), miny = Math.min.apply(null, menor.y), maxy = Math.max.apply(null, menor.y);
    var cs = 0, cb = 0;
    for (var gi = 0; gi < GRADE; gi++) {
      var px = minx + (gi + 0.5) * (maxx - minx) / GRADE;
      for (var gj = 0; gj < GRADE; gj++) {
        var py = miny + (gj + 0.5) * (maxy - miny) / GRADE;
        if (noPoligono(px, py, menor.x, menor.y)) { cs++; if (noPoligono(px, py, maior.x, maior.y)) cb++; }
      }
    }
    return cs ? cb / cs : 0;
  }

  // setores: [{ nome, poa, forma, centroLat, centroLng, raioM, pontos }]. Devolve os pares com POA > 0 que se sobrepõem.
  function sobreposicoes(setores) {
    var itens = (setores || []).filter(function (s) { return s.poa > 0 && s.forma; });
    var pares = [];
    for (var i = 0; i < itens.length; i++) {
      for (var j = i + 1; j < itens.length; j++) {
        var f = sobreposicaoFracao(poligonoDoSetor(itens[i]), poligonoDoSetor(itens[j]));
        if (f > LIMITE_SOBREPOSICAO) pares.push({ a: itens[i].nome, b: itens[j].nome, fracao: f });
      }
    }
    return pares;
  }

  // Ponto de partida para um cenário novo: o mesmo POA em cada metro quadrado (POA ∝ área), somando `total`
  // (1 = 100%). É só uma sugestão: o responsável ajusta e justifica. setores: [{ id, areaM2 }].
  function distribuirPelaArea(setores, total) {
    var soma = (setores || []).reduce(function (a, s) { return a + (s.areaM2 > 0 ? s.areaM2 : 0); }, 0);
    var t = total == null ? 1 : total;
    var saida = {};
    (setores || []).forEach(function (s) { saida[s.id] = soma > 0 && s.areaM2 > 0 ? t * s.areaM2 / soma : 0; });
    return arredondar(saida);
  }

  // Sugestão para a próxima versão: o POA atual (depois das buscas) de cada setor, em { setorId: fração }.
  // Os valores são arredondados para 0,1% sem nunca passar de 100% na soma.
  function sugerirProximaVersao(resultado) {
    var saida = {};
    if (!resultado) return saida;
    resultado.setores.forEach(function (s) { saida[s.setorId] = s.poaAtual; });
    return arredondar(saida);
  }

  // Arredonda para baixo, em décimos de ponto percentual: a soma nunca passa do original nem de 1
  function arredondar(mapa) {
    var saida = {};
    Object.keys(mapa).forEach(function (id) { saida[id] = Math.floor(mapa[id] * 1000 + 1e-9) / 1000; });
    return saida;
  }

  function somaPoa(valores) {
    return (valores || []).reduce(function (a, v) { return a + (Number(v) || 0); }, 0);
  }

  // Atualização depois de UMA busca negativa (a mesma conta do servidor, busca_missao_aplicar, conferida pelos testes):
  //   q = POD × cobertura no setor pesquisado e q = 0 nos demais ("Fora da área" não é pesquisada);
  //   r_j = p_j × (1 − q_j);  Z = Σ r_k;  p'_j = r_j / Z.  Cada missão se aplica à versão vigente, em sequência:
  //   o app NUNCA soma PODs de missões diferentes como se fossem independentes.
  // entrada: { setores: [{ id, poa }], fora, setorId, pod, cobertura }  (probabilidades entre 0 e 1)
  // saída: { ok: true, q, z, antes, depois, pos, setores: [{ id, poa }], fora } ou { ok: false, motivo }
  //   motivo: 'pod_desconhecido' (não recalcula: pendência), 'setor_fora_do_cenario', 'invalido' (valor fora de 0–1 ou soma ≠ 100%),
  //           'z_zero' (Z = 0: inconsistência; nada muda)
  function posBusca(entrada) {
    var e = entrada || {};
    var lista = e.setores || [];
    var num = function (v) { return v === null || v === undefined || v === '' ? NaN : Number(v); };
    var pod = num(e.pod), cob = e.cobertura == null ? 1 : num(e.cobertura);
    if (isNaN(pod)) return { ok: false, motivo: 'pod_desconhecido' };
    if (!(pod >= 0 && pod <= 1) || !(cob > 0 && cob <= 1)) return { ok: false, motivo: 'invalido' };
    var alvo = lista.find(function (s) { return s.id === e.setorId; });
    if (!alvo) return { ok: false, motivo: 'setor_fora_do_cenario' };
    var soma = 0, valido = true;
    lista.forEach(function (s) { var v = num(s.poa); if (!(v >= 0 && v <= 1)) valido = false; soma += v; });
    var fora = e.fora == null ? 1 - soma : num(e.fora);
    if (!valido || !(fora >= 0 && fora <= 1) || soma + fora < 0.999 || soma + fora > 1.001) return { ok: false, motivo: 'invalido' };
    var q = Math.round(pod * cob * 1e6) / 1e6;
    var r = lista.map(function (s) { return { id: s.id, r: Number(s.poa) * (1 - (s.id === e.setorId ? q : 0)) }; });
    var z = r.reduce(function (a, x) { return a + x.r; }, 0) + fora;
    if (!(z > 0)) return { ok: false, motivo: 'z_zero' };
    var arred = function (x) { return Math.round(x * 1e6) / 1e6; };
    var novos = r.map(function (x) { return { id: x.id, poa: arred(x.r / z) }; });
    var foraNovo = arred(fora / z);
    var diff = arred(1 - foraNovo - novos.reduce(function (a, x) { return a + x.poa; }, 0));
    if (diff !== 0) {
      var maior = novos.reduce(function (m, x) { return m === null || x.poa > m.poa ? x : m; }, null);
      if (maior && maior.poa >= foraNovo) maior.poa = arred(maior.poa + diff); else foraNovo = arred(foraNovo + diff);
    }
    var antes = Number(alvo.poa);
    return { ok: true, q: q, z: z, antes: antes, depois: novos.find(function (x) { return x.id === e.setorId; }).poa, pos: arred(antes * q), setores: novos, fora: foraNovo };
  }

  var alvo = typeof window !== 'undefined' ? window : globalThis;
  alvo.POD = {
    calcular: calcular, acumular: acumular, distribuirPelaArea: distribuirPelaArea,
    sugerirProximaVersao: sugerirProximaVersao, somaPoa: somaPoa, posBusca: posBusca,
    poligonoDoSetor: poligonoDoSetor, sobreposicaoFracao: sobreposicaoFracao, sobreposicoes: sobreposicoes, LIMITE_SOBREPOSICAO: LIMITE_SOBREPOSICAO,
  };
})();
