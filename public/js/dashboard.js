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
      s.appendChild(sv('line', { x1: margem, x2: W - margem, y1: y, y2: y, class: 'dash-grade-linha' }));
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
    return { id: p.id, tipo: p.tipo, grupo: p.grupo, km: m / 1000, horas: ms / 3600000, pontos: pontos,
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
    return { inicio: t0, passo: passo, baldes: conjuntos.map(function (s, k) { return { t: t0 + k * passo, pessoas: s.size }; }) };
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
      ultimaPassagem: ultima, pessoas: quem.size };
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
  function graficoAtividade(at, marcas, largura) {
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
      s.appendChild(g);
      if (i % cada === 0) {
        var meiaNoite = new Date(b.t).getHours() === 0 && new Date(b.t).getMinutes() === 0;
        var rot = umDia || (meiaNoite && i > 0) ? diaMes(b.t) : hora(b.t);
        s.appendChild(sv('text', { x: esq + i * slot, y: base + 18, 'text-anchor': i === 0 ? 'start' : 'middle', class: 'dash-eixo' }, rot));
      }
    });
    (marcas || []).forEach(function (m) {
      var x = esq + ((m.t - at.inicio) / at.passo) * slot;
      if (!(x >= esq && x <= W - dir)) return;
      s.appendChild(sv('line', { x1: x, x2: x, y1: topo - 14, y2: base, class: 'dash-marca' }));
      s.appendChild(sv('text', { x: x + (x > W - 150 ? -6 : 6), y: topo - 6, 'text-anchor': x > W - 150 ? 'end' : 'start', class: 'dash-marca-rotulo' }, m.rotulo));
    });
    return s;
  }

  // Tabela alinhada: cabeçalho e linhas na mesma grade; "barra" vira uma trilha proporcional.
  function tabela(classe, colunas, linhas) {
    var nodos = colunas.map(function (c) { return el('span', { classe: 'dash-cab' + (c.num ? ' dash-cab-num' : '') + (c.classe ? ' ' + c.classe : ''), texto: c.titulo }); });
    linhas.forEach(function (l) {
      colunas.forEach(function (c, i) {
        var v = l[i];
        if (c.barra) {
          var trilho = el('span', { classe: 'dash-trilho' + (c.classe ? ' ' + c.classe : '') }, [el('span', { classe: 'dash-trilho-barra' })]);
          trilho.firstChild.style.width = v == null ? '0%' : Math.max(v > 0 ? 2 : 0, Math.round(v * 100)) + '%';
          nodos.push(trilho);
        } else {
          nodos.push(el('span', { classe: (c.num ? 'dash-num' : 'dash-linha-rotulo') + (c.classe ? ' ' + c.classe : '') }, [v == null ? '—' : v]));
        }
      });
    });
    return el('div', { classe: 'dash-tab ' + classe }, nodos);
  }

  function ocorrencias(itens) {
    return el('div', { classe: 'dash-ocorr' }, itens.map(function (it) {
      return el('div', { classe: 'dash-ocorr-item' + (it.alerta && it.valor ? ' dash-ocorr-alerta' : '') + (it.valor ? '' : ' dash-ocorr-zero') }, [
        el('strong', { texto: it.valor == null ? '—' : String(it.valor) }),
        el('span', { texto: it.rotulo }),
      ]);
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

    var topo = el('div', { classe: 'dash-barra-op' }, [
      el('span', { classe: 'dash-chip ' + (encerrada ? 'dash-chip-fim' : 'dash-chip-aberta'), texto: encerrada ? 'encerrada' : 'em andamento' }),
      el('span', { classe: 'muted dash-atualizado', texto: 'Números de ' + diaMes(agora) + ' ' + hora(agora) }),
      el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Atualizar', onclick: function () { raiz.Dashboard.operacao(op, elemento, { resumo: r && r.fonte }); } }),
    ]);

    var vitimaValor = !d ? '—' : loc ? 'Sim' : 'Não';
    var vitimaDet = !d ? 'sem dados do banco' : loc ? (CONDICOES[loc.condicao] || loc.condicao) + ' · ' + hora(Date.parse(loc.em)) : 'ainda não localizada';
    var kpis = el('div', { classe: 'dash-kpis dash-kpis-6' }, [
      kpi('◷', 'Duração', duracao((fim || agora) - inicio) || '—', inicio ? (encerrada ? 'encerrada ' + diaMes(fim) + ' ' + hora(fim) : 'desde ' + diaMes(inicio) + ' ' + hora(inicio)) : 'início não informado', 'ambar'),
      kpi('◉', 'Efetivo', e ? String(e.efetivo) : '—', e ? (encerrada ? e.porTipo.militar + ' mil. · ' + e.porTipo.civil + ' civis' : e.emCampo + ' em campo agora') : null, 'verde'),
      kpi('↝', 'Percorrido', e ? num(e.km, 1) + ' km' : '—', 'soma das trilhas GPS', 'azul'),
      kpi('⧗', 'Esforço', e ? num(e.horas, 1) + ' h' : '—', 'pessoa·hora com GPS', 'azul'),
      kpi('▦', 'Setores', e ? String(e.setores.length) : '—', e && e.coberturaMedia != null ? pct(e.coberturaMedia) + ' coberto' : 'nenhum desenhado', 'ambar'),
      kpi('⌖', 'Localizada', vitimaValor, vitimaDet, 'roxo'),
    ]);

    // pessoas em campo no tempo, com a localização marcada
    var corpoAtiv = e && e.atividade && e.atividade.baldes.some(function (b) { return b.pessoas; })
      ? [graficoAtividade(e.atividade, loc ? [{ t: Date.parse(loc.em), rotulo: 'Vítima localizada ' + hora(Date.parse(loc.em)) }] : [],
        (elemento.clientWidth || 760) - 40)]
      : [el('p', { classe: 'muted', texto: 'Ainda não há trilhas GPS nesta operação.' })];
    var cAtiv = cartao({
      span: 8, titulo: 'Pessoas em campo', pergunta: 'Quantas pessoas enviaram posição em cada intervalo, do início até ' + (encerrada ? 'o encerramento' : 'agora') + '.',
      corpo: corpoAtiv,
      nota: e && e.atividade ? 'Início em ' + diaMes(e.atividade.inicio) + '. Cada coluna = ' + duracao(e.atividade.passo) +
        '. Passe o mouse ou toque numa coluna para ver o número.' : null,
    });

    // vítima: localização e perfis (do banco)
    var perfis = d ? Object.keys(d.perfis || {}).map(function (p) { return { rotulo: nomePerfil(p), valor: d.perfis[p] }; })
      .sort(function (a, b) { return b.valor - a.valor; }) : [];
    var cVit = cartao({
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
      })) : el('p', { classe: 'muted', texto: 'Ninguém em campo ainda.' })],
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
      })) : el('p', { classe: 'muted', texto: 'Nenhum setor desenhado.' })],
      nota: e && e.setores.length ? 'Aproximado: o setor é dividido em quadrados de ~' + (e.setores[0].celulaM || 30) + ' m; conta como coberto o quadrado por onde passou alguma trilha. Os menos cobertos aparecem primeiro.' : null,
    });

    var o = r ? r.ocorrencias : {};
    var cOcorr = cartao({
      span: 12, titulo: 'Ocorrências', pergunta: 'O que chegou do campo e o que o comando fez.',
      corpo: [ocorrencias([
        { rotulo: 'Pedidos de ajuda', valor: o.ajuda, alerta: true },
        { rotulo: 'Pistas', valor: o.PISTA },
        { rotulo: 'Vestígios', valor: o.VESTIGIO },
        { rotulo: 'Objetos', valor: o.OBJETO },
        { rotulo: 'Obstáculos', valor: o.OBSTACULO },
        { rotulo: 'Fotos', valor: o.fotos },
        { rotulo: 'Pontos marcados', valor: o.pontos },
        { rotulo: 'Ordens enviadas', valor: o.ordens },
        { rotulo: 'Retornos atrasados', valor: o.retornosAtrasados, alerta: true },
        { rotulo: 'Registros no diário', valor: d ? d.registros_diario : null },
      ])],
    });

    return [topo, kpis, el('div', { classe: 'dash-grade' }, [cAtiv, cVit, cGrupos, cSet, cOcorr])];
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
    // opcoes.resumo: função que devolve o resumo do painel (trilhas, grupos, setores, ocorrências).
    // O estudo do banco (vítimas) é opcional: se faltar a migração, o restante aparece mesmo assim.
    operacao: function (op, elemento, opcoes) {
      var fonte = opcoes && opcoes.resumo;
      return carregar(elemento, async function () {
        var d = null;
        try { d = await C.rpc('estudo_operacao', { p_operacao: op.id }); } catch (e) { console.warn('estudo_operacao indisponível:', e.message || e); }
        var r = fonte ? fonte() : null;
        if (r) r.fonte = fonte;
        return { d: d, r: r };
      }, function (x, alvo) { return renderOperacao(x.d, x.r, op, alvo); });
    },
    calcularEsforco: calcularEsforco,
  };
})(typeof window !== 'undefined' ? window : globalThis);
