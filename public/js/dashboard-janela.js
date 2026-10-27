/* =====================================================================
 * Dashboard numa janela própria (dashboard.html). Só mostra o dashboard:
 *   dashboard.html          → dashboard geral (todas as operações a que você tem acesso)
 *   dashboard.html?op=<id>  → dashboard de uma operação
 * Usa a mesma sessão do painel (mesma origem), então quem já entrou não precisa entrar de novo.
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

  async function iniciar() {
    var op = new URLSearchParams(location.search).get('op');
    if (!C || !C.cliente) {
      avisar('Não foi possível conectar ao banco. Verifique a internet e abra o dashboard de novo.');
      return;
    }
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
      sub.textContent = 'Números desta operação, sem dados pessoais';
      document.title = 'Dashboard · ' + o.codigo;
      window.Dashboard.operacao(o, corpo);
    } catch (e) {
      avisar(e.message || 'Não foi possível abrir o dashboard.');
    }
  }

  iniciar();
})();
