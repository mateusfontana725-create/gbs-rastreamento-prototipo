/* =====================================================================
 * ipo-form.js — tela do IPO (Informe Padrão de Ocorrência do CBMPR), num lugar só e na ordem do informe.
 *   Antes o IPO ficava espalhado: parte no cadastro da operação, parte nas fichas das vítimas e os procedimentos,
 *   recursos e desdobramentos em registros soltos do diário. Esta tela junta tudo, com atalhos:
 *     - efetivo de cada dia preenchido pelos militares que estiveram no app naquele dia;
 *     - recursos preenchidos pelo quadro de recursos do SCI;
 *     - desdobramento do dia com um toque ("+ Hoje");
 *     - "Copiar para o WhatsApp": o texto pronto, no formato usado nos grupos (Ipo.textoWhatsApp).
 *   Grava em operacoes.ipo (salvar_ipo_operacao). A natureza e o início das operações continuam no cadastro
 *   (mudam o tipo da operação). Registros antigos do diário (procedimento, recurso, desdobramento) continuam valendo:
 *   entram no informe junto com o que for escrito aqui.
 *   API: window.IpoForm = { abrir(op, opcoes), copiar(op) }.
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI, I = window.Ipo;
  if (!C || !UI || !I) return;
  var el = UI.el;

  function dd(n) { return (n < 10 ? '0' : '') + n; }
  function hojeLocal() { var d = new Date(); return d.getFullYear() + '-' + dd(d.getMonth() + 1) + '-' + dd(d.getDate()); }
  function diaDe(ms) { var d = new Date(ms); return d.getFullYear() + '-' + dd(d.getMonth() + 1) + '-' + dd(d.getDate()); }
  function paraCampoData(v) {
    var ms = C.paraMs(v);
    if (ms == null) return '';
    var d = new Date(ms);
    return d.getFullYear() + '-' + dd(d.getMonth() + 1) + '-' + dd(d.getDate()) + 'T' + dd(d.getHours()) + ':' + dd(d.getMinutes());
  }
  function isoLocal(v) { if (!v) return ''; var d = new Date(v); return isNaN(d) ? '' : d.toISOString(); }
  function coordTexto(lat, lng) { return window.Coords ? window.Coords.formatar(lat, lng, 'gms') : Number(lat).toFixed(6) + ', ' + Number(lng).toFixed(6); }

  // Fichas das vítimas e os registros do diário que entram no IPO (procedimento, recurso, desdobramento)
  async function dadosExtras(op) {
    var r = await Promise.all([
      C.consultar(C.cliente.from('vitimas').select('*').eq('operacao_id', op.id).order('criado_em', { ascending: true })).catch(function () { return []; }),
      C.consultar(C.cliente.from('diario').select('id,tipo,ref_id,detalhe,ocorrido_em').eq('operacao_id', op.id)
        .in('tipo', ['procedimento', 'recurso', 'desdobramento']).order('ocorrido_em', { ascending: true })).catch(function () { return []; }),
    ]);
    return { vitimas: r[0] || [], diario: r[1] || [], coordenada: coordTexto };
  }

  function copiarTexto(texto) {
    return navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(texto).then(function () { return true; }, function () { return false; }) : Promise.resolve(false);
  }
  // Mostra o texto pronto (dá para conferir e copiar à mão no celular) e tenta copiar sozinho.
  async function mostrarTexto(texto) {
    var area = el('textarea', { classe: 'campo mono ipo-texto', id: 'ipo-texto', rows: '18', readonly: true, 'aria-label': 'Texto do IPO' });
    area.value = texto;
    var copiou = await copiarTexto(texto);
    var fechar = UI.abrirModal(el('div', { classe: 'form-padrao' }, [
      el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'IPO para o WhatsApp' }, [UI.dica('O asterisco deixa o texto em negrito no WhatsApp. Confira e cole no grupo.')]),
      el('p', { classe: copiou ? 'nota' : 'muted', texto: copiou ? 'Texto copiado. É só colar no grupo.' : 'Toque em Copiar (ou selecione o texto abaixo e copie).' }),
      area,
      UI.rodape([
        el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
        el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Copiar', onclick: async function () {
          if (await copiarTexto(area.value)) UI.aviso('IPO copiado.', 'ok');
          else { area.focus(); area.select(); UI.aviso('Selecionado: use Copiar do celular.', 'ok'); }
        } }),
      ]),
    ]), { empilhar: true, tamanho: 'largo' });
  }

  async function copiar(op) {
    try { await mostrarTexto(I.textoWhatsApp(op, await dadosExtras(op))); }
    catch (e) { UI.aviso('Não foi possível montar o IPO: ' + (e.message || e), 'erro', 7000); }
  }

  // Efetivo de cada dia pelos militares (e responsáveis) que mandaram posição pelo app naquele dia.
  function efetivoPeloApp() {
    var P = window.Painel;
    if (!P || !P.participantes) return [];
    var porDia = {};
    P.participantes().forEach(function (p) {
      var d = p.dados || {};
      if (d.tipo !== 'militar' && d.tipo !== 'responsavel') return;
      var nome = String(d.nome_painel || d.nome || '').trim();
      var dias = {};
      (p.pontos || []).forEach(function (pt) { if (pt.t) dias[diaDe(pt.t)] = true; });
      if (!Object.keys(dias).length && d.criado_em) dias[diaDe(C.paraMs(d.criado_em))] = true;
      Object.keys(dias).forEach(function (k) { (porDia[k] = porDia[k] || []).push(nome); });
    });
    return Object.keys(porDia).sort().map(function (k) {
      var nomes = porDia[k].sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); });
      return { dia: k, qtd: nomes.length, nomes: nomes.length > 1 ? nomes.slice(0, -1).join(', ') + ' e ' + nomes[nomes.length - 1] : nomes[0] };
    });
  }
  // Recursos do quadro do SCI (migração 080) que não foram desmobilizados
  async function recursosDoSci(op) {
    var r = await C.consultar(C.cliente.from('sci2_recursos').select('nome,quantidade,instituicao,situacao').eq('operacao_id', op.id).order('criado_em', { ascending: true }));
    return (r || []).filter(function (x) { return x.situacao !== 'desmobilizado'; })
      .map(function (x) { return x.nome + (x.quantidade > 1 ? ' ×' + x.quantidade : '') + (x.instituicao ? ' - ' + x.instituicao : '') + '.'; });
  }

  // Lista editável por dia (efetivo ou desdobramentos). campos: [{ chave, tipo: 'qtd'|'texto'|'area', rotulo, ph }]
  function listaDias(itens, campos, rotuloNovo) {
    var caixa = el('div', { classe: 'ipo-dias' });
    var linhas = [];
    function linha(x) {
      var dia = el('input', { classe: 'campo', type: 'date', value: x.dia || hojeLocal(), 'aria-label': 'Dia' });
      var ctrls = {};
      var celulas = [el('div', { classe: 'ipo-dia-data' }, [dia])];
      campos.forEach(function (c) {
        var ctl = c.tipo === 'area' ? el('textarea', { classe: 'campo', rows: '3', maxlength: '4000', placeholder: c.ph || '', 'aria-label': c.rotulo })
          : el('input', { classe: 'campo' + (c.tipo === 'qtd' ? ' ipo-qtd' : ''), type: c.tipo === 'qtd' ? 'number' : 'text', min: c.tipo === 'qtd' ? '0' : null, max: c.tipo === 'qtd' ? '999' : null,
            inputmode: c.tipo === 'qtd' ? 'numeric' : null, maxlength: c.tipo === 'qtd' ? null : '1000', placeholder: c.ph || '', 'aria-label': c.rotulo });
        ctl.value = x[c.chave] != null ? String(x[c.chave]) : '';
        ctrls[c.chave] = ctl;
        celulas.push(el('div', { classe: 'ipo-dia-' + c.chave }, [ctl]));
      });
      var reg = { dia: dia, ctrls: ctrls };
      var tirar = el('button', { classe: 'btn btn-pequeno ipo-dia-tirar', type: 'button', texto: '✕', 'aria-label': 'Tirar este dia', onclick: function () {
        linhas = linhas.filter(function (l) { return l !== reg; }); no.remove();
      } });
      var no = el('div', { classe: 'ipo-dia ipo-dia-' + campos.map(function (c) { return c.tipo; }).join('-') }, celulas.concat([tirar]));
      reg.no = no;
      linhas.push(reg);
      caixa.appendChild(no);
      return reg;
    }
    (itens || []).forEach(linha);
    var api = {
      elemento: el('div', null, [caixa]),
      ler: function () {
        return linhas.map(function (l) {
          var r = { dia: l.dia.value };
          campos.forEach(function (c) { r[c.chave] = l.ctrls[c.chave].value; });
          return r;
        });
      },
      adicionar: function (x) { var r = linha(x || {}); var prim = r.ctrls[campos[campos.length - 1].chave]; setTimeout(function () { prim.focus(); }, 30); return r; },
      // completa os dias que ainda não têm linha (não mexe no que já foi escrito)
      completar: function (lista) {
        var tem = {};
        linhas.forEach(function (l) { tem[l.dia.value] = l; });
        var n = 0;
        lista.forEach(function (x) {
          var l = tem[x.dia];
          if (!l) { linha(x); n++; return; }
          var vazio = campos.every(function (c) { return !String(l.ctrls[c.chave].value || '').trim(); });
          if (vazio) { campos.forEach(function (c) { l.ctrls[c.chave].value = x[c.chave] != null ? String(x[c.chave]) : ''; }); n++; }
        });
        // em ordem de dia
        linhas.sort(function (a, b) { return a.dia.value < b.dia.value ? -1 : a.dia.value > b.dia.value ? 1 : 0; }).forEach(function (l) { caixa.appendChild(l.no); });
        return n;
      },
    };
    api.botaoNovo = el('button', { classe: 'btn btn-pequeno', type: 'button', texto: rotuloNovo || '+ Dia', onclick: function () { api.adicionar({ dia: hojeLocal() }); } });
    return api;
  }

  function radios(nome, lista, marcado) {
    return el('div', { classe: 'opcoes-ipo', role: 'radiogroup' }, lista.map(function (x) {
      return el('label', { classe: 'linha-opcao' }, [el('input', { type: 'radio', name: nome, value: x[0], checked: marcado === x[0] ? true : null }), ' ' + x[1]]);
    }));
  }
  function marcadoEm(raiz, nome) { var r = raiz.querySelector('input[name="' + nome + '"]:checked'); return r ? r.value : ''; }

  async function abrir(op, opcoes) {
    opcoes = opcoes || {};
    if (!op) return;
    var editavel = opcoes.editavel !== false;
    var ipo = I.normalizarIpo(op.ipo || {});
    var extra;
    try { extra = await dadosExtras(op); } catch (e) { extra = { vitimas: [], diario: [], coordenada: coordTexto }; }
    var vit = extra.vitimas;

    // cabeçalho
    var destino = el('input', { classe: 'campo', id: 'ipo-destino', maxlength: '120', value: ipo.destinatarios, placeholder: I.DESTINO_PADRAO });
    var unidade = el('input', { classe: 'campo', id: 'ipo-unidade', maxlength: '120', value: ipo.unidade, placeholder: 'Ex.: 3º BBM/2ª CBM/3º PBM - Rolândia' });
    var rgo = el('input', { classe: 'campo mono', id: 'ipo-rgo', maxlength: '40', value: ipo.rgo, placeholder: 'Ex.: 20263BBM12221' });
    // local e horários
    var localidade = el('input', { classe: 'campo', id: 'ipo-localidade', maxlength: '300', value: ipo.localidade || op.local_endereco || '', placeholder: 'Ex.: Guaraci, Fazenda União - Rio Rondon' });
    var ulv = vit.filter(function (v) { return v.ulv_lat != null && v.ulv_lng != null; })[0];
    var coordPadrao = ulv ? coordTexto(ulv.ulv_lat, ulv.ulv_lng) : op.local_lat != null ? coordTexto(op.local_lat, op.local_lng) : '';
    var coordRef = el('input', { classe: 'campo mono', id: 'ipo-coord', maxlength: '120', value: ipo.coord_referencia, placeholder: coordPadrao || 'Ex.: 22°53\'48.90"S 51°39\'36.78"W' });
    var acionCb = el('input', { classe: 'campo', id: 'ipo-acion-cb', type: 'datetime-local', value: paraCampoData(ipo.acionamento_cb || op.acionado_em) });
    var desap = el('input', { classe: 'campo', id: 'ipo-desap', type: 'datetime-local', value: ipo.desaparecimento ? paraCampoData(ipo.desaparecimento) : '' });
    var desapQual = el('select', { classe: 'campo', id: 'ipo-desap-qual', 'aria-label': 'Origem da hora do desaparecimento' }, [el('option', { value: '', texto: 'Origem da hora…' })].concat(
      I.QUALIDADE_HORA.map(function (x) { return el('option', { value: x[0], selected: ipo.desaparecimento_qualidade === x[0] ? true : null, texto: x[1] }); })));
    var aquatica = I.ehAquatica(ipo.natureza);
    // vítimas: dados das fichas + documento (vai no IPO, não na ficha)
    var pessoas = el('input', { classe: 'campo ipo-qtd', id: 'ipo-pessoas', type: 'number', min: '0', max: '999', inputmode: 'numeric', value: ipo.pessoas_perdidas != null ? ipo.pessoas_perdidas : '', placeholder: vit.length ? String(vit.length) : '' });
    var docs = {};
    var listaVit = vit.length ? el('ul', { classe: 'ipo-vitimas' }, vit.map(function (v) {
      var doc = el('input', { classe: 'campo mono', maxlength: '40', value: ipo.vitimas_docs[String(v.id).toLowerCase()] || '', placeholder: 'CPF ou RG (opcional)', 'aria-label': 'Documento de ' + v.nome });
      docs[String(v.id).toLowerCase()] = doc;
      return el('li', null, [el('div', null, [el('strong', { texto: v.nome }),
        el('small', { classe: 'muted', texto: [v.sexo === 'M' ? 'Masculino' : v.sexo === 'F' ? 'Feminino' : 'sexo não informado', v.idade != null ? v.idade + ' anos' : 'idade não informada', v.origem || 'origem não informada'].join(' · ') })]), doc]);
    })) : el('p', { classe: 'muted', texto: 'Nenhuma ficha de vítima. Os dados da vítima (nome, sexo, idade, origem) vêm das fichas: cadastre em Vítima.' });
    // busca
    var procs = {};
    var gradeProc = el('div', { classe: 'ipo-procs' }, I.PROCEDIMENTOS.map(function (p) {
      var cb = el('input', { type: 'checkbox', value: p[0], checked: ipo.procedimentos.indexOf(p[0]) !== -1 ? true : null });
      procs[p[0]] = cb;
      return el('label', { classe: 'linha-opcao' }, [cb, ' ' + p[1]]);
    }));
    var procOutros = el('input', { classe: 'campo', id: 'ipo-proc-outros', maxlength: '300', value: ipo.procedimentos_outros, placeholder: 'Outro procedimento (opcional)' });
    var procDiario = extra.diario.filter(function (e) { return e.tipo === 'procedimento'; }).length;
    // recursos e efetivo
    var recursos = el('textarea', { classe: 'campo', id: 'ipo-recursos', rows: '4', maxlength: '4000', placeholder: 'Um por linha. Ex.:\nABS BM 13629 3ºBBM/2CIA/3PEL - Rolândia.\nABRESC BM 004 - Canil Setorial 3° BBM.' });
    recursos.value = ipo.recursos_cb;
    var efetivo = listaDias(ipo.efetivo, [{ chave: 'qtd', tipo: 'qtd', rotulo: 'Quantidade de BMs', ph: 'Qtd' }, { chave: 'nomes', tipo: 'texto', rotulo: 'Quem', ph: 'Ex.: Sgt. Berzotti, Cb. Alves e Sd. Guimarães' }], '+ Dia');
    var desdob = listaDias(ipo.desdobramentos, [{ chave: 'texto', tipo: 'area', rotulo: 'O que foi feito no dia', ph: 'O que foi feito e o que se apurou neste dia' }], '+ Hoje');
    var desdobDiario = extra.diario.filter(function (e) { return e.tipo === 'desdobramento'; }).length;
    var orgaos = el('textarea', { classe: 'campo', id: 'ipo-orgaos', rows: '3', maxlength: '4000', placeholder: 'Um por linha. Ex.:\nPMPR: 02 PMs - Patrulha Rural\nDefesa Civil de Guaraci' });
    orgaos.value = ipo.orgaos_apoio;
    var responsavel = el('input', { classe: 'campo', id: 'ipo-resp', maxlength: '1000', value: ipo.responsavel_informacoes, placeholder: 'Ex.: Cb. Alves/GBS' });
    var erro = el('p', { classe: 'erro-form', role: 'alert', hidden: true });

    var btnEfetivoApp = el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '↻ Preencher pelos militares do app', title: 'Para cada dia, os militares e responsáveis que enviaram posição pelo app (não muda o que já foi escrito)',
      onclick: function () {
        var lista = efetivoPeloApp();
        if (!lista.length) { UI.aviso('Nenhum militar com posição registrada nesta operação.', 'erro', 6000); return; }
        var n = efetivo.completar(lista);
        UI.aviso(n ? n + ' dia(s) preenchido(s) pelos militares do app. Confira os nomes.' : 'Os dias já estavam preenchidos.', 'ok', 6000);
      } });
    var btnRecursosSci = el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '↻ Usar os recursos do SCI', onclick: async function () {
      try {
        var linhas = await recursosDoSci(op);
        if (!linhas.length) { UI.aviso('Nenhum recurso cadastrado no SCI (Recursos).', 'erro', 6000); return; }
        var atuais = recursos.value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        linhas.forEach(function (l) { if (atuais.indexOf(l) === -1) atuais.push(l); });
        recursos.value = atuais.join('\n');
      } catch (e) { UI.aviso('Os recursos do SCI não estão disponíveis (migração 080).', 'erro', 6000); }
    } });

    var form = el('form', { classe: 'form-padrao form-ipo', novalidate: true }, [
      el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'IPO · Informe Padrão de Ocorrência' }, [UI.dica('Tudo do informe num lugar só, na ordem do IPO. O que já existe no app (início, vítimas, natureza) entra sozinho. "Copiar para o WhatsApp" monta o texto no formato dos grupos.')]),
      UI.secao('Cabeçalho', [UI.grade([
        UI.campo('IPO para (destinatários)', destino, { para: 'ipo-destino' }),
        UI.campo('Unidade', unidade, { para: 'ipo-unidade', opcional: true }),
        UI.campo('RGO', rgo, { para: 'ipo-rgo', opcional: true }),
        UI.campo('Natureza', el('p', { classe: 'ipo-fixo', texto: ipo.natureza || 'não informada (escolha em Dados da operação → Editar)' }), {}),
      ])]),
      UI.secao('Local e horários', [UI.grade([
        UI.campo('Localidade/Município/Região', localidade, { para: 'ipo-localidade', largo: true }),
        UI.campo('Coord. de referência (último avistamento)', coordRef, { para: 'ipo-coord', ajuda: coordPadrao ? 'Em branco: ' + coordPadrao + (ulv ? ' (último local visto da ficha)' : ' (local da operação)') : null }),
        UI.campo('Início das operações', el('p', { classe: 'ipo-fixo', texto: op.acionado_em ? I.dataExtensa(op.acionado_em) : 'não informado (Dados da operação)' }), {}),
        UI.campo('Acionamento do CB', acionCb, { para: 'ipo-acion-cb', ajuda: 'Em branco: o início das operações.' }),
        UI.campo('Desaparecimento provável', el('div', { classe: 'ipo-par' }, [desap, desapQual]), { para: 'ipo-desap' }),
        aquatica ? UI.campo('Tipo de meio líquido', radios('ipo-meio', I.MEIOS, ipo.meio_liquido), {}) : null,
      ])]),
      UI.secao('Vítima(s)', [UI.grade([UI.campo('Nº de pessoas perdidas', pessoas, { para: 'ipo-pessoas', ajuda: vit.length ? 'Em branco: ' + vit.length + ' (fichas).' : null })]), listaVit]),
      UI.secao('Busca', [
        UI.campo('Buscas preliminares (casas de parentes, hospitais etc.)?', radios('ipo-buscas', I.BUSCAS, ipo.buscas_preliminares), { largo: true }),
        UI.campo('Possibilidade real de vida?', radios('ipo-vida', I.VIDA, ipo.possibilidade_vida), { largo: true }),
        UI.campo('Procedimentos de busca sendo realizados', el('div', null, [gradeProc, procOutros, procDiario ? el('small', { classe: 'muted', texto: procDiario + ' registro(s) de procedimento no diário também entram.' }) : null]), { largo: true }),
      ]),
      UI.secao('Recursos e efetivo', [
        UI.campo('Recursos CB deslocados e sendo utilizados', recursos, { para: 'ipo-recursos', largo: true }),
        el('div', { classe: 'acoes-linha' }, [btnRecursosSci]),
        UI.campo('BMs diretamente envolvidos, por dia', efetivo.elemento, { largo: true }),
        el('div', { classe: 'acoes-linha' }, [efetivo.botaoNovo, btnEfetivoApp]),
      ]),
      UI.secao('Desdobramentos / situação atual', [
        desdob.elemento,
        el('div', { classe: 'acoes-linha' }, [desdob.botaoNovo]),
        desdobDiario ? el('small', { classe: 'muted', texto: desdobDiario + ' desdobramento(s) registrado(s) no diário também entram, no dia deles.' }) : null,
      ]),
      UI.secao('Fechamento', [UI.grade([
        UI.campo('Órgãos de apoio', orgaos, { para: 'ipo-orgaos', largo: true }),
        UI.campo('Imagens anexas junto a esta mensagem?', radios('ipo-imagens', [['sim', 'Sim'], ['nao', 'Não']], ipo.imagens_anexas === true ? 'sim' : ipo.imagens_anexas === false ? 'nao' : ''), {}),
        UI.campo('Responsável pelas informações', responsavel, { para: 'ipo-resp' }),
      ])]),
      erro,
      UI.rodape([
        el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }),
        el('button', { classe: 'btn', type: 'button', id: 'ipo-copiar', texto: '📋 Copiar para o WhatsApp', onclick: function () { mostrarTexto(I.textoWhatsApp(Object.assign({}, op, { ipo: ler() }), extra)); } }),
        editavel ? el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'ipo-salvar', texto: 'Salvar IPO' }) : null,
      ]),
    ]);

    function ler() {
      var proc = Object.keys(procs).filter(function (k) { return procs[k].checked; });
      var docsIpo = {};
      Object.keys(docs).forEach(function (k) { if (docs[k].value.trim()) docsIpo[k] = docs[k].value.trim(); });
      var img = marcadoEm(form, 'ipo-imagens');
      return I.normalizarIpo(Object.assign({}, op.ipo || {}, {
        destinatarios: destino.value, unidade: unidade.value, rgo: rgo.value, localidade: localidade.value, coord_referencia: coordRef.value,
        acionamento_cb: isoLocal(acionCb.value), desaparecimento: isoLocal(desap.value), desaparecimento_qualidade: desapQual.value,
        meio_liquido: aquatica ? marcadoEm(form, 'ipo-meio') : ipo.meio_liquido, pessoas_perdidas: pessoas.value, vitimas_docs: docsIpo,
        buscas_preliminares: marcadoEm(form, 'ipo-buscas'), possibilidade_vida: marcadoEm(form, 'ipo-vida'), procedimentos: proc, procedimentos_outros: procOutros.value,
        recursos_cb: recursos.value, efetivo: efetivo.ler(), desdobramentos: desdob.ler(), orgaos_apoio: orgaos.value,
        imagens_anexas: img === 'sim' ? true : img === 'nao' ? false : null, responsavel_informacoes: responsavel.value,
      }));
    }
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      if (!editavel) return;
      erro.hidden = true;
      var dados = ler();
      var btn = form.querySelector('#ipo-salvar');
      btn.disabled = true;
      try {
        var r = await C.rpc('salvar_ipo_operacao', { p_operacao: op.id, p_ipo: dados });
        op.ipo = (r && r.ipo) || dados;
        if (r && r.atualizado_em) op.atualizado_em = r.atualizado_em;
        fechar(true);
        UI.aviso('IPO salvo.', 'ok');
        if (opcoes.aoSalvar) opcoes.aoSalvar(op);
      } catch (e) {
        erro.textContent = 'Não foi possível salvar: ' + (e.message || e) + (/dados_invalidos|inválid/i.test(String(e.message)) ? ' (texto longo demais? O banco precisa da migração 081.)' : '');
        erro.hidden = false;
        btn.disabled = false;
      }
    });
    if (!editavel) Array.prototype.forEach.call(form.querySelectorAll('input, textarea, select'), function (c) { c.disabled = true; });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false, tamanho: 'largo', empilhar: true });
  }

  window.IpoForm = { abrir: abrir, copiar: copiar };
})();
