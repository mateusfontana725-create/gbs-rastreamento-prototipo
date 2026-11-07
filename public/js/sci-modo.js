/* =====================================================================
 * sci-modo.js — Modo SCI (Posto de Comando, migração 057).
 *   O seletor OPERAÇÃO | SCI do topo do painel troca a interface inteira: no Modo SCI, menu lateral por seções
 *   (Comando, Operações, Planejamento, Logística, Administração e Finanças) e as páginas do comando. É a mesma operação:
 *   o mapa, as equipes (grupos), os setores, as vítimas encontradas, os pedidos de ajuda e o diário vêm do painel; o que
 *   é só do SCI fica nas tabelas sci2_* (comando inicial, organograma, boletim do CI, informações, períodos e o quadro de
 *   vítimas). Regras sem tela em sci-dados.js.
 *   "Mapa operacional e setores" mostra o mapa do painel dentro do Modo SCI (o menu continua), com um botão para voltar.
 *   Na primeira vez numa operação, o "Estabelecer o SCI" pede comando inicial, informações iniciais, setores e o 1º período.
 *   API: window.SciModo = { entrar(), sair(), ativo() }.
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI, D = window.SciDados;
  if (!C || !UI || !D) return;
  var el = UI.el, P = D.PENDENTE;
  var INSTITUICOES = ['CBMPR', 'Defesa Civil', 'PMPR', 'SAMU', 'Polícia Civil', 'Guarda Municipal', 'Prefeitura'];
  var CORES_FASE = { plotada: 'azul', remocao: 'ambar', acv: 'laranja', entregue: 'verde' };
  var CAT_DIARIO = { operacao: ['COMANDO', 'azul'], setor: ['SETOR', 'azul'], deslocamento: ['EQUIPE', 'ambar'], chegada: ['EQUIPE', 'ambar'], encontro: ['VÍTIMA', 'verde'],
    alerta: ['ALERTA', 'laranja'], pessoa: ['PESSOA', 'cinza'], observacao: ['REGISTRO', 'cinza'], documento: ['DOCUMENTO', 'cinza'] };
  var NATUREZA = { aquatica: 'Busca aquática', terrestre: 'Busca terrestre', aerea: 'Busca aérea', sarp: 'Operação SARP (aeronave remotamente pilotada)', brec: 'BREC (busca e resgate em estruturas colapsadas)' };

  var est = {
    ativo: false, opId: null, pagina: 'resumo', voltarPara: 'resumo', ausente: false, erro: null, carregou: false,
    dados: { estado: null, informacoes: [], periodos: [], vitimas: [], diario: [] },
    canal: null, timer: null, relogio: null, raiz: null, corpo: null, menu: null, topo: null, hostMapa: null, mapaMovido: null,
    responsaveis: null, wizard: null, usuario: null,
  };

  function Pn() { return window.Painel; }
  function op() { return Pn() && Pn().op(); }
  function pode() { return Boolean(Pn() && Pn().podeAlterar()); }
  function $(id) { return document.getElementById(id); }
  function botao(texto, fn, classe, attrs) { return el('button', Object.assign({ classe: 'btn btn-pequeno ' + (classe || ''), type: 'button', texto: texto, onclick: fn }, attrs || {})); }
  function pend(v) { return D.vazio(v) ? el('span', { classe: 'sci2-pend', texto: P }) : el('span', { texto: String(v) }); }
  function dois(n) { return (n < 10 ? '0' : '') + n; }
  function dataLocal(v) { var d = new Date(typeof v === 'number' ? v : Date.parse(v)); return d.getFullYear() + '-' + dois(d.getMonth() + 1) + '-' + dois(d.getDate()) + 'T' + dois(d.getHours()) + ':' + dois(d.getMinutes()); }
  function iso(v) { if (!v) return null; var d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
  function bloco(titulo, filhos, acoes, extraClasse) {
    return el('section', { classe: 'sci2-bloco ' + (extraClasse || '') }, [
      el('header', { classe: 'sci2-bloco-topo' }, [el('h3', { texto: titulo }), acoes && acoes.length ? el('div', { classe: 'sci2-bloco-acoes' }, acoes) : null]),
    ].concat(filhos));
  }
  function tag(texto, cor) { return el('span', { classe: 'sci2-tag sci2-tag-' + (cor || 'cinza'), texto: texto }); }
  function kpi(n, rotulo, sub, cor, pagina) {
    return el(pagina ? 'button' : 'div', { classe: 'sci2-kpi' + (cor ? ' sci2-kpi-' + cor : ''), type: pagina ? 'button' : null, onclick: pagina ? function () { ir(pagina); } : null },
      [el('b', { texto: n == null ? '—' : String(n) }), el('span', { texto: rotulo }), sub ? el('small', { texto: sub }) : null]);
  }
  async function rpc(nome, args, ok) {
    try {
      var r = await C.rpc(nome, args);
      if (ok) UI.aviso(ok, 'ok');
      await carregar();
      return r;
    } catch (e) {
      UI.aviso(e.message, 'erro', 8000);
      return null;
    }
  }

  /* ---------- Dados ---------- */
  async function carregar() {
    var o = op();
    if (!o) return;
    var id = o.id;
    try {
      var r = await Promise.all([
        C.consultar(C.cliente.from('sci2_estado').select('*').eq('operacao_id', id).maybeSingle()),
        C.consultar(C.cliente.from('sci2_informacoes').select('*').eq('operacao_id', id).order('recebida_em', { ascending: false })),
        C.consultar(C.cliente.from('sci2_periodos').select('*').eq('operacao_id', id).order('numero', { ascending: true })),
        C.consultar(C.cliente.from('sci2_vitimas').select('*').eq('operacao_id', id).order('numero', { ascending: true })),
        C.consultar(C.cliente.from('diario').select('id,ocorrido_em,categoria,tipo,nivel,titulo,detalhe,autor_nome').eq('operacao_id', id).order('ocorrido_em', { ascending: false }).limit(60)),
      ]);
      if (!op() || op().id !== id) return;
      est.dados = { estado: r[0] || null, informacoes: r[1] || [], periodos: r[2] || [], vitimas: r[3] || [], diario: r[4] || [] };
      est.carregou = true; est.erro = null; est.ausente = false;
    } catch (e) {
      var t = String((e.original && (e.original.message || e.original.code)) || e.message || '');
      if (/sci2_|42P01|PGRST205|does not exist|schema cache/.test(t)) est.ausente = true;
      else est.erro = e.message;
      est.carregou = true;
    }
    if (est.ativo) render();
  }
  function agendar(ms) { clearTimeout(est.timer); est.timer = setTimeout(carregar, ms || 400); }
  function assinar() {
    pararCanal();
    var id = op().id;
    try {
      est.canal = C.cliente.channel('sci2-' + id + '-' + Date.now());
      ['sci2_estado', 'sci2_informacoes', 'sci2_periodos', 'sci2_vitimas'].forEach(function (t) {
        est.canal.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: 'operacao_id=eq.' + id }, function () { agendar(300); });
      });
      est.canal.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'diario', filter: 'operacao_id=eq.' + id }, function () { agendar(800); });
      est.canal.subscribe();
    } catch (e) { /* sem tempo real: o relógio recarrega */ }
  }
  function pararCanal() { if (est.canal) { try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ } } est.canal = null; }

  // Tudo o que as páginas usam, montado na hora a partir do painel e das tabelas sci2_*
  function contexto() {
    var Pa = Pn(), o = op(), agora = C.agora ? C.agora() : Date.now();
    var parts = Pa.participantes().map(function (p) { return { p: p, tipo: Pa.tipo(p), estado: Pa.estadoParticipante(p).cod }; });
    var grupos = Pa.grupos(), missoes = Pa.missoes(), setores = Pa.setores();
    var quadro = D.quadroVitimas(est.dados.vitimas, Pa.vitimasLocalizadas(), Pa.fichas());
    var equipes = D.equipesPorStatus(grupos, missoes);
    var pedidos = [];
    if (window.AjudaPedidos && window.AjudaPedidos.disponivel && window.AjudaPedidos.disponivel()) {
      Pa.participantes().forEach(function (p) { var x = window.AjudaPedidos.abertoDoParticipante(p.id); if (x) pedidos.push(x); });
    }
    var cmd = window.Briefing && window.Briefing.comando ? window.Briefing.comando() : null;
    var estado = est.dados.estado || {};
    var periodo = D.periodoAtual(est.dados.periodos, agora);
    var c = {
      o: o, agora: agora, parts: parts, grupos: grupos, missoes: missoes, setores: setores, quadro: quadro, nv: D.numerosVitimas(quadro), equipes: equipes,
      balanco: D.balancoPessoas(parts), progresso: D.progressoSetores(setores), pedidos: pedidos, estado: estado, org: estado.organograma || {},
      ci: cmd && cmd.comando_nome ? cmd.comando_nome : '', ciDesde: cmd && cmd.comando_desde, periodo: periodo,
    };
    c.alertas = D.alertas({ agora: agora, estado: estado, periodos: est.dados.periodos, informacoes: est.dados.informacoes, quadro: quadro, pedidosAjuda: pedidos,
      alertasApp: Pa.alertasAtivos(), equipes: equipes, ativa: o.status === 'ativa' });
    return c;
  }

  /* ---------- Casca: topo, menu e página ---------- */
  function montarCasca() {
    if (est.raiz) return;
    est.topo = el('header', { classe: 'sci2-topo' });
    est.menu = el('nav', { classe: 'sci2-menu', 'aria-label': 'Seções do SCI' });
    est.corpo = el('main', { classe: 'sci2-pagina', id: 'sci2-pagina', tabindex: '-1' });
    est.raiz = el('section', { classe: 'sci2', id: 'tela-sci', hidden: true, 'aria-label': 'Modo SCI' }, [est.topo, el('div', { classe: 'sci2-corpo' }, [est.menu, est.corpo])]);
    ($('tela-painel') || document.body).appendChild(est.raiz);
  }
  function seletorModo() {
    return el('div', { classe: 'modo-seletor', role: 'group', 'aria-label': 'Modo da tela' }, [
      el('button', { type: 'button', 'aria-pressed': 'false', texto: 'Operação', title: 'Voltar ao mapa operacional', onclick: function () { sair(); } }),
      el('button', { type: 'button', classe: 'ativo', 'aria-pressed': 'true', texto: 'SCI', title: 'Você está no Modo SCI' }),
    ]);
  }
  function renderTopo(c) {
    var o = c.o, ini = Date.parse(o.acionado_em || o.criada_em), p = c.periodo.atual;
    var crit = c.alertas.filter(function (a) { return a.nivel === 'critico'; }).length;
    est.topo.innerHTML = '';
    [
      el('span', { classe: 'sci2-marca', texto: 'PC' }),
      el('div', { classe: 'sci2-topo-nome' }, [el('strong', { texto: 'Gestão da Ocorrência' }),
        el('span', { texto: [o.codigo, NATUREZA[o.tipo] || o.tipo_outro, p ? 'Período ' + p.numero : null, 'T+' + D.duracao(c.agora - ini), 'CI: ' + (c.ci || P)].filter(Boolean).join(' · ') })]),
      el('span', { classe: 'sci2-esp' }),
      o.status !== 'ativa' ? tag(o.arquivada_em ? 'Arquivada · só leitura' : 'Encerrada · só leitura', 'cinza') : null,
      crit ? el('button', { type: 'button', classe: 'sci2-chip-alerta', title: 'Ver os alertas no Painel do Comando', 'aria-label': crit + ' alerta(s) crítico(s)', onclick: function () { ir('painel'); } }, [el('span', { texto: '⚠ ' + crit }), el('span', { classe: 'sci2-chip-longo', texto: ' crítico' + (crit > 1 ? 's' : '') })]) : null,
      seletorModo(),
    ].forEach(function (n) { if (n) est.topo.appendChild(n); });
  }
  function renderMenu(c) {
    est.menu.innerHTML = '';
    var minhas = D.minhasFuncoes(c.org, est.usuario);
    if (minhas.length) est.menu.appendChild(el('div', { classe: 'sci2-menu-minha' }, [el('small', { texto: '★ Sua função' }), el('span', { texto: minhas.map(function (f) { return f.nome; }).join(', ') })]));
    D.MENU.forEach(function (g) {
      var r = D.responsavelSecao(c.org, g.secao);
      est.menu.appendChild(el('div', { classe: 'sci2-menu-grupo' }, [
        el('div', { classe: 'sci2-menu-titulo' }, [g.titulo.toUpperCase(), r ? el('small', { classe: r.comCi ? 'sci2-menu-ci' : r.texto === P ? 'sci2-pend' : '', texto: r.texto }) : null]),
      ].concat(g.paginas.map(function (p) {
        var n = contador(c, p[0]);
        return el('button', { type: 'button', classe: 'sci2-menu-item' + (est.pagina === p[0] ? ' ativo' : '') + (p[0] === 'mapa' ? ' sci2-menu-mapa' : ''), 'data-pagina': p[0],
          'aria-current': est.pagina === p[0] ? 'page' : null, onclick: function () { ir(p[0]); } }, [el('span', { texto: p[1] }), n ? el('span', { classe: 'sci2-menu-n' + (n.critico ? ' critico' : ''), texto: String(n.n) }) : null]);
      }))));
    });
    var atual = est.menu.querySelector('.sci2-menu-item.ativo');
    if (atual && est.menu.scrollWidth > est.menu.clientWidth) est.menu.scrollLeft = Math.max(0, atual.offsetLeft - 48);
  }
  function contador(c, pagina) {
    var al = c.alertas.filter(function (a) { return a.pagina === pagina && a.nivel !== 'pendencia'; });
    if (pagina === 'painel') { var cr = c.alertas.filter(function (a) { return a.nivel === 'critico'; }).length; return cr ? { n: cr, critico: true } : null; }
    if (pagina === 'vitimas') { var n = c.nv.aguardandoEquipe + c.nv.emRemocao; return n ? { n: n, critico: al.length > 0 } : null; }
    return al.length ? { n: al.length, critico: al.some(function (a) { return a.nivel === 'critico'; }) } : null;
  }
  var PAGINAS = {
    resumo: paginaResumo, painel: paginaPainel, organograma: paginaOrganograma, operacoes: paginaOperacoes, mapa: paginaMapa, vitimas: paginaVitimas,
    espera: paginaEspera, recursos: paginaRecursos, formularios: paginaFormularios, logistica: paginaLogistica, admfin: paginaAdmFin, estabelecer: paginaEstabelecer,
  };
  // focoProtegido: alguém digitando na página → o redesenho periódico espera
  function render(forcar) {
    if (!est.ativo || !est.raiz) return;
    var c = contexto();
    renderTopo(c);
    renderMenu(c);
    est.raiz.classList.toggle('sci2-assistente', est.pagina === 'estabelecer');
    if (!forcar && est.pagina === 'mapa' && est.corpo.querySelector('#sci2-host-mapa')) return;   // o mapa não é redesenhado
    var ae = document.activeElement;
    if (!forcar && ae && est.corpo.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    if (!forcar && est.pagina === 'estabelecer') return;   // o assistente só redesenha quando a pessoa avança
    var rol = est.corpo.scrollTop;
    devolverMapa();
    est.corpo.innerHTML = '';
    est.corpo.setAttribute('data-pagina', est.pagina);
    if (est.ausente) {
      est.corpo.appendChild(bloco('SCI', [el('p', { classe: 'nota', texto: 'O SCI novo ainda não está no servidor: rode a migração 057_sci_posto_comando.sql no Supabase (ela só acrescenta tabelas sci2_; nada do que existe muda).' })]));
      return;
    }
    if (!est.carregou) { est.corpo.appendChild(el('p', { classe: 'muted sci2-carregando', texto: 'Carregando o SCI…' })); return; }
    if (est.erro) est.corpo.appendChild(el('p', { classe: 'nota', texto: 'Não foi possível atualizar: ' + est.erro }));
    (PAGINAS[est.pagina] || paginaResumo)(c).forEach(function (n) { if (n) est.corpo.appendChild(n); });
    est.corpo.scrollTop = rol;
  }
  function ir(pagina) {
    if (pagina === 'estabelecer' && !pode()) pagina = 'resumo';
    if (est.pagina !== 'mapa') est.voltarPara = est.pagina;
    est.pagina = pagina;
    if (pagina === 'estabelecer' && !est.wizard) iniciarWizard();
    render(true);
    est.corpo.scrollTop = 0;
  }

  /* ---------- Entrar e sair do Modo SCI ---------- */
  function entrar(pagina) {
    var o = op();
    if (!o) return;
    montarCasca();
    if (est.opId !== o.id) {
      est.opId = o.id; est.carregou = false; est.ausente = false; est.erro = null; est.wizard = null; est.responsaveis = null;
      est.dados = { estado: null, informacoes: [], periodos: [], vitimas: [], diario: [] };
      est.pagina = 'resumo';
    }
    var u = Pn().usuario && Pn().usuario();
    est.usuario = u ? u.id : null;
    est.ativo = true;
    est.raiz.hidden = false;
    document.body.classList.add('modo-sci');
    if (Pn().fecharMenu) Pn().fecharMenu();
    render(true);
    assinar();
    carregar().then(function () {
      if (!est.ativo) return;
      var e = est.dados.estado;
      // primeira vez nesta operação: estabelecer o SCI; quem tem uma função designada abre nela
      if (pagina) ir(pagina);
      else if (!est.ausente && pode() && !(e && e.estabelecido_em) && est.pagina === 'resumo') ir('estabelecer');
      else if (est.pagina === 'resumo' && e) {
        var minhas = D.minhasFuncoes(e.organograma, est.usuario);
        var destino = minhas.length ? ({ seg: 'painel', 'ops.acv': 'vitimas', 'ops.espera': 'espera', plan: 'recursos', 'plan.rec': 'recursos', 'plan.doc': 'formularios', log: 'logistica', adm: 'admfin' }[minhas[0].id]) : null;
        if (destino) ir(destino);
      }
    });
    clearInterval(est.relogio);
    est.relogio = setInterval(function () { if (est.ativo && !document.hidden) render(); }, 10000);
    sincronizarSeletor();
  }
  function sair() {
    if (!est.ativo) { sincronizarSeletor(); return; }
    est.ativo = false;
    devolverMapa();
    if (est.raiz) est.raiz.hidden = true;
    document.body.classList.remove('modo-sci');
    clearInterval(est.relogio); clearTimeout(est.timer);
    pararCanal();
    sincronizarSeletor();
    var m = Pn() && Pn().mapa();
    if (m) setTimeout(function () { m.invalidateSize(); }, 60);
  }
  function sincronizarSeletor() {
    var a = $('modo-operacao'), b = $('modo-sci');
    if (a) { a.classList.toggle('ativo', !est.ativo); a.setAttribute('aria-pressed', String(!est.ativo)); }
    if (b) { b.classList.toggle('ativo', est.ativo); b.setAttribute('aria-pressed', String(est.ativo)); }
  }

  /* ---------- Mapa operacional dentro do Modo SCI ---------- */
  function paginaMapa() {
    var host = el('div', { classe: 'sci2-host-mapa', id: 'sci2-host-mapa' });
    var topo = el('div', { classe: 'sci2-mapa-topo' }, [
      botao('← Voltar', function () { ir(est.voltarPara && est.voltarPara !== 'mapa' ? est.voltarPara : 'resumo'); }, 'btn-escuro', { id: 'sci2-mapa-voltar' }),
      el('strong', { texto: 'Mapa operacional e setores' }),
      el('span', { classe: 'muted', texto: 'Equipes, setores, pontos e vítimas ao vivo. Para desenhar setores e trilhas, use o modo Operação.' }),
    ]);
    setTimeout(function () { moverMapa(host); }, 0);
    return [el('div', { classe: 'sci2-pagina-mapa' }, [topo, host])];
  }
  function moverMapa(host) {
    var mapa = $('mapa');
    if (!mapa || !host.isConnected) return;
    if (!est.mapaMovido) est.mapaMovido = { pai: mapa.parentNode, depois: mapa.nextSibling };
    host.appendChild(mapa);
    var m = Pn().mapa();
    if (m) setTimeout(function () { m.invalidateSize(); }, 30);
  }
  function devolverMapa() {
    if (!est.mapaMovido) return;
    var mapa = $('mapa'), v = est.mapaMovido;
    est.mapaMovido = null;
    if (mapa) v.pai.insertBefore(mapa, v.depois && v.depois.parentNode === v.pai ? v.depois : v.pai.firstChild);
    var m = Pn() && Pn().mapa();
    if (m) setTimeout(function () { m.invalidateSize(); }, 30);
  }
  function verNoMapa(lat, lng) { ir('mapa'); setTimeout(function () { if (Pn().irPara) Pn().irPara(lat, lng); }, 120); }

  /* ---------- Comando · Resumo ---------- */
  function cabecalhoOcorrencia(c) {
    var o = c.o, p = c.periodo.atual;
    var ini = o.acionado_em || o.criada_em;
    return el('div', { classe: 'sci2-cab' }, [
      el('small', { classe: 'sci2-olho', texto: (o.status === 'ativa' ? 'EM ANDAMENTO' : 'ENCERRADA') + ' · ' + (NATUREZA[o.tipo] || o.tipo_outro || 'Ocorrência').toUpperCase() }),
      el('h2', { texto: o.codigo }),
      el('p', { classe: 'muted', texto: [o.local_endereco || 'Local ' + P, 'início ' + D.horaCurta(ini), 'T+' + D.duracao(c.agora - Date.parse(ini)),
        p ? 'Período operacional ' + p.numero + ' (' + D.horaCurta(p.inicio) + ' → ' + D.horaCurta(p.fim) + ')' : 'sem período operacional', 'CI: ' + (c.ci || P)].join(' · ') }),
    ]);
  }
  function paginaResumo(c) {
    var e = c.estado, nv = c.nv, b = c.balanco;
    var boletim = bloco('Situação atual · boletim do CI', [
      e.boletim ? el('p', { classe: 'sci2-boletim', texto: e.boletim }) : el('p', { classe: 'sci2-pend', texto: P + ' — o CI ainda não registrou o boletim.' }),
      e.boletim_em ? el('small', { classe: 'muted', texto: 'Atualizado às ' + D.horaCurta(e.boletim_em) + ' por ' + (e.boletim_por_nome || '—') }) : null,
    ], [pode() ? botao(e.boletim ? 'Atualizar boletim' : 'Escrever boletim', editarBoletim, 'btn-escuro', { id: 'sci2-boletim' }) : null], 'sci2-bloco-boletim');
    var kpis = el('div', { classe: 'sci2-kpis' }, [
      kpi(nv.procuradas + nv.aguardandoEquipe + nv.emRemocao, 'ainda a resgatar', nv.procuradas + ' não localizada(s) · ' + (nv.aguardandoEquipe + nv.emRemocao) + ' localizada(s)', 'laranja', 'vitimas'),
      kpi(nv.vivas, 'localizadas com vida', nv.entregues + ' entregue(s)', 'verde', 'vitimas'),
      kpi(nv.obitos, 'óbitos', null, null, 'vitimas'),
      kpi(b.total - b.sairam, 'pessoas na operação', b.emCampo + ' em campo agora', null, 'painel'),
      kpi(c.parts.filter(function (x) { return x.tipo === 'militar' && x.estado !== 'removido'; }).length, 'bombeiros empregados', c.grupos.length + ' equipe(s)', null, 'recursos'),
      kpi(c.equipes.missao.length, 'equipes em missão', c.equipes.disponivel.length + ' disponível(is) · ' + c.equipes.descanso.length + ' em descanso', null, 'operacoes'),
    ]);
    var p = c.progresso;
    var marcos = proximosMarcos(c);
    return [
      cabecalhoOcorrencia(c),
      e.estabelecido_em || !pode() ? null : el('div', { classe: 'nota sci2-nota-acao' }, [el('strong', { texto: 'O SCI desta operação ainda não foi estabelecido. ' }), 'Comando inicial, informações iniciais, setores e 1º período.', botao('Estabelecer o SCI', function () { ir('estabelecer'); }, 'btn-escuro')]),
      boletim, kpis,
      el('div', { classe: 'sci2-colunas' }, [
        bloco('Atualizações em tempo real', [linhaDoTempo(est.dados.diario.slice(0, 12))], [botao('Linha do tempo completa', function () { ir('formularios'); })]),
        el('div', { classe: 'sci2-coluna' }, [
          bloco('Riscos e alertas · ' + c.alertas.length, [listaAlertas(c.alertas.slice(0, 6))]),
          bloco('Progresso dos setores', [
            p.total ? el('div', { classe: 'sci2-barra', role: 'img', 'aria-label': p.concluido + ' concluídos, ' + p.andamento + ' em andamento, ' + p.pendente + ' pendentes' }, [
              el('span', { classe: 'v', style: 'flex:' + p.concluido }), el('span', { classe: 'a', style: 'flex:' + p.andamento }), el('span', { classe: 'z', style: 'flex:' + p.pendente })]) : null,
            el('p', { classe: 'muted', texto: p.total ? p.concluido + ' de ' + p.total + ' concluído(s) · ' + p.andamento + ' em andamento · ' + p.pendente + ' pendente(s)' : 'Nenhum setor desenhado no mapa.' }),
          ], [botao('Ver no mapa', function () { ir('mapa'); })]),
          bloco('Próximos marcos', [marcos.length ? el('ul', { classe: 'sci2-lista' }, marcos.map(function (m) { return el('li', null, [el('b', { classe: 'num', texto: D.horaCurta(m.em) }), ' ', m.texto]); }))
            : el('p', { classe: 'muted', texto: 'Nada agendado. Defina o período operacional e os retornos das equipes.' })]),
        ]),
      ]),
    ];
  }
  function proximosMarcos(c) {
    var out = [], agora = c.agora, per = c.periodo;
    if (per.atual) out.push({ em: Date.parse(per.atual.fim), texto: 'Fim do período operacional ' + per.atual.numero });
    if (per.proximo) out.push({ em: Date.parse(per.proximo.inicio), texto: 'Início do período operacional ' + per.proximo.numero });
    c.equipes.missao.forEach(function (x) {
      var m = x.missao, t = Date.parse(m.retorno_combinado_em || m.prazo_retorno_em);
      if (t && t > agora) out.push({ em: t, texto: 'Retorno previsto da equipe ' + x.grupo.nome });
    });
    return out.filter(function (m) { return m.em > agora; }).sort(function (a, b) { return a.em - b.em; }).slice(0, 5);
  }
  function linhaDoTempo(lista) {
    if (!lista.length) return el('p', { classe: 'muted', texto: 'Nada registrado ainda.' });
    return el('ul', { classe: 'sci2-eventos' }, lista.map(function (d) {
      var cat = d.tipo === 'sci2' ? ['SCI', 'laranja'] : (CAT_DIARIO[d.categoria] || ['REGISTRO', 'cinza']);
      return el('li', { classe: d.nivel === 'critico' ? 'critico' : null }, [
        el('span', { classe: 'sci2-ev-hora num', texto: D.horaCurta(d.ocorrido_em) }), tag(cat[0], cat[1]),
        el('div', { classe: 'sci2-ev-texto' }, [el('span', { texto: d.titulo.replace(/^SCI · /, '') }), d.detalhe ? el('small', { classe: 'muted', texto: d.detalhe }) : null]),
      ]);
    }));
  }
  function listaAlertas(lista) {
    if (!lista.length) return el('p', { classe: 'muted', texto: 'Nenhum alerta com o que está registrado.' });
    return el('ul', { classe: 'sci2-alertas' }, lista.map(function (a) {
      return el('li', null, [el('button', { type: 'button', classe: 'sci2-alerta sci2-alerta-' + a.nivel, onclick: function () { ir(a.pagina); } }, [
        el('span', { classe: 'sci2-alerta-nivel', texto: a.nivel === 'critico' ? 'CRÍTICO' : a.nivel === 'alerta' ? 'ALERTA' : 'FALTA' }), el('span', { texto: a.texto })])]);
    }));
  }
  async function editarBoletim() {
    var r = await UI.confirmar({ titulo: 'Boletim do CI', texto: 'Situação atual em poucas linhas: o que está acontecendo, onde, o que vem a seguir. Vai para a linha do tempo.',
      campo: { rotulo: 'Situação atual', valor: (est.dados.estado && est.dados.estado.boletim) || '', max: 4000, obrigatorio: true, area: true }, ok: 'Salvar boletim' });
    if (r) rpc('sci2_salvar_estado', { p_operacao: op().id, p_dados: { boletim: r.texto } }, 'Boletim salvo.');
  }

  /* ---------- Comando · Painel do Comando ---------- */
  function paginaPainel(c) {
    var b = c.balanco, nv = c.nv, p = c.periodo.atual, eq = c.equipes;
    var restam = p ? Date.parse(p.fim) - c.agora : null;
    var faixa = el('div', { classe: 'sci2-faixa-periodo' }, [
      el('div', null, [el('small', { classe: 'sci2-olho', texto: 'PERÍODO OPERACIONAL ATUAL' }),
        el('strong', { texto: p ? 'PO ' + p.numero + ' · ' + D.horaCurta(p.inicio) + ' → ' + D.horaCurta(p.fim) : 'Nenhum período em curso' }),
        p ? el('span', { classe: 'muted', texto: 'Restam ' + D.duracao(restam) }) : null]),
      el('div', { classe: 'sci2-bloco-acoes' }, [botao('Períodos e objetivos', function () { ir('operacoes'); }), window.Briefing ? botao('Briefing', function () { window.Briefing.abrir(); }) : null,
        botao('Formulários e relatórios', function () { ir('formularios'); })]),
    ]);
    var setoresLista = c.setores.map(function (s) {
      var m = c.missoes.filter(function (x) { return x.setor_id === s.id && D.MISSAO_ATIVA.indexOf(x.status) !== -1; });
      var st = { concluido: ['concluído', 'verde'], andamento: ['em trabalho', 'ambar'] }[s.status] || ['aberto', 'azul'];
      return el('li', { classe: 'sci2-linha' }, [el('i', { classe: 'sci2-cor', style: 'background:' + (s.cor || '#66b2ff') }), el('strong', { texto: s.nome }),
        el('span', { classe: 'muted', texto: m.length ? m.map(function (x) { return x.grupo_nome; }).join(', ') : 'sem equipe' }), tag(st[0], st[1])]);
    });
    function linhaEquipe(x, sub) { return el('li', { classe: 'sci2-linha' }, [el('i', { classe: 'sci2-cor', style: 'background:' + (x.grupo.cor || '#888') }), el('strong', { texto: x.grupo.nome }), el('span', { classe: 'muted', texto: sub })]); }
    return [
      cabecalhoOcorrencia(c), faixa,
      el('div', { classe: 'sci2-colunas' }, [
        el('div', { classe: 'sci2-coluna' }, [
          bloco('Alertas ativos · ' + c.alertas.length, [el('small', { classe: 'muted', texto: 'Ordem: segurança da equipe › vítimas › comando' }), listaAlertas(c.alertas)]),
          bloco('Balanço de pessoas', [
            el('div', { classe: 'sci2-kpis sci2-kpis-4' }, [kpi(b.total, 'na operação'), kpi(b.emCampo, 'em campo', null, 'verde'), kpi(b.semContato + b.aguardando, 'sem contato agora', null, b.semContato ? 'laranja' : null), kpi(b.sairam, 'saíram')]),
            el('p', { classe: 'muted' }, [tag(b.fecha ? 'Soma fecha' : 'Soma não fecha', b.fecha ? 'verde' : 'laranja'), ' ' + b.militares + ' militares · ' + b.civis + ' civis · ' + b.responsaveis + ' responsáveis no painel']),
            el('p', { classe: 'muted', texto: 'Vítimas: ' + nv.procuradas + ' procurada(s) · ' + nv.aguardandoEquipe + ' aguardando equipe · ' + nv.emRemocao + ' em remoção · ' + nv.foraDaEstrutura + ' na ACV ou entregue(s)' }),
          ], [botao('Controle de vítimas', function () { ir('vitimas'); })]),
          bloco('Linha do tempo', [linhaDoTempo(est.dados.diario.slice(0, 10))], [botao('Completa', function () { ir('formularios'); })]),
        ]),
        el('div', { classe: 'sci2-coluna' }, [
          bloco('Setores de trabalho · ' + c.progresso.total, [setoresLista.length ? el('ul', { classe: 'sci2-lista' }, setoresLista) : el('p', { classe: 'muted', texto: 'Nenhum setor desenhado. Desenhe no modo Operação.' })],
            [botao('Ver no mapa', function () { ir('mapa'); })]),
          bloco('Equipes por status', [
            el('p', { classe: 'muted' }, [tag(eq.missao.length + ' em missão', 'ambar'), ' ', tag(eq.disponivel.length + ' disponível(is)', 'verde'), ' ', tag(eq.descanso.length + ' em descanso', 'azul'), ' ', tag(eq.indisponivel.length + ' indisponível(is)', 'cinza')]),
            el('ul', { classe: 'sci2-lista' }, eq.missao.map(function (x) { return linhaEquipe(x, x.missao.nome + (x.missao.setor_nome ? ' · setor ' + x.missao.setor_nome : '') + ' · desde ' + D.horaCurta(x.missao.enviada_em) + ' (' + D.duracao(c.agora - Date.parse(x.missao.enviada_em)) + ')'); })
              .concat(eq.disponivel.map(function (x) { return linhaEquipe(x, 'disponível'); }), eq.descanso.map(function (x) { return linhaEquipe(x, 'em descanso'); }))),
          ], [botao('Recursos e fatores humanos', function () { ir('recursos'); })]),
        ]),
      ]),
    ];
  }

  /* ---------- Comando · Organograma ---------- */
  async function responsaveis() {
    if (est.responsaveis) return est.responsaveis;
    try { est.responsaveis = (await C.rpc('listar_responsaveis', { p_operacao: op().id })) || []; } catch (e) { est.responsaveis = []; }
    return est.responsaveis;
  }
  function organograma(m, ok) { return rpc('sci2_organograma', { p_operacao: op().id, p_mudancas: m }, ok); }
  async function desativar(id) {
    var f = D.funcao(id), lista = D.desativacao((est.dados.estado || {}).organograma, id);
    var junto = lista.slice(1).map(function (x) { return D.funcao(x).nome; });
    var r = await UI.confirmar({ titulo: 'Desativar ' + f.nome + '?', texto: (junto.length ? 'Também saem: ' + junto.join(', ') + '. ' : '') + 'A função volta ao Comandante do Incidente. O histórico fica na linha do tempo.', ok: 'Desativar', perigo: true });
    if (r) organograma([{ id: id, ativa: false }], f.nome + ' desativada.');
  }
  async function designar(id) {
    if (!pode()) return;
    var f = D.funcao(id), a = (((est.dados.estado || {}).organograma || {}).ativas || {})[id] || {};
    var lista = await responsaveis();
    var nome = el('input', { classe: 'campo', id: 'sci2-d-nome', maxlength: '80', placeholder: 'Posto e nome' });
    nome.value = a.nome || '';
    var conta = el('select', { classe: 'campo', id: 'sci2-d-conta' }, [el('option', { value: '', texto: '— sem conta no app —' })].concat(lista.map(function (r) {
      return el('option', { value: r.user_id, selected: a.user_id === r.user_id ? true : null, texto: r.nome + (r.email ? ' (' + r.email + ')' : '') });
    })));
    conta.addEventListener('change', function () { var r = lista.filter(function (x) { return x.user_id === conta.value; })[0]; if (r && !nome.value.trim()) nome.value = r.nome; });
    var form = el('form', { novalidate: true }, [
      el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, [f.nome, UI.dica(f.titulo + ': ' + f.desc + '. Com a conta ligada, o Modo SCI abre na página desta função para essa pessoa.')]),
      UI.campo(f.titulo, nome, { para: 'sci2-d-nome', largo: true }),
      UI.campo('Conta de responsável (opcional)', conta, { para: 'sci2-d-conta', largo: true }),
      UI.rodape([f.fixa ? null : botao('Desativar', function () { fechar(); desativar(id); }, 'btn-perigo'), botao('Cancelar', function () { fechar(); }),
        el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'sci2-d-salvar', texto: 'Salvar' })]),
    ]);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var m = { id: id }, n = nome.value.replace(/\s+/g, ' ').trim();
      if (n !== (a.nome || '')) m.nome = n;
      if ((conta.value || null) !== (a.user_id || null)) m.user_id = conta.value || null;
      fechar();
      if (Object.keys(m).length > 1) organograma([m], f.nome + ': ' + (n || P) + '.');
    });
    var fechar = UI.abrirModal(form, { tamanho: 'estreito' });
  }
  function cartao(c, id, filhos) {
    var f = D.funcao(id), a = (c.org.ativas || {})[id] || {}, n = a.nome;
    var titulo = n ? el('strong', { texto: n }) : f.fixa ? el('strong', { classe: 'sci2-ci-txt', texto: 'com o CI' }) : el('strong', { classe: 'sci2-pend', texto: P });
    var conta = a.user_id ? ((est.responsaveis || []).filter(function (r) { return r.user_id === a.user_id; })[0] || {}).nome || 'conta ligada' : null;
    return el('div', { classe: 'sci2-fn sci2-fn-' + f.tipo, 'data-funcao': id }, [
      el('div', { classe: 'sci2-fn-cab' }, [el('div', { classe: 'sci2-fn-nome' }, [el('small', { texto: f.nome }), el('span', { texto: f.titulo })]),
        pode() ? botao(n ? 'Trocar' : 'Designar', function () { designar(id); }, n ? '' : 'btn-escuro') : null,
        pode() && !f.fixa ? el('button', { type: 'button', classe: 'sci2-fn-x', title: 'Desativar (volta ao CI)', 'aria-label': 'Desativar ' + f.nome, texto: '×', onclick: function () { desativar(id); } }) : null]),
      titulo,
      el('small', { classe: 'muted', texto: [conta ? '★ ' + (a.user_id === est.usuario ? 'você' : conta) : null, a.desde ? 'desde ' + D.horaCurta(a.desde) : f.fixa ? 'desde a abertura' : null].filter(Boolean).join(' · ') }),
    ].concat(filhos || []));
  }
  function ativar(id) {
    var f = D.funcao(id);
    return el('button', { type: 'button', classe: 'sci2-fn-ativar', 'data-ativar': id, disabled: pode() ? null : true, title: f.desc,
      onclick: function () { organograma([{ id: id, ativa: true }], f.nome + ' ativada. Designe quem responde.'); } }, [el('span', { texto: '+ ' + f.nome }), el('small', { texto: f.desc })]);
  }
  function unidades(c, pai) {
    return D.filhos(pai).map(function (u) {
      if (!D.ativa(c.org, u.id)) return D.podeAtivar(c.org, u.id) && pode() ? ativar(u.id) : null;
      var sub = D.filhos(u.id);
      return cartao(c, u.id, sub.length ? [el('div', { classe: 'sci2-fn-filhos' }, unidades(c, u.id))] : null);
    });
  }
  function paginaOrganograma(c) {
    if (est.responsaveis == null) responsaveis().then(function () { render(true); });
    var com = D.comOCi(c.org);
    var staff = D.CATALOGO.filter(function (f) { return f.tipo === 'staff'; }).map(function (f) { return D.ativa(c.org, f.id) ? cartao(c, f.id) : pode() ? ativar(f.id) : null; });
    var equipes = c.grupos.map(function (g) {
      var tipo = (c.org.equipes || {})[g.id] || '';
      var lider = Pn().membros(g.id).filter(function (m) { return m.papel === 'responsavel'; }).map(function (m) { var p = Pn().participante(m.participante_id); return p ? Pn().nome(p) : null; }).filter(Boolean);
      var sel = el('select', { classe: 'campo sci2-sel-tipo', 'aria-label': 'Tipo de ' + g.nome, disabled: pode() ? null : true }, [el('option', { value: '', texto: 'Tipo…' })].concat(Object.keys(D.TIPOS_EQUIPE).map(function (k) {
        return el('option', { value: k, selected: tipo === k ? true : null, texto: D.TIPOS_EQUIPE[k] });
      })));
      sel.addEventListener('change', function () { organograma([{ equipe: g.id, tipo: sel.value || null }]); });
      return el('div', { classe: 'sci2-equipe' }, [el('i', { classe: 'sci2-cor', style: 'background:' + (g.cor || '#888') }), el('div', null, [el('strong', { texto: g.nome }),
        el('small', { classe: 'muted', texto: (lider.length ? 'Líder: ' + lider.join(', ') + ' · ' : '') + Pn().membros(g.id).length + ' membro(s)' })]), sel]);
    });
    var secoes = D.CATALOGO.filter(function (f) { return f.tipo === 'secao'; }).map(function (f) {
      if (!D.ativa(c.org, f.id)) return el('div', { classe: 'sci2-org-col sci2-org-off' }, [pode() ? ativar(f.id) : el('div', { classe: 'sci2-fn sci2-fn-off' }, [el('small', { texto: f.nome }), el('strong', { classe: 'sci2-ci-txt', texto: 'com o CI' })])]);
      var extra = f.id === 'ops' ? [el('div', { classe: 'sci2-equipes' }, [el('small', { classe: 'sci2-olho', texto: 'RECURSOS TÁTICOS (equipes do app)' })].concat(equipes.length ? equipes : [el('p', { classe: 'muted', texto: 'Nenhum grupo criado ainda.' })]).concat([
        botao('Grupos e membros', function () { Pn().abrirGrupos(); })]))] : [];
      return el('div', { classe: 'sci2-org-col' }, [cartao(c, f.id), el('div', { classe: 'sci2-fn-filhos' }, unidades(c, f.id).concat(extra))]);
    });
    var log = est.dados.diario.filter(function (d) { return d.tipo === 'sci2' && /^SCI · (Ativada|Desativada|Oficial|Seção|Unidade|Setor de|Área de Espera|ACV|Especialistas)/.test(d.titulo); }).slice(0, 12);
    return [
      el('div', { classe: 'sci2-cab' }, [el('small', { classe: 'sci2-olho', texto: c.o.codigo + ' · SISTEMA DE COMANDO DE INCIDENTES' }), el('h2', { texto: 'SCI · organograma' }),
        el('p', { classe: 'muted', texto: 'A estrutura cresce conforme a ocorrência: toque numa função tracejada para ativá-la. O que não está ativado fica com o Comandante do Incidente.' })]),
      el('div', { classe: 'sci2-org' }, [
        el('div', { classe: 'sci2-fn sci2-fn-ci' }, [
          el('div', { classe: 'sci2-fn-cab' }, [el('div', { classe: 'sci2-fn-nome' }, [el('small', { texto: 'COMANDANTE DO INCIDENTE' })]),
            window.Briefing && pode() ? botao('Passar o comando', function () { window.Briefing.abrir(); }) : null]),
          c.ci ? el('strong', { texto: c.ci }) : el('strong', { classe: 'sci2-pend', texto: P }),
          el('small', { classe: 'muted', texto: c.ciDesde ? 'no comando desde ' + D.horaCurta(c.ciDesde) : 'comando da operação (Briefing → assumir ou passar o comando)' }),
          com.length ? el('small', { classe: 'sci2-com-ci', texto: 'Funções não ativadas ficam com o CI: ' + com.join(', ') }) : null,
        ]),
        el('div', { classe: 'sci2-org-staff' }, [el('small', { classe: 'sci2-olho', texto: 'STAFF DO COMANDO' })].concat(staff.filter(Boolean))),
        el('div', { classe: 'sci2-org-secoes' }, secoes),
      ]),
      bloco('Ativações e desativações', [log.length ? linhaDoTempo(log) : el('p', { classe: 'muted', texto: 'Cada mudança entra na linha do tempo como decisão do Comando.' })]),
    ];
  }

  /* ---------- Operações · Visão geral e períodos ---------- */
  function salvarPeriodo(p, dados, ok) { return rpc('sci2_periodo', { p_operacao: op().id, p_id: p ? p.id : null, p_dados: dados }, ok); }
  function formPeriodo(p, base) {
    var b = base || {};
    var ini = el('input', { classe: 'campo', id: 'sci2-p-ini', type: 'datetime-local', value: dataLocal(p ? p.inicio : b.inicio || Date.now()) });
    var fim = el('input', { classe: 'campo', id: 'sci2-p-fim', type: 'datetime-local', value: dataLocal(p ? p.fim : b.fim || Date.now() + 12 * 3600e3) });
    var obj = el('textarea', { classe: 'campo', id: 'sci2-p-obj', rows: '5', placeholder: 'Um objetivo por linha. Ex.: Varrer os setores 1 e 2 até 18h' });
    obj.value = (p ? p.objetivos : []).map(function (x) { return x.texto; }).join('\n');
    var form = el('form', { novalidate: true }, [
      el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, [p ? 'Período operacional ' + p.numero : 'Novo período operacional', UI.dica('Objetivos do período (SCI 202). O estado de cada um é marcado na página.')]),
      UI.grade([UI.campo('Início', ini, { para: 'sci2-p-ini' }), UI.campo('Fim', fim, { para: 'sci2-p-fim' })]),
      UI.campo('Objetivos', obj, { para: 'sci2-p-obj', largo: true, opcional: true }),
      UI.rodape([botao('Cancelar', function () { fechar(); }), el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'sci2-p-salvar', texto: 'Salvar' })]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var antigos = p ? p.objetivos : [];
      var lista = obj.value.split('\n').map(function (t) { return t.trim(); }).filter(Boolean).slice(0, 20).map(function (t) {
        var a = antigos.filter(function (x) { return x.texto === t; })[0];
        return { texto: t.slice(0, 300), estado: a ? a.estado : 'pendente' };
      });
      var r = await salvarPeriodo(p, { inicio: iso(ini.value), fim: iso(fim.value), objetivos: lista }, p ? 'Período atualizado.' : 'Período definido.');
      if (r) fechar();
    });
    var fechar = UI.abrirModal(form);
  }
  async function novaInformacao() {
    var t = el('textarea', { classe: 'campo', id: 'sci2-i-texto', rows: '3', maxlength: '1000', placeholder: 'Ex.: 2 pessoas caíram da ponte por volta das 7h' });
    var f = el('input', { classe: 'campo', id: 'sci2-i-fonte', maxlength: '200', placeholder: 'Ex.: COPOM, testemunha, empresa' });
    var h = el('input', { classe: 'campo', id: 'sci2-i-hora', type: 'datetime-local', value: dataLocal(Date.now()) });
    var form = el('form', { novalidate: true }, [
      el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, ['Informação recebida', UI.dica('Entra como NÃO CONFIRMADA, com fonte e hora. A equipe confirma (ou descarta com motivo) depois.')]),
      UI.campo('O que foi informado', t, { para: 'sci2-i-texto', largo: true }), UI.grade([UI.campo('Fonte', f, { para: 'sci2-i-fonte' }), UI.campo('Recebida às', h, { para: 'sci2-i-hora' })]),
      UI.rodape([botao('Cancelar', function () { fechar(); }), el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'sci2-i-salvar', texto: 'Registrar' })]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      if (!t.value.trim()) { t.focus(); return; }
      var r = await rpc('sci2_informacao', { p_operacao: op().id, p_id: null, p_dados: { texto: t.value, fonte: f.value, recebida_em: iso(h.value) } }, 'Informação registrada (NÃO CONFIRMADA).');
      if (r) fechar();
    });
    var fechar = UI.abrirModal(form, { tamanho: 'estreito' });
  }
  function listaInformacoes(lista) {
    if (!lista.length) return el('p', { classe: 'muted', texto: 'Nenhuma informação registrada.' });
    return el('ul', { classe: 'sci2-lista' }, lista.map(function (i) {
      var est2 = i.descartada_em ? ['DESCARTADA', 'cinza'] : i.confirmada_em ? ['CONFIRMADA', 'verde'] : ['NÃO CONFIRMADA', 'laranja'];
      return el('li', { classe: 'sci2-info' + (i.descartada_em ? ' descartada' : '') }, [
        el('div', null, [el('span', { texto: i.texto }), el('small', { classe: 'muted', texto: 'Fonte: ' + (i.fonte || P) + ' · ' + D.horaCurta(i.recebida_em) + (i.confirmada_em ? ' · confirmada por ' + i.confirmada_por_nome : '') + (i.descartada_em ? ' · ' + i.descartada_motivo : '') })]),
        tag(est2[0], est2[1]),
        pode() && !i.confirmada_em && !i.descartada_em ? el('span', { classe: 'sci2-info-acoes' }, [
          botao('Confirmar', function () { rpc('sci2_informacao', { p_operacao: op().id, p_id: i.id, p_dados: { confirmar: true } }, 'Informação confirmada.'); }),
          botao('Descartar', async function () { var r = await UI.confirmar({ titulo: 'Descartar a informação?', texto: i.texto, campo: { rotulo: 'Motivo', obrigatorio: true, max: 300 }, ok: 'Descartar', perigo: true }); if (r) rpc('sci2_informacao', { p_operacao: op().id, p_id: i.id, p_dados: { descartar: r.texto } }, 'Informação descartada.'); }, 'btn-link'),
        ]) : null,
      ]);
    }));
  }
  function paginaOperacoes(c) {
    var p = c.periodo.atual || c.periodo.proximo || c.periodo.vencido, per = est.dados.periodos;
    var objetivos = p ? el('ul', { classe: 'sci2-lista' }, (p.objetivos || []).map(function (x, i) {
      var sel = el('select', { classe: 'campo sci2-sel-obj', 'aria-label': 'Estado do objetivo', disabled: pode() ? null : true }, Object.keys(D.ESTADO_OBJETIVO).map(function (k) { return el('option', { value: k, selected: x.estado === k ? true : null, texto: D.ESTADO_OBJETIVO[k] }); }));
      sel.addEventListener('change', function () { var lista = p.objetivos.map(function (o, j) { return j === i ? { texto: o.texto, estado: sel.value } : o; }); salvarPeriodo(p, { objetivos: lista }); });
      return el('li', { classe: 'sci2-linha sci2-obj sci2-obj-' + x.estado }, [el('span', { classe: 'sci2-obj-marca', texto: x.estado === 'cumprido' ? '✓' : x.estado === 'em_curso' ? '◐' : '○' }), el('span', { texto: x.texto }), sel]);
    })) : null;
    var designacoes = c.equipes.missao.map(function (x) {
      var m = x.missao;
      return el('tr', null, [x.grupo.nome, m.setor_nome || '—', m.nome, ({ enviada: 'enviada', em_deslocamento: 'em deslocamento', no_setor: 'no setor', busca_finalizada: 'retornando', retorno_atrasado: 'RETORNO ATRASADO' })[m.status] || m.status,
        D.horaCurta(m.enviada_em) + ' (' + D.duracao(c.agora - Date.parse(m.enviada_em)) + ')'].map(function (t) { return el('td', { texto: t }); }));
    });
    var naoConf = est.dados.informacoes.filter(function (i) { return !i.confirmada_em && !i.descartada_em; });
    var decisoes = c.alertas.filter(function (a) { return a.nivel !== 'pendencia'; });
    return [
      el('div', { classe: 'sci2-cab' }, [el('small', { classe: 'sci2-olho', texto: 'SEÇÃO DE OPERAÇÕES · ' + (D.responsavelSecao(c.org, 'ops').texto).toUpperCase() }), el('h2', { texto: 'Operações · visão geral' }),
        el('p', { classe: 'muted', texto: 'Períodos operacionais, objetivos, designações das equipes e o que pede decisão.' })]),
      el('div', { classe: 'sci2-colunas' }, [
        el('div', { classe: 'sci2-coluna' }, [
          bloco(p ? 'Período operacional ' + p.numero + (p === c.periodo.atual ? ' · em curso' : p === c.periodo.proximo ? ' · próximo' : ' · terminado') : 'Período operacional', p ? [
            el('p', { classe: 'sci2-periodo-hora' }, [el('b', { texto: D.horaCurta(p.inicio) + ' → ' + D.horaCurta(p.fim) }), p === c.periodo.atual ? ' · restam ' + D.duracao(Date.parse(p.fim) - c.agora) : '']),
            el('small', { classe: 'sci2-olho', texto: 'OBJETIVOS DO PERÍODO (SCI 202)' }),
            (p.objetivos || []).length ? objetivos : el('p', { classe: 'sci2-pend', texto: P + ' — sem objetivos.' }),
          ] : [el('p', { classe: 'muted', texto: 'Nenhum período operacional definido.' })], [pode() && p ? botao('Editar', function () { formPeriodo(p); }) : null,
            pode() ? botao(p ? 'Preparar o próximo' : 'Definir período', function () { var u = per[per.length - 1]; formPeriodo(null, u ? { inicio: Date.parse(u.fim), fim: Date.parse(u.fim) + (Date.parse(u.fim) - Date.parse(u.inicio)) } : null); }, 'btn-escuro', { id: 'sci2-novo-periodo' }) : null]),
          bloco('Designações táticas (SCI 204) · equipe × setor × tarefa', [designacoes.length ? el('div', { classe: 'sci2-tabela-rol' }, [el('table', { classe: 'sci2-tabela' }, [
            el('thead', null, [el('tr', null, ['Equipe', 'Setor', 'Tarefa', 'Situação', 'Desde'].map(function (t) { return el('th', { texto: t }); }))]), el('tbody', null, designacoes)])])
            : el('p', { classe: 'muted', texto: 'Nenhuma equipe em deslocamento. As designações vêm dos deslocamentos de grupos do app.' })], [botao('Deslocamentos de grupos', function () { Pn().abrirMissoes(); })]),
          per.length > 1 ? bloco('Períodos operacionais', [el('ul', { classe: 'sci2-lista' }, per.map(function (x) {
            var feitos = (x.objetivos || []).filter(function (o) { return o.estado === 'cumprido'; }).length;
            return el('li', { classe: 'sci2-linha' }, [el('strong', { texto: 'PO ' + x.numero }), el('span', { classe: 'muted', texto: D.horaCurta(x.inicio) + ' → ' + D.horaCurta(x.fim) }), el('span', { texto: feitos + '/' + (x.objetivos || []).length + ' objetivos cumpridos' }),
              pode() ? botao('Abrir', function () { formPeriodo(x); }) : null]);
          }))]) : null,
        ]),
        el('div', { classe: 'sci2-coluna' }, [
          bloco('Precisa da sua decisão', [listaAlertas(decisoes), naoConf.length ? el('p', { classe: 'muted', texto: naoConf.length + ' informação(ões) NÃO CONFIRMADA(S) logo abaixo.' }) : null]),
          bloco('Informações recebidas', [listaInformacoes(est.dados.informacoes)], [pode() ? botao('+ Informação', novaInformacao, 'btn-escuro', { id: 'sci2-nova-info' }) : null]),
        ]),
      ]),
    ];
  }

  /* ---------- Operações · Vítimas e ACV ---------- */
  function vitima(id, dados, ok) { return rpc('sci2_vitima', { p_operacao: op().id, p_id: id, p_dados: dados }, ok); }
  function nomeFicha(id) { var f = id ? Pn().fichas().filter(function (x) { return x.id === id; })[0] : null; return f ? f.nome : ''; }
  function locDe(v) { return v.localizacao_id ? Pn().vitimasLocalizadas().filter(function (l) { return l.id === v.localizacao_id; })[0] || null : null; }
  function cartaoVitima(v, c) {
    var l = locDe(v), n = nomeFicha(v.vitima_id);
    var linha = v.fase === 'remocao' ? 'com ' + (v.equipe_nome || 'equipe') + ' desde ' + D.horaCurta(v.remocao_em) : v.fase === 'acv' ? 'na ACV desde ' + D.horaCurta(v.acv_em) : v.fase === 'entregue' ? 'entregue ' + D.horaCurta(v.entregue_em) + ' · ' + v.destino : 'aguardando equipe há ' + D.duracao(c.agora - Date.parse(v.criado_em));
    return el('button', { type: 'button', classe: 'sci2-vit sci2-vit-' + v.fase, 'data-vitima': v.id, onclick: function () { abrirVitima(v); } }, [
      el('div', { classe: 'sci2-vit-cab' }, [el('b', { texto: D.vnum(v.numero) }), tag(D.CONDICAO[v.condicao], v.condicao === 'obito' ? 'cinza' : v.condicao === 'viva' ? 'verde' : 'ambar')]),
      n ? el('span', { texto: n }) : null,
      el('small', { classe: 'muted', texto: linha }),
      v.fase === 'remocao' ? el('small', { classe: 'sci2-bloqueio', texto: 'Bloqueada para ' + v.equipe_nome + ' · não designar outra equipe' }) : null,
      l ? el('small', { classe: 'muted', texto: 'Encontrada por ' + (l.registrado_por_nome || '—') + ' às ' + D.horaCurta(l.registrado_em) }) : !v.localizacao_id ? el('small', { classe: 'muted', texto: 'Sem plotagem no mapa' }) : null,
    ]);
  }
  function abrirVitima(v) {
    var c = contexto(), l = locDe(v), fichas = Pn().fichas();
    var equipe = el('select', { classe: 'campo', id: 'sci2-v-equipe' }, [el('option', { value: '', texto: 'Escolha a equipe…' })].concat(c.grupos.map(function (g) {
      var ocupada = c.quadro.remocao.some(function (x) { return x.equipe_grupo_id === g.id && x.id !== v.id; });
      return el('option', { value: g.id, texto: g.nome + (ocupada ? ' (em outra remoção)' : '') });
    })));
    var destino = el('input', { classe: 'campo', id: 'sci2-v-destino', maxlength: '200', placeholder: 'Ex.: SAMU – Hospital do Trabalhador' }); destino.value = v.destino || '';
    var cond = el('select', { classe: 'campo', id: 'sci2-v-cond' }, Object.keys(D.CONDICAO).map(function (k) { return el('option', { value: k, selected: v.condicao === k ? true : null, texto: D.CONDICAO[k] }); }));
    var ficha = el('select', { classe: 'campo', id: 'sci2-v-ficha' }, [el('option', { value: '', texto: '— sem ficha —' })].concat(fichas.map(function (f) { return el('option', { value: f.id, selected: v.vitima_id === f.id ? true : null, texto: f.nome }); })));
    var obs = el('textarea', { classe: 'campo', id: 'sci2-v-obs', rows: '2', maxlength: '1000' }); obs.value = v.observacao || '';
    var acoes = [];
    var ro = !pode();
    if (!ro && v.fase === 'plotada') acoes.push(UI.campo('Equipe da remoção', el('div', { classe: 'sci2-linha-campo' }, [equipe, botao('Iniciar remoção', function () {
      if (!equipe.value) { equipe.focus(); return; } fechar(); vitima(v.id, { fase: 'remocao', equipe_grupo_id: equipe.value }, D.vnum(v.numero) + ' em remoção.'); }, 'btn-escuro', { id: 'sci2-v-remocao' })]), { para: 'sci2-v-equipe', largo: true }));
    if (!ro && (v.fase === 'plotada' || v.fase === 'remocao')) acoes.push(botao('Check-in na ACV', function () { fechar(); vitima(v.id, { fase: 'acv' }, D.vnum(v.numero) + ' na ACV.'); }, v.fase === 'remocao' ? 'btn-escuro' : '', { id: 'sci2-v-acv' }));
    if (!ro && v.fase === 'remocao') acoes.push(botao('Liberar bloqueio', function () { fechar(); vitima(v.id, { liberar: true }, 'Bloqueio liberado.'); }, 'btn-link'));
    if (!ro && v.fase === 'acv') acoes.push(UI.campo('Destino da entrega', el('div', { classe: 'sci2-linha-campo' }, [destino, botao('Registrar entrega', function () {
      if (!destino.value.trim()) { destino.focus(); return; } fechar(); vitima(v.id, { fase: 'entregue', destino: destino.value }, D.vnum(v.numero) + ' entregue.'); }, 'btn-escuro', { id: 'sci2-v-entregar' })]), { para: 'sci2-v-destino', largo: true }));
    var etapas = [['Plotada', v.criado_em], ['Em remoção' + (v.equipe_nome ? ' (' + v.equipe_nome + ')' : ''), v.remocao_em], ['Check-in na ACV', v.acv_em], ['Entregue' + (v.destino ? ' — ' + v.destino : ''), v.entregue_em]];
    var form = el('form', { novalidate: true }, [
      el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, [D.vnum(v.numero) + (nomeFicha(v.vitima_id) ? ' · ' + nomeFicha(v.vitima_id) : ''), UI.dica('Plotada no mapa → em remoção (equipe bloqueada) → check-in na ACV → entregue. Cada passo vai para a linha do tempo.')]),
      el('ol', { classe: 'sci2-etapas' }, etapas.map(function (x) { return el('li', { classe: x[1] ? 'feito' : null }, [el('b', { texto: x[1] ? D.horaCurta(x[1]) : '—' }), ' ', x[0]]); })),
      l ? el('p', { classe: 'muted', texto: 'Encontrada por ' + (l.registrado_por_nome || '—') + ' às ' + D.horaCurta(l.registrado_em) + (l.local_descricao ? ' · ' + l.local_descricao : '') }) : null,
      acoes.length ? el('div', { classe: 'sci2-v-acoes' }, acoes) : null,
      UI.secao('Dados', [UI.grade([UI.campo('Condição', cond, { para: 'sci2-v-cond' }), UI.campo('Ficha da vítima', ficha, { para: 'sci2-v-ficha' })]), UI.campo('Observação', obs, { para: 'sci2-v-obs', largo: true, opcional: true })]),
      UI.rodape([
        l && l.lat != null ? botao('Ver no mapa', function () { fechar(); verNoMapa(l.lat, l.lng); }) : null,
        v.vitima_id ? botao('Abrir a ficha', function () { Pn().abrirFicha(v.vitima_id); }) : null,
        botao('Fechar', function () { fechar(); }),
        ro ? null : el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'sci2-v-salvar', texto: 'Salvar dados' }),
      ]),
    ]);
    if (ro) [cond, ficha, obs].forEach(function (x) { x.disabled = true; });
    form.addEventListener('submit', function (ev) { ev.preventDefault(); fechar(); vitima(v.id, { condicao: cond.value, vitima_id: ficha.value || null, observacao: obs.value }, 'Dados salvos.'); });
    var fechar = UI.abrirModal(form);
  }
  async function chegadaSemPlotagem() {
    var cond = el('select', { classe: 'campo', id: 'sci2-s-cond' }, Object.keys(D.CONDICAO).map(function (k) { return el('option', { value: k, texto: D.CONDICAO[k] }); }));
    var obs = el('textarea', { classe: 'campo', id: 'sci2-s-obs', rows: '2', maxlength: '1000', placeholder: 'Ex.: trazida pela população, sem fita de identificação' });
    var form = el('form', { novalidate: true }, [el('h2', { id: 'modal-titulo', texto: 'Chegou na ACV sem plotagem' }),
      el('p', { classe: 'muted', texto: 'A vítima entra no quadro já na ACV, com o próximo número. Depois dá para ligar à ficha.' }),
      UI.campo('Condição', cond, { para: 'sci2-s-cond' }), UI.campo('Observação', obs, { para: 'sci2-s-obs', largo: true, opcional: true }),
      UI.rodape([botao('Cancelar', function () { fechar(); }), el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'sci2-s-salvar', texto: 'Confirmar check-in' })])]);
    form.addEventListener('submit', function (ev) { ev.preventDefault(); fechar(); vitima(null, { fase: 'acv', condicao: cond.value, observacao: obs.value }, 'Check-in na ACV registrado.'); });
    var fechar = UI.abrirModal(form, { tamanho: 'estreito' });
  }
  function paginaVitimas(c) {
    var q = c.quadro, nv = c.nv;
    var colunas = D.FASES.map(function (f) {
      var lista = q[f[0]];
      return el('div', { classe: 'sci2-vit-col sci2-vit-col-' + CORES_FASE[f[0]] }, [el('div', { classe: 'sci2-vit-col-topo' }, [el('strong', { texto: f[1] }), el('span', { classe: 'num', texto: String(lista.length) })])]
        .concat(lista.length ? lista.map(function (v) { return cartaoVitima(v, c); }) : [el('p', { classe: 'muted sci2-vazio', texto: '—' })]));
    });
    var fora = q.foraDoQuadro.map(function (l) {
      var n = nomeFicha(l.vitima_id);
      return el('li', { classe: 'sci2-linha' }, [tag(l.condicao === 'obito' ? 'óbito' : 'com vida', l.condicao === 'obito' ? 'cinza' : 'verde'),
        el('span', { texto: (n ? n + ' · ' : '') + 'encontrada por ' + (l.registrado_por_nome || '—') + ' às ' + D.horaCurta(l.registrado_em) }),
        l.lat != null ? botao('Ver no mapa', function () { verNoMapa(l.lat, l.lng); }) : null,
        pode() ? botao('Trazer para o quadro', function () { vitima(null, { localizacao_id: l.id }, 'Vítima no quadro.'); }, 'btn-escuro') : null]);
    });
    return [
      el('div', { classe: 'sci2-cab' }, [el('small', { classe: 'sci2-olho', texto: c.o.codigo + ' · SINCRONIZADO COM O MAPA OPERACIONAL' }), el('h2', { texto: 'Vítimas e ACV' }),
        el('p', { classe: 'muted', texto: 'Plotada no mapa → em remoção (equipe bloqueada) → check-in na ACV → entregue.' })]),
      el('div', { classe: 'sci2-kpis' }, [kpi(nv.procuradas, 'não localizadas', 'fichas sem localização', 'laranja'), kpi(nv.aguardandoEquipe, 'localizadas', 'aguardando equipe', nv.aguardandoEquipe ? 'laranja' : null),
        kpi(nv.emRemocao, 'em remoção', 'agora', nv.emRemocao ? 'ambar' : null), kpi(nv.foraDaEstrutura, 'fora da estrutura', nv.naAcv + ' na ACV · ' + nv.entregues + ' entregue(s)', 'verde')]),
      el('div', { classe: 'sci2-acoes-pagina' }, pode() ? [
        botao('+ Vítima encontrada', function () { Pn().abrirRegistroVitima({ depois: function () { entrar('vitimas'); } }); }, 'btn-escuro', { id: 'sci2-vit-nova' }),
        botao('+ Chegou na ACV sem plotagem', chegadaSemPlotagem, '', { id: 'sci2-vit-acv' }),
        Pn().cadastroRapido ? botao('+ Ficha de vítima (procurada)', function () { Pn().cadastroRapido(); }) : null,
      ] : []),
      fora.length ? bloco('Conciliação mapa × quadro · ' + fora.length, [el('p', { classe: 'muted', texto: 'Vítimas encontradas no app que ainda não estão no quadro.' }), el('ul', { classe: 'sci2-lista' }, fora)], null, 'sci2-bloco-alerta') : null,
      el('div', { classe: 'sci2-quadro-vit' }, colunas),
      q.procuradas.length ? bloco('Ainda procuradas (fichas) · ' + q.procuradas.length, [el('ul', { classe: 'sci2-lista' }, q.procuradas.map(function (f) {
        return el('li', { classe: 'sci2-linha' }, [el('strong', { texto: f.nome }), el('span', { classe: 'muted', texto: [f.idade != null ? f.idade + ' anos' : null, f.caracteristicas].filter(Boolean).join(' · ') }), botao('Abrir a ficha', function () { Pn().abrirFicha(f.id); })]);
      }))]) : null,
      bloco('Área de Concentração de Vítimas', [el('p', { classe: 'muted' }, ['Encarregado da ACV: ', pend(D.ativa(c.org, 'ops.acv') ? D.nome(c.org, 'ops.acv') : 'com o CI'), '. ', D.ativa(c.org, 'ops.acv') ? '' : 'Ative a ACV no organograma quando alguém assumir.'])],
        [pode() && !D.ativa(c.org, 'ops.acv') ? botao('Ativar a ACV', function () { organograma([{ id: 'ops.acv', ativa: true }], 'ACV ativada.'); }) : null]),
    ];
  }

  /* ---------- Planejamento · Formulários e relatórios ---------- */
  function paginaFormularios(c) {
    var texto = D.sci201({ op: c.o, ci: c.ci, agora: c.agora, estado: c.estado, periodos: est.dados.periodos, informacoes: est.dados.informacoes, setores: c.setores, equipes: c.equipes, quadro: c.quadro });
    var pre = el('pre', { classe: 'sci2-pre', id: 'sci2-201', texto: texto });
    var R = window.Relatorio;
    return [
      el('div', { classe: 'sci2-cab' }, [el('small', { classe: 'sci2-olho', texto: c.o.codigo + ' · UNIDADE DE DOCUMENTAÇÃO · ' + (D.ativa(c.org, 'plan.doc') ? D.nome(c.org, 'plan.doc') || P : 'com o CI').toUpperCase() }), el('h2', { texto: 'Formulários e relatórios' }),
        el('p', { classe: 'muted', texto: 'Montados a partir dos registros da operação. Campo sem informação sai como [PENDENTE].' })]),
      el('div', { classe: 'sci2-colunas' }, [
        bloco('SCI 201 · Resumo do Incidente', [pre], [botao('Copiar', function () { copiar(texto); }, 'btn-escuro', { id: 'sci2-copiar-201' })]),
        el('div', { classe: 'sci2-coluna' }, [
          bloco('Relatórios da operação', [el('p', { classe: 'muted', texto: 'Diário, passagem de comando, relatório final e relatório para a imprensa, em PDF, com as fotos.' }),
            el('div', { classe: 'sci2-acoes-pagina' }, [R ? botao('Abrir relatórios', function () { R.abrirRelatoriosOperacao(c.o); }, 'btn-escuro') : null, window.Briefing ? botao('Briefing e passagem de comando', function () { window.Briefing.abrir(); }) : null])]),
          bloco('Linha do tempo · SCI 214', [linhaDoTempo(est.dados.diario.slice(0, 30))], [R ? botao('Diário completo', function () { R.abrirDiario(c.o); }) : null]),
        ]),
      ]),
    ];
  }
  async function copiar(t) {
    try { await navigator.clipboard.writeText(t); UI.aviso('Copiado. Cole no WhatsApp ou no documento.', 'ok'); }
    catch (e) { var s = window.getSelection(), r = document.createRange(), n = $('sci2-201'); if (n) { r.selectNodeContents(n); s.removeAllRanges(); s.addRange(r); } UI.aviso('Selecionei o texto: copie com Ctrl+C.', 'ok'); }
  }

  /* ---------- Páginas da próxima etapa: o que já existe no app, à mão ---------- */
  function proximaEtapa(texto) { return el('p', { classe: 'nota sci2-proxima', texto: 'Próxima etapa do SCI: ' + texto + ' Enquanto isso, o que o app já tem está abaixo.' }); }
  function cabSecao(c, olho, titulo, secao) {
    var r = D.responsavelSecao(c.org, secao);
    return el('div', { classe: 'sci2-cab' }, [el('small', { classe: 'sci2-olho', texto: olho + (r ? ' · ' + r.texto.toUpperCase() : '') }), el('h2', { texto: titulo })]);
  }
  function paginaEspera(c) {
    var eq = c.equipes;
    function linha(x, sub) { return el('li', { classe: 'sci2-linha' }, [el('i', { classe: 'sci2-cor', style: 'background:' + (x.grupo.cor || '#888') }), el('strong', { texto: x.grupo.nome }), el('span', { classe: 'muted', texto: sub }), botao('Abrir grupo', function () { Pn().abrirGrupos(x.grupo.id); })]); }
    return [cabSecao(c, 'SEÇÃO DE OPERAÇÕES · ÁREA DE ESPERA', 'Área de Espera', 'ops'),
      proximaEtapa('check-in de recursos, reserva mínima e designação direto daqui.'),
      el('div', { classe: 'sci2-kpis sci2-kpis-4' }, [kpi(eq.disponivel.length, 'equipes disponíveis', null, eq.disponivel.length ? 'verde' : 'laranja'), kpi(eq.descanso.length, 'em descanso'), kpi(eq.missao.length, 'em missão'), kpi(eq.indisponivel.length, 'indisponíveis')]),
      !eq.disponivel.length && c.grupos.length ? el('p', { classe: 'nota sci2-bloco-alerta', texto: 'Reserva abaixo do mínimo: nenhuma equipe disponível para substituição ou intervenção rápida.' }) : null,
      bloco('Prontas para designar', [eq.disponivel.length ? el('ul', { classe: 'sci2-lista' }, eq.disponivel.map(function (x) { return linha(x, 'disponível'); }).concat(eq.descanso.map(function (x) { return linha(x, 'em descanso'); })))
        : el('p', { classe: 'muted', texto: 'Nenhuma equipe disponível agora.' })], [botao('Grupos e disponibilidade', function () { Pn().abrirGrupos(); }), botao('Deslocamentos', function () { Pn().abrirMissoes(); })])];
  }
  function paginaRecursos(c) {
    var linhas = c.grupos.map(function (g) {
      var x = c.equipes.missao.filter(function (m) { return m.grupo.id === g.id; })[0];
      return el('tr', null, [g.nome, x ? 'em missão' : ({ em_descanso: 'em descanso', indisponivel: 'indisponível' })[g.disponibilidade] || 'disponível', x ? (x.missao.setor_nome || x.missao.nome) : '—',
        String(Pn().membros(g.id).length), x ? D.duracao(c.agora - Date.parse(x.missao.enviada_em)) : '—'].map(function (t) { return el('td', { texto: t }); }));
    });
    return [cabSecao(c, 'SEÇÃO DE PLANEJAMENTO · RECURSOS', 'Recursos e fatores humanos', 'plan'),
      proximaEtapa('horas no turno e descanso, água, alimentação, lesões e pedidos de recurso por equipe.'),
      bloco('Equipes', [linhas.length ? el('div', { classe: 'sci2-tabela-rol' }, [el('table', { classe: 'sci2-tabela' }, [el('thead', null, [el('tr', null, ['Equipe', 'Status', 'Setor / tarefa', 'Membros', 'No deslocamento há'].map(function (t) { return el('th', { texto: t }); }))]), el('tbody', null, linhas)])])
        : el('p', { classe: 'muted', texto: 'Nenhum grupo criado.' })], [botao('Grupos', function () { Pn().abrirGrupos(); }), window.RecursosEquipe ? botao('Recursos das equipes', function () { window.RecursosEquipe.abrir(); }) : null,
        botao('Equipe de responsáveis', function () { Pn().abrirEquipe(); }), pode() ? botao('Convidar', function () { Pn().abrirConvite(); }) : null]),
      bloco('Pessoas', [el('p', { classe: 'muted', texto: c.balanco.total + ' na operação · ' + c.balanco.emCampo + ' em campo · ' + c.balanco.militares + ' militares · ' + c.balanco.civis + ' civis' })])];
  }
  function paginaLogistica(c) {
    var cmd = c.estado.comando || {}, bases = Pn().pontosInteresse().filter(function (p) { return p.categoria === 'BASE'; });
    return [cabSecao(c, 'SEÇÃO DE LOGÍSTICA', 'Logística e materiais', 'log'),
      proximaEtapa('instalações, água, alimentação, combustível, energia, relação de materiais e pedidos de recurso.'),
      bloco('Instalações', [el('p', null, ['Posto de Comando: ', pend(cmd.pc_texto || (bases.filter(function (b) { return b.id === cmd.pc_ponto_id; })[0] || {}).titulo)]),
        el('p', null, ['Base: ', pend(cmd.base_texto || (bases.filter(function (b) { return b.id === cmd.base_ponto_id; })[0] || {}).titulo)]),
        bases.length ? el('p', { classe: 'muted', texto: 'Bases no mapa: ' + bases.map(function (b) { return b.titulo; }).join(', ') }) : null]),
      window.RecursosEquipe ? bloco('Recursos das equipes', [el('p', { classe: 'muted', texto: 'Embarcações, viaturas, drones e equipamentos cadastrados em cada equipe.' })], [botao('Abrir', function () { window.RecursosEquipe.abrir(); })]) : null];
  }
  function paginaAdmFin(c) {
    var ini = Date.parse(c.o.acionado_em || c.o.criada_em), fim = c.o.status === 'ativa' ? c.agora : Date.parse(c.o.encerrada_em || c.agora);
    return [cabSecao(c, 'SEÇÃO DE ADMINISTRAÇÃO E FINANÇAS', 'Tempo, provedoria e custos', 'adm'),
      proximaEtapa('homem-hora do pessoal, horas dos equipamentos, aquisições, contratos e custos.'),
      el('div', { classe: 'sci2-kpis sci2-kpis-4' }, [kpi(c.balanco.total, 'pessoas empregadas'), kpi(D.duracao(fim - ini), 'duração da ocorrência'), kpi(c.grupos.length, 'equipes'), kpi(c.balanco.militares, 'militares')])];
  }

  /* ---------- Estabelecer o SCI (primeira vez na operação) ---------- */
  function iniciarWizard() {
    var e = est.dados.estado || {}, cmd = e.comando || {};
    var bases = Pn().pontosInteresse().filter(function (p) { return p.categoria === 'BASE'; });
    est.wizard = {
      passo: 0,
      modalidade: cmd.modalidade || 'unico',
      instituicoes: (cmd.instituicoes && cmd.instituicoes.length ? cmd.instituicoes : ['CBMPR']).slice(),
      pc_ponto_id: cmd.pc_ponto_id || (bases[0] ? bases[0].id : ''), pc_texto: cmd.pc_texto || (bases[0] ? bases[0].titulo : ''),
      base_ponto_id: cmd.base_ponto_id || '', base_texto: cmd.base_texto || '',
      canal_comando: cmd.canal_comando || '', canal_tatico: cmd.canal_tatico || '',
      inicio: Date.now(), fim: Date.now() + 12 * 3600e3, objetivos: '',
    };
  }
  var PASSOS = ['Comando inicial', 'Informações iniciais', 'Setorização', '1º período operacional'];
  function paginaEstabelecer(c) {
    var w = est.wizard || (iniciarWizard(), est.wizard);
    var corpo = [cpasso0, cpasso1, cpasso2, cpasso3][w.passo](c, w);
    var passos = el('ol', { classe: 'sci2-passos' }, PASSOS.map(function (p, i) {
      return el('li', { classe: (i === w.passo ? 'atual' : i < w.passo ? 'feito' : '') }, [el('button', { type: 'button', texto: (i + 1) + ' · ' + p, onclick: function () { guardarPasso(); w.passo = i; render(true); } })]);
    }));
    var rod = el('div', { classe: 'sci2-wizard-rodape' }, [
      botao('Pular por enquanto', function () { guardarPasso(); ir('resumo'); }, 'btn-link', { id: 'sci2-w-pular', title: 'O que faltar aparece como pendência no Resumo' }),
      el('span', { classe: 'sci2-esp' }),
      w.passo > 0 ? botao('← Voltar', function () { guardarPasso(); w.passo--; render(true); }) : null,
      w.passo < PASSOS.length - 1 ? botao('Próximo: ' + PASSOS[w.passo + 1] + ' →', function () { guardarPasso(); w.passo++; render(true); }, 'btn-escuro', { id: 'sci2-w-proximo' })
        : botao('Estabelecer o SCI', concluirWizard, 'btn-primario', { id: 'sci2-w-concluir' }),
    ]);
    return [el('div', { classe: 'sci2-wizard' }, [
      el('small', { classe: 'sci2-olho', texto: c.o.codigo + ' · ESTABELECER O SCI' }),
      el('h2', { texto: 'Estabelecer o SCI' }),
      el('p', { classe: 'muted', texto: 'O local e os setores já vêm do mapa. Qualquer passo pode ficar para depois: o que faltar aparece como pendência no Resumo.' }),
      passos, el('div', { classe: 'sci2-wizard-corpo', id: 'sci2-wizard-corpo' }, corpo), rod,
    ])];
  }
  // lê os campos do passo atual para o rascunho (nada vai ao servidor antes de "Estabelecer o SCI", menos as informações)
  function guardarPasso() {
    var w = est.wizard;
    if (!w) return;
    function v(id) { var n = $(id); return n ? n.value : null; }
    if (w.passo === 0) {
      var m = document.querySelector('input[name="sci2-w-mod"]:checked'); if (m) w.modalidade = m.value;
      w.instituicoes = Array.prototype.map.call(document.querySelectorAll('.sci2-inst input:checked'), function (x) { return x.value; }).concat(w.instituicoes.filter(function (x) { return INSTITUICOES.indexOf(x) === -1 && (!$('sci2-w-inst-' + x)); }));
      ['pc_ponto_id', 'pc_texto', 'base_ponto_id', 'base_texto', 'canal_comando', 'canal_tatico'].forEach(function (k) { var x = v('sci2-w-' + k); if (x != null) w[k] = x; });
    } else if (w.passo === 3) {
      var i = v('sci2-w-ini'), f = v('sci2-w-fim'), o = v('sci2-w-obj');
      if (i) w.inicio = Date.parse(i); if (f) w.fim = Date.parse(f); if (o != null) w.objetivos = o;
    }
  }
  function selPonto(id, valor, rotuloVazio) {
    var pts = Pn().pontosInteresse().slice().sort(function (a, b) { return (a.categoria === 'BASE' ? 0 : 1) - (b.categoria === 'BASE' ? 0 : 1); });
    return el('select', { classe: 'campo', id: id }, [el('option', { value: '', texto: rotuloVazio })].concat(pts.map(function (p) {
      return el('option', { value: p.id, selected: valor === p.id ? true : null, texto: p.titulo + (p.categoria === 'BASE' ? ' (base)' : '') });
    })));
  }
  function cpasso0(c, w) {
    var inst = INSTITUICOES.concat(w.instituicoes.filter(function (x) { return INSTITUICOES.indexOf(x) === -1; }));
    var outra = el('input', { classe: 'campo', id: 'sci2-w-outra', maxlength: '60', placeholder: 'Outra instituição' });
    var pcSel = selPonto('sci2-w-pc_ponto_id', w.pc_ponto_id, '— sem ponto no mapa —');
    var pcTxt = el('input', { classe: 'campo', id: 'sci2-w-pc_texto', maxlength: '200', placeholder: 'Ex.: Viatura ABTR-12 na cabeceira da ponte', value: w.pc_texto });
    pcSel.addEventListener('change', function () { var p = Pn().pontosInteresse().filter(function (x) { return x.id === pcSel.value; })[0]; if (p && !pcTxt.value.trim()) pcTxt.value = p.titulo; });
    return [
      UI.secao('Comandante do Incidente', [el('div', { classe: 'sci2-ci-linha' }, [c.ci ? el('strong', { texto: c.ci }) : el('strong', { classe: 'sci2-pend', texto: P }),
        el('span', { classe: 'muted', texto: c.ci ? 'é quem está no comando da operação' + (c.ciDesde ? ' desde ' + D.horaCurta(c.ciDesde) : '') + '.' : 'ninguém assumiu o comando ainda.' }),
        window.Briefing ? botao(c.ci ? 'Passar o comando' : 'Assumir o comando', function () { guardarPasso(); window.Briefing.abrir(); }) : null])]),
      UI.secao('Modalidade de comando', [el('div', { classe: 'sci2-opcoes', role: 'radiogroup' }, [['unico', 'Comando único', 'Uma instituição comanda'], ['unificado', 'Comando unificado', 'Várias instituições decidem juntas']].map(function (o) {
        return el('label', { classe: 'sci2-opcao' }, [el('input', { type: 'radio', name: 'sci2-w-mod', value: o[0], checked: w.modalidade === o[0] ? true : null }), el('b', { texto: o[1] }), el('small', { texto: o[2] })]);
      }))]),
      UI.secao('Instituições', [el('div', { classe: 'sci2-inst' }, inst.map(function (x) {
        return el('label', { classe: 'sci2-chip-check' }, [el('input', { type: 'checkbox', id: 'sci2-w-inst-' + x, value: x, checked: w.instituicoes.indexOf(x) !== -1 ? true : null }), x]);
      }).concat([el('span', { classe: 'sci2-linha-campo' }, [outra, botao('+ Adicionar', function () { var t = outra.value.trim(); if (!t) return; guardarPasso(); if (w.instituicoes.indexOf(t) === -1) w.instituicoes.push(t); render(true); })])]))]),
      UI.secao('Instalações', [UI.grade([UI.campo('Posto de Comando (ponto do mapa)', pcSel, { para: 'sci2-w-pc_ponto_id' }), UI.campo('Posto de Comando (descrição)', pcTxt, { para: 'sci2-w-pc_texto' }),
        UI.campo('Base de Operações (ponto do mapa)', selPonto('sci2-w-base_ponto_id', w.base_ponto_id, '— sem ponto no mapa —'), { para: 'sci2-w-base_ponto_id', opcional: true }),
        UI.campo('Base de Operações (descrição)', el('input', { classe: 'campo', id: 'sci2-w-base_texto', maxlength: '200', value: w.base_texto }), { para: 'sci2-w-base_texto', opcional: true })])]),
      UI.secao('Comunicações', [UI.grade([UI.campo('Canal de comando', el('input', { classe: 'campo', id: 'sci2-w-canal_comando', maxlength: '80', placeholder: 'Ex.: Canal 1 – Comando', value: w.canal_comando }), { para: 'sci2-w-canal_comando', opcional: true }),
        UI.campo('Canal tático', el('input', { classe: 'campo', id: 'sci2-w-canal_tatico', maxlength: '80', placeholder: 'Ex.: Canal 3 – Equipes', value: w.canal_tatico }), { para: 'sci2-w-canal_tatico', opcional: true })])]),
    ];
  }
  function cpasso1() {
    return [el('p', { classe: 'muted', texto: 'Cada dado recebido da autoridade local, da central ou de testemunha nasce NÃO CONFIRMADO, com fonte e hora. A equipe confirma depois.' }),
      listaInformacoes(est.dados.informacoes), pode() ? botao('+ Informação recebida', novaInformacao, 'btn-escuro', { id: 'sci2-w-info' }) : null];
  }
  function cpasso2(c) {
    return [el('p', { classe: 'muted', texto: 'Os setores desenhados no mapa operacional já fazem parte do SCI. Para desenhar ou ajustar, use o modo Operação; o rascunho do SCI fica guardado.' }),
      c.setores.length ? el('ul', { classe: 'sci2-lista' }, c.setores.map(function (s) {
        return el('li', { classe: 'sci2-linha' }, [el('i', { classe: 'sci2-cor', style: 'background:' + (s.cor || '#66b2ff') }), el('strong', { texto: s.nome }), el('span', { classe: 'muted', texto: s.equipe || '' }), tag(({ concluido: 'concluído', andamento: 'em trabalho' })[s.status] || 'aberto', 'azul')]);
      })) : el('p', { classe: 'sci2-pend', texto: 'Nenhum setor ainda.' }),
      el('div', { classe: 'sci2-acoes-pagina' }, [botao('Ver no mapa', function () { guardarPasso(); ir('mapa'); }), botao('Desenhar no modo Operação', function () { guardarPasso(); sair(); })])];
  }
  function cpasso3(c, w) {
    var obj = el('textarea', { classe: 'campo', id: 'sci2-w-obj', rows: '5', placeholder: 'Um objetivo por linha. Ex.:\nVarrer os setores 1 e 2 até 18h\nLeitura do nível do rio a cada 30 min' });
    obj.value = w.objetivos;
    var ja = est.dados.periodos.length;
    return [ja ? el('p', { classe: 'nota', texto: 'Esta operação já tem ' + ja + ' período(s) definido(s). Ajuste em Operações › Visão geral e períodos.' }) :
      el('p', { classe: 'muted', texto: 'Início, fim e objetivos do primeiro período (SCI 202). Pode ficar para depois.' }),
    ja ? null : UI.grade([UI.campo('Início', el('input', { classe: 'campo', id: 'sci2-w-ini', type: 'datetime-local', value: dataLocal(w.inicio) }), { para: 'sci2-w-ini' }),
      UI.campo('Fim', el('input', { classe: 'campo', id: 'sci2-w-fim', type: 'datetime-local', value: dataLocal(w.fim) }), { para: 'sci2-w-fim' })]),
    ja ? null : UI.campo('Objetivos do período', obj, { para: 'sci2-w-obj', largo: true, opcional: true })];
  }
  async function concluirWizard() {
    guardarPasso();
    var w = est.wizard, cmd = { modalidade: w.modalidade, instituicoes: w.instituicoes, pc_ponto_id: w.pc_ponto_id || null, pc_texto: w.pc_texto, base_ponto_id: w.base_ponto_id || null,
      base_texto: w.base_texto, canal_comando: w.canal_comando, canal_tatico: w.canal_tatico };
    var b = $('sci2-w-concluir'); if (b) b.disabled = true;
    try {
      await C.rpc('sci2_salvar_estado', { p_operacao: op().id, p_dados: { comando: cmd, estabelecer: true } });
      if (!est.dados.periodos.length && (w.objetivos.trim() || w.fim > w.inicio)) {
        var lista = w.objetivos.split('\n').map(function (t) { return t.trim(); }).filter(Boolean).slice(0, 20).map(function (t) { return { texto: t.slice(0, 300), estado: 'pendente' }; });
        await C.rpc('sci2_periodo', { p_operacao: op().id, p_id: null, p_dados: { inicio: new Date(w.inicio).toISOString(), fim: new Date(w.fim).toISOString(), objetivos: lista } });
      }
      UI.aviso('SCI estabelecido.', 'ok');
      est.wizard = null;
      await carregar();
      ir('resumo');
    } catch (e) {
      UI.aviso(e.message, 'erro', 8000);
      if (b) b.disabled = false;
    }
  }

  /* ---------- Seletor do painel ---------- */
  function ligarSeletor() {
    var a = $('modo-operacao'), b = $('modo-sci');
    if (a) a.addEventListener('click', function () { sair(); });
    if (b) b.addEventListener('click', function () { entrar(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ligarSeletor); else ligarSeletor();

  window.SciModo = { entrar: entrar, sair: sair, ativo: function () { return est.ativo; } };
})();
