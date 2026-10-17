/* =====================================================================
 * ipo.js — Informe Padrão de Ocorrência (IPO) do CBMPR.
 *   - campos do IPO que ficam no cadastro da operação (criação e edição)
 *   - limpa os dados antes de salvar (criar_operacao / atualizar_operacao)
 * O que já existe no cadastro (tipo, acionamento, endereço, descrição, fichas de
 * vítima) não se repete aqui. Procedimentos, recursos e desdobramentos vão para o diário.
 * ===================================================================== */
(function (raiz) {
  'use strict';
  var UI = raiz.UI;

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
      coordenadas_referencia: texto(raw.coordenadas_referencia, 80),
      meio_liquido: opcao(MEIOS, raw.meio_liquido),
      pessoas_perdidas: inteiro(raw.pessoas_perdidas, 0, 999),
      buscas_preliminares: opcao(BUSCAS, raw.buscas_preliminares),
      possibilidade_vida: opcao(VIDA, raw.possibilidade_vida),
      bms_envolvidos: inteiro(raw.bms_envolvidos, 0, 999),
      imagens_anexas: raw.imagens_anexas === true ? true : raw.imagens_anexas === false ? false : null,
      responsavel_informacoes: texto(raw.responsavel_informacoes, MAX_LONGO),
    };
  }

  /* ------------------------------ campos ------------------------------ */
  function rotulo(id, t) { return UI.el('label', { classe: 'rotulo', for: id, texto: t }); }
  function campo(id, t, valor, extra) {
    return UI.el('div', { classe: 'grupo' }, [rotulo(id, t),
      UI.el('input', Object.assign({ classe: 'campo', id: id, value: valor == null ? '' : String(valor), maxlength: 200, autocomplete: 'off' }, extra || {}))]);
  }
  function radios(nome, t, lista, marcado) {
    return UI.el('div', { classe: 'grupo' }, [UI.el('span', { classe: 'rotulo', texto: t }),
      UI.el('div', { classe: 'opcoes-ipo' }, lista.map(function (x) {
        return UI.el('label', { classe: 'linha-opcao' }, [UI.el('input', { type: 'radio', name: nome, value: x[0], checked: marcado === x[0] ? true : null }), ' ' + x[1]]);
      }))]);
  }
  function marcado(elemento, nome) {
    var r = elemento.querySelector('input[name="' + nome + '"]:checked');
    return r ? r.value : '';
  }

  // Bloco do IPO dentro do cadastro. Devolve { elemento, ler(), limpar() }.
  // opcoes.prefixo evita ids repetidos entre o cadastro novo e a edição.
  function camposIpo(op, opcoes) {
    op = op || {};
    var atual = normalizarIpo(op.ipo || {});
    var pre = (opcoes && opcoes.prefixo) || 'cad';
    var temDados = Object.keys(op.ipo || {}).length > 0;
    var id = function (s) { return pre + '-ipo-' + s; };

    var campos = {
      destino: UI.el('input', { classe: 'campo', id: id('destino'), maxlength: '120', autocomplete: 'off', value: temDados ? atual.destinatarios : DESTINO_PADRAO }),
      natureza: UI.el('input', { classe: 'campo', id: id('natureza'), maxlength: String(MAX_TEXTO), autocomplete: 'off', placeholder: 'Ex.: BUSCA TERRESTRE/AQUÁTICA – PESSOA', value: atual.natureza }),
      solicNome: UI.el('input', { classe: 'campo', id: id('solic-nome'), maxlength: '120', autocomplete: 'off', value: atual.solicitante_nome }),
      solicDoc: UI.el('input', { classe: 'campo', id: id('solic-doc'), maxlength: '40', autocomplete: 'off', value: atual.solicitante_documento }),
      desap: UI.el('input', { classe: 'campo', id: id('desap'), maxlength: '40', autocomplete: 'off', placeholder: 'dd/mm/aaaa hh:mm', value: atual.desaparecimento }),
      coord: UI.el('input', { classe: 'campo mono', id: id('coord'), maxlength: '80', autocomplete: 'off', placeholder: 'lat, lng', value: atual.coordenadas_referencia }),
      pessoas: UI.el('input', { classe: 'campo', id: id('pessoas'), type: 'number', min: '0', max: '999', value: atual.pessoas_perdidas != null ? atual.pessoas_perdidas : '' }),
      bms: UI.el('input', { classe: 'campo', id: id('bms'), type: 'number', min: '0', max: '999', value: atual.bms_envolvidos != null ? atual.bms_envolvidos : '' }),
      responsavel: UI.el('input', { classe: 'campo', id: id('resp'), maxlength: String(MAX_LONGO), autocomplete: 'off', placeholder: 'Ex.: Sgt. Fulano — equipe GBS', value: atual.responsavel_informacoes }),
    };
    var nomeMeio = pre + '-ipo-meio', nomeBuscas = pre + '-ipo-buscas', nomeVida = pre + '-ipo-vida', nomeImagens = pre + '-ipo-imagens';

    var elemento = UI.el('details', { classe: 'ipo-cadastro', id: id('bloco'), open: temDados ? true : null }, [
      UI.el('summary', null, [UI.el('span', { texto: 'IPO — informe padrão de ocorrência' })]),
      UI.el('p', { classe: 'ajuda', texto: 'Sai no relatório final, no formato do IPO. Localidade, acionamento e contexto são os campos acima. As vítimas são as fichas de vítima.' }),
      UI.el('div', { classe: 'grupo-duplo' }, [
        UI.el('div', { classe: 'grupo' }, [rotulo(id('destino'), 'IPO para (destinatários)'), campos.destino]),
        UI.el('div', { classe: 'grupo' }, [rotulo(id('natureza'), 'Natureza'), campos.natureza]),
      ]),
      UI.el('div', { classe: 'grupo-duplo' }, [
        UI.el('div', { classe: 'grupo' }, [rotulo(id('solic-nome'), 'Nome do solicitante'), campos.solicNome]),
        UI.el('div', { classe: 'grupo' }, [rotulo(id('solic-doc'), 'Documento do solicitante (RG/CPF)'), campos.solicDoc]),
      ]),
      UI.el('div', { classe: 'grupo-duplo' }, [
        UI.el('div', { classe: 'grupo' }, [rotulo(id('desap'), 'Desaparecimento (último horário visto)'), campos.desap]),
        UI.el('div', { classe: 'grupo' }, [rotulo(id('coord'), 'Coordenadas do último avistamento'), campos.coord]),
      ]),
      radios(nomeMeio, 'Tipo de meio líquido', MEIOS, atual.meio_liquido),
      UI.el('div', { classe: 'grupo-duplo' }, [
        UI.el('div', { classe: 'grupo' }, [rotulo(id('pessoas'), 'Nº de pessoas perdidas'), campos.pessoas]),
        UI.el('div', { classe: 'grupo' }, [rotulo(id('bms'), 'BMs diretamente envolvidos'), campos.bms]),
      ]),
      radios(nomeBuscas, 'Buscas preliminares (casas de parentes, hospitais etc.)?', BUSCAS, atual.buscas_preliminares),
      radios(nomeVida, 'Possibilidade real de vida?', VIDA, atual.possibilidade_vida),
      radios(nomeImagens, 'Imagens anexas junto a esta mensagem?', [['sim', 'Sim'], ['nao', 'Não']],
        atual.imagens_anexas === true ? 'sim' : atual.imagens_anexas === false ? 'nao' : ''),
      UI.el('div', { classe: 'grupo' }, [rotulo(id('resp'), 'Responsável pelas informações'), campos.responsavel]),
    ]);

    function ler() {
      var imagens = marcado(elemento, nomeImagens);
      return normalizarIpo({
        destinatarios: campos.destino.value,
        natureza: campos.natureza.value,
        solicitante_nome: campos.solicNome.value,
        solicitante_documento: campos.solicDoc.value,
        desaparecimento: campos.desap.value,
        coordenadas_referencia: campos.coord.value,
        meio_liquido: marcado(elemento, nomeMeio),
        pessoas_perdidas: campos.pessoas.value,
        buscas_preliminares: marcado(elemento, nomeBuscas),
        possibilidade_vida: marcado(elemento, nomeVida),
        bms_envolvidos: campos.bms.value,
        imagens_anexas: imagens === 'sim' ? true : imagens === 'nao' ? false : null,
        responsavel_informacoes: campos.responsavel.value,
      });
    }

    function limpar() {
      campos.destino.value = DESTINO_PADRAO;
      Object.keys(campos).forEach(function (k) { if (k !== 'destino') campos[k].value = ''; });
      elemento.querySelectorAll('input[type="radio"]').forEach(function (r) { r.checked = false; });
    }

    return { elemento: elemento, ler: ler, limpar: limpar };
  }

  raiz.Ipo = {
    normalizarIpo: normalizarIpo, camposIpo: camposIpo,
    MEIOS: MEIOS, BUSCAS: BUSCAS, VIDA: VIDA, PROCEDIMENTOS: PROCEDIMENTOS, DESTINO_PADRAO: DESTINO_PADRAO,
  };
})(typeof window !== 'undefined' ? window : globalThis);
