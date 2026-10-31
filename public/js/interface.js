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
  // Estrutura igual em todo o app: cabeçalho fixo (título, "i" e ×), corpo que rola e rodapé
  // (.form-rodape) sempre à vista. O título (#modal-titulo) é levado para o cabeçalho, mesmo
  // quando o conteúdo é redesenhado. No celular o modal vira uma folha que sobe de baixo.
  // opcoes.tamanho: 'estreito' | 'largo' | 'cheio' (padrão: médio).
  // opcoes.rodape: nó fixo embaixo do modal, fora da área que rola (ações sempre à vista).
  function abrirModal(conteudo, opcoes) {
    opcoes = opcoes || {};
    if (!opcoes.empilhar) fecharTodos();
    var anterior = document.activeElement;
    var btnX = el('button', { classe: 'modal-x', type: 'button', 'aria-label': 'Fechar', title: 'Fechar', texto: '×' });
    var cabeca = el('div', { classe: 'modal-cabeca' }, [btnX]);
    var corpo = el('div', { classe: 'modal-corpo' }, [conteudo]);
    var caixa = el('div', { classe: 'modal form-padrao' + (opcoes.tamanho ? ' modal-' + opcoes.tamanho : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-titulo' }, [cabeca, corpo].concat(opcoes.rodape ? [opcoes.rodape] : []));
    var fundo = el('div', { classe: 'modal-fundo' }, [caixa]);
    fundo.addEventListener('click', function (ev) {
      if (ev.target === fundo && opcoes.fecharNoFundo !== false) fechar(null);
    });
    // × faz o mesmo que o "Fechar"/"Cancelar" do rodapé (quando há), senão só fecha
    btnX.addEventListener('click', function () {
      var b = botaoDeSaida();
      if (b) b.click(); else fechar(null);
    });
    function botaoDeSaida() {
      var f = corpo.querySelector('button.so-x');
      if (f) return f;
      var bs = corpo.querySelectorAll('.form-rodape > button, .modal-acoes > button');
      for (var i = 0; i < bs.length; i++) if (/^cancelar$/i.test(bs[i].textContent.trim())) return bs[i];
      return null;
    }
    // Título para o cabeçalho; botões "Fechar" somem (o × faz o mesmo, chamando o próprio botão)
    function arrumar() {
      var t = corpo.querySelector('#modal-titulo');
      if (t) {
        Array.prototype.forEach.call(cabeca.querySelectorAll('#modal-titulo'), function (v) { if (v !== t) v.remove(); });
        cabeca.insertBefore(t, btnX);
      }
      cabeca.classList.toggle('sem-titulo', !cabeca.querySelector('#modal-titulo'));
      Array.prototype.forEach.call(corpo.querySelectorAll('button'), function (b) {
        if (/^fechar$/i.test(b.textContent.trim())) b.classList.add('so-x');
      });
      Array.prototype.forEach.call(corpo.querySelectorAll('.form-rodape, .modal-acoes'), function (r) {
        var visiveis = Array.prototype.filter.call(r.children, function (b) { return !b.hidden && !b.classList.contains('so-x'); });
        r.classList.toggle('rodape-vazio', visiveis.length === 0);
      });
    }
    arrumar();
    var obs = window.MutationObserver ? new MutationObserver(function () { obs.disconnect(); arrumar(); obs.observe(corpo, { childList: true, subtree: true }); }) : null;
    if (obs) obs.observe(corpo, { childList: true, subtree: true });
    function tecla(ev) {
      // Esc fecha só o modal de cima
      if (ev.key === 'Escape' && pilha.length && pilha[pilha.length - 1].fechar === fechar) { ev.preventDefault(); fechar(null); }
    }
    document.addEventListener('keydown', tecla);
    document.body.appendChild(fundo);
    var foco = corpo.querySelector('[autofocus]') || corpo.querySelector('textarea, input:not([type=hidden]), select, button:not(.dica)') || btnX;
    if (foco) setTimeout(function () { foco.focus(); }, 30);

    function fechar(valor) {
      if (!fundo.parentNode) return;
      if (obs) obs.disconnect();
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
      filhos.push(rodape([btnCancelar, btnOk]));
      var resolvido = false;
      var fechar = abrirModal(el('div', null, filhos), {
        tamanho: o.campo || o.detalhe ? null : 'estreito',
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

  // Campo com rótulo (opcionalmente com "i") e controle. Opções: para (id do controle), dica, ajuda (linha curta), opcional, largo, oculto
  function campo(rotulo, controle, o) {
    o = o || {};
    return el('div', { classe: 'campo-bloco' + (o.largo ? ' campo-largo' : ''), hidden: o.oculto ? true : null }, [
      el('label', { classe: 'rotulo', for: o.para || null }, [rotulo, o.opcional ? el('span', { classe: 'rotulo-opcional', texto: 'opcional' }) : null, o.dica ? dica(o.dica) : null]),
      controle,
      o.ajuda ? el('small', { classe: 'muted', texto: o.ajuda }) : null,
    ]);
  }

  // Grade de campos: 2 colunas no computador, 1 no celular (ver estilos.css)
  function grade(filhos, o) {
    return el('div', { classe: 'form-grade' + (o && o.tres ? ' form-grade-3' : '') }, filhos);
  }

  // Seção em cartão com título pequeno (como as linhas do POA/POD). o.dica: explicação no "i"
  function secao(titulo, filhos, o) {
    o = o || {};
    return el('div', { classe: 'secao-form' + (o.classe ? ' ' + o.classe : ''), hidden: o.oculto ? true : null }, [
      titulo ? el('div', { classe: 'secao-titulo' }, [titulo, o.dica ? dica(o.dica) : null]) : null,
    ].concat(filhos));
  }

  // Escolha única em cartões lado a lado. opcoes: [{ valor, rotulo, sub, marcado, desabilitado }]
  function escolhas(nome, opcoes, aoMudar) {
    return el('div', { classe: 'escolhas', role: 'radiogroup' }, opcoes.map(function (op) {
      var r = el('input', { type: 'radio', name: nome, value: op.valor, checked: op.marcado ? true : null, disabled: op.desabilitado ? true : null });
      if (aoMudar) r.addEventListener('change', function () { if (r.checked) aoMudar(op.valor); });
      return el('label', { classe: 'escolha' }, [r, el('span', null, [op.rotulo, op.sub ? el('small', { texto: op.sub }) : null])]);
    }));
  }

  // Rodapé: botões à direita, o secundário à esquerda. Recebe os botões já criados, na ordem visual.
  function rodape(botoes) {
    return el('div', { classe: 'form-rodape' }, botoes);
  }

  /*
   * Tela do jeito de quem usa (guardada neste aparelho; não muda nada para os outros nem no servidor):
   * tamanho do texto, quais botões ficam no topo e em que ordem (o resto fica em Ferramentas),
   * e canto do painel de grupos no mapa.
   * O modo "Personalizar tela" (js/personalizar.js) muda isto arrastando os botões.
   */
  var CHAVE_APARENCIA = 'gbs-aparencia';
  var FONTES = { minimo: 'Mínimo', menor: 'Menor', normal: 'Normal', maior: 'Maior', grande: 'Grande' };
  var LETRAS = { industrial: 'Industrial', tecnica: 'Técnica', sistema: 'Do aparelho' };
  var POSICOES_GRUPOS = { topright: 'Canto superior direito', topleft: 'Canto superior esquerdo', bottomright: 'Canto inferior direito', bottomleft: 'Canto inferior esquerdo' };
  var LADOS_ACOES = { topo: 'No topo', direita: 'Lateral direita' };
  function listaTexto(v) { return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string'; }) : []; }
  function lerAparencia() {
    var v;
    try { v = JSON.parse(localStorage.getItem(CHAVE_APARENCIA) || 'null') || {}; } catch (e) { v = {}; }
    if (typeof v !== 'object') v = {};
    return {
      fonte: FONTES[v.fonte] ? v.fonte : 'normal',
      letra: LETRAS[v.letra] ? v.letra : 'industrial',
      topo: Array.isArray(v.topo) ? listaTexto(v.topo) : null,   // null = o padrão da página
      gruposPos: POSICOES_GRUPOS[v.gruposPos] ? v.gruposPos : 'topright',
      acoesLado: LADOS_ACOES[v.acoesLado] ? v.acoesLado : 'topo',
      topoOculto: v.topoOculto === true,
      // versão anterior (escolhas por botão): convertida em "topo" na primeira leitura
      ocultos: listaTexto(v.ocultos), noMenu: listaTexto(v.noMenu), ordem: listaTexto(v.ordem),
    };
  }
  var ouvintes = [];
  function gravarAparencia(v) {
    try {
      localStorage.setItem(CHAVE_APARENCIA, JSON.stringify({ fonte: v.fonte, letra: v.letra, topo: v.topo, gruposPos: v.gruposPos, acoesLado: v.acoesLado, topoOculto: v.topoOculto }));
    } catch (e) { /* sem armazenamento: vale só até recarregar */ memoria = v; }
    aplicarAparencia(v);
  }
  var memoria = null;
  function atual() { return memoria || lerAparencia(); }
  function aplicarAparencia(v) {
    v = v || atual();
    document.documentElement.setAttribute('data-fonte', v.fonte);
    document.documentElement.setAttribute('data-letra', v.letra || 'industrial');
    document.documentElement.classList.toggle('topo-oculto', Boolean(v.topoOculto));
    document.documentElement.classList.toggle('acoes-lado-direita', v.acoesLado === 'direita');
    ouvintes.forEach(function (f) { try { f(v); } catch (e) { /* um ouvinte com erro não para os outros */ } });
  }
  function mudar(fn) { var v = atual(); fn(v); gravarAparencia(v); }
  var aparencia = {
    ler: atual,
    fontes: FONTES,
    letras: LETRAS,
    definirLetra: function (l) { mudar(function (v) { v.letra = LETRAS[l] ? l : 'industrial'; }); },
    posicoesGrupos: POSICOES_GRUPOS,
    definirFonte: function (f) { mudar(function (v) { v.fonte = FONTES[f] ? f : 'normal'; }); },
    // Botões do topo (ids na ordem). padrao: os ids que a página põe no topo quando não há escolha.
    topo: function (padrao) {
      var v = atual();
      if (v.topo) return v.topo.slice();
      var fora = (v.ocultos || []).concat(v.noMenu || []);
      var ordem = (v.ordem || []).filter(function (id) { return padrao.indexOf(id) !== -1; });
      return ordem.concat(padrao.filter(function (id) { return ordem.indexOf(id) === -1; })).filter(function (id) { return fora.indexOf(id) === -1; });
    },
    definirTopo: function (ids) { mudar(function (v) { v.topo = listaTexto(ids); }); },
    definirPosicaoGrupos: function (pos) { mudar(function (v) { v.gruposPos = POSICOES_GRUPOS[pos] ? pos : 'topright'; }); },
    posicaoGrupos: function () { return atual().gruposPos; },
    // Botões de ação: no topo ou numa coluna à direita do mapa (só em tela de tablet ou maior)
    ladosAcoes: LADOS_ACOES,
    acoesLado: function () { return atual().acoesLado; },
    definirAcoesLado: function (l) { mudar(function (v) { v.acoesLado = LADOS_ACOES[l] ? l : 'topo'; }); },
    // Cabeçalho recolhido: ganha altura para o mapa (um botão ▼ no topo traz de volta)
    topoOculto: function () { return atual().topoOculto; },
    definirTopoOculto: function (b) { mudar(function (v) { v.topoOculto = b === true; }); },
    restaurar: function () { memoria = null; gravarAparencia({ fonte: 'normal', letra: 'industrial', topo: null, gruposPos: 'topright', acoesLado: 'topo', topoOculto: false }); },
    aoMudar: function (f) { ouvintes.push(f); },
    aplicar: function () { aplicarAparencia(); },
  };
  aplicarAparencia();

  window.UI = { el: el, aviso: aviso, abrirModal: abrirModal, fecharModal: fecharModal, fecharTodos: fecharTodos, confirmar: confirmar,
    dica: dica, campo: campo, grade: grade, rodape: rodape, secao: secao, escolhas: escolhas, aparencia: aparencia };
})();
