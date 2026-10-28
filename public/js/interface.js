/* =====================================================================
 * interface.js — componentes de interface compartilhados:
 * avisos rápidos (toasts) e caixas de confirmação acessíveis.
 * ===================================================================== */
(function () {
  'use strict';

  function el(tag, attrs, filhos) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'texto') e.textContent = attrs[k];
        else if (k === 'classe') e.className = attrs[k];
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
      });
    }
    (filhos || []).forEach(function (f) {
      if (f == null) return;
      e.appendChild(typeof f === 'string' ? document.createTextNode(f) : f);
    });
    return e;
  }

  // Avisos (toasts): curtos e com botão de fechar. Quem chama pode pedir menos tempo, nunca mais que
  // 5 s (8 s para erro). Com o mouse em cima o aviso espera; no toque não (não há "sair de cima").
  // ms = 'fixo': fica até fechar no × (alertas de segurança que não aparecem em outro lugar).
  var AVISO_MAX = 5000, AVISO_MAX_ERRO = 8000;
  function aviso(texto, tipo, ms) {
    var raiz = document.getElementById('avisos');
    if (!raiz) return null;
    var erro = tipo === 'erro', fixo = ms === 'fixo';
    var dur = fixo ? null : Math.min(ms || (erro ? 6000 : 3500), erro ? AVISO_MAX_ERRO : AVISO_MAX);
    var timer = null;
    var a = el('div', { classe: 'aviso' + (tipo ? ' aviso-' + tipo : '') + (fixo ? ' aviso-fixo' : ''), role: erro ? 'alert' : 'status' }, [
      el('span', { classe: 'aviso-texto', texto: texto }),
    ]);
    function fechar() {
      clearTimeout(timer);
      if (a.parentNode) a.parentNode.removeChild(a);
    }
    a.appendChild(el('button', { classe: 'aviso-fechar', type: 'button', 'aria-label': 'Fechar aviso', title: 'Fechar', texto: '×',
      onclick: function (ev) { ev.stopPropagation(); fechar(); } }));
    if (!fixo) {
      a.addEventListener('pointerenter', function (ev) { if (ev.pointerType === 'mouse') clearTimeout(timer); });
      a.addEventListener('pointerleave', function (ev) {
        if (ev.pointerType !== 'mouse') return;
        clearTimeout(timer);
        timer = setTimeout(fechar, 2000);
      });
      timer = setTimeout(fechar, dur);
    }
    raiz.appendChild(a);
    // no máximo 3 na tela: sai o mais antigo que não seja fixo
    while (raiz.children.length > 3) {
      var velho = raiz.querySelector('.aviso:not(.aviso-fixo)') || raiz.firstChild;
      raiz.removeChild(velho);
    }
    return a;
  }

  // Pilha de modais: normalmente só um aberto; opcoes.empilhar abre por cima
  // (ex.: escolher um ponto no mapa sem perder o formulário que está embaixo).
  var pilha = [];

  // Abre um modal genérico. "conteudo" é um nó DOM. Devolve função para fechar.
  function abrirModal(conteudo, opcoes) {
    opcoes = opcoes || {};
    if (!opcoes.empilhar) fecharTodos();
    var anterior = document.activeElement;
    var caixa = el('div', { classe: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-titulo' }, [conteudo]);
    var fundo = el('div', { classe: 'modal-fundo' }, [caixa]);
    fundo.addEventListener('click', function (ev) {
      if (ev.target === fundo && opcoes.fecharNoFundo !== false) fechar(null);
    });
    function tecla(ev) {
      // Esc fecha só o modal de cima
      if (ev.key === 'Escape' && pilha.length && pilha[pilha.length - 1].fechar === fechar) { ev.preventDefault(); fechar(null); }
    }
    document.addEventListener('keydown', tecla);
    document.body.appendChild(fundo);
    var foco = caixa.querySelector('[autofocus]') || caixa.querySelector('textarea, input, button');
    if (foco) setTimeout(function () { foco.focus(); }, 30);

    function fechar(valor) {
      if (!fundo.parentNode) return;
      document.removeEventListener('keydown', tecla);
      fundo.parentNode.removeChild(fundo);
      pilha = pilha.filter(function (m) { return m.fechar !== fechar; });
      if (anterior && anterior.focus) { try { anterior.focus(); } catch (e) { /* ignora */ } }
      if (opcoes.aoFechar) opcoes.aoFechar(valor);
    }
    pilha.push({ fechar: fechar });
    return fechar;
  }

  // Fecha o modal de cima
  function fecharModal() {
    if (pilha.length) pilha[pilha.length - 1].fechar(null);
  }

  function fecharTodos() {
    while (pilha.length) {
      var antes = pilha.length;
      pilha[pilha.length - 1].fechar(null);
      if (pilha.length === antes) pilha.pop();   // salvaguarda
    }
  }

  /*
   * confirmar({ titulo, texto, detalhe, ok, cancelar, perigo, empilhar, campo: { rotulo, valor, max, obrigatorio } })
   * → Promise que resolve { texto } se confirmado, ou null se cancelado.
   */
  function confirmar(o) {
    return new Promise(function (resolve) {
      var area = null;
      var erro = el('p', { classe: 'erro-form', hidden: true });
      var filhos = [el('h2', { id: 'modal-titulo', texto: o.titulo || 'Confirmar' })];
      if (o.texto) filhos.push(el('p', { texto: o.texto }));
      if (o.detalhe) filhos.push(o.detalhe);
      if (o.campo) {
        area = el('textarea', { classe: 'campo', id: 'modal-campo', maxlength: String(o.campo.max || 500), rows: '3' });
        area.value = o.campo.valor || '';
        filhos.push(el('div', { classe: 'grupo' }, [
          el('label', { classe: 'rotulo', for: 'modal-campo', texto: o.campo.rotulo || 'Texto' }),
          area,
        ]));
      }
      filhos.push(erro);
      var btnOk = el('button', { classe: 'btn ' + (o.perigo ? 'btn-primario' : 'btn-escuro'), type: 'button', texto: o.ok || 'Confirmar' });
      var btnCancelar = el('button', { classe: 'btn', type: 'button', texto: o.cancelar || 'Cancelar', autofocus: !area });
      filhos.push(el('div', { classe: 'modal-acoes' }, [btnCancelar, btnOk]));
      var resolvido = false;
      var fechar = abrirModal(el('div', null, filhos), {
        empilhar: Boolean(o.empilhar),   // abre por cima do que está aberto (ex.: confirmar dentro de um formulário)
        aoFechar: function (v) { if (!resolvido) { resolvido = true; resolve(v || null); } },
      });
      btnCancelar.addEventListener('click', function () { fechar(null); });
      btnOk.addEventListener('click', function () {
        var texto = area ? area.value.trim() : '';
        if (o.campo && o.campo.obrigatorio && !texto) {
          erro.textContent = 'Preencha o texto.';
          erro.hidden = false;
          area.focus();
          return;
        }
        resolvido = true;
        resolve({ texto: texto });
        fechar({ texto: texto });
      });
    });
  }

  /*
   * Página aberta há muito tempo pode estar rodando uma versão antiga do
   * aplicativo (ex.: a página do participante fica aberta a busca inteira).
   * Compara a versão desta página com /versao.json e, se mudou, oferece
   * atualizar. Recarregar não perde a participação: ela retoma sozinha.
   */
  function verificarVersao() {
    var meta = document.querySelector('meta[name="gbs-versao"]');
    if (!meta || !window.fetch) return;
    var minha = meta.getAttribute('content');
    var avisado = false;
    function conferir() {
      if (avisado || document.visibilityState !== 'visible') return;
      fetch('versao.json?_=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        if (!j || !j.versao || j.versao === minha || avisado) return;
        avisado = true;
        var faixa = el('div', { classe: 'faixa-versao', role: 'status' }, [
          el('span', { texto: 'Há uma versão nova desta página.' }),
          el('button', { classe: 'btn btn-pequeno btn-escuro', type: 'button', texto: 'Atualizar agora', onclick: function () { window.GBS_RECARREGANDO = true; location.reload(); } }),
        ]);
        document.body.appendChild(faixa);
      }).catch(function () { /* sem internet: tenta depois */ });
    }
    setInterval(conferir, 5 * 60000);
    document.addEventListener('visibilitychange', conferir);
    setTimeout(conferir, 20000);
  }
  verificarVersao();

  /*
   * Padrão dos formulários e modais (usado em todo o app):
   *   - rótulo curto; a explicação vai para um ícone "i" ao lado (UI.dica), não para parágrafos;
   *   - campos em grade (UI.grade) e um rodapé com no máximo uma ação primária (UI.rodape).
   */
  // Ícone "i" com a explicação: toque ou clique abre embaixo do rótulo; o mouse mostra no título.
  function dica(texto) {
    var tip = el('span', { classe: 'dica-texto', role: 'note', hidden: true, texto: texto });
    var b = el('button', { classe: 'dica', type: 'button', 'aria-label': 'Explicação', title: texto, texto: 'i' });
    b.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); tip.hidden = !tip.hidden; });
    return el('span', { classe: 'dica-caixa' }, [b, tip]);
  }

  // Campo com rótulo (opcionalmente com "i") e controle. Opções: para (id do controle), dica, ajuda (linha curta), largo, oculto
  function campo(rotulo, controle, o) {
    o = o || {};
    return el('div', { classe: 'campo-bloco' + (o.largo ? ' campo-largo' : ''), hidden: o.oculto ? true : null }, [
      el('label', { classe: 'rotulo', for: o.para || null }, [rotulo, o.dica ? dica(o.dica) : null]),
      controle,
      o.ajuda ? el('small', { classe: 'muted', texto: o.ajuda }) : null,
    ]);
  }

  // Grade de campos: 2 colunas no computador, 1 no celular (ver estilos.css)
  function grade(filhos, o) {
    return el('div', { classe: 'form-grade' + (o && o.tres ? ' form-grade-3' : '') }, filhos);
  }

  // Rodapé: botões à direita, o secundário à esquerda. Recebe os botões já criados, na ordem visual.
  function rodape(botoes) {
    return el('div', { classe: 'form-rodape' }, botoes);
  }

  window.UI = { el: el, aviso: aviso, abrirModal: abrirModal, fecharModal: fecharModal, fecharTodos: fecharTodos, confirmar: confirmar,
    dica: dica, campo: campo, grade: grade, rodape: rodape };
})();
