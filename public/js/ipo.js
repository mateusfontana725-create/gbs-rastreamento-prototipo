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
  var VIDA = [['sim', 'Sim'], ['nao_corpo', 'Não - busca de corpo'], ['desconhecido', 'Não apurado']];
  var PROCEDIMENTOS = [
    ['scuba', 'Mergulho com equipamento SCUBA'], ['livre', 'Mergulho livre'], ['rede', 'Rede de busca/garatéia'],
    ['superficie', 'Busca de superfície com embarcações'], ['margens', 'Busca terrestre nas margens/areia'], ['aeronave', 'Busca com aeronave'],
  ];
  // Natureza da ocorrência: escolha numa lista; "Outra" abre um campo para descrever.
  var NATUREZAS = ['BUSCA TERRESTRE – PESSOA', 'BUSCA AQUÁTICA – PESSOA', 'BUSCA TERRESTRE/AQUÁTICA – PESSOA', 'BUSCA AÉREA – PESSOA', 'RESGATE'];
  var OUTRA_NATUREZA = '__outra__';
  // Perfis da vítima (estudos): valores fixos gravados no banco; o formulário só seleciona.
  var PERFIS_VITIMA = [['idoso', 'Idoso'], ['crianca', 'Criança'], ['adolescente', 'Adolescente'], ['demencia', 'Alzheimer / demência'],
    ['autismo', 'Autismo (TEA)'], ['deficiencia_intelectual', 'Deficiência intelectual'], ['transtorno_mental', 'Transtorno mental'], ['outro', 'Outro']];
  var MAX_TEXTO = 300, MAX_LONGO = 1000;

  // Natureza → tipo da operação (o tipo não é mais escolhido à parte: vem da natureza)
  function semAcento(t) { return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase(); }
  function ehAquatica(natureza) { return semAcento(natureza).indexOf('AQUATIC') >= 0; }
  function tipoDaNatureza(natureza) {
    var limpo = String(natureza || '').replace(/\s+/g, ' ').trim();
    var t = semAcento(limpo);
    if (!limpo) return { tipo: null, tipo_outro: null };
    if (t.indexOf('AQUATIC') >= 0) return { tipo: 'aquatica', tipo_outro: null };
    if (t.indexOf('TERRESTRE') >= 0) return { tipo: 'terrestre', tipo_outro: null };
    if (t.indexOf('AEREA') >= 0 || t.indexOf('AEREO') >= 0) return { tipo: 'aerea', tipo_outro: null };
    return { tipo: 'outras', tipo_outro: limpo.slice(0, 60) };
  }
  // Data e hora (campo datetime-local) → ISO; vazio ou inválido → ''
  function dataIso(v) {
    var t = String(v || '').trim();
    if (!t) return '';
    var d = new Date(t);
    return isNaN(d) ? '' : d.toISOString();
  }

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
      desaparecimento: dataIso(raw.desaparecimento),
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
    NATUREZAS: NATUREZAS, OUTRA_NATUREZA: OUTRA_NATUREZA, PERFIS_VITIMA: PERFIS_VITIMA,
    ehAquatica: ehAquatica, tipoDaNatureza: tipoDaNatureza,
  };
})(typeof window !== 'undefined' ? window : globalThis);
