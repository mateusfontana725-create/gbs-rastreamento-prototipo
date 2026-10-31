/* =====================================================================
 * Painel de comando SCI numa janela própria (sci.html?op=<id>).
 * Para o comando remoto acompanhar pelo celular e para um segundo monitor no PC.
 * Usa a mesma sessão do painel; sem sessão, pede o login de responsável.
 * sci.html?op=<id>&imprimir=1 abre e imprime (salvar em PDF pelo navegador).
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI;
  var corpo = document.getElementById('sci-corpo'), aviso = document.getElementById('sci-aviso'), login = document.getElementById('sci-login');
  var params = new URLSearchParams(location.search);
  var opId = params.get('op');

  function avisar(t) { aviso.textContent = t; aviso.hidden = false; corpo.innerHTML = ''; }

  async function abrir() {
    login.hidden = true;
    try {
      var op = await C.consultar(C.cliente.from('operacoes').select('*').eq('id', opId).maybeSingle());
      if (!op) { avisar('Operação não encontrada ou sem permissão de acesso (só os responsáveis da operação e os administradores veem o SCI).'); return; }
      var setores = [];
      var lerSetores = async function () {
        try { setores = (await C.consultar(C.cliente.from('setores').select('id,nome,status,equipe,cor').eq('operacao_id', opId).order('nome'))) || []; } catch (e) { /* sem setores */ }
      };
      await lerSetores();
      document.title = 'SCI · ' + op.codigo;
      var ctx = { op: op, janela: true, podeAlterar: function () { return op.status === 'ativa'; }, setores: function () { return setores; } };
      window.SCI.montar(corpo, ctx);
      // situação da operação (encerrada?) e setores, a cada minuto
      setInterval(async function () {
        try { var o = await C.consultar(C.cliente.from('operacoes').select('*').eq('id', opId).maybeSingle()); if (o) Object.assign(op, o); } catch (e) { /* tenta de novo */ }
        lerSetores();
      }, 60000);
      if (params.get('imprimir') === '1') {
        var n = 0, t = setInterval(function () {
          if (document.querySelector('.sci-secao') || ++n > 40) { clearInterval(t); setTimeout(function () { window.print(); }, 600); }
        }, 250);
      }
    } catch (e) {
      avisar(e.message || 'Não foi possível abrir o painel SCI.');
    }
  }

  async function iniciar() {
    if (!C || !C.cliente) { avisar('Não foi possível conectar ao banco. Verifique a internet e abra de novo.'); return; }
    if (!opId || !/^[0-9a-f-]{36}$/i.test(opId)) { avisar('Link incompleto: falta a operação.'); return; }
    var sessao = null;
    try { sessao = (await C.cliente.auth.getSession()).data.session; } catch (e) { sessao = null; }
    if (sessao && !(sessao.user && sessao.user.is_anonymous)) { abrir(); return; }
    login.hidden = false;
    login.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var erro = document.getElementById('sci-login-erro');
      erro.hidden = true;
      var b = document.getElementById('sci-entrar');
      b.disabled = true;
      try {
        var r = await C.cliente.auth.signInWithPassword({ email: document.getElementById('sci-email').value.trim(), password: document.getElementById('sci-senha').value });
        if (r.error) throw r.error;
        abrir();
      } catch (e) {
        erro.textContent = 'E-mail ou senha incorretos.';
        erro.hidden = false;
      } finally { b.disabled = false; }
    });
  }
  iniciar();
})();
