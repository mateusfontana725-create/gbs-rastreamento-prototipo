/* =====================================================================
 * ipo.js — Informe Padrão de Ocorrência (IPO) do CBMPR: listas de opções e limpeza dos
 * dados antes de salvar. Os campos ficam no próprio cadastro da operação (cadastro.js),
 * que é o mesmo formulário do IPO. Procedimentos, recursos e desdobramentos vão para o diário.
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var DESTINO_PADRAO = '2 CRBM / 3 BBM';
  var MEIOS = [['mar', 'Mar'], ['rio', 'Rio'], ['lago', 'Lago/represa/tanque'], ['cachoeira', 'Cachoeira']];
  var BUSCAS = [['sim', 'Sim'], ['nao', 'Não'], ['ainda_nao', 'Ainda não foi possível'], ['sem_necessidade', 'Sem necessidade (vítimas certamente perdidas)']];
  var VIDA = [['sim', 'Sim'], ['nao_corpo', 'Não - busca de corpo'], ['desconhecido', 'Não sabido']];
  var PROCEDIMENTOS = [
    ['scuba', 'Mergulho com equipamento SCUBA'], ['livre', 'Mergulho livre'], ['rede', 'Rede de busca/garatéia'],
    ['superficie', 'Busca de superfície com embarcações'], ['margens', 'Busca terrestre nas margens/areia'], ['aeronave', 'Busca com aeronave'],
  ];
  var MAX_TEXTO = 300, MAX_LONGO = 1000;

  function opcao(lista, valor) { return lista.some(function (x) { return x[0] === valor; }) ? valor : ''; }
  function texto(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
  function inteiro(v, min, max) {
    var n = parseInt(v, 10);
    return isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  }

  // Dados do formulário → objeto limpo, com tudo dentro dos limites que o banco aceita.
  function normalizarIpo(raw) {
    raw = raw || {};
    return {
      destinatarios: texto(raw.destinatarios, 120) || DESTINO_PADRAO,
      natureza: texto(raw.natureza, MAX_TEXTO),
      solicitante_nome: texto(raw.solicitante_nome, 120),
      solicitante_documento: texto(raw.solicitante_documento, 40),
      desaparecimento: texto(raw.desaparecimento, 40),
      meio_liquido: opcao(MEIOS, raw.meio_liquido),
      pessoas_perdidas: inteiro(raw.pessoas_perdidas, 0, 999),
      buscas_preliminares: opcao(BUSCAS, raw.buscas_preliminares),
      possibilidade_vida: opcao(VIDA, raw.possibilidade_vida),
      bms_envolvidos: inteiro(raw.bms_envolvidos, 0, 999),
      imagens_anexas: raw.imagens_anexas === true ? true : raw.imagens_anexas === false ? false : null,
      responsavel_informacoes: texto(raw.responsavel_informacoes, MAX_LONGO),
    };
  }

  raiz.Ipo = {
    normalizarIpo: normalizarIpo,
    MEIOS: MEIOS, BUSCAS: BUSCAS, VIDA: VIDA, PROCEDIMENTOS: PROCEDIMENTOS, DESTINO_PADRAO: DESTINO_PADRAO,
  };
})(typeof window !== 'undefined' ? window : globalThis);
