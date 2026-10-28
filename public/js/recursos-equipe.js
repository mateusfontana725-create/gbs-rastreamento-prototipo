/* =====================================================================
 * recursos-equipe.js — disponibilidade, capacidades e recursos de cada equipe (migração 036)
 *   Recursos: embarcação, viatura, drone, cão de busca, equipamento de comunicação, primeiros socorros (e outro).
 *   Disponibilidade: informada (disponível, em descanso, indisponível); "em missão" é deduzida do deslocamento ativo.
 *   Avisos de segurança: equipe sem equipamento de comunicação ou sem primeiros socorros (só quando há recursos
 *   registrados: sem informação não se acusa falta). Usa a interface window.Painel (militar.js).
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI, P = window.Painel;
  if (!C || !UI || !P) return;
  var el = UI.el;

  var TIPOS = {
    embarcacao: { rotulo: 'Embarcação', icone: '⛵' }, viatura: { rotulo: 'Viatura', icone: '🚒' }, drone: { rotulo: 'Drone', icone: '🛸' },
    cao_busca: { rotulo: 'Cão de busca', icone: '🐕' }, comunicacao: { rotulo: 'Equipamento de comunicação', icone: '📻' },
    primeiros_socorros: { rotulo: 'Primeiros socorros', icone: '⛑' }, outro: { rotulo: 'Outro recurso', icone: '▪' },
  };
  var SITUACOES = { operacional: 'Operacional', limitado: 'Limitado', indisponivel: 'Indisponível' };
  var DISPONIBILIDADES = { disponivel: 'Disponível', em_descanso: 'Em descanso', indisponivel: 'Indisponível', em_missao: 'Em missão' };
  var MISSAO_ATIVA = ['enviada', 'em_deslocamento', 'no_setor', 'busca_finalizada', 'retorno_atrasado'];

  var est = { opId: null, recursos: [], ausente: false, canal: null, timer: null, ouvintes: [] };

  function podeAlterar() { return Boolean(P.podeAlterar && P.podeAlterar()); }
  function dataLocal(ms) {
    var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  async function carregar() {
    var op = P.op();
    if (!op || est.ausente) return;
    var opId = op.id;
    try {
      var r = await C.consultar(C.cliente.from('grupo_recursos').select('*').eq('operacao_id', opId));
      if (!P.op() || P.op().id !== opId) return;
      est.recursos = r || [];
    } catch (e) {
      var t = String(e.original && (e.original.message || e.original.details) || e.message);
      if (/grupo_recursos/.test(t) || e.codigo === 'funcao_ausente') est.ausente = true;
    }
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
      est.canal = C.cliente.channel('op-recursos-' + op.id + '-' + Date.now())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'grupo_recursos', filter: 'operacao_id=eq.' + op.id }, agendar)
        .subscribe();
    } catch (e) { /* sem tempo real: recarrega ao abrir e ao salvar */ }
    return carga;
  }

  function parar() {
    clearTimeout(est.timer);
    if (est.canal) { try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ } }
    est.canal = null; est.opId = null; est.recursos = []; est.ausente = false;
  }

  function recursosDe(grupoId) { return est.recursos.filter(function (r) { return r.grupo_id === grupoId; }); }

  // Disponibilidade que vale agora: deslocamento ativo = "em missão"; senão a informada pelo comando.
  function efetiva(g) {
    var ativa = ((P.missoes ? P.missoes() : []) || []).some(function (m) { return m.grupo_id === g.id && MISSAO_ATIVA.indexOf(m.status) !== -1; });
    return ativa ? 'em_missao' : (g.disponibilidade || 'disponivel');
  }

  // Avisos de segurança: só quando há recursos registrados
  function avisos(g) {
    var rs = recursosDe(g.id), a = [];
    if (!rs.length) return a;
    function falta(tipo) { return !rs.some(function (r) { return r.tipo === tipo && r.situacao !== 'indisponivel'; }); }
    if (falta('comunicacao')) a.push('sem equipamento de comunicação');
    if (falta('primeiros_socorros')) a.push('sem primeiros socorros');
    return a;
  }

  // Linha de chips para a lista de equipes
  function resumo(g) {
    var disp = efetiva(g), rs = recursosDe(g.id);
    var chips = [el('span', { classe: 'selo recurso-disp recurso-disp-' + disp, texto: DISPONIBILIDADES[disp] })];
    if (g.disponivel_em && disp !== 'disponivel' && disp !== 'em_missao') chips.push(el('span', { classe: 'muted', texto: 'volta às ' + C.hora(g.disponivel_em, false) }));
    rs.forEach(function (r) {
      chips.push(el('span', { classe: 'selo recurso-chip' + (r.situacao !== 'operacional' ? ' recurso-' + r.situacao : ''), title: TIPOS[r.tipo].rotulo + (r.observacao ? ' — ' + r.observacao : ''),
        texto: TIPOS[r.tipo].icone + ' ' + (r.identificacao || TIPOS[r.tipo].rotulo) + (r.quantidade > 1 ? ' ×' + r.quantidade : '') + (r.situacao !== 'operacional' ? ' (' + SITUACOES[r.situacao].toLowerCase() + ')' : '') }));
    });
    if (!rs.length) chips.push(el('span', { classe: 'muted', texto: 'recursos não informados' }));
    var av = avisos(g);
    if (av.length) chips.push(el('span', { classe: 'selo selo-alerta', texto: '⚠ ' + av.join(' · ') }));
    var linhas = [el('div', { classe: 'recurso-chips' }, chips)];
    if (g.capacidades) linhas.push(el('div', { classe: 'muted recurso-cap', texto: 'Capacidades: ' + g.capacidades }));
    if (g.disponibilidade_obs && disp !== 'disponivel') linhas.push(el('div', { classe: 'muted recurso-cap', texto: g.disponibilidade_obs }));
    return el('div', { classe: 'recurso-resumo' }, linhas);
  }

  // Antes de mandar uma equipe para algum lugar: avisa se ela está em descanso, indisponível ou em missão
  async function confirmarEnvio(g) {
    var disp = efetiva(g);
    if (disp === 'disponivel') return true;
    var motivo = disp === 'em_missao' ? 'já está em deslocamento (missão ativa)' : disp === 'em_descanso' ? 'está em descanso' + (g.disponibilidade_obs ? ' (' + g.disponibilidade_obs + ')' : '') : 'está indisponível' + (g.disponibilidade_obs ? ' (' + g.disponibilidade_obs + ')' : '');
    var r = await UI.confirmar({ titulo: 'A equipe ' + g.nome + ' ' + motivo + '. Enviar mesmo assim?', texto: 'Um novo destino substitui o deslocamento anterior desta equipe. A decisão é sua; o aviso é só para não esquecer a disponibilidade.', ok: 'Enviar mesmo assim', empilhar: true });
    return Boolean(r);
  }

  /* ---------- Edição ------------------------------------------------------ */
  function abrir(grupoId) {
    var g = (P.grupos ? P.grupos() : []).find(function (x) { return x.id === grupoId; });
    if (!g) return;
    if (est.ausente) { UI.aviso('Os recursos das equipes ainda não estão no servidor: rode a migração 036_recursos_equipes.sql no Supabase.', 'erro', 8000); return; }
    var editavel = podeAlterar();
    var disp = el('select', { classe: 'campo', id: 'rec-disp', disabled: editavel ? null : true }, ['disponivel', 'em_descanso', 'indisponivel'].map(function (k) {
      return el('option', { value: k, selected: k === g.disponibilidade ? true : null, texto: DISPONIBILIDADES[k] });
    }));
    var obs = el('input', { classe: 'campo', id: 'rec-obs', maxlength: '200', value: g.disponibilidade_obs || '', placeholder: 'Ex.: turno terminado, equipe cansada…', disabled: editavel ? null : true });
    var volta = el('input', { classe: 'campo', id: 'rec-volta', type: 'datetime-local', value: g.disponivel_em ? dataLocal(C.paraMs(g.disponivel_em)) : '', disabled: editavel ? null : true });
    var cap = el('textarea', { classe: 'campo', id: 'rec-cap', rows: '2', maxlength: '300', placeholder: 'Ex.: mergulho autônomo, resgate em altura, APH avançado', disabled: editavel ? null : true });
    cap.value = g.capacidades || '';
    var linhas = [];
    var lista = el('div', { classe: 'rec-lista' });
    function adicionar(r) {
      r = r || { tipo: 'viatura', identificacao: '', quantidade: 1, situacao: 'operacional', observacao: '' };
      var tipo = el('select', { classe: 'campo campo-pequeno', 'aria-label': 'Tipo de recurso', disabled: editavel ? null : true }, Object.keys(TIPOS).map(function (k) { return el('option', { value: k, selected: k === r.tipo ? true : null, texto: TIPOS[k].icone + ' ' + TIPOS[k].rotulo }); }));
      var ident = el('input', { classe: 'campo', maxlength: '60', value: r.identificacao || '', placeholder: 'Identificação (ex.: VTR ABT-12, Mavic 3T)', 'aria-label': 'Identificação', disabled: editavel ? null : true });
      var qtd = el('input', { classe: 'campo campo-poa', type: 'number', min: '1', max: '99', value: String(r.quantidade || 1), 'aria-label': 'Quantidade', disabled: editavel ? null : true });
      var sit = el('select', { classe: 'campo campo-pequeno', 'aria-label': 'Situação', disabled: editavel ? null : true }, Object.keys(SITUACOES).map(function (k) { return el('option', { value: k, selected: k === r.situacao ? true : null, texto: SITUACOES[k] }); }));
      var ob = el('input', { classe: 'campo', maxlength: '200', value: r.observacao || '', placeholder: 'Observação', 'aria-label': 'Observação do recurso', disabled: editavel ? null : true });
      var item = { tipo: tipo, ident: ident, qtd: qtd, sit: sit, ob: ob, no: null };
      item.no = el('div', { classe: 'rec-linha' }, [tipo, ident, qtd, sit, ob,
        editavel ? el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Remover', onclick: function () { linhas = linhas.filter(function (x) { return x !== item; }); item.no.remove(); } }) : null]);
      linhas.push(item);
      lista.appendChild(item.no);
    }
    recursosDe(g.id).forEach(adicionar);
    var erro = el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btnSalvar = el('button', { classe: 'btn btn-escuro', type: 'button', id: 'rec-salvar', texto: 'Salvar' });
    var atalhos = editavel ? el('div', { classe: 'acoes-linha' }, Object.keys(TIPOS).filter(function (k) { return k !== 'outro'; }).map(function (k) {
      return el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '+ ' + TIPOS[k].icone + ' ' + TIPOS[k].rotulo, onclick: function () { adicionar({ tipo: k, quantidade: 1, situacao: 'operacional' }); } });
    }).concat([el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '+ Outro', onclick: function () { adicionar({ tipo: 'outro', quantidade: 1, situacao: 'operacional' }); } })])) : null;
    btnSalvar.addEventListener('click', async function () {
      erro.hidden = true;
      var voltaMs = volta.value ? new Date(volta.value).getTime() : null;
      btnSalvar.disabled = true;
      try {
        await C.rpc('salvar_recursos_grupo', { p_grupo: g.id, p_dados: {
          disponibilidade: disp.value, disponibilidade_obs: obs.value.trim(), disponivel_em: voltaMs != null && !isNaN(voltaMs) ? new Date(voltaMs).toISOString() : null, capacidades: cap.value.trim(),
          recursos: linhas.map(function (x) { return { tipo: x.tipo.value, identificacao: x.ident.value.trim(), quantidade: Number(x.qtd.value) || 1, situacao: x.sit.value, observacao: x.ob.value.trim() }; }),
        } });
        UI.aviso('Equipe ' + g.nome + ': recursos e disponibilidade salvos.', 'ok');
        fechar(true);
        await carregar();
        if (P.recarregarGrupos) P.recarregarGrupos();
      } catch (e) { erro.textContent = e.message; erro.hidden = false; btnSalvar.disabled = false; }
    });
    var corpo = el('div', { classe: 'form-recursos' }, [
      el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, ['Recursos · ' + g.nome, UI.dica('"Em missão" aparece sozinho quando a equipe está em deslocamento.')]),
      el('div', { classe: 'grupo grupo-2col' }, [
        el('div', null, [el('label', { classe: 'rotulo', for: 'rec-disp', texto: 'Disponibilidade' }), disp]),
        el('div', null, [el('label', { classe: 'rotulo', for: 'rec-volta', texto: 'Volta a ficar disponível às (opcional)' }), volta]),
      ]),
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'rec-obs', texto: 'Observação' }), obs]),
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'rec-cap', texto: 'Capacidades' }), cap]),
      el('div', { classe: 'grupo' }, [el('span', { classe: 'rotulo', texto: 'Recursos' }), lista, atalhos]),
      erro,
      UI.rodape([el('button', { classe: 'btn', type: 'button', texto: editavel ? 'Cancelar' : 'Fechar', onclick: function () { fechar(); } }), editavel ? btnSalvar : null]),
    ]);
    var fechar = UI.abrirModal(corpo, { fecharNoFundo: false });
  }

  window.RecursosEquipe = {
    iniciar: iniciar, parar: parar, abrir: abrir, resumo: resumo, efetiva: efetiva, avisos: avisos, recursosDe: recursosDe, confirmarEnvio: confirmarEnvio, recarregar: carregar,
    aoMudar: function (f) { est.ouvintes.push(f); }, TIPOS: TIPOS, DISPONIBILIDADES: DISPONIBILIDADES,
    disponivel: function () { return !est.ausente; },
  };
})();
