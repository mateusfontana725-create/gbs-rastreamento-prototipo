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

  var NUMERO = '1.11.1';
  var DATA = '2026-11-21';
  // Mais recente primeiro. Textos curtos, para quem usa (não para quem programa).
  var NOVIDADES = [
    { versao: '1.11.1', data: '2026-11-21', itens: [
      'Relatórios: o IPO de cada dia agora se chama "IPO diário" (no cartão, no título do PDF e no nome do arquivo), para não confundir com o "IPO geral".',
    ] },
    { versao: '1.11.0', data: '2026-11-21', itens: [
      'Dados da operação refeito: uma ficha limpa, seção por seção (Ocorrência, Local, Solicitante, Busca, Procedimentos e recursos, Vítimas), com o rótulo à esquerda e o valor à direita. Mostra também pessoas perdidas, BMs, procedimentos, recursos e as vítimas. O que falta preencher aparece num aviso no topo.',
      'Editar operação: seções numeradas, com títulos e rótulos legíveis, opções em botões e atalhos no topo para pular direto para cada parte. As vítimas viraram mais uma seção do formulário.',
      'Correção: operação com o ponto no mapa (sem endereço escrito) não aparece mais como "Cadastro incompleto".',
    ] },
    { versao: '1.10.3', data: '2026-11-21', itens: [
      'Ficha da vítima: a foto também ficou dentro do formulário. A foto atual aparece ali, escolher outra a substitui e "Tirar a foto atual" a retira ao salvar. Saíram os botões separados de adicionar, trocar e tirar foto.',
    ] },
    { versao: '1.10.2', data: '2026-11-21', itens: [
      'Ficha da vítima: o último local visto agora faz parte do próprio formulário (ponto no mapa, coordenada digitada ou a sua posição, e a descrição). Acabou o botão separado "Cadastrar último local visto". Vale também ao cadastrar vítimas na criação da operação.',
    ] },
    { versao: '1.10.1', data: '2026-11-21', itens: [
      'Recursos empregados (Editar operação): a lista já vem com ABS BM 13629 (Rolândia), ABRESC BM 004 e ABRESC BM 005 (Canil Setorial 3° BBM). Escolha e clique em Adicionar.',
      'Não achou o recurso na lista? "Novo recurso na lista" cadastra um novo, que passa a aparecer nas próximas vezes (neste aparelho). Os já adicionados dá para editar ou remover.',
    ] },
    { versao: '1.10.0', data: '2026-11-21', itens: [
      'Novo relatório IPO geral, o primeiro da lista de Relatórios: o IPO da operação inteira, no modelo do CBMPR, curto e sem separar por dia. Traz o informe completo (procedimentos, recursos empregados, efetivo, desdobramentos, órgãos), o mapa da operação, os militares, as trilhas e os pontos de interesse.',
      'No IPO geral dá para marcar, se quiser: um mapa de cada trilha, o mapa dos pontos de interesse e um mapa de cada setor.',
    ] },
    { versao: '1.9.1', data: '2026-11-21', itens: [
      'IPO e Diário: o mapa de cada trilha e o mapa dos pontos de interesse agora saem SEMPRE no relatório. As caixas para escolher foram retiradas.',
    ] },
    { versao: '1.9.0', data: '2026-11-21', itens: [
      'Editar operação refeito como um formulário de verdade: uma coluna só, seções em blocos (Identificação, Local, Ocorrência, Solicitante, Busca, Procedimentos e recursos), campos um embaixo do outro, sem grade.',
      'Nº de pessoas perdidas e BMs diretamente envolvidos agora têm a opção "Não apurado".',
      'Documento da vítima (CPF, RG ou outro) na ficha: escolha o tipo e digite o número. Vai para o IPO.',
      'Novo no formulário: procedimentos de busca realizados e recursos do Corpo de Bombeiros empregados. Escolha o recurso na lista (os cadastrados em Recursos), ou digite um que não esteja nela; dá para editar e remover os adicionados.',
      'O GPS e o alerta de permanência em setor saíram do formulário: ficam em Dados da operação › Ajustar GPS e alertas.',
    ] },
    { versao: '1.8.3', data: '2026-11-19', itens: [
      'O mapa dos pontos de interesse agora é opcional, como o mapa de cada trilha: marque "Também um mapa dos pontos de interesse" no IPO ou no Diário. A coordenada de cada ponto continua sempre na tabela.',
    ] },
    { versao: '1.8.2', data: '2026-11-19', itens: [
      'IPO: os pontos de interesse do dia ganham um mapa só com eles, numerados, e a tabela traz o número e a coordenada de cada ponto (além do tipo, nome e descrição).',
    ] },
    { versao: '1.8.1', data: '2026-11-19', itens: [
      'Quilômetros percorridos mais reais: o dashboard e os relatórios contam o TERRENO percorrido, em que cada pedaço de chão conta uma vez. Quem fica andando em volta do mesmo lugar, o grupo que anda junto e a ida e volta pelo mesmo caminho não multiplicam mais os quilômetros. A soma do que cada pessoa andou continua no dashboard, em letra menor.',
      'O km de cada pessoa no painel e no dashboard (ficha, lista de trilhas) também não soma de novo as voltas no mesmo lugar.',
    ] },
    { versao: '1.8.0', data: '2026-11-19', itens: [
      'Mapa do dia nos relatórios (IPO e Diário) mais perto: enquadra o local da operação e o que foi feito no dia num raio de 5 km, como o filtro do dia no painel.',
      'Trilha do relatório não liga mais os dois lados de uma falha de GPS: a linha sai em trechos (o risco reto atravessando o mapa sumiu).',
      'O mapa do dia não mostra mais os setores (podem ter sido criados em outros dias); o que foi feito no dia são as trilhas e os pontos.',
      'IPO mostra os pontos de interesse do dia (ex.: ponto de perigo) com nome e descrição curta, e as fotos tiradas no dia (até 6, pequenas).',
    ] },
    { versao: '1.7.3', data: '2026-11-19', itens: [
      'Falhas de GPS não aparecem mais no mapa (nem as marcas "Sem posições a partir daqui" nem o tracejado), no painel e na tela do participante. No painel, a pessoa ganha só um aviso "⚠ GPS" na lista e um texto na ficha com quantas falhas teve e a maior.',
      'Ponto solto (a trilha vai longe e volta: salto do GPS ou última posição ruim antes de uma falha) sai do desenho da trilha no mapa e nos relatórios: não risca mais o mapa nem estica o zoom. As posições continuam guardadas.',
    ] },
    { versao: '1.7.2', data: '2026-11-19', itens: [
      'Formulário do IPO (Dados da ocorrência) com TODOS os campos do modelo para preencher: natureza, início das operações, tipo de meio líquido, nome, sexo, idade, origem e documento da vítima (quando não há ficha de vítima), nº de pessoas perdidas e contexto do desaparecimento, além dos que já tinha. Antes esses campos só existiam em outras telas (ou nem existiam), por isso faltavam no relatório.',
    ] },
    { versao: '1.7.1', data: '2026-11-19', itens: [
      'IPO completo: o relatório e o texto do WhatsApp trazem TODOS os campos do modelo do CBMPR (unidade, RGO, natureza, localidade, início, meio líquido, coordenada, nº de pessoas perdidas, sexo/idade, nome e origem da vítima, desaparecimento, acionamento, buscas preliminares, possibilidade de vida, procedimentos, contexto, recursos, efetivo, desdobramentos, órgãos de apoio, imagens e responsável). O que não foi preenchido sai como "Não apurado" (antes o campo vazio simplesmente sumia).',
      'IPO de um dia = IPO acumulado até aquele dia, como no modelo: o efetivo e os desdobramentos trazem todos os dias até ali, e procedimentos, recursos e órgãos somam o que foi usado até ali. "Copiar IPO do dia" também.',
      'Natureza: sem a natureza do IPO, vale o tipo da operação.',
      'Mapa do dia centrado no local da operação: trilha ou ponto longe do local (quem estava longe da busca) não estica mais o zoom.',
    ] },
    { versao: '1.7.0', data: '2026-11-19', itens: [
      'Corrigido: os setores sumiam do mapa do painel (problema da rotação do mapa da versão 1.5.0). Setores, trilhas desenhadas, pontos e rótulos voltaram e giram junto com o mapa.',
      'IPO: o "Responsável pelas informações" agora é quem gerou o relatório; sem quem gerou, a linha não sai (nunca mais um nome guardado qualquer).',
      'Relatórios IPO e Diário: o MAPA DO DIA é padrão — trilhas, pontos e setores marcados daquele dia, com o zoom um pouco mais aberto. Saiu o mapa de cada setor (o setor mostra onde foi marcado; o que foi varrido está nas trilhas). Opcional: um mapa de cada trilha.',
      'Relatórios: trilha só conta quem tem linha desenhada no dia; sem trilha, sem setor ou sem ponto no dia, a seção (e o mapa) não aparecem. Saiu a seção "Setores varridos".',
      'Tela de Relatórios mais compacta: IPO e Diário lado a lado, com a data na mesma linha e uma única caixa para o mapa de cada trilha.',
    ] },
    { versao: '1.6.0', data: '2026-11-18', itens: [
      'Participante: botão 💾 Arquivos para exportar a própria trilha (GPX, KML, GeoJSON ou CSV) e mandar por WhatsApp/e-mail quando a conexão com os bombeiros falhar, e para importar um arquivo recebido (GPX, KML, KMZ, GeoJSON, CSV, AlpineQuest) que aparece no mapa e fica guardado para abrir sem internet. No aplicativo, o arquivo sai pela folha de compartilhar do Android ou vai para Downloads (precisa do APK novo).',
      'Participante: o mapa pode girar conforme o celular (Camadas › Girar o mapa conforme o celular, ou toque na bússola): a frente do aparelho fica para cima, para saber para onde está apontando.',
      'Painel: a rosa da bússola do mapa girava para o lado errado ao girar o mapa; corrigido.',
    ] },
    { versao: '1.5.0', data: '2026-11-18', itens: [
      'Painel do responsável: girar o mapa em 2D. Dois dedos no celular, Shift + roda do mouse no computador, ou os botões ↺ ↻ (15° cada) ao lado do botão de enquadrar. A bússola do canto gira junto e, tocada, volta o norte para cima. No celular, o menu ☰ Mapa tem "Girar o mapa" e "Norte para cima".',
    ] },
    { versao: '1.4.1', data: '2026-11-18', itens: [
      'Relatórios IPO e Diário: os mapas agora são caixas para marcar — mapa do dia (tudo junto), mapa de cada setor e mapa de cada trilha, em qualquer combinação (um, dois, os três ou nenhum).',
    ] },
    { versao: '1.4.0', data: '2026-11-18', itens: [
      'Relatórios IPO e Diário: na hora de gerar você escolhe os mapas — um mapa com tudo do dia, setor por setor, trilha por trilha (uma por pessoa) ou todos eles.',
    ] },
    { versao: '1.3.4', data: '2026-11-18', itens: [
      'Relatório Diário: um único mapa por dia, com o zoom pegando todos os setores trabalhados no dia, as trilhas e os pontos daquele dia. Saíram os mapas setor por setor.',
    ] },
    { versao: '1.3.3', data: '2026-11-18', itens: [
      'Relatório Diário: sem nenhum teto de mapas de setor. Todos os setores do dia saem com mapa.',
    ] },
    { versao: '1.3.2', data: '2026-11-18', itens: [
      'Relatório Diário: todos os setores trabalhados no dia ganham o bloco com mapa, sem limite por dia (antes só os 8 primeiros). Em períodos com muitos setores o mapa de cada um sai menor, para o arquivo não ficar pesado, mas nenhum setor fica sem mapa.',
    ] },
    { versao: '1.3.1', data: '2026-11-18', itens: [
      'Relatório Diário mais detalhado: trilhas do dia pessoa a pessoa (início, fim, tempo em campo, quilômetros e setores percorridos) e um bloco para cada setor trabalhado (situação, horários, equipes, responsável, observações, cronologia e mapa em satélite com as trilhas do dia).',
    ] },
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
