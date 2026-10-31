/* =====================================================================
 * relatos-revisao.js — revisão dos relatos de campo (migração 042)
 *   - Cada relato (pista, vestígio, objeto…) tem um estado: pendente, em análise, confirmado, descartado,
 *     inconclusivo ou contestado. Mudar o estado cria uma VERSÃO nova (nada é sobrescrito) com quem e quando.
 *   - Confirmar, descartar, contestar e "inconclusivo" exigem justificativa (como foi verificado).
 *   - Três horários separados: quando o FATO aconteceu (informado, estimado ou desconhecido), quando o relato
 *     foi RECEBIDO e quando foi REVISADO. A hora da posição GPS é só da posição.
 *   Usa a interface window.Painel (militar.js).
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI, P = window.Painel;
  if (!C || !UI || !P) return;
  var el = UI.el;

  var ESTADOS = {
    pendente: { rotulo: 'Pendente', classe: 'selo-neutro', sub: 'ainda não olhado' },
    em_analise: { rotulo: 'Em análise', classe: 'selo-alerta', sub: 'alguém está verificando' },
    confirmado: { rotulo: 'Confirmado', classe: 'selo-ok', sub: 'verificado por outro meio' },
    descartado: { rotulo: 'Descartado', classe: 'selo-neutro selo-riscado', sub: 'não tem relação' },
    inconclusivo: { rotulo: 'Inconclusivo', classe: 'selo-neutro', sub: 'não deu para saber' },
    contestado: { rotulo: 'Contestado', classe: 'selo-perigo', sub: 'há informação contrária' },
  };
  var COM_JUSTIFICATIVA = ['confirmado', 'descartado', 'inconclusivo', 'contestado'];
  var ORIGENS = { informado: 'informado', estimado: 'estimado', gps: 'pelo GPS', desconhecido: 'desconhecido' };

  var est = { opId: null, porMensagem: new Map(), ausente: false, erro: null, canal: null, timer: null, ouvintes: [] };

  // Pedido de ajuda e vítima localizada têm fluxo próprio (ajuda-pedidos.js, vitima_localizacoes): não entram na revisão
  function ehRelato(m) { return Boolean(m && m.direcao === 'entrada' && m.categoria && m.categoria !== 'MENSAGEM' && m.categoria !== 'AJUDA' && m.categoria !== 'VITIMA'); }

  /* ---------- Dados ------------------------------------------------------ */
  function aplicar(lista) {
    (lista || []).forEach(function (r) {
      var v = est.porMensagem.get(r.mensagem_id) || [];
      if (!v.some(function (x) { return x.id === r.id; })) v.push(r);
      v.sort(function (a, b) { return a.versao - b.versao; });
      est.porMensagem.set(r.mensagem_id, v);
    });
  }

  function avisar() {
    if (P.atualizarCentral) P.atualizarCentral();
    est.ouvintes.forEach(function (f) { try { f(); } catch (e) { /* ignora */ } });
  }

  async function carregar() {
    var op = P.op();
    if (!op || est.ausente) return;
    var opId = op.id;
    try {
      var r = await C.consultar(C.cliente.from('relato_revisoes').select('*').eq('operacao_id', opId).order('versao', { ascending: true }));
      if (!P.op() || P.op().id !== opId) return;
      est.porMensagem = new Map();
      aplicar(r || []);
      est.erro = null;
    } catch (e) {
      var t = String(e.original && (e.original.message || e.original.details) || e.message);
      if (/relato_revisoes/.test(t) || e.codigo === 'funcao_ausente') est.ausente = true;
      est.erro = e.message;
    }
    avisar();
  }

  function iniciar() {
    parar();
    var op = P.op();
    if (!op) return;
    est.opId = op.id;
    var carga = carregar();
    try {
      est.canal = C.cliente.channel('op-revisoes-' + op.id + '-' + Date.now());
      est.canal.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'relato_revisoes', filter: 'operacao_id=eq.' + op.id }, function (ev) {
        if (!ev || !ev.new || !P.op() || ev.new.operacao_id !== P.op().id) return;
        aplicar([ev.new]);
        clearTimeout(est.timer);
        est.timer = setTimeout(avisar, 150);
      });
      est.canal.subscribe();
    } catch (e) { /* sem tempo real: recarrega ao abrir */ }
    return carga;
  }

  function parar() {
    clearTimeout(est.timer);
    if (est.canal) { try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ } }
    est.canal = null; est.opId = null; est.porMensagem = new Map(); est.ausente = false; est.erro = null;
  }

  function versoes(id) { return est.porMensagem.get(id) || []; }
  function ultima(id) { var v = versoes(id); return v.length ? v[v.length - 1] : null; }
  function estado(id) { var u = ultima(id); return u ? u.estado : 'pendente'; }

  /* ---------- Peças para o painel ---------------------------------------- */
  // Selo do estado. Sem revisão: "não revisado".
  function selo(m) {
    if (!ehRelato(m) || est.ausente) return null;
    var u = ultima(m.id);
    if (!u) return el('span', { classe: 'selo selo-neutro selo-revisao', title: 'Ninguém revisou este relato ainda', texto: 'Não revisado' });
    var e = ESTADOS[u.estado] || ESTADOS.pendente;
    return el('span', { classe: 'selo selo-revisao ' + e.classe, title: 'Revisado por ' + u.revisado_por_nome + ' às ' + C.hora(u.revisado_em, false) + (u.nota ? ': ' + u.nota : ''), texto: e.rotulo });
  }

  function textoFato(u) {
    if (!u || (!u.fato_em && u.fato_origem !== 'desconhecido')) return 'não informado';
    if (!u.fato_em) return 'desconhecido';
    return C.hora(u.fato_em) + ' (' + (ORIGENS[u.fato_origem] || 'informado') + ')';
  }

  // Os três horários (fato, recebido, revisado) em blocos curtos.
  function horarios(m) {
    var u = ultima(m.id);
    function kv(rot, val, sub) {
      return el('div', { classe: 'kv' }, [el('dt', { texto: rot }), el('dd', { classe: val === 'não informado' ? 'kv-vazio' : null }, [val, sub ? el('small', { classe: 'muted kv-sub', texto: sub }) : null])]);
    }
    return el('dl', { classe: 'kv-grade revisao-horas' }, [
      kv('Fato', textoFato(u), u && u.fato_em ? null : 'quando aconteceu'),
      kv('Recebido', C.hora(m.criada_em, false), C.idade(m.criada_em)),
      kv('Revisado', u ? C.hora(u.revisado_em, false) : '—', u ? u.revisado_por_nome + ' · v' + u.versao : 'ainda não'),
    ]);
  }

  function historico(m) {
    var v = versoes(m.id).slice().reverse();
    if (!v.length) return null;
    return el('details', { classe: 'revisao-historico' }, [
      el('summary', { texto: 'Versões da revisão (' + v.length + ')' }),
      el('ol', { reversed: true }, v.map(function (r) {
        var e = ESTADOS[r.estado] || ESTADOS.pendente;
        return el('li', null, [
          el('strong', { texto: 'v' + r.versao + ' · ' + e.rotulo }),
          ' — ' + r.revisado_por_nome + ', ' + C.hora(r.revisado_em, false),
          r.fato_em || r.fato_origem === 'desconhecido' ? ' · fato: ' + textoFato(r) : '',
          r.nota ? el('div', { classe: 'muted', texto: r.nota }) : null,
        ]);
      })),
    ]);
  }

  function dataLocal(ms) {
    var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------- Formulário de revisão -------------------------------------- */
  // o.aoSalvar: chamado depois de gravar (ex.: reabrir o relato)
  function abrir(m, o) {
    o = o || {};
    if (!ehRelato(m)) return;
    if (est.ausente) { UI.aviso('A revisão de relatos ainda não está no servidor: rode a migração 042 no Supabase.', 'erro', 8000); return; }
    var u = ultima(m.id);
    var escolhido = u ? u.estado : 'em_analise';
    var erro = el('p', { classe: 'erro-form', hidden: true });
    var nota = el('textarea', { classe: 'campo', id: 'rev-nota', maxlength: '500', rows: '3', placeholder: 'Como foi verificado, quem viu, por que não vale…' });
    var campoNota = UI.campo('Justificativa', nota, { para: 'rev-nota' });
    var rotNota = campoNota.querySelector('label');
    function ajustarNota() {
      var obrig = COM_JUSTIFICATIVA.indexOf(escolhido) !== -1;
      rotNota.firstChild.textContent = obrig ? 'Justificativa (obrigatória)' : 'Observação';
    }
    var opcoes = UI.escolhas('rev-estado', Object.keys(ESTADOS).map(function (k) {
      return { valor: k, rotulo: ESTADOS[k].rotulo, sub: ESTADOS[k].sub, marcado: k === escolhido };
    }), function (v) { escolhido = v; ajustarNota(); });
    var fato = el('input', { classe: 'campo', id: 'rev-fato', type: 'datetime-local', value: u && u.fato_em ? dataLocal(C.paraMs(u.fato_em)) : '' });
    var origem = el('select', { classe: 'campo', id: 'rev-origem' }, [
      ['informado', 'Informado por alguém'], ['estimado', 'Estimado'], ['gps', 'Pelo GPS / foto'], ['desconhecido', 'Desconhecido'],
    ].map(function (x) { return el('option', { value: x[0], selected: u && u.fato_origem === x[0] ? true : null, texto: x[1] }); }));
    var btnSalvar = el('button', { classe: 'btn btn-escuro', type: 'submit', texto: 'Salvar revisão' });
    var form = el('form', { classe: 'form-revisao', novalidate: true }, [
      el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, ['Revisar relato', UI.dica('Cada revisão é uma versão nova; as anteriores ficam no histórico. Indicação não é confirmação: confirme só com outro meio.')]),
      el('p', { classe: 'relato-texto', texto: m.texto || '(sem texto)' }),
      horarios(m),
      UI.secao('Estado', [opcoes]),
      campoNota,
      UI.secao('Quando o fato aconteceu', [UI.grade([
        UI.campo('Data e hora', fato, { para: 'rev-fato', opcional: true, ajuda: 'Em branco: não informado (não é a hora do envio).' }),
        UI.campo('Origem da hora', origem, { para: 'rev-origem' }),
      ])], { dica: 'Diferente da hora em que o relato chegou e da hora da posição GPS.' }),
      historico(m),
      erro,
      UI.rodape([el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btnSalvar]),
    ]);
    ajustarNota();
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var texto = nota.value.trim();
      if (COM_JUSTIFICATIVA.indexOf(escolhido) !== -1 && !texto) {
        erro.textContent = 'Escreva a justificativa: como foi verificado ou por que não vale.';
        erro.hidden = false; nota.focus(); return;
      }
      var fatoIso = null;
      if (fato.value) { var d = new Date(fato.value); if (!isNaN(d)) fatoIso = d.toISOString(); }
      btnSalvar.disabled = true;
      try {
        var r = await C.rpc('revisar_relato', { p_mensagem: m.id, p_estado: escolhido, p_nota: texto, p_fato_em: fatoIso, p_fato_origem: fatoIso || origem.value === 'desconhecido' ? origem.value : null });
        aplicar([r]);
        avisar();
        UI.aviso('Revisão salva (versão ' + r.versao + ').', 'ok');
        fechar();
        if (o.aoSalvar) o.aoSalvar(r);
      } catch (e) {
        erro.textContent = C.traduzirErro(e);
        erro.hidden = false;
        btnSalvar.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form);
  }

  // Resumo para relatório e painel de qualidade: quantos relatos em cada estado.
  function resumo(mensagens) {
    var r = { total: 0, porEstado: {} };
    Object.keys(ESTADOS).forEach(function (k) { r.porEstado[k] = 0; });
    r.naoRevisados = 0;
    (mensagens || []).forEach(function (m) {
      if (!ehRelato(m)) return;
      r.total++;
      if (!ultima(m.id)) r.naoRevisados++;
      r.porEstado[estado(m.id)]++;
    });
    return r;
  }

  window.RelatosRevisao = {
    iniciar: iniciar, parar: parar, recarregar: carregar, abrir: abrir, selo: selo, horarios: horarios, historico: historico,
    estado: estado, ultima: ultima, versoes: versoes, resumo: resumo, ehRelato: ehRelato, ESTADOS: ESTADOS,
    aoMudar: function (f) { est.ouvintes.push(f); },
    disponivel: function () { return !est.ausente; },
  };
  // operação aberta antes deste arquivo carregar: começa agora
  if (P.op && P.op() && !est.opId) iniciar();
})();
