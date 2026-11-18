/* =====================================================================
 * versao.js — número da versão do sistema (painel, página do participante e aplicativo) e as novidades de cada uma.
 *   A cada atualização: subir NUMERO (1.2.3 → correção 1.2.4; novidade 1.3.0), pôr a versão nova no topo de NOVIDADES e
 *   o mesmo número em public/versao.json e no <meta name="gbs-versao"> das páginas (o teste testes/versao.test.js confere).
 *   Onde aparece: qualquer elemento com o atributo data-versao recebe "Versão X" e, ao tocar, mostra as novidades.
 *   No aplicativo Android, mostra também a versão do aplicativo instalado (GBSApp.info().versao).
 *   API: window.GBSVersao = { numero, data, novidades, texto(), abrirNovidades() }.
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var NUMERO = '1.3.0';
  var DATA = '2026-11-18';
  // Mais recente primeiro. Textos curtos, para quem usa (não para quem programa).
  var NOVIDADES = [
    { versao: '1.3.0', data: '2026-11-18', itens: [
      'Dois relatórios separados: IPO (curto, no modelo do CBMPR) e Diário (detalhado). Os dois podem ser de um dia, de um período ou de tudo até o momento, separados dia a dia.',
      'Relatório IPO: o informe do dia, os militares só com graduação e QRA, os setores varridos, as trilhas feitas (com o mapa em satélite) e os pontos de interesse do dia, de forma resumida.',
      'Relatório Diário: o detalhe de cada dia (IPO do dia, pessoas em campo, mapa, setores, encontros, diário completo e pontos).',
    ] },
    { versao: '1.2.1', data: '2026-11-18', itens: [
      'Os mapas dos relatórios (setores, mapa geral, dia) agora usam imagem de satélite no fundo, e não o mapa de ruas.',
    ] },
    { versao: '1.2.0', data: '2026-11-18', itens: [
      'Relatório da imprensa refeito: sem linha do tempo. Traz resumo, pessoa procurada (sem nome), como aconteceu, buscas realizadas e meios, estratégia e próximos passos, forças envolvidas (Bombeiros, voluntários e órgãos de apoio como PM, Guarda Municipal, Defesa Civil) e recursos empregados.',
      'No IPO (Dados da ocorrência › Para a imprensa) você escreve "Como aconteceu" e "Estratégia e próximos passos"; em branco, sai um texto padrão com os dados da operação.',
    ] },
    { versao: '1.1.1', data: '2026-11-17', itens: [
      'O IPO é um só: tudo fica no IPO (Diário). Os dados da ocorrência (natureza, vítima, local) estão no cartão do topo, com Copiar IPO; saiu o item separado "IPO · dados gerais" do menu.',
    ] },
    { versao: '1.1.0', data: '2026-11-17', itens: [
      'Tirar a localização de uma pessoa do mapa (ficha › ⋮ Mais › Tirar do mapa): para quem entrou de longe só para acompanhar ou testar. Some do mapa, da trilha e do link público; nada é apagado e dá para mostrar de novo. Se a pessoa entrar de novo na operação, volta ao mapa.',
    ] },
    { versao: '1.0.0', data: '2026-11-17', itens: [
      'Número da versão no painel, na página do participante e no aplicativo, com esta lista de novidades.',
      'IPO (Diário): o IPO de cada dia junto com o diário (o que foi feito, efetivo, procedimentos, recursos, apoio e situação para o dia seguinte).',
      'Relatório IPO (Diário) de um dia, de um período ou de tudo, separado dia a dia (pessoas, quilômetros, trilhas, setores e diário de cada dia).',
      'Retomar uma operação encerrada (com o motivo registrado no diário).',
      'Relatórios: um de comando (escolha o comando ou todos), Final, Final detalhado e imprensa mais completa, com o IPO dentro.',
    ] },
  ];

  function texto() { return 'Versão ' + NUMERO; }
  function dataBr(k) { var p = String(k || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : k; }
  var appVersao = null;   // versão do aplicativo Android instalado (quando a página roda dentro dele)

  function abrirNovidades() {
    var UI = raiz.UI;
    var linhas = NOVIDADES.map(function (v) {
      return { titulo: 'Versão ' + v.versao + ' · ' + dataBr(v.data) + (v.versao === NUMERO ? ' (esta)' : ''), itens: v.itens };
    });
    if (!UI || !UI.abrirModal) {
      raiz.alert(texto() + '\n\n' + linhas.map(function (l) { return l.titulo + '\n- ' + l.itens.join('\n- '); }).join('\n\n'));
      return;
    }
    var el = UI.el;
    var fechar = UI.abrirModal(el('div', { classe: 'form-padrao novidades' }, [
      el('h2', { id: 'modal-titulo', texto: texto() }),
      el('p', { classe: 'muted', texto: 'Atualizada em ' + dataBr(DATA) + '.' + (appVersao ? ' Aplicativo Android instalado: ' + appVersao + '.' : '') +
        ' Se alguém estiver com um número diferente, é só recarregar a página (ou abrir o aplicativo de novo).' }),
    ].concat(linhas.map(function (l) {
      return el('section', { classe: 'novidades-versao' }, [el('h3', { texto: l.titulo }), el('ul', null, l.itens.map(function (t) { return el('li', { texto: t }); }))]);
    })).concat([UI.rodape([el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })])])), { tamanho: 'largo', empilhar: true });
  }

  function preencher() {
    var alvos = document.querySelectorAll('[data-versao]');
    Array.prototype.forEach.call(alvos, function (no) {
      no.textContent = texto() + (appVersao ? ' · app ' + appVersao : '');
      if (!no.getAttribute('title')) no.setAttribute('title', 'Ver as novidades desta versão');
      if (!no.__versao) {
        no.__versao = true;
        no.addEventListener('click', function (ev) { ev.preventDefault(); abrirNovidades(); });
      }
    });
  }
  function iniciar() {
    preencher();
    var app = raiz.GBSApp;
    if (app && app.disponivel && app.info) {
      app.info().then(function (i) { if (i && i.versao) { appVersao = String(i.versao); preencher(); } }).catch(function () { /* sem a informação */ });
    }
  }

  var api = { numero: NUMERO, data: DATA, novidades: NOVIDADES, texto: texto, abrirNovidades: abrirNovidades, preencher: preencher };
  raiz.GBSVersao = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
    else iniciar();
  }
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
