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

  function kpi(icone, rotulo, valor, detalhe, cor) {
    return el('div', { classe: 'dash-kpi dash-kpi-' + cor }, [
      el('span', { classe: 'dash-kpi-icone', 'aria-hidden': 'true', texto: icone }),
      el('div', { classe: 'dash-kpi-texto' }, [
        el('span', { classe: 'dash-kpi-rotulo', texto: rotulo }),
        el('strong', { classe: 'dash-kpi-valor' }, [valor]),
        detalhe ? el('small', { classe: 'dash-kpi-detalhe', texto: detalhe }) : null,
      ]),
    ]);
  }

  // Cartão com estrutura fixa: título, n (tamanho da amostra), pergunta, corpo e nota.
  // span: colunas da grade (12 = largura toda).
  function cartao(o) {
    var amostra = o.n == null ? el('span', { classe: 'dash-n dash-n-baixo', texto: 'n < 5' })
      : el('span', { classe: 'dash-n', texto: 'n = ' + o.n });
    return el('section', { classe: 'dash-card dash-s' + (o.span || 12) }, [
      el('header', { classe: 'dash-card-topo' }, [el('h3', { texto: o.titulo }), o.n === undefined ? null : amostra]),
      o.pergunta ? el('p', { classe: 'dash-pergunta', texto: o.pergunta }) : null,
      el('div', { classe: 'dash-card-corpo' }, o.corpo),
      o.nota ? el('p', { classe: 'dash-card-nota', texto: o.nota }) : null,
    ]);
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
  function colunas(itens, rotuloGrafico) {
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
      s.appendChild(sv('line', { x1: margem, x2: W - margem, y1: y, y2: y, class: 'dash-grade' }));
    });
    s.appendChild(sv('line', { x1: margem, x2: W - margem, y1: base, y2: base, class: 'dash-base' }));
    itens.forEach(function (it, i) {
      var x = margem + i * slot + (slot - largura) / 2;
      var cx = x + largura / 2;
      if (it.valor == null) {
        s.appendChild(sv('rect', { x: x, y: base - 14, width: largura, height: 14, rx: 4, class: 'dash-oculta' }));
      } else if (it.valor === 0) {
        s.appendChild(sv('rect', { x: x, y: base - 3, width: largura, height: 3, rx: 1.5, class: 'dash-zero' }));
      } else {
        var h = Math.max(6, (base - topo) * (it.valor / max));
        s.appendChild(sv('rect', { x: x, y: base - h, width: largura, height: h, rx: 5, fill: 'url(#' + id + ')' }));
        s.appendChild(sv('text', { x: cx, y: base - h - 7, 'text-anchor': 'middle', class: 'dash-valor' }, String(it.valor)));
      }
      s.appendChild(sv('text', { x: cx, y: base + 20, 'text-anchor': 'middle', class: 'dash-eixo' }, it.rotulo));
    });
    return s;
  }

  // Barras horizontais em grade: rótulo | barra | valor · percentual. Alinham por construção.
  function barrasHorizontais(linhas, total) {
    var max = linhas.reduce(function (m, l) { return Math.max(m, l.valor || 0); }, 0) || 1;
    var nodos = [];
    linhas.forEach(function (l) {
      var trilho = el('span', { classe: 'dash-trilho' }, [el('span', { classe: 'dash-trilho-barra' })]);
      trilho.firstChild.style.width = l.valor == null ? '0%' : Math.max(2, Math.round((l.valor / max) * 100)) + '%';
      nodos.push(el('span', { classe: 'dash-linha-rotulo', texto: l.rotulo }), trilho);
      nodos.push(l.valor == null ? el('span', { classe: 'dash-num' }, [oculto()])
        : el('span', { classe: 'dash-num', texto: l.valor + (total ? ' · ' + percentual(l.valor, total) : '') }));
    });
    return el('div', { classe: 'dash-barras' }, nodos);
  }

  // Uma faixa 100% dividida por categoria, com legenda alinhada embaixo.
  function faixaProporcao(itens, total) {
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
      return [
        el('span', { classe: 'dash-bolinha dash-seg-' + i, 'aria-hidden': 'true' }),
        el('span', { classe: 'dash-linha-rotulo', texto: it.rotulo }),
        el('span', { classe: 'dash-num' }, [it.valor == null ? oculto() : it.valor + ' · ' + percentual(it.valor, total)]),
      ];
    }).reduce(function (a, b) { return a.concat(b); }, []));
    return el('div', { classe: 'dash-proporcao' }, [faixa, legenda]);
  }

  // Tabela de perfis. Painel geral: fichas, operações com localização e distância mediana.
  // Painel da operação (geral = false): só as fichas daquele perfil.
  function tabelaPerfis(perfis, geral) {
    var max = perfis.reduce(function (m, p) { return Math.max(m, p.fichas || 0); }, 0) || 1;
    var cabecalho = geral ? ['Perfil', '', 'Fichas', 'Com localização', 'Mediana até a localização'] : ['Perfil', '', 'Fichas'];
    var classes = { '': 'dash-cab-barra', 'Com localização': 'dash-col-loc' };
    var nodos = cabecalho.map(function (t) { return el('span', { classe: 'dash-cab' + (classes[t] ? ' ' + classes[t] : ''), texto: t }); });
    perfis.forEach(function (p) {
      var trilho = el('span', { classe: 'dash-trilho dash-trilho-celula' }, [el('span', { classe: 'dash-trilho-barra' })]);
      trilho.firstChild.style.width = p.fichas == null ? '0%' : Math.max(2, Math.round((p.fichas / max) * 100)) + '%';
      nodos.push(el('span', { classe: 'dash-linha-rotulo', texto: nomePerfil(p.perfil) }), trilho,
        el('span', { classe: 'dash-num' }, [valorOu(p.fichas)]));
      if (geral) {
        nodos.push(el('span', { classe: 'dash-num dash-col-loc' }, [valorOu(p.operacoes_com_localizacao)]),
          el('span', { classe: 'dash-num' }, [valorOu(p.mediana_km, km)]));
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

  /* ------------------------------ leitura em texto ------------------------------ */
  function frases(d) {
    var ops = d.operacoes, dist = d.distancia_km, loc = d.localizacoes;
    if (ops.total === 0) return ['Ainda não há operações no seu acesso.'];
    var out = [];
    out.push('Você tem ' + ops.total + ' operaç' + (ops.total === 1 ? 'ão' : 'ões') + ': ' + ops.abertas + ' abert' + (ops.abertas === 1 ? 'a' : 'as') +
      ' e ' + ops.encerradas + ' encerrada' + (ops.encerradas === 1 ? '' : 's') + '.');
    var pico = ultimos12(ops.por_mes).reduce(function (m, x) { return x.n > m.n ? x : m; }, { mes: null, n: 0 });
    if (pico.n > 0) out.push('O mês com mais operações nos últimos 12 meses foi ' + rotuloMes(pico.mes) + ', com ' + pico.n + '.');
    if (dist.mediana != null) {
      out.push('Em ' + dist.casos + ' casos com vítima localizada, a distância mediana entre o último local visto (ULV) e o local da localização é de ' +
        km(dist.mediana) + '. Metade dos casos fica entre ' + km(dist.p25) + ' e ' + km(dist.p75) + '.');
    }
    if (loc.minutos_ate_mediana != null) out.push('A localização acontece, em mediana, ' + minutos(loc.minutos_ate_mediana) + ' depois do início das operações.');
    var perfis = d.perfis.filter(function (p) { return p.fichas != null; }).sort(function (a, b) { return b.fichas - a.fichas; });
    if (perfis.length) out.push('O perfil mais frequente entre as vítimas é "' + nomePerfil(perfis[0].perfil) + '", com ' + perfis[0].fichas + ' ficha' + (perfis[0].fichas === 1 ? '' : 's') + '.');
    var cond = loc.por_condicao || {};
    if (cond.viva != null || cond.obito != null) {
      out.push('Entre as vítimas localizadas: ' + (cond.viva != null ? cond.viva + ' com vida' : 'um número oculto com vida') +
        ' e ' + (cond.obito != null ? cond.obito + ' em óbito' : 'um número oculto em óbito') + '.');
    }
    return out;
  }

  /* ------------------------------ painel geral ------------------------------ */
  function renderGeral(d, elemento) {
    var ops = d.operacoes, dist = d.distancia_km, loc = d.localizacoes;
    var meses = ultimos12(ops.por_mes);
    var tipos = Object.keys(ops.por_tipo || {}).map(function (t) { return { rotulo: TIPOS[t] || t, valor: ops.por_tipo[t] }; });
    var condicoes = Object.keys(loc.por_condicao || {}).map(function (c) { return { rotulo: CONDICOES[c] || c, valor: loc.por_condicao[c] }; });
    var totalCond = condicoes.reduce(function (t, i) { return t + (i.valor || 0); }, 0);
    var comLocalizacao = loc.operacoes_com_localizacao;

    var topo = el('header', { classe: 'dash-topo' }, [
      el('div', null, [
        el('h2', { texto: 'Estatísticas e estudos' }),
        el('p', { classe: 'muted', texto: 'Todas as operações a que você tem acesso. Só números, sem identificação.' }),
      ]),
      el('div', { classe: 'dash-acoes' }, [
        el('span', { classe: 'dash-atualizado muted', texto: 'Atualizado em ' + dataHora(d.gerado_em) }),
        el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Atualizar', onclick: function () { raiz.Dashboard.geral(elemento); } }),
      ]),
    ]);

    var kpis = el('div', { classe: 'dash-kpis' }, [
      kpi('▦', 'Operações', String(ops.total), ops.total ? 'todas as que você acessa' : 'nenhuma ainda', 'ambar'),
      kpi('◉', 'Abertas', String(ops.abertas), 'em andamento agora', 'verde'),
      kpi('✓', 'Encerradas', String(ops.encerradas), 'com registro final', 'azul'),
      kpi('⌖', 'Com vítima localizada', valorOu(comLocalizacao), comLocalizacao == null ? 'poucos casos' : percentual(comLocalizacao, ops.total) + ' das operações', 'roxo'),
    ]);

    var leitura = el('section', { classe: 'dash-leitura' }, [
      el('h3', { texto: 'Leitura rápida' }),
      el('ul', null, frases(d).map(function (f) { return el('li', { texto: f }); })),
      temOculto(d) ? el('p', { classe: 'dash-nota-oculto muted', texto: 'Números com menos de ' + d.k_minimo + ' casos aparecem como "oculto", para que ninguém seja identificado.' }) : null,
    ]);

    var grafMeses = cartao({
      span: 8, titulo: 'Operações por mês', n: ops.total, pergunta: 'Quantas operações começaram em cada mês, nos últimos 12 meses?',
      corpo: [colunas(meses.map(function (m) { return { rotulo: MESES[Number(m.mes.slice(5)) - 1], valor: m.n }; }), 'Operações por mês')],
    });

    var grafTipos = cartao({
      span: 4, titulo: 'Operações por tipo', n: ops.total, pergunta: 'Que tipo de operação predomina?',
      corpo: [barrasHorizontais(tipos, ops.total)],
    });

    var grafDist = cartao({
      span: 8, titulo: 'Distância entre o ULV e a localização', n: dist.casos,
      pergunta: 'A que distância do último local visto (ULV) a vítima foi localizada?',
      corpo: [colunas(dist.faixas.map(function (f) { return { rotulo: f.faixa, valor: f.n }; }), 'Distância do ULV à localização')],
      nota: 'ULV = último local visto: o ponto do cadastro da operação (coordenadas do último avistamento).',
    });

    var resumoDist = cartao({
      span: 4, titulo: 'Distância e tempo', n: dist.casos, pergunta: 'Resumo dos casos com localização.',
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
      corpo: [tabelaPerfis(d.perfis, true)],
      nota: 'Fichas podem ter perfil em branco. A distância mediana por perfil só aparece com 5 ou mais casos.',
    });

    var grafCond = cartao({
      span: 4, titulo: 'Vítimas localizadas', n: totalCond, pergunta: 'Com vida ou em óbito?',
      corpo: [faixaProporcao(condicoes, totalCond || 1)],
    });

    return [
      topo, kpis, leitura,
      el('div', { classe: 'dash-grade' }, [grafMeses, grafTipos, grafDist, resumoDist, grafPerfis, grafCond]),
    ];
  }

  /* ------------------------------ painel da operação ------------------------------ */
  // Os números da operação são do próprio responsável: nada aqui fica oculto por tamanho de amostra.
  // Dados que não existem (sem ponto, sem localização) aparecem por extenso, não como "oculto".
  function minutosDesde(iso) {
    var t = Date.parse(iso);
    return isNaN(t) ? null : Math.max(0, (Date.now() - t) / 60000);
  }
  function coordenadas(p) { return p.lat.toFixed(5) + ', ' + p.lng.toFixed(5); }

  // Linha do tempo: início das operações → localização da vítima, com o tempo entre os dois no meio.
  // Sem localização, mostra o que falta: em andamento há X, ou encerrada sem localização.
  function linhaDoTempo(d) {
    var loc = d.localizacao, inicio = d.acionado_em;
    function no(rotulo, valor, sub, classe) {
      return el('div', { classe: 'dash-tempo-no ' + classe }, [
        el('span', { classe: 'dash-tempo-rotulo', texto: rotulo }),
        el('strong', { classe: 'dash-tempo-data', texto: valor }),
        sub ? el('small', { classe: 'muted', texto: sub }) : null,
      ]);
    }
    var meio;
    if (loc) {
      meio = [el('span', { classe: 'dash-tempo-rotulo', texto: 'Até a localização' }),
        el('strong', { classe: 'dash-tempo-medida', texto: minutos(loc.minutos_ate) || '—' }),
        el('span', { classe: 'dash-tempo-trilho ativo' })];
    } else if (d.encerrada_em) {
      meio = [el('span', { classe: 'dash-tempo-rotulo', texto: 'Encerrada' }),
        el('strong', { classe: 'dash-tempo-medida', texto: 'sem localização' }),
        el('span', { classe: 'dash-tempo-trilho tracejado' })];
    } else {
      var decorrido = inicio ? minutos(minutosDesde(inicio)) : null;
      meio = [el('span', { classe: 'dash-tempo-rotulo', texto: 'Em andamento' }),
        el('strong', { classe: 'dash-tempo-medida', texto: decorrido ? 'há ' + decorrido : 'sem início registrado' }),
        el('span', { classe: 'dash-tempo-trilho tracejado' })];
    }
    return el('section', { classe: 'dash-tempo', 'aria-label': 'Linha do tempo da operação' }, [
      no('Início das operações', inicio ? dataHora(inicio) : 'não informado', null, 'dash-tempo-ini'),
      el('div', { classe: 'dash-tempo-centro' }, meio),
      loc
        ? no('Localização da vítima', dataHora(loc.em), CONDICOES[loc.condicao] || loc.condicao, 'dash-tempo-fim')
        : no('Localização da vítima', 'ainda não registrada', null, 'dash-tempo-fim dash-tempo-pendente'),
    ]);
  }

  function renderOperacao(d, op, elemento) {
    var loc = d.localizacao;
    var perfis = Object.keys(d.perfis || {}).map(function (p) { return { rotulo: nomePerfil(p), valor: d.perfis[p] }; })
      .sort(function (a, b) { return b.valor - a.valor; });
    var encerrada = Boolean(d.encerrada_em);

    var topo = el('header', { classe: 'dash-topo' }, [
      el('div', null, [
        el('h2', { texto: 'Estudo da operação' }),
        el('p', { classe: 'muted' }, [
          el('span', { texto: d.codigo + ' · ' }),
          el('span', { classe: 'dash-chip ' + (encerrada ? 'dash-chip-fim' : 'dash-chip-aberta'), texto: encerrada ? 'encerrada' : 'em andamento' }),
        ]),
      ]),
      el('div', { classe: 'dash-acoes' }, [
        el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Atualizar', onclick: function () { raiz.Dashboard.operacao(op, elemento); } }),
      ]),
    ]);

    var kpis = el('div', { classe: 'dash-kpis' }, [
      kpi('◎', 'Vítimas (fichas)', String(d.fichas), d.fichas ? 'com ficha cadastrada' : 'nenhuma ficha ainda', 'ambar'),
      kpi('⌖', 'Localizada', loc ? 'Sim' : 'Não', loc ? (CONDICOES[loc.condicao] || loc.condicao) : 'ainda não registrada', 'roxo'),
      kpi('↔', 'Distância do ULV', loc && loc.distancia_km != null ? km(loc.distancia_km) : '—',
        loc ? 'entre o último local visto e a localização' : 'sem localização', 'azul'),
      kpi('☰', 'Registros no diário', String(d.registros_diario), null, 'verde'),
    ]);

    var cartaoPerfis = cartao({
      span: 7, titulo: 'Perfil das vítimas', n: d.fichas,
      pergunta: 'Quais perfis foram cadastrados nas fichas desta operação?',
      corpo: [perfis.length ? barrasHorizontais(perfis, d.fichas)
        : el('p', { classe: 'muted', texto: 'Nenhuma ficha com perfil cadastrado.' })],
    });

    var cartaoLocal = cartao({
      span: 5, titulo: 'Local', pergunta: 'Onde está o último local visto e quantos registros há?',
      corpo: [medidas([
        ['Último local visto (ULV)', d.ulv ? coordenadas(d.ulv) : 'sem ponto no cadastro'],
        ['Localizações registradas', String(d.localizacoes)],
        ['Setores de busca', String(d.setores)],
      ])],
      nota: 'ULV = último local visto: o ponto do cadastro da operação. Sem ponto, a distância não é calculada.',
    });

    return [topo, kpis, linhaDoTempo(d), el('div', { classe: 'dash-grade' }, [cartaoPerfis, cartaoLocal])];
  }

  /* ------------------------------ carregamento ------------------------------ */
  async function carregar(elemento, chamada, desenhar) {
    elemento.innerHTML = '';
    elemento.appendChild(el('p', { classe: 'muted dash-carregando', texto: 'Carregando os números…' }));
    try {
      var d = await chamada();
      elemento.innerHTML = '';
      var wrap = el('div', { classe: 'dash' });
      desenhar(d, elemento).forEach(function (n) { wrap.appendChild(n); });
      elemento.appendChild(wrap);
    } catch (e) {
      elemento.innerHTML = '';
      elemento.appendChild(el('p', { classe: 'erro-form', texto: 'Não foi possível carregar o painel: ' + (e.message || e) }));
    }
  }

  raiz.Dashboard = {
    geral: function (elemento) { return carregar(elemento, function () { return C.rpc('estudo_geral'); }, renderGeral); },
    operacao: function (op, elemento) {
      return carregar(elemento, function () { return C.rpc('estudo_operacao', { p_operacao: op.id }); },
        function (d, alvo) { return renderOperacao(d, op, alvo); });
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
