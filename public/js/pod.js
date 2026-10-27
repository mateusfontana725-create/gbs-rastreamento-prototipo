/*
 * Probabilidades de busca: POA, POD e POS. Cálculo puro, sem tela (testado em testes/pod.test.js).
 *
 * De onde vem cada número:
 *   - POA (probabilidade de a pessoa estar no setor): decisão do responsável, por vítima, guardada
 *     numa versão APROVADA do cenário (com justificativa). O app nunca estima o POA inicial sozinho.
 *   - POD (probabilidade de a busca achar a pessoa, SE ela estiver no setor): vem do registro manual
 *     da busca. Nunca do GPS: a trilha mostra por onde a equipe passou, não o que ela observou.
 *
 * O que o app calcula a partir deles (Koopman, "Search and Screening", 1980; IAMSAR, vol. II):
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
   *   cenario:   { id, numero, aprovadaEm (ms), setores: [{ setorId, nome, poa }] }   (versão APROVADA)
   *   registros: [{ id, setorId, vitimaId (nulo = todas), pod (0–1), registradoEm (ms), anulado (bool) }]
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
      else if (cen.aprovadaEm != null && r.registradoEm < cen.aprovadaEm) motivo = 'anterior_a_versao';
      return { id: r.id, setorId: r.setorId, conta: motivo === null, motivo: motivo, pod: limitar01(Number(r.pod) || 0),
        pos: 0, poaAntes: null, poaDepois: null, _r: r };
    });

    // Bayes em sequência: q = probabilidade atual (já normalizada) de cada setor e de "fora"
    var q = {};
    ativos.forEach(function (s) { q[s.setorId] = Number(s.poa) || 0; });
    var qFora = poaFora;
    var podsDoSetor = {};
    resRegistros.forEach(function (x) {
      if (!x.conta) return;
      var antes = q[x.setorId];
      x.poaAntes = antes;
      x.pos = antes * x.pod;                       // chance de achar nesta busca (dado que ainda não foi achada)
      q[x.setorId] = antes * (1 - x.pod);
      var z = qFora;
      Object.keys(q).forEach(function (id) { z += q[id]; });
      if (z > 0) {
        Object.keys(q).forEach(function (id) { q[id] /= z; });
        qFora /= z;
      }
      x.poaDepois = q[x.setorId];
      (podsDoSetor[x.setorId] = podsDoSetor[x.setorId] || []).push(x.pod);
    });

    var posTotal = 0;
    var resSetores = ativos.map(function (s) {
      var podAcum = podsDoSetor[s.setorId] ? acumular(podsDoSetor[s.setorId]) : null;
      var pos = (Number(s.poa) || 0) * (podAcum || 0);
      posTotal += pos;
      return { setorId: s.setorId, nome: s.nome, poa: Number(s.poa) || 0, pod: podAcum, pos: pos, poaAtual: q[s.setorId],
        registros: podsDoSetor[s.setorId] ? podsDoSetor[s.setorId].length : 0 };
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

  var alvo = typeof window !== 'undefined' ? window : globalThis;
  alvo.POD = {
    calcular: calcular, acumular: acumular, distribuirPelaArea: distribuirPelaArea,
    sugerirProximaVersao: sugerirProximaVersao, somaPoa: somaPoa,
  };
})();
