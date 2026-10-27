/* =====================================================================
 * ajuda-pedidos.js — pedidos de ajuda com fluxo completo (migração 035)
 *   recebido → assumido → equipe enviada → em atendimento → resolvido
 *   - "Lido" ou "ciente" NÃO resolvem: só "Resolver", com o tipo e a justificativa.
 *   - Mostra o tempo sem atendimento (desde que chegou até alguém assumir) e as escalações do servidor.
 *   - Prioridade (baixar exige justificativa), assumir/reassumir, enviar equipe, iniciar atendimento,
 *     anotar, resolver e reabrir; o histórico de cada pedido nunca é apagado.
 *   O estado é do servidor: todos os responsáveis veem o mesmo. Usa a interface window.Painel (militar.js).
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI, P = window.Painel;
  if (!C || !UI || !P) return;
  var el = UI.el;

  var ESTADOS = {
    recebido: { rotulo: 'Recebido', classe: 'selo-perigo' },
    assumido: { rotulo: 'Assumido', classe: 'selo-alerta' },
    equipe_enviada: { rotulo: 'Equipe enviada', classe: 'selo-alerta' },
    em_atendimento: { rotulo: 'Em atendimento', classe: 'selo-responsavel' },
    resolvido: { rotulo: 'Resolvido', classe: 'selo-ok' },
  };
  var PRIORIDADES = { critica: { rotulo: 'Crítica', ordem: 0 }, alta: { rotulo: 'Alta', ordem: 1 }, media: { rotulo: 'Média', ordem: 2 }, baixa: { rotulo: 'Baixa', ordem: 3 } };
  var RESOLUCOES = { atendido: 'Atendido', sem_necessidade: 'Sem necessidade', falso_alarme: 'Falso alarme', encaminhado: 'Encaminhado a outro serviço', outro: 'Outro' };
  var EVENTOS = { recebido: 'Recebido', assumido: 'Assumido', prioridade: 'Prioridade', equipe_enviada: 'Equipe enviada', em_atendimento: 'Atendimento', resolvido: 'Resolvido', reaberto: 'Reaberto', escalado: 'ESCALADO', nota: 'Anotação' };

  var est = { opId: null, pedidos: new Map(), eventos: new Map(), ausente: false, erro: null, canal: null, timer: null, timerCanal: null,
    timerRelogio: null, timerVerif: null, renderAtual: null, ouvintes: [], carregou: false };

  /* ---------- Formatação ------------------------------------------------- */
  function agora() { return C.agora ? C.agora() : Date.now(); }
  function duracao(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' s';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  }
  function podeAlterar() { return Boolean(P.podeAlterar && P.podeAlterar()); }
  function abertos() {
    return Array.from(est.pedidos.values()).filter(function (p) { return p.estado !== 'resolvido'; });
  }

  /* ---------- Dados ------------------------------------------------------ */
  async function carregar() {
    var op = P.op();
    if (!op || est.ausente) return;
    var opId = op.id;
    try {
      var r = await Promise.all([
        C.consultar(C.cliente.from('pedidos_ajuda').select('*').eq('operacao_id', opId).order('recebido_em', { ascending: false })),
        C.consultar(C.cliente.from('pedido_ajuda_eventos').select('*').eq('operacao_id', opId).order('id', { ascending: true })),
      ]);
      if (!P.op() || P.op().id !== opId) return;
      est.pedidos = new Map((r[0] || []).map(function (p) { return [p.id, p]; }));
      est.eventos = new Map();
      (r[1] || []).forEach(function (e) { if (!est.eventos.has(e.pedido_id)) est.eventos.set(e.pedido_id, []); est.eventos.get(e.pedido_id).push(e); });
      est.erro = null;
      est.carregou = true;
    } catch (e) {
      // banco sem a migração 035: o painel segue com o aviso antigo
      var t = String(e.original && (e.original.message || e.original.details) || e.message);
      if (/pedidos_ajuda|pedido_ajuda_eventos/.test(t) || e.codigo === 'funcao_ausente') est.ausente = true;
      est.erro = e.message;
    }
    avisarMudou();
  }

  function avisarMudou() {
    atualizarPilula();
    if (est.renderAtual) est.renderAtual();
    est.ouvintes.forEach(function (f) { try { f(); } catch (e) { /* ignora */ } });
  }

  function agendar() {
    clearTimeout(est.timer);
    est.timer = setTimeout(carregar, 350);
  }

  function assinar() {
    var op = P.op();
    if (!op || est.ausente) return;
    var opId = op.id;
    if (est.canal) { try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ } }
    try {
      est.canal = C.cliente.channel('op-ajuda-' + opId + '-' + Date.now());
      ['pedidos_ajuda', 'pedido_ajuda_eventos'].forEach(function (tabela) {
        est.canal.on('postgres_changes', { event: '*', schema: 'public', table: tabela, filter: 'operacao_id=eq.' + opId }, agendar);
      });
      est.canal.subscribe(function (status) {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(est.timerCanal);
          est.timerCanal = setTimeout(function () { var o = P.op(); if (o && o.id === opId) { carregar(); assinar(); } }, 60000);
        }
      });
    } catch (e) { /* sem tempo real: recarrega ao abrir e a cada minuto */ }
  }

  function iniciar() {
    parar();
    var op = P.op();
    if (!op) return;
    est.opId = op.id;
    carregar();
    assinar();
    // relógio da tela (tempo sem atendimento) e verificação de escalação enquanto o painel está aberto
    est.timerRelogio = setInterval(function () { atualizarPilula(); if (est.renderAtual) est.renderAtual(); }, 20000);
    est.timerVerif = setInterval(function () {
      var o = P.op();
      if (!o || o.status !== 'ativa' || est.ausente || !abertos().length) return;
      C.rpc('verificar_pedidos_ajuda', { p_operacao: o.id }, 15000).then(function (n) { if (n) carregar(); }).catch(function () { /* tenta no próximo ciclo */ });
    }, 60000);
  }

  function parar() {
    clearTimeout(est.timer); clearTimeout(est.timerCanal); clearInterval(est.timerRelogio); clearInterval(est.timerVerif);
    if (est.canal) { try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ } }
    est.canal = null; est.opId = null; est.pedidos = new Map(); est.eventos = new Map(); est.ausente = false; est.erro = null; est.renderAtual = null; est.carregou = false;
    atualizarPilula();
  }

  /* ---------- Pílula no topo e item do menu ------------------------------ */
  function resumo() {
    var ab = abertos(), sem = ab.filter(function (p) { return p.estado === 'recebido'; });
    var maisAntigo = sem.reduce(function (m, p) { var t = agora() - C.paraMs(p.recebido_em); return t > m ? t : m; }, 0);
    return { abertos: ab.length, semAtendimento: sem.length, maisAntigoSemAtendimentoMs: maisAntigo, escalados: ab.filter(function (p) { return p.escalonamentos > 0; }).length };
  }

  function atualizarPilula() {
    var r = resumo();
    var btn = document.getElementById('btn-ajuda');
    if (btn) {
      btn.hidden = !r.abertos || est.ausente;
      btn.classList.toggle('ajuda-sem-atendimento', r.semAtendimento > 0);
      var n = document.getElementById('ajuda-qtd');
      if (n) n.textContent = String(r.abertos);
      var t = document.getElementById('ajuda-tempo');
      if (t) t.textContent = r.semAtendimento ? 'sem atendimento há ' + duracao(r.maisAntigoSemAtendimentoMs) : 'em andamento';
    }
    var m = document.getElementById('menu-ajuda-qtd');
    if (m) m.textContent = r.abertos ? r.abertos + ' aberto' + (r.abertos > 1 ? 's' : '') : '';
  }

  /* ---------- Ações ------------------------------------------------------ */
  async function executar(nome, args, ok) {
    try {
      await C.rpc(nome, args);
      if (ok) UI.aviso(ok, 'ok');
      await carregar();
      return true;
    } catch (e) {
      UI.aviso(e.message, 'erro', 8000);
      return false;
    }
  }

  async function pedirResolucao(p) {
    var tipo = el('select', { classe: 'campo', id: 'ajuda-resolucao' }, Object.keys(RESOLUCOES).map(function (k) { return el('option', { value: k, texto: RESOLUCOES[k] }); }));
    var r = await UI.confirmar({
      titulo: 'Resolver o pedido de ' + p.participante_nome + '?',
      texto: 'Resolver encerra o pedido. Diga o que foi feito: a justificativa fica no histórico (que nunca é apagado).',
      detalhe: el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'ajuda-resolucao', texto: 'Como terminou' }), tipo]),
      campo: { rotulo: 'Justificativa (obrigatória, mín. 5 caracteres)', max: 1000, obrigatorio: true },
      ok: 'Resolver pedido', empilhar: true,
    });
    if (!r) return;
    if (r.texto.length < 5) { UI.aviso('Escreva a justificativa (pelo menos 5 caracteres).', 'erro'); return; }
    await executar('pedido_ajuda_resolver', { p_pedido: p.id, p_resolucao: tipo.value, p_texto: r.texto }, 'Pedido resolvido.');
  }

  async function pedirEquipe(p) {
    var grupos = (P.grupos ? P.grupos() : []) || [];
    if (!grupos.length) { UI.aviso('Crie uma equipe (grupo) antes de enviá-la.', 'erro'); return; }
    var sel = el('select', { classe: 'campo', id: 'ajuda-equipe' }, grupos.map(function (g) { return el('option', { value: g.id, selected: g.id === p.equipe_grupo_id ? true : null, texto: g.nome }); }));
    var r = await UI.confirmar({
      titulo: 'Enviar equipe ao pedido de ' + p.participante_nome,
      texto: 'Registra no pedido qual equipe foi enviada. Para mandar a rota ao celular da equipe, use depois "Enviar destino".',
      detalhe: el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'ajuda-equipe', texto: 'Equipe' }), sel]),
      campo: { rotulo: 'Observação (opcional)', max: 500 }, ok: 'Registrar envio', empilhar: true,
    });
    if (!r) return;
    await executar('pedido_ajuda_enviar_equipe', { p_pedido: p.id, p_grupo: sel.value, p_nota: r.texto }, 'Equipe registrada no pedido.');
  }

  async function mudarPrioridade(p, nova) {
    if (nova === p.prioridade) return;
    var baixando = PRIORIDADES[nova].ordem > PRIORIDADES[p.prioridade].ordem;
    var just = '';
    if (baixando) {
      var r = await UI.confirmar({
        titulo: 'Baixar a prioridade para ' + PRIORIDADES[nova].rotulo.toLowerCase() + '?',
        texto: 'Baixar a prioridade exige justificativa (fica no histórico).',
        campo: { rotulo: 'Justificativa (obrigatória)', max: 500, obrigatorio: true }, ok: 'Baixar prioridade', empilhar: true,
      });
      if (!r) { if (est.renderAtual) est.renderAtual(); return; }
      just = r.texto;
    }
    var ok = await executar('pedido_ajuda_prioridade', { p_pedido: p.id, p_prioridade: nova, p_justificativa: just || null }, 'Prioridade alterada.');
    if (!ok && est.renderAtual) est.renderAtual();
  }

  async function pedirTexto(p, nome, titulo, rotulo, okTxt, args, min) {
    var r = await UI.confirmar({ titulo: titulo, campo: { rotulo: rotulo, max: 500, obrigatorio: Boolean(min) }, ok: okTxt, empilhar: true });
    if (!r) return;
    var a = Object.assign({ p_pedido: p.id }, args);
    a[args.__chave || 'p_texto'] = r.texto;
    delete a.__chave;
    await executar(nome, a);
  }

  /* ---------- Tela ------------------------------------------------------- */
  function cartao(p, aberto) {
    var eventos = est.eventos.get(p.id) || [];
    var t0 = C.paraMs(p.recebido_em);
    var ehAberto = p.estado !== 'resolvido';
    var tempo = !ehAberto ? 'Resolvido em ' + duracao(C.paraMs(p.resolvido_em) - t0) + ' (às ' + C.hora(p.resolvido_em, false) + ')'
      : p.estado === 'recebido' ? 'SEM ATENDIMENTO há ' + duracao(agora() - t0)
        : 'Aberto há ' + duracao(agora() - t0) + (p.assumido_em ? ' · assumido após ' + duracao(C.paraMs(p.assumido_em) - t0) : '');
    var cab = el('div', { classe: 'ajuda-topo' }, [
      el('strong', { classe: 'ajuda-nome', texto: p.participante_nome }),
      el('span', { classe: 'selo ' + ESTADOS[p.estado].classe, texto: ESTADOS[p.estado].rotulo }),
      el('span', { classe: 'selo ajuda-prio ajuda-prio-' + p.prioridade, texto: 'Prioridade ' + PRIORIDADES[p.prioridade].rotulo.toLowerCase() }),
      p.escalonamentos > 0 && ehAberto ? el('span', { classe: 'selo selo-perigo', texto: 'ESCALADO ×' + p.escalonamentos }) : null,
    ]);
    var linhas = el('div', { classe: 'ajuda-linhas' }, [
      el('p', { classe: 'ajuda-tempo' + (ehAberto && p.estado === 'recebido' ? ' ajuda-tempo-alerta' : ''), texto: tempo }),
      el('p', { classe: 'muted', texto: 'Recebido às ' + C.hora(p.recebido_em, false) + (p.origem === 'resposta' ? ' · resposta "preciso de ajuda" a um comando' : ' · botão "Preciso de ajuda"') + (p.lat != null ? ' · com localização' : ' · sem localização') }),
      p.texto ? el('p', { classe: 'ajuda-texto', texto: p.texto }) : null,
      p.assumido_por_nome ? el('p', { texto: 'Responsável: ' + p.assumido_por_nome + (p.assumido_em ? ' (desde ' + C.hora(p.assumido_em, false) + ')' : '') }) : null,
      p.equipe_nome ? el('p', { texto: 'Equipe: ' + p.equipe_nome + (p.equipe_enviada_em ? ' (enviada às ' + C.hora(p.equipe_enviada_em, false) + ')' : '') }) : null,
      p.atendimento_iniciado_em ? el('p', { texto: 'Atendimento iniciado às ' + C.hora(p.atendimento_iniciado_em, false) }) : null,
      !ehAberto ? el('p', { classe: 'ajuda-resolucao' }, [el('strong', { texto: RESOLUCOES[p.resolucao] + ' por ' + (p.resolvido_por_nome || '—') + ': ' }), p.resolucao_texto]) : null,
    ]);
    var acoes = [];
    if (podeAlterar()) {
      if (ehAberto) {
        var prio = el('select', { classe: 'campo campo-pequeno', 'aria-label': 'Prioridade', title: 'Prioridade' }, Object.keys(PRIORIDADES).map(function (k) {
          return el('option', { value: k, selected: k === p.prioridade ? true : null, texto: 'Prioridade ' + PRIORIDADES[k].rotulo.toLowerCase() });
        }));
        prio.addEventListener('change', function () { mudarPrioridade(p, prio.value); });
        var meu = P.usuario && P.usuario() && P.usuario().id;
        if (p.estado === 'recebido' || p.assumido_por !== meu) {
          acoes.push(el('button', { classe: 'btn btn-escuro btn-pequeno', type: 'button', texto: p.estado === 'recebido' ? 'Assumir' : 'Assumir (passar para mim)',
            onclick: function () { executar('pedido_ajuda_assumir', { p_pedido: p.id }, 'Você assumiu o pedido.'); } }));
        }
        acoes.push(prio);
        acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: p.equipe_nome ? 'Trocar/enviar outra equipe' : 'Enviar equipe', onclick: function () { pedirEquipe(p); } }));
        if (p.lat != null) acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '🧭 Enviar destino', onclick: function () { UI.fecharTodos(); if (P.enviarDestino) P.enviarDestino(p.lat, p.lng, 'Pedido de ajuda: ' + p.participante_nome); } }));
        if (p.estado !== 'em_atendimento') acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Iniciar atendimento', onclick: function () { pedirTexto(p, 'pedido_ajuda_iniciar_atendimento', 'Iniciar o atendimento?', 'Observação (opcional)', 'Iniciar atendimento', { __chave: 'p_nota' }, 0); } }));
        acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Anotar', onclick: function () { pedirTexto(p, 'pedido_ajuda_nota', 'Anotação no pedido', 'Anotação', 'Anotar', {}, 2); } }));
        acoes.push(el('button', { classe: 'btn btn-primario btn-pequeno', type: 'button', texto: 'Resolver…', onclick: function () { pedirResolucao(p); } }));
      } else {
        acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Reabrir', onclick: function () { pedirTexto(p, 'pedido_ajuda_reabrir', 'Reabrir o pedido?', 'Motivo (obrigatório, mín. 5 caracteres)', 'Reabrir', { __chave: 'p_motivo' }, 5); } }));
      }
    }
    if (p.lat != null && P.irPara) acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Ver no mapa', onclick: function () { UI.fecharTodos(); P.irPara(p.lat, p.lng); } }));
    var hist = el('details', { classe: 'ajuda-historico', open: aberto ? true : null }, [
      el('summary', { texto: 'Histórico (' + eventos.length + ')' }),
      el('ol', null, eventos.map(function (e) {
        return el('li', { classe: e.tipo === 'escalado' ? 'ajuda-ev-escalado' : null }, [el('strong', { texto: C.hora(e.em, false) + ' · ' + (EVENTOS[e.tipo] || e.tipo) + ' · ' + e.por_nome + ': ' }), e.detalhe]);
      })),
    ]);
    return el('li', { classe: 'ajuda-cartao ajuda-estado-' + p.estado + ' ajuda-p-' + p.prioridade, 'data-pedido': p.id }, [cab, linhas, el('div', { classe: 'acoes-linha ajuda-acoes' }, acoes), hist]);
  }

  var abaAtual = 'abertos';
  function abrir(pedidoId) {
    var corpo = el('div', { classe: 'ajuda-corpo' });
    var fechar;
    function desenhar() {
      corpo.innerHTML = '';
      corpo.appendChild(el('h2', { id: 'modal-titulo', texto: 'Pedidos de ajuda' }));
      corpo.appendChild(el('p', { classe: 'ajuda', texto: 'Cada pedido segue: recebido → assumido → equipe enviada → em atendimento → resolvido. "Lido" ou "ciente" não resolvem: só "Resolver", com a justificativa. Sem ninguém assumir, o sistema escala com alarme.' }));
      if (est.ausente) {
        corpo.appendChild(el('p', { classe: 'nota', texto: 'O fluxo de pedidos de ajuda ainda não está no servidor: rode a migração 035_pedidos_ajuda.sql no Supabase.' }));
        corpo.appendChild(el('div', { classe: 'modal-acoes' }, [el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]));
        return;
      }
      if (est.erro) corpo.appendChild(el('p', { classe: 'nota', texto: 'Não foi possível atualizar: ' + est.erro }));
      var todos = Array.from(est.pedidos.values());
      var ab = todos.filter(function (p) { return p.estado !== 'resolvido'; });
      var rs = todos.filter(function (p) { return p.estado === 'resolvido'; });
      var abas = el('div', { classe: 'ajuda-abas', role: 'tablist' }, [['abertos', 'Abertos (' + ab.length + ')'], ['resolvidos', 'Resolvidos (' + rs.length + ')']].map(function (a) {
        return el('button', { classe: 'btn btn-pequeno' + (abaAtual === a[0] ? ' btn-ativo' : ''), type: 'button', role: 'tab', 'aria-selected': String(abaAtual === a[0]), texto: a[1], onclick: function () { abaAtual = a[0]; desenhar(); } });
      }));
      corpo.appendChild(abas);
      var lista = abaAtual === 'abertos'
        ? ab.sort(function (a, b) { return (a.estado === 'recebido' ? 0 : 1) - (b.estado === 'recebido' ? 0 : 1) || PRIORIDADES[a.prioridade].ordem - PRIORIDADES[b.prioridade].ordem || C.paraMs(a.recebido_em) - C.paraMs(b.recebido_em); })
        : rs.sort(function (a, b) { return C.paraMs(b.resolvido_em) - C.paraMs(a.resolvido_em); });
      if (!lista.length) corpo.appendChild(el('p', { classe: 'muted', texto: abaAtual === 'abertos' ? 'Nenhum pedido de ajuda aberto.' : 'Nenhum pedido resolvido ainda.' }));
      corpo.appendChild(el('ul', { classe: 'ajuda-lista' }, lista.map(function (p) { return cartao(p, p.id === pedidoId); })));
      corpo.appendChild(el('div', { classe: 'modal-acoes' }, [el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]));
    }
    if (pedidoId && est.pedidos.get(pedidoId)) abaAtual = est.pedidos.get(pedidoId).estado === 'resolvido' ? 'resolvidos' : 'abertos';
    est.renderAtual = desenhar;
    desenhar();
    fechar = UI.abrirModal(corpo, { aoFechar: function () { est.renderAtual = null; } });
    carregar();
  }

  function pedidoDoParticipante(pid) {
    var melhor = null;
    est.pedidos.forEach(function (p) {
      if (p.participante_id === pid && p.estado !== 'resolvido' && (!melhor || C.paraMs(p.recebido_em) > C.paraMs(melhor.recebido_em))) melhor = p;
    });
    return melhor;
  }

  window.AjudaPedidos = {
    iniciar: iniciar, parar: parar, abrir: abrir, recarregar: carregar, resumo: resumo,
    disponivel: function () { return !est.ausente && est.carregou; },
    abertoDoParticipante: pedidoDoParticipante,
    aoMudar: function (f) { est.ouvintes.push(f); },
    ESTADOS: ESTADOS, PRIORIDADES: PRIORIDADES, duracao: duracao,
  };
})();
