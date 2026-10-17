/* =====================================================================
 * dashboard.js — painéis de estudo, desenhados sem bibliotecas externas (SVG).
 *   - Dashboard.geral(elemento): painel inicial com os números de todas as operações a que o
 *     responsável tem acesso (estudo_geral): cartões, gráficos e leitura em texto.
 *   - Dashboard.operacao(op, elemento): números de uma operação (estudo_operacao).
 * O banco devolve nulo para grupos com menos de 5 casos: aqui aparecem como "oculto".
 * ===================================================================== */
(function (raiz) {
  'use strict';
  var C = raiz.Comunicacao, UI = raiz.UI;
  var NS = 'http://www.w3.org/2000/svg';

  // nomes dos perfis vêm da mesma lista do formulário (ipo.js): o gráfico e o cadastro não divergem
  function nomePerfil(p) {
    var x = (window.Ipo && window.Ipo.PERFIS_VITIMA || []).filter(function (y) { return y[0] === p; })[0];
    return x ? x[1] : p;
  }
  var TIPOS = { aquatica: 'Aquática', terrestre: 'Terrestre', aerea: 'Aérea', outras: 'Outras', sem_tipo: 'Sem tipo' };
  var CONDICOES = { viva: 'Com vida', obito: 'Em óbito' };
  var MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  var CORES = ['#f59e0b', '#38bdf8', '#34d399', '#a78bfa', '#f472b6', '#fb7185', '#facc15', '#94a3b8'];

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
  function rotuloMes(ym) { var p = ym.split('-'); return MESES[Number(p[1]) - 1] + '/' + p[0].slice(2); }
  function ultimos12(lista) {
    // sempre 12 meses, mesmo sem operação em alguns deles (barra zerada)
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

  /* ------------------------------ blocos ------------------------------ */
  function el(tag, attrs, filhos) { return UI.el(tag, attrs, filhos); }
  function oculto() { return el('span', { classe: 'dash-oculto', texto: 'oculto' }); }
  function ou(v, f) { return v == null ? oculto() : (f ? f(v) : String(v)); }

  function kpi(icone, rotulo, valor, detalhe, cor) {
    return el('div', { classe: 'dash-kpi dash-kpi-' + cor }, [
      el('span', { classe: 'dash-kpi-icone', 'aria-hidden': 'true', texto: icone }),
      el('div', null, [
        el('span', { classe: 'dash-kpi-rotulo', texto: rotulo }),
        el('strong', { classe: 'dash-kpi-valor' }, [valor]),
        detalhe ? el('small', { classe: 'dash-kpi-detalhe', texto: detalhe }) : null,
      ]),
    ]);
  }

  function cartao(titulo, subtitulo, corpo, extra) {
    return el('section', { classe: 'dash-card' + (extra ? ' ' + extra : '') }, [
      el('header', { classe: 'dash-card-topo' }, [
        el('h3', { texto: titulo }),
        subtitulo ? el('small', { classe: 'muted', texto: subtitulo }) : null,
      ]),
      corpo,
    ]);
  }

  /* ------------------------------ gráficos (SVG) ------------------------------ */
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

  // Barras verticais: itens [{rotulo, valor (nulo = oculto)}]
  function barrasVerticais(itens, rotuloGrafico, formato) {
    var W = 600, H = 230, base = 190, topo = 26, esquerda = 8;
    var largura = (W - esquerda * 2) / Math.max(itens.length, 1);
    var max = itens.reduce(function (m, i) { return Math.max(m, i.valor || 0); }, 1);
    var s = svg(W, H, rotuloGrafico);
    var grade = [0.25, 0.5, 0.75, 1];
    grade.forEach(function (f) {
      var y = base - (base - topo) * f;
      s.appendChild(sv('line', { x1: esquerda, x2: W - esquerda, y1: y, y2: y, class: 'dash-grade' }));
    });
    itens.forEach(function (it, i) {
      var x = esquerda + i * largura + largura * 0.18;
      var w = largura * 0.64;
      if (it.valor == null) {
        s.appendChild(sv('rect', { x: x, y: base - 26, width: w, height: 26, rx: 5, class: 'dash-oculto-barra' }));
        s.appendChild(sv('text', { x: x + w / 2, y: base - 34, 'text-anchor': 'middle', class: 'dash-eixo' }, 'oculto'));
      } else {
        var h = Math.max(2, (base - topo) * (it.valor / max));
        s.appendChild(sv('rect', { x: x, y: base - h, width: w, height: h, rx: 6, class: 'dash-barra', fill: 'url(#dash-grad)' }));
        s.appendChild(sv('text', { x: x + w / 2, y: base - h - 6, 'text-anchor': 'middle', class: 'dash-valor' }, formato ? formato(it.valor) : String(it.valor)));
      }
      s.appendChild(sv('text', { x: x + w / 2, y: base + 18, 'text-anchor': 'middle', class: 'dash-eixo' }, it.rotulo));
    });
    var defs = sv('defs');
    var grad = sv('linearGradient', { id: 'dash-grad', x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.appendChild(sv('stop', { offset: '0%', 'stop-color': '#fbbf24' }));
    grad.appendChild(sv('stop', { offset: '100%', 'stop-color': '#b45309' }));
    defs.appendChild(grad);
    s.insertBefore(defs, s.firstChild);
    return s;
  }

  // Rosca: itens [{rotulo, valor}] (valores nulos ficam fora e aparecem como oculto na legenda)
  function rosca(itens, rotuloGrafico, centro) {
    var visiveis = itens.filter(function (i) { return i.valor > 0; });
    var total = visiveis.reduce(function (t, i) { return t + i.valor; }, 0);
    var s = svg(200, 200, rotuloGrafico);
    var r = 70, c = 2 * Math.PI * r, acumulado = 0;
    s.appendChild(sv('circle', { cx: 100, cy: 100, r: r, fill: 'none', 'stroke-width': 24, class: 'dash-trilho-rosca' }));
    visiveis.forEach(function (it, i) {
      var parte = c * (it.valor / (total || 1));
      s.appendChild(sv('circle', { cx: 100, cy: 100, r: r, fill: 'none', 'stroke-width': 24, stroke: CORES[i % CORES.length],
        'stroke-dasharray': parte + ' ' + (c - parte), 'stroke-dashoffset': -acumulado,
        transform: 'rotate(-90 100 100)', 'stroke-linecap': 'butt' }));
      acumulado += parte;
    });
    s.appendChild(sv('text', { x: 100, y: 96, 'text-anchor': 'middle', class: 'dash-centro-n' }, centro.valor));
    s.appendChild(sv('text', { x: 100, y: 118, 'text-anchor': 'middle', class: 'dash-centro-r' }, centro.rotulo));
    return s;
  }

  function legenda(itens, total) {
    return el('ul', { classe: 'dash-legenda' }, itens.map(function (it, i) {
      var pct = it.valor == null || !total ? null : Math.round((it.valor / total) * 100);
      return el('li', null, [
        el('span', { classe: 'dash-bolinha', 'aria-hidden': 'true' }),
        el('span', { classe: 'dash-legenda-rotulo', texto: it.rotulo }),
        el('strong', null, [it.valor == null ? oculto() : String(it.valor) + (pct != null ? ' · ' + pct + '%' : '')]),
      ]);
    }));
  }

  // Cores da legenda seguem a ordem da rosca (só para os valores visíveis)
  function pintarBolinhas(lista, itens) {
    var visiveis = itens.filter(function (i) { return i.valor > 0; });
    var ordem = visiveis.map(function (i) { return i.rotulo; });
    lista.querySelectorAll('li').forEach(function (li, idx) {
      var rotulo = itens[idx] && itens[idx].rotulo;
      var pos = ordem.indexOf(rotulo);
      if (pos >= 0) li.querySelector('.dash-bolinha').style.background = CORES[pos % CORES.length];
    });
    return lista;
  }

  // Faixas de distância: histograma
  function histograma(faixas) {
    return barrasVerticais(faixas.map(function (f) { return { rotulo: f.faixa, valor: f.n }; }), 'Distribuição da distância entre o ULV e a localização da vítima', null);
  }

  /* ------------------------------ leitura em texto ------------------------------ */
  function frases(dados) {
    var ops = dados.operacoes, dist = dados.distancia_km, loc = dados.localizacoes;
    var out = [];
    if (ops.total === 0) return ['Ainda não há operações no seu acesso.'];
    out.push('Você tem ' + ops.total + ' operaç' + (ops.total === 1 ? 'ão' : 'ões') + ': ' + ops.abertas + ' abert' + (ops.abertas === 1 ? 'a' : 'as') + ' e ' + ops.encerradas + ' encerrada' + (ops.encerradas === 1 ? '' : 's') + '.');
    var pico = ultimos12(ops.por_mes).reduce(function (m, x) { return x.n > m.n ? x : m; }, { mes: null, n: 0 });
    if (pico.n > 0) out.push('O mês com mais operações nos últimos 12 meses foi ' + rotuloMes(pico.mes) + ', com ' + pico.n + '.');
    if (dist.mediana != null) {
      out.push('Em ' + dist.casos + ' casos com vítima localizada, a distância mediana entre o ULV e o local da localização foi de ' + km(dist.mediana) + '. Metade dos casos ficou entre ' + km(dist.p25) + ' e ' + km(dist.p75) + '.');
    }
    if (loc.minutos_ate_mediana != null) out.push('A localização aconteceu, em mediana, ' + minutos(loc.minutos_ate_mediana) + ' depois do início das operações.');
    var perfisVisiveis = dados.perfis.filter(function (p) { return p.fichas != null; }).sort(function (a, b) { return b.fichas - a.fichas; });
    if (perfisVisiveis.length) out.push('O perfil mais frequente entre as vítimas é "' + nomePerfil(perfisVisiveis[0].perfil) + '", com ' + perfisVisiveis[0].fichas + ' ficha' + (perfisVisiveis[0].fichas === 1 ? '' : 's') + '.');
    var condicoes = loc.por_condicao || {};
    if (condicoes.viva != null || condicoes.obito != null) {
      out.push('Entre as vítimas localizadas: ' + (condicoes.viva != null ? condicoes.viva + ' com vida' : 'um número oculto com vida') + ' e ' + (condicoes.obito != null ? condicoes.obito + ' em óbito' : 'um número oculto em óbito') + '.');
    }
    var algumOculto = JSON.stringify(dados).indexOf('null') >= 0;
    if (algumOculto) out.push('Números com menos de ' + dados.k_minimo + ' casos ficam ocultos, para que ninguém seja identificado.');
    return out;
  }

  /* ------------------------------ painel geral ------------------------------ */
  function renderGeral(d) {
    var ops = d.operacoes, dist = d.distancia_km, loc = d.localizacoes;
    var meses = ultimos12(ops.por_mes);
    var tipos = Object.keys(ops.por_tipo || {}).map(function (t) { return { rotulo: TIPOS[t] || t, valor: ops.por_tipo[t] }; });
    var totalTipos = tipos.reduce(function (t, i) { return t + (i.valor || 0); }, 0);
    var condicoes = Object.keys(loc.por_condicao || {}).map(function (c) { return { rotulo: CONDICOES[c] || c, valor: loc.por_condicao[c] }; });
    var totalCond = condicoes.reduce(function (t, i) { return t + (i.valor || 0); }, 0);

    var topo = el('header', { classe: 'dash-topo' }, [
      el('div', null, [
        el('h2', { texto: 'Estatísticas e estudos' }),
        el('p', { classe: 'muted', texto: 'Todas as operações a que você tem acesso · só números, sem identificação' }),
      ]),
      el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Atualizar', onclick: function () { raiz.Dashboard.geral(this.closest('.dash').parentNode); } }),
    ]);

    var kpis = el('div', { classe: 'dash-kpis' }, [
      kpi('▦', 'Operações', String(ops.total), ops.total ? 'todas as que você acessa' : 'nenhuma ainda', 'ambar'),
      kpi('◉', 'Abertas', String(ops.abertas), 'em andamento agora', 'verde'),
      kpi('✓', 'Encerradas', String(ops.encerradas), 'com registro final', 'azul'),
      kpi('⌖', 'Com vítima localizada', ou(loc.operacoes_com_localizacao), dist.casos != null ? dist.casos + ' com distância calculada' : 'poucos casos para calcular', 'roxo'),
    ]);

    var leitura = el('section', { classe: 'dash-leitura' }, [
      el('h3', { texto: 'Leitura rápida' }),
      el('ul', null, frases(d).map(function (f) { return el('li', { texto: f }); })),
    ]);

    var grafMeses = cartao('Operações por mês', 'últimos 12 meses', barrasVerticais(meses.map(function (m) {
      return { rotulo: MESES[Number(m.mes.slice(5)) - 1], valor: m.n };
    }), 'Operações por mês nos últimos 12 meses'), 'dash-largo');

    var grafTipos = cartao('Operações por tipo', 'participação', el('div', { classe: 'dash-rosca-linha' }, [
      rosca(tipos, 'Operações por tipo', { valor: String(totalTipos), rotulo: 'operações' }),
      pintarBolinhas(legenda(tipos, totalTipos), tipos),
    ]));

    var grafDist = cartao('Distância do ULV à localização', 'faixas de 1 km ou mais', histograma(dist.faixas), 'dash-largo');

    var resumoDist = cartao('Distância e tempo', 'mediana e metade central', el('div', { classe: 'dash-medidas' }, [
      medida('Mediana', km(dist.mediana)),
      medida('Metade central', dist.p25 == null ? null : km(dist.p25) + ' a ' + km(dist.p75)),
      medida('Média', km(dist.media)),
      medida('Tempo até localizar (mediana)', minutos(loc.minutos_ate_mediana)),
    ]));

    var perfisMax = d.perfis.reduce(function (m, p) { return Math.max(m, p.fichas || 0); }, 1);
    var grafPerfis = cartao('Perfil das vítimas', 'fichas e distância mediana por perfil', el('div', { classe: 'dash-perfis' },
      d.perfis.map(function (p) {
        var trilho = el('span', { classe: 'dash-trilho' }, [el('span', { classe: 'dash-trilho-barra' })]);
        trilho.firstChild.style.width = p.fichas == null ? '0%' : Math.round((p.fichas / perfisMax) * 100) + '%';
        return el('div', { classe: 'dash-perfil' }, [
          el('span', { classe: 'dash-perfil-nome', texto: nomePerfil(p.perfil) }),
          trilho,
          el('span', { classe: 'dash-perfil-n' }, [ou(p.fichas)]),
          el('span', { classe: 'dash-perfil-km' }, [p.mediana_km == null ? el('span', { classe: 'muted', texto: 'distância oculta' }) : km(p.mediana_km)]),
        ]);
      })), 'dash-largo');

    var grafCond = cartao('Condição da vítima localizada', 'com vida ou em óbito', el('div', { classe: 'dash-rosca-linha' }, [
      rosca(condicoes, 'Condição da vítima localizada', { valor: String(totalCond), rotulo: 'localizadas' }),
      pintarBolinhas(legenda(condicoes, totalCond), condicoes),
    ]));

    var rodape = el('p', { classe: 'dash-rodape muted', texto: 'Atualizado em ' + dataHora(d.gerado_em) + '. Números com menos de ' + d.k_minimo + ' casos aparecem como "oculto".' });

    return [topo, kpis, leitura, el('div', { classe: 'dash-grade' }, [grafMeses, grafTipos, grafDist, resumoDist, grafPerfis, grafCond]), rodape];
  }

  function medida(rotulo, valor) {
    return el('div', { classe: 'dash-medida' }, [el('span', { texto: rotulo }), el('strong', null, [valor == null ? oculto() : valor])]);
  }

  /* ------------------------------ painel da operação ------------------------------ */
  function linhaDl(dl, rotulo, valorTexto) {
    dl.appendChild(UI.el('dt', { texto: rotulo }));
    dl.appendChild(UI.el('dd', { texto: valorTexto }));
  }

  function renderOperacao(d) {
    var loc = d.localizacao;
    var dl = UI.el('dl', { classe: 'dados' });
    linhaDl(dl, 'ULV (último local visto)', d.ulv ? window.Coords.formatar(d.ulv.lat, d.ulv.lng, 'dec') : 'sem ponto no cadastro');
    linhaDl(dl, 'Início das operações', d.acionado_em ? dataHora(d.acionado_em) : '—');
    linhaDl(dl, 'Localização da vítima', loc ? (CONDICOES[loc.condicao] || loc.condicao) + ' · ' + dataHora(loc.em) : 'nenhuma registrada ainda');
    linhaDl(dl, 'Distância do ULV', loc && loc.distancia_km != null ? km(loc.distancia_km) : '—');
    linhaDl(dl, 'Tempo desde o início das operações', loc && loc.minutos_ate != null ? minutos(loc.minutos_ate) : '—');
    var perfis = Object.keys(d.perfis || {}).map(function (p) { return { rotulo: nomePerfil(p), valor: d.perfis[p] }; });
    return [
      el('div', { classe: 'dash-kpis' }, [
        kpi('◎', 'Vítimas (fichas)', String(d.fichas), null, 'ambar'),
        kpi('⌖', 'Localizações', String(d.localizacoes), null, 'roxo'),
        kpi('▦', 'Setores', String(d.setores), null, 'azul'),
        kpi('☰', 'Registros no diário', String(d.registros_diario), null, 'verde'),
      ]),
      el('div', { classe: 'dash-grade dash-grade-op' }, [
        cartao('ULV e localização', null, dl),
        cartao('Perfis das vítimas', null, perfis.length ? barrasVerticais(perfis, 'Perfis das vítimas desta operação') : el('p', { classe: 'muted', texto: 'Nenhuma ficha de vítima nesta operação.' })),
      ]),
    ];
  }

  /* ------------------------------ carregamento ------------------------------ */
  async function carregar(elemento, chamada, desenhar) {
    elemento.innerHTML = '';
    elemento.appendChild(el('p', { classe: 'muted dash-carregando', texto: 'Carregando os números…' }));
    try {
      var d = await chamada();
      elemento.innerHTML = '';
      var wrap = el('div', { classe: 'dash' });
      desenhar(d).forEach(function (n) { wrap.appendChild(n); });
      elemento.appendChild(wrap);
    } catch (e) {
      elemento.innerHTML = '';
      elemento.appendChild(el('p', { classe: 'erro-form', texto: 'Não foi possível carregar o painel: ' + (e.message || e) }));
    }
  }

  raiz.Dashboard = {
    geral: function (elemento) { return carregar(elemento, function () { return C.rpc('estudo_geral'); }, renderGeral); },
    operacao: function (op, elemento) {
      return carregar(elemento, function () { return C.rpc('estudo_operacao', { p_operacao: op.id }); }, renderOperacao);
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
