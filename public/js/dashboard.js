/* =====================================================================
 * dashboard.js — painéis de estudo, desenhados sem bibliotecas externas (SVG e grade CSS).
 *   - Dashboard.geral(elemento): painel inicial com os números de todas as operações a que o
 *     responsável tem acesso (estudo_geral).
 *   - Dashboard.operacao(op, elemento): números de uma operação (estudo_operacao).
 * O banco devolve nulo para grupos com menos de 5 casos: aqui aparecem como "oculto".
 * Cada gráfico mostra o tamanho da amostra (n), para que ninguém leia um número pequeno como certo.
 * ===================================================================== */
(function (raiz) {
  'use strict';
  var C = raiz.Comunicacao, UI = raiz.UI;
  var NS = 'http://www.w3.org/2000/svg';
  var MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  var TIPOS = { aquatica: 'Aquática', terrestre: 'Terrestre', aerea: 'Aérea', outras: 'Outras', sem_tipo: 'Sem tipo' };
  var CONDICOES = { viva: 'Com vida', obito: 'Em óbito' };
  var gradCont = 0;

  // nomes dos perfis vêm da mesma lista do formulário (ipo.js): o gráfico e o cadastro não divergem
  function nomePerfil(p) {
    var x = (window.Ipo && window.Ipo.PERFIS_VITIMA || []).filter(function (y) { return y[0] === p; })[0];
    return x ? x[1] : p;
  }

  /* ------------------------------ formatação ------------------------------ */
  function dd(n) { return (n < 10 ? '0' : '') + n; }
  function dataHora(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '—' : dd(d.getDate()) + '/' + dd(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + dd(d.getHours()) + ':' + dd(d.getMinutes());
  }
  function num(v, casas) { return String(Number(v).toFixed(casas || 0)).replace('.', ','); }
  function km(v) { return v == null ? null : num(v, 2) + ' km'; }
  function minutos(m) {
    if (m == null) return null;
    m = Math.round(m);
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  }
  function percentual(parte, total) { return total ? Math.round((parte / total) * 100) + '%' : ''; }
  function rotuloMes(ym) { var p = ym.split('-'); return MESES[Number(p[1]) - 1] + '/' + p[0].slice(2); }
  // sempre 12 meses, mesmo sem operação em alguns deles
  function ultimos12(lista) {
    var mapa = {};
    (lista || []).forEach(function (m) { mapa[m.mes] = m.n; });
    var out = [], hoje = new Date();
    for (var i = 11; i >= 0; i--) {
      var d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
      var ym = d.getFullYear() + '-' + dd(d.getMonth() + 1);
      out.push({ mes: ym, n: mapa[ym] || 0 });
    }
    return out;
  }
  // há algum número oculto (nulo) na resposta?
  function temOculto(v) {
    if (v === null) return true;
    if (Array.isArray(v)) return v.some(temOculto);
    if (typeof v === 'object') return Object.keys(v).some(function (k) { return temOculto(v[k]); });
    return false;
  }

  /* ------------------------------ blocos ------------------------------ */
  function el(tag, attrs, filhos) { return UI.el(tag, attrs, filhos); }
  function oculto() { return el('span', { classe: 'dash-oculto', texto: 'oculto', title: 'menos de 5 casos' }); }
  function valorOu(v, f) { return v == null ? oculto() : (f ? f(v) : String(v)); }

  /* ------------------------------ interação: tocar abre os detalhes ------------------------------ */
  // Deixa o elemento clicável e acessível pelo teclado (Enter / Espaço). Funciona em HTML e em SVG.
  function clicavel(no, aoClicar, dica) {
    if (!aoClicar) return no;
    no.classList.add('dash-clicavel');
    no.setAttribute('role', 'button');
    no.setAttribute('tabindex', '0');
    if (dica && no.namespaceURI !== NS) no.setAttribute('title', dica);
    no.addEventListener('click', function (ev) { ev.stopPropagation(); aoClicar(); });
    no.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); aoClicar(); }
    });
    return no;
  }
  // Outras partes da mesma linha (barra, número) também respondem ao toque, sem entrar na ordem do Tab.
  function tambemClica(no, aoClicar) {
    if (!aoClicar) return no;
    no.classList.add('dash-clicavel-sec');
    no.addEventListener('click', function (ev) { ev.stopPropagation(); aoClicar(); });
    return no;
  }

  // Lista da janela de detalhes. itens: [{ titulo, meta, valor, aoClicar }] ou uma Promise disso.
  function listaDetalhe(itens, vazio) {
    var ul = el('ul', { classe: 'dash-det-lista' });
    function preencher(lista) {
      ul.innerHTML = '';
      if (!lista.length) { ul.appendChild(el('li', { classe: 'muted dash-det-vazio', texto: vazio || 'Nada para mostrar.' })); return; }
      lista.forEach(function (it) {
        var partes = [
          el('span', { classe: 'dash-det-nome' }, [it.titulo]),
          it.meta ? el('span', { classe: 'dash-det-meta', texto: it.meta }) : null,
          it.valor != null ? el('span', { classe: 'dash-det-valor', texto: it.valor }) : null,
        ];
        ul.appendChild(el('li', null, [it.aoClicar
          ? el('button', { classe: 'dash-det-item', type: 'button', onclick: it.aoClicar }, partes.concat([el('span', { classe: 'dash-det-seta', 'aria-hidden': 'true', texto: '›' })]))
          : el('div', { classe: 'dash-det-item' }, partes)]));
      });
    }
    if (itens && typeof itens.then === 'function') {
      ul.appendChild(el('li', { classe: 'muted dash-det-vazio', texto: 'Carregando…' }));
      itens.then(preencher, function (e) {
        ul.innerHTML = '';
        ul.appendChild(el('li', { classe: 'erro-form', texto: 'Não foi possível carregar: ' + ((e && e.message) || e) }));
      });
    } else {
      preencher(itens || []);
    }
    return ul;
  }

  // Janela de detalhes, por cima do dashboard (fechar volta para ele).
  // o: { titulo, subtitulo, medidas: [[rótulo, valor]], lista, vazio, nota, acoes: [{ texto, fn, principal }] }
  function abrirDetalhe(o) {
    var fechar = null;
    var caixa = el('div', { classe: 'dash-det' }, [
      el('div', { classe: 'dash-det-topo' }, [
        el('h2', { id: 'modal-titulo', texto: o.titulo }),
        el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
      o.subtitulo ? el('p', { classe: 'muted dash-det-sub', texto: o.subtitulo }) : null,
      o.medidas ? medidas(o.medidas) : null,
      o.lista ? listaDetalhe(o.lista, o.vazio) : null,
      o.nota ? el('p', { classe: 'dash-card-nota', texto: o.nota }) : null,
      o.acoes && o.acoes.length ? el('div', { classe: 'dash-det-acoes' }, o.acoes.map(function (a) {
        return el('button', { classe: 'btn' + (a.principal ? ' btn-primario' : ''), type: 'button', texto: a.texto, onclick: a.fn });
      })) : null,
    ]);
    fechar = UI.abrirModal(caixa, { empilhar: true });
    return fechar;
  }

  // Operações a que o responsável tem acesso, para as listas dos detalhes. Mesmos critérios do estudo_geral:
  // mês = início das operações (ou criação) no fuso do banco (UTC); sem tipo = "sem_tipo".
  var cacheOps = null, cacheLocalizadas = null;
  function operacoesDoUsuario() {
    if (!cacheOps) {
      cacheOps = C.consultarTudo(function () { return C.cliente.from('operacoes').select('*').order('criada_em', { ascending: false }); });
      cacheOps.catch(function () { cacheOps = null; });
    }
    return cacheOps;
  }
  function operacoesComLocalizacao() {
    if (!cacheLocalizadas) {
      cacheLocalizadas = C.consultarTudo(function () { return C.cliente.from('vitima_localizacoes').select('operacao_id'); })
        .then(function (linhas) { return new Set(linhas.map(function (l) { return l.operacao_id; })); });
      cacheLocalizadas.catch(function () { cacheLocalizadas = null; });
    }
    return cacheLocalizadas;
  }
  // Para os gráficos: só aquática e terrestre; o resto (aérea, outras, sem tipo) vira "Outros"
  var GRUPOS_TIPO = { aquatica: 'Aquática', terrestre: 'Terrestre', outras: 'Outros' };
  function grupoTipo(t) { return t === 'aquatica' || t === 'terrestre' ? t : 'outras'; }
  function mesDaOperacao(o) {
    var t = Date.parse(o.acionado_em || o.criada_em);
    return isNaN(t) ? null : new Date(t).toISOString().slice(0, 7);
  }
  function abrirOperacao(id) {
    if (UI.fecharTodos) UI.fecharTodos();
    location.hash = '#op=' + id;
  }
  function itemOperacao(o) {
    var natureza = o.ipo && o.ipo.natureza ? o.ipo.natureza : (TIPOS[o.tipo || 'sem_tipo'] || o.tipo);
    var quando = o.acionado_em || o.criada_em;
    return {
      titulo: o.codigo || 'Operação',
      meta: [natureza, quando ? dataHora(quando).slice(0, 10) : null].filter(Boolean).join(' · '),
      valor: o.encerrada_em ? 'encerrada' : 'aberta',
      aoClicar: function () { abrirOperacao(o.id); },
    };
  }
  // Lista (Promise) das operações que passam no filtro, já no formato da janela de detalhes.
  function listaOperacoes(filtro) {
    return operacoesDoUsuario().then(function (ops) { return ops.filter(filtro).map(itemOperacao); });
  }
  function detalheLocalizadas(d) {
    var loc = d.localizacoes, dist = d.distancia_km;
    abrirDetalhe({
      titulo: 'Operações com vítima localizada',
      medidas: [
        ['Operações com localização', valorOu(loc.operacoes_com_localizacao)],
        ['Tempo até localizar (mediana)', valorOu(loc.minutos_ate_mediana, minutos)],
        ['Distância do ULV (mediana)', valorOu(dist.mediana, km)],
      ],
      lista: operacoesComLocalizacao().then(function (ids) {
        return listaOperacoes(function (o) { return ids.has(o.id); });
      }),
      vazio: 'Nenhuma vítima localizada nas suas operações.',
      nota: 'Toque numa operação para abri-la.',
    });
  }

  function kpi(icone, rotulo, valor, detalhe, cor, aoClicar) {
    return clicavel(el('div', { classe: 'dash-kpi dash-kpi-' + cor }, [
      el('span', { classe: 'dash-kpi-icone', 'aria-hidden': 'true', texto: icone }),
      el('div', { classe: 'dash-kpi-texto' }, [
        el('span', { classe: 'dash-kpi-rotulo', texto: rotulo }),
        el('strong', { classe: 'dash-kpi-valor' }, [valor]),
        detalhe ? el('small', { classe: 'dash-kpi-detalhe', texto: detalhe }) : null,
      ]),
      aoClicar ? el('span', { classe: 'dash-kpi-seta', 'aria-hidden': 'true', texto: '›' }) : null,
    ]), aoClicar, 'Ver detalhes: ' + rotulo);
  }

  // Cartão com estrutura fixa: título, n (tamanho da amostra), pergunta, corpo e nota.
  // span: colunas da grade (12 = largura toda).
  function cartao(o) {
    var amostra = o.n == null ? el('span', { classe: 'dash-n dash-n-baixo', texto: 'n < 5' })
      : el('span', { classe: 'dash-n', texto: 'n = ' + o.n });
    return clicavel(el('section', { classe: 'dash-card dash-s' + (o.span || 12) }, [
      el('header', { classe: 'dash-card-topo' }, [el('h3', { classe: 'titulo-com-dica' }, [o.titulo, o.pergunta && window.UI ? UI.dica(o.pergunta) : null]), o.n === undefined ? null : amostra,
        o.aoClicar ? el('span', { classe: 'dash-card-dica', texto: o.dica || 'Detalhes ›' }) : null]),
      el('div', { classe: 'dash-card-corpo' }, o.corpo),
      o.nota ? el('p', { classe: 'dash-card-nota', texto: o.nota }) : null,
    ]), o.aoClicar, 'Ver detalhes: ' + o.titulo);
  }

  /* ------------------------------ gráficos ------------------------------ */
  function svg(largura, altura, rotulo) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 ' + largura + ' ' + altura);
    s.setAttribute('class', 'dash-svg');
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', rotulo);
    return s;
  }
  function sv(tag, atributos, texto) {
    var e = document.createElementNS(NS, tag);
    Object.keys(atributos || {}).forEach(function (k) { e.setAttribute(k, atributos[k]); });
    if (texto != null) e.textContent = texto;
    return e;
  }

  // Colunas verticais. itens: [{ rotulo, valor }]; valor 0 vira um traço; valor nulo vira "oculto".
  // aoClicar(item, índice): cada coluna (com o rótulo) vira um alvo de toque.
  function colunas(itens, rotuloGrafico, aoClicar) {
    var W = 640, H = 230, base = 186, topo = 30, margem = 12;
    var slot = (W - margem * 2) / Math.max(itens.length, 1);
    var largura = slot * 0.6;
    var max = itens.reduce(function (m, i) { return Math.max(m, i.valor || 0); }, 0) || 1;
    var id = 'dash-grad-' + (++gradCont);
    var s = svg(W, H, rotuloGrafico);
    var defs = sv('defs');
    var grad = sv('linearGradient', { id: id, x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.appendChild(sv('stop', { offset: '0%', 'stop-color': '#fbbf24' }));
    grad.appendChild(sv('stop', { offset: '100%', 'stop-color': '#b45309' }));
    defs.appendChild(grad);
    s.appendChild(defs);
    [0.5, 1].forEach(function (f) {
      var y = base - (base - topo) * f;
      s.appendChild(sv('line', { x1: margem, x2: W - margem, y1: y, y2: y, class: 'dash-grade-linha' }));
    });
    s.appendChild(sv('line', { x1: margem, x2: W - margem, y1: base, y2: base, class: 'dash-base' }));
    itens.forEach(function (it, i) {
      var x = margem + i * slot + (slot - largura) / 2;
      var cx = x + largura / 2;
      var g = sv('g', { class: 'dash-col' });
      if (aoClicar) {
        g.appendChild(sv('title', null, it.rotulo + ': ' + (it.valor == null ? 'oculto' : it.valor) + ' · toque para ver'));
        g.appendChild(sv('rect', { x: margem + i * slot, y: topo - 20, width: slot, height: base - topo + 46, rx: 6, class: 'dash-alvo' }));
      }
      if (it.valor == null) {
        g.appendChild(sv('rect', { x: x, y: base - 14, width: largura, height: 14, rx: 4, class: 'dash-oculta' }));
      } else if (it.valor === 0) {
        g.appendChild(sv('rect', { x: x, y: base - 3, width: largura, height: 3, rx: 1.5, class: 'dash-zero' }));
      } else {
        var h = Math.max(6, (base - topo) * (it.valor / max));
        g.appendChild(sv('rect', { x: x, y: base - h, width: largura, height: h, rx: 5, fill: 'url(#' + id + ')' }));
        g.appendChild(sv('text', { x: cx, y: base - h - 7, 'text-anchor': 'middle', class: 'dash-valor' }, String(it.valor)));
      }
      g.appendChild(sv('text', { x: cx, y: base + 20, 'text-anchor': 'middle', class: 'dash-eixo' }, it.rotulo));
      if (aoClicar) clicavel(g, function () { aoClicar(it, i); });
      s.appendChild(g);
    });
    return s;
  }

  // Duas colunas por item, lado a lado (ex.: aquática e terrestre em cada mês).
  // itens: [{ rotulo, valores: { chave: n } }]; series: [{ chave, rotulo, classe }]; aoClicar(item, serie).
  function colunasDuplas(itens, series, rotuloGrafico, aoClicar) {
    var W = 640, H = 230, base = 186, topo = 30, margem = 12;
    var slot = (W - margem * 2) / Math.max(itens.length, 1);
    var larg = Math.min(16, slot * 0.34), vao = 2;
    var max = itens.reduce(function (m, it) { return series.reduce(function (mm, se) { return Math.max(mm, it.valores[se.chave] || 0); }, m); }, 0) || 1;
    var s = svg(W, H, rotuloGrafico);
    [0.5, 1].forEach(function (f) {
      var y = base - (base - topo) * f;
      s.appendChild(sv('line', { x1: margem, x2: W - margem, y1: y, y2: y, class: 'dash-grade-linha' }));
    });
    s.appendChild(sv('line', { x1: margem, x2: W - margem, y1: base, y2: base, class: 'dash-base' }));
    itens.forEach(function (it, i) {
      var meio = margem + i * slot + slot / 2;
      var x0 = meio - (series.length * larg + (series.length - 1) * vao) / 2;
      series.forEach(function (se, k) {
        var v = it.valores[se.chave] || 0, x = x0 + k * (larg + vao);
        var g = sv('g', { class: 'dash-col dash-col-' + se.classe });
        if (aoClicar) {
          g.appendChild(sv('title', null, it.rotulo + ' · ' + se.rotulo + ': ' + v + ' · toque para ver'));
          g.appendChild(sv('rect', { x: x - vao / 2, y: topo - 20, width: larg + vao, height: base - topo + 26, class: 'dash-alvo' }));
        }
        if (!v) g.appendChild(sv('rect', { x: x, y: base - 3, width: larg, height: 3, rx: 1.5, class: 'dash-zero' }));
        else {
          var h = Math.max(5, (base - topo) * (v / max));
          g.appendChild(sv('rect', { x: x, y: base - h, width: larg, height: h, rx: 3, class: 'dash-barra-' + se.classe }));
          g.appendChild(sv('text', { x: x + larg / 2, y: base - h - 6, 'text-anchor': 'middle', class: 'dash-valor dash-valor-peq' }, String(v)));
        }
        if (aoClicar) clicavel(g, function () { aoClicar(it, se); });
        s.appendChild(g);
      });
      s.appendChild(sv('text', { x: meio, y: base + 20, 'text-anchor': 'middle', class: 'dash-eixo' }, it.rotulo));
    });
    return s;
  }

  // Barras horizontais em grade: rótulo | barra | valor · percentual. Alinham por construção.
  function barrasHorizontais(linhas, total, aoClicar) {
    var max = linhas.reduce(function (m, l) { return Math.max(m, l.valor || 0); }, 0) || 1;
    var nodos = [];
    linhas.forEach(function (l) {
      var fn = aoClicar ? function () { aoClicar(l); } : null;
      var trilho = el('span', { classe: 'dash-trilho' }, [el('span', { classe: 'dash-trilho-barra' })]);
      trilho.firstChild.style.width = l.valor == null ? '0%' : Math.max(2, Math.round((l.valor / max) * 100)) + '%';
      nodos.push(clicavel(el('span', { classe: 'dash-linha-rotulo', texto: l.rotulo }), fn, 'Ver detalhes: ' + l.rotulo), tambemClica(trilho, fn));
      nodos.push(tambemClica(l.valor == null ? el('span', { classe: 'dash-num' }, [oculto()])
        : el('span', { classe: 'dash-num', texto: l.valor + (total ? ' · ' + percentual(l.valor, total) : '') }), fn));
    });
    return el('div', { classe: 'dash-barras' }, nodos);
  }

  // Uma faixa 100% dividida por categoria, com legenda alinhada embaixo.
  function faixaProporcao(itens, total, aoClicar) {
    var visiveis = itens.filter(function (i) { return i.valor > 0; });
    var faixa = el('div', { classe: 'dash-faixa', role: 'img', 'aria-label': itens.map(function (i) {
      return i.rotulo + ': ' + (i.valor == null ? 'oculto' : i.valor);
    }).join('; ') });
    visiveis.forEach(function (it) {
      var seg = el('span', { classe: 'dash-seg dash-seg-' + itens.indexOf(it) });
      seg.style.width = (it.valor / total) * 100 + '%';
      faixa.appendChild(seg);
    });
    var legenda = el('div', { classe: 'dash-legenda' }, itens.map(function (it, i) {
      var fn = aoClicar ? function () { aoClicar(it); } : null;
      return [
        el('span', { classe: 'dash-bolinha dash-seg-' + i, 'aria-hidden': 'true' }),
        clicavel(el('span', { classe: 'dash-linha-rotulo', texto: it.rotulo }), fn, 'Ver detalhes: ' + it.rotulo),
        tambemClica(el('span', { classe: 'dash-num' }, [it.valor == null ? oculto() : it.valor + ' · ' + percentual(it.valor, total)]), fn),
      ];
    }).reduce(function (a, b) { return a.concat(b); }, []));
    return el('div', { classe: 'dash-proporcao' }, [faixa, legenda]);
  }

  // Tabela de perfis. Painel geral: fichas, operações com localização e distância mediana.
  // Painel da operação (geral = false): só as fichas daquele perfil.
  function tabelaPerfis(perfis, geral, aoClicar) {
    var max = perfis.reduce(function (m, p) { return Math.max(m, p.fichas || 0); }, 0) || 1;
    var cabecalho = geral ? ['Perfil', '', 'Fichas', 'Com localização', 'Mediana até a localização'] : ['Perfil', '', 'Fichas'];
    var classes = { '': 'dash-cab-barra', 'Com localização': 'dash-col-loc' };
    var nodos = cabecalho.map(function (t) { return el('span', { classe: 'dash-cab' + (classes[t] ? ' ' + classes[t] : ''), texto: t }); });
    perfis.forEach(function (p) {
      var trilho = el('span', { classe: 'dash-trilho dash-trilho-celula' }, [el('span', { classe: 'dash-trilho-barra' })]);
      trilho.firstChild.style.width = p.fichas == null ? '0%' : Math.max(2, Math.round((p.fichas / max) * 100)) + '%';
      var fn = aoClicar ? function () { aoClicar(p); } : null;
      nodos.push(clicavel(el('span', { classe: 'dash-linha-rotulo', texto: nomePerfil(p.perfil) }), fn, 'Ver detalhes: ' + nomePerfil(p.perfil)),
        tambemClica(trilho, fn), tambemClica(el('span', { classe: 'dash-num' }, [valorOu(p.fichas)]), fn));
      if (geral) {
        nodos.push(tambemClica(el('span', { classe: 'dash-num dash-col-loc' }, [valorOu(p.operacoes_com_localizacao)]), fn),
          tambemClica(el('span', { classe: 'dash-num' }, [valorOu(p.mediana_km, km)]), fn));
      }
    });
    return el('div', { classe: 'dash-tabela' + (geral ? ' dash-tabela-geral' : '') }, nodos);
  }

  // Lista de medidas alinhada: rótulo à esquerda, valor à direita.
  function medidas(linhas) {
    var nodos = [];
    linhas.forEach(function (l) {
      nodos.push(el('dt', { texto: l[0] }), el('dd', null, [l[1] == null ? oculto() : l[1]]));
    });
    return el('dl', { classe: 'dash-medidas' }, nodos);
  }

  function cartaoQualidade(q) {
    if (!q) {
      return cartao({ span: 12, titulo: 'Qualidade dos dados', pergunta: 'Sobre quantos casos cada número foi calculado.',
        corpo: [el('p', { classe: 'muted', texto: 'Indisponível: rode a migração 043_qualidade_estudos.sql no Supabase.' })] });
    }
    function n(v, total) { return v == null ? null : String(v) + (total ? ' (' + percentual(v, total) + ')' : ''); }
    var aus = q.ausentes || {}, f = q.fichas || {};
    var colA = medidas([
      ['Unidade de análise', 'operação'],
      ['Casos elegíveis', n(q.elegiveis)],
      ['Com localização (posição)', n(q.com_localizacao, q.elegiveis)],
      ['Válidos para distância', n(q.validos_distancia, q.com_localizacao)],
      ['Válidos para tempo', n(q.validos_tempo, q.com_localizacao)],
    ]);
    var colB = medidas([
      ['Ausente: ULV', n(aus.ulv)],
      ['Ausente: posição da localização', n(aus.posicao_localizacao)],
      ['Ausente: hora de início', n(aus.inicio)],
      ['Tempo negativo (inconsistente)', n(q.tempo_negativo)],
      ['Possíveis duplicatas', n(q.possiveis_duplicatas)],
    ]);
    var colC = medidas([
      ['Não localizados (encerradas)', n(q.nao_localizados)],
      ['Abertas sem localização', n(q.abertas_sem_localizacao)],
      ['Fichas: idade não informada', f.idade_nao_informada == null ? null : String(f.idade_nao_informada)],
      ['Fichas: idade estimada', f.idade_estimada == null ? null : String(f.idade_estimada)],
      ['Fichas: sem perfil', f.sem_perfil == null ? null : String(f.sem_perfil)],
    ]);
    return cartao({
      span: 12, titulo: 'Qualidade dos dados', n: q.elegiveis, pergunta: 'Sobre quantos casos cada número foi calculado, e o que ficou de fora.',
      corpo: [el('div', { classe: 'dash-qualidade' }, [colA, colB, colC])],
      nota: 'Um caso = uma operação (primeira localização com posição). Dado ausente não vira zero: fica fora da conta e aparece aqui. ' +
        'Não localizados ficam fora das medianas de distância e tempo (não se sabe onde nem quando a pessoa seria achada). ' +
        'Duplicata possível: mesmo tipo, ULV a menos de 1 km e início a menos de 48 h — confira se é a mesma ocorrência.',
    });
  }

  /* ------------------------------ painel geral ------------------------------ */
  function renderGeral(d, elemento) {
    var ops = d.operacoes, dist = d.distancia_km, loc = d.localizacoes;
    var meses = ultimos12(ops.por_mes);
    var somaTipo = { aquatica: 0, terrestre: 0, outras: 0 };
    Object.keys(ops.por_tipo || {}).forEach(function (t) { somaTipo[grupoTipo(t)] += ops.por_tipo[t] || 0; });
    var tipos = ['aquatica', 'terrestre', 'outras'].filter(function (k) { return somaTipo[k] > 0 || k !== 'outras'; })
      .map(function (k) { return { chave: k, rotulo: GRUPOS_TIPO[k], valor: somaTipo[k] }; });
    var condicoes = Object.keys(loc.por_condicao || {}).map(function (c) { return { chave: c, rotulo: CONDICOES[c] || c, valor: loc.por_condicao[c] }; });
    var comLocalizacao = loc.operacoes_com_localizacao;
    // Denominador: todas as vítimas localizadas (cada uma tem uma condição; desde a 048, várias por operação).
    // Somar só as visíveis trataria a oculta como zero.
    var vitLocalizadas = loc.vitimas_localizadas != null ? loc.vitimas_localizadas : comLocalizacao;
    var totalCond = typeof vitLocalizadas === 'number' ? vitLocalizadas : condicoes.reduce(function (t, i) { return t + (i.valor || 0); }, 0);

    var topo = el('header', { classe: 'dash-topo' }, [
      el('h2', { texto: 'Dashboard' }),
      el('div', { classe: 'dash-acoes' }, [
        janelaPropria() ? null : el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'dash-nova-janela', texto: '↗ Abrir em outra janela',
          title: 'Abre só o dashboard numa janela própria (ou outro monitor)',
          onclick: function () { abrirJanelaDashboard(''); } }),
      ]),
    ]);

    var nota = 'Toque numa operação para abri-la.';
    var kpis = el('div', { classe: 'dash-kpis' }, [
      kpi('▦', 'Operações', String(ops.total), ops.total ? 'todas as que você acessa' : 'nenhuma ainda', 'ambar', function () {
        abrirDetalhe({ titulo: 'Todas as operações', subtitulo: ops.total + ' no seu acesso, da mais nova para a mais antiga.',
          lista: listaOperacoes(function () { return true; }), vazio: 'Nenhuma operação ainda.', nota: nota });
      }),
      kpi('◉', 'Abertas', String(ops.abertas), 'em andamento agora', 'verde', function () {
        abrirDetalhe({ titulo: 'Operações abertas', subtitulo: 'Em andamento agora.',
          lista: listaOperacoes(function (o) { return !o.encerrada_em; }), vazio: 'Nenhuma operação aberta.', nota: nota });
      }),
      kpi('✓', 'Encerradas', String(ops.encerradas), 'com registro final', 'azul', function () {
        abrirDetalhe({ titulo: 'Operações encerradas', lista: listaOperacoes(function (o) { return Boolean(o.encerrada_em); }),
          vazio: 'Nenhuma operação encerrada.', nota: nota });
      }),
      kpi('⌖', 'Com vítima localizada', valorOu(comLocalizacao), comLocalizacao == null ? 'poucos casos' : percentual(comLocalizacao, ops.total) + ' das operações', 'roxo',
        function () { detalheLocalizadas(d); }),
    ]);

    var notaOculto = temOculto(d) ? el('p', { classe: 'dash-nota-oculto muted', texto: 'Números com menos de ' + d.k_minimo + ' casos aparecem como "oculto", para que ninguém seja identificado.' }) : null;

    // Por mês: duas colunas (aquática e terrestre), contadas da lista de operações do usuário.
    // Sem a lista (falha ao carregar), volta à coluna única do total.
    var corpoMeses, notaMeses;
    if (Array.isArray(d.opsLista)) {
      var porMes = {};
      meses.forEach(function (m) { porMes[m.mes] = { aquatica: 0, terrestre: 0, outras: 0 }; });
      d.opsLista.forEach(function (o) { var m = mesDaOperacao(o); if (porMes[m]) porMes[m][grupoTipo(o.tipo)]++; });
      var outrasPeriodo = meses.reduce(function (t, m) { return t + porMes[m.mes].outras; }, 0);
      var series = [{ chave: 'aquatica', rotulo: 'Aquática', classe: 'aq' }, { chave: 'terrestre', rotulo: 'Terrestre', classe: 'te' }];
      corpoMeses = [
        colunasDuplas(meses.map(function (m) { return { mes: m.mes, rotulo: MESES[Number(m.mes.slice(5)) - 1], valores: porMes[m.mes] }; }), series, 'Operações por mês: aquáticas e terrestres',
          function (it, se) {
            var n = it.valores[se.chave];
            abrirDetalhe({ titulo: 'Operações ' + (se.chave === 'aquatica' ? 'aquáticas' : 'terrestres') + ' de ' + rotuloMes(it.mes),
              subtitulo: n + (n === 1 ? ' operação começou' : ' operações começaram') + ' neste mês.',
              lista: listaOperacoes(function (o) { return mesDaOperacao(o) === it.mes && grupoTipo(o.tipo) === se.chave; }), vazio: 'Nenhuma operação.', nota: nota });
          }),
        el('ul', { classe: 'dash-legenda-series' }, series.map(function (se) { return el('li', null, [el('span', { classe: 'dash-serie dash-serie-' + se.classe }), se.rotulo]); })),
      ];
      notaMeses = 'Toque numa coluna para ver as operações.' + (outrasPeriodo ? ' ' + outrasPeriodo + ' operação(ões) de outros tipos no período aparecem em "Operações por tipo".' : '');
    } else {
      corpoMeses = [colunas(meses.map(function (m) { return { mes: m.mes, rotulo: MESES[Number(m.mes.slice(5)) - 1], valor: m.n }; }), 'Operações por mês',
        function (it) {
          abrirDetalhe({ titulo: 'Operações de ' + rotuloMes(it.mes), subtitulo: it.valor + (it.valor === 1 ? ' operação começou' : ' operações começaram') + ' neste mês.',
            lista: listaOperacoes(function (o) { return mesDaOperacao(o) === it.mes; }), vazio: 'Nenhuma operação neste mês.', nota: nota });
        })];
      notaMeses = 'Toque numa coluna para ver as operações do mês.';
    }
    var grafMeses = cartao({
      span: 8, titulo: 'Operações por mês', n: ops.total, pergunta: 'Quantas buscas aquáticas e terrestres começaram em cada mês, nos últimos 12 meses?',
      corpo: corpoMeses,
      nota: notaMeses,
    });

    var grafTipos = cartao({
      span: 4, titulo: 'Operações por tipo', n: ops.total, pergunta: 'Que tipo de operação predomina?',
      corpo: [barrasHorizontais(tipos, ops.total, function (t) {
        abrirDetalhe({ titulo: 'Operações: ' + t.rotulo, subtitulo: t.valor + ' de ' + ops.total + ' (' + percentual(t.valor, ops.total) + ').',
          lista: listaOperacoes(function (o) { return grupoTipo(o.tipo) === t.chave; }), vazio: 'Nenhuma operação deste tipo.', nota: nota });
      })],
      nota: '"Outros": as que não são busca aquática nem terrestre. Toque num tipo para ver as operações.',
    });

    var grafDist = cartao({
      span: 8, titulo: 'Distância entre o ULV e a localização', n: dist.casos,
      pergunta: 'A que distância do último local visto (ULV) a vítima foi localizada?',
      corpo: [colunas(dist.faixas.map(function (f) { return { rotulo: f.faixa, valor: f.n }; }), 'Distância do ULV à localização', function (f) {
        abrirDetalhe({
          titulo: 'Localizadas a ' + f.rotulo + ' km do ULV',
          medidas: [
            ['Casos nesta faixa', valorOu(f.valor)],
            ['Parte dos casos com distância', f.valor == null || !dist.casos ? null : percentual(f.valor, dist.casos)],
            ['Total de casos com distância', valorOu(dist.casos)],
          ],
          nota: f.valor == null ? 'Menos de ' + d.k_minimo + ' casos: o número fica oculto para que ninguém seja identificado.'
            : 'Distância em linha reta entre o último local visto (ULV) e o ponto onde a vítima foi localizada.',
          acoes: [{ texto: 'Ver operações com vítima localizada', fn: function () { detalheLocalizadas(d); } }],
        });
      })],
      nota: 'ULV = último local visto: o ponto do cadastro da operação (coordenadas do último avistamento). Toque numa coluna para detalhes.',
    });

    var resumoDist = cartao({
      span: 4, titulo: 'Distância e tempo', n: dist.casos, pergunta: 'Resumo dos casos com localização.', dica: 'Como ler ›',
      aoClicar: function () {
        abrirDetalhe({
          titulo: 'Como ler: distância e tempo',
          medidas: [
            ['Mediana', valorOu(dist.mediana, km)],
            ['Metade central (25%–75%)', dist.p25 == null ? null : km(dist.p25) + ' a ' + km(dist.p75)],
            ['Média', valorOu(dist.media, km)],
            ['Tempo até localizar (mediana)', valorOu(loc.minutos_ate_mediana, minutos)],
          ],
          lista: [
            { titulo: 'Mediana', meta: 'Metade dos casos foi localizada mais perto que isso, metade mais longe. Não é puxada por um caso extremo.' },
            { titulo: 'Metade central', meta: 'Faixa onde estão os 50% de casos do meio. Boa referência para o raio de busca inicial.' },
            { titulo: 'Média', meta: 'Soma das distâncias dividida pelo número de casos. Um caso muito longe aumenta bastante a média.' },
            { titulo: 'Tempo até localizar', meta: 'Do início das operações até o primeiro registro de vítima localizada (mediana).' },
          ],
          nota: 'Com menos de ' + d.k_minimo + ' casos os valores ficam ocultos.',
          acoes: [{ texto: 'Ver operações com vítima localizada', fn: function () { detalheLocalizadas(d); } }],
        });
      },
      corpo: [medidas([
        ['Mediana', km(dist.mediana)],
        ['Metade central (25%–75%)', dist.p25 == null ? null : km(dist.p25) + ' a ' + km(dist.p75)],
        ['Média', km(dist.media)],
        ['Tempo até localizar (mediana)', minutos(loc.minutos_ate_mediana)],
      ])],
    });

    var grafPerfis = cartao({
      span: 8, titulo: 'Perfil das vítimas', n: d.perfis.reduce(function (t, p) { return t + (p.fichas || 0); }, 0),
      pergunta: 'Quais perfis aparecem, e em quantos casos a vítima foi localizada?',
      corpo: [tabelaPerfis(d.perfis, true, function (p) {
        abrirDetalhe({
          titulo: 'Perfil: ' + nomePerfil(p.perfil),
          medidas: [
            ['Fichas com este perfil', valorOu(p.fichas)],
            ['Operações com vítima localizada', valorOu(p.operacoes_com_localizacao)],
            ['Distância mediana até a localização', valorOu(p.mediana_km, km)],
          ],
          nota: 'Uma ficha pode ter mais de um perfil. Números com menos de ' + d.k_minimo + ' casos ficam ocultos.',
        });
      })],
      nota: 'Fichas podem ter perfil em branco. A distância mediana por perfil só aparece com 5 ou mais casos. Toque num perfil para detalhes.',
    });

    var grafCond = cartao({
      span: 4, titulo: 'Vítimas localizadas', n: totalCond, pergunta: 'Com vida ou em óbito?',
      corpo: [faixaProporcao(condicoes, totalCond || 1, function (c) {
        abrirDetalhe({
          titulo: 'Vítimas localizadas: ' + c.rotulo.toLowerCase(),
          medidas: [
            ['Vítimas', valorOu(c.valor)],
            ['Parte das localizadas', c.valor == null || !totalCond ? null : percentual(c.valor, totalCond)],
          ],
          nota: 'Conta o primeiro registro de localização de cada vítima.',
          acoes: [{ texto: 'Ver operações com vítima localizada', fn: function () { detalheLocalizadas(d); } }],
        });
      })],
    });

    return [
      topo, kpis, notaOculto, secaoMapaParana(),
      el('div', { classe: 'dash-grade' }, [grafMeses, grafTipos, grafDist, resumoDist, grafPerfis, grafCond, cartaoQualidade(d.qualidade)]),
    ];
  }

  /* ------------------------------ esforço de busca (cálculo puro, sem DOM) ------------------------------ */
  // Entrada: o resumo do painel (Painel.resumoOperacao), com as trilhas já filtradas por GPS.trilha
  // (pontos imprecisos fora, falhas de GPS separando os trechos). Saída: números prontos para desenhar.
  var R_TERRA = 6371008.8, RAD = Math.PI / 180;
  var EM_CAMPO_MS = 10 * 60000;   // "em campo agora": algum ponto nos últimos 10 min
  var PASSOS_MIN = [15, 30, 60, 120, 180, 360, 720, 1440];
  var MAX_BALDES = 24;

  function metros(a, b) {
    var dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R_TERRA * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // projeção plana local (metros), boa para áreas de alguns quilômetros
  function projetor(lat0, lng0) {
    var c = Math.cos(lat0 * RAD);
    return function (lat, lng) { return [(lng - lng0) * RAD * R_TERRA * c, (lat - lat0) * RAD * R_TERRA]; };
  }
  function dentro(x, y, poli) {
    var d = false;
    for (var i = 0, j = poli.length - 1; i < poli.length; j = i++) {
      var xi = poli[i][0], yi = poli[i][1], xj = poli[j][0], yj = poli[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) d = !d;
    }
    return d;
  }

  // Dados do banco (janela própria do dashboard ou link público: dashboard_operacao_dados / dashboard_publico)
  // no mesmo formato do resumo do painel, para os números serem os mesmos nas duas telas.
  var PRECISAO_TRILHA_M = 150;   // a mesma do painel (militar.js, LIM.precisaoTrilhaM)
  function verticesSetor(s) {
    if (s.forma === 'poligono') return s.pontos || [];
    var v = [], c = Math.cos(s.centro_lat * RAD);
    for (var i = 0; i < 64; i++) {
      var a = (i / 64) * 2 * Math.PI;
      v.push([s.centro_lat + (Math.sin(a) * s.raio_m) / (R_TERRA * RAD), s.centro_lng + (Math.cos(a) * s.raio_m) / (R_TERRA * RAD * c)]);
    }
    return v;
  }
  function areaSetorM2(s, v) {
    if (s.forma === 'circulo') return Math.PI * s.raio_m * s.raio_m;
    if (!v.length) return 0;
    var la = 0, ln = 0;
    v.forEach(function (q) { la += q[0]; ln += q[1]; });
    var xy = projetor(la / v.length, ln / v.length), pts = v.map(function (q) { return xy(q[0], q[1]); }), a = 0;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    return Math.abs(a / 2);
  }
  function resumoDoServidor(dd) {
    var G = raiz.GPS;
    var lacuna = dd.operacao && dd.operacao.gps_lacuna_s ? dd.operacao.gps_lacuna_s * 1000 : undefined;
    var participantes = (dd.participantes || []).map(function (p) {
      var pts = (p.pontos || []).map(function (q) { return { lat: q[0], lng: q[1], prec: q[2], t: q[3] }; });
      var segs = G ? G.trilha(pts, { precisaoTrilhaM: PRECISAO_TRILHA_M, lacunaMs: lacuna, objetos: true }).segmentos : (pts.length ? [pts] : []);
      return { id: p.id, nome: p.nome, tipo: p.tipo, grupo: p.grupo || null,
        segmentos: segs.map(function (seg) { return seg.map(function (pt) { return { lat: pt.lat, lng: pt.lng, t: pt.t }; }); }) };
    });
    var setores = (dd.setores || []).map(function (s) {
      var v = verticesSetor(s);
      return { id: s.id, nome: s.nome, areaM2: areaSetorM2(s, v), vertices: v };
    });
    return { agora: Date.now(), participantes: participantes, setores: setores, ocorrencias: dd.ocorrencias || {}, relatos: dd.relatos || [], publico: Boolean(dd.publico) };
  }

  function resumoPessoa(p, agora) {
    var m = 0, ms = 0, pontos = 0, ultimo = null, primeiro = null;
    p.segmentos.forEach(function (seg) {
      for (var i = 1; i < seg.length; i++) m += metros(seg[i - 1], seg[i]);
      if (seg.length > 1) ms += seg[seg.length - 1].t - seg[0].t;
      seg.forEach(function (pt) {
        pontos++;
        if (ultimo == null || pt.t > ultimo) ultimo = pt.t;
        if (primeiro == null || pt.t < primeiro) primeiro = pt.t;
      });
    });
    return { id: p.id, nome: p.nome || 'Participante', tipo: p.tipo, grupo: p.grupo, km: m / 1000, horas: ms / 3600000, pontos: pontos,
      primeiro: primeiro, ultimo: ultimo, emCampo: ultimo != null && agora - ultimo <= EM_CAMPO_MS };
  }

  // Pessoas com pelo menos um ponto em cada intervalo, do início ao fim (ou agora).
  function atividade(r, pessoas, inicio, fim) {
    if (inicio == null) inicio = pessoas.reduce(function (m, p) { return p.primeiro != null && (m == null || p.primeiro < m) ? p.primeiro : m; }, null);
    if (inicio == null || !(fim > inicio)) return null;
    var dur = fim - inicio, passo = null;
    for (var i = 0; i < PASSOS_MIN.length; i++) if (dur / (PASSOS_MIN[i] * 60000) <= MAX_BALDES) { passo = PASSOS_MIN[i] * 60000; break; }
    if (!passo) passo = Math.ceil(dur / MAX_BALDES / 86400000) * 86400000;
    // começa num horário "redondo" (hora cheia, ou múltiplo do passo dentro da hora)
    var d0 = new Date(inicio);
    if (passo >= 3600000) d0.setMinutes(0, 0, 0);
    else d0.setMinutes(Math.floor(d0.getMinutes() / (passo / 60000)) * (passo / 60000), 0, 0);
    var t0 = d0.getTime(), n = Math.max(1, Math.ceil((fim - t0) / passo));
    var conjuntos = [];
    for (var k = 0; k < n; k++) conjuntos.push(new Set());
    r.participantes.forEach(function (p) {
      p.segmentos.forEach(function (seg) {
        seg.forEach(function (pt) {
          var b = Math.floor((pt.t - t0) / passo);
          if (b >= 0 && b < n) conjuntos[b].add(p.id);
        });
      });
    });
    return { inicio: t0, passo: passo, baldes: conjuntos.map(function (s, k) { return { t: t0 + k * passo, pessoas: s.size, ids: Array.from(s) }; }) };
  }

  // Cobertura aproximada de um setor: células de ~30 m (maiores em setores grandes) por onde alguma
  // trilha passou, sobre as células dentro do setor. Entre dois pontos seguidos a linha é preenchida.
  function coberturaSetor(s, r) {
    var v = s.vertices || [];
    if (v.length < 3) return { id: s.id, nome: s.nome, areaKm2: s.areaM2 / 1e6, cobertura: null };
    var la = 0, ln = 0;
    v.forEach(function (p) { la += p[0]; ln += p[1]; });
    var xy = projetor(la / v.length, ln / v.length);
    var poli = v.map(function (p) { return xy(p[0], p[1]); });
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    poli.forEach(function (q) { minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]); miny = Math.min(miny, q[1]); maxy = Math.max(maxy, q[1]); });
    var cel = Math.max(30, Math.sqrt((s.areaM2 || 0) / 40000));
    var nx = Math.max(1, Math.ceil((maxx - minx) / cel)), ny = Math.max(1, Math.ceil((maxy - miny) / cel));
    var dentroSetor = new Uint8Array(nx * ny), visitada = new Uint8Array(nx * ny), total = 0, visitadas = 0;
    for (var j = 0; j < ny; j++) for (var i = 0; i < nx; i++) {
      if (dentro(minx + (i + 0.5) * cel, miny + (j + 0.5) * cel, poli)) { dentroSetor[j * nx + i] = 1; total++; }
    }
    if (!total) return { id: s.id, nome: s.nome, areaKm2: s.areaM2 / 1e6, cobertura: null };
    var ultima = null, quem = new Set();
    function marcar(x, y, t, pid) {
      var i = Math.floor((x - minx) / cel), j = Math.floor((y - miny) / cel);
      if (i < 0 || j < 0 || i >= nx || j >= ny) return;
      var k = j * nx + i;
      if (!dentroSetor[k]) return;
      if (!visitada[k]) { visitada[k] = 1; visitadas++; }
      if (ultima == null || t > ultima) ultima = t;
      quem.add(pid);
    }
    r.participantes.forEach(function (p) {
      p.segmentos.forEach(function (seg) {
        var ant = null;
        seg.forEach(function (pt) {
          var q = xy(pt.lat, pt.lng);
          if (ant) {
            var dx = q[0] - ant.q[0], dy = q[1] - ant.q[1], d = Math.sqrt(dx * dx + dy * dy);
            if (d > cel / 2) {
              var passos = Math.min(400, Math.ceil(d / (cel / 2)));
              for (var s2 = 1; s2 < passos; s2++) {
                var f = s2 / passos;
                marcar(ant.q[0] + dx * f, ant.q[1] + dy * f, ant.t + (pt.t - ant.t) * f, p.id);
              }
            }
          }
          marcar(q[0], q[1], pt.t, p.id);
          ant = { q: q, t: pt.t };
        });
      });
    });
    return { id: s.id, nome: s.nome, areaKm2: s.areaM2 / 1e6, cobertura: visitadas / total, celulaM: Math.round(cel),
      ultimaPassagem: ultima, pessoas: quem.size, ids: Array.from(quem) };
  }

  function calcularEsforco(r, inicio, fim) {
    var agora = r.agora;
    var pessoas = r.participantes.map(function (p) { return resumoPessoa(p, agora); });
    var porGrupo = new Map();
    pessoas.forEach(function (p) {
      if (p.tipo === 'responsavel' && !p.pontos) return;   // responsável sem trilha não é efetivo de campo
      var g = p.grupo || { id: '', nome: 'Sem grupo', cor: null };
      var x = porGrupo.get(g.id) || { id: g.id, nome: g.nome, cor: g.cor, pessoas: 0, km: 0, horas: 0 };
      x.pessoas++; x.km += p.km; x.horas += p.horas;
      porGrupo.set(g.id, x);
    });
    var campo = pessoas.filter(function (p) { return p.tipo !== 'responsavel' || p.pontos; });
    var porTipo = { militar: 0, civil: 0, responsavel: 0 };
    campo.forEach(function (p) { porTipo[p.tipo] = (porTipo[p.tipo] || 0) + 1; });
    var setores = r.setores.map(function (s) { return coberturaSetor(s, r); });
    var areaTotal = 0, areaCoberta = 0;
    setores.forEach(function (s) { if (s.cobertura != null) { areaTotal += s.areaKm2; areaCoberta += s.areaKm2 * s.cobertura; } });
    return {
      efetivo: campo.length,
      porTipo: porTipo,
      emCampo: campo.filter(function (p) { return p.emCampo; }).length,
      km: campo.reduce(function (t, p) { return t + p.km; }, 0),
      horas: campo.reduce(function (t, p) { return t + p.horas; }, 0),
      grupos: Array.from(porGrupo.values()).sort(function (a, b) { return b.km - a.km || a.nome.localeCompare(b.nome); }),
      atividade: atividade(r, campo, inicio, fim != null ? fim : agora),
      setores: setores.sort(function (a, b) { return (a.cobertura == null) - (b.cobertura == null) || (a.cobertura || 0) - (b.cobertura || 0); }),
      coberturaMedia: areaTotal ? areaCoberta / areaTotal : null,
      pessoas: campo,   // para as listas de detalhe
    };
  }

  /* ------------------------------ painel da operação ------------------------------ */
  function duracao(ms) {
    if (ms == null || !(ms >= 0)) return null;
    var m = Math.round(ms / 60000);
    if (m < 1440) return minutos(m);
    var d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
    return d + ' d' + (h ? ' ' + h + ' h' : '');
  }
  function hora(ms) { var d = new Date(ms); return dd(d.getHours()) + ':' + dd(d.getMinutes()); }
  function diaMes(ms) { var d = new Date(ms); return dd(d.getDate()) + '/' + dd(d.getMonth() + 1); }
  function haQuanto(ms, agora) {
    if (ms == null) return null;
    var m = Math.round((agora - ms) / 60000);
    return m < 1 ? 'agora' : 'há ' + duracao(agora - ms);
  }
  function coordenadas(p) { return p.lat.toFixed(5) + ', ' + p.lng.toFixed(5); }
  function pct(x) { return Math.round(x * 100) + '%'; }

  // Pessoas em campo ao longo do tempo (uma coluna por intervalo) com marcas (ex.: vítima localizada).
  // largura: em px da tela, para o texto sair no tamanho real (no celular o gráfico não é encolhido)
  function graficoAtividade(at, marcas, largura, aoClicar) {
    var W = Math.round(Math.max(280, Math.min(760, largura || 760))), H = 240, base = 198, topo = 26, esq = 30, dir = 8;
    var n = at.baldes.length, slot = (W - esq - dir) / n, larg = Math.max(2, slot - 2);
    var max = at.baldes.reduce(function (m, b) { return Math.max(m, b.pessoas); }, 0);
    var s = svg(W, H, 'Pessoas em campo ao longo da operação');
    var escala = function (v) { return max ? (base - topo) * (v / max) : 0; };
    if (max) {
      s.appendChild(sv('line', { x1: esq, x2: W - dir, y1: topo, y2: topo, class: 'dash-grade-linha' }));
      s.appendChild(sv('text', { x: esq - 6, y: topo + 4, 'text-anchor': 'end', class: 'dash-eixo' }, String(max)));
    }
    s.appendChild(sv('line', { x1: esq, x2: W - dir, y1: base, y2: base, class: 'dash-base' }));
    s.appendChild(sv('text', { x: esq - 6, y: base + 4, 'text-anchor': 'end', class: 'dash-eixo' }, '0'));
    var umDia = at.passo >= 86400000;
    var cada = Math.ceil(n / Math.max(3, Math.min(8, Math.floor(W / 80))));
    at.baldes.forEach(function (b, i) {
      var x = esq + i * slot + (slot - larg) / 2;
      var g = sv('g', { class: 'dash-col' });
      var h = escala(b.pessoas);
      g.appendChild(sv('title', null, (umDia ? diaMes(b.t) : diaMes(b.t) + ' ' + hora(b.t) + '–' + hora(b.t + at.passo)) + ' · ' +
        b.pessoas + (b.pessoas === 1 ? ' pessoa' : ' pessoas')));
      // área de toque maior que a barra
      g.appendChild(sv('rect', { x: esq + i * slot, y: topo, width: slot, height: base - topo, class: 'dash-alvo' }));
      if (b.pessoas) g.appendChild(sv('rect', { x: x, y: base - h, width: larg, height: h, rx: Math.min(3, larg / 2), class: 'dash-barra' }));
      if (aoClicar && b.pessoas) clicavel(g, function () { aoClicar(b); });
      s.appendChild(g);
      if (i % cada === 0) {
        var meiaNoite = new Date(b.t).getHours() === 0 && new Date(b.t).getMinutes() === 0;
        var rot = umDia || (meiaNoite && i > 0) ? diaMes(b.t) : hora(b.t);
        s.appendChild(sv('text', { x: esq + i * slot, y: base + 18, 'text-anchor': i === 0 ? 'start' : 'middle', class: 'dash-eixo' }, rot));
      }
    });
    // várias marcas próximas (ex.: duas vítimas localizadas no mesmo intervalo): os rótulos descem um por linha
    var postos = [];
    (marcas || []).slice().sort(function (a, b) { return a.t - b.t; }).forEach(function (m) {
      var x = esq + ((m.t - at.inicio) / at.passo) * slot;
      if (!(x >= esq && x <= W - dir)) return;
      var linha = postos.filter(function (px) { return Math.abs(px - x) < 150; }).length;
      postos.push(x);
      s.appendChild(sv('line', { x1: x, x2: x, y1: topo - 14, y2: base, class: 'dash-marca' }));
      s.appendChild(sv('text', { x: x + (x > W - 150 ? -6 : 6), y: topo - 6 + linha * 13, 'text-anchor': x > W - 150 ? 'end' : 'start', class: 'dash-marca-rotulo' }, m.rotulo));
    });
    return s;
  }

  // Tabela alinhada: cabeçalho e linhas na mesma grade; "barra" vira uma trilha proporcional.
  // aoClicarLinha(índice): a 1ª célula vira o alvo do teclado; as outras também respondem ao toque.
  function tabela(classe, colunas, linhas, aoClicarLinha) {
    var nodos = colunas.map(function (c) { return el('span', { classe: 'dash-cab' + (c.num ? ' dash-cab-num' : '') + (c.classe ? ' ' + c.classe : ''), texto: c.titulo }); });
    linhas.forEach(function (l, j) {
      var fn = aoClicarLinha ? function () { aoClicarLinha(j); } : null;
      colunas.forEach(function (c, i) {
        var v = l[i], no;
        if (c.barra) {
          no = el('span', { classe: 'dash-trilho' + (c.classe ? ' ' + c.classe : '') }, [el('span', { classe: 'dash-trilho-barra' })]);
          no.firstChild.style.width = v == null ? '0%' : Math.max(v > 0 ? 2 : 0, Math.round(v * 100)) + '%';
        } else {
          no = el('span', { classe: (c.num ? 'dash-num' : 'dash-linha-rotulo') + (c.classe ? ' ' + c.classe : '') }, [v == null ? '—' : v]);
        }
        nodos.push(i === 0 ? clicavel(no, fn, 'Ver detalhes') : tambemClica(no, fn));
      });
    });
    return el('div', { classe: 'dash-tab ' + classe }, nodos);
  }

  function ocorrencias(itens) {
    return el('div', { classe: 'dash-ocorr' }, itens.map(function (it) {
      return clicavel(el('div', { classe: 'dash-ocorr-item' + (it.alerta && it.valor ? ' dash-ocorr-alerta' : '') + (it.valor ? '' : ' dash-ocorr-zero') }, [
        el('strong', { texto: it.valor == null ? '—' : String(it.valor) }),
        el('span', { texto: it.rotulo }),
      ]), it.aoClicar, it.dica);
    }));
  }

  // d: resposta de estudo_operacao (pode faltar: banco sem a migração 023); r: resumo do painel
  function renderOperacao(d, r, op, elemento) {
    var agora = r ? r.agora : Date.now();
    var inicio = op.acionado_em ? Date.parse(op.acionado_em) : null;
    var fim = op.encerrada_em ? Date.parse(op.encerrada_em) : null;
    var e = r ? calcularEsforco(r, inicio, fim) : null;
    var loc = d && d.localizacao;
    var encerrada = Boolean(fim);
    // ações no painel (militar.js): ver pessoa / setor no mapa, abrir a central e o diário
    var acoes = (r && r.acoes) || {};
    var porId = new Map((e ? e.pessoas : []).map(function (p) { return [p.id, p]; }));
    var TIPO_PESSOA = { militar: 'militar', civil: 'civil', responsavel: 'responsável' };
    function situacao(p) { return p.emCampo ? 'em campo agora' : p.ultimo ? 'último ponto ' + haQuanto(p.ultimo, agora) : 'sem GPS'; }
    function itemPessoa(p, valor) {
      return {
        titulo: p.nome, meta: [p.grupo ? p.grupo.nome : 'sem grupo', TIPO_PESSOA[p.tipo] || p.tipo, valor != null ? situacao(p) : null].filter(Boolean).join(' · '),
        valor: valor != null ? valor : situacao(p),
        aoClicar: acoes.verPessoa ? function () { acoes.verPessoa(p.id); } : null,
      };
    }
    function detalhePessoas(titulo, subtitulo, pessoas, valorDe) {
      abrirDetalhe({ titulo: titulo, subtitulo: subtitulo, lista: pessoas.map(function (p) { return itemPessoa(p, valorDe ? valorDe(p) : null); }),
        vazio: 'Ninguém.', nota: acoes.verPessoa ? 'Toque numa pessoa para vê-la no mapa e abrir a ficha.' : null });
    }
    function porNome(a, b) { return a.nome.localeCompare(b.nome); }
    function detalheSetor(st) {
      abrirDetalhe({
        titulo: st.nome || 'Setor',
        medidas: [
          ['Área', st.areaKm2 < 1 ? num(st.areaKm2 * 100, 1) + ' ha' : num(st.areaKm2, 2) + ' km²'],
          ['Coberto (aproximado)', st.cobertura == null ? '—' : pct(st.cobertura)],
          ['Última passagem', st.ultimaPassagem ? haQuanto(st.ultimaPassagem, agora) + ' (' + hora(st.ultimaPassagem) + ')' : 'ninguém passou'],
          ['Pessoas que passaram', String(st.pessoas || 0)],
        ],
        lista: (st.ids || []).map(function (id) { return porId.get(id); }).filter(Boolean).sort(porNome).map(function (p) { return itemPessoa(p, null); }),
        vazio: 'Ninguém passou por este setor ainda.',
        acoes: acoes.verSetor ? [{ texto: 'Ver setor no mapa', principal: true, fn: function () { acoes.verSetor(st.id); } }] : null,
      });
    }
    // Várias vítimas por ocorrência (migração 048): cada uma com a própria localização, condição, tempo e distância.
    var vitimas = d && Array.isArray(d.vitimas) ? d.vitimas : null;
    var nomesVit = (r && r.nomesVitimas) || {};
    var TRIAGEM = { verde: 'verde', amarelo: 'amarela', vermelho: 'vermelha', cinza: 'cinza' };
    var FASE_SCI = { localizada: 'localizada', removida: 'removida (ACV)', transportada: 'transportada' };
    function nomeVitima(v) { return (v.vitima_id && nomesVit[v.vitima_id]) || (v.sem_ficha ? 'Vítima sem ficha' : 'Vítima'); }
    function descVitima(v) {
      return [v.idade != null ? v.idade + ' anos' : null, v.sexo === 'F' ? 'feminino' : v.sexo === 'M' ? 'masculino' : null,
        (v.perfil || []).map(nomePerfil).join(', ') || null].filter(Boolean).join(' · ');
    }
    function situacaoVitima(v) {
      if (!v.localizada) return 'procurando';
      return (CONDICOES[v.condicao] || v.condicao || 'localizada') + (v.em ? ' · ' + hora(Date.parse(v.em)) : '');
    }
    function detalheUmaVitima(v) {
      abrirDetalhe({
        titulo: v.rotulo + ' · ' + nomeVitima(v),
        subtitulo: descVitima(v) || (v.sem_ficha ? 'Localização registrada sem ficha de vítima.' : null),
        medidas: [
          ['Situação', v.localizada ? 'localizada · ' + (CONDICOES[v.condicao] || v.condicao || '—').toLowerCase() : 'ainda não localizada'],
          ['Hora', v.em ? diaMes(Date.parse(v.em)) + ' ' + hora(Date.parse(v.em)) : '—'],
          ['Tempo após o início', v.minutos_ate != null ? minutos(v.minutos_ate) : '—'],
          ['Distância do ULV', v.distancia_km != null ? km(v.distancia_km) : (d && d.ulv ? '—' : 'sem ULV')],
          ['No SCI', v.sci ? 'V-' + String(v.sci.numero).padStart(2, '0') + ' · ' + (FASE_SCI[v.sci.fase] || v.sci.fase) + (v.sci.triagem ? ' · triagem ' + TRIAGEM[v.sci.triagem] : '') : '—'],
        ],
      });
    }
    function listaVitimas() {
      abrirDetalhe({
        titulo: 'Vítimas', subtitulo: d.vitimas_localizadas + ' de ' + d.vitimas_total + ' localizada(s)',
        lista: vitimas.map(function (v) {
          return { titulo: v.rotulo + ' · ' + nomeVitima(v), meta: [descVitima(v), v.distancia_km != null ? km(v.distancia_km) + ' do ULV' : null].filter(Boolean).join(' · '),
            valor: situacaoVitima(v), aoClicar: function () { detalheUmaVitima(v); } };
        }),
        vazio: 'Nenhuma vítima cadastrada nem localizada.',
        nota: 'Toque numa vítima para ver os dados dela.',
      });
    }
    function detalheVitima() {
      if (vitimas) { if (vitimas.length === 1) detalheUmaVitima(vitimas[0]); else listaVitimas(); return; }
      abrirDetalhe({
        titulo: 'Vítima',
        medidas: !d ? [['Dados do banco', 'indisponíveis (migração 023)']] : [
          ['Localizada', loc ? 'sim · ' + (CONDICOES[loc.condicao] || loc.condicao).toLowerCase() : 'não'],
          ['Hora', loc ? diaMes(Date.parse(loc.em)) + ' ' + hora(Date.parse(loc.em)) : '—'],
          ['Tempo após o início', loc && loc.minutos_ate != null ? minutos(loc.minutos_ate) : '—'],
          ['Distância do ULV', loc && loc.distancia_km != null ? km(loc.distancia_km) : (d.ulv ? '—' : 'sem ULV')],
          ['Fichas de vítima', String(d.fichas)],
          ['Localizações registradas', String(d.localizacoes)],
        ],
        nota: d && d.ulv ? 'ULV (último local visto): ' + coordenadas(d.ulv) : null,
      });
    }

    var topo = el('div', { classe: 'dash-barra-op' }, [
      el('span', { classe: 'dash-chip ' + (encerrada ? 'dash-chip-fim' : 'dash-chip-aberta'), texto: encerrada ? 'encerrada' : 'em andamento' }),
      el('span', { classe: 'muted dash-atualizado', texto: 'Números de ' + diaMes(agora) + ' ' + hora(agora) }),
      seloAutomatico(ATUALIZAR_OPERACAO_MS),
      r && r.publico ? el('span', { classe: 'dash-chip dash-chip-publico', texto: 'somente visualização' }) : null,
    ]);

    var vitimaValor = !d ? '—' : vitimas && vitimas.length > 1 ? d.vitimas_localizadas + ' de ' + d.vitimas_total : loc ? 'Sim' : 'Não';
    var vitimaDet = !d ? 'sem dados do banco' : vitimas && vitimas.length > 1 ? 'vítimas localizadas'
      : loc ? (CONDICOES[loc.condicao] || loc.condicao) + ' · ' + hora(Date.parse(loc.em)) : 'ainda não localizada';
    var comGente = e && e.atividade ? e.atividade.baldes.filter(function (b) { return b.pessoas; }).length * e.atividade.passo : null;
    var kpis = el('div', { classe: 'dash-kpis dash-kpis-6' }, [
      kpi('◷', 'Duração', duracao((fim || agora) - inicio) || '—', inicio ? (encerrada ? 'encerrada ' + diaMes(fim) + ' ' + hora(fim) : 'desde ' + diaMes(inicio) + ' ' + hora(inicio)) : 'início não informado', 'ambar',
        function () {
          abrirDetalhe({ titulo: 'Duração', medidas: [
            ['Início das operações', inicio ? diaMes(inicio) + ' ' + hora(inicio) : 'não informado'],
            [encerrada ? 'Encerramento' : 'Agora', diaMes(fim || agora) + ' ' + hora(fim || agora)],
            ['Duração', duracao((fim || agora) - inicio) || '—'],
            ['Tempo com alguém em campo', comGente != null ? '≈ ' + duracao(comGente) : '—'],
          ], nota: 'Tempo com alguém em campo: soma dos intervalos do gráfico em que pelo menos uma pessoa enviou posição.' });
        }),
      kpi('◉', 'Efetivo', e ? String(e.efetivo) : '—', e ? (encerrada ? e.porTipo.militar + ' mil. · ' + e.porTipo.civil + ' civis' : e.emCampo + ' em campo agora') : null, 'verde',
        e ? function () {
          detalhePessoas('Efetivo', e.porTipo.militar + ' militares · ' + e.porTipo.civil + ' civis · ' + e.porTipo.responsavel + ' responsáveis com trilha',
            e.pessoas.slice().sort(function (a, b) { return (b.emCampo - a.emCampo) || porNome(a, b); }));
        } : null),
      kpi('↝', 'Percorrido', e ? num(e.km, 1) + ' km' : '—', 'soma das trilhas GPS', 'azul',
        e ? function () { detalhePessoas('Percorrido por pessoa', num(e.km, 1) + ' km no total', e.pessoas.slice().sort(function (a, b) { return b.km - a.km; }), function (p) { return num(p.km, 1) + ' km'; }); } : null),
      kpi('⧗', 'Esforço', e ? num(e.horas, 1) + ' h' : '—', 'pessoa·hora com GPS', 'azul',
        e ? function () { detalhePessoas('Horas com GPS por pessoa', num(e.horas, 1) + ' pessoa·hora no total', e.pessoas.slice().sort(function (a, b) { return b.horas - a.horas; }), function (p) { return num(p.horas, 1) + ' h'; }); } : null),
      kpi('▦', 'Setores', e ? String(e.setores.length) : '—', e && e.coberturaMedia != null ? pct(e.coberturaMedia) + ' coberto' : 'nenhum desenhado', 'ambar',
        e && e.setores.length ? function () {
          abrirDetalhe({ titulo: 'Setores', subtitulo: 'Do menos para o mais coberto.', lista: e.setores.map(function (st) {
            return { titulo: st.nome || 'Setor', meta: st.ultimaPassagem ? 'última passagem ' + haQuanto(st.ultimaPassagem, agora) : 'ninguém passou',
              valor: st.cobertura == null ? '—' : pct(st.cobertura), aoClicar: function () { detalheSetor(st); } };
          }) });
        } : null),
      kpi('⌖', vitimas && vitimas.length > 1 ? 'Localizadas' : 'Localizada', vitimaValor, vitimaDet, 'roxo', detalheVitima),
    ]);

    // pessoas em campo no tempo, com a localização marcada
    var corpoAtiv = e && e.atividade && e.atividade.baldes.some(function (b) { return b.pessoas; })
      ? [graficoAtividade(e.atividade, vitimas ? vitimas.filter(function (v) { return v.em; }).map(function (v) {
          return { t: Date.parse(v.em), rotulo: (vitimas.length > 1 ? v.rotulo + ' localizada ' : 'Vítima localizada ') + hora(Date.parse(v.em)) };
        }) : loc ? [{ t: Date.parse(loc.em), rotulo: 'Vítima localizada ' + hora(Date.parse(loc.em)) }] : [],
        (elemento.clientWidth || 760) - 40, function (b) {
          var intervalo = e.atividade.passo >= 86400000 ? diaMes(b.t) : diaMes(b.t) + ', ' + hora(b.t) + '–' + hora(b.t + e.atividade.passo);
          detalhePessoas('Em campo: ' + intervalo, b.pessoas + (b.pessoas === 1 ? ' pessoa enviou' : ' pessoas enviaram') + ' posição neste intervalo.',
            b.ids.map(function (id) { return porId.get(id); }).filter(Boolean).sort(porNome));
        })]
      : [el('p', { classe: 'muted', texto: 'Ainda não há trilhas GPS nesta operação.' })];
    var cAtiv = cartao({
      span: 8, titulo: 'Pessoas em campo', pergunta: 'Quantas pessoas enviaram posição em cada intervalo, do início até ' + (encerrada ? 'o encerramento' : 'agora') + '.',
      corpo: corpoAtiv,
      nota: e && e.atividade ? 'Início em ' + diaMes(e.atividade.inicio) + '. Cada coluna = ' + duracao(e.atividade.passo) +
        '. Toque numa coluna para ver quem estava em campo.' : null,
    });

    // vítima: localização e perfis (do banco)
    var perfis = d ? Object.keys(d.perfis || {}).map(function (p) { return { rotulo: nomePerfil(p), valor: d.perfis[p] }; })
      .sort(function (a, b) { return b.valor - a.valor; }) : [];
    var cVit = vitimas && vitimas.length > 1 ? cartao({
      span: 4, titulo: 'Vítimas', n: vitimas.length,
      pergunta: 'Cada vítima com a própria situação, hora e distância do último local visto (ULV).',
      corpo: [
        tabela('dash-tab-vitimas', [{ titulo: 'Vítima' }, { titulo: 'Situação' }, { titulo: 'Do ULV', num: true }],
          vitimas.map(function (v) {
            return [el('span', { classe: 'dash-vitima' }, [el('strong', { texto: v.rotulo }), ' ' + nomeVitima(v)]), situacaoVitima(v),
              v.distancia_km != null ? km(v.distancia_km) : '—'];
          }), function (j) { detalheUmaVitima(vitimas[j]); }),
        perfis.length ? el('div', { classe: 'dash-sub' }, [el('h4', { texto: 'Perfis' }), barrasHorizontais(perfis, d.fichas)]) : null,
      ],
      nota: d.ulv ? 'ULV: ' + coordenadas(d.ulv) + '. Toque numa vítima para ver os dados dela.' : 'Sem ponto no cadastro: a distância não é calculada.',
    }) : cartao({
      span: 4, titulo: 'Vítima', n: d ? d.fichas : undefined,
      pergunta: 'Onde e quando foi localizada, a partir do último local visto (ULV).',
      corpo: !d ? [el('p', { classe: 'muted', texto: 'Os dados das vítimas vêm do banco (migração 023). Aplique a migração para ver esta parte.' })] : [
        medidas([
          ['Localizada', loc ? 'sim · ' + (CONDICOES[loc.condicao] || loc.condicao).toLowerCase() : 'não'],
          ['Hora', loc ? diaMes(Date.parse(loc.em)) + ' ' + hora(Date.parse(loc.em)) : '—'],
          ['Tempo após o início', loc && loc.minutos_ate != null ? minutos(loc.minutos_ate) : '—'],
          ['Distância do ULV', loc && loc.distancia_km != null ? km(loc.distancia_km) : (d.ulv ? '—' : 'sem ULV')],
        ]),
        perfis.length ? el('div', { classe: 'dash-sub' }, [el('h4', { texto: 'Perfis' }), barrasHorizontais(perfis, d.fichas)])
          : el('p', { classe: 'muted dash-sub', texto: d.fichas ? 'Fichas sem perfil marcado.' : 'Nenhuma ficha de vítima.' }),
      ],
      nota: d && d.ulv ? 'ULV: ' + coordenadas(d.ulv) : 'Sem ponto no cadastro: a distância não é calculada.',
    });

    // esforço por grupo
    var maxKm = e ? e.grupos.reduce(function (m, g) { return Math.max(m, g.km); }, 0) || 1 : 1;
    var cGrupos = cartao({
      span: 6, titulo: 'Esforço por grupo', n: e ? e.efetivo : undefined, pergunta: 'Quanto cada grupo percorreu e quantas horas ficou com GPS ligado.',
      corpo: [e && e.grupos.length ? tabela('dash-tab-grupos', [
        { titulo: 'Grupo' }, { titulo: 'Pessoas', num: true }, { titulo: '', barra: true, classe: 'dash-so-largo' }, { titulo: 'km', num: true }, { titulo: 'Horas', num: true },
      ], e.grupos.map(function (g) {
        var nome = el('span', { classe: 'dash-grupo' }, [el('span', { classe: 'dash-bolinha' }), g.nome]);
        if (g.cor) nome.firstChild.style.background = g.cor; else nome.firstChild.classList.add('dash-sem-cor');
        return [nome, String(g.pessoas), g.km / maxKm, num(g.km, 1), num(g.horas, 1)];
      }), function (j) {
        var g = e.grupos[j];
        detalhePessoas('Grupo: ' + g.nome, g.pessoas + (g.pessoas === 1 ? ' pessoa' : ' pessoas') + ' · ' + num(g.km, 1) + ' km · ' + num(g.horas, 1) + ' h',
          e.pessoas.filter(function (p) { return (p.grupo ? p.grupo.id : '') === g.id; }).sort(function (a, b) { return b.km - a.km; }),
          function (p) { return num(p.km, 1) + ' km'; });
      }) : el('p', { classe: 'muted', texto: 'Ninguém em campo ainda.' })],
    });

    // cobertura dos setores
    var cSet = cartao({
      span: 6, titulo: 'Cobertura dos setores', n: e ? e.setores.length : undefined,
      pergunta: 'Quanto da área de cada setor teve alguém passando, e quando foi a última passagem.',
      corpo: [e && e.setores.length ? tabela('dash-tab-setores', [
        { titulo: 'Setor' }, { titulo: 'Área', num: true, classe: 'dash-so-largo' }, { titulo: '', barra: true, classe: 'dash-so-largo' }, { titulo: 'Coberto', num: true }, { titulo: 'Última passagem', num: true },
      ], e.setores.map(function (s) {
        return [s.nome || 'Setor', s.areaKm2 < 1 ? num(s.areaKm2 * 100, 1) + ' ha' : num(s.areaKm2, 2) + ' km²', s.cobertura,
          s.cobertura == null ? null : pct(s.cobertura), s.ultimaPassagem ? haQuanto(s.ultimaPassagem, agora) : 'ninguém passou'];
      }), function (j) { detalheSetor(e.setores[j]); }) : el('p', { classe: 'muted', texto: 'Nenhum setor desenhado.' })],
      nota: e && e.setores.length ? 'Aproximado: o setor é dividido em quadrados de ~' + (e.setores[0].celulaM || 30) + ' m; conta como coberto o quadrado por onde passou alguma trilha. Os menos cobertos aparecem primeiro.' : null,
    });

    var o = r ? r.ocorrencias : {};
    // Tocar numa ocorrência mostra a lista dela (não abre a área de mensagens). No painel, cada relato abre o próprio detalhe.
    var relatos = (r && r.relatos) || [];
    var ROT_REL = { AJUDA: 'Pedido de ajuda', PISTA: 'Pista', VESTIGIO: 'Vestígio', OBJETO: 'Objeto', OBSTACULO: 'Obstáculo' };
    function listaRelatos(titulo, filtro, vazio) {
      var itens = relatos.filter(filtro).map(function (m) {
        var t = Date.parse(m.criada_em);
        var txt = m.texto ? String(m.texto).replace(/\s+/g, ' ').trim() : '';
        return {
          titulo: txt ? (txt.length > 90 ? txt.slice(0, 89) + '…' : txt) : (m.direcao !== 'entrada' ? 'Ordem enviada' : ROT_REL[m.categoria] || 'Relato'),
          meta: [m.direcao !== 'entrada' || !txt ? null : ROT_REL[m.categoria], m.autor].filter(Boolean).join(' · '),
          valor: isFinite(t) ? diaMes(t) + ' ' + hora(t) : '',
          aoClicar: acoes.abrirRelato && m.direcao === 'entrada' ? function () { acoes.abrirRelato(m.id); } : null,
        };
      });
      abrirDetalhe({ titulo: titulo, subtitulo: itens.length + (itens.length === 1 ? ' registro' : ' registros') + ', do mais recente ao mais antigo', lista: itens, vazio: vazio,
        nota: acoes.abrirRelato ? 'Toque num relato para ver o detalhe, o local no mapa e a revisão.' : r && r.publico ? 'No link público os textos e os autores não aparecem.' : null });
    }
    function porCategoria(cat) { return function (m) { return m.direcao === 'entrada' && m.categoria === cat; }; }
    var cOcorr = cartao({
      span: 12, titulo: 'Ocorrências', pergunta: 'O que chegou do campo e o que o comando fez.',
      corpo: [ocorrencias([
        { rotulo: 'Pedidos de ajuda', valor: o.ajuda, alerta: true, lista: function (m) { return m.categoria === 'AJUDA'; } },
        { rotulo: 'Pistas', valor: o.PISTA, lista: porCategoria('PISTA') },
        { rotulo: 'Vestígios', valor: o.VESTIGIO, lista: porCategoria('VESTIGIO') },
        { rotulo: 'Objetos', valor: o.OBJETO, lista: porCategoria('OBJETO') },
        { rotulo: 'Obstáculos', valor: o.OBSTACULO, lista: porCategoria('OBSTACULO') },
        { rotulo: 'Fotos', valor: o.fotos },
        { rotulo: 'Pontos marcados', valor: o.pontos },
        { rotulo: 'Ordens enviadas', valor: o.ordens, lista: function (m) { return m.direcao !== 'entrada'; } },
        { rotulo: 'Retornos atrasados', valor: o.retornosAtrasados, alerta: true, aba: 'alertas' },
        { rotulo: 'Registros no diário', valor: d ? d.registros_diario : null, diario: true },
      ].map(function (it) {
        // relatos e ordens: a lista deles aqui mesmo; retornos abrem os alertas; o diário abre o diário
        if (it.lista && it.valor) { it.aoClicar = function () { listaRelatos(it.rotulo, it.lista, 'Nenhum registro.'); }; it.dica = 'Ver a lista'; }
        if (it.aba && acoes.abrirCentral) { it.aoClicar = function () { acoes.abrirCentral(it.aba); }; it.dica = 'Abrir os alertas'; }
        if (it.diario && acoes.abrirDiario) { it.aoClicar = function () { acoes.abrirDiario(); }; it.dica = 'Abrir o diário'; }
        return it;
      }))],
    });

    // Verificação (só no painel, com a operação aberta): o que já foi conferido e o que ainda é só indicação
    var cVerif = null;
    var PN = raiz.Painel, RR = raiz.RelatosRevisao;
    if (PN && PN.op && PN.op() && PN.op().id === op.id && RR && RR.disponivel()) {
      var rv = RR.resumo(PN.mensagens ? PN.mensagens() : []), pe = rv.porEstado;
      var bi = raiz.Binomio && raiz.Binomio.disponivel() ? raiz.Binomio.resumo() : null;
      var oc = raiz.ObservacoesCampo && raiz.ObservacoesCampo.disponivel() ? raiz.ObservacoesCampo.resumo() : null;
      cVerif = cartao({
        span: 12, titulo: 'Verificação', n: rv.total, pergunta: 'Indicação não é confirmação: o que já foi conferido por outro meio e o que ainda espera.',
        corpo: [ocorrencias([
          { rotulo: 'Relatos sem revisão', valor: rv.naoRevisados, alerta: rv.naoRevisados > 0, aba: 'msgs' },
          { rotulo: 'Em análise', valor: pe.em_analise, aba: 'msgs' },
          { rotulo: 'Confirmados', valor: pe.confirmado, aba: 'msgs' },
          { rotulo: 'Descartados', valor: pe.descartado, aba: 'msgs' },
          { rotulo: 'Inconclusivos ou contestados', valor: pe.inconclusivo + pe.contestado, aba: 'msgs' },
          bi ? { rotulo: 'Cão: indicações em análise', valor: bi.emAnalise, alerta: bi.emAnalise > 0, abrir: function () { raiz.Binomio.abrir(); } } : null,
          bi ? { rotulo: 'Cão: confirmadas', valor: bi.confirmadas, abrir: function () { raiz.Binomio.abrir(); } } : null,
          oc ? { rotulo: 'Focos térmicos a verificar', valor: oc.focosAVerificar, alerta: oc.focosAVerificar > 0, abrir: function () { raiz.ObservacoesCampo.abrir('drone'); } } : null,
          oc ? { rotulo: 'Indicações na água', valor: oc.indicacoesAgua, abrir: function () { raiz.ObservacoesCampo.abrir('aquatica'); } } : null,
        ].filter(Boolean).map(function (it) {
          if (it.aba && acoes.abrirCentral) { it.aoClicar = function () { acoes.abrirCentral(it.aba); }; it.dica = 'Abrir as mensagens'; }
          if (it.abrir) { it.aoClicar = it.abrir; it.dica = 'Abrir'; }
          return it;
        }))],
        nota: oc && oc.areaObservadaM2 ? 'Área observada por drone (registrada): ' + (oc.areaObservadaM2 >= 1e4 ? num(oc.areaObservadaM2 / 1e4, 1) + ' ha' : Math.round(oc.areaObservadaM2) + ' m²') + '. Plano de voo não conta como área vista.' : null,
      });
    }

    return [topo, kpis, el('div', { classe: 'dash-grade' }, [cAtiv, cVit, cGrupos, cSet, cOcorr, cVerif])];
  }

  /* ------------------------------ mapa do Paraná (operações) ------------------------------ */
  // Cada operação aparece no LOCAL cadastrado (operacoes.local_lat/local_lng) — nunca na posição de um participante.
  // Limites do estado, das mesorregiões e dos municípios: js/parana-geo.js (IBGE), carregado só quando o mapa abre.
  var LIMITES_PR = [[-26.72, -54.62], [-22.51, -48.02]];
  var STATUS_OP = {
    ativa: { rotulo: 'Ativa', cor: '#22c55e' },
    encerrada: { rotulo: 'Encerrada', cor: '#ef4444' },
  };
  var LETRA_TIPO = { terrestre: 'T', aquatica: 'A', aerea: 'Ae', outras: 'O', sem_tipo: '?' };
  var ATUALIZAR_MAPA_MS = 60000;   // conferência periódica (o tempo real cobre o resto)
  var mapaDash = null;             // { mapa, no, marcadores: Map, camada, canal, timer, sujo }
  var promessaGeo = null, geoDec = null;

  function pararMapa() {
    var m = mapaDash;
    mapaDash = null;
    if (!m) return;
    clearInterval(m.timer);
    document.removeEventListener('visibilitychange', m.aoVoltar);
    if (m.canal) { try { C.cliente.removeChannel(m.canal); } catch (e) { /* ignora */ } }
    try { m.mapa.remove(); } catch (e) { /* ignora */ }
  }

  function carregarGeo() {
    if (raiz.ParanaGeo) return Promise.resolve(raiz.ParanaGeo);
    if (!promessaGeo) {
      promessaGeo = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'js/parana-geo.js';
        s.onload = function () { if (raiz.ParanaGeo) resolve(raiz.ParanaGeo); else reject(new Error('arquivo de limites vazio')); };
        s.onerror = function () { reject(new Error('não foi possível baixar os limites do Paraná')); };
        document.head.appendChild(s);
      });
      promessaGeo.catch(function () { promessaGeo = null; });
    }
    return promessaGeo;
  }

  // polyline (algoritmo do Google), precisão 1e-3, latitude primeiro
  function decodificar(str) {
    var pts = [], i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      var r = [0, 0];
      for (var k = 0; k < 2; k++) {
        var res = 0, sh = 0, b;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
        r[k] = res & 1 ? ~(res >> 1) : res >> 1;
      }
      lat += r[0]; lng += r[1];
      pts.push([lat / 1e3, lng / 1e3]);
    }
    return pts;
  }

  function geoDecodificado(g) {
    if (geoDec) return geoDec;
    geoDec = {
      estado: g.estado.map(decodificar),
      regioes: g.regioes.map(function (r) { return { nome: r.nome, centro: r.centro, aneis: r.aneis.map(decodificar) }; }),
      municipios: g.municipios.map(function (m) { return { nome: m[0], regiao: m[1], caixa: m[2], aneis: m[3].map(decodificar) }; }),
    };
    return geoDec;
  }

  function dentroDoAnel(lat, lng, anel) {
    var dentro = false;
    for (var i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      var yi = anel[i][0], xi = anel[i][1], yj = anel[j][0], xj = anel[j][1];
      if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) dentro = !dentro;
    }
    return dentro;
  }

  // Município e mesorregião do ponto (limites simplificados: perto da divisa pode cair no vizinho).
  function localNoParana(lat, lng) {
    if (!geoDec) return null;
    for (var i = 0; i < geoDec.municipios.length; i++) {
      var m = geoDec.municipios[i], c = m.caixa;
      if (lat < c[0] || lat > c[2] || lng < c[1] || lng > c[3]) continue;
      if (m.aneis.some(function (a) { return dentroDoAnel(lat, lng, a); })) return { municipio: m.nome, regiao: geoDec.regioes[m.regiao] ? geoDec.regioes[m.regiao].nome : '' };
    }
    return { fora: true };
  }

  function temCoordenada(o) {
    return o.local_lat != null && o.local_lng != null && isFinite(o.local_lat) && isFinite(o.local_lng) &&
      Math.abs(o.local_lat) <= 90 && Math.abs(o.local_lng) <= 180 && !(o.local_lat === 0 && o.local_lng === 0);
  }
  function statusDe(o) { return o.status === 'ativa' ? 'ativa' : 'encerrada'; }
  function tipoDe(o) { return LETRA_TIPO[o.tipo] ? o.tipo : 'sem_tipo'; }
  function naturezaDe(o) {
    var base = o.tipo === 'outras' && o.tipo_outro ? 'Outras – ' + o.tipo_outro : TIPOS[tipoDe(o)];
    var nat = o.ipo && o.ipo.natureza;
    return nat ? base + ' · ' + nat : base;
  }

  function iconeOp(o) {
    var st = statusDe(o), tp = tipoDe(o);
    return L.divIcon({
      className: 'dash-mk-wrap',
      // só a cor diz a situação (verde ativa, vermelha encerrada); o tipo fica no popup e na dica
      html: '<span class="dash-mk dash-mk-' + st + '" style="--cor:' + STATUS_OP[st].cor + '" title="' + C.esc(STATUS_OP[st].rotulo + ' · ' + TIPOS[tp]) + '"></span>',
      iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -10],
    });
  }

  function iconeGrupoOps(cluster) {
    var filhos = cluster.getAllChildMarkers();
    var ativas = filhos.filter(function (mk) { return mk.options.statusOp === 'ativa'; }).length;
    var ang = Math.round(ativas / filhos.length * 360);
    return L.divIcon({
      className: 'dash-cluster-wrap',
      html: '<span class="dash-cluster" style="background:conic-gradient(' + STATUS_OP.ativa.cor + ' 0 ' + ang + 'deg,' + STATUS_OP.encerrada.cor + ' 0)" title="' +
        ativas + ' ativa(s), ' + (filhos.length - ativas) + ' encerrada(s)"><b>' + filhos.length + '</b></span>',
      iconSize: [38, 38], iconAnchor: [19, 19],
    });
  }

  function popupOp(o) {
    var st = statusDe(o);
    var loc = localNoParana(o.local_lat, o.local_lng);
    var onde = !loc ? 'Município: carregando limites…' : loc.fora ? 'Fora dos limites do Paraná' : loc.municipio + ' · ' + loc.regiao;
    var quando = o.acionado_em || o.criada_em;
    var resp = el('dd', { texto: 'carregando…' });
    var part = el('dd', { texto: 'carregando…' });
    var compacto = Boolean(mapaDash && mapaDash.no.clientWidth < 480);   // celular: popup menor, botão sempre à vista
    var limite = compacto ? 90 : 160;
    var desc = (o.descricao || '').replace(/\s+/g, ' ').trim();
    if (desc.length > limite) desc = desc.slice(0, limite - 3) + '…';
    var no = el('div', { classe: 'dash-pop' + (compacto ? ' dash-pop-compacto' : '') }, [
      el('strong', { classe: 'dash-pop-titulo', texto: o.codigo || 'Operação' }),
      el('span', { classe: 'dash-pop-status dash-pop-' + st, texto: STATUS_OP[st].rotulo + (st === 'encerrada' && o.encerrada_em ? ' em ' + dataHora(o.encerrada_em) : '') }),
      el('dl', { classe: 'dash-pop-dados' }, [
        el('dt', { texto: 'Tipo' }), el('dd', { texto: naturezaDe(o) }),
        el('dt', { texto: 'Local' }), el('dd', { classe: 'dash-pop-onde', texto: onde }),
        el('dt', { texto: 'Acionada' }), el('dd', { texto: quando ? dataHora(quando) : '—' }),
        el('dt', { texto: 'Responsável' }), resp,
        el('dt', { texto: 'Participantes' }), part,
      ]),
      desc ? el('p', { classe: 'dash-pop-desc', texto: desc }) : null,
      el('button', { classe: 'btn btn-pequeno btn-escuro dash-pop-abrir', type: 'button', texto: o.dados_apagados_em ? 'Abrir operação (dados apagados)' : st === 'ativa' ? 'Abrir operação' : 'Abrir operação (só leitura)',
        onclick: function () { pararMapa(); abrirOperacao(o.id); } }),
    ]);
    // dados que dependem da permissão: o banco só devolve o que este responsável pode ver
    C.rpc('listar_responsaveis', { p_operacao: o.id }).then(function (l) {
      var cri = (l || []).filter(function (r) { return r.criador; })[0] || (l || [])[0];
      resp.textContent = cri ? cri.nome + ((l || []).length > 1 ? ' (+' + (l.length - 1) + ')' : '') : 'não informado';
    }).catch(function () { resp.textContent = 'indisponível'; });
    C.cliente.from('participantes').select('id', { count: 'exact', head: true }).eq('operacao_id', o.id).neq('tipo', 'responsavel').eq('removido', false)
      .then(function (r) { part.textContent = r.error ? 'indisponível' : String(r.count == null ? '—' : r.count); }, function () { part.textContent = 'indisponível'; });
    return no;
  }

  function legendaMapa(ops) {
    var st = {}, tp = {};
    ops.forEach(function (o) { st[statusDe(o)] = (st[statusDe(o)] || 0) + 1; tp[tipoDe(o)] = (tp[tipoDe(o)] || 0) + 1; });
    var itens = [];
    ['ativa', 'encerrada'].forEach(function (k) {
      if (st[k]) itens.push(el('li', null, [el('span', { classe: 'dash-mk dash-mk-' + k + ' dash-mk-leg', style: '--cor:' + STATUS_OP[k].cor }), STATUS_OP[k].rotulo + ' (' + st[k] + ')']));
    });
    if (ops.length > 1) itens.push(el('li', null, [el('span', { classe: 'dash-cluster dash-cluster-leg', style: 'background:conic-gradient(' + STATUS_OP.ativa.cor + ' 0 180deg,' + STATUS_OP.encerrada.cor + ' 0)' }, [el('b', { texto: '2' })]), 'Operações próximas agrupadas']));
    return itens.length ? el('ul', { classe: 'dash-mapa-legenda' }, itens) : el('p', { classe: 'muted dash-mapa-legenda', texto: 'Nenhuma operação com local cadastrado.' });
  }

  function desenharLimites(m, g) {
    var d = geoDecodificado(g);
    var tela = L.canvas({ padding: 0.3 });
    if (!m.mapa.getPane('rotulosRegiao')) m.mapa.createPane('rotulosRegiao').style.zIndex = 450;   // abaixo dos marcadores
    var municipios = L.layerGroup(d.municipios.map(function (x) {
      return L.polygon(x.aneis, { renderer: tela, color: '#94a3b8', weight: 0.6, opacity: 0.55, fill: false, interactive: false });
    }));
    L.layerGroup(d.regioes.map(function (r) {
      return L.polygon(r.aneis, { renderer: tela, color: '#f59e0b', weight: 1.4, opacity: 0.75, dashArray: '5 5', fill: false, interactive: false });
    })).addTo(m.mapa);
    L.polygon(d.estado, { renderer: tela, color: '#f59e0b', weight: 2.6, opacity: 0.95, fillColor: '#f59e0b', fillOpacity: 0.04, interactive: false }).addTo(m.mapa);
    var rotulos = L.layerGroup(d.regioes.map(function (r) {
      return L.marker(r.centro, { pane: 'rotulosRegiao', interactive: false, keyboard: false, icon: L.divIcon({ className: 'dash-rotulo-regiao', html: '<span>' + C.esc(r.nome) + '</span>', iconSize: null }) });
    }));
    function porZoom() {
      var z = m.mapa.getZoom();
      if (z >= 9) municipios.addTo(m.mapa); else municipios.remove();
      if (z <= 9) rotulos.addTo(m.mapa); else rotulos.remove();
    }
    m.mapa.on('zoomend', porZoom);
    porZoom();
  }

  async function atualizarMapa(m) {
    if (mapaDash !== m) return;
    m.sujo = false;
    var ops;
    try {
      ops = await C.consultarTudo(function () {
        return C.cliente.from('operacoes').select('id,codigo,tipo,tipo_outro,status,acionado_em,criada_em,encerrada_em,dados_apagados_em,local_lat,local_lng,local_endereco,descricao,ipo')
          .order('criada_em', { ascending: false });
      });
    } catch (e) {
      if (mapaDash !== m) return;
      m.aviso.hidden = false;
      m.aviso.textContent = 'Não foi possível atualizar as operações do mapa: ' + e.message + (m.marcadores.size ? ' Mostrando o último carregamento.' : '');
      m.aviso.appendChild(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Tentar de novo', onclick: function () { atualizarMapa(m); } }));
      return;
    }
    if (mapaDash !== m) return;
    m.aviso.hidden = true;
    var comLocal = ops.filter(temCoordenada), semLocal = ops.filter(function (o) { return !temCoordenada(o); });
    var vistos = new Set();
    comLocal.forEach(function (o) {
      vistos.add(o.id);
      var assinatura = [o.local_lat, o.local_lng, o.status, o.tipo, o.codigo, o.encerrada_em, o.descricao, o.dados_apagados_em].join('|');
      var x = m.marcadores.get(o.id);
      if (x && x.assinatura === assinatura) { x.o = o; return; }
      if (x) m.camada.removeLayer(x.mk);
      var mk = L.marker([o.local_lat, o.local_lng], { icon: iconeOp(o), statusOp: statusDe(o), title: o.codigo || 'Operação', alt: o.codigo || 'Operação', keyboard: true });
      var item = { o: o, mk: mk, assinatura: assinatura };
      // o popup nunca passa da altura do mapa (no celular ele rola por dentro e o botão continua alcançável)
      var alturaPop = Math.max(180, (m.no.clientHeight || 340) - 70);
      mk.bindPopup(function () { return popupOp(item.o); }, { maxWidth: Math.min(300, (m.no.clientWidth || 300) - 50), minWidth: 200, maxHeight: alturaPop,
        className: 'dash-popup', autoPanPadding: [12, 12] });
      m.camada.addLayer(mk);
      m.marcadores.set(o.id, item);
    });
    m.marcadores.forEach(function (x, id) { if (!vistos.has(id)) { m.camada.removeLayer(x.mk); m.marcadores.delete(id); } });
    m.legenda.replaceChildren(legendaMapa(comLocal));
    m.semLocal.replaceChildren();
    m.semLocal.hidden = !semLocal.length;
    if (semLocal.length) {
      m.semLocal.appendChild(el('span', { texto: semLocal.length + (semLocal.length === 1 ? ' operação sem coordenadas do local não aparece' : ' operações sem coordenadas do local não aparecem') + ' no mapa. ' }));
      m.semLocal.appendChild(el('button', { classe: 'link-botao', type: 'button', texto: 'Ver quais', onclick: function () {
        abrirDetalhe({ titulo: 'Operações sem local no mapa', subtitulo: 'Cadastre o local (Dados da operação) para que apareçam no mapa.',
          lista: semLocal.map(itemOperacao), nota: 'Toque numa operação para abri-la.' });
      } }));
    }
    m.contagem.textContent = comLocal.length + ' no mapa';
  }

  function iniciarMapa(caixa, no) {
    if (!raiz.L || !document.body.contains(no)) return;
    pararMapa();
    var mapa = L.map(no, { zoomSnap: 0.5, minZoom: 5, maxZoom: 18, scrollWheelZoom: false, maxBounds: L.latLngBounds(LIMITES_PR).pad(0.9), worldCopyJump: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · limites: IBGE',
    }).addTo(mapa);
    mapa.fitBounds(LIMITES_PR, { padding: [8, 8] });
    // rolar a página não dá zoom sem querer: a roda só vale depois de tocar no mapa
    mapa.on('click focus', function () { mapa.scrollWheelZoom.enable(); });
    mapa.on('mouseout blur', function () { mapa.scrollWheelZoom.disable(); });
    var camada = L.markerClusterGroup
      ? L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 44, spiderfyOnMaxZoom: true, iconCreateFunction: iconeGrupoOps })
      : L.featureGroup();
    camada.addTo(mapa);
    var m = {
      mapa: mapa, no: no, camada: camada, marcadores: new Map(), canal: null, timer: null, sujo: false,
      aviso: caixa.querySelector('.dash-mapa-aviso'), legenda: caixa.querySelector('.dash-mapa-legenda-caixa'),
      semLocal: caixa.querySelector('.dash-mapa-sem-local'), contagem: caixa.querySelector('.dash-mapa-n'),
    };
    mapaDash = m;
    m.aoVoltar = function () { if (!document.hidden && m.sujo) atualizarMapa(m); };
    document.addEventListener('visibilitychange', m.aoVoltar);
    carregarGeo().then(function (g) {
      if (mapaDash !== m) return;
      desenharLimites(m, g);
      m.marcadores.forEach(function (x) { if (x.mk.isPopupOpen()) x.mk.setPopupContent(popupOp(x.o)); });
    }).catch(function (e) {
      if (mapaDash !== m) return;
      caixa.querySelector('.dash-mapa-nota').textContent = 'Limites de municípios e regiões indisponíveis (' + e.message + '). As operações continuam no mapa.';
    });
    atualizarMapa(m);
    // tempo real (migração 028 põe "operacoes" na publicação); sem ele, a conferência periódica cobre
    try {
      m.canal = C.cliente.channel('dash-operacoes-' + Date.now())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'operacoes' }, function () {
          if (mapaDash !== m) return;
          clearTimeout(m.atraso);
          m.atraso = setTimeout(function () { if (document.hidden || !visivel(m)) m.sujo = true; else atualizarMapa(m); }, 600);
        })
        .subscribe();
    } catch (e) { m.canal = null; }
    m.timer = setInterval(function () {
      if (mapaDash !== m) return;
      if (!document.body.contains(m.no)) { pararMapa(); return; }
      if (document.hidden || !visivel(m)) { m.sujo = true; return; }
      atualizarMapa(m);
    }, ATUALIZAR_MAPA_MS);
  }
  function visivel(m) { return m.no.offsetParent !== null; }

  function secaoMapaParana() {
    var no = el('div', { classe: 'dash-mapa', role: 'region', 'aria-label': 'Mapa do Paraná com as operações' });
    var caixa = el('section', { classe: 'dash-card dash-mapa-card', 'aria-labelledby': 'dash-mapa-titulo' }, [
      el('div', { classe: 'dash-card-topo' }, [
        el('h3', { id: 'dash-mapa-titulo', texto: 'Operações no mapa do Paraná' }),
        el('span', { classe: 'dash-n dash-mapa-n', texto: '…' }),
      ]),
      el('p', { classe: 'dash-pergunta dash-mapa-nota', texto: 'Cada marcador fica no local cadastrado da operação. Toque num marcador para ver os dados; a roda do mouse dá zoom depois de clicar no mapa.' }),
      el('p', { classe: 'erro-form dash-mapa-aviso', role: 'alert', hidden: true }),
      no,
      el('div', { classe: 'dash-mapa-legenda-caixa' }),
      el('p', { classe: 'muted dash-mapa-sem-local', hidden: true }),
    ]);
    if (!raiz.L) {
      no.replaceWith(el('p', { classe: 'erro-form', texto: 'Mapa indisponível: a biblioteca de mapas não carregou (verifique a conexão).' }));
      return caixa;
    }
    // o dashboard é montado fora da página e inserido depois: o mapa começa quando a caixa já está na tela
    setTimeout(function () { iniciarMapa(caixa, no); }, 0);
    return caixa;
  }

  /* ------------------------------ carregamento ------------------------------ */
  // silencioso (atualização automática): os números antigos ficam na tela até os novos chegarem,
  // sem "Carregando…" e sem pular a rolagem; uma falha mantém o que está na tela.
  async function carregar(elemento, chamada, desenhar, silencioso) {
    if (!silencioso) {
      elemento.innerHTML = '';
      elemento.appendChild(el('p', { classe: 'muted dash-carregando', texto: 'Carregando os números…' }));
    }
    try {
      var d = await chamada();
      if (!elemento.isConnected && silencioso) return;
      var rolagem = elemento.closest && elemento.closest('.modal-corpo, .janela-dash-corpo');
      var topo = rolagem ? rolagem.scrollTop : window.scrollY;
      var wrap = el('div', { classe: 'dash' });
      desenhar(d, elemento).forEach(function (n) { if (n) wrap.appendChild(n); });
      elemento.innerHTML = '';
      elemento.appendChild(wrap);
      if (silencioso) { if (rolagem) rolagem.scrollTop = topo; else window.scrollTo(0, topo); }
    } catch (e) {
      if (silencioso) { console.warn('Dashboard: atualização automática falhou:', e.message || e); return; }
      elemento.innerHTML = '';
      elemento.appendChild(el('p', { classe: 'erro-form', texto: 'Não foi possível carregar o painel: ' + (e.message || e) }));
    }
  }

  // Atualização automática (sem botão): de tempos em tempos, com a tela visível, enquanto o dashboard estiver aberto.
  var ATUALIZAR_OPERACAO_MS = 30000, ATUALIZAR_GERAL_MS = 120000;
  function atualizarSozinho(elemento, ms, recarregar) {
    clearInterval(elemento._dashTimer);
    elemento._dashTimer = setInterval(function () {
      if (!elemento.isConnected) { clearInterval(elemento._dashTimer); return; }
      if (document.visibilityState !== 'visible' || elemento._dashOcupado) return;
      elemento._dashOcupado = true;
      Promise.resolve(recarregar()).then(function () { elemento._dashOcupado = false; }, function () { elemento._dashOcupado = false; });
    }, ms);
  }
  function seloAutomatico(ms) {
    return el('span', { classe: 'dash-auto', title: 'Os números se atualizam sozinhos a cada ' + Math.round(ms / 1000) + ' s (com a tela aberta)' }, [
      el('span', { classe: 'dash-auto-ponto', 'aria-hidden': 'true' }), 'atualiza sozinho']);
  }

  // Dashboard numa janela própria: dashboard.html, só o dashboard (sem o mapa nem o painel).
  // Sempre o mesmo nome de janela: abrir de novo reaproveita a que já está aberta.
  function janelaPropria() { return /dashboard\.html$/.test(location.pathname); }
  function abrirJanelaDashboard(busca) { window.open('dashboard.html' + (busca || ''), 'gbs-dashboard', 'noopener'); }

  raiz.Dashboard = {
    geral: function (elemento, silencioso) {
      if (!silencioso) atualizarSozinho(elemento, ATUALIZAR_GERAL_MS, function () { return raiz.Dashboard.geral(elemento, true); });
      pararMapa();
      cacheOps = cacheLocalizadas = null;
      return carregar(elemento, function () {
        return Promise.all([C.rpc('estudo_geral'), operacoesDoUsuario().catch(function () { return null; }), C.rpc('estudo_qualidade').catch(function () { return null; })])
          .then(function (r) {
            // fora do temOculto
            Object.defineProperty(r[0], 'opsLista', { value: r[1], enumerable: false });
            Object.defineProperty(r[0], 'qualidade', { value: r[2], enumerable: false });
            return r[0];
          });
      }, renderGeral, silencioso);
    },
    // opcoes.resumo: função que devolve o resumo do painel (trilhas, grupos, setores, ocorrências).
    // O estudo do banco (vítimas) é opcional: se faltar a migração, o restante aparece mesmo assim.
    // Sem opcoes.resumo (janela própria) os dados vêm do banco (dashboard_operacao_dados); opcoes.publico = token do
    // link público (dashboard_publico, sem login). Os números são os mesmos do painel. Atualiza sozinho.
    operacao: function (op, elemento, opcoes, silencioso) {
      opcoes = opcoes || {};
      if (!silencioso) atualizarSozinho(elemento, ATUALIZAR_OPERACAO_MS, function () { return raiz.Dashboard.operacao(op, elemento, opcoes, true); });
      var fonte = opcoes.resumo;
      return carregar(elemento, async function () {
        var d = null, r = null;
        if (fonte) {
          try { d = await C.rpc('estudo_operacao', { p_operacao: op.id }); } catch (e) { console.warn('estudo_operacao indisponível:', e.message || e); }
          r = fonte();
          r.fonte = fonte;
        } else {
          var dd = opcoes.publico ? await C.rpc('dashboard_publico', { p_token: opcoes.publico }) : await C.rpc('dashboard_operacao_dados', { p_operacao: op.id });
          if (dd.operacao) Object.assign(op, dd.operacao);
          d = dd.estudo || null;
          r = resumoDoServidor(dd);
          if (opcoes.aoCarregar) opcoes.aoCarregar(dd);
        }
        r.acoes = opcoes.acoes || {};
        // nomes das vítimas: só para quem tem login (o estudo e o link público não trazem nomes)
        if (!opcoes.publico && d && d.vitimas && d.vitimas.length) {
          try {
            var fichas = await C.consultar(C.cliente.from('vitimas').select('id,nome').eq('operacao_id', op.id));
            r.nomesVitimas = {};
            (fichas || []).forEach(function (f) { r.nomesVitimas[f.id] = f.nome; });
          } catch (e) { /* sem os nomes: aparecem os rótulos V-01, V-02… */ }
        }
        return { d: d, r: r };
      }, function (x, alvo) { return renderOperacao(x.d, x.r, op, alvo); }, silencioso);
    },
    resumoDoServidor: resumoDoServidor,
    calcularEsforco: calcularEsforco,
    pararMapa: pararMapa,
    localNoParana: function (lat, lng) { return localNoParana(lat, lng); },
    abrirJanela: function (opId) { abrirJanelaDashboard('?op=' + encodeURIComponent(opId)); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
