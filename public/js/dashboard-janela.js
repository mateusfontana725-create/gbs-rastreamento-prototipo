/* =====================================================================
 * Dashboard numa janela própria (dashboard.html). Só mostra o dashboard:
 *   dashboard.html            → dashboard geral (todas as operações a que você tem acesso)
 *   dashboard.html?op=<id>    → dashboard de uma operação (responsável, com login)
 *   dashboard.html?p=<token>  → link público da operação: sem login, só visualização, sem nomes (migração 048)
 * Com login, usa a mesma sessão do painel (mesma origem). Os números vêm do banco (dashboard_operacao_dados),
 * os mesmos do painel, e se atualizam sozinhos.
 * ===================================================================== */
(function () {
  'use strict';

  var C = window.Comunicacao;
  var corpo = document.getElementById('janela-corpo');
  var aviso = document.getElementById('janela-aviso');
  var titulo = document.getElementById('janela-titulo');
  var sub = document.getElementById('janela-sub');

  function avisar(texto) {
    aviso.textContent = texto;
    aviso.hidden = false;
    corpo.innerHTML = '';
  }

  // Link público: sem sessão nenhuma (nem anônima); o banco só devolve leitura.
  function abrirPublico(token) {
    if (!/^[0-9a-f]{48}$/.test(token)) { avisar('Link inválido. Peça um link novo a quem enviou.'); return; }
    titulo.textContent = 'Acompanhamento da operação';
    sub.textContent = 'Somente visualização · sem nomes de pessoas';
    document.body.classList.add('dashboard-publico');
    var op = { id: null, codigo: '' };
    window.Dashboard.operacao(op, corpo, {
      publico: token,
      aoCarregar: function (dd) {
        titulo.textContent = 'Operação ' + dd.operacao.codigo;
        document.title = 'Acompanhamento · ' + dd.operacao.codigo;
      },
    }).then(function () {
      if (/link_publico_invalido|não encontrado|desligado/i.test(corpo.textContent)) avisar('Este link não funciona mais (foi trocado ou desligado). Peça o link novo a quem enviou.');
    });
  }

  async function iniciar() {
    var busca = new URLSearchParams(location.search);
    var op = busca.get('op'), token = busca.get('p');
    if (!C || !C.cliente) {
      avisar('Não foi possível conectar ao banco. Verifique a internet e abra o dashboard de novo.');
      return;
    }
    if (token) { abrirPublico(token); return; }
    var sessao = null;
    try { sessao = (await C.cliente.auth.getSession()).data.session; } catch (e) { sessao = null; }
    if (!sessao) {
      avisar('Entre na sua conta no painel principal e abra o dashboard de novo.');
      return;
    }
    if (!op) {
      titulo.textContent = 'Dashboard das operações';
      document.title = 'Dashboard · GBS';
      window.Dashboard.geral(corpo);
      return;
    }
    try {
      var o = await C.consultar(C.cliente.from('operacoes').select('*').eq('id', op).maybeSingle());
      if (!o) { avisar('Operação não encontrada ou sem permissão de acesso.'); return; }
      titulo.textContent = 'Dashboard da operação · ' + o.codigo;
      sub.textContent = 'Números desta operação, iguais aos do painel';
      document.title = 'Dashboard · ' + o.codigo;
      window.Dashboard.operacao(o, corpo, {});
    } catch (e) {
      avisar(e.message || 'Não foi possível abrir o dashboard.');
    }
  }

  iniciar();
})();
