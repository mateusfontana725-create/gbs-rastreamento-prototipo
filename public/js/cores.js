/* =====================================================================
 * cores.js — escolha de cor livre (grupos, setores, trilhas…)
 *   - Funções puras: conversão entre #rrggbb e HSL, normalização e escolha de uma cor ainda não usada.
 *   - UI.seletorCor(): amostras prontas + "Minhas cores" (guardadas neste aparelho) + painel de cor personalizada
 *     com tom, intensidade e claridade, o seletor do sistema e o código #rrggbb. O servidor aceita qualquer #rrggbb.
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var HEX_RE = /^#[0-9a-f]{6}$/i;
  var CHAVE_MINHAS = 'gbs-minhas-cores';
  var MAX_MINHAS = 12;

  // "#abc", "ABC", "#AABBCC" → "#aabbcc"; qualquer outra coisa → null
  function normalizar(v) {
    var t = String(v == null ? '' : v).trim().toLowerCase();
    if (t[0] !== '#') t = '#' + t;
    if (/^#[0-9a-f]{3}$/.test(t)) t = '#' + t[1] + t[1] + t[2] + t[2] + t[3] + t[3];
    return HEX_RE.test(t) ? t : null;
  }

  // h 0–360, s e l 0–100
  function hexParaHsl(hex) {
    var c = normalizar(hex) || '#000000';
    var r = parseInt(c.slice(1, 3), 16) / 255, g = parseInt(c.slice(3, 5), 16) / 255, b = parseInt(c.slice(5, 7), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, h = 0, s = 0, l = (max + min) / 2;
    if (d > 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h: Math.round(h) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function hslParaHex(h, s, l) {
    h = ((Number(h) % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, Number(s))) / 100;
    l = Math.max(0, Math.min(100, Number(l))) / 100;
    var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    function p(v) { var n = Math.round((v + m) * 255); return (n < 16 ? '0' : '') + n.toString(16); }
    return '#' + p(r) + p(g) + p(b);
  }

  // Primeira cor da lista que ainda não está em uso (comparação sem diferenciar maiúsculas)
  function livre(lista, usadas) {
    var u = {};
    (usadas || []).forEach(function (c) { var n = normalizar(c); if (n) u[n] = true; });
    for (var i = 0; i < lista.length; i++) if (!u[normalizar(lista[i])]) return normalizar(lista[i]);
    return normalizar(lista[0]);
  }

  // Cor de texto legível sobre um fundo (preto ou branco)
  function textoSobre(hex) {
    var c = normalizar(hex) || '#000000';
    var r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#000000' : '#ffffff';
  }

  function lerMinhas() {
    try {
      var l = JSON.parse(localStorage.getItem(CHAVE_MINHAS) || '[]');
      return Array.isArray(l) ? l.map(normalizar).filter(Boolean).slice(0, MAX_MINHAS) : [];
    } catch (e) { return []; }
  }
  function guardarMinhas(lista) {
    try { localStorage.setItem(CHAVE_MINHAS, JSON.stringify(lista.slice(0, MAX_MINHAS))); } catch (e) { /* sem armazenamento: não guarda */ }
  }

  var API = { normalizar: normalizar, hexParaHsl: hexParaHsl, hslParaHex: hslParaHex, livre: livre, textoSobre: textoSobre, MAX_MINHAS: MAX_MINHAS };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  raiz.Cores = API;

  /* ---------- Seletor na tela ---------- */
  var UI = raiz.UI;
  if (!UI || !raiz.document) return;
  var el = UI.el;

  // o: { rotulo, valor (#rrggbb), padroes: [#rrggbb…], aoMudar(hex) }
  // Devolve o elemento; .valor() devolve a cor escolhida (#rrggbb em minúsculas).
  UI.seletorCor = function (o) {
    var atual = normalizar(o.valor) || normalizar((o.padroes || [])[0]) || '#3b82f6';
    var padroes = (o.padroes || []).map(normalizar).filter(Boolean);
    var minhas = lerMinhas();
    var amostras = el('div', { classe: 'cores-setor', role: 'radiogroup', 'aria-label': o.rotulo || 'Cor' });
    var painel = el('div', { classe: 'cor-painel', hidden: true });
    var preview = el('span', { classe: 'cor-preview', 'aria-hidden': 'true' });
    var codigo = el('input', { classe: 'campo cor-codigo', type: 'text', maxlength: '7', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Código da cor (#rrggbb)', placeholder: '#rrggbb' });
    var nativo = el('input', { type: 'color', classe: 'campo-cor cor-nativo', 'aria-label': 'Escolher a cor no seletor do sistema' });
    function deslizante(rotulo, max) {
      var i = el('input', { type: 'range', min: '0', max: String(max), step: '1', classe: 'cor-deslizante', 'aria-label': rotulo });
      return { entrada: i, linha: el('label', { classe: 'cor-linha' }, [el('span', { texto: rotulo }), i]) };
    }
    var tom = deslizante('Tom', 359), inten = deslizante('Intensidade', 100), clar = deslizante('Claridade', 100);
    var guardar = el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Guardar em "Minhas cores"' });
    var botaoMais = el('button', { classe: 'cor-mais', type: 'button', 'aria-expanded': 'false', title: 'Outra cor: escolha o tom, a intensidade e a claridade', 'aria-label': 'Outra cor' }, [el('span', { 'aria-hidden': 'true', texto: '＋' })]);
    var ouvinte = o.aoMudar;

    function pintarSliders() {
      var hsl = hexParaHsl(atual);
      tom.entrada.value = String(hsl.h); inten.entrada.value = String(hsl.s); clar.entrada.value = String(hsl.l);
      tom.entrada.style.background = 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)';
      inten.entrada.style.background = 'linear-gradient(90deg,' + hslParaHex(hsl.h, 0, hsl.l) + ',' + hslParaHex(hsl.h, 100, hsl.l) + ')';
      clar.entrada.style.background = 'linear-gradient(90deg,#000,' + hslParaHex(hsl.h, hsl.s, 50) + ',#fff)';
    }
    var redesenhando = false;
    function marcar() {
      // cor que ainda não tem amostra (veio do painel): aparece como "Cor atual" ao lado das outras
      if (!redesenhando && amostras.firstChild && !amostras.querySelector('[data-cor="' + atual + '"]')) { desenharAmostras(); return; }
      Array.prototype.forEach.call(amostras.querySelectorAll('.cor-amostra'), function (b) {
        var igual = b.getAttribute('data-cor') === atual;
        b.setAttribute('aria-checked', String(igual));
        b.classList.toggle('marcada', igual);
      });
      preview.style.background = atual;
      nativo.value = atual;
      if (document.activeElement !== codigo) codigo.value = atual;
      guardar.disabled = minhas.indexOf(atual) !== -1 || padroes.indexOf(atual) !== -1;
    }
    function definir(c, avisar, sliders) {
      var n = normalizar(c);
      if (!n) return;
      atual = n;
      marcar();
      if (sliders !== false) pintarSliders();
      if (avisar && ouvinte) ouvinte(atual);
    }
    function amostra(c, rotulo) {
      var b = el('button', { classe: 'cor-amostra', type: 'button', role: 'radio', 'data-cor': c, title: rotulo || c, 'aria-label': (rotulo || 'Cor') + ' ' + c });
      b.style.background = c;
      b.addEventListener('click', function () { definir(c, true); });
      return b;
    }
    function desenharAmostras() {
      redesenhando = true;
      amostras.innerHTML = '';
      var vistos = {};
      padroes.forEach(function (c) { if (!vistos[c]) { vistos[c] = 1; amostras.appendChild(amostra(c)); } });
      minhas.forEach(function (c) { if (!vistos[c]) { vistos[c] = 1; amostras.appendChild(amostra(c, 'Minha cor')); } });
      if (!vistos[atual]) amostras.appendChild(amostra(atual, 'Cor atual'));   // cor própria já gravada (ex.: grupo antigo)
      amostras.appendChild(botaoMais);
      redesenhando = false;
      marcar();
    }

    [tom, inten, clar].forEach(function (s) {
      s.entrada.addEventListener('input', function () {
        definir(hslParaHex(tom.entrada.value, inten.entrada.value, clar.entrada.value), true, false);
        inten.entrada.style.background = 'linear-gradient(90deg,' + hslParaHex(tom.entrada.value, 0, clar.entrada.value) + ',' + hslParaHex(tom.entrada.value, 100, clar.entrada.value) + ')';
        clar.entrada.style.background = 'linear-gradient(90deg,#000,' + hslParaHex(tom.entrada.value, inten.entrada.value, 50) + ',#fff)';
      });
    });
    nativo.addEventListener('input', function () { definir(nativo.value, true); });
    codigo.addEventListener('input', function () { var n = normalizar(codigo.value); if (n && codigo.value.length >= 4) definir(n, true); });
    codigo.addEventListener('blur', function () { codigo.value = atual; });
    guardar.addEventListener('click', function () {
      if (minhas.indexOf(atual) === -1) { minhas.unshift(atual); minhas = minhas.slice(0, MAX_MINHAS); guardarMinhas(minhas); }
      desenharAmostras();
    });
    botaoMais.addEventListener('click', function () {
      painel.hidden = !painel.hidden;
      botaoMais.setAttribute('aria-expanded', String(!painel.hidden));
      botaoMais.classList.toggle('aberto', !painel.hidden);
    });
    painel.appendChild(el('div', { classe: 'cor-painel-topo' }, [preview, codigo, nativo]));
    [tom, inten, clar].forEach(function (s) { painel.appendChild(s.linha); });
    painel.appendChild(guardar);

    var raizEl = el('div', { classe: 'seletor-cor' }, [amostras, painel]);
    raizEl.valor = function () { return atual; };
    raizEl.definir = function (c) { definir(c, false); desenharAmostras(); };
    desenharAmostras();
    pintarSliders();
    return raizEl;
  };
})(typeof window !== 'undefined' ? window : globalThis);
