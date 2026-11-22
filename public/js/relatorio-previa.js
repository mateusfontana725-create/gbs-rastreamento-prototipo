/* =====================================================================
 * relatorio-previa.js — prévia do PDF na tela (o "mini PDF" do Personalizar do IPO) e as edições feitas nele.
 *   O documento é o mesmo do pdfmake (doc.content). A prévia desenha em HTML: textos, tabelas, listas, colunas e
 *   imagens (mapas e fotos da prévia vêm como 'PREVIA:<nome>' e aparecem como caixas). Quebra de página = nova folha.
 *   Edição: cada texto ganha uma chave estável (título da seção acima + o texto + a ocorrência). Tocar num texto da
 *   prévia deixa escrever; a troca fica em edicoes[chave] e aplicarEdicoes() põe no documento (prévia e PDF final).
 *   API: window.RelatorioPrevia = { aplicarEdicoes(content, edicoes), renderizar(el, doc, { aoEditar(chave, texto) }) }.
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var TITULOS = { h1: 1, h2: 1, dia: 1 };
  function textoPlano(t) {
    if (t == null) return '';
    if (typeof t === 'string' || typeof t === 'number') return String(t);
    if (Array.isArray(t)) return t.map(textoPlano).join('');
    if (typeof t === 'object') return textoPlano(t.text);
    return '';
  }

  // Percorre o documento na ordem de leitura e dá a cada texto a sua chave (_chave). Texto solto num array (célula de
  // tabela, item de lista) vira { text } para poder guardar a chave. Aplica as edições.
  function aplicarEdicoes(content, edicoes) {
    edicoes = edicoes || {};
    var ctx = { titulo: '', n: {} };
    function folha(o) {
      var t = textoPlano(o.text);
      if (!t.trim()) return;
      var k = ctx.titulo + '›' + t;
      ctx.n[k] = (ctx.n[k] || 0) + 1;
      o._chave = k + '#' + ctx.n[k];
      if (TITULOS[o.style] || o.headlineLevel) ctx.titulo = t;
      if (Object.prototype.hasOwnProperty.call(edicoes, o._chave)) { o.text = edicoes[o._chave]; o._editado = true; }
    }
    function andar(n, pai, i) {
      if (n == null) return;
      if (typeof n === 'string' || typeof n === 'number') {
        if (pai && String(n).trim()) { var o = { text: String(n) }; pai[i] = o; folha(o); }
        return;
      }
      if (Array.isArray(n)) { for (var j = 0; j < n.length; j++) andar(n[j], n, j); return; }
      if (typeof n !== 'object') return;
      if (n.text != null && !n.stack && !n.table) { folha(n); return; }
      ['stack', 'columns', 'ul', 'ol'].forEach(function (k) { if (Array.isArray(n[k])) andar(n[k]); });
      if (n.table && Array.isArray(n.table.body)) n.table.body.forEach(function (linha) { andar(linha); });
    }
    andar(content);
    return content;
  }

  // ---------- desenho em HTML ----------
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  function renderizar(alvo, doc, opcoes) {
    opcoes = opcoes || {};
    alvo.innerHTML = '';
    var folhas = el('div', 'pv-folhas');
    alvo.appendChild(folhas);
    var folha = null, nFolha = 0;
    function novaFolha() {
      nFolha++;
      folha = el('div', 'pv-folha');
      folha.appendChild(el('div', 'pv-folha-num', 'Página ' + nFolha));
      folhas.appendChild(folha);
    }
    novaFolha();

    function editavel(e, o) {
      if (!o || !o._chave || !opcoes.aoEditar) return;
      e.classList.add('pv-editavel');
      if (o._editado) e.classList.add('pv-editado');
      e.title = 'Toque para editar este texto';
      e.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (e.isContentEditable) return;
        var antes = e.textContent;
        e.contentEditable = 'true';
        e.classList.add('pv-editando');
        e.focus();
        try { var r = document.createRange(); r.selectNodeContents(e); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); } catch (x) { /* sem seleção */ }
        function fim(salvar) {
          e.removeEventListener('blur', aoSair);
          e.removeEventListener('keydown', teclas);
          e.contentEditable = 'false';
          e.classList.remove('pv-editando');
          var novo = (e.innerText || e.textContent || '').replace(/ /g, ' ').replace(/\n+$/, '');
          if (salvar && novo !== antes) opcoes.aoEditar(o._chave, novo);
          else e.textContent = antes;
        }
        function aoSair() { fim(true); }
        function teclas(k) {
          if (k.key === 'Enter' && !k.shiftKey) { k.preventDefault(); e.blur(); }
          else if (k.key === 'Escape') { k.preventDefault(); k.stopPropagation(); e.removeEventListener('blur', aoSair); fim(false); }
        }
        e.addEventListener('blur', aoSair);
        e.addEventListener('keydown', teclas);
      });
    }

    function inline(t, e) {   // texto rico (array de partes) ou simples
      if (Array.isArray(t)) t.forEach(function (x) {
        if (x == null) return;
        if (typeof x === 'object') { var s = el('span', null, textoPlano(x.text)); if (x.bold) s.style.fontWeight = '700'; e.appendChild(s); }
        else e.appendChild(document.createTextNode(String(x)));
      });
      else e.textContent = textoPlano(t);
    }

    function no(n, dentroDeTabela) {
      if (n == null) return null;
      if (typeof n === 'string' || typeof n === 'number') { var sp = el('span', 'pv-td', String(n)); return sp; }
      if (Array.isArray(n)) { var f = el('div', 'pv-pilha'); n.forEach(function (x) { var c = no(x, dentroDeTabela); if (c) f.appendChild(c); }); return f; }
      if (typeof n !== 'object') return null;
      var e;
      if (n.image != null) {
        if (typeof n.image === 'string' && n.image.indexOf('PREVIA:') === 0) {
          e = el('div', 'pv-imagem', n.image.slice(7));
          var w = (n.fit && n.fit[0]) || n.width || 300, h = (n.fit && n.fit[1]) || (n.width ? n.width * 0.55 : 160);
          if (/foto/i.test(n.image)) { w = (n.fit && n.fit[0]) || 160; h = (n.fit && n.fit[1]) || 120; e.classList.add('pv-foto'); }
          e.style.width = Math.min(100, w / 5.15) + '%';
          e.style.aspectRatio = (w / h).toFixed(3);
        } else {
          e = el('img', 'pv-img'); e.src = n.image; e.alt = '';
          if (n.width) e.style.width = Math.min(100, n.width / 5.15) + '%';
        }
      } else if (n.table && Array.isArray(n.table.body)) {
        e = el('table', 'pv-tabela' + (n.layout === 'noBorders' ? ' pv-sem-borda' : ''));
        n.table.body.forEach(function (linha, li) {
          var tr = el('tr');
          (linha || []).forEach(function (cel) {
            if (cel && typeof cel === 'object' && !Array.isArray(cel) && Object.keys(cel).length === 0) return;   // célula coberta por colSpan
            var td = el(li === 0 && n.table.headerRows ? 'th' : 'td');
            if (cel && cel.colSpan) td.colSpan = cel.colSpan;
            var c = no(cel, true); if (c) td.appendChild(c);
            tr.appendChild(td);
          });
          e.appendChild(tr);
        });
      } else if (Array.isArray(n.stack)) {
        e = el('div', 'pv-pilha'); n.stack.forEach(function (x) { var c = no(x, dentroDeTabela); if (c) e.appendChild(c); });
      } else if (Array.isArray(n.columns)) {
        e = el('div', 'pv-colunas'); n.columns.forEach(function (x) { var c = no(x, dentroDeTabela); if (c) { var d = el('div', 'pv-coluna'); d.appendChild(c); e.appendChild(d); } });
      } else if (Array.isArray(n.ul) || Array.isArray(n.ol)) {
        e = el(n.ol ? 'ol' : 'ul', 'pv-lista'); (n.ul || n.ol).forEach(function (x) { var li = el('li'); var c = no(x, true); if (c) li.appendChild(c); e.appendChild(li); });
      } else if (n.text != null) {
        e = el(TITULOS[n.style] ? 'div' : 'p', 'pv-t pv-' + (n.style || 'corpo'));
        inline(n.text, e);
        if (n.bold) e.style.fontWeight = '700';
        if (n.color && /^#/.test(n.color)) e.style.color = n.color;
        if (!e.textContent.trim()) return null;
        editavel(e, n);
      } else if (n.canvas) {
        e = el('div', 'pv-traco');
      } else return null;
      return e;
    }

    (Array.isArray(doc.content) ? doc.content : [doc.content]).forEach(function (n) {
      if (n && n.pageBreak === 'before' && folha.childNodes.length > 1) novaFolha();
      var e = no(n, false);
      if (e) folha.appendChild(e);
      if (n && n.pageBreak === 'after') novaFolha();
    });
    // quebras dentro de pilhas (ex.: título com pageBreak dentro de um stack) não são vistas aqui: a prévia é aproximada
    return { paginas: nFolha };
  }

  raiz.RelatorioPrevia = { aplicarEdicoes: aplicarEdicoes, renderizar: renderizar, textoPlano: textoPlano };
})(typeof window !== 'undefined' ? window : globalThis);
