/* =====================================================================
 * acesso.js — código de acesso da operação e pedidos de acesso (migração 069)
 *   Quem já tem o aplicativo digita o código da operação e pede para entrar. O pedido chega aqui: o responsável
 *   aceita (como civil ou como bombeiro) ou recusa. O link e o QR Code continuam entrando direto.
 *   - painelCodigo(): o código em letras grandes, copiar, trocar e ligar/desligar (aba "Código" do Convidar).
 *   - botão "🔑 N" no topo (só quando há pedido esperando) e o item "Pedidos de acesso" em Ferramentas.
 *   - abrir(): a lista de pedidos com Aceitar como civil / como bombeiro / Recusar.
 *   Tempo real pela tabela pedidos_acesso (com conferência a cada 30 s). Usa window.Painel (comando.js).
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI, P = window.Painel;
  if (!C || !UI || !P) return;
  var el = UI.el;

  var est = { opId: null, pedidos: new Map(), canal: null, timer: null, timerCarga: null, ausente: false, carregou: false, vistos: null, renderAtual: null };

  function podeAlterar() { return Boolean(P.podeAlterar && P.podeAlterar()); }
  function pendentes() {
    return Array.from(est.pedidos.values()).filter(function (p) { return p.status === 'pendente'; })
      .sort(function (a, b) { return C.paraMs(a.criado_em) - C.paraMs(b.criado_em); });
  }

  function telefoneBonito(t) {
    var d = String(t || '').replace(/\D/g, '');
    if (d.length === 13 && d.indexOf('55') === 0) d = d.slice(2);
    if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
    if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
    return t || '';
  }
  function cpfBonito(c) {
    var d = String(c || '').replace(/\D/g, '');
    return d.length === 11 ? d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-' + d.slice(9) : c || '';
  }
  // ABC234 → "ABC 234" (mais fácil de ler e de ditar pelo rádio)
  function codigoLegivel(c) { return c ? c.slice(0, 3) + ' ' + c.slice(3) : '—'; }

  function ehTabelaAusente(e) {
    return /pedidos_acesso|schema cache|does not exist|42P01|PGRST205|PGRST200/i.test(String((e && (e.message || e.codigo)) || '') + ' ' + String((e && e.original && e.original.message) || ''));
  }

  /* ---------- Carga e tempo real ---------------------------------------- */
  async function carregar() {
    if (!est.opId || est.ausente) return;
    var opId = est.opId;
    try {
      var lista = await C.consultarTudo(function () {
        return C.cliente.from('pedidos_acesso').select('*').eq('operacao_id', opId).order('criado_em', { ascending: false });
      });
      if (est.opId !== opId) return;
      var mapa = new Map();
      lista.forEach(function (p) { mapa.set(p.id, p); });
      est.pedidos = mapa;
      var novos = pendentes().filter(function (p) { return est.vistos && !est.vistos.has(p.id); });
      if (!est.vistos) est.vistos = new Set();
      pendentes().forEach(function (p) { est.vistos.add(p.id); });
      if (novos.length && est.carregou) {
        UI.aviso(novos.length === 1 ? novos[0].nome + ' pediu para entrar na operação.' : novos.length + ' pessoas pediram para entrar na operação.', 'ok', 9000);
      }
      est.carregou = true;
      atualizarPilula();
      if (est.renderAtual) est.renderAtual();
    } catch (e) {
      if (ehTabelaAusente(e)) { est.ausente = true; atualizarPilula(); }
    }
  }

  function assinar() {
    if (!est.opId || est.ausente) return;
    var opId = est.opId;
    if (est.canal) { try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ } }
    try {
      est.canal = C.cliente.channel('op-pedidos-acesso-' + opId + '-' + Date.now())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos_acesso', filter: 'operacao_id=eq.' + opId }, function () {
          clearTimeout(est.timerCarga);
          est.timerCarga = setTimeout(carregar, 400);
        })
        .subscribe(function (status) {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            setTimeout(function () { if (est.opId === opId) assinar(); }, 60000);
          }
        });
    } catch (e) { /* sem tempo real: a conferência periódica atualiza */ }
  }

  function iniciar() {
    parar();
    var op = P.op();
    if (!op || op.status !== 'ativa') return;
    est.opId = op.id;
    var carga = carregar();
    assinar();
    est.timer = setInterval(carregar, 30000);
    return carga;
  }

  function parar() {
    clearInterval(est.timer); clearTimeout(est.timerCarga);
    if (est.canal) { try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ } }
    est.canal = null; est.opId = null; est.pedidos = new Map(); est.ausente = false; est.carregou = false; est.vistos = null; est.renderAtual = null;
    atualizarPilula();
  }

  function atualizarPilula() {
    var n = pendentes().length;
    var op = P.op && P.op();
    var btn = document.getElementById('btn-pedidos');
    if (btn) {
      btn.hidden = !n || est.ausente || !op || op.status !== 'ativa';
      var q = document.getElementById('pedidos-qtd');
      if (q) q.textContent = String(n);
    }
    var m = document.getElementById('menu-acesso-qtd');
    if (m) m.textContent = n ? n + ' esperando' : '';
  }

  /* ---------- Decisão ---------------------------------------------------- */
  async function decidir(p, aceitar, tipo) {
    try {
      await C.rpc('decidir_pedido_acesso', { p_pedido: p.id, p_aceitar: aceitar, p_tipo: tipo || 'civil' });
      UI.aviso(aceitar ? p.nome + ' pode entrar na operação.' : 'Pedido de ' + p.nome + ' recusado.', 'ok');
      await carregar();
    } catch (e) {
      UI.aviso(e.message, 'erro', 8000);
      await carregar();
    }
  }

  function linhaPedido(p, editavel) {
    var quando = C.hora(p.criado_em, false);
    var dados = el('div', { classe: 'acesso-dados' }, [
      el('strong', { classe: 'acesso-nome', texto: p.nome }),
      el('span', { classe: 'muted', texto: 'pediu às ' + quando }),
      p.telefone ? el('a', { classe: 'acesso-tel', href: 'tel:+55' + String(p.telefone).replace(/\D/g, '').replace(/^55/, ''), texto: '☎ ' + telefoneBonito(p.telefone) }) : null,
      p.cpf ? el('span', { classe: 'muted mono', texto: 'CPF ' + cpfBonito(p.cpf) }) : null,
    ]);
    var acoes = null;
    if (p.status === 'pendente' && editavel) {
      acoes = el('div', { classe: 'acesso-acoes' }, [
        el('button', { classe: 'btn btn-escuro btn-pequeno', type: 'button', 'data-acao': 'aceitar-civil', texto: '● Aceitar como civil', onclick: function () { decidir(p, true, 'civil'); } }),
        el('button', { classe: 'btn btn-pequeno', type: 'button', 'data-acao': 'aceitar-militar', texto: '■ Aceitar como bombeiro', onclick: function () { decidir(p, true, 'militar'); } }),
        el('button', { classe: 'btn btn-pequeno btn-perigo', type: 'button', 'data-acao': 'recusar', texto: 'Recusar', onclick: function () { decidir(p, false); } }),
      ]);
    } else if (p.status === 'recusado' && editavel) {
      acoes = el('div', { classe: 'acesso-acoes' }, [
        el('button', { classe: 'btn btn-pequeno', type: 'button', 'data-acao': 'aceitar-civil', texto: 'Aceitar mesmo assim (civil)', onclick: function () { decidir(p, true, 'civil'); } }),
        el('button', { classe: 'btn btn-pequeno', type: 'button', 'data-acao': 'aceitar-militar', texto: 'Aceitar como bombeiro', onclick: function () { decidir(p, true, 'militar'); } }),
      ]);
    }
    var rotulo = { pendente: ['selo-alerta', 'Esperando'], aceito: ['selo-ok', 'Aceito' + (p.tipo_concedido === 'militar' ? ' (bombeiro)' : ' (civil)')], recusado: ['selo-perigo', 'Recusado'], cancelado: ['selo-neutro', 'Desistiu'] }[p.status] || ['selo-neutro', p.status];
    return el('li', { classe: 'acesso-pedido acesso-' + p.status, 'data-pedido': p.id }, [
      el('div', { classe: 'acesso-topo' }, [dados, el('span', { classe: 'selo ' + rotulo[0], texto: rotulo[1] })]),
      p.decidido_por_nome && p.status !== 'pendente' ? el('p', { classe: 'muted acesso-por', texto: 'por ' + p.decidido_por_nome + (p.decidido_em ? ' às ' + C.hora(p.decidido_em, false) : '') }) : null,
      acoes,
    ]);
  }

  function abrir() {
    var op = P.op();
    if (!op) return;
    var corpo = el('div', { classe: 'acesso-corpo' });
    function desenhar() {
      corpo.innerHTML = '';
      var editavel = podeAlterar();
      if (est.ausente) {
        corpo.appendChild(el('p', { classe: 'muted', texto: 'O servidor ainda não tem o pedido de acesso por código (migração 069). Peça ao administrador para aplicá-la.' }));
        return;
      }
      var abertos = pendentes();
      var decididos = Array.from(est.pedidos.values()).filter(function (p) { return p.status !== 'pendente'; })
        .sort(function (a, b) { return C.paraMs(b.decidido_em || b.atualizado_em) - C.paraMs(a.decidido_em || a.atualizado_em); }).slice(0, 15);
      corpo.appendChild(el('h3', { classe: 'acesso-sub', texto: 'Esperando uma resposta (' + abertos.length + ')' }));
      if (!abertos.length) corpo.appendChild(el('p', { classe: 'muted', id: 'acesso-vazio', texto: 'Nenhum pedido esperando. Quem digitar o código no aplicativo aparece aqui na hora.' }));
      else corpo.appendChild(el('ul', { classe: 'acesso-lista', id: 'acesso-lista' }, abertos.map(function (p) { return linhaPedido(p, editavel); })));
      if (decididos.length) {
        corpo.appendChild(el('h3', { classe: 'acesso-sub', texto: 'Já respondidos' }));
        corpo.appendChild(el('ul', { classe: 'acesso-lista acesso-lista-feitos' }, decididos.map(function (p) { return linhaPedido(p, editavel); })));
      }
    }
    est.renderAtual = desenhar;
    var fechar = UI.abrirModal(el('div', { classe: 'form-padrao acesso-modal' }, [
      el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Pedidos de acesso' }, [UI.dica('Quem já tem o aplicativo digita o código da operação e pede para entrar. Só entra depois que você aceitar. O link e o QR Code do Convidar continuam entrando direto.')]),
      el('div', { classe: 'acesso-codigo-resumo' }, [
        el('span', { classe: 'muted', texto: 'Código da operação' }),
        el('strong', { classe: 'acesso-codigo-mini mono', id: 'acesso-codigo-mini', texto: op.codigo_acesso_ativo === false ? 'desligado' : codigoLegivel(op.codigo_acesso) }),
        el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'acesso-ver-codigo', texto: 'Ver / trocar', onclick: function () { fechar(); P.abrirConvite('codigo'); } }),
      ]),
      corpo,
      UI.rodape([el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]));
    desenhar();
    return carregar();
  }

  /* ---------- Código da operação (aba do Convidar) ------------------------ */
  function painelCodigo() {
    var op = P.op();
    var caixa = el('div', { classe: 'acesso-codigo-painel', id: 'painel-codigo-acesso' });
    async function mudar(args, aviso) {
      try {
        var r = await C.rpc('definir_codigo_acesso', Object.assign({ p_operacao: op.id }, args));
        op.codigo_acesso = r.codigo_acesso;
        op.codigo_acesso_ativo = r.codigo_acesso_ativo;
        desenhar();
        if (aviso) UI.aviso(aviso, 'ok');
      } catch (e) { UI.aviso(e.message, 'erro', 7000); }
    }
    async function copiar() {
      try { await navigator.clipboard.writeText(op.codigo_acesso); UI.aviso('Código copiado.', 'ok'); }
      catch (e) { UI.aviso('Anote o código: ' + op.codigo_acesso, 'erro'); }
    }
    function desenhar() {
      caixa.innerHTML = '';
      var ativo = op.codigo_acesso_ativo !== false;
      var editavel = podeAlterar();
      if (!op.codigo_acesso && !('codigo_acesso' in op)) {
        caixa.appendChild(el('p', { classe: 'muted', texto: 'O servidor ainda não tem o código de acesso (migração 069).' }));
        return;
      }
      caixa.appendChild(el('p', { classe: 'ajuda', texto: 'Para quem já tem o aplicativo: abrir o aplicativo, tocar em "Entrar com código", digitar este código e o nome. O pedido chega aqui e a pessoa só entra depois que você aceitar.' }));
      caixa.appendChild(el('div', { classe: 'acesso-codigo-grande' + (ativo ? '' : ' desligado'), id: 'acesso-codigo-grande', 'aria-label': 'Código de acesso ' + (op.codigo_acesso || '').split('').join(' '), texto: codigoLegivel(op.codigo_acesso) }));
      if (!ativo) caixa.appendChild(el('p', { classe: 'aviso-pequeno', texto: 'Entrada por código desligada: o aplicativo recusa este código.' }));
      caixa.appendChild(el('div', { classe: 'linha-botoes' }, [
        el('button', { classe: 'btn btn-escuro', type: 'button', id: 'acesso-copiar', texto: 'Copiar código', onclick: copiar }),
        editavel ? el('button', { classe: 'btn', type: 'button', id: 'acesso-trocar', texto: 'Trocar código', onclick: async function () {
          if (!(await UI.confirmar({ titulo: 'Trocar o código?', texto: 'O código atual para de valer na hora. Quem já entrou continua na operação.', ok: 'Trocar', empilhar: true }))) return;
          mudar({ p_trocar: true }, 'Código trocado.');
        } }) : null,
        editavel ? el('button', { classe: 'btn', type: 'button', id: 'acesso-alternar', texto: ativo ? 'Desligar entrada por código' : 'Ligar entrada por código', onclick: function () { mudar({ p_ativo: !ativo }, ativo ? 'Entrada por código desligada.' : 'Entrada por código ligada.'); } }) : null,
        el('button', { classe: 'btn', type: 'button', id: 'acesso-ver-pedidos', texto: 'Pedidos de acesso (' + pendentes().length + ')', onclick: function () { UI.fecharTodos(); abrir(); } }),
      ]));
    }
    desenhar();
    return caixa;
  }

  window.Acesso = { iniciar: iniciar, parar: parar, abrir: abrir, painelCodigo: painelCodigo, pendentes: pendentes };
})();
