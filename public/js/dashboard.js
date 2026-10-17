/* =====================================================================
 * dashboard.js — painéis de estudo.
 *   - Dashboard.geral(elemento): números de todas as operações a que o responsável tem acesso
 *     (painel inicial). Só agregados (estudo_geral).
 *   - Dashboard.operacao(op, elemento): números de uma operação (estudo_operacao).
 * Grupos com menos de 5 casos chegam nulos do banco e aparecem como "oculto": ninguém é identificável.
 * ===================================================================== */
(function (raiz) {
  'use strict';
  var C = raiz.Comunicacao, UI = raiz.UI;

  var PERFIS = {
    idoso: 'Idoso', crianca: 'Criança', adolescente: 'Adolescente', demencia: 'Alzheimer / demência',
    autismo: 'Autismo (TEA)', deficiencia_intelectual: 'Deficiência intelectual', transtorno_mental: 'Transtorno mental', outro: 'Outro',
  };
  var TIPOS = { aquatica: 'Aquática', terrestre: 'Terrestre', aerea: 'Aérea', outras: 'Outras', sem_tipo: 'Sem tipo' };
  var CONDICOES = { viva: 'Com vida', obito: 'Em óbito' };
  var MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  function dd(n) { return (n < 10 ? '0' : '') + n; }
  function dataHora(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '—' : dd(d.getDate()) + '/' + dd(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + dd(d.getHours()) + ':' + dd(d.getMinutes());
  }
  function oculto() { return UI.el('span', { classe: 'est-oculto', texto: 'oculto (menos de 5 casos)' }); }
  function valor(v) { return v == null ? oculto() : String(v); }
  function km(v) { return v == null ? oculto() : String(v).replace('.', ',') + ' km'; }
  function minutos(m) {
    if (m == null) return '—';
    if (m < 60) return Math.round(m) + ' min';
    return Math.floor(m / 60) + ' h' + (Math.round(m) % 60 ? ' ' + (Math.round(m) % 60) + ' min' : '');
  }
  function rotuloMes(ym) {
    var p = ym.split('-');
    return MESES[Number(p[1]) - 1] + '/' + p[0].slice(2);
  }

  function cartao(titulo, filhos) {
    return UI.el('section', { classe: 'est-bloco' }, [UI.el('h3', { texto: titulo })].concat(filhos));
  }
  function numero(rotulo, conteudo) {
    return UI.el('div', { classe: 'est-numero' }, [UI.el('strong', null, [conteudo]), UI.el('span', { texto: rotulo })]);
  }
  // linhas: [{ rotulo, n }] — n nulo mostra "oculto"; a barra é proporcional ao maior valor visível
  function barras(linhas) {
    if (!linhas.length) return UI.el('p', { classe: 'muted', texto: 'Nenhum registro.' });
    var max = linhas.reduce(function (m, l) { return Math.max(m, l.n || 0); }, 1);
    return UI.el('div', { classe: 'est-barras' }, linhas.map(function (l) {
      var barra = UI.el('span', { classe: 'est-barra' });
      barra.style.width = l.n == null ? '0%' : Math.round((l.n / max) * 100) + '%';
      return UI.el('div', { classe: 'est-linha' }, [
        UI.el('span', { classe: 'est-rotulo', texto: l.rotulo }),
        UI.el('span', { classe: 'est-trilho' }, [barra]),
        l.n == null ? oculto() : UI.el('span', { classe: 'est-n', texto: String(l.n) }),
      ]);
    }));
  }
  function porChave(obj, nomes) {
    return Object.keys(obj || {}).map(function (k) { return { rotulo: nomes[k] || k, n: obj[k] }; });
  }
  function tabelaPerfis(lista) {
    return UI.el('table', { classe: 'est-tabela' }, [
      UI.el('thead', null, [UI.el('tr', null, ['Perfil', 'Fichas', 'Com localização', 'Mediana do ULV até a localização'].map(function (t) {
        return UI.el('th', { texto: t });
      }))]),
      UI.el('tbody', null, lista.map(function (p) {
        return UI.el('tr', null, [
          UI.el('td', { texto: PERFIS[p.perfil] || p.perfil }),
          UI.el('td', null, [valor(p.fichas)]),
          UI.el('td', null, [valor(p.operacoes_com_localizacao)]),
          UI.el('td', null, [km(p.mediana_km)]),
        ]);
      })),
    ]);
  }

  function renderGeral(d) {
    var ops = d.operacoes, dist = d.distancia_km, loc = d.localizacoes;
    return [
      UI.el('p', { classe: 'muted', texto: 'Números de todas as operações a que você tem acesso. Grupos com menos de ' + d.k_minimo +
        ' casos ficam ocultos, para que ninguém seja identificado pelos números.' }),
      UI.el('div', { classe: 'est-numeros' }, [
        numero('operações', String(ops.total)), numero('abertas', String(ops.abertas)), numero('encerradas', String(ops.encerradas)),
        numero('com vítima localizada', valor(loc.operacoes_com_localizacao)),
      ]),
      cartao('Operações por tipo', [barras(porChave(ops.por_tipo, TIPOS))]),
      cartao('Operações nos últimos 12 meses', [barras(ops.por_mes.map(function (m) { return { rotulo: rotuloMes(m.mes), n: m.n }; }))]),
      cartao('Distância do ULV até o local em que a vítima foi localizada', [
        UI.el('div', { classe: 'est-numeros' }, [
          numero('casos', valor(dist.casos)),
          numero('mediana', km(dist.mediana)),
          numero('metade dos casos entre', dist.p25 == null ? oculto() : km(dist.p25) + ' e ' + km(dist.p75)),
          numero('média', km(dist.media)),
          numero('tempo até a localização (mediana)', loc.minutos_ate_mediana == null ? oculto() : minutos(loc.minutos_ate_mediana)),
        ]),
        barras(dist.faixas.map(function (f) { return { rotulo: f.faixa, n: f.n }; })),
      ]),
      cartao('Perfil da vítima', [tabelaPerfis(d.perfis)]),
      cartao('Condição da vítima localizada', [barras(porChave(loc.por_condicao, CONDICOES))]),
    ];
  }

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
    linhaDl(dl, 'Tempo desde o início das operações', loc ? minutos(loc.minutos_ate) : '—');
    return [
      UI.el('p', { classe: 'muted', texto: 'Dados desta operação. O ULV é o ponto do cadastro (coordenadas do último avistamento).' }),
      UI.el('div', { classe: 'est-numeros' }, [
        numero('vítimas (fichas)', String(d.fichas)), numero('localizações', String(d.localizacoes)),
        numero('setores', String(d.setores)), numero('registros no diário', String(d.registros_diario)),
      ]),
      cartao('ULV e localização', [dl]),
      cartao('Perfis das vítimas', [d.fichas ? barras(porChave(d.perfis, PERFIS)) : UI.el('p', { classe: 'muted', texto: 'Nenhuma ficha de vítima nesta operação.' })]),
    ];
  }

  async function carregar(elemento, chamada, desenhar) {
    elemento.innerHTML = '';
    elemento.appendChild(UI.el('p', { classe: 'muted', texto: 'Carregando…' }));
    try {
      var d = await chamada();
      elemento.innerHTML = '';
      desenhar(d).forEach(function (n) { elemento.appendChild(n); });
    } catch (e) {
      elemento.innerHTML = '';
      elemento.appendChild(UI.el('p', { classe: 'erro-form', texto: 'Não foi possível carregar o painel: ' + (e.message || e) }));
    }
  }

  raiz.Dashboard = {
    geral: function (elemento) { return carregar(elemento, function () { return C.rpc('estudo_geral'); }, renderGeral); },
    operacao: function (op, elemento) {
      return carregar(elemento, function () { return C.rpc('estudo_operacao', { p_operacao: op.id }); }, renderOperacao);
    },
    PERFIS: PERFIS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
