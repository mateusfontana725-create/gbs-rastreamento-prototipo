/* =====================================================================
 * briefing.js — briefing da operação e passagem de comando (migração 037)
 *   - O briefing é uma página curta montada pelo SERVIDOR com o que já está cadastrado (briefing_operacao_dados):
 *     objetivo, último local visto, hipóteses, riscos, equipes, tarefas, comunicações e decisões pendentes.
 *     O que não existe em outro lugar (objetivo, riscos, comunicações, observações e decisões a tomar) é escrito aqui.
 *   - Passagem de comando: quem comanda escolhe outro responsável; o servidor guarda uma FOTO do briefing naquele
 *     momento; quem recebe lê a foto e ACEITA (o comando só muda no aceite, com a hora) ou recusa com motivo.
 *     Se o comandante não responde, outro responsável pode ASSUMIR o comando com motivo obrigatório.
 *   Usa a interface window.Painel (militar.js).
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI, P = window.Painel;
  if (!C || !UI || !P) return;
  var el = UI.el;

  var DISP = { disponivel: 'Disponível', em_descanso: 'Em descanso', indisponivel: 'Indisponível', em_missao: 'Em missão' };
  var TIPOS_REC = { embarcacao: '⛵ Embarcação', viatura: '🚒 Viatura', drone: '🛸 Drone', cao_busca: '🐕 Cão de busca', comunicacao: '📻 Comunicação', primeiros_socorros: '⛑ Primeiros socorros', outro: '▪ Outro' };
  var STATUS_MISSAO = { enviada: 'enviada', em_deslocamento: 'em deslocamento', no_setor: 'no setor', busca_finalizada: 'busca finalizada', retorno_atrasado: 'RETORNO ATRASADO' };
  var ESTADOS_PASSAGEM = { pendente: 'aguardando aceite', aceita: 'aceita', recusada: 'recusada', cancelada: 'cancelada', assumida: 'comando assumido sem aceite' };

  var est = { opId: null, comando: null, passagens: [], ausente: false, erro: null, canal: null, timer: null, timerCanal: null,
    renderAtual: null, avisadas: {}, dados: null, ouvintes: [] };

  /* ---------- Dados ------------------------------------------------------ */
  function eu() { return P.usuario && P.usuario() && P.usuario().id; }
  function podeAlterar() { return Boolean(P.podeAlterar && P.podeAlterar()); }
  function sou_comandante() { return Boolean(est.comando && est.comando.comando_user_id && est.comando.comando_user_id === eu()); }
  function pendente() { return est.passagens.find(function (p) { return p.estado === 'pendente'; }) || null; }

  async function carregar() {
    var op = P.op();
    if (!op || est.ausente) return;
    var opId = op.id;
    try {
      var r = await Promise.all([
        C.consultar(C.cliente.from('passagens_comando').select('*').eq('operacao_id', opId).order('criada_em', { ascending: false })),
        C.consultar(C.cliente.from('operacoes').select('id,comando_user_id,comando_nome,comando_desde').eq('id', opId).maybeSingle()),
      ]);
      if (!P.op() || P.op().id !== opId) return;
      est.passagens = r[0] || [];
      est.comando = r[1] || null;
      est.erro = null;
    } catch (e) {
      var t = String(e.original && (e.original.message || e.original.details) || e.message);
      if (/passagens_comando|comando_user_id|briefing/.test(t) || e.codigo === 'funcao_ausente') est.ausente = true;
      est.erro = e.message;
    }
    atualizarChip();
    avisarPassagemPendente();
    if (est.renderAtual) est.renderAtual();
    est.ouvintes.forEach(function (f) { try { f(); } catch (e) { /* ignora */ } });
  }

  function agendar() { clearTimeout(est.timer); est.timer = setTimeout(carregar, 400); }

  function iniciar() {
    parar();
    var op = P.op();
    if (!op) return;
    est.opId = op.id;
    var carga = carregar();
    try {
      est.canal = C.cliente.channel('op-briefing-' + op.id + '-' + Date.now());
      [['passagens_comando', 'operacao_id=eq.' + op.id], ['decisoes_pendentes', 'operacao_id=eq.' + op.id], ['briefing_operacao', 'operacao_id=eq.' + op.id], ['operacoes', 'id=eq.' + op.id]].forEach(function (t) {
        est.canal.on('postgres_changes', { event: '*', schema: 'public', table: t[0], filter: t[1] }, agendar);
      });
      est.canal.subscribe(function (status) {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(est.timerCanal);
          est.timerCanal = setTimeout(function () { var o = P.op(); if (o && o.id === op.id) { carregar(); iniciar(); } }, 60000);
        }
      });
    } catch (e) { /* sem tempo real: recarrega ao abrir */ }
    return carga;
  }

  function parar() {
    clearTimeout(est.timer); clearTimeout(est.timerCanal);
    if (est.canal) { try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ } }
    est.canal = null; est.opId = null; est.comando = null; est.passagens = []; est.ausente = false; est.erro = null; est.renderAtual = null; est.dados = null; est.avisadas = {};
    atualizarChip();
  }

  /* ---------- Chip do comando no topo ------------------------------------ */
  function atualizarChip() {
    var chip = document.getElementById('comando-chip');
    if (!chip) return;
    var pend = pendente();
    var paraMim = pend && pend.para_user_id === eu();
    if (est.ausente || !est.comando || !est.comando.comando_nome) { chip.hidden = true; return; }
    chip.hidden = false;
    chip.classList.toggle('comando-pendente', Boolean(paraMim));
    chip.textContent = paraMim ? '⚠ Passagem de comando aguardando o seu aceite' : '★ Comando: ' + est.comando.comando_nome + (est.comando.comando_desde ? ' (desde ' + C.hora(est.comando.comando_desde, false) + ')' : '');
    chip.title = paraMim ? 'Toque para ler o briefing e aceitar' : 'Abrir o briefing e a passagem de comando';
  }

  // Passagem que chegou para mim: abre sozinha uma vez (e fica no chip enquanto não for respondida)
  function avisarPassagemPendente() {
    var pend = pendente();
    if (!pend || pend.para_user_id !== eu() || est.avisadas[pend.id] || !podeAlterar()) return;
    est.avisadas[pend.id] = true;
    abrirRecebimento(pend);
  }

  /* ---------- Formatação ------------------------------------------------- */
  function hora(v) { return v ? C.hora(v, false) : '—'; }
  function coord(l) { return Number(l.lat).toFixed(5) + ', ' + Number(l.lng).toFixed(5); }
  // Cartão do briefing: título pequeno (com contagem opcional) e conteúdo
  function secao(titulo, filhos, o) {
    o = o || {};
    return el('section', { classe: 'secao-form briefing-sec' + (o.largo ? ' briefing-largo' : '') + (o.alerta ? ' briefing-sec-alerta' : ''), 'aria-label': titulo }, [
      el('div', { classe: 'secao-titulo' }, [titulo, o.n != null ? el('span', { classe: 'briefing-n', texto: String(o.n) }) : null]),
    ].concat(filhos));
  }
  function vazio(t) { return el('p', { classe: 'briefing-vazio', texto: t }); }
  function lista(itens, vazioTxt) {
    return itens.length ? el('ul', { classe: 'briefing-lista' }, itens) : (vazioTxt ? vazio(vazioTxt) : null);
  }
  function sub(t) { return t ? el('div', { classe: 'briefing-sub', texto: t }) : null; }
  function pct(v) { return (Number(v) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%'; }

  /*
   * Desenha o briefing a partir do JSON do servidor (d). congelado = foto de uma passagem (sem botões que agem).
   * acoes: { editar, novaDecisao, resolverDecisao(id), abrirPedido(ref), abrirCenario(vitima) }
   */
  function renderizar(d, acoes, congelado) {
    var o = d.operacao;
    var partes = [];
    partes.push(el('div', { classe: 'resumo-op briefing-cab' }, [
      el('div', { classe: 'resumo-op-nome' }, [
        el('strong', { texto: o.codigo }),
        el('span', { texto: [o.tipo, o.acionado_em ? 'acionada ' + C.hora(o.acionado_em, false) : '', o.local].filter(Boolean).join(' · ') }),
      ]),
      el('div', { classe: 'resumo-op-selos' }, [
        el('span', { classe: 'briefing-comando' }, ['★ ', el('strong', { texto: d.comando && d.comando.nome ? d.comando.nome : '—' }), d.comando && d.comando.desde ? ' desde ' + hora(d.comando.desde) : '']),
        congelado ? el('span', { classe: 'selo selo-neutro', texto: 'foto de ' + C.hora(d.gerado_em, false) }) : null,
      ]),
    ]));

    // 1. objetivo
    var obj = d.objetivo.texto || '';
    partes.push(secao('Objetivo', [
      obj ? el('p', { classe: 'briefing-objetivo', texto: obj })
        : (d.objetivo.sugerido ? el('p', { classe: 'briefing-vazio', texto: 'Sem objetivo escrito. Da ocorrência: ' + d.objetivo.sugerido }) : vazio('Não definido.')),
      d.observacoes ? sub('Observações: ' + d.observacoes) : null,
    ], { largo: true }));

    var grade = [];
    // 2. vítimas e último local visto
    var vit = d.vitimas.map(function (v) {
      return el('li', null, [
        el('div', { classe: 'briefing-linha' }, [el('strong', { texto: v.nome + (v.idade != null ? ', ' + v.idade + ' anos' + (v.idade_qualidade === 'estimada' ? ' (estimada)' : '') : '') }),
          v.localizada ? el('span', { classe: 'selo selo-ok', texto: 'LOCALIZADA · ' + (v.localizada.condicao === 'obito' ? 'óbito' : 'com vida') + ' ' + hora(v.localizada.em) }) : null]),
        sub([v.perfil && v.perfil.length ? v.perfil.join(', ') : '', v.caracteristicas, v.roupas].filter(Boolean).join(' · ')),
      ]);
    });
    var ult = d.ultimo_local_visto.map(function (l) {
      return el('li', null, [
        el('div', { classe: 'briefing-linha' }, [el('strong', { texto: '📍 ' + l.titulo }),
          !congelado && P.irPara ? el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Ver no mapa', onclick: function () { UI.fecharTodos(); P.irPara(l.lat, l.lng); } }) : null]),
        sub((l.categoria === 'ULTIMA_LOCALIZACAO' ? 'última localização' : 'possível localização') + ' · ' + coord(l) + (l.descricao ? ' · ' + l.descricao : '')),
      ]);
    });
    grade.push(secao('Vítimas e último local visto', [lista(vit, 'Nenhuma vítima cadastrada.'), lista(ult, 'Último local visto não marcado.')], { n: d.vitimas.length }));

    // 3. hipóteses
    grade.push(secao('Hipóteses', [lista(d.hipoteses.map(function (h) {
      return el('li', null, [
        el('div', { classe: 'briefing-linha' }, [el('strong', { texto: h.vitima }), el('span', { classe: 'briefing-meta', texto: 'v' + h.versao + ' · ref. ' + hora(h.horario_referencia) + (h.confianca ? ' · ' + h.confianca : '') }),
          !congelado && acoes && acoes.abrirCenario ? el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'POA/POD', onclick: function () { acoes.abrirCenario(); } }) : null]),
        el('div', { texto: h.hipoteses || h.justificativa || '—' }),
        h.limitacoes ? sub('Limitações: ' + h.limitacoes) : null,
        h.setores && h.setores.length ? el('div', { classe: 'briefing-chips' }, h.setores.map(function (x) { return el('span', { classe: 'briefing-chip', texto: x.nome + ' ' + pct(x.poa) }); })) : null,
        h.rascunho_aberto ? sub('Rascunho de nova versão aguardando aprovação.') : null,
      ]);
    }), 'Nenhum cenário (POA) publicado.')]));

    // 4. riscos
    var r = d.riscos;
    var alertasRisco = [
      r.pedidos_ajuda_abertos ? el('p', { classe: 'briefing-alerta', texto: '🆘 ' + r.pedidos_ajuda_abertos + ' pedido(s) de ajuda aberto(s)' }) : null,
      r.alertas_criticos_sem_ciente ? el('p', { classe: 'briefing-alerta', texto: '⚠ ' + r.alertas_criticos_sem_ciente + ' alerta(s) crítico(s) sem ciente' }) : null,
    ];
    grade.push(secao('Riscos', [
      r.texto ? el('p', { classe: 'briefing-texto', texto: r.texto }) : null,
      lista(r.pontos.map(function (x) { return el('li', null, [el('strong', { texto: '⚠ ' + x.titulo }), sub(x.descricao)]); }), r.texto ? '' : 'Nenhum risco informado.'),
    ].concat(alertasRisco), { alerta: Boolean(r.pedidos_ajuda_abertos || r.alertas_criticos_sem_ciente) }));

    // 5. equipes
    grade.push(secao('Equipes', [lista(d.equipes.map(function (g) {
      var avisos = [g.sem_comunicacao && g.recursos.length ? 'sem comunicação' : null, g.sem_primeiros_socorros && g.recursos.length ? 'sem primeiros socorros' : null].filter(Boolean);
      return el('li', null, [
        el('div', { classe: 'briefing-linha' }, [el('strong', { texto: g.nome }),
          el('span', { classe: 'selo recurso-disp recurso-disp-' + g.disponibilidade_efetiva, texto: DISP[g.disponibilidade_efetiva] || g.disponibilidade_efetiva }),
          el('span', { classe: 'briefing-meta', texto: g.conectados + '/' + g.membros + ' conectados' })]),
        sub([g.disponibilidade_obs && g.disponibilidade_efetiva !== 'disponivel' ? g.disponibilidade_obs : '', g.disponivel_em && g.disponibilidade !== 'disponivel' ? 'volta às ' + hora(g.disponivel_em) : '', g.capacidades].filter(Boolean).join(' · ')),
        sub(g.recursos.length ? g.recursos.map(function (x) { return (TIPOS_REC[x.tipo] || x.tipo) + (x.identificacao ? ' ' + x.identificacao : '') + (x.quantidade > 1 ? ' ×' + x.quantidade : '') + (x.situacao !== 'operacional' ? ' (' + x.situacao + ')' : ''); }).join(' · ') : 'Recursos não informados'),
        avisos.length ? el('div', { classe: 'briefing-alerta', texto: '⚠ ' + avisos.join(' · ') }) : null,
      ]);
    }), 'Nenhuma equipe criada.')], { n: d.equipes.length }));

    // 6. tarefas
    var s = d.tarefas.setores;
    grade.push(secao('Tarefas', [
      el('dl', { classe: 'kv-grade briefing-setores' }, [['Concluídos', s.concluido], ['Em andamento', s.andamento], ['Pendentes', s.pendente]].map(function (x) {
        return el('div', { classe: 'kv kv-num' }, [el('dt', { texto: x[0] }), el('dd', { texto: String(x[1]) })]);
      })),
      s.pendentes && s.pendentes.length ? sub('Faltam: ' + s.pendentes.join(', ')) : null,
      lista(d.tarefas.deslocamentos.map(function (m) {
        return el('li', null, [el('div', { classe: 'briefing-linha' }, [el('strong', { texto: m.grupo + ' → ' + (m.setor || m.nome) }),
          el('span', { classe: 'briefing-meta', texto: (STATUS_MISSAO[m.status] || m.status) + (m.prazo_retorno_em ? ' · volta até ' + hora(m.prazo_retorno_em) : '') })])]);
      }), 'Nenhum deslocamento em andamento.'),
    ]));

    // 7. comunicações
    var c = d.comunicacoes;
    grade.push(secao('Comunicações', [
      c.texto ? el('p', { classe: 'briefing-texto', texto: c.texto }) : vazio('Canais e contatos não informados.'),
      c.dados.sem_comunicacao && c.dados.sem_comunicacao.length ? el('p', { classe: 'briefing-alerta', texto: '📵 ' + c.dados.sem_comunicacao.join(' · ') }) : null,
      c.dados.mensagens_sem_confirmacao ? sub(c.dados.mensagens_sem_confirmacao + ' mensagem(ns) sem confirmação') : null,
      c.dados.ultimas && c.dados.ultimas.length ? lista(c.dados.ultimas.map(function (m) {
        return el('li', null, [el('div', { classe: 'briefing-linha' }, [el('strong', { texto: m.de }), el('span', { classe: 'briefing-meta', texto: hora(m.em) + (m.categoria ? ' · ' + m.categoria : '') })]), el('div', { texto: m.texto })]);
      }), '') : null,
    ]));

    // 8. decisões pendentes
    var dec = d.decisoes_pendentes.map(function (x) {
      return el('li', null, [el('div', { classe: 'briefing-linha' }, [el('strong', { texto: x.texto }),
        !congelado && acoes && acoes.resolverDecisao ? el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Decidir', onclick: function () { acoes.resolverDecisao(x); } }) : null]),
        sub([x.responsavel ? 'quem decide: ' + x.responsavel : '', x.prazo ? 'até ' + hora(x.prazo) : ''].filter(Boolean).join(' · '))]);
    });
    var auto = d.decisoes_automaticas.map(function (x) {
      return el('li', null, [el('div', { classe: 'briefing-linha' }, [el('span', { texto: '⏳ ' + x.texto }),
        !congelado && acoes && acoes.abrirReferencia ? el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Abrir', onclick: function () { acoes.abrirReferencia(x.ref); } }) : null])]);
    });
    var decisoes = secao('Decisões pendentes', [
      lista(dec.concat(auto), 'Nenhuma decisão pendente.'),
      !congelado && acoes && acoes.novaDecisao && podeAlterar() ? el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'briefing-nova-decisao', texto: '+ Nova decisão', onclick: function () { acoes.novaDecisao(); } }) : null,
    ], { largo: true, n: dec.length + auto.length });

    partes.push(el('div', { classe: 'briefing-grade' }, grade));
    partes.push(decisoes);
    return el('div', { classe: 'briefing-corpo' }, partes);
  }

  // Texto puro (para copiar e passar por rádio, mensagem ou papel)
  function textoPuro(d) {
    var l = [];
    l.push('BRIEFING — ' + d.operacao.codigo + ' (' + C.hora(d.gerado_em, false) + ')');
    l.push('Comando: ' + (d.comando && d.comando.nome || '—'));
    l.push('OBJETIVO: ' + (d.objetivo.texto || d.objetivo.sugerido || 'não definido'));
    l.push('VÍTIMAS: ' + (d.vitimas.map(function (v) { return v.nome + (v.idade != null ? ' (' + (v.idade_qualidade === 'estimada' ? '~' : '') + v.idade + ')' : '') + (v.localizada ? ' [LOCALIZADA]' : ''); }).join('; ') || '—'));
    l.push('ÚLTIMO LOCAL VISTO: ' + (d.ultimo_local_visto.map(function (x) { return x.titulo + ' ' + coord(x); }).join('; ') || '—'));
    l.push('HIPÓTESES: ' + (d.hipoteses.map(function (h) { return h.vitima + ': ' + (h.hipoteses || h.justificativa || '—') + ' [' + h.setores.map(function (s) { return s.nome + ' ' + pct(s.poa); }).join(', ') + ']'; }).join(' | ') || 'sem cenário aprovado'));
    l.push('RISCOS: ' + ([d.riscos.texto].concat(d.riscos.pontos.map(function (p) { return p.titulo; })).filter(Boolean).join('; ') || '—') + (d.riscos.pedidos_ajuda_abertos ? ' | ' + d.riscos.pedidos_ajuda_abertos + ' pedido(s) de ajuda aberto(s)' : ''));
    l.push('EQUIPES: ' + (d.equipes.map(function (g) { return g.nome + ' (' + (DISP[g.disponibilidade_efetiva] || g.disponibilidade_efetiva) + (g.recursos.length ? '; ' + g.recursos.map(function (r) { return (TIPOS_REC[r.tipo] || r.tipo).replace(/^\S+ /, '') + (r.identificacao ? ' ' + r.identificacao : ''); }).join(', ') : '') + ')'; }).join('; ') || '—'));
    l.push('TAREFAS: ' + (d.tarefas.deslocamentos.map(function (m) { return m.grupo + ' → ' + (m.setor || m.nome) + ' (' + (STATUS_MISSAO[m.status] || m.status) + ')'; }).join('; ') || 'sem deslocamento') + ' | Setores pendentes: ' + ((d.tarefas.setores.pendentes || []).join(', ') || 'nenhum'));
    l.push('COMUNICAÇÕES: ' + (d.comunicacoes.texto || '—'));
    l.push('DECISÕES PENDENTES: ' + (d.decisoes_pendentes.map(function (x) { return x.texto; }).concat(d.decisoes_automaticas.map(function (x) { return x.texto; })).join('; ') || 'nenhuma'));
    return l.join('\n');
  }

  /* ---------- Ações ------------------------------------------------------ */
  async function rpc(nome, args, ok) {
    try { var r = await C.rpc(nome, args); if (ok) UI.aviso(ok, 'ok'); await carregar(); return r; } catch (e) { UI.aviso(e.message, 'erro', 8000); return null; }
  }

  function abrirEdicao(d, aposSalvar) {
    var f = {
      objetivo: el('textarea', { classe: 'campo', id: 'brief-objetivo', rows: '3', maxlength: '1000', placeholder: 'O que esta operação precisa alcançar (ex.: localizar o Sr. Antônio com vida)' }),
      riscos: el('textarea', { classe: 'campo', id: 'brief-riscos', rows: '3', maxlength: '1000', placeholder: 'Riscos além dos pontos de risco do mapa (clima, terreno, segurança)' }),
      comunicacoes: el('textarea', { classe: 'campo', id: 'brief-com', rows: '3', maxlength: '1000', placeholder: 'Canais, frequências, contatos do posto de comando, horários de reporte' }),
      observacoes: el('textarea', { classe: 'campo', id: 'brief-obs', rows: '2', maxlength: '1000', placeholder: 'Outras informações importantes para quem assume' }),
    };
    f.objetivo.value = d.objetivo.texto || d.objetivo.sugerido || '';
    f.riscos.value = d.riscos.texto || ''; f.comunicacoes.value = d.comunicacoes.texto || ''; f.observacoes.value = d.observacoes || '';
    var erro = el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = el('button', { classe: 'btn btn-escuro', type: 'button', id: 'brief-salvar', texto: 'Salvar' });
    btn.addEventListener('click', async function () {
      erro.hidden = true; btn.disabled = true;
      try {
        await C.rpc('salvar_briefing', { p_operacao: P.op().id, p_dados: { objetivo: f.objetivo.value, riscos: f.riscos.value, comunicacoes: f.comunicacoes.value, observacoes: f.observacoes.value } });
        UI.aviso('Briefing atualizado.', 'ok'); fechar(true); if (aposSalvar) aposSalvar();
      } catch (e) { erro.textContent = e.message; erro.hidden = false; btn.disabled = false; }
    });
    var fechar = UI.abrirModal(el('div', { classe: 'form-briefing' }, [
      el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, ['Textos do briefing', UI.dica('Vítimas, equipes, hipóteses e decisões vêm do cadastro: só digite o que não existe em outro lugar.')]),
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'brief-objetivo', texto: 'Objetivo' }), f.objetivo]),
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'brief-riscos', texto: 'Riscos' }), f.riscos]),
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'brief-com', texto: 'Comunicações' }), f.comunicacoes]),
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'brief-obs', texto: 'Observações' }), f.observacoes]),
      erro,
      UI.rodape([el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]), { fecharNoFundo: false, empilhar: true });
  }

  async function novaDecisao(aposSalvar) {
    var resp = el('input', { classe: 'campo', id: 'dec-resp', maxlength: '60', placeholder: 'Quem decide (opcional)' });
    var prazo = el('input', { classe: 'campo', id: 'dec-prazo', type: 'datetime-local' });
    var r = await UI.confirmar({
      titulo: 'Nova decisão a tomar', texto: 'Anote o que precisa ser decidido. Aparece no briefing até alguém decidir ou cancelar.',
      detalhe: el('div', null, [el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'dec-resp', texto: 'Quem decide' }), resp]), el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'dec-prazo', texto: 'Prazo (opcional)' }), prazo])]),
      campo: { rotulo: 'O que precisa ser decidido (mín. 3 caracteres)', max: 300, obrigatorio: true }, ok: 'Registrar', empilhar: true,
    });
    if (!r) return;
    var ms = prazo.value ? new Date(prazo.value).getTime() : null;
    await rpc('decisao_criar', { p_operacao: P.op().id, p_dados: { texto: r.texto, responsavel: resp.value.trim(), prazo: ms != null && !isNaN(ms) ? new Date(ms).toISOString() : null } }, 'Decisão registrada.');
    if (aposSalvar) aposSalvar();
  }

  async function resolverDecisao(x, aposSalvar) {
    var estado = el('select', { classe: 'campo', id: 'dec-estado' }, [el('option', { value: 'decidida', texto: 'Decidida' }), el('option', { value: 'cancelada', texto: 'Cancelada (não será mais necessário)' })]);
    var r = await UI.confirmar({
      titulo: 'Decisão: ' + x.texto, texto: 'Registre o que foi decidido (ou por que foi cancelada). Fica no diário.',
      detalhe: el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'dec-estado', texto: 'Situação' }), estado]),
      campo: { rotulo: 'O que foi decidido', max: 500, obrigatorio: true }, ok: 'Registrar', empilhar: true,
    });
    if (!r) return;
    await rpc('decisao_resolver', { p_decisao: x.id, p_estado: estado.value, p_texto: r.texto }, 'Decisão registrada.');
    if (aposSalvar) aposSalvar();
  }

  // Explicação curta atrás de um (i): passa o mouse (title) ou toca para abrir embaixo
  function dica(texto) {
    var tip = el('span', { classe: 'dica-texto', role: 'note', hidden: true, texto: texto });
    var b = el('button', { classe: 'dica', type: 'button', 'aria-label': 'Explicação', title: texto, texto: 'i' });
    b.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); tip.hidden = !tip.hidden; });
    return el('span', { classe: 'dica-caixa' }, [b, tip]);
  }
  function pessoa(rotulo, conteudo, extra) {
    return el('div', { classe: 'passagem-pessoa' + (extra ? ' ' + extra : '') }, [el('small', { classe: 'passagem-rotulo', texto: rotulo }), conteudo]);
  }

  async function abrirPassagem(aposSalvar) {
    var sel = el('select', { classe: 'campo', id: 'pas-para', 'aria-label': 'Passar o comando para' }, [el('option', { value: '', texto: 'Carregando…' })]);
    var nota = el('textarea', { classe: 'campo', id: 'pas-nota', rows: '3', maxlength: '1000', placeholder: 'O que quem assume precisa saber agora' });
    var erro = el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = el('button', { classe: 'btn btn-escuro', type: 'button', id: 'pas-enviar', texto: 'Passar o comando', disabled: true });
    var atual = est.comando && est.comando.comando_nome || '—';
    var fechar = UI.abrirModal(el('div', { classe: 'passagem-form' }, [
      el('h2', { id: 'modal-titulo', classe: 'passagem-titulo' }, ['Passar o comando', dica('O servidor guarda uma foto do briefing de agora e a outra pessoa a lê. O comando só muda quando ela ACEITAR (com a hora do aceite). Até lá, você continua no comando.')]),
      el('div', { classe: 'passagem-grade' }, [
        el('div', { classe: 'passagem-fluxo' }, [
          pessoa('Agora', el('strong', { texto: atual })),
          el('span', { classe: 'passagem-seta', 'aria-hidden': 'true', texto: '→' }),
          pessoa('Passa para', sel, 'passagem-pessoa-sel'),
        ]),
        el('div', { classe: 'passagem-recado' }, [
          el('label', { classe: 'rotulo', for: 'pas-nota' }, ['Recado', dica('Opcional. O briefing completo já vai junto, sem precisar digitar de novo.')]),
          nota,
        ]),
      ]),
      erro,
      el('div', { classe: 'passagem-rodape' }, [
        el('span', { classe: 'muted passagem-aviso', texto: 'Você segue no comando até o aceite.' }),
        el('div', { classe: 'passagem-botoes' }, [el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
      ]),
    ]), { fecharNoFundo: false, empilhar: true });
    try {
      var rs = await C.rpc('listar_responsaveis', { p_operacao: P.op().id });
      var outros = (rs || []).filter(function (r) { return r.user_id !== eu(); });
      sel.innerHTML = '';
      sel.appendChild(el('option', { value: '', texto: outros.length ? 'Escolha…' : 'Nenhum outro responsável' }));
      outros.forEach(function (r) { sel.appendChild(el('option', { value: r.user_id, texto: r.nome })); });
      btn.disabled = !outros.length;
    } catch (e) { erro.textContent = e.message; erro.hidden = false; }
    btn.addEventListener('click', async function () {
      erro.hidden = true;
      if (!sel.value) { erro.textContent = 'Escolha quem vai receber o comando.'; erro.hidden = false; return; }
      btn.disabled = true;
      try {
        await C.rpc('passagem_iniciar', { p_operacao: P.op().id, p_para: sel.value, p_nota: nota.value.trim() });
        UI.aviso('Passagem enviada. O comando muda quando ' + sel.options[sel.selectedIndex].text + ' aceitar.', 'ok');
        fechar(true); await carregar(); if (aposSalvar) aposSalvar();
      } catch (e) { erro.textContent = e.message; erro.hidden = false; btn.disabled = false; }
    });
  }

  function abrirRecebimento(pas) {
    var corpo = el('div', { classe: 'passagem-recebimento' });
    var fechar;
    var pendente = pas.estado === 'pendente' && pas.para_user_id === eu();
    var r = pas.resumo || {};
    var contagem = [
      (r.vitimas || []).length + ' vítima(s)', (r.equipes || []).length + ' equipe(s)',
      ((r.decisoes_pendentes || []).length + (r.decisoes_automaticas || []).length) + ' decisão(ões) pendente(s)',
      r.riscos && r.riscos.pedidos_ajuda_abertos ? r.riscos.pedidos_ajuda_abertos + ' pedido(s) de ajuda aberto(s)' : null,
    ].filter(Boolean);
    corpo.appendChild(el('h2', { id: 'modal-titulo', classe: 'passagem-titulo' }, [pendente ? 'Receber o comando' : 'Passagem de comando',
      pendente ? dica('O comando só muda quando você aceitar, e o horário do aceite fica registrado. Se recusar, quem passou continua no comando e vê o seu motivo.') : null]));
    corpo.appendChild(el('div', { classe: 'passagem-fluxo passagem-fluxo-leitura' }, [
      pessoa('De', el('strong', { texto: pas.de_nome || '—' })), el('span', { classe: 'passagem-seta', 'aria-hidden': 'true', texto: '→' }),
      pessoa(pendente ? 'Para você' : 'Para', el('strong', { texto: pas.para_nome || '—' })),
      el('span', { classe: 'selo selo-neutro', texto: C.hora(pas.criada_em, false) }),
    ]));
    if (pas.nota) corpo.appendChild(el('blockquote', { classe: 'passagem-nota' }, [el('strong', { texto: 'Recado de ' + pas.de_nome + ': ' }), pas.nota]));
    corpo.appendChild(el('details', { classe: 'passagem-briefing' }, [
      el('summary', null, [el('strong', { texto: 'Briefing do momento' }), el('span', { classe: 'muted', texto: ' · ' + contagem.join(' · ') })]),
      renderizar(pas.resumo, null, true),
    ]));
    var acoes = [el('button', { classe: 'btn', type: 'button', texto: 'Ler depois', onclick: function () { fechar(); } })];
    if (podeAlterar() && pas.estado === 'pendente' && pas.para_user_id === eu()) {
      acoes.push(el('button', { classe: 'btn btn-perigo', type: 'button', id: 'pas-recusar', texto: 'Recusar…', onclick: async function () {
        var r = await UI.confirmar({ titulo: 'Recusar o comando?', texto: 'Diga o motivo: quem passou o comando vê a sua resposta e continua no comando.', campo: { rotulo: 'Motivo (obrigatório)', max: 500, obrigatorio: true }, ok: 'Recusar', perigo: true, empilhar: true });
        if (!r) return;
        if (await rpc('passagem_responder', { p_passagem: pas.id, p_aceitar: false, p_nota: r.texto }, 'Passagem recusada.')) fechar(true);
      } }));
      acoes.push(el('button', { classe: 'btn btn-escuro', type: 'button', id: 'pas-aceitar', texto: 'Aceitar o comando', onclick: async function () {
        if (await rpc('passagem_responder', { p_passagem: pas.id, p_aceitar: true, p_nota: '' }, 'Você está no comando.')) fechar(true);
      } }));
    }
    corpo.appendChild(el('div', { classe: 'modal-acoes' }, acoes));
    fechar = UI.abrirModal(corpo, { fecharNoFundo: false, empilhar: true });
  }

  async function assumir(aposSalvar) {
    var r = await UI.confirmar({
      titulo: 'Assumir o comando sem o aceite de ' + (est.comando && est.comando.comando_nome || 'quem está no comando') + '?',
      texto: 'Só quando o comandante não pode responder. O motivo fica no diário, em destaque.',
      campo: { rotulo: 'Motivo (obrigatório, mín. 10 caracteres)', max: 500, obrigatorio: true }, ok: 'Assumir o comando', perigo: true, empilhar: true,
    });
    if (!r) return;
    if (await rpc('comando_assumir', { p_operacao: P.op().id, p_motivo: r.texto }, 'Você assumiu o comando.') && aposSalvar) aposSalvar();
  }

  /* ---------- Tela principal --------------------------------------------- */
  function abrir() {
    var corpo = el('div', { classe: 'briefing-modal' });
    var fechar;
    var carregando = false;
    function desenhar() {
      corpo.innerHTML = '';
      corpo.appendChild(el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, ['Briefing e passagem de comando',
        UI.dica('Montado com o que já está cadastrado (vítimas, cenário, equipes, setores, mensagens). Só objetivo, riscos, comunicações, observações e decisões são escritos aqui. Na passagem, quem recebe lê uma foto deste briefing e aceita.')]));
      if (est.ausente) {
        corpo.appendChild(el('p', { classe: 'nota', texto: 'Briefing indisponível: faltam as migrações 035 a 037 no banco.' }));
        corpo.appendChild(UI.rodape([el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]));
        return;
      }
      var pend = pendente();
      var meu = sou_comandante();
      var acoesRodape = [
        el('button', { classe: 'btn', type: 'button', id: 'briefing-copiar', texto: 'Copiar texto', title: 'Texto curto para rádio, mensagem ou papel', onclick: function () { if (est.dados && P.copiar) P.copiar(textoPuro(est.dados)); } }),
        el('button', { classe: 'btn', type: 'button', id: 'briefing-atualizar', texto: '↻', title: 'Atualizar', 'aria-label': 'Atualizar', onclick: function () { atualizar(); } }),
      ];
      if (podeAlterar()) {
        acoesRodape.push(el('button', { classe: 'btn', type: 'button', id: 'briefing-editar', texto: 'Editar textos', onclick: function () { if (est.dados) abrirEdicao(est.dados, atualizar); } }));
        if (meu || (P.admin && P.admin())) acoesRodape.push(el('button', { classe: 'btn btn-escuro', type: 'button', id: 'briefing-passar', disabled: pend ? true : null, texto: 'Passar o comando', title: pend ? 'Já há uma passagem aguardando aceite' : '', onclick: function () { abrirPassagem(desenhar); } }));
        if (!meu) acoesRodape.push(el('button', { classe: 'btn btn-escuro', type: 'button', id: 'briefing-assumir', texto: 'Assumir o comando', onclick: function () { assumir(desenhar); } }));
      }
      if (pend) {
        var paraMim = pend.para_user_id === eu();
        corpo.appendChild(el('div', { classe: 'nota briefing-pendente' }, [
          el('span', null, [el('strong', { texto: 'Aguardando aceite: ' }), pend.de_nome + ' → ' + pend.para_nome + ' (' + C.hora(pend.criada_em, false) + ')']),
          paraMim ? el('button', { classe: 'btn btn-pequeno btn-escuro', type: 'button', texto: 'Ler e responder', onclick: function () { abrirRecebimento(pend); } }) : null,
          pend.de_user_id === eu() || (P.admin && P.admin()) ? el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Cancelar passagem', onclick: async function () { await rpc('passagem_cancelar', { p_passagem: pend.id }, 'Passagem cancelada.'); desenhar(); } }) : null,
        ]));
      }
      if (carregando && !est.dados) corpo.appendChild(el('div', { classe: 'painel-carregando-inline' }, [el('span', { classe: 'spinner' }), 'Montando o briefing…']));
      if (est.dados) {
        corpo.appendChild(renderizar(est.dados, {
          novaDecisao: function () { novaDecisao(atualizar); }, resolverDecisao: function (x) { resolverDecisao(x, atualizar); },
          abrirCenario: function () { if (window.BuscaCenario) window.BuscaCenario.abrir(); },
          abrirReferencia: function (ref) {
            var k = String(ref).split(':');
            if (k[0] === 'pedido' && window.AjudaPedidos) window.AjudaPedidos.abrir(k[1]);
            else if ((k[0] === 'cenario' || k[0] === 'vitima') && window.BuscaCenario) window.BuscaCenario.abrir(k[0] === 'vitima' ? k[1] : null);
            else if (k[0] === 'alerta' && P.abrirCentral) { UI.fecharTodos(); P.abrirCentral('alertas'); }
          },
        }, false));
      }
      if (est.erro) corpo.appendChild(el('p', { classe: 'nota', texto: 'Não foi possível atualizar: ' + est.erro }));
      var hist = est.passagens;
      if (hist.length) {
        corpo.appendChild(el('details', { classe: 'briefing-historico' }, [
          el('summary', { texto: 'Histórico de passagens (' + hist.length + ')' }),
          el('ul', { classe: 'briefing-lista' }, hist.map(function (p) {
            return el('li', null, [
              C.hora(p.criada_em, false) + ' · ' + (p.de_nome || '—') + ' → ' + p.para_nome + ' · ' + ESTADOS_PASSAGEM[p.estado] + (p.respondida_em ? ' às ' + C.hora(p.respondida_em, false) : ''),
              p.motivo ? ' · motivo: ' + p.motivo : '', p.resposta_nota ? ' · resposta: ' + p.resposta_nota : '', p.nota ? el('div', { classe: 'muted', texto: 'Recado: ' + p.nota }) : null,
              el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Ver foto do briefing', onclick: function () { abrirRecebimento(Object.assign({}, p, { estado: 'visualizacao' })); } }),
            ]);
          })),
        ]));
      }
      corpo.appendChild(UI.rodape(acoesRodape));
    }
    async function atualizar() {
      carregando = true;
      try {
        est.dados = await C.rpc('briefing_operacao_dados', { p_operacao: P.op().id });
        est.erro = null;
      } catch (e) { est.erro = e.message; }
      carregando = false;
      await carregar();
      desenhar();
    }
    est.renderAtual = function () { desenhar(); };
    desenhar();
    fechar = UI.abrirModal(corpo, { tamanho: 'largo', aoFechar: function () { est.renderAtual = null; } });
    atualizar();
  }

  window.Briefing = {
    iniciar: iniciar, parar: parar, abrir: abrir, recarregar: carregar, textoPuro: textoPuro, renderizar: renderizar,
    comando: function () { return est.comando; }, aoMudar: function (f) { est.ouvintes.push(f); },
    disponivel: function () { return !est.ausente; },
  };
})();
