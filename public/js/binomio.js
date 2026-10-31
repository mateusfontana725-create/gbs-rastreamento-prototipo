/* =====================================================================
 * binomio.js — busca com cão: sessão do binômio (cão e condutor), migração 042
 *   - Sessão ligada a um setor, com o condutor (participante), o cão, o artigo de odor (o quê, de onde veio,
 *     quem manipulou) e as condições. Iniciar, pausar, retomar e finalizar guardam a hora de cada passo.
 *   - O cão normalmente não tem GPS: o mapa mostra a trilha do CONDUTOR durante a sessão e diz isso.
 *   - Indicação do cão (I1, I2…) começa "em análise": indicação não é confirmação.
 *     Confirmação (C1…) é ligada a uma indicação e exige um método independente do cão (equipe, visual, drone…).
 *   Usa a interface window.Painel (militar.js).
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI, P = window.Painel;
  if (!C || !UI || !P) return;
  var el = UI.el;

  var ESTADOS_SESSAO = {
    planejada: { rotulo: 'Planejada', classe: 'selo-neutro' },
    em_andamento: { rotulo: 'Em andamento', classe: 'selo-ok' },
    pausada: { rotulo: 'Pausada', classe: 'selo-alerta' },
    finalizada: { rotulo: 'Finalizada', classe: 'selo-neutro' },
  };
  var ESTADOS_EVENTO = {
    em_analise: { rotulo: 'Em análise', classe: 'selo-alerta' },
    pendente: { rotulo: 'Pendente', classe: 'selo-alerta' },
    confirmada: { rotulo: 'Confirmada', classe: 'selo-ok' },
    descartada: { rotulo: 'Descartada', classe: 'selo-neutro selo-riscado' },
    inconclusiva: { rotulo: 'Inconclusiva', classe: 'selo-neutro' },
  };
  var METODOS = ['Equipe no local', 'Busca visual', 'Drone', 'Outro cão (independente)', 'Mergulho / sonar', 'Outro'];
  var COR_TRILHA = '#a855f7';

  var est = { marcadores: [], opId: null, sessoes: new Map(), eventos: new Map(), ausente: false, erro: null, canal: null, timer: null, timerMapa: null,
    camada: null, renderAtual: null, ouvintes: [] };

  function podeAlterar() { return Boolean(P.podeAlterar && P.podeAlterar()); }
  function agora() { return Date.now(); }

  /* ---------- Dados ------------------------------------------------------ */
  async function carregar() {
    var op = P.op();
    if (!op || est.ausente) return;
    var opId = op.id;
    try {
      var r = await Promise.all([
        C.consultar(C.cliente.from('binomio_sessoes').select('*').eq('operacao_id', opId).order('criado_em', { ascending: true })),
        C.consultar(C.cliente.from('binomio_eventos').select('*').eq('operacao_id', opId).order('registrado_em', { ascending: true })),
      ]);
      if (!P.op() || P.op().id !== opId) return;
      est.sessoes = new Map((r[0] || []).map(function (s) { return [s.id, s]; }));
      est.eventos = new Map((r[1] || []).map(function (e) { return [e.id, e]; }));
      est.erro = null;
    } catch (e) {
      var t = String(e.original && (e.original.message || e.original.details) || e.message);
      if (/binomio_/.test(t) || e.codigo === 'funcao_ausente') est.ausente = true;
      est.erro = e.message;
    }
    atualizar();
  }

  function atualizar() {
    desenharMapa();
    var q = document.getElementById('menu-binomio-qtd');
    if (q) {
      var r = resumo();
      q.textContent = r.ativas ? r.ativas + ' em busca' : r.emAnalise ? r.emAnalise + ' em análise' : '';
    }
    if (est.renderAtual) est.renderAtual();
    est.ouvintes.forEach(function (f) { try { f(); } catch (e) { /* ignora */ } });
  }

  function agendar() { clearTimeout(est.timer); est.timer = setTimeout(carregar, 400); }

  function iniciar() {
    parar();
    var op = P.op();
    if (!op) return;
    est.opId = op.id;
    if (P.mapa() && window.L) est.camada = L.layerGroup().addTo(P.mapa());
    var carga = carregar();
    try {
      est.canal = C.cliente.channel('op-binomio-' + op.id + '-' + Date.now());
      ['binomio_sessoes', 'binomio_eventos'].forEach(function (t) {
        est.canal.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: 'operacao_id=eq.' + op.id }, agendar);
      });
      est.canal.subscribe();
    } catch (e) { /* sem tempo real: recarrega ao abrir */ }
    // a trilha do condutor cresce enquanto a sessão está em andamento
    est.timerMapa = setInterval(function () { if (emAndamento().length) desenharMapa(); }, 20000);
    return carga;
  }

  function parar() {
    clearTimeout(est.timer); clearInterval(est.timerMapa);
    if (est.canal) { try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ } }
    if (est.camada) { try { est.camada.remove(); } catch (e) { /* ignora */ } }
    if (P.desagruparMarcadores) P.desagruparMarcadores(est.marcadores);
    est.marcadores = [];
    est.canal = null; est.camada = null; est.opId = null; est.sessoes = new Map(); est.eventos = new Map();
    est.ausente = false; est.erro = null; est.renderAtual = null;
  }

  function aplicarSessao(s) { if (s && s.id) est.sessoes.set(s.id, s); atualizar(); }
  function aplicarEvento(e) { if (e && e.id) est.eventos.set(e.id, e); atualizar(); }
  function emAndamento() { return Array.from(est.sessoes.values()).filter(function (s) { return s.estado === 'em_andamento' || s.estado === 'pausada'; }); }
  function eventosDa(s) {
    return Array.from(est.eventos.values()).filter(function (e) { return e.sessao_id === s.id; })
      .sort(function (a, b) { return C.paraMs(a.registrado_em) - C.paraMs(b.registrado_em); });
  }

  /* ---------- Contas ----------------------------------------------------- */
  // Tempo efetivo de busca: do início ao fim (ou agora), menos as pausas.
  function tempoEfetivoMs(s) {
    if (!s.iniciada_em) return null;
    var ini = C.paraMs(s.iniciada_em), fim = s.finalizada_em ? C.paraMs(s.finalizada_em) : agora();
    var pausado = (s.pausas || []).reduce(function (soma, p) {
      var de = C.paraMs(p.de), ate = p.ate ? C.paraMs(p.ate) : fim;
      return soma + Math.max(0, ate - de);
    }, 0);
    return Math.max(0, fim - ini - pausado);
  }
  function fmtDur(ms) {
    if (ms == null) return '—';
    var min = Math.round(ms / 60000);
    return min < 60 ? min + ' min' : Math.floor(min / 60) + ' h ' + (min % 60 < 10 ? '0' : '') + (min % 60) + ' min';
  }
  function emPausa(s, t) {
    return (s.pausas || []).some(function (p) { var de = C.paraMs(p.de), ate = p.ate ? C.paraMs(p.ate) : Infinity; return t >= de && t <= ate; });
  }
  // Trechos da trilha do condutor durante a sessão (sem as pausas)
  function trilhaCondutor(s) {
    if (!s.iniciada_em || !s.condutor_participante_id) return [];
    var p = P.participante(s.condutor_participante_id);
    if (!p) return [];
    var ini = C.paraMs(s.iniciada_em), fim = s.finalizada_em ? C.paraMs(s.finalizada_em) : Infinity;
    var segs = [];
    (P.trilha(p).segmentos || []).forEach(function (seg) {
      var atual = [];
      seg.forEach(function (pt) {
        var dentro = pt.t >= ini && pt.t <= fim && !emPausa(s, pt.t);
        if (dentro) atual.push([pt.lat, pt.lng]);
        else if (atual.length) { segs.push(atual); atual = []; }
      });
      if (atual.length) segs.push(atual);
    });
    return segs.filter(function (x) { return x.length >= 2; });
  }
  function nomeCondutor(s) {
    var p = s.condutor_participante_id && P.participante(s.condutor_participante_id);
    return p ? P.nome(p) : (s.condutor_nome || 'não informado');
  }
  function nomeSetor(s) {
    var st = s.setor_id && P.setores().filter(function (x) { return x.id === s.setor_id; })[0];
    return st ? st.nome : null;
  }

  /* ---------- Mapa ------------------------------------------------------- */
  function desenharMapa() {
    if (!est.camada || !window.L) return;
    est.camada.clearLayers();
    if (P.desagruparMarcadores) P.desagruparMarcadores(est.marcadores);
    est.marcadores = [];
    est.sessoes.forEach(function (s) {
      var rot = '🐕 ' + C.esc(s.cao_nome) + ' · GPS do condutor' + (s.cao_gps === 'sem_dispositivo' ? ' (o cão não tem GPS)' : '');
      trilhaCondutor(s).forEach(function (seg) {
        L.polyline(seg, { color: COR_TRILHA, weight: 4, opacity: s.estado === 'finalizada' ? 0.45 : 0.85, dashArray: '2 7', lineCap: 'round' })
          .bindTooltip(rot, { sticky: true }).addTo(est.camada);
      });
      eventosDa(s).forEach(function (e) {
        if (e.lat == null) return;
        var cls = 'mk-binomio mk-binomio-' + e.tipo + ' mk-binomio-' + e.estado;
        var mk = L.marker([e.lat, e.lng], { icon: L.divIcon({ className: 'mk-binomio-wrap', html: '<div class="' + cls + '">' + C.esc(e.codigo) + '</div>', iconSize: [0, 0] }),
          title: (e.tipo === 'indicacao' ? 'Indicação ' : 'Confirmação ') + e.codigo + ' — ' + ESTADOS_EVENTO[e.estado].rotulo })
          .bindPopup(function () { return popupEvento(s, e); });
        est.marcadores.push(mk);
      });
    });
    // as marcas entram no agrupamento do mapa (junto com pontos, relatos e fotos)
    if (P.agruparMarcadores) P.agruparMarcadores(est.marcadores, 'verif'); else est.marcadores.forEach(function (mk) { mk.addTo(est.camada); });
  }

  function popupEvento(s, e) {
    return el('div', { classe: 'popup-binomio' }, [
      el('strong', { texto: '🐕 ' + s.cao_nome + ' · ' + (e.tipo === 'indicacao' ? 'Indicação ' : 'Confirmação ') + e.codigo }),
      el('div', null, [el('span', { classe: 'selo ' + ESTADOS_EVENTO[e.estado].classe, texto: ESTADOS_EVENTO[e.estado].rotulo })]),
      el('div', { classe: 'muted', texto: 'Às ' + C.hora(e.ocorrido_em, false) + (e.metodo ? ' · ' + e.metodo : '') }),
      e.descricao ? el('div', { texto: e.descricao }) : null,
      e.tipo === 'indicacao' && e.estado === 'em_analise' ? el('div', { classe: 'muted', texto: 'Indicação não é confirmação.' }) : null,
      el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Abrir sessão', onclick: function () { abrir(s.id); } }),
    ]);
  }

  /* ---------- Ações ------------------------------------------------------ */
  async function executar(nome, args, ok) {
    try {
      var r = await C.rpc(nome, args);
      if (ok) UI.aviso(ok, 'ok');
      return r;
    } catch (e) {
      UI.aviso(C.traduzirErro(e), 'erro', 8000);
      return null;
    }
  }

  async function controle(s, acao) {
    if (acao === 'finalizar') {
      var ok = await UI.confirmar({ titulo: 'Finalizar a sessão do ' + s.cao_nome + '?', texto: 'Tempo efetivo até agora: ' + fmtDur(tempoEfetivoMs(s)) + '. Indicações em análise continuam abertas.', ok: 'Finalizar', empilhar: true });
      if (!ok) return;
    }
    var nomes = { iniciar: 'Sessão iniciada.', pausar: 'Sessão pausada.', retomar: 'Sessão retomada.', finalizar: 'Sessão finalizada.' };
    var r = await executar('binomio_controle', { p_sessao: s.id, p_acao: acao }, nomes[acao]);
    if (r) aplicarSessao(r);
  }

  function dataLocal(ms) {
    var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // Escolhe um ponto no mapa e volta para o formulário
  function tocarNoMapa(volta) {
    UI.fecharTodos();
    var feito = false;
    var ctl = P.iniciarDesenho({
      aoClicar: function (ll) { feito = true; ctl.encerrar(); volta({ lat: ll[0], lng: ll[1], precisao: null, origem: 'mapa' }); },
      aoCancelar: function () { if (!feito) volta(null); },
    });
    if (!ctl) { volta(null); return; }
    ctl.barra('Toque no mapa onde o cão indicou.', null, [el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Cancelar', onclick: function () { ctl.encerrar(); } })]);
  }

  // Formulário da indicação (e da confirmação, com ind = a indicação confirmada)
  function formEvento(s, ind, estado) {
    estado = estado || {};
    var tipo = ind ? 'confirmacao' : 'indicacao';
    var condutor = s.condutor_participante_id && P.participante(s.condutor_participante_id);
    var posCond = condutor && P.posicao(condutor);
    var pos = estado.pos !== undefined ? estado.pos : (ind ? null : (posCond ? { lat: posCond.lat, lng: posCond.lng, precisao: posCond.prec, origem: 'condutor' } : null));
    var erro = el('p', { classe: 'erro-form', hidden: true });
    var quando = el('input', { classe: 'campo', id: 'bin-quando', type: 'datetime-local', value: estado.quando || dataLocal(agora()) });
    var desc = el('textarea', { classe: 'campo', id: 'bin-desc', maxlength: '500', rows: '3', placeholder: ind ? 'O que foi encontrado / verificado' : 'Comportamento do cão (alerta, latido, deita…), direção do vento' });
    desc.value = estado.desc || '';
    var metodo = el('select', { classe: 'campo', id: 'bin-metodo' }, [el('option', { value: '', texto: 'Escolha…' })].concat(METODOS.map(function (m) { return el('option', { value: m, selected: estado.metodo === m ? true : null, texto: m }); })));
    var textoPos = el('p', { classe: 'muted bin-pos', texto: '' });
    function mostrarPos() {
      textoPos.textContent = pos ? C.coord(pos.lat) + ', ' + C.coord(pos.lng) + ' · ' + ({ condutor: 'posição do condutor', mapa: 'tocado no mapa', eu: 'minha posição' }[pos.origem] || '') +
        (pos.precisao ? ' (±' + Math.round(pos.precisao) + ' m)' : '') : (ind ? 'Sem posição: usa a da indicação ' + ind.codigo + '.' : 'Sem posição.');
    }
    mostrarPos();
    function guardar() { return { pos: pos, quando: quando.value, desc: desc.value, metodo: metodo.value }; }
    var botoesPos = el('div', { classe: 'acoes-linha' }, [
      posCond ? el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Posição do condutor', title: 'Última posição do GPS de ' + P.nome(condutor), onclick: function () { pos = { lat: posCond.lat, lng: posCond.lng, precisao: posCond.prec, origem: 'condutor' }; mostrarPos(); } }) : null,
      el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Minha posição', onclick: async function () {
        var m = await P.minhaPosicao();
        if (!m || !m.ok) { UI.aviso('Sem a sua localização agora.', 'erro'); return; }
        pos = { lat: m.lat, lng: m.lng, precisao: m.precisao || m.prec || null, origem: 'eu' }; mostrarPos();
      } }),
      el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Tocar no mapa', onclick: function () {
        var g = guardar();
        tocarNoMapa(function (p) { if (p) g.pos = p; formEvento(s, ind, g); });
      } }),
      pos ? el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Sem posição', onclick: function () { pos = null; mostrarPos(); } }) : null,
    ]);
    var btnOk = el('button', { classe: 'btn btn-escuro', type: 'submit', texto: ind ? 'Registrar confirmação' : 'Registrar indicação' });
    var form = el('form', { classe: 'form-binomio-evento', novalidate: true }, [
      el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, [ind ? 'Confirmar ' + ind.codigo + ' (' + s.cao_nome + ')' : 'Indicação do cão ' + s.cao_nome,
        UI.dica(ind ? 'A confirmação precisa de um método independente do cão. Ela começa "pendente" até alguém registrar o resultado.' : 'A indicação começa "em análise": indicação não é confirmação.')]),
      ind ? UI.campo('Método independente', metodo, { para: 'bin-metodo' }) : null,
      UI.secao('Onde', [textoPos, botoesPos], { dica: s.cao_gps === 'sem_dispositivo' ? 'O cão não tem GPS: a posição é a do condutor ou a marcada no mapa.' : null }),
      UI.grade([UI.campo('Quando', quando, { para: 'bin-quando' })]),
      UI.campo('Descrição', desc, { para: 'bin-desc', opcional: true }),
      erro,
      UI.rodape([el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btnOk]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      if (ind && !metodo.value) { erro.textContent = 'Escolha o método independente usado para confirmar.'; erro.hidden = false; metodo.focus(); return; }
      var d = quando.value ? new Date(quando.value) : new Date();
      var dados = { tipo: tipo, descricao: desc.value.trim(), ocorrido_em: isNaN(d) ? null : d.toISOString() };
      if (pos) { dados.lat = pos.lat; dados.lng = pos.lng; if (pos.precisao != null) dados.precisao = pos.precisao; }
      if (ind) { dados.relacionado_a = ind.id; dados.metodo = metodo.value; }
      btnOk.disabled = true;
      try {
        var r = await C.rpc('registrar_binomio_evento', { p_sessao: s.id, p_dados: dados });
        UI.aviso((ind ? 'Confirmação ' : 'Indicação ') + r.codigo + ' registrada (' + ESTADOS_EVENTO[r.estado].rotulo.toLowerCase() + ').', 'ok');
        fechar();
        aplicarEvento(r);
        abrir(s.id);
      } catch (e) {
        erro.textContent = C.traduzirErro(e); erro.hidden = false; btnOk.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form);
  }

  // Resultado de um evento (confirmada / descartada / inconclusiva, com justificativa)
  function formResultado(s, e) {
    var escolhido = e.estado;
    var opcoes = (e.tipo === 'indicacao' ? ['em_analise'] : ['pendente']).concat(['confirmada', 'descartada', 'inconclusiva']);
    var nota = el('textarea', { classe: 'campo', id: 'bin-nota', maxlength: '500', rows: '3', placeholder: 'Como foi verificado' });
    nota.value = e.revisao_nota || '';
    var erro = el('p', { classe: 'erro-form', hidden: true });
    var btnOk = el('button', { classe: 'btn btn-escuro', type: 'submit', texto: 'Salvar resultado' });
    var form = el('form', { novalidate: true }, [
      el('h2', { id: 'modal-titulo', texto: 'Resultado de ' + e.codigo + ' (' + s.cao_nome + ')' }),
      UI.secao('Estado', [UI.escolhas('bin-estado', opcoes.map(function (k) { return { valor: k, rotulo: ESTADOS_EVENTO[k].rotulo, marcado: k === escolhido }; }), function (v) { escolhido = v; })]),
      UI.campo('Justificativa', nota, { para: 'bin-nota', ajuda: 'Obrigatória para confirmada, descartada ou inconclusiva.' }),
      erro,
      UI.rodape([el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btnOk]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var t = nota.value.trim();
      if (['confirmada', 'descartada', 'inconclusiva'].indexOf(escolhido) !== -1 && !t) { erro.textContent = 'Escreva a justificativa.'; erro.hidden = false; nota.focus(); return; }
      btnOk.disabled = true;
      try {
        var r = await C.rpc('revisar_binomio_evento', { p_evento: e.id, p_estado: escolhido, p_nota: t });
        UI.aviso(e.codigo + ': ' + ESTADOS_EVENTO[r.estado].rotulo.toLowerCase() + '.', 'ok');
        fechar(); aplicarEvento(r); abrir(s.id);
      } catch (x) { erro.textContent = C.traduzirErro(x); erro.hidden = false; btnOk.disabled = false; }
    });
    var fechar = UI.abrirModal(form, { tamanho: 'estreito' });
  }

  // Criar ou editar a sessão
  function formSessao(s) {
    var novo = !s;
    s = s || {};
    var erro = el('p', { classe: 'erro-form', hidden: true });
    function inp(id, valor, max, ph) { var i = el('input', { classe: 'campo', id: id, type: 'text', maxlength: String(max), placeholder: ph || '' }); i.value = valor || ''; return i; }
    var cao = inp('bin-cao', s.cao_nome, 60, 'Nome do cão');
    var condutor = el('select', { classe: 'campo', id: 'bin-condutor' }, [el('option', { value: '', texto: '— sem participante (só o nome) —' })].concat(
      P.participantes().filter(function (p) { return !p.dados.removido || p.id === s.condutor_participante_id; })
        .sort(function (a, b) { return P.nome(a).localeCompare(P.nome(b), 'pt-BR'); })
        .map(function (p) { return el('option', { value: p.id, selected: p.id === s.condutor_participante_id ? true : null, texto: P.nome(p) }); })));
    var condNome = inp('bin-cond-nome', s.condutor_nome, 80, 'Se o condutor não está no app');
    var setor = el('select', { classe: 'campo', id: 'bin-setor' }, [el('option', { value: '', texto: '— sem setor —' })].concat(
      P.setores().map(function (x) { return el('option', { value: x.id, selected: x.id === s.setor_id ? true : null, texto: x.nome }); })));
    var gps = s.cao_gps || 'sem_dispositivo';
    var artigo = inp('bin-artigo', s.artigo_odor, 200, 'Ex.: camiseta usada, travesseiro');
    var origem = inp('bin-origem', s.artigo_origem, 200, 'Onde/de quem foi recolhido');
    var manip = inp('bin-manip', s.artigo_manipulacao, 200, 'Quem tocou, como foi guardado');
    var cond = el('textarea', { classe: 'campo', id: 'bin-cond', maxlength: '500', rows: '2', placeholder: 'Vento, temperatura, umidade, terreno, contaminação da área' });
    cond.value = s.condicoes || '';
    var btnOk = el('button', { classe: 'btn btn-escuro', type: 'submit', texto: novo ? 'Criar sessão' : 'Salvar' });
    var form = el('form', { classe: 'form-binomio', novalidate: true }, [
      el('h2', { id: 'modal-titulo', texto: novo ? 'Nova sessão do binômio' : 'Sessão: ' + s.cao_nome }),
      UI.secao('Binômio', [UI.grade([
        UI.campo('Cão', cao, { para: 'bin-cao' }),
        UI.campo('Setor', setor, { para: 'bin-setor', opcional: true }),
        UI.campo('Condutor', condutor, { para: 'bin-condutor', ajuda: 'A trilha mostrada no mapa é a do GPS do condutor.' }),
        UI.campo('Nome do condutor', condNome, { para: 'bin-cond-nome', opcional: true }),
      ]),
      UI.campo('GPS do cão', UI.escolhas('bin-gps', [
        { valor: 'sem_dispositivo', rotulo: 'Sem dispositivo', sub: 'mapa usa o GPS do condutor', marcado: gps === 'sem_dispositivo' },
        { valor: 'coleira_externa', rotulo: 'Coleira com GPS', sub: 'trilha em outro aparelho', marcado: gps === 'coleira_externa' },
      ], function (v) { gps = v; }))]),
      UI.secao('Artigo de odor', [UI.grade([
        UI.campo('O quê', artigo, { para: 'bin-artigo', opcional: true }),
        UI.campo('Origem', origem, { para: 'bin-origem', opcional: true }),
        UI.campo('Manipulação', manip, { para: 'bin-manip', opcional: true, largo: true }),
      ])], { dica: 'Em branco fica "não informado". Artigo contaminado ou de origem incerta muda a leitura das indicações.' }),
      UI.campo('Condições', cond, { para: 'bin-cond', opcional: true }),
      erro,
      UI.rodape([el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btnOk]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      if (!cao.value.trim()) { erro.textContent = 'Informe o nome do cão.'; erro.hidden = false; cao.focus(); return; }
      btnOk.disabled = true;
      try {
        var r = await C.rpc('salvar_binomio_sessao', { p_operacao: P.op().id, p_id: novo ? null : s.id, p_dados: {
          cao_nome: cao.value.trim(), cao_gps: gps, setor_id: setor.value || null, condutor_participante_id: condutor.value || null,
          condutor_nome: condNome.value.trim(), artigo_odor: artigo.value.trim(), artigo_origem: origem.value.trim(),
          artigo_manipulacao: manip.value.trim(), condicoes: cond.value.trim() } });
        UI.aviso(novo ? 'Sessão criada. Toque em Iniciar quando o cão começar.' : 'Sessão salva.', 'ok');
        fechar(); aplicarSessao(r); abrir(r.id);
      } catch (x) { erro.textContent = C.traduzirErro(x); erro.hidden = false; btnOk.disabled = false; }
    });
    var fechar = UI.abrirModal(form);
  }

  /* ---------- Tela ------------------------------------------------------- */
  function linhaInfo(rot, valor) {
    return el('div', { classe: 'kv' }, [el('dt', { texto: rot }), el('dd', { classe: valor ? null : 'kv-vazio' }, [valor || 'não informado'])]);
  }

  function cartao(s, aberto) {
    var eventos = eventosDa(s);
    var ativa = s.estado === 'em_andamento' || s.estado === 'pausada';
    var setor = nomeSetor(s);
    var pausas = (s.pausas || []).length;
    var tempo = s.iniciada_em
      ? 'Início ' + C.hora(s.iniciada_em, false) + (pausas ? ' · ' + pausas + ' pausa' + (pausas > 1 ? 's' : '') : '') + (s.finalizada_em ? ' · fim ' + C.hora(s.finalizada_em, false) : '') + ' · busca efetiva ' + fmtDur(tempoEfetivoMs(s))
      : 'Ainda não iniciada';
    var acoes = [];
    if (podeAlterar()) {
      if (s.estado === 'planejada') acoes.push(el('button', { classe: 'btn btn-escuro btn-pequeno', type: 'button', texto: '▶ Iniciar', onclick: function () { controle(s, 'iniciar'); } }));
      if (s.estado === 'em_andamento') acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '❚❚ Pausar', onclick: function () { controle(s, 'pausar'); } }));
      if (s.estado === 'pausada') acoes.push(el('button', { classe: 'btn btn-escuro btn-pequeno', type: 'button', texto: '▶ Retomar', onclick: function () { controle(s, 'retomar'); } }));
      if (ativa) {
        acoes.push(el('button', { classe: 'btn btn-primario btn-pequeno', type: 'button', texto: '⚑ Indicação', title: 'O cão indicou algo', onclick: function () { formEvento(s, null); } }));
        acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '■ Finalizar', onclick: function () { controle(s, 'finalizar'); } }));
      }
      if (s.estado !== 'finalizada') acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Editar', onclick: function () { formSessao(s); } }));
    }
    var segs = trilhaCondutor(s);
    if (segs.length && P.mapa()) {
      acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Ver no mapa', onclick: function () {
        UI.fecharTodos();
        try { P.mapa().fitBounds(L.latLngBounds([].concat.apply([], segs)), { padding: [40, 40], maxZoom: 18 }); } catch (e) { /* ignora */ }
      } }));
    }
    var lista = el('ul', { classe: 'bin-eventos' }, eventos.map(function (e) {
      var ind = e.relacionado_a && est.eventos.get(e.relacionado_a);
      var acoesEv = [];
      if (e.lat != null) acoesEv.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Mapa', onclick: function () { UI.fecharTodos(); P.irPara(e.lat, e.lng); } }));
      if (podeAlterar()) {
        if (e.tipo === 'indicacao' && e.estado === 'em_analise') acoesEv.push(el('button', { classe: 'btn btn-pequeno btn-escuro', type: 'button', texto: 'Confirmar por outro meio', onclick: function () { formEvento(s, e); } }));
        acoesEv.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Resultado', onclick: function () { formResultado(s, e); } }));
      }
      return el('li', { classe: 'bin-evento bin-evento-' + e.tipo }, [
        el('div', { classe: 'ajuda-topo' }, [
          el('strong', { classe: 'bin-codigo', texto: e.codigo }),
          el('span', { texto: e.tipo === 'indicacao' ? 'Indicação' : 'Confirmação de ' + (ind ? ind.codigo : '—') + ' · ' + e.metodo }),
          el('span', { classe: 'selo ' + ESTADOS_EVENTO[e.estado].classe, texto: ESTADOS_EVENTO[e.estado].rotulo }),
          el('span', { classe: 'muted num', texto: C.hora(e.ocorrido_em, false) }),
        ]),
        e.descricao ? el('p', { texto: e.descricao }) : null,
        e.revisao_nota ? el('p', { classe: 'revisao-nota', texto: (e.revisado_por_nome || '') + ': ' + e.revisao_nota }) : null,
        e.lat == null ? el('p', { classe: 'muted', texto: 'Sem posição.' }) : null,
        acoesEv.length ? el('div', { classe: 'acoes-linha' }, acoesEv) : null,
      ]);
    }));
    return el('li', { classe: 'ajuda-cartao bin-cartao bin-' + s.estado, 'data-sessao': s.id }, [
      el('div', { classe: 'ajuda-topo' }, [
        el('strong', { classe: 'ajuda-nome', texto: '🐕 ' + s.cao_nome }),
        el('span', { classe: 'selo ' + ESTADOS_SESSAO[s.estado].classe, texto: ESTADOS_SESSAO[s.estado].rotulo }),
        setor ? el('span', { classe: 'selo selo-neutro', texto: /^setor\b/i.test(setor) ? setor : 'Setor ' + setor }) : null,
      ]),
      el('p', { classe: 'ajuda-tempo', texto: tempo }),
      el('dl', { classe: 'kv-grade bin-info' }, [
        linhaInfo('Condutor', nomeCondutor(s)),
        linhaInfo('GPS do cão', s.cao_gps === 'coleira_externa' ? 'Coleira com GPS (fora do app)' : 'Sem dispositivo — mapa mostra o condutor'),
        linhaInfo('Artigo de odor', s.artigo_odor),
        linhaInfo('Origem do artigo', s.artigo_origem),
        linhaInfo('Manipulação', s.artigo_manipulacao),
        linhaInfo('Condições', s.condicoes),
      ]),
      el('details', { classe: 'ajuda-historico', open: aberto || eventos.length ? true : null }, [
        el('summary', { texto: 'Indicações e confirmações (' + eventos.length + ')' }),
        eventos.length ? lista : el('p', { classe: 'muted', texto: ativa ? 'Nenhuma ainda. Use "⚑ Indicação" quando o cão indicar.' : 'Nenhuma.' }),
      ]),
      acoes.length ? el('div', { classe: 'acoes-linha ajuda-acoes' }, acoes) : null,
    ]);
  }

  function abrir(sessaoId) {
    var corpo = el('div', { classe: 'ajuda-corpo binomio-corpo' });
    var fechar;
    function desenhar() {
      corpo.innerHTML = '';
      corpo.appendChild(el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, ['Binômio (cão e condutor)',
        UI.dica('Indicação do cão não é confirmação: confirme por um método independente. O cão sem GPS aparece pela trilha do condutor.')]));
      if (est.ausente) {
        corpo.appendChild(el('p', { classe: 'nota', texto: 'As sessões do binômio ainda não estão no servidor: rode a migração 042 no Supabase.' }));
        corpo.appendChild(UI.rodape([el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]));
        return;
      }
      if (est.erro) corpo.appendChild(el('p', { classe: 'nota', texto: 'Não foi possível atualizar: ' + est.erro }));
      var ordem = { em_andamento: 0, pausada: 1, planejada: 2, finalizada: 3 };
      var lista = Array.from(est.sessoes.values()).sort(function (a, b) { return ordem[a.estado] - ordem[b.estado] || C.paraMs(b.criado_em) - C.paraMs(a.criado_em); });
      if (!lista.length) corpo.appendChild(el('p', { classe: 'muted', texto: 'Nenhuma sessão com cão nesta operação.' }));
      corpo.appendChild(el('ul', { classe: 'ajuda-lista' }, lista.map(function (s) { return cartao(s, s.id === sessaoId); })));
      corpo.appendChild(UI.rodape([
        el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
        podeAlterar() ? el('button', { classe: 'btn btn-escuro', type: 'button', id: 'bin-nova', texto: '+ Nova sessão', onclick: function () { formSessao(null); } }) : null,
      ]));
    }
    est.renderAtual = desenhar;
    desenhar();
    fechar = UI.abrirModal(corpo, { tamanho: 'largo', aoFechar: function () { est.renderAtual = null; } });
    if (sessaoId) {
      var alvo = corpo.querySelector('[data-sessao="' + sessaoId + '"]');
      if (alvo && alvo.scrollIntoView) alvo.scrollIntoView({ block: 'nearest' });
    }
  }

  function resumo() {
    var ev = Array.from(est.eventos.values());
    return {
      sessoes: est.sessoes.size, ativas: emAndamento().length,
      indicacoes: ev.filter(function (e) { return e.tipo === 'indicacao'; }).length,
      emAnalise: ev.filter(function (e) { return e.tipo === 'indicacao' && e.estado === 'em_analise'; }).length,
      confirmadas: ev.filter(function (e) { return e.estado === 'confirmada'; }).length,
    };
  }

  window.Binomio = {
    iniciar: iniciar, parar: parar, abrir: abrir, recarregar: carregar, resumo: resumo,
    sessoes: function () { return Array.from(est.sessoes.values()); },
    eventos: function () { return Array.from(est.eventos.values()); },
    tempoEfetivoMs: tempoEfetivoMs, trilhaCondutor: trilhaCondutor,
    aoMudar: function (f) { est.ouvintes.push(f); },
    disponivel: function () { return !est.ausente; },
  };
  // operação aberta antes deste arquivo carregar: começa agora
  if (P.op && P.op() && !est.opId) iniciar();
})();
