/* =====================================================================
 * militar.js — painel do bombeiro responsável
 *   - login (e-mail/senha) + verificação na lista de responsáveis
 *   - criação, listagem, encerramento e limpeza de operações
 *   - mapa em tempo real (Leaflet), lista de participantes, trilhas
 *   - ficha individual, envio de orientações e estado das mensagens
 *   - equipe de responsáveis: posição do próprio responsável no mapa,
 *     outros responsáveis da operação e mensagens entre eles
 * ===================================================================== */
(function () {
  'use strict';

  var C = window.Comunicacao;
  var UI = window.UI;
  function $(id) { return document.getElementById(id); }

  // Botões de ação: no topo (padrão) ou numa coluna à direita do mapa, só com tela de tablet ou maior.
  function aplicarLadoAcoes() {
    var acoes = $('acoes-topo'), cabeca = document.querySelector('.painel-topo'), corpo = $('painel-corpo');
    if (!acoes || !cabeca || !corpo) return;
    var lateral = UI.aparencia.acoesLado() === 'direita' && window.matchMedia('(min-width: 861px)').matches;
    if (lateral) {
      if (acoes.parentNode !== corpo) corpo.appendChild(acoes);
    } else if (acoes.parentNode !== cabeca) {
      cabeca.insertBefore(acoes, cabeca.querySelector('.painel-acoes'));
    }
    acoes.classList.toggle('acoes-lateral-col', lateral);
  }

  var LIM = {
    conectadoMs: 45000,          // contato nos últimos 45 s = conectado
    instavelMs: 120000,          // 45 s a 2 min = sinal instável; acima = sem atualização
    posicaoAntigaMs: 120000,     // posição com mais de 2 min = "antiga"
    precisaoTrilhaM: 150,        // pontos com precisão pior são só "posição aproximada" (fora da linha da trilha)
    pollingOkMs: 20000,          // conferência periódica com tempo real funcionando
    pollingFalhaMs: 8000,        // conferência periódica quando o tempo real cai
  };

  var PALETA = {
    militar: ['#1d4ed8', '#0e7490', '#4338ca', '#0369a1', '#1e40af', '#155e75', '#3730a3', '#2563eb'],
    // Trilhas civis em ROXO (não se confundem com a vegetação); um tom diferente para cada civil.
    civil: ['#A020F0', '#D946EF', '#7C3AED', '#C026D3', '#9D4EDD', '#E040FB', '#6D28D9', '#F0ABFC'],
    // responsável da operação: vermelho (como o militar), diferenciado pelo losango e pela letra R
    responsavel: ['#dc2626', '#ef4444', '#b91c1c', '#f87171'],
  };

  // Cores dos GRUPOS: escolhidas para não se confundir com as cores reservadas
  // (militar, civil, responsável, ajuda, seleção, trilhas), com o fundo do mapa
  // (vegetação e água) nem entre si. Com mais grupos do que cores, a cor se repete
  // e o nome do grupo aparece na legenda e no marcador.
  var GRUPO_CORES = ['#ec4899', '#fb923c', '#6366f1', '#a3e635', '#f8fafc', '#a16207'];

  // Tipos exibidos no painel. "responsavel" = militar responsável com o painel aberto
  // (só os responsáveis da operação veem esses marcadores).
  var TIPOS = {
    militar: { letra: 'M', rotulo: 'Militar', selo: 'selo-militar', trilha: null },
    civil: { letra: 'C', rotulo: 'Civil', selo: 'selo-civil', trilha: '10 7' },
    responsavel: { letra: 'R', rotulo: 'Responsável', selo: 'selo-responsavel', trilha: '2 7' },
  };
  // Comandos que fazem sentido entre responsáveis.
  var COMANDOS_RESPONSAVEL = ['ATENCAO', 'CONFIRME', 'PERSONALIZADA'];

  // "Minha posição": o filtro das leituras está em gps.js (o mesmo da página do participante).
  var CFG_GPS = { sinalVidaMs: 15000, envioRapidoMs: 1000, envioPeMs: 1500, reiniciarMs: 90000 };

  var CHAVE_AJUDA_VISTA = 'sar-militar-ajuda-vista';
  var CHAVE_LATERAL = 'gbs-painel-lateral-oculta';
  var CHAVE_PREFS_MAPA = 'gbs-painel-mapa';
  var CHAVE_GRUPOS_MENU = 'gbs-painel-menu-grupos';
  var CHAVE_GAVETA = 'gbs-painel-gaveta';

  // Relatos de campo enviados pelos participantes (mensagens com categoria).
  var CATEGORIAS = {
    MENSAGEM: { rotulo: 'Mensagem', letra: '✉' },
    PISTA: { rotulo: 'Possível pista', letra: 'P' },
    VESTIGIO: { rotulo: 'Vestígio', letra: 'V' },
    OBJETO: { rotulo: 'Objeto encontrado', letra: 'O' },
    OBSTACULO: { rotulo: 'Obstáculo', letra: '!' },
    OUTRO: { rotulo: 'Outro', letra: '?' },
    AJUDA: { rotulo: 'PEDIDO DE AJUDA', letra: 'SOS' },
    VITIMA: { rotulo: 'Vítima localizada', letra: '✚' },
  };
  // Condição da vítima localizada. Vem só da tabela vitima_localizacoes, que o
  // servidor (RLS) entrega apenas aos responsáveis da operação.
  var CONDICAO_VITIMA = { viva: 'VIVA', obito: 'MORTA' };
  var ORIGEM_FOTO = {
    gps: 'GPS do aparelho', exif: 'gravada na própria foto (EXIF)', nenhuma: 'sem localização',
    pendente: 'pendente (aguardando o GPS do aparelho)', trilha: 'trilha GPS da pessoa (ponto mais próximo do momento da foto)',
  };

  var est = {
    usuario: null,
    responsavel: null,
    op: null,
    mapa: null,
    participantes: new Map(),   // id → P
    pontosOrfaos: [],
    posIds: new Set(),
    maxPosId: 0,
    mensagens: new Map(),       // id → mensagem
    canal: null,
    geracaoCanal: 0,
    tempoReal: 'conectando',    // conectando | ok | falha
    precisaRecarregar: false,
    ultimoSyncOk: 0,
    ultimaTentativaSync: 0,
    syncFalhou: false,
    sincronizando: false,
    timerStatus: null,
    timerPoll: null,
    timerReassinar: null,
    selecionado: null,
    circuloPrecisao: null,
    jaEnquadrou: false,
    trilhasSujas: new Set(),
    rafTrilhas: null,
    listaSuja: false,
    abrirConvite: false,
    rotulosVisiveis: true,
    ajudaVista: new Set(C.local.ler(CHAVE_AJUDA_VISTA, [])),
    audio: null,
    // presença e posição do próprio responsável
    meuPart: null,
    compartilhando: false,
    watchId: null,
    gpsMeu: 'aguardando',
    ultimoAceitoMeu: null,      // última leitura válida do meu GPS { lat, lng, prec, t }
    filtroMeu: new window.GPS.Filtro(),
    minhaPosEstado: 'desligada', // desligada | iniciando | ativa | sem_sinal | bloqueada | indisponivel
    iniciandoMinhaPos: false,
    meuWatchEm: 0,
    permissaoMinha: 'desconhecido',
    filaMinha: null,            // fila offline da "Minha posição" (trilha-local.js: IndexedDB)
    bufferMinha: [],            // pontos capturados enquanto a fila abre
    enviandoMinha: false,
    timerMinhaFila: null,
    timerMeuSinal: null,
    wakeLock: null,
    // mensagens recebidas por este responsável
    entregando: new Set(),
    confirmadasLocal: new Set(),
    alertasTocados: new Set(),
    alertaAtual: null,
    cpfVisivel: new Set(),
    // mensagens e relatos recebidos dos participantes
    lidasLocal: new Set(),
    marcandoLidas: new Set(),
    destaqueNovas: new Set(),
    filaNotif: [],
    timerNotif: null,
    relatosMarc: new Map(),     // id da mensagem → marcador
    // fotos
    fotos: new Map(),           // id → foto
    fotosMarc: new Map(),       // id → marcador
    fotosFila: [],              // fotos tiradas por este responsável aguardando envio
    enviandoFotos: false,
    // mapa e interface
    camadasBase: null,
    camadaAtual: 'osm',
    camadaPontos: null,         // fotos e relatos (agrupados quando próximos)
    legenda: null,
    rotulos: { agendar: function () {} },   // mapa-rotulos.js, ligado ao criar o mapa
    filtroEstado: null,
    alertaAdiadas: new Set(),   // mensagens de outro responsável deixadas para responder depois (×)         // lista: só conectados / instáveis / sem atualização (tocar no resumo)
    prefsMapa: Object.assign({ camada: 'osm', fotos: true, relatos: true, nomesMapa: false, agrupar: true, pessoas: true, legenda: true, setores: true, pontos: true, local: true, tmPlanejadas: true, tmPercorridas: true }, C.local.ler(CHAVE_PREFS_MAPA, {}) || {}),
    lateralOculta: Boolean(C.local.ler(CHAVE_LATERAL, false)),
    centralAba: 'msgs',
    // setores, pontos de interesse e destinos
    setores: new Map(),         // id → { d: dados, camada }
    pontosInt: new Map(),       // id → { d: dados, marcador }
    tiposPonto: new Map(),      // id → tipo de ponto criado pelos responsáveis (nome, ícone, cor)
    estilosCategoria: new Map(),  // categoria fixa → { icone, cor } escolhidos (migração 050)
    destinos: new Map(),        // participante_id → destino ativo
    rotasFicha: new Map(),      // destino:modo → { rota, origem, em, calculando, erro }
    camadaRotaFicha: null,
    camadaRotaApoio: null,      // rota até um participante (ir até a pessoa / mandar apoio)
    rotaApoio: null,
    timerRotaApoio: null,
    rotaFichaChave: null,
    camadaSetores: null,
    camadaPontosInt: null,
    linhaDestino: null,
    marcaDestino: null,
    desenho: null,              // modo de desenho em andamento
    timerAreas: null,
    visao3d: null,
    centralFiltro: 'todas',
    centralVoltar: false,
    assinaturaConversa: '',
    // cadastro da operação
    marcaLocal: null,           // marcador do local da operação no mapa
    // trilhas desenhadas à mão (migração 028)
    trilhasManuais: new Map(),  // id → { d: dados, camada }
    camadaTrilhasManuais: null,
    canalTrilhas: null,
    timerTrilhas: null,
    timerCanalTrilhas: null,
    semTrilhasManuais: false,
    erroTrilhasManuais: null,
    trilhasOcultas: null,
    trilhasOcultasOp: null,
    // grupos
    grupos: new Map(),          // id → grupo
    membros: new Map(),         // grupo_id → Map(participante_id → vínculo {papel, origem…})
    semGrupos: false,           // banco sem a migração 008
    filtroGrupos: new Set(),    // grupos ligados no mapa (ícone de olho; vários ao mesmo tempo). Vazio = todos. Não fica lembrado
    controleGrupos: null,
    camadaDestinosGrupo: null,
    timerGrupos: null,
    canalExtras: null,          // tempo real das tabelas novas (separado: um erro nelas não derruba o canal principal)
    // deslocamentos de grupos (missões) e alertas
    missoes: new Map(),         // id → missão
    missaoMembros: new Map(),   // missao_id → [membros]
    semMissoes: false,          // banco sem a migração 010
    alertas: new Map(),         // id → alerta
    alertasCarregados: false,
    timerMissoes: null,
    timerRetornos: null,
    timerAlarmeCritico: null,
    alertaFaixa: null,
    // "Encontrei a vítima": registros com a condição (só responsáveis leem)
    vitimasLoc: new Map(),      // mensagem_id → registro
    fichas: new Map(),          // id da ficha → {nome, idade, cadastro_rapido…} (para o nome no marcador da vítima localizada)
    semVitimaLoc: false,        // banco sem a migração 011
    // tempo de permanência em setor (calculado no servidor pela trilha GPS)
    permanencias: new Map(),    // id → permanência aberta (pessoa ainda no setor)
    semPermanencia: false,      // banco sem a migração 013
  };

  /* ------------------------------------------------------------------ */
  /* Telas e navegação                                                    */
  /* ------------------------------------------------------------------ */
  var TELAS = ['carregando', 'login', 'sem-permissao', 'operacoes', 'responsaveis', 'painel'];
  function mostrarTela(nome) {
    TELAS.forEach(function (t) { $('tela-' + t).hidden = t !== nome; });
    document.body.classList.toggle('no-painel', nome === 'painel');
  }

  function opDoHash() {
    var m = /(?:^#|&)op=([0-9a-f-]{36})/i.exec(location.hash);
    return m ? m[1] : null;
  }


  function rotear() {
    if (!est.responsavel) return;
    if (location.hash === '#responsaveis') {
      fecharPainel();
      if (est.responsavel.admin) mostrarResponsaveis();
      else location.hash = '';
      return;
    }
    var id = opDoHash();
    if (id) {
      if (!est.op || est.op.id !== id) abrirPainel(id);
    } else {
      fecharPainel();
      mostrarOperacoes();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Autenticação                                                         */
  /* ------------------------------------------------------------------ */
  async function iniciar() {
    document.querySelectorAll('[data-acao="sair"]').forEach(function (b) { b.addEventListener('click', sair); });
    $('form-login').addEventListener('submit', entrar);
    $('btn-solicitar-acesso').addEventListener('click', abrirSolicitacaoAcesso);
    $('btn-nova-op').addEventListener('click', abrirNovaOperacao);
    // Cadastro completo da operação nova: tipo, acionamento, local e descrição
    $('menu-dados-op').addEventListener('click', abrirDadosOperacao);
    $('menu-dashboard').addEventListener('click', abrirDashboardOperacao);
    // menu do cabeçalho: um botão abre a lista de ações
    $('btn-menu-topo').addEventListener('click', function (ev) {
      ev.stopPropagation();
      abrirMenuTopo($('menu-topo-lista').hidden);
    });
    document.addEventListener('click', function (ev) {
      if (!$('menu-topo').contains(ev.target)) abrirMenuTopo(false);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') abrirMenuTopo(false);
    });
    $('menu-topo-lista').addEventListener('click', function () { abrirMenuTopo(false); });
    // alternador: painel de estatísticas ou lista de operações
    document.querySelectorAll('.vista-botao').forEach(function (b) {
      b.addEventListener('click', function () { setVista(b.getAttribute('data-vista')); });
    });
    $('menu-diario').addEventListener('click', function () { fecharMenu(false); if (window.Relatorio && est.op) window.Relatorio.abrirDiario(est.op); });
    $('menu-relatorio').addEventListener('click', function () { fecharMenu(false); if (window.Relatorio && est.op) window.Relatorio.abrirRelatoriosOperacao(est.op); });
    $('menu-grupos').addEventListener('click', abrirGrupos);
    $('menu-missoes').addEventListener('click', abrirMissoes);
    $('opt-local').addEventListener('click', function () { definirPrefMapa('local', !est.prefsMapa.local); });
    $('faixa-alerta-ciente').addEventListener('click', function () { if (est.alertaFaixa) reconhecerAlerta(est.alertaFaixa.id); });
    $('faixa-alerta-mapa').addEventListener('click', function () { if (est.alertaFaixa) verAlertaNoMapa(est.alertaFaixa); });
    $('aba-alertas').addEventListener('click', function () { mostrarAbaCentral('alertas'); });
    $('btn-voltar').addEventListener('click', function () { location.hash = ''; });
    $('btn-convite').addEventListener('click', abrirConvite);
    $('btn-encerrar').addEventListener('click', encerrarOperacao);
    // um botão só: o texto diz o que o toque vai fazer
    $('busca').addEventListener('input', function () { est.listaSuja = true; renderizarLista(); });
    $('btn-recolher').addEventListener('click', alternarLateral);
    iniciarGaveta();
    $('ficha-fechar').addEventListener('click', fecharFicha);
    document.querySelectorAll('#ficha .ficha-aba').forEach(function (b) {
      b.addEventListener('click', function () { mostrarAbaFicha(b.getAttribute('data-aba')); });
    });
    $('ficha-centralizar').addEventListener('click', function () { centralizar(est.selecionado); });
    $('ficha-trilha').addEventListener('click', function () { alternarTrilha(est.selecionado); });
    ligarMenuAcoes($('ficha-menu'));
    $('ficha-remover').addEventListener('click', removerParticipante);
    $('gps-alerta-tentar').addEventListener('click', garantirMinhaPosicao);
    $('gps-alerta-como').addEventListener('click', mostrarComoLiberarMinha);
    $('btn-minha-conta').addEventListener('click', abrirMinhaConta);
    $('btn-novo-resp').addEventListener('click', abrirCadastroResponsavel);
    // filtros das listas (cada mudança reaplica sobre o que já está carregado)
    ['ops-busca', 'ops-situacao', 'ops-criador', 'ops-periodo'].forEach(function (id) {
      $(id).addEventListener(id === 'ops-busca' ? 'input' : 'change', renderizarOperacoes);
    });
    $('ops-limpar').addEventListener('click', function () {
      $('ops-busca').value = ''; $('ops-situacao').value = ''; $('ops-criador').value = ''; $('ops-periodo').value = '';
      renderizarOperacoes();
    });
    ['resp-busca', 'resp-situacao', 'resp-papel'].forEach(function (id) {
      $(id).addEventListener(id === 'resp-busca' ? 'input' : 'change', desenharResponsaveis);
    });
    $('resp-limpar').addEventListener('click', function () {
      $('resp-busca').value = ''; $('resp-situacao').value = ''; $('resp-papel').value = '';
      desenharResponsaveis();
    });
    $('resp-cred-fechar').addEventListener('click', function () { $('resp-credenciais').hidden = true; $('resp-cred-texto').textContent = ''; });
    $('resp-cred-copiar').addEventListener('click', function () { copiarTexto($('resp-cred-texto').textContent); });
    $('btn-equipe').addEventListener('click', abrirEquipe);
    // Menu de ferramentas
    $('btn-ferramentas').addEventListener('click', function () { alternarMenu(); });
    $('menu-fechar').addEventListener('click', function () { fecharMenu(true); });
    $('menu-ferramentas').addEventListener('click', function (ev) {
      // Fecha só ao escolher uma AÇÃO (na captura: antes de a ação desabilitar o botão).
      // Chaves liga/desliga, escolhas, seletores e os títulos dos grupos mudam algo
      // no próprio menu: ele continua aberto até o usuário fechar (Fechar, Esc ou tocar fora).
      var item = ev.target.closest('.menu-item');
      if (item && !item.disabled && ehAcaoDoMenu(item)) fecharMenu(false);
    }, true);
    document.addEventListener('pointerdown', function (ev) {
      if (!$('menu-ferramentas').hidden && !$('ferramentas').contains(ev.target)) fecharMenu(false);
    });
    iniciarGruposMenu();
    // Painel "Camadas" sobre o mapa: tipo de mapa, 2D/3D e camadas operacionais
    $('btn-camadas').addEventListener('click', function () { if ($('camadas-painel').hidden) abrirCamadas(); else fecharCamadas(true); });
    $('camadas-fechar').addEventListener('click', function () { fecharCamadas(true); });
    document.addEventListener('pointerdown', function (ev) {
      // no celular/tablet o painel é uma folha temporária: tocar no mapa fecha; no computador fica aberto
      if ($('camadas-painel').hidden || $('camadas-mapa').contains(ev.target) || !camadasCompacto()) return;
      fecharCamadas(false);
    });
    $('modo-2d').addEventListener('click', fecharRelevo3D);
    iniciarModo3D();
    $('btn-registrar-foto').addEventListener('click', function () { abrirRegistrarFoto(); });
    // Áreas e pontos
    $('menu-setor').addEventListener('click', escolherTipoSetor);
    $('menu-trilha').addEventListener('click', function () { iniciarDesenhoTrilha(); });
    $('menu-ponto').addEventListener('click', function () { iniciarDesenho('ponto'); });
    $('menu-destino').addEventListener('click', function () { escolherDestino([]); });
    $('menu-areas').addEventListener('click', abrirAreas);
    $('areas-fechar').addEventListener('click', fecharAreas);
    $('areas-novo-setor').addEventListener('click', escolherTipoSetor);
    $('areas-novo-ponto').addEventListener('click', function () { iniciarDesenho('ponto'); });
    $('areas-nova-trilha').addEventListener('click', function () { iniciarDesenhoTrilha(); });
    $('opt-desenhadas-planejadas').addEventListener('click', function () { definirPrefMapa('tmPlanejadas', est.prefsMapa.tmPlanejadas === false); });
    $('opt-desenhadas-percorridas').addEventListener('click', function () { definirPrefMapa('tmPercorridas', est.prefsMapa.tmPercorridas === false); });
    $('opt-setores').addEventListener('click', function () { definirPrefMapa('setores', !est.prefsMapa.setores); });
    $('opt-pontos').addEventListener('click', function () { definirPrefMapa('pontos', !est.prefsMapa.pontos); });
    $('menu-3d').addEventListener('click', abrirRelevo3D);
    $('menu-regua').addEventListener('click', function () { fecharMenu(false); alternarRegua(); });
    $('menu-aparencia').addEventListener('click', function () { fecharMenu(false); if (window.Personalizar) window.Personalizar.iniciar(); });
    $('menu-cenario').addEventListener('click', function () { fecharMenu(false); if (window.BuscaCenario) window.BuscaCenario.abrir(); });
    $('btn-regua').addEventListener('click', alternarRegua);
    $('btn-recolher-topo').addEventListener('click', function () { UI.aparencia.definirTopoOculto(true); });
    $('btn-mostrar-topo').addEventListener('click', function () { UI.aparencia.definirTopoOculto(false); });
    UI.aparencia.aoMudar(aplicarLadoAcoes);
    window.matchMedia('(min-width: 861px)').addEventListener('change', aplicarLadoAcoes);
    aplicarLadoAcoes();
    $('menu-ajuda').addEventListener('click', function () { fecharMenu(false); if (window.AjudaPedidos) window.AjudaPedidos.abrir(); });
    $('btn-ajuda').addEventListener('click', function () { if (window.AjudaPedidos) window.AjudaPedidos.abrir(); });
    $('menu-sci').addEventListener('click', function () { fecharMenu(false); abrirSci(); });
    $('menu-binomio').addEventListener('click', function () { fecharMenu(false); if (window.Binomio) window.Binomio.abrir(); });
    $('menu-drone-agua').addEventListener('click', function () { fecharMenu(false); if (window.ObservacoesCampo) window.ObservacoesCampo.abrir(); });
    $('menu-briefing').addEventListener('click', function () { fecharMenu(false); if (window.Briefing) window.Briefing.abrir(); });
    $('comando-chip').addEventListener('click', function () { if (window.Briefing) window.Briefing.abrir(); });
    if (window.AjudaPedidos) window.AjudaPedidos.aoMudar(function () { if (est.op) { atualizarEstados(); if (est.selecionado) atualizarFicha(); } });
    $('visao-3d-fechar').addEventListener('click', fecharRelevo3D);
    $('visao-3d-atualizar').addEventListener('click', function () { adicionarDados3D(); UI.aviso('Posições atualizadas no 3D.', 'ok'); });
    $('ficha-enviar-destino').addEventListener('click', function () { if (est.selecionado) escolherDestino([est.selecionado]); });
    $('ficha-ir-ate').addEventListener('click', function () { if (est.selecionado) abrirRotaAte(est.selecionado); });
    $('barra-apoio-parar').addEventListener('click', pararRotaApoio);
    $('barra-apoio-ver').addEventListener('click', verRotaApoio);
    $('ficha-renomear').addEventListener('click', function () { var p = est.participantes.get(est.selecionado); if (p) renomearParticipante(p); });
    $('ficha-vitima').addEventListener('click', function () { if (est.selecionado) abrirRegistroVitima({ encontrou: est.selecionado, onde: 'quem' }); });
    $('menu-vitima').addEventListener('click', function () { fecharMenu(false); abrirRegistroVitima({}); });
    $('menu-vitima-rapida').addEventListener('click', function () { fecharMenu(false); abrirCadastroRapido(); });
    $('btn-excluir-op').addEventListener('click', function () { excluirOperacao(est.op); });
    document.querySelectorAll('[data-camada]').forEach(function (b) {
      b.addEventListener('click', function () { trocarCamada(b.getAttribute('data-camada')); });
    });
    $('opt-fotos').addEventListener('click', function () { definirPrefMapa('fotos', !est.prefsMapa.fotos); });
    $('opt-relatos').addEventListener('click', function () { definirPrefMapa('relatos', !est.prefsMapa.relatos); });
    $('opt-nomes').addEventListener('click', function () { definirPrefMapa('nomesMapa', !est.prefsMapa.nomesMapa); });
    $('opt-pessoas').addEventListener('click', function () { definirPrefMapa('pessoas', !est.prefsMapa.pessoas); });
    document.querySelectorAll('[data-modo-mapa]').forEach(function (b) {
      b.addEventListener('click', function () { aplicarModoMapa(b.getAttribute('data-modo-mapa')); });
    });
    document.querySelector('#faixa-alerta .faixa-alerta-textos').addEventListener('click', function () {
      var f = $('faixa-alerta');
      f.classList.toggle('aberta');
      this.setAttribute('aria-expanded', String(f.classList.contains('aberta')));
    });
    document.querySelector('#faixa-alerta .faixa-alerta-textos').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.click(); }
    });
    $('alerta-cmd-fechar').addEventListener('click', adiarAlertaParaMim);
    $('alerta-cmd').addEventListener('keydown', function (ev) { if (ev.key === 'Escape') adiarAlertaParaMim(); });
    $('btn-alerta-pendente').addEventListener('click', function () {
      est.alertaAdiadas.clear();
      est.alertaAtual = null;
      mostrarAlertaParaMim();
    });
    $('resumo').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-estado]');
      if (!b) return;
      est.filtroEstado = est.filtroEstado === b.getAttribute('data-estado') ? null : b.getAttribute('data-estado');
      renderizarLista();
    });
    $('opt-coord').addEventListener('change', function () { definirPrefMapa('coord', this.value); if (est.selecionado) atualizarFicha(); });
    $('ficha-estatisticas').addEventListener('click', function () { if (window.Ferramentas && est.selecionado) window.Ferramentas.abrirEstatisticas(est.selecionado); });
    $('ficha-exportar').addEventListener('click', function () { if (window.Ferramentas && est.selecionado) window.Ferramentas.abrirExportar(est.selecionado); });
    $('opt-trilhas').addEventListener('click', function () { definirTodasTrilhas(!todasTrilhasVisiveis()); });
    $('menu-diag-gps').addEventListener('click', function () { fecharMenu(false); abrirDiagnosticoGps(); });
    $('menu-minha-trilha').addEventListener('click', function () { fecharMenu(false); alternarMinhaTrilha(); });
    iniciarSecoesMenu();
    // Tema escuro ou claro (Ferramentas → Configurações). Os botões marcam o tema atual e o menu continua aberto.
    document.querySelectorAll('.menu-tema [data-tema]').forEach(function (b) {
      b.addEventListener('click', function () { definirTema(b.getAttribute('data-tema')); });
    });
    atualizarBotoesTema();
    // Lista lateral: ocultar / reabrir
    $('btn-ocultar-lateral').addEventListener('click', function () { definirLateral(false); });
    $('btn-mostrar-lateral').addEventListener('click', function () { definirLateral(true); });
    $('painel-corpo').addEventListener('transitionend', function (ev) {
      if (ev.target === $('painel-corpo') && est.mapa) est.mapa.invalidateSize({ pan: false });
    });
    // Central de comunicação
    $('btn-mensagens').addEventListener('click', function () { if ($('central').hidden) abrirCentral(); else fecharCentral(); });
    $('central-fechar').addEventListener('click', fecharCentral);
    $('aba-msgs').addEventListener('click', function () { mostrarAbaCentral('msgs'); });
    $('aba-fotos').addEventListener('click', function () { mostrarAbaCentral('fotos'); });
    document.querySelectorAll('[data-filtro]').forEach(function (b) {
      b.addEventListener('click', function () { est.centralFiltro = b.getAttribute('data-filtro'); renderizarCentral(); });
    });
    $('form-resposta').addEventListener('submit', enviarResposta);
    $('resposta-texto').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); enviarResposta(ev); }
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && est.compartilhando) {
        pedirTelaLigada();
        enviarMeuSinal();
        enviarMinhaFila();
      }
      if (document.visibilityState === 'visible' && est.op && est.op.status === 'ativa') verificarPermissaoMinha();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || document.querySelector('.modal-fundo') || document.querySelector('.lightbox')) return;
      if (est.desenho) cancelarDesenho();
      else if (!$('visao-3d').hidden) fecharRelevo3D();
      else if (!$('menu-ferramentas').hidden) fecharMenu(true);
      else if (!$('camadas-painel').hidden) fecharCamadas(true);
      else if (!$('painel-areas').hidden) fecharAreas();
      else if (!$('ficha').hidden) fecharFicha();
      else if (!$('central').hidden) fecharCentral();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') marcarLidasVisiveis();
    });
    document.addEventListener('pointerdown', prepararAudio, { once: true });
    window.addEventListener('hashchange', rotear);
    window.addEventListener('online', function () { if (est.op) { sincronizar(); enviarFilaFotos(); } });
    window.addEventListener('pagehide', function () { if (est.filaMinha) est.filaMinha.persistirPendentes(); });
    window.addEventListener('beforeunload', function (ev) {
      // fotos não enviadas ou pontos de GPS que ainda não estão gravados no aparelho (só na memória)
      if (est.fotosFila.length || (est.filaMinha && est.filaMinha.qtdNaoDuraveis()) || est.bufferMinha.length) { ev.preventDefault(); ev.returnValue = ''; }
    });

    if (!C.configurado) {
      mostrarTela('login');
      erroLogin('O aplicativo não está configurado no servidor (variáveis SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY).');
      $('btn-entrar').disabled = true;
      return;
    }

    C.cliente.auth.onAuthStateChange(function (evento) {
      if (evento === 'SIGNED_OUT') {
        est.responsavel = null;
        fecharPainel();
        mostrarTela('login');
      }
    });

    try {
      var r = await C.cliente.auth.getSession();
      var sessao = r.data && r.data.session;
      if (sessao && sessao.user && !sessao.user.is_anonymous) await aposLogin(sessao.user);
      else mostrarTela('login');
    } catch (e) {
      mostrarTela('login');
      erroLogin(C.traduzirErro(e));
    }
  }

  function erroLogin(t) {
    $('login-erro').textContent = t || '';
    $('login-erro').hidden = !t;
  }

  async function entrar(ev) {
    ev.preventDefault();
    erroLogin('');
    var email = $('login-email').value.trim();
    var senha = $('login-senha').value;
    if (!email || !senha) return erroLogin('Informe e-mail e senha.');
    var btn = $('btn-entrar');
    btn.disabled = true;
    btn.textContent = 'ENTRANDO…';
    try {
      var r = await C.cliente.auth.signInWithPassword({ email: email, password: senha });
      if (r.error) throw C.criarErro(r.error);
      $('login-senha').value = '';
      await aposLogin(r.data.user);
    } catch (e) {
      erroLogin(e.message || C.traduzirErro(e));
    } finally {
      btn.disabled = false;
      btn.textContent = 'ENTRAR';
    }
  }

  async function aposLogin(usuario) {
    est.usuario = usuario;
    var resp;
    try {
      resp = await C.consultar(C.cliente.from('responsaveis').select('nome,admin,ativo').eq('user_id', usuario.id).maybeSingle());
    } catch (e) {
      mostrarTela('login');
      erroLogin(e.message);
      return;
    }
    if (!resp || resp.ativo === false) {
      $('sem-permissao-texto').textContent = await textoSemAcesso();
      mostrarTela('sem-permissao');
      return;
    }
    est.responsavel = resp;
    $('usuario-nome').textContent = resp.nome + ' · ' + (usuario.email || '') + (resp.admin ? ' · administrador' : '');
    $('btn-responsaveis').hidden = !resp.admin;
    C.sincronizarRelogio();
    rotear();
    // Senha provisória (convite de responsável): o painel só segue depois que a pessoa cria a própria senha
    if (usuario.user_metadata && usuario.user_metadata.senha_provisoria === true) trocarSenhaProvisoria();
  }

  // Primeiro acesso com senha provisória: pede uma senha nova. A janela não fecha sem ela (sem ×, sem Esc).
  function trocarSenhaProvisoria() {
    var s1 = UI.el('input', { classe: 'campo', type: 'password', id: 'prov-senha1', autocomplete: 'new-password', minlength: '8', maxlength: '72', autofocus: true });
    var s2 = UI.el('input', { classe: 'campo', type: 'password', id: 'prov-senha2', autocomplete: 'new-password', minlength: '8', maxlength: '72' });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-primario', type: 'submit', id: 'prov-salvar', texto: 'Salvar nova senha' });
    var form = UI.el('form', { classe: 'form-padrao', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Crie a sua senha' }, [UI.dica('Você entrou com uma senha provisória, enviada por e-mail. Crie agora uma senha só sua para continuar.')]),
      UI.secao('Nova senha', [
        UI.campo('Nova senha', s1, { para: 'prov-senha1', ajuda: 'Pelo menos 8 caracteres, misturando letras e números.' }),
        UI.campo('Repita a senha', s2, { para: 'prov-senha2' }),
        erro,
      ]),
      UI.rodape([btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      if (s1.value.length < 8) { erro.textContent = 'A senha precisa ter pelo menos 8 caracteres.'; erro.hidden = false; return; }
      if (s1.value !== s2.value) { erro.textContent = 'As duas senhas não são iguais.'; erro.hidden = false; return; }
      btn.disabled = true;
      try {
        var r = await C.cliente.auth.updateUser({ password: s1.value, data: { senha_provisoria: false } });
        if (r.error) throw C.criarErro(r.error);
        fechar();
        UI.aviso('Senha criada. Bem-vindo ao painel.', 'ok');
      } catch (e) {
        erro.textContent = /weak|password/i.test(String(e.original && e.original.message)) ? 'Senha fraca. Use pelo menos 8 caracteres, misturando letras e números.' : e.message;
        erro.hidden = false;
        btn.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form, { travado: true, fecharNoFundo: false });
  }

  // Mensagem de quem entrou mas ainda não tem acesso: pedido pendente, recusado ou desativado.
  var MENSAGEM_SEM_ACESSO = {
    pendente: 'Seu pedido de acesso está aguardando a aprovação de um administrador. Você poderá entrar assim que ele aprovar.',
    recusada: 'Seu pedido de acesso não foi aprovado. Fale com um administrador se acha que é engano.',
    desativado: 'Seu acesso ao painel está desativado. Fale com um administrador.',
  };
  async function textoSemAcesso() {
    var padrao = 'Este usuário não está cadastrado como responsável. Peça ao administrador do sistema para autorizar o seu acesso.';
    try {
      var st = await C.rpc('meu_status_acesso');
      return MENSAGEM_SEM_ACESSO[st && st.status] || padrao;
    } catch (e) {
      return padrao;
    }
  }

  async function sair() {
    fecharPainel();
    try { await C.cliente.auth.signOut(); } catch (e) { /* ignora */ }
    est.responsavel = null;
    location.hash = '';
    mostrarTela('login');
  }

  /* ------------------------------------------------------------------ */
  /* Operações                                                            */
  /* ------------------------------------------------------------------ */
  // Operação encerrada: o painel abre só para visualização (o servidor também recusa alterações, migração 026).
  function podeAlterar() {
    return Boolean(est.op && est.op.status === 'ativa' && !est.op.dados_apagados_em);
  }

  // Os dados ficam guardados depois de encerrar; só saem se a operação for excluída (migração 027).
  // O valor gravado em retencao_horas ficou só para o servidor antigo, antes da migração.
  var RETENCAO_SEGURA_H = 2160;

  function descricaoOp(op) {
    var cad = [window.Cadastro.textoTipo(op), op.acionado_em ? 'acionada ' + window.Cadastro.dataHora(op.acionado_em) : '', op.local_endereco || '']
      .filter(Boolean).join(' · ');
    var t;
    if (op.status === 'ativa') t = 'Ativa desde ' + C.hora(op.criada_em, false);
    else t = 'Encerrada em ' + C.hora(op.encerrada_em, false) + (op.dados_apagados_em ? ' · dados apagados (regra antiga)' : '');
    return (cad ? cad + ' — ' : '') + t;
  }

  // Menu "⋮" da linha: abre as funções disponíveis para aquela linha. Um menu aberto por vez;
  // fecha ao escolher uma função, ao clicar fora ou com Esc.
  var menuLinhaAberto = null;
  function menuLinha(itens) {
    var gatilho = UI.el('button', { classe: 'btn btn-icone', type: 'button', texto: '⋮', title: 'Mais opções', 'aria-label': 'Mais opções', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    var lista = UI.el('div', { classe: 'menu-linha', role: 'menu', hidden: true }, itens.map(function (it) {
      return UI.el('button', { classe: 'menu-linha-item' + (it.perigo ? ' perigo' : ''), type: 'button', role: 'menuitem', texto: it.texto,
        onclick: function () { fechar(); it.acao(); } });
    }));
    function fechar() {
      lista.hidden = true;
      gatilho.setAttribute('aria-expanded', 'false');
      if (menuLinhaAberto === fechar) menuLinhaAberto = null;
    }
    gatilho.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var abrir = lista.hidden;
      if (menuLinhaAberto) menuLinhaAberto();
      lista.hidden = !abrir;
      gatilho.setAttribute('aria-expanded', String(abrir));
      if (abrir) menuLinhaAberto = fechar;
    });
    return UI.el('div', { classe: 'menu-linha-wrap' }, [gatilho, lista]);
  }

  // Fileira de botões → só os principais ficam à vista; o resto vai para o menu "⋮".
  // Ficam: os `manter` primeiros e Fechar/Cancelar. Os botões só mudam de lugar
  // (mesmos ids e ações); com 1 só sobrando, nada muda.
  function compactarAcoes(caixa, manter) {
    if (!caixa) return caixa;
    manter = manter == null ? 1 : manter;
    var botoes = Array.prototype.filter.call(caixa.children, function (b) { return b.tagName === 'BUTTON' || b.tagName === 'A'; });
    var finais = botoes.filter(function (b) { return /^(Fechar|Cancelar)$/.test(b.textContent.trim()); });
    var mover = botoes.filter(function (b, i) { return i >= manter && finais.indexOf(b) < 0; });
    if (mover.length < 2) return caixa;
    var gatilho = UI.el('button', { classe: 'btn btn-mais-acoes', type: 'button', texto: '⋮ Mais', title: 'Mais ações', 'aria-label': 'Mais ações', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    var lista = UI.el('div', { classe: 'menu-linha', role: 'menu', hidden: true });
    var wrap = UI.el('div', { classe: 'menu-linha-wrap menu-acoes' }, [gatilho, lista]);
    caixa.insertBefore(wrap, finais[0] || null);
    mover.forEach(function (b) {
      b.classList.add('menu-linha-item');
      if (b.classList.contains('btn-perigo')) b.classList.add('perigo');
      ['btn', 'btn-pequeno', 'btn-escuro', 'btn-ok', 'btn-perigo', 'btn-link'].forEach(function (c) { b.classList.remove(c); });
      b.setAttribute('role', 'menuitem');
      lista.appendChild(b);
    });
    ligarMenuAcoes(wrap);
    return caixa;
  }

  // A lista do menu "⋮" fica presa ao botão, mas sempre dentro da tela: alinha pela borda do
  // botão, encosta na borda da tela se faltar espaço e abre para cima se faltar espaço embaixo.
  function posicionarMenuLinha(lista) {
    var g = lista.parentNode.querySelector('button').getBoundingClientRect();
    var vw = document.documentElement.clientWidth, vh = window.innerHeight, folga = 8;
    var w = lista.offsetWidth, h = lista.offsetHeight;
    var esq = Math.max(folga, Math.min(g.right - w, vw - w - folga));
    var topo = g.bottom + 6;
    if (topo + h > vh - folga) topo = g.top - h - 6;
    lista.style.position = 'fixed';
    lista.style.left = Math.round(esq) + 'px';
    lista.style.top = Math.round(Math.max(folga, topo)) + 'px';
    lista.style.right = lista.style.bottom = 'auto';
  }

  // Liga um menu "⋮" já montado (gatilho + .menu-linha): abre/fecha, um por vez, fecha ao escolher.
  // O gatilho some quando todos os itens estão ocultos.
  function ligarMenuAcoes(wrap) {
    var gatilho = wrap.querySelector('button'), lista = wrap.querySelector('.menu-linha');
    function fechar() {
      lista.hidden = true;
      gatilho.setAttribute('aria-expanded', 'false');
      if (menuLinhaAberto === fechar) menuLinhaAberto = null;
    }
    gatilho.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var abrir = lista.hidden;
      if (menuLinhaAberto) menuLinhaAberto();
      lista.hidden = !abrir;
      gatilho.setAttribute('aria-expanded', String(abrir));
      if (abrir) { menuLinhaAberto = fechar; posicionarMenuLinha(lista); }
    });
    lista.addEventListener('click', function (ev) { if (ev.target.closest('.menu-linha-item')) fechar(); });
    wrap.atualizarGatilho = function () {
      gatilho.hidden = !Array.prototype.some.call(lista.children, function (b) { return !b.hidden; });
    };
    wrap.atualizarGatilho();
    return wrap;
  }

  /* ---------- Itens do mapa: balão no clique, painel no duplo clique / segurar ---------- */
  // Um clique num item do mapa abre um balão pequeno preso a ele (nome e o essencial).
  // O painel lateral (ficha, detalhes) abre com dois cliques, clicar e segurar, ou pelo
  // botão do balão. Na lista lateral um clique continua abrindo direto.
  function abrirBalao(latlng, info, detalhes) {
    if (!est.mapa) return;
    var corpo = UI.el('div', { classe: 'balao-corpo' }, [
      UI.el('strong', { classe: 'balao-titulo', texto: info.titulo }),
      info.sub ? UI.el('small', { classe: 'balao-sub', texto: info.sub }) : null,
      info.texto ? UI.el('p', { classe: 'balao-texto', texto: info.texto }) : null,
      detalhes ? UI.el('button', { classe: 'balao-detalhes', type: 'button', id: 'balao-detalhes', texto: info.botao || 'Detalhes ›',
        title: 'Dica: dois cliques ou clicar e segurar no mapa abrem direto',
        onclick: function () { fecharBalao(); detalhes(); } }) : null,
    ]);
    if (!est.balao) {
      est.balao = L.popup({ className: 'balao-mapa', closeButton: true, autoPan: true, autoPanPadding: [30, 30], maxWidth: 240, minWidth: 120, offset: [0, -8] });
    }
    est.balao.setLatLng(latlng).setContent(corpo);
    est.balao.options.offset = L.point(0, info.deslocY || -8);
    est.balao.openOn(est.mapa);
  }

  function fecharBalao() {
    if (est.balao && est.mapa && est.mapa.hasLayer(est.balao)) est.mapa.closePopup(est.balao);
  }

  // o: { info: fn(ev) → {titulo, sub, texto, deslocY}, detalhes: fn(ev), noDesenho: fn(ev) (durante um desenho) }
  var TEMPO_SEGURAR_MS = 550;
  var segurar = { timer: null, inicio: null };
  function cancelarSegurar() { clearTimeout(segurar.timer); segurar.timer = null; }
  // ligado uma vez no mapa: arrastar ou dar zoom cancela o "segurar"
  function ligarSegurarNoMapa(mapa) {
    mapa.on('mousemove', function (ev) { if (segurar.timer && segurar.inicio && ev.containerPoint.distanceTo(segurar.inicio) > 8) cancelarSegurar(); });
    mapa.on('movestart zoomstart mouseup', cancelarSegurar);
  }

  function ligarCliquesMapa(camada, o) {
    var segurou = false;
    function abrirDetalhes(ev) { cancelarSegurar(); fecharBalao(); o.detalhes(ev); }
    function marcarSegurou() { segurou = true; setTimeout(function () { segurou = false; }, 1200); }
    camada.on('click', function (ev) {
      L.DomEvent.stopPropagation(ev);
      if (est.desenho) { if (o.noDesenho) o.noDesenho(ev); return; }
      if (segurou) { segurou = false; return; }   // o clique que termina o "segurar"
      var info = o.info(ev);
      abrirBalao(info.latlng || ev.latlng, info, function () { o.detalhes(ev); });
    });
    camada.on('dblclick', function (ev) {
      L.DomEvent.stopPropagation(ev);   // não dá zoom no mapa
      if (ev.originalEvent) L.DomEvent.preventDefault(ev.originalEvent);
      if (est.desenho) return;
      abrirDetalhes(ev);
    });
    camada.on('contextmenu', function (ev) {   // toque longo (celular) ou botão direito
      L.DomEvent.stopPropagation(ev);
      if (ev.originalEvent) L.DomEvent.preventDefault(ev.originalEvent);
      if (est.desenho) return;
      marcarSegurou();
      abrirDetalhes(ev);
    });
    camada.on('mousedown', function (ev) {   // clicar e segurar com o mouse
      if (est.desenho || (ev.originalEvent && ev.originalEvent.button !== 0)) return;
      cancelarSegurar();
      segurar.inicio = ev.containerPoint;
      segurar.timer = setTimeout(function () { segurar.timer = null; marcarSegurou(); abrirDetalhes(ev); }, TEMPO_SEGURAR_MS);
    });
    camada.on('mouseup mouseout', cancelarSegurar);
    return camada;
  }

  document.addEventListener('click', function (ev) {
    if (menuLinhaAberto && !ev.target.closest('.menu-linha-wrap')) menuLinhaAberto();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && menuLinhaAberto) menuLinhaAberto();
  });

  function abrirOperacao(op) {
    location.hash = '#op=' + op.id;
  }

  function mostrarOperacoes() {
    mostrarTela('operacoes');
    aplicarVista();
  }

  // Vista da tela inicial: "dashboard" (painel de estatísticas) ou "lista" (operações). Fica salva neste navegador.
  function vistaAtual() {
    try { return localStorage.getItem('gbs.vista') === 'lista' ? 'lista' : 'dashboard'; } catch (e) { return 'dashboard'; }
  }

  function setVista(nome) {
    try { localStorage.setItem('gbs.vista', nome); } catch (e) { /* sem armazenamento: vale só nesta tela */ }
    aplicarVista();
  }

  function aplicarVista() {
    var dash = vistaAtual() === 'dashboard';
    $('vista-dashboard').hidden = !dash;
    $('vista-lista').hidden = dash;
    $('vista-btn-dashboard').setAttribute('aria-selected', String(dash));
    $('vista-btn-lista').setAttribute('aria-selected', String(!dash));
    if (dash) {
      if (window.Dashboard) window.Dashboard.geral($('estudos-geral-corpo'));
    } else {
      carregarListaOperacoes();
    }
  }

  function abrirMenuTopo(aberto) {
    $('menu-topo-lista').hidden = !aberto;
    $('btn-menu-topo').setAttribute('aria-expanded', String(aberto));
  }

  async function carregarListaOperacoes() {
    var ul = $('lista-ops');
    ul.innerHTML = '<li class="muted">Carregando…</li>';
    var ops;
    try {
      // select('*'): funciona com ou sem as colunas do cadastro (migração 007)
      ops = await C.consultar(
        C.cliente.from('operacoes')
          .select('*')
          .order('criada_em', { ascending: false })
          .limit(100)
      );
    } catch (e) {
      ul.innerHTML = '';
      ul.appendChild(UI.el('li', { classe: 'erro-form', texto: e.message }));
      return;
    }
    // Administrador vê todas as operações: mostra quem criou cada uma (nomes só para o admin).
    var admin = Boolean(est.responsavel && est.responsavel.admin);
    $('ops-titulo').textContent = admin ? 'Operações (todas)' : 'Minhas operações';
    $('ops-criador').hidden = !admin;
    var nomes = {};
    if (admin) {
      try {
        ((await C.rpc('admin_listar_responsaveis', {})) || []).forEach(function (r) { nomes[r.user_id] = r.nome; });
      } catch (e) { /* sem os nomes, a lista segue sem o "criada por" */ }
    }
    est.listaOps = ops;
    est.nomesCriadores = nomes;
    renderizarOperacoes();
  }

  // Sem acento e sem maiúsculas: "petropolis" encontra "Petrópolis".
  function semAcento(t) {
    return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  // Filtros da lista de operações (sobre o que já foi carregado, sem nova consulta).
  function filtrarOperacoes(ops) {
    var busca = semAcento($('ops-busca').value.trim());
    var situacao = $('ops-situacao').value;
    var criador = $('ops-criador').hidden ? '' : $('ops-criador').value;
    var dias = Number($('ops-periodo').value) || 0;
    var agora = Date.now();
    return ops.filter(function (op) {
      if (busca && semAcento([op.codigo, op.local_endereco, op.descricao].join(' ')).indexOf(busca) === -1) return false;
      if (situacao && op.status !== situacao) return false;
      if (criador === 'eu' && op.responsavel_id !== est.usuario.id) return false;
      if (criador === 'outros' && op.responsavel_id === est.usuario.id) return false;
      if (dias) {
        var ref = C.paraMs(op.acionado_em || op.criada_em);
        if (!ref || agora - ref > dias * 86400000) return false;
      }
      return true;
    });
  }

  function renderizarOperacoes() {
    var ul = $('lista-ops');
    var todas = est.listaOps || [];
    var ops = filtrarOperacoes(todas);
    var admin = Boolean(est.responsavel && est.responsavel.admin);
    var nomes = est.nomesCriadores || {};
    ul.innerHTML = '';
    var vazio = !todas.length ? 'Nenhuma operação criada ainda.' : !ops.length ? 'Nenhuma operação com esses filtros.' : '';
    $('ops-vazio').textContent = vazio;
    $('ops-vazio').hidden = !vazio;
    $('ops-contagem').textContent = !todas.length ? '' : ops.length === todas.length
      ? todas.length + (todas.length === 1 ? ' operação' : ' operações')
      : ops.length + ' de ' + todas.length + ' operações';
    ops.forEach(function (op) {
      var selo = op.status === 'ativa'
        ? UI.el('span', { classe: 'selo selo-ok', texto: 'Ativa' })
        : op.arquivada_em
          ? UI.el('span', { classe: 'selo selo-neutro', title: 'Encerrada e arquivada em ' + C.hora(op.arquivada_em) + ': consulta pelo arquivo da operação', texto: 'Arquivada' })
          : UI.el('span', { classe: 'selo selo-neutro', texto: 'Encerrada' });
      // Encerrada também abre (só visualização), inclusive depois da retenção (cadastro, diário e relatórios)
      var semPainel = false;
      var funcoes = [];
      funcoes.push({ texto: op.status === 'ativa' ? 'Abrir painel' : 'Ver painel (só leitura)', acao: function () { abrirOperacao(op); } });
      if (window.Relatorio) {
        funcoes.push({ texto: 'Diário da operação', acao: function () { window.Relatorio.abrirDiario(op); } });
        funcoes.push({ texto: 'Relatórios (diário, comando e final)', acao: function () { window.Relatorio.abrirRelatoriosOperacao(op); } });
      }
      // Operação antiga (só com o nome): continua válida; o painel sugere completar.
      var incompleta = 'tipo' in op && window.Cadastro.incompleto(op);
      if (incompleta) funcoes.push({ texto: 'Completar cadastro', acao: function () { window.Cadastro.abrirDados(op, { aoSalvar: function () { mostrarOperacoes(); } }); } });
      if (podeArquivar(op)) funcoes.push({ texto: 'Arquivar agora (liberar espaço)', acao: function () { arquivarOperacao(op); } });
      if (podeExcluir(op)) funcoes.push({ texto: 'Excluir operação', perigo: true, acao: function () { excluirOperacao(op); } });
      var acoes = UI.el('div', { classe: 'op-acoes' }, funcoes.length ? [menuLinha(funcoes)] : []);
      var deEquipe = est.usuario && op.responsavel_id !== est.usuario.id
        ? UI.el('span', { classe: 'selo selo-responsavel', title: 'Você foi adicionado como responsável', texto: 'Equipe' }) : null;
      var seloIncompleto = incompleta ? UI.el('span', { classe: 'selo selo-alerta', title: 'Falta tipo e/ou data e hora do acionamento', texto: 'Cadastro incompleto' }) : null;
      var li = UI.el('li', { classe: semPainel ? '' : 'clicavel', tabindex: semPainel ? null : '0' }, [
        UI.el('div', { classe: 'op-info' }, [
          UI.el('strong', null, [op.codigo + ' ', selo, deEquipe ? ' ' : null, deEquipe, seloIncompleto ? ' ' : null, seloIncompleto]),
          UI.el('span', { texto: descricaoOp(op) }),
          admin && op.responsavel_id !== est.usuario.id ? UI.el('span', { classe: 'muted', texto: 'Criada por ' + (nomes[op.responsavel_id] || 'outro responsável') }) : null,
        ]),
        acoes,
      ]);
      // clicar na linha abre o painel (os ícones têm a própria ação)
      if (!semPainel) {
        li.addEventListener('click', function (ev) { if (!ev.target.closest('button')) abrirOperacao(op); });
        li.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && ev.target === li) abrirOperacao(op); });
      }
      ul.appendChild(li);
    });
  }

  // "+ Nova operação": o cadastro abre num modal (a lista de operações fica limpa).
  function abrirNovaOperacao() {
    var codigo = UI.el('input', { classe: 'campo', id: 'nova-codigo', maxlength: '80', required: true, autocomplete: 'off', placeholder: 'Ex.: BUSCA SERRA AZUL 09/10' });
    var campos = window.Cadastro.camposOperacao(null, { inicial: true, prefixo: 'nova' });
    var vitimas = secaoVitimasNovaOp();
    var erro = UI.el('p', { classe: 'erro-form', id: 'nova-erro', role: 'alert', hidden: true });
    var status = UI.el('div', { classe: 'nova-op-status', id: 'nova-status', role: 'status', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-primario', type: 'submit', id: 'btn-criar', texto: 'Criar operação' });
    var cancelar = UI.el('button', { classe: 'btn', type: 'button', id: 'nova-cancelar', texto: 'Cancelar', onclick: function () { fechar(); } });
    var dadosOp = UI.el('fieldset', { classe: 'nova-op-dados', id: 'nova-op-dados' }, [
      UI.el('div', { classe: 'nova-op-linha' }, [
        UI.campo('Nome ou código *', codigo, { para: 'nova-codigo', largo: true, dica: 'Só o nome é obrigatório. O resto do cadastro vai depois, em Dados da operação. Os dados ficam guardados até a exclusão da operação.' }),
      ]),
      campos.elemento,
    ]);
    var form = UI.el('form', { classe: 'form-nova-op form-padrao', id: 'form-nova', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Nova operação' }),
      vitimas.elemento,
      dadosOp,
      status,
      erro,
      UI.rodape([cancelar, btn]),
    ]);
    // ctx.op: a operação já criada (a partir daí o formulário só tenta salvar as vítimas que faltam)
    var ctx = { op: null, foi: false };
    function irParaOperacao() {
      if (ctx.foi || !ctx.op) return;
      ctx.foi = true;
      est.abrirConvite = true;
      location.hash = '#op=' + ctx.op.id;
    }
    form.addEventListener('submit', function (ev) {
      criarOperacao(ev, { codigo: codigo, campos: campos, vitimas: vitimas, dadosOp: dadosOp, erro: erro, status: status, btn: btn, cancelar: cancelar, ctx: ctx,
        fechar: function () { fechar(true); }, irParaOperacao: irParaOperacao });
    });
    // Fechar depois de criada (Esc, "Seguir sem elas"…) sempre leva à operação: nada se perde.
    var fechar = UI.abrirModal(form, { fecharNoFundo: false, aoFechar: function () { irParaOperacao(); } });
    setTimeout(function () { codigo.focus(); }, 40);
  }

  // Vítimas cadastradas junto com a operação: os mesmos campos e a mesma validação da
  // ficha (Cadastro.camposVitima). Nada é salvo antes de a operação existir.
  function secaoVitimasNovaOp() {
    var itens = [];
    var seq = 0;
    var lista = UI.el('div', { classe: 'nova-vitimas-lista', id: 'nova-vitimas-lista' });
    var qtd = UI.el('span', { classe: 'nova-vitimas-qtd', id: 'nova-vitimas-qtd' });
    var add = UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'nova-add-vitima', texto: '+ Adicionar vítima' });
    var caixa = UI.el('details', { classe: 'nova-vitimas', id: 'nova-vitimas' }, [
      UI.el('summary', null, [UI.el('span', { texto: 'Vítimas' }), qtd]),
      UI.el('div', { classe: 'nova-vitimas-corpo' }, [
        lista,
        UI.el('div', { classe: 'nova-vitimas-acoes' }, [add]),
      ]),
    ]);
    function renumerar() {
      itens.forEach(function (it, i) { it.titulo.textContent = 'Vítima ' + (i + 1); });
      qtd.textContent = itens.length ? String(itens.length) : '';
    }
    function adicionar() {
      seq += 1;
      var campos = window.Cadastro.camposVitima(null, 'nova-vitima-' + seq);
      var it = { campos: campos, salva: false };
      it.titulo = UI.el('strong');
      it.estado = UI.el('small', { classe: 'nova-vitima-estado muted' });
      it.remover = UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Remover', onclick: async function () {
        if (it.salva) return;
        var nomeDigitado = it.campos.nome.value.trim();
        if (nomeDigitado) {
          var ok = await UI.confirmar({ titulo: 'Descartar a vítima "' + nomeDigitado + '"?', texto: 'A ficha ainda não foi salva: o que foi digitado nela se perde.', ok: 'Descartar', perigo: true });
          if (!ok) return;
        }
        itens = itens.filter(function (x) { return x !== it; });
        it.bloco.remove();
        renumerar();
        add.focus();
      } });
      it.bloco = UI.el('div', { classe: 'nova-vitima' }, [
        UI.el('div', { classe: 'nova-vitima-topo' }, [UI.el('div', null, [it.titulo, ' ', it.estado]), it.remover]),
      ].concat(campos.elementos));
      itens.push(it);
      lista.appendChild(it.bloco);
      renumerar();
      caixa.open = true;
      campos.nome.focus();
    }
    add.addEventListener('click', adicionar);
    return {
      elemento: caixa,
      itens: function () { return itens.slice(); },
      pendentes: function () { return itens.filter(function (it) { return !it.salva; }); },
      // null = todas certas; senão o texto do erro (o foco vai para o campo)
      validar: function () {
        for (var i = 0; i < itens.length; i++) {
          var it = itens[i];
          if (it.salva) continue;
          var inv = it.campos.validar(it.campos.ler());
          if (inv) { caixa.open = true; inv.campo.focus(); return 'Vítima ' + (i + 1) + ': ' + inv.texto; }
        }
        return null;
      },
      marcar: function (it, situacao, texto) {
        it.bloco.classList.toggle('salva', situacao === 'salva');
        it.bloco.classList.toggle('falhou', situacao === 'falhou');
        it.estado.textContent = texto || '';
        if (situacao === 'salva') { it.salva = true; it.campos.bloquear(true); it.remover.hidden = true; }
      },
    };
  }

  async function criarOperacao(ev, f) {
    ev.preventDefault();
    var erro = f.erro;
    erro.hidden = true;
    var btn = f.btn;
    if (!f.ctx.op) {
      var codigo = f.codigo.value.trim();
      if (codigo.length < 2) {
        erro.textContent = 'Informe o nome ou código da operação.';
        erro.hidden = false;
        f.codigo.focus();
        return;
      }
      var dados;
      try {
        dados = f.campos.ler();
      } catch (e) {
        erro.textContent = e.message;
        erro.hidden = false;
        return;
      }
      // as vítimas são conferidas ANTES de criar: um erro de digitação não deixa operação pela metade
      var invalida = f.vitimas.validar();
      if (invalida) { erro.textContent = invalida; erro.hidden = false; return; }
      btn.disabled = true;
      var args = { p_codigo: codigo, p_retencao_horas: RETENCAO_SEGURA_H, p_dados: dados };
      try {
        var op;
        try {
          op = await C.rpc('criar_operacao', args);
        } catch (e1) {
          if (e1.codigo !== 'funcao_ausente') throw e1;
          // banco sem a migração 007: cria só com o nome (o cadastro fica para depois)
          delete args.p_dados;
          op = await C.rpc('criar_operacao', args);
          UI.aviso('Operação criada só com o nome: o servidor ainda não tem o cadastro completo (migração 007).', 'erro', 9000);
        }
        f.ctx.op = op;
      } catch (e) {
        erro.textContent = e.message;
        erro.hidden = false;
        btn.disabled = false;
        return;
      }
      // a partir daqui a operação existe: os dados dela não são mais editáveis neste modal
      f.dadosOp.disabled = true;
    } else {
      var invalida2 = f.vitimas.validar();
      if (invalida2) { erro.textContent = invalida2; erro.hidden = false; return; }
      btn.disabled = true;
    }
    var falhas = await salvarVitimasNovaOp(f.ctx.op, f.vitimas);
    var salvas = f.vitimas.itens().filter(function (it) { return it.salva; }).length;
    if (!falhas.length) {
      f.fechar();
      if (salvas) UI.aviso('Operação criada com ' + salvas + (salvas > 1 ? ' fichas de vítima.' : ' ficha de vítima.'), 'ok');
      f.irParaOperacao();
      return;
    }
    // Operação criada, mas alguma ficha falhou: o modal fica aberto só para as vítimas.
    f.status.hidden = false;
    f.status.innerHTML = '';
    f.status.appendChild(UI.el('p', { classe: 'nota', texto: 'A operação "' + f.ctx.op.codigo + '" foi criada' + (salvas ? ' e ' + salvas + (salvas > 1 ? ' fichas foram salvas' : ' ficha foi salva') : '') +
      '. ' + (falhas.length > 1 ? falhas.length + ' fichas não foram salvas' : '1 ficha não foi salva') + ': ' + falhas[0] +
      '. Tente de novo ou siga sem elas (dá para cadastrar depois em Ferramentas → Vítimas).' }));
    btn.textContent = 'Tentar salvar de novo';
    btn.disabled = false;
    f.cancelar.textContent = 'Seguir sem elas';
  }

  // Salva, uma por vez, as fichas que ainda não foram salvas. Uma ficha salva nunca é
  // reenviada; antes de repetir, confere no servidor se a tentativa anterior já gravou
  // (resposta perdida por falta de sinal) para não duplicar.
  async function salvarVitimasNovaOp(op, vitimas) {
    var pend = vitimas.pendentes();
    var falhas = [];
    if (!pend.length) return falhas;
    var existentes = [];
    if (pend.some(function (it) { return it.tentou; })) {
      try {
        existentes = (await C.consultar(C.cliente.from('vitimas').select('id,nome,idade,caracteristicas,roupas,observacoes,nascimento,sexo,origem,perfil').eq('operacao_id', op.id))) || [];
      } catch (e) { existentes = []; }
    }
    function igual(a, b) {
      return a.nome === b.nome && (a.idade == null ? null : Number(a.idade)) === b.idade && (a.caracteristicas || '') === b.caracteristicas &&
        (a.roupas || '') === b.roupas && (a.observacoes || '') === b.observacoes && (a.nascimento || null) === (b.nascimento || null) &&
        (a.sexo || null) === (b.sexo || null) && (a.origem || '') === (b.origem || '') && JSON.stringify(a.perfil || []) === JSON.stringify(b.perfil || []);
    }
    for (var i = 0; i < pend.length; i++) {
      var it = pend[i];
      var dados = it.campos.ler();
      var ja = it.tentou ? existentes.findIndex(function (x) { return igual(x, dados); }) : -1;
      if (ja >= 0) {
        existentes.splice(ja, 1);
        vitimas.marcar(it, 'salva', '✓ salva');
        continue;
      }
      vitimas.marcar(it, null, 'salvando…');
      it.tentou = true;
      try {
        var salva = await C.rpc('salvar_vitima', { p_operacao: op.id, p_id: null, p_dados: dados });
        var arq = it.campos.arquivo();
        if (arq) {
          try {
            await window.Cadastro.subirFoto(op, salva, arq);
          } catch (e) {
            vitimas.marcar(it, 'salva', '✓ salva · foto não enviada: ' + e.message);
            continue;
          }
        }
        vitimas.marcar(it, 'salva', '✓ salva');
      } catch (e) {
        vitimas.marcar(it, 'falhou', '✕ não salva');
        falhas.push(e.message);
      }
    }
    return falhas;
  }

  // Ferramentas → Dados da operação (ver e editar o cadastro e o GPS).
  // Dashboard da operação (menu Operação): números desta operação, sem dados pessoais.
  function abrirDashboardOperacao() {
    if (!est.op || !window.Dashboard) return;
    var corpo = UI.el('div', { classe: 'estudo-operacao', id: 'estudo-operacao' });
    // Como no Dashboard geral: numa janela própria (ou outro monitor), com as operações noutra janela.
    var novaJanela = UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'dash-op-nova-janela', texto: '↗ Abrir em outra janela',
      title: 'Abre só o dashboard desta operação numa janela própria, para deixar o mapa em outra',
      onclick: function () { window.Dashboard.abrirJanela(est.op.id); } });
    var linkPublico = UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'dash-op-link-publico', texto: '🔗 Link público',
      title: 'Link para acompanhar a operação sem login, só visualização (sem nomes)', onclick: abrirLinkPublicoDashboard });
    var fechar = UI.abrirModal(UI.el('div', { classe: 'detalhe-operacao modal-dashboard' }, [
      UI.el('div', { classe: 'modal-dashboard-topo' }, [
        UI.el('h2', { id: 'modal-titulo', texto: 'Dashboard da operação · ' + est.op.codigo }),
        UI.el('div', { classe: 'dash-acoes' }, [
          podeAlterar() ? linkPublico : null,
          novaJanela,
          UI.el('button', { classe: 'btn btn-pequeno', type: 'button', 'aria-label': 'Fechar', texto: 'Fechar', onclick: function () { fechar(); } }),
        ]),
      ]),
      corpo,
    ]));
    // ações dos detalhes do dashboard: fecham as janelas e levam ao lugar certo do painel
    window.Dashboard.operacao(est.op, corpo, { resumo: resumoOperacao, acoes: {
      verPessoa: function (id) { UI.fecharTodos(); selecionar(id); },
      verSetor: function (id) { var s = est.setores.get(id); UI.fecharTodos(); if (s) verSetorNoMapa(s.d); },
      abrirCentral: function (aba) { UI.fecharTodos(); abrirCentral(aba); },
      abrirRelato: function (id) { UI.fecharTodos(); abrirRelato(id); },
      abrirDiario: function () { UI.fecharTodos(); if (window.Relatorio && est.op) window.Relatorio.abrirDiario(est.op); },
    } });
  }

  // Link público do dashboard (migração 048): quem abre não precisa de login e só vê os números (sem nomes,
  // sem textos de mensagens, sem fotos). Pode ser trocado (o anterior para de funcionar) ou desligado.
  function urlDashboardPublico(token) { return location.origin + '/dashboard.html?p=' + token; }
  function abrirLinkPublicoDashboard() {
    var op = est.op;
    if (!op) return;
    var corpo = UI.el('div');
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Link público do dashboard' }),
      UI.dica('Quem abre o link vê o dashboard desta operação sem entrar no sistema, só para acompanhar: números, gráficos, setores e vítimas (sem nomes). Não dá para alterar nada. Trocar o link faz o anterior parar de funcionar.'),
      corpo,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]), { empilhar: true });
    async function executar(fn, aviso) {
      try {
        var r = await C.rpc(fn, { p_operacao: op.id });
        op.dashboard_token = r.token || null;
        desenhar();
        if (aviso) UI.aviso(aviso, 'ok');
      } catch (e) { UI.aviso('Não foi possível: ' + e.message, 'erro', 7000); }
    }
    function desenhar() {
      corpo.innerHTML = '';
      if (!op.dashboard_token) {
        corpo.appendChild(UI.el('p', { classe: 'muted', texto: 'Esta operação ainda não tem link público.' }));
        corpo.appendChild(UI.el('button', { classe: 'btn btn-escuro', type: 'button', id: 'dash-pub-criar', texto: 'Criar link público', onclick: async function () {
          if (!(await UI.confirmar({ titulo: 'Criar o link público?', texto: 'Qualquer pessoa com o link poderá acompanhar o dashboard desta operação, sem login e sem poder alterar nada. Os nomes das pessoas não aparecem.', ok: 'Criar link', empilhar: true }))) return;
          executar('dashboard_publico_gerar', 'Link público criado.');
        } }));
        return;
      }
      var url = urlDashboardPublico(op.dashboard_token);
      var campo = UI.el('input', { classe: 'campo mono', id: 'dash-pub-url', readonly: true, value: url });
      corpo.appendChild(UI.campo('Endereço', campo, { para: 'dash-pub-url' }));
      corpo.appendChild(UI.el('div', { classe: 'linha-botoes' }, [
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', id: 'dash-pub-copiar', texto: 'Copiar link', onclick: function () {
          (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { UI.aviso('Link copiado.', 'ok'); }, function () { campo.select(); UI.aviso('Selecione e copie o endereço.', 'erro'); });
        } }),
        UI.el('a', { classe: 'btn', id: 'dash-pub-whatsapp', target: '_blank', rel: 'noopener', href: 'https://wa.me/?text=' + encodeURIComponent('Acompanhe a operação ' + op.codigo + ' (somente visualização): ' + url), texto: 'Enviar pelo WhatsApp' }),
        UI.el('a', { classe: 'btn', target: '_blank', rel: 'noopener', href: url, texto: 'Abrir' }),
        UI.el('button', { classe: 'btn', type: 'button', id: 'dash-pub-trocar', texto: 'Trocar link', onclick: async function () {
          if (!(await UI.confirmar({ titulo: 'Trocar o link público?', texto: 'O link atual para de funcionar na hora. Quem estiver acompanhando precisará do novo.', ok: 'Trocar', empilhar: true }))) return;
          executar('dashboard_publico_gerar', 'Link trocado. O anterior não funciona mais.');
        } }),
        UI.el('button', { classe: 'btn', type: 'button', id: 'dash-pub-desligar', texto: 'Desligar', onclick: async function () {
          if (!(await UI.confirmar({ titulo: 'Desligar o link público?', texto: 'Quem tiver o link deixa de ver o dashboard.', ok: 'Desligar', perigo: true, empilhar: true }))) return;
          executar('dashboard_publico_desligar', 'Link público desligado.');
        } }),
      ]));
    }
    desenhar();
  }

  // Retrato do que o painel já tem carregado, para o dashboard da operação (sem nova consulta ao banco):
  // trilhas filtradas (GPS.trilha), grupo de cada pessoa, setores com vértices e área, e ocorrências.
  function resumoOperacao() {
    var participantes = Array.from(est.participantes.values()).map(function (p) {
      var tr = window.GPS.trilha(p.pontos, { precisaoTrilhaM: LIM.precisaoTrilhaM, lacunaMs: lacunaMsOp(), objetos: true });
      var g = grupoDoParticipante(p);
      return {
        id: p.id, nome: nomeExibido(p), tipo: tipoDe(p.dados), grupo: g ? { id: g.id, nome: g.nome, cor: g.cor } : null,
        segmentos: tr.segmentos.map(function (seg) { return seg.map(function (pt) { return { lat: pt.lat, lng: pt.lng, t: pt.t }; }); }),
      };
    });
    var setores = Array.from(est.setores.values()).map(function (x) {
      return { id: x.d.id, nome: x.d.nome, areaM2: areaSetorM2(x.d), vertices: verticesSetor(x.d) };
    });
    var o = { ajuda: 0, PISTA: 0, VESTIGIO: 0, OBJETO: 0, OBSTACULO: 0, ordens: 0, fotos: est.fotos.size, pontos: est.pontosInt.size, retornosAtrasados: 0 };
    est.mensagens.forEach(function (m) {
      if (m.categoria === 'AJUDA' || m.resposta === 'PRECISO_AJUDA') o.ajuda++;
      if (m.direcao === 'entrada' && m.categoria && o[m.categoria] != null && m.categoria !== 'AJUDA') o[m.categoria]++;
      if (m.direcao !== 'entrada') o.ordens++;
    });
    est.alertas.forEach(function (a) { if (a.tipo === 'retorno_atrasado') o.retornosAtrasados++; });
    // relatos e ordens, para a lista ao tocar numa ocorrência do dashboard
    var relatos = [];
    est.mensagens.forEach(function (m) {
      var ajuda = m.categoria === 'AJUDA' || m.resposta === 'PRECISO_AJUDA';
      if (m.direcao === 'entrada' && !ajuda && !(m.categoria && o[m.categoria] != null)) return;
      relatos.push({ id: m.id, categoria: ajuda ? 'AJUDA' : m.categoria, direcao: m.direcao, criada_em: m.criada_em, texto: m.texto, autor: m.remetente_nome });
    });
    relatos.sort(function (a, b) { return String(b.criada_em).localeCompare(String(a.criada_em)); });
    return { agora: Date.now(), participantes: participantes, setores: setores, ocorrencias: o, relatos: relatos };
  }

  function abrirDadosOperacao() {
    if (!est.op) return;
    window.Cadastro.abrirDados(est.op, {
      editavel: podeAlterar(),
      limparArquivos: limparArquivosPendentes,
      verNoMapa: function (op) { verLocalNoMapa(op); },
      aoSalvar: function (atual) {
        if (!est.op || !atual || atual.id !== est.op.id) return;
        est.op = Object.assign(est.op, atual);
        renderizarCabecalho();
        desenharLocalOp();
        aplicarIntervaloGpsMeu();
        est.participantes.forEach(function (p) { sujarTrilha(p); });   // limite de falha pode ter mudado
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Exclusão definitiva de uma operação                                  */
  /* ------------------------------------------------------------------ */
  // Mostrado só a quem pode excluir: quem criou a operação ou um administrador.
  // A regra que vale é a do banco (função excluir_operacao); isto só esconde o botão.
  // Arquivar (migração 055): operação encerrada, ainda não arquivada; quem criou ou administrador (o servidor confere)
  function podeArquivar(op) {
    if (!op || op.status === 'ativa' || op.arquivada_em || !('arquivada_em' in op)) return false;
    return Boolean(est.usuario && (op.responsavel_id === est.usuario.id || (est.responsavel && est.responsavel.admin)));
  }

  async function arquivarOperacao(op) {
    var ok = await UI.confirmar({
      titulo: 'Arquivar a operação ' + op.codigo + '?',
      texto: 'Os dados da operação (participantes, posições, trilhas, mensagens, setores, pontos, diário e registros) saem do banco '
        + 'para um arquivo compactado no Storage, para liberar espaço. A operação continua na lista e abre só para consulta, '
        + 'com mapa, relatórios e dashboard. Fotos e relatórios continuam onde estão. O arquivo é conferido antes de apagar '
        + 'qualquer coisa; se algo não bater, nada é apagado. Não dá para desfazer pelo app.',
      ok: 'Arquivar agora',
    });
    if (!ok) return;
    UI.aviso('Arquivando ' + op.codigo + '… pode levar até um minuto.', 'ok', 5000);
    try {
      var s = await C.cliente.auth.getSession();
      var token = s && s.data && s.data.session ? s.data.session.access_token : null;
      if (!token) throw C.criarErro({ message: 'nao_autenticado' });
      var r = await fetch('/api/arquivar', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ operacao_id: op.id }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok || !j.ok) throw C.criarErro({ message: (j.erro || 'falha') + (j.detalhe ? ' (' + j.detalhe + ')' : '') });
      UI.aviso('Operação ' + op.codigo + ' arquivada: ' + (j.linhas || 0) + ' registro(s) num arquivo de ' + Math.max(1, Math.round((j.bytes || 0) / 1024)) + ' KB.', 'ok', 8000);
    } catch (e) {
      UI.aviso('Não foi possível arquivar: ' + (e.message || e), 'erro', 10000);
    }
    mostrarOperacoes();
  }

  function podeExcluir(op) {
    return Boolean(op && est.usuario && est.responsavel && (op.responsavel_id === est.usuario.id || est.responsavel.admin));
  }

  function textoFalhaArquivos(n) {
    return n + ' arquivo(s) de foto não puderam ser apagados agora. Eles ficaram registrados e serão apagados automaticamente pela limpeza diária.';
  }

  // Apaga do Storage os arquivos de fotos cujos registros este responsável acabou
  // de excluir. O que falhar continua na fila (arquivos_pendentes) e é apagado
  // depois pela limpeza diária (/api/limpeza), sem ficar esquecido.
  async function limparArquivosPendentes() {
    var itens;
    try {
      // com o bucket de cada arquivo (fotos de campo ou fotos de vítimas — migração 007)
      itens = await C.rpc('meus_arquivos_pendentes_v2');
    } catch (e) {
      if (e.codigo !== 'funcao_ausente') return { apagados: 0, falhas: 0, erro: e.message };
      try {
        itens = ((await C.rpc('meus_arquivos_pendentes')) || []).map(function (c) { return { caminho: c, bucket: 'fotos' }; });
      } catch (e2) {
        return { apagados: 0, falhas: 0, erro: e2.message };
      }
    }
    itens = itens || [];
    var porBucket = {};
    itens.forEach(function (it) { (porBucket[it.bucket || 'fotos'] = porBucket[it.bucket || 'fotos'] || []).push(it.caminho); });
    var apagados = 0;
    var buckets = Object.keys(porBucket);
    for (var b = 0; b < buckets.length; b++) {
      var caminhos = porBucket[buckets[b]];
      for (var i = 0; i < caminhos.length; i += 100) {
        var lote = caminhos.slice(i, i + 100);
        try {
          var r = await C.cliente.storage.from(buckets[b]).remove(lote);
          if (r.error) continue;
          var conf = await C.rpc('confirmar_arquivos_removidos', { p_caminhos: lote });
          apagados += Number(conf) || 0;
        } catch (e) { /* fica na fila para a limpeza diária */ }
      }
    }
    return { apagados: apagados, falhas: itens.length - apagados };
  }

  // Excluir: uma confirmação simples. Apaga a operação e tudo o que é dela (migração 041).
  async function excluirOperacao(op) {
    if (!op || !podeExcluir(op)) return;
    var r = await UI.confirmar({
      titulo: 'Excluir "' + op.codigo + '"?',
      texto: 'Apaga a operação e todos os dados dela: participantes, trilhas, mensagens, fotos, fichas, grupos, diário e relatórios. Os links deixam de funcionar. Não dá para desfazer.',
      ok: 'Excluir',
      perigo: true,
    });
    if (!r) return;
    var aviso = UI.aviso('Excluindo a operação…', null, 'fixo');
    var res;
    try {
      res = await C.rpc('excluir_operacao', { p_operacao: op.id }, 30000);
    } catch (e) {
      if (aviso && aviso.parentNode) aviso.remove();
      UI.aviso('Não foi possível excluir: ' + e.message + (e.rede ? ' Nada foi apagado; tente de novo quando a conexão voltar.' : ''), 'erro', 8000);
      return;
    }
    var arq = await limparArquivosPendentes();
    if (aviso && aviso.parentNode) aviso.remove();
    var resumo = 'Operação "' + (res && res.operacao || op.codigo) + '" excluída' +
      (res ? ' (' + res.participantes + ' participante(s), ' + res.fotos + ' foto(s)' + (res.vitimas != null ? ', ' + res.vitimas + ' ficha(s) de vítima' : '') + ')' : '') + '.';
    if (arq.falhas) UI.aviso(resumo + ' ' + textoFalhaArquivos(arq.falhas), 'erro', 'fixo');
    else UI.aviso(resumo, 'ok', 5000);
    if (est.op && est.op.id === op.id) {
      fecharPainel();
      if (location.hash) location.hash = '';
      else mostrarOperacoes();
    } else {
      mostrarOperacoes();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Painel: abertura e fechamento                                        */
  /* ------------------------------------------------------------------ */
  // Spinner sobre o painel até a operação carregar (participantes, posições, mensagens, setores, grupos, POA, pedidos de ajuda, briefing…).
  // Trava de segurança: some sozinho depois de 45 s, para nunca prender a tela.
  function carregandoPainel(ligado) {
    var c = $('painel-carregando');
    if (!c) return;
    clearTimeout(est.timerCarregando);
    c.hidden = !ligado;
    $('tela-painel').setAttribute('aria-busy', String(Boolean(ligado)));
    if (ligado) est.timerCarregando = setTimeout(function () { c.hidden = true; $('tela-painel').setAttribute('aria-busy', 'false'); }, 45000);
  }

  async function abrirPainel(id) {
    fecharPainel();
    mostrarTela('painel');
    carregandoPainel(true);
    var op;
    try {
      op = await C.consultar(C.cliente.from('operacoes').select('*').eq('id', id).maybeSingle());
    } catch (e) {
      carregandoPainel(false);
      UI.aviso(e.message, 'erro');
      location.hash = '';
      return;
    }
    if (!op) {
      carregandoPainel(false);
      UI.aviso('Operação não encontrada ou sem permissão de acesso.', 'erro');
      location.hash = '';
      return;
    }
    // Operação arquivada (migração 055): os dados estão no arquivo do Storage; baixa e confere antes de montar o painel
    if (op.arquivada_em && window.ArquivoLocal) {
      try {
        await window.ArquivoLocal.carregar(op, { usuarioNome: est.responsavel && est.responsavel.nome });
      } catch (e) {
        carregandoPainel(false);
        UI.aviso('Não foi possível abrir o arquivo desta operação: ' + (e.message || e), 'erro', 10000);
        location.hash = '';
        return;
      }
    }
    est.op = op;
    avaliarGaveta();
    aplicarLateral(false);
    renderizarCabecalho();
    criarMapa();
    desenharLocalOp();
    aplicarIntervaloGpsMeu();
    await carregarTudo();
    assinarTempoReal();
    assinarTempoRealExtras();
    assinarTrilhasManuais();
    var cargasModulos = [];
    ['BuscaCenario', 'AjudaPedidos', 'RecursosEquipe', 'Briefing', 'RelatosRevisao', 'Binomio', 'ObservacoesCampo'].forEach(function (nome) {
      if (window[nome]) cargasModulos.push(Promise.resolve(window[nome].iniciar()).catch(function () { /* o módulo mostra o próprio aviso */ }));
    });
    // o spinner sai quando tudo da operação chegou (e só se ainda é a mesma operação)
    Promise.all(cargasModulos).then(function () { if (est.op && est.op.id === op.id) carregandoPainel(false); });
    est.timerStatus = setInterval(atualizarEstados, 5000);
    // Reserva do alerta de retorno atrasado (o servidor verifica por pg_cron; sem ele, o painel aberto verifica).
    est.timerRetornos = setInterval(verificarRetornosPainel, 30000);
    iniciarPolling();
    if (op.status === 'ativa') {
      // O responsável só entra no mapa (e só registra posição) quando liga "Registrar minha trilha".
      // Se já tem registro nesta operação (ligou antes), ele é reaproveitado para mensagens e fotos.
      acharMeuRegistro();
      est.timerMeuSinal = setInterval(function () {
        if (!est.op || est.op.status !== 'ativa') return;
        if (est.compartilhando && !est.meuPart) entrarComoResponsavel();
        else if (est.meuPart) enviarMeuSinal();
        lerPosicaoSeParado();
        vigiarMeuGps();
        enviarMinhaFila();
        enviarFilaFotos();
      }, CFG_GPS.sinalVidaMs);
      // Estava registrando neste aparelho (a página recarregou)? Pergunta antes de retomar.
      oferecerRetomarMinhaTrilha();
    }
    atualizarEstadoGps();
    if (est.abrirConvite) {
      est.abrirConvite = false;
      abrirConvite();
    }
  }

  function fecharPainel() {
    carregandoPainel(false);
    pararMinhaPosicao(true);
    clearInterval(est.timerMeuSinal);
    est.timerMeuSinal = null;
    est.meuPart = null;
    est.filaMinha = null;
    est.abrindoMinha = null;
    est.bufferMinha = [];
    est.ultimoAceitoMeu = null;
    est.filtroMeu.reiniciar();
    est.minhaPosEstado = 'desligada';
    est.enviouMinhaAlguma = false;
    est.entregando = new Set();
    est.alertaAtual = null;
    if ($('alerta-cmd')) $('alerta-cmd').hidden = true;
    fecharMenu(false);
    fecharCamadas(false);
    fecharCentral();
    fecharLightbox();
    cancelarDesenho();
    fecharAreas();
    fecharRelevo3D();
    clearTimeout(est.timerAreas);
    est.setores = new Map();
    est.pontosInt = new Map();
    est.destinos = new Map();
    est.camadaSetores = est.camadaPontosInt = est.linhaDestino = est.marcaDestino = null;
    est.rotasFicha = new Map();
    pararRotaApoio();
    est.camadaRotaApoio = null;
    est.camadaRotaFicha = null;
    est.rotaFichaChave = null;
    est.centralVoltar = false;
    clearTimeout(est.timerNotif);
    est.filaNotif = [];
    est.lidasLocal = new Set();
    est.marcandoLidas = new Set();
    est.destaqueNovas = new Set();
    est.relatosMarc = new Map();
    est.fotos = new Map();
    est.fotosMarc = new Map();
    est.camadaPontos = est.legenda = est.camadasBase = null;
    est.assinaturaConversa = '';
    est.marcaLocal = null;
    est.grupos = new Map();
    est.membros = new Map();
    est.semGrupos = false;
    est.filtroGrupos = new Set();
    est.controleGrupos = est.camadaDestinosGrupo = null;
    est.missoes = new Map();
    est.missaoMembros = new Map();
    est.semMissoes = false;
    est.alertas = new Map();
    est.alertasCarregados = false;
    est.alertaFaixa = null;
    est.vitimasLoc = new Map();
    est.fichas = new Map();
    est.semVitimaLoc = false;
    est.permanencias = new Map();
    est.semPermanencia = false;
    $('faixa-alerta').hidden = true;
    clearInterval(est.timerRetornos);
    clearInterval(est.timerAlarmeCritico);
    clearTimeout(est.timerGrupos);
    clearTimeout(est.timerMissoes);
    clearTimeout(est.timerExtras);
    est.timerRetornos = est.timerAlarmeCritico = est.timerGrupos = est.timerMissoes = null;
    if (est.canalExtras) {
      try { C.cliente.removeChannel(est.canalExtras); } catch (e) { /* ignora */ }
      est.canalExtras = null;
    }
    encerrarTrilhasManuais();
    if (window.BuscaCenario) window.BuscaCenario.parar();
    if (window.AjudaPedidos) window.AjudaPedidos.parar();
    if (window.RecursosEquipe) window.RecursosEquipe.parar();
    if (window.Briefing) window.Briefing.parar();
    ['RelatosRevisao', 'Binomio', 'ObservacoesCampo'].forEach(function (nome) { if (window[nome]) window[nome].parar(); });
    if (est.fotosFila.length) UI.aviso(est.fotosFila.length + ' foto(s) sua(s) não chegaram a ser enviadas e foram descartadas ao sair do painel.', 'erro', 10000);
    est.fotosFila = [];
    clearInterval(est.timerStatus);
    clearInterval(est.timerPoll);
    clearTimeout(est.timerReassinar);
    est.timerStatus = est.timerPoll = est.timerReassinar = null;
    if (est.canal) {
      try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ }
      est.canal = null;
    }
    est.geracaoCanal++;
    fecharFicha();
    UI.fecharModal();
    if (est.mapa) {
      est.mapa.remove();
      est.mapa = null;
    }
    est.resumo = null;
    est.op = null;
    est.participantes = new Map();
    est.pontosOrfaos = [];
    est.posIds = new Set();
    est.maxPosId = 0;
    est.mensagens = new Map();
    est.selecionado = null;
    est.circuloPrecisao = null;
    est.jaEnquadrou = false;
    est.tempoReal = 'conectando';
    est.precisaRecarregar = false;
    est.ultimoSyncOk = 0;
    est.syncFalhou = false;
    $('lista-part').innerHTML = '';
    $('lista-removidos').innerHTML = '';
    $('feed-msgs').innerHTML = '';
    $('galeria').innerHTML = '';
    atualizarContadorMsgs();
  }

  function limparDadosDoMapa() {
    est.participantes.forEach(function (p) {
      tirarPessoaDoMapa(p);
      if (p.trilha) p.trilha.remove();
      if (p.halo) p.halo.remove();
      if (p.lacunas) p.lacunas.remove();
    });
    limparAreasDoMapa();
    // grupos, deslocamentos e alertas também são apagados com os dados (retenção)
    est.grupos = new Map();
    est.membros = new Map();
    est.missoes = new Map();
    est.missaoMembros = new Map();
    est.alertas = new Map();
    est.vitimasLoc = new Map();
    est.fichas = new Map();
    est.permanencias = new Map();
    est.filtroGrupos = new Set();   // sem redesenhar: as trilhas e marcadores acabaram de ser removidos
    if (est.camadaDestinosGrupo) est.camadaDestinosGrupo.clearLayers();
    renderizarControleGrupos();
    mostrarFaixaAlerta();
    if (est.circuloPrecisao) { est.circuloPrecisao.remove(); est.circuloPrecisao = null; }
    if (est.camadaPontos) est.camadaPontos.clearLayers();
    if (est.camadaPontosFixos) est.camadaPontosFixos.clearLayers();
    est.participantes = new Map();
    est.posIds = new Set();
    est.mensagens = new Map();
    est.fotos = new Map();
    est.fotosMarc = new Map();
    est.relatosMarc = new Map();
    fecharFicha();
    $('lista-part').innerHTML = '';
    $('lista-removidos').innerHTML = '';
    renderizarLista();
    renderizarCentral();
    atualizarContadorMsgs();
  }

  function renderizarCabecalho() {
    var op = est.op;
    $('op-codigo').textContent = op.codigo;
    var tipoOp = window.Cadastro.textoTipo(op);
    $('op-sub').textContent = (tipoOp ? tipoOp + ' · ' : '') + (op.status === 'ativa' ? 'Operação ativa' : op.arquivada_em ? 'Operação arquivada · só leitura' : 'Operação encerrada · só leitura');
    $('menu-dados-estado').textContent = 'tipo' in op && window.Cadastro.incompleto(op) ? 'cadastro incompleto' : '';
    $('menu-grupos').hidden = Boolean(op.dados_apagados_em);
    $('menu-missoes').hidden = Boolean(op.dados_apagados_em);
    $('menu-destino').hidden = op.status !== 'ativa';
    $('btn-encerrar').hidden = op.status !== 'ativa';
    $('btn-convite').hidden = op.status !== 'ativa';
    $('btn-registrar-foto').hidden = op.status !== 'ativa';
    $('menu-vitima').hidden = op.status !== 'ativa';
    $('menu-vitima-rapida').hidden = op.status !== 'ativa';
    $('menu-minha-trilha').hidden = op.status !== 'ativa';
    $('btn-excluir-op').hidden = !podeExcluir(op);
    $('menu-zona-perigo').hidden = $('btn-encerrar').hidden && $('btn-excluir-op').hidden;
    $('menu-destino').hidden = op.status !== 'ativa';
    ['menu-setor', 'menu-trilha', 'menu-ponto'].forEach(function (id) { $(id).hidden = op.status !== 'ativa' || Boolean(op.dados_apagados_em); });
    // encerrada: painel só para consulta (botões de alteração somem; o servidor também recusa)
    $('tela-painel').classList.toggle('op-somente-leitura', op.status !== 'ativa');
    if (op.status !== 'ativa' && est.compartilhando) pararMinhaPosicao(true);
    var faixa = $('faixa-encerrada');
    faixa.hidden = op.status === 'ativa';
    if (op.status !== 'ativa') {
      $('faixa-encerrada-texto').innerHTML = '<span class="selo selo-neutro">Somente visualização</span> ' + C.esc('Operação encerrada em ' + C.hora(op.encerrada_em) + '. ' +
        (op.dados_apagados_em ? 'Os dados pessoais foram apagados (regra antiga de retenção); o cadastro, o diário e os relatórios continuam.' : 'Nada pode ser alterado. Os dados continuam guardados para consulta e análise.'));
    }
    atualizarTitulo();
  }

  function atualizarTitulo() {
    if (!est.op) return;
    var n = naoLidas().length;
    document.title = (n ? '(' + n + ') ' : '') + est.op.codigo + ' — Painel GBS';
  }

  /* ------------------------------------------------------------------ */
  /* Mapa                                                                 */
  /* ------------------------------------------------------------------ */
  function criarMapa() {
    var mapa = L.map('mapa', { zoomControl: true, preferCanvas: false, worldCopyJump: true }).setView([-15.79, -47.88], 4);
    // Acima do zoom que o servidor tem (maxNativeZoom) os ladrilhos são ampliados, em vez de sumirem.
    var osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 19,
      maxZoom: 22,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
    var topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 17,   // o servidor vai até 17; acima disso os ladrilhos são ampliados (zoom continua funcionando)
      maxZoom: 19,
      subdomains: 'abc',
      attribution: '&copy; OpenStreetMap, SRTM | Estilo: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    });
    var satelite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 18,   // bug: sem isto o mapa sumia perto de 20 m de escala; agora o ladrilho do zoom 18 é ampliado
      maxZoom: 22,
      attribution: 'Imagens &copy; Esri, Maxar, Earthstar Geographics',
    });
    // As camadas de fundo são escolhidas no painel "Camadas", sobre o mapa.
    est.camadasBase = { osm: osm, topo: topo, satelite: satelite };
    est.camadaAtual = est.camadasBase[est.prefsMapa.camada] ? est.prefsMapa.camada : 'osm';
    est.camadasBase[est.camadaAtual].addTo(mapa);
    L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(mapa);

    // Controle essencial de orientação que fica sempre no mapa: enquadrar todos.
    var Botoes = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        var div = L.DomUtil.create('div', 'leaflet-bar');
        var b1 = L.DomUtil.create('a', 'btn-mapa', div);
        b1.href = '#';
        b1.title = 'Enquadrar todos os participantes';
        b1.setAttribute('role', 'button');
        b1.setAttribute('aria-label', b1.title);
        b1.textContent = '⤢';
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.on(b1, 'click', function (e) { L.DomEvent.preventDefault(e); enquadrarTodos(); });
        return div;
      },
    });
    new Botoes().addTo(mapa);

    // Legenda compacta: começa SEMPRE recolhida (um toque em "Legenda" abre e fecha).
    // A identificação mostra só os tipos que estão na operação; a lista de grupos é
    // gerada dos grupos cadastrados (sem grupos fantasmas nem cores sem grupo).
    var Legenda = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd: function () {
        var div = L.DomUtil.create('div', 'legenda');
        div.innerHTML = '<details class="legenda-det"><summary>▤ Legenda</summary><div class="legenda-corpo"></div></details>';
        est.legendaCorpo = div.querySelector('.legenda-corpo');
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        return div;
      },
    });
    est.legenda = new Legenda();
    est.legenda.addTo(mapa);   // sempre no mapa; abre e fecha tocando em "Legenda"
    // Meteorologia: botão próprio logo acima da legenda (liga/desliga o painel de tempo; js/meteo.js)
    var BotaoMeteo = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd: function () {
        var div = L.DomUtil.create('div', 'controle-meteo');
        var ligada = window.MeteoPainel && window.MeteoPainel.estado ? Boolean(window.MeteoPainel.estado().ligada) : false;
        div.innerHTML = '<button class="btn-meteo-mapa" type="button" id="opt-meteo" aria-pressed="' + ligada + '" title="Radar, previsão e alertas do tempo na área">☂ Meteorologia</button>';
        L.DomEvent.disableClickPropagation(div);
        div.firstChild.addEventListener('click', function () { if (window.MeteoPainel && window.MeteoPainel.alternar) window.MeteoPainel.alternar(); });
        return div;
      },
    });
    new BotaoMeteo().addTo(mapa);   // adicionado depois: fica acima da legenda

    // Bússola pequena no canto: o mapa é sempre norte para cima, então a rosa mostra onde fica o norte e o sul.
    var Bussola = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd: function () {
        var div = L.DomUtil.create('div', 'bussola-mapa');
        div.title = 'Norte: o mapa sempre fica com o norte para cima';
        div.setAttribute('role', 'img');
        div.setAttribute('aria-label', 'Bússola: norte para cima');
        div.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true">' +
          '<circle cx="24" cy="24" r="22.5" fill="none" stroke="currentColor" stroke-opacity=".3"/>' +
          '<path d="M24 13 L28.5 25 L24 23 L19.5 25 Z" fill="#ef4444"/>' +
          '<path d="M24 35 L28.5 23 L24 25 L19.5 23 Z" fill="currentColor" fill-opacity=".45"/>' +
          '<text x="24" y="10.5" text-anchor="middle" font-size="7.5" font-weight="700" fill="#ef4444">N</text>' +
          '<text x="24" y="46" text-anchor="middle" font-size="6.5" font-weight="600" fill="currentColor" fill-opacity=".7">S</text>' +
          '<text x="42.5" y="26.5" text-anchor="middle" font-size="6.5" font-weight="600" fill="currentColor" fill-opacity=".7">L</text>' +
          '<text x="5.5" y="26.5" text-anchor="middle" font-size="6.5" font-weight="600" fill="currentColor" fill-opacity=".7">O</text>' +
          '</svg>';
        L.DomEvent.disableClickPropagation(div);
        return div;
      },
    });
    new Bussola().addTo(mapa);

    // Grupos: cada grupo com o ícone de olho (mostrar só o grupo / restaurar tudo).
    var Grupos = L.Control.extend({
      options: { position: UI.aparencia.posicaoGrupos() },
      onAdd: function () {
        var div = L.DomUtil.create('div', 'controle-grupos');
        div.hidden = true;
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        return div;
      },
    });
    est.controleGrupos = new Grupos();
    est.controleGrupos.addTo(mapa);
    // Destinos dos membros do grupo filtrado (só aparecem com o filtro ligado).
    est.camadaDestinosGrupo = L.layerGroup().addTo(mapa);

    // Fotos e relatos: agrupados quando estão próximos (o número indica quantos),
    // para não poluir o mapa. Ao aproximar, cada um aparece no seu local; vários
    // no mesmo ponto se abrem em leque ao tocar no grupo.
    // Camada própria, abaixo dos participantes: quem está em campo fica sempre visível por cima.
    var painelPontos = mapa.createPane('pontos');
    painelPontos.style.zIndex = 550;
    est.camadaPontos = criarGrupo().addTo(mapa);
    est.camadaPontosFixos = L.layerGroup().addTo(mapa);
    // Grupo aberto em leque: as fotos e relatos sobem para ficar fáceis de tocar.
    est.camadaPontos.on('spiderfied', function () { painelPontos.style.zIndex = 650; });
    est.camadaPontos.on('unspiderfied', function () { painelPontos.style.zIndex = 550; });

    // Setores ficam ABAIXO das trilhas e dos marcadores (não escondem nada).
    mapa.createPane('setores').style.zIndex = 350;
    // Nome do setor: acima das áreas e trilhas, mas abaixo das pessoas e pontos (não as cobre).
    var painelRotSetor = mapa.createPane('rotulosSetor');
    painelRotSetor.style.zIndex = 450;
    painelRotSetor.style.pointerEvents = 'none';
    est.camadaSetores = L.layerGroup();
    est.camadaPontosInt = L.layerGroup();
    // Trilhas desenhadas à mão: acima dos setores e abaixo dos rastros de GPS e dos marcadores.
    mapa.createPane('trilhasDesenhadas').style.zIndex = 390;
    est.camadaTrilhasManuais = L.layerGroup().addTo(mapa);
    if (est.prefsMapa.setores) est.camadaSetores.addTo(mapa);
    if (est.prefsMapa.pontos) est.camadaPontosInt.addTo(mapa);
    mapa.on('click', aoClicarNoMapa);
    ligarSegurarNoMapa(mapa);
    // toque longo / botão direito: coordenadas e altitude do ponto (como no AlpineQuest)
    mapa.on('contextmenu', function (e) { if (!est.desenho && window.Ferramentas) window.Ferramentas.infoPonto(e.latlng); });

    est.mapa = mapa;
    // Pessoas: agrupadas de longe quando estão perto umas das outras; quem pede atenção fica à parte.
    est.camadaPessoasFixas = L.featureGroup().addTo(mapa);
    // "Pessoas" desligado só esconde (CSS): tirar o agrupamento do mapa com gente se movendo quebra a biblioteca
    $('mapa').classList.toggle('ocultar-pessoas', !est.prefsMapa.pessoas);
    montarCamadaPessoas();
    // Nomes pelo zoom e sem sobreposição (mapa-rotulos.js)
    est.rotulos = window.MapaRotulos ? window.MapaRotulos.instalar(mapa) : { agendar: function () {} };
    // De longe, um selo só por região no lugar dos agrupamentos separados (js/mapa-resumo.js)
    est.resumo = window.MapaResumo ? window.MapaResumo.instalar(mapa, { coletar: coletarParaResumo }) : null;
    mapa.on('zoomend', estilizarTrilhas);
    $('mapa').classList.toggle('esconder-rotulos', !est.prefsMapa.nomesMapa);
    atualizarMenu();
    setTimeout(function () { mapa.invalidateSize(); }, 50);
  }

  // Agrupamento único de tudo que é ponto no mapa: pontos de interesse, relatos e fotos.
  // O círculo mostra quantos são e um anel com a proporção de cada tipo; "!" vermelho quando
  // há área de risco ou pedido de ajuda dentro. De perto o raio diminui; vários no mesmo
  // lugar se abrem em leque ao tocar.
  var COR_TIPO_PONTO = { poi: '#38bdf8', relato: '#f97316', foto: '#a855f7', verif: '#fbbf24', import: '#84cc16' };
  var ROTULO_TIPO_PONTO = { poi: ['ponto de interesse', 'pontos de interesse'], relato: ['relato', 'relatos'], foto: ['foto', 'fotos'],
    verif: ['indicação a verificar', 'indicações a verificar'], import: ['ponto importado', 'pontos importados'] };
  var TIPOS_PONTO_ORDEM = ['poi', 'relato', 'foto', 'verif', 'import'];
  function criarGrupo() {
    if (!L.markerClusterGroup) return L.featureGroup();   // biblioteca indisponível: sem agrupamento
    return L.markerClusterGroup({
      clusterPane: 'pontos',
      showCoverageOnHover: false,
      // agrupa já na escala de 200 m e de 100 m (zoom 16 e 17); só bem de perto o raio diminui
      maxClusterRadius: function (z) { return z >= 19 ? 26 : z >= 17 ? 40 : 50; },
      spiderfyOnMaxZoom: true,
      zoomToBoundsOnClick: true,
      iconCreateFunction: function (grupo) {
        var filhos = grupo.getAllChildMarkers();
        var cont = { poi: 0, relato: 0, foto: 0, verif: 0, import: 0 }, critico = false, vitimas = [];
        filhos.forEach(function (m) {
          var t = cont[m.options.tipoPonto] != null ? m.options.tipoPonto : 'poi';
          cont[t]++;
          if (m.options.critico) critico = true;
          if (m.options.vitima) vitimas.push(m.getLatLng());
        });
        // relato e ponto da mesma vítima (a menos de 30 m) contam como uma só
        var vitima = vitimas.filter(function (ll, i) { return !vitimas.slice(0, i).some(function (o) { return o.distanceTo(ll) < 30; }); }).length;
        var cores = [];
        TIPOS_PONTO_ORDEM.forEach(function (t) { for (var i = 0; i < cont[t]; i++) cores.push(COR_TIPO_PONTO[t]); });
        var anel = window.MapaRotulos ? window.MapaRotulos.fatiasDeCor(cores) : cores[0] + ' 0deg 360deg';
        var dica = TIPOS_PONTO_ORDEM.filter(function (t) { return cont[t]; })
          .map(function (t) { return cont[t] + ' ' + ROTULO_TIPO_PONTO[t][cont[t] === 1 ? 0 : 1]; }).join(', ') +
          (vitima ? ' · inclui vítima localizada' : '') + (critico ? ' · inclui área de risco ou pedido de ajuda' : '') + '. Toque para aproximar.';
        return L.divIcon({
          className: 'cluster-wrap',
          html: '<div class="cluster cluster-pontos' + (critico ? ' cluster-critico' : '') + (vitima ? ' cluster-vitima' : '') + '" style="background:conic-gradient(' + anel + ')" title="' + C.esc(dica) + '">' +
            '<b>' + filhos.length + '</b>' + (critico ? '<i class="cl-alerta" aria-hidden="true">!</i>' : '') +
            // vítima dentro do grupo: marca "+" verde (com a quantidade) e etiqueta fixa ao lado, em qualquer zoom
            (vitima ? '<i class="cl-vitima" aria-hidden="true">+' + (vitima > 1 ? vitima : '') + '</i><span class="cl-vitima-rotulo">' + (vitima > 1 ? vitima + ' VÍTIMAS' : 'VÍTIMA') + '</span>' : '') + '</div>',
          iconSize: [38, 38],
          iconAnchor: [19, 19],
        });
      },
    });
  }

  // O que o resumo de longe (js/mapa-resumo.js) agrupa junto: as pessoas no mapa e tudo que está nos grupos de pontos
  // (relatos, fotos, pontos de interesse, indicações, importados e a vítima encontrada). Lê o estado de agora.
  function coletarParaResumo() {
    var itens = [];
    if (est.prefsMapa.pessoas) {
      est.participantes.forEach(function (p) {
        var mk = p.marcador;
        if (!mk) return;
        var ll = mk.getLatLng();
        var cls = classesMarcador(p);
        itens.push({
          id: 'p' + p.id, familia: 'pessoa', lat: ll.lat, lng: ll.lng,
          cor: mk.options.corAgrupado, nome: p.dados.nome,
          ajuda: /(^| )ajuda( |$)/.test(cls), saida: /(^| )saida( |$)/.test(cls),
          chave: cls + '|' + p.dados.nome + '|' + textoRotulo(p),
          icon: function () { return criarIcone(p); },   // só monta o ícone de quem for desenhado isolado
          marcador: mk, titulo: mk.options.title, alt: mk.options.alt, zIndexOffset: mk.options.zIndexOffset,
        });
      });
    }
    [est.camadaPontos, est.camadaPontosFixos].forEach(function (g) {
      if (!g || !g.getLayers) return;
      g.getLayers().forEach(function (mk) {
        if (!mk.getLatLng) return;
        var ll = mk.getLatLng();
        itens.push({
          id: 'k' + L.stamp(mk), familia: 'ponto', lat: ll.lat, lng: ll.lng,
          tipo: mk.options.tipoPonto || 'poi', critico: Boolean(mk.options.critico), vitima: Boolean(mk.options.vitima),
          chave: String(L.stamp(mk.options.icon)),
          icon: mk.options.icon, marcador: mk, titulo: mk.options.title, alt: mk.options.alt, zIndexOffset: mk.options.zIndexOffset,
        });
      });
    });
    return itens;
  }

  // Cada marcador de ponto vai para o agrupamento, exceto os "fixos" (vítima encontrada),
  // que ficam sempre soltos e por cima.
  function camadaDoPonto(mk) { return mk.options.fixo ? est.camadaPontosFixos : est.camadaPontos; }

  // Marcadores de outros módulos (binômio, drone e água, camadas importadas) entram no mesmo agrupamento e
  // diminuem com o zoom como os demais. Cada módulo guarda a própria lista e a tira antes de redesenhar.
  // tipo: 'verif' (indicações a verificar) ou 'import' (pontos importados).
  function agruparMarcadores(lista, tipo) {
    if (!est.camadaPontos || !lista || !lista.length) return;
    lista.forEach(function (mk) { mk.options.tipoPonto = tipo; mk.options.pane = 'pontos'; });
    if (est.camadaPontos.addLayers) est.camadaPontos.addLayers(lista); else lista.forEach(function (mk) { est.camadaPontos.addLayer(mk); });
  }
  function desagruparMarcadores(lista) {
    if (!est.camadaPontos || !lista || !lista.length) return;
    if (est.camadaPontos.removeLayers) est.camadaPontos.removeLayers(lista); else lista.forEach(function (mk) { est.camadaPontos.removeLayer(mk); });
  }
  function mostrarPonto(mk, visivel) {
    var c = mk && camadaDoPonto(mk);
    if (!c) return;
    if (visivel) { if (!c.hasLayer(mk)) c.addLayer(mk); }
    else if (c.hasLayer(mk)) c.removeLayer(mk);
  }

  // Legenda editável: cada linha tem uma chave; o usuário pode trocar o texto ou ocultar a linha.
  // Fica guardado neste aparelho (vale para todas as operações). Os nomes dos grupos vêm do cadastro.
  var CHAVE_LEGENDA = 'gbs-legenda';
  var ITENS_LEGENDA = [
    { chave: 'militar', secao: 'part', icone: '<span class="simbolo simbolo-militar"><span>M</span></span>', padrao: 'Militar' },
    { chave: 'civil', secao: 'part', icone: '<span class="simbolo simbolo-civil"><span>C</span></span>', padrao: 'Civil' },
    { chave: 'responsavel', secao: 'part', icone: '<span class="simbolo simbolo-responsavel"><span>R</span></span>', padrao: 'Responsável da operação' },
    { chave: 'resp_grupo', secao: 'part', icone: '<span class="lg-resp-grupo"><span class="simbolo simbolo-militar em-grupo" style="--cor-grupo:' + GRUPO_CORES[0] + ';background:' + GRUPO_CORES[0] + '"><span>M</span></span></span>', padrao: 'Responsável do grupo' },
    { chave: 'antigo', secao: 'part', icone: '<span class="antigo"><span class="simbolo simbolo-civil" style="background:#6b7280"><span>·</span></span></span>', padrao: 'Última posição antiga' },
    { chave: 'foto', secao: 'mapa', icone: '<span class="mk-foto mk-foto-legenda"><span class="ico-camera"></span></span>', padrao: 'Foto' },
    { chave: 'relato', secao: 'mapa', icone: '<span class="mk-relato mk-relato-legenda"><span>P</span></span>', padrao: 'Relato' },
    { chave: 'poi', secao: 'mapa', icone: '<span class="mk-poi mk-poi-legenda poi-ENCONTRO"><span>E</span></span>', padrao: 'Ponto de interesse' },
    { chave: 'base', secao: 'mapa', icone: '<span class="mk-poi mk-poi-legenda poi-BASE"><span>B</span></span>', padrao: 'Base' },
    { chave: 'cluster_pontos', secao: 'mapa', icone: '<span class="cluster cluster-pontos cluster-legenda" style="background:conic-gradient(#38bdf8 0 120deg, #f97316 0 240deg, #a855f7 0)"><b>3</b></span>', padrao: 'Pontos, relatos e fotos agrupados' },
    { chave: 'cluster_pessoas', secao: 'mapa', icone: '<span class="cluster-pessoas cluster-legenda" style="background:conic-gradient(#ef4444 0 180deg, #3b82f6 0)"><b>2</b></span>', padrao: 'Pessoas agrupadas' },
    { chave: 'local', secao: 'mapa', icone: '<span class="mk-local mk-local-legenda" aria-hidden="true">◎</span>', padrao: 'Local da operação' },
    { chave: 'setor', secao: 'mapa', icone: '<span class="setor-legenda"></span>', padrao: 'Setor de busca' },
    { chave: 'trilha_gps', secao: 'mapa', icone: '<span class="lg-trilha-gps"></span>', padrao: 'Trilha de GPS (registrada pelo aparelho)' },
    { chave: 'trilha_planejada', secao: 'mapa', icone: '<span class="lg-trilha-desenhada lg-planejada"></span>', padrao: 'Trilha desenhada · planejada' },
    { chave: 'trilha_percorrida', secao: 'mapa', icone: '<span class="lg-trilha-desenhada lg-percorrida"></span>', padrao: 'Trilha desenhada · percorrida' },
    { chave: 'rota', secao: 'mapa', icone: '<span class="lg-linha-rota"></span>', padrao: 'Rota até o destino' },
    { chave: 'falha', secao: 'mapa', icone: '<span class="lg-lacuna"></span>', padrao: 'Falha' },
  ];
  function prefsLegenda() {
    var v = C.local.ler(CHAVE_LEGENDA, null) || {};
    return { rotulos: v.rotulos || {}, ocultos: v.ocultos || {} };
  }

  function linhaLegenda(item, pref) {
    var texto = pref.rotulos[item.chave] || item.padrao;
    return '<div class="legenda-linha" data-legenda="' + item.chave + '">' + item.icone + '<span><b>' + C.esc(texto) + '</b></span></div>';
  }

  function renderizarLegenda() {
    var corpo = est.legendaCorpo;
    if (!corpo || !est.participantes || !est.membros) return;
    var pref = prefsLegenda();
    var presentes = { militar: false, civil: false, responsavel: false, resp_grupo: false, antigo: false };
    est.participantes.forEach(function (p) { if (!p.dados.removido) presentes[tipoDe(p.dados)] = true; });
    est.membros.forEach(function (mapa) { mapa.forEach(function (m) { if (m.papel === 'responsavel') presentes.resp_grupo = true; }); });
    presentes.antigo = Array.from(est.participantes.values()).some(function (p) { return !p.dados.removido && posicaoAntiga(p); });
    function linhas(secao) {
      return ITENS_LEGENDA.filter(function (it) {
        return it.secao === secao && !pref.ocultos[it.chave] && (secao !== 'part' || presentes[it.chave]);
      }).map(function (it) { return linhaLegenda(it, pref); }).join('');
    }
    var grupos = Array.from(est.grupos.values()).sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
    var listaGrupos = grupos.length
      ? '<ul class="legenda-grupos">' + grupos.map(function (g) {
        var n = est.membros.has(g.id) ? est.membros.get(g.id).size : 0;
        return '<li>' + htmlChipGrupo(g, 'legenda-cor') + '<span class="legenda-grupo-nome">' + C.esc(g.nome) + '</span><small class="muted">' + n + ' integrante' + (n === 1 ? '' : 's') + '</small></li>';
      }).join('') + '</ul>'
      : '<p class="muted legenda-vazio">Nenhum grupo cadastrado nesta operação.</p>';
    var noMapa = linhas('mapa');
    corpo.innerHTML =
      '<h4 class="legenda-titulo">Participantes</h4>' +
      (linhas('part') || '<p class="muted legenda-vazio">Nenhum participante ainda.</p>') +
      '<h4 class="legenda-titulo">Grupos ativos</h4>' + listaGrupos +
      (noMapa ? '<h4 class="legenda-titulo">No mapa</h4>' + noMapa : '') +
      '<button type="button" class="btn btn-pequeno legenda-editar" id="legenda-editar">✎ Editar legenda</button>';
    corpo.querySelector('#legenda-editar').addEventListener('click', abrirEditarLegenda);
  }

  function abrirEditarLegenda() {
    var pref = prefsLegenda();
    var campos = {};
    var secoes = [['part', 'Participantes (só aparecem os tipos que estão na operação)'], ['mapa', 'No mapa']];
    var corpo = secoes.map(function (sec) {
      return UI.el('fieldset', { classe: 'legenda-edicao' }, [UI.el('legend', { texto: sec[1] })].concat(ITENS_LEGENDA.filter(function (it) { return it.secao === sec[0]; }).map(function (it) {
        var txt = UI.el('input', { classe: 'campo campo-pequeno', maxlength: '60', value: pref.rotulos[it.chave] || '', placeholder: it.padrao, 'aria-label': 'Texto para "' + it.padrao + '"' });
        var ver = UI.el('input', { type: 'checkbox', checked: pref.ocultos[it.chave] ? null : true, 'aria-label': 'Mostrar "' + it.padrao + '" na legenda' });
        campos[it.chave] = { txt: txt, ver: ver };
        var ico = UI.el('span', { classe: 'legenda-edicao-ico', 'aria-hidden': 'true' });
        ico.innerHTML = it.icone;
        return UI.el('div', { classe: 'legenda-edicao-linha', 'data-legenda': it.chave }, [ver, ico, txt]);
      })));
    });
    var fechar = UI.abrirModal(UI.el('form', { classe: 'form-legenda', novalidate: true, onsubmit: function (ev) {
      ev.preventDefault();
      var novo = { rotulos: {}, ocultos: {} };
      Object.keys(campos).forEach(function (k) {
        var t = campos[k].txt.value.replace(/\s+/g, ' ').trim();
        if (t) novo.rotulos[k] = t;
        if (!campos[k].ver.checked) novo.ocultos[k] = true;
      });
      C.local.gravar(CHAVE_LEGENDA, novo);
      fechar();
      renderizarLegenda();
      UI.aviso('Legenda atualizada (neste aparelho).', 'ok');
    } }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Legenda do mapa' }, [UI.dica('Muda só o texto da legenda, não o mapa. Fica neste aparelho. Os nomes dos grupos mudam em Ferramentas → Grupos.')]),
    ].concat(corpo).concat([
      UI.rodape([
        UI.el('button', { classe: 'btn', type: 'button', id: 'legenda-padrao', texto: 'Padrão', onclick: function () {
          Object.keys(campos).forEach(function (k) { campos[k].txt.value = ''; campos[k].ver.checked = true; });
        } }),
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'legenda-salvar', texto: 'Salvar' }),
      ]),
    ])));
  }

  function marcadoresDe(tipo) {
    if (tipo === 'pontos') return Array.from(est.pontosInt.values()).map(function (p) { return p.marcador; }).filter(Boolean);
    return Array.from((tipo === 'fotos' ? est.fotosMarc : est.relatosMarc).values());
  }

  function trocarCamada(nome) {
    if (!est.mapa || !est.camadasBase || !est.camadasBase[nome]) return;
    if (nome !== est.camadaAtual) {
      est.mapa.removeLayer(est.camadasBase[est.camadaAtual]);
      est.camadasBase[nome].addTo(est.mapa);
      est.camadaAtual = nome;
    }
    definirPrefMapa('camada', nome);
    aplicarBase3D(nome);   // se o 3D estiver aberto, troca o fundo dele também
  }

  // Troca o fundo do relevo 3D sem fechar a visão 3D (câmera e marcadores continuam).
  function aplicarBase3D(nome) {
    var v = est.visao3d;
    if (!v || !v.mapa || !BASES_3D[nome]) return;
    var base = BASES_3D[nome];
    try {
      if (v.mapa.getLayer('base')) v.mapa.removeLayer('base');
      if (v.mapa.getSource('base')) v.mapa.removeSource('base');
      v.mapa.addSource('base', { type: 'raster', tiles: base.tiles, tileSize: 256, maxzoom: base.maxzoom, attribution: base.attribution });
      v.mapa.addLayer({ id: 'base', type: 'raster', source: 'base' }, 'sombreamento');
    } catch (e) {
      UI.aviso('Não foi possível trocar o fundo do 3D: ' + e.message, 'erro', 6000);
    }
    atualizarMenu();
  }

  function definirPrefMapa(chave, valor) {
    est.prefsMapa[chave] = valor;
    C.local.gravar(CHAVE_PREFS_MAPA, est.prefsMapa);
    if (est.mapa) {
      if ((chave === 'fotos' || chave === 'relatos' || chave === 'pontos') && est.camadaPontos) {
        var lista = marcadoresDe(chave);
        var agrupados = lista.filter(function (mk) { return !mk.options.fixo; });
        if (est.camadaPontos.addLayers) {
          if (valor) est.camadaPontos.addLayers(agrupados); else est.camadaPontos.removeLayers(agrupados);
        } else {
          agrupados.forEach(function (mk) { mostrarPonto(mk, valor); });
        }
        lista.forEach(function (mk) { if (mk.options.fixo) mostrarPonto(mk, valor); });
      }
      if (chave === 'legenda' && est.legenda) { if (valor) est.legenda.addTo(est.mapa); else est.legenda.remove(); }
      if (chave === 'setores' && est.camadaSetores) { if (valor) est.camadaSetores.addTo(est.mapa); else est.camadaSetores.remove(); }
      if (chave === 'pontos' && est.camadaPontosInt) { if (valor) est.camadaPontosInt.addTo(est.mapa); else est.camadaPontosInt.remove(); }
      if (chave === 'local') desenharLocalOp();
      if (chave === 'tmPlanejadas' || chave === 'tmPercorridas') redesenharTrilhasManuais();
      if (chave === 'nomesMapa') $('mapa').classList.toggle('esconder-rotulos', !valor);
      if (chave === 'agrupar') montarCamadaPessoas();
      if (chave === 'pessoas' && est.camadaPessoas) {
        $('mapa').classList.toggle('ocultar-pessoas', !valor);
        est.rotulos.agendar();
        if (est.circuloPrecisao) { if (valor) est.circuloPrecisao.addTo(est.mapa); else est.circuloPrecisao.remove(); }
      }
    }
    atualizarMenu();
  }

  /* ---------- Menu de ferramentas ---------------------------------- */
  function alternarMenu() {
    if ($('menu-ferramentas').hidden) abrirMenu(); else fecharMenu(true);
  }

  function abrirMenu() {
    atualizarMenu();
    $('menu-ferramentas').hidden = false;
    $('btn-ferramentas').setAttribute('aria-expanded', 'true');
    document.body.classList.add('menu-aberto');
    var primeiro = $('menu-ferramentas').querySelector('.menu-item:not([hidden]):not([disabled])');
    if (primeiro) setTimeout(function () { primeiro.focus(); }, 20);
  }

  function fecharMenu(devolverFoco) {
    var menu = $('menu-ferramentas');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    $('btn-ferramentas').setAttribute('aria-expanded', 'false');
    document.body.classList.remove('menu-aberto');
    var filtro = $('menu-filtro');
    if (filtro && filtro.value) { filtro.value = ''; filtro.dispatchEvent(new Event('input')); }
    if (devolverFoco) $('btn-ferramentas').focus();
  }

  // Ação = item que faz algo fora do menu (abre janela, inicia desenho…). Chaves
  // (aria-pressed), escolhas (role="radio") e o seletor de coordenadas não são ações.
  function ehAcaoDoMenu(item) {
    return !item.classList.contains('menu-select') && !item.hasAttribute('aria-pressed') && item.getAttribute('role') !== 'radio';
  }

  // Grupos do menu: abertos/fechados como o usuário deixou (neste aparelho).
  function iniciarGruposMenu() {
    var salvos = C.local.ler(CHAVE_GRUPOS_MENU) || {};
    document.querySelectorAll('#menu-ferramentas details.menu-grupo[data-grupo]').forEach(function (d) {
      var nome = d.getAttribute('data-grupo');
      if (typeof salvos[nome] === 'boolean') d.open = salvos[nome];
      d.addEventListener('toggle', function () {
        var atual = C.local.ler(CHAVE_GRUPOS_MENU) || {};
        atual[nome] = d.open;
        C.local.gravar(CHAVE_GRUPOS_MENU, atual);
      });
    });
  }

  // Um botão "Setor": ao tocar, escolhe como criar — desenhando a área ou por raio.
  function escolherTipoSetor() {
    if (!podeAlterar()) return;
    fecharMenu(false);
    var fechar = UI.abrirModal(UI.el('div', { classe: 'escolha-setor' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Novo setor de busca' }),
      UI.el('div', { classe: 'opcoes-setor' }, [
        UI.el('button', { classe: 'opcao-setor', type: 'button', id: 'setor-tipo-poligono', onclick: function () { fechar(true); iniciarDesenho('poligono'); } }, [
          UI.el('span', { classe: 'opcao-setor-ico', 'aria-hidden': 'true', texto: '⬠' }),
          UI.el('strong', { texto: 'Desenhar a área' }), UI.el('small', { texto: 'toque nos cantos do setor no mapa' })]),
        UI.el('button', { classe: 'opcao-setor', type: 'button', id: 'setor-tipo-raio', onclick: function () { fechar(true); iniciarDesenho('raio'); } }, [
          UI.el('span', { classe: 'opcao-setor-ico', 'aria-hidden': 'true', texto: '◯' }),
          UI.el('strong', { texto: 'Por raio' }), UI.el('small', { texto: 'toque no centro e informe o raio em metros' })]),
      ]),
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } })]),
    ]));
  }

  /* ---------- Painel "Camadas" sobre o mapa -------------------------- */
  function camadasCompacto() {
    return Boolean(window.matchMedia && window.matchMedia('(max-width: 860px), (pointer: coarse)').matches);
  }

  function abrirCamadas() {
    atualizarMenu();
    if (camadasCompacto()) fecharMenu(false);
    $('camadas-painel').hidden = false;
    $('btn-camadas').setAttribute('aria-expanded', 'true');
    var marcado = $('camadas-painel').querySelector('[data-camada][aria-checked="true"]');
    if (marcado) setTimeout(function () { marcado.focus(); }, 20);
  }

  function fecharCamadas(devolverFoco) {
    var p = $('camadas-painel');
    if (!p || p.hidden) return;
    p.hidden = true;
    $('btn-camadas').setAttribute('aria-expanded', 'false');
    if (devolverFoco) $('btn-camadas').focus();
  }

  // 2D/3D: o botão do 3D só fica ativo se o aparelho tem gráficos 3D (WebGL).
  function iniciarModo3D() {
    var nota = $('nota-3d');
    if (suportaWebGL()) {
      nota.className = 'camadas-nota';
      nota.textContent = 'O relevo 3D abre em tela cheia e precisa de internet.';
    } else {
      $('menu-3d').disabled = true;
      $('menu-3d').title = 'Indisponível neste aparelho (sem WebGL)';
      nota.className = 'camadas-nota aviso-3d';
      nota.textContent = 'Relevo 3D indisponível: este aparelho ou navegador não tem gráficos 3D (WebGL). Para ver o relevo, use o tipo de mapa Topográfico.';
    }
    nota.hidden = false;
    atualizarModoVisao();
  }

  function atualizarModoVisao() {
    var em3d = !$('visao-3d').hidden;
    $('modo-2d').setAttribute('aria-pressed', String(!em3d));
    $('menu-3d').setAttribute('aria-pressed', String(em3d));
  }

  // Tema do painel: "escuro" (padrão) ou "claro". Fica salvo neste aparelho.
  var CHAVE_TEMA = 'gbs-painel-tema';
  function definirTema(tema) {
    var valor = tema === 'claro' ? 'claro' : 'escuro';
    document.documentElement.setAttribute('data-tema', valor);
    try { localStorage.setItem(CHAVE_TEMA, valor); } catch (e) { /* sem armazenamento: vale só nesta página */ }
    atualizarBotoesTema();
    if (est.mapa) setTimeout(function () { est.mapa.invalidateSize({ pan: false }); }, 60);
  }

  function atualizarBotoesTema() {
    var atual = document.documentElement.getAttribute('data-tema') || 'escuro';
    document.querySelectorAll('.menu-tema [data-tema]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-tema') === atual));
    });
  }

  /* ---------- Modos rápidos do mapa ("mostrar só …") ----------------- */
  // Cada modo liga exatamente estas camadas e desliga as outras; mexer numa camada
  // depois vira "personalizado". O rastreamento e os dados não mudam, só o que aparece.
  var CAMADAS_MODO = ['pessoas', 'trilhas', 'desenhadas', 'setores', 'pontos', 'relatos', 'fotos', 'local'];
  var MODOS_MAPA = {
    tudo: { rotulo: 'Tudo', liga: CAMADAS_MODO },
    equipes: { rotulo: 'Equipes', liga: ['pessoas', 'trilhas'] },
    cobertura: { rotulo: 'Cobertura', liga: ['trilhas', 'desenhadas', 'setores'] },
    setores: { rotulo: 'Setores', liga: ['setores'] },
    pontos: { rotulo: 'Pontos', liga: ['pontos', 'local'] },
    fotos: { rotulo: 'Fotos', liga: ['fotos'] },
    relatos: { rotulo: 'Relatos', liga: ['relatos'] },
  };
  function camadaLigada(k) {
    if (k === 'trilhas') return todasTrilhasVisiveis();
    if (k === 'desenhadas') return est.prefsMapa.tmPlanejadas !== false && est.prefsMapa.tmPercorridas !== false;
    return Boolean(est.prefsMapa[k]);
  }
  function modoMapaAtual() {
    var achado = null;
    Object.keys(MODOS_MAPA).some(function (m) {
      var liga = MODOS_MAPA[m].liga;
      var igual = CAMADAS_MODO.every(function (k) { return camadaLigada(k) === (liga.indexOf(k) >= 0); });
      if (igual) achado = m;
      return igual;
    });
    return achado;
  }
  function aplicarModoMapa(m) {
    var modo = MODOS_MAPA[m];
    if (!modo) return;
    CAMADAS_MODO.forEach(function (k) {
      var quer = modo.liga.indexOf(k) >= 0;
      if (camadaLigada(k) === quer) return;
      if (k === 'trilhas') definirTodasTrilhas(quer, true);
      else if (k === 'desenhadas') { definirPrefMapa('tmPlanejadas', quer); definirPrefMapa('tmPercorridas', quer); }
      else definirPrefMapa(k, quer);
    });
    atualizarMenu();
  }

  function todasTrilhasVisiveis() {
    var todas = true;
    est.participantes.forEach(function (p) { if (!p.trilhaVisivel) todas = false; });
    return todas;
  }

  // Mantém os estados (marcado/desmarcado) dos itens do menu iguais ao que está no mapa.
  function atualizarMenu() {
    document.querySelectorAll('[data-camada]').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-camada') === est.camadaAtual));
    });
    $('opt-fotos').setAttribute('aria-pressed', String(Boolean(est.prefsMapa.fotos)));
    $('opt-relatos').setAttribute('aria-pressed', String(Boolean(est.prefsMapa.relatos)));
    $('opt-setores').setAttribute('aria-pressed', String(Boolean(est.prefsMapa.setores)));
    $('opt-pontos').setAttribute('aria-pressed', String(Boolean(est.prefsMapa.pontos)));
    $('opt-desenhadas-planejadas').setAttribute('aria-pressed', String(est.prefsMapa.tmPlanejadas !== false));
    $('opt-desenhadas-percorridas').setAttribute('aria-pressed', String(est.prefsMapa.tmPercorridas !== false));
    $('opt-nomes').setAttribute('aria-pressed', String(Boolean(est.prefsMapa.nomesMapa)));
    $('opt-pessoas').setAttribute('aria-pressed', String(Boolean(est.prefsMapa.pessoas)));
    $('opt-coord').value = est.prefsMapa.coord || 'dec';
    var trilhasVisiveis = todasTrilhasVisiveis();
    $('opt-trilhas').setAttribute('aria-pressed', String(trilhasVisiveis));
    $('opt-local').setAttribute('aria-pressed', String(Boolean(est.prefsMapa.local)));
    $('menu-grupos-qtd').textContent = est.grupos.size ? String(est.grupos.size) : '';
    var ativas = missoesAtivas().length;
    $('menu-missoes-qtd').textContent = ativas ? ativas + ' ativo(s)' : '';
    // resumo no botão "Camadas": mapa de fundo e quantas camadas estão ocultas
    var nomesBase = { osm: 'Mapa', topo: 'Topográfico', satelite: 'Satélite' };
    var modo = modoMapaAtual();
    document.querySelectorAll('[data-modo-mapa]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-modo-mapa') === modo));
    });
    var filtrado = modo !== 'tudo';
    $('btn-camadas').classList.toggle('camadas-filtrado', filtrado);
    $('camadas-resumo').textContent = (nomesBase[est.camadaAtual] || '') +
      (!filtrado ? '' : modo ? ' · só ' + MODOS_MAPA[modo].rotulo.toLowerCase() : ' · personalizado');
    $('btn-camadas').setAttribute('aria-label', 'Camadas do mapa: ' + $('camadas-resumo').textContent);
  }

  /* ---------- Lista lateral: ocultar e reabrir ----------------------- */
  function definirLateral(visivel) {
    est.lateralOculta = !visivel;
    C.local.gravar(CHAVE_LATERAL, est.lateralOculta);
    aplicarLateral(true);
    if (visivel) {
      var b = $('btn-ocultar-lateral');
      if (b) setTimeout(function () { b.focus(); }, 30);
    } else {
      setTimeout(function () { $('btn-mostrar-lateral').focus(); }, 30);
    }
  }

  // Ocultar a lista muda só a interface: dados, rastreamento e tempo real seguem iguais.
  function aplicarLateral(animar) {
    var oculta = est.lateralOculta && !gaveta.ativa;
    document.body.classList.toggle('lateral-oculta', oculta);
    $('lateral').setAttribute('aria-hidden', String(oculta));
    if (oculta) $('lateral').setAttribute('inert', ''); else $('lateral').removeAttribute('inert');
    $('btn-mostrar-lateral').hidden = !oculta;
    atualizarBotaoReabrir();
    atualizarMenu();
    if (!est.mapa) return;
    // Acompanha a transição para o mapa ocupar o espaço sem "pular".
    var mapa = est.mapa;
    var fim = Date.now() + (animar ? 400 : 0);
    (function passo() {
      if (est.mapa !== mapa) return;
      mapa.invalidateSize({ pan: false });
      if (Date.now() < fim) requestAnimationFrame(passo);
    })();
  }

  function atualizarBotaoReabrir() {
    var b = $('btn-mostrar-lateral');
    if (!b || b.hidden) return;
    var n = 0, alerta = false;
    est.participantes.forEach(function (p) {
      if (!p.dados.removido) n++;
      if (temAjuda(p) || saidaPendente(p) || naoLidasDe(p.id).length) alerta = true;
    });
    $('reabrir-qtd').textContent = String(n);
    $('reabrir-alerta').hidden = !alerta;
    b.title = 'Mostrar a lista de participantes' + (alerta ? ' (há alertas)' : '');
  }

  function enquadrarTodos() {
    var pts = [];
    est.participantes.forEach(function (p) {
      var pos = posicaoAtual(p);
      if (pos && visivelNoFiltro(p)) pts.push([pos.lat, pos.lng]);
    });
    if (!pts.length && est.op && est.op.local_lat != null) pts.push([est.op.local_lat, est.op.local_lng]);
    if (!pts.length) {
      UI.aviso(filtroAtivo() ? 'Nenhum membro dos grupos mostrados tem posição ainda.' : 'Nenhum participante com posição ainda.');
      return;
    }
    if (pts.length === 1) est.mapa.setView(pts[0], Math.max(est.mapa.getZoom(), 16));
    else est.mapa.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 17 });
  }

  function centralizar(id) {
    var p = est.participantes.get(id);
    var pos = p && posicaoAtual(p);
    if (!pos) {
      UI.aviso('Este participante ainda não enviou posição.');
      return;
    }
    est.mapa.setView([pos.lat, pos.lng], Math.max(est.mapa.getZoom(), 17));
  }

  /* ------------------------------------------------------------------ */
  /* Carga de dados e sincronização                                       */
  /* ------------------------------------------------------------------ */
  async function carregarTudo() {
    var opId = est.op.id;
    try {
      var parts = await C.consultarTudo(function () {
        return C.cliente.from('participantes').select('*').eq('operacao_id', opId).order('criado_em', { ascending: true });
      });
      if (!est.op || est.op.id !== opId) return;
      parts.forEach(upsertParticipante);

      var pontos = await C.consultarTudo(function () {
        return C.cliente.from('posicoes').select('id,participante_id,lat,lng,precisao,registrado_em,recebido_em')
          .eq('operacao_id', opId).order('id', { ascending: true });
      });
      if (!est.op || est.op.id !== opId) return;
      pontos.forEach(adicionarPonto);

      var msgs = await C.consultarTudo(function () {
        return C.cliente.from('mensagens').select('*').eq('operacao_id', opId).order('criada_em', { ascending: true });
      });
      if (!est.op || est.op.id !== opId) return;
      msgs.forEach(function (m) { receberMensagem(m, true); });

      await carregarFotos(true);
      if (!est.op || est.op.id !== opId) return;
      await carregarAreas();
      if (!est.op || est.op.id !== opId) return;
      await carregarGrupos();
      if (!est.op || est.op.id !== opId) return;
      await carregarVitimasLoc();
      if (!est.op || est.op.id !== opId) return;
      await carregarPermanencias();
      if (!est.op || est.op.id !== opId) return;
      await carregarMissoes(true);
      if (!est.op || est.op.id !== opId) return;

      est.ultimoSyncOk = Date.now();
      est.syncFalhou = false;
    } catch (e) {
      est.syncFalhou = true;
      UI.aviso('Falha ao carregar dados: ' + e.message, 'erro');
    }
    renderizarLista();
    renderizarCentral();
    atualizarContadorMsgs();
    atualizarPilula();
    if (!est.jaEnquadrou && temAlgumaPosicao()) {
      est.jaEnquadrou = true;
      enquadrarTodos();
    }
  }

  // Conferência periódica: recupera eventos perdidos (queda do tempo real,
  // celular do responsável sem internet etc.). Busca só posições novas (id > último).
  async function sincronizar() {
    if (!est.op || est.sincronizando) return;
    est.sincronizando = true;
    var opId = est.op.id;
    try {
      var op = await C.consultar(C.cliente.from('operacoes').select('*').eq('id', opId).maybeSingle());
      if (!est.op || est.op.id !== opId) return;
      if (!op) {
        UI.aviso('Esta operação foi excluída ou você não tem mais acesso a ela.', 'erro', 8000);
        location.hash = '';
        return;
      }
      if (op) {
        var mudou = op.status !== est.op.status || op.dados_apagados_em !== est.op.dados_apagados_em;
        var mudouCadastro = op.atualizado_em !== est.op.atualizado_em;
        var mudouLacuna = op.gps_lacuna_s !== est.op.gps_lacuna_s;
        est.op = op;
        if (mudou || mudouCadastro) renderizarCabecalho();
        if (mudou && op.dados_apagados_em) limparDadosDoMapa();
        if (mudouCadastro) { desenharLocalOp(); aplicarIntervaloGpsMeu(); }
        if (mudouLacuna) est.participantes.forEach(function (p) { sujarTrilha(p); });
      }
      var parts = await C.consultarTudo(function () {
        return C.cliente.from('participantes').select('*').eq('operacao_id', opId).order('criado_em', { ascending: true });
      });
      if (!est.op || est.op.id !== opId) return;
      parts.forEach(upsertParticipante);

      var novos = await C.consultarTudo(function () {
        return C.cliente.from('posicoes').select('id,participante_id,lat,lng,precisao,registrado_em,recebido_em')
          .eq('operacao_id', opId).gt('id', est.maxPosId).order('id', { ascending: true });
      });
      if (!est.op || est.op.id !== opId) return;
      novos.forEach(adicionarPonto);

      var msgs = await C.consultar(
        C.cliente.from('mensagens').select('*').eq('operacao_id', opId).order('criada_em', { ascending: false }).limit(500)
      );
      if (!est.op || est.op.id !== opId) return;
      msgs.forEach(function (m) { receberMensagem(m, false); });

      await carregarFotos(false);
      if (!est.op || est.op.id !== opId) return;
      await carregarAreas();
      if (!est.op || est.op.id !== opId) return;
      await carregarGrupos();
      if (!est.op || est.op.id !== opId) return;
      await carregarVitimasLoc();
      if (!est.op || est.op.id !== opId) return;
      await carregarPermanencias();
      if (!est.op || est.op.id !== opId) return;
      await carregarMissoes(false);
      if (!est.op || est.op.id !== opId) return;

      est.ultimoSyncOk = Date.now();
      est.syncFalhou = false;
    } catch (e) {
      est.syncFalhou = true;
    } finally {
      est.sincronizando = false;
      atualizarPilula();
    }
  }

  // Ciclo independente do tempo real: verifica a cada 2 s se já passou o
  // intervalo (20 s com tempo real ativo, 8 s sem ele) e então sincroniza.
  function iniciarPolling() {
    clearInterval(est.timerPoll);
    est.ultimaTentativaSync = Date.now();
    est.timerPoll = setInterval(function () {
      if (!est.op || est.sincronizando) return;
      var ms = est.tempoReal === 'ok' && !est.syncFalhou ? LIM.pollingOkMs : LIM.pollingFalhaMs;
      if (Date.now() - est.ultimaTentativaSync >= ms) {
        est.ultimaTentativaSync = Date.now();
        sincronizar();
      }
    }, 2000);
  }

  function assinarTempoReal() {
    if (!est.op) return;
    var opId = est.op.id;
    var geracao = ++est.geracaoCanal;
    if (est.canal) {
      try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ }
    }
    est.tempoReal = 'conectando';
    var filtro = 'operacao_id=eq.' + opId;
    est.canal = C.cliente.channel('op-' + opId + '-' + geracao)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'participantes', filter: filtro }, function (ev) {
        if (ev.eventType === 'DELETE') return;
        if (ev.new && ev.new.id) { upsertParticipante(ev.new); renderizarLista(); }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posicoes', filter: filtro }, function (ev) {
        if (ev.new && ev.new.id) adicionarPonto(ev.new);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mensagens', filter: filtro }, function (ev) {
        if (ev.new && ev.new.id) receberMensagem(ev.new, false);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'fotos', filter: filtro }, function (ev) {
        if (ev.eventType === 'DELETE') { if (ev.old && ev.old.id) removerFoto(ev.old.id); return; }
        if (ev.new && ev.new.id) adicionarFoto(ev.new, false);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'setores', filter: filtro }, agendarAreas)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pontos_interesse', filter: filtro }, agendarAreas)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tipos_ponto' }, agendarAreas)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categorias_ponto_estilo' }, agendarAreas)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'destinos', filter: filtro }, agendarAreas)
      .subscribe(function (status) {
        if (geracao !== est.geracaoCanal) return;
        if (status === 'SUBSCRIBED') {
          est.tempoReal = 'ok';
          clearTimeout(est.timerReassinar);
          if (est.precisaRecarregar) {
            est.precisaRecarregar = false;
            sincronizar();
          }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          est.tempoReal = 'falha';
          est.precisaRecarregar = true;
          clearTimeout(est.timerReassinar);
          est.timerReassinar = setTimeout(function () {
            if (geracao === est.geracaoCanal && est.tempoReal !== 'ok') assinarTempoReal();
          }, 15000);
        }
        atualizarPilula();
      });
  }

  // Tabelas novas (fichas de vítimas, grupos, deslocamentos, alertas) num canal
  // próprio: se o banco ainda não tiver as migrações 007–010, o canal principal
  // (participantes, posições, mensagens…) continua funcionando. A conferência
  // periódica (sincronizar) também busca esses dados, então nada se perde.
  function assinarTempoRealExtras() {
    if (!est.op) return;
    var opId = est.op.id;
    if (est.canalExtras) {
      try { C.cliente.removeChannel(est.canalExtras); } catch (e) { /* ignora */ }
    }
    var filtro = 'operacao_id=eq.' + opId;
    try {
      est.canalExtras = C.cliente.channel('op-extras-' + opId + '-' + Date.now())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'vitimas', filter: filtro }, function () {
          if (window.Cadastro) window.Cadastro.aoMudarVitimas(opId);
          carregarFichas();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'grupos', filter: filtro }, agendarGrupos)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'grupo_membros', filter: filtro }, agendarGrupos)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'missoes', filter: filtro }, agendarMissoes)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'missao_membros', filter: filtro }, agendarMissoes)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'setor_permanencias', filter: filtro }, function (ev) {
          if (ev.new && ev.new.id) receberPermanencias([ev.new]);
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'vitima_localizacoes', filter: filtro }, function (ev) {
          if (ev.new && ev.new.id) receberVitimasLoc([ev.new]);
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alertas', filter: filtro }, function (ev) {
          if (ev.new && ev.new.id) receberAlerta(ev.new, false);
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'alertas', filter: filtro }, function (ev) {
          if (ev.new && ev.new.id) receberAlerta(ev.new, true);
        })
        .subscribe(function (status) {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            // Sem as tabelas novas ou sem conexão: a conferência periódica cobre.
            clearTimeout(est.timerExtras);
            est.timerExtras = setTimeout(function () { if (est.op && est.op.id === opId && !est.semGrupos && !est.semMissoes) assinarTempoRealExtras(); }, 60000);
          }
        });
    } catch (e) { /* conferência periódica cobre */ }
  }

  function atualizarPilula() {
    var pil = $('pilula');
    if (!pil) return;
    var cls, txt;
    if (est.op && est.op.status !== 'ativa') {
      cls = 'parado'; txt = est.op.arquivada_em ? 'Arquivada · só leitura' : 'Encerrada · só leitura';
    } else if (navigator.onLine === false || (est.syncFalhou && est.tempoReal !== 'ok')) {
      cls = 'sem_atualizacao'; txt = 'Sem conexão — reconectando';
    } else if (est.tempoReal === 'ok') {
      cls = 'conectado'; txt = 'Ao vivo';
    } else if (est.tempoReal === 'falha') {
      cls = 'instavel'; txt = 'Atualizando a cada ' + Math.round(LIM.pollingFalhaMs / 1000) + ' s';
    } else {
      cls = 'aguardando'; txt = 'Conectando…';
    }
    var html = '<span class="ponto ponto-' + cls + '"></span><span>' + C.esc(txt) + '</span>';
    if (pil.innerHTML !== html) pil.innerHTML = html;
    pil.title = cls === 'conectado' ? 'Tempo real ativo: as posições chegam na hora' : txt;
  }

  /* ------------------------------------------------------------------ */
  /* Participantes                                                        */
  /* ------------------------------------------------------------------ */
  // Nome de exibição dado pelo responsável (migração 029): vale no painel inteiro;
  // o nome que a pessoa digitou fica em nome_original (mostrado na ficha).
  function normalizarNomeParticipante(row) {
    if (!row || !('nome' in row)) return row;
    var r = Object.assign({}, row);
    r.nome_original = row.nome;
    if (row.nome_painel) r.nome = row.nome_painel;
    return r;
  }

  function upsertParticipante(row) {
    row = normalizarNomeParticipante(row);
    var p = est.participantes.get(row.id);
    if (!p) {
      p = { id: row.id, dados: row, pontos: [], trilhaVisivel: est.prefsMapa.trilhas !== false, marcador: null, trilha: null, li: null, cor: null };
      est.participantes.set(row.id, p);
      est.nomesCurtos = null;
      atribuirCores();
      // pontos que chegaram antes do cadastro do participante
      var orfaos = est.pontosOrfaos.filter(function (o) { return o.participante_id === row.id; });
      if (orfaos.length) {
        est.pontosOrfaos = est.pontosOrfaos.filter(function (o) { return o.participante_id !== row.id; });
        orfaos.forEach(function (o) { est.posIds.delete(o.id); adicionarPonto(o); });
      }
    } else {
      var antigo = p.dados;
      if (row.saida_solicitada_em && !antigo.saida_solicitada_em && !row.liberado_em) {
        UI.aviso((row.nome || 'Participante') + ' PEDIU PARA ENCERRAR o rastreamento. Abra a ficha para liberar.' + sufixoFiltro(row.id), 'erro', 15000);
        alarme();
      }
      p.dados = Object.assign({}, antigo, row);
      if (antigo.nome !== p.dados.nome || Boolean(antigo.removido) !== Boolean(p.dados.removido)) {
        if (p.li) { p.li.remove(); p.li = null; }
        renovarNomesCurtos();
      }
      // não regride a última posição se um ponto mais novo já chegou pelo fluxo de posições
      if (antigo.ultima_posicao_em && row.ultima_posicao_em &&
          C.paraMs(row.ultima_posicao_em) < C.paraMs(antigo.ultima_posicao_em)) {
        p.dados.ultima_lat = antigo.ultima_lat;
        p.dados.ultima_lng = antigo.ultima_lng;
        p.dados.ultima_precisao = antigo.ultima_precisao;
        p.dados.ultima_posicao_em = antigo.ultima_posicao_em;
      }
      if (antigo.tipo !== row.tipo) atribuirCores();
    }
    atualizarMarcador(p);
    est.listaSuja = true;
    if (est.selecionado === p.id) atualizarFicha();
    if (!est.jaEnquadrou && posicaoAtual(p)) {
      est.jaEnquadrou = true;
      setTimeout(enquadrarTodos, 100);
    }
  }

  function atribuirCores() {
    var cont = { militar: 0, civil: 0, responsavel: 0 };
    Array.from(est.participantes.values())
      .sort(function (a, b) { return C.paraMs(a.dados.criado_em) - C.paraMs(b.dados.criado_em); })
      .forEach(function (p) {
        var tipo = tipoDe(p.dados);
        var cor = PALETA[tipo][cont[tipo]++ % PALETA[tipo].length];
        if (p.cor !== cor) {
          p.cor = cor;
          if (p.trilha) p.trilha.setStyle({ color: corDoParticipante(p), dashArray: TIPOS[tipo].trilha });
          if (p.marcador) { p.marcador.setIcon(criarIcone(p)); }
          if (p.li) p.li = null; // força recriar o item da lista
        }
      });
    $('lista-part').innerHTML = '';
    $('lista-removidos').innerHTML = '';
    est.listaSuja = true;
    renderizarLegenda();
  }

  function tipoDe(d) {
    return d.tipo === 'militar' ? 'militar' : d.tipo === 'responsavel' ? 'responsavel' : 'civil';
  }

  function ehEu(p) {
    return Boolean(est.usuario && p.dados.user_id === est.usuario.id);
  }

  // Grupo que define a cor do participante no mapa. Responsáveis da operação
  // mantêm a identificação própria (vermelho, com R) e nunca recebem a cor de um grupo.
  function grupoDoParticipante(p) {
    if (!p || tipoDe(p.dados) === 'responsavel') return null;
    return gruposDe(p.id)[0] || null;
  }

  function corDoParticipante(p) {
    var g = grupoDoParticipante(p);
    return g ? g.cor : p.cor;
  }

  /* ---------- Nomes curtos no mapa ---------------------------------- */
  // No mapa o nome aparece abreviado ("João S.", "Sgt. Oliveira"); o completo aparece ao passar
  // o cursor (ou tocar) no marcador e na ficha. Dois nomes que ficariam iguais ganham o sobrenome.
  var PARTICULAS_NOME = { da: 1, de: 1, di: 1, do: 1, du: 1, das: 1, dos: 1, e: 1 };
  var POSTO_GRAD = /^(sd|cb|sgt|subten|st|asp|ten|tc|cap|maj|cel|gen|cmt|[1-3][º°o])\.?$/i;
  function abreviarNome(nome) {
    var n = String(nome || '').replace(/\s+/g, ' ').trim();
    if (n.length <= 12) return n;
    var w = n.split(' ');
    var i = 0, posto = [];
    while (i < w.length - 1 && POSTO_GRAD.test(w[i])) { posto.push(w[i]); i++; }
    var resto = w.slice(i).filter(function (x) { return !PARTICULAS_NOME[x.toLowerCase()] && /[0-9A-Za-zÀ-ÿ]/.test(x); });
    if (!resto.length) return n.slice(0, 11) + '…';
    if (posto.length) return posto.join(' ') + ' ' + resto[resto.length - 1];   // posto + nome de guerra
    if (resto.length === 1) return resto[0].length > 14 ? resto[0].slice(0, 13) + '…' : resto[0];
    return resto[0] + ' ' + resto[resto.length - 1].charAt(0).toUpperCase() + '.';
  }
  function primeiroEUltimo(nome) {
    var w = String(nome || '').trim().split(/\s+/).filter(function (x) { return !PARTICULAS_NOME[x.toLowerCase()]; });
    return w.length > 1 ? w[0] + ' ' + w[w.length - 1] : String(nome || '');
  }
  function calcularNomesCurtos() {
    var mapa = new Map(), etapas = [abreviarNome, primeiroEUltimo, function (n) { return n; }];
    var lista = Array.from(est.participantes.values()).filter(function (p) { return !p.dados.removido; });
    var pendentes = lista;
    etapas.forEach(function (f) {
      if (!pendentes.length) return;
      var cont = {};
      pendentes.forEach(function (p) { var k = f(p.dados.nome).toLowerCase(); cont[k] = (cont[k] || 0) + 1; });
      // também conta quem já foi resolvido (não repetir um nome curto já usado)
      mapa.forEach(function (v) { var k = v.toLowerCase(); cont[k] = (cont[k] || 0) + 1; });
      var prox = [];
      pendentes.forEach(function (p) {
        var c = f(p.dados.nome);
        if (cont[c.toLowerCase()] === 1 || f === etapas[2]) mapa.set(p.id, c); else prox.push(p);
      });
      pendentes = prox;
    });
    return mapa;
  }
  function nomeCurto(p) {
    if (!est.nomesCurtos) est.nomesCurtos = calcularNomesCurtos();
    var c = est.nomesCurtos.get(p.id) || abreviarNome(p.dados.nome);
    return ehEu(p) ? c + ' (você)' : c;
  }
  function htmlNomeMapa(p) {
    var curto = nomeCurto(p), todo = nomeExibido(p);
    return curto === todo ? '<span class="mk-nc">' + C.esc(todo) + '</span>'
      : '<span class="mk-nc">' + C.esc(curto) + '</span><span class="mk-nl">' + C.esc(todo) + '</span>';
  }
  // Algum nome mudou ou alguém entrou/saiu: refaz os nomes curtos de todos (um pode ter ganho sobrenome).
  function renovarNomesCurtos() {
    est.nomesCurtos = null;
    est.participantes.forEach(function (p) {
      var el = p.marcador && p.marcador.getElement();
      var n = el && el.querySelector('.mk-nome');
      if (n) n.innerHTML = htmlNomeMapa(p);
      if (p.marcador && p.marcador.getElement()) p.marcador.getElement().title = nomeExibido(p) + ' (' + TIPOS[tipoDe(p.dados)].rotulo + ')';
    });
    est.rotulos.agendar();
  }

  // O responsável muda o nome mostrado no painel (o nome que a pessoa digitou fica guardado).
  function renomearParticipante(p) {
    var d = p.dados;
    var original = d.nome_original || d.nome;
    var campo = UI.el('input', { classe: 'campo', id: 'renomear-nome', maxlength: '40', value: d.nome, autofocus: true });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', texto: 'Salvar nome' });
    var form = UI.el('form', { novalidate: true, classe: 'form-padrao' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Renomear participante' }),
      UI.campo('Nome no painel', campo, { para: 'renomear-nome', dica: 'O novo nome aparece para os responsáveis, no mapa e nas listas. A pessoa continua vendo o nome que digitou: ' + original + '.' }),
      erro,
      UI.rodape([
        d.nome_painel ? UI.el('button', { classe: 'btn', type: 'button', texto: 'Nome original', onclick: function () { salvar(''); } }) : null,
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }),
        btn,
      ]),
    ]);
    async function salvar(nome) {
      erro.hidden = true;
      if (nome && (nome.length < 2 || nome.length > 40)) { erro.textContent = 'Use de 2 a 40 caracteres.'; erro.hidden = false; return; }
      btn.disabled = true;
      try {
        var r = await C.rpc('renomear_participante', { p_participante: p.id, p_nome: nome });
        fechar();
        upsertParticipante(Object.assign({}, p.dados, { nome: r.nome, nome_painel: r.nome_painel }));
        renderizarLista();
        UI.aviso(r.nome_painel ? 'Nome alterado para "' + r.nome_painel + '".' : 'Voltou ao nome original.', 'ok');
      } catch (e) {
        btn.disabled = false;
        erro.textContent = e.codigo === 'funcao_ausente' ? 'O banco ainda não tem a migração 029 (renomear participantes).' : e.message;
        erro.hidden = false;
      }
    }
    form.addEventListener('submit', function (ev) { ev.preventDefault(); salvar(campo.value.replace(/\s+/g, ' ').trim()); });
    var fechar = UI.abrirModal(form);
  }

  function nomeExibido(p) {
    return ehEu(p) ? p.dados.nome + ' (você)' : p.dados.nome;
  }

  function htmlSimbolo(p) {
    var t = tipoDe(p.dados);
    var g = grupoDoParticipante(p);
    var cor = g ? g.cor : p.cor;
    return '<div class="simbolo simbolo-' + t + (ehEu(p) ? ' simbolo-eu' : '') + (g ? ' em-grupo' : '') +
      '" style="--cor-grupo:' + cor + ';background:' + cor + '"><span>' + TIPOS[t].letra + '</span></div>';
  }

  function htmlSeloTipo(d) {
    var t = TIPOS[tipoDe(d)];
    return '<span class="selo ' + t.selo + '">' + t.rotulo + '</span>';
  }

  function saidaPendente(p) {
    var d = p.dados;
    return Boolean(d.saida_solicitada_em && !d.liberado_em && !d.removido);
  }

  function formatarCpf(d, visivel) {
    if (!d) return '—';
    d = String(d);
    if (!visivel) return '***.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-**';
    return d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-' + d.slice(9);
  }

  function formatarTelefone(d) {
    if (!d) return '—';
    d = String(d);
    return '(' + d.slice(0, 2) + ') ' + (d.length === 11 ? d.slice(2, 7) + '-' + d.slice(7) : d.slice(2, 6) + '-' + d.slice(6));
  }

  function posicaoAtual(p) {
    var d = p.dados;
    if (d.ultima_lat == null || d.ultima_lng == null) return null;
    return { lat: d.ultima_lat, lng: d.ultima_lng, prec: d.ultima_precisao, t: C.paraMs(d.ultima_posicao_em) };
  }

  function temAlgumaPosicao() {
    var tem = false;
    est.participantes.forEach(function (p) { if (posicaoAtual(p)) tem = true; });
    return tem;
  }

  // Pedido de ajuda ainda não atendido: resposta "PRECISO DE AJUDA" a um CONFIRME
  // ou o botão "Preciso de ajuda" da página do participante.
  function temAjuda(p) {
    // Com o fluxo de pedidos (migração 035) só o estado "resolvido" tira o aviso: ler ou dar ciente não resolve.
    if (window.AjudaPedidos && window.AjudaPedidos.disponivel()) {
      var ped = window.AjudaPedidos.abertoDoParticipante(p.id);
      return ped ? { id: ped.id, pedido: ped, direcao: 'pedido', criada_em: ped.recebido_em, lat: ped.lat, lng: ped.lng } : null;
    }
    var ultima = null, sos = null;
    est.mensagens.forEach(function (m) {
      if (m.participante_id !== p.id) return;
      if (m.direcao === 'entrada') {
        if (m.categoria === 'AJUDA' && (!sos || C.paraMs(m.criada_em) > C.paraMs(sos.criada_em))) sos = m;
      } else if (m.resposta && m.confirmada_em) {
        if (!ultima || C.paraMs(m.confirmada_em) > C.paraMs(ultima.confirmada_em)) ultima = m;
      }
    });
    var resp = ultima && ultima.resposta === 'PRECISO_AJUDA' && !est.ajudaVista.has(ultima.id) ? ultima : null;
    if (sos && est.ajudaVista.has(sos.id)) sos = null;
    if (resp && sos) return C.paraMs(sos.criada_em) > C.paraMs(resp.confirmada_em) ? sos : resp;
    return resp || sos;
  }

  function mensagensPendentes(p) {
    var n = 0;
    est.mensagens.forEach(function (m) { if (m.participante_id === p.id && m.direcao !== 'entrada' && !m.confirmada_em) n++; });
    return n;
  }

  // Reincluído e o celular ainda não voltou a enviar a localização.
  function aguardandoRetorno(p) {
    var d = p.dados;
    if (!d.reincluido_em || d.removido || d.rastreando) return false;
    var r = C.paraMs(d.reincluido_em);
    return !d.ultima_posicao_em || C.paraMs(d.ultima_posicao_em) < r;
  }

  // Estado de conexão do participante (nunca trata posição antiga como atual).
  function estadoDe(p) {
    var d = p.dados;
    var agora = C.agora();
    var por = d.removido_por_nome ? ' por ' + d.removido_por_nome : '';
    if (d.liberado_em) return { cod: 'removido', rot: 'Saída liberada às ' + C.hora(d.liberado_em, false) + por };
    if (d.removido) return { cod: 'removido', rot: 'Removido' + (d.removido_em ? ' às ' + C.hora(d.removido_em, false) : '') + por };
    if (est.op && est.op.status !== 'ativa') return { cod: 'encerrado', rot: 'Operação encerrada' };
    if (aguardandoRetorno(p)) return { cod: 'aguardando', rot: 'Reincluído às ' + C.hora(d.reincluido_em, false) + ' · aguardando o celular voltar' };
    var contato = C.paraMs(d.ultimo_contato_em);
    if (!contato) return { cod: 'aguardando', rot: 'Aguardando primeiro contato' };
    var dt = agora - contato;
    if (tipoDe(d) === 'responsavel') {
      if (dt > LIM.instavelMs) return { cod: 'sem_atualizacao', rot: 'Painel fechado ou sem conexão · último contato ' + C.idade(contato) };
      if (dt > LIM.conectadoMs) return { cod: 'instavel', rot: 'Sinal instável · último contato ' + C.idade(contato) };
      return { cod: 'conectado', rot: d.rastreando ? 'No painel · compartilhando posição' : 'No painel · sem posição' };
    }
    if (!d.rastreando) {
      return { cod: 'parado', rot: 'Interrompeu o compartilhamento' + (dt > LIM.instavelMs ? ' · sem contato ' + C.idade(contato) : '') };
    }
    if (dt > LIM.instavelMs) return { cod: 'sem_atualizacao', rot: 'Sem atualização ' + C.idade(contato) };
    if (dt > LIM.conectadoMs) return { cod: 'instavel', rot: 'Sinal instável · último contato ' + C.idade(contato) };
    return { cod: 'conectado', rot: 'Conectado' };
  }

  function textoGps(g) {
    return {
      aguardando: 'Aguardando GPS', ok: 'GPS ativo', fraco: 'GPS com sinal fraco', sem_sinal: 'GPS sem sinal',
      negado: 'Localização negada no aparelho', indisponivel: 'GPS desligado/indisponível',
    }[g] || g;
  }

  function posicaoAntiga(p) {
    var pos = posicaoAtual(p);
    return !pos || !pos.t || C.agora() - pos.t > LIM.posicaoAntigaMs;
  }

  /* ---------- Marcadores ------------------------------------------- */
  function classesMarcador(p) {
    var c = ['mk'];
    if (posicaoAntiga(p) || estadoDe(p).cod !== 'conectado') c.push('antigo');
    if (temAjuda(p)) c.push('ajuda');
    if (saidaPendente(p)) c.push('saida');
    if (naoLidasDe(p.id).length) c.push('msg-nova');
    if (est.selecionado === p.id) c.push('selecionado');
    if (ehEu(p)) c.push('eu');
    var principal = gruposDe(p.id)[0];
    if (principal && principal.papel === 'responsavel') c.push('resp-grupo');
    return c.join(' ');
  }

  function textoRotulo(p) {
    var pos = posicaoAtual(p);
    return pos ? C.idade(pos.t) : '';
  }

  function resumoTexto(t, n) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  // Balão da pessoa: nome, tipo/grupo, idade da posição e o que pede atenção
  function infoBalaoPessoa(p) {
    var d = p.dados, pos = posicaoAtual(p), g = gruposDe(p.id)[0];
    var sub = [TIPOS[tipoDe(d)].rotulo + (g ? ' · ' + (g.papel === 'responsavel' ? '★ ' : '') + g.nome : '')];
    if (pos) sub.push('posição ' + C.idade(pos.t));
    var alertas = [];
    if (temAjuda(p)) alertas.push('PEDIU AJUDA');
    if (saidaPendente(p)) alertas.push('pediu para encerrar');
    if (naoLidasDe(p.id).length) alertas.push(naoLidasDe(p.id).length + ' mensagem(ns) nova(s)');
    var dest = est.destinos.get(p.id);
    if (dest) alertas.push('indo para: ' + dest.nome);
    return { latlng: p.marcador ? p.marcador.getLatLng() : null, titulo: nomeExibido(p), sub: sub.join(' · '), texto: alertas.join(' · ') || null, botao: 'Abrir ficha ›', deslocY: -12 };
  }

  function criarIcone(p) {
    var html = '<div class="' + classesMarcador(p) + '">' + htmlSimbolo(p) +
      '<div class="mk-rotulo"><span class="mk-nome">' + htmlNomeMapa(p) + '</span><small class="mk-idade">' + C.esc(textoRotulo(p)) + '</small></div>' +
      '</div>';
    return L.divIcon({ className: 'mk-wrap', html: html, iconSize: [0, 0] });
  }

  function atualizarMarcador(p) {
    if (!est.mapa) return;
    var pos = posicaoAtual(p);
    if (!pos || p.dados.removido || !visivelNoFiltro(p)) {
      tirarPessoaDoMapa(p);
      return;
    }
    if (!p.marcador) {
      p.marcador = L.marker([pos.lat, pos.lng], {
        icon: criarIcone(p),
        keyboard: true,
        riseOnHover: true,   // o nome escondido por falta de espaço aparece por cima ao passar o mouse
        title: nomeExibido(p) + ' (' + TIPOS[tipoDe(p.dados)].rotulo + ')',
        alt: p.dados.nome,
        corAgrupado: corDoParticipante(p),
        zIndexOffset: tipoDe(p.dados) === 'responsavel' ? 200 : tipoDe(p.dados) === 'militar' ? 100 : 0,
      });
      ligarCliquesMapa(p.marcador, {
        noDesenho: function () { aoClicarNoMapa({ latlng: p.marcador.getLatLng() }); },
        info: function () { return infoBalaoPessoa(p); },
        detalhes: function () { selecionar(p.id); },
      });
      // Ao sair de um agrupamento o ícone é recriado: reaplica a situação atual
      p.marcador.on('add', function () { atualizarAparenciaMarcador(p); });
      colocarPessoaNoMapa(p);
      return;
    }
    var atual = p.marcador.getLatLng();
    if (atual.lat !== pos.lat || atual.lng !== pos.lng) { p.marcador.setLatLng([pos.lat, pos.lng]); est.rotulos.agendar(); }
    atualizarAparenciaMarcador(p);
  }

  /* ---------- Camada das pessoas (agrupamento de longe) -------------- */
  function criarCamadaPessoas() {
    // agrupar pessoas próximas de longe fica sempre ligado (não há mais opção para desligar)
    return window.MapaRotulos ? window.MapaRotulos.criarGrupoPessoas(L) : L.featureGroup();
  }

  // (Re)cria a camada conforme a preferência "Agrupar pessoas próximas" e devolve as pessoas a ela.
  function montarCamadaPessoas() {
    if (!est.mapa) return;
    if (est.camadaPessoas) { est.camadaPessoas.clearLayers(); est.camadaPessoas.remove(); }
    est.camadaPessoas = criarCamadaPessoas().addTo(est.mapa);
    est.participantes.forEach(function (p) {
      if (p.marcador) { est.camadaPessoasFixas.removeLayer(p.marcador); p._fixo = null; colocarPessoaNoMapa(p); }
    });
  }

  // Pede atenção (ajuda, saída, selecionado, você): sempre visível, fora do agrupamento.
  function colocarPessoaNoMapa(p) {
    if (!p.marcador || !est.camadaPessoas) return;
    var fixo = !window.MapaRotulos || window.MapaRotulos.ehDestaque(classesMarcador(p));
    if (p._fixo === fixo) return;
    var sai = fixo ? est.camadaPessoas : est.camadaPessoasFixas, entra = fixo ? est.camadaPessoasFixas : est.camadaPessoas;
    if (sai.hasLayer(p.marcador)) sai.removeLayer(p.marcador);
    p._fixo = fixo;
    entra.addLayer(p.marcador);
  }

  function tirarPessoaDoMapa(p) {
    if (!p.marcador) return;
    if (est.camadaPessoas && est.camadaPessoas.hasLayer(p.marcador)) est.camadaPessoas.removeLayer(p.marcador);
    if (est.camadaPessoasFixas && est.camadaPessoasFixas.hasLayer(p.marcador)) est.camadaPessoasFixas.removeLayer(p.marcador);
    p.marcador.remove();
    p.marcador = null;
    p._fixo = null;
  }

  // Cor do grupo no agrupamento: refaz os círculos uma vez só, depois de várias mudanças.
  function atualizarAgrupamentos() {
    if (est._refazGrupos || !est.camadaPessoas || !est.camadaPessoas.refreshClusters) return;
    est._refazGrupos = setTimeout(function () {
      est._refazGrupos = null;
      if (est.camadaPessoas.refreshClusters) est.camadaPessoas.refreshClusters();
    }, 300);
  }

  // Cor do grupo no símbolo e na trilha. Só refaz o símbolo quando o HTML muda (sem piscar).
  function atualizarIdentidade(p) {
    if (p.marcador) {
      var html = criarIcone(p).options.html;
      if (p._iconeHtml !== html) { p.marcador.setIcon(criarIcone(p)); p._iconeHtml = html; }
      var cor = corDoParticipante(p);
      if (p.marcador.options.corAgrupado !== cor) { p.marcador.options.corAgrupado = cor; atualizarAgrupamentos(); }
    }
    if (p.trilha) p.trilha.setStyle({ color: corDoParticipante(p) });
  }

  function atualizarAparenciaMarcador(p) {
    if (!p.marcador) return;
    colocarPessoaNoMapa(p);   // entra ou sai do agrupamento conforme a situação
    var el = p.marcador.getElement();
    if (!el) return;
    var mk = el.querySelector('.mk');
    if (!mk) return;
    var cls = classesMarcador(p);
    if (mk.className !== cls) { mk.className = cls; est.rotulos.agendar(); }
    var nome = el.querySelector('.mk-nome');
    var htmlNome = htmlNomeMapa(p);
    if (nome && nome.getAttribute('data-h') !== htmlNome) { nome.innerHTML = htmlNome; nome.setAttribute('data-h', htmlNome); }
    var idade = el.querySelector('.mk-idade');
    var txt = textoRotulo(p);
    if (idade && idade.textContent !== txt) idade.textContent = txt;
    if (est.selecionado === p.id && est.circuloPrecisao) {
      var pos = posicaoAtual(p);
      if (pos) {
        est.circuloPrecisao.setLatLng([pos.lat, pos.lng]);
        est.circuloPrecisao.setRadius(pos.prec || 0);
      }
    }
  }

  /* ---------- Trilhas ---------------------------------------------- */
  function adicionarPonto(row) {
    if (est.posIds.has(row.id)) return;
    est.posIds.add(row.id);
    if (row.id > est.maxPosId) est.maxPosId = row.id;
    var p = est.participantes.get(row.participante_id);
    if (!p) {
      est.pontosOrfaos.push(row);
      return;
    }
    // t = capturado pelo GPS; rec = chegou ao servidor; exib = mostrado neste painel
    var pt = { id: row.id, t: C.paraMs(row.registrado_em), lat: row.lat, lng: row.lng, prec: row.precisao,
      rec: C.paraMs(row.recebido_em), exib: C.agora() };
    // insere na ordem temporal correta (pontos enviados depois de uma queda chegam fora de ordem)
    // (mesmo horário: desempata pelo id, para o desenho ser sempre o mesmo)
    var arr = p.pontos;
    var i = arr.length;
    while (i > 0 && (arr[i - 1].t > pt.t || (arr[i - 1].t === pt.t && arr[i - 1].id > pt.id))) i--;
    arr.splice(i, 0, pt);

    var d = p.dados;
    if (!d.ultima_posicao_em || pt.t > C.paraMs(d.ultima_posicao_em)) {
      d.ultima_lat = pt.lat;
      d.ultima_lng = pt.lng;
      d.ultima_precisao = pt.prec;
      d.ultima_posicao_em = new Date(pt.t).toISOString();
      atualizarMarcador(p);
      est.listaSuja = true;
      if (!est.jaEnquadrou) {
        est.jaEnquadrou = true;
        setTimeout(enquadrarTodos, 100);
      }
    }
    sujarTrilha(p);
    if (est.selecionado === p.id) atualizarFicha();
    // alarmes de proximidade (saiu do setor / entrou em área de risco)
    if (window.Ferramentas && pt.t > C.agora() - 180000 && (pt.prec == null || pt.prec <= LIM.precisaoTrilhaM)) window.Ferramentas.aoNovoPonto(p, pt);
  }

  function sujarTrilha(p) {
    est.trilhasSujas.add(p.id);
    if (est.rafTrilhas) return;
    est.rafTrilhas = requestAnimationFrame(function () {
      est.rafTrilhas = null;
      est.trilhasSujas.forEach(function (id) {
        var x = est.participantes.get(id);
        if (x) desenharTrilha(x);
      });
      est.trilhasSujas.clear();
      if (est.listaSuja) renderizarLista();
    });
  }

  // Trilha em ordem cronológica (p.pontos já é mantido ordenado por horário).
  // Não liga pontos imprecisos, separados por longa pausa ou por salto
  // impossível, nem desenha o vaivém de quem está parado (gps.js). Os pontos
  // guardados não mudam: o histórico completo continua na ficha.
  // Distância percorrida pelo participante (rastros GPS válidos; as falhas sem registro não contam)
  function distanciaPercorridaM(p) {
    var m = 0;
    trilhaDe(p).segmentos.forEach(function (seg) { m += comprimentoLinhaM(seg); });
    return m;
  }
  function formatarKm(m) {
    return (m / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' km';
  }

  function trilhaDe(p) {
    return window.GPS.trilha(p.pontos, { precisaoTrilhaM: LIM.precisaoTrilhaM, lacunaMs: lacunaMsOp() });
  }

  // Limite de falha da operação (s sem ponto entre dois pontos seguidos); padrão do gps.js sem a migração 009.
  function lacunaMsOp() {
    return est.op && est.op.gps_lacuna_s ? est.op.gps_lacuna_s * 1000 : undefined;
  }

  // Espessura pelo zoom: em pixels a linha não muda com o zoom, então de longe ela "engorda"
  // em relação ao mapa e cobre tudo. De perto fica como antes; afastando, afina.
  function fatorZoomTrilha() {
    var z = est.mapa ? est.mapa.getZoom() : 17;
    return (z >= 18 ? 1 : z >= 17 ? 0.85 : z >= 16 ? 0.7 : z >= 15 ? 0.55 : z >= 14 ? 0.45 : 0.38) * fatorTelaTrilha();
  }
  // Espessura pela largura da tela: em telas grandes (≥ 1280 px) fica como sempre foi; em telas menores
  // afina na proporção (até 60% num celular de 360 px), para não cobrir o mapa. Nunca passa do tamanho atual.
  function fatorTelaTrilha() {
    var w = window.innerWidth || 1280;
    return Math.max(0.6, Math.min(1, 0.6 + 0.4 * (w - 360) / (1280 - 360)));
  }
  // linha fina (2,5 px de perto; ~1 px de longe); a selecionada um pouco mais grossa
  function pesoTrilha(p) {
    var f = fatorZoomTrilha();
    return Math.max(1, Math.round((est.selecionado === p.id ? 4 : 2.5) * f * 10) / 10);
  }
  function pesoHalo(p) { return pesoTrilha(p) + (fatorZoomTrilha() >= 0.7 ? 2 : 1); }
  // com alguém selecionado, as outras trilhas ficam apagadas (menos cor no mapa)
  function opacidadeTrilha(p) {
    if (est.selecionado && est.selecionado !== p.id) return 0.3;
    return est.selecionado === p.id ? 0.95 : 0.7;
  }
  function opacidadeHalo(p) { return fatorZoomTrilha() >= 0.7 && (!est.selecionado || est.selecionado === p.id) ? 0.35 : 0; }
  // tracejado proporcional à espessura (de longe os traços ficam curtos e finos)
  function tracoTrilha(tipo) {
    var base = TIPOS[tipo].trilha;
    if (!base) return null;
    var f = Math.max(0.5, fatorZoomTrilha());
    return base.split(' ').map(function (n) { return Math.max(2, Math.round(+n * f)); }).join(' ');
  }

  function desenharTrilha(p) {
    if (!est.mapa) return;
    var tr = p.trilhaVisivel && visivelNoFiltro(p) ? trilhaDe(p) : { segmentos: [], lacunas: [] };
    var segs = tr.segmentos;
    desenharLacunas(p, tr.lacunas);
    if (!segs.length) {   // oculta ou sem pontos: nada a desenhar
      if (p.trilha) p.trilha.remove();
      if (p.halo) p.halo.remove();
      return;
    }
    var tipo = tipoDe(p.dados);
    // Civis: contorno claro por baixo para a linha roxa aparecer sobre mata, satélite e topográfico.
    if (tipo === 'civil') {
      if (!p.halo) {
        p.halo = L.polyline(segs, { color: '#ffffff', weight: pesoHalo(p), opacity: opacidadeHalo(p), interactive: false, lineJoin: 'round', className: 'trilha-halo' });
      } else {
        p.halo.setLatLngs(segs);
      }
      if (!est.mapa.hasLayer(p.halo)) p.halo.addTo(est.mapa);
    }
    if (!p.trilha) {
      p.trilha = L.polyline(segs, {
        color: corDoParticipante(p),
        weight: pesoTrilha(p),
        opacity: opacidadeTrilha(p),
        dashArray: tracoTrilha(tipo),
        interactive: false,
        lineJoin: 'round',
        className: 'trilha trilha-' + tipo,
      });
    } else {
      p.trilha.setLatLngs(segs);
    }
    if (!est.mapa.hasLayer(p.trilha)) p.trilha.addTo(est.mapa);
  }

  // Falha: intervalo maior que o limite da operação entre dois pontos seguidos
  // (ou salto incoerente). É desenhada TRACEJADA em cinza (não é percurso
  // registrado), com o início (○) e o fim (●) da falha marcados.
  function desenharLacunas(p, lacunas) {
    if (!lacunas.length) { if (p.lacunas) { p.lacunas.remove(); p.lacunas = null; } return; }
    if (!p.lacunas) p.lacunas = L.layerGroup().addTo(est.mapa);
    var assinatura = lacunas.map(function (l) { return l.t0 + '-' + l.t1; }).join('|');
    if (p.lacunas._assinatura === assinatura) return;
    p.lacunas._assinatura = assinatura;
    p.lacunas.clearLayers();
    lacunas.forEach(function (l) {
      var dur = Math.round((l.t1 - l.t0) / 1000);
      var txtDur = dur < 120 ? dur + ' s' : Math.round(dur / 60) + ' min';
      var texto = 'Falha: sem posições registradas de ' + C.hora(l.t0) + ' a ' + C.hora(l.t1) + ' (' + txtDur + ')' +
        (l.impossivel ? ' — salto incoerente' : '') + '. O percurso real nesse trecho é desconhecido.';
      L.polyline([l.de, l.ate], { color: '#9ca3af', weight: pesoLacuna(), opacity: 0.9, dashArray: '8 6', interactive: true, className: 'trilha-lacuna' })
        .bindTooltip(texto, { sticky: true })
        .addTo(p.lacunas);
      L.circleMarker(l.de, { radius: raioFalha(), color: '#e5e7eb', weight: 2, fillColor: '#111827', fillOpacity: 1, className: 'falha-inicio' })
        .bindTooltip('Início da falha · ' + nomeExibido(p) + ' · ' + C.hora(l.t0) + ' (último ponto antes da falha)')
        .addTo(p.lacunas);
      L.circleMarker(l.ate, { radius: raioFalha(), color: '#111827', weight: 2, fillColor: '#e5e7eb', fillOpacity: 1, className: 'falha-fim' })
        .bindTooltip('Fim da falha · ' + nomeExibido(p) + ' · ' + C.hora(l.t1) + ' (primeiro ponto depois da falha, ' + txtDur + ' sem posições)')
        .addTo(p.lacunas);
    });
  }

  function pesoLacuna() { return Math.max(1.5, Math.round(2.5 * Math.max(0.6, fatorZoomTrilha()) * 10) / 10); }
  function raioFalha() { return fatorZoomTrilha() >= 0.8 ? 5 : 3.5; }

  // A trilha de quem está com a ficha aberta fica mais grossa (fácil de seguir entre várias).
  // Também refeita a cada zoom (espessura e tracejado acompanham o zoom).
  function estilizarTrilhas() {
    est.participantes.forEach(function (p) {
      if (p.trilha) p.trilha.setStyle({ weight: pesoTrilha(p), dashArray: tracoTrilha(tipoDe(p.dados)), opacity: opacidadeTrilha(p) });
      if (p.halo) p.halo.setStyle({ weight: pesoHalo(p), opacity: opacidadeHalo(p) });
      if (p.lacunas) p.lacunas.eachLayer(function (l) {
        if (l instanceof L.CircleMarker) l.setRadius(raioFalha());
        else l.setStyle({ weight: pesoLacuna() });
      });
      if (p.trilha && est.selecionado === p.id) p.trilha.bringToFront();
    });
  }

  // A tela mudou de tamanho (girou o celular, redimensionou a janela): espessuras acompanham.
  var ultimoFatorTela = null;
  function ajustarTrilhasATela() {
    var f = fatorTelaTrilha();
    if (f === ultimoFatorTela) return;
    ultimoFatorTela = f;
    estilizarTrilhas();
    est.trilhasManuais.forEach(function (t) { if (t.camada && t.fatorTela !== f) desenharTrilhaManual(t); });
  }

  // Ocultar a trilha afeta só o mapa: os pontos continuam chegando e sendo guardados.
  function alternarTrilha(id, valor) {
    var p = est.participantes.get(id);
    if (!p) return;
    p.trilhaVisivel = typeof valor === 'boolean' ? valor : !p.trilhaVisivel;
    desenharTrilha(p);
    est.listaSuja = true;
    renderizarLista();
    if (est.selecionado === id) atualizarFicha();
    atualizarMenu();
  }

  function definirTodasTrilhas(visivel, silencioso) {
    // lembrado no aparelho: quem entrar depois já aparece com ou sem trilha
    est.prefsMapa.trilhas = visivel;
    C.local.gravar(CHAVE_PREFS_MAPA, est.prefsMapa);
    est.participantes.forEach(function (p) {
      p.trilhaVisivel = visivel;
      desenharTrilha(p);
    });
    est.listaSuja = true;
    renderizarLista();
    if (est.selecionado) atualizarFicha();
    atualizarMenu();
    if (!silencioso) UI.aviso(visivel ? 'Todas as trilhas visíveis.' : 'Trilhas ocultas (o rastreamento continua).');
  }

  /* ---------- Gaveta da lista (celular e tablet em pé) ---------------- */
  // O mapa ocupa a tela toda e a lista sobe por cima em três alturas:
  // mini (só o cabeçalho), meia e cheia. Tocar na alça alterna; arrastar ajusta.
  var gaveta = {
    ativa: false,
    estado: (function () { var v = C.local.ler(CHAVE_GAVETA, 'meia'); return v === 'mini' || v === 'cheia' ? v : 'meia'; })(),
    mq: window.matchMedia ? window.matchMedia('(max-width: 860px) and (orientation: portrait)') : null,
    arrastou: false,
  };

  function alturasGaveta() {
    var corpo = $('painel-corpo'), lat = $('lateral');
    var H = corpo.clientHeight || window.innerHeight;
    var topo = lat.getBoundingClientRect().top;
    var resumo = lat.querySelector('.resumo');
    var mini = resumo ? Math.round(resumo.getBoundingClientRect().bottom - topo + 10) : 92;
    mini = Math.max(64, Math.min(mini, 140));
    var cheia = Math.max(mini + 120, H - 52);
    var meia = Math.max(mini + 80, Math.min(Math.round(H * 0.5), cheia - 60));
    return { mini: mini, meia: meia, cheia: cheia };
  }

  function alturaGaveta(h) {
    $('lateral').style.height = h + 'px';
    $('painel-corpo').style.setProperty('--gaveta-h', h + 'px');
  }

  function aplicarGaveta() {
    var lat = $('lateral');
    if (!gaveta.ativa) {
      lat.style.height = '';
      $('painel-corpo').style.removeProperty('--gaveta-h');
      delete lat.dataset.gaveta;
      delete $('painel-corpo').dataset.gaveta;
      return;
    }
    lat.dataset.gaveta = gaveta.estado;
    $('painel-corpo').dataset.gaveta = gaveta.estado;
    // primeiro o estado (mostra/esconde partes), depois a medida da altura
    alturaGaveta(alturasGaveta()[gaveta.estado]);
    var rot = { mini: 'recolhida', meia: 'pela metade', cheia: 'em tela cheia' }[gaveta.estado];
    $('gaveta-alca').setAttribute('aria-label', 'Lista de participantes ' + rot + '. Tocar muda o tamanho; também dá para arrastar.');
    $('gaveta-alca').setAttribute('aria-expanded', String(gaveta.estado !== 'mini'));
  }

  function definirGaveta(estado, lembrar) {
    gaveta.estado = estado;
    if (lembrar !== false) C.local.gravar(CHAVE_GAVETA, estado);
    aplicarGaveta();
  }

  function avaliarGaveta() {
    var ativa = Boolean(gaveta.mq && gaveta.mq.matches);
    if (ativa !== gaveta.ativa) {
      gaveta.ativa = ativa;
      document.body.classList.toggle('gaveta', ativa);
      if (est.op) aplicarLateral(false);
    }
    aplicarGaveta();
  }

  function iniciarGaveta() {
    var lat = $('lateral'), alca = $('gaveta-alca');
    if (gaveta.mq) {
      if (gaveta.mq.addEventListener) gaveta.mq.addEventListener('change', avaliarGaveta);
      else if (gaveta.mq.addListener) gaveta.mq.addListener(avaliarGaveta);
    }
    var tAjuste = null;
    window.addEventListener('resize', function () { clearTimeout(tAjuste); tAjuste = setTimeout(function () { if (gaveta.ativa) aplicarGaveta(); ajustarTrilhasATela(); }, 120); });
    alca.addEventListener('click', function () {
      if (gaveta.arrastou) { gaveta.arrastou = false; return; }
      definirGaveta({ mini: 'meia', meia: 'cheia', cheia: 'mini' }[gaveta.estado]);
    });
    alca.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowUp') { ev.preventDefault(); definirGaveta(gaveta.estado === 'mini' ? 'meia' : 'cheia'); }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); definirGaveta(gaveta.estado === 'cheia' ? 'meia' : 'mini'); }
    });
    // Arrastar pela alça ou pelo título
    var arr = null;
    function inicio(ev) {
      if (!gaveta.ativa || (ev.button != null && ev.button !== 0)) return;
      if (ev.target.closest('button:not(.gaveta-alca), input, select, a')) return;
      arr = { y: ev.clientY, h: lat.getBoundingClientRect().height, t: Date.now(), id: ev.pointerId, alt: alturasGaveta(), moveu: false };
      try { ev.target.setPointerCapture(ev.pointerId); } catch (e) { /* ignora */ }
    }
    function mover(ev) {
      if (!arr || ev.pointerId !== arr.id) return;
      var dy = ev.clientY - arr.y;
      if (!arr.moveu && Math.abs(dy) < 6) return;
      if (!arr.moveu) { arr.moveu = true; lat.classList.add('arrastando'); }
      ev.preventDefault();
      alturaGaveta(Math.max(arr.alt.mini, Math.min(arr.alt.cheia, arr.h - dy)));
    }
    function fim(ev) {
      if (!arr || ev.pointerId !== arr.id) return;
      var a = arr;
      arr = null;
      lat.classList.remove('arrastando');
      if (!a.moveu) return;
      gaveta.arrastou = true;
      setTimeout(function () { gaveta.arrastou = false; }, 350);
      var h = lat.getBoundingClientRect().height;
      var vel = (ev.clientY - a.y) / Math.max(1, Date.now() - a.t);   // px/ms (positivo = para baixo)
      var ordem = ['mini', 'meia', 'cheia'];
      var alvo;
      if (Math.abs(vel) > 0.6) {
        // gesto rápido: vai para a próxima posição na direção do gesto
        var atual = ordem.reduce(function (m, k) { return Math.abs(a.alt[k] - a.h) < Math.abs(a.alt[m] - a.h) ? k : m; }, 'meia');
        var i = ordem.indexOf(atual) + (vel < 0 ? 1 : -1);
        alvo = ordem[Math.max(0, Math.min(2, i))];
      } else {
        alvo = ordem.reduce(function (m, k) { return Math.abs(a.alt[k] - h) < Math.abs(a.alt[m] - h) ? k : m; }, 'meia');
      }
      definirGaveta(alvo);
    }
    [alca, lat.querySelector('.lateral-cabeca .linha')].forEach(function (el) {
      el.addEventListener('pointerdown', inicio);
      el.addEventListener('pointermove', mover);
      el.addEventListener('pointerup', fim);
      el.addEventListener('pointercancel', fim);
    });
    avaliarGaveta();
  }

  /* ---------- Lista lateral ---------------------------------------- */
  function alternarLateral() {
    var lat = $('lateral');
    var recolhida = lat.classList.toggle('recolhida');
    $('btn-recolher').textContent = recolhida ? 'Expandir' : 'Recolher';
    $('btn-recolher').setAttribute('aria-expanded', String(!recolhida));
    setTimeout(function () { if (est.mapa) est.mapa.invalidateSize(); }, 50);
  }

  // Lista compacta: uma linha por pessoa (símbolo, nome, avisos e a idade da posição).
  // Tipo e grupo já estão no símbolo (forma, letra e cor); o resto fica na ficha (tocar na linha).
  function criarItemLista(p) {
    var li = UI.el('li', { classe: 'lista-item', tabindex: '0', 'data-id': p.id });
    var simbolo = UI.el('div', { classe: 'li-simbolo' });
    var nome = UI.el('div', { classe: 'li-nome' });
    var estado = UI.el('div', { classe: 'li-estado' });
    var acoes = UI.el('div', { classe: 'li-acoes' });
    var bRei = UI.el('button', { classe: 'btn btn-pequeno btn-ok btn-reincluir', type: 'button', hidden: true, 'aria-label': 'Reincluir ' + p.dados.nome + ' na operação', texto: 'Reincluir' });
    bRei.addEventListener('click', function (ev) { ev.stopPropagation(); reincluirParticipante(p.id); });
    acoes.appendChild(bRei);
    li.appendChild(simbolo);
    li.appendChild(nome);
    li.appendChild(estado);
    li.appendChild(acoes);
    li.addEventListener('click', function () { abrirDaLista(p.id); });
    li.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); abrirDaLista(p.id); }
    });
    p.li = li;
    p.liPartes = { simbolo: simbolo, nome: nome, estado: estado, bRei: bRei };
    return li;
  }

  // Tocar na linha: abre a ficha e leva o mapa até a pessoa (sem mudar o zoom).
  function abrirDaLista(id) {
    selecionar(id);
    var p = est.participantes.get(id);
    var pos = p && posicaoAtual(p);
    if (pos && est.mapa) est.mapa.panTo([pos.lat, pos.lng]);
  }

  // "há 26 min" → "26 min" (coluna estreita da lista)
  function idadeCurta(t) {
    return String(C.idade(t) || '').replace(/^há\s+/, '');
  }

  function atualizarItemLista(p) {
    if (!p.li) criarItemLista(p);
    var d = p.dados;
    var e = estadoDe(p);
    var ajuda = temAjuda(p);
    var saida = saidaPendente(p);
    var pend = mensagensPendentes(p);
    var novas = naoLidasDe(p.id).length;
    var pos = posicaoAtual(p);
    var partes = p.liPartes;
    var grupos = gruposDe(p.id);
    var gpsRuim = d.rastreando && ['sem_sinal', 'negado', 'indisponivel'].indexOf(d.gps_estado) !== -1;

    var htmlSimb = '<div class="' + (posicaoAntiga(p) ? 'antigo' : '') + '">' + htmlSimbolo(p) + '</div>';
    if (partes.simbolo.innerHTML !== htmlSimb) partes.simbolo.innerHTML = htmlSimb;

    // Avisos só quando existem (ícone curto; a descrição completa vai no title e na ficha)
    var resp = grupos.some(function (g) { return g.papel === 'responsavel'; });
    var htmlNome = (resp ? '<span class="li-estrela" title="Responsável do grupo">★</span>' : '') +
      '<span class="nome-txt">' + C.esc(nomeExibido(p)) + '</span>' +
      (ajuda ? '<span class="li-aviso li-aviso-ajuda" title="Pediu ajuda">SOS</span>' : '') +
      (saida ? '<span class="li-aviso li-aviso-saida" title="Pediu para sair">Saída</span>' : '') +
      (novas ? '<span class="li-aviso li-aviso-msg" title="' + (novas === 1 ? 'Mensagem nova' : novas + ' mensagens novas') + '">✉' + (novas > 1 ? novas : '') + '</span>' : '');
    if (partes.nome.innerHTML !== htmlNome) partes.nome.innerHTML = htmlNome;

    var dica = e.rot + (gpsRuim ? ' · ' + textoGps(d.gps_estado) : '') +
      (pend ? ' · ' + pend + ' mensagem(ns) aguardando confirmação' : '') + (aguardandoRetorno(p) ? ' · reincluído' : '') +
      (pos ? ' · posição ' + C.hora(pos.t) + ' (' + C.idade(pos.t) + ')' : ' · sem posição ainda') +
      (grupos.length ? ' · ' + grupos.map(function (g) { return (g.papel === 'responsavel' ? 'resp. ' : '') + g.nome; }).join(', ') : '');
    var htmlEstado = '<span class="ponto ponto-' + e.cod + '"></span>' +
      (gpsRuim ? '<span class="li-gps" aria-hidden="true">GPS</span>' : '') +
      '<span class="li-idade">' + (pos ? C.esc(idadeCurta(pos.t)) : '—') + '</span>';
    if (partes.estado.innerHTML !== htmlEstado) partes.estado.innerHTML = htmlEstado;
    if (p.li.title !== dica) { p.li.title = dica; p.li.setAttribute('aria-label', nomeExibido(p) + ': ' + dica); }

    var podeReincluir = podeReincluirP(p);
    if (partes.bRei.hidden === podeReincluir) partes.bRei.hidden = !podeReincluir;
    p.li.classList.toggle('selecionado', est.selecionado === p.id);
    p.li.classList.toggle('alerta-ajuda', Boolean(ajuda));
    p.li.classList.toggle('alerta-saida', saida && !ajuda);
    p.li.classList.toggle('li-antigo', e.cod !== 'conectado' && tipoDe(d) !== 'responsavel');
    var busca = $('busca').value.trim().toLowerCase();
    p.li.hidden = (Boolean(busca) && (d.nome + ' ' + (d.nome_original || '')).toLowerCase().indexOf(busca) === -1) || !visivelNoFiltro(p) ||
      (est.filtroEstado && !d.removido && (tipoDe(d) === 'responsavel' || estadoDe(p).cod !== est.filtroEstado));
  }

  function ordemLista(a, b) {
    var aa = temAjuda(a) ? 0 : saidaPendente(a) ? 1 : naoLidasDe(a.id).length ? 2 : 3;
    var bb = temAjuda(b) ? 0 : saidaPendente(b) ? 1 : naoLidasDe(b.id).length ? 2 : 3;
    if (aa !== bb) return aa - bb;
    var ra = tipoDe(a.dados) === 'responsavel' ? 0 : 1, rb = tipoDe(b.dados) === 'responsavel' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    var ar = a.dados.removido ? 1 : 0, br = b.dados.removido ? 1 : 0;
    if (ar !== br) return ar - br;
    return a.dados.nome.localeCompare(b.dados.nome, 'pt-BR', { sensitivity: 'base' });
  }

  // Duas listas: quem está na operação e quem está fora (removido ou com saída
  // liberada), que pode ser reincluído. O cadastro e a trilha dos dois continuam.
  function renderizarLista() {
    est.listaSuja = false;
    var lista = Array.from(est.participantes.values()).sort(ordemLista);
    var ativos = lista.filter(function (p) { return !p.dados.removido; });
    var fora = lista.filter(function (p) { return p.dados.removido; });
    [[$('lista-part'), ativos], [$('lista-removidos'), fora]].forEach(function (par) {
      var ul = par[0];
      par[1].forEach(function (p, i) {
        atualizarItemLista(p);
        if (ul.children[i] !== p.li) ul.insertBefore(p.li, ul.children[i] || null);
      });
      while (ul.children.length > par[1].length) ul.removeChild(ul.lastChild);
    });
    $('lista-vazia').hidden = lista.length > 0;
    var noFiltro = filtroAtivo() ? ativos.filter(visivelNoFiltro).length : null;
    $('qtd-part').textContent = noFiltro == null ? String(ativos.length) : noFiltro + ' de ' + ativos.length;
    $('qtd-removidos').textContent = String(fora.length);
    $('grupo-removidos').hidden = fora.length === 0;

    var cont = { conectado: 0, instavel: 0, sem_atualizacao: 0, parado: 0, militar: 0, civil: 0, responsavel: 0 };
    lista.forEach(function (p) {
      if (p.dados.removido) return;
      var t = tipoDe(p.dados);
      cont[t]++;
      if (t === 'responsavel') return;   // os contadores de estado são das equipes de campo
      var c = estadoDe(p).cod;
      if (cont[c] != null) cont[c]++;
    });
    // Resumo numa linha: cada contador filtra a lista (tocar de novo mostra todos)
    var chips = [['conectado', 'conectados'], ['instavel', 'instáveis'], ['sem_atualizacao', 'sem atualização'], ['parado', 'interromperam']]
      .filter(function (c) { return c[0] !== 'parado' || cont.parado; })
      .map(function (c) {
        var ativo = est.filtroEstado === c[0];
        return '<button type="button" class="resumo-chip' + (ativo ? ' ativo' : '') + '" data-estado="' + c[0] + '" aria-pressed="' + ativo + '" title="' +
          cont[c[0]] + ' ' + c[1] + (ativo ? ' · tocar para mostrar todos' : ' · tocar para listar só estes') + '"><span class="ponto ponto-' + c[0] + '"></span><b>' + cont[c[0]] + '</b></button>';
      }).join('');
    var htmlResumo = chips + '<span class="resumo-tipos" title="' + cont.militar + ' militar(es) · ' + cont.civil + ' civil(is) · ' + cont.responsavel + ' responsável(is)">' +
      cont.militar + ' M · ' + cont.civil + ' C' + (cont.responsavel ? ' · ' + cont.responsavel + ' R' : '') + '</span>';
    if ($('resumo').innerHTML !== htmlResumo) $('resumo').innerHTML = htmlResumo;
    // a altura da gaveta recolhida depende do resumo (que muda de tamanho)
    if (gaveta.ativa && gaveta.estado === 'mini' && !$('lateral').classList.contains('arrastando')) aplicarGaveta();
    atualizarBotaoReabrir();
  }

  // Executado a cada 5 s: atualiza "há X s", estados e cores de conexão.
  function atualizarEstados() {
    est.participantes.forEach(atualizarAparenciaMarcador);
    renderizarLista();
    if (est.selecionado) atualizarFicha();
    atualizarPilula();
    if (filtroAtivo()) desenharDestinosGrupo();
    if (est.permanencias.size && !$('painel-areas').hidden) renderizarAreas();   // "há X min" anda sozinho
  }

  /* ------------------------------------------------------------------ */
  /* Ficha do participante                                                */
  /* ------------------------------------------------------------------ */
  function selecionar(id) {
    var anterior = est.participantes.get(est.selecionado);
    est.selecionado = id;
    if (anterior) atualizarAparenciaMarcador(anterior);
    var p = est.participantes.get(id);
    if (!p) return;
    atualizarAparenciaMarcador(p);
    if (est.circuloPrecisao) { est.circuloPrecisao.remove(); est.circuloPrecisao = null; }
    var pos = posicaoAtual(p);
    if (pos && pos.prec) {
      est.circuloPrecisao = L.circle([pos.lat, pos.lng], {
        radius: pos.prec, color: p.cor, weight: 1, fillOpacity: 0.08, interactive: false, className: 'circulo-precisao',
      }).addTo(est.mapa);
    }
    montarComandos(p);
    // Em telas pequenas a ficha e a central ocupam o mesmo espaço: guarda a central para voltar depois.
    if (!$('central').hidden && telaPequena()) {
      est.centralVoltar = true;
      $('central').hidden = true;
    }
    if ($('ficha').hidden || anterior !== p) $('resposta-texto').value = '';
    est.assinaturaConversa = '';
    $('ficha').hidden = false;
    $('ficha').querySelector('.ficha-corpo').scrollTop = 0;
    atualizarFicha();
    renderizarLista();
    marcarLidasVisiveis();
    estilizarTrilhas();
    desenharLinhaDestino();
  }

  function telaPequena() {
    return Boolean(window.matchMedia && window.matchMedia('(max-width: 860px)').matches);
  }

  function fecharFicha() {
    mostrarAbaFicha('conversa');
    $('ficha').hidden = true;
    var p = est.participantes.get(est.selecionado);
    est.selecionado = null;
    if (p) atualizarAparenciaMarcador(p);
    if (est.circuloPrecisao) { est.circuloPrecisao.remove(); est.circuloPrecisao = null; }
    if (est.participantes.size) renderizarLista();
    estilizarTrilhas();
    desenharLinhaDestino();
    if (est.centralVoltar) {
      est.centralVoltar = false;
      if (est.op) abrirCentral();
    }
  }

  // Abas da ficha: "Conversa" (padrão) e "Dados". A escolhida fica até fechar a ficha.
  function mostrarAbaFicha(nome) {
    est.abaFicha = nome === 'dados' ? 'dados' : 'conversa';
    document.querySelectorAll('#ficha .ficha-aba').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-aba') === est.abaFicha)); });
    document.querySelectorAll('#ficha [data-aba-painel]').forEach(function (sec) { sec.hidden = sec.getAttribute('data-aba-painel') !== est.abaFicha; });
  }

  function montarComandos(p) {
    var cont = $('ficha-comandos');
    cont.innerHTML = '';
    if (ehEu(p)) return;   // ninguém envia orientação para si mesmo
    // A mensagem livre é escrita no campo logo abaixo; aqui ficam só as orientações prontas.
    var tipos = (tipoDe(p.dados) === 'responsavel' ? COMANDOS_RESPONSAVEL : Object.keys(C.TIPOS_MENSAGEM))
      .filter(function (t) { return t !== 'PERSONALIZADA'; });
    tipos.forEach(function (tipo) {
      var t = C.TIPOS_MENSAGEM[tipo];
      cont.appendChild(UI.el('button', {
        classe: 'btn ' + t.classe, type: 'button', texto: t.rotulo,
        onclick: function () { enviarComando(p.id, tipo); },
      }));
    });
  }

  function estadoMensagem(m, p) {
    if (m.confirmada_em) {
      var resp = m.resposta ? ' · ' + (C.RESPOSTAS[m.resposta] || m.resposta) : '';
      return { cls: m.resposta === 'PRECISO_AJUDA' ? 'selo-perigo' : 'selo-ok', txt: 'Confirmada às ' + C.hora(m.confirmada_em) + resp };
    }
    if (m.entregue_em) return { cls: 'selo-alerta', txt: 'Recebida pelo aparelho às ' + C.hora(m.entregue_em) + ' · aguardando confirmação' };
    var e = estadoDe(p).cod;
    if (e === 'conectado' || e === 'instavel' || e === 'parado') {
      return { cls: 'selo-neutro', txt: 'Enviada às ' + C.hora(m.criada_em) + ' · aguardando entrega no aparelho' };
    }
    return { cls: 'selo-perigo', txt: 'Enviada às ' + C.hora(m.criada_em) + ' · participante sem conexão: será entregue quando ele reconectar' };
  }

  function atualizarFicha() {
    var p = est.participantes.get(est.selecionado);
    if (!p || $('ficha').hidden) return;
    var d = p.dados;
    var e = estadoDe(p);
    var pos = posicaoAtual(p);

    var eu = ehEu(p);
    var ehResp = tipoDe(d) === 'responsavel';
    $('ficha-nome').textContent = nomeExibido(p);
    $('ficha-renomear').hidden = !podeAlterar() || eu;
    var orig = d.nome_original && d.nome_original !== d.nome ? d.nome_original : '';
    $('ficha-nome-original').hidden = !orig;
    $('ficha-nome-original').textContent = orig ? 'Nome informado pela pessoa: ' + orig : '';
    $('ficha-simbolo').innerHTML = htmlSimbolo(p);

    // Topo da ficha, em texto simples: tipo · grupo(s) · situação. CPF, coordenadas e
    // histórico ficam na aba "Dados".
    $('ficha-resumo').innerHTML = '<span>' + C.esc(TIPOS[tipoDe(d)].rotulo) + '</span>' + gruposDe(p.id).map(function (g) {
      return '<span class="ficha-grupo">' + htmlChipGrupo(est.grupos.get(g.id) || g, 'ficha-grupo-cor', 'i') + (g.papel === 'responsavel' ? '★ ' : '') + C.esc(g.nome) + '</span>';
    }).join('') + '<span class="ficha-estado"><span class="ponto ponto-' + e.cod + '"></span>' + C.esc(e.rot) + '</span>';
    var posTxt;
    if (!pos) posTxt = 'Ainda sem posição';
    else posTxt = 'Posição ' + C.idade(pos.t) + ' · ' + C.precisao(pos.prec) + (posicaoAntiga(p) ? ' · antiga' : '');
    var gpsRuim = d.rastreando && ['sem_sinal', 'negado', 'indisponivel'].indexOf(d.gps_estado) !== -1;
    $('ficha-pos').textContent = posTxt + (gpsRuim ? ' · ' + textoGps(d.gps_estado) : '');
    $('ficha-pos').classList.toggle('antiga', !pos || posicaoAntiga(p) || gpsRuim);
    var perm = textoPermanenciaParticipante(p.id);
    $('ficha-permanencia').hidden = !perm;
    if (perm) {
      $('ficha-permanencia').textContent = '⏱ ' + perm.texto;
      $('ficha-permanencia').classList.toggle('acima', perm.acima);
    }
    var destino = est.destinos.get(p.id);
    var caixaDest = $('ficha-destino');
    caixaDest.hidden = !destino;
    if (destino) {
      caixaDest.innerHTML = '';
      caixaDest.appendChild(document.createTextNode('🧭 Navegando até: '));
      caixaDest.appendChild(UI.el('strong', { texto: destino.nome }));
      caixaDest.appendChild(document.createTextNode(' · enviado às ' + C.hora(destino.criado_em, false) + ' por ' + destino.enviado_por_nome + ' · '));
      caixaDest.appendChild(destino.recebido_em
        ? UI.el('span', { classe: 'destino-recebido', texto: '✓ recebido no celular às ' + C.hora(destino.recebido_em, false) + ' ' })
        : UI.el('span', { classe: 'destino-aguardando', texto: 'aguardando o celular receber ' }));
      caixaDest.appendChild(UI.el('button', { classe: 'btn btn-pequeno btn-link', type: 'button', texto: 'Encerrar', onclick: function () { encerrarDestinoPainel(destino); } }));
      caixaDest.appendChild(UI.el('span', { classe: 'ficha-rota', id: 'ficha-rota', hidden: true }));
    }
    $('ficha-enviar-destino').hidden = tipoDe(d) === 'responsavel' || d.removido || est.op.status !== 'ativa';
    $('ficha-ir-ate').hidden = ehEu(p) || d.removido || est.op.status !== 'ativa';
    $('ficha-vitima').hidden = tipoDe(d) === 'responsavel' || est.op.status !== 'ativa';
    desenharLinhaDestino();
    var ligar = $('ficha-ligar');
    ligar.hidden = !d.telefone;
    if (d.telefone) {
      ligar.href = 'tel:+55' + d.telefone;
      ligar.textContent = '📞 Ligar';
      ligar.title = 'Ligar para ' + formatarTelefone(d.telefone);
      ligar.setAttribute('aria-label', ligar.title);
    }

    // Aba "Dados": só o que serve para agir (sem repetir latitude/longitude e precisão soltas)
    var linhas = [
      ['Celular', d.telefone ? '<a class="tel" href="tel:+55' + C.esc(d.telefone) + '">' + formatarTelefone(d.telefone) + '</a>' : '—'],
      ['CPF', d.cpf ? '<span class="mono">' + formatarCpf(d.cpf, est.cpfVisivel.has(p.id)) + '</span> ' +
        '<button type="button" class="btn btn-pequeno btn-link" data-cpf="' + p.id + '">' + (est.cpfVisivel.has(p.id) ? 'ocultar' : 'mostrar') + '</button>' : '—'],
      ['Coordenadas', pos ? '<span class="mono">' + C.esc(window.Coords.formatar(pos.lat, pos.lng, est.prefsMapa.coord || 'dec')) + '</span> <span class="muted">' + C.esc(C.precisao(pos.prec)) + '</span>' : '—'],
      ['Última posição', pos ? C.hora(pos.t) + ' <span class="muted">(' + C.idade(pos.t) + ')</span>' : '—'],
      ['Distância percorrida', (p.pontos && p.pontos.length) ? formatarKm(distanciaPercorridaM(p)) + ' <span class="muted">(rastros GPS, sem as falhas)</span>' : '—'],
      ['Último contato', d.ultimo_contato_em ? C.hora(d.ultimo_contato_em) + ' <span class="muted">(' + C.idade(d.ultimo_contato_em) + ')</span>' : '—'],
      ['Rastreamento', (ehResp ? (d.rastreando ? 'Compartilhando posição' : 'Posição não compartilhada') : (d.rastreando ? 'Ativo' : 'Interrompido')) + ' · ' + C.esc(textoGps(d.gps_estado))],
      [ehResp ? 'Entrou no painel' : 'Ingressou', C.hora(d.criado_em)],
    ];
    if (ehResp) linhas = linhas.filter(function (l) { return l[0] !== 'CPF' && l[0] !== 'Celular'; });
    $('ficha-dados').innerHTML = linhas.map(function (l) { return '<dt>' + l[0] + '</dt><dd>' + l[1] + '</dd>'; }).join('');
    var bCpf = $('ficha-dados').querySelector('[data-cpf]');
    if (bCpf) bCpf.addEventListener('click', function () {
      if (est.cpfVisivel.has(p.id)) est.cpfVisivel.delete(p.id); else est.cpfVisivel.add(p.id);
      atualizarFicha();
    });

    // Pedido de encerramento
    var caixaSaida = $('ficha-saida');
    var pendente = saidaPendente(p) && est.op.status === 'ativa';
    caixaSaida.hidden = !pendente;
    if (pendente) {
      caixaSaida.innerHTML = '';
      caixaSaida.appendChild(UI.el('div', { classe: 'nota nota-saida' }, [
        UI.el('strong', { texto: 'PEDIU PARA ENCERRAR às ' + C.hora(d.saida_solicitada_em, false) + '.' }, [UI.dica('O rastreamento continua até você decidir.')]),
        d.saida_motivo ? UI.el('div', { texto: 'Motivo: ' + d.saida_motivo }) : null,
        podeAlterar() ? UI.el('div', { classe: 'acoes-linha' }, [
          UI.el('button', { classe: 'btn btn-ok btn-pequeno', type: 'button', texto: 'Liberar saída', onclick: function () { liberarSaida(p.id); } }),
          UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Pedir para continuar', onclick: function () { recusarSaida(p.id); } }),
        ]) : null,
      ]));
    }

    var bTri = $('ficha-trilha');
    bTri.setAttribute('aria-pressed', String(p.trilhaVisivel));
    bTri.textContent = p.trilhaVisivel ? 'Ocultar trilha' : 'Mostrar trilha';
    $('ficha-centralizar').disabled = !pos;
    $('ficha-ir-ate').disabled = !pos;
    if ($('ficha-menu').atualizarGatilho) $('ficha-menu').atualizarGatilho();

    // Pedido de ajuda
    var ajuda = temAjuda(p);
    var caixaAjuda = $('ficha-alerta');
    caixaAjuda.hidden = !ajuda;
    if (ajuda && ajuda.pedido) {
      caixaAjuda.innerHTML = '';
      var AP = window.AjudaPedidos, pd = ajuda.pedido;
      caixaAjuda.appendChild(UI.el('div', { classe: 'nota nota-ajuda' }, [
        UI.el('strong', { texto: 'PEDIU AJUDA às ' + C.hora(pd.recebido_em) + ' · ' + ((AP.ESTADOS[pd.estado] || {}).rotulo || pd.estado) + '. ' }),
        pd.estado === 'recebido' ? 'Ninguém assumiu há ' + AP.duracao(C.agora() - C.paraMs(pd.recebido_em)) + '. ' : (pd.assumido_por_nome ? 'Responsável: ' + pd.assumido_por_nome + '. ' : ''),
        pd.lat != null ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Ver no mapa', onclick: function () { est.mapa.setView([pd.lat, pd.lng], Math.max(est.mapa.getZoom(), 17)); } }) : null,
        ' ',
        UI.el('button', { classe: 'btn btn-pequeno btn-escuro', type: 'button', texto: pd.estado === 'recebido' ? 'Assumir / tratar' : 'Abrir atendimento', onclick: function () { AP.abrir(pd.id); } }),
      ]));
    } else if (ajuda) {
      caixaAjuda.innerHTML = '';
      caixaAjuda.appendChild(UI.el('div', { classe: 'nota nota-ajuda' }, [
        UI.el('strong', { texto: 'PEDIU AJUDA às ' + C.hora(ajuda.direcao === 'entrada' ? ajuda.criada_em : ajuda.confirmada_em) + '. ' }),
        ajuda.direcao === 'entrada'
          ? 'Pelo botão "Preciso de ajuda"' + (ajuda.lat != null ? ', com a localização. ' : ' (sem localização). ')
          : 'Em resposta a: ' + (C.TIPOS_MENSAGEM[ajuda.tipo] || {}).rotulo + '. ',
        ajuda.direcao === 'entrada' && ajuda.lat != null
          ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Ver no mapa', onclick: function () { verRelatoNoMapa(ajuda); } }) : null,
        ' ',
        UI.el('button', {
          classe: 'btn btn-pequeno', type: 'button', texto: 'Marcar como atendido',
          onclick: function () {
            est.ajudaVista.add(ajuda.id);
            C.local.gravar(CHAVE_AJUDA_VISTA, Array.from(est.ajudaVista).slice(-500));
            atualizarEstados();
          },
        }),
      ]));
    }

    // Comandos
    var podeEnviar = est.op.status === 'ativa' && !d.removido && !eu;
    $('ficha-comandos').querySelectorAll('button').forEach(function (b) { b.disabled = !podeEnviar; });
    $('ficha-cmd-rapidos').hidden = eu || !podeEnviar;
    var aviso = $('ficha-cmd-aviso');
    aviso.hidden = !eu && podeEnviar && (e.cod === 'conectado' || e.cod === 'instavel' || e.cod === 'parado');
    aviso.textContent = eu
      ? 'Esta é a sua ficha: sua localização vai automaticamente para os outros responsáveis.'
      : !podeEnviar ? 'Envio indisponível: ' + (d.removido ? 'participante removido.' : 'operação encerrada.')
      : ehResp ? 'Painel dele fechado: a mensagem chega quando ele abrir a operação.'
      : 'Sem conexão: a mensagem chega quando o celular reconectar.';
    $('ficha-msgs-titulo').textContent = eu ? 'Mensagens recebidas' : 'Mensagens';
    renderizarConversa(p);
    var formResp = $('form-resposta');
    formResp.hidden = eu || !podeEnviar;
    $('resposta-texto').placeholder = 'Mensagem para ' + d.nome + '…';

    // Fotos registradas por este participante
    renderizarFotosFicha(p);
    // Grupos deste participante (papel, adicionar, remover)
    renderizarGruposFicha(p);

    // Histórico de posições (últimos 50)
    $('ficha-qtd-pontos').textContent = String(p.pontos.length);
    var linhasHist = p.pontos.slice(-50).reverse().map(function (pt) {
      return '<tr><td class="num">' + C.hora(pt.t) + '</td><td class="mono">' + C.coord(pt.lat) + '</td><td class="mono">' +
        C.coord(pt.lng) + '</td><td class="num">' + C.esc(C.precisao(pt.prec)) + '</td><td class="num">' + textoAtraso(pt) + '</td></tr>';
    }).join('');
    $('ficha-hist').innerHTML = linhasHist || '<tr><td colspan="5" class="muted">Sem posições registradas.</td></tr>';

    $('ficha-remover').hidden = d.removido || est.op.status !== 'ativa' || ehResp;
    atualizarSituacaoFicha(p);
  }

  function podeReincluirP(p) {
    return Boolean(p.dados.removido && est.op && est.op.status === 'ativa' && tipoDe(p.dados) !== 'responsavel');
  }

  // Bloco no topo da ficha: fora da operação (com o botão Reincluir) ou reincluído aguardando o celular.
  function atualizarSituacaoFicha(p) {
    var d = p.dados;
    var caixa = $('ficha-situacao');
    var assinatura = [d.removido, d.liberado_em, d.removido_em, d.reincluido_em, d.rastreando, aguardandoRetorno(p), est.op.status].join('|');
    if (caixa._assinatura === assinatura) return;
    caixa._assinatura = assinatura;
    caixa.innerHTML = '';
    caixa.className = 'ficha-bloco ficha-situacao';
    if (d.removido) {
      caixa.classList.add('fora');
      caixa.appendChild(UI.el('p', null, [UI.el('strong', { texto: estadoDe(p).rot + '.' }),
        ' O cadastro, a trilha e as mensagens continuam guardados.']));
      if (podeReincluirP(p)) {
        caixa.appendChild(UI.el('button', { classe: 'btn btn-ok', type: 'button', id: 'ficha-reincluir', texto: 'Reincluir na operação',
          onclick: function () { reincluirParticipante(p.id); } }));
      }
      caixa.hidden = false;
    } else if (aguardandoRetorno(p)) {
      caixa.classList.add('aguardando');
      caixa.appendChild(UI.el('p', null, [UI.el('strong', { texto: 'Reincluído às ' + C.hora(d.reincluido_em, false) + (d.reincluido_por_nome ? ' por ' + d.reincluido_por_nome : '') + '.' }),
        ' Aguardando o celular voltar: a página dele mostra "Os bombeiros chamaram você de volta". Se ele fechou a página, deve abrir o mesmo link no mesmo celular.']));
      caixa.hidden = false;
    } else {
      caixa.hidden = true;
    }
  }

  async function reincluirParticipante(id) {
    var p = est.participantes.get(id);
    if (!p || !podeReincluirP(p)) return;
    var r = await UI.confirmar({
      titulo: 'Reincluir ' + p.dados.nome + ' na operação?',
      texto: 'Ele volta para a lista de participantes com o mesmo cadastro e a mesma trilha (nada é duplicado). ' +
        'O celular dele mostra o aviso para voltar à busca e, com um toque, volta a enviar a localização e a receber mensagens.',
      ok: 'Reincluir',
    });
    if (!r) return;
    try {
      var row = await C.rpc('reincluir_participante', { p_participante: id });
      if (row) upsertParticipante(row);
      renderizarLista();
      atualizarMarcador(p);
      if (est.selecionado === id) atualizarFicha();
      UI.aviso(p.dados.nome + ' foi reincluído. Aguardando o celular dele voltar.', 'ok', 7000);
    } catch (e) {
      UI.aviso(e.message, 'erro');
    }
  }

  // Atraso entre a captura pelo GPS e a chegada ao servidor (diagnóstico de campo).
  function textoAtraso(pt) {
    if (!pt.rec || !pt.t) return '—';
    var s = Math.max(0, Math.round((pt.rec - pt.t) / 1000));
    return s < 60 ? s + ' s' : Math.round(s / 60) + ' min';
  }

  /* ------------------------------------------------------------------ */
  /* Mensagens                                                            */
  /* ------------------------------------------------------------------ */
  async function enviarComando(participanteId, tipo) {
    var p = est.participantes.get(participanteId);
    if (!p) return;
    var t = C.TIPOS_MENSAGEM[tipo];
    var e = estadoDe(p);
    var semConexao = !(e.cod === 'conectado' || e.cod === 'instavel' || e.cod === 'parado');
    var detalhe = UI.el('div', null, [
      UI.el('p', null, ['Destinatário: ', UI.el('strong', { texto: p.dados.nome }), ' (' + TIPOS[tipoDe(p.dados)].rotulo.toLowerCase() + ')']),
      semConexao ? UI.el('p', { classe: 'nota', texto: 'O participante está sem conexão (' + e.rot + '). A mensagem ficará aguardando e só será entregue quando o celular dele reconectar.' }) : null,
    ]);
    var r = await UI.confirmar({
      titulo: (t.critico ? 'Confirmar envio: ' : 'Enviar: ') + t.rotulo,
      detalhe: detalhe,
      campo: {
        rotulo: tipo === 'PERSONALIZADA' ? 'Mensagem' : 'Texto da orientação (pode complementar)',
        valor: t.padrao,
        max: 500,
        obrigatorio: tipo === 'PERSONALIZADA',
      },
      ok: 'ENVIAR PARA ' + p.dados.nome.toUpperCase(),
      perigo: t.critico,
    });
    if (!r) return;
    try {
      var m = await C.rpc('enviar_mensagem', { p_participante: p.id, p_tipo: tipo, p_texto: r.texto });
      receberMensagem(m, true);
      UI.aviso('Mensagem enviada. Acompanhe a entrega na ficha.', 'ok');
    } catch (err) {
      UI.aviso(err.message, 'erro');
    }
  }

  function receberMensagem(m, silencioso) {
    var antiga = est.mensagens.get(m.id);
    est.mensagens.set(m.id, m);
    var p = est.participantes.get(m.participante_id);
    if (!silencioso && m.resposta === 'PRECISO_AJUDA' && (!antiga || antiga.resposta !== 'PRECISO_AJUDA') && !est.ajudaVista.has(m.id)) {
      UI.aviso('PEDIDO DE AJUDA: ' + (p ? p.dados.nome : 'participante') + sufixoFiltro(m.participante_id), 'erro', 15000);
      alarme();
    }
    if (!silencioso && est.meuPart && m.participante_id === est.meuPart && m.direcao !== 'entrada' && !antiga && !m.confirmada_em) {
      alarme();
      try { if (navigator.vibrate) navigator.vibrate([400, 150, 400]); } catch (e) { /* ignora */ }
    }
    if (m.direcao === 'entrada') {
      // Mensagem ou relato do participante para os responsáveis.
      if (antiga && antiga.lida_em == null && m.lida_em != null) est.lidasLocal.delete(m.id);
      if (!antiga && !silencioso && m.categoria === 'AJUDA' && !est.ajudaVista.has(m.id)) {
        UI.aviso('PEDIDO DE AJUDA: ' + nomeDoParticipante(m.participante_id, m.remetente_nome) + (m.lat != null ? ' (com localização)' : '') + sufixoFiltro(m.participante_id), 'erro', 15000);
        alarme();
      } else if (!antiga && !silencioso && !m.lida_em) {
        notificarEntrada(m);
      }
      atualizarRelato(m);
      agendarCentral();
      atualizarContadorMsgs();
      if (!antiga && est.selecionado === m.participante_id && !$('ficha').hidden) marcarLidasVisiveis();
    }
    if (p) {
      atualizarAparenciaMarcador(p);
      est.listaSuja = true;
      if (est.selecionado === p.id) atualizarFicha();
    }
    verificarMensagensParaMim();
    renderizarLista();
  }

  function prepararAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !est.audio) est.audio = new AC();
    } catch (e) { /* sem áudio */ }
  }

  function alarme() {
    var ac = est.audio;
    if (!ac) return;
    try {
      if (ac.state === 'suspended') ac.resume();
      var t = ac.currentTime;
      [0, 0.3, 0.6, 0.9].forEach(function (d, i) {
        var o = ac.createOscillator(), g = ac.createGain();
        o.type = 'square';
        o.frequency.value = i % 2 ? 660 : 990;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(0.3, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.25);
        o.connect(g); g.connect(ac.destination);
        o.start(t + d); o.stop(t + d + 0.28);
      });
    } catch (e) { /* ignora */ }
  }

  async function liberarSaida(id) {
    var p = est.participantes.get(id);
    if (!p) return;
    var r = await UI.confirmar({
      titulo: 'Liberar a saída de ' + p.dados.nome + '?',
      texto: 'O celular dele para de enviar a localização e mostra "Saída liberada". A trilha já registrada continua guardada.',
      ok: 'Liberar saída',
    });
    if (!r) return;
    try {
      await C.rpc('liberar_participante', { p_participante: id });
      p.dados.liberado_em = new Date().toISOString();
      p.dados.removido = true;
      p.dados.rastreando = false;
      atualizarMarcador(p);
      atualizarFicha();
      renderizarLista();
      UI.aviso('Saída de ' + p.dados.nome + ' liberada.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro');
    }
  }

  async function recusarSaida(id) {
    var p = est.participantes.get(id);
    if (!p) return;
    var r = await UI.confirmar({
      titulo: 'Pedir para ' + p.dados.nome + ' continuar?',
      texto: 'O pedido de encerramento é cancelado e ele recebe a mensagem abaixo no celular.',
      campo: { rotulo: 'Mensagem', valor: 'Permaneça na operação até nova orientação. Seu rastreamento continua ativo.', max: 500, obrigatorio: true },
      ok: 'Enviar e manter rastreamento',
    });
    if (!r) return;
    try {
      await C.rpc('recusar_saida', { p_participante: id });
      var m = await C.rpc('enviar_mensagem', { p_participante: id, p_tipo: 'PERSONALIZADA', p_texto: r.texto });
      p.dados.saida_solicitada_em = null;
      p.dados.saida_motivo = null;
      receberMensagem(m, true);
      atualizarAparenciaMarcador(p);
      atualizarFicha();
      renderizarLista();
      UI.aviso('Pedido recusado e mensagem enviada.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro');
    }
  }

  async function removerParticipante() {
    var p = est.participantes.get(est.selecionado);
    if (!p) return;
    var r = await UI.confirmar({
      titulo: 'Remover ' + p.dados.nome + '?',
      texto: 'O participante deixa de enviar a localização e de receber mensagens. O cadastro e a trilha já registrada continuam guardados, e você pode reincluí-lo depois pela lista "Fora da operação".',
      ok: 'Remover',
      perigo: true,
    });
    if (!r) return;
    try {
      await C.rpc('remover_participante', { p_participante: p.id });
      p.dados.removido = true;
      p.dados.rastreando = false;
      p.dados.removido_em = p.dados.removido_em || new Date().toISOString();
      est.destinos.delete(p.id);
      atualizarMarcador(p);
      atualizarFicha();
      renderizarLista();
      UI.aviso('Participante removido.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Encerramento                                                         */
  /* ------------------------------------------------------------------ */
  // Antes de encerrar ou apagar: se ainda não há relatório, oferece gerar agora
  // (depois da retenção ele sai sem pessoas, trilhas e fotos).
  // Devolve true para seguir com a ação, false se o responsável foi gerar o relatório.
  async function oferecerRelatorio(op, acao, aposRelatorio) {
    if (!window.Relatorio) return true;
    var n = await window.Relatorio.quantosRelatorios(op.id);
    if (n !== 0) return true;
    var r = await UI.confirmar({
      titulo: 'Gerar o relatório final antes?',
      texto: 'Esta operação ainda não tem relatório final. ' + acao +
        ' Depois disso o relatório sai só com o cadastro, o diário e o resultado (sem pessoas, trilhas e fotos).',
      ok: 'Gerar relatório agora',
      cancelar: 'Continuar sem relatório',
    });
    if (!r) return true;
    window.Relatorio.abrirRelatorio(op, {
      aviso: 'Gere o relatório e depois feche esta janela para continuar.',
      textoFechar: 'Fechar e continuar',
      aoFechar: function () { setTimeout(aposRelatorio, 50); },
    });
    return false;
  }

  async function encerrarOperacao(jaOfereceu) {
    var op = est.op;
    if (!op || op.status !== 'ativa') return;
    if (jaOfereceu !== true && !(await oferecerRelatorio(op, 'Depois de encerrar o painel fica só para consulta.', function () { encerrarOperacao(true); }))) return;
    abrirEncerramento();
  }

  // Encerrar com o resultado da busca. "Vítima localizada" abre o mesmo formulário do botão
  // "Vítima encontrada" (ficha, condição, estado, quem encontrou e local); o resultado vai para a
  // operação (o mesmo do relatório final) e só então a operação é encerrada.
  function abrirEncerramento(pre) {
    var op = est.op;
    if (!op || op.status !== 'ativa') return;
    pre = pre || {};
    var regs = Array.from(est.vitimasLoc.values()).sort(function (a, b) { return String(a.registrado_em).localeCompare(String(b.registrado_em)); });
    var ultimo = regs[regs.length - 1] || null;
    var OPCOES = [
      ['localizada', 'Vítima localizada', ultimo
        ? 'já registrada' + (regs.length > 1 ? ' (' + regs.length + ' registros)' : '') + ': ' + CONDICAO_VITIMA[ultimo.condicao].toLowerCase() + (ultimo.local_descricao ? ' · ' + ultimo.local_descricao : '')
        : 'em seguida: ficha, condição e local'],
      ['nao_localizada', 'Vítima não localizada', ''],
      ['outro', 'Outro desfecho', 'descreva abaixo'],
      ['sem', 'Sem informar agora', 'dá para informar no relatório'],
    ];
    var inicial = pre.escolha || (op.resultado === 'nao_localizada' ? 'nao_localizada' : op.resultado === 'outro' ? 'outro' : ultimo || /^localizada/.test(op.resultado || '') ? 'localizada' : null);
    var opcoes = UI.el('div', { classe: 'opcoes-resultado', role: 'radiogroup', 'aria-label': 'Resultado da busca' }, OPCOES.map(function (o) {
      return UI.el('label', { classe: 'opcao-resultado', 'data-resultado': o[0] }, [
        UI.el('input', { type: 'radio', name: 'enc-resultado', value: o[0], checked: inicial === o[0] ? true : null }),
        UI.el('span', null, [UI.el('strong', { texto: o[1] }), o[2] ? UI.el('small', { classe: 'muted', texto: o[2] }) : null]),
      ]);
    }));
    var outraVitima = UI.el('input', { type: 'checkbox', id: 'enc-outra-vitima' });
    var blocoOutra = ultimo ? UI.el('label', { classe: 'linha-opcao enc-outra' }, [outraVitima, ' Registrar outra vítima encontrada agora']) : null;
    var texto = UI.el('textarea', { classe: 'campo', id: 'enc-texto', rows: '3', maxlength: '4000', placeholder: 'Resumo do desfecho: onde, quando e em que condições; encaminhamentos.' });
    texto.value = pre.texto != null ? pre.texto : op.resultado_texto || '';
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-primario', type: 'submit', id: 'enc-confirmar', texto: 'Encerrar operação' });
    function escolha() { return (form.querySelector('input[name="enc-resultado"]:checked') || {}).value || null; }
    function atualizar() {
      var e = escolha();
      if (blocoOutra) blocoOutra.hidden = e !== 'localizada';
      var registrar = e === 'localizada' && (!ultimo || outraVitima.checked);
      btn.textContent = registrar ? 'Registrar a vítima…' : 'Encerrar operação';
      texto.parentNode.hidden = e === 'sem';
    }
    var form = UI.el('form', { classe: 'form-encerrar form-padrao', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Encerrar operação' },
        [UI.dica('Os celulares param de enviar localização e os links deixam de funcionar. Nada é apagado: o painel fica só para consulta. O desfecho aparece no relatório.')]),
      UI.secao('Resultado da busca', [opcoes, blocoOutra]),
      UI.campo('Desfecho', texto, { para: 'enc-texto', largo: true }),
      erro,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    opcoes.addEventListener('change', atualizar);
    outraVitima.addEventListener('change', atualizar);
    atualizar();
    var fechar = UI.abrirModal(form, { fecharNoFundo: false });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var e = escolha(), t = texto.value.trim();
      if (!e) { erro.textContent = 'Escolha o resultado da busca (ou "Encerrar sem informar o resultado").'; erro.hidden = false; return; }
      if (e === 'outro' && !t) { erro.textContent = 'Descreva o desfecho.'; erro.hidden = false; texto.focus(); return; }
      if (e === 'localizada' && (!ultimo || outraVitima.checked)) {
        // o mesmo formulário do botão "Vítima encontrada"; ao registrar, segue o encerramento
        fechar();
        abrirRegistroVitima({
          aoRegistrar: function (r, condicao) { concluirEncerramento(condicao === 'obito' ? 'localizada_obito' : 'localizada_viva', t); },
          aoVoltar: function () { abrirEncerramento({ escolha: e, texto: texto.value }); },
        });
        return;
      }
      fechar();
      var res = e === 'localizada' ? (ultimo.condicao === 'obito' ? 'localizada_obito' : 'localizada_viva') : e === 'sem' ? null : e;
      concluirEncerramento(res, t);
    });
  }

  async function concluirEncerramento(resultado, texto) {
    var op = est.op;
    if (!op || op.status !== 'ativa') return;
    try {
      if (resultado) Object.assign(est.op, await C.rpc('definir_resultado', { p_operacao: op.id, p_resultado: resultado, p_texto: texto || '' }));
    } catch (e) {
      UI.aviso('Resultado não registrado (' + e.message + '). A operação NÃO foi encerrada: tente de novo.', 'erro', 10000);
      return;
    }
    try {
      var atual = await C.rpc('encerrar_operacao', { p_operacao: op.id });
      est.op = Object.assign(est.op, atual);
      renderizarCabecalho();
      if (est.op.dados_apagados_em) {
        limparDadosDoMapa();
        var arq = await limparArquivosPendentes();
        if (arq.falhas) UI.aviso(textoFalhaArquivos(arq.falhas), 'erro', 12000);
      } else {
        atualizarEstados();
      }
      UI.aviso('Operação encerrada' + (resultado ? ' com o resultado registrado.' : '.'), 'ok', 7000);
    } catch (e) {
      UI.aviso((resultado ? 'O resultado foi registrado, mas a operação não foi encerrada: ' : '') + e.message, 'erro', 10000);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Convite: links e QR Code                                             */
  /* ------------------------------------------------------------------ */
  function linkPara(token) {
    var u = new URL('civil.html', location.href);
    u.search = '';
    u.hash = 't=' + token;
    return u.href;
  }

  function abrirConvite() {
    var op = est.op;
    if (!op || op.status !== 'ativa') return;
    var links = { civil: linkPara(op.token_civil), militar: linkPara(op.token_militar) };
    var atual = 'civil';

    var entrada = UI.el('input', { classe: 'campo', readonly: true, 'aria-label': 'Link de convite' });
    var qr = UI.el('div', { classe: 'qr', 'aria-label': 'QR Code do link' });
    var nota = UI.el('p', { classe: 'nota' });
    var abaCivil = UI.el('button', { classe: 'btn btn-ativo', type: 'button', texto: '● Link para CIVIS' });
    var abaMil = UI.el('button', { classe: 'btn', type: 'button', id: 'aba-convite-bombeiros', texto: '■ Link para BOMBEIROS' });
    var abaWhats = window.Convites ? UI.el('button', { classe: 'btn', type: 'button', id: 'aba-convite-whatsapp', texto: '☎ WhatsApp' }) : null;
    var abaEmail = window.Convites ? UI.el('button', { classe: 'btn', type: 'button', id: 'aba-convite-email', texto: '✉ E-mail' }) : null;
    var caixaLink = UI.el('div', { classe: 'link-caixa' });
    var paineis = { whatsapp: abaWhats ? window.Convites.painel('whatsapp') : null, email: abaEmail ? window.Convites.painel('email') : null };
    Object.keys(paineis).forEach(function (k) { if (paineis[k]) paineis[k].hidden = true; });

    function mostrar(tipo) {
      var convite = tipo === 'email' || tipo === 'whatsapp';
      if (!convite) atual = tipo;
      if (!convite) entrada.value = links[tipo];
      abaCivil.className = 'btn' + (tipo === 'civil' ? ' btn-ativo' : '');
      abaMil.className = 'btn' + (tipo === 'militar' ? ' btn-ativo' : '');
      if (abaWhats) abaWhats.className = 'btn' + (tipo === 'whatsapp' ? ' btn-ativo' : '');
      if (abaEmail) abaEmail.className = 'btn' + (tipo === 'email' ? ' btn-ativo' : '');
      caixaLink.hidden = qr.hidden = nota.hidden = convite;
      Object.keys(paineis).forEach(function (k) { if (paineis[k]) paineis[k].hidden = k !== tipo; });
      if (convite) return;
      nota.textContent = tipo === 'civil'
        ? 'Quem entrar por este link aparece como civil.'
        : 'Só para bombeiros: quem entrar por este link se identifica como militar.';
      if (window.qrcode) {
        try {
          var q = window.qrcode(0, 'M');
          q.addData(links[tipo]);
          q.make();
          qr.innerHTML = q.createSvgTag({ cellSize: 6, margin: 4, scalable: true, title: 'QR Code — link para ' + (tipo === 'civil' ? 'civis' : 'bombeiros') });
        } catch (e) { qr.textContent = 'Não foi possível gerar o QR Code.'; }
      } else {
        qr.textContent = 'QR Code indisponível (biblioteca não carregada).';
      }
    }

    async function copiar() {
      try {
        await navigator.clipboard.writeText(entrada.value);
        UI.aviso('Link copiado.', 'ok');
      } catch (e) {
        entrada.select();
        try { document.execCommand('copy'); UI.aviso('Link copiado.', 'ok'); } catch (e2) { UI.aviso('Copie o link manualmente.', 'erro'); }
      }
    }

    async function compartilhar() {
      try {
        await navigator.share({
          title: 'Operação ' + op.codigo,
          text: 'Operação de busca "' + op.codigo + '" — abra o link para compartilhar sua localização com a equipe do Corpo de Bombeiros:',
          url: entrada.value,
        });
      } catch (e) { /* cancelado */ }
    }

    abaCivil.addEventListener('click', function () { mostrar('civil'); });
    abaMil.addEventListener('click', function () { mostrar('militar'); });
    if (abaEmail) abaEmail.addEventListener('click', function () { mostrar('email'); });
    if (abaWhats) abaWhats.addEventListener('click', function () { mostrar('whatsapp'); });

    var botoes = [UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Copiar', onclick: copiar })];
    if (navigator.share) botoes.push(UI.el('button', { classe: 'btn', type: 'button', texto: 'Compartilhar', onclick: compartilhar }));
    [entrada].concat(botoes).forEach(function (n) { caixaLink.appendChild(n); });

    var fechar = UI.abrirModal(UI.el('div', { classe: 'form-padrao' }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Convidar' }, [UI.dica('Os links de civis e de bombeiros não dão acesso ao painel: só servem para entrar na operação como participante. Responsável convidado entra pelo painel, com a própria conta.')]),
      UI.el('div', { classe: 'abas' }, [abaCivil, abaMil, abaWhats, abaEmail]),
      caixaLink,
      qr,
      nota,
      paineis.whatsapp,
      paineis.email,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]));
    mostrar(atual);
  }

  /* ------------------------------------------------------------------ */
  /* Mensagens e relatos recebidos dos participantes                      */
  /* ------------------------------------------------------------------ */
  function jaLida(m) {
    return Boolean(m.lida_em) || est.lidasLocal.has(m.id);
  }

  function naoLidas() {
    var lista = [];
    est.mensagens.forEach(function (m) { if (m.direcao === 'entrada' && !jaLida(m)) lista.push(m); });
    return lista;
  }

  function naoLidasDe(pid) {
    return naoLidas().filter(function (m) { return m.participante_id === pid; });
  }

  function nomeDoParticipante(pid, reserva) {
    var p = est.participantes.get(pid);
    return p ? nomeExibido(p) : (reserva || 'Participante');
  }

  function resumir(t, n) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  function atualizarContadorMsgs() {
    var n = est.op ? naoLidas().length : 0;
    var c = $('contador-msgs');
    if (c) {
      c.textContent = n > 99 ? '99+' : String(n);
      c.hidden = !n;
    }
    var b = $('btn-mensagens');
    if (b) {
      b.classList.toggle('tem-novas', n > 0);
      b.title = n ? n + ' mensagem(ns) ou relato(s) não lido(s)' : 'Mensagens, relatos e fotos dos participantes';
    }
    atualizarTitulo();
    atualizarBotaoReabrir();
  }

  // Aviso visual + sonoro de mensagem nova. Várias de uma vez (ex.: reconexão) viram um aviso só.
  function notificarEntrada(m) {
    est.filaNotif.push(m);
    clearTimeout(est.timerNotif);
    est.timerNotif = setTimeout(descarregarNotificacoes, 400);
  }

  function descarregarNotificacoes() {
    var fila = est.filaNotif.filter(function (m) { return !jaLida(m); });
    est.filaNotif = [];
    if (!fila.length || !est.op) return;
    var texto;
    if (fila.length === 1) {
      var m = fila[0];
      var cat = CATEGORIAS[m.categoria] || CATEGORIAS.MENSAGEM;
      var relato = m.categoria && m.categoria !== 'MENSAGEM';
      texto = (relato ? 'RELATO (' + cat.rotulo + ') de ' : 'Mensagem de ') + nomeDoParticipante(m.participante_id, m.remetente_nome) +
        ': ' + resumir(m.texto, 140);
    } else {
      texto = fila.length + ' novas mensagens/relatos dos participantes.';
    }
    avisoClicavel(texto + ' Toque para abrir.', function () {
      if (fila.length === 1) abrirConversa(fila[0].participante_id);
      else abrirCentral('msgs');
    });
    bipeMensagem();
    var b = $('btn-mensagens');
    b.classList.remove('pulsar');
    void b.offsetWidth;
    b.classList.add('pulsar');
  }

  function avisoClicavel(texto, acao) {
    var a = UI.aviso(texto, 'msg');
    if (!a) return;
    a.classList.add('clicavel');
    a.setAttribute('tabindex', '0');
    a.addEventListener('click', function () { if (a.parentNode) a.parentNode.removeChild(a); acao(); });
    // Enter no botão de fechar só fecha: não abre a conversa
    a.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && ev.target === a) { ev.preventDefault(); a.click(); } });
  }

  function bipeMensagem() {
    var ac = est.audio;
    if (!ac) return;
    try {
      if (ac.state === 'suspended') ac.resume();
      var t = ac.currentTime;
      [0, 0.18].forEach(function (d, i) {
        var o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine';
        o.frequency.value = i ? 1175 : 880;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(0.25, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.16);
        o.connect(g); g.connect(ac.destination);
        o.start(t + d); o.stop(t + d + 0.18);
      });
    } catch (e) { /* ignora */ }
  }

  // Marca como lidas as mensagens que estão sendo vistas (central aberta ou
  // conversa do participante aberta na ficha). O participante vê "Lida por …".
  function marcarLidasVisiveis() {
    if (!est.op || document.visibilityState === 'hidden') return;
    var centralAberta = !$('central').hidden && est.centralAba === 'msgs';
    var fichaDe = !$('ficha').hidden ? est.selecionado : null;
    if (!centralAberta && !fichaDe) return;
    var ids = [];
    naoLidas().forEach(function (m) {
      if ((centralAberta || m.participante_id === fichaDe) && !est.marcandoLidas.has(m.id)) ids.push(m.id);
    });
    if (centralAberta) ids.forEach(function (id) { est.destaqueNovas.add(id); });
    marcarLidas(ids);
  }

  function marcarLidas(ids) {
    ids = ids.filter(function (id) { return !est.marcandoLidas.has(id); });
    if (!ids.length) return;
    ids.forEach(function (id) { est.lidasLocal.add(id); est.marcandoLidas.add(id); });
    atualizarContadorMsgs();
    est.listaSuja = true;
    renderizarLista();
    est.participantes.forEach(atualizarAparenciaMarcador);
    C.rpc('marcar_lidas', { p_ids: ids }).then(function () {
      var agora = new Date().toISOString();
      ids.forEach(function (id) {
        var m = est.mensagens.get(id);
        if (m && !m.lida_em) { m.lida_em = agora; m.lida_por_nome = est.responsavel ? est.responsavel.nome : null; }
      });
      agendarCentral();
      if (est.selecionado) atualizarFicha();
    }).catch(function () {
      // sem conexão: volta a contar como não lida e tenta de novo depois
      ids.forEach(function (id) { est.lidasLocal.delete(id); });
      atualizarContadorMsgs();
    }).then(function () {
      ids.forEach(function (id) { est.marcandoLidas.delete(id); });
    });
  }

  /* ---------- Relatos com localização no mapa ------------------------ */
  function iconeRelato(m) {
    var cat = CATEGORIAS[m.categoria] || CATEGORIAS.MENSAGEM;
    return L.divIcon({
      className: 'mk-relato-wrap',
      html: '<div class="mk-relato cat-' + C.esc(m.categoria || 'MENSAGEM') + '"><span>' + C.esc(cat.letra) + '</span></div>',
      iconSize: [30, 30],
      iconAnchor: [15, 30],
    });
  }

  function atualizarRelato(m) {
    if (!est.camadaPontos) return;
    // No mapa só os relatos e pedidos de ajuda; mensagens comuns ficam na conversa
    // (com "Ver no mapa" quando têm localização), para não poluir o mapa.
    var tem = m.direcao === 'entrada' && m.lat != null && m.lng != null && m.categoria && m.categoria !== 'MENSAGEM';
    var mk = est.relatosMarc.get(m.id);
    if (!tem) {
      if (mk) { mostrarPonto(mk, false); est.relatosMarc.delete(m.id); }
      return;
    }
    if (mk) return;
    var cat = CATEGORIAS[m.categoria] || CATEGORIAS.MENSAGEM;
    mk = L.marker([m.lat, m.lng], {
      icon: iconeRelato(m),
      keyboard: true,
      title: cat.rotulo + ' — ' + nomeDoParticipante(m.participante_id, m.remetente_nome) + ' às ' + C.hora(m.criada_em, false),
      alt: cat.rotulo,
      pane: 'pontos',        // participantes ficam por cima
      tipoPonto: 'relato',
      critico: m.categoria === 'AJUDA',
      vitima: m.categoria === 'VITIMA',   // vítima localizada: agrupa como os demais, mas o grupo mostra a marca de vítima
    });
    ligarCliquesMapa(mk, {
      info: function () {
        if (m.categoria === 'VITIMA') return infoVitimaLocalizada(m, mk);
        return { latlng: mk.getLatLng(), titulo: cat.rotulo, sub: nomeDoParticipante(m.participante_id, m.remetente_nome) + ' · ' + C.hora(m.criada_em, false),
          texto: resumoTexto(m.texto, 90), deslocY: -10 };
      },
      detalhes: function () { abrirRelato(m.id); },
    });
    est.relatosMarc.set(m.id, mk);
    mostrarPonto(mk, Boolean(est.prefsMapa.relatos));
  }

  function destacarNoMapa(grupo, mk, lat, lng) {
    if (!est.mapa) return;
    if (telaPequena()) { fecharCentral(); if (!$('ficha').hidden) fecharFicha(); }
    UI.fecharModal();
    function piscar() {
      var el = mk && mk.getElement && mk.getElement();
      if (!el) return;
      el.classList.add('destaque');
      setTimeout(function () { el.classList.remove('destaque'); }, 3500);
    }
    if (mk && grupo && grupo.zoomToShowLayer && est.mapa.hasLayer(grupo)) {
      grupo.zoomToShowLayer(mk, function () { est.mapa.panTo([lat, lng]); setTimeout(piscar, 300); });
    } else {
      est.mapa.setView([lat, lng], Math.max(est.mapa.getZoom(), 17));
      setTimeout(piscar, 300);
    }
  }

  function verRelatoNoMapa(m) {
    if (m.lat == null) return;
    if (!est.prefsMapa.relatos) definirPrefMapa('relatos', true);
    var mkR = est.relatosMarc.get(m.id);
    destacarNoMapa(mkR && camadaDoPonto(mkR), mkR, m.lat, m.lng);
  }

  // Balão do marcador da vítima localizada: o nome da vítima, a condição e o que se sabe do achado
  function infoVitimaLocalizada(m, mk) {
    var reg = registroDaMensagem(m);
    if (!reg) return { latlng: mk.getLatLng(), titulo: 'Vítima localizada', sub: C.hora(m.criada_em, false), texto: 'Carregando os detalhes…', deslocY: -10 };
    var f = reg.vitima_id ? est.fichas.get(reg.vitima_id) : null;
    var enc = quemEncontrou(reg);
    var linhas = [
      'Condição: ' + CONDICAO_VITIMA[reg.condicao],
      enc ? 'Encontrada por ' + nomeExibido(enc) : reg.encontrada_por_texto ? 'Encontrada por ' + reg.encontrada_por_texto : 'Registrada por ' + reg.registrado_por_nome,
      reg.local_descricao ? 'Local: ' + resumoTexto(reg.local_descricao, 70) : null,
      f && f.cadastro_rapido ? 'Cadastro rápido: falta completar a ficha' : null,
    ].filter(Boolean);
    return { latlng: mk.getLatLng(), titulo: f ? textoFicha(f) : 'Vítima localizada', sub: 'Localizada às ' + C.hora(reg.posicao_em || reg.registrado_em, false), texto: linhas.join('\n'), deslocY: -10, botao: 'O que aconteceu ›' };
  }

  // Tudo sobre a vítima localizada: quem é, a condição, quem encontrou, onde, e quem estava perto
  function abrirVitimaLocalizada(m) {
    var reg = registroDaMensagem(m);
    var f = reg && reg.vitima_id ? est.fichas.get(reg.vitima_id) : null;
    var enc = reg ? quemEncontrou(reg) : null;
    var op = est.op;
    var dl = UI.el('dl', { classe: 'kv-grade vit-loc-dados' });
    function kv(rot, valor, largo) {
      dl.appendChild(UI.el('div', { classe: 'kv' + (largo ? ' kv-largo' : '') }, [UI.el('dt', { texto: rot }), UI.el('dd', { classe: valor ? null : 'kv-vazio' }, [valor || 'não informado'])]));
    }
    var corpo = [UI.el('h2', { id: 'modal-titulo', texto: f ? f.nome : 'Vítima localizada' })];
    if (!reg) {
      corpo.push(UI.el('p', { classe: 'muted', texto: est.semVitimaLoc ? 'Detalhes indisponíveis: falta a migração 011 no Supabase.' : 'Carregando os detalhes…' }));
    } else {
      corpo.push(UI.el('div', { classe: 'acoes-linha vit-loc-selos' }, [
        seloCondicaoReg(reg),
        f && f.cadastro_rapido ? UI.el('span', { classe: 'selo selo-alerta', texto: 'Cadastro rápido: completar' }) : null,
        !f ? UI.el('span', { classe: 'selo selo-neutro', texto: 'Sem ficha' }) : null,
      ]));
      var pos = reg.lat != null ? { lat: reg.lat, lng: reg.lng } : null;
      var quando = reg.posicao_em || reg.registrado_em;
      var setor = pos ? setorDoPonto(pos.lat, pos.lng) : null;
      var ulv = pos && op.local_lat != null ? C.distancia(op.local_lat, op.local_lng, pos.lat, pos.lng) : null;
      var inicio = op.acionado_em ? C.paraMs(op.acionado_em) : null;
      kv('Vítima', f ? textoFicha(f) : '');
      kv('Localizada', C.hora(quando) + ' (' + C.idade(quando) + ')');
      kv('Encontrada por', enc ? nomeExibido(enc) + ' (' + TIPOS[tipoDe(enc.dados)].rotulo.toLowerCase() + ')' : reg.encontrada_por_texto || '');
      kv('Registrada por', reg.registrado_por_nome.replace(/\s*\(encontrada por [^)]*\)\s*$/, '') + ' às ' + C.hora(reg.registrado_em, false));
      kv('Local', reg.local_descricao || '', true);
      kv('Coordenadas', pos ? C.coord(pos.lat) + ', ' + C.coord(pos.lng) + ' (' + C.precisao(reg.precisao) + ')' : '', true);
      kv('Setor', pos ? (setor ? setor.nome : 'fora dos setores desenhados') : '');
      kv('Do último local visto', ulv != null ? formatarComprimento(ulv) : '');
      kv('Depois do início', inicio && C.paraMs(quando) >= inicio ? textoMin(Math.round((C.paraMs(quando) - inicio) / 60000)) : '');
      kv('Estado e encaminhamento', reg.observacoes || '', true);
      // Participantes: quem estava perto na última posição conhecida
      if (pos) {
        var perto = [];
        est.participantes.forEach(function (p) {
          if (p.dados.removido || (enc && p.id === enc.id) || tipoDe(p.dados) === 'responsavel') return;
          var pp = posicaoAtual(p);
          if (!pp) return;
          var d = C.distancia(pos.lat, pos.lng, pp.lat, pp.lng);
          if (d <= 300) perto.push({ p: p, d: d, pp: pp });
        });
        perto.sort(function (a, b) { return a.d - b.d; });
        var lista = perto.length ? UI.el('ul', { classe: 'lista-perto' }, perto.map(function (x) {
          var gr = gruposDe(x.p.id).map(function (g) { return g.nome; }).join(', ');
          return UI.el('li', null, [
            UI.el('strong', { texto: nomeExibido(x.p) }),
            UI.el('small', { classe: 'muted', texto: TIPOS[tipoDe(x.p.dados)].rotulo + (gr ? ' · ' + gr : '') + ' · a ' + formatarComprimento(x.d) + ' · posição ' + C.idade(x.pp.t) }),
            UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Ficha', onclick: function () { fechar(); selecionar(x.p.id); } }),
          ]);
        })) : UI.el('p', { classe: 'muted', texto: 'Ninguém com posição conhecida a menos de 300 m.' });
        corpo.push(dl, UI.secao('Participantes', [
          enc ? UI.el('p', null, [UI.el('strong', { texto: nomeExibido(enc) }), ' encontrou a vítima ', UI.el('button', { classe: 'btn btn-pequeno btn-link', type: 'button', texto: 'ver ficha', onclick: function () { fechar(); selecionar(enc.id); } })]) : null,
          UI.el('p', { classe: 'muted', texto: 'Perto do local (até 300 m, pela última posição):' }),
          lista,
        ]));
      } else {
        corpo.push(dl);
      }
    }
    var fechar = UI.abrirModal(UI.el('div', { classe: 'visor-vitima-loc' }, corpo.concat([
      compactarAcoes(UI.rodape([
        f && window.Cadastro ? UI.el('button', { classe: 'btn' + (f.cadastro_rapido ? ' btn-primario' : ''), type: 'button', id: 'vitloc-ficha', texto: f.cadastro_rapido ? 'Completar a ficha' : 'Abrir a ficha', onclick: function () {
          fechar();
          window.Cadastro.abrirFichaPorId(op, f.id, { editavel: podeAlterar(), limparArquivos: limparArquivosPendentes, aoMudar: carregarFichas });
        } }) : null,
        m.lat != null ? UI.el('button', { classe: 'btn', type: 'button', texto: 'Ver no mapa', onclick: function () { fechar(); verRelatoNoMapa(m); } }) : null,
        reg && window.SCI ? UI.el('button', { classe: 'btn', type: 'button', id: 'vitloc-sci', texto: 'Abrir no SCI', onclick: function () {
          fechar(); try { localStorage.setItem('gbs-sci-aba', 'vitimas'); } catch (e) { /* abre na última aba */ } abrirSci();
        } }) : null,
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ])),
    ])));
    // no quadro do SCI: número, quadro (ACV, transportada) e triagem
    if (reg && !est.semSci) {
      C.consultar(C.cliente.from('sci_vitimas').select('numero,fase,triagem,destino').eq('localizacao_id', reg.id).maybeSingle()).then(function (sv) {
        var alvo = document.querySelector('.visor-vitima-loc .vit-loc-selos');
        if (!sv || !alvo) return;
        var fases = { localizada: 'localizada, aguardando remoção', removida: 'na ACV', transportada: 'transportada' + (sv.destino ? ' — ' + sv.destino : '') };
        var tri = { verde: 'verde', amarelo: 'amarela', vermelho: 'vermelha', cinza: 'cinza (óbito)' };
        alvo.appendChild(UI.el('span', { classe: 'selo selo-neutro', texto: 'SCI: V-' + (sv.numero < 10 ? '0' : '') + sv.numero + ' · ' + fases[sv.fase] + (sv.triagem ? ' · triagem ' + tri[sv.triagem] : '') }));
      }).catch(function (e) { if (ehTabelaAusente(e)) est.semSci = true; });
    }
  }

  function abrirRelato(id) {
    var m = est.mensagens.get(id);
    if (!m) return;
    if (m.categoria === 'VITIMA') { marcarLidas([m.id]); abrirVitimaLocalizada(m); return; }
    var p = est.participantes.get(m.participante_id);
    var cat = CATEGORIAS[m.categoria] || CATEGORIAS.MENSAGEM;
    marcarLidas([m.id]);
    var RR = window.RelatosRevisao;
    var revisavel = Boolean(RR && RR.disponivel() && RR.ehRelato(m));
    var dl = UI.el('dl', { classe: 'dados' });
    function linha(rot, valor) { dl.appendChild(UI.el('dt', { texto: rot })); dl.appendChild(UI.el('dd', null, [valor])); }
    linha('Enviado por', nomeDoParticipante(m.participante_id, m.remetente_nome) + (p ? ' (' + TIPOS[tipoDe(p.dados)].rotulo.toLowerCase() + ')' : ''));
    if (!revisavel) linha('Horário', C.hora(m.criada_em) + ' (' + C.idade(m.criada_em) + ')');
    linha('Latitude', C.coord(m.lat));
    linha('Longitude', C.coord(m.lng));
    linha('Precisão', C.precisao(m.precisao));
    if (m.posicao_em) linha('Posição GPS obtida às', C.hora(m.posicao_em));
    linha('Leitura', m.lida_em ? 'Lida por ' + (m.lida_por_nome || 'responsável') + ' às ' + C.hora(m.lida_em, false) : 'Lida agora por você');
    var ultRev = revisavel ? RR.ultima(m.id) : null;
    var fechar = UI.abrirModal(UI.el('div', { classe: 'visor-relato' }, [
      UI.el('h2', { id: 'modal-titulo', texto: m.categoria && m.categoria !== 'MENSAGEM' ? 'Relato: ' + cat.rotulo : 'Mensagem com localização' }),
      m.categoria === 'VITIMA' ? seloCondicao(m) : null,
      revisavel ? UI.el('div', { classe: 'acoes-linha' }, [RR.selo(m)]) : null,
      UI.el('p', { classe: 'relato-texto', texto: m.texto }),
      ultRev && ultRev.nota ? UI.el('p', { classe: 'revisao-nota', texto: ultRev.revisado_por_nome + ': ' + ultRev.nota }) : null,
      revisavel ? RR.horarios(m) : null,
      dl,
      revisavel ? RR.historico(m) : null,
      compactarAcoes(UI.rodape([
        revisavel && podeAlterar() ? UI.el('button', { classe: 'btn btn-escuro', type: 'button', id: 'relato-revisar', texto: 'Revisar', onclick: function () { fechar(); RR.abrir(m, { aoSalvar: function () { abrirRelato(m.id); } }); } }) : null,
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Ver no mapa', onclick: function () { fechar(); verRelatoNoMapa(m); } }),
        p ? UI.el('button', { classe: 'btn' + (revisavel && podeAlterar() ? '' : ' btn-escuro'), type: 'button', texto: 'Abrir conversa', onclick: function () { abrirConversa(m.participante_id); } }) : null,
        podeAlterar() ? UI.el('button', { classe: 'btn', type: 'button', id: 'relato-ponto', texto: 'Registrar como ponto de interesse', onclick: function () { fechar(); pontoDoRelato(m); } }) : null,
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ])),
    ]));
  }

  /* ---------- Conversa na ficha ------------------------------------ */
  function renderizarConversa(p) {
    var msgs = [];
    est.mensagens.forEach(function (m) { if (m.participante_id === p.id) msgs.push(m); });
    msgs.sort(function (a, b) { return C.paraMs(a.criada_em) - C.paraMs(b.criada_em); });
    var cod = estadoDe(p).cod;
    var assinatura = p.id + '|' + cod + '|' + msgs.map(function (m) {
      return m.id + ':' + (m.entregue_em || '') + (m.confirmada_em || '') + (m.resposta || '') + (jaLida(m) ? 'L' : '') + (m.lida_por_nome || '') +
        (est.vitimasLoc.has(m.id) ? 'V' : '');
    }).join(',');
    if (assinatura === est.assinaturaConversa) return;
    var primeira = est.assinaturaConversa.split('|')[0] !== p.id;
    est.assinaturaConversa = assinatura;
    var ul = $('ficha-msgs');
    var noFim = ul.scrollHeight - ul.scrollTop - ul.clientHeight < 40;
    ul.innerHTML = '';
    if (!msgs.length) ul.appendChild(UI.el('li', { classe: 'muted vazio', texto: 'Nenhuma mensagem.' }));
    msgs.forEach(function (m) {
      if (m.direcao === 'entrada') {
        var cat = CATEGORIAS[m.categoria] || CATEGORIAS.MENSAGEM;
        var relato = m.categoria && m.categoria !== 'MENSAGEM';
        ul.appendChild(UI.el('li', { classe: 'entrada' + (relato ? ' relato' : '') + (jaLida(m) ? '' : ' nao-lida') }, [
          UI.el('div', { classe: 'msg-topo' }, [
            UI.el('span', { texto: relato ? 'RELATO · ' + cat.rotulo : nomeDoParticipante(m.participante_id, m.remetente_nome) }),
            UI.el('span', { classe: 'muted num', texto: C.hora(m.criada_em) }),
          ]),
          m.categoria === 'VITIMA' ? seloCondicao(m) : null,
          UI.el('div', { classe: 'msg-texto', texto: m.texto }),
          UI.el('div', { classe: 'msg-estado' }, [
            m.lat != null
              ? UI.el('button', { classe: 'btn btn-pequeno btn-link', type: 'button', texto: 'Ver no mapa (' + C.precisao(m.precisao) + ')', onclick: function () { verRelatoNoMapa(m); } })
              : UI.el('span', { classe: 'muted', texto: 'Sem localização' }),
            UI.el('span', { classe: 'muted', texto: m.lida_em ? '· Lida por ' + (m.lida_por_nome || 'responsável') + ' às ' + C.hora(m.lida_em, false) : '· Nova' }),
          ]),
        ]));
        return;
      }
      var t = C.TIPOS_MENSAGEM[m.tipo] || C.TIPOS_MENSAGEM.PERSONALIZADA;
      var st = estadoMensagem(m, p);
      ul.appendChild(UI.el('li', { classe: 'saida' }, [
        UI.el('div', { classe: 'msg-topo' }, [UI.el('span', { texto: t.rotulo }), UI.el('span', { classe: 'muted num', texto: C.hora(m.criada_em) })]),
        UI.el('div', { classe: 'msg-texto', texto: m.texto || t.padrao }),
        UI.el('div', { classe: 'msg-estado' }, [UI.el('span', { classe: 'selo ' + st.cls, texto: st.txt })]),
        UI.el('div', { classe: 'muted msg-autor', texto: 'Por ' + (m.remetente_nome || '—') }),
      ]));
    });
    if (primeira || noFim) ul.scrollTop = ul.scrollHeight;
  }

  function abrirConversa(pid) {
    if (!est.participantes.has(pid)) return;
    if (telaPequena()) { est.centralVoltar = !$('central').hidden; }
    selecionar(pid);
    setTimeout(function () {
      var bloco = $('ficha-conversa');
      if (bloco) bloco.scrollIntoView({ block: 'start', behavior: 'smooth' });
      var ta = $('resposta-texto');
      if (ta && !$('form-resposta').hidden) ta.focus({ preventScroll: true });
    }, 60);
  }

  // Resposta rápida (mensagem livre) sem sair da ficha.
  async function enviarResposta(ev) {
    if (ev) ev.preventDefault();
    var p = est.participantes.get(est.selecionado);
    if (!p) return;
    var ta = $('resposta-texto');
    var texto = ta.value.trim();
    if (!texto) {
      UI.aviso('Escreva a mensagem antes de enviar.', 'erro');
      ta.focus();
      return;
    }
    var btn = $('btn-responder');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      var m = await C.rpc('enviar_mensagem', { p_participante: p.id, p_tipo: 'PERSONALIZADA', p_texto: texto.slice(0, 500) });
      ta.value = '';
      receberMensagem(m, true);
      marcarLidas(naoLidasDe(p.id).map(function (x) { return x.id; }));
      UI.aviso('Mensagem enviada a ' + p.dados.nome + '.', 'ok');
    } catch (e) {
      UI.aviso('Mensagem não enviada: ' + e.message, 'erro', 8000);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Enviar';
    }
  }

  /* ---------- Central de comunicação (mensagens, relatos e fotos) ----- */
  function abrirCentral(aba) {
    if (!est.op) return;
    if (aba) est.centralAba = aba;
    if (telaPequena() && !$('ficha').hidden) {
      est.centralVoltar = false;
      fecharFicha();
    }
    fecharMenu(false);
    fecharAreas();
    $('central').hidden = false;
    $('btn-mensagens').setAttribute('aria-expanded', 'true');
    document.body.classList.add('central-aberta');
    mostrarAbaCentral(est.centralAba);
  }

  function fecharCentral() {
    var c = $('central');
    if (!c || c.hidden) return;
    c.hidden = true;
    $('btn-mensagens').setAttribute('aria-expanded', 'false');
    document.body.classList.remove('central-aberta');
    est.destaqueNovas = new Set();
  }

  function mostrarAbaCentral(aba) {
    est.centralAba = aba === 'fotos' || aba === 'alertas' ? aba : 'msgs';
    ['msgs', 'fotos', 'alertas'].forEach(function (a) {
      var ativa = est.centralAba === a;
      $('aba-' + a).classList.toggle('btn-ativo', ativa);
      $('aba-' + a).setAttribute('aria-selected', String(ativa));
      $('painel-' + a).hidden = !ativa;
    });
    renderizarCentral();
  }

  function agendarCentral() {
    if (est.rafCentral) return;
    est.rafCentral = requestAnimationFrame(function () {
      est.rafCentral = null;
      renderizarCentral();
    });
  }

  function renderizarCentral() {
    $('qtd-fotos').textContent = String(est.fotos.size);
    renderizarFilaFotos();
    atualizarContadorAlertas();
    if ($('central').hidden || !est.op) return;
    if (est.centralAba === 'msgs') renderizarFeed();
    else if (est.centralAba === 'alertas') renderizarAlertas();
    else renderizarGaleria();
    marcarLidasVisiveis();
  }

  function renderizarFeed() {
    document.querySelectorAll('[data-filtro]').forEach(function (b) {
      b.classList.toggle('btn-ativo', b.getAttribute('data-filtro') === est.centralFiltro);
      b.setAttribute('aria-pressed', String(b.getAttribute('data-filtro') === est.centralFiltro));
    });
    var lista = [];
    est.mensagens.forEach(function (m) {
      if (m.direcao !== 'entrada') return;
      var relato = m.categoria && m.categoria !== 'MENSAGEM';
      if (est.centralFiltro === 'relatos' && !relato) return;
      if (est.centralFiltro === 'mensagens' && relato) return;
      lista.push(m);
    });
    lista.sort(function (a, b) { return C.paraMs(b.criada_em) - C.paraMs(a.criada_em); });
    var ul = $('feed-msgs');
    ul.innerHTML = '';
    $('feed-vazio').hidden = lista.length > 0;
    $('feed-vazio').textContent = est.centralFiltro === 'todas'
      ? 'Nenhuma mensagem dos participantes ainda. Quando alguém escrever ou relatar algo pelo link, aparece aqui.'
      : 'Nada neste filtro.';
    lista.slice(0, 300).forEach(function (m) {
      var p = est.participantes.get(m.participante_id);
      var cat = CATEGORIAS[m.categoria] || CATEGORIAS.MENSAGEM;
      var relato = m.categoria && m.categoria !== 'MENSAGEM';
      var simb = UI.el('span', { classe: 'feed-simbolo' });
      if (p) simb.innerHTML = htmlSimbolo(p);
      var topo = UI.el('div', { classe: 'feed-topo' }, [
        simb,
        UI.el('strong', { texto: nomeDoParticipante(m.participante_id, m.remetente_nome) }),
        relato ? UI.el('span', { classe: 'selo selo-relato', texto: cat.rotulo }) : null,
        relato && window.RelatosRevisao ? window.RelatosRevisao.selo(m) : null,
        UI.el('span', { classe: 'muted num feed-hora', texto: C.hora(m.criada_em, false) }),
      ]);
      var acoes = UI.el('div', { classe: 'feed-acoes' }, [
        m.lat != null ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Ver no mapa', onclick: function () { verRelatoNoMapa(m); } }) : null,
        p ? UI.el('button', { classe: 'btn btn-pequeno btn-escuro', type: 'button', texto: 'Responder', onclick: function () { abrirConversa(m.participante_id); } }) : null,
        m.categoria === 'VITIMA' || (relato && window.RelatosRevisao && window.RelatosRevisao.ehRelato(m) && window.RelatosRevisao.disponivel())
          ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: m.categoria === 'VITIMA' ? 'Detalhes' : 'Detalhes e revisão', onclick: function () { abrirRelato(m.id); } }) : null,
      ]);
      ul.appendChild(UI.el('li', { classe: 'feed-item' + (relato ? ' relato' : '') + (est.destaqueNovas.has(m.id) || !jaLida(m) ? ' nova' : ''), 'data-id': m.id }, [
        topo,
        m.categoria === 'VITIMA' ? seloCondicao(m) : null,
        UI.el('div', { classe: 'feed-texto', texto: m.texto }),
        UI.el('div', { classe: 'feed-meta', texto:
          (m.lat != null ? 'Com localização (' + C.precisao(m.precisao) + ')' : 'Sem localização') + ' · ' + C.idade(m.criada_em) +
          (m.lida_em ? ' · lida por ' + (m.lida_por_nome || 'responsável') : '') }),
        acoes,
      ]));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Fotografias georreferenciadas                                        */
  /* ------------------------------------------------------------------ */
  async function carregarFotos(silencioso) {
    var opId = est.op.id;
    var lista;
    try {
      lista = await C.consultarTudo(function () {
        return C.cliente.from('fotos').select('*').eq('operacao_id', opId).order('registrada_em', { ascending: true });
      });
    } catch (e) {
      return;   // tenta de novo na próxima conferência (não derruba o restante)
    }
    if (!est.op || est.op.id !== opId) return;
    var ids = new Set();
    lista.forEach(function (f) { ids.add(f.id); adicionarFoto(f, silencioso); });
    Array.from(est.fotos.keys()).forEach(function (id) { if (!ids.has(id)) removerFoto(id); });
  }

  function iconeFoto() {
    return L.divIcon({ className: 'mk-foto-wrap', html: '<div class="mk-foto"><span class="ico-camera"></span></div>', iconSize: [32, 32], iconAnchor: [16, 16] });
  }

  // "14/10/2026 13:56" no fuso do aparelho
  function dataHoraCurta(v) { return window.Cadastro ? window.Cadastro.dataHora(v) : C.hora(v); }

  function adicionarFoto(f, silencioso) {
    if (!est.op || f.operacao_id !== est.op.id) return;
    var antiga = est.fotos.get(f.id);
    est.fotos.set(f.id, f);
    var mk = est.fotosMarc.get(f.id);
    if (f.lat != null && f.lng != null && est.camadaPontos) {
      if (!mk) {
        mk = L.marker([f.lat, f.lng], {
          icon: iconeFoto(),
          keyboard: true,
          title: 'Foto de ' + nomeDoParticipante(f.participante_id, f.autor_nome) + ' · ' + dataHoraCurta(f.capturada_em || f.registrada_em) +
            (f.setor_nome ? ' · setor ' + f.setor_nome : ''),
          alt: 'Foto',
          pane: 'pontos',    // participantes ficam por cima
          tipoPonto: 'foto',
        });
        ligarCliquesMapa(mk, {
          info: function () {
            return { latlng: mk.getLatLng(), titulo: 'Foto', sub: nomeDoParticipante(f.participante_id, f.autor_nome) + ' · ' + dataHoraCurta(f.capturada_em || f.registrada_em),
              texto: f.setor_nome ? 'Setor ' + f.setor_nome : null, botao: 'Ver a foto ›', deslocY: -10 };
          },
          detalhes: function () { abrirFoto(f.id); },
        });
        est.fotosMarc.set(f.id, mk);
        mostrarPonto(mk, Boolean(est.prefsMapa.fotos));
      } else if (antiga && (antiga.lat !== f.lat || antiga.lng !== f.lng)) {
        mk.setLatLng([f.lat, f.lng]);
      }
    }
    if (!antiga) {
      if (!silencioso && f.participante_id !== est.meuPart) {
        avisoClicavel('Nova foto de ' + nomeDoParticipante(f.participante_id, f.autor_nome) +
          (f.lat != null ? '' : f.origem_posicao === 'pendente' ? ' (local pendente: aparece no mapa quando o GPS responder)' : ' (sem localização)') +
          (f.legenda ? ': ' + resumir(f.legenda, 80) : '') + '. Toque para ver.', function () { abrirFoto(f.id); });
        bipeMensagem();
      }
    }
    agendarCentral();
    if (est.selecionado === f.participante_id) atualizarFicha();
  }

  function removerFoto(id) {
    var mk = est.fotosMarc.get(id);
    mostrarPonto(mk, false);
    est.fotosMarc.delete(id);
    est.fotos.delete(id);
    agendarCentral();
  }

  function fotosOrdenadas(pid) {
    return Array.from(est.fotos.values())
      .filter(function (f) { return !pid || f.participante_id === pid; })
      .sort(function (a, b) { return C.paraMs(b.registrada_em) - C.paraMs(a.registrada_em); });
  }

  function miniatura(f, lista) {
    var img = UI.el('img', { alt: f.legenda || 'Foto de ' + (f.autor_nome || ''), loading: 'lazy', 'data-caminho': f.caminho, decoding: 'async' });
    var u = window.Fotos.urlEmCache(f.caminho);
    if (u) img.src = u;
    img.addEventListener('error', function () { img.parentNode && img.parentNode.classList.add('falhou'); });
    return UI.el('button', {
      classe: 'miniatura' + (f.lat == null ? ' sem-local' : ''), type: 'button',
      title: 'Foto de ' + (f.autor_nome || '') + ' — ' + C.hora(f.capturada_em || f.registrada_em),
      onclick: function () { abrirFoto(f.id, lista); },
    }, [img, f.lat == null ? UI.el('span', { classe: 'tag-sem-local', texto: 'sem local' }) : null]);
  }

  async function carregarMiniaturas(raiz) {
    var imgs = Array.from(raiz.querySelectorAll('img[data-caminho]:not([src])'));
    if (!imgs.length) return;
    var caminhos = Array.from(new Set(imgs.map(function (i) { return i.getAttribute('data-caminho'); })));
    try {
      var urls = await window.Fotos.urlsAssinadas(caminhos);
      imgs.forEach(function (i) { var u = urls[i.getAttribute('data-caminho')]; if (u) i.src = u; });
    } catch (e) {
      imgs.forEach(function (i) { if (i.parentNode) i.parentNode.classList.add('falhou'); });
    }
  }

  function renderizarGaleria() {
    var fotos = fotosOrdenadas();
    var ids = fotos.map(function (f) { return f.id; });
    var ul = $('galeria');
    var assinatura = ids.join(',');
    $('galeria-vazia').hidden = fotos.length > 0;
    if (ul.getAttribute('data-assinatura') === assinatura) { carregarMiniaturas(ul); return; }
    ul.setAttribute('data-assinatura', assinatura);
    ul.innerHTML = '';
    fotos.forEach(function (f) {
      ul.appendChild(UI.el('li', { classe: 'galeria-item' }, [
        miniatura(f, ids),
        UI.el('div', { classe: 'galeria-info' }, [
          UI.el('strong', { texto: nomeDoParticipante(f.participante_id, f.autor_nome) }),
          UI.el('span', { classe: 'muted', texto: C.hora(f.capturada_em || f.registrada_em, false) + (f.lat == null ? ' · sem localização' : '') }),
          f.legenda ? UI.el('span', { classe: 'galeria-legenda', texto: f.legenda }) : null,
        ]),
      ]));
    });
    carregarMiniaturas(ul);
  }

  function renderizarFotosFicha(p) {
    var fotos = fotosOrdenadas(p.id);
    var bloco = $('ficha-fotos-bloco');
    bloco.hidden = !fotos.length;
    $('ficha-qtd-fotos').textContent = String(fotos.length);
    var ul = $('ficha-fotos');
    var ids = fotos.map(function (f) { return f.id; });
    var assinatura = p.id + ':' + ids.join(',');
    if (ul.getAttribute('data-assinatura') !== assinatura) {
      ul.setAttribute('data-assinatura', assinatura);
      ul.innerHTML = '';
      fotos.forEach(function (f) { ul.appendChild(UI.el('li', null, [miniatura(f, ids)])); });
    }
    if (fotos.length) carregarMiniaturas(ul);
  }

  // Janela da foto: imagem, autor, horários (captura × registro) e coordenadas.
  function abrirFoto(id, lista) {
    var f = est.fotos.get(id);
    if (!f) { UI.aviso('Esta foto não está mais disponível.', 'erro'); return; }
    lista = (lista && lista.length ? lista : fotosOrdenadas().map(function (x) { return x.id; }))
      .filter(function (x) { return est.fotos.has(x); });
    var pos = lista.indexOf(id);
    var p = est.participantes.get(f.participante_id);
    var autor = nomeDoParticipante(f.participante_id, f.autor_nome);
    var tipoAutor = TIPOS[f.autor_tipo === 'militar' ? 'militar' : f.autor_tipo === 'responsavel' ? 'responsavel' : 'civil'];

    var caixa = UI.el('div', { classe: 'visor-img carregando' }, [UI.el('span', { classe: 'visor-status', texto: 'Carregando a foto…' })]);
    var urlAtual = null;
    async function carregar() {
      caixa.className = 'visor-img carregando';
      caixa.innerHTML = '';
      caixa.appendChild(UI.el('span', { classe: 'visor-status', texto: 'Carregando a foto…' }));
      try {
        urlAtual = window.Fotos.urlEmCache(f.caminho) || (await window.Fotos.urlsAssinadas([f.caminho]))[f.caminho];
        if (!urlAtual) throw new Error('arquivo não encontrado');
      } catch (e) {
        mostrarFalha(e.rede ? 'sem conexão' : (e.message || 'erro'));
        return;
      }
      var img = UI.el('img', { alt: f.legenda || 'Foto registrada por ' + autor, id: 'visor-imagem' });
      img.addEventListener('load', function () { caixa.className = 'visor-img'; var st = caixa.querySelector('.visor-status'); if (st) st.remove(); });
      img.addEventListener('error', function () { mostrarFalha('conexão lenta ou link expirado'); });
      img.addEventListener('click', function () { abrirLightbox(urlAtual, img.alt); });
      img.src = urlAtual;
      caixa.appendChild(img);
    }
    function mostrarFalha(motivo) {
      caixa.className = 'visor-img falhou';
      caixa.innerHTML = '';
      caixa.appendChild(UI.el('span', { classe: 'visor-status', texto: 'Não foi possível carregar a imagem (' + motivo + ').' }));
      caixa.appendChild(UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Tentar de novo', onclick: carregar }));
    }

    var dl = UI.el('dl', { classe: 'dados' });
    function linha(rot, valor) { dl.appendChild(UI.el('dt', { texto: rot })); dl.appendChild(UI.el('dd', null, [valor])); }
    var selo = UI.el('span', { classe: 'selo ' + tipoAutor.selo, texto: tipoAutor.rotulo });
    linha('Registrada por', UI.el('span', null, [autor + ' ', selo]));
    linha('Capturada em', f.capturada_em ? dataHoraCurta(f.capturada_em) + ' (relógio do aparelho)' : 'desconhecido');
    var atraso = f.capturada_em ? C.paraMs(f.registrada_em) - C.paraMs(f.capturada_em) : 0;
    linha('Recebida às', C.hora(f.registrada_em) + (atraso > 120000 ? ' (enviada ' + C.idade(f.capturada_em, C.paraMs(f.registrada_em)).replace('há ', '') + ' depois da captura)' : ''));
    if (f.lat != null) {
      linha('Latitude', UI.el('span', { classe: 'mono', texto: C.coord(f.lat) }));
      linha('Longitude', UI.el('span', { classe: 'mono', texto: C.coord(f.lng) }));
      linha('Precisão', C.precisao(f.precisao));
      linha('Origem do local', ORIGEM_FOTO[f.origem_posicao] || f.origem_posicao);
      if (f.local_atualizado_em) linha('Local completado', dataHoraCurta(f.local_atualizado_em) + ' (a foto foi tirada sem GPS)');
    } else if (f.origem_posicao === 'pendente') {
      var vencido = f.capturada_em && C.agora() - C.paraMs(f.capturada_em) > 11 * 60000;
      linha('Localização', vencido ? 'Não obtida: o GPS do aparelho não respondeu a tempo.'
        : 'Pendente — será completada quando o GPS do aparelho responder (até 10 min após a captura).');
    } else {
      linha('Localização', 'Sem localização (o aparelho não informou) — a foto não aparece no mapa.');
    }
    if ('setor_nome' in f) linha('Setor', f.setor_nome || (f.lat != null ? 'fora dos setores' : '—'));
    if (f.legenda) linha('Descrição', f.legenda);
    if (f.largura) linha('Imagem', f.largura + ' × ' + f.altura + ' px' + (f.bytes ? ' · ' + Math.round(f.bytes / 1024) + ' KB' : ''));

    var nav = lista.length > 1 ? UI.el('div', { classe: 'visor-nav' }, [
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '‹ Anterior', disabled: pos <= 0 ? true : null, onclick: function () { abrirFoto(lista[pos - 1], lista); } }),
      UI.el('span', { classe: 'muted num', texto: (pos + 1) + ' de ' + lista.length }),
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Próxima ›', disabled: pos >= lista.length - 1 ? true : null, onclick: function () { abrirFoto(lista[pos + 1], lista); } }),
    ]) : null;

    var fechar = UI.abrirModal(UI.el('div', { classe: 'visor-foto' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Foto de ' + autor }),
      UI.el('p', { classe: 'visor-quando', texto: (f.capturada_em ? dataHoraCurta(f.capturada_em) : 'Data desconhecida') + (f.setor_nome ? ' · setor ' + f.setor_nome : '') }),
      caixa,
      nav,
      dl,
      compactarAcoes(UI.rodape([
        UI.el('button', { classe: 'btn', type: 'button', id: 'visor-ampliar', texto: 'Ampliar', onclick: function () { if (urlAtual) abrirLightbox(urlAtual, 'Foto de ' + autor); } }),
        f.lat != null ? UI.el('button', { classe: 'btn', type: 'button', texto: 'Ver no mapa', onclick: function () {
          fechar();
          if (!est.prefsMapa.fotos) definirPrefMapa('fotos', true);
          destacarNoMapa(est.camadaPontos, est.fotosMarc.get(f.id), f.lat, f.lng);   // fotos sempre no agrupamento
        } }) : null,
        p ? UI.el('button', { classe: 'btn', type: 'button', texto: 'Ficha de ' + p.dados.nome, onclick: function () { fechar(); selecionar(p.id); } }) : null,
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ])),
    ]), { aoFechar: fecharLightbox });
    carregar();
  }

  // Imagem em tela cheia. Toque na imagem: tamanho real (com rolagem); fora dela: fecha.
  function abrirLightbox(url, alt) {
    fecharLightbox();
    var img = UI.el('img', { src: url, alt: alt || 'Foto' });
    var btn = UI.el('button', { classe: 'btn lightbox-fechar', type: 'button', texto: 'Fechar', 'aria-label': 'Fechar a imagem ampliada' });
    var caixa = UI.el('div', { classe: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': alt || 'Foto ampliada' }, [img, btn]);
    img.addEventListener('click', function (ev) { ev.stopPropagation(); caixa.classList.toggle('tamanho-real'); });
    caixa.addEventListener('click', fecharLightbox);
    document.addEventListener('keydown', teclaLightbox, true);
    document.body.appendChild(caixa);
    btn.focus();
  }

  function teclaLightbox(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      fecharLightbox();
    }
  }

  function fecharLightbox() {
    var c = document.querySelector('.lightbox');
    document.removeEventListener('keydown', teclaLightbox, true);
    if (c && c.parentNode) {
      c.parentNode.removeChild(c);
      var b = $('visor-ampliar');
      if (b) b.focus();
    }
  }

  /* ---------- Fotos tiradas pelo próprio responsável ----------------- */
  function obterMinhaPosicao() {
    var u = est.compartilhando && est.ultimoAceitoMeu && est.ultimoAceitoMeu.prec != null && est.ultimoAceitoMeu.prec <= 100 ? est.ultimoAceitoMeu : null;
    if (u) u = { lat: u.lat, lng: u.lng, prec: u.prec, t: u.recebidaEm || u.t };
    if (u && Date.now() - u.t < 15000) {
      return Promise.resolve({ ok: true, lat: u.lat, lng: u.lng, prec: u.prec, t: u.t });
    }
    if (!('geolocation' in navigator) || !window.isSecureContext) return Promise.resolve({ ok: false, motivo: 'navegador sem acesso à localização' });
    return new Promise(function (resolve) {
      navigator.geolocation.getCurrentPosition(function (p) {
        var agora = Date.now();
        resolve({ ok: true, lat: p.coords.latitude, lng: p.coords.longitude, prec: p.coords.accuracy,
          t: p.timestamp && Math.abs(p.timestamp - agora) < 864e5 ? p.timestamp : agora });
      }, function (e) {
        // parado, o GPS pode não entregar leitura nova: usa a última de até 2 min (com o horário real dela)
        if (e.code !== 1 && u && Date.now() - u.t < 120000) {
          resolve({ ok: true, lat: u.lat, lng: u.lng, prec: u.prec, t: u.t });
          return;
        }
        resolve({ ok: false, motivo: e.code === 1 ? 'permissão de localização negada' : e.code === 2 ? 'GPS desligado ou indisponível' : 'sem sinal de GPS' });
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 });
    });
  }

  function abrirRegistrarFoto(aoEnviar) {
    if (!est.op || est.op.status !== 'ativa') return;
    if (typeof aoEnviar !== 'function') aoEnviar = null;
    prepararAudio();
    var inCam = UI.el('input', { classe: 'sr-only', type: 'file', accept: 'image/*', capture: 'environment', id: 'painel-foto-camera' });
    var inArq = UI.el('input', { classe: 'sr-only', type: 'file', accept: 'image/*', id: 'painel-foto-arquivo' });
    inCam.addEventListener('change', function (ev) { aoEscolherFotoPainel(ev, true, aoEnviar); });
    inArq.addEventListener('change', function (ev) { aoEscolherFotoPainel(ev, false, aoEnviar); });
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, ['Registrar foto', UI.dica('A foto fica vinculada a você e a esta operação. O local é o do GPS no momento ou o gravado na foto. Sem local, ela é salva mas não aparece no mapa.')]),
      UI.el('div', { classe: 'fotos-botoes' }, [
        UI.el('label', { classe: 'btn btn-escuro btn-foto' }, [UI.el('span', { classe: 'ico-camera', 'aria-hidden': 'true' }), ' TIRAR FOTO', inCam]),
        UI.el('label', { classe: 'btn btn-foto' }, ['Escolher arquivo', inArq]),
      ]),
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } })]),
    ]));
  }

  async function aoEscolherFotoPainel(ev, daCamera, aoEnviar) {
    var arquivo = ev.target.files && ev.target.files[0];
    UI.fecharModal();
    if (!arquivo || !est.op) return;
    var opId = est.op.id;
    var f = await window.Fotos.lerArquivo(arquivo, daCamera, obterMinhaPosicao);
    if (!f || !est.op || est.op.id !== opId) return;
    window.Fotos.abrirPrevia(f, {
      obterPosicao: obterMinhaPosicao,
      aoSalvar: async function (d) {
        if (!est.op || est.op.id !== opId) throw new Error('A operação foi fechada antes de salvar a foto.');
        var item = Object.assign(d, { id: C.uuid(), operacao_id: opId, participante_id: null, estado: 'fila', aoEnviar: aoEnviar || null });
        est.fotosFila.push(item);
        if (item.origem === 'pendente') {
          window.Fotos.aguardarLocal(item.capturada, function (pos) {
            if (est.fotosFila.indexOf(item) !== -1 && item.estado !== 'enviando') {
              // ainda na fila: a foto já sai com o local
              if (pos) Object.assign(item, { origem: 'gps', lat: pos.lat, lng: pos.lng, prec: pos.prec, posicao_em: pos.t });
              else item.origem = 'nenhuma';
              return;
            }
            item.localDepois = pos || 'nenhuma';
            enviarLocalDepois(item);
          });
        }
        renderizarFilaFotos();
        enviarFilaFotos();
      },
    });
  }

  // Foto do responsável já registrada: manda o local que o GPS deu depois
  function enviarLocalDepois(item) {
    if (!item.registrada || !item.localDepois || !est.meuPart) return;
    var pos = item.localDepois === 'nenhuma' ? null : item.localDepois;
    item.localDepois = null;
    window.Fotos.atualizarLocal(item.participante_id || est.meuPart, item.id, pos)
      .then(function (f) { if (f && f.id) adicionarFoto(f, true); })
      .catch(function (e) { if (e.rede) { item.localDepois = pos || 'nenhuma'; setTimeout(function () { enviarLocalDepois(item); }, 15000); } });
  }

  async function enviarFilaFotos() {
    if (est.enviandoFotos || !est.fotosFila.length || !est.op) return;
    est.enviandoFotos = true;
    try {
      while (est.fotosFila.length && est.op) {
        var it = est.fotosFila[0];
        if (it.operacao_id !== est.op.id) { est.fotosFila.shift(); continue; }
        if (!est.meuPart) await entrarComoResponsavel();
        if (!est.meuPart) break;   // sem conexão: tenta no próximo ciclo
        it.participante_id = est.meuPart;
        it.estado = 'enviando';
        renderizarFilaFotos();
        try {
          var foto = await window.Fotos.enviar(it);
          est.fotosFila.shift();
          it.registrada = true;
          if (it.localDepois) enviarLocalDepois(it);
          window.Fotos.guardarUrlLocal(foto.caminho, URL.createObjectURL(it.blob));
          adicionarFoto(foto, true);
          UI.aviso(foto.lat != null ? 'Foto registrada no mapa.' : foto.origem_posicao === 'pendente'
            ? 'Foto registrada. O local é completado quando o GPS responder.' : 'Foto registrada sem localização (não aparece no mapa).', 'ok');
          if (it.aoEnviar) { try { it.aoEnviar(foto); } catch (e2) { /* ignora */ } }
        } catch (e) {
          if (e.rede) {
            it.estado = 'fila';
            UI.aviso('Sem conexão: a foto ficou na fila e será enviada automaticamente. Não feche o painel.', 'erro', 8000);
            break;
          }
          if (e.codigo === 'participante_invalido') est.meuPart = null;
          est.fotosFila.shift();
          UI.aviso('A foto não foi salva: ' + e.message, 'erro', 9000);
        }
      }
    } finally {
      est.enviandoFotos = false;
      renderizarFilaFotos();
    }
  }

  function renderizarFilaFotos() {
    var caixa = $('minhas-fotos-fila');
    if (!caixa) return;
    var n = est.fotosFila.length;
    caixa.hidden = !n;
    if (!n) return;
    caixa.innerHTML = '';
    caixa.appendChild(UI.el('span', { texto: n + ' foto(s) sua(s) ' + (est.enviandoFotos ? 'sendo enviada(s)…' : 'aguardando conexão para envio.') + ' ' }));
    if (!est.enviandoFotos) caixa.appendChild(UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Tentar agora', onclick: enviarFilaFotos }));
  }

  /* ------------------------------------------------------------------ */
  /* Setores de busca, pontos de interesse e destinos                     */
  /* ------------------------------------------------------------------ */
  var CORES_SETOR = ['#3b82f6', '#f59e0b', '#14b8a6', '#ec4899', '#84cc16', '#0ea5e9', '#f43f5e', '#eab308'];
  var STATUS_SETOR = {
    pendente: { rotulo: 'Pendente', selo: 'selo-neutro' },
    andamento: { rotulo: 'Em andamento', selo: 'selo-alerta' },
    concluido: { rotulo: 'Concluído', selo: 'selo-ok' },
  };
  var RAIO_ALERTA_PADRAO = 100;   // m — área de risco sem raio definido
  var CAT_PONTO = {
    ULTIMA_LOCALIZACAO: { rotulo: 'Última localização conhecida', letra: 'U' },
    POSSIVEL_LOCALIZACAO: { rotulo: 'Possível localização da vítima', letra: '?' },
    VESTIGIO: { rotulo: 'Vestígio ou objeto encontrado', letra: 'V' },
    RISCO: { rotulo: 'Área de risco / perigo', letra: '!' },
    ENCONTRO: { rotulo: 'Ponto de encontro', letra: 'E' },
    VITIMA_ENCONTRADA: { rotulo: 'Vítima encontrada', letra: '+' },
    BASE: { rotulo: 'Base da operação', letra: 'B' },
    OUTRO: { rotulo: 'Outro ponto', letra: '•' },
  };
  var RAIO_BASE_PADRAO = 100;   // m — raio de chegada à base sem valor definido
  var FAIXA_COBERTURA_M = 25;   // meia-largura de varredura considerada em volta de cada rastro
  var URL_DEM = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';

  /* ---------- Carga e tempo real ------------------------------------ */
  async function carregarAreas() {
    if (!est.op) return;
    var opId = est.op.id;
    try {
      var r = await Promise.all([
        C.consultar(C.cliente.from('setores').select('*').eq('operacao_id', opId).order('criado_em', { ascending: true })),
        C.consultar(C.cliente.from('pontos_interesse').select('*').eq('operacao_id', opId).order('criado_em', { ascending: true })),
        C.consultar(C.cliente.from('destinos').select('*').eq('operacao_id', opId).is('encerrado_em', null)),
        carregarTiposPonto(),
      ]);
      if (!est.op || est.op.id !== opId) return;
      aplicarSetores(r[0] || [], true);
      aplicarPontos(r[1] || [], true);
      aplicarDestinos(r[2] || []);
      est.erroAreas = false;
    } catch (e) {
      // banco sem a migração 003 ou sem conexão: o resto do painel segue funcionando
      if (!est.erroAreas) console.warn('Setores/pontos indisponíveis:', e.message);
      est.erroAreas = true;
    }
    await carregarTrilhasManuais();   // trata os próprios erros (banco sem a migração 028 não derruba setores)
  }

  // Tipos de ponto criados pelos responsáveis (valem para todas as operações). Banco sem a migração 047: só as categorias fixas.
  async function carregarTiposPonto() {
    try {
      var lista = await C.consultar(C.cliente.from('tipos_ponto').select('*').order('nome', { ascending: true }));
      est.tiposPonto = new Map((lista || []).map(function (t) { return [t.id, t]; }));
    } catch (e) {
      est.tiposPonto = new Map();
    }
    // ícone e cor escolhidos para as categorias fixas (sem a migração 050: as de sempre)
    try {
      var estilos = await C.consultar(C.cliente.from('categorias_ponto_estilo').select('*'));
      est.estilosCategoria = new Map((estilos || []).map(function (x) { return [x.categoria, x]; }));
    } catch (e) {
      est.estilosCategoria = new Map();
    }
  }

  function agendarAreas() {
    clearTimeout(est.timerAreas);
    est.timerAreas = setTimeout(carregarAreas, 400);
  }

  function aplicarSetores(lista, completa) {
    var vistos = new Set();
    lista.forEach(function (d) {
      vistos.add(d.id);
      var s = est.setores.get(d.id);
      if (!s) { s = { d: d, camada: null }; est.setores.set(d.id, s); }
      else s.d = d;
      desenharSetor(s);
    });
    if (completa) {
      est.setores.forEach(function (s, id) {
        if (!vistos.has(id)) { if (s.camada) s.camada.remove(); est.setores.delete(id); }
      });
    }
    renderizarAreas();
  }

  function aplicarPontos(lista, completa) {
    var vistos = new Set();
    lista.forEach(function (d) {
      vistos.add(d.id);
      var p = est.pontosInt.get(d.id);
      if (!p) { p = { d: d, marcador: null }; est.pontosInt.set(d.id, p); }
      else p.d = d;
      desenharPontoInt(p);
    });
    if (completa) {
      est.pontosInt.forEach(function (p, id) {
        if (!vistos.has(id)) { tirarPontoInt(p); est.pontosInt.delete(id); }
      });
    }
    renderizarAreas();
  }

  function aplicarDestinos(lista) {
    est.destinos = new Map();
    lista.forEach(function (d) { if (!d.encerrado_em) est.destinos.set(d.participante_id, d); });
    if (est.selecionado) atualizarFicha();
    if (filtroAtivo()) desenharDestinosGrupo();
  }

  function limparAreasDoMapa() {
    est.setores.forEach(function (s) { if (s.camada) s.camada.remove(); });
    est.pontosInt.forEach(tirarPontoInt);
    if (est.linhaDestino) { est.linhaDestino.remove(); est.linhaDestino = null; }
    if (est.marcaDestino) { est.marcaDestino.remove(); est.marcaDestino = null; }
    est.trilhasManuais.forEach(function (t) { if (t.camada) t.camada.remove(); });
    est.setores = new Map();
    est.pontosInt = new Map();
    est.destinos = new Map();
    est.trilhasManuais = new Map();
    renderizarAreas();
  }

  /* ---------- Geometria --------------------------------------------- */
  // Projeção local em metros (equiretangular), boa para áreas de busca (até dezenas de km).
  function projetor(lat0, lng0) {
    var R = 6371008.8, k = Math.PI / 180, cos0 = Math.cos(lat0 * k);
    return {
      xy: function (lat, lng) { return [(lng - lng0) * k * R * cos0, (lat - lat0) * k * R]; },
      ll: function (x, y) { return [lat0 + y / (k * R), lng0 + x / (k * R * cos0)]; },
    };
  }

  function verticesSetor(d) {
    if (d.forma === 'poligono') return d.pontos || [];
    var pr = projetor(d.centro_lat, d.centro_lng), v = [];
    for (var i = 0; i < 64; i++) {
      var a = (i / 64) * 2 * Math.PI;
      v.push(pr.ll(Math.cos(a) * d.raio_m, Math.sin(a) * d.raio_m));
    }
    return v;
  }

  function centroSetor(d) {
    if (d.forma === 'circulo') return [d.centro_lat, d.centro_lng];
    var la = 0, ln = 0;
    d.pontos.forEach(function (p) { la += p[0]; ln += p[1]; });
    return [la / d.pontos.length, ln / d.pontos.length];
  }

  function areaSetorM2(d) {
    if (d.forma === 'circulo') return Math.PI * d.raio_m * d.raio_m;
    var c = centroSetor(d), pr = projetor(c[0], c[1]);
    var pts = d.pontos.map(function (p) { return pr.xy(p[0], p[1]); }), a = 0;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    return Math.abs(a / 2);
  }

  function formatarArea(m2) {
    if (m2 < 10000) return Math.round(m2).toLocaleString('pt-BR') + ' m²';
    if (m2 < 1e6) return Math.round(m2).toLocaleString('pt-BR') + ' m² (' + (m2 / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' ha)';
    return (m2 / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' km² (' + Math.round(m2 / 10000).toLocaleString('pt-BR') + ' ha)';
  }

  function dentroDoPoligono(x, y, pts) {
    var dentro = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if (((pts[i][1] > y) !== (pts[j][1] > y)) && (x < (pts[j][0] - pts[i][0]) * (y - pts[i][1]) / (pts[j][1] - pts[i][1]) + pts[i][0])) dentro = !dentro;
    }
    return dentro;
  }

  function distSegmento(px, py, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    var t = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
    var qx = a[0] + t * dx - px, qy = a[1] + t * dy - py;
    return Math.sqrt(qx * qx + qy * qy);
  }

  // Estimativa de quanto do setor ficou perto de algum rastro GPS (faixa de ±25 m).
  // É uma estimativa: não prova que a área foi vasculhada.
  function coberturaSetor(d) {
    var c = centroSetor(d), pr = projetor(c[0], c[1]);
    var poli = verticesSetor(d).map(function (p) { return pr.xy(p[0], p[1]); });
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    poli.forEach(function (p) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); });
    var area = areaSetorM2(d);
    var passo = Math.max(4, Math.sqrt(area / 4000));
    var f = FAIXA_COBERTURA_M;
    var segs = [];
    est.participantes.forEach(function (p) {
      trilhaDe(p).segmentos.forEach(function (seg) {
        var ant = null;
        seg.forEach(function (ll) {
          var q = pr.xy(ll[0], ll[1]);
          var a = ant || q;
          if (Math.max(a[0], q[0]) >= minX - f && Math.min(a[0], q[0]) <= maxX + f &&
              Math.max(a[1], q[1]) >= minY - f && Math.min(a[1], q[1]) <= maxY + f) segs.push([a, q]);
          ant = q;
        });
      });
    });
    var total = 0, cobertos = 0;
    for (var x = minX + passo / 2; x < maxX; x += passo) {
      for (var y = minY + passo / 2; y < maxY; y += passo) {
        if (!dentroDoPoligono(x, y, poli)) continue;
        total++;
        for (var i = 0; i < segs.length; i++) {
          if (distSegmento(x, y, segs[i][0], segs[i][1]) <= f) { cobertos++; break; }
        }
      }
    }
    return { pct: total ? Math.round((cobertos / total) * 100) : 0, comRastros: segs.length > 0 };
  }

  /* ---------- Desenho dos setores ----------------------------------- */
  function estiloSetor(d) {
    return {
      pane: 'setores',
      color: d.cor,
      weight: 1.5,
      opacity: 0.75,
      fillColor: d.cor,
      fillOpacity: d.status === 'concluido' ? 0.04 : d.status === 'andamento' ? 0.1 : 0.06,
      dashArray: d.status === 'pendente' ? '8 6' : null,
      className: 'setor setor-' + d.status,
    };
  }

  // A situação some de longe (o traço e o preenchimento da área já a indicam)
  function htmlRotuloSetor(d) {
    return '<span class="rs-nome">' + C.esc(d.nome) + '</span><span class="rs-status"> · ' + C.esc(STATUS_SETOR[d.status].rotulo) + '</span>';
  }

  function desenharSetor(s) {
    if (!est.mapa || !est.camadaSetores) return;
    var d = s.d;
    if (s.camada) { s.camada.remove(); s.camada = null; }
    if (est.desenho && est.desenho.tipo === 'ajuste' && est.desenho.id === d.id) return;   // sendo ajustado
    var camada = d.forma === 'circulo'
      ? L.circle([d.centro_lat, d.centro_lng], Object.assign({ radius: d.raio_m }, estiloSetor(d)))
      : L.polygon(d.pontos, estiloSetor(d));
    camada.bindTooltip(htmlRotuloSetor(d), { permanent: true, direction: 'center', className: 'rotulo-setor', opacity: 1, pane: 'rotulosSetor' });
    ligarCliquesMapa(camada, {
      noDesenho: function (ev) { aoClicarNoMapa(ev); },   // durante o desenho o clique é do mapa
      info: function () { return { titulo: 'Setor ' + d.nome, sub: STATUS_SETOR[d.status].rotulo }; },
      detalhes: function () { abrirSetor(d.id); },
    });
    camada.addTo(est.camadaSetores);
    s.camada = camada;
  }

  /* ---------- Pontos de interesse ----------------------------------- */
  // Categoria para mostrar: uma das fixas (com regras próprias: risco, base, vítima…) ou um tipo criado
  // pelos responsáveis, com ícone e cor próprios (o ponto guarda uma cópia, para aparecer mesmo sem o tipo).
  function catDoPonto(d) {
    var t = d && d.tipo_id ? est.tiposPonto.get(d.tipo_id) : null;
    if (d && (d.tipo_id || d.icone)) {
      return { rotulo: t ? t.nome : 'Outro ponto', letra: (t && t.icone) || d.icone || '•', cor: (t && t.cor) || d.cor || null, tipo: true };
    }
    var k = CAT_PONTO[d && d.categoria] ? d.categoria : 'OUTRO';
    var e = est.estilosCategoria.get(k);
    if (e && (e.icone || e.cor)) return { rotulo: CAT_PONTO[k].rotulo, letra: e.icone || CAT_PONTO[k].letra, cor: e.cor || COR_CATEGORIA[k], tipo: true };
    return CAT_PONTO[k];
  }
  // Cores de sempre das categorias fixas (as mesmas do CSS .poi-*): ponto de partida ao escolher outra
  var COR_CATEGORIA = { ULTIMA_LOCALIZACAO: '#f8fafc', POSSIVEL_LOCALIZACAO: '#fbbf24', VESTIGIO: '#ec4899', RISCO: '#dc2626',
    ENCONTRO: '#2563eb', VITIMA_ENCONTRADA: '#10b981', BASE: '#0ea5e9', OUTRO: '#64748b' };
  function estiloCorPonto(cor) {
    return cor ? 'background:' + cor + ';color:' + window.Cores.textoSobre(cor) : '';
  }
  function htmlMarcaPonto(d) {
    var cat = catDoPonto(d);
    var est_ = estiloCorPonto(cat.cor);
    return '<div class="mk-poi poi-' + C.esc(d.categoria) + (cat.tipo ? ' poi-tipo' : '') + '"' + (est_ ? ' style="' + est_ + '"' : '') +
      '><span>' + C.esc(cat.letra) + '</span></div>';
  }
  // Marca do ponto como elemento (listas, detalhes, formulário)
  function elMarcaPonto(d, extra) {
    var cat = catDoPonto(d);
    return UI.el('span', Object.assign({ classe: 'mk-poi poi-' + d.categoria + (cat.tipo ? ' poi-tipo' : ''), style: estiloCorPonto(cat.cor) || null }, extra || {}),
      [UI.el('span', { texto: cat.letra })]);
  }

  function iconePontoInt(d) {
    return L.divIcon({
      className: 'mk-poi-wrap',
      html: htmlMarcaPonto(d) +
        '<div class="mk-poi-rotulo">' + C.esc(d.titulo) + '</div>',
      iconSize: [0, 0],
    });
  }

  function tirarPontoInt(p) {
    if (p.marcador) { mostrarPonto(p.marcador, false); p.marcador = null; }
    if (p.circulo) { p.circulo.remove(); p.circulo = null; }
    p._assinatura = null;
  }

  function desenharPontoInt(p) {
    if (!est.mapa || !est.camadaPontosInt) return;
    var d = p.d;
    // A sincronização redesenha a lista inteira: só refaz quando o ponto mudou (evita refazer o agrupamento)
    var cat = catDoPonto(d);
    var assinatura = [d.lat, d.lng, d.categoria, d.titulo, d.raio_m, d.tipo_id, cat.letra, cat.cor, cat.rotulo].join('|');
    if (p.marcador && p._assinatura === assinatura) return;
    tirarPontoInt(p);
    p._assinatura = assinatura;
    // Área de risco: círculo do alarme de proximidade (quem entra é avisado).
    if (d.categoria === 'RISCO') {
      p.circulo = L.circle([d.lat, d.lng], { radius: d.raio_m || RAIO_ALERTA_PADRAO, color: '#ef4444', weight: 1.5, opacity: 0.7, dashArray: '6 6',
        fillColor: '#ef4444', fillOpacity: 0.05, interactive: false, className: 'circulo-risco' }).addTo(est.camadaPontosInt);
    } else if (d.categoria === 'BASE') {
      // Base: círculo do raio de chegada (usado no controle de retorno dos grupos).
      p.circulo = L.circle([d.lat, d.lng], { radius: d.raio_m || RAIO_BASE_PADRAO, color: '#0ea5e9', weight: 1.5, opacity: 0.6, dashArray: '4 6',
        fillColor: '#0ea5e9', fillOpacity: 0.04, interactive: false, className: 'circulo-base' }).addTo(est.camadaPontosInt);
    }
    // O marcador entra no agrupamento junto com relatos e fotos (o círculo de risco/base continua sempre à vista).
    var mk = L.marker([d.lat, d.lng], {
      icon: iconePontoInt(d), keyboard: true, riseOnHover: true, title: cat.rotulo + ': ' + d.titulo, alt: d.titulo,
      pane: 'pontos', tipoPonto: 'poi', critico: d.categoria === 'RISCO', vitima: d.categoria === 'VITIMA_ENCONTRADA',
    });
    ligarCliquesMapa(mk, {
      noDesenho: function () { aoClicarNoMapa({ latlng: mk.getLatLng() }); },
      info: function () { return { latlng: mk.getLatLng(), titulo: d.titulo, sub: cat.rotulo, texto: resumoTexto(d.descricao, 90), deslocY: -30 }; },
      detalhes: function () { abrirPontoInt(d.id); },
    });
    p.marcador = mk;
    mostrarPonto(mk, Boolean(est.prefsMapa.pontos));
  }


  /* ---------- Modo de desenho (tocar no mapa) ------------------------ */
  // Barra do desenho, sempre no mesmo formato (enxuta): instrução · [extra] · ↶ desfazer · ⋯ outras ações ·
  // ação principal · ×. Quem chama só passa os botões; o papel de cada um sai da classe/texto:
  //   btn-ok (ou Concluir/Salvar/Enviar) = principal; "Desfazer…" = ↶; "Cancelar"/"Sair" = ×;
  //   data-fixo = fica à vista; o resto vai para o menu ⋯ (com uma só ação extra, ela fica à vista).
  function papelBotao(b) {
    var t = (b.textContent || '').trim(), id = b.id || '';
    if (/^(cancelar|sair)$/i.test(t) || /-(cancelar|sair)$/.test(id)) return 'cancelar';
    if (/^desfazer/i.test(t)) return 'desfazer';
    if (b.classList.contains('btn-ok') || /^(✔ )?(concluir|salvar|enviar)/i.test(t)) return 'principal';
    if (b.hasAttribute('data-fixo')) return 'fixo';
    return 'outro';
  }
  function mostrarBarraDesenho(texto, extra, botoes) {
    $('barra-desenho-texto').textContent = texto;
    $('barra-desenho-texto').title = texto;
    var ex = $('barra-desenho-extra');
    ex.innerHTML = '';
    if (extra) ex.appendChild(extra);
    var bt = $('barra-desenho-botoes');
    bt.innerHTML = '';
    var grupos = { cancelar: [], desfazer: [], principal: [], fixo: [], outro: [] };
    (botoes || []).forEach(function (b) { if (b) grupos[papelBotao(b)].push(b); });
    grupos.desfazer.forEach(function (b) {
      var rot = b.textContent.trim();
      b.textContent = '↶';
      b.setAttribute('aria-label', rot); b.title = rot;
      b.classList.add('barra-ico');
      bt.appendChild(b);
    });
    grupos.fixo.forEach(function (b) { bt.appendChild(b); });
    if (grupos.outro.length === 1) bt.appendChild(grupos.outro[0]);
    else if (grupos.outro.length > 1) {
      var menu = UI.el('div', { classe: 'barra-mais-menu', id: 'barra-mais-menu', role: 'menu', hidden: true });
      grupos.outro.forEach(function (b) {
        b.classList.add('barra-mais-item');
        b.setAttribute('role', 'menuitem');
        b.addEventListener('click', function () { menu.hidden = true; mais.setAttribute('aria-expanded', 'false'); });
        menu.appendChild(b);
      });
      var mais = UI.el('button', { classe: 'btn btn-pequeno barra-ico', type: 'button', id: 'barra-mais', texto: '⋯', title: 'Mais ações', 'aria-label': 'Mais ações',
        'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: function () {
          menu.hidden = !menu.hidden;
          mais.setAttribute('aria-expanded', String(!menu.hidden));
        } });
      bt.appendChild(UI.el('span', { classe: 'barra-mais' }, [mais, menu]));
    }
    grupos.principal.forEach(function (b) { b.classList.add('btn-ok'); bt.appendChild(b); });
    grupos.cancelar.forEach(function (b) {
      var rot = b.textContent.trim();
      b.textContent = '×';
      b.setAttribute('aria-label', rot); b.title = rot;
      b.classList.add('barra-ico', 'barra-x');
      bt.appendChild(b);
    });
    $('barra-desenho').hidden = false;
  }

  function iniciarDesenho(tipo, opcoes) {
    if (!est.mapa || !est.op) return;
    cancelarDesenho();
    fecharMenu(false);
    if (telaPequena()) { fecharAreas(); fecharCentral(); if (!$('ficha').hidden) fecharFicha(); }
    if (gaveta.ativa) definirGaveta('mini', false);   // o mapa inteiro livre para desenhar
    est.desenho = Object.assign({ tipo: tipo, camadaTemp: L.layerGroup().addTo(est.mapa), pontos: [] }, opcoes || {});
    $('mapa').classList.add('modo-desenho');
    var cancelar = UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'desenho-cancelar', texto: 'Cancelar', onclick: cancelarDesenho });
    if (tipo === 'raio') {
      mostrarBarraDesenho('Toque no mapa no CENTRO do setor.', null, [cancelar]);
    } else if (tipo === 'poligono') {
      atualizarBarraPoligono();
    } else if (tipo === 'ponto') {
      mostrarBarraDesenho('Toque no mapa onde fica o ponto.', null, [
        UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Usar minha posição', onclick: usarMinhaPosicaoNoDesenho }), cancelar]);
    } else if (tipo === 'destino') {
      mostrarBarraDesenho('Toque no mapa no DESTINO.', null, [cancelar]);
    } else if (tipo === 'trilha' || tipo === 'trajeto') {
      // barra própria (atualizarBarraTrilha), montada por iniciarDesenhoTrilha / iniciarDesenhoTrajeto
    } else if (tipo === 'vitima') {
      mostrarBarraDesenho('Toque no mapa onde a VÍTIMA foi encontrada.', null, [
        UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Usar minha posição', onclick: usarMinhaPosicaoNoDesenho }), cancelar]);
    }
  }

  function atualizarBarraPoligono() {
    var n = est.desenho.pontos.length;
    mostrarBarraDesenho(n < 3 ? 'Toque nos cantos da área (' + n + ' de no mínimo 3).' : n + ' cantos. Toque em mais pontos ou em Concluir.', null, [
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Desfazer', disabled: n ? null : true, onclick: function () { est.desenho.pontos.pop(); redesenharTemp(); atualizarBarraPoligono(); } }),
      UI.el('button', { classe: 'btn btn-pequeno btn-ok', type: 'button', id: 'desenho-concluir', texto: 'Concluir', disabled: n >= 3 ? null : true, onclick: concluirPoligono }),
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'desenho-cancelar', texto: 'Cancelar', onclick: cancelarDesenho }),
    ]);
  }

  function redesenharTemp() {
    var dz = est.desenho;
    dz.camadaTemp.clearLayers();
    if (dz.tipo === 'poligono') {
      var cor = '#facc15';
      if (dz.pontos.length >= 3) L.polygon(dz.pontos, { color: cor, weight: 2, fillOpacity: 0.12, dashArray: '6 4', interactive: false }).addTo(dz.camadaTemp);
      else if (dz.pontos.length === 2) L.polyline(dz.pontos, { color: cor, weight: 2, dashArray: '6 4', interactive: false }).addTo(dz.camadaTemp);
      dz.pontos.forEach(function (p) { L.circleMarker(p, { radius: 5, color: '#000', weight: 1.5, fillColor: cor, fillOpacity: 1, interactive: false }).addTo(dz.camadaTemp); });
    } else if (dz.tipo === 'trilha' || dz.tipo === 'trajeto') {
      // traço à mão livre: linha contínua; início verde e fim branco (o próximo traço continua dali).
      // Trilha em amarelo; trajeto a enviar em azul (a cor da rota no celular).
      if (dz.pontos.length >= 2) {
        L.polyline(dz.pontos, { color: '#0b1220', weight: 7, opacity: 0.6, interactive: false, className: 'trilha-rascunho-contorno' }).addTo(dz.camadaTemp);
        L.polyline(dz.pontos, { color: dz.tipo === 'trajeto' ? '#3b82f6' : '#facc15', weight: 3, interactive: false, className: 'trilha-rascunho' + (dz.tipo === 'trajeto' ? ' trajeto-rascunho' : '') }).addTo(dz.camadaTemp);
      }
      // ponto a ponto: cada ponto marcado aparece (até 400, para não pesar)
      if (dz.modo === 'pontos' && dz.pontos.length > 2 && dz.pontos.length <= 400) {
        dz.pontos.slice(1, -1).forEach(function (p) { L.circleMarker(p, { radius: 3.5, color: '#0b1220', weight: 1, fillColor: dz.tipo === 'trajeto' ? '#93c5fd' : '#fde68a', fillOpacity: 1, interactive: false, className: 'trilha-rascunho-vertice' }).addTo(dz.camadaTemp); });
      }
      if (dz.pontos.length) {
        L.circleMarker(dz.pontos[0], { radius: 5, color: '#0b1220', weight: 1.5, fillColor: '#22c55e', fillOpacity: 1, interactive: false, className: 'trilha-rascunho-inicio' }).addTo(dz.camadaTemp);
        L.circleMarker(dz.pontos[dz.pontos.length - 1], { radius: 8, color: '#0b1220', weight: 2, fillColor: '#ffffff', fillOpacity: 1, interactive: false, className: 'trilha-rascunho-fim' }).addTo(dz.camadaTemp);
      }
    }
  }

  function aoClicarNoMapa(e) {
    var dz = est.desenho;
    if (!dz || !e || !e.latlng) return;
    var ll = [Math.round(e.latlng.lat * 1e7) / 1e7, Math.round(e.latlng.lng * 1e7) / 1e7];
    if (dz.tipo === 'raio') {
      dz.centro = ll;
      $('barra-desenho').hidden = true;
      abrirFormSetor({ forma: 'circulo', centro_lat: ll[0], centro_lng: ll[1], raio_m: 200 });
    } else if (dz.tipo === 'poligono') {
      dz.pontos.push(ll);
      redesenharTemp();
      atualizarBarraPoligono();
    } else if (dz.tipo === 'trilha' || dz.tipo === 'trajeto') {
      return;   // trilha e trajeto se desenham arrastando (ligarDesenhoLivre), não tocando ponto a ponto
    } else if (dz.tipo === 'ponto') {
      $('barra-desenho').hidden = true;
      abrirFormPontoInt({ lat: ll[0], lng: ll[1] });
    } else if (dz.tipo === 'destino') {
      var pre = dz.participantes;
      var grupoPre = dz.grupo_id;
      cancelarDesenho();
      abrirEnviarDestino({ nome: 'Ponto marcado no mapa', lat: ll[0], lng: ll[1], participantes: pre, grupo_id: grupoPre });
    } else if (dz.tipo === 'vitima') {
      var estado = dz.estado || {};
      cancelarDesenho();
      abrirRegistroVitima(Object.assign({}, estado, { lat: ll[0], lng: ll[1], onde: 'mapa' }));
    } else if (dz.tipo === 'externo' && dz.aoClicar) {
      dz.aoClicar(ll);
    }
  }

  // Modo de desenho usado pelas ferramentas (medir etc.): mesma barra e mesma
  // regra de toques no mapa (inclusive sobre marcadores).
  function iniciarDesenhoExterno(o) {
    if (!est.mapa) return null;
    cancelarDesenho();
    fecharMenu(false);
    if (telaPequena()) { fecharAreas(); fecharCentral(); if (!$('ficha').hidden) fecharFicha(); }
    if (gaveta.ativa) definirGaveta('mini', false);   // o mapa livre para tocar
    est.desenho = { tipo: 'externo', camadaTemp: L.layerGroup().addTo(est.mapa), aoClicar: o.aoClicar, aoCancelar: o.aoCancelar };
    $('mapa').classList.add('modo-desenho');
    var dz = est.desenho;
    return {
      camada: dz.camadaTemp,
      barra: function (texto, extra, botoes) { if (est.desenho === dz) mostrarBarraDesenho(texto, extra, botoes); },
      encerrar: function () { if (est.desenho === dz) cancelarDesenho(); },
      ativo: function () { return est.desenho === dz; },
    };
  }

  async function usarMinhaPosicaoNoDesenho() {
    var p = await obterMinhaPosicao();
    if (!p.ok) { UI.aviso('Sem a sua localização agora (' + p.motivo + '). Toque no mapa.', 'erro', 7000); return; }
    aoClicarNoMapa({ latlng: { lat: p.lat, lng: p.lng } });
  }

  function concluirPoligono() {
    var dz = est.desenho;
    if (!dz || dz.pontos.length < 3) return;
    $('barra-desenho').hidden = true;
    abrirFormSetor({ forma: 'poligono', pontos: dz.pontos.slice() });
  }

  function cancelarDesenho() {
    var dz = est.desenho;
    if (!dz) return;
    est.desenho = null;
    if (dz.desligar) dz.desligar();
    if (dz.camadaTemp) dz.camadaTemp.remove();
    if (dz.aoCancelar) dz.aoCancelar();
    $('barra-desenho').hidden = true;
    $('mapa').classList.remove('modo-desenho');
  }

  /* ---------- Setores: formulário, detalhes, limites, exclusão ------- */
  function opcoesParticipantes(selecionado, incluirVazio) {
    var sel = UI.el('select', { classe: 'campo', id: 'setor-participante' });
    if (incluirVazio) sel.appendChild(UI.el('option', { value: '', texto: '— ninguém (só a equipe abaixo) —' }));
    Array.from(est.participantes.values())
      .filter(function (p) { return !p.dados.removido || p.id === selecionado; })
      .sort(function (a, b) { return a.dados.nome.localeCompare(b.dados.nome, 'pt-BR'); })
      .forEach(function (p) {
        sel.appendChild(UI.el('option', { value: p.id, selected: p.id === selecionado ? true : null, texto: nomeExibido(p) + ' (' + TIPOS[tipoDe(p.dados)].rotulo.toLowerCase() + ')' }));
      });
    return sel;
  }

  function corLivre() {
    var usadas = new Set(Array.from(est.setores.values()).map(function (s) { return s.d.cor.toLowerCase(); }));
    for (var i = 0; i < CORES_SETOR.length; i++) if (!usadas.has(CORES_SETOR[i].toLowerCase())) return CORES_SETOR[i];
    return CORES_SETOR[est.setores.size % CORES_SETOR.length];
  }

  // s: setor existente (edição) ou base de um novo (forma + geometria)
  function abrirFormSetor(s) {
    var novo = !s.id;
    var d = Object.assign({ nome: 'Setor ' + (est.setores.size + 1), cor: corLivre(), status: 'pendente', equipe: '', observacoes: '', participante_id: null }, s);
    var dz = est.desenho;
    var previa = null;
    function desenharPrevia(raio) {
      if (!dz || d.forma !== 'circulo') return;
      if (previa) previa.remove();
      previa = L.circle([d.centro_lat, d.centro_lng], { radius: raio, color: '#facc15', weight: 2, dashArray: '6 4', fillOpacity: 0.12, interactive: false }).addTo(dz.camadaTemp);
    }
    var nome = UI.el('input', { classe: 'campo', id: 'setor-nome', maxlength: '60', value: d.nome });
    var raio = d.forma === 'circulo' ? UI.el('input', { classe: 'campo', id: 'setor-raio', type: 'number', min: '5', max: '50000', step: '10', inputmode: 'numeric', value: String(Math.round(d.raio_m)) }) : null;
    var area = UI.el('p', { classe: 'meta-area', id: 'setor-area' });
    function atualizarArea() {
      var r = raio ? Number(raio.value) : null;
      var dd = Object.assign({}, d, raio ? { raio_m: r } : {});
      area.textContent = 'Área ≈ ' + (raio && !(r >= 5 && r <= 50000) ? '—' : formatarArea(areaSetorM2(dd)));
      if (raio && r >= 5 && r <= 50000) desenharPrevia(r);
    }
    if (raio) raio.addEventListener('input', atualizarArea);
    var cores = UI.seletorCor({ rotulo: 'Cor do setor', valor: d.cor, padroes: CORES_SETOR });
    var part = opcoesParticipantes(d.participante_id, true);
    var equipe = UI.el('input', { classe: 'campo', id: 'setor-equipe', maxlength: '60', value: d.equipe || '', placeholder: 'Ex.: Equipe Alfa' });
    var status = UI.el('select', { classe: 'campo', id: 'setor-status' }, Object.keys(STATUS_SETOR).map(function (k) {
      return UI.el('option', { value: k, selected: k === d.status ? true : null, texto: STATUS_SETOR[k].rotulo });
    }));
    var obs = UI.el('textarea', { classe: 'campo', id: 'setor-obs', maxlength: '500', rows: '2' });
    obs.value = d.observacoes || '';
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btnSalvar = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'setor-salvar', texto: novo ? 'Criar setor' : 'Salvar' });
    var salvo = false;
    var form = UI.el('form', { classe: 'form-setor form-padrao', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: novo ? 'Novo setor' : 'Editar setor' }),
      UI.secao(null, [
        UI.grade([
          UI.campo('Nome', nome, { para: 'setor-nome', dica: 'Nome, número ou código que a equipe reconhece no rádio.' }),
          raio ? UI.campo('Raio (m)', raio, { para: 'setor-raio' }) : null,
          UI.campo('Situação', status, { para: 'setor-status' }),
          UI.campo('Responsável', part, { para: 'setor-participante' }),
          UI.campo('Equipe', equipe, { para: 'setor-equipe', opcional: true }),
          raio ? null : area,
        ], { tres: true }),
        raio ? area : null,
      ]),
      UI.campo('Cor', cores, { largo: true }),
      UI.campo('Observações', obs, { para: 'setor-obs', largo: true, opcional: true }),
      erro,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btnSalvar]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var dados = {
        nome: nome.value.replace(/\s+/g, ' ').trim(),
        cor: cores.valor() || d.cor,
        participante_id: part.value || null,
        equipe: equipe.value.trim(),
        status: status.value,
        observacoes: obs.value.trim(),
      };
      if (!dados.nome) { erro.textContent = 'Informe o nome do setor.'; erro.hidden = false; return; }
      if (novo || raio) {
        dados.forma = d.forma;
        if (d.forma === 'circulo') {
          var r = Number(raio.value);
          if (!(r >= 5 && r <= 50000)) { erro.textContent = 'O raio deve ficar entre 5 m e 50 km.'; erro.hidden = false; return; }
          Object.assign(dados, { centro_lat: d.centro_lat, centro_lng: d.centro_lng, raio_m: r });
        } else {
          dados.pontos = d.pontos;
        }
      }
      btnSalvar.disabled = true;
      try {
        var res = await C.rpc('salvar_setor', { p_operacao: est.op.id, p_id: d.id || null, p_dados: dados });
        salvo = true;
        fechar(true);
        cancelarDesenho();
        aplicarSetores([res]);
        UI.aviso(novo ? 'Setor "' + res.nome + '" criado.' : 'Setor salvo.', 'ok');
      } catch (e) {
        erro.textContent = 'Não foi possível salvar: ' + e.message;
        erro.hidden = false;
        btnSalvar.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false, aoFechar: function () { if (!salvo && novo) cancelarDesenho(); } });
    atualizarArea();
  }

  function nomeResponsavelSetor(d) {
    var p = d.participante_id && est.participantes.get(d.participante_id);
    var partes = [];
    if (p) partes.push(nomeExibido(p));
    if (d.equipe) partes.push(d.equipe);
    return partes.join(' · ') || 'Ninguém atribuído';
  }

  function verSetorNoMapa(d) {
    if (!est.mapa) return;
    if (!est.prefsMapa.setores) definirPrefMapa('setores', true);
    if (telaPequena()) { fecharAreas(); }
    UI.fecharModal();
    est.mapa.fitBounds(L.latLngBounds(verticesSetor(d)), { padding: [40, 40], maxZoom: 17 });
  }

  /* ---------- Camada de POA no mapa (js/busca-cenario.js) ---------- */
  // Setores pintados pela probabilidade atual. Escala própria (violeta), que não se confunde com as cores de
  // emergência nem de risco, e camada separada da passagem GPS e das missões. valores: { setorId: fração } ou nulo (remove).
  function escalaProb(t) {
    var a = [237, 233, 254], b = [91, 33, 182];
    return 'rgb(' + [0, 1, 2].map(function (i) { return Math.round(a[i] + (b[i] - a[i]) * t); }).join(',') + ')';
  }
  function camadaProbabilidade(valores, titulo) {
    if (est.camadaProb) { est.camadaProb.remove(); est.camadaProb = null; }
    if (est.legendaProb) { est.legendaProb.remove(); est.legendaProb = null; }
    if (!valores || !est.mapa) return;
    var max = 0;
    Object.keys(valores).forEach(function (k) { max = Math.max(max, valores[k]); });
    if (!(max > 0)) return;
    var grupo = L.layerGroup();
    est.setores.forEach(function (s, id) {
      if (valores[id] == null) return;
      L.polygon(verticesSetor(s.d), { color: '#4c1d95', weight: 1, fillColor: escalaProb(valores[id] / max), fillOpacity: 0.55, interactive: false }).addTo(grupo);
    });
    grupo.addTo(est.mapa);
    est.camadaProb = grupo;
    var Legenda = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd: function () {
        var div = L.DomUtil.create('div', 'legenda-prob');
        div.innerHTML = '<strong></strong><span class="legenda-prob-barra"></span><span class="legenda-prob-eixo"><small>0%</small><small></small></span>';
        div.querySelector('strong').textContent = titulo || 'POA atual (prévia)';
        div.querySelectorAll('small')[1].textContent = (max * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '% (maior setor)';
        return div;
      },
    });
    est.legendaProb = new Legenda();
    est.legendaProb.addTo(est.mapa);
  }

  /* ---------- Detalhes de setor, ponto de interesse e trilha (mesmo padrão visual) ---------- */
  // Cabeçalho com a cor do item, o tipo, o nome e uma etiqueta de situação
  function cabecaDetalhe(o) {
    return UI.el('header', { classe: 'detalhe-cabeca', style: '--cor:' + (o.cor || '#64748b') }, [
      o.marca || null,
      UI.el('div', { classe: 'detalhe-cabeca-texto' }, [
        UI.el('small', { classe: 'detalhe-tipo', texto: o.tipo }),
        UI.el('h2', { id: 'modal-titulo', classe: 'detalhe-titulo' }, [o.titulo].concat(o.extra || [])),
      ]),
      o.etiqueta ? UI.el('span', { classe: 'selo ' + o.etiqueta.classe, texto: o.etiqueta.texto }) : null,
    ]);
  }

  // Fatos em caixinhas: [rotulo, valor, ocupa a largura toda?]. Entradas nulas são ignoradas.
  function fatosDetalhe(lista) {
    return UI.el('dl', { classe: 'detalhe-fatos' }, lista.filter(Boolean).map(function (f) {
      return UI.el('div', { classe: 'detalhe-fato' + (f[2] ? ' largo' : '') }, [UI.el('dt', { texto: f[0] }), UI.el('dd', null, [f[1]])]);
    }));
  }

  function secaoDetalhe(titulo, conteudo) {
    return UI.el('section', { classe: 'detalhe-secao' }, [UI.el('h3', { texto: titulo }), conteudo]);
  }

  // Ações no rodapé do detalhe (em telas estreitas, as menos usadas vão para "Mais")
  function rodapeDetalhe(botoes) {
    return compactarAcoes(UI.el('div', { classe: 'detalhe-rodape modal-acoes acoes-detalhe' }, botoes));
  }

  function abrirSetor(id) {
    var s = est.setores.get(id);
    if (!s) return;
    var d = s.d;
    var cob = coberturaSetor(d);
    var caixaCob = UI.el('div', { classe: 'nota nota-cobertura' }, [
      UI.el('strong', { texto: 'Percorrido (estimativa pelos rastros GPS): ' + cob.pct + '%' }),
      UI.el('div', { texto: cob.comRastros
        ? 'Parte da área que ficou a até ' + FAIXA_COBERTURA_M + ' m de algum rastro. Não prova que o setor foi vasculhado: só a equipe confirma, marcando "Concluído".'
        : 'Nenhum rastro GPS passou por este setor ainda.' }),
    ]);
    var podeEditar = podeAlterar();
    var botoesStatus = UI.el('div', { classe: 'status-setor', role: 'group', 'aria-label': 'Situação do setor' }, Object.keys(STATUS_SETOR).map(function (k) {
      return UI.el('button', {
        classe: 'btn btn-pequeno status-' + k + (d.status === k ? ' btn-ativo' : ''), type: 'button', 'data-status': k,
        'aria-pressed': String(d.status === k), disabled: podeEditar ? null : true, texto: STATUS_SETOR[k].rotulo,
        onclick: async function () {
          if (k === d.status) return;
          try {
            var res = await C.rpc('salvar_setor', { p_operacao: est.op.id, p_id: d.id, p_dados: { status: k } });
            aplicarSetores([res]);
            UI.aviso('Setor "' + res.nome + '": ' + STATUS_SETOR[k].rotulo + '.', 'ok');
            abrirSetor(id);
          } catch (e) { UI.aviso(e.message, 'erro'); }
        },
      });
    }));
    var classeSituacao = { pendente: 'selo-neutro', andamento: 'selo-alerta', concluido: 'selo-ok' }[d.status] || 'selo-neutro';
    var fechar = UI.abrirModal(UI.el('div', { classe: 'detalhe-setor' }, [
      cabecaDetalhe({
        cor: d.cor, tipo: 'Setor de busca · ' + (d.forma === 'circulo' ? 'círculo' : 'área desenhada'), titulo: d.nome,
        etiqueta: { texto: STATUS_SETOR[d.status].rotulo, classe: classeSituacao },
      }),
      secaoDetalhe('Situação', botoesStatus),
      fatosDetalhe([
        ['Área aproximada', formatarArea(areaSetorM2(d))],
        d.forma === 'circulo' ? ['Raio', Math.round(d.raio_m).toLocaleString('pt-BR') + ' m'] : ['Cantos', String(d.pontos.length)],
        ['Responsável', nomeResponsavelSetor(d)],
        ['Equipe', d.equipe || 'não informada'],
        ['Criado', C.hora(d.criado_em) + ' por ' + d.criado_por_nome, true],
        d.atualizado_por_nome && d.atualizado_em !== d.criado_em ? ['Alterado', C.hora(d.atualizado_em) + ' por ' + d.atualizado_por_nome, true] : null,
      ]),
      d.observacoes ? secaoDetalhe('Observações', UI.el('p', { classe: 'detalhe-texto', texto: d.observacoes })) : null,
      secaoDetalhe('Busca', UI.el('div', { classe: 'detalhe-busca' }, [caixaCob, window.BuscaCenario ? window.BuscaCenario.blocoSetor(d) : null])),
      rodapeDetalhe([
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Ver no mapa', onclick: function () { fechar(); verSetorNoMapa(d); } }),
        podeEditar ? UI.el('button', { classe: 'btn', type: 'button', texto: 'Editar', onclick: function () { abrirFormSetor(d); } }) : null,
        podeEditar ? UI.el('button', { classe: 'btn', type: 'button', id: 'setor-ajustar', texto: 'Ajustar limites', onclick: function () { fechar(); ajustarLimites(d.id); } }) : null,
        podeEditar && est.op.status === 'ativa' ? UI.el('button', { classe: 'btn', type: 'button', texto: '🧭 Enviar o centro como destino', onclick: function () {
          var c = centroSetor(d);
          fechar();
          abrirEnviarDestino({ nome: 'Setor ' + d.nome, lat: c[0], lng: c[1], setor_id: d.id, participantes: d.participante_id ? [d.participante_id] : [] });
        } }) : null,
        podeEditar ? UI.el('button', { classe: 'btn btn-perigo', type: 'button', id: 'setor-excluir', texto: 'Excluir', onclick: function () { fechar(); excluirSetor(d); } }) : null,
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]));
  }

 async function excluirSetor(d) {
    var r = await UI.confirmar({
      titulo: 'Excluir o setor "' + d.nome + '"?',
      texto: 'O setor some do mapa de todos os responsáveis (e do celular de quem estava atribuído). As trilhas GPS não são afetadas.',
      ok: 'Excluir setor',
      perigo: true,
    });
    if (!r) return;
    try {
      await C.rpc('excluir_setor', { p_id: d.id });
      var s = est.setores.get(d.id);
      if (s && s.camada) s.camada.remove();
      est.setores.delete(d.id);
      renderizarAreas();
      UI.aviso('Setor excluído.', 'ok');
    } catch (e) {
      UI.aviso(e.codigo === 'sem_permissao' ? 'Só quem criou o setor, quem criou a operação ou um administrador pode excluí-lo.' : e.message, 'erro', 7000);
    }
  }

  // Ajuste dos limites direto no mapa: arrastar cantos (polígono) ou centro/raio (círculo).
  function ajustarLimites(id) {
    var s = est.setores.get(id);
    if (!s || !est.mapa) return;
    cancelarDesenho();
    var d = s.d;
    if (telaPequena()) { fecharAreas(); }
    est.desenho = { tipo: 'ajuste', id: id, camadaTemp: L.layerGroup().addTo(est.mapa), aoCancelar: function () { desenharSetor(s); } };
    var dz = est.desenho;
    if (s.camada) { s.camada.remove(); s.camada = null; }
    var cor = d.cor;
    var botoes = [
      UI.el('button', { classe: 'btn btn-pequeno btn-ok', type: 'button', id: 'ajuste-salvar', texto: 'Salvar limites', onclick: salvarAjuste }),
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Cancelar', onclick: cancelarDesenho }),
    ];
    function iconeVertice(classe) { return L.divIcon({ className: 'vertice-wrap', html: '<div class="' + classe + '"></div>', iconSize: [0, 0] }); }
    if (d.forma === 'poligono') {
      var pts = d.pontos.map(function (p) { return p.slice(); });
      var redesenhar = function () {
        dz.camadaTemp.clearLayers();
        L.polygon(pts, { color: cor, weight: 2.5, fillColor: cor, fillOpacity: 0.12, dashArray: '6 4', interactive: false }).addTo(dz.camadaTemp);
        pts.forEach(function (p, i) {
          var v = L.marker(p, { icon: iconeVertice('vertice'), draggable: true, zIndexOffset: 3000, title: 'Arraste para mover; toque para remover' }).addTo(dz.camadaTemp);
          v.on('drag', function (e) { pts[i] = [e.latlng.lat, e.latlng.lng]; poli.setLatLngs(pts); });
          v.on('dragend', redesenhar);
          v.on('click', function () {
            if (pts.length <= 3) { UI.aviso('A área precisa de pelo menos 3 cantos.', 'erro'); return; }
            pts.splice(i, 1);
            redesenhar();
          });
          var j = (i + 1) % pts.length;
          var meio = [(p[0] + pts[j][0]) / 2, (p[1] + pts[j][1]) / 2];
          L.marker(meio, { icon: iconeVertice('vertice-meio'), zIndexOffset: 2900, title: 'Toque para criar um canto aqui' })
            .on('click', function () { pts.splice(j === 0 ? pts.length : j, 0, meio); redesenhar(); })
            .addTo(dz.camadaTemp);
        });
        var poli = dz.camadaTemp.getLayers()[0];
      };
      redesenhar();
      dz.obter = function () { return { forma: 'poligono', pontos: pts.map(function (p) { return [Math.round(p[0] * 1e7) / 1e7, Math.round(p[1] * 1e7) / 1e7]; }) }; };
      mostrarBarraDesenho('Arraste os cantos · toque em ◇ para criar um canto · toque num canto para removê-lo.', null, botoes);
    } else {
      var centro = [d.centro_lat, d.centro_lng];
      var raioIn = UI.el('input', { classe: 'campo campo-raio', type: 'number', min: '5', max: '50000', step: '10', id: 'ajuste-raio', 'aria-label': 'Raio em metros', value: String(Math.round(d.raio_m)) });
      var circ = L.circle(centro, { radius: d.raio_m, color: cor, weight: 2.5, fillColor: cor, fillOpacity: 0.12, dashArray: '6 4', interactive: false }).addTo(dz.camadaTemp);
      var vc = L.marker(centro, { icon: iconeVertice('vertice'), draggable: true, zIndexOffset: 3000, title: 'Arraste para mover o centro' }).addTo(dz.camadaTemp);
      vc.on('drag', function (e) { centro = [e.latlng.lat, e.latlng.lng]; circ.setLatLng(centro); });
      raioIn.addEventListener('input', function () { var r = Number(raioIn.value); if (r >= 5 && r <= 50000) circ.setRadius(r); });
      dz.obter = function () {
        var r = Number(raioIn.value);
        if (!(r >= 5 && r <= 50000)) return null;
        return { forma: 'circulo', centro_lat: Math.round(centro[0] * 1e7) / 1e7, centro_lng: Math.round(centro[1] * 1e7) / 1e7, raio_m: r };
      };
      mostrarBarraDesenho('Arraste o centro e ajuste o raio (m):', raioIn, botoes);
    }
    est.mapa.fitBounds(L.latLngBounds(verticesSetor(d)), { padding: [60, 60], maxZoom: 17 });
    $('mapa').classList.add('modo-desenho');

    async function salvarAjuste() {
      var dados = dz.obter();
      if (!dados) { UI.aviso('O raio deve ficar entre 5 m e 50 km.', 'erro'); return; }
      try {
        var res = await C.rpc('salvar_setor', { p_operacao: est.op.id, p_id: id, p_dados: dados });
        dz.aoCancelar = null;
        cancelarDesenho();
        aplicarSetores([res]);
        UI.aviso('Limites do setor "' + res.nome + '" salvos.', 'ok');
      } catch (e) {
        UI.aviso('Não foi possível salvar: ' + e.message, 'erro', 7000);
      }
    }
  }

  /* ---------- Pontos de interesse: formulário e detalhes ------------- */
  function abrirFormPontoInt(base) {
    var novo = !base.id;
    var d = Object.assign({ categoria: 'OUTRO', titulo: '', descricao: '' }, base);
    // Categorias fixas (com regras: risco, base, vítima…) e, depois, os tipos criados pelos responsáveis.
    // Valor do rádio: a categoria ('RISCO'…) ou 'tipo:<id>'.
    var marcadoInicial = d.tipo_id ? 'tipo:' + d.tipo_id : d.categoria;
    var grade = UI.el('div', { classe: 'cat-pontos', role: 'radiogroup', 'aria-label': 'Categoria' });
    function rotuloDaOpcao(v) {
      if (!v) return '';
      if (v.indexOf('tipo:') === 0) { var t = est.tiposPonto.get(v.slice(5)); return t ? t.nome : ''; }
      return CAT_PONTO[v] ? CAT_PONTO[v].rotulo : '';
    }
    function rotulosConhecidos() {
      var r = Object.keys(CAT_PONTO).map(function (c) { return CAT_PONTO[c].rotulo; });
      est.tiposPonto.forEach(function (t) { r.push(t.nome); });
      return r;
    }
    function opcaoCat(valor, marca, rotulo, extra) {
      return UI.el('label', { classe: 'cat-ponto' + (extra ? ' ' + extra : '') }, [
        UI.el('input', { type: 'radio', name: 'ponto-cat', value: valor, checked: valor === marcadoInicial ? true : null }),
        marca,
        UI.el('span', { classe: 'cat-ponto-txt', texto: rotulo }),
      ]);
    }
    function desenharGrade(marcar) {
      var atual = marcar || (grade.querySelector('input:checked') || {}).value || marcadoInicial;
      marcadoInicial = atual;
      grade.innerHTML = '';
      Object.keys(CAT_PONTO).forEach(function (k) {
        grade.appendChild(opcaoCat(k, elMarcaPonto({ categoria: k }), CAT_PONTO[k].rotulo));
      });
      var tipos = Array.from(est.tiposPonto.values()).filter(function (t) { return t.ativo || 'tipo:' + t.id === atual; })
        .sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
      tipos.forEach(function (t) {
        grade.appendChild(opcaoCat('tipo:' + t.id, elMarcaPonto({ categoria: 'OUTRO', tipo_id: t.id, icone: t.icone, cor: t.cor }), t.nome, 'cat-ponto-tipo'));
      });
      // tipo que o ponto usa mas não está carregado (ex.: banco sem permissão de leitura): mantém a escolha
      if (atual.indexOf('tipo:') === 0 && !est.tiposPonto.has(atual.slice(5))) {
        grade.appendChild(opcaoCat(atual, elMarcaPonto(d), d.titulo || 'Tipo do ponto', 'cat-ponto-tipo'));
      }
      grade.appendChild(UI.el('button', { classe: 'cat-ponto cat-ponto-novo', type: 'button', id: 'ponto-novo-tipo',
        title: 'Criar um tipo de ponto com nome, ícone e cor próprios (fica disponível para todos os responsáveis)', onclick: function () {
          abrirTipoPonto(null, function (t) { desenharGrade('tipo:' + t.id); aoMudarCat(); });
        } }, [UI.el('span', { classe: 'mk-poi', 'aria-hidden': 'true' }, [UI.el('span', { texto: '＋' })]), UI.el('span', { classe: 'cat-ponto-txt', texto: 'Novo tipo' })]));
      grade.appendChild(UI.el('button', { classe: 'cat-ponto cat-ponto-novo', type: 'button', id: 'ponto-gerir-tipos', title: 'Trocar o ícone e a cor de qualquer categoria, editar ou deixar de usar tipos', onclick: function () {
        abrirGerirTiposPonto(function () { desenharGrade(); aoMudarCat(); });
      } }, [UI.el('span', { classe: 'mk-poi', 'aria-hidden': 'true' }, [UI.el('span', { texto: '✎' })]), UI.el('span', { classe: 'cat-ponto-txt', texto: 'Ícones e tipos' })]));
    }
    desenharGrade();
    var titulo = UI.el('input', { classe: 'campo', id: 'ponto-titulo', maxlength: '80', value: d.titulo, placeholder: 'Ex.: Última vez vista na trilha da cachoeira' });
    var desc = UI.el('textarea', { classe: 'campo', id: 'ponto-desc', maxlength: '1000', rows: '3', placeholder: 'Opcional' });
    desc.value = d.descricao || '';
    var lat = UI.el('input', { classe: 'campo mono', id: 'ponto-lat', type: 'number', step: 'any', inputmode: 'decimal', value: String(d.lat) });
    var lng = UI.el('input', { classe: 'campo mono', id: 'ponto-lng', type: 'number', step: 'any', inputmode: 'decimal', value: String(d.lng) });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'ponto-salvar', texto: novo ? 'Marcar ponto' : 'Salvar' });
    // coordenada digitada em qualquer formato (UTM, MGRS, GMS, decimal) preenche latitude/longitude
    var coordTxt = UI.el('input', { classe: 'campo mono', id: 'ponto-coord', placeholder: 'Colar coordenada (UTM, MGRS, graus…)' });
    var coordInfo = UI.el('small', { classe: 'muted', id: 'ponto-coord-info' });
    coordTxt.addEventListener('input', function () {
      var c = window.Coords.interpretar(coordTxt.value);
      if (c) { lat.value = String(Math.round(c.lat * 1e7) / 1e7); lng.value = String(Math.round(c.lng * 1e7) / 1e7); coordInfo.textContent = '✓ ' + window.Coords.formatar(c.lat, c.lng, 'dec'); }
      else coordInfo.textContent = coordTxt.value.trim() ? 'Formato não reconhecido' : '';
    });
    var raio = UI.el('input', { classe: 'campo', id: 'ponto-raio', type: 'number', min: '10', max: '5000', step: '10', inputmode: 'numeric',
      value: d.raio_m ? String(Math.round(d.raio_m)) : String(d.categoria === 'BASE' ? RAIO_BASE_PADRAO : RAIO_ALERTA_PADRAO) });
    var rotRaio = UI.el('label', { classe: 'rotulo', for: 'ponto-raio' });
    var grupoRaio = UI.el('div', { classe: 'campo-bloco' }, [rotRaio, raio]);
    // Raio: alarme de proximidade (área de risco) ou chegada (base).
    function ajustarRaio(k) {
      grupoRaio.hidden = k !== 'RISCO' && k !== 'BASE';
      rotRaio.innerHTML = '';
      rotRaio.appendChild(document.createTextNode(k === 'BASE' ? 'Raio da base (m)' : 'Raio de alerta (m)'));
      rotRaio.appendChild(UI.dica(k === 'BASE'
        ? 'Quem estiver dentro deste círculo, com GPS preciso, conta como "chegou à base" no controle de retorno.'
        : 'Quem entrar neste círculo recebe um alerta no celular e o painel é avisado.'));
    }
    ajustarRaio(d.categoria);
    var rotuloAnterior = '';
    function aoMudarCat() {
      var k = (grade.querySelector('input:checked') || {}).value;
      if (k === 'BASE' && !d.raio_m && Number(raio.value) === RAIO_ALERTA_PADRAO) raio.value = String(RAIO_BASE_PADRAO);
      ajustarRaio(k);
      // nome ainda é o rótulo de uma categoria (ou vazio): acompanha a escolha
      var atual = titulo.value.trim();
      if (k && (!atual || atual === rotuloAnterior || rotulosConhecidos().indexOf(atual) !== -1)) titulo.value = rotuloDaOpcao(k);
      rotuloAnterior = rotuloDaOpcao(k);
    }
    grade.addEventListener('change', aoMudarCat);
    if (!d.titulo) titulo.value = rotuloDaOpcao(marcadoInicial) || CAT_PONTO.OUTRO.rotulo;
    rotuloAnterior = rotuloDaOpcao(marcadoInicial);
    var salvo = false;
    var form = UI.el('form', { classe: 'form-ponto form-padrao', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: novo ? 'Marcar ponto' : 'Editar ponto' }),
      d.relatado_por_nome ? UI.el('p', { classe: 'ajuda', texto: 'Relato de ' + d.relatado_por_nome }) : null,
      UI.secao('Categoria', [grade]),
      UI.el('div', { classe: 'form-colunas' }, [
        UI.secao('Identificação', [
          UI.campo('Nome', titulo, { para: 'ponto-titulo' }),
          grupoRaio,
          UI.campo('Observações', desc, { para: 'ponto-desc' }),
        ]),
        UI.secao('Local', [
          UI.campo('Coordenada', coordTxt, { para: 'ponto-coord', dica: 'Pode colar em qualquer formato: decimal, UTM, MGRS ou graus. A latitude e a longitude são preenchidas sozinhas.' }),
          coordInfo,
          UI.grade([
            UI.campo('Latitude', lat, { para: 'ponto-lat' }),
            UI.campo('Longitude', lng, { para: 'ponto-lng' }),
          ]),
        ]),
      ]),
      erro,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var escolha = (grade.querySelector('input:checked') || {}).value;
      var dados = {
        categoria: escolha && escolha.indexOf('tipo:') === 0 ? 'OUTRO' : escolha,
        titulo: titulo.value.replace(/\s+/g, ' ').trim(),
        descricao: desc.value.trim(),
        lat: Number(lat.value),
        lng: Number(lng.value),
      };
      if (!dados.categoria) { erro.textContent = 'Escolha a categoria.'; erro.hidden = false; return; }
      if (!dados.titulo) { erro.textContent = 'Informe o nome do ponto.'; erro.hidden = false; return; }
      if (!isFinite(dados.lat) || !isFinite(dados.lng) || Math.abs(dados.lat) > 90 || Math.abs(dados.lng) > 180 || (dados.lat === 0 && dados.lng === 0)) {
        erro.textContent = 'Coordenadas inválidas.'; erro.hidden = false; return;
      }
      if (novo && d.mensagem_id) dados.mensagem_id = d.mensagem_id;
      if (escolha.indexOf('tipo:') === 0) dados.tipo_id = escolha.slice(5);
      else if (d.tipo_id) dados.tipo_id = null;   // voltou para uma categoria fixa
      if (dados.categoria === 'RISCO' || dados.categoria === 'BASE') {
        var r = Number(raio.value);
        if (!isFinite(r) || r < 10 || r > 5000) { erro.textContent = 'Raio: de 10 m a 5.000 m.'; erro.hidden = false; return; }
        dados.raio_m = Math.round(r);
      }
      btn.disabled = true;
      try {
        var res = await C.rpc('salvar_ponto', { p_operacao: est.op.id, p_id: d.id || null, p_dados: dados });
        salvo = true;
        fechar(true);
        cancelarDesenho();
        aplicarPontos([res]);
        if (!est.prefsMapa.pontos) definirPrefMapa('pontos', true);
        UI.aviso(novo ? 'Ponto "' + res.titulo + '" marcado.' : 'Ponto salvo.', 'ok');
      } catch (e) {
        erro.textContent = 'Não foi possível salvar: ' + e.message;
        erro.hidden = false;
        btn.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false, tamanho: 'largo', aoFechar: function () { if (!salvo) cancelarDesenho(); } });
  }

  // Coordenadas no formato escolhido (Ferramentas › Formato das coordenadas), com os
  // outros formatos logo abaixo e botão de copiar — para passar por rádio ou telefone.
  function blocoCoordenadas(lat, lng) {
    var fmt = est.prefsMapa.coord || 'dec';
    var principal = window.Coords.formatar(lat, lng, fmt);
    var outros = Object.keys(window.Coords.FORMATOS).filter(function (f) { return f !== fmt; })
      .map(function (f) { return UI.el('div', { classe: 'mono muted coord-outro', texto: window.Coords.formatar(lat, lng, f) }); });
    return UI.el('div', { classe: 'bloco-coord' }, [
      UI.el('span', { classe: 'mono coord-principal', texto: principal }), ' ',
      UI.el('button', { classe: 'btn btn-pequeno btn-link', type: 'button', texto: 'Copiar', onclick: function () { copiarTexto(principal); } }),
    ].concat(outros));
  }

  function copiarTexto(t) {
    var ok = function () { UI.aviso('Copiado: ' + t, 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok, function () { UI.aviso(t, 'ok', 9000); });
    else UI.aviso(t, 'ok', 9000);
  }

  function verPontoNoMapa(d) {
    if (!est.mapa) return;
    if (!est.prefsMapa.pontos) definirPrefMapa('pontos', true);
    if (telaPequena()) fecharAreas();
    var p = est.pontosInt.get(d.id);
    var mk = p && p.marcador;
    // dentro de um grupo: aproxima até o ponto aparecer sozinho e pisca
    destacarNoMapa(mk && camadaDoPonto(mk), mk, d.lat, d.lng);
  }

  /* ---------- Tipos de ponto criados pelos responsáveis ------------- */
  var CORES_TIPO = ['#64748b', '#2563eb', '#16a34a', '#f59e0b', '#7c3aed', '#0891b2', '#db2777', '#92400e'];

  // Criar ou editar um tipo (nome, ícone, cor). Abre por cima do formulário do ponto. aoSalvar(tipo)
  function abrirTipoPonto(t, aoSalvar) {
    var nome = UI.el('input', { classe: 'campo', id: 'tipo-ponto-nome', maxlength: '40', value: t ? t.nome : '', placeholder: 'Ex.: Pouso de helicóptero' });
    var cor = t ? t.cor : CORES_TIPO[est.tiposPonto.size % CORES_TIPO.length];
    // ícone: o catálogo inteiro (Escolher ícone), ou qualquer letra/sigla/emoji digitado lá
    var icone = UI.seletorIcone({ id: 'tipo-ponto-icone', rotulo: 'Ícone do tipo', valor: t ? t.icone : null, cor: cor });
    var cores = UI.seletorCor({ rotulo: 'Cor do tipo', valor: cor, padroes: CORES_TIPO, aoMudar: function (c) { cor = c; icone.definirCor(c); } });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'tipo-ponto-salvar', texto: t ? 'Salvar tipo' : 'Criar tipo' });
    var form = UI.el('form', { classe: 'form-padrao', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: t ? 'Editar tipo de ponto' : 'Novo tipo de ponto' }),
      UI.dica('O tipo fica disponível para todos os responsáveis, em qualquer operação. Pontos já marcados com ele acompanham as mudanças de ícone e cor.'),
      UI.secao('Tipo', [
        UI.campo('Nome', nome, { para: 'tipo-ponto-nome' }),
        UI.campo('Ícone', icone, { dica: '"Escolher ícone" abre todos os ícones, com busca. Também vale letra, sigla ou emoji digitado.' }),
        cores,
      ]),
      erro,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var dados = { nome: nome.value.replace(/\s+/g, ' ').trim(), icone: icone.valor(), cor: cores.valor() || cor };
      if (dados.nome.length < 2) { erro.textContent = 'Informe o nome do tipo (2 a 40 letras).'; erro.hidden = false; return; }
      if (!dados.icone) { erro.textContent = 'Escolha um ícone.'; erro.hidden = false; return; }
      btn.disabled = true;
      try {
        var res = await C.rpc('salvar_tipo_ponto', { p_id: t ? t.id : null, p_dados: dados });
        est.tiposPonto.set(res.id, res);
        fechar();
        UI.aviso(t ? 'Tipo "' + res.nome + '" salvo.' : 'Tipo "' + res.nome + '" criado.', 'ok');
        est.pontosInt.forEach(function (p) { if (p.d.tipo_id === res.id) { p.d.icone = res.icone; p.d.cor = res.cor; desenharPontoInt(p); } });
        renderizarAreas();
        if (aoSalvar) aoSalvar(res);
      } catch (e) {
        erro.textContent = 'Não foi possível salvar: ' + e.message;
        erro.hidden = false;
        btn.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form, { empilhar: true, fecharNoFundo: false });
    setTimeout(function () { nome.focus(); }, 30);
  }

  // Ícone e cor de uma categoria fixa (para todos os responsáveis; as regras da categoria não mudam). aoSalvar()
  function abrirEstiloCategoria(k, aoSalvar) {
    var e = est.estilosCategoria.get(k) || {};
    var cor = e.cor || COR_CATEGORIA[k];
    var icone = UI.seletorIcone({ id: 'estilo-cat-icone', rotulo: 'Ícone', valor: e.icone || CAT_PONTO[k].letra, cor: cor });
    var cores = UI.seletorCor({ rotulo: 'Cor', valor: cor, padroes: [COR_CATEGORIA[k]].concat(CORES_TIPO), aoMudar: function (c) { cor = c; icone.definirCor(c); } });
    async function salvar(ic, c) {
      try {
        var res = await C.rpc('salvar_estilo_categoria', { p_categoria: k, p_icone: ic, p_cor: c });
        if (res && (res.icone || res.cor)) est.estilosCategoria.set(k, res); else est.estilosCategoria.delete(k);
        fechar();
        est.pontosInt.forEach(function (p) { if (p.d.categoria === k && !p.d.tipo_id) desenharPontoInt(p); });
        renderizarAreas();
        UI.aviso('Aparência de "' + CAT_PONTO[k].rotulo + '" salva.', 'ok');
        if (aoSalvar) aoSalvar();
      } catch (er) { UI.aviso('Não foi possível salvar: ' + er.message, 'erro', 7000); }
    }
    var fechar = UI.abrirModal(UI.el('div', { classe: 'form-padrao' }, [
      UI.el('h2', { id: 'modal-titulo', texto: CAT_PONTO[k].rotulo }),
      UI.dica('Muda só a aparência desta categoria, em todas as operações. As regras dela (alarme de risco, raio da base, vítima) continuam.'),
      UI.secao('Aparência', [UI.campo('Ícone', icone), cores]),
      UI.rodape([
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }),
        UI.el('button', { classe: 'btn', type: 'button', id: 'estilo-cat-padrao', texto: 'Voltar ao padrão', onclick: function () { salvar(null, null); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', id: 'estilo-cat-salvar', texto: 'Salvar', onclick: function () { salvar(icone.valor(), cores.valor() || cor); } }),
      ]),
    ]), { empilhar: true });
  }

  // Ícones das categorias fixas e tipos criados: trocar ícone/cor; editar ou deixar de usar tipos (quem criou ou administrador). aoMudar()
  function abrirGerirTiposPonto(aoMudar) {
    var fixas = UI.el('ul', { classe: 'lista-areas' });
    var lista = UI.el('ul', { classe: 'lista-areas' });
    function desenhar() {
      fixas.innerHTML = '';
      Object.keys(CAT_PONTO).forEach(function (k) {
        var e = est.estilosCategoria.get(k);
        fixas.appendChild(UI.el('li', { classe: 'item-area tipo-ponto-item' }, [
          elMarcaPonto({ categoria: k }),
          UI.el('span', { classe: 'item-area-txt' }, [UI.el('strong', { texto: CAT_PONTO[k].rotulo }),
            UI.el('small', { classe: 'muted', texto: e ? 'Escolhido por ' + e.atualizado_por_nome : 'Padrão' })]),
          UI.el('button', { classe: 'btn btn-pequeno', type: 'button', 'data-categoria': k, texto: 'Trocar ícone', onclick: function () {
            abrirEstiloCategoria(k, function () { desenhar(); if (aoMudar) aoMudar(); });
          } }),
        ]));
      });
      lista.innerHTML = '';
      var tipos = Array.from(est.tiposPonto.values()).filter(function (t) { return t.ativo; }).sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
      if (!tipos.length) lista.appendChild(UI.el('li', { classe: 'muted', texto: 'Nenhum tipo criado.' }));
      tipos.forEach(function (t) {
        var meu = (est.usuario && t.criado_por === est.usuario.id) || (est.responsavel && est.responsavel.admin);
        lista.appendChild(UI.el('li', { classe: 'item-area tipo-ponto-item' }, [
          elMarcaPonto({ categoria: 'OUTRO', tipo_id: t.id, icone: t.icone, cor: t.cor }),
          UI.el('span', { classe: 'item-area-txt' }, [UI.el('strong', { texto: t.nome }), UI.el('small', { classe: 'muted', texto: 'Criado por ' + t.criado_por_nome })]),
          meu ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Editar', onclick: function () {
            abrirTipoPonto(t, function () { desenhar(); if (aoMudar) aoMudar(); });
          } }) : null,
          meu ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Deixar de usar', title: 'Some da lista de categorias; pontos já marcados continuam no mapa', onclick: async function () {
            if (!(await UI.confirmar({ titulo: 'Deixar de usar "' + t.nome + '"?', texto: 'O tipo some da lista de categorias. Os pontos já marcados com ele continuam no mapa, com o mesmo ícone.', ok: 'Deixar de usar', empilhar: true }))) return;
            try {
              var res = await C.rpc('salvar_tipo_ponto', { p_id: t.id, p_dados: { ativo: false } });
              est.tiposPonto.set(res.id, res);
              desenhar();
              if (aoMudar) aoMudar();
            } catch (e) { UI.aviso('Não foi possível alterar: ' + e.message, 'erro', 7000); }
          } }) : null,
        ]));
      });
    }
    desenhar();
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Ícones e tipos de ponto' }),
      UI.dica('Qualquer categoria pode ter o ícone e a cor trocados (vale para todas as operações). Os tipos criados só são alterados por quem criou ou por um administrador.'),
      UI.secao('Categorias', [fixas]),
      UI.secao('Tipos criados', [lista, UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '＋ Novo tipo', onclick: function () {
        abrirTipoPonto(null, function () { desenhar(); if (aoMudar) aoMudar(); });
      } })]),
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]), { empilhar: true, tamanho: 'largo' });
  }

  function abrirPontoInt(id) {
    var p = est.pontosInt.get(id);
    if (!p) return;
    var d = p.d;
    var cat = catDoPonto(d);
    var alt = UI.el('span', { classe: 'muted', texto: 'consultando o modelo de terreno…' });
    var foto = d.foto_id && est.fotos.get(d.foto_id);
    var ativa = est.op.status === 'ativa';
    var editavel = podeAlterar();
    var fechar = UI.abrirModal(UI.el('div', { classe: 'detalhe-ponto' }, [
      cabecaDetalhe({
        marca: elMarcaPonto(d, { 'aria-hidden': 'true' }),
        tipo: 'Ponto de interesse · ' + cat.rotulo, titulo: d.titulo,
        extra: [editavel ? UI.el('button', { classe: 'btn btn-pequeno btn-renomear', type: 'button', id: 'ponto-renomear', title: 'Renomear o ponto', 'aria-label': 'Renomear o ponto', texto: '✎',
          onclick: function () { fechar(); renomearPonto(d); } }) : null],
      }),
      fatosDetalhe([
        ['Coordenadas', blocoCoordenadas(d.lat, d.lng), true],
        ['Altitude', alt],
        d.categoria === 'RISCO' ? ['Alarme de proximidade', 'raio de ' + Math.round(d.raio_m || RAIO_ALERTA_PADRAO) + ' m'] : null,
        d.categoria === 'BASE' ? ['Chegada à base', 'raio de ' + Math.round(d.raio_m || RAIO_BASE_PADRAO) + ' m'] : null,
        ['Registrado', C.hora(d.criado_em) + ' por ' + d.criado_por_nome],
        d.relatado_por_nome ? ['Relatado por', d.relatado_por_nome + ' (participante)'] : null,
        d.atualizado_por_nome && d.atualizado_em !== d.criado_em ? ['Alterado', C.hora(d.atualizado_em) + ' por ' + d.atualizado_por_nome] : null,
      ]),
      d.descricao ? secaoDetalhe('Descrição', UI.el('p', { classe: 'detalhe-texto', texto: d.descricao })) : null,
      foto ? secaoDetalhe('Foto', UI.el('div', { classe: 'ponto-foto' }, [miniatura(foto, [foto.id])])) : null,
      rodapeDetalhe([
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Ver no mapa', onclick: function () { fechar(); verPontoNoMapa(d); } }),
        ativa ? UI.el('button', { classe: 'btn', type: 'button', id: 'ponto-destino', texto: '🧭 Enviar como destino', onclick: function () { abrirEnviarDestino({ nome: d.titulo, lat: d.lat, lng: d.lng, ponto_id: d.id }); } }) : null,
        editavel ? UI.el('button', { classe: 'btn', type: 'button', texto: 'Editar', onclick: function () { abrirFormPontoInt(d); } }) : null,
        ativa ? UI.el('button', { classe: 'btn', type: 'button', texto: foto ? 'Trocar foto' : 'Anexar foto', onclick: function () { fechar(); anexarFotoPonto(d); } }) : null,
        window.Ferramentas ? UI.el('button', { classe: 'btn', type: 'button', id: 'ponto-aneis', texto: window.Ferramentas.temAneis(d.id) ? '◎ Tirar anéis de distância' : '◎ Anéis de distância',
          onclick: function () { fechar(); window.Ferramentas.alternarAneis({ id: d.id, lat: d.lat, lng: d.lng, nome: d.titulo }); } }) : null,
        editavel ? UI.el('button', { classe: 'btn btn-perigo', type: 'button', id: 'ponto-excluir', texto: 'Excluir', onclick: function () { fechar(); excluirPontoInt(d); } }) : null,
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]));
    altitudeEm(d.lat, d.lng).then(function (m) {
      alt.textContent = m == null ? 'indisponível (sem conexão com o modelo de terreno)' : '≈ ' + Math.round(m).toLocaleString('pt-BR') + ' m (modelo de terreno, aproximado)';
    });
  }

 function renomearPonto(d) {
    var campo = UI.el('input', { classe: 'campo', id: 'ponto-novo-nome', maxlength: '80', value: d.titulo, autofocus: true });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', texto: 'Salvar nome' });
    var form = UI.el('form', { novalidate: true, classe: 'form-padrao' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Renomear ponto' }),
      UI.campo('Nome do ponto', campo, { para: 'ponto-novo-nome' }),
      erro,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var titulo = campo.value.replace(/\s+/g, ' ').trim();
      if (!titulo) { erro.textContent = 'Informe o nome do ponto.'; erro.hidden = false; return; }
      btn.disabled = true;
      try {
        var res = await C.rpc('salvar_ponto', { p_operacao: est.op.id, p_id: d.id, p_dados: { titulo: titulo } });
        fechar();
        aplicarPontos([res]);
        UI.aviso('Ponto renomeado para "' + res.titulo + '".', 'ok');
      } catch (e) {
        btn.disabled = false;
        erro.textContent = e.message; erro.hidden = false;
      }
    });
    var fechar = UI.abrirModal(form);
  }

  function anexarFotoPonto(d) {
    abrirRegistrarFoto(async function (foto) {
      try {
        var res = await C.rpc('salvar_ponto', { p_operacao: est.op.id, p_id: d.id, p_dados: { foto_id: foto.id } });
        aplicarPontos([res]);
        UI.aviso('Foto anexada ao ponto "' + res.titulo + '".', 'ok');
      } catch (e) {
        UI.aviso('A foto foi salva, mas não foi anexada ao ponto: ' + e.message, 'erro', 8000);
      }
    });
  }

  async function excluirPontoInt(d) {
    var r = await UI.confirmar({
      titulo: 'Excluir o ponto "' + d.titulo + '"?',
      texto: 'O ponto some do mapa de todos os responsáveis. Uma foto anexada continua na galeria.',
      ok: 'Excluir ponto',
      perigo: true,
    });
    if (!r) return;
    try {
      await C.rpc('excluir_ponto', { p_id: d.id });
      var p = est.pontosInt.get(d.id);
      if (p) tirarPontoInt(p);
      est.pontosInt.delete(d.id);
      renderizarAreas();
      UI.aviso('Ponto excluído.', 'ok');
    } catch (e) {
      UI.aviso(e.codigo === 'sem_permissao' ? 'Só quem marcou o ponto, quem criou a operação ou um administrador pode excluí-lo.' : e.message, 'erro', 7000);
    }
  }

  // Relato de um participante vira ponto de interesse (fica registrado quem relatou).
  function pontoDoRelato(m) {
    var mapa = { PISTA: 'VESTIGIO', VESTIGIO: 'VESTIGIO', OBJETO: 'VESTIGIO', OBSTACULO: 'RISCO', AJUDA: 'POSSIVEL_LOCALIZACAO', VITIMA: 'VITIMA_ENCONTRADA' };
    // Vítima: título e descrição neutros (pontos de interesse podem aparecer no mapa dos participantes).
    var vitima = m.categoria === 'VITIMA';
    abrirFormPontoInt({
      categoria: mapa[m.categoria] || 'OUTRO',
      titulo: vitima ? 'Vítima localizada' : resumir(m.texto, 80),
      descricao: vitima ? '' : m.texto,
      lat: m.lat, lng: m.lng,
      mensagem_id: m.id,
      relatado_por_nome: nomeDoParticipante(m.participante_id, m.remetente_nome),
    });
  }

  /* ---------- Destino (navegação do participante) -------------------- */
  function participantesNavegaveis() {
    return Array.from(est.participantes.values())
      .filter(function (p) { return !p.dados.removido && tipoDe(p.dados) !== 'responsavel'; })
      .sort(function (a, b) { return a.dados.nome.localeCompare(b.dados.nome, 'pt-BR'); });
  }

  // alvo: { nome, lat, lng, ponto_id?, setor_id?, participantes?: [ids pré-marcados], grupo_id?: grupo pré-escolhido }
  // "Pessoas": um destino para cada participante marcado (como antes).
  // "Grupo": um deslocamento do grupo inteiro (só o responsável do grupo ou todos
  // os membros), com base e prazo de retorno — gera os alertas automáticos.
  function abrirEnviarDestino(alvo) {
    if (!est.op || est.op.status !== 'ativa') return;
    var lista = participantesNavegaveis();
    var pre = new Set(alvo.participantes || []);
    var nome = UI.el('input', { classe: 'campo', id: 'destino-nome', maxlength: '80', value: alvo.nome || 'Destino' });
    var caixas = UI.el('div', { classe: 'lista-destino' }, lista.length ? lista.map(function (p) {
      var atual = est.destinos.get(p.id);
      return UI.el('label', { classe: 'linha-opcao' }, [
        UI.el('input', { type: 'checkbox', value: p.id, checked: pre.has(p.id) ? true : null }),
        ' ' + p.dados.nome + ' (' + TIPOS[tipoDe(p.dados)].rotulo.toLowerCase() + ')',
        atual ? UI.el('small', { classe: 'muted', texto: ' — hoje indo para: ' + atual.nome }) : null,
      ]);
    }) : [UI.el('p', { classe: 'muted', texto: 'Nenhum participante ativo nesta operação.' })]);
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'destino-enviar', texto: 'Enviar destino' });
    var modos = UI.el('div', { classe: 'opcoes-modo', role: 'radiogroup', 'aria-label': 'Como o participante vai até lá' },
      Object.keys(window.Rotas.MODOS).map(function (k, i) {
        var m = window.Rotas.MODOS[k];
        return UI.el('label', { classe: 'opcao-modo' }, [
          UI.el('input', { type: 'radio', name: 'destino-modo', value: k, checked: i === 0 ? true : null }),
          UI.el('span', null, [UI.el('strong', { texto: m.icone + ' ' + m.rotulo }), UI.el('small', { texto: m.descricao })]),
        ]);
      }));

    // --- Para quem: pessoas ou um grupo ---
    var grupos = Array.from(est.grupos.values()).sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
    var modoGrupo = Boolean(alvo.grupo_id && est.grupos.has(alvo.grupo_id));
    var abaPessoas = UI.el('button', { classe: 'btn', type: 'button', id: 'destino-aba-pessoas', texto: 'Pessoas' });
    var abaGrupo = UI.el('button', { classe: 'btn', type: 'button', id: 'destino-aba-grupo', texto: 'Grupo', disabled: est.semGrupos ? true : null });
    var blocoPessoas = UI.el('div', { classe: 'grupo' }, [
      UI.el('div', { classe: 'linha-rotulo' }, [UI.el('span', { classe: 'rotulo', texto: 'Pessoas' }),
        lista.length ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Marcar todos', onclick: function () { caixas.querySelectorAll('input').forEach(function (c) { c.checked = true; }); } }) : null]),
      caixas,
    ]);
    var selGrupo = UI.el('select', { classe: 'campo', id: 'destino-grupo' }, grupos.map(function (g) {
      var n = membrosAtivosCampo(g.id).length;
      return UI.el('option', { value: g.id, selected: g.id === alvo.grupo_id ? true : null, texto: g.nome + ' (' + n + ' membro' + (n === 1 ? '' : 's') + ' de campo)' });
    }));
    var publico = UI.el('div', { classe: 'opcoes-modo', role: 'radiogroup', 'aria-label': 'Quem do grupo recebe o destino' }, [
      UI.el('label', { classe: 'opcao-modo' }, [UI.el('input', { type: 'radio', name: 'destino-publico', value: 'todos', checked: true }),
        UI.el('span', null, [UI.el('strong', { texto: 'Todos os membros' }), UI.el('small', { texto: 'cada membro de campo vê o destino no celular' })])]),
      UI.el('label', { classe: 'opcao-modo' }, [UI.el('input', { type: 'radio', name: 'destino-publico', value: 'responsavel' }),
        UI.el('span', null, [UI.el('strong', { texto: 'Só o responsável do grupo' }), UI.el('small', { texto: 'quem tem o papel ★ no grupo leva a equipe' })])]),
    ]);
    var bases = Array.from(est.pontosInt.values()).map(function (x) { return x.d; }).filter(function (d) { return d.categoria === 'BASE'; });
    var selBase = UI.el('select', { classe: 'campo', id: 'destino-base' }, [UI.el('option', { value: '', texto: '— sem base (sem controle de retorno) —' })].concat(
      bases.map(function (b, i) { return UI.el('option', { value: b.id, selected: i === 0 ? true : null, texto: b.titulo + ' (raio ' + Math.round(b.raio_m || RAIO_BASE_PADRAO) + ' m)' }); })));
    var raioBase = UI.el('input', { classe: 'campo', id: 'destino-raio-base', type: 'number', min: '10', max: '5000', step: '10', inputmode: 'numeric' });
    var prazo = UI.el('input', { classe: 'campo', id: 'destino-prazo', type: 'number', min: '5', max: '720', step: '5', inputmode: 'numeric', value: '30' });
    function ajustarRaioBase() {
      var b = est.pontosInt.get(selBase.value);
      raioBase.value = String(Math.round((b && b.d.raio_m) || RAIO_BASE_PADRAO));
      raioBase.disabled = prazo.disabled = !selBase.value;
    }
    selBase.addEventListener('change', ajustarRaioBase);
    ajustarRaioBase();
    var prazosGrupo = camposPrazos(null);
    var blocoGrupo = UI.el('div', { classe: 'bloco-destino-grupo' }, grupos.length ? [
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'destino-grupo', texto: 'Grupo' }), selGrupo]),
      UI.el('div', { classe: 'grupo' }, [UI.el('span', { classe: 'rotulo', texto: 'Quem recebe o destino' }), publico]),
      UI.el('fieldset', { classe: 'bloco-form' }, [
        UI.el('legend', { texto: 'Retorno à base' }),
        UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'destino-base', texto: 'Base' }), selBase,
          bases.length ? null : UI.el('small', { classe: 'muted', texto: 'Nenhuma base marcada: use Ferramentas → Marcar ponto de interesse → "Base da operação".' })]),
        UI.el('div', { classe: 'grupo-duplo' }, [
          UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'destino-raio-base', texto: 'Na base quando estiver a até (m)' }), raioBase]),
          UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'destino-prazo', texto: 'Voltar em até (min) depois da busca' }), prazo]),
        ]),
      ]),
      UI.el('fieldset', { classe: 'bloco-form' }, [
        UI.el('legend', { texto: 'Horários combinados (opcional)' }),
        prazosGrupo.el,
      ]),
    ] : [UI.el('p', { classe: 'muted', texto: 'Nenhum grupo nesta operação. Crie em Ferramentas → Grupos.' })]);
    function mostrarModo() {
      abaPessoas.className = 'btn' + (!modoGrupo ? ' btn-ativo' : '');
      abaGrupo.className = 'btn' + (modoGrupo ? ' btn-ativo' : '');
      abaPessoas.setAttribute('aria-pressed', String(!modoGrupo));
      abaGrupo.setAttribute('aria-pressed', String(modoGrupo));
      blocoPessoas.hidden = modoGrupo;
      blocoGrupo.hidden = !modoGrupo;
      btn.textContent = modoGrupo ? 'Enviar ao grupo' : 'Enviar destino';
      erro.hidden = true;
    }
    abaPessoas.addEventListener('click', function () { modoGrupo = false; mostrarModo(); });
    abaGrupo.addEventListener('click', function () { modoGrupo = true; mostrarModo(); });

    var traj = window.Rotas.temTrajeto(alvo);
    var rotaTraj = traj ? window.Rotas.deTracado(alvo.trajeto, { modo: 'a_pe' }) : null;
    var form = UI.el('form', { novalidate: true, classe: 'form-padrao' }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: traj ? 'Enviar trajeto' : 'Enviar destino' },
        [UI.dica(traj
          ? 'O celular mostra a linha desenhada (' + window.Rotas.formatarDistancia(rotaTraj.distancia_m) + ', ' + rotaTraj.passos.filter(function (x) { return x.tipo === 'curva'; }).length + ' curva(s)) e guia a pessoa do início ao fim.'
          : 'O celular mostra o destino no mapa, a distância em linha reta e a direção. ' + C.coord(alvo.lat) + ', ' + C.coord(alvo.lng) + '.')]),
      UI.secao(null, [
        UI.campo(traj ? 'Nome do trajeto' : 'Nome do destino', nome, { para: 'destino-nome', dica: 'É o nome que aparece no celular de quem recebe.' }),
        UI.campo(traj ? 'Como vão percorrer' : 'Rota até lá', modos, { dica: traj ? 'Serve para estimar o tempo.' : 'O celular calcula a rota por ruas, caminhos e trilhas.' }),
      ]),
      UI.secao('Para quem', [
        UI.el('div', { classe: 'abas', role: 'group', 'aria-label': 'Enviar para' }, [abaPessoas, abaGrupo]),
        blocoPessoas,
        blocoGrupo,
      ]),
      erro,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    mostrarModo();
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var ids = Array.from(caixas.querySelectorAll('input:checked')).map(function (c) { return c.value; });
      var modoSel = (form.querySelector('input[name="destino-modo"]:checked') || {}).value || 'a_pe';
      var n = nome.value.replace(/\s+/g, ' ').trim();
      if (!n) { erro.textContent = 'Informe o nome do destino.'; erro.hidden = false; return; }
      if (modoGrupo) {
        enviarDestinoAoGrupo({ form: form, btn: btn, erro: erro, fechar: function () { fechar(true); if (alvo.aoEnviar) alvo.aoEnviar({ nome: n, grupo_id: selGrupo.value || null, participantes: [] }); }, alvo: alvo, nome: n, modo: modoSel,
          grupo: selGrupo.value, publico: (form.querySelector('input[name="destino-publico"]:checked') || {}).value || 'todos',
          base: selBase.value || null, raio: Number(raioBase.value), prazo: Number(prazo.value), prazos: prazosGrupo });
        return;
      }
      if (!ids.length) { erro.textContent = 'Escolha pelo menos um participante.'; erro.hidden = false; return; }
      btn.disabled = true;
      var ok = 0, falhas = [];
      for (var i = 0; i < ids.length; i++) {
        try {
          var args = { p_participante: ids[i], p_nome: n, p_lat: alvo.lat, p_lng: alvo.lng, p_ponto: alvo.ponto_id || null, p_modo: modoSel };
          var d;
          try {
            d = traj ? await C.rpc('definir_destino_trajeto', { p_participante: ids[i], p_nome: n, p_trajeto: alvo.trajeto, p_modo: modoSel })
              : await C.rpc('definir_destino', args);
          } catch (e1) {
            if (e1.codigo !== 'funcao_ausente') throw e1;
            if (traj) { var e2 = new Error('O banco ainda não tem a migração 030 (trajeto desenhado como destino).'); e2.parar = true; throw e2; }
            delete args.p_modo;   // banco sem a migração 005: envia sem o modo
            d = await C.rpc('definir_destino', args);
          }
          est.destinos.set(d.participante_id, d);
          ok++;
        } catch (e) {
          if (e.parar) { erro.textContent = e.message; erro.hidden = false; btn.disabled = false; return; }
          var p = est.participantes.get(ids[i]);
          falhas.push((p ? p.dados.nome : '?') + ': ' + e.message);
        }
      }
      fechar(true);
      if (ok && alvo.aoEnviar) alvo.aoEnviar({ nome: n, grupo_id: null, participantes: ids });
      else if (!ok && alvo.aoCancelar) alvo.aoCancelar();   // nada enviado: o desenho continua
      if (ok) UI.aviso((traj ? 'Trajeto "' : 'Destino "') + n + '" enviado a ' + ok + ' participante(s). ' + (traj ? 'Eles seguem a linha desenhada no celular.' : 'Eles veem a distância e a direção no celular.'), 'ok', 7000);
      if (falhas.length) UI.aviso('Não enviado para ' + falhas.join('; '), 'erro', 10000);
      if (est.selecionado) atualizarFicha();
    });
    var fechar = UI.abrirModal(form, { aoFechar: function (v) { if (!v && alvo.aoCancelar) alvo.aoCancelar(); } });
  }

  // Deslocamento de um grupo inteiro (migração 010): numa transação só, o servidor
  // cria a missão, envia o destino a quem deve receber e passa a acompanhar todos.
  async function enviarDestinoAoGrupo(o) {
    o.erro.hidden = true;
    if (!o.grupo) { o.erro.textContent = 'Escolha o grupo.'; o.erro.hidden = false; return; }
    if (o.base && !(o.raio >= 10 && o.raio <= 5000)) { o.erro.textContent = 'Raio de chegada à base: de 10 m a 5.000 m.'; o.erro.hidden = false; return; }
    if (o.base && !(o.prazo >= 5 && o.prazo <= 720)) { o.erro.textContent = 'Tempo para voltar: de 5 a 720 minutos.'; o.erro.hidden = false; return; }
    var dadosPrazos = null;
    if (o.prazos) {
      try { dadosPrazos = o.prazos.ler(); } catch (e0) { o.erro.textContent = e0.message; o.erro.hidden = false; return; }
      if (o.prazos.vazio(dadosPrazos)) dadosPrazos = null;
    }
    o.btn.disabled = true;
    try {
      var traj = window.Rotas.temTrajeto(o.alvo);
      var r = traj
        ? await C.rpc('enviar_trajeto_grupo', {
          p_grupo: o.grupo, p_nome: o.nome, p_trajeto: o.alvo.trajeto, p_publico: o.publico, p_modo: o.modo,
          p_setor: o.alvo.setor_id || null, p_base: o.base, p_raio_base_m: o.base ? o.raio : null, p_prazo_min: o.base ? o.prazo : 30,
        }, 20000)
        : await C.rpc('enviar_destino_grupo', {
          p_grupo: o.grupo, p_nome: o.nome, p_lat: o.alvo.lat, p_lng: o.alvo.lng, p_publico: o.publico, p_modo: o.modo,
          p_setor: o.alvo.setor_id || null, p_ponto: o.alvo.ponto_id || null,
          p_base: o.base, p_raio_base_m: o.base ? o.raio : null, p_prazo_min: o.base ? o.prazo : 30,
        }, 20000);
      o.fechar();
      var g = est.grupos.get(o.grupo);
      UI.aviso('Destino "' + o.nome + '" enviado ao grupo ' + (g ? g.nome : '') + ': ' + r.destinatarios + ' recebe(m) no celular, ' +
        r.acompanhados + ' acompanhado(s).' + (o.base ? ' Voltar em até ' + o.prazo + ' min depois de finalizar a busca.' : ' Sem base: não há controle de retorno.'), 'ok', 10000);
      // Prazos combinados: a missão já existe; uma falha aqui não desfaz o envio (nem o repete)
      if (dadosPrazos && r.missao && r.missao.id) {
        try {
          var mp = await C.rpc('definir_prazos_missao', { p_missao: r.missao.id, p_dados: dadosPrazos });
          if (mp && mp.id) est.missoes.set(mp.id, mp);
          UI.aviso('Horários combinados registrados' + (dadosPrazos.inicio_combinado_em ? ': iniciar até ' + C.hora(dadosPrazos.inicio_combinado_em, false) : '') +
            (dadosPrazos.retorno_combinado_em ? (dadosPrazos.inicio_combinado_em ? ', ' : ': ') + 'retornar até ' + C.hora(dadosPrazos.retorno_combinado_em, false) : '') + '.', 'ok', 8000);
        } catch (e3) {
          UI.aviso('O destino foi enviado, mas os horários combinados NÃO foram gravados: ' + erroPrazos(e3) +
            ' Abra Deslocamentos de grupos → ⏱ Prazos para tentar de novo.', 'erro', 15000);
        }
      }
      agendarAreas();
      agendarMissoes();
    } catch (e) {
      o.erro.textContent = e.codigo === 'funcao_ausente'
        ? (window.Rotas.temTrajeto(o.alvo) ? 'O banco ainda não tem a migração 030 (trajeto desenhado como destino).' : 'O servidor ainda não tem os deslocamentos de grupos (execute a migração 010 no Supabase).')
        : 'Não foi possível enviar: ' + e.message;
      o.erro.hidden = false;
      o.btn.disabled = false;
    }
  }

  // Escolher o destino: um ponto de interesse ou um local tocado no mapa.
  function escolherDestino(participantes, grupoId) {
    var pontos = Array.from(est.pontosInt.values()).map(function (p) { return p.d; });
    var setores = Array.from(est.setores.values()).map(function (s) { return s.d; });
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Enviar destino' }, [UI.dica('Escolha um setor, um ponto de interesse ou toque no mapa.')]),
      UI.el('div', { classe: 'acoes-linha acoes-iguais' }, [
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', id: 'destino-no-mapa', texto: 'Escolher no mapa', onclick: function () {
          fechar(); iniciarDesenho('destino', { participantes: participantes || [], grupo_id: grupoId || null });
        } }),
        UI.el('button', { classe: 'btn', type: 'button', id: 'destino-desenhar-trajeto', texto: '✎ Desenhar o trajeto', title: 'A equipe segue a linha que você desenhar',
          onclick: function () { fechar(); iniciarDesenhoTrajeto(participantes, grupoId); } }),
      ]),
      UI.el('div', { classe: 'form-colunas' }, [
        UI.secao('Setores', [setores.length ? UI.el('ul', { classe: 'lista-areas lista-escolha' }, setores.map(function (d) {
          return UI.el('li', null, [UI.el('button', { classe: 'item-area', type: 'button', onclick: function () {
            var c = centroSetor(d);
            fechar(); abrirEnviarDestino({ nome: 'Setor ' + d.nome, lat: c[0], lng: c[1], setor_id: d.id, participantes: participantes, grupo_id: grupoId });
          } }, [UI.el('span', { classe: 'chip-cor', style: 'background:' + d.cor }),
            UI.el('span', { classe: 'item-area-txt' }, [UI.el('strong', { texto: 'Setor ' + d.nome }), UI.el('small', { classe: 'muted', texto: (STATUS_SETOR[d.status] || STATUS_SETOR.pendente).rotulo })])])]);
        })) : UI.el('p', { classe: 'muted', texto: 'Nenhum setor.' })], { dica: 'O centro do setor é o destino.' }),
        UI.secao('Pontos de interesse', [pontos.length ? UI.el('ul', { classe: 'lista-areas lista-escolha' }, pontos.map(function (d) {
          var cat = catDoPonto(d);
          return UI.el('li', null, [UI.el('button', { classe: 'item-area', type: 'button', onclick: function () {
            fechar(); abrirEnviarDestino({ nome: d.titulo, lat: d.lat, lng: d.lng, ponto_id: d.id, participantes: participantes, grupo_id: grupoId });
          } }, [elMarcaPonto(d),
            UI.el('span', { classe: 'item-area-txt' }, [UI.el('strong', { texto: d.titulo }), UI.el('small', { classe: 'muted', texto: cat.rotulo })])])]);
        })) : UI.el('p', { classe: 'muted', texto: 'Nenhum ponto marcado.' })]),
      ]),
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } })]),
    ]));
  }

  async function encerrarDestinoPainel(d) {
    var r = await UI.confirmar({ titulo: 'Encerrar a navegação?', texto: 'O participante deixa de ver o destino "' + d.nome + '".', ok: 'Encerrar navegação' });
    if (!r) return;
    try {
      await C.rpc('encerrar_destino', { p_destino: d.id });
      est.destinos.delete(d.participante_id);
      if (est.selecionado) atualizarFicha();
      UI.aviso('Navegação encerrada.', 'ok');
    } catch (e) { UI.aviso(e.message, 'erro'); }
  }

  // Na ficha aberta: linha tracejada do participante até o destino dele.
  function desenharLinhaDestino() {
    if (est.linhaDestino) { est.linhaDestino.remove(); est.linhaDestino = null; }
    if (est.marcaDestino) { est.marcaDestino.remove(); est.marcaDestino = null; }
    var d0 = est.mapa && est.selecionado && !$('ficha').hidden ? est.destinos.get(est.selecionado) : null;
    if (!d0) limparRotaFicha();
    if (!est.mapa || !est.selecionado || $('ficha').hidden) return;
    var d = est.destinos.get(est.selecionado);
    if (!d) return;
    est.marcaDestino = L.marker([d.lat, d.lng], {
      icon: L.divIcon({ className: 'mk-destino-wrap', html: '<div class="mk-destino">🧭</div>', iconSize: [0, 0] }),
      interactive: false, keyboard: false, zIndexOffset: 400,
    }).addTo(est.mapa);
    var p = est.participantes.get(est.selecionado);
    var pos = p && posicaoAtual(p);
    if (pos) est.linhaDestino = L.polyline([[pos.lat, pos.lng], [d.lat, d.lng]], { color: '#facc15', weight: 2, dashArray: '4 8', opacity: 0.6, interactive: false }).addTo(est.mapa);
    if (pos) rotaDaFicha(est.selecionado, d, pos);
  }

  /* ---------- Rota por caminhos reais (ficha) ------------------------- */
  // A ficha mostra a rota calculada da posição do participante até o destino dele
  // (mesmo serviço e mesmo modo que o celular dele usa). Recalcula se ele andar
  // mais de 100 m ou a cada 5 min.
  function rotaDaFicha(pid, d, pos) {
    var modo = d.modo || 'a_pe';
    var chave = d.id + ':' + modo;
    var c = est.rotasFicha.get(chave);
    var longe = c && c.origem && window.GPS.distancia(c.origem[0], c.origem[1], pos.lat, pos.lng) > 100;
    var velha = c && Date.now() - c.em > 5 * 60000;
    if (!c || ((longe || velha) && !c.calculando && Date.now() - c.em > 30000)) {
      c = { calculando: true, em: Date.now(), origem: [pos.lat, pos.lng], rota: c ? c.rota : null, erro: null };
      est.rotasFicha.set(chave, c);
      window.Rotas.paraDestino(d, { origem: [pos.lat, pos.lng], modo: modo }).then(function (r) {
        c.calculando = false;
        c.em = Date.now();
        if (r.ok) { c.rota = r.rota; c.erro = null; } else { c.erro = r.mensagem; }
        if (est.selecionado === pid && !$('ficha').hidden) { est.rotaFichaChave = null; desenharRotaFicha(chave, c); atualizarResumoRotaFicha(c); }
      });
    }
    desenharRotaFicha(chave, c);
    atualizarResumoRotaFicha(c);
  }

  function desenharRotaFicha(chave, c) {
    if (!est.mapa) return;
    if (!est.camadaRotaFicha) est.camadaRotaFicha = L.layerGroup().addTo(est.mapa);
    var marca = chave + ':' + (c.rota ? c.rota.calculada_em : '');
    if (est.rotaFichaChave === marca) return;
    est.rotaFichaChave = marca;
    est.camadaRotaFicha.clearLayers();
    if (c.rota) window.Rotas.desenhar(est.camadaRotaFicha, c.rota, { peso: 4 });
  }

  function atualizarResumoRotaFicha(c) {
    var el = $('ficha-rota');
    if (!el) return;
    var txt = c.rota ? window.Rotas.resumo(c.rota) + (c.calculando ? ' (atualizando…)' : '') +
      (c.rota.avisos && c.rota.avisos.length ? ' · ' + c.rota.avisos.join(' ') : '')
      : c.calculando ? 'Calculando a rota por caminhos…' : 'Rota por caminhos indisponível: ' + (c.erro || '') ;
    if (el.textContent !== txt) el.textContent = txt;
    el.hidden = false;
  }

  function limparRotaFicha() {
    if (est.camadaRotaFicha) est.camadaRotaFicha.clearLayers();
    est.rotaFichaChave = null;
    var el = $('ficha-rota');
    if (el) el.hidden = true;
  }

  /* ---------- Rota até um participante (ir até a pessoa ou mandar apoio) ---------- */
  // Parte da minha localização (GPS deste aparelho), de uma base ou da posição de outro
  // participante e vai até a última posição da pessoa. Enquanto estiver ligada, recalcula
  // quando um dos dois anda mais de 60 m (no máximo a cada 30 s). Sem internet para a rota
  // por caminhos, mostra a linha reta com a distância.
  function abrirRotaAte(pid) {
    var p = est.participantes.get(pid);
    if (!p || !est.op) return;
    var pos = posicaoAtual(p);
    if (!pos) { UI.aviso('Ainda não há posição de ' + nomeExibido(p) + ' para traçar a rota.', 'erro'); return; }
    var bases = Array.from(est.pontosInt.values()).map(function (x) { return x.d; }).filter(function (d) { return d.categoria === 'BASE'; });
    var outros = Array.from(est.participantes.values()).filter(function (q) {
      return q.id !== pid && !q.dados.removido && !ehEu(q) && posicaoAtual(q);
    }).sort(function (a, b) { return nomeExibido(a).localeCompare(nomeExibido(b), 'pt-BR'); });
    var anterior = est.rotaApoio && est.rotaApoio.alvo === pid ? est.rotaApoio : null;
    var sel = UI.el('select', { classe: 'campo', id: 'rota-ate-origem' }, [UI.el('option', { value: 'gps', texto: 'Minha localização (GPS deste aparelho)' })]
      .concat(bases.map(function (b) { return UI.el('option', { value: 'base:' + b.id, texto: 'Base: ' + b.titulo }); }))
      .concat(outros.map(function (q) { return UI.el('option', { value: 'p:' + q.id, texto: nomeExibido(q) + ' (posição atual)' }); })));
    if (anterior) sel.value = anterior.origem;
    var modos = UI.el('div', { classe: 'opcoes-modo', role: 'radiogroup', 'aria-label': 'Como vai até lá' },
      Object.keys(window.Rotas.MODOS).map(function (k, i) {
        var m = window.Rotas.MODOS[k];
        return UI.el('label', { classe: 'opcao-modo' }, [
          UI.el('input', { type: 'radio', name: 'rota-ate-modo', value: k, checked: (anterior ? anterior.modo === k : i === 0) ? true : null }),
          UI.el('span', null, [UI.el('strong', { texto: m.icone + ' ' + m.rotulo }), UI.el('small', { texto: m.descricao })]),
        ]);
      }));
    var idade = Date.now() - pos.t;
    var form = UI.el('form', { novalidate: true, classe: 'form-padrao' }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Rota até ' + nomeExibido(p) },
        [UI.dica('Última posição às ' + C.hora(p.dados.ultima_posicao_em, false) + ' (' + C.idade(p.dados.ultima_posicao_em) + ').' +
          (idade > 5 * 60000 ? ' Posição antiga: a pessoa pode estar sem sinal; a rota vai até onde foi vista por último.' : ' A rota acompanha a pessoa enquanto ela anda.'))]),
      UI.campo('Saindo de', sel, { para: 'rota-ate-origem', largo: true }),
      UI.campo('Como vai', modos, { largo: true }),
      UI.rodape([
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }),
        est.op.status === 'ativa' ? UI.el('button', { classe: 'btn', type: 'button', id: 'rota-ate-enviar', texto: 'Mandar alguém até ela',
          title: 'Envia a posição atual da pessoa como destino para outra pessoa ou grupo',
          onclick: function () { abrirEnviarDestino({ nome: 'Apoio a ' + nomeCurto(p), lat: pos.lat, lng: pos.lng }); } }) : null,
        UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'rota-ate-tracar', texto: 'Traçar rota' }),
      ]),
    ]);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var modo = (form.querySelector('input[name="rota-ate-modo"]:checked') || {}).value || 'a_pe';
      fechar();
      iniciarRotaApoio(pid, sel.value, modo);
    });
    var fechar = UI.abrirModal(form);
  }

  function iniciarRotaApoio(pid, origem, modo) {
    pararRotaApoio();
    if (!$('ficha').hidden) fecharFicha();   // o mapa fica livre para a rota (a barra embaixo mostra o resumo)
    est.rotaApoio = { alvo: pid, origem: origem, modo: modo, rota: null, erro: null, calculando: false, em: 0, ultO: null, ultA: null, primeira: true };
    if (est.mapa && !est.camadaRotaApoio) est.camadaRotaApoio = L.layerGroup().addTo(est.mapa);
    est.timerRotaApoio = setInterval(function () { atualizarRotaApoio(false); }, 15000);
    atualizarRotaApoio(true);
  }

  function pararRotaApoio() {
    clearInterval(est.timerRotaApoio);
    est.timerRotaApoio = null;
    est.rotaApoio = null;
    if (est.camadaRotaApoio) est.camadaRotaApoio.clearLayers();
    var b = $('barra-apoio');
    if (b) b.hidden = true;
  }

  function origemRotaApoio(r) {
    if (r.origem === 'gps') {
      return obterMinhaPosicao().then(function (o) {
        return o.ok ? { ok: true, lat: o.lat, lng: o.lng, rotulo: 'sua localização' } : { ok: false, motivo: 'sua localização: ' + o.motivo };
      });
    }
    if (r.origem.indexOf('base:') === 0) {
      var b = est.pontosInt.get(r.origem.slice(5));
      return Promise.resolve(b ? { ok: true, lat: b.d.lat, lng: b.d.lng, rotulo: 'base ' + b.d.titulo } : { ok: false, motivo: 'a base foi removida' });
    }
    var q = est.participantes.get(r.origem.slice(2));
    var qp = q && posicaoAtual(q);
    return Promise.resolve(qp ? { ok: true, lat: qp.lat, lng: qp.lng, rotulo: nomeExibido(q) } : { ok: false, motivo: 'sem posição de quem sai' });
  }

  async function atualizarRotaApoio(forcar) {
    var r = est.rotaApoio;
    if (!r || r.calculando) return;
    var p = est.participantes.get(r.alvo);
    var a = p && !p.dados.removido ? posicaoAtual(p) : null;
    if (!a) { pararRotaApoio(); UI.aviso('Rota encerrada: a pessoa saiu da operação ou está sem posição.', 'erro'); return; }
    r.calculando = true;
    var o = await origemRotaApoio(r);
    if (est.rotaApoio !== r) return;
    r.calculando = false;
    if (!o.ok) { r.erro = 'Não foi possível obter a origem (' + o.motivo + ').'; renderizarBarraApoio(); return; }
    r.origemRotulo = o.rotulo;
    var dist = function (x, y) { return window.GPS.distancia(x[0], x[1], y[0], y[1]); };
    var andou = !r.ultO || dist(r.ultO, [o.lat, o.lng]) > 60 || dist(r.ultA, [a.lat, a.lng]) > 60;
    if (!forcar && (!andou || Date.now() - r.em < 30000)) { renderizarBarraApoio(); return; }
    r.calculando = true;
    renderizarBarraApoio();
    var res = await window.Rotas.calcular({ origem: [o.lat, o.lng], destino: [a.lat, a.lng], modo: r.modo });
    if (est.rotaApoio !== r) return;   // parada enquanto calculava
    r.calculando = false;
    r.em = Date.now();
    r.ultO = [o.lat, o.lng];
    r.ultA = [a.lat, a.lng];
    r.reta = Math.round(dist(r.ultO, r.ultA));
    if (res.ok) { r.rota = res.rota; r.erro = null; } else { r.rota = null; r.erro = res.mensagem; }
    desenharRotaApoio(r);
    if (r.primeira) { r.primeira = false; verRotaApoio(); }
    renderizarBarraApoio();
  }

  function desenharRotaApoio(r) {
    if (!est.mapa) return;
    if (!est.camadaRotaApoio) est.camadaRotaApoio = L.layerGroup().addTo(est.mapa);
    var g = est.camadaRotaApoio;
    if (r.rota) window.Rotas.desenhar(g, r.rota, { peso: 5 });
    else {
      g.clearLayers();   // sem rota por caminhos: linha reta tracejada
      L.polyline([r.ultO, r.ultA], { color: '#2563eb', weight: 3, dashArray: '6 8', opacity: 0.9, interactive: false, className: 'rota-apoio-reta' }).addTo(g);
    }
    L.circleMarker(r.ultO, { radius: 6, color: '#0b1220', weight: 2, fillColor: '#93c5fd', fillOpacity: 1, interactive: false, className: 'rota-apoio-origem' }).addTo(g);
  }

  function verRotaApoio() {
    var r = est.rotaApoio;
    if (!r || !est.mapa || !r.ultO) return;
    var pts = r.rota ? r.rota.geometria.slice() : [];
    pts.push(r.ultO, r.ultA);
    est.mapa.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 17 });
    if (!$('ficha').hidden) fecharFicha();
    if (telaPequena()) fecharCentral();
  }

  function renderizarBarraApoio() {
    var r = est.rotaApoio, barra = $('barra-apoio');
    if (!barra) return;
    if (!r) { barra.hidden = true; return; }
    var p = est.participantes.get(r.alvo);
    var vista = p ? C.paraMs(p.dados.ultima_posicao_em) : 0;
    var velha = vista && Date.now() - vista > 5 * 60000;
    var partes = [];
    if (r.rota) partes.push(window.Rotas.resumo(r.rota));
    else if (r.ultO) partes.push('Linha reta: ' + window.Rotas.formatarDistancia(r.reta) + (r.erro ? ' (rota por caminhos indisponível: ' + r.erro + ')' : ''));
    else if (r.erro) partes.push(r.erro);
    if (r.calculando) partes.push(r.ultO ? 'atualizando…' : 'calculando…');
    if (p) partes.push((velha ? '⚠ posição dela de ' : 'posição dela às ') + C.hora(p.dados.ultima_posicao_em, false) + (velha ? ' (' + C.idade(p.dados.ultima_posicao_em) + ', pode estar sem sinal)' : ''));
    var txt = $('barra-apoio-texto');
    txt.innerHTML = '';
    txt.appendChild(UI.el('strong', { texto: 'Rota até ' + (p ? nomeExibido(p) : '?') + (r.origemRotulo ? ' (de ' + r.origemRotulo + ')' : '') + ': ' }));
    txt.appendChild(document.createTextNode(partes.join(' · ')));
    barra.classList.toggle('desatualizada', Boolean(velha || r.erro));
    var g = $('barra-apoio-google');
    if (r.ultA) { g.href = window.Rotas.linkGoogle(r.ultA, r.modo); g.hidden = false; } else g.hidden = true;
    barra.hidden = false;
  }

  /* ---------- Lista de setores e pontos ------------------------------ */
  function abrirAreas() {
    if (!est.op) return;
    fecharCentral();
    if (telaPequena() && !$('ficha').hidden) fecharFicha();
    fecharMenu(false);
    $('painel-areas').hidden = false;
    document.body.classList.add('areas-aberta');
    renderizarAreas();
  }

  function fecharAreas() {
    var c = $('painel-areas');
    if (!c || c.hidden) return;
    c.hidden = true;
    document.body.classList.remove('areas-aberta');
  }

  function renderizarAreas() {
    var ulS = $('lista-setores'), ulP = $('lista-pontos-int');
    if (!ulS) return;
    $('qtd-setores').textContent = String(est.setores.size);
    $('qtd-pontos-int').textContent = String(est.pontosInt.size);
    $('qtd-trilhas').textContent = String(est.trilhasManuais.size);
    if ($('painel-areas').hidden) return;
    var editavel = podeAlterar();
    ['areas-novo-setor', 'areas-novo-ponto'].forEach(function (i) { $(i).hidden = !editavel; });
    $('areas-nova-trilha').hidden = !editavel || est.semTrilhasManuais;
    renderizarListaTrilhas();
    ulS.innerHTML = '';
    $('setores-vazio').hidden = est.setores.size > 0;
    est.setores.forEach(function (s) {
      var d = s.d;
      ulS.appendChild(UI.el('li', null, [UI.el('button', { classe: 'item-area', type: 'button', 'data-setor': d.id, onclick: function () { abrirSetor(d.id); } }, [
        UI.el('span', { classe: 'chip-cor', style: 'background:' + d.cor }),
        UI.el('span', { classe: 'item-area-txt' }, [
          UI.el('strong', { texto: d.nome }),
          UI.el('small', { classe: 'muted', texto: nomeResponsavelSetor(d) + ' · ' + formatarArea(areaSetorM2(d)) }),
          (function () {
            var r = resumoPermanenciaSetor(d.id);
            return r ? UI.el('small', { classe: 'permanencia-setor' + (r.acima ? ' acima' : ''), texto: '⏱ ' + r.texto }) : null;
          })(),
        ]),
        UI.el('span', { classe: 'selo ' + STATUS_SETOR[d.status].selo, texto: STATUS_SETOR[d.status].rotulo }),
      ])]));
    });
    ulP.innerHTML = '';
    $('pontos-int-vazio').hidden = est.pontosInt.size > 0;
    est.pontosInt.forEach(function (p) {
      var d = p.d;
      var cat = catDoPonto(d);
      ulP.appendChild(UI.el('li', null, [UI.el('button', { classe: 'item-area', type: 'button', 'data-ponto': d.id, onclick: function () { abrirPontoInt(d.id); } }, [
        elMarcaPonto(d),
        UI.el('span', { classe: 'item-area-txt' }, [
          UI.el('strong', { texto: d.titulo }),
          UI.el('small', { classe: 'muted', texto: cat.rotulo + ' · ' + C.hora(d.criado_em, false) + ' · ' + d.criado_por_nome }),
        ]),
      ])]));
    });
  }

  /* ---------- Trilhas desenhadas à mão (migração 028) --------------- */
  // Linha marcada ponto a ponto pelo responsável: PLANEJADA (caminho previsto) ou PERCORRIDA
  // (informada pelo usuário como já feita). Não é rastro de GPS e não muda a situação dos setores.
  // Visual próprio, que nenhum rastro GPS usa: linha com contorno escuro e marcas de início e fim.
  var ESTADO_TRILHA = {
    planejada: { rotulo: 'Planejada', dica: 'caminho previsto, ainda não percorrido', cor: '#facc15', traco: '10 8', selo: 'selo-trilha-planejada' },
    percorrida: { rotulo: 'Percorrida', dica: 'informada como já percorrida pela equipe', cor: '#ffffff', traco: null, selo: 'selo-trilha-percorrida' },
  };
  // Meio do percurso (migração 030): quem fez ou vai fazer o trajeto.
  var MEIO_TRILHA = {
    equipe: { rotulo: 'Equipe a pé', ico: '🚶' },
    drone: { rotulo: 'Drone', ico: '🛸' },
    viatura: { rotulo: 'Viatura', ico: '🚒' },
    embarcacao: { rotulo: 'Embarcação', ico: '🚤' },
    aeronave: { rotulo: 'Aeronave', ico: '🚁' },
    cao: { rotulo: 'Cão de busca', ico: '🐕' },
    outro: { rotulo: 'Outro', ico: '•' },
  };
  function meioDe(d) { return MEIO_TRILHA[d.meio] || MEIO_TRILHA.equipe; }
  var CHAVE_RASCUNHO_TRILHA = 'gbs-rascunho-trilha-';   // + id da operação: desenho em andamento guardado no aparelho
  var CHAVE_TRILHAS_OCULTAS = 'gbs-trilhas-ocultas-';   // + id da operação: trilhas escondidas uma a uma

  function comprimentoLinhaM(pts) {
    var m = 0;
    for (var i = 1; i < pts.length; i++) m += C.distancia(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    return m;
  }
  function formatarComprimento(m) {
    return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' km';
  }
  function trilhasOcultas() {
    if (!est.op) return new Set();
    if (!est.trilhasOcultas || est.trilhasOcultasOp !== est.op.id) {
      est.trilhasOcultas = new Set(C.local.ler(CHAVE_TRILHAS_OCULTAS + est.op.id, []) || []);
      est.trilhasOcultasOp = est.op.id;
    }
    return est.trilhasOcultas;
  }
  function gravarTrilhasOcultas() {
    if (est.op) C.local.gravar(CHAVE_TRILHAS_OCULTAS + est.op.id, Array.from(trilhasOcultas()));
  }
  function prefEstadoTrilha(estado) { return estado === 'percorrida' ? 'tmPercorridas' : 'tmPlanejadas'; }
  function trilhaManualVisivel(d) {
    return est.prefsMapa[prefEstadoTrilha(d.estado)] !== false && !trilhasOcultas().has(d.id);
  }

  function desenharTrilhaManual(t) {
    if (t.camada) { t.camada.remove(); t.camada = null; }
    if (!est.mapa || !est.camadaTrilhasManuais) return;
    var d = t.d;
    if (est.desenho && est.desenho.tipo === 'trilha' && est.desenho.trilhaId === d.id) return;   // traçado sendo editado
    if (!trilhaManualVisivel(d) || !Array.isArray(d.pontos) || d.pontos.length < 2) return;
    var e = ESTADO_TRILHA[d.estado] || ESTADO_TRILHA.planejada;
    var g = L.featureGroup();
    var opc = { pane: 'trilhasDesenhadas', lineJoin: 'round', lineCap: 'round' };
    var ft = fatorTelaTrilha();   // mais discreta em telas pequenas
    t.fatorTela = ft;
    L.polyline(d.pontos, Object.assign({ color: '#0b1220', weight: 5 * ft, opacity: 0.4, className: 'trilha-desenhada-contorno' }, opc)).addTo(g);
    var cor = d.cor || e.cor;   // cor própria da trilha (ex.: a do arquivo importado) ou a da situação
    L.polyline(d.pontos, Object.assign({ color: cor, weight: Math.max(1.5, 2.5 * ft), opacity: 0.85, dashArray: e.traco, className: 'trilha-desenhada trilha-desenhada-' + d.estado }, opc)).addTo(g);
    var ini = d.pontos[0], fim = d.pontos[d.pontos.length - 1];
    L.circleMarker(ini, Object.assign({ radius: Math.max(2.5, 3.5 * ft), color: '#0b1220', weight: 1.5, fillColor: cor, fillOpacity: 0.9 }, opc)).addTo(g);
    L.circleMarker(fim, Object.assign({ radius: Math.max(3, 4 * ft), color: cor, weight: 2, fillColor: '#0b1220', fillOpacity: 0.9 }, opc)).addTo(g);
    ligarCliquesMapa(g, {
      noDesenho: function (ev) { aoClicarNoMapa(ev); },   // durante um desenho o toque é do mapa
      info: function () { return { titulo: meioDe(d).ico + ' ' + d.nome, sub: e.rotulo + (d.comprimento_m ? ' · ' + window.Rotas.formatarDistancia(d.comprimento_m) : '') }; },
      detalhes: function () { abrirTrilhaManual(d.id); },
    });
    g.addTo(est.camadaTrilhasManuais);
    t.camada = g;
  }

  function redesenharTrilhasManuais() {
    est.trilhasManuais.forEach(desenharTrilhaManual);
  }

  function aplicarTrilhasManuais(lista, completa) {
    var vistos = new Set();
    lista.forEach(function (d) {
      vistos.add(d.id);
      var t = est.trilhasManuais.get(d.id);
      if (!t) { t = { d: d, camada: null }; est.trilhasManuais.set(d.id, t); }
      else t.d = d;
      desenharTrilhaManual(t);
    });
    if (completa) {
      est.trilhasManuais.forEach(function (t, id) {
        if (!vistos.has(id)) { if (t.camada) t.camada.remove(); est.trilhasManuais.delete(id); }
      });
    }
    renderizarAreas();
  }

  async function carregarTrilhasManuais() {
    if (!est.op || est.semTrilhasManuais) return;
    var opId = est.op.id;
    try {
      var lista = await C.consultar(C.cliente.from('trilhas_manuais').select('*').eq('operacao_id', opId).order('criado_em', { ascending: true }));
      if (!est.op || est.op.id !== opId) return;
      aplicarTrilhasManuais(lista || [], true);
      est.erroTrilhasManuais = null;
    } catch (e) {
      // banco sem a migração 028: o resto do painel segue; a lista avisa
      if (/trilhas_manuais/.test(String(e.original && (e.original.message || e.original.details) || e.message)) || e.codigo === 'funcao_ausente') est.semTrilhasManuais = true;
      est.erroTrilhasManuais = e.message;
      renderizarAreas();
    }
  }

  // Tempo real em canal próprio: se a tabela ainda não existir no banco, o canal principal não cai.
  function assinarTrilhasManuais() {
    if (!est.op || est.semTrilhasManuais) return;
    var opId = est.op.id;
    if (est.canalTrilhas) { try { C.cliente.removeChannel(est.canalTrilhas); } catch (e) { /* ignora */ } }
    try {
      est.canalTrilhas = C.cliente.channel('op-trilhas-' + opId + '-' + Date.now())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'trilhas_manuais', filter: 'operacao_id=eq.' + opId }, agendarTrilhasManuais)
        .subscribe(function (status) {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            clearTimeout(est.timerCanalTrilhas);
            est.timerCanalTrilhas = setTimeout(function () { if (est.op && est.op.id === opId) { carregarTrilhasManuais(); assinarTrilhasManuais(); } }, 60000);
          }
        });
    } catch (e) { /* sem tempo real: recarrega ao abrir a operação e ao salvar */ }
  }
  function agendarTrilhasManuais() {
    clearTimeout(est.timerTrilhas);
    est.timerTrilhas = setTimeout(carregarTrilhasManuais, 400);
  }
  function encerrarTrilhasManuais() {
    clearTimeout(est.timerTrilhas);
    clearTimeout(est.timerCanalTrilhas);
    if (est.canalTrilhas) { try { C.cliente.removeChannel(est.canalTrilhas); } catch (e) { /* ignora */ } }
    est.canalTrilhas = null;
    est.trilhasManuais.forEach(function (t) { if (t.camada) t.camada.remove(); });
    est.trilhasManuais = new Map();
    est.semTrilhasManuais = false;
    est.erroTrilhasManuais = null;
  }

  /* --- desenho à mão livre: arrastar o dedo ou o mouse sobre o mapa desenha o caminho --- */
  function rascunhoTrilha() { return est.op ? C.local.ler(CHAVE_RASCUNHO_TRILHA + est.op.id, null) : null; }
  function gravarRascunhoTrilha() {
    var dz = est.desenho;
    if (!est.op || !dz || dz.tipo !== 'trilha' || dz.trilhaId) return;
    if (dz.pontos.length) C.local.gravar(CHAVE_RASCUNHO_TRILHA + est.op.id, { client_id: dz.client_id, pontos: dz.pontos, tracos: dz.tracos, em: Date.now() });
    else apagarRascunhoTrilha();
  }
  function apagarRascunhoTrilha() {
    if (est.op) { try { localStorage.removeItem(CHAVE_RASCUNHO_TRILHA + est.op.id); } catch (e) { /* ignora */ } }
  }

  // Nova trilha (retoma o desenho não salvo deste aparelho, se houver) ou edição do traçado (trilhaId).
  async function iniciarDesenhoTrilha(trilhaId) {
    if (!est.mapa || !est.op || !podeAlterar()) return;
    if (est.semTrilhasManuais) { UI.aviso(C.traduzirErro({ message: 'funcao_ausente' }), 'erro', 9000); return; }
    var opc = { client_id: C.uuid(), pontos: [], tracos: [] };
    if (trilhaId) {
      var t = est.trilhasManuais.get(trilhaId);
      if (!t) return;
      opc = { trilhaId: trilhaId, pontos: t.d.pontos.map(function (p) { return [p[0], p[1]]; }), tracos: [],
        // cancelar a edição devolve o traçado salvo ao mapa
        aoCancelar: function () { var t2 = est.trilhasManuais.get(trilhaId); if (t2) desenharTrilhaManual(t2); } };
    } else {
      var r = rascunhoTrilha();
      if (r && Array.isArray(r.pontos) && r.pontos.length) {
        var retomar = await UI.confirmar({
          titulo: 'Retomar a trilha não salva?',
          texto: 'Há um desenho (' + formatarComprimento(comprimentoLinhaM(r.pontos)) + ') que não foi salvo neste aparelho' + (r.em ? ' (' + C.hora(new Date(r.em).toISOString()) + ')' : '') + '.',
          ok: 'Retomar desenho', cancelar: 'Começar do zero',
        });
        if (retomar) opc = { client_id: r.client_id || C.uuid(), pontos: r.pontos, tracos: Array.isArray(r.tracos) ? r.tracos : [] };
        else apagarRascunhoTrilha();
      }
    }
    opc.modo = modoDesenhoTrilha();
    iniciarDesenho('trilha', opc);
    if (!est.desenho || est.desenho.tipo !== 'trilha') return;
    if (trilhaId) desenharTrilhaManual(est.trilhasManuais.get(trilhaId));   // esconde o traçado antigo enquanto edita
    ligarDesenhoLivre(est.desenho);
    redesenharTemp();
    atualizarBarraTrilha();
    if (opc.pontos.length) est.mapa.fitBounds(L.latLngBounds(opc.pontos), { padding: [60, 60], maxZoom: 17 });
  }

  var MAX_PONTOS_TRILHA = 2000;
  var TOL_TRACO_PX = 1.5;      // simplificação do traço (pixels na tela no momento do desenho)
  var EMENDA_PX = 44;          // um novo traço que começa perto do fim (ou do início) continua a mesma linha

  // simplificação do traço: a mesma do gerador de rotas (rotas.js)
  function simplificarIdx(pts, tol) { return window.Rotas.simplificarIndices(pts, tol); }
  function arredLL(ll) { return [Math.round(ll.lat * 1e7) / 1e7, Math.round(ll.lng * 1e7) / 1e7]; }

  // Modo do desenho de trilha/trajeto: 'livre' (segurar e arrastar, como caneta) ou 'pontos' (cada toque
  // no mapa marca um ponto, ligado ao anterior por uma reta; o mapa continua arrastável). Lembrado no aparelho.
  var CHAVE_MODO_DESENHO = 'gbs-desenho-modo';
  function modoDesenhoTrilha() { return C.local.ler(CHAVE_MODO_DESENHO, 'livre') === 'pontos' ? 'pontos' : 'livre'; }

  // Liga o desenho por arrasto no mapa. "Mover mapa" (dz.mover) devolve o arrasto ao mapa sem sair do desenho.
  // Dois dedos: o traço em andamento é descartado e o gesto fica para o zoom do mapa.
  // No modo ponto a ponto o arrasto é sempre do mapa e o toque (sem arrastar) acrescenta um ponto.
  function ligarDesenhoLivre(dz) {
    var mapa = est.mapa, cont = mapa.getContainer();
    var ativos = new Set(), traco = null, toque = null;
    function ehControle(t) { return t && t.closest && t.closest('.leaflet-control-container, .leaflet-control, .leaflet-popup'); }
    function porPontos() { return dz.modo === 'pontos'; }
    function desenhando() { return est.desenho === dz && !dz.mover && !dz.pausado && !porPontos(); }
    function aplicarModo() {
      var livre = est.desenho === dz && !dz.mover && !porPontos();
      cont.classList.toggle('desenho-pontos', est.desenho === dz && porPontos() && !dz.mover);
      cont.classList.toggle('desenho-livre', livre);
      cont.classList.toggle('desenho-mover', est.desenho === dz && Boolean(dz.mover));
      if (livre) { mapa.dragging.disable(); mapa.doubleClickZoom.disable(); mapa.boxZoom.disable(); }
      else { mapa.dragging.enable(); mapa.doubleClickZoom.enable(); mapa.boxZoom.enable(); }
    }
    function largar() {
      if (traco && traco.linha) traco.linha.remove();
      traco = null;
    }
    function aoDescer(ev) {
      if (est.desenho === dz && porPontos() && !dz.mover && !ehControle(ev.target)) toque = { x: ev.clientX, y: ev.clientY, n: (toque && toque.ativo ? 2 : 1), ativo: true, id: ev.pointerId };
      if (!desenhando() || ehControle(ev.target) || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
      ativos.add(ev.pointerId);
      if (ativos.size > 1) { largar(); return; }   // pinça: zoom do mapa
      ev.preventDefault();
      ev.stopPropagation();
      try { cont.setPointerCapture(ev.pointerId); } catch (e) { /* ignora */ }
      var p0 = mapa.mouseEventToContainerPoint(ev);
      traco = { id: ev.pointerId, px: [p0], linha: L.polyline([mapa.containerPointToLatLng(p0)], { color: '#facc15', weight: 3, interactive: false, className: 'trilha-traco-vivo' }).addTo(dz.camadaTemp) };
    }
    function aoMover(ev) {
      if (!traco || ev.pointerId !== traco.id) return;
      ev.preventDefault();
      var lista = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [];
      if (!lista.length) lista = [ev];
      lista.forEach(function (e2) {
        var p = mapa.mouseEventToContainerPoint(e2), u = traco.px[traco.px.length - 1];
        if (Math.abs(p.x - u.x) + Math.abs(p.y - u.y) < 2) return;
        traco.px.push(p);
        traco.linha.addLatLng(mapa.containerPointToLatLng(p));
      });
    }
    function aoSubir(ev) {
      if (toque && toque.id === ev.pointerId) toque.ativo = false;
      ativos.delete(ev.pointerId);
      if (!traco || ev.pointerId !== traco.id) return;
      var t = traco;
      largar();
      if (ev.type === 'pointercancel') return;
      concluirTraco(dz, t.px);
    }
    // em modo desenho, toques e cliques no mapa não abrem nada (só os controles do mapa respondem)
    function aoClicar(ev) {
      if (est.desenho !== dz || dz.mover || ehControle(ev.target)) return;
      ev.stopPropagation(); ev.preventDefault();
      if (!porPontos()) return;
      // ponto a ponto: só um toque parado vale (arrastar ou pinçar move o mapa)
      var t = toque; toque = null;
      if (!t || t.n > 1 || Math.abs(ev.clientX - t.x) + Math.abs(ev.clientY - t.y) > 8) return;
      acrescentarPonto(dz, arredLL(mapa.mouseEventToLatLng(ev)));
    }
    cont.addEventListener('pointerdown', aoDescer, true);
    cont.addEventListener('pointermove', aoMover, true);
    cont.addEventListener('pointerup', aoSubir, true);
    cont.addEventListener('pointercancel', aoSubir, true);
    cont.addEventListener('click', aoClicar, true);
    dz.aplicarModo = aplicarModo;
    dz.desligar = function () {
      largar();
      cont.removeEventListener('pointerdown', aoDescer, true);
      cont.removeEventListener('pointermove', aoMover, true);
      cont.removeEventListener('pointerup', aoSubir, true);
      cont.removeEventListener('pointercancel', aoSubir, true);
      cont.removeEventListener('click', aoClicar, true);
      cont.classList.remove('desenho-livre', 'desenho-mover', 'desenho-pontos');
      mapa.dragging.enable(); mapa.doubleClickZoom.enable(); mapa.boxZoom.enable();
    };
    aplicarModo();
  }

  // Um traço terminou: simplifica e junta à linha (no fim, ou no início se começou perto dele).
  function concluirTraco(dz, px) {
    if (est.desenho !== dz || px.length < 2) return;
    var mapa = est.mapa;
    var idx = simplificarIdx(px, TOL_TRACO_PX);
    var novos = idx.map(function (i) { return arredLL(mapa.containerPointToLatLng(px[i])); });
    if (novos.length < 2) return;
    var noInicio = false;
    if (dz.pontos.length) {
      var ini = px[0];
      var fim = mapa.latLngToContainerPoint(dz.pontos[dz.pontos.length - 1]);
      var comeco = mapa.latLngToContainerPoint(dz.pontos[0]);
      var dFim = ini.distanceTo(fim), dComeco = ini.distanceTo(comeco);
      if (dFim > EMENDA_PX && dComeco > EMENDA_PX) {
        UI.aviso('Para continuar, comece o novo traço no fim da linha (círculo branco) ou no início (verde). O desenho é uma linha só.', 'erro', 7000);
        return;
      }
      noInicio = dComeco < dFim && dComeco <= EMENDA_PX;
    }
    if (dz.pontos.length + novos.length > MAX_PONTOS_TRILHA) {
      UI.aviso('A linha chegou ao limite de detalhe (' + MAX_PONTOS_TRILHA + ' pontos). Conclua esta e desenhe a continuação separada.', 'erro', 8000);
      return;
    }
    if (noInicio) dz.pontos = novos.slice().reverse().concat(dz.pontos);
    else dz.pontos = dz.pontos.concat(novos);
    dz.tracos.push({ n: novos.length, inicio: noInicio });
    redesenharTemp();
    gravarRascunhoTrilha();
    atualizarBarraTrilha();
  }

  // Ponto a ponto: o ponto entra no fim da linha (cada ponto é um "traço" de 1, para o Desfazer).
  function acrescentarPonto(dz, ll) {
    if (est.desenho !== dz) return;
    if (dz.pontos.length + 1 > MAX_PONTOS_TRILHA) {
      UI.aviso('A linha chegou ao limite de detalhe (' + MAX_PONTOS_TRILHA + ' pontos). Conclua esta e desenhe a continuação separada.', 'erro', 8000);
      return;
    }
    var u = dz.pontos[dz.pontos.length - 1];
    if (u && u[0] === ll[0] && u[1] === ll[1]) return;
    dz.pontos = dz.pontos.concat([ll]);
    dz.tracos.push({ n: 1, inicio: false });
    redesenharTemp();
    if (dz.tipo === 'trilha') gravarRascunhoTrilha();
    atualizarBarraTrilha();
  }

  function desfazerTraco(dz) {
    var t = dz.tracos.pop();
    if (!t) return;
    if (t.inicio) dz.pontos = dz.pontos.slice(t.n);
    else dz.pontos = dz.pontos.slice(0, dz.pontos.length - t.n);
    if (dz.pontos.length < 2 && !dz.tracos.length && !dz.trilhaId) dz.pontos = [];
    redesenharTemp(); gravarRascunhoTrilha(); atualizarBarraTrilha();
  }

  function desenhoLivre(dz) { return Boolean(dz && (dz.tipo === 'trilha' || dz.tipo === 'trajeto')); }

  function atualizarBarraTrilha() {
    var dz = est.desenho;
    if (!desenhoLivre(dz)) return;
    var traj = dz.tipo === 'trajeto';
    var n = dz.pontos.length;
    var compr = n > 1 ? formatarComprimento(comprimentoLinhaM(dz.pontos)) : '';
    var pontos = dz.modo === 'pontos';
    var texto = dz.mover
      ? 'Mover mapa: arraste e dê zoom. Toque em "Desenhar" para continuar.'
      : pontos ? (n < 2 ? (traj ? 'Trajeto ponto a ponto: ' : dz.trilhaId ? 'Editando o traçado ponto a ponto: ' : 'Trilha ponto a ponto: ') +
          'toque no mapa em cada ponto do caminho, na ordem; eles são ligados por retas. Arraste para mover o mapa.' + (n === 1 ? ' (1 ponto)' : '')
        : (traj ? 'Trajeto · ' : dz.trilhaId ? 'Editando o traçado · ' : 'Trilha · ') + n + ' pontos · ' + compr + ' · toque para o próximo ponto.')
      : n < 2 ? (traj ? 'Trajeto para enviar: desenhe, na ordem, o caminho que a equipe deve fazer (segure e arraste).'
        : (dz.trilhaId ? 'Editando o traçado: ' : 'Desenhar trilha ou trajeto: ') + 'segure e arraste sobre o mapa, como uma caneta. "✔ Concluir" salva como trilha planejada; "Mais opções…" escolhe trilha feita ou enviar para alguém.')
        : (traj ? 'Trajeto · ' : dz.trilhaId ? 'Editando o traçado · ' : 'Trilha · ') + compr + ' · continue arrastando a partir do círculo branco. Dois dedos: zoom.';
    var rapido = !traj && !dz.trilhaId;
    mostrarBarraDesenho(texto, null, [
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'trilha-modo', 'aria-pressed': String(pontos), 'data-fixo': true,
        title: pontos ? 'Voltar a desenhar à mão livre (segurar e arrastar)' : 'Marcar o caminho tocando ponto a ponto no mapa',
        texto: pontos ? '✎ Mão livre' : '• Ponto a ponto', onclick: function () {
          dz.modo = pontos ? 'livre' : 'pontos';
          C.local.gravar(CHAVE_MODO_DESENHO, dz.modo);
          dz.mover = false;
          if (dz.aplicarModo) dz.aplicarModo();
          atualizarBarraTrilha();
        } }),
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'trilha-desfazer', texto: pontos ? 'Desfazer ponto' : 'Desfazer traço', disabled: dz.tracos.length ? null : true, onclick: function () { desfazerTraco(dz); } }),
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'trilha-limpar', texto: 'Limpar', disabled: n ? null : true, onclick: async function () {
        if (n >= 2 && !(await UI.confirmar({ titulo: 'Apagar o desenho?', texto: 'O traçado em andamento recomeça do zero (a trilha salva não muda).', ok: 'Limpar', perigo: true }))) return;
        if (est.desenho !== dz) return;
        dz.pontos = []; dz.tracos = []; redesenharTemp(); gravarRascunhoTrilha(); atualizarBarraTrilha();
      } }),
      pontos ? null : UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'trilha-mover', 'aria-pressed': String(Boolean(dz.mover)),
        texto: dz.mover ? '✎ Desenhar' : '✋ Mover mapa', onclick: function () { dz.mover = !dz.mover; if (dz.aplicarModo) dz.aplicarModo(); atualizarBarraTrilha(); } }),
      rapido ? UI.el('button', { classe: 'btn btn-pequeno btn-ok', type: 'button', id: 'trilha-concluir-rapido', texto: '✔ Concluir',
        title: 'Salvar já como trilha planejada, com nome automático (dá para editar depois)', disabled: n >= 2 ? null : true, onclick: concluirTrilhaRapido }) : null,
      UI.el('button', { classe: 'btn btn-pequeno' + (rapido ? '' : ' btn-ok'), type: 'button', id: 'trilha-concluir', texto: traj ? 'Enviar trajeto…' : dz.trilhaId ? 'Salvar traçado' : 'Mais opções…',
        disabled: n >= 2 ? null : true, onclick: traj ? concluirTrajeto : concluirTrilha }),
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'trilha-cancelar', texto: 'Cancelar', onclick: cancelarDesenhoTrilha }),
    ]);
  }

  async function cancelarDesenhoTrilha() {
    var dz = est.desenho;
    if (!desenhoLivre(dz)) return;
    if (dz.pontos.length >= 2 && !dz.trilhaId) {
      var ok = await UI.confirmar({ titulo: 'Descartar este desenho?', texto: 'O traçado desenhado (' + formatarComprimento(comprimentoLinhaM(dz.pontos)) + ') não será salvo.', ok: 'Descartar', cancelar: 'Continuar desenhando', perigo: true });
      if (!ok || est.desenho !== dz) return;
    }
    if (!dz.trilhaId && dz.tipo === 'trilha') apagarRascunhoTrilha();
    cancelarDesenho();
  }

  /* ---------- Trajeto desenhado e enviado como destino ---------------- */
  // O responsável desenha o caminho à mão (mesma ferramenta das trilhas) e envia a uma pessoa ou
  // a um grupo; o celular segue a linha como foi desenhada (rotas.js → Rotas.deTracado).
  function iniciarDesenhoTrajeto(participantes, grupoId) {
    if (!est.mapa || !podeAlterar()) return;
    iniciarDesenho('trajeto', { pontos: [], tracos: [], participantes: participantes || [], grupo_id: grupoId || null, modo: modoDesenhoTrilha() });
    if (!est.desenho || est.desenho.tipo !== 'trajeto') return;
    ligarDesenhoLivre(est.desenho);
    redesenharTemp();
    atualizarBarraTrilha();
  }

  function concluirTrajeto() {
    var dz = est.desenho;
    if (!dz || dz.tipo !== 'trajeto' || dz.pontos.length < 2) return;
    $('barra-desenho').hidden = true;
    var fim = dz.pontos[dz.pontos.length - 1];
    abrirEnviarDestino({
      nome: 'Trajeto', lat: fim[0], lng: fim[1], trajeto: dz.pontos.slice(), participantes: dz.participantes, grupo_id: dz.grupo_id,
      aoCancelar: function () { if (est.desenho === dz) atualizarBarraTrilha(); },   // fechou sem enviar: volta ao desenho
      aoEnviar: function () { if (est.desenho === dz) cancelarDesenho(); },
    });
  }

  // Concluir sem formulário: salva como trilha planejada, com nome automático ("Trilha 3 · 14:05").
  // Nome, situação, grupo e cor podem ser ajustados depois em Setores, trilhas e pontos.
  async function concluirTrilhaRapido() {
    var dz = est.desenho;
    if (!dz || dz.tipo !== 'trilha' || dz.trilhaId || dz.pontos.length < 2) return;
    var usados = new Set(Array.from(est.trilhasManuais.values()).map(function (t) { return t.d.nome.trim().toLowerCase(); }));
    var n = est.trilhasManuais.size + 1, nome;
    do { nome = 'Trilha ' + n + ' · ' + C.hora(new Date().toISOString(), false); n++; } while (usados.has(nome.toLowerCase()));
    var btn = $('trilha-concluir-rapido');
    if (btn) btn.disabled = true;
    try {
      var res = await C.rpc('salvar_trilha_manual', { p_operacao: est.op.id, p_id: null,
        p_dados: { client_id: dz.client_id, nome: nome, estado: 'planejada', meio: 'equipe', pontos: dz.pontos.slice() } });
      apagarRascunhoTrilha();
      cancelarDesenho();
      aplicarTrilhasManuais([res]);
      UI.aviso('Trilha "' + res.nome + '" salva como planejada. Para mudar nome ou situação, abra-a em Setores, trilhas e pontos.', 'ok');
    } catch (e) {
      if (btn) btn.disabled = false;
      UI.aviso('Trilha não salva: ' + e.message + ' O desenho continua na tela: tente de novo.', 'erro', 9000);
    }
  }

  async function concluirTrilha() {
    var dz = est.desenho;
    if (!dz || dz.tipo !== 'trilha' || dz.pontos.length < 2) return;
    if (!dz.trilhaId) { $('barra-desenho').hidden = true; escolherDestinoDoDesenho(dz); return; }
    // edição do traçado: salva só a geometria
    var btn = $('trilha-concluir');
    if (btn) btn.disabled = true;
    try {
      var res = await C.rpc('salvar_trilha_manual', { p_operacao: est.op.id, p_id: dz.trilhaId, p_dados: { pontos: dz.pontos } });
      cancelarDesenho();
      aplicarTrilhasManuais([res]);
      UI.aviso('Traçado da trilha "' + res.nome + '" salvo.', 'ok');
    } catch (e) {
      if (btn) btn.disabled = false;
      UI.aviso('Traçado não salvo: ' + e.message + (e.rede ? ' O desenho continua na tela: tente de novo.' : ''), 'erro', 9000);
    }
  }

  // Uma ferramenta só para desenhar: ao concluir, a pessoa escolhe se o desenho é uma trilha já
  // feita, uma trilha planejada (só registrar) ou um trajeto para alguém percorrer (enviar como
  // destino; pode ficar também registrado como trilha planejada). Fechar volta ao desenho.
  function escolherDestinoDoDesenho(dz) {
    var compr = formatarComprimento(comprimentoLinhaM(dz.pontos));
    var guardar = UI.el('input', { type: 'checkbox', id: 'desenho-guardar-planejada', checked: true });
    var escolhido = false;
    function opcao(id, titulo, texto, acao, extra) {
      return UI.el('div', { classe: 'opcao-desenho' }, [
        UI.el('button', { classe: 'item-area opcao-desenho-btn', type: 'button', id: id, onclick: function () { escolhido = true; fechar(true); acao(); } }, [
          UI.el('span', { classe: 'item-area-txt' }, [UI.el('strong', { texto: titulo }), UI.el('small', { classe: 'muted', texto: texto })]),
        ]),
        extra || null,
      ]);
    }
    var fechar = UI.abrirModal(UI.el('div', { classe: 'escolha-desenho' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'O que é este desenho? (' + compr + ')' }),
      UI.el('div', { classe: 'lista-escolha-desenho' }, [
        opcao('desenho-feita', '✔ Trilha já percorrida', 'Registrar o caminho que uma equipe ou drone já fez (com quando).', function () { abrirFormTrilha(null, 'percorrida'); }),
        opcao('desenho-planejada', '📋 Trilha planejada', 'Registrar no mapa um caminho a fazer, sem enviar a ninguém agora.', function () { abrirFormTrilha(null, 'planejada'); }),
        opcao('desenho-enviar', '➝ Enviar para alguém percorrer', 'A pessoa ou o grupo segue a linha no celular, do início (verde) ao fim.', function () { enviarDesenhoComoTrajeto(dz, guardar.checked); },
          UI.el('label', { classe: 'linha-opcao opcao-desenho-extra' }, [guardar, ' Guardar também no mapa como trilha planejada'])),
      ]),
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Voltar ao desenho', onclick: function () { fechar(); } })]),
    ]), { aoFechar: function () { if (!escolhido && est.desenho === dz) atualizarBarraTrilha(); } });
  }

  function enviarDesenhoComoTrajeto(dz, guardar) {
    var fim = dz.pontos[dz.pontos.length - 1];
    abrirEnviarDestino({
      nome: 'Trajeto', lat: fim[0], lng: fim[1], trajeto: dz.pontos.slice(),
      aoCancelar: function () { if (est.desenho === dz) atualizarBarraTrilha(); },   // fechou sem enviar: volta ao desenho
      aoEnviar: function (env) {
        var pontos = dz.pontos.slice(), clientId = dz.client_id;
        if (est.desenho === dz) { apagarRascunhoTrilha(); cancelarDesenho(); }
        if (guardar) registrarTrajetoComoTrilha(pontos, clientId, env || {});
      },
    });
  }

  // O trajeto enviado fica no mapa como trilha planejada (com quem recebeu). O envio já foi feito:
  // uma falha aqui só avisa (o client_id evita duplicar se repetir).
  async function registrarTrajetoComoTrilha(pontos, clientId, env) {
    var nome = String(env.nome || 'Trajeto').slice(0, 70);
    var usados = new Set(Array.from(est.trilhasManuais.values()).map(function (t) { return t.d.nome.trim().toLowerCase(); }));
    if (usados.has(nome.toLowerCase())) nome = nome + ' (' + C.hora(new Date().toISOString(), false) + ')';
    var dados = { client_id: clientId || C.uuid(), nome: nome, estado: 'planejada', pontos: pontos, meio: 'equipe',
      grupo_id: env.grupo_id || null, participante_id: env.participantes && env.participantes.length === 1 ? env.participantes[0] : null,
      observacoes: 'Trajeto enviado como destino.' };
    try {
      var res = await C.rpc('salvar_trilha_manual', { p_operacao: est.op.id, p_id: null, p_dados: dados });
      aplicarTrilhasManuais([res]);
    } catch (e) {
      UI.aviso('O trajeto foi enviado, mas não ficou registrado como trilha planejada: ' + e.message, 'erro', 10000);
    }
  }

  // Formulário da trilha. d = trilha existente (editar dados) ou null (nova, com os pontos do desenho).
  // extra (nova trilha vinda de arquivo importado): { pontos, nome, cor, meio, estado, percorrida_em, arquivo }
  function abrirFormTrilha(d, estadoInicial, extra) {
    var dz = extra ? null : est.desenho;
    var novo = !d;
    if (novo && !extra && (!dz || dz.tipo !== 'trilha')) return;
    if (novo && extra && !extra.client_id) extra.client_id = C.uuid();
    var pontos = novo ? (extra ? extra.pontos : dz.pontos.slice()) : d.pontos;
    var base = novo ? extra || {} : d;
    var nome = UI.el('input', { classe: 'campo', id: 'trilha-nome', maxlength: '80', required: true, value: novo ? (extra && extra.nome) || '' : d.nome,
      placeholder: 'Ex.: Margem esquerda do córrego – Equipe Alfa', autofocus: true });
    var estadoAtual = novo ? estadoInicial || (extra && extra.estado) || null : estadoInicial || d.estado;
    var meio = UI.el('select', { classe: 'campo', id: 'trilha-meio' }, Object.keys(MEIO_TRILHA).map(function (k) {
      return UI.el('option', { value: k, selected: (base.meio || 'equipe') === k ? true : null, texto: MEIO_TRILHA[k].ico + ' ' + MEIO_TRILHA[k].rotulo });
    }));
    var corPropria = UI.el('input', { type: 'checkbox', id: 'trilha-cor-propria', checked: base.cor ? true : null });
    var cor = UI.el('input', { type: 'color', classe: 'campo-cor', id: 'trilha-cor', value: base.cor || '#22d3ee', 'aria-label': 'Cor da trilha' });
    cor.disabled = !base.cor;
    corPropria.addEventListener('change', function () { cor.disabled = !corPropria.checked; });
    var estados = UI.el('div', { classe: 'opcoes-estado-trilha', role: 'radiogroup', 'aria-label': 'Situação da trilha' }, Object.keys(ESTADO_TRILHA).map(function (k) {
      var e = ESTADO_TRILHA[k];
      return UI.el('label', { classe: 'opcao-estado-trilha' }, [
        UI.el('input', { type: 'radio', name: 'trilha-estado', value: k, checked: k === estadoAtual ? true : null }),
        UI.el('span', { classe: 'lg-trilha-desenhada lg-' + k, 'aria-hidden': 'true' }),
        UI.el('span', null, [UI.el('strong', { texto: e.rotulo })]),
      ]);
    }));
    var quando = UI.el('input', { classe: 'campo', id: 'trilha-percorrida-em', type: 'datetime-local', max: paraCampoDataHora(C.agora()),
      value: paraCampoDataHora(!novo && d.percorrida_em ? d.percorrida_em : (extra && extra.percorrida_em) || C.agora()) });
    var grupoQuando = UI.campo('Quando foi percorrida', quando, { para: 'trilha-percorrida-em', oculto: estadoAtual !== 'percorrida' });
    estados.addEventListener('change', function () {
      grupoQuando.hidden = ((form.querySelector('input[name="trilha-estado"]:checked') || {}).value) !== 'percorrida';
    });
    var grupoSel = UI.el('select', { classe: 'campo', id: 'trilha-grupo' }, [UI.el('option', { value: '', texto: '— nenhum grupo —' })].concat(
      Array.from(est.grupos.values()).sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); }).map(function (g) {
        return UI.el('option', { value: g.id, selected: !novo && d.grupo_id === g.id ? true : null, texto: g.nome });
      })));
    var part = opcoesParticipantes(novo ? null : d.participante_id, true);
    part.id = 'trilha-participante';
    var equipe = UI.el('input', { classe: 'campo', id: 'trilha-equipe', maxlength: '60', value: novo ? '' : d.equipe || '', placeholder: 'Se não for um grupo cadastrado' });
    var obs = UI.el('textarea', { classe: 'campo', id: 'trilha-obs', maxlength: '1000', rows: '2' });
    obs.value = novo ? '' : d.observacoes || '';
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btnSalvar = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'trilha-salvar', texto: novo ? 'Salvar trilha' : 'Salvar' });
    var salvo = false;
    var form = UI.el('form', { classe: 'form-trilha form-padrao', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: novo ? 'Nova trilha' : 'Editar trilha' }),
      UI.el('p', { classe: 'meta-area', texto: pontos.length + ' pontos · ' + formatarComprimento(comprimentoLinhaM(pontos)) }),
      UI.el('div', { classe: 'form-colunas' }, [
        UI.secao('Trilha', [
          UI.campo('Nome', nome, { para: 'trilha-nome' }),
          UI.campo('Situação', estados, { dica: 'Trilha desenhada à mão: não é rastro de GPS e não conclui setores.' }),
          grupoQuando,
          UI.grade([
            UI.campo('Feito por', meio, { para: 'trilha-meio' }),
            UI.campo('Cor no mapa', UI.el('div', { classe: 'linha-cor' }, [UI.el('label', { classe: 'linha-opcao' }, [corPropria, ' própria']), cor]), { dica: 'Sem cor própria: amarelo (planejada) ou branco (percorrida).' }),
          ]),
        ]),
        UI.secao('Quem', [
          UI.campo('Grupo', grupoSel, { para: 'trilha-grupo', opcional: true }),
          UI.campo('Responsável', part, { para: 'trilha-participante', opcional: true }),
          UI.campo('Equipe', equipe, { para: 'trilha-equipe', opcional: true }),
        ]),
      ]),
      UI.campo('Observações', obs, { para: 'trilha-obs', largo: true, opcional: true }),
      erro,
      UI.rodape([
        UI.el('button', { classe: 'btn', type: 'button', id: 'trilha-voltar', texto: novo ? 'Voltar' : 'Cancelar', onclick: function () { fechar(); } }),
        btnSalvar,
      ]),
    ]);
    function mostrarErro(t) { erro.textContent = t; erro.hidden = false; }
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var estado = (form.querySelector('input[name="trilha-estado"]:checked') || {}).value;
      var dados = {
        nome: nome.value.replace(/\s+/g, ' ').trim(),
        grupo_id: grupoSel.value || null,
        participante_id: part.value || null,
        equipe: equipe.value.trim(),
        observacoes: obs.value.trim(),
        meio: meio.value,
        cor: corPropria.checked ? cor.value : '',
      };
      if (!dados.nome) { mostrarErro('Informe o nome da trilha.'); nome.focus(); return; }
      var repetido = Array.from(est.trilhasManuais.values()).some(function (t) {
        return t.d.id !== (d && d.id) && t.d.nome.trim().toLowerCase() === dados.nome.toLowerCase();
      });
      if (repetido) { mostrarErro('Já existe uma trilha com esse nome nesta operação. Use um nome que identifique o trajeto.'); nome.focus(); return; }
      if (!estado) { mostrarErro('Escolha se a trilha é planejada ou já foi percorrida.'); return; }
      dados.estado = estado;
      if (estado === 'percorrida') {
        var iso = quando.value ? new Date(quando.value) : null;
        if (!iso || isNaN(iso) || iso.getTime() > Date.now() + 120000) { mostrarErro('Informe quando a trilha foi percorrida (não pode estar no futuro).'); return; }
        dados.percorrida_em = iso.toISOString();
      }
      if (novo) {
        dados.pontos = pontos;
        dados.client_id = extra ? extra.client_id : dz.client_id;
        if (extra) { dados.origem = 'importada'; if (extra.arquivo) dados.arquivo = extra.arquivo; }
      }
      btnSalvar.disabled = true;
      btnSalvar.textContent = 'Salvando…';
      try {
        var res = await C.rpc('salvar_trilha_manual', { p_operacao: est.op.id, p_id: novo ? null : d.id, p_dados: dados });
        salvo = true;
        if (novo && !extra) { apagarRascunhoTrilha(); cancelarDesenho(); }
        fechar(true);
        aplicarTrilhasManuais([res]);
        UI.aviso(novo ? 'Trilha "' + res.nome + '" salva (' + ESTADO_TRILHA[res.estado].rotulo.toLowerCase() + ').' : 'Trilha salva.', 'ok');
      } catch (e) {
        // o desenho continua na tela e guardado no aparelho: dá para tentar de novo sem redesenhar
        mostrarErro('Não foi possível salvar: ' + e.message + (novo ? ' O desenho não foi perdido: tente de novo.' : ''));
        btnSalvar.disabled = false;
        btnSalvar.textContent = novo ? 'Tentar de novo' : 'Salvar';
      }
    });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false, tamanho: 'largo', aoFechar: function () {
      // fechar sem salvar volta ao desenho (nada se perde)
      if (!salvo && novo && dz && est.desenho === dz) { atualizarBarraTrilha(); }
    } });
  }

  function paraCampoDataHora(v) {
    var ms = C.paraMs(v);
    if (ms == null) return '';
    var x = new Date(ms);
    function d2(n) { return (n < 10 ? '0' : '') + n; }
    return x.getFullYear() + '-' + d2(x.getMonth() + 1) + '-' + d2(x.getDate()) + 'T' + d2(x.getHours()) + ':' + d2(x.getMinutes());
  }

  function equipeDaTrilha(d) {
    var partes = [];
    var g = d.grupo_id && est.grupos.get(d.grupo_id);
    if (g) partes.push('Grupo ' + g.nome);
    var p = d.participante_id && est.participantes.get(d.participante_id);
    if (p) partes.push(nomeExibido(p));
    if (d.equipe) partes.push(d.equipe);
    return partes.join(' · ');
  }

  function verTrilhaNoMapa(d) {
    if (!est.mapa) return;
    if (est.prefsMapa[prefEstadoTrilha(d.estado)] === false) definirPrefMapa(prefEstadoTrilha(d.estado), true);
    if (trilhasOcultas().has(d.id)) alternarTrilhaOculta(d.id);
    if (telaPequena()) fecharAreas();
    UI.fecharModal();
    est.mapa.fitBounds(L.latLngBounds(d.pontos), { padding: [50, 50], maxZoom: 17 });
  }

  function alternarTrilhaOculta(id) {
    var s = trilhasOcultas();
    if (s.has(id)) s.delete(id); else s.add(id);
    gravarTrilhasOcultas();
    var t = est.trilhasManuais.get(id);
    if (t) desenharTrilhaManual(t);
    renderizarAreas();
  }

  function abrirTrilhaManual(id) {
    var t = est.trilhasManuais.get(id);
    if (!t) return;
    var d = t.d;
    var e = ESTADO_TRILHA[d.estado] || ESTADO_TRILHA.planejada;
    var editavel = podeAlterar();
    var oculta = trilhasOcultas().has(d.id);
    var fechar = UI.abrirModal(UI.el('div', { classe: 'detalhe-trilha' }, [
      cabecaDetalhe({ cor: e.cor, tipo: 'Trilha · ' + e.rotulo, titulo: d.nome, etiqueta: { texto: e.rotulo, classe: e.selo } }),
      fatosDetalhe([
        ['Situação', e.dica, true],
        d.estado === 'percorrida' && d.percorrida_em ? ['Percorrida em', C.hora(d.percorrida_em) + (d.percorrida_por_nome ? ' (informado por ' + d.percorrida_por_nome + ')' : '')] : null,
        ['Comprimento', formatarComprimento(d.comprimento_m != null ? d.comprimento_m : comprimentoLinhaM(d.pontos)) + ' · ' + d.pontos.length + ' pontos'],
        ['Equipe', equipeDaTrilha(d) || 'não informada'],
        ['Percurso feito por', meioDe(d).ico + ' ' + meioDe(d).rotulo],
        ['Origem', d.origem === 'importada' ? 'Importada de arquivo' + (d.arquivo ? ' (' + d.arquivo + ')' : '') + ' · não é rastro de GPS do app' : 'Desenhada à mão no mapa · não é rastro de GPS', true],
        ['Criada', C.hora(d.criado_em) + ' por ' + d.criado_por_nome],
        d.atualizado_por_nome && d.atualizado_em !== d.criado_em ? ['Alterada', C.hora(d.atualizado_em) + ' por ' + d.atualizado_por_nome] : null,
      ]),
      d.observacoes ? secaoDetalhe('Observações', UI.el('p', { classe: 'detalhe-texto', texto: d.observacoes })) : null,
      rodapeDetalhe([
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Ver no mapa', onclick: function () { fechar(); verTrilhaNoMapa(d); } }),
        UI.el('button', { classe: 'btn', type: 'button', id: 'trilha-ocultar', texto: oculta ? 'Mostrar no mapa' : 'Ocultar no mapa', onclick: function () { fechar(); alternarTrilhaOculta(d.id); } }),
        editavel && d.estado === 'planejada' ? UI.el('button', { classe: 'btn btn-ok', type: 'button', id: 'trilha-marcar-percorrida', texto: 'Informar como percorrida', onclick: function () { abrirFormTrilha(d, 'percorrida'); } }) : null,
        editavel ? UI.el('button', { classe: 'btn', type: 'button', id: 'trilha-editar', texto: 'Editar dados', onclick: function () { abrirFormTrilha(d); } }) : null,
        editavel ? UI.el('button', { classe: 'btn', type: 'button', id: 'trilha-editar-tracado', texto: 'Editar traçado', onclick: function () { fechar(); iniciarDesenhoTrilha(d.id); } }) : null,
        editavel ? UI.el('button', { classe: 'btn btn-perigo', type: 'button', id: 'trilha-excluir', texto: 'Excluir', onclick: function () { fechar(); excluirTrilhaManual(d); } }) : null,
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]));
  }

 async function excluirTrilhaManual(d) {
    var r = await UI.confirmar({
      titulo: 'Excluir a trilha "' + d.nome + '"?',
      texto: 'A linha desenhada some do mapa de todos os responsáveis. Setores, participantes e rastros de GPS não são afetados.',
      ok: 'Excluir trilha',
      perigo: true,
    });
    if (!r) return;
    try {
      await C.rpc('excluir_trilha_manual', { p_id: d.id });
      var t = est.trilhasManuais.get(d.id);
      if (t && t.camada) t.camada.remove();
      est.trilhasManuais.delete(d.id);
      renderizarAreas();
      UI.aviso('Trilha excluída.', 'ok');
    } catch (e) {
      UI.aviso(e.codigo === 'sem_permissao' ? 'Só quem desenhou a trilha, quem criou a operação ou um administrador pode excluí-la.' : e.message, 'erro', 7000);
    }
  }

  function renderizarListaTrilhas() {
    var ul = $('lista-trilhas');
    ul.innerHTML = '';
    var vazio = $('trilhas-vazio');
    vazio.hidden = est.trilhasManuais.size > 0;
    vazio.textContent = est.semTrilhasManuais ? 'Trilhas desenhadas indisponíveis: o banco ainda não tem a migração 028.'
      : est.erroTrilhasManuais ? 'Não foi possível carregar as trilhas: ' + est.erroTrilhasManuais
      : 'Nenhuma trilha desenhada.';
    var ocultas = trilhasOcultas();
    Array.from(est.trilhasManuais.values()).sort(function (a, b) { return a.d.nome.localeCompare(b.d.nome, 'pt-BR'); }).forEach(function (t) {
      var d = t.d;
      var e = ESTADO_TRILHA[d.estado] || ESTADO_TRILHA.planejada;
      var oculta = ocultas.has(d.id);
      var catOff = est.prefsMapa[prefEstadoTrilha(d.estado)] === false;
      var sub = meioDe(d).ico + ' ' + [formatarComprimento(d.comprimento_m != null ? d.comprimento_m : comprimentoLinhaM(d.pontos)), equipeDaTrilha(d) || d.criado_por_nome].join(' · ');
      ul.appendChild(UI.el('li', { classe: 'item-trilha' + (oculta || catOff ? ' trilha-oculta' : '') }, [
        UI.el('button', { classe: 'item-area', type: 'button', 'data-trilha': d.id, onclick: function () { abrirTrilhaManual(d.id); } }, [
          UI.el('span', { classe: 'lg-trilha-desenhada lg-' + d.estado, 'aria-hidden': 'true' }),
          UI.el('span', { classe: 'item-area-txt' }, [UI.el('strong', { texto: d.nome }), UI.el('small', { classe: 'muted', texto: sub })]),
          UI.el('span', { classe: 'selo ' + e.selo, texto: e.rotulo }),
        ]),
        UI.el('button', { classe: 'btn-olho', type: 'button', 'data-olho-trilha': d.id, 'aria-pressed': String(!oculta),
          title: catOff ? 'Categoria "' + e.rotulo.toLowerCase() + '" desligada nas camadas' : oculta ? 'Mostrar no mapa' : 'Ocultar no mapa',
          'aria-label': (oculta ? 'Mostrar ' : 'Ocultar ') + d.nome + ' no mapa', texto: oculta ? '◌' : '◉',
          onclick: function () { alternarTrilhaOculta(d.id); } }),
      ]));
    });
  }

  /* ---------- Altitude pelo modelo digital de terreno ---------------- */
  // Ladrilhos "Terrarium" (Terrain Tiles / AWS Open Data): altura = R*256 + G + B/256 − 32768.
  var cacheDem = new Map();
  function ladrilhoDem(z, x, y) {
    var chave = z + '/' + x + '/' + y;
    if (cacheDem.has(chave)) return cacheDem.get(chave);
    var p = new Promise(function (resolve) {
      var img = new Image();
      var t = setTimeout(function () { resolve(null); }, 10000);
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        clearTimeout(t);
        try {
          var cv = document.createElement('canvas');
          cv.width = cv.height = 256;
          var cx = cv.getContext('2d');
          cx.drawImage(img, 0, 0);
          resolve(cx.getImageData(0, 0, 256, 256).data);
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { clearTimeout(t); resolve(null); };
      img.src = URL_DEM.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    });
    p.then(function (v) { if (!v) cacheDem.delete(chave); });
    cacheDem.set(chave, p);
    return p;
  }

  async function altitudeEm(lat, lng) {
    var z = 13, n = Math.pow(2, z);
    var x = (lng + 180) / 360 * n;
    var r = lat * Math.PI / 180;
    var y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
    var tx = Math.floor(x), ty = Math.floor(y);
    var px = Math.min(255, Math.floor((x - tx) * 256)), py = Math.min(255, Math.floor((y - ty) * 256));
    var dados = await ladrilhoDem(z, tx, ty);
    if (!dados) return null;
    var i = (py * 256 + px) * 4;
    return dados[i] * 256 + dados[i + 1] + dados[i + 2] / 256 - 32768;
  }

  /* ---------- Relevo em 3D (MapLibre GL, carregado só quando aberto) -- */
  var MAPLIBRE = {
    js: 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
    jsSri: 'sha384-SYKAG6cglRMN0RVvhNeBY0r3FYKNOJtznwA0v7B5Vp9tr31xAHsZC0DqkQ/pZDmj',
    css: 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
    cssSri: 'sha384-MinO0mNliZ3vwppuPOUnGa+iq619pfMhLVUXfC4LHwSCvF9H+6P/KO4Q7qBOYV5V',
  };
  var carregandoMapLibre = null;
  function carregarMapLibre() {
    if (window.maplibregl) return Promise.resolve();
    if (carregandoMapLibre) return carregandoMapLibre;
    carregandoMapLibre = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = MAPLIBRE.css; css.integrity = MAPLIBRE.cssSri; css.crossOrigin = 'anonymous';
      document.head.appendChild(css);
      var sc = document.createElement('script');
      sc.src = MAPLIBRE.js; sc.integrity = MAPLIBRE.jsSri; sc.crossOrigin = 'anonymous';
      sc.onload = function () {
        if (window.maplibregl) resolve();
        else { carregandoMapLibre = null; reject(new Error('a biblioteca 3D não respondeu')); }
      };
      sc.onerror = function () { carregandoMapLibre = null; reject(new Error('não foi possível carregar a biblioteca 3D')); };
      document.head.appendChild(sc);
    });
    return carregandoMapLibre;
  }

  function suportaWebGL() {
    try {
      var c = document.createElement('canvas');
      return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
    } catch (e) { return false; }
  }

  var BASES_3D = {
    osm: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom: 19, attribution: '© OpenStreetMap' },
    topo: { tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'], maxzoom: 17, attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)' },
    satelite: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], maxzoom: 19, attribution: 'Imagens © Esri, Maxar, Earthstar Geographics' },
  };

  // Régua circular (js/regua.js): o botão do topo e o item de Ferramentas fazem a mesma coisa.
  function alternarRegua() {
    if (!est.mapa || !window.Regua) return;
    var ligada = window.Regua.alternar(est.mapa);
    $('btn-regua').setAttribute('aria-pressed', String(ligada));
    $('btn-regua').classList.toggle('btn-ativo', ligada);
    $('menu-regua').setAttribute('aria-pressed', String(ligada));
    UI.aviso(ligada ? 'Régua circular ligada: os números são o raio, medido a partir do centro da tela.' : 'Régua circular desligada.', 'ok', 4000);
  }

  async function abrirRelevo3D() {
    if (!est.mapa) return;
    fecharMenu(false);
    fecharCamadas(false);
    cancelarDesenho();
    var caixa = $('visao-3d');
    caixa.hidden = false;
    document.body.classList.add('visao-3d-aberta');
    atualizarModoVisao();
    var nota = $('visao-3d-nota');
    nota.textContent = 'Carregando o relevo em 3D…';
    if (!suportaWebGL()) {
      nota.textContent = 'Este aparelho ou navegador não tem suporte a gráficos 3D (WebGL). Use o tipo de mapa "Topográfico" no painel Camadas, sobre o mapa.';
      return;
    }
    try {
      await carregarMapLibre();
    } catch (e) {
      nota.textContent = 'Não foi possível abrir o 3D: ' + e.message + '. Verifique a internet. O mapa normal continua funcionando.';
      return;
    }
    if (caixa.hidden) return;
    var base = BASES_3D[est.camadaAtual] || BASES_3D.osm;
    var c = est.mapa.getCenter();
    var mapa3d = new window.maplibregl.Map({
      container: 'visao-3d-mapa',
      style: {
        version: 8,
        sources: {
          base: { type: 'raster', tiles: base.tiles, tileSize: 256, maxzoom: base.maxzoom, attribution: base.attribution },
          dem: { type: 'raster-dem', tiles: [URL_DEM], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: 'Elevação: Terrain Tiles (Mapzen/AWS) — SRTM e outras fontes' },
        },
        layers: [
          { id: 'base', type: 'raster', source: 'base' },
          { id: 'sombreamento', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.45 } },
        ],
        terrain: { source: 'dem', exaggeration: 1.5 },
      },
      center: [c.lng, c.lat],
      zoom: Math.max(2, est.mapa.getZoom() - 1),
      pitch: 60,
      maxPitch: 80,
      attributionControl: { compact: true },
    });
    mapa3d.addControl(new window.maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    est.visao3d = { mapa: mapa3d, marcadores: [], popup: null };
    mapa3d.on('load', function () {
      if (!est.visao3d || est.visao3d.mapa !== mapa3d) return;
      adicionarDados3D();
      nota.textContent = 'Relevo 3D real a partir do modelo digital de terreno (Terrain Tiles/AWS — SRTM e outras fontes, resolução de cerca de 30 m), com exagero vertical de 1,5×. ' +
        'Arraste com dois dedos (ou com o botão direito) para girar e inclinar; toque no terreno para ver a altitude. Mostra as posições do momento em que foi aberto: toque em "Atualizar posições".';
    });
    mapa3d.on('error', function (ev) {
      if (ev && ev.sourceId === 'dem' && !est.visao3d.avisouDem) {
        est.visao3d.avisouDem = true;
        UI.aviso('Parte do relevo não carregou (sem conexão com o modelo de terreno).', 'erro', 7000);
      }
    });
    mapa3d.on('click', async function (e) {
      var m = await altitudeEm(e.lngLat.lat, e.lngLat.lng);
      if (!est.visao3d || est.visao3d.mapa !== mapa3d) return;
      if (est.visao3d.popup) est.visao3d.popup.remove();
      est.visao3d.popup = new window.maplibregl.Popup({ closeButton: true, className: 'popup-3d' })
        .setLngLat(e.lngLat)
        .setText((m == null ? 'Altitude indisponível' : 'Altitude ≈ ' + Math.round(m).toLocaleString('pt-BR') + ' m') + ' · ' + C.coord(e.lngLat.lat) + ', ' + C.coord(e.lngLat.lng))
        .addTo(mapa3d);
    });
  }

  // Setores, trilhas, participantes e pontos sobre o relevo (retrato do momento).
  function adicionarDados3D() {
    var v = est.visao3d;
    if (!v) return;
    var m = v.mapa;
    var setores = { type: 'FeatureCollection', features: [] };
    est.setores.forEach(function (s) {
      var anel = verticesSetor(s.d).map(function (p) { return [p[1], p[0]]; });
      anel.push(anel[0]);
      setores.features.push({ type: 'Feature', properties: { cor: s.d.cor }, geometry: { type: 'Polygon', coordinates: [anel] } });
    });
    var trilhas = { type: 'FeatureCollection', features: [] };
    est.participantes.forEach(function (p) {
      if (!p.trilhaVisivel) return;
      trilhaDe(p).segmentos.forEach(function (seg) {
        if (seg.length < 2) return;
        trilhas.features.push({ type: 'Feature', properties: { cor: corDoParticipante(p) }, geometry: { type: 'LineString', coordinates: seg.map(function (q) { return [q[1], q[0]]; }) } });
      });
    });
    if (m.getSource('setores')) {
      m.getSource('setores').setData(setores);
      m.getSource('trilhas').setData(trilhas);
    } else {
      m.addSource('setores', { type: 'geojson', data: setores });
      m.addLayer({ id: 'setores-fundo', type: 'fill', source: 'setores', paint: { 'fill-color': ['get', 'cor'], 'fill-opacity': 0.18 } });
      m.addLayer({ id: 'setores-borda', type: 'line', source: 'setores', paint: { 'line-color': ['get', 'cor'], 'line-width': 2.5 } });
      m.addSource('trilhas', { type: 'geojson', data: trilhas });
      m.addLayer({ id: 'trilhas-halo', type: 'line', source: 'trilhas', paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.5 } });
      m.addLayer({ id: 'trilhas', type: 'line', source: 'trilhas', paint: { 'line-color': ['get', 'cor'], 'line-width': 3.5 } });
    }
    v.marcadores.forEach(function (mk) { mk.remove(); });
    v.marcadores = [];
    est.participantes.forEach(function (p) {
      var pos = posicaoAtual(p);
      if (!pos || p.dados.removido) return;
      var el = document.createElement('div');
      el.className = 'mk3d' + (posicaoAntiga(p) ? ' antigo' : '');
      el.innerHTML = htmlSimbolo(p);
      el.title = nomeExibido(p) + ' — posição ' + C.idade(pos.t);
      v.marcadores.push(new window.maplibregl.Marker({ element: el }).setLngLat([pos.lng, pos.lat]).addTo(m));
    });
    est.pontosInt.forEach(function (pi) {
      var d = pi.d, cat = catDoPonto(d);
      var el = document.createElement('div');
      el.className = 'mk3d mk3d-poi';
      el.innerHTML = htmlMarcaPonto(d);
      el.title = cat.rotulo + ': ' + d.titulo;
      v.marcadores.push(new window.maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([d.lng, d.lat]).addTo(m));
    });
  }

  function fecharRelevo3D() {
    var caixa = $('visao-3d');
    if (!caixa || caixa.hidden) return;
    caixa.hidden = true;
    document.body.classList.remove('visao-3d-aberta');
    atualizarModoVisao();
    if (est.visao3d) {
      try { est.visao3d.mapa.remove(); } catch (e) { /* ignora */ }
      est.visao3d = null;
    }
    $('visao-3d-mapa').innerHTML = '';
  }

  /* ------------------------------------------------------------------ */
  /* Presença e posição do próprio responsável                            */
  /* ------------------------------------------------------------------ */
  // Registra este responsável no mapa da operação (sem posição até o aparelho enviar a primeira localização).
  async function entrarComoResponsavel() {
    if (!est.op || est.op.status !== 'ativa') return;
    var opId = est.op.id;
    try {
      var row = await C.rpc('entrar_como_responsavel', { p_operacao: opId });
      if (!est.op || est.op.id !== opId || !row) return;
      est.meuPart = row.id;
      upsertParticipante(row);
      renderizarLista();
      verificarMensagensParaMim();
      if (est.compartilhando) enviarMeuSinal();
    } catch (e) { /* tenta de novo no próximo ciclo */ }
  }

  var TEXTO_MINHA_POS = {
    desligada: 'sem envio · toque para tentar',
    iniciando: 'ligando…',
    ativa: 'ligada',
    sem_sinal: 'ligada · procurando sinal',
    bloqueada: 'bloqueada no navegador',
    indisponivel: 'indisponível',
    outro_aparelho: 'enviada por outro aparelho seu',
  };

  // O botão só aparece como "ligado" com a permissão concedida E coordenadas chegando.
  // Sem chave nem texto permanente no menu: só avisa quando a localização deste aparelho
  // tem um problema que exige ação (bloqueada no navegador ou sem GPS). Some sozinho ao resolver.
  var AVISO_GPS = {
    bloqueada: 'A localização está bloqueada neste navegador. Sem ela, sua posição não chega à equipe.',
    indisponivel: 'Este aparelho não oferece localização. Sem ela, sua posição não chega à equipe.',
    outro_aparelho: 'Sua posição já é enviada por outro aparelho seu. Para enviar por este, use o botão abaixo.',
  };
  function atualizarEstadoGps() {
    var e = est.minhaPosEstado;
    var texto = AVISO_GPS[e] || '';
    var caixa = $('gps-alerta');
    if (caixa) {
      caixa.hidden = !texto;
      $('gps-alerta-texto').textContent = texto;
      $('gps-alerta-como').hidden = e !== 'bloqueada';
      $('gps-alerta-tentar').textContent = e === 'outro_aparelho' ? 'Usar este aparelho' : 'Tentar de novo';
    }
    $('ferramentas').classList.toggle('alerta-gps', Boolean(texto));
    if (texto && est.avisoGpsFeito !== e) UI.aviso(texto, 'erro', 8000);
    est.avisoGpsFeito = texto ? e : null;
    atualizarFilaMinha();
    atualizarBotaoMinhaTrilha();
  }

  function chaveMinhaPosAqui() { return 'gbs-minha-pos-aqui:' + (est.op ? est.op.id : ''); }

  // O mesmo responsável com o painel aberto em dois aparelhos (ex.: computador do
  // posto de comando e celular): só um compartilha, para a trilha não "pular"
  // entre os dois. Se outro aparelho dele já está enviando, este não liga sozinho.
  function outroAparelhoCompartilhando() {
    var p = est.meuPart && est.participantes.get(est.meuPart);
    if (!p) return false;
    var d = p.dados;
    var recente = d.ultima_posicao_em && C.agora() - C.paraMs(d.ultima_posicao_em) < 120000;
    var aqui = Date.now() - Number(C.local.ler(chaveMinhaPosAqui(), 0) || 0) < 180000;
    return Boolean(d.rastreando && recente && !aqui);
  }

  // Registro da trilha do responsável: opcional, liga e desliga só pelo botão, sempre com confirmação.
  // Menu Ferramentas em seções recolhíveis (o estado fica neste aparelho) e busca pelo nome da função.
  var CHAVE_SECOES_MENU = 'gbs-menu-secoes-fechadas';
  function iniciarSecoesMenu() {
    var menu = $('menu-ferramentas'), filtro = $('menu-filtro');
    if (!menu || !filtro) return;
    var fechadas = new Set(C.local.ler(CHAVE_SECOES_MENU, []) || []);
    var secoes = Array.prototype.slice.call(menu.querySelectorAll('.menu-secao'));
    function aplicarSecao(sec) {
      var aberta = !fechadas.has(sec.getAttribute('data-secao')) || Boolean(filtro.value.trim());
      sec.classList.toggle('fechada', !aberta);
      sec.querySelector('.menu-secao-titulo').setAttribute('aria-expanded', String(aberta));
    }
    secoes.forEach(function (sec) {
      sec.querySelector('.menu-secao-titulo').addEventListener('click', function () {
        if (filtro.value.trim()) return;
        var id = sec.getAttribute('data-secao');
        if (fechadas.has(id)) fechadas.delete(id); else fechadas.add(id);
        C.local.gravar(CHAVE_SECOES_MENU, Array.from(fechadas));
        aplicarSecao(sec);
      });
      aplicarSecao(sec);
    });
    function semAcento(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
    filtro.addEventListener('input', function () {
      var q = semAcento(filtro.value.trim());
      Array.prototype.forEach.call(menu.querySelectorAll('.menu-lista .menu-item, .menu-lista .menu-tema'), function (it) {
        it.classList.toggle('filtrado', Boolean(q) && semAcento(it.textContent + ' ' + (it.title || '')).indexOf(q) === -1);
      });
      secoes.forEach(function (sec) {
        aplicarSecao(sec);
        sec.hidden = Boolean(q) && !sec.querySelector('.menu-secao-itens > :not(.filtrado):not([hidden]):not(.menu-sol)');
      });
    });
    // Enter: abre a primeira função encontrada
    filtro.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      var it = menu.querySelector('.menu-lista .menu-item:not(.filtrado):not([hidden]):not(.fora-do-menu)');
      if (it && it.tagName === 'BUTTON') { ev.preventDefault(); it.click(); }
    });
  }

  function chaveMinhaTrilha() { return 'gbs-minha-trilha:' + (est.op ? est.op.id : ''); }
  function acharMeuRegistro() {
    if (est.meuPart || !est.usuario) return;
    est.participantes.forEach(function (p) {
      if (!est.meuPart && p.dados.user_id === est.usuario.id && p.dados.tipo === 'responsavel' && !p.dados.removido) est.meuPart = p.dados.id;
    });
    if (est.meuPart) verificarMensagensParaMim();
  }
  function atualizarBotaoMinhaTrilha() {
    var b = $('menu-minha-trilha');
    if (!b) return;
    var ligado = est.compartilhando || est.iniciandoMinhaPos;
    b.setAttribute('aria-pressed', String(Boolean(ligado)));
    b.classList.toggle('btn-ativo', Boolean(ligado));
    $('menu-minha-trilha-estado').textContent = est.iniciandoMinhaPos ? 'ligando…' : est.compartilhando ? (est.minhaPosEstado === 'ativa' ? 'gravando' : 'gravando · sem sinal') : 'desligado';
  }
  async function alternarMinhaTrilha() {
    if (!est.op || est.op.status !== 'ativa' || est.iniciandoMinhaPos) return;
    if (est.compartilhando) {
      var parar = await UI.confirmar({ titulo: 'Interromper o registro da sua trilha?', ok: 'Interromper',
        texto: 'Sua posição deixa de ser enviada à equipe e a sua trilha para de ser gravada. O que já foi gravado continua no mapa. Para voltar a gravar, toque de novo em "Registrar minha trilha".' });
      if (!parar) return;
      C.local.apagar(chaveMinhaTrilha());
      pararMinhaPosicao(false);
      UI.aviso('Registro da sua trilha interrompido.', 'ok');
      return;
    }
    var iniciar = await UI.confirmar({ titulo: 'Iniciar o registro da sua trilha?', ok: 'Iniciar registro',
      texto: 'Sua posição passa a aparecer no mapa para a equipe e a sua trilha é gravada até você interromper. Mantenha o painel aberto e a tela ligada.' });
    if (!iniciar) return;
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      est.minhaPosEstado = 'indisponivel';
      atualizarEstadoGps();
      return;
    }
    await verificarPermissaoMinha();
    if (est.permissaoMinha === 'denied') { est.minhaPosEstado = 'bloqueada'; atualizarEstadoGps(); mostrarComoLiberarMinha(); return; }
    C.local.gravar(chaveMinhaTrilha(), 1);
    ligarMinhaPosicao(false);
  }
  async function oferecerRetomarMinhaTrilha() {
    if (!Number(C.local.ler(chaveMinhaTrilha(), 0))) return;
    var opId = est.op.id;
    var sim = await UI.confirmar({ titulo: 'Retomar o registro da sua trilha?', ok: 'Retomar', cancelar: 'Não registrar',
      texto: 'Você estava registrando a sua trilha neste aparelho quando o painel foi fechado. Quer continuar?' });
    if (!est.op || est.op.id !== opId) return;
    if (!sim) { C.local.apagar(chaveMinhaTrilha()); return; }
    ligarMinhaPosicao(false);
  }

  // Permissions API: acompanha mudanças (ex.: o responsável liberou nas configurações).
  async function verificarPermissaoMinha() {
    var r = await window.GPS.consultarPermissao();
    est.permissaoMinha = r.estado;
    if (r.status && !est.statusPermissaoMinha) {
      est.statusPermissaoMinha = r.status;
      r.status.onchange = function () {
        est.permissaoMinha = r.status.state;
        if (!est.op || est.op.status !== 'ativa') return;
        // liberou depois de tentar ligar: segue o pedido já confirmado
        if (est.permissaoMinha === 'granted' && est.minhaPosEstado === 'bloqueada' && Number(C.local.ler(chaveMinhaTrilha(), 0))) {
          ligarMinhaPosicao(true);
        } else if (est.permissaoMinha === 'denied' && est.compartilhando) {
          pararMinhaPosicao(true);
          est.minhaPosEstado = 'bloqueada';
          atualizarEstadoGps();
        }
      };
    }
    if (est.permissaoMinha === 'granted' && est.minhaPosEstado === 'bloqueada' && est.op && est.op.status === 'ativa' && Number(C.local.ler(chaveMinhaTrilha(), 0))) {
      ligarMinhaPosicao(true);
    }
  }

  // A localização do responsável não tem liga/desliga: se o envio parou
  // (bloqueio, falha, outro aparelho), tenta de novo neste aparelho.
  async function garantirMinhaPosicao() {
    if (est.iniciandoMinhaPos) return;
    if (est.compartilhando) {
      UI.aviso('Sua posição está sendo compartilhada com a equipe. Para parar, use "Registrar minha trilha" em Ferramentas.', 'ok');
      return;
    }
    if (!est.op || est.op.status !== 'ativa') return;
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      UI.aviso('Este navegador não oferece localização (é preciso abrir o painel por https://).', 'erro', 7000);
      return;
    }
    await verificarPermissaoMinha();
    if (est.permissaoMinha === 'denied') { mostrarComoLiberarMinha(); return; }
    ligarMinhaPosicao(false);
  }

  function mostrarComoLiberarMinha() {
    var inst = window.GPS.instrucoesLocalizacao('navegador');
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', texto: inst.titulo }),
      UI.el('ol', { classe: 'perm-passos' }, inst.passos.map(function (t) { return UI.el('li', { texto: t }); })),
      UI.rodape([
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Verificar de novo', onclick: function () { fechar(); ligarMinhaPosicao(false); } }),
      ]),
    ]));
  }

  // Liga a coleta: um único observador do GPS, nunca duplicado.
  async function ligarMinhaPosicao(automatico) {
    if (est.compartilhando || est.iniciandoMinhaPos || !est.op || est.op.status !== 'ativa') return;
    var opId = est.op.id;
    est.iniciandoMinhaPos = true;
    est.minhaPosEstado = 'iniciando';
    atualizarEstadoGps();
    prepararAudio();
    try {
      if (!est.meuPart) await entrarComoResponsavel();
      if (!est.meuPart) throw new Error('Não foi possível registrar você no mapa. Verifique a conexão.');
      abrirMinhaTrilha();
      var teste = await new Promise(function (resolve) {
        navigator.geolocation.getCurrentPosition(
          function (pos) { resolve({ ok: true, pos: pos }); },
          function (err) { resolve({ ok: false, codigo: err.code }); },
          { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
        );
      });
      if (!est.op || est.op.id !== opId || est.op.status !== 'ativa') return;   // trocou de operação nesse meio-tempo
      if (!teste.ok && teste.codigo === 1) {
        est.minhaPosEstado = 'bloqueada';
        est.permissaoMinha = 'denied';
        if (!automatico) mostrarComoLiberarMinha();   // no automático, o aviso do menu Ferramentas basta
        return;
      }
      est.compartilhando = true;
      est.filtroMeu.reiniciar();
      est.ultimoAceitoMeu = null;
      if (teste.ok) {
        processarMinhaPosicao(teste.pos);
        if (est.minhaPosEstado === 'iniciando') est.minhaPosEstado = 'sem_sinal';   // leitura descartada (antiga/inválida)
      } else {
        est.gpsMeu = teste.codigo === 2 ? 'indisponivel' : 'sem_sinal';
        est.minhaPosEstado = 'sem_sinal';
      }
      iniciarMeuWatch();
      pedirTelaLigada();
      enviarMeuSinal();
      UI.aviso(est.minhaPosEstado === 'ativa'
        ? 'Sua posição está sendo compartilhada com a equipe. Mantenha o painel aberto.'
        : 'Compartilhamento ligado, mas ainda sem sinal de GPS.', est.minhaPosEstado === 'ativa' ? 'ok' : 'erro', 7000);
    } catch (e) {
      est.minhaPosEstado = 'desligada';
      UI.aviso(e.message, 'erro');
    } finally {
      est.iniciandoMinhaPos = false;
      atualizarEstadoGps();
    }
  }

  function iniciarMeuWatch() {
    if (est.watchId != null) return;
    est.meuWatchEm = Date.now();
    est.watchId = navigator.geolocation.watchPosition(processarMinhaPosicao, erroMeuGps, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 30000,
    });
  }

  // Sem leituras por 90 s com o painel visível: reinicia o observador (sempre um só).
  function vigiarMeuGps() {
    if (!est.compartilhando || document.visibilityState !== 'visible' || est.gpsMeu === 'negado') return;
    var ultima = est.ultimoAceitoMeu ? est.ultimoAceitoMeu.recebidaEm || 0 : 0;
    if (Date.now() - Math.max(ultima, est.meuWatchEm) < CFG_GPS.reiniciarMs) return;
    if (est.watchId != null) { navigator.geolocation.clearWatch(est.watchId); est.watchId = null; }
    iniciarMeuWatch();
  }

  function processarMinhaPosicao(pos) {
    if (!est.compartilhando) return;
    var r = est.filtroMeu.processar(pos);
    if (r.atual) {
      var a = r.atual;
      est.ultimoAceitoMeu = { lat: a.lat, lng: a.lng, prec: a.prec, t: a.t, recebidaEm: a.recebidaEm };
      est.gpsMeu = a.prec != null && a.prec > 50 ? 'fraco' : 'ok';
      est.minhaPosEstado = 'ativa';
    }
    if (r.pontos.length) {
      var rapido = r.rapido;
      // gravado primeiro no aparelho (IndexedDB), com id único; depois enviado
      guardarMinhaPosicao(r.pontos.map(function (p) { return { id: C.uuid(), lat: p.lat, lng: p.lng, prec: p.prec, t: p.t }; })).then(function () {
        // envio logo em seguida (o primeiro na hora; ~1 s em veículo; ~1,5 s a pé), sem adiar o que já está marcado
        if (!est.timerMinhaFila) {
          est.timerMinhaFila = setTimeout(function () { est.timerMinhaFila = null; enviarMinhaFila(); },
            !est.enviouMinhaAlguma ? 300 : rapido ? CFG_GPS.envioRapidoMs : CFG_GPS.envioPeMs);
        }
      });
    }
    atualizarEstadoGps();
  }

  // Fila offline da "Minha posição" (a mesma da página do participante).
  function abrirMinhaTrilha() {
    if (!est.meuPart || !est.op) return Promise.resolve(null);
    var pid = est.meuPart;
    if (est.filaMinha && est.filaMinha.ids.participanteId === pid) return Promise.resolve(est.filaMinha);
    if (est.abrindoMinha && est.abrindoMinha.pid === pid) return est.abrindoMinha.promessa;
    var promessa = window.TrilhaLocal.abrir({ participanteId: pid, userId: est.usuario && est.usuario.id, operacaoId: est.op.id })
      .then(function (f) {
        est.abrindoMinha = null;
        if (est.meuPart !== pid) return null;
        est.filaMinha = f;
        var buf = est.bufferMinha;
        est.bufferMinha = [];
        return (buf.length ? f.adicionar(buf).then(avaliarGravacaoMinha) : Promise.resolve()).then(function () { enviarMinhaFila(); return f; });
      })
      .catch(function () { est.abrindoMinha = null; return null; });
    est.abrindoMinha = { pid: pid, promessa: promessa };
    return promessa;
  }

  // Ponto só é "salvo" quando o aparelho confirma a gravação; senão o usuário é avisado (no máximo 1 vez por minuto).
  function avaliarGravacaoMinha(res) {
    if (res && res.duraveis === false && Date.now() - (est.ultimoAvisoGravacaoMinha || 0) > 60000) {
      est.ultimoAvisoGravacaoMinha = Date.now();
      UI.aviso('Atenção: não foi possível gravar a sua posição neste aparelho (pode estar sem espaço). Os pontos estão só na memória: não feche esta página.', 'erro', 12000);
    }
    return res;
  }

  function guardarMinhaPosicao(pontos) {
    if (est.filaMinha && est.filaMinha.ids.participanteId === est.meuPart) return est.filaMinha.adicionar(pontos).then(avaliarGravacaoMinha);
    // a fila ainda está abrindo: os pontos esperam aqui, sem limite (nenhum é descartado)
    Array.prototype.push.apply(est.bufferMinha, pontos);
    return abrirMinhaTrilha();
  }

  function qtdParaEnviarMinha() {
    return (est.filaMinha ? est.filaMinha.qtdParaEnviar() : 0) + est.bufferMinha.length;
  }

  // Detalhes da fila (pendentes, gravação no aparelho, última sincronização confirmada, falhas) no menu Ferramentas
  function atualizarFilaMinha() {
    if (est.filaMinha && est.gpsMeu) {
      var ruim = est.gpsMeu === 'negado' || est.gpsMeu === 'indisponivel' || est.gpsMeu === 'sem_sinal';
      if (est.compartilhando) est.filaMinha.transicao('gps', ruim, { motivo: est.gpsMeu });
    }
    if (!est.filaMinhaUI && $('fila-estado-meu') && window.FilaEstado) {
      est.filaMinhaUI = window.FilaEstado.montar($('fila-estado-meu'), {
        fila: function () { return est.filaMinha; },
        extra: function () { return { pendentes: est.bufferMinha.length, naoDuraveis: est.bufferMinha.length }; },
        ativo: function () { return Boolean(est.compartilhando); },
      });
    }
    if (est.filaMinhaUI) est.filaMinhaUI.atualizar();
  }

  function pendentesMinha() {
    return (est.filaMinha ? est.filaMinha.qtdPendentes() : 0) + est.bufferMinha.length;
  }

  // Intervalo máximo sem ponto definido na operação (padrão 15 s).
  function aplicarIntervaloGpsMeu() {
    var s = est.op && est.op.gps_intervalo_s;
    if (s) est.filtroMeu.configurar({ intervaloParadoMs: s * 1000 });
  }

  // Parado no mesmo lugar, o navegador pode não avisar novas leituras; então
  // pedimos uma leitura nova (no ritmo do intervalo de GPS da operação).
  function lerPosicaoSeParado() {
    if (!est.compartilhando || !est.ultimoAceitoMeu) return;
    if (Date.now() - est.ultimoAceitoMeu.recebidaEm < Math.max(5000, est.filtroMeu.cfg.intervaloParadoMs - 2000)) return;
    navigator.geolocation.getCurrentPosition(processarMinhaPosicao, function () {}, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
    });
  }

  function erroMeuGps(err) {
    if (err.code === 1) {
      est.gpsMeu = 'negado';
      est.minhaPosEstado = 'bloqueada';
    } else if (err.code === 2) {
      est.gpsMeu = 'indisponivel';
      est.minhaPosEstado = 'sem_sinal';
    } else if (!est.ultimoAceitoMeu || Date.now() - est.ultimoAceitoMeu.recebidaEm > 60000) {
      est.gpsMeu = 'sem_sinal';
      est.minhaPosEstado = 'sem_sinal';
    }
    est.filtroMeu.registrar(null, false, err.code === 1 ? 'negado' : err.code === 2 ? 'indisponivel' : 'sem_sinal');
    atualizarEstadoGps();
  }

  // Envio em lote: o ponto só é marcado como enviado quando o servidor confirma.
  async function enviarMinhaFila() {
    var fila = est.filaMinha;
    if (est.enviandoMinha || !est.meuPart || !fila || fila.ids.participanteId !== est.meuPart || !fila.qtdParaEnviar()) return;
    est.enviandoMinha = true;
    try {
      var r = await window.TrilhaLocal.enviarLote(fila, C.rpc, {
        lote: 200,
        gps: est.compartilhando ? est.gpsMeu : null,
        ajustarHora: function (pts) {
          var desvio = C.agora() - Date.now();   // relógio do aparelho errado: converte para a hora do servidor
          return Math.abs(desvio) < 30000 ? pts : pts.map(function (x) { return Object.assign({}, x, { t: Math.round(x.t + desvio) }); });
        },
      });
      if (r.recusados) est.filtroMeu.registrar(null, false, 'servidor_recusou');
      if (r.confirmados) {
        est.enviouMinhaAlguma = true;
        C.local.gravar(chaveMinhaPosAqui(), Date.now());   // este aparelho é o que compartilha
      }
      if (r.resp && r.resp.gps_lacuna_s > 0) fila.lacunaMs = r.resp.gps_lacuna_s * 1000;
      fila.persistirPendentes();   // o que não conseguiu ser gravado no aparelho é tentado de novo
      if (fila.qtdParaEnviar()) setTimeout(enviarMinhaFila, 300);
    } catch (e) {
      if (e.codigo === 'operacao_encerrada' || e.codigo === 'participante_invalido') {
        fila.limpar();
        est.filaMinha = null;
        if (e.codigo === 'participante_invalido') est.meuPart = null;
      } else if (e.codigo === 'lote_invalido') {
        await fila.marcarRecusados(fila.pendentes(200).map(function (p) { return { id: p.id, motivo: 'lote_invalido' }; }));
      } else if (!est.timerMinhaFila) {
        est.timerMinhaFila = setTimeout(function () { est.timerMinhaFila = null; enviarMinhaFila(); }, 5000);
      }
    } finally {
      est.enviandoMinha = false;
      atualizarFilaMinha();
    }
  }

  async function enviarMeuSinal() {
    if (!est.meuPart) return;
    try {
      // Só o aparelho que está compartilhando diz "rastreando". Um segundo aparelho
      // do mesmo responsável (ex.: computador + celular) manda null e não apaga o estado.
      // O aviso de que parou é enviado uma única vez, em pararMinhaPosicao().
      var r = await C.rpc('sinal_vida', {
        p_participante: est.meuPart,
        p_rastreando: est.compartilhando ? true : null,
        p_gps: est.compartilhando ? est.gpsMeu : null,
      }, 12000);
      if (r && r.status === 'inexistente') est.meuPart = null;   // registro apagado: será recriado
    } catch (e) { /* tenta de novo no próximo ciclo */ }
  }

  function pararMinhaPosicao(silencioso) {
    var estava = est.compartilhando;
    est.compartilhando = false;
    if (est.watchId != null) {
      navigator.geolocation.clearWatch(est.watchId);
      est.watchId = null;
    }
    clearTimeout(est.timerMinhaFila);
    est.timerMinhaFila = null;
    est.minhaPosEstado = 'desligada';
    liberarTelaLigada();
    if (estava) {
      // envia o que ficou na fila e depois avisa que parou (guarda o registro
      // agora, porque ao sair do painel ele é limpo logo em seguida)
      var part = est.meuPart;
      enviarMinhaFila().then(function () {
        if (part) C.rpc('sinal_vida', { p_participante: part, p_rastreando: false, p_gps: null }).catch(function () {});
      });
    }
    if (!silencioso) atualizarEstadoGps();
  }

  // Diagnóstico das leituras do GPS deste aparelho (não é enviado a ninguém).
  function abrirDiagnosticoGps() {
    var f = est.filtroMeu;
    var caixa = UI.el('div', { classe: 'diag-tabela' });
    var info = UI.el('p', { classe: 'ajuda' });
    function render() {
      caixa.innerHTML = window.GPS.tabelaDiagnostico(f, 80);
      info.textContent = 'Minha posição: ' + (TEXTO_MINHA_POS[est.minhaPosEstado] || est.minhaPosEstado) + ' · permissão do navegador: ' +
        est.permissaoMinha + ' · na fila: ' + pendentesMinha() +
        (est.filaMinha ? ' (' + est.filaMinha.tipo + ', enviados ' + est.filaMinha.qtdEnviados() + ', recusados ' + est.filaMinha.recusados().length + ')' : '') +
        ' · intervalo máximo: ' + Math.round(f.cfg.intervaloParadoMs / 1000) + ' s · ' +
        (f.resumo().map(function (x) { return x.texto + ': ' + x.qtd; }).join(' · ') || 'sem leituras ainda');
    }
    render();
    var timer = setInterval(render, 2000);
    var fechar = UI.abrirModal(UI.el('div', { classe: 'modal-diag form-padrao' }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Diagnóstico do GPS' },
        [UI.dica('Cada leitura do GPS: entrou na trilha ou foi descartada, com o motivo. Fica neste aparelho. Para o de um participante, ele abre o link com "&diag=1".')]),
      info,
      caixa,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]), { aoFechar: function () { clearInterval(timer); } });
  }

  async function pedirTelaLigada() {
    if (!est.compartilhando || est.wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      est.wakeLock = await navigator.wakeLock.request('screen');
      est.wakeLock.addEventListener('release', function () { est.wakeLock = null; });
    } catch (e) { est.wakeLock = null; }
  }

  function liberarTelaLigada() {
    if (est.wakeLock) {
      try { est.wakeLock.release(); } catch (e) { /* ignora */ }
      est.wakeLock = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Mensagens recebidas por este responsável (de outros responsáveis)    */
  /* ------------------------------------------------------------------ */
  function verificarMensagensParaMim() {
    if (!est.meuPart) return;
    var paraEntregar = [];
    est.mensagens.forEach(function (m) {
      if (m.participante_id === est.meuPart && m.direcao !== 'entrada' && !m.entregue_em && !est.entregando.has(m.id)) {
        est.entregando.add(m.id);
        paraEntregar.push(m.id);
      }
    });
    if (paraEntregar.length) {
      C.rpc('marcar_entregues', { p_ids: paraEntregar }).catch(function () {
        paraEntregar.forEach(function (id) { est.entregando.delete(id); });
      });
    }
    mostrarAlertaParaMim();
  }

  // "×" no cartão: deixa a resposta para depois. A mensagem continua pendente e um botão
  // no topo ("✉ N para você") reabre o cartão; mensagem nova também reabre.
  function adiarAlertaParaMim() {
    pendentesParaMim().forEach(function (m) { est.alertaAdiadas.add(m.id); });
    est.alertaAtual = null;
    mostrarAlertaParaMim();
  }

  function pendentesParaMim() {
    var lista = [];
    est.mensagens.forEach(function (m) {
      if (est.meuPart && m.participante_id === est.meuPart && m.direcao !== 'entrada' && !m.confirmada_em && !est.confirmadasLocal.has(m.id)) lista.push(m);
    });
    return lista.sort(function (a, b) { return C.paraMs(b.criada_em) - C.paraMs(a.criada_em); });
  }

  function mostrarAlertaParaMim() {
    var caixa = $('alerta-cmd');
    if (!caixa) return;
    var todas = pendentesParaMim();
    var pend = todas.filter(function (m) { return !est.alertaAdiadas.has(m.id); });
    var bReabrir = $('btn-alerta-pendente');
    bReabrir.hidden = !todas.length || Boolean(pend.length);
    $('alerta-pendente-qtd').textContent = String(todas.length);
    if (!pend.length) {
      caixa.hidden = true;
      est.alertaAtual = null;
      return;
    }
    var m = pend[0];
    var fila = pend.length > 1 ? 'Mais ' + (pend.length - 1) + ' mensagem(ns) aguardando confirmação' : '';
    if (est.alertaAtual === m.id && !caixa.hidden) {
      $('alerta-cmd-fila').textContent = fila;
      return;
    }
    est.alertaAtual = m.id;
    var tipo = C.TIPOS_MENSAGEM[m.tipo] || C.TIPOS_MENSAGEM.PERSONALIZADA;
    caixa.className = 'alerta-msg alerta-painel alerta-' + tipo.classe;
    $('alerta-cmd-tit').textContent = tipo.titulo;
    $('alerta-cmd-texto').textContent = m.texto || tipo.padrao;
    $('alerta-cmd-meta').textContent = 'De ' + (m.remetente_nome || 'outro responsável') + ' · ' + (est.op ? est.op.codigo : '') + ' · às ' + C.hora(m.criada_em);
    $('alerta-cmd-fila').textContent = fila;
    var botoes = $('alerta-cmd-botoes');
    botoes.innerHTML = '';
    if (m.tipo === 'CONFIRME') {
      botoes.appendChild(UI.el('button', { classe: 'btn btn-ok', type: 'button', texto: 'Estou bem', onclick: function () { confirmarParaMim(m.id, 'ESTOU_BEM'); } }));
      botoes.appendChild(UI.el('button', { classe: 'btn btn-primario', type: 'button', texto: 'Preciso de ajuda', onclick: function () { confirmarParaMim(m.id, 'PRECISO_AJUDA'); } }));
    } else {
      botoes.appendChild(UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Confirmar leitura', onclick: function () { confirmarParaMim(m.id, 'CIENTE'); } }));
    }
    caixa.hidden = false;
    var b = botoes.querySelector('button');
    if (b) b.focus({ preventScroll: true });
  }

  async function confirmarParaMim(id, resposta) {
    est.confirmadasLocal.add(id);
    est.alertaAtual = null;
    mostrarAlertaParaMim();
    try {
      var m = await C.rpc('confirmar_mensagem', { p_mensagem: id, p_resposta: resposta });
      if (m && m.id) receberMensagem(m, true);
      UI.aviso('Confirmação enviada.', 'ok');
    } catch (e) {
      est.confirmadasLocal.delete(id);
      mostrarAlertaParaMim();
      UI.aviso(e.message, 'erro');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Equipe: responsáveis da operação                                     */
  /* ------------------------------------------------------------------ */
  function abrirEquipe() {
    var op = est.op;
    if (!op) return;
    var souCriador = est.usuario && op.responsavel_id === est.usuario.id;
    var lista = UI.el('ul', { classe: 'lista-equipe' }, [UI.el('li', { classe: 'muted', texto: 'Carregando…' })]);
    var entrada = UI.el('input', { classe: 'campo', type: 'email', id: 'equipe-email', autocomplete: 'off', placeholder: 'email@cbm…', 'aria-describedby': 'equipe-ajuda' });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btnAdd = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', texto: 'Adicionar' });
    var form = UI.el('form', { classe: 'equipe-form', novalidate: true }, [
      UI.campo('Adicionar responsável (e-mail)', UI.el('div', { classe: 'link-caixa' }, [entrada, btnAdd]), { para: 'equipe-email', dica: 'Só é possível adicionar quem já tem acesso ao painel (cadastrado pelo administrador).' }),
      erro,
    ]);

    function render(itens) {
      lista.innerHTML = '';
      (itens || []).forEach(function (r) {
        var eu = est.usuario && r.user_id === est.usuario.id;
        var li = UI.el('li', null, [
          UI.el('div', { classe: 'equipe-info' }, [
            UI.el('strong', { texto: r.nome }),
            r.criador ? UI.el('span', { classe: 'selo selo-responsavel', texto: 'Criador' }) : null,
            eu ? UI.el('span', { classe: 'selo selo-neutro', texto: 'Você' }) : null,
            UI.el('div', { classe: 'muted', texto: r.email || '' }),
          ]),
        ]);
        if (souCriador && !r.criador && !eu && podeAlterar()) {
          var bRem = UI.el('button', { classe: 'btn btn-perigo btn-pequeno', type: 'button', texto: 'Remover' });
          bRem.addEventListener('click', async function () {
            var ok = await UI.confirmar({ titulo: 'Remover ' + r.nome + ' da operação?', texto: r.nome + ' deixa de ter acesso a esta operação. O que a pessoa já registrou continua no histórico.', ok: 'Remover', perigo: true });
            if (!ok) return;
            bRem.disabled = true;
            try {
              render(await C.rpc('remover_responsavel', { p_operacao: op.id, p_user: r.user_id }));
              UI.aviso(r.nome + ' foi removido da operação.', 'ok');
              sincronizar();
            } catch (e) {
              bRem.disabled = false;
              UI.aviso(e.message, 'erro');
            }
          });
          li.appendChild(bRem);
        }
        lista.appendChild(li);
      });
    }

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var email = entrada.value.trim();
      if (!email || email.indexOf('@') === -1) {
        erro.textContent = 'Informe o e-mail do responsável.';
        erro.hidden = false;
        return;
      }
      btnAdd.disabled = true;
      try {
        render(await C.rpc('adicionar_responsavel', { p_operacao: op.id, p_email: email }));
        entrada.value = '';
        UI.aviso('Responsável adicionado. Ele já vê esta operação na lista dele.', 'ok');
      } catch (e) {
        erro.textContent = e.message;
        erro.hidden = false;
      } finally {
        btnAdd.disabled = false;
      }
    });

    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Responsáveis da operação' }, [UI.dica('Todos os responsáveis abaixo veem o mapa, os participantes, as posições uns dos outros e as mensagens desta operação, e podem enviar orientações.' + (souCriador ? '' : ' Só quem criou a operação pode remover responsáveis.'))]),
      lista,
      podeAlterar() ? form : UI.el('p', { classe: 'muted', texto: 'Operação encerrada: a equipe não pode ser alterada.' }),
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]));

    C.rpc('listar_responsaveis', { p_operacao: op.id }).then(render).catch(function (e) {
      lista.innerHTML = '';
      lista.appendChild(UI.el('li', { classe: 'erro-form', texto: e.message }));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Minha conta: troca da própria senha                                  */
  /* ------------------------------------------------------------------ */
  function abrirMinhaConta() {
    var s1 = UI.el('input', { classe: 'campo', type: 'password', id: 'conta-senha1', autocomplete: 'new-password', maxlength: '72' });
    var s2 = UI.el('input', { classe: 'campo', type: 'password', id: 'conta-senha2', autocomplete: 'new-password', maxlength: '72' });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', texto: 'Salvar nova senha' });
    var form = UI.el('form', { classe: 'form-padrao', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Minha senha' }),
      UI.el('p', { classe: 'ajuda', texto: (est.responsavel ? est.responsavel.nome + ' · ' : '') + (est.usuario && est.usuario.email || '') }),
      UI.grade([
        UI.campo('Nova senha', s1, { para: 'conta-senha1', dica: 'Mínimo de 8 caracteres, com letras e números.' }),
        UI.campo('Repita', s2, { para: 'conta-senha2' }),
      ]),
      erro,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      if (s1.value.length < 8) { erro.textContent = 'A senha precisa ter pelo menos 8 caracteres.'; erro.hidden = false; return; }
      if (s1.value !== s2.value) { erro.textContent = 'As duas senhas não são iguais.'; erro.hidden = false; return; }
      btn.disabled = true;
      try {
        // trocar a senha tira o aviso de senha provisória (se houver)
        var r = await C.cliente.auth.updateUser({ password: s1.value, data: { senha_provisoria: false } });
        if (r.error) throw C.criarErro(r.error);
        fechar();
        UI.aviso('Senha alterada.', 'ok');
      } catch (e) {
        erro.textContent = /weak|password/i.test(String(e.original && e.original.message)) ? 'Senha fraca. Use pelo menos 8 caracteres, misturando letras e números.' : e.message;
        erro.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form);
  }

  /* ------------------------------------------------------------------ */
  /* Responsáveis (somente administradores)                               */
  /* ------------------------------------------------------------------ */
  var ERROS_API = {
    nome_invalido: 'Informe o nome (2 a 60 caracteres).',
    email_invalido: 'E-mail inválido.',
    senha_fraca: 'Senha fraca: use pelo menos 8 caracteres.',
    ja_cadastrado: 'Este e-mail já está cadastrado como responsável.',
    sem_permissao: 'Somente administradores podem fazer isso.',
    nao_autenticado: 'Sessão expirada. Entre novamente.',
    responsavel_nao_encontrado: 'Responsável não encontrado.',
    variaveis_de_ambiente_ausentes: 'Servidor sem a chave secreta do Supabase (variável SUPABASE_SECRET_KEY no Vercel).',
    falha_supabase: 'O Supabase recusou a operação. Tente de novo em instantes.',
    responsavel_com_registros: 'Esta pessoa tem operações, mensagens ou localizações de vítimas registradas, que não podem ser apagadas. Desative o acesso em vez de excluir.',
    nao_pode_alterar_a_si: 'Você não pode alterar ou excluir o seu próprio acesso.',
    login_nao_apagado: 'O acesso ao painel foi removido, mas o login não pôde ser apagado. Apague-o em Authentication → Users no Supabase.',
    falha_rede: 'Falha de comunicação com o Supabase.',
    email_em_uso: 'Este e-mail já tem cadastro. Se já pediu acesso, aguarde a aprovação; se foi recusado, fale com um administrador.',
  };

  function gerarSenha() {
    var alfabeto = 'abcdefghjkmnpqrstuvwxyz23456789';
    var b = new Uint8Array(12);
    crypto.getRandomValues(b);
    var s = '';
    for (var i = 0; i < 12; i++) {
      s += alfabeto[b[i] % alfabeto.length];
      if (i === 3 || i === 7) s += '-';
    }
    return s;
  }

  async function copiarTexto(t) {
    try { await navigator.clipboard.writeText(t); UI.aviso('Copiado.', 'ok'); }
    catch (e) { UI.aviso('Selecione e copie manualmente.', 'erro'); }
  }

  async function chamarApiResponsaveis(corpo) {
    var sessao = (await C.cliente.auth.getSession()).data.session;
    if (!sessao) throw new Error(ERROS_API.nao_autenticado);
    return enviarApi(corpo, 'Bearer ' + sessao.access_token);
  }

  // Sem autorização = pedido de acesso (a conta ainda não existe para o painel).
  async function enviarApi(corpo, autorizacao) {
    var cabecalhos = { 'Content-Type': 'application/json' };
    if (autorizacao) cabecalhos.Authorization = autorizacao;
    var r;
    try {
      r = await fetch('/api/responsaveis', { method: 'POST', headers: cabecalhos, body: JSON.stringify(corpo) });
    } catch (e) {
      throw new Error('Sem conexão com o servidor.');
    }
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(ERROS_API[j.erro] || ('Erro ' + r.status + (j.erro ? ': ' + j.erro : '')));
    return j;
  }

  // Pedido de acesso (modal na tela de login). Não cria acesso: o administrador aprova depois.
  function abrirSolicitacaoAcesso() {
    var form = document.importNode($('tpl-form-solicitacao').content, true).querySelector('form');
    form.addEventListener('submit', enviarSolicitacao);
    var fechar = UI.abrirModal(form, { fecharNoFundo: false });
    est.fecharSolicitacao = fechar;
    form.querySelector('#sol-cancelar').addEventListener('click', function () { fechar(); });
    setTimeout(function () { form.querySelector('#sol-nome').focus(); }, 40);
  }

  async function enviarSolicitacao(ev) {
    ev.preventDefault();
    var form = ev.currentTarget;
    var erro = form.querySelector('#sol-erro');
    erro.hidden = true;
    var nome = form.querySelector('#sol-nome').value.replace(/\s+/g, ' ').trim();
    var email = form.querySelector('#sol-email').value.trim().toLowerCase();
    var senha = form.querySelector('#sol-senha').value;
    var confirma = form.querySelector('#sol-senha2').value;
    var msg = nome.length < 2 ? ERROS_API.nome_invalido
      : !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? ERROS_API.email_invalido
      : senha.length < 8 ? ERROS_API.senha_fraca
      : senha !== confirma ? 'As senhas não conferem.' : '';
    if (msg) { erro.textContent = msg; erro.hidden = false; return; }
    var btn = form.querySelector('#sol-enviar');
    btn.disabled = true;
    try {
      await enviarApi({ acao: 'solicitar', nome: nome, email: email, senha: senha }, null);
      if (est.fecharSolicitacao) { est.fecharSolicitacao(); est.fecharSolicitacao = null; }
      $('login-email').value = email;
      UI.aviso('Pedido enviado. Um administrador vai analisar; você poderá entrar depois da aprovação.', 'ok', 9000);
    } catch (e) {
      erro.textContent = e.message;
      erro.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  // Pedidos pendentes (só o administrador vê). A seção some quando não há nenhum.
  async function carregarSolicitacoes() {
    try {
      desenharSolicitacoes(await C.rpc('admin_listar_solicitacoes'));
    } catch (e) {
      desenharSolicitacoes([]);
      UI.aviso('Não foi possível carregar os pedidos de acesso: ' + e.message, 'erro', 7000);
    }
  }

  function desenharSolicitacoes(lista) {
    var ul = $('lista-solicitacoes');
    lista = lista || [];
    ul.innerHTML = '';
    $('sec-solicitacoes').hidden = !lista.length;
    $('sol-contagem').textContent = lista.length ? lista.length + (lista.length === 1 ? ' pendente' : ' pendentes') : '';
    lista.forEach(function (s) {
      ul.appendChild(UI.el('li', null, [
        UI.el('div', { classe: 'op-info' }, [
          UI.el('strong', { texto: s.nome }),
          UI.el('span', { texto: (s.email || '') + ' · pediu em ' + C.hora(s.criado_em, false) }),
        ]),
        UI.el('div', { classe: 'op-acoes' }, [
          UI.el('button', { classe: 'btn btn-pequeno btn-ok', type: 'button', texto: 'Aprovar', onclick: function () { decidirSolicitacao(s, true); } }),
          UI.el('button', { classe: 'btn btn-pequeno btn-perigo', type: 'button', texto: 'Recusar', onclick: function () { decidirSolicitacao(s, false); } }),
        ]),
      ]));
    });
  }

  async function decidirSolicitacao(s, aprovar) {
    var ok = await UI.confirmar({
      titulo: (aprovar ? 'Aprovar ' : 'Recusar ') + s.nome,
      texto: aprovar ? s.nome + ' passará a acessar o painel como responsável comum (não administrador).'
        : s.nome + ' não terá acesso ao painel. O pedido fica registrado como recusado.',
      ok: aprovar ? 'Aprovar' : 'Recusar',
      perigo: !aprovar,
    });
    if (!ok) return;
    try {
      await C.rpc('admin_decidir_solicitacao', { p_id: s.id, p_aprovar: aprovar });
      UI.aviso(aprovar ? s.nome + ' aprovado.' : 'Pedido recusado.', 'ok');
      carregarResponsaveis();
    } catch (e) {
      UI.aviso(e.message, 'erro', 7000);
    }
  }

  async function mostrarResponsaveis() {
    mostrarTela('responsaveis');
    document.title = 'Responsáveis — Painel GBS';
    await carregarResponsaveis();
  }

  async function carregarResponsaveis() {
    var ul = $('lista-resp');
    ul.innerHTML = '<li class="muted">Carregando…</li>';
    carregarSolicitacoes();
    try {
      renderizarResponsaveis(await C.rpc('admin_listar_responsaveis'));
    } catch (e) {
      ul.innerHTML = '';
      ul.appendChild(UI.el('li', { classe: 'erro-form', texto: e.message }));
    }
  }

  function renderizarResponsaveis(lista) {
    est.listaResp = lista || [];
    desenharResponsaveis();
  }

  // Filtros da lista de responsáveis (sobre a lista carregada).
  function filtrarResponsaveis(lista) {
    var busca = semAcento($('resp-busca').value.trim());
    var situacao = $('resp-situacao').value;
    var papel = $('resp-papel').value;
    return lista.filter(function (r) {
      if (busca && semAcento((r.nome || '') + ' ' + (r.email || '')).indexOf(busca) === -1) return false;
      if (situacao === 'ativos' && !r.ativo) return false;
      if (situacao === 'desativados' && r.ativo) return false;
      if (papel === 'admin' && !r.admin) return false;
      if (papel === 'comuns' && r.admin) return false;
      return true;
    });
  }

  function desenharResponsaveis() {
    var ul = $('lista-resp');
    var todos = est.listaResp || [];
    var lista = filtrarResponsaveis(todos);
    ul.innerHTML = '';
    var vazio = !todos.length ? 'Nenhum responsável cadastrado.' : !lista.length ? 'Nenhum responsável com esses filtros.' : '';
    $('resp-vazio').textContent = vazio;
    $('resp-vazio').hidden = !vazio;
    $('resp-contagem').textContent = !todos.length ? '' : lista.length === todos.length
      ? todos.length + (todos.length === 1 ? ' responsável' : ' responsáveis')
      : lista.length + ' de ' + todos.length + ' responsáveis';
    lista.forEach(function (r) {
      var funcoes = [];
      if (!r.eu) {
        funcoes.push({ texto: 'Redefinir senha', acao: function () { redefinirSenha(r); } });
        funcoes.push({ texto: r.admin ? 'Tirar administrador' : 'Tornar administrador', acao: function () { alterarAdmin(r); } });
      }
      funcoes.push({ texto: 'Renomear', acao: function () { renomearResponsavel(r); } });
      // Desativar e excluir ficam juntos, no fim do menu
      if (!r.eu) {
        funcoes.push({ texto: r.ativo ? 'Desativar acesso' : 'Reativar acesso', perigo: r.ativo, acao: function () { alterarAtivo(r); } });
        funcoes.push({ texto: 'Excluir responsável', perigo: true, acao: function () { excluirResponsavel(r); } });
      }
      var acoes = UI.el('div', { classe: 'op-acoes' }, [menuLinha(funcoes)]);
      var li = UI.el('li', { classe: (r.ativo ? '' : 'inativo ') + 'clicavel', tabindex: '0' }, [
        UI.el('div', { classe: 'op-info' }, [
          UI.el('strong', null, [
            r.nome + ' ',
            r.admin ? UI.el('span', { classe: 'selo selo-responsavel', texto: 'Administrador' }) : null,
            r.ativo ? null : UI.el('span', { classe: 'selo selo-perigo', texto: 'Desativado' }),
            r.eu ? UI.el('span', { classe: 'selo selo-neutro', texto: 'Você' }) : null,
          ]),
          UI.el('span', { texto: (r.email || '') + ' · último acesso: ' + (r.ultimo_acesso ? C.hora(r.ultimo_acesso, false) : 'nunca entrou') }),
        ]),
        acoes,
      ]);
      li.addEventListener('click', function (ev) { if (!ev.target.closest('button')) abrirDetalheResponsavel(r); });
      li.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && ev.target === li) abrirDetalheResponsavel(r); });
      ul.appendChild(li);
    });
  }

  function alterarAdmin(r) {
    alterarResponsavel(r, { p_admin: !r.admin }, r.admin ? 'deixará de ser administrador' : 'passará a ser administrador');
  }

  function alterarAtivo(r) {
    alterarResponsavel(r, { p_ativo: !r.ativo }, r.ativo ? 'perderá o acesso ao painel na hora' : 'voltará a acessar o painel');
  }

  // Detalhes de um responsável (clicar na linha): dados e as mesmas ações, em texto.
  function abrirDetalheResponsavel(r) {
    var fechar = null;
    var acoes = [];
    function acao(texto, fn, classe) {
      return UI.el('button', { classe: 'btn ' + (classe || ''), type: 'button', texto: texto, onclick: function () { fechar(); fn(); } });
    }
    if (!r.eu) {
      acoes.push(acao('Redefinir senha', function () { redefinirSenha(r); }));
      acoes.push(acao(r.admin ? 'Tirar administrador' : 'Tornar administrador', function () { alterarAdmin(r); }));
      acoes.push(acao(r.ativo ? 'Desativar acesso' : 'Reativar acesso', function () { alterarAtivo(r); }, r.ativo ? 'btn-perigo' : 'btn-ok'));
    }
    acoes.push(acao('Renomear', function () { renomearResponsavel(r); }));
    if (!r.eu) acoes.push(acao('Excluir responsável', function () { excluirResponsavel(r); }, 'btn-perigo'));
    fechar = UI.abrirModal(UI.el('div', { classe: 'detalhe-resp' }, [
      UI.el('h2', { id: 'modal-titulo', texto: r.nome }),
      UI.el('p', { classe: 'muted', texto: r.email || '' }),
      UI.el('p', { classe: 'ajuda', texto: (r.admin ? 'Administrador' : 'Responsável') + (r.ativo ? '' : ' · acesso desativado') +
        ' · último acesso: ' + (r.ultimo_acesso ? C.hora(r.ultimo_acesso, false) : 'nunca entrou') }),
      UI.el('div', { classe: 'modal-acoes' }, acoes.concat([UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })])),
    ]));
  }

  // Cadastro de responsável num modal (igual ao de nova operação). O modelo está no HTML (<template>).
  function abrirCadastroResponsavel() {
    var form = document.importNode($('tpl-form-resp').content, true).querySelector('form');
    form.querySelector('#resp-senha').value = gerarSenha();
    form.querySelector('#resp-gerar').addEventListener('click', function () { form.querySelector('#resp-senha').value = gerarSenha(); });
    form.addEventListener('submit', cadastrarResponsavel);
    var fechar = UI.abrirModal(form, { fecharNoFundo: false });
    est.fecharCadastroResp = fechar;
    form.querySelector('#resp-cancelar').addEventListener('click', function () { fechar(); });
    setTimeout(function () { form.querySelector('#resp-nome').focus(); }, 40);
  }

  async function cadastrarResponsavel(ev) {
    ev.preventDefault();
    var erro = $('resp-erro');
    erro.hidden = true;
    var nome = $('resp-nome').value.replace(/\s+/g, ' ').trim();
    var email = $('resp-email').value.trim().toLowerCase();
    var senha = $('resp-senha').value;
    var admin = $('resp-admin').checked;
    var msg = nome.length < 2 ? ERROS_API.nome_invalido
      : !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? ERROS_API.email_invalido
      : senha.length < 8 ? ERROS_API.senha_fraca : '';
    if (msg) { erro.textContent = msg; erro.hidden = false; return; }
    var btn = $('resp-cadastrar');
    btn.disabled = true;
    try {
      var r = await chamarApiResponsaveis({ acao: 'criar', nome: nome, email: email, senha: senha, admin: admin });
      var painel = new URL('militar.html', location.href);
      painel.hash = '';
      $('resp-cred-texto').textContent = r.ja_existia
        ? 'Painel: ' + painel.href + '\nE-mail: ' + email + '\nSenha: a mesma que essa pessoa já usava (o login já existia).'
        : 'Painel: ' + painel.href + '\nE-mail: ' + email + '\nSenha provisória: ' + senha + '\n\nTroque a senha em "Minha conta" no primeiro acesso.';
      $('resp-credenciais').hidden = false;
      if (est.fecharCadastroResp) { est.fecharCadastroResp(); est.fecharCadastroResp = null; }
      UI.aviso(nome + ' cadastrado.', 'ok');
      carregarResponsaveis();
    } catch (e) {
      erro.textContent = e.message;
      erro.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  async function alterarResponsavel(r, campos, efeito) {
    var ok = await UI.confirmar({ titulo: r.nome, texto: r.nome + ' ' + efeito + '. Confirma?', ok: 'Confirmar', perigo: campos.p_ativo === false });
    if (!ok) return;
    try {
      renderizarResponsaveis(await C.rpc('admin_alterar_responsavel', Object.assign({ p_user: r.user_id }, campos)));
      UI.aviso('Alteração salva.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro', 7000);
    }
  }

  // Exclusão definitiva: o banco recusa quem é você ou tem histórico (operações, mensagens, localizações).
  async function excluirResponsavel(r) {
    var ok = await UI.confirmar({
      titulo: 'Excluir ' + r.nome,
      texto: 'O login e o acesso ao painel de ' + r.nome + ' serão apagados e não podem ser recuperados. '
        + 'Se a pessoa já criou operações, enviou mensagens ou registrou localizações de vítimas, a exclusão é recusada: nesse caso, desative o acesso.',
      ok: 'Excluir definitivamente',
      perigo: true,
    });
    if (!ok) return;
    try {
      await chamarApiResponsaveis({ acao: 'excluir', user_id: r.user_id });
      renderizarResponsaveis(await C.rpc('admin_listar_responsaveis'));
      UI.aviso('Responsável excluído.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro', 8000);
    }
  }

  async function renomearResponsavel(r) {
    var res = await UI.confirmar({ titulo: 'Renomear', campo: { rotulo: 'Nome / posto e graduação', valor: r.nome, max: 60, obrigatorio: true }, ok: 'Salvar' });
    if (!res) return;
    try {
      renderizarResponsaveis(await C.rpc('admin_alterar_responsavel', { p_user: r.user_id, p_nome: res.texto }));
      UI.aviso('Nome atualizado.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro');
    }
  }

  async function redefinirSenha(r) {
    var res = await UI.confirmar({
      titulo: 'Redefinir senha de ' + r.nome,
      texto: 'A senha atual deixa de funcionar. Passe a nova senha para ' + r.nome + ' por um canal seguro.',
      campo: { rotulo: 'Nova senha provisória', valor: gerarSenha(), max: 72, obrigatorio: true },
      ok: 'Redefinir senha',
    });
    if (!res) return;
    if (res.texto.length < 8) { UI.aviso(ERROS_API.senha_fraca, 'erro'); return; }
    try {
      await chamarApiResponsaveis({ acao: 'senha', user_id: r.user_id, senha: res.texto });
      $('resp-cred-texto').textContent = 'E-mail: ' + (r.email || '') + '\nNova senha provisória: ' + res.texto;
      $('resp-credenciais').hidden = false;
      window.scrollTo(0, 0);
      UI.aviso('Senha redefinida.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro', 7000);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Local da operação (cadastro)                                         */
  /* ------------------------------------------------------------------ */
  function desenharLocalOp() {
    if (est.marcaLocal) { est.marcaLocal.remove(); est.marcaLocal = null; }
    var op = est.op;
    if (!est.mapa || !op || op.local_lat == null || op.local_lng == null || !est.prefsMapa.local) return;
    var mk = L.marker([op.local_lat, op.local_lng], {
      icon: L.divIcon({ className: 'mk-local-wrap', html: '<div class="mk-local">◎</div><div class="mk-local-rotulo">Local da operação</div>', iconSize: [0, 0] }),
      keyboard: true, title: 'Local da operação' + (op.local_endereco ? ': ' + op.local_endereco : ''), alt: 'Local da operação', zIndexOffset: -100,
    });
    ligarCliquesMapa(mk, {
      noDesenho: function () { aoClicarNoMapa({ latlng: mk.getLatLng() }); },
      info: function () { return { latlng: mk.getLatLng(), titulo: 'Local da operação', texto: op.local_endereco || null, botao: 'Dados da operação ›', deslocY: -12 }; },
      detalhes: function () { abrirDadosOperacao(); },
    });
    mk.addTo(est.mapa);
    est.marcaLocal = mk;
    if (!est.jaEnquadrou && !temAlgumaPosicao()) est.mapa.setView([op.local_lat, op.local_lng], 15);
  }

  function verLocalNoMapa(op) {
    if (!est.mapa || !op || op.local_lat == null) return;
    if (!est.prefsMapa.local) definirPrefMapa('local', true);
    est.mapa.setView([op.local_lat, op.local_lng], Math.max(est.mapa.getZoom(), 16));
  }

  // Tabela ainda inexistente no banco (migração não aplicada): a função fica desligada.
  function ehTabelaAusente(e) {
    var o = (e && e.original) || e || {};
    return o.code === '42P01' || o.code === 'PGRST205' || /does not exist|Could not find the table|schema cache/i.test(String(o.message || ''));
  }

  function bipeCurto() {
    var ac = est.audio;
    if (!ac) return;
    try {
      if (ac.state === 'suspended') ac.resume();
      var t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + 0.32);
    } catch (e) { /* ignora */ }
  }

  /* ------------------------------------------------------------------ */
  /* Grupos                                                               */
  /* ------------------------------------------------------------------ */
  async function carregarGrupos() {
    if (!est.op || est.semGrupos) return;
    var opId = est.op.id;
    try {
      var r = await Promise.all([
        C.consultar(C.cliente.from('grupos').select('*').eq('operacao_id', opId).order('nome', { ascending: true })),
        C.consultar(C.cliente.from('grupo_membros').select('*').eq('operacao_id', opId)),
      ]);
      if (!est.op || est.op.id !== opId) return;
      est.grupos = new Map((r[0] || []).map(function (g) { return [g.id, g]; }));
      var mem = new Map();
      (r[1] || []).forEach(function (m) {
        if (!mem.has(m.grupo_id)) mem.set(m.grupo_id, new Map());
        mem.get(m.grupo_id).set(m.participante_id, m);
      });
      est.membros = mem;
      est.filtroGrupos.forEach(function (gid) { if (!est.grupos.has(gid)) est.filtroGrupos.delete(gid); });
      aplicarMudancaGrupos();
    } catch (e) {
      if (ehTabelaAusente(e)) { est.semGrupos = true; renderizarControleGrupos(); }
    }
  }

  function agendarGrupos() {
    clearTimeout(est.timerGrupos);
    est.timerGrupos = setTimeout(carregarGrupos, 400);
  }

  // Depois de mudar grupos ou vínculos: marcadores (★), lista, ficha, filtro e controle.
  function aplicarMudancaGrupos() {
    est.participantes.forEach(function (p) {
      atualizarAparenciaMarcador(p);
      atualizarIdentidade(p);
      if (filtroAtivo()) { atualizarMarcador(p); desenharTrilha(p); }
    });
    est.listaSuja = true;
    renderizarLista();
    if (est.selecionado) atualizarFicha();
    if (filtroAtivo()) desenharDestinosGrupo();
    renderizarControleGrupos();
    renderizarLegenda();
    atualizarMenu();
    if (est.renderGruposAberto) est.renderGruposAberto();
  }

  // Grupos de um participante: [{ id, nome, cor, papel }]
  // Quadradinho da cor do grupo, com o ícone dele dentro (quando tem)
  function chipGrupo(g) {
    var ic = g && g.icone;
    if (!ic && g && g.id && est.grupos.get(g.id)) ic = est.grupos.get(g.id).icone;
    var c = UI.el('span', { classe: 'chip-cor' + (ic ? ' chip-icone' : ''), style: 'background:' + g.cor + (ic ? ';color:' + window.Cores.textoSobre(g.cor) : '') }, ic ? [ic] : null);
    return c;
  }
  function htmlChipGrupo(g, classe, tag) {
    tag = tag || 'span';
    var ic = g.icone;
    return '<' + tag + ' class="' + classe + (ic ? ' chip-cor chip-icone' : '') + '" style="background:' + C.esc(g.cor) + (ic ? ';color:' + window.Cores.textoSobre(g.cor) : '') + '">' + (ic ? C.esc(ic) : '') + '</' + tag + '>';
  }

  function gruposDe(pid) {
    var lista = [];
    est.membros.forEach(function (mapa, gid) {
      var m = mapa.get(pid);
      var g = est.grupos.get(gid);
      if (m && g) lista.push({ id: g.id, nome: g.nome, cor: g.cor, papel: m.papel, origem: m.origem });
    });
    return lista.sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
  }

  function membrosDe(gid) {
    var mapa = est.membros.get(gid);
    var lista = [];
    if (mapa) mapa.forEach(function (m, pid) { var p = est.participantes.get(pid); if (p) lista.push({ p: p, m: m }); });
    return lista.sort(function (a, b) { return a.p.dados.nome.localeCompare(b.p.dados.nome, 'pt-BR'); });
  }

  // Membros que podem receber destino (de campo, ativos).
  function membrosAtivosCampo(gid) {
    return membrosDe(gid).filter(function (x) { return !x.p.dados.removido && tipoDe(x.p.dados) !== 'responsavel'; });
  }

  // Filtro do ícone de olho: os membros dos grupos LIGADOS ficam no mapa e na lista
  // (vários grupos ao mesmo tempo). Nenhum grupo ligado = todos.
  function filtroAtivo() { return est.filtroGrupos.size > 0; }

  function visivelNoFiltro(p) {
    if (!filtroAtivo()) return true;
    var visivel = false;
    est.filtroGrupos.forEach(function (gid) {
      var m = est.membros.get(gid);
      if (m && m.has(p.id)) visivel = true;
    });
    return visivel;
  }

  // Aviso sobre alguém escondido pelo filtro (os alertas continuam sempre).
  function sufixoFiltro(pid) {
    if (!filtroAtivo()) return '';
    var p = est.participantes.get(pid);
    return p && !visivelNoFiltro(p) ? ' — fora dos grupos mostrados no mapa' : '';
  }

  // Liga ou desliga um grupo no mapa (o olho). Ao ligar, o mapa se ajusta aos grupos mostrados.
  function alternarGrupoFiltro(gid) {
    if (est.filtroGrupos.has(gid)) est.filtroGrupos.delete(gid);
    else est.filtroGrupos.add(gid);
    aplicarFiltroGrupos(est.filtroGrupos.has(gid));
  }

  // Alertas e mensagens de um grupo: liga esse grupo junto com os que já estão ligados.
  function ligarGrupoFiltro(gid, silencioso) {
    if (!est.grupos.has(gid)) return;
    est.filtroGrupos.add(gid);
    aplicarFiltroGrupos(!silencioso);
  }

  function mostrarTodosGrupos() {
    est.filtroGrupos.clear();
    aplicarFiltroGrupos(false);
  }

  // Não fica lembrado ao recarregar (para ninguém esquecer pessoas escondidas).
  function aplicarFiltroGrupos(enquadrar) {
    est.participantes.forEach(function (p) { atualizarMarcador(p); desenharTrilha(p); });
    if (est.selecionado) {
      var sel = est.participantes.get(est.selecionado);
      if (sel && !visivelNoFiltro(sel)) fecharFicha();
    }
    est.listaSuja = true;
    renderizarLista();
    desenharDestinosGrupo();
    renderizarControleGrupos();
    if (enquadrar && filtroAtivo()) enquadrarGrupos(Array.from(est.filtroGrupos));
  }

  // Enquadra os membros (com posição e destino) dos grupos indicados.
  function enquadrarGrupos(gids) {
    if (!est.mapa) return;
    var pts = [];
    gids.forEach(function (gid) {
      membrosDe(gid).forEach(function (x) {
        var pos = posicaoAtual(x.p);
        if (pos && !x.p.dados.removido) pts.push([pos.lat, pos.lng]);
        var d = est.destinos.get(x.p.id);
        if (d) pts.push([d.lat, d.lng]);
      });
    });
    if (!pts.length) { UI.aviso('Nenhum membro desses grupos com posição ainda.'); return; }
    if (pts.length === 1) est.mapa.setView(pts[0], Math.max(est.mapa.getZoom(), 16));
    else est.mapa.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 17 });
  }

  // Com o filtro ligado: o destino de cada membro dos grupos mostrados (🧭) e a linha até ele, na cor do grupo.
  function desenharDestinosGrupo() {
    var camada = est.camadaDestinosGrupo;
    if (!camada) return;
    camada.clearLayers();
    var vistos = {};
    est.filtroGrupos.forEach(function (gid) {
      var g = est.grupos.get(gid);
      if (!g) return;
      membrosDe(g.id).forEach(function (x) {
        var d = est.destinos.get(x.p.id);
        if (!d || x.p.dados.removido) return;
        var nome = nomeExibido(x.p);
        L.marker([d.lat, d.lng], {
          icon: L.divIcon({ className: 'mk-destino-wrap', html: '<div class="mk-destino">🧭</div>', iconSize: [0, 0] }),
          keyboard: false, zIndexOffset: 400, title: 'Destino de ' + nome + ': ' + d.nome,
        }).bindTooltip('Destino de ' + C.esc(nome) + ': ' + C.esc(d.nome)).addTo(camada);
        var pos = posicaoAtual(x.p);
        // trajeto desenhado: a linha a seguir (uma vez por trajeto); senão, a direção em linha reta
        if (window.Rotas.temTrajeto(d)) {
          var chave = JSON.stringify(d.trajeto[0]) + d.trajeto.length;
          if (!vistos[chave]) { vistos[chave] = 1; L.polyline(d.trajeto, { color: g.cor, weight: Math.max(1.5, 3 * fatorTelaTrilha()), opacity: 0.85, interactive: false, className: 'trajeto-grupo' }).addTo(camada); }
        } else if (pos) L.polyline([[pos.lat, pos.lng], [d.lat, d.lng]], { color: g.cor, weight: 2, dashArray: '4 8', opacity: 0.75, interactive: false }).addTo(camada);
      });
    });
  }

  // Controle "Grupos" no mapa: um ícone de olho por grupo.
  function renderizarControleGrupos() {
    var ctl = est.controleGrupos;
    var div = ctl && ctl.getContainer && ctl.getContainer();
    if (!div) return;
    var grupos = Array.from(est.grupos.values()).sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
    div.hidden = !grupos.length;
    var det = div.querySelector('details');
    var aberto = det ? det.open : !telaPequena();
    var focoGrupo = document.activeElement && div.contains(document.activeElement) ? document.activeElement.getAttribute('data-grupo') : null;
    div.innerHTML = '';
    if (!grupos.length) return;
    var ul = UI.el('ul', { classe: 'lista-grupos-mapa' }, grupos.map(function (g) {
      var ativo = est.filtroGrupos.has(g.id);
      var n = membrosDe(g.id).filter(function (x) { return !x.p.dados.removido; }).length;
      var rot = ativo ? 'Mostrar todos de novo' : 'Mostrar só o grupo ' + g.nome + ' no mapa';
      return UI.el('li', { classe: ativo ? 'ativo' : '' }, [
        chipGrupo(g),
        UI.el('span', { classe: 'grupo-mapa-nome', texto: g.nome }),
        UI.el('small', { classe: 'muted', title: n + ' pessoa(s) ativa(s)', texto: String(n) }),
        UI.el('button', { classe: 'btn btn-pequeno btn-olho' + (ativo ? ' btn-ativo' : ''), type: 'button', 'data-grupo': g.id,
          'aria-pressed': String(ativo), 'aria-label': rot, title: rot, texto: ativo ? '👁 ✓' : '👁',
          onclick: function () { alternarGrupoFiltro(g.id); } }),
      ]);
    }));
    // Com grupos ligados, o título avisa mesmo com o controle recolhido (sem faixa flutuante no mapa).
    var ligados = est.filtroGrupos.size;
    var titulo = 'Grupos (' + grupos.length + ')' + (ligados === 1 ? ' · filtrado' : ligados > 1 ? ' · ' + ligados + ' filtrados' : '');
    var conteudo = [UI.el('summary', { texto: titulo }), ul];
    if (ligados) conteudo.push(UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Mostrar todos', onclick: mostrarTodosGrupos }));
    div.appendChild(UI.el('details', { open: aberto ? true : null }, conteudo));
    if (focoGrupo) { var b = div.querySelector('[data-grupo="' + focoGrupo + '"]'); if (b) b.focus(); }
  }

  // Ficha do participante: grupos dele, papel e inclusão em outro grupo.
  // Grupos na ficha: só a lista (nome e papel) e um botão "Adicionar a um grupo", que abre a
  // janela de escolha. Trocar o papel ou tirar do grupo fica em Ferramentas → Grupos → Membros.
  function renderizarGruposFicha(p) {
    var bloco = $('ficha-grupos-bloco'), caixa = $('ficha-grupos');
    if (est.semGrupos || !est.grupos.size) { bloco.hidden = true; caixa._assinatura = ''; return; }
    var meus = gruposDe(p.id);
    var editavel = podeAlterar();
    var outros = Array.from(est.grupos.values()).filter(function (g) { return !meus.some(function (x) { return x.id === g.id; }); });
    var assinatura = p.id + '|' + JSON.stringify(meus) + '|' + outros.length + '|' + editavel + '|' + Boolean(p.dados.removido);
    bloco.hidden = false;
    if (caixa._assinatura === assinatura) return;
    caixa._assinatura = assinatura;
    caixa.innerHTML = '';
    if (!meus.length) caixa.appendChild(UI.el('p', { classe: 'muted ficha-sem-grupo', texto: 'Não está em nenhum grupo.' }));
    else caixa.appendChild(UI.el('ul', { classe: 'ficha-lista-grupos' }, meus.map(function (g) {
      return UI.el('li', null, [chipGrupo(g), UI.el('strong', { texto: g.nome }),
        UI.el('small', { classe: 'muted', texto: (g.papel === 'responsavel' ? '★ responsável' : 'membro') + (g.origem === 'link' ? ' · entrou pelo link' : '') })]);
    })));
    if (editavel && outros.length && !p.dados.removido) {
      caixa.appendChild(UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'ficha-add-grupo', texto: '＋ Adicionar a um grupo', onclick: function () { abrirAdicionarAoGrupo(p); } }));
    }
  }

  function abrirAdicionarAoGrupo(p) {
    var meus = gruposDe(p.id);
    var outros = Array.from(est.grupos.values()).filter(function (g) { return !meus.some(function (x) { return x.id === g.id; }); })
      .sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
    if (!outros.length) return;
    var lista = UI.el('div', { classe: 'opcoes-modo', role: 'radiogroup', 'aria-label': 'Grupo' }, outros.map(function (g, i) {
      var n = (est.membros.get(g.id) || new Map()).size;
      return UI.el('label', { classe: 'opcao-modo' }, [
        UI.el('input', { type: 'radio', name: 'add-grupo', value: g.id, checked: i === 0 ? true : null }),
        UI.el('span', null, [UI.el('strong', null, [chipGrupo(g), ' ' + g.nome]),
          UI.el('small', { texto: n + ' pessoa(s)' })]),
      ]);
    }));
    var papel = UI.el('div', { classe: 'opcoes-modo', role: 'radiogroup', 'aria-label': 'Papel no grupo' }, [
      UI.el('label', { classe: 'opcao-modo' }, [UI.el('input', { type: 'radio', name: 'add-papel', value: 'membro', checked: true }),
        UI.el('span', null, [UI.el('strong', { texto: 'Membro' }), UI.el('small', { texto: 'faz parte da equipe' })])]),
      UI.el('label', { classe: 'opcao-modo' }, [UI.el('input', { type: 'radio', name: 'add-papel', value: 'responsavel' }),
        UI.el('span', null, [UI.el('strong', { texto: '★ Responsável' }), UI.el('small', { texto: 'leva a equipe e finaliza a busca no celular' })])]),
    ]);
    var btn = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'add-grupo-salvar', texto: 'Adicionar' });
    var form = UI.el('form', { novalidate: true, classe: 'form-padrao' }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Adicionar a grupo' }, [UI.dica('Responsável leva a equipe e finaliza a busca no celular.')]),
      UI.el('p', { classe: 'ajuda', texto: nomeExibido(p) }),
      UI.campo('Grupo', lista, { largo: true }),
      UI.campo('Papel', papel, { largo: true }),
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var gid = (form.querySelector('input[name="add-grupo"]:checked') || {}).value;
      var pap = (form.querySelector('input[name="add-papel"]:checked') || {}).value || 'membro';
      if (!gid) return;
      btn.disabled = true;
      if (await definirMembro(gid, p.id, pap)) fechar(true);
      else btn.disabled = false;
    });
    var fechar = UI.abrirModal(form);
  }

  async function definirMembro(gid, pid, papel) {
    try {
      var m = await C.rpc('definir_membro', { p_grupo: gid, p_participante: pid, p_papel: papel });
      if (!est.membros.has(gid)) est.membros.set(gid, new Map());
      est.membros.get(gid).set(pid, m);
      aplicarMudancaGrupos();
      var g = est.grupos.get(gid), p = est.participantes.get(pid);
      UI.aviso((p ? p.dados.nome : 'Participante') + ' no grupo ' + (g ? g.nome : '') + (papel === 'responsavel' ? ' como responsável.' : ' como membro.'), 'ok');
      return true;
    } catch (e) {
      UI.aviso(e.message, 'erro');
      return false;
    }
  }

  async function removerMembro(gid, pid) {
    var p = est.participantes.get(pid);
    var ok = await UI.confirmar({ titulo: 'Tirar do grupo?', texto: (p ? p.dados.nome : 'Este participante') + ' sai deste grupo. Ele continua na operação e o histórico dele fica como está.', ok: 'Tirar do grupo', perigo: true });
    if (!ok) return;
    try {
      await C.rpc('remover_membro', { p_grupo: gid, p_participante: pid });
      var mapa = est.membros.get(gid);
      if (mapa) mapa.delete(pid);
      aplicarMudancaGrupos();
      UI.aviso('Retirado do grupo.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro');
    }
  }

  // Ferramentas → Grupos
  function abrirGrupos() {
    if (!est.op) return;
    var corpo = UI.el('div', { classe: 'corpo-grupos' });
    var editavel = podeAlterar();
    function render() {
      corpo.innerHTML = '';
      if (est.semGrupos) {
        corpo.appendChild(UI.el('p', { classe: 'nota', texto: 'Os grupos ainda não estão disponíveis no servidor: execute a migração 008 no Supabase.' }));
        return;
      }
      var grupos = Array.from(est.grupos.values()).sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
      if (!grupos.length) corpo.appendChild(UI.el('p', { classe: 'muted', texto: 'Nenhum grupo ainda.' }));
      corpo.appendChild(UI.el('ul', { classe: 'lista-grupos' }, grupos.map(function (g) {
        var mem = membrosDe(g.id).filter(function (x) { return !x.p.dados.removido; });
        var resp = mem.filter(function (x) { return x.m.papel === 'responsavel'; }).map(function (x) { return x.p.dados.nome; });
        var ativo = est.filtroGrupos.has(g.id);
        return UI.el('li', { classe: 'item-grupo', 'data-grupo': g.id }, [
          UI.el('div', { classe: 'item-grupo-topo' }, [
            chipGrupo(g),
            UI.el('strong', { texto: g.nome }),
            UI.el('small', { classe: 'muted', texto: mem.length + ' pessoa(s)' + (resp.length ? ' · ★ ' + resp.join(', ') : ' · sem responsável') +
              ' · link: ' + (g.permite_militar ? 'militares ou civis' : 'civis') }),
          ]),
          window.RecursosEquipe ? window.RecursosEquipe.resumo(g) : null,
          compactarAcoes(UI.el('div', { classe: 'acoes-linha' }, [
            UI.el('button', { classe: 'btn btn-pequeno' + (ativo ? ' btn-ativo' : ''), type: 'button', 'aria-pressed': String(ativo), texto: ativo ? '👁 Mostrando no mapa' : '👁 Mostrar no mapa',
              onclick: function () { alternarGrupoFiltro(g.id); render(); } }),
            UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Membros', onclick: function () { abrirMembrosGrupo(g.id); } }),
            est.op.status === 'ativa' ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Link do grupo', onclick: function () { abrirLinkGrupo(g.id); } }) : null,
            est.op.status === 'ativa' ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '🧭 Enviar destino', onclick: async function () {
              if (window.RecursosEquipe && !(await window.RecursosEquipe.confirmarEnvio(g))) return;
              fechar(); escolherDestino([], g.id);
            } }) : null,
            window.RecursosEquipe ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Recursos', onclick: function () { window.RecursosEquipe.abrir(g.id); } }) : null,
            editavel ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Editar', onclick: function () { abrirFormGrupo(g); } }) : null,
            editavel ? UI.el('button', { classe: 'btn btn-pequeno btn-perigo', type: 'button', texto: 'Excluir', onclick: function () { fechar(); excluirGrupo(g); } }) : null,
          ])),
        ]);
      })));
    }
    render();
    est.renderGruposAberto = render;
    var fechar = UI.abrirModal(UI.el('div', { classe: 'modal-grupos' }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Grupos' }, [UI.dica('Cada pessoa vê no celular só os grupos de que faz parte. Os links de grupo ficam só com os responsáveis da operação.')]),
      corpo,
      UI.rodape([
        editavel && !est.semGrupos ? UI.el('button', { classe: 'btn btn-escuro', type: 'button', id: 'grupo-novo', texto: '＋ Novo grupo', onclick: function () { abrirFormGrupo(null); } }) : null,
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]), { aoFechar: function () { if (est.renderGruposAberto === render) est.renderGruposAberto = null; } });
  }

  function abrirFormGrupo(g) {
    var novo = !g;
    var corPadrao = g ? g.cor : window.Cores.livre(GRUPO_CORES, Array.from(est.grupos.values()).map(function (x) { return x.cor; }));
    var nome = UI.el('input', { classe: 'campo', id: 'grupo-nome', maxlength: '60', value: g ? g.nome : '', placeholder: 'Ex.: Polícia Civil' });
    var icone = UI.seletorIcone({ id: 'grupo-icone', rotulo: 'Ícone do grupo', valor: g ? g.icone : null, cor: corPadrao, vazio: true });
    var cores = UI.seletorCor({ rotulo: 'Cor do grupo', valor: corPadrao, padroes: GRUPO_CORES, aoMudar: function (c) { icone.definirCor(c); } });
    var mil = UI.el('input', { type: 'checkbox', id: 'grupo-militar', checked: g && g.permite_militar ? true : null });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'grupo-salvar', texto: novo ? 'Criar grupo' : 'Salvar' });
    var form = UI.el('form', { novalidate: true, classe: 'form-padrao' }, [
      UI.el('h2', { id: 'modal-titulo', texto: novo ? 'Novo grupo' : 'Editar grupo' }),
      UI.grade([
        UI.campo('Nome do grupo', nome, { para: 'grupo-nome', largo: true }),
      ]),
      UI.campo('Cor', cores, { largo: true }),
      UI.campo('Ícone', icone, { largo: true, opcional: true, dica: 'Aparece junto da cor do grupo nas listas e no mapa (ex.: 🐕 canil, 🚤 embarcação, 🚁 aéreo).' }),
      UI.el('label', { classe: 'linha-opcao' }, [mil, ' Militar pelo link do grupo', UI.dica('Sem esta opção, quem entra pelo link do grupo aparece como civil (celular obrigatório; CPF opcional). O papel de responsável do grupo só é dado aqui no painel.')]),
      erro,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var dados = {
        nome: nome.value.replace(/\s+/g, ' ').trim(),
        cor: cores.valor() || corPadrao,
        permite_militar: Boolean(mil.checked),
      };
      if (icone.valor() || (g && g.icone)) dados.icone = icone.valor() || '';   // sem a migração 050 o campo não vai
      if (!dados.nome) { erro.textContent = 'Informe o nome do grupo.'; erro.hidden = false; return; }
      btn.disabled = true;
      try {
        var res = await C.rpc('salvar_grupo', { p_operacao: est.op.id, p_id: g ? g.id : null, p_dados: dados });
        est.grupos.set(res.id, res);
        aplicarMudancaGrupos();
        fechar(true);
        UI.aviso(novo ? 'Grupo "' + res.nome + '" criado. Agora adicione as pessoas.' : 'Grupo salvo.', 'ok');
        if (novo) abrirMembrosGrupo(res.id); else abrirGrupos();
      } catch (e) {
        erro.textContent = e.codigo === 'funcao_ausente' ? 'Execute a migração 008 no Supabase para usar grupos.' : 'Não foi possível salvar: ' + e.message;
        erro.hidden = false;
        btn.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false });
  }

  function abrirMembrosGrupo(gid) {
    var g = est.grupos.get(gid);
    if (!g) return;
    var editavel = podeAlterar();
    var corpo = UI.el('div');
    function render() {
      corpo.innerHTML = '';
      var mem = membrosDe(gid);
      var noGrupo = UI.secao('No grupo (' + mem.length + ')', []);
      var adicionar = UI.secao('Adicionar pessoas', []);
      corpo.appendChild(UI.el('div', { classe: 'form-colunas' }, editavel ? [noGrupo, adicionar] : [noGrupo]));
      if (!mem.length) noGrupo.appendChild(UI.el('p', { classe: 'muted', texto: 'Ninguém ainda. Marque ao lado ou envie o link do grupo.' }));
      noGrupo.appendChild(UI.el('ul', { classe: 'lista-membros' }, mem.map(function (x) {
        var papel = UI.el('select', { classe: 'campo campo-pequeno', 'aria-label': 'Papel de ' + x.p.dados.nome, disabled: editavel ? null : true }, [
          UI.el('option', { value: 'membro', selected: x.m.papel === 'membro' ? true : null, texto: 'Membro' }),
          UI.el('option', { value: 'responsavel', selected: x.m.papel === 'responsavel' ? true : null, texto: '★ Responsável' }),
        ]);
        papel.addEventListener('change', async function () { if (await definirMembro(gid, x.p.id, papel.value)) render(); });
        return UI.el('li', { classe: 'linha-grupo' }, [
          UI.el('strong', { texto: nomeExibido(x.p) }),
          UI.el('small', { classe: 'muted', texto: TIPOS[tipoDe(x.p.dados)].rotulo + (x.p.dados.removido ? ' · fora da operação' : '') + (x.m.origem === 'link' ? ' · entrou pelo link' : '') }),
          papel,
          editavel ? UI.el('button', { classe: 'btn btn-pequeno btn-link', type: 'button', texto: 'Tirar', onclick: async function () { await removerMembro(gid, x.p.id); render(); } }) : null,
        ]);
      })));
      if (!editavel) return;
      var naoMembros = Array.from(est.participantes.values())
        .filter(function (p) { return !p.dados.removido && !(est.membros.get(gid) && est.membros.get(gid).has(p.id)); })
        .sort(function (a, b) { return a.dados.nome.localeCompare(b.dados.nome, 'pt-BR'); });
      if (!naoMembros.length) { adicionar.appendChild(UI.el('p', { classe: 'muted', texto: 'Todos os participantes ativos já estão no grupo.' })); return; }
      var caixas = UI.el('div', { classe: 'lista-destino' }, naoMembros.map(function (p) {
        var outros = gruposDe(p.id).map(function (x) { return x.nome; });
        return UI.el('label', { classe: 'linha-opcao' }, [
          UI.el('input', { type: 'checkbox', value: p.id }),
          ' ' + nomeExibido(p) + ' (' + TIPOS[tipoDe(p.dados)].rotulo.toLowerCase() + ')',
          outros.length ? UI.el('small', { classe: 'muted', texto: ' — já em: ' + outros.join(', ') }) : null,
        ]);
      }));
      var pap = UI.el('select', { classe: 'campo campo-pequeno', 'aria-label': 'Papel de quem será adicionado' }, [
        UI.el('option', { value: 'membro', texto: 'como Membro' }), UI.el('option', { value: 'responsavel', texto: 'como ★ Responsável' })]);
      var btnAdd = UI.el('button', { classe: 'btn btn-escuro btn-pequeno', type: 'button', id: 'membros-adicionar', texto: 'Adicionar marcados', onclick: async function () {
        var ids = Array.from(caixas.querySelectorAll('input:checked')).map(function (c) { return c.value; });
        if (!ids.length) { UI.aviso('Marque pelo menos uma pessoa.', 'erro'); return; }
        btnAdd.disabled = true;
        for (var i = 0; i < ids.length; i++) await definirMembro(gid, ids[i], pap.value);
        render();
      } });
      adicionar.appendChild(caixas);
      adicionar.appendChild(UI.el('div', { classe: 'acoes-linha' }, [pap, btnAdd]));
    }
    render();
    est.renderGruposAberto = render;
    var fechar = UI.abrirModal(UI.el('div', { classe: 'modal-membros' }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, [chipGrupo(g), ' ' + g.nome,
        UI.dica('O responsável (★) pode receber o destino pelo grupo e avisar que a busca no setor terminou.')]),
      corpo,
      UI.rodape([
        UI.el('button', { classe: 'btn', type: 'button', texto: '◀ Grupos', onclick: function () { fechar(); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]), { tamanho: 'largo', aoFechar: function () { if (est.renderGruposAberto === render) est.renderGruposAberto = null; } });
  }

  // QR Code de um link (mesma biblioteca do convite da operação).
  function qrDoLink(caixa, texto, titulo) {
    if (!window.qrcode) { caixa.textContent = 'QR Code indisponível (biblioteca não carregada).'; return; }
    try {
      var q = window.qrcode(0, 'M');
      q.addData(texto);
      q.make();
      caixa.innerHTML = q.createSvgTag({ cellSize: 6, margin: 4, scalable: true, title: titulo });
    } catch (e) { caixa.textContent = 'Não foi possível gerar o QR Code.'; }
  }

  async function abrirLinkGrupo(gid) {
    var g = est.grupos.get(gid);
    if (!g || !est.op || est.op.status !== 'ativa') return;
    var info;
    try {
      info = await C.rpc('link_do_grupo', { p_grupo: gid });
    } catch (e) {
      UI.aviso(e.message, 'erro');
      return;
    }
    var entrada = UI.el('input', { classe: 'campo', readonly: true, 'aria-label': 'Link do grupo', value: linkPara(info.token) });
    var qr = UI.el('div', { classe: 'qr', 'aria-label': 'QR Code do link do grupo' });
    qrDoLink(qr, entrada.value, 'QR Code — link do grupo ' + g.nome);
    var botoes = [UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Copiar', onclick: function () { copiarTexto(entrada.value); } })];
    if (navigator.share) botoes.push(UI.el('button', { classe: 'btn', type: 'button', texto: 'Compartilhar', onclick: function () {
      navigator.share({ title: 'Grupo ' + g.nome + ' — operação ' + est.op.codigo,
        text: 'Grupo ' + g.nome + ' da operação "' + est.op.codigo + '" — abra o link para entrar no grupo e compartilhar sua localização com a equipe:', url: entrada.value })
        .catch(function () { /* cancelado */ });
    } }));
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, [chipGrupo(g), ' ' + g.nome,
        UI.dica('Quem abrir este link entra na operação e no grupo, como membro' + (info.permite_militar ? ' (pode se identificar como militar).' : ', sempre como civil.') + ' O link não dá acesso ao painel.')]),
      UI.el('div', { classe: 'link-caixa' }, [entrada].concat(botoes)),
      qr,
      UI.rodape([
        UI.el('button', { classe: 'btn btn-perigo', type: 'button', texto: 'Gerar novo link', onclick: async function () {
          fechar();
          var r = await UI.confirmar({ titulo: 'Gerar um novo link para o grupo ' + g.nome + '?', texto: 'O link atual (e o QR Code) deixa de funcionar na hora. Quem já entrou continua no grupo.', ok: 'Gerar novo link', perigo: true });
          if (!r) { abrirLinkGrupo(gid); return; }
          try {
            await C.rpc('gerar_novo_link_grupo', { p_grupo: gid });
            UI.aviso('Novo link gerado. O anterior não funciona mais.', 'ok');
          } catch (e) { UI.aviso(e.message, 'erro'); }
          abrirLinkGrupo(gid);
        } }),
        UI.el('button', { classe: 'btn', type: 'button', texto: '◀ Grupos', onclick: function () { fechar(); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]));
  }

  async function excluirGrupo(g) {
    var r = await UI.confirmar({
      titulo: 'Excluir o grupo "' + g.nome + '"?',
      texto: 'As pessoas continuam na operação; só deixam de estar no grupo. O link do grupo deixa de funcionar. Deslocamentos já feitos continuam no histórico.',
      ok: 'Excluir grupo',
      perigo: true,
    });
    if (!r) { abrirGrupos(); return; }
    try {
      await C.rpc('excluir_grupo', { p_id: g.id });
      est.grupos.delete(g.id);
      est.membros.delete(g.id);
      est.filtroGrupos.delete(g.id);
      aplicarMudancaGrupos();
      UI.aviso('Grupo excluído.', 'ok');
    } catch (e) {
      UI.aviso(e.codigo === 'sem_permissao' ? 'Só quem criou o grupo, quem criou a operação ou um administrador pode excluí-lo.' : e.message, 'erro', 7000);
    }
    abrirGrupos();
  }

  /* ------------------------------------------------------------------ */
  /* Deslocamentos de grupos (missões) e alertas                          */
  /* ------------------------------------------------------------------ */
  var STATUS_MISSAO = {
    enviada: { rotulo: 'Enviada', selo: 'selo-neutro' },
    em_deslocamento: { rotulo: 'Em deslocamento', selo: 'selo-alerta' },
    no_setor: { rotulo: 'No setor', selo: 'selo-responsavel' },
    busca_finalizada: { rotulo: 'Busca finalizada · voltando à base', selo: 'selo-alerta' },
    retorno_atrasado: { rotulo: 'RETORNO ATRASADO', selo: 'selo-perigo' },
    na_base: { rotulo: 'Na base', selo: 'selo-ok' },
    encerrada: { rotulo: 'Encerrada', selo: 'selo-neutro' },
  };

  function missoesAtivas() {
    return Array.from(est.missoes.values()).filter(function (m) { return m.status !== 'encerrada' && m.status !== 'na_base'; });
  }

  async function carregarMissoes(silencioso) {
    if (!est.op || est.semMissoes) return;
    var opId = est.op.id;
    try {
      var r = await Promise.all([
        C.consultar(C.cliente.from('missoes').select('*').eq('operacao_id', opId).order('enviada_em', { ascending: false }).limit(100)),
        C.consultar(C.cliente.from('missao_membros').select('*').eq('operacao_id', opId)),
        C.consultar(C.cliente.from('alertas').select('*').eq('operacao_id', opId).order('id', { ascending: false }).limit(500)),
      ]);
      if (!est.op || est.op.id !== opId) return;
      est.missoes = new Map((r[0] || []).map(function (m) { return [m.id, m]; }));
      var mm = new Map();
      (r[1] || []).forEach(function (x) {
        if (!mm.has(x.missao_id)) mm.set(x.missao_id, []);
        mm.get(x.missao_id).push(x);
      });
      est.missaoMembros = mm;
      var primeira = !est.alertasCarregados;
      (r[2] || []).forEach(function (a) { receberAlerta(a, silencioso || primeira, true); });
      est.alertasCarregados = true;
      atualizarMenu();
      if (est.renderMissoesAberto) est.renderMissoesAberto();
    } catch (e) {
      if (ehTabelaAusente(e)) est.semMissoes = true;
    }
  }

  function agendarMissoes() {
    clearTimeout(est.timerMissoes);
    est.timerMissoes = setTimeout(function () { carregarMissoes(false); }, 500);
  }

  // Reserva para o alerta de retorno atrasado: sem pg_cron no Supabase, o painel
  // aberto pede ao servidor que verifique os prazos (a regra e o anti-duplicação são do banco).
  function verificarRetornosPainel() {
    if (!est.op || est.op.status !== 'ativa' || est.semMissoes) return;
    // retorno após a busca, horários combinados e falta de comunicação (migração 032): só com deslocamento ativo
    if (!missoesAtivas().length) return;
    // com pg_cron o servidor já verifica a cada minuto: o painel ajuda a cada 60 s (30 s no retorno)
    var retorno = missoesAtivas().some(function (m) { return m.status === 'busca_finalizada' || m.status === 'retorno_atrasado'; });
    est.cicloRetornos = (est.cicloRetornos || 0) + 1;
    if (!retorno && est.cicloRetornos % 2) return;
    C.rpc('verificar_retornos', { p_operacao: est.op.id }, 15000).then(function (n) { if (n) agendarMissoes(); }).catch(function () { /* tenta no próximo ciclo */ });
  }

  /* ---------- Responsável registra "vítima encontrada" (migração 025) ---------- */
  // Para quando a notícia chega por rádio, telefone ou pessoalmente. Mesmo registro do campo:
  // alerta crítico aos responsáveis, diário, dashboard e relatório. A condição só os responsáveis veem.
  // pre: { condicao, encontrou (id do participante), onde: 'mapa'|'gps'|'quem'|'nenhum', lat, lng }
  function abrirRegistroVitima(pre) {
    if (!est.op || est.op.status !== 'ativa') { UI.aviso('A operação não está ativa.', 'erro'); return; }
    pre = pre || {};
    var temPonto = pre.lat != null && pre.lng != null;
    var pessoas = Array.from(est.participantes.values())
      .filter(function (p) { return !p.dados.removido && tipoDe(p.dados) !== 'responsavel'; })
      .sort(function (a, b) { return nomeExibido(a).localeCompare(nomeExibido(b), 'pt-BR'); });

    var cond = UI.el('div', { classe: 'vit-condicoes', role: 'radiogroup', 'aria-label': 'Condição da vítima' }, [['viva', 'Com vida'], ['obito', 'Óbito']].map(function (c) {
      return UI.el('label', { classe: 'vit-condicao vit-' + c[0] }, [
        UI.el('input', { type: 'radio', name: 'vit-condicao', value: c[0], checked: pre.condicao === c[0] ? true : null }),
        UI.el('span', { texto: c[1] }),
      ]);
    }));
    var quem = UI.el('select', { classe: 'campo', id: 'vit-quem' }, [UI.el('option', { value: '', texto: '— não informar —' })].concat(pessoas.map(function (p) {
      return UI.el('option', { value: p.id, selected: pre.encontrou === p.id ? true : null, texto: nomeExibido(p) + ' (' + TIPOS[tipoDe(p.dados)].rotulo.toLowerCase() + ')' });
    })).concat([UI.el('option', { value: '__outra', selected: pre.encontrou === '__outra' ? true : null, texto: 'Outra pessoa (fora do sistema)…' })]));
    var quemTexto = UI.el('input', { classe: 'campo', id: 'vit-quem-texto', maxlength: '120', value: pre.encontradaPor || '', placeholder: 'Ex.: morador da chácara, PM, SAMU', hidden: pre.encontrou !== '__outra' });
    quem.addEventListener('change', function () { quemTexto.hidden = quem.value !== '__outra'; if (!quemTexto.hidden) quemTexto.focus(); });
    // Ficha da vítima: escolher uma já cadastrada ou criar agora só com o nome
    var ficha = UI.el('select', { classe: 'campo', id: 'vit-ficha' }, [UI.el('option', { value: '', texto: '— não informar —' }),
      UI.el('option', { value: '__nova', selected: pre.vitimaId === '__nova' ? true : null, texto: '＋ Nova vítima (informar o nome)' })]);
    var fichaNome = UI.el('input', { classe: 'campo', id: 'vit-nome', maxlength: '80', value: pre.vitimaNome || '', placeholder: 'Nome ou "Não identificada"', hidden: pre.vitimaId !== '__nova' });
    ficha.addEventListener('change', function () { fichaNome.hidden = ficha.value !== '__nova'; if (!fichaNome.hidden) fichaNome.focus(); });
    C.consultar(C.cliente.from('vitimas').select('id,nome,idade').eq('operacao_id', est.op.id).order('criado_em', { ascending: true })).then(function (lista) {
      (lista || []).forEach(function (v, i) {
        ficha.insertBefore(UI.el('option', { value: v.id, texto: v.nome + (v.idade != null ? ' (' + v.idade + ' anos)' : '') }), ficha.lastChild);
        if (pre.vitimaId === v.id || (!pre.vitimaId && lista.length === 1 && i === 0)) ficha.value = v.id;   // uma só vítima: já vem escolhida
      });
    }).catch(function () { /* sem fichas: segue com nome ou sem informar */ });
    var localDesc = UI.el('input', { classe: 'campo', id: 'vit-local', maxlength: '500', value: pre.localDescricao || '', placeholder: 'Ex.: margem esquerda do córrego, sob a ponte' });
    var obs = UI.el('textarea', { classe: 'campo', id: 'vit-obs', maxlength: '1000', rows: '2', placeholder: 'Ex.: consciente, hipotermia leve; levada pelo SAMU ao HU' });
    obs.value = pre.observacoes || '';

    function opcaoOnde(valor, texto, extra) {
      return UI.el('label', { classe: 'vit-onde', 'data-onde': valor }, [
        UI.el('input', { type: 'radio', name: 'vit-onde', value: valor }),
        UI.el('span', null, [UI.el('span', { texto: texto }), UI.el('small', { classe: 'muted', texto: extra || '' })]),
      ]);
    }
    var btnMapa = UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'vit-escolher-mapa', texto: temPonto ? 'Trocar' : 'Escolher' });
    var optMapa = opcaoOnde('mapa', 'Ponto no mapa', temPonto ? window.Coords.formatar(pre.lat, pre.lng, est.prefsMapa.coord || 'dec') : 'ainda não escolhido');
    optMapa.appendChild(btnMapa);
    var optQuem = opcaoOnde('quem', 'Posição de quem encontrou', '');
    var onde = UI.el('div', { classe: 'vit-ondes', role: 'radiogroup', 'aria-label': 'Local' }, [
      optMapa,
      opcaoOnde('gps', 'Minha localização', 'GPS deste aparelho'),
      optQuem,
      opcaoOnde('nenhum', 'Sem localização', 'marcar depois'),
    ]);
    function marcarOnde(v) { var r = onde.querySelector('input[value="' + v + '"]'); if (r && !r.disabled) r.checked = true; }
    function posDeQuem() {
      var p = est.participantes.get(participanteQuem());
      return p ? posicaoAtual(p) : null;
    }
    function atualizarQuem() {
      var pos = posDeQuem();
      var r = optQuem.querySelector('input');
      r.disabled = !pos;
      optQuem.classList.toggle('desativada', !pos);
      optQuem.querySelector('small').textContent = !participanteQuem() ? 'escolha quem encontrou' : pos ? 'última posição ' + C.idade(pos.t) + ' · ± ' + Math.round(pos.prec || 0) + ' m' : 'essa pessoa ainda não tem posição';
      if (r.disabled && r.checked) marcarOnde(temPonto ? 'mapa' : 'gps');
    }
    function participanteQuem() { return quem.value && quem.value !== '__outra' ? quem.value : null; }
    quem.addEventListener('change', function () { atualizarQuem(); if (posDeQuem() && !temPonto) marcarOnde('quem'); });
    atualizarQuem();
    if (!temPonto) optMapa.querySelector('input').disabled = true;
    marcarOnde(pre.onde && (pre.onde !== 'mapa' || temPonto) ? pre.onde : temPonto ? 'mapa' : posDeQuem() ? 'quem' : 'gps');

    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var noEncerramento = typeof pre.aoRegistrar === 'function';
    var btn = UI.el('button', { classe: 'btn btn-primario', type: 'submit', id: 'vit-registrar', texto: noEncerramento ? 'Registrar e continuar' : 'Registrar' });
    quemTexto.placeholder = 'Quem? Ex.: morador, PM, SAMU';
    localDesc.placeholder = 'Descrição do local (opcional)';
    obs.placeholder = 'Ex.: consciente, hipotermia leve; levada pelo SAMU ao HU';
    var form = UI.el('form', { classe: 'form-vitima form-padrao', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: noEncerramento ? 'Vítima encontrada (antes de encerrar)' : 'Vítima encontrada' },
        [UI.dica(noEncerramento
          ? 'Entra no diário, no relatório e no resultado da operação. A condição só os responsáveis veem.'
          : 'Dispara o alerta de vítima localizada para os responsáveis e entra no diário. A condição só os responsáveis veem.')]),
      UI.el('div', { classe: 'form-colunas' }, [
        UI.el('div', null, [
          UI.secao('Vítima', [ficha, fichaNome, cond]),
          UI.secao('Quem encontrou', [quem, quemTexto], { dica: 'Opcional. Escolhendo um participante, dá para usar a posição dele como local.' }),
        ]),
        UI.secao('Onde', [onde, localDesc]),
      ]),
      UI.secao('Estado e encaminhamento', [obs]),
      erro,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: noEncerramento ? 'Voltar' : 'Cancelar', onclick: function () { fechar(); if (pre.aoVoltar) pre.aoVoltar(); if (pre.depois) pre.depois(); } }), btn]),
    ]);
    var fechar = UI.abrirModal(form, { fecharNoFundo: false, tamanho: 'largo' });

    // Tudo o que foi preenchido (para voltar ao formulário depois de escolher o ponto no mapa).
    function estadoAtual() {
      var c = form.querySelector('input[name="vit-condicao"]:checked');
      return { condicao: c ? c.value : null, encontrou: quem.value || null, encontradaPor: quemTexto.value, vitimaId: ficha.value || null,
        vitimaNome: fichaNome.value, localDescricao: localDesc.value, observacoes: obs.value, aoRegistrar: pre.aoRegistrar, aoVoltar: pre.aoVoltar, depois: pre.depois };
    }
    btnMapa.addEventListener('click', function () {
      var e = estadoAtual();
      fechar();
      iniciarDesenho('vitima', { estado: e });
    });

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var e = estadoAtual();
      var modo = (form.querySelector('input[name="vit-onde"]:checked') || {}).value;
      if (!e.condicao) { erro.textContent = 'Escolha a condição: com vida ou óbito.'; erro.hidden = false; return; }
      if (e.vitimaId === '__nova' && !e.vitimaNome.trim()) { erro.textContent = 'Informe o nome da nova vítima (ou "Não identificada").'; erro.hidden = false; fichaNome.focus(); return; }
      var args = { p_operacao: est.op.id, p_condicao: e.condicao, p_encontrou: participanteQuem() };
      btn.disabled = true;
      try {
        if (modo === 'mapa' && temPonto) {
          args.p_lat = pre.lat; args.p_lng = pre.lng;
        } else if (modo === 'gps') {
          var g = await obterMinhaPosicao();
          if (!g.ok) throw new Error('Sem a sua localização agora (' + g.motivo + '). Escolha no mapa ou a posição de quem encontrou.');
          args.p_lat = g.lat; args.p_lng = g.lng; args.p_precisao = g.prec; args.p_posicao_em = new Date(g.t || Date.now()).toISOString();
        } else if (modo === 'quem') {
          var pq = posDeQuem();
          if (!pq) throw new Error('Quem encontrou ainda não tem posição. Escolha outra opção.');
          args.p_lat = pq.lat; args.p_lng = pq.lng; args.p_precisao = pq.prec; args.p_posicao_em = new Date(pq.t).toISOString();
        }
        var dados = { condicao: e.condicao, encontrou: participanteQuem(), encontrada_por: quem.value === '__outra' ? e.encontradaPor.trim() : '',
          vitima_id: e.vitimaId && e.vitimaId !== '__nova' ? e.vitimaId : null, vitima_nome: e.vitimaId === '__nova' ? e.vitimaNome.trim() : '',
          local_descricao: e.localDescricao.trim(), observacoes: e.observacoes.trim(),
          lat: args.p_lat, lng: args.p_lng, precisao: args.p_precisao, posicao_em: args.p_posicao_em };
        var r, semDetalhes = false;
        try {
          r = await C.rpc('registrar_vitima_encontrada', { p_operacao: est.op.id, p_dados: dados });
        } catch (e3) {
          if (e3.codigo !== 'funcao_ausente') throw e3;
          // banco sem a migração 031: registra o essencial (condição, local, quem encontrou)
          r = await C.rpc('responsavel_registrar_vitima', args);
          semDetalhes = Boolean(dados.vitima_id || dados.vitima_nome || dados.encontrada_por || dados.local_descricao || dados.observacoes);
        }
        if (r && r.mensagem) receberMensagem(r.mensagem, true);
        if (r && r.registro) receberVitimasLoc([r.registro]);
        fechar();
        if (semDetalhes) UI.aviso('Registrado sem a ficha, o local descrito, quem encontrou (fora do sistema) e o estado: o banco ainda não tem a migração 031.', 'erro', 10000);
        if (noEncerramento) { pre.aoRegistrar(r, e.condicao, dados); return; }
        UI.aviso('Vítima encontrada registrada. Os responsáveis receberam o alerta.', 'ok', 7000);
        sincronizar();
        if (pre.depois) { pre.depois(); return; }   // veio do SCI: volta para ele (a vítima já está no quadro)
        if (args.p_lat != null && est.mapa) est.mapa.setView([args.p_lat, args.p_lng], Math.max(est.mapa.getZoom(), 16));
      } catch (e2) {
        btn.disabled = false;
        erro.textContent = e2.codigo === 'funcao_ausente' || /responsavel_registrar_vitima/.test(e2.message || '')
          ? 'O servidor ainda não foi atualizado (falta a migração 025 no Supabase). Avise o responsável técnico.' : (e2.message || 'Não foi possível registrar.');
        erro.hidden = false;
      }
    });
  }

  /* ---------- "Encontrei a vítima" (condição só para os responsáveis) ---------- */
  async function carregarVitimasLoc() {
    if (!est.op || est.semVitimaLoc) return;
    var opId = est.op.id;
    try {
      var r = await C.consultar(C.cliente.from('vitima_localizacoes').select('*').eq('operacao_id', opId).order('registrado_em').limit(500));
      if (!est.op || est.op.id !== opId) return;
      receberVitimasLoc(r || []);
      carregarFichas();
    } catch (e) {
      if (ehTabelaAusente(e)) est.semVitimaLoc = true;
    }
  }

  // Fichas das vítimas (só os responsáveis leem): dão o nome ao marcador da vítima localizada.
  async function carregarFichas() {
    if (!est.op) return;
    var opId = est.op.id;
    try {
      var r = await C.consultar(C.cliente.from('vitimas').select('id,nome,idade,idade_qualidade,sexo,cadastro_rapido').eq('operacao_id', opId).limit(200));
      if (!est.op || est.op.id !== opId) return;
      est.fichas = new Map((r || []).map(function (v) { return [v.id, v]; }));
    } catch (e) { /* sem fichas (migração antiga): o marcador mostra "Vítima localizada" */ }
  }

  function textoFicha(f) {
    if (!f) return '';
    var idade = f.idade != null ? (f.idade_qualidade === 'estimada' ? '~' : '') + f.idade + ' anos' : '';
    return f.nome + (idade ? ' · ' + idade : '');
  }
  // Registro da vítima localizada de uma mensagem VITIMA (ou null)
  function registroDaMensagem(m) { return m ? est.vitimasLoc.get(m.id) || null : null; }
  function nomeDaVitima(reg) {
    var f = reg && reg.vitima_id ? est.fichas.get(reg.vitima_id) : null;
    return f ? f.nome : 'Vítima localizada';
  }
  function setorDoPonto(lat, lng) {
    var achado = null;
    est.setores.forEach(function (x) {
      var d = x.d;
      if (achado) return;
      if (d.forma === 'circulo') { if (C.distancia(d.centro_lat, d.centro_lng, lat, lng) <= d.raio_m) achado = d; return; }
      var pts = d.pontos || [], dentro = false;
      for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        if (((pts[i][0] > lat) !== (pts[j][0] > lat)) && (lng < (pts[j][1] - pts[i][1]) * (lat - pts[i][0]) / (pts[j][0] - pts[i][0]) + pts[i][1])) dentro = !dentro;
      }
      if (dentro) achado = d;
    });
    return achado;
  }
  // Participante que encontrou: o do alerta "vitima:<id>" (quando o registro tem um participante de campo)
  function quemEncontrou(reg) {
    var achado = null;
    est.alertas.forEach(function (a) { if (a.tipo === 'vitima_localizada' && a.chave === 'vitima:' + reg.id) achado = a; });
    var p = achado && achado.participante_id ? est.participantes.get(achado.participante_id) : null;
    return p && p.id !== reg.participante_id ? p : null;
  }

  // Painel de comando SCI (js/sci.js) numa janela grande; "Outra janela" abre sci.html para o comando remoto
  function abrirSci() {
    if (!est.op || !window.SCI) return;
    var caixa = UI.el('div', { classe: 'sci-no-painel' });
    var ctl = null;
    var fechar = UI.abrirModal(UI.el('div', null, [UI.el('h2', { id: 'modal-titulo', texto: 'Comando SCI' }), caixa]), { tamanho: 'cheio', aoFechar: function () { if (ctl) ctl.parar(); } });
    ctl = window.SCI.montar(caixa, {
      op: est.op, podeAlterar: podeAlterar,
      setores: function () { return Array.from(est.setores.values()).map(function (x) { return x.d; }); },
      irPara: function (lat, lng) { fechar(); if (est.mapa) est.mapa.setView([lat, lng], Math.max(est.mapa.getZoom(), 16)); },
      // o mesmo "Vítima encontrada" do app (ponto no mapa, quem encontrou, alerta, diário); ao terminar, volta ao SCI
      registrarVitima: function (pre) { fechar(); abrirRegistroVitima(Object.assign({}, pre, { depois: abrirSci })); },
      abrirFicha: function (id) { if (window.Cadastro) window.Cadastro.abrirFichaPorId(est.op, id, { editavel: podeAlterar(), limparArquivos: limparArquivosPendentes, aoMudar: carregarFichas }); },
      cadastroRapido: function () { if (window.Cadastro) window.Cadastro.abrirRapido(est.op, { empilhar: true, aoSalvar: function () { carregarFichas(); } }); },
      abrirBriefing: window.Briefing ? function () { fechar(); window.Briefing.abrir(); } : null,
      abrirGrupos: function (gid) { fechar(); if (gid) abrirMembrosGrupo(gid); else abrirGrupos(); },
      abrirRecursos: window.RecursosEquipe ? function () { fechar(); window.RecursosEquipe.abrir(); } : null,
    });
  }

  function abrirCadastroRapido() {
    if (!est.op || est.op.status !== 'ativa' || !window.Cadastro) return;
    window.Cadastro.abrirRapido(est.op, { aoSalvar: function () { carregarFichas(); } });
  }

  function receberVitimasLoc(lista) {
    var mudou = false;
    lista.forEach(function (r) {
      if (!est.op || r.operacao_id !== est.op.id) return;
      if (!est.vitimasLoc.has(r.mensagem_id)) mudou = true;
      est.vitimasLoc.set(r.mensagem_id, r);
    });
    if (!mudou) return;
    mostrarFaixaAlerta();
    if (!$('central').hidden) {
      if (est.centralAba === 'alertas') renderizarAlertas();
      else if (est.centralAba === 'msgs') renderizarFeed();
    }
    if (est.selecionado && !$('ficha').hidden) atualizarFicha();
  }

  // O alerta guarda só o texto neutro; a chave "vitima:<id>" liga ao registro com a condição.
  function registroDoAlerta(a) {
    if (!a || a.tipo !== 'vitima_localizada' || !a.chave) return null;
    var id = a.chave.slice('vitima:'.length);
    var achado = null;
    est.vitimasLoc.forEach(function (r) { if (r.id === id) achado = r; });
    return achado;
  }

  function textoRegistroVitima(r) {
    return 'Condição: ' + CONDICAO_VITIMA[r.condicao] + (r.local_descricao ? ' · local: ' + r.local_descricao : '') +
      (r.observacoes ? ' · ' + r.observacoes : '') + ' · registrado por ' + r.registrado_por_nome +
      ' (' + r.registrado_por_tipo + ') em ' + C.hora(r.registrado_em) +
      (r.lat != null ? ' · ' + C.coord(r.lat) + ', ' + C.coord(r.lng) + ' (' + C.precisao(r.precisao) + ')' : ' · sem localização do GPS');
  }

  function seloCondicaoReg(r) {
    return UI.el('span', { classe: 'selo selo-condicao condicao-' + r.condicao, texto: 'Condição: ' + CONDICAO_VITIMA[r.condicao] });
  }

  function seloCondicao(m) {
    var r = est.vitimasLoc.get(m.id);
    if (r) return seloCondicaoReg(r);
    return UI.el('span', { classe: 'selo selo-condicao', texto: est.semVitimaLoc ? 'Condição indisponível (migração 011)' : 'Carregando condição…' });
  }

  /* ---------- Tempo de permanência em setor -------------------------- */
  async function carregarPermanencias() {
    if (!est.op || est.semPermanencia) return;
    var opId = est.op.id;
    try {
      var r = await C.consultar(C.cliente.from('setor_permanencias').select('*').eq('operacao_id', opId).is('saiu_em', null).limit(1000));
      if (!est.op || est.op.id !== opId) return;
      est.permanencias = new Map();
      receberPermanencias(r || []);
    } catch (e) {
      if (ehTabelaAusente(e)) est.semPermanencia = true;
    }
  }

  function receberPermanencias(lista) {
    lista.forEach(function (r) {
      if (!est.op || r.operacao_id !== est.op.id) return;
      if (r.saiu_em) est.permanencias.delete(r.id);
      else est.permanencias.set(r.id, r);
    });
    if (est.selecionado && !$('ficha').hidden) atualizarFicha();
    if (!$('painel-areas').hidden) renderizarAreas();
  }

  function limitePermanencia() { return est.op && est.op.permanencia_limite_min ? est.op.permanencia_limite_min : 0; }
  function minutosNoSetor(r) { return Math.max(0, Math.floor((C.agora() - C.paraMs(r.entrou_em)) / 60000)); }
  function textoMin(m) { return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60 < 10 ? '0' : '') + (m % 60) + ' min' : ''); }

  // "No setor A1 há 47 min" (pela trilha GPS)
  function textoPermanenciaParticipante(pid) {
    var lim = limitePermanencia(), partes = [], acima = false;
    est.permanencias.forEach(function (r) {
      if (r.participante_id !== pid) return;
      var s = est.setores.get(r.setor_id);
      var m = minutosNoSetor(r);
      if (lim && m >= lim) acima = true;
      partes.push((s ? s.d.nome : 'setor') + ' há ' + textoMin(m));
    });
    if (!partes.length) return null;
    return { texto: 'No setor ' + partes.join(' · ') + (acima ? ' — acima do limite de ' + textoMin(lim) : ''), acima: acima };
  }

  function resumoPermanenciaSetor(setorId) {
    var lim = limitePermanencia(), n = 0, maior = 0;
    est.permanencias.forEach(function (r) {
      if (r.setor_id !== setorId) return;
      var p = est.participantes.get(r.participante_id);
      if (p && (p.dados.removido || p.dados.liberado_em)) return;
      n++;
      maior = Math.max(maior, minutosNoSetor(r));
    });
    if (!n) return null;
    return { texto: n + ' pessoa(s) no setor agora · há até ' + textoMin(maior), acima: Boolean(lim && maior >= lim) };
  }

  // a: linha de "alertas". silencioso: sem som (carga inicial / atualização). deCarga: veio da consulta periódica.
  function receberAlerta(a, silencioso, deCarga) {
    var antigo = est.alertas.get(a.id);
    est.alertas.set(a.id, a);
    if (!antigo && !silencioso && !a.reconhecido_em) {
      if (a.nivel === 'critico') {
        alarme();
        try { if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 800]); } catch (e) { /* ignora */ }
      } else if (a.tipo === 'comunicacao_restabelecida') {
        bipeCurto();
        avisoClicavel('📶 ' + a.titulo + '. ' + a.texto, function () { verAlertaNoMapa(a); });
      } else if (a.tipo === 'permanencia_setor') {
        bipeCurto();
        avisoClicavel('⏱ ' + a.titulo + '. Avalie a troca da equipe. Toque para ver no mapa.', function () { verAlertaNoMapa(a); });
      } else {
        bipeCurto();
        UI.aviso('🔔 ' + a.titulo + ': ' + a.texto, 'ok', 10000);
      }
    }
    mostrarFaixaAlerta();
    atualizarContadorAlertas();
    if (!$('central').hidden && est.centralAba === 'alertas') renderizarAlertas();
    if (!deCarga && !antigo && a.missao_id) agendarMissoes();
  }

  // Faixa vermelha fixa: o alerta crítico mais antigo ainda sem "Ciente", com alarme repetido.
  function mostrarFaixaAlerta() {
    var criticos = Array.from(est.alertas.values()).filter(function (a) { return a.nivel === 'critico' && !a.reconhecido_em; })
      .sort(function (a, b) { return a.id - b.id; });
    var a = est.op && est.op.status === 'ativa' ? criticos[0] || null : null;   // encerrada: sem faixa nem alarme
    est.alertaFaixa = a;
    var faixa = $('faixa-alerta');
    if (!a) {
      faixa.hidden = true;
      clearInterval(est.timerAlarmeCritico);
      est.timerAlarmeCritico = null;
      return;
    }
    var reg = registroDoAlerta(a);
    faixa.classList.toggle('faixa-vitima', a.tipo === 'vitima_localizada');
    faixa.classList.toggle('faixa-vitima-obito', Boolean(reg && reg.condicao === 'obito'));
    $('faixa-alerta-titulo').textContent = '⚠ ' + a.titulo + (reg ? ' — ' + CONDICAO_VITIMA[reg.condicao] : '');
    $('faixa-alerta-texto').textContent = reg ? textoRegistroVitima(reg) : a.texto;
    $('faixa-alerta-meta').textContent = 'Alerta às ' + C.hora(a.criado_em, false) + (a.posicao_em ? ' · última posição às ' + C.hora(a.posicao_em, false) : '') +
      (criticos.length > 1 ? ' · mais ' + (criticos.length - 1) + ' alerta(s) crítico(s)' : '');
    $('faixa-alerta-mapa').hidden = a.lat == null && !a.grupo_id;
    // Faixa numa linha; tocar no texto mostra tudo (outro alerta volta a ficar compacto)
    if (est.faixaAlertaId !== a.id) { faixa.classList.remove('aberta'); est.faixaAlertaId = a.id; }
    faixa.hidden = false;
    if (!est.timerAlarmeCritico) est.timerAlarmeCritico = setInterval(function () { if (est.alertaFaixa) alarme(); }, 20000);
  }

  async function reconhecerAlerta(id) {
    try {
      var a = await C.rpc('reconhecer_alerta', { p_alerta: id });
      receberAlerta(a, true, true);
      UI.aviso('Alerta marcado como ciente.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro');
    }
  }

  function verAlertaNoMapa(a) {
    if (!est.mapa) return;
    if (a.grupo_id && est.grupos.has(a.grupo_id)) ligarGrupoFiltro(a.grupo_id, true);
    if (a.lat != null) {
      est.mapa.setView([a.lat, a.lng], Math.max(est.mapa.getZoom(), 16));
      var marca = L.circleMarker([a.lat, a.lng], { radius: 18, color: a.nivel === 'critico' ? '#ef4444' : '#facc15', weight: 3, fill: false, className: 'pulso-alerta', interactive: false }).addTo(est.mapa);
      setTimeout(function () { marca.remove(); }, 8000);
    } else if (a.grupo_id) {
      enquadrarGrupos([a.grupo_id]);
    }
    if (telaPequena()) fecharCentral();
  }

  function atualizarContadorAlertas() {
    var n = 0;
    est.alertas.forEach(function (a) { if (!a.reconhecido_em) n++; });
    var c = $('qtd-alertas');
    if (!c) return;
    c.textContent = String(n);
    c.hidden = !n;
  }

  function renderizarAlertas() {
    var ul = $('lista-alertas');
    var lista = Array.from(est.alertas.values()).sort(function (a, b) { return b.id - a.id; });
    $('alertas-vazio').hidden = lista.length > 0;
    ul.innerHTML = '';
    lista.forEach(function (a) {
      var reg = registroDoAlerta(a);
      ul.appendChild(UI.el('li', { classe: 'item-alerta alerta-' + a.nivel + (a.tipo === 'vitima_localizada' ? ' alerta-vitima' : '') + (a.reconhecido_em ? ' reconhecido' : '') }, [
        UI.el('div', { classe: 'item-alerta-cabeca' }, [
          UI.el('strong', { texto: a.titulo }),
          UI.el('small', { classe: 'muted', texto: C.hora(a.criado_em) }),
        ]),
        reg ? seloCondicaoReg(reg) : null,
        UI.el('p', { texto: reg ? textoRegistroVitima(reg) : a.texto }),
        UI.el('small', { classe: 'muted', texto: (a.posicao_em ? 'Pela trilha GPS: ' + C.hora(a.posicao_em) + '. ' : '') +
          (a.reconhecido_em ? 'Ciente: ' + (a.reconhecido_por_nome || '') + ' às ' + C.hora(a.reconhecido_em, false) + '.' : '') }),
        UI.el('div', { classe: 'acoes-linha' }, [
          a.lat != null || a.grupo_id ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Ver no mapa', onclick: function () { verAlertaNoMapa(a); } }) : null,
          !a.reconhecido_em && est.op.status === 'ativa' ? UI.el('button', { classe: 'btn btn-pequeno btn-escuro', type: 'button', texto: 'Ciente', onclick: function () { reconhecerAlerta(a.id); } }) : null,
        ]),
      ]));
    });
  }

  /* ---------- Controle de tempo dos deslocamentos (migração 032) ---------- */
  // Horário combinado para o grupo iniciar e para voltar, com tolerância, e o tempo sem
  // contato que conta como falha de comunicação. Os alertas são gerados pelo servidor.
  var PRAZOS_PADRAO = { tolerancia_min: 10, sem_sinal_min: 10 };

  function doisDigitos(n) { return (n < 10 ? '0' : '') + n; }
  function isoParaHora(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return doisDigitos(d.getHours()) + ':' + doisDigitos(d.getMinutes());
  }
  // "HH:MM" digitado → data. Uma hora que já passou há mais de 6 h é de amanhã;
  // depoisDe (ms): o retorno fica sempre depois do início.
  function horaParaData(hhmm, depoisDe) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    var d = new Date();
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() < Date.now() - 6 * 3600e3) d.setDate(d.getDate() + 1);
    if (depoisDe != null && d.getTime() <= depoisDe) d.setDate(d.getDate() + 1);
    return d;
  }

  // Horários combinados de um deslocamento: sair até, estar de volta até, e os alertas.
  // m: a missão (para editar) ou nada (novo deslocamento). Usado no envio ao grupo e em ⏱ Horários.
  function camposPrazos(m) {
    m = m || {};
    var ini = UI.el('input', { classe: 'campo', id: 'prazo-inicio', type: 'time', value: isoParaHora(m.inicio_combinado_em) });
    var ret = UI.el('input', { classe: 'campo', id: 'prazo-retorno', type: 'time', value: isoParaHora(m.retorno_combinado_em) });
    var tol = UI.el('input', { classe: 'campo', id: 'prazo-tolerancia', type: 'number', min: '0', max: '240', step: '1', inputmode: 'numeric',
      value: String(m.tolerancia_min != null ? m.tolerancia_min : PRAZOS_PADRAO.tolerancia_min) });
    var sem = UI.el('input', { classe: 'campo', id: 'prazo-sem-sinal', type: 'number', min: '3', max: '240', step: '1', inputmode: 'numeric',
      value: String(m.sem_sinal_min != null ? m.sem_sinal_min : PRAZOS_PADRAO.sem_sinal_min) });
    var comb = UI.el('textarea', { classe: 'campo', id: 'prazo-combinado', maxlength: '500', rows: '2',
      placeholder: 'Ex.: rádio a cada 30 min no canal 3; voltar pela estrada principal' });
    comb.value = m.combinado_texto || '';
    function atalho(campo, rotulo, min) {
      return UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: rotulo, onclick: function () { campo.value = isoParaHora(new Date(Date.now() + min * 60000).toISOString()); } });
    }
    var personalizado = (m.tolerancia_min != null && m.tolerancia_min !== PRAZOS_PADRAO.tolerancia_min) ||
      (m.sem_sinal_min != null && m.sem_sinal_min !== PRAZOS_PADRAO.sem_sinal_min) || Boolean(m.combinado_texto);
    var el = UI.el('div', { classe: 'prazos-form' }, [
      UI.el('div', { classe: 'grupo-duplo' }, [
        UI.el('div', { classe: 'grupo' }, [
          UI.el('label', { classe: 'rotulo', for: 'prazo-inicio', texto: 'Sair até' }), ini,
          UI.el('span', { classe: 'atalhos-prazo' }, [atalho(ini, 'agora', 0), atalho(ini, '+15 min', 15), atalho(ini, '+30 min', 30)]),
        ]),
        UI.el('div', { classe: 'grupo' }, [
          UI.el('label', { classe: 'rotulo', for: 'prazo-retorno', texto: 'Estar de volta até' }), ret,
          UI.el('span', { classe: 'atalhos-prazo' }, [atalho(ret, '+1 h', 60), atalho(ret, '+2 h', 120), atalho(ret, '+4 h', 240)]),
        ]),
      ]),
      UI.el('details', { classe: 'grupo detalhes-prazos', open: personalizado ? true : null }, [
        UI.el('summary', null, ['Alertas e combinados (padrão: 10 min)', UI.dica('Atraso: o horário passou e a condição não foi cumprida, além da tolerância. Falta de contato: alguém ficou sem notícia por esse tempo. Sem internet, o celular guarda as posições e envia depois.')]),
        UI.el('div', { classe: 'grupo-duplo' }, [
          UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'prazo-tolerancia', texto: 'Avisar atraso depois de (min)' }), tol]),
          UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'prazo-sem-sinal', texto: 'Avisar falta de contato depois de (min sem sinal)' }), sem]),
        ]),
        UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'prazo-combinado', texto: 'O que foi combinado com o grupo (opcional)' }), comb]),
      ]),
    ]);
    // Lê e confere. Devolve os dados para definir_prazos_missao ou lança Error com a mensagem.
    function ler() {
      var dIni = null, dRet = null;
      if (ini.value) {
        dIni = m.inicio_combinado_em && ini.value === isoParaHora(m.inicio_combinado_em) ? new Date(m.inicio_combinado_em) : horaParaData(ini.value);
        if (!dIni) throw new Error('Horário de saída inválido.');
      }
      if (ret.value) {
        var manteve = m.retorno_combinado_em && ret.value === isoParaHora(m.retorno_combinado_em);
        dRet = manteve ? new Date(m.retorno_combinado_em) : horaParaData(ret.value, dIni ? dIni.getTime() : null);
        if (!dRet) throw new Error('Horário de volta inválido.');
        if (!manteve && dRet.getTime() < Date.now()) throw new Error('O horário de volta já passou. Informe um horário futuro.');
      }
      if (dIni && dRet && dRet.getTime() <= dIni.getTime()) throw new Error('A volta precisa ser depois da saída.');
      var t = Number(tol.value), ss = Number(sem.value);
      if (!(tol.value !== '' && Number.isInteger(t) && t >= 0 && t <= 240)) throw new Error('Atraso: informe de 0 a 240 minutos.');
      if (!(sem.value !== '' && Number.isInteger(ss) && ss >= 3 && ss <= 240)) throw new Error('Falta de contato: informe de 3 a 240 minutos.');
      return {
        inicio_combinado_em: dIni ? dIni.toISOString() : '', retorno_combinado_em: dRet ? dRet.toISOString() : '',
        tolerancia_min: t, sem_sinal_min: ss, combinado_texto: comb.value.replace(/\s+/g, ' ').trim(),
      };
    }
    function vazio(x) {
      return !x.inicio_combinado_em && !x.retorno_combinado_em && !x.combinado_texto &&
        x.tolerancia_min === PRAZOS_PADRAO.tolerancia_min && x.sem_sinal_min === PRAZOS_PADRAO.sem_sinal_min;
    }
    return { el: el, ler: ler, vazio: vazio };
  }

  function erroPrazos(e) {
    return e.codigo === 'funcao_ausente' ? 'O banco ainda não tem o controle de tempo (execute a migração 032 no Supabase).' : e.message;
  }

  // Situação de um horário combinado: { texto, classe } (classe: ok | alerta | atrasado)
  function situacaoPrazo(alvoIso, tolMin, cumpridoIso) {
    var alvo = C.paraMs(alvoIso), agora = Date.now();
    if (cumpridoIso) {
      var atraso = Math.round((C.paraMs(cumpridoIso) - alvo) / 60000);
      return { texto: '✔ às ' + C.hora(cumpridoIso, false) + (atraso > tolMin ? ' (' + textoMin(atraso) + ' depois do combinado)' : ''), classe: atraso > tolMin ? 'alerta' : 'ok' };
    }
    var falta = Math.round((alvo - agora) / 60000);
    if (falta >= 0) return { texto: 'faltam ' + textoMin(falta), classe: falta <= 10 ? 'alerta' : 'ok' };
    if (-falta <= tolMin) return { texto: 'na tolerância (' + textoMin(-falta) + ' após o horário)', classe: 'alerta' };
    return { texto: '⚠ ATRASADO há ' + textoMin(-falta - tolMin) + ' (além da tolerância)', classe: 'atrasado' };
  }

  // Quadro dos horários combinados do deslocamento: sair até, voltar até e o que já aconteceu
  function blocoTempoMissao(m, membros) {
    if (m.inicio_combinado_em === undefined) return null;   // banco sem a migração 032
    var tol = m.tolerancia_min != null ? m.tolerancia_min : PRAZOS_PADRAO.tolerancia_min;
    var sem = m.sem_sinal_min != null ? m.sem_sinal_min : PRAZOS_PADRAO.sem_sinal_min;
    var linhas = [];
    if (m.inicio_combinado_em) {
      var inicios = membros.map(function (y) { return C.paraMs(y.x.iniciou_em); }).filter(Boolean);
      var primeiro = inicios.length ? new Date(Math.min.apply(null, inicios)).toISOString() : (m.iniciada_em || null);
      var si = situacaoPrazo(m.inicio_combinado_em, tol, primeiro);
      linhas.push(UI.el('li', { classe: 'prazo-' + si.classe }, [UI.el('span', { texto: 'Sair até ' + C.hora(m.inicio_combinado_em, false) }), UI.el('small', { texto: si.texto })]));
    }
    if (m.retorno_combinado_em) {
      var concluido = m.status === 'na_base' || m.status === 'encerrada' ? (m.chegou_base_em || m.encerrada_em) : null;
      var sr = situacaoPrazo(m.retorno_combinado_em, tol, concluido);
      linhas.push(UI.el('li', { classe: 'prazo-' + sr.classe }, [UI.el('span', { texto: 'Estar de volta até ' + C.hora(m.retorno_combinado_em, false) }), UI.el('small', { texto: sr.texto })]));
    }
    return UI.el('div', { classe: 'painel-prazos' }, [
      UI.el('div', { classe: 'painel-prazos-titulo', texto: 'Horários combinados' }),
      linhas.length ? UI.el('ul', { classe: 'prazos-missao' }, linhas)
        : UI.el('p', { classe: 'muted', texto: 'Nenhum horário combinado (sem aviso de atraso).' }),
      UI.el('p', { classe: 'muted regra-prazos', texto: 'Avisa atraso depois de ' + tol + ' min do horário · falta de contato depois de ' + sem + ' min sem sinal' +
        (m.prazos_definidos_por_nome ? ' · definido por ' + m.prazos_definidos_por_nome + ' às ' + C.hora(m.prazos_definidos_em, false) : '') }),
      m.combinado_texto ? UI.el('p', { classe: 'combinado-missao', texto: 'Combinado: ' + m.combinado_texto }) : null,
    ]);
  }

  // Último contato de um membro com o servidor (GPS ou sinal de vida), para a tabela do deslocamento
  function contatoMembro(m, y) {
    var d = y.p && y.p.dados;
    if (!d || !d.ultimo_contato_em) return { texto: '—', classe: '' };
    var min = Math.floor((Date.now() - C.paraMs(d.ultimo_contato_em)) / 60000);
    var lim = m.sem_sinal_min != null ? m.sem_sinal_min : PRAZOS_PADRAO.sem_sinal_min;
    var ativa = m.status !== 'encerrada' && m.status !== 'na_base' && !y.x.chegou_base_em;
    if (ativa && min >= lim) return { texto: '📵 há ' + textoMin(min), classe: 'atrasado', titulo: 'Sem contato desde ' + C.hora(d.ultimo_contato_em) + ': pode estar sem internet. O celular guarda as posições e envia quando o sinal voltar.' };
    return { texto: min < 1 ? 'agora' : 'há ' + textoMin(min), classe: '', titulo: 'Último contato: ' + C.hora(d.ultimo_contato_em) };
  }

  function abrirPrazosMissao(m) {
    var campos = camposPrazos(m);
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'prazos-salvar', texto: 'Salvar horários' });
    var form = UI.el('form', { novalidate: true, classe: 'form-padrao' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Horários' }),
      UI.el('p', { classe: 'meta-area', texto: m.grupo_nome + ' → ' + m.nome + (m.base_nome ? ' · base: ' + m.base_nome : ' · sem base') }),
      campos.el, erro,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var dados;
      try { dados = campos.ler(); } catch (e) { erro.textContent = e.message; erro.hidden = false; return; }
      btn.disabled = true;
      try {
        var r = await C.rpc('definir_prazos_missao', { p_missao: m.id, p_dados: dados });
        if (r && r.id) est.missoes.set(r.id, r);
        fechar(true);
        UI.aviso('Horários de ' + m.grupo_nome + ' salvos e registrados no diário.', 'ok');
        if (est.renderMissoesAberto) est.renderMissoesAberto();
        agendarMissoes();
      } catch (e) {
        erro.textContent = 'Não foi possível salvar: ' + erroPrazos(e);
        erro.hidden = false;
        btn.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form, { empilhar: true });
  }

  // Quem envia e como foi: uma linha abaixo do título do deslocamento
  function resumoEnvio(m) {
    var quem = m.publico === 'responsavel' ? 'só o responsável recebeu' : 'todos receberam';
    var base = m.base_nome ? 'base ' + m.base_nome + ' (chegada a até ' + Math.round(m.raio_base_m) + ' m)' : 'sem base (sem controle de retorno)';
    return 'Enviado por ' + m.enviado_por_nome + ' às ' + C.hora(m.enviada_em, false) + ' · ' + quem + ' · ' + base;
  }

  // Etapas do deslocamento, em ordem. A primeira sem horário é a que está acontecendo agora.
  function linhaTempoMissao(m) {
    var etapas = [
      ['Enviado', m.enviada_em],
      ['Saiu', m.iniciada_em],
      [m.setor_nome ? 'No setor' : 'No destino', m.chegou_setor_em],
      ['Busca encerrada', m.busca_finalizada_em],
    ];
    if (m.base_lat != null) etapas.push(['Todos na base', m.chegou_base_em]);
    if (m.encerrada_em) etapas.push(['Encerrado', m.encerrada_em]);
    var atual = etapas.findIndex(function (e) { return !e[1]; });
    return UI.el('ol', { classe: 'etapas-missao', 'aria-label': 'Etapas do deslocamento' }, etapas.map(function (e, i) {
      var classe = e[1] ? 'feita' : (i === atual ? 'atual' : 'pendente');
      return UI.el('li', { classe: classe }, [UI.el('span', { texto: e[0] }), UI.el('small', { texto: e[1] ? C.hora(e[1], false) : (i === atual ? 'agora' : '—') })]);
    }));
  }

  // Situação de um membro no deslocamento (uma pílula na lista)
  function situacaoMembro(m, y) {
    if (y.p && y.p.dados.removido) return { texto: 'fora da operação', classe: '' };
    if (y.x.chegou_base_em) return { texto: '✔ na base às ' + C.hora(y.x.chegou_base_em, false), classe: 'ok' };
    if (m.status === 'retorno_atrasado') return { texto: 'ainda não chegou à base', classe: 'atrasado' };
    if (y.x.chegou_setor_em) return { texto: (m.setor_nome ? 'no setor' : 'no destino') + ' às ' + C.hora(y.x.chegou_setor_em, false), classe: 'ok' };
    if (y.x.iniciou_em) return { texto: 'em deslocamento desde ' + C.hora(y.x.iniciou_em, false), classe: '' };
    return { texto: 'ainda não saiu', classe: m.status === 'enviada' ? '' : 'alerta' };
  }

  // Lista de membros: quem está onde e a última notícia de cada um
  function listaMembrosMissao(m, membros) {
    if (!membros.length) return UI.el('p', { classe: 'muted', texto: 'Nenhum membro neste deslocamento.' });
    return UI.el('ul', { classe: 'membros-lista', 'aria-label': 'Membros do deslocamento' }, membros.map(function (y) {
      var st = situacaoMembro(m, y);
      var c = contatoMembro(m, y);
      return UI.el('li', null, [
        UI.el('span', { classe: 'membro-nome', texto: y.p ? nomeExibido(y.p) : 'participante' }),
        UI.el('small', { classe: 'muted', texto: y.x.recebe_destino ? 'recebe o destino' : 'só acompanhado' }),
        UI.el('span', { classe: 'pilula-estado ' + st.classe, texto: st.texto }),
        c.texto === '—' ? null : UI.el('span', { classe: 'pilula-estado ' + c.classe, title: c.titulo || null, texto: 'contato: ' + c.texto }),
      ]);
    }));
  }

  // Ações do cartão: a principal primeiro; encerrar fica separado, à direita
  function acoesMissao(m, ativa, fecharModal) {
    var botoes = [];
    if (ativa && !m.busca_finalizada_em) botoes.push(UI.el('button', { classe: 'btn btn-pequeno btn-ok', type: 'button', texto: 'Finalizar busca',
      title: 'O grupo terminou a busca no setor: começa a contar o tempo para voltar à base', onclick: function () { finalizarBuscaPainel(m); } }));
    if (ativa && m.busca_finalizada_em && m.base_lat != null) botoes.push(UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Mais 15 min para voltar', onclick: function () { prorrogarRetorno(m); } }));
    if (ativa && m.inicio_combinado_em !== undefined) botoes.push(UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '⏱ Horários', title: 'Hora de sair, hora de voltar e alertas', onclick: function () { abrirPrazosMissao(m); } }));
    botoes.push(UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Ver no mapa', onclick: function () { fecharModal(); verMissaoNoMapa(m); } }));
    if (ativa) botoes.push(UI.el('button', { classe: 'btn btn-pequeno btn-perigo empurrar', type: 'button', texto: 'Encerrar', onclick: function () { encerrarMissaoPainel(m); } }));
    return UI.el('div', { classe: 'acoes-missao' }, botoes);
  }

  // Ferramentas → Deslocamentos de grupos: um cartão por deslocamento
  function abrirMissoes() {
    if (!est.op) return;
    var corpo = UI.el('div', { classe: 'corpo-missoes' });
    function render() {
      corpo.innerHTML = '';
      if (est.semMissoes) {
        corpo.appendChild(UI.el('p', { classe: 'nota', texto: 'Os deslocamentos de grupos ainda não estão disponíveis no servidor: execute a migração 010 no Supabase.' }));
        return;
      }
      var lista = Array.from(est.missoes.values()).sort(function (a, b) {
        var aa = a.status === 'encerrada' || a.status === 'na_base' ? 1 : 0, bb = b.status === 'encerrada' || b.status === 'na_base' ? 1 : 0;
        return aa - bb || C.paraMs(b.enviada_em) - C.paraMs(a.enviada_em);
      });
      if (!lista.length) {
        corpo.appendChild(UI.el('p', { classe: 'muted', texto: 'Nenhum deslocamento ainda. Para criar: Enviar destino → Grupo.' }));
        return;
      }
      lista.forEach(function (m) {
        var st = STATUS_MISSAO[m.status] || STATUS_MISSAO.encerrada;
        var ativa = m.status !== 'encerrada' && m.status !== 'na_base' && est.op.status === 'ativa';
        var membros = (est.missaoMembros.get(m.id) || []).map(function (x) { return { x: x, p: est.participantes.get(x.participante_id) }; })
          .sort(function (a, b) { return (a.p ? a.p.dados.nome : '').localeCompare(b.p ? b.p.dados.nome : '', 'pt-BR'); });
        corpo.appendChild(UI.el('article', { classe: 'cartao-missao status-' + m.status }, [
          UI.el('header', { classe: 'cartao-missao-topo' }, [
            UI.el('div', { classe: 'cartao-missao-titulo' }, [
              UI.el('strong', { texto: m.grupo_nome + ' → ' + m.nome }),
              UI.el('small', { classe: 'muted', texto: resumoEnvio(m) }),
            ]),
            UI.el('span', { classe: 'selo ' + st.selo, texto: st.rotulo }),
          ]),
          linhaTempoMissao(m),
          blocoTempoMissao(m, membros),
          listaMembrosMissao(m, membros),
          acoesMissao(m, ativa, function () { fechar(); }),
        ]));
      });
    }
    render();
    est.renderMissoesAberto = render;
    var fechar = UI.abrirModal(UI.el('div', { classe: 'modal-missoes' }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Deslocamentos de grupos' }, [UI.dica('Cada cartão é um deslocamento: horários combinados, onde está cada pessoa e o que falta. ' +
        'Os alertas de atraso e de falta de contato são verificados pelo servidor, mesmo sem internet.')]),
      corpo,
      UI.rodape([UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]), { aoFechar: function () { if (est.renderMissoesAberto === render) est.renderMissoesAberto = null; } });
  }

  function verMissaoNoMapa(m) {
    if (!est.mapa) return;
    if (m.grupo_id && est.grupos.has(m.grupo_id)) ligarGrupoFiltro(m.grupo_id, true);
    var pts = [[m.lat, m.lng]];
    if (m.base_lat != null) pts.push([m.base_lat, m.base_lng]);
    (est.missaoMembros.get(m.id) || []).forEach(function (x) {
      var p = est.participantes.get(x.participante_id);
      var pos = p && posicaoAtual(p);
      if (pos) pts.push([pos.lat, pos.lng]);
    });
    if (m.setor_id && est.setores.has(m.setor_id)) verticesSetor(est.setores.get(m.setor_id).d).forEach(function (v) { pts.push(v); });
    est.mapa.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 17 });
  }

  async function finalizarBuscaPainel(m) {
    var r = await UI.confirmar({
      titulo: 'Finalizar a busca de ' + m.grupo_nome + ' em ' + m.nome + '?',
      texto: m.base_lat != null
        ? 'Todos os acompanhados recebem o destino "Volte para a base" e começa a contar o prazo de retorno (' + m.prazo_retorno_min + ' min). O setor NÃO é marcado como concluído automaticamente.'
        : 'Sem base definida: a navegação do grupo é encerrada e não há controle de retorno.',
      ok: 'Finalizar busca',
    });
    if (!r) return;
    try {
      await C.rpc('finalizar_busca', { p_missao: m.id });
      UI.aviso('Busca finalizada. ' + (m.base_lat != null ? 'O grupo está voltando à base.' : ''), 'ok');
      agendarMissoes();
      agendarAreas();
    } catch (e) { UI.aviso(e.message, 'erro'); }
  }

  async function prorrogarRetorno(m) {
    try {
      await C.rpc('prorrogar_retorno', { p_missao: m.id, p_min: 15 });
      UI.aviso('Prazo de retorno prorrogado em 15 min.', 'ok');
      agendarMissoes();
    } catch (e) { UI.aviso(e.message, 'erro'); }
  }

  async function encerrarMissaoPainel(m) {
    var r = await UI.confirmar({
      titulo: 'Encerrar o deslocamento de ' + m.grupo_nome + '?',
      texto: 'A navegação do grupo é encerrada e não há mais alertas automáticos deste deslocamento (inclusive de retorno).',
      ok: 'Encerrar deslocamento',
      perigo: true,
    });
    if (!r) return;
    try {
      await C.rpc('encerrar_missao', { p_missao: m.id });
      UI.aviso('Deslocamento encerrado.', 'ok');
      agendarMissoes();
      agendarAreas();
    } catch (e) { UI.aviso(e.message, 'erro'); }
  }

  /* ------------------------------------------------------------------ */
  /* Interface para as ferramentas de mapa (ferramentas.js)               */
  /* ------------------------------------------------------------------ */
  window.Painel = {
    mapa: function () { return est.mapa; },
    controleGrupos: function () { return est.controleGrupos; },
    fecharMenu: function () { fecharMenu(false); },
    compactarAcoes: compactarAcoes,
    op: function () { return est.op; },
    usuario: function () { return est.usuario; },
    trilhasManuais: function () { return Array.from(est.trilhasManuais.values()).map(function (t) { return t.d; }); },
    emDesenho: function () { return Boolean(est.desenho); },
    // Linha pronta (ex.: de arquivo importado) enviada como trajeto a pessoas ou a um grupo
    enviarTrajeto: function (pts, nome) {
      if (!podeAlterar()) { UI.aviso('Operação encerrada: só leitura.', 'erro'); return; }
      var fim = pts[pts.length - 1];
      abrirEnviarDestino({ nome: String(nome || 'Trajeto').slice(0, 80), lat: fim[0], lng: fim[1], trajeto: pts });
    },
    // Linha de arquivo importado → trilha da operação (formulário com nome, cor, meio e situação já preenchidos)
    registrarTrilha: function (extra) {
      if (!podeAlterar()) { UI.aviso('Operação encerrada: só leitura.', 'erro'); return; }
      if (est.semTrilhasManuais) { UI.aviso(C.traduzirErro({ message: 'funcao_ausente' }), 'erro', 9000); return; }
      abrirFormTrilha(null, null, extra);
    },
    admin: function () { return Boolean(est.responsavel && est.responsavel.admin); },
    meuNome: function () { return (est.responsavel && est.responsavel.nome) || ''; },
    selecionado: function () { return est.selecionado; },
    participantes: function () { return Array.from(est.participantes.values()); },
    participante: function (id) { return est.participantes.get(id) || null; },
    nome: function (p) { return nomeExibido(p); },
    tipo: function (p) { return tipoDe(p.dados); },
    trilha: function (p) { return window.GPS.trilha(p.pontos, { precisaoTrilhaM: LIM.precisaoTrilhaM, lacunaMs: lacunaMsOp(), objetos: true }); },
    posicao: function (p) { return posicaoAtual(p); },
    pontosInteresse: function () { return Array.from(est.pontosInt.values()).map(function (x) { return x.d; }); },
    setores: function () { return Array.from(est.setores.values()).map(function (x) { return x.d; }); },
    areaSetorM2: areaSetorM2,
    grupos: function () { return Array.from(est.grupos.values()); },
    podeAlterar: podeAlterar,
    missoes: function () { return Array.from(est.missoes.values()); },
    camadaProbabilidade: camadaProbabilidade,
    agruparMarcadores: agruparMarcadores,
    desagruparMarcadores: desagruparMarcadores,
    categorias: CAT_PONTO,
    categoriaDoPonto: catDoPonto,   // { rotulo, letra, cor? } — fixa ou tipo criado pelos usuários
    raioAlertaPadrao: RAIO_ALERTA_PADRAO,
    formatoCoord: function () { return est.prefsMapa.coord || 'dec'; },
    minhaPosicao: function () { return obterMinhaPosicao(); },
    altitudeEm: altitudeEm,
    alarme: function () { alarme(); },
    iniciarDesenho: iniciarDesenhoExterno,
    marcarPonto: function (lat, lng, extra) { abrirFormPontoInt(Object.assign({ lat: lat, lng: lng }, extra || {})); },
    registrarVitima: function (lat, lng) { abrirRegistroVitima({ lat: lat, lng: lng, onde: 'mapa' }); },
    // Celular: recolhe a lista (gaveta) para a janela do ponto caber; devolve a altura que ainda cobre o mapa.
    liberarMapa: function () {
      if (!gaveta.ativa) return 0;
      if (gaveta.estado !== 'mini') definirGaveta('mini', false);
      return alturasGaveta().mini;
    },
    // menu do toque longo / botão direito: setor com centro no ponto, ou área começando nele
    setorRaioEm: function (lat, lng) { iniciarDesenho('raio'); if (est.desenho) aoClicarNoMapa({ latlng: { lat: lat, lng: lng } }); },
    setorDesenhoDesde: function (lat, lng) { iniciarDesenho('poligono'); if (est.desenho) aoClicarNoMapa({ latlng: { lat: lat, lng: lng } }); },
    enviarDestino: function (lat, lng, nome) { abrirEnviarDestino({ nome: nome || 'Ponto marcado no mapa', lat: lat, lng: lng }); },
    criarSetor: function (pontos, nome) { abrirFormSetor(Object.assign({ forma: 'poligono', pontos: pontos }, nome ? { nome: nome.slice(0, 60) } : {})); },
    salvarPonto: function (dados) { return C.rpc('salvar_ponto', { p_operacao: est.op.id, p_id: null, p_dados: dados }).then(function (r) { aplicarPontos([r]); return r; }); },
    blocoCoordenadas: blocoCoordenadas,
    copiar: copiarTexto,
    fecharMenu: function () { fecharMenu(false); },
    // Relatos de campo recentes (pistas, vestígios, objetos, obstáculos), sem o nome de quem enviou: contexto da sugestão de POA por IA
    relatos: function () {
      return Array.from(est.mensagens.values()).filter(function (m) { return m.direcao === 'entrada' && m.categoria && m.categoria !== 'MENSAGEM' && m.categoria !== 'AJUDA' && m.categoria !== 'VITIMA' && m.texto; })
        .sort(function (a, b) { return C.paraMs(b.criada_em) - C.paraMs(a.criada_em); }).slice(0, 15)
        .map(function (m) { return { texto: m.texto, quando: new Date(C.paraMs(m.criada_em)).toISOString(), categoria: (CATEGORIAS[m.categoria] || CATEGORIAS.OUTRO).rotulo, lat: m.lat, lng: m.lng }; });
    },
    irPara: function (lat, lng) { if (est.mapa && lat != null && lng != null) est.mapa.setView([lat, lng], Math.max(est.mapa.getZoom(), 17)); },
    recarregarGrupos: function () { return carregarGrupos().then(function () { if (est.renderGruposAberto) est.renderGruposAberto(); }); },
    abrirCentral: function (aba) { abrirCentral(aba); },
    // link do civil.html da operação (com o código de um convite por e-mail, quando houver)
    linkCivil: function (codigo) { return est.op ? linkPara(est.op.token_civil) + (codigo ? '&c=' + codigo : '') : ''; },
    // link de cada categoria de convite: civil e bombeiro (com o código do convite) ou o painel da operação (responsável)
    linkConvite: function (tipo, codigo) {
      if (!est.op) return '';
      if (tipo === 'responsavel') { var u = new URL('militar.html', location.href); u.search = ''; u.hash = 'op=' + est.op.id; return u.href; }
      return linkPara(tipo === 'militar' ? est.op.token_militar : est.op.token_civil) + (codigo ? '&c=' + codigo : '');
    },
    atualizarCentral: function () { if (est.op) agendarCentral(); },
    abrirRelato: function (id) { abrirRelato(id); },
    mensagens: function () { return Array.from(est.mensagens.values()); },
  };

  iniciar();
})();
