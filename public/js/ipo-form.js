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
 *   O IPO é preenchido dia a dia no IPO (Diário): abrirDia(op, dia) grava o que foi feito, o efetivo, os procedimentos,
 *   os recursos, os órgãos de apoio e a situação ao fim do dia (Ipo.gravarDia, só aquele dia). abrir(op) fica com os
 *   dados gerais da ocorrência (cabeçalho, local, vítima, busca, recursos e órgãos fixos).
 *   API: window.IpoForm = { abrir(op, opcoes), abrirDia(op, dia, opcoes), copiar(op), copiarDia(op, dia) }.
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
    // quem gera o IPO (o responsável logado) é o "responsável pelas informações"
    var P = window.Painel;
    return { vitimas: r[0] || [], diario: r[1] || [], coordenada: coordTexto, responsavel: P && P.meuNome ? P.meuNome() : '' };
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
    var desdobDiario = extra.diario.filter(function (e) { return e.tipo === 'desdobramento'; }).length;
    var orgaos = el('textarea', { classe: 'campo', id: 'ipo-orgaos', rows: '3', maxlength: '4000', placeholder: 'Um por linha. Ex.:\nPMPR: 02 PMs - Patrulha Rural\nDefesa Civil de Guaraci' });
    orgaos.value = ipo.orgaos_apoio;
    var impComo = el('textarea', { classe: 'campo', id: 'ipo-imp-como', rows: '4', maxlength: '3000', placeholder: 'Como aconteceu, em poucas linhas e sem nomes. Ex.: Um homem de 34 anos saiu para uma trilha na manhã de sábado e não retornou; a família acionou os Bombeiros à noite.' });
    impComo.value = ipo.imprensa_como;
    var impEstrategia = el('textarea', { classe: 'campo', id: 'ipo-imp-estrategia', rows: '4', maxlength: '3000', placeholder: 'Como as buscas estão sendo conduzidas e os próximos passos. Ex.: As equipes varrem a trilha e as encostas em setores, com apoio de cães e drone; amanhã o foco será a margem do rio.' });
    impEstrategia.value = ipo.imprensa_estrategia;
    var erro = el('p', { classe: 'erro-form', role: 'alert', hidden: true });

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
      el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'IPO (Diário) · dados da ocorrência' }, [UI.dica('O que vale para a operação inteira, na ordem do IPO. O que já existe no app (início, vítimas, natureza) entra sozinho. O que muda a cada dia (efetivo, o que foi feito, situação) fica no IPO do dia, no IPO (Diário). "Copiar para o WhatsApp" monta o informe completo.')]),
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
      UI.secao('Recursos', [
        UI.campo('Recursos CB deslocados e sendo utilizados (fixos da operação)', recursos, { para: 'ipo-recursos', largo: true, ajuda: 'O que foi empregado só num dia vai no IPO daquele dia.' }),
        el('div', { classe: 'acoes-linha' }, [btnRecursosSci]),
      ]),
      UI.secao('Cada dia: efetivo e desdobramentos', [
        el('p', { classe: 'muted', texto: I.diasComIpo(op.ipo).length
          ? 'Dias com IPO preenchido: ' + I.diasComIpo(op.ipo).map(function (k) { return k.split('-').reverse().slice(0, 2).join('/'); }).join(', ') + '. O efetivo, o que foi feito, os procedimentos e a situação de cada dia ficam no IPO do dia, no próprio IPO (Diário).'
          : 'O efetivo, o que foi feito, os procedimentos e a situação de cada dia ficam no IPO do dia, no próprio IPO (Diário).' }),
        editavel ? el('div', { classe: 'acoes-linha' }, [el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'ipo-abrir-hoje', texto: '+ IPO de hoje', onclick: function () { abrirDia(op, hojeLocal(), { aoSalvar: opcoes.aoSalvar }); } })]) : null,
        desdobDiario ? el('small', { classe: 'muted', texto: desdobDiario + ' desdobramento(s) registrado(s) no diário também entram, no dia deles.' }) : null,
      ]),
      UI.secao('Para a imprensa', [
        el('p', { classe: 'muted', texto: 'Estes dois textos saem EXATAMENTE como escritos no relatório da imprensa. Não coloque nomes, documentos, telefones nem nada que identifique a pessoa ou a família. Em branco: o relatório monta um texto padrão com os dados da operação.' }),
        UI.campo('Como aconteceu', impComo, { para: 'ipo-imp-como', largo: true }),
        UI.campo('Estratégia e próximos passos', impEstrategia, { para: 'ipo-imp-estrategia', largo: true }),
      ]),
      UI.secao('Fechamento', [UI.grade([
        UI.campo('Órgãos de apoio', orgaos, { para: 'ipo-orgaos', largo: true }),
        UI.campo('Imagens anexas junto a esta mensagem?', radios('ipo-imagens', [['sim', 'Sim'], ['nao', 'Não']], ipo.imagens_anexas === true ? 'sim' : ipo.imagens_anexas === false ? 'nao' : ''), {}),
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
        recursos_cb: recursos.value, orgaos_apoio: orgaos.value, imprensa_como: impComo.value, imprensa_estrategia: impEstrategia.value,
        imagens_anexas: img === 'sim' ? true : img === 'nao' ? false : null,
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

  /* ---------- IPO do dia (fica no IPO · Diário) ---------- */
  function diaBr(k) { var p = String(k).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function primeiroDia(op) { return diaDe(C.paraMs(op.acionado_em || op.criada_em) || Date.now()); }
  async function ipoAtual(op) {
    try {
      var r = await C.consultar(C.cliente.from('operacoes').select('ipo').eq('id', op.id));
      if (r && r[0]) return r[0].ipo || {};
    } catch (e) { /* usa o que o painel tem */ }
    return op.ipo || {};
  }
  async function copiarDia(op, dia) {
    try { await mostrarTexto(I.textoWhatsApp(op, Object.assign(await dadosExtras(op), { ate: dia }))); }
    catch (e) { UI.aviso('Não foi possível montar o IPO do dia: ' + (e.message || e), 'erro', 7000); }
  }
  // opcoes: { aoSalvar(op), editavel }
  async function abrirDia(op, dia, opcoes) {
    opcoes = opcoes || {};
    if (!op) return;
    var editavel = opcoes.editavel !== false && op.status === 'ativa';
    var hoje = hojeLocal(), ini = primeiroDia(op);
    dia = I.diaValido(dia) || hoje;
    if (dia > hoje) dia = hoje;
    var extra;
    try { extra = await dadosExtras(op); } catch (e) { extra = { vitimas: [], diario: [], coordenada: coordTexto }; }
    if (editavel) op.ipo = await ipoAtual(op);

    var campoDia = el('input', { classe: 'campo', type: 'date', id: 'ipod-dia', value: dia, min: ini < hoje ? ini : hoje, max: hoje });
    var feito = el('textarea', { classe: 'campo', id: 'ipod-feito', rows: '5', maxlength: '4000', placeholder: 'O que foi feito e o que se apurou neste dia: setores varridos, equipes, resultados, informações novas…' });
    var qtd = el('input', { classe: 'campo ipo-qtd', id: 'ipod-qtd', type: 'number', min: '0', max: '999', inputmode: 'numeric', placeholder: 'Qtd' });
    var nomes = el('input', { classe: 'campo', id: 'ipod-nomes', maxlength: '1000', placeholder: 'Ex.: Sgt. Berzotti, Cb. Alves e Sd. Guimarães' });
    var procs = {};
    var gradeProc = el('div', { classe: 'ipo-procs' }, I.PROCEDIMENTOS.map(function (p) {
      var cb = el('input', { type: 'checkbox', value: p[0] });
      procs[p[0]] = cb;
      return el('label', { classe: 'linha-opcao' }, [cb, ' ' + p[1]]);
    }));
    var procOutros = el('input', { classe: 'campo', id: 'ipod-proc-outros', maxlength: '300', placeholder: 'Outro procedimento (opcional)' });
    var recursos = el('textarea', { classe: 'campo', id: 'ipod-recursos', rows: '3', maxlength: '4000', placeholder: 'Um por linha. Ex.:\nABTS BM 1234 - 3º BBM\nDrone DJI M30 - SARP' });
    var orgaos = el('textarea', { classe: 'campo', id: 'ipod-orgaos', rows: '3', maxlength: '4000', placeholder: 'Um por linha. Ex.:\nPMPR: 02 PMs - Patrulha Rural\nDefesa Civil' });
    var situacao = el('textarea', { classe: 'campo', id: 'ipod-situacao', rows: '3', maxlength: '4000', placeholder: 'Como a busca ficou ao fim do dia e o que fica para o dia seguinte (setores pendentes, pistas a checar, apoio pedido…)' });
    var antigos = el('p', { classe: 'muted', hidden: true });
    var quem = el('p', { classe: 'muted', hidden: true });
    var erro = el('p', { classe: 'erro-form', role: 'alert', hidden: true });

    function preencher(k) {
      var d = I.ipoDoDia(op.ipo, k, []);
      feito.value = d.texto; qtd.value = d.qtd != null ? d.qtd : ''; nomes.value = d.nomes;
      Object.keys(procs).forEach(function (p) { procs[p].checked = d.procedimentos.indexOf(p) !== -1; });
      procOutros.value = d.procedimentos_outros; recursos.value = d.recursos; orgaos.value = d.orgaos; situacao.value = d.situacao;
      var velho = I.ipoDoDia({}, k, extra.diario);
      var partes = [];
      if (velho.textoDiario) partes.push('desdobramento');
      if (velho.recursosDiario) partes.push('recurso');
      if (velho.procedimentos.length) partes.push('procedimento');
      antigos.textContent = partes.length ? 'Registros deste dia feitos pelo "+ Novo registro" (' + partes.join(', ') + ') também entram no IPO do dia.' : '';
      antigos.hidden = !partes.length;
      quem.textContent = d.por ? 'Preenchido por ' + d.por + (d.em ? ' em ' + new Date(d.em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '') + '.' : '';
      quem.hidden = !d.por;
      titulo.textContent = 'IPO do dia ' + diaBr(k);
    }
    function ler() {
      var P = window.Painel;
      return { dia: campoDia.value, texto: feito.value, qtd: qtd.value === '' ? null : qtd.value, nomes: nomes.value,
        procedimentos: Object.keys(procs).filter(function (p) { return procs[p].checked; }), procedimentos_outros: procOutros.value,
        recursos: recursos.value, orgaos: orgaos.value, situacao: situacao.value,
        por: P && P.meuNome ? P.meuNome() : '', em: new Date().toISOString() };
    }
    var btnApp = el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '↻ Militares do app neste dia', title: 'Os militares e responsáveis que enviaram posição pelo app neste dia', onclick: function () {
      var x = efetivoPeloApp().filter(function (y) { return y.dia === campoDia.value; })[0];
      if (!x) { UI.aviso('Nenhum militar com posição neste dia (no que o painel tem carregado).', 'erro', 6000); return; }
      qtd.value = x.qtd; nomes.value = x.nomes;
    } });
    var btnSci = el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '↻ Recursos do SCI', onclick: async function () {
      try {
        var linhas = await recursosDoSci(op);
        if (!linhas.length) { UI.aviso('Nenhum recurso cadastrado no SCI (Recursos).', 'erro', 6000); return; }
        var atuais = recursos.value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        linhas.forEach(function (l) { if (atuais.indexOf(l) === -1) atuais.push(l); });
        recursos.value = atuais.join('\n');
      } catch (e) { UI.aviso('Os recursos do SCI não estão disponíveis (migração 080).', 'erro', 6000); }
    } });
    var btnOntem = el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '↧ Repetir do dia anterior', title: 'Copia efetivo, procedimentos, recursos e órgãos do dia anterior (não copia o que foi feito nem a situação)', onclick: function () {
      var d = new Date(campoDia.value + 'T12:00:00'); d.setDate(d.getDate() - 1);
      var ant = I.ipoDoDia(op.ipo, diaDe(d.getTime()), []);
      if (ant.vazio) { UI.aviso('O dia anterior não tem IPO preenchido.', 'erro', 5000); return; }
      if (!qtd.value && ant.qtd != null) qtd.value = ant.qtd;
      if (!nomes.value) nomes.value = ant.nomes;
      ant.procedimentos.forEach(function (p) { if (procs[p]) procs[p].checked = true; });
      if (!procOutros.value) procOutros.value = ant.procedimentos_outros;
      if (!recursos.value) recursos.value = ant.recursos;
      if (!orgaos.value) orgaos.value = ant.orgaos;
    } });
    var titulo = el('span', { texto: 'IPO do dia' });
    var form = el('form', { classe: 'form-padrao form-ipo form-ipo-dia', novalidate: true }, [
      el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, [titulo, UI.dica('Um IPO por dia, junto com o diário: quem chega no dia seguinte vê o que foi feito e como a busca ficou. Os dados gerais (vítima, local, natureza) ficam no cartão "Dados da ocorrência", no topo do IPO (Diário). "Copiar IPO do dia" monta o IPO completo, acumulado até este dia (todos os campos do modelo; o que falta sai como "Não apurado"), para colar no grupo.')]),
      UI.grade([UI.campo('Dia', campoDia, { para: 'ipod-dia' })]),
      UI.secao('O que foi feito no dia', [feito, antigos]),
      UI.secao('Efetivo do dia', [UI.grade([
        UI.campo('BMs envolvidos', qtd, { para: 'ipod-qtd' }),
        UI.campo('Quem', nomes, { para: 'ipod-nomes', largo: true }),
      ]), el('div', { classe: 'acoes-linha' }, [btnApp, btnOntem])]),
      UI.secao('Procedimentos de busca feitos no dia', [gradeProc, procOutros]),
      UI.secao('Recursos e apoio no dia', [
        UI.campo('Recursos CB empregados', recursos, { para: 'ipod-recursos', largo: true }),
        el('div', { classe: 'acoes-linha' }, [btnSci]),
        UI.campo('Órgãos de apoio', orgaos, { para: 'ipod-orgaos', largo: true }),
      ]),
      UI.secao('Situação ao fim do dia / próximos passos', [situacao]),
      quem,
      erro,
      UI.rodape([
        el('button', { classe: 'btn', type: 'button', texto: editavel ? 'Cancelar' : 'Fechar', onclick: function () { fechar(); } }),
        el('button', { classe: 'btn', type: 'button', id: 'ipod-copiar', texto: '📋 Copiar IPO do dia', onclick: function () {
          var prev = I.gravarDia(op.ipo, ler());
          mostrarTexto(I.textoWhatsApp(Object.assign({}, op, { ipo: prev }), Object.assign({}, extra, { ate: campoDia.value })));
        } }),
        editavel ? el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'ipod-salvar', texto: 'Salvar IPO do dia' }) : null,
      ]),
    ]);
    campoDia.addEventListener('change', function () {
      if (!I.diaValido(campoDia.value) || campoDia.value > hoje) { campoDia.value = dia; return; }
      dia = campoDia.value;
      preencher(dia);
    });
    preencher(dia);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      if (!editavel) return;
      erro.hidden = true;
      var reg = ler();
      var btn = form.querySelector('#ipod-salvar');
      btn.disabled = true;
      try {
        var atual = await ipoAtual(op);   // outro responsável pode ter salvo outro dia enquanto esta tela estava aberta
        var novo = I.gravarDia(atual, reg);
        var r = await C.rpc('salvar_ipo_operacao', { p_operacao: op.id, p_ipo: novo });
        op.ipo = (r && r.ipo) || novo;
        if (r && r.atualizado_em) op.atualizado_em = r.atualizado_em;
        fechar(true);
        UI.aviso('IPO do dia ' + diaBr(reg.dia) + ' salvo.', 'ok');
        if (opcoes.aoSalvar) opcoes.aoSalvar(op, reg.dia);
      } catch (e) {
        erro.textContent = 'Não foi possível salvar: ' + (e.message || e);
        erro.hidden = false;
        btn.disabled = false;
      }
    });
    if (!editavel) Array.prototype.forEach.call(form.querySelectorAll('input, textarea, select'), function (c) { if (c !== campoDia) c.disabled = true; });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false, tamanho: 'largo', empilhar: true });
    setTimeout(function () { if (editavel) feito.focus(); }, 60);
  }

  window.IpoForm = { abrir: abrir, abrirDia: abrirDia, copiar: copiar, copiarDia: copiarDia };
})();
