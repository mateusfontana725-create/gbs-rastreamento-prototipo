/* =====================================================================
 * ipo.js — Informe Padrão de Ocorrência (IPO) do CBMPR.
 *   - define os campos e limpa os dados antes de salvar (salvar_ipo_operacao)
 *   - editor em modal, aberto pelo menu "IPO" da operação
 * O relatório final (relatorio-pdf.js) monta o IPO com estes mesmos campos.
 * ===================================================================== */
(function (raiz) {
  'use strict';
  var C = raiz.Comunicacao, UI = raiz.UI;

  var DESTINO_PADRAO = '2 CRBM / 3 BBM';
  var MEIOS = [['mar', 'Mar'], ['rio', 'Rio'], ['lago', 'Lago/represa/tanque'], ['cachoeira', 'Cachoeira']];
  var BUSCAS = [['sim', 'Sim'], ['nao', 'Não'], ['ainda_nao', 'Ainda não foi possível'], ['sem_necessidade', 'Sem necessidade (vítimas certamente perdidas)']];
  var VIDA = [['sim', 'Sim'], ['nao_corpo', 'Não - busca de corpo'], ['desconhecido', 'Não sabido']];
  var PROCEDIMENTOS = [
    ['scuba', 'Mergulho com equipamento SCUBA'], ['livre', 'Mergulho livre'], ['rede', 'Rede de busca/garatéia'],
    ['superficie', 'Busca de superfície com embarcações'], ['margens', 'Busca terrestre nas margens/areia'], ['aeronave', 'Busca com aeronave'],
  ];
  var MAX_VITIMAS = 10, MAX_TEXTO = 1000, MAX_LONGO = 4000;

  function opcao(lista, valor) { return lista.some(function (x) { return x[0] === valor; }) ? valor : ''; }
  function texto(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
  function textoLongo(v) { return String(v == null ? '' : v).trim().slice(0, MAX_LONGO); }
  function inteiro(v, min, max) {
    var n = parseInt(v, 10);
    return isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  }

  // Dados do formulário → objeto limpo, com tudo dentro dos limites que o banco aceita.
  function normalizarIpo(raw) {
    raw = raw || {};
    var vitimas = (Array.isArray(raw.vitimas) ? raw.vitimas : []).slice(0, MAX_VITIMAS).map(function (v) {
      return { nome: texto(v.nome, 120), nascimento: texto(v.nascimento, 20), sexo: opcao([['M', ''], ['F', '']], v.sexo) || '',
        idade: inteiro(v.idade, 0, 130), origem: texto(v.origem, 120) };
    }).filter(function (v) { return v.nome || v.nascimento || v.origem || v.idade != null; });
    var procedimentos = (Array.isArray(raw.procedimentos) ? raw.procedimentos : [])
      .filter(function (p) { return PROCEDIMENTOS.some(function (x) { return x[0] === p; }); });
    return {
      destinatarios: texto(raw.destinatarios, 120) || DESTINO_PADRAO,
      natureza: texto(raw.natureza, MAX_TEXTO),
      localidade: texto(raw.localidade, MAX_TEXTO),
      solicitante_nome: texto(raw.solicitante_nome, 120),
      solicitante_documento: texto(raw.solicitante_documento, 40),
      inicio_operacoes: texto(raw.inicio_operacoes, 40),
      coordenadas_referencia: texto(raw.coordenadas_referencia, 80),
      desaparecimento: texto(raw.desaparecimento, 40),
      meio_liquido: opcao(MEIOS, raw.meio_liquido),
      pessoas_perdidas: inteiro(raw.pessoas_perdidas, 0, 999),
      vitimas: vitimas,
      buscas_preliminares: opcao(BUSCAS, raw.buscas_preliminares),
      possibilidade_vida: opcao(VIDA, raw.possibilidade_vida),
      procedimentos: procedimentos,
      contexto: textoLongo(raw.contexto),
      recursos: textoLongo(raw.recursos),
      bms_envolvidos: inteiro(raw.bms_envolvidos, 0, 999),
      desdobramentos: textoLongo(raw.desdobramentos),
      imagens_anexas: raw.imagens_anexas === true ? true : raw.imagens_anexas === false ? false : null,
      responsavel_informacoes: texto(raw.responsavel_informacoes, 160),
    };
  }

  /* ------------------------------ editor ------------------------------ */
  function rotulo(id, t) { return UI.el('label', { classe: 'rotulo', for: id, texto: t }); }
  function campo(id, t, valor, extra) {
    return UI.el('div', { classe: 'grupo' }, [rotulo(id, t),
      UI.el('input', Object.assign({ classe: 'campo', id: id, value: valor == null ? '' : String(valor), maxlength: 200, autocomplete: 'off' }, extra || {}))]);
  }
  function areaTexto(id, t, valor, linhas) {
    return UI.el('div', { classe: 'grupo' }, [rotulo(id, t),
      UI.el('textarea', { classe: 'campo', id: id, rows: linhas || 3, maxlength: MAX_LONGO, texto: valor || '' })]);
  }
  function radios(nome, t, lista, marcado) {
    return UI.el('div', { classe: 'grupo' }, [UI.el('span', { classe: 'rotulo', texto: t }),
      UI.el('div', { classe: 'opcoes-ipo' }, lista.map(function (x) {
        return UI.el('label', { classe: 'linha-opcao' }, [UI.el('input', { type: 'radio', name: nome, value: x[0], checked: marcado === x[0] ? true : null }), ' ' + x[1]]);
      }))]);
  }
  function caixas(nome, t, lista, marcados) {
    return UI.el('div', { classe: 'grupo' }, [UI.el('span', { classe: 'rotulo', texto: t }),
      UI.el('div', { classe: 'opcoes-ipo' }, lista.map(function (x) {
        return UI.el('label', { classe: 'linha-opcao' }, [UI.el('input', { type: 'checkbox', name: nome, value: x[0], checked: marcados.indexOf(x[0]) >= 0 ? true : null }), ' ' + x[1]]);
      }))]);
  }

  function linhaVitima(v) {
    var linha = UI.el('div', { classe: 'ipo-vitima' }, [
      UI.el('div', { classe: 'grade-ipo' }, [
        UI.el('input', { classe: 'campo', name: 'v-nome', placeholder: 'Nome', maxlength: 120, value: v.nome || '' }),
        UI.el('input', { classe: 'campo', name: 'v-nasc', placeholder: 'Nascimento (dd/mm/aaaa)', maxlength: 20, value: v.nascimento || '' }),
        UI.el('select', { classe: 'campo', name: 'v-sexo', 'aria-label': 'Sexo' }, [
          UI.el('option', { value: '', texto: 'Sexo' }), UI.el('option', { value: 'M', selected: v.sexo === 'M' ? true : null, texto: 'Masculino' }),
          UI.el('option', { value: 'F', selected: v.sexo === 'F' ? true : null, texto: 'Feminino' })]),
        UI.el('input', { classe: 'campo', name: 'v-idade', type: 'number', min: 0, max: 130, placeholder: 'Idade', value: v.idade != null ? v.idade : '' }),
        UI.el('input', { classe: 'campo', name: 'v-origem', placeholder: 'Origem (cidade/bairro)', maxlength: 120, value: v.origem || '' }),
      ]),
      UI.el('button', { classe: 'btn btn-pequeno btn-perigo', type: 'button', texto: 'Remover', onclick: function () { linha.remove(); } }),
    ]);
    return linha;
  }

  function lerVitimas(form) {
    return Array.prototype.map.call(form.querySelectorAll('.ipo-vitima'), function (l) {
      return { nome: l.querySelector('[name="v-nome"]').value, nascimento: l.querySelector('[name="v-nasc"]').value,
        sexo: l.querySelector('[name="v-sexo"]').value, idade: l.querySelector('[name="v-idade"]').value, origem: l.querySelector('[name="v-origem"]').value };
    });
  }

  function marcado(form, nome) {
    var r = form.querySelector('input[name="' + nome + '"]:checked');
    return r ? r.value : '';
  }

  function abrirEditor(op, aoSalvar) {
    var atual = op && op.ipo && typeof op.ipo === 'object' ? op.ipo : {};
    var prefill = {
      destinatarios: atual.destinatarios || DESTINO_PADRAO,
      natureza: atual.natureza || '',
      localidade: atual.localidade != null && atual.localidade !== '' ? atual.localidade : (op && op.local_endereco) || '',
      coordenadas_referencia: atual.coordenadas_referencia || (op && op.local_lat != null ? op.local_lat + ', ' + op.local_lng : ''),
    };
    var vitimas = (atual.vitimas && atual.vitimas.length ? atual.vitimas : [{}]).map(function (v) { return v; });
    var lista = UI.el('div', { classe: 'ipo-vitimas' }, vitimas.map(linhaVitima));
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btnSalvar = UI.el('button', { classe: 'btn btn-primario', type: 'submit', texto: 'Salvar IPO' });
    var form = UI.el('form', { novalidate: true, classe: 'form-ipo' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Informe Padrão de Ocorrência (IPO)' }),
      UI.el('p', { classe: 'ajuda', texto: 'Estes dados saem no relatório final, no formato do IPO. O que já está no sistema (acionamento, local e coordenadas do cadastro) aparece preenchido ou automaticamente.' }),
      campo('ipo-destino', 'IPO para (destinatários)', prefill.destinatarios),
      campo('ipo-natureza', 'Natureza', prefill.natureza, { placeholder: 'Ex.: BUSCA TERRESTRE/AQUÁTICA – PESSOA' }),
      areaTexto('ipo-localidade', 'Localidade / município / região (ponto de referência)', prefill.localidade, 2),
      campo('ipo-solic-nome', 'Nome do solicitante', atual.solicitante_nome),
      campo('ipo-solic-doc', 'Documento do solicitante (RG/CPF)', atual.solicitante_documento),
      UI.el('h3', { texto: 'Vítima(s)' }),
      lista,
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '+ Adicionar vítima', onclick: function () {
        if (lista.querySelectorAll('.ipo-vitima').length < MAX_VITIMAS) lista.appendChild(linhaVitima({}));
      } }),
      UI.el('h3', { texto: 'Ocorrência' }),
      campo('ipo-inicio', 'Data/hora do início das operações', atual.inicio_operacoes, { placeholder: 'dd/mm/aaaa hh:mm' }),
      campo('ipo-desap', 'Data/horário provável do desaparecimento (último horário visto)', atual.desaparecimento, { placeholder: 'dd/mm/aaaa hh:mm' }),
      campo('ipo-coord', 'Coordenadas de referência (último avistamento)', atual.coordenadas_referencia || prefill.coordenadas_referencia, { placeholder: 'lat, lng' }),
      radios('ipo-meio', 'Tipo de meio líquido', MEIOS, atual.meio_liquido || ''),
      campo('ipo-pessoas', 'Nº de pessoas perdidas', atual.pessoas_perdidas != null ? atual.pessoas_perdidas : '', { type: 'number', min: 0, max: 999 }),
      radios('ipo-buscas', 'Buscas preliminares (casas de parentes, hospitais etc.)?', BUSCAS, atual.buscas_preliminares || ''),
      radios('ipo-vida', 'Possibilidade real de vida?', VIDA, atual.possibilidade_vida || ''),
      UI.el('h3', { texto: 'Operação' }),
      caixas('ipo-proc', 'Procedimentos de busca sendo realizados', PROCEDIMENTOS, atual.procedimentos || []),
      areaTexto('ipo-contexto', 'Contexto / histórico / cenário do desaparecimento', atual.contexto, 4),
      areaTexto('ipo-recursos', 'Recursos do CB deslocados e em uso (uma linha por recurso)', atual.recursos, 3),
      campo('ipo-bms', 'Quantidade de BMs diretamente envolvidos', atual.bms_envolvidos != null ? atual.bms_envolvidos : '', { type: 'number', min: 0, max: 999 }),
      areaTexto('ipo-desdobramentos', 'Desdobramentos / situação atual (por dia)', atual.desdobramentos, 4),
      radios('ipo-imagens', 'Imagens anexas junto a esta mensagem?', [['sim', 'Sim'], ['nao', 'Não']], atual.imagens_anexas === true ? 'sim' : atual.imagens_anexas === false ? 'nao' : ''),
      campo('ipo-resp', 'Responsável pelas informações', atual.responsavel_informacoes, { placeholder: 'Ex.: Sgt. Fulano — equipe GBS' }),
      erro,
      UI.el('div', { classe: 'modal-acoes' }, [
        UI.el('button', { classe: 'btn', type: 'button', id: 'ipo-cancelar', texto: 'Cancelar' }),
        btnSalvar,
      ]),
    ]);

    var fechar = UI.abrirModal(form, { fecharNoFundo: false });
    form.querySelector('#ipo-cancelar').addEventListener('click', function () { fechar(); });
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var v = function (id) { return form.querySelector('#' + id).value; };
      var dados = normalizarIpo({
        destinatarios: v('ipo-destino'), natureza: v('ipo-natureza'), localidade: v('ipo-localidade'),
        solicitante_nome: v('ipo-solic-nome'), solicitante_documento: v('ipo-solic-doc'),
        vitimas: lerVitimas(form), inicio_operacoes: v('ipo-inicio'), desaparecimento: v('ipo-desap'),
        coordenadas_referencia: v('ipo-coord'), meio_liquido: marcado(form, 'ipo-meio'),
        pessoas_perdidas: v('ipo-pessoas'), buscas_preliminares: marcado(form, 'ipo-buscas'),
        possibilidade_vida: marcado(form, 'ipo-vida'),
        procedimentos: Array.prototype.map.call(form.querySelectorAll('input[name="ipo-proc"]:checked'), function (c) { return c.value; }),
        contexto: v('ipo-contexto'), recursos: v('ipo-recursos'), bms_envolvidos: v('ipo-bms'),
        desdobramentos: v('ipo-desdobramentos'),
        imagens_anexas: marcado(form, 'ipo-imagens') === 'sim' ? true : marcado(form, 'ipo-imagens') === 'nao' ? false : null,
        responsavel_informacoes: v('ipo-resp'),
      });
      btnSalvar.disabled = true;
      try {
        var r = await C.rpc('salvar_ipo_operacao', { p_operacao: op.id, p_ipo: dados });
        if (aoSalvar) aoSalvar(r && r.ipo ? r.ipo : dados);
        UI.aviso('IPO salvo. Ele sai no próximo relatório final.', 'ok', 6000);
        fechar();
      } catch (e) {
        erro.textContent = e.message || 'Não foi possível salvar o IPO.';
        erro.hidden = false;
      } finally {
        btnSalvar.disabled = false;
      }
    });
    setTimeout(function () { form.querySelector('#ipo-destino').focus(); }, 40);
  }

  raiz.Ipo = { normalizarIpo: normalizarIpo, abrirEditor: abrirEditor, MEIOS: MEIOS, BUSCAS: BUSCAS, VIDA: VIDA, PROCEDIMENTOS: PROCEDIMENTOS, DESTINO_PADRAO: DESTINO_PADRAO };
})(typeof window !== 'undefined' ? window : globalThis);
