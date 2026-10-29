/* =====================================================================
 * sci.js — painel de comando SCI (migração 045, regras em sci-core.js)
 *   Fonte única do Posto de Comando, na ordem que o comando remoto lê: onde é (local), quantas vítimas,
 *   quem responde por quê, o que já aconteceu (linha do tempo), missões, órgãos, alertas, situação e danos,
 *   estrutura SCI, recursos e logística, nível do rio. Atualiza sozinho (tempo real) para todos.
 *   O comandante registra por frases curtas (texto ou voz): o painel entende, mostra o que vai gravar e
 *   aponta divergências antes. Campo sem informação = [PENDENTE]; de terceiros sem confirmação = NÃO CONFIRMADA.
 *   SCI.montar(elemento, ctx) — ctx: { op, podeAlterar(), setores(), irPara(lat, lng)?, janela?: true }
 *   Usado no painel (janela grande) e em sci.html (janela própria, para o comando remoto pelo celular).
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI, S = window.SciCore;
  if (!C || !UI || !S) return;
  var el = UI.el;
  var P = S.PENDENTE;
  var BUCKET = 'sci';
  var CORES_TRIAGEM = { verde: '#22c55e', amarelo: '#facc15', vermelho: '#ef4444', cinza: '#6b7280' };
  var CORES_EQUIPE = { em_operacao: '#f97316', designada: '#60a5fa', em_deslocamento: '#facc15', disponivel: '#22c55e', desmobilizada: '#6b7280' };
  var SECOES = [['local', 'Local'], ['vitimas', 'Vítimas'], ['comando', 'Comando'], ['linha', 'Linha do tempo'], ['missoes', 'Missões'], ['orgaos', 'Órgãos'],
    ['alertas', 'Alertas'], ['situacao', 'Situação'], ['estrutura', 'Estrutura SCI'], ['recursos', 'Recursos'], ['rio', 'Nível do rio']];

  function dois(n) { return (n < 10 ? '0' : '') + n; }
  function dataLocal(v) { var d = new Date(typeof v === 'number' ? v : Date.parse(v)); return d.getFullYear() + '-' + dois(d.getMonth() + 1) + '-' + dois(d.getDate()) + 'T' + dois(d.getHours()) + ':' + dois(d.getMinutes()); }
  function iso(v) { if (!v) return null; var d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
  function hc(v) { return v ? S.horaCurta(v) : P; }
  function pend(v, extra) { return S.vazio(v) ? el('span', { classe: 'sci-pend', texto: P }) : el('span', { texto: String(v) + (extra || '') }); }
  function botao(texto, fn, classe, attrs) { return el('button', Object.assign({ classe: 'btn btn-pequeno ' + (classe || ''), type: 'button', texto: texto, onclick: fn }, attrs || {})); }

  function montar(raiz, ctx) {
    var est = { estado: { funcoes: {}, marcos: {}, logistica: {} }, vitimas: [], eventos: [], itens: [], carregou: false, ausente: false, erro: null,
      canal: null, timer: null, relogio: null, arrastando: false, pendenteRender: false, filtro: '', urls: {}, ativo: true };
    var opId = ctx.op.id;
    function op() { return ctx.op; }
    function pode() { return Boolean(ctx.podeAlterar && ctx.podeAlterar()) && op().status === 'ativa'; }
    function dados() { return { op: op(), estado: est.estado, vitimas: est.vitimas, eventos: est.eventos, itens: est.itens }; }
    function itens(tipo) { return S.porTipo(est.itens, tipo).sort(function (a, b) { return (a.ordem || 0) - (b.ordem || 0); }); }

    /* ---------- Dados ---------- */
    async function carregar() {
      try {
        var r = await Promise.all([
          C.consultar(C.cliente.from('sci_estado').select('*').eq('operacao_id', opId).maybeSingle()),
          C.consultar(C.cliente.from('sci_vitimas').select('*').eq('operacao_id', opId).order('numero', { ascending: true })),
          C.consultar(C.cliente.from('sci_eventos').select('*').eq('operacao_id', opId).order('ocorrido_em', { ascending: false }).limit(1000)),
          C.consultar(C.cliente.from('sci_itens').select('*').eq('operacao_id', opId).order('ordem', { ascending: true })),
        ]);
        if (!est.ativo) return;
        est.estado = r[0] || { funcoes: {}, marcos: {}, logistica: {} };
        est.estado.funcoes = est.estado.funcoes || {}; est.estado.marcos = est.estado.marcos || {}; est.estado.logistica = est.estado.logistica || {};
        est.vitimas = r[1] || []; est.eventos = r[2] || []; est.itens = r[3] || [];
        est.carregou = true; est.erro = null;
        carregarImagens();
      } catch (e) {
        if (/sci_/.test(String(e.original && (e.original.message || e.original.details) || e.message)) || e.codigo === 'funcao_ausente') est.ausente = true;
        est.erro = e.message;
      }
      render();
    }
    function agendar() { clearTimeout(est.timer); est.timer = setTimeout(carregar, 300); }
    async function carregarImagens() {
      var cams = itens('imagem').map(function (i) { return i.dados.caminho; }).filter(function (c) { return !est.urls[c]; });
      if (!cams.length) return;
      try {
        var r = await C.cliente.storage.from(BUCKET).createSignedUrls(cams, 3600);
        (r.data || []).forEach(function (d) { if (d.signedUrl && d.path) est.urls[d.path] = d.signedUrl; });
        render();
      } catch (e) { /* sem miniaturas */ }
    }
    function iniciarTempoReal() {
      try {
        est.canal = C.cliente.channel('sci-' + opId + '-' + Date.now());
        ['sci_estado', 'sci_vitimas', 'sci_eventos', 'sci_itens'].forEach(function (t) {
          est.canal.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: 'operacao_id=eq.' + opId }, agendar);
        });
        est.canal.subscribe();
      } catch (e) { /* sem tempo real: atualiza a cada 30 s */ }
      // relógio, tempo decorrido e alertas por tempo (leitura antiga, vítima esperando); sem tempo real, também os dados
      est.relogio = setInterval(function () { if (!est.canal) carregar(); else render(); }, 30000);
    }
    function parar() {
      est.ativo = false;
      clearTimeout(est.timer); clearInterval(est.relogio);
      if (est.canal) { try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ } }
      est.canal = null;
    }

    async function rpc(nome, args, ok) {
      try {
        var r = await C.rpc(nome, args);
        if (ok) UI.aviso(ok, 'ok');
        agendar();
        return r;
      } catch (e) {
        UI.aviso(e.message, 'erro', 8000);
        return null;
      }
    }

    /* ---------- Render ---------- */
    function render() {
      if (!est.ativo) return;
      if (est.arrastando) { est.pendenteRender = true; return; }
      var rol = raiz.closest('.modal-corpo') || (ctx.janela ? document.scrollingElement : raiz);
      var rolagem = rol ? rol.scrollTop : 0, abertos = Array.prototype.map.call(raiz.querySelectorAll('details[open][data-chave]'), function (d) { return d.getAttribute('data-chave'); });
      var foco = document.activeElement && raiz.contains(document.activeElement) && document.activeElement.id ? document.activeElement.id : null;
      var rapido = raiz.querySelector('#sci-frase'), textoRapido = rapido ? rapido.value : '';
      raiz.innerHTML = '';
      raiz.classList.add('sci');
      if (est.ausente) {
        raiz.appendChild(el('div', { classe: 'sci-vazio' }, [el('h2', { texto: 'Painel de comando SCI' }),
          el('p', { classe: 'nota', texto: 'O painel SCI ainda não está no servidor: rode a migração 045_sci.sql no Supabase.' })]));
        return;
      }
      if (!est.carregou) { raiz.appendChild(el('p', { classe: 'muted sci-carregando', texto: est.erro ? 'Não foi possível carregar: ' + est.erro : 'Carregando o painel de comando…' })); return; }
      raiz.appendChild(cabecalho());
      if (pode()) raiz.appendChild(registroRapido(textoRapido));
      raiz.appendChild(secaoLocal());
      raiz.appendChild(secaoVitimas());
      raiz.appendChild(secaoComando());
      raiz.appendChild(secaoLinha());
      raiz.appendChild(secaoMissoes());
      raiz.appendChild(secaoOrgaos());
      raiz.appendChild(secaoAlertas());
      raiz.appendChild(secaoSituacao());
      raiz.appendChild(secaoEstrutura());
      raiz.appendChild(secaoRecursos());
      raiz.appendChild(secaoRio());
      abertos.forEach(function (k) { var d = raiz.querySelector('details[data-chave="' + k + '"]'); if (d) d.open = true; });
      if (rol) rol.scrollTop = rolagem;
      if (foco) { var f = document.getElementById(foco); if (f && f.focus) f.focus(); }
    }

    function secao(id, titulo, acoes, filhos, dica) {
      return el('section', { classe: 'sci-secao', id: 'sci-' + id, 'data-secao': id }, [
        el('header', { classe: 'sci-secao-topo' }, [el('h3', { classe: 'titulo-com-dica' }, [titulo, dica ? UI.dica(dica) : null]),
          acoes && acoes.length ? el('div', { classe: 'sci-secao-acoes' }, acoes) : null]),
      ].concat([].concat.apply([], filhos)));   // filhos pode trazer listas (ex.: uma linha por aeronave)
    }

    /* ---------- Cabeçalho ---------- */
    function cabecalho() {
      var o = op(), e = est.estado, agora = Date.now();
      var ac = e.marcos.acionamento || o.acionado_em;
      var nat = (o.ipo && o.ipo.natureza) || ({ aquatica: 'Busca aquática', terrestre: 'Busca terrestre' }[o.tipo] || o.tipo_outro || '');
      var tempo = ac ? (Date.parse(ac) > agora ? 'Acionamento em ' + S.duracao(Date.parse(ac) - agora) : 'Acionamento ' + hc(ac) + ' · decorrido ' + S.duracao((e.marcos.termino ? Date.parse(e.marcos.termino) : agora) - Date.parse(ac)))
        : 'Acionamento ' + P;
      var acoes = [
        botao('Copiar resumo', function () { copiar(S.resumo(dados(), Date.now()), 'Resumo copiado. Cole no WhatsApp.'); }, 'btn-escuro', { id: 'sci-copiar' }),
        botao('Texto para a imprensa', abrirImprensa),
        botao('Imprimir / PDF', imprimir),
        ctx.janela ? null : botao('↗ Outra janela', function () { window.open('sci.html?op=' + encodeURIComponent(opId), 'gbs-sci-' + opId, 'noopener'); }, '', { title: 'Abre só o painel SCI (bom para o comando remoto e outro monitor)' }),
        pode() ? botao(e.teste ? 'Sair do modo teste (zerar)' : 'Modo teste', alternarTeste, e.teste ? 'btn-primario' : '', { id: 'sci-teste' }) : null,
      ];
      return el('header', { classe: 'sci-topo' }, [
        e.teste ? el('div', { classe: 'sci-faixa-teste', role: 'status', texto: 'MODO TESTE — vítimas e registros de teste não vão para o diário e são apagados ao sair do modo teste.' }) : null,
        el('div', { classe: 'sci-topo-linha' }, [
          el('div', { classe: 'sci-topo-nome' }, [
            el('small', { classe: 'sci-eyebrow', texto: 'SCI · ' + (nat || 'Ocorrência') }),
            el('h2', { classe: 'sci-titulo', texto: o.codigo }),
            el('span', { classe: 'muted', texto: (o.local_endereco || 'Local ' + P) + ' · ' + S.dms(o.local_lat, o.local_lng) }),
          ]),
          el('div', { classe: 'sci-relogio' }, [
            el('strong', { classe: 'num', texto: dois(new Date().getHours()) + 'h' + dois(new Date().getMinutes()) }),
            el('span', { texto: tempo }),
            o.status !== 'ativa' ? el('span', { classe: 'selo selo-neutro', texto: 'Encerrada' + (o.encerrada_em ? ' ' + hc(o.encerrada_em) : '') }) : e.marcos.termino ? el('span', { classe: 'selo selo-ok', texto: 'Término ' + hc(e.marcos.termino) }) : null,
          ]),
        ]),
        el('div', { classe: 'acoes-linha sci-topo-acoes' }, acoes),
        el('nav', { classe: 'sci-nav', 'aria-label': 'Blocos do painel' }, SECOES.map(function (s) {
          return el('button', { classe: 'sci-nav-item', type: 'button', texto: s[1], onclick: function () { var a = raiz.querySelector('#sci-' + s[0]); if (a) a.scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
        })),
      ]);
    }

    async function copiar(texto, ok) {
      try { await navigator.clipboard.writeText(texto); UI.aviso(ok || 'Copiado.', 'ok'); }
      catch (e) { UI.abrirModal(el('div', null, [el('h2', { id: 'modal-titulo', texto: 'Copie o texto' }), el('textarea', { classe: 'campo', rows: '12', readonly: true }, [texto])]), { empilhar: true }); }
    }
    function abrirImprensa() {
      var t = el('textarea', { classe: 'campo', id: 'sci-imprensa', rows: '12' });
      t.value = S.imprensa(dados(), Date.now());
      var fechar = UI.abrirModal(el('div', null, [
        el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, ['Texto para a imprensa', UI.dica('Montado só com o que está registrado, sem nomes de vítimas. Revise antes de divulgar.')]),
        t,
        UI.rodape([botao('Fechar', function () { fechar(); }), botao('Copiar', function () { copiar(t.value, 'Texto copiado.'); }, 'btn-escuro')]),
      ]), { empilhar: true });
    }
    function imprimir() {
      if (ctx.janela) { window.print(); return; }
      window.open('sci.html?op=' + encodeURIComponent(opId) + '&imprimir=1', '_blank', 'noopener');
    }
    async function alternarTeste() {
      var e = est.estado;
      if (e.teste) {
        var ok = await UI.confirmar({ titulo: 'Sair do modo teste?', texto: 'Apaga as vítimas, a linha do tempo, os marcos e o total de teste. Funções, instalações, equipes, órgãos e recursos preparados ficam. Faça isso antes do acionamento.', ok: 'Zerar e sair', perigo: true, empilhar: true });
        if (ok) rpc('sci_modo_teste', { p_operacao: opId, p_ligar: false }, 'Painel zerado. Total de vítimas [PENDENTE] e linha do tempo vazia.');
      } else {
        var ok2 = await UI.confirmar({ titulo: 'Ligar o modo teste?', texto: 'Para testar o quadro antes da ocorrência: o que for registrado não vai para o diário e é apagado ao sair do modo teste. Só com o quadro vazio.', ok: 'Ligar modo teste', empilhar: true });
        if (ok2) rpc('sci_modo_teste', { p_operacao: opId, p_ligar: true }, 'Modo teste ligado.');
      }
    }

    /* ---------- Registro rápido (frase ou voz) ---------- */
    function registroRapido(valor) {
      var entrada = el('textarea', { classe: 'campo sci-frase', id: 'sci-frase', rows: '2', maxlength: '2000', placeholder: 'Ex.: "V-03 na ACV, amarela" · "SAMU no local com 5" · "despacho 7h15" · "segurança: Sgt Dinardi"' });
      entrada.value = valor || '';
      entrada.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); entender(false); } });
      var Reconhecer = window.SpeechRecognition || window.webkitSpeechRecognition;
      var mic = Reconhecer ? botao('🎤', function () { ditar(entrada, mic, Reconhecer); }, 'sci-mic', { title: 'Falar a informação', 'aria-label': 'Falar a informação' }) : null;
      function entender(ia) {
        var t = entrada.value.trim();
        if (!t) { entrada.focus(); return; }
        if (ia) return perguntarIa(t, entrada);
        var r = S.interpretar(t, dados(), Date.now());
        confirmarAcoes(t, r.acoes, null, entrada);
      }
      return el('section', { classe: 'sci-rapido', 'aria-label': 'Registro rápido' }, [
        el('div', { classe: 'sci-rapido-linha' }, [entrada, mic]),
        el('div', { classe: 'acoes-linha' }, [
          botao('Registrar', function () { entender(false); }, 'btn-escuro', { id: 'sci-entender' }),
          botao('Entender com IA', function () { entender(true); }, '', { title: 'A IA lê frases mais longas ou confusas (precisa da chave de IA no servidor)' }),
          botao('O que falta?', abrirFaltando, '', { id: 'sci-falta' }),
        ]),
      ]);
    }
    function ditar(entrada, mic, Reconhecer) {
      try {
        var r = new Reconhecer();
        r.lang = 'pt-BR'; r.interimResults = true; r.continuous = false;
        var base = entrada.value ? entrada.value.replace(/\s*$/, ' ') : '';
        mic.classList.add('gravando');
        r.onresult = function (ev) { var t = ''; for (var i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript; entrada.value = base + t; };
        r.onend = function () { mic.classList.remove('gravando'); entrada.focus(); };
        r.onerror = function (ev) { mic.classList.remove('gravando'); UI.aviso(ev.error === 'not-allowed' ? 'Permita o microfone para falar a informação.' : 'Não deu para ouvir. Tente de novo ou digite.', 'erro'); };
        r.start();
      } catch (e) { UI.aviso('Este navegador não transcreve voz. Digite a informação.', 'erro'); }
    }
    async function perguntarIa(t, entrada) {
      var s = await C.cliente.auth.getSession();
      var token = s && s.data && s.data.session ? s.data.session.access_token : null;
      var e = est.estado;
      var contexto = { agora: new Date().toISOString(), tipo: op().tipo, total: e.total_vitimas,
        vitimas: est.vitimas.map(function (v) { return { numero: v.numero, fase: v.fase, triagem: v.triagem, sexo: v.sexo }; }),
        orgaos: itens('orgao').map(function (i) { return i.dados.nome; }), equipes: itens('equipe').map(function (i) { return i.dados.nome; }),
        marcos: Object.keys(e.marcos), funcoes: S.FUNCOES.map(function (f) { return f[1] + ': ' + (S.nomeFuncao(e, f[0]) || P); }) };
      UI.aviso('Perguntando à IA…');
      try {
        var r = await fetch('/api/sci-ia', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ operacao_id: opId, texto: t, contexto: contexto }) });
        var j = await r.json().catch(function () { return {}; });
        if (!r.ok) { UI.aviso((j.mensagem || 'A IA não respondeu agora.') + ' Use "Registrar".', 'erro', 8000); return; }
        confirmarAcoes(t, S.normalizarAcoes(j.acoes, dados()), j, entrada);
      } catch (x) { UI.aviso('Sem conexão com o servidor. Use "Registrar".', 'erro'); }
    }

    function confirmarAcoes(frase, acoes, ia, entrada) {
      var div = S.divergencias(acoes, dados());
      var marcas = acoes.map(function () { return true; });
      var lista = el('ul', { classe: 'sci-acoes' }, acoes.map(function (a, i) {
        var c = el('input', { type: 'checkbox', checked: true, id: 'sci-acao-' + i });
        c.addEventListener('change', function () { marcas[i] = c.checked; });
        return el('li', null, [el('label', { classe: 'linha-opcao', for: 'sci-acao-' + i }, [c, ' ' + a.texto_tela])]);
      }));
      var frase0 = el('input', { type: 'checkbox', id: 'sci-acao-frase' });
      var btn = el('button', { classe: 'btn btn-escuro', type: 'button', id: 'sci-gravar', texto: 'Gravar' });
      var fechar = UI.abrirModal(el('div', { classe: 'sci-confirmar' }, [
        el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, ['Conferir antes de gravar', UI.dica('Desmarque o que foi entendido errado. Cada item entra no painel com a hora indicada (ou agora) e vai para a linha do tempo.')]),
        el('p', { classe: 'sci-frase-original', texto: '“' + frase + '”' }),
        ia && ia.resposta ? el('p', { classe: 'nota', texto: ia.resposta }) : null,
        acoes.length ? lista : el('p', { classe: 'muted', texto: 'Nada para gravar.' }),
        div.length ? el('div', { classe: 'sci-divergencias', role: 'alert' }, [el('strong', { texto: 'Divergências' }), el('ul', null, div.map(function (x) { return el('li', { texto: x }); }))]) : null,
        el('label', { classe: 'linha-opcao' }, [frase0, ' Guardar também a frase original na linha do tempo']),
        ia && ia.faltando && ia.faltando.length ? el('details', { classe: 'sci-faltando-ia' }, [el('summary', { texto: 'O que ainda falta (IA)' }), el('ul', null, ia.faltando.map(function (x) { return el('li', { texto: x }); }))]) : null,
        UI.rodape([botao('Cancelar', function () { fechar(); }), btn]),
      ]), { empilhar: true });
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        var escolhidas = acoes.filter(function (a, i) { return marcas[i]; });
        if (frase0.checked) escolhidas.push({ acao: 'evento', categoria: 'informacao', texto: frase, nao_confirmada: false });
        var r = await executar(escolhidas);
        fechar();
        var atual = raiz.querySelector('#sci-frase');   // o painel foi redesenhado: o campo é outro
        if (r.ok && atual) atual.value = '';
        var faltam = S.alertas(dados(), Date.now()).filter(function (a) { return a.nivel !== 'pendencia'; }).slice(0, 3);
        UI.aviso((r.ok ? 'Gravado: ' + r.ok + ' item(ns).' : '') + (r.falhas ? ' ' + r.falhas + ' não gravado(s): ' + r.erros.join('; ') : '') +
          (faltam.length ? ' Atenção: ' + faltam.map(function (a) { return a.texto; }).join(' ') : ''), r.falhas ? 'erro' : 'ok', 8000);
      });
    }

    // Executa ações (da frase, da IA ou de botões) pelas funções do banco, na ordem. Devolve { ok, falhas, erros }.
    async function executar(acoes) {
      var res = { ok: 0, falhas: 0, erros: [] };
      function achar(tipo, nome) {
        var n = String(nome || '').toLowerCase();
        return itens(tipo).filter(function (i) { return String(i.dados.nome || '').toLowerCase() === n; })[0] || null;
      }
      for (var i = 0; i < acoes.length; i++) {
        var a = acoes[i], r = null;
        try {
          if (a.acao === 'marco') r = await C.rpc('sci_marcar', { p_operacao: opId, p_marco: a.marco, p_em: a.em || null });
          else if (a.acao === 'vitima_nova' || a.acao === 'vitima') {
            var v = a.numero ? est.vitimas.filter(function (x) { return x.numero === a.numero; })[0] : null;
            var dd = {};
            ['numero', 'fase', 'triagem', 'sexo', 'idade', 'nome', 'local', 'destino', 'observacoes', 'em'].forEach(function (k) { if (a[k] != null) dd[k] = a[k]; });
            if (v) delete dd.numero;
            r = await C.rpc('sci_salvar_vitima', { p_operacao: opId, p_id: v ? v.id : null, p_dados: dd });
            if (r) { est.vitimas = est.vitimas.filter(function (x) { return x.id !== r.id; }).concat([r]); }
          } else if (a.acao === 'total') r = await C.rpc('sci_salvar_estado', { p_operacao: opId, p_dados: { total_vitimas: a.total, total_confirmado: a.confirmado } });
          else if (a.acao === 'funcao') { var f = {}; f[a.funcao] = { nome: a.nome || '', acumula_ci: a.acumula_ci }; r = await C.rpc('sci_salvar_estado', { p_operacao: opId, p_dados: { funcoes: f } }); }
          else if (a.acao === 'situacao') r = await C.rpc('sci_salvar_estado', { p_operacao: opId, p_dados: { situacao: a.texto } });
          else if (a.acao === 'evento') r = await C.rpc('sci_registrar_evento', { p_operacao: opId, p_dados: { categoria: a.categoria, texto: a.texto, nao_confirmada: a.nao_confirmada, em: a.em || null } });
          else if (a.acao === 'leitura_rio') r = await C.rpc('sci_salvar_item', { p_operacao: opId, p_id: null, p_tipo: 'leitura_rio', p_dados: { em: a.em || new Date().toISOString(), nivel: a.nivel, tendencia: a.tendencia, ponto: a.ponto, vazao: a.vazao, fonte: a.fonte } });
          else if (a.acao === 'orgao' || a.acao === 'equipe' || a.acao === 'recurso' || a.acao === 'instalacao') {
            var tipo = a.acao;
            var atual = tipo === 'instalacao' ? itens('instalacao').filter(function (x) { return x.dados.tipo === a.tipo; })[0] : achar(tipo, a.nome);
            var nd = Object.assign({}, atual ? atual.dados : {});
            Object.keys(a).forEach(function (k) { if (['acao', 'em', 'texto_tela'].indexOf(k) === -1 && a[k] != null && a[k] !== '') nd[k] = a[k]; });
            if (tipo === 'instalacao' && !nd.nome) nd.nome = S.INSTALACOES[a.tipo];
            if (tipo === 'orgao' && a.situacao === 'no_local' && !nd.chegada_em) nd.chegada_em = a.em || new Date().toISOString();
            if (tipo === 'orgao' && a.situacao === 'acionado' && !nd.acionado_em) nd.acionado_em = a.em || new Date().toISOString();
            if (tipo === 'recurso' && a.status === 'no_local' && !nd.chegada_em) nd.chegada_em = a.em || new Date().toISOString();
            if (tipo === 'recurso' && a.status === 'solicitado' && !nd.solicitado_em) nd.solicitado_em = a.em || new Date().toISOString();
            r = await C.rpc('sci_salvar_item', { p_operacao: opId, p_id: atual ? atual.id : null, p_tipo: tipo, p_dados: nd });
            if (r) est.itens = est.itens.filter(function (x) { return x.id !== r.id; }).concat([r]);
          }
          if (r) res.ok++;
        } catch (e) { res.falhas++; res.erros.push(e.message); }
      }
      await carregar();
      return res;
    }

    function abrirFaltando() {
      var al = S.alertas(dados(), Date.now());
      var fechar = UI.abrirModal(el('div', { classe: 'sci-falta' }, [
        el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, ['O que falta', UI.dica('Em ordem de prioridade: segurança primeiro. Calculado com o que está no painel.')]),
        al.length ? listaAlertas(al) : el('p', { classe: 'muted', texto: 'Nada pendente com o que está registrado.' }),
        UI.rodape([botao('Fechar', function () { fechar(); }, 'btn-escuro')]),
      ]), { empilhar: true, tamanho: 'estreito' });
    }
    function listaAlertas(al) {
      return el('ul', { classe: 'sci-alertas' }, al.map(function (a) {
        return el('li', { classe: 'sci-alerta sci-alerta-' + a.nivel }, [el('span', { classe: 'sci-alerta-nivel', texto: a.nivel === 'critico' ? 'CRÍTICO' : a.nivel === 'alerta' ? 'ALERTA' : 'FALTA' }),
          el('button', { classe: 'sci-alerta-texto', type: 'button', texto: a.texto, onclick: function (ev) {
            if (ev.currentTarget.closest('.sci-falta')) UI.fecharModal();   // veio da janela "O que falta": fecha só ela
            var s = raiz.querySelector('#sci-' + a.bloco); if (s) s.scrollIntoView({ behavior: 'smooth' });
          } })]);
      }));
    }

    /* ---------- 1. Local ---------- */
    function secaoLocal() {
      var o = op(), imgs = itens('imagem'), pc = S.instalacao(est.itens, 'pc'), acv = S.instalacao(est.itens, 'acv'), zpa = itens('instalacao').filter(function (x) { return x.dados.tipo === 'zpa'; })[0];
      var aeronaves = itens('recurso').filter(function (r) { return r.dados.tipo === 'aeronave'; });
      var lk = o.local_lat != null ? S.links(o.local_lat, o.local_lng) : null;
      var galeria = el('div', { classe: 'sci-imagens' }, imgs.map(function (i) {
        var url = est.urls[i.dados.caminho];
        return el('figure', { classe: 'sci-imagem' }, [
          el('button', { type: 'button', classe: 'sci-imagem-botao', title: 'Ampliar', onclick: function () { ampliar(i, url); } }, [url ? el('img', { src: url, alt: i.dados.legenda || 'Imagem do local', loading: 'lazy' }) : el('span', { classe: 'muted', texto: 'carregando…' })]),
          el('figcaption', { texto: i.dados.legenda || '' }),
        ]);
      }));
      var anexar = null;
      if (pode()) {
        var arq = el('input', { type: 'file', accept: 'image/*', classe: 'sr-only', id: 'sci-img-arquivo' });
        arq.addEventListener('change', function () { var f = arq.files && arq.files[0]; arq.value = ''; if (f) enviarImagem(f); });
        anexar = el('label', { classe: 'btn btn-pequeno', for: 'sci-img-arquivo', texto: 'Anexar imagem de satélite' }, [arq]);
      }
      function coordLinha(rot, it) {
        var d = it && it.dados;
        var t = d ? [d.local, d.lat != null ? S.dms(d.lat, d.lng) : ''].filter(Boolean).join(' – ') : '';
        return el('div', { classe: 'kv' }, [el('dt', { texto: rot }), el('dd', { classe: t ? null : 'kv-vazio', texto: t || P })]);
      }
      return secao('local', 'Local da ocorrência', [anexar], [
        imgs.length ? galeria : el('p', { classe: 'muted', texto: 'Sem imagens. Anexe uma captura de satélite aproximada e uma ampla, com o ponto do acidente, o lado das vítimas, o lado das equipes e os acessos marcados.' }),
        el('dl', { classe: 'kv-grade' }, [
          el('div', { classe: 'kv kv-largo' }, [el('dt', { texto: 'Local' }), el('dd', null, [pend(o.local_endereco)])]),
          el('div', { classe: 'kv' }, [el('dt', { texto: 'Coordenadas' }), el('dd', null, [o.local_lat != null ? S.dms(o.local_lat, o.local_lng) : P, o.local_lat != null ? el('small', { classe: 'muted kv-sub', texto: o.local_lat.toFixed(4) + ', ' + o.local_lng.toFixed(4) }) : null])]),
          coordLinha('PC', pc), coordLinha('ACV', acv),
        ]),
        lk ? el('div', { classe: 'acoes-linha sci-links' }, [
          el('a', { classe: 'btn btn-pequeno', href: lk.satelite, target: '_blank', rel: 'noopener', texto: 'Satélite – Google Maps' }),
          el('a', { classe: 'btn btn-pequeno', href: lk.earth, target: '_blank', rel: 'noopener', texto: 'Google Earth' }),
          el('a', { classe: 'btn btn-pequeno', href: lk.osm, target: '_blank', rel: 'noopener', texto: 'OpenStreetMap' }),
          el('a', { classe: 'btn btn-pequeno btn-escuro', href: lk.rota, target: '_blank', rel: 'noopener', texto: 'Rota até o local' }),
          ctx.irPara ? botao('Ver no mapa', function () { ctx.irPara(o.local_lat, o.local_lng); }) : null,
        ]) : null,
        aeronaves.map(function (a) {
          var dd = a.dados, disp = dd.status === 'no_local' || dd.status === 'em_uso' || dd.status === 'a_caminho';
          return el('div', { classe: 'sci-aeronave ' + (disp ? 'sci-aeronave-ok' : 'sci-aeronave-nao') }, [
            el('strong', { texto: '✈ ' + dd.nome + (dd.orgao ? ' – ' + dd.orgao : '') + ' · ' + (S.STATUS_RECURSO[dd.status] || P) }),
            dd.nota ? el('div', { texto: dd.nota }) : null,
            el('div', { classe: 'muted', texto: 'Pouso: ' + (dd.local || (zpa && (zpa.dados.local || zpa.dados.nome)) || P) }),
          ]);
        }),
      ], 'Imagens marcadas primeiro: o comando remoto entende a cena pela imagem antes de ler os números.');
    }
    function ampliar(i, url) {
      var fechar = UI.abrirModal(el('div', { classe: 'sci-ampliada' }, [
        el('h2', { id: 'modal-titulo', texto: i.dados.legenda || 'Imagem do local' }),
        url ? el('img', { src: url, alt: i.dados.legenda || '' }) : null,
        UI.rodape([
          pode() ? botao('Editar legenda', async function () {
            var r = await UI.confirmar({ titulo: 'Legenda', campo: { rotulo: 'Legenda', valor: i.dados.legenda || '', max: 200 }, ok: 'Salvar', empilhar: true });
            if (r) { fechar(); rpc('sci_salvar_item', { p_operacao: opId, p_id: i.id, p_tipo: 'imagem', p_dados: { caminho: i.dados.caminho, legenda: r.texto } }, 'Legenda salva.'); }
          }) : null,
          pode() ? botao('Excluir', async function () {
            if (await UI.confirmar({ titulo: 'Excluir a imagem?', ok: 'Excluir', perigo: true, empilhar: true })) { fechar(); rpc('sci_excluir_item', { p_id: i.id }, 'Imagem excluída.'); }
          }, 'btn-perigo') : null,
          botao('Fechar', function () { fechar(); }, 'btn-escuro'),
        ]),
      ]), { tamanho: 'cheio', empilhar: true });
    }
    async function enviarImagem(arquivo) {
      var r = await UI.confirmar({ titulo: 'Legenda da imagem', texto: 'Ex.: "Cena: ponte destruída · ilhados à esquerda, equipes à direita".', campo: { rotulo: 'Legenda', max: 200 }, ok: 'Enviar', empilhar: true });
      if (!r) return;
      UI.aviso('Enviando a imagem…');
      try {
        var img = await window.Fotos.prepararImagem(arquivo);
        var caminho = opId + '/' + C.uuid() + '.jpg';
        var up = await C.cliente.storage.from(BUCKET).upload(caminho, await img.blob.arrayBuffer(), { contentType: 'image/jpeg', upsert: false });
        if (up.error) throw C.criarErro(up.error);
        await rpc('sci_salvar_item', { p_operacao: opId, p_id: null, p_tipo: 'imagem', p_dados: { caminho: caminho, legenda: r.texto } }, 'Imagem anexada.');
      } catch (e) { UI.aviso('A imagem não foi enviada: ' + e.message, 'erro', 8000); }
    }

    /* ---------- 2. Vítimas ---------- */
    function secaoVitimas() {
      var t = S.totais(est.vitimas, est.estado);
      function k(n, rot, classe) { return el('span', { classe: 'sci-k ' + (classe || '') }, [el('b', { texto: n == null ? P : String(n) }), rot]); }
      var tot = el('div', { classe: 'sci-totais' }, [
        el('button', { type: 'button', classe: 'sci-k sci-k-total' + (t.informado != null && !t.confirmado ? ' sci-nao-conf' : ''), id: 'sci-total', disabled: pode() ? null : true, onclick: editarTotal, title: 'Total informado (toque para editar)' },
          [el('b', { texto: t.informado == null ? P : String(t.informado) }), 'total de vítimas', t.informado != null && !t.confirmado ? el('small', { texto: 'NÃO CONFIRMADO' }) : null]),
        k(t.localizadas, 'localizadas'), k(t.naoLocalizadas, 'ainda não localizadas', t.naoLocalizadas ? 'sci-k-crit' : ''), k(t.removidas, 'removidas da água/ilha'),
        k(t.transportadas, 'transportadas'), k(t.obitos, 'óbitos', t.obitos ? 'sci-k-crit' : ''),
      ]);
      var quadro = el('div', { classe: 'sci-quadro', id: 'sci-quadro' }, S.FASES.map(function (f) {
        var pf = t.porFase[f[0]];
        var cards = est.vitimas.filter(function (v) { return v.fase === f[0]; }).map(cartaoVitima);
        return el('div', { classe: 'sci-coluna', 'data-fase': f[0] }, [
          el('div', { classe: 'sci-coluna-topo' }, [el('div', null, [el('strong', { texto: f[1] }), el('small', { texto: f[2] })]), el('b', { classe: 'sci-coluna-n', texto: String(pf.n) })]),
          f[0] === 'localizada' ? el('div', { classe: 'sci-tri-mini muted', texto: 'Cor só depois da triagem na ACV' })
            : el('div', { classe: 'sci-tri-mini' }, ['verde', 'amarelo', 'vermelho', 'cinza'].map(function (c) { return el('span', null, [el('i', { style: 'background:' + CORES_TRIAGEM[c] }), String(pf[c])]); })),
          el('div', { classe: 'sci-cards' }, cards.length ? cards : [el('p', { classe: 'muted sci-coluna-vazia', texto: f[0] === 'localizada' ? 'Nenhuma vítima aguardando remoção.' : 'Arraste uma vítima para cá.' })]),
        ]);
      }));
      return secao('vitimas', 'Vítimas', [
        pode() ? botao('+ Vítima localizada', novaVitima, 'btn-escuro', { id: 'sci-nova-vitima' }) : null,
      ], [
        tot,
        t.divergencia ? el('p', { classe: 'sci-divergencias', role: 'alert', texto: t.divergencia }) : null,
        quadro,
        el('p', { classe: 'muted sci-legenda' }, ['Verde', 'Amarelo', 'Vermelho', 'Cinza – óbito'].map(function (n, i) {
          return el('span', null, [el('i', { style: 'background:' + CORES_TRIAGEM[['verde', 'amarelo', 'vermelho', 'cinza'][i]] }), n]);
        }).concat([el('span', null, [el('i', { classe: 'sem-cor' }), 'Aguardando triagem (ACV)']), pode() ? ' · Arraste para o próximo quadro. Toque para editar.' : ''])),
      ], 'Localizadas → Removidas para a ACV → Transportadas. Mudar de quadro registra o horário na linha do tempo.');
    }
    function cartaoVitima(v) {
      var cor = v.fase !== 'localizada' && v.triagem ? CORES_TRIAGEM[v.triagem] : null;
      var titulo = S.vnum(v.numero) + ' · ' + (v.nome || 'sem nome') + ' · ' + (v.sexo === 'F' ? 'Feminino' : v.sexo === 'M' ? 'Masculino' : 'sexo ' + P) + (v.destino ? ' · ' + v.destino : '');
      var c = el('div', { classe: 'sci-vq' + (cor ? '' : ' sem-cor') + (v.triagem === 'cinza' && cor ? ' obito' : ''), tabindex: '0', role: 'button', 'data-id': v.id, title: titulo,
        'aria-label': titulo + (cor ? ', triagem ' + S.TRIAGEM[v.triagem] : ', aguardando triagem'), style: cor ? 'background:' + cor + ';color:' + (v.triagem === 'amarelo' || v.triagem === 'verde' ? '#111' : '#fff') : null }, [
        el('b', { texto: dois(v.numero) }), el('span', { classe: 'sci-vq-nome', texto: v.nome ? v.nome.split(' ')[0] : '—' }), el('span', { texto: v.sexo || '' }),
      ]);
      c.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); editarVitima(v); } });
      ligarArraste(c, v);
      return c;
    }
    // Arrastar com mouse ou dedo (pointer events). Toque sem arrastar abre a ficha.
    function ligarArraste(no, v) {
      var ini = null, fantasma = null, alvo = null;
      no.addEventListener('pointerdown', function (ev) { if (ev.button !== 0) return; ini = { x: ev.clientX, y: ev.clientY, id: ev.pointerId }; });
      no.addEventListener('pointermove', function (ev) {
        if (!ini || ev.pointerId !== ini.id) return;
        if (!fantasma && Math.hypot(ev.clientX - ini.x, ev.clientY - ini.y) > 8 && pode()) {
          est.arrastando = true;
          try { no.setPointerCapture(ev.pointerId); } catch (e) { /* ignora */ }
          fantasma = no.cloneNode(true); fantasma.classList.add('sci-fantasma'); document.body.appendChild(fantasma); no.classList.add('sci-origem');
        }
        if (!fantasma) return;
        ev.preventDefault();
        fantasma.style.left = (ev.clientX - 22) + 'px'; fantasma.style.top = (ev.clientY - 22) + 'px';
        // perto da borda da tela, rola (no celular os quadros ficam um embaixo do outro)
        var rol = raiz.closest('.modal-corpo') || document.scrollingElement;
        if (rol) { var h = window.innerHeight; if (ev.clientY > h - 70) rol.scrollTop += 14; else if (ev.clientY < 70) rol.scrollTop -= 14; }
        fantasma.hidden = true;
        var debaixo = document.elementFromPoint(ev.clientX, ev.clientY);
        fantasma.hidden = false;
        var col = debaixo && debaixo.closest ? debaixo.closest('.sci-coluna') : null;
        if (alvo && alvo !== col) alvo.classList.remove('sci-alvo');
        alvo = col; if (alvo) alvo.classList.add('sci-alvo');
      });
      function soltar(ev, cancelar) {
        if (!ini) return;
        var arrastou = Boolean(fantasma);
        if (fantasma) fantasma.remove();
        fantasma = null; no.classList.remove('sci-origem');
        if (alvo) alvo.classList.remove('sci-alvo');
        var fase = alvo && alvo.getAttribute('data-fase');
        alvo = null; ini = null; est.arrastando = false;
        if (arrastou) {
          if (!cancelar && fase && fase !== v.fase) moverVitima(v, fase);
          else if (est.pendenteRender) { est.pendenteRender = false; render(); }
        } else if (!cancelar) editarVitima(v);
      }
      no.addEventListener('pointerup', function (ev) { soltar(ev, false); });
      no.addEventListener('pointercancel', function (ev) { soltar(ev, true); });
    }
    function moverVitima(v, fase) {
      var dd = { fase: fase };
      if (fase === 'transportada' && !v.destino) {
        UI.confirmar({ titulo: S.vnum(v.numero) + ' transportada para onde?', campo: { rotulo: 'Destino (hospital, abrigo…)', max: 200 }, ok: 'Transportada', empilhar: true }).then(function (r) {
          if (!r) { render(); return; }
          dd.destino = r.texto;
          rpc('sci_salvar_vitima', { p_operacao: opId, p_id: v.id, p_dados: dd }, S.vnum(v.numero) + ' transportada.');
        });
        return;
      }
      rpc('sci_salvar_vitima', { p_operacao: opId, p_id: v.id, p_dados: dd }, S.vnum(v.numero) + ' → ' + S.rotulo(S.FASES, fase) + '.');
    }
    async function novaVitima() {
      var r = await rpc('sci_salvar_vitima', { p_operacao: opId, p_id: null, p_dados: {} });
      if (r) { UI.aviso(S.vnum(r.numero) + ' localizada às ' + S.horaCurta(r.localizada_em).slice(6) + '. Toque no quadrado para completar.', 'ok'); }
    }
    async function editarTotal() {
      if (!pode()) return;
      var e = est.estado;
      var n = el('input', { classe: 'campo', id: 'sci-total-n', type: 'number', min: '0', max: '100000', step: '1', inputmode: 'numeric', value: e.total_vitimas == null ? '' : String(e.total_vitimas) });
      var cf = el('input', { type: 'checkbox', id: 'sci-total-conf', checked: e.total_confirmado ? true : null });
      var fechar = UI.abrirModal(el('form', { novalidate: true }, [
        el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, ['Total de vítimas', UI.dica('Em branco = [PENDENTE]. Informado por terceiros fica NÃO CONFIRMADO até a equipe confirmar.')]),
        UI.campo('Total informado', n, { para: 'sci-total-n' }),
        el('label', { classe: 'linha-opcao' }, [cf, ' Confirmado pela equipe']),
        UI.rodape([botao('Cancelar', function () { fechar(); }), el('button', { classe: 'btn btn-escuro', type: 'submit', texto: 'Salvar' })]),
      ]), { tamanho: 'estreito', empilhar: true });
      n.closest('form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        var v = n.value.trim() === '' ? null : Number(n.value);
        if (v != null && !(Number.isInteger(v) && v >= 0)) { n.focus(); return; }
        fechar();
        rpc('sci_salvar_estado', { p_operacao: opId, p_dados: { total_vitimas: v, total_confirmado: cf.checked } }, 'Total salvo.');
      });
    }
    function editarVitima(v) {
      var ro = !pode();
      function inp(id, valor, attrs) { var i = el('input', Object.assign({ classe: 'campo', id: id, disabled: ro ? true : null }, attrs || {})); i.value = valor == null ? '' : valor; return i; }
      function sel(id, opcoes, valor) { return el('select', { classe: 'campo', id: id, disabled: ro ? true : null }, opcoes.map(function (o) { return el('option', { value: o[0], selected: (valor || '') === o[0] ? true : null, texto: o[1] }); })); }
      var numero = inp('sci-v-num', v.numero, { type: 'number', min: '1', max: '9999' });
      var nome = inp('sci-v-nome', v.nome, { maxlength: '80', placeholder: 'sem nome' });
      var idade = inp('sci-v-idade', v.idade, { type: 'number', min: '0', max: '130' });
      var est2 = el('input', { type: 'checkbox', id: 'sci-v-idade-est', checked: v.idade_estimada ? true : null, disabled: ro ? true : null });
      var sexo = sel('sci-v-sexo', [['', P], ['F', 'Feminino'], ['M', 'Masculino']], v.sexo);
      var fase = sel('sci-v-fase', S.FASES.map(function (f) { return [f[0], f[1]]; }), v.fase);
      var tri = sel('sci-v-tri', [['', 'Aguardando triagem']].concat(Object.keys(S.TRIAGEM).map(function (k) { return [k, S.TRIAGEM[k]]; })), v.triagem);
      var local = inp('sci-v-local', v.local, { maxlength: '200', placeholder: 'onde foi localizada' });
      var destino = inp('sci-v-dest', v.destino, { maxlength: '200', placeholder: 'hospital, abrigo…' });
      var obs = el('textarea', { classe: 'campo', id: 'sci-v-obs', rows: '2', maxlength: '1000', disabled: ro ? true : null }); obs.value = v.observacoes || '';
      var quando = inp('sci-v-quando', dataLocal(Date.now()), { type: 'datetime-local' });
      var erro = el('p', { classe: 'erro-form', hidden: true });
      var horarios = el('dl', { classe: 'kv-grade' }, [['Localizada', v.localizada_em], ['Removida para a ACV', v.removida_em], ['Triada', v.triada_em], ['Transportada', v.transportada_em]].map(function (x) {
        return el('div', { classe: 'kv' }, [el('dt', { texto: x[0] }), el('dd', { classe: x[1] ? null : 'kv-vazio', texto: x[1] ? S.horaCurta(x[1]) : '—' })]);
      }));
      var proxima = { localizada: 'removida', removida: 'transportada' }[v.fase];
      var form = el('form', { classe: 'sci-form-vitima', novalidate: true }, [
        el('h2', { id: 'modal-titulo', texto: S.vnum(v.numero) + (v.nome ? ' · ' + v.nome : '') }),
        horarios,
        UI.grade([UI.campo('Número', numero, { para: 'sci-v-num' }), UI.campo('Nome', nome, { para: 'sci-v-nome', opcional: true }),
          UI.campo('Idade', el('div', { classe: 'idade-linha' }, [idade, el('label', { classe: 'check-curto', for: 'sci-v-idade-est' }, [est2, ' estimada'])]), { para: 'sci-v-idade', opcional: true }),
          UI.campo('Sexo', sexo, { para: 'sci-v-sexo' }),
          UI.campo('Quadro', fase, { para: 'sci-v-fase' }), UI.campo('Triagem (na ACV)', tri, { para: 'sci-v-tri' }),
          UI.campo('Onde foi localizada', local, { para: 'sci-v-local', opcional: true }), UI.campo('Destino', destino, { para: 'sci-v-dest', opcional: true })]),
        UI.campo('Observações', obs, { para: 'sci-v-obs', opcional: true }),
        ro ? null : UI.campo('Hora do fato (mudança de quadro ou triagem)', quando, { para: 'sci-v-quando', ajuda: 'Deixe "agora" se aconteceu agora.' }),
        erro,
        UI.rodape(ro ? [botao('Fechar', function () { fechar(); }, 'btn-escuro')] : [
          botao('Retirar do quadro', excluir, 'btn-perigo'),
          botao('Cancelar', function () { fechar(); }),
          proxima ? botao('→ ' + S.rotulo(S.FASES, proxima), function () { fase.value = proxima; form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); }) : null,
          el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'sci-v-salvar', texto: 'Salvar' }),
        ]),
      ]);
      async function excluir() {
        var r = await UI.confirmar({ titulo: 'Retirar ' + S.vnum(v.numero) + ' do quadro?', texto: 'Use para lançamento errado ou duplicado. Fica registrado na linha do tempo.', campo: { rotulo: 'Motivo (obrigatório)', obrigatorio: true, max: 300 }, ok: 'Retirar', perigo: true, empilhar: true });
        if (r) { fechar(); rpc('sci_excluir_vitima', { p_id: v.id, p_motivo: r.texto }, S.vnum(v.numero) + ' retirada do quadro.'); }
      }
      form.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        if (ro) return;
        var dd = { numero: Number(numero.value), nome: nome.value, idade: idade.value.trim() === '' ? null : Number(idade.value), idade_estimada: est2.checked,
          sexo: sexo.value, fase: fase.value, triagem: tri.value, local: local.value, destino: destino.value, observacoes: obs.value, em: iso(quando.value) };
        if (dd.fase === 'transportada' && !dd.destino.trim()) { erro.textContent = 'Informe o destino (hospital, abrigo…).'; erro.hidden = false; destino.focus(); return; }
        var r = await rpc('sci_salvar_vitima', { p_operacao: opId, p_id: v.id, p_dados: dd }, S.vnum(dd.numero) + ' salva.');
        if (r) fechar();
      });
      var fechar = UI.abrirModal(form, { empilhar: true });
    }

    /* ---------- 3. Quem responde por quê ---------- */
    function secaoComando() {
      var e = est.estado;
      var funcoes = el('div', { classe: 'sci-funcoes' }, S.FUNCOES.map(function (f) {
        var nome = S.nomeFuncao(e, f[0]);
        return el('button', { type: 'button', classe: 'sci-funcao' + (f[0] === 'ci' ? ' sci-funcao-ci' : ''), disabled: pode() ? null : true, onclick: editarFuncoes }, [el('small', { texto: f[1] }), pend(nome)]);
      }));
      var inst = el('div', { classe: 'sci-instalacoes' }, itens('instalacao').map(function (i) {
        var d = i.dados, desat = d.estado === 'desativada';
        return el('button', { type: 'button', classe: 'sci-instalacao' + (desat ? ' sci-desativada' : ''), onclick: function () { formItem('instalacao', i); } }, [
          el('strong', { texto: d.nome }),
          el('span', null, ['Responsável: ', pend(d.responsavel)]),
          d.local ? el('small', { texto: d.local }) : null,
          d.lat != null ? el('small', { classe: 'muted', texto: d.lat.toFixed(6) + ', ' + d.lng.toFixed(6) }) : null,
          desat ? el('small', { classe: 'sci-desat', texto: 'DESATIVADA' + (d.desativada_em ? ' às ' + S.horaCurta(d.desativada_em).slice(6) : '') + (d.motivo ? ' – ' + d.motivo : '') }) : d.estado === 'planejada' ? el('small', { texto: 'Planejada' }) : null,
        ]);
      }));
      var setores = (ctx.setores ? ctx.setores() : []) || [];
      var canais = itens('canal');
      return secao('comando', 'Quem responde por quê', [
        pode() ? botao('Editar funções SCI', editarFuncoes, 'btn-escuro', { id: 'sci-funcoes-editar' }) : null,
        pode() ? botao('+ Instalação', function () { formItem('instalacao', null); }) : null,
      ], [
        el('h4', { classe: 'sci-sub', texto: 'Funções SCI' }), funcoes,
        el('h4', { classe: 'sci-sub', texto: 'Instalações ativadas' }), itens('instalacao').length ? inst : el('p', { classe: 'muted', texto: 'Nenhuma instalação registrada (PC, Área de Espera, ACV, ZPA, Abrigo, GGI).' }),
        el('h4', { classe: 'sci-sub', texto: 'Setores de operação' }),
        setores.length ? el('ul', { classe: 'sci-lista-simples' }, setores.map(function (s) {
          return el('li', null, [el('i', { classe: 'chip-cor', style: 'background:' + (s.cor || '#888') }), el('strong', { texto: s.nome }), el('span', { classe: 'muted', texto: ' · ' + ({ pendente: 'pendente', andamento: 'em andamento', concluido: 'concluído' }[s.status] || s.status || '') + (s.equipe ? ' · ' + s.equipe : '') })]);
        })) : el('p', { classe: 'muted', texto: 'Nenhum setor definido.' }),
        el('div', { classe: 'sci-sub-linha' }, [el('h4', { classe: 'sci-sub', texto: 'Comunicações' }), pode() ? botao('+ Canal', function () { formItem('canal', null); }) : null]),
        canais.length ? tabela(['Canal', 'Função', 'Usuários'], canais.map(function (c) { return { item: c, celulas: [c.dados.nome, c.dados.funcao || P, c.dados.usuarios || P] }; }), 'canal')
          : el('p', { classe: 'muted', texto: 'Nenhum canal registrado.' }),
      ], 'Função vazia aparece como [PENDENTE]. Toque para editar.');
    }
    function editarFuncoes() {
      if (!pode()) return;
      var e = est.estado, campos = {};
      var linhas = S.FUNCOES.map(function (f) {
        var atual = (e.funcoes && e.funcoes[f[0]]) || {};
        var nome = el('input', { classe: 'campo', id: 'sci-f-' + f[0], maxlength: '80', placeholder: P });
        nome.value = atual.nome || '';
        var acu = f[0] === 'ci' ? null : el('input', { type: 'checkbox', id: 'sci-f-acu-' + f[0], checked: atual.acumula_ci ? true : null });
        if (acu) acu.addEventListener('change', function () { nome.disabled = acu.checked; });
        nome.disabled = Boolean(acu && acu.checked);
        campos[f[0]] = { nome: nome, acu: acu, atual: atual };
        return UI.campo(f[1], el('div', { classe: 'idade-linha' }, [nome, acu ? el('label', { classe: 'check-curto', for: 'sci-f-acu-' + f[0] }, [acu, ' acumula (CI)']) : null]), { para: 'sci-f-' + f[0] });
      });
      var acomp = el('input', { classe: 'campo', id: 'sci-acomp', maxlength: '300', placeholder: 'Ex.: Cap Prado – Central de Operações (quartel), em contato com o CI' });
      acomp.value = e.acompanhamento || '';
      var form = el('form', { novalidate: true }, [
        el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, ['Funções SCI', UI.dica('Posto e nome de quem responde. "Acumula (CI)": a função fica com o Comandante do Incidente.')]),
        UI.grade(linhas), UI.campo('Acompanhamento remoto', acomp, { para: 'sci-acomp', opcional: true, largo: true }),
        UI.rodape([botao('Cancelar', function () { fechar(); }), el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'sci-f-salvar', texto: 'Salvar' })]),
      ]);
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var mud = {};
        Object.keys(campos).forEach(function (k) {
          var c = campos[k], n = c.nome.value.replace(/\s+/g, ' ').trim(), a = Boolean(c.acu && c.acu.checked);
          if (n !== (c.atual.nome || '') || a !== Boolean(c.atual.acumula_ci)) mud[k] = { nome: n, acumula_ci: a };
        });
        fechar();
        var dd = {};
        if (Object.keys(mud).length) dd.funcoes = mud;
        if (acomp.value.trim() !== (e.acompanhamento || '')) dd.acompanhamento = acomp.value;
        if (Object.keys(dd).length) rpc('sci_salvar_estado', { p_operacao: opId, p_dados: dd }, 'Funções salvas.');
      });
      var fechar = UI.abrirModal(form, { empilhar: true });
    }

    /* ---------- Itens genéricos: formulário e tabela ---------- */
    var CAMPOS = {
      instalacao: [['tipo', 'Tipo', 'sel', S.INSTALACOES], ['nome', 'Nome', 'txt'], ['responsavel', 'Responsável', 'txt'], ['estado', 'Situação', 'sel', S.ESTADO_INSTALACAO],
        ['local', 'Local / descrição', 'txt'], ['lat', 'Latitude', 'num'], ['lng', 'Longitude', 'num'], ['desativada_em', 'Desativada em', 'hora'], ['motivo', 'Motivo (desativação)', 'area'], ['nota', 'Observação', 'area']],
      equipe: [['nome', 'Equipe', 'txt'], ['orgao', 'Órgão', 'txt'], ['efetivo', 'Efetivo (pessoas)', 'int'], ['status', 'Status', 'sel', S.STATUS_EQUIPE], ['missao', 'Missão', 'area'],
        ['funcao', 'Função (organograma)', 'txt'], ['chefe', 'Responsável / chefe', 'txt'], ['setor', 'Setor', 'txt'], ['meios', 'Meios', 'txt'], ['notas', 'Andamento / notas', 'area']],
      orgao: [['nome', 'Órgão', 'txt'], ['situacao', 'Situação', 'sel', S.SITUACAO_ORGAO], ['pessoas', 'Pessoas', 'int'], ['viaturas', 'Viaturas', 'int'], ['detalhe', 'Detalhamento do efetivo', 'area'],
        ['missao', 'Missão', 'area'], ['acionado_em', 'Acionado em', 'hora'], ['chegada_em', 'Chegada', 'hora'], ['nota', 'Observação', 'area']],
      recurso: [['nome', 'Recurso', 'txt'], ['tipo', 'Tipo', 'sel', S.TIPO_RECURSO], ['orgao', 'Órgão', 'txt'], ['qtd', 'Quantidade', 'int'], ['status', 'Status', 'sel', S.STATUS_RECURSO],
        ['local', 'Local / designação', 'txt'], ['solicitado_em', 'Solicitado em', 'hora'], ['chegada_em', 'Chegada', 'hora'], ['nota', 'Observação', 'area']],
      canal: [['nome', 'Canal', 'txt'], ['funcao', 'Função', 'txt'], ['usuarios', 'Usuários', 'txt']],
      leitura_rio: [['em', 'Hora da leitura', 'hora'], ['ponto', 'Ponto', 'txt'], ['nivel', 'Nível', 'txt'], ['vazao', 'Vazão / vertedouro', 'txt'], ['tendencia', 'Tendência', 'sel', S.TENDENCIA], ['fonte', 'Fonte', 'txt']],
    };
    var TITULOS = { instalacao: 'Instalação', equipe: 'Equipe e missão', orgao: 'Órgão envolvido', recurso: 'Recurso / pedido', canal: 'Canal de comunicação', leitura_rio: 'Leitura do nível do rio' };
    function formItem(tipo, item) {
      var ro = !pode(), d = item ? item.dados : (tipo === 'leitura_rio' ? { em: new Date().toISOString(), tendencia: 'a_confirmar' } : tipo === 'instalacao' ? { estado: 'ativa' } : {});
      var ctrls = {};
      var campos = CAMPOS[tipo].map(function (c) {
        var id = 'sci-i-' + c[0], ctl;
        if (c[2] === 'sel') ctl = el('select', { classe: 'campo', id: id }, [el('option', { value: '', texto: P })].concat(Object.keys(c[3]).map(function (k) { return el('option', { value: k, selected: d[c[0]] === k ? true : null, texto: c[3][k] }); })));
        else if (c[2] === 'area') { ctl = el('textarea', { classe: 'campo', id: id, rows: '2', maxlength: '1000' }); ctl.value = d[c[0]] || ''; }
        else if (c[2] === 'hora') ctl = el('input', { classe: 'campo', id: id, type: 'datetime-local', value: d[c[0]] ? dataLocal(d[c[0]]) : '' });
        else if (c[2] === 'int' || c[2] === 'num') ctl = el('input', { classe: 'campo', id: id, type: 'number', step: c[2] === 'int' ? '1' : 'any', min: c[2] === 'int' ? '0' : null, inputmode: 'decimal', value: d[c[0]] == null ? '' : String(d[c[0]]), placeholder: c[2] === 'int' ? '? (não informado)' : '' });
        else { ctl = el('input', { classe: 'campo', id: id, maxlength: '200' }); ctl.value = d[c[0]] || ''; }
        if (ro) ctl.disabled = true;
        ctrls[c[0]] = { ctl: ctl, tipo: c[2] };
        return UI.campo(c[1], ctl, { para: id, largo: c[2] === 'area' });
      });
      var erro = el('p', { classe: 'erro-form', hidden: true });
      var form = el('form', { novalidate: true, classe: 'sci-form-item' }, [
        el('h2', { id: 'modal-titulo', texto: (item ? '' : 'Nova: ') + TITULOS[tipo] }),
        UI.grade(campos), erro,
        UI.rodape(ro ? [botao('Fechar', function () { fechar(); }, 'btn-escuro')] : [
          item ? botao('Excluir', async function () { if (await UI.confirmar({ titulo: 'Excluir?', texto: 'O histórico na linha do tempo continua.', ok: 'Excluir', perigo: true, empilhar: true })) { fechar(); rpc('sci_excluir_item', { p_id: item.id }, 'Excluído.'); } }, 'btn-perigo') : null,
          botao('Cancelar', function () { fechar(); }),
          el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'sci-i-salvar', texto: 'Salvar' }),
        ]),
      ]);
      form.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        var dd = {};
        Object.keys(ctrls).forEach(function (k) {
          var c = ctrls[k], v = c.ctl.value;
          if (v === '' || v == null) return;
          if (c.tipo === 'int' || c.tipo === 'num') dd[k] = Number(v);
          else if (c.tipo === 'hora') dd[k] = iso(v);
          else dd[k] = v;
        });
        if (tipo === 'instalacao' && !dd.nome && dd.tipo) dd.nome = S.INSTALACOES[dd.tipo];
        if (tipo === 'instalacao' && dd.estado === 'desativada' && !dd.desativada_em) dd.desativada_em = new Date().toISOString();
        if (!dd[tipo === 'leitura_rio' ? 'em' : 'nome']) { erro.textContent = tipo === 'leitura_rio' ? 'Informe a hora da leitura.' : 'Informe o nome.'; erro.hidden = false; return; }
        var r = await rpc('sci_salvar_item', { p_operacao: opId, p_id: item ? item.id : null, p_tipo: tipo, p_dados: dd }, 'Salvo.');
        if (r) fechar();
      });
      var fechar = UI.abrirModal(form, { empilhar: true });
    }
    function tabela(cabecas, linhas, tipo) {
      return el('div', { classe: 'sci-tabela-rolagem' }, [el('table', { classe: 'sci-tabela' }, [
        el('thead', null, [el('tr', null, cabecas.map(function (c) { return el('th', { texto: c }); }))]),
        el('tbody', null, linhas.map(function (l) {
          var tr = el('tr', { tabindex: '0', onclick: function () { formItem(tipo, l.item); } }, l.celulas.map(function (c) { return el('td', null, [c === P ? el('span', { classe: 'sci-pend', texto: P }) : c]); }));
          tr.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') formItem(tipo, l.item); });
          return tr;
        })),
      ])]);
    }

    /* ---------- 4. Linha do tempo ---------- */
    function secaoLinha() {
      var e = est.estado;
      var marcos = el('ol', { classe: 'sci-marcos' }, S.MARCOS.map(function (m) {
        var v = e.marcos[m[0]];
        // acionamento ainda não marcado no SCI: mostra o do cadastro da operação, para confirmar com um toque
        var doCadastro = !v && m[0] === 'acionamento' && op().acionado_em ? op().acionado_em : null;
        return el('li', { classe: v ? 'feito' : '' }, [
          el('span', { classe: 'sci-marco-rot', texto: m[1] }),
          el('span', { classe: 'sci-marco-hora num', texto: v ? S.horaCurta(v) : doCadastro ? S.horaCurta(doCadastro) + ' (cadastro)' : 'aguardando' }),
          pode() ? el('span', { classe: 'sci-marco-acoes' }, v ? [botao('Corrigir', function () { informarHora(m, v); })]
            : doCadastro ? [botao('Confirmar', function () { rpc('sci_marcar', { p_operacao: opId, p_marco: m[0], p_em: doCadastro }, m[1] + ' confirmado.'); }, 'btn-escuro'), botao('Informar hora', function () { informarHora(m, doCadastro); })]
            : [botao('Agora', function () { rpc('sci_marcar', { p_operacao: opId, p_marco: m[0] }, m[1] + ': agora.'); }, 'btn-escuro', { 'data-marco': m[0] }), botao('Informar hora', function () { informarHora(m, null); })]) : null,
        ]);
      }));
      var cats = Object.keys(S.CATEGORIAS);
      var filtro = el('div', { classe: 'sci-filtro' }, [['', 'Todos']].concat(cats.map(function (k) { return [k, S.CATEGORIAS[k]]; })).map(function (c) {
        return el('button', { type: 'button', classe: 'chip-filtro' + (est.filtro === c[0] ? ' ativo' : ''), texto: c[1], onclick: function () { est.filtro = c[0]; render(); } });
      }));
      var lista = est.eventos.filter(function (x) { return !est.filtro || x.categoria === est.filtro; }).slice().sort(function (a, b) { return Date.parse(b.ocorrido_em) - Date.parse(a.ocorrido_em); });
      var eventos = el('ul', { classe: 'sci-eventos' }, lista.slice(0, 400).map(function (x) {
        var hist = x.historico || [];
        return el('li', { classe: 'sci-evento sci-cat-' + x.categoria + (x.anulado_em ? ' sci-anulado' : '') }, [
          el('span', { classe: 'sci-ev-hora num', texto: S.horaCurta(x.ocorrido_em) }),
          el('span', { classe: 'sci-ev-cat', texto: S.CATEGORIAS[x.categoria] }),
          el('div', { classe: 'sci-ev-texto' }, [
            el('span', { texto: x.texto }),
            x.nao_confirmada && !x.anulado_em ? el('span', { classe: 'selo selo-alerta', texto: 'NÃO CONFIRMADA' }) : null,
            x.corrigido_em ? el('small', { classe: 'muted', texto: ' Corrigido às ' + S.horaCurta(x.corrigido_em).slice(6) + (hist.length ? ': antes "' + hist[hist.length - 1].texto + '"' + (hist[hist.length - 1].motivo ? ' (' + hist[hist.length - 1].motivo + ')' : '') : '') }) : null,
            x.anulado_em ? el('small', { classe: 'muted', texto: ' Anulado por ' + x.anulado_por_nome + ': ' + x.anulado_motivo }) : null,
            x.confirmada_em ? el('small', { classe: 'muted', texto: ' Confirmada por ' + x.confirmada_por_nome + ' às ' + S.horaCurta(x.confirmada_em).slice(6) }) : null,
          ]),
          pode() && !x.anulado_em ? el('span', { classe: 'sci-ev-acoes' }, [
            x.nao_confirmada ? botao('Confirmar', function () { rpc('sci_confirmar_evento', { p_id: x.id }, 'Confirmada.'); }) : null,
            botao('Corrigir', function () { corrigirEvento(x); }),
            botao('Anular', async function () { var r = await UI.confirmar({ titulo: 'Anular o registro?', texto: x.texto, campo: { rotulo: 'Motivo (obrigatório)', obrigatorio: true, max: 300 }, ok: 'Anular', perigo: true, empilhar: true }); if (r) rpc('sci_anular_evento', { p_id: x.id, p_motivo: r.texto }, 'Registro anulado.'); }, 'btn-link'),
          ]) : null,
        ]);
      }));
      return secao('linha', 'Linha do tempo da operação', [pode() ? botao('+ Registro', function () { novoEvento(); }, 'btn-escuro', { id: 'sci-novo-registro' }) : null], [
        marcos, filtro,
        lista.length ? eventos : el('p', { classe: 'muted', texto: 'Nenhum registro ainda.' }),
      ], 'Marcos com "Agora" ou a hora informada. Cada movimento de vítima, órgão, recurso e instalação entra sozinho.');
    }
    async function informarHora(m, atual) {
      var h = el('input', { classe: 'campo', id: 'sci-m-hora', type: 'datetime-local', value: dataLocal(atual || Date.now()) });
      var fechar = UI.abrirModal(el('form', { novalidate: true }, [
        el('h2', { id: 'modal-titulo', texto: m[1] }), UI.campo('Data e hora', h, { para: 'sci-m-hora' }),
        UI.rodape([
          atual ? botao('Retirar marco', function () { fechar(); rpc('sci_marcar', { p_operacao: opId, p_marco: m[0], p_apagar: true }, 'Marco retirado.'); }, 'btn-perigo') : null,
          botao('Cancelar', function () { fechar(); }), el('button', { classe: 'btn btn-escuro', type: 'submit', texto: 'Salvar' })]),
      ]), { tamanho: 'estreito', empilhar: true });
      h.closest('form').addEventListener('submit', function (ev) { ev.preventDefault(); fechar(); rpc('sci_marcar', { p_operacao: opId, p_marco: m[0], p_em: iso(h.value) }, m[1] + ' registrado.'); });
    }
    function formEvento(x, aoSalvar) {
      var h = el('input', { classe: 'campo', id: 'sci-e-hora', type: 'datetime-local', value: dataLocal(x ? x.ocorrido_em : Date.now()) });
      var cat = el('select', { classe: 'campo', id: 'sci-e-cat' }, Object.keys(S.CATEGORIAS).map(function (k) { return el('option', { value: k, selected: (x ? x.categoria : 'decisao') === k ? true : null, texto: S.CATEGORIAS[k] }); }));
      var t = el('textarea', { classe: 'campo', id: 'sci-e-texto', rows: '3', maxlength: '1000' }); t.value = x ? x.texto : '';
      var nc = el('input', { type: 'checkbox', id: 'sci-e-nc' });
      var motivo = el('input', { classe: 'campo', id: 'sci-e-motivo', maxlength: '300', placeholder: 'Ex.: eram 11 ilhados, não 9' });
      var form = el('form', { novalidate: true }, [
        el('h2', { id: 'modal-titulo', texto: x ? 'Corrigir registro' : 'Novo registro' }),
        UI.grade([UI.campo('Hora', h, { para: 'sci-e-hora' }), UI.campo('Categoria', cat, { para: 'sci-e-cat' })]),
        UI.campo('O que aconteceu', t, { para: 'sci-e-texto', largo: true }),
        x ? UI.campo('Motivo da correção', motivo, { para: 'sci-e-motivo', opcional: true }) : el('label', { classe: 'linha-opcao' }, [nc, ' Informação de terceiros, NÃO CONFIRMADA pela equipe']),
        UI.rodape([botao('Cancelar', function () { fechar(); }), el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'sci-e-salvar', texto: 'Salvar' })]),
      ]);
      form.addEventListener('submit', function (ev) { ev.preventDefault(); if (!t.value.trim()) { t.focus(); return; } fechar(); aoSalvar({ em: iso(h.value), categoria: cat.value, texto: t.value, nao_confirmada: nc.checked, motivo: motivo.value }); });
      var fechar = UI.abrirModal(form, { empilhar: true });
    }
    function novoEvento() { formEvento(null, function (d) { rpc('sci_registrar_evento', { p_operacao: opId, p_dados: d }, 'Registrado.'); }); }
    function corrigirEvento(x) { formEvento(x, function (d) { rpc('sci_corrigir_evento', { p_id: x.id, p_dados: d }, 'Correção registrada (o texto anterior fica guardado).'); }); }

    /* ---------- 5. Missão de cada equipe ---------- */
    function secaoMissoes() {
      var eq = itens('equipe');
      return secao('missoes', 'Missão de cada equipe', [pode() ? botao('+ Equipe', function () { formItem('equipe', null); }, 'btn-escuro') : null], [
        eq.length ? el('ul', { classe: 'sci-missoes' }, eq.map(function (i) {
          var d = i.dados;
          return el('li', null, [el('button', { type: 'button', classe: 'sci-missao', style: '--faixa:' + (CORES_EQUIPE[d.status] || '#888'), onclick: function () { formItem('equipe', i); } }, [
            el('div', { classe: 'sci-missao-cab' }, [el('strong', { texto: d.nome }), el('span', { classe: 'muted', texto: [d.orgao, d.efetivo != null ? d.efetivo + ' pessoas' : '? pessoas'].filter(Boolean).join(' · ') }),
              el('span', { classe: 'selo sci-status', style: 'background:' + (CORES_EQUIPE[d.status] || '#888'), texto: S.STATUS_EQUIPE[d.status] || P })]),
            el('div', null, [pend(d.missao)]),
            el('small', null, ['Responsável: ', pend(d.chefe), d.setor ? ' · Setor: ' + d.setor : '', d.meios ? ' · Meios: ' + d.meios : '']),
            d.notas ? el('small', { classe: 'muted', texto: d.notas }) : null,
          ])]);
        })) : el('p', { classe: 'muted', texto: 'Nenhuma equipe registrada.' }),
      ], 'A cor da faixa indica o status. Toque para editar (função, setor, meios e andamento ficam no mesmo cartão).');
    }

    /* ---------- 6. Órgãos ---------- */
    function secaoOrgaos() {
      var to = S.totaisOrgaos(est.itens), og = itens('orgao');
      return secao('orgaos', 'Órgãos envolvidos', [pode() ? botao('+ Órgão', function () { formItem('orgao', null); }, 'btn-escuro') : null], [
        el('div', { classe: 'sci-totais' }, [
          el('span', { classe: 'sci-k' }, [el('b', { texto: String(to.orgaos) }), 'órgãos envolvidos']), el('span', { classe: 'sci-k' }, [el('b', { texto: String(to.noLocal) }), 'no local']),
          el('span', { classe: 'sci-k' }, [el('b', { texto: String(to.pessoas) }), 'pessoas' + (to.semEfetivo ? ' (' + to.semEfetivo + ' órgão(s) sem efetivo informado)' : '')]),
          el('span', { classe: 'sci-k' }, [el('b', { texto: String(to.viaturas) }), 'viaturas' + (to.semViaturas ? ' (' + to.semViaturas + ' sem informação)' : '')]),
        ]),
        og.length ? el('div', { classe: 'sci-orgaos' }, og.map(function (i) {
          var d = i.dados;
          return el('button', { type: 'button', classe: 'sci-orgao sci-orgao-' + (d.situacao || 'x'), onclick: function () { formItem('orgao', i); } }, [
            el('div', { classe: 'sci-missao-cab' }, [el('strong', { texto: d.nome }), el('span', { classe: 'selo selo-neutro', texto: S.SITUACAO_ORGAO[d.situacao] || P })]),
            el('div', { classe: 'num' }, [(d.pessoas == null ? '?' : d.pessoas) + ' pessoas · ' + (d.viaturas == null ? '?' : d.viaturas) + ' viaturas']),
            d.detalhe ? el('small', { texto: d.detalhe }) : null,
            el('small', null, ['Missão: ', pend(d.missao)]),
            d.nota ? el('small', { classe: 'muted', texto: d.nota }) : null,
            d.chegada_em ? el('small', { classe: 'muted', texto: 'Chegada ' + S.horaCurta(d.chegada_em) }) : d.acionado_em ? el('small', { classe: 'muted', texto: 'Acionado ' + S.horaCurta(d.acionado_em) }) : null,
          ]);
        })) : el('p', { classe: 'muted', texto: 'Nenhum órgão registrado.' }),
      ], 'Mostra a dimensão da ocorrência de relance. Efetivo não informado aparece como "?" (não conta como zero).');
    }

    /* ---------- 7. Alertas ---------- */
    function secaoAlertas() {
      var al = S.alertas(dados(), Date.now());
      return secao('alertas', 'Alertas do Comando', [botao('Copiar resumo', function () { copiar(S.resumo(dados(), Date.now()), 'Resumo copiado.'); })], [
        al.length ? listaAlertas(al) : el('p', { classe: 'muted', texto: 'Nenhum alerta com o que está registrado.' }),
      ], 'Calculados a partir dos dados: segurança primeiro, depois o que diverge e o que falta.');
    }

    /* ---------- 8. Situação e relatório de danos ---------- */
    function secaoSituacao() {
      var e = est.estado, pc = S.instalacao(est.itens, 'pc');
      function bloco(rot, texto, quando, extra) {
        return el('div', { classe: 'sci-texto-bloco' }, [el('h4', { classe: 'sci-sub', texto: rot }), quando ? el('small', { classe: 'muted', texto: S.horaCurta(quando) }) : null].concat(extra || []).concat([
          S.vazio(texto) ? el('span', { classe: 'sci-pend', texto: P }) : el('p', { classe: 'sci-pre', texto: texto })]));
      }
      return secao('situacao', 'Situação e objetivos', [pode() ? botao('Editar dados do incidente', editarSituacao, 'btn-escuro', { id: 'sci-situacao-editar' }) : null], [
        bloco('Situação atual', e.situacao, e.situacao_em),
        bloco('Relatório de danos', e.danos, e.danos_em, [
          e.danos_fonte ? el('small', { classe: 'muted', texto: ' · Fonte: ' + e.danos_fonte }) : null,
          e.danos && !e.danos_confirmado ? el('span', { classe: 'selo selo-alerta', texto: 'NÃO CONFIRMADO' }) : null,
          e.danos && !e.danos_confirmado && pode() ? botao('Confirmar', function () { rpc('sci_salvar_estado', { p_operacao: opId, p_dados: { danos_confirmado: true } }, 'Relatório de danos confirmado.'); }) : null,
        ]),
        bloco('Objetivos do período', e.objetivos), bloco('Riscos principais', e.riscos),
        el('dl', { classe: 'kv-grade' }, [['Comandante', S.nomeFuncao(e, 'ci')], ['Segurança', S.nomeFuncao(e, 'seguranca')],
          ['Coordenadas', op().local_lat != null ? op().local_lat.toFixed(4) + ', ' + op().local_lng.toFixed(4) : ''], ['PC', pc ? pc.dados.nome + (pc.dados.local ? ' – ' + pc.dados.local : '') : '']].map(function (x) {
          return el('div', { classe: 'kv' }, [el('dt', { texto: x[0] }), el('dd', { classe: x[1] ? null : 'kv-vazio', texto: x[1] || P })]);
        })),
      ]);
    }
    function editarSituacao() {
      var e = est.estado;
      function area(id, v, rows, ph) { var a = el('textarea', { classe: 'campo', id: id, rows: String(rows || 3), maxlength: '8000', placeholder: ph || '' }); a.value = v || ''; return a; }
      var sit = area('sci-s-sit', e.situacao, 3), obj = area('sci-s-obj', e.objetivos, 3), ris = area('sci-s-ris', e.riscos, 3);
      var dan = area('sci-s-dan', e.danos, 8, 'Humanos · Materiais · Rurais e ambientais · Infraestrutura');
      var fonte = el('input', { classe: 'campo', id: 'sci-s-fonte', maxlength: '200', placeholder: 'Ex.: Defesa Civil, lado ilhado' }); fonte.value = e.danos_fonte || '';
      var hora = el('input', { classe: 'campo', id: 'sci-s-hora', type: 'datetime-local', value: e.danos_em ? dataLocal(e.danos_em) : dataLocal(Date.now()) });
      var conf = el('input', { type: 'checkbox', id: 'sci-s-conf', checked: e.danos_confirmado ? true : null });
      var form = el('form', { novalidate: true }, [
        el('h2', { id: 'modal-titulo', texto: 'Dados do incidente' }),
        UI.campo('Situação atual', sit, { para: 'sci-s-sit', largo: true }),
        UI.grade([UI.campo('Objetivos do período', obj, { para: 'sci-s-obj' }), UI.campo('Riscos principais', ris, { para: 'sci-s-ris' })]),
        UI.secao('Relatório de danos', [dan, UI.grade([UI.campo('Fonte', fonte, { para: 'sci-s-fonte' }), UI.campo('Recebido em', hora, { para: 'sci-s-hora' })]),
          el('label', { classe: 'linha-opcao' }, [conf, ' Confirmado pela equipe'])]),
        UI.rodape([botao('Cancelar', function () { fechar(); }), el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'sci-s-salvar', texto: 'Salvar' })]),
      ]);
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var dd = { situacao: sit.value, objetivos: obj.value, riscos: ris.value, danos_fonte: fonte.value, danos_confirmado: conf.checked };
        if (dan.value.trim() !== (e.danos || '')) { dd.danos = dan.value; dd.danos_em = iso(hora.value); }
        fechar();
        rpc('sci_salvar_estado', { p_operacao: opId, p_dados: dd }, 'Dados do incidente salvos.');
      });
      var fechar = UI.abrirModal(form, { tamanho: 'largo', empilhar: true });
    }

    /* ---------- 9. Estrutura SCI (organograma) ---------- */
    function secaoEstrutura() {
      var e = est.estado;
      function caixa(rot, chave) { return el('div', { classe: 'sci-org-caixa' + (chave === 'ci' ? ' sci-org-ci' : '') }, [el('small', { texto: rot }), pend(S.nomeFuncao(e, chave))]); }
      var equipes = itens('equipe').filter(function (i) { return i.dados.status !== 'desmobilizada'; });
      var orgaos = itens('orgao').map(function (i) { return i.dados.nome; });
      return secao('estrutura', 'Estrutura SCI', [pode() ? botao('Editar organograma', editarFuncoes) : null], [
        e.acompanhamento ? el('p', { classe: 'nota', texto: 'Acompanhamento remoto: ' + e.acompanhamento }) : null,
        el('div', { classe: 'sci-org' }, [
          caixa('Comandante do Incidente', 'ci'),
          el('div', { classe: 'sci-org-staff' }, [caixa('Oficial de Segurança', 'seguranca'), caixa('Oficial de Ligação', 'ligacao'), caixa('Informação Pública', 'informacao_publica')]),
          orgaos.length ? el('p', { classe: 'muted sci-org-ligacao', texto: 'Órgãos em ligação: ' + orgaos.join(', ') }) : null,
          el('div', { classe: 'sci-org-secoes' }, [
            el('div', null, [caixa('Seção de Operações', 'operacoes'), el('ul', { classe: 'sci-org-equipes' }, equipes.map(function (i) {
              return el('li', null, [el('small', { texto: i.dados.funcao || i.dados.missao || 'Equipe' }), el('span', { texto: i.dados.nome + (i.dados.chefe ? ' · ' + i.dados.chefe : '') })]);
            }))]),
            caixa('Seção de Planejamento', 'planejamento'), caixa('Seção de Logística', 'logistica'), caixa('Adm./Finanças', 'adm_financas'),
          ]),
        ]),
      ]);
    }

    /* ---------- 10. Recursos e logística ---------- */
    function secaoRecursos() {
      var e = est.estado, pc = S.instalacao(est.itens, 'pc'), acv = S.instalacao(est.itens, 'acv');
      var log = el('dl', { classe: 'kv-grade' }, [
        el('div', { classe: 'kv' }, [el('dt', { texto: 'PC' }), el('dd', { texto: pc ? (pc.dados.local || pc.dados.nome) + (pc.dados.lat != null ? ' – ' + S.dms(pc.dados.lat, pc.dados.lng) : '') : P })]),
        el('div', { classe: 'kv' }, [el('dt', { texto: 'ACV' }), el('dd', { texto: acv ? (acv.dados.local || acv.dados.nome) : P })]),
      ].concat(S.LOGISTICA.map(function (l) {
        return el('div', { classe: 'kv' }, [el('dt', { texto: l[1] }), el('dd', null, [pend(e.logistica[l[0]]), pode() ? botao('editar', function () { editarLogistica(l); }, 'btn-link') : null])]);
      })));
      var rec = itens('recurso');
      return secao('recursos', 'Recursos e logística', [pode() ? botao('+ Recurso / pedido', function () { formItem('recurso', null); }, 'btn-escuro') : null], [
        el('h4', { classe: 'sci-sub', texto: 'Logística' }), log,
        rec.length ? tabela(['Recurso', 'Tipo', 'Órgão', 'Qtd', 'Status', 'Local / designação', 'Solicitado', 'Chegada'], rec.map(function (r) {
          var d = r.dados;
          return { item: r, celulas: [d.nome, S.TIPO_RECURSO[d.tipo] || '—', d.orgao || '—', d.qtd == null ? '—' : String(d.qtd), S.STATUS_RECURSO[d.status] || P, d.local || '—',
            d.solicitado_em ? S.horaCurta(d.solicitado_em) : '—', d.chegada_em ? S.horaCurta(d.chegada_em) : '—'] };
        }), 'recurso') : el('p', { classe: 'muted', texto: 'Nenhum recurso ou pedido registrado.' }),
      ], 'Viaturas, embarcações, aeronaves e pedidos com status e horários. Aeronave aparece em destaque no bloco do local.');
    }
    async function editarLogistica(l) {
      var r = await UI.confirmar({ titulo: l[1], campo: { rotulo: l[1] + ' (situação)', valor: est.estado.logistica[l[0]] || '', max: 300 }, ok: 'Salvar', empilhar: true });
      if (!r) return;
      var lg = {}; lg[l[0]] = r.texto;
      rpc('sci_salvar_estado', { p_operacao: opId, p_dados: { logistica: lg } }, l[1] + ' salvo.');
    }

    /* ---------- 11. Nível do rio ---------- */
    function secaoRio() {
      var le = itens('leitura_rio').slice().sort(function (a, b) { return Date.parse(b.dados.em) - Date.parse(a.dados.em); });
      return secao('rio', 'Nível do rio / segurança', [pode() ? botao('+ Leitura', function () { formItem('leitura_rio', null); }, 'btn-escuro', { id: 'sci-nova-leitura' }) : null], [
        le.length ? tabela(['Hora', 'Ponto', 'Nível', 'Vazão / vertedouro', 'Tendência', 'Fonte'], le.map(function (r) {
          var d = r.dados;
          return { item: r, celulas: [S.horaCurta(d.em), d.ponto || '—', d.nivel || '—', d.vazao || '—', S.TENDENCIA[d.tendencia] || '—', d.fonte || '—'] };
        }), 'leitura_rio') : el('p', { classe: 'muted', texto: 'Nenhuma leitura registrada.' }),
      ], 'Sem leitura há mais de 30 min gera alerta. Rio subindo é crítico.');
    }

    carregar();
    iniciarTempoReal();
    return { parar: parar, recarregar: carregar, executar: executar };
  }

  window.SCI = { montar: montar };
})();
