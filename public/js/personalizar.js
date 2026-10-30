/* =====================================================================
 * personalizar.js — a tela do painel do jeito de quem usa (neste aparelho).
 *
 * Qualquer função das Ferramentas pode virar botão no topo, e qualquer botão do
 * topo pode voltar para Ferramentas. No modo "Personalizar tela":
 *   - arraste um botão do topo para mudar a ordem, ou para fora do topo para tirá-lo;
 *   - arraste (ou toque) uma função da bandeja para pô-la no topo;
 *   - arraste o painel de grupos para outro canto do mapa;
 *   - escolha o tamanho do texto.
 * As escolhas ficam em UI.aparencia (js/interface.js). Nada muda para as outras pessoas.
 * ===================================================================== */
(function () {
  'use strict';

  var el = UI.el;
  var ap = UI.aparencia;
  function $(id) { return document.getElementById(id); }

  // Botões que a página já põe no topo (na ordem padrão) e funções do menu que podem ir para lá.
  var PADRAO = ['menu-ponto', 'btn-registrar-foto', 'menu-setor', 'menu-trilha', 'btn-regua', 'menu-cenario', 'menu-dashboard', 'menu-sci', 'btn-mensagens', 'btn-convite'];
  var DO_MENU = ['menu-minha-trilha', 'menu-vitima', 'menu-vitima-rapida', 'menu-destino', 'menu-areas', 'menu-grupos', 'menu-missoes', 'menu-ajuda', 'menu-binomio', 'menu-drone-agua', 'menu-briefing', 'menu-dados-op',
    'menu-diario', 'menu-relatorio', 'btn-equipe', 'menu-ir-coord', 'menu-medir', 'menu-importar', 'menu-exportar', 'menu-diag-gps'];
  var TODOS = PADRAO.concat(DO_MENU);
  // A régua já tem item próprio no menu (menu-regua): fora do topo não precisa de atalho.
  var SEM_ATALHO = ['btn-regua'];

  function ehPadrao(id) { return PADRAO.indexOf(id) !== -1; }

  // Nome e ícone de cada função, lidos do próprio botão (o texto fica num lugar só: o HTML)
  function info(id) {
    var o = $(id);
    if (!o) return null;
    if (ehPadrao(id)) {
      var ico = o.querySelector('.ico-acao, .ico-camera, .ico-msg');
      var rot = o.querySelector('.rotulo-acao');
      return { rotulo: (rot || o).textContent.replace(/\s+/g, ' ').trim(), icone: ico ? ico.cloneNode(true) : null };
    }
    var spans = o.querySelectorAll(':scope > span');
    var rot = Array.prototype.filter.call(spans, function (s) { return !s.classList.contains('ico-item'); })[0];
    var i = o.querySelector('.ico-item');
    return { rotulo: rot ? rot.textContent.trim() : id, icone: el('span', { classe: 'ico-acao', 'aria-hidden': 'true', texto: i ? i.textContent : '•' }) };
  }

  // Cópias: botão no topo para função do menu; item no menu para botão do topo. Seguem o original
  // (escondido/desabilitado pela própria página, ex.: operação encerrada) e o disparam ao clicar.
  var copias = {};
  function seguir(original, copia) {
    function sync() {
      copia.hidden = original.hidden;
      copia.disabled = original.disabled;
      if (original.hasAttribute('aria-pressed')) copia.setAttribute('aria-pressed', original.getAttribute('aria-pressed'));
      copia.classList.toggle('btn-ativo', original.classList.contains('btn-ativo'));
    }
    sync();
    new MutationObserver(sync).observe(original, { attributes: true, attributeFilter: ['hidden', 'disabled', 'aria-pressed', 'class'] });
  }
  function copiaDe(id) {
    if (copias[id]) return copias[id];
    var o = $(id), i = info(id);
    if (!o || !i) return null;
    var c;
    if (ehPadrao(id)) {
      c = el('button', { classe: 'menu-item atalho-menu', type: 'button', id: 'menu-atalho-' + id, 'data-acao': id }, [
        el('span', { classe: 'ico-item', 'aria-hidden': 'true', texto: i.icone ? i.icone.textContent.trim() || '•' : '•' }), el('span', { texto: i.rotulo }),
      ]);
      var lista = document.querySelector('#menu-ferramentas .menu-lista');
      var antes = Array.prototype.filter.call(lista.children, function (x) { return !x.classList.contains('atalho-menu'); })[0];
      lista.insertBefore(c, antes || null);
    } else {
      c = el('button', { classe: 'btn btn-barra btn-pequeno btn-acao-topo atalho-topo', type: 'button', id: 'topo-' + id, 'data-acao': id, title: i.rotulo, 'aria-label': i.rotulo }, [
        i.icone, el('span', { classe: 'rotulo-acao', texto: i.rotulo }),
      ]);
      $('acoes-topo').appendChild(c);
    }
    c.addEventListener('click', function () { if (!ativo) o.click(); });
    seguir(o, c);
    copias[id] = c;
    return c;
  }
  // Elemento que representa a função no topo
  function noTopo(id) { return ehPadrao(id) ? $(id) : copiaDe(id); }

  function idsTopo() {
    return ap.topo(PADRAO).filter(function (id, i, l) { return TODOS.indexOf(id) !== -1 && l.indexOf(id) === i && $(id); });
  }

  function aplicar() {
    var topo = $('acoes-topo');
    if (!topo) return;
    var ids = idsTopo();
    TODOS.forEach(function (id) {
      var o = $(id);
      if (!o) return;
      var la = ids.indexOf(id) !== -1;
      if (ehPadrao(id)) {
        o.classList.toggle('fora-do-topo', !la);
        if (SEM_ATALHO.indexOf(id) === -1) { var a = copiaDe(id); if (a) a.classList.toggle('fora-do-menu', la); }
      } else {
        o.classList.toggle('no-topo', la);
        if (la || copias[id]) { var c = copiaDe(id); if (c) c.classList.toggle('fora-do-topo', !la); }
      }
    });
    ids.forEach(function (id) { var e = noTopo(id); if (e) topo.appendChild(e); });
    // os que saíram do topo vão para o fim (escondidos), para não atrapalhar a ordem
    Array.prototype.forEach.call(topo.querySelectorAll('.fora-do-topo'), function (e) { topo.appendChild(e); });
    // atalhos no menu na ordem padrão, antes do resto
    PADRAO.forEach(function (id) {
      var a = copias[id];
      // antes da primeira seção (ou item) que não seja atalho
      if (a && a.parentNode) a.parentNode.insertBefore(a, Array.prototype.filter.call(a.parentNode.children, function (x) { return !x.classList.contains('atalho-menu'); })[0] || null);
    });
    var ctl = window.Painel && window.Painel.controleGrupos && window.Painel.controleGrupos();
    if (ctl && ctl.getPosition() !== ap.posicaoGrupos()) ctl.setPosition(ap.posicaoGrupos());
    if (ativo) desenharBandeja();
  }

  /* ------------------------------------------------------------------ */
  /* Modo "Personalizar tela"                                            */
  /* ------------------------------------------------------------------ */
  var ativo = false, painel = null, bandeja = null, fonteSeg = null, letraSeg = null, cantos = null;

  function iniciar() {
    if (ativo) return;
    if (window.Painel && window.Painel.fecharMenu) window.Painel.fecharMenu();
    UI.fecharTodos();
    ativo = true;
    document.body.classList.add('personalizando');
    bandeja = el('div', { classe: 'pers-bandeja', id: 'pers-bandeja', role: 'list', 'aria-label': 'Funções em Ferramentas' });
    fonteSeg = el('div', { classe: 'seg pers-fonte', role: 'radiogroup', 'aria-label': 'Tamanho do texto' });
    letraSeg = el('div', { classe: 'seg pers-letra', role: 'radiogroup', 'aria-label': 'Letra' });
    cantos = el('div', { classe: 'pers-cantos', role: 'radiogroup', 'aria-label': 'Canto do painel de grupos' });
    painel = el('section', { classe: 'pers-painel', id: 'personalizar', role: 'region', 'aria-label': 'Personalizar tela' }, [
      el('div', { classe: 'pers-cabeca' }, [
        el('strong', { classe: 'titulo-com-dica' }, ['Personalizar tela', UI.dica('Arraste os botões do topo para mudar a ordem, ou para fora do topo para mandá-los para Ferramentas. ' +
          'Arraste (ou toque) uma função abaixo para pô-la no topo. No mapa, arraste o painel de grupos para outro canto. Vale só neste aparelho.')]),
        el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'pers-padrao', texto: 'Padrão', onclick: function () { ap.restaurar(); UI.aviso('Tela no padrão.', 'ok', 2500); } }),
        el('button', { classe: 'btn btn-pequeno btn-escuro', type: 'button', id: 'pers-concluir', texto: 'Concluir', onclick: concluir }),
      ]),
      el('div', { classe: 'pers-linha' }, [
        el('div', { classe: 'pers-bloco pers-bloco-bandeja' }, [el('span', { classe: 'pers-rotulo', texto: 'Em Ferramentas' }), bandeja]),
        el('div', { classe: 'pers-bloco' }, [el('span', { classe: 'pers-rotulo', texto: 'Texto' }), fonteSeg]),
        el('div', { classe: 'pers-bloco' }, [el('span', { classe: 'pers-rotulo', texto: 'Letra' }), letraSeg]),
        el('div', { classe: 'pers-bloco' }, [el('span', { classe: 'pers-rotulo', texto: 'Grupos no mapa' }), cantos]),
      ]),
    ]);
    document.body.appendChild(painel);
    marcarTopo(true);
    desenharBandeja();
    document.addEventListener('click', bloquearCliques, true);
    document.addEventListener('keydown', teclas, true);
    $('acoes-topo').addEventListener('pointerdown', aoApertarTopo);
    ligarGrupos(true);
    setTimeout(function () { var b = $('pers-concluir'); if (b) b.focus(); }, 30);
  }

  function concluir() {
    if (!ativo) return;
    ativo = false;
    document.body.classList.remove('personalizando');
    document.removeEventListener('click', bloquearCliques, true);
    document.removeEventListener('keydown', teclas, true);
    $('acoes-topo').removeEventListener('pointerdown', aoApertarTopo);
    ligarGrupos(false);
    marcarTopo(false);
    if (painel) painel.remove();
    painel = bandeja = fonteSeg = letraSeg = cantos = null;
    UI.aviso('Tela salva neste aparelho.', 'ok', 2500);
  }

  // No modo de edição os botões do topo não executam a ação: só se movem
  function bloquearCliques(ev) {
    var b = ev.target.closest && ev.target.closest('#acoes-topo .btn-acao-topo');
    if (!b) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.target.closest('.pers-tirar')) tirar(b.getAttribute('data-acao') || b.id);
  }

  // Teclado: ← → mudam a ordem do botão em foco; Delete tira; Esc conclui
  function teclas(ev) {
    if (ev.key === 'Escape' && !document.querySelector('.modal-fundo')) { ev.preventDefault(); concluir(); return; }
    var b = document.activeElement && document.activeElement.closest && document.activeElement.closest('#acoes-topo .btn-acao-topo');
    if (!b) return;
    var id = b.getAttribute('data-acao') || b.id;
    var ids = idsTopo(), i = ids.indexOf(id);
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      var j = i + (ev.key === 'ArrowLeft' ? -1 : 1);
      if (j < 0 || j >= ids.length) return;
      ids.splice(i, 1); ids.splice(j, 0, id);
      ap.definirTopo(ids);
      setTimeout(function () { var e = noTopo(id); if (e) e.focus(); }, 0);
    } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      tirar(id);
    }
  }

  function marcarTopo(ligar) {
    Array.prototype.forEach.call($('acoes-topo').querySelectorAll('.btn-acao-topo'), function (b) {
      var x = b.querySelector('.pers-tirar');
      if (ligar && !x) b.appendChild(el('span', { classe: 'pers-tirar', 'aria-hidden': 'true', title: 'Tirar do topo', texto: '×' }));
      if (!ligar && x) x.remove();
    });
  }

  function tirar(id) {
    ap.definirTopo(idsTopo().filter(function (x) { return x !== id; }));
  }
  function por(id, indice) {
    var ids = idsTopo().filter(function (x) { return x !== id; });
    ids.splice(indice == null ? ids.length : Math.max(0, Math.min(indice, ids.length)), 0, id);
    ap.definirTopo(ids);
    marcarTopo(true);
  }

  function desenharBandeja() {
    if (!bandeja) return;
    var ids = idsTopo();
    bandeja.innerHTML = '';
    var fora = TODOS.filter(function (id) { return ids.indexOf(id) === -1 && $(id); });
    if (!fora.length) bandeja.appendChild(el('span', { classe: 'muted pers-vazio', texto: 'Tudo está no topo.' }));
    fora.forEach(function (id) {
      var i = info(id);
      var chip = el('button', { classe: 'pers-chip', type: 'button', role: 'listitem', 'data-acao': id, title: 'Arraste para o topo ou toque para pôr no fim', 'aria-label': 'Pôr ' + i.rotulo + ' no topo' }, [
        i.icone, el('span', { texto: i.rotulo }), el('span', { classe: 'pers-mais', 'aria-hidden': 'true', texto: '+' }),
      ]);
      chip.addEventListener('pointerdown', function (ev) { arrastar(ev, id, 'bandeja', chip); });
      chip.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); por(id); } });
      bandeja.appendChild(chip);
    });
    marcarTopo(true);
    // tamanho do texto
    var f = ap.ler().fonte;
    fonteSeg.innerHTML = '';
    Object.keys(ap.fontes).forEach(function (k) {
      fonteSeg.appendChild(el('button', { classe: 'seg-opcao', type: 'button', role: 'radio', 'aria-checked': String(f === k), 'data-fonte': k, texto: ap.fontes[k],
        onclick: function () { ap.definirFonte(k); } }));
    });
    // letra: Industrial (Barlow, padrão), Técnica (IBM Plex) ou a do aparelho
    var l = ap.ler().letra;
    letraSeg.innerHTML = '';
    Object.keys(ap.letras).forEach(function (k) {
      letraSeg.appendChild(el('button', { classe: 'seg-opcao', type: 'button', role: 'radio', 'aria-checked': String(l === k), 'data-letra': k, texto: ap.letras[k],
        onclick: function () { ap.definirLetra(k); } }));
    });
    // canto do painel de grupos
    var pos = ap.posicaoGrupos();
    cantos.innerHTML = '';
    ['topleft', 'topright', 'bottomleft', 'bottomright'].forEach(function (k) {
      cantos.appendChild(el('button', { classe: 'pers-canto pers-canto-' + k, type: 'button', role: 'radio', 'aria-checked': String(pos === k), 'data-canto': k,
        'aria-label': ap.posicoesGrupos[k], title: ap.posicoesGrupos[k], onclick: function () { ap.definirPosicaoGrupos(k); } }));
    });
  }

  /* ---------- Arrastar (mouse e toque: pointer events) ---------------- */
  function aoApertarTopo(ev) {
    var b = ev.target.closest('.btn-acao-topo');
    if (!b || ev.target.closest('.pers-tirar') || ev.button > 0) return;
    arrastar(ev, b.getAttribute('data-acao') || b.id, 'topo', b);
  }

  // Onde o ponteiro está: no topo (com a posição de inserção), na bandeja ou fora
  function alvo(x, y) {
    var barra = document.querySelector('.painel-topo').getBoundingClientRect();
    if (y >= barra.top - 10 && y <= barra.bottom + 24) {
      var itens = Array.prototype.filter.call($('acoes-topo').querySelectorAll('.btn-acao-topo'), function (b) {
        return b.offsetParent && !b.classList.contains('pers-origem');
      });
      // botão mais perto do ponteiro (vale para uma linha ou várias); antes ou depois dele pelo lado
      var indice = itens.length, menor = Infinity;
      itens.forEach(function (it, i) {
        var r = it.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        var d = Math.pow(x - cx, 2) + Math.pow((y - cy) * 3, 2);   // a linha pesa mais que a coluna
        if (d < menor) { menor = d; indice = x < cx ? i : i + 1; }
      });
      return { zona: 'topo', indice: indice, itens: itens };
    }
    if (painel) {
      var r = painel.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom && x >= r.left && x <= r.right) return { zona: 'bandeja' };
    }
    return { zona: 'fora' };
  }

  var marcador = null;
  function mostrarMarcador(a) {
    if (!marcador) marcador = el('span', { classe: 'pers-marcador', 'aria-hidden': 'true' });
    var topo = $('acoes-topo');
    if (!a || a.zona !== 'topo') { if (marcador.parentNode) marcador.remove(); return; }
    var ref = a.itens[a.indice] || null;
    if (ref) topo.insertBefore(marcador, ref); else topo.appendChild(marcador);
  }

  function arrastar(ev, id, origem, elOrigem) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    var x0 = ev.clientX, y0 = ev.clientY, iniciou = false, fantasma = null, ultimo = null;
    var ptr = ev.pointerId;
    function mover(e) {
      if (e.pointerId !== ptr) return;
      if (!iniciou) {
        if (Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) < 6) return;
        iniciou = true;
        var i = info(id);
        fantasma = el('div', { classe: 'pers-fantasma', 'aria-hidden': 'true' }, [i.icone, el('span', { texto: i.rotulo }), el('small', { classe: 'pers-destino' })]);
        document.body.appendChild(fantasma);
        elOrigem.classList.add('pers-origem');
        document.body.classList.add('pers-arrastando');
      }
      e.preventDefault();
      fantasma.style.transform = 'translate(' + Math.round(e.clientX + 12) + 'px,' + Math.round(e.clientY + 12) + 'px)';
      ultimo = alvo(e.clientX, e.clientY);
      mostrarMarcador(ultimo);
      var vaiTirar = origem === 'topo' && ultimo.zona !== 'topo';
      var vaiPor = origem === 'bandeja' && ultimo.zona === 'topo';
      fantasma.classList.toggle('pers-fantasma-tirar', vaiTirar);
      fantasma.classList.toggle('pers-fantasma-por', vaiPor);
      fantasma.querySelector('.pers-destino').textContent = vaiTirar ? '→ Ferramentas' : vaiPor ? '→ topo' : '';
      if (painel) painel.classList.toggle('pers-alvo', vaiTirar);
      $('acoes-topo').classList.toggle('pers-alvo', vaiPor || (origem === 'topo' && ultimo.zona === 'topo'));
    }
    function soltar(e) {
      if (e.pointerId !== ptr) return;
      document.removeEventListener('pointermove', mover);
      document.removeEventListener('pointerup', soltar);
      document.removeEventListener('pointercancel', soltar);
      mostrarMarcador(null);
      if (fantasma) fantasma.remove();
      elOrigem.classList.remove('pers-origem');
      document.body.classList.remove('pers-arrastando');
      if (painel) painel.classList.remove('pers-alvo');
      $('acoes-topo').classList.remove('pers-alvo');
      if (e.type === 'pointercancel') return;
      if (!iniciou) {
        if (origem === 'bandeja') por(id);   // toque simples na bandeja: vai para o fim do topo
        return;
      }
      if (ultimo && ultimo.zona === 'topo') por(id, ultimo.indice);
      else if (origem === 'topo') tirar(id);
    }
    document.addEventListener('pointermove', mover, { passive: false });
    document.addEventListener('pointerup', soltar);
    document.addEventListener('pointercancel', soltar);
  }

  /* ---------- Painel de grupos: arrastar para um canto do mapa --------- */
  var grupoArrasto = null;
  function ligarGrupos(ligar) {
    var ctl = window.Painel && window.Painel.controleGrupos && window.Painel.controleGrupos();
    var cont = ctl && ctl.getContainer && ctl.getContainer();
    if (!cont) return;
    if (ligar) {
      grupoArrasto = function (ev) { arrastarGrupos(ev, ctl, cont); };
      cont.addEventListener('pointerdown', grupoArrasto);
    } else if (grupoArrasto) {
      cont.removeEventListener('pointerdown', grupoArrasto);
      grupoArrasto = null;
    }
  }
  function arrastarGrupos(ev, ctl, cont) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    var mapa = window.Painel.mapa().getContainer();
    var alvos = el('div', { classe: 'pers-alvos-cantos', 'aria-hidden': 'true' }, ['topleft', 'topright', 'bottomleft', 'bottomright'].map(function (k) {
      return el('div', { classe: 'pers-alvo-canto pers-canto-' + k, 'data-canto': k });
    }));
    mapa.appendChild(alvos);
    cont.classList.add('pers-origem');
    var ptr = ev.pointerId, escolhido = ctl.getPosition();
    function canto(x, y) {
      var r = mapa.getBoundingClientRect();
      return (y < r.top + r.height / 2 ? 'top' : 'bottom') + (x < r.left + r.width / 2 ? 'left' : 'right');
    }
    function marcar() {
      Array.prototype.forEach.call(alvos.children, function (a) { a.classList.toggle('ativo', a.getAttribute('data-canto') === escolhido); });
    }
    marcar();
    function mover(e) { if (e.pointerId !== ptr) return; e.preventDefault(); escolhido = canto(e.clientX, e.clientY); marcar(); }
    function soltar(e) {
      if (e.pointerId !== ptr) return;
      document.removeEventListener('pointermove', mover);
      document.removeEventListener('pointerup', soltar);
      document.removeEventListener('pointercancel', soltar);
      alvos.remove();
      cont.classList.remove('pers-origem');
      if (e.type !== 'pointercancel') ap.definirPosicaoGrupos(escolhido);
    }
    document.addEventListener('pointermove', mover, { passive: false });
    document.addEventListener('pointerup', soltar);
    document.addEventListener('pointercancel', soltar);
  }

  ap.aoMudar(aplicar);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', aplicar); else aplicar();

  window.Personalizar = { iniciar: iniciar, concluir: concluir, aplicar: aplicar, ativo: function () { return ativo; }, TODOS: TODOS, PADRAO: PADRAO };
})();
