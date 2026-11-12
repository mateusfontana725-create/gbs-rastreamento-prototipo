/* =====================================================================
 * participante.js — página do participante (civil ou militar de campo)
 *   1. Lê o token do link (#t=...), mostra a operação.
 *   2. Só depois do toque em INICIAR: pede a permissão de localização,
 *      cria uma sessão anônima e ingressa na operação.
 *   3. Coleta posições, guarda numa fila local e envia em lotes.
 *   4. Recebe mensagens em tempo real e envia as confirmações.
 * ===================================================================== */
(function () {
  'use strict';

  var C = window.Comunicacao;
  var UI = window.UI;
  // Dentro do aplicativo Android (js/app-nativo.js): o GPS é lido e enviado pelo serviço do aplicativo,
  // que continua com a tela apagada; a página mostra o mapa, as mensagens e o estado.
  var APP = window.GBSApp || { disponivel: false };
  var NATIVO = Boolean(APP.disponivel);
  function $(id) { return document.getElementById(id); }

  var CHAVE_PART = 'sar-civil-participacao';
  var CHAVE_FILA = 'sar-civil-fila';
  var CHAVE_CONF = 'sar-civil-confirmacoes';
  var CHAVE_MSGS = 'gbs-civil-mensagens-pendentes';
  var CHAVE_VISTO = 'gbs-civil-conversa-vista';
  // Entrada pelo código da operação (migração 069): o pedido aguardando resposta e os dados já digitados
  var CHAVE_PEDIDO = 'gbs-civil-pedido-acesso';
  var CHAVE_PRE = 'gbs-civil-pre-cadastro';
  // Modal do aplicativo já mostrado sozinho para esta participação
  var CHAVE_APP_OFERECIDO = 'gbs-civil-app-oferecido';
  // Fotos com local pendente: [{ id (client_id), capturada, fix: {lat,lng,prec,t} | 'nenhuma' | null }]
  var CHAVE_FOTOS_PEND = 'gbs-civil-fotos-local-pendente';
  var EQUIPE_ATUAL_S = 120;          // posição de bombeiro com até 2 min = atual

  // Coleta x envio: o GPS é lido continuamente (watchPosition, eventos reais do
  // aparelho); o filtro (gps.js) decide quais leituras entram na trilha; os
  // pontos aceitos vão para uma fila local (sobrevive a falta de internet) e são
  // enviados logo: ~1 s em veículo, ~1,5 s a pé (vários pontos por envio).
  var CFG = {
    envioRapidoMs: 1000,         // em veículo: envia 1 s depois do ponto
    envioPeMs: 1500,             // a pé/parado: envia 1,5 s depois (junta os pontos desse intervalo)
    sinalVidaMs: 10000,          // "estou conectado" a cada 10 s (o painel marca instável com 35 s sem contato)
    semGpsMs: 60000,             // sem leitura por 60 s = "sem sinal"
    reiniciarGpsMs: 90000,       // sem leitura por 90 s com a tela aberta: reinicia a leitura do GPS
    reinclusaoMs: 20000,         // removido: verifica a cada 20 s se foi chamado de volta
    destinoMs: 15000,            // recuperação do destino (além do tempo real)
    loteMaximo: 200,
  };

  var estado = {
    token: null,
    info: null,
    part: null,               // { participante_id, nome, tipo, operacao }
    rastreando: false,
    watchId: null,
    gps: 'aguardando',
    ultimaLeitura: null,      // { lat, lng, prec, recebidaEm }
    ultimoAceito: null,       // { lat, lng, t }
    trilha: null,             // fila offline dos pontos (trilha-local.js: IndexedDB)
    trilhaAbrindo: null,
    bufferPontos: [],         // pontos capturados enquanto a fila abre (NÃO gravados no aparelho ainda; nunca descartados)
    filaLegada: null,         // fila da versão anterior (localStorage), migrada ao abrir
    userId: null,
    grupos: [],               // grupos deste participante (nome, cor, papel)
    enviando: false,
    timerEnvio: null,
    falhas: 0,
    ultimoSucesso: 0,
    ultimoEnviadoT: null,
    timerSinal: null,
    timerUI: null,
    ultimoTique: Date.now(),
    wakeLock: null,
    canal: null,
    mensagens: new Map(),
    confirmadasLocal: new Set(),
    confPendentes: [],
    msgPendentes: [],        // mensagens escritas aqui que ainda não chegaram ao servidor
    fotosLocais: new Map(),  // fotos na fila do aparelho (id → item)
    minhasFotos: [],         // fotos já registradas (servidor)
    urlsFotos: new Map(),    // caminho → link temporário
    enviandoFotos: false,
    alertaAtual: null,
    alertadas: new Set(),
    audio: null,
    swReg: null,
    finalizado: false,
    // mapa
    mapa: null,
    meuMarcador: null,
    meuCirculo: null,
    equipe: new Map(),        // id → marcador
    timerEquipe: null,
    jaEnquadrou: false,
    seguindo: true,
    conversaVistaAte: 0,
    // setores, pontos e navegação
    camadaExtras: null,
    destino: null,            // { id, nome, lat, lng, criado_em }
    marcaDestino: null,
    linhaDestino: null,
    rumo: null,               // direção para onde o celular aponta (bússola), em graus
    rumoEm: 0,
    rumoGps: null,            // direção em que a pessoa anda, pelo GPS (quando o celular não tem sensor de direção)
    rumoGpsEm: 0,
    refRumoGps: null,         // última posição usada para calcular o rumo pelo GPS
    bussolaDesde: 0,          // quando a bússola começou a procurar
    ouvindoBussola: false,
    rafNav: null,
    destinoConfirmado: null,  // id do destino cuja chegada já foi confirmada ao servidor
    // rota por caminhos reais (rotas.js → /api/rota)
    modoNav: 'a_pe',
    rota: null,               // rota calculada (com destId e modo)
    rotaErro: null,
    rotaErroEm: 0,
    rotaCalcEm: 0,
    rotaCalculando: false,
    rotaForaCont: 0,
    camadaRota: null,
    falhasDestino: 0,
    destinoSemTempoReal: false,
    // GPS
    filtro: new window.GPS.Filtro(),
    permissao: 'desconhecido',  // granted | denied | prompt | desconhecido
    statusPermissao: null,
    watchIniciadoEm: 0,
    envioAgendadoPara: 0,
    timerReinclusao: null,
    motivoFim: null,
  };

  /* ------------------------------------------------------------------ */
  /* Telas                                                               */
  /* ------------------------------------------------------------------ */
  var TELAS = ['carregando', 'erro', 'codigo', 'espera', 'inicio', 'rastreio', 'encerrado'];
  function mostrarTela(nome) {
    TELAS.forEach(function (t) { $('tela-' + t).hidden = t !== nome; });
    document.body.classList.toggle('civil-em-rastreio', nome === 'rastreio');   // o mapa ocupa a tela toda
    if (nome === 'rastreio') aplicarTipoUI();
    if (nome !== 'rastreio') fecharMenuFolha();
    window.scrollTo(0, 0);
    if (nome === 'rastreio' && estado.mapa) setTimeout(function () { estado.mapa.invalidateSize(); }, 60);
  }

  function mostrarErro(texto) {
    $('erro-texto').textContent = texto;
    mostrarTela('erro');
  }

  /* ------------------------------------------------------------------ */
  /* Inicialização                                                       */
  /* ------------------------------------------------------------------ */
  function lerToken() {
    var doHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('t');
    var daBusca = new URLSearchParams(location.search).get('t');
    var t = (doHash || daBusca || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(t) ? t : null;
  }

  // Código do convite por e-mail (#t=…&c=…): só preenche o nome; quem manda no acesso é o token do link
  function lerCodigoConvite() {
    var c = (new URLSearchParams(location.hash.replace(/^#/, '')).get('c') || '').trim().toLowerCase();
    return /^[0-9a-f]{24}$/.test(c) ? c : null;
  }

  async function iniciar() {
    $('btn-recarregar').addEventListener('click', function () { location.reload(); });

    if (!C.configurado) {
      return mostrarErro('O aplicativo não está configurado no servidor (variáveis do Supabase ausentes). Avise os bombeiros.');
    }
    if (!window.isSecureContext) {
      return mostrarErro('Esta página precisa ser aberta por um endereço seguro (https://).');
    }
    if (!('geolocation' in navigator)) {
      return mostrarErro('Este navegador não oferece acesso à localização. Use o Google Chrome atualizado.');
    }
    estado.token = lerToken();
    // Guarda a página e o mapa no aparelho já na primeira visita (abre de novo mesmo sem internet)
    registrarServiceWorker();
    if (NATIVO) ouvirApp();
    // "Entrar em outra busca com o código" (telas de início, erro e encerrada): quem já tem o aplicativo,
    // que abre sempre na última busca, consegue pedir para entrar numa busca nova.
    document.querySelectorAll('[data-outra-busca]').forEach(function (b) { b.addEventListener('click', abrirEntradaPorCodigo); });
    // Sem link (ou pedido pelo código ainda esperando resposta): a pessoa entra com o código e espera os bombeiros aceitarem
    if (!estado.token || (C.local.ler(CHAVE_PEDIDO, null) && !participacaoAtiva())) return iniciarPorCodigo();

    try {
      estado.info = await C.rpc('info_operacao', { p_token: estado.token });
    } catch (e) {
      // Sem internet, mas este aparelho já estava na busca: continua registrando e envia quando o sinal voltar
      if (e.rede && await retomarSemInternet()) return;
      return mostrarErro(e.rede ? 'Sem conexão com a internet. Conecte-se e toque em TENTAR NOVAMENTE.' : e.message);
    }
    if (!estado.info) {
      return mostrarErro('Link de operação inválido. Peça um novo link aos bombeiros.');
    }
    if (!estado.info.ativa) {
      return finalizar('encerrada');
    }

    // Tela inicial
    $('ini-operacao').textContent = estado.info.operacao;
    $('ini-grupo-caixa').hidden = !estado.info.grupo;
    $('ini-grupo').textContent = estado.info.grupo || '';
    // Só aparece a escolha quando o link deixa escolher (grupo que permite militar). O link de militares
    // devolve só "militar" e o de civis só "civil": nesses casos não há escolha nenhuma.
    var tipos = estado.info.tipos_permitidos || [];
    var permiteMilitar = tipos.indexOf('militar') !== -1;
    $('ini-tipo-escolha').hidden = !(permiteMilitar && tipos.indexOf('civil') !== -1);

    var salvo = C.local.ler(CHAVE_PART, null);
    estado.convite = lerCodigoConvite();
    if (estado.convite && !(salvo && salvo.token === estado.token)) {
      try {
        var conv = await C.rpc('convite_ler', { p_codigo: estado.convite });
        if (conv && conv.nome) $('ini-nome').value = conv.nome;
        else estado.convite = null;
      } catch (e) { /* sem o nome pré-preenchido: a pessoa digita */ }
    }
    // Acesso aprovado pelo código: os dados digitados no pedido já vêm preenchidos
    var pre = C.local.ler(CHAVE_PRE, null);
    if (pre && !(salvo && salvo.token === estado.token)) {
      C.local.apagar(CHAVE_PRE);
      if (!$('ini-nome').value) $('ini-nome').value = pre.nome || '';
      $('ini-cpf').value = mascararCpf(pre.cpf || '');
      $('ini-tel').value = mascararTelefone(pre.telefone || '');
      estado.aprovadoPorCodigo = true;
    }
    if (salvo && salvo.token === estado.token) {
      $('ini-nome').value = salvo.nome || '';
      $('ini-cpf').value = mascararCpf(salvo.cpf || '');
      $('ini-tel').value = mascararTelefone(salvo.telefone || '');
      if (permiteMilitar && salvo.tipo) {
        var r = document.querySelector('input[name="tipo"][value="' + salvo.tipo + '"]');
        if (r) r.checked = true;
      }
      if (salvo.ativo) $('btn-iniciar').textContent = 'CONTINUAR';
      // Fila da versão anterior (localStorage): passa para o IndexedDB quando a participação abrir.
      var fila = C.local.ler(CHAVE_FILA, null);
      if (fila && fila.participante_id === salvo.participante_id && Array.isArray(fila.pontos)) {
        estado.filaLegada = fila;
      }
      var conf = C.local.ler(CHAVE_CONF, null);
      if (conf && conf.participante_id === salvo.participante_id && Array.isArray(conf.itens)) {
        estado.confPendentes = conf.itens;
        conf.itens.forEach(function (c) { estado.confirmadasLocal.add(c.id); });
      }
      var pm = C.local.ler(CHAVE_MSGS, null);
      if (pm && pm.participante_id === salvo.participante_id && Array.isArray(pm.itens)) estado.msgPendentes = pm.itens;
    } else {
      C.local.apagar(CHAVE_FILA);
      C.local.apagar(CHAVE_CONF);
      C.local.apagar(CHAVE_MSGS);
      C.local.apagar(CHAVE_FOTOS_PEND);
    }

    $('form-inicio').addEventListener('submit', aoIniciar);
    $('btn-saida').addEventListener('click', aoSolicitarSaida);
    $('menu-saida').addEventListener('click', function () { abrirMenuFolha(false); aoSolicitarSaida(); });
    $('form-msg').addEventListener('submit', aoEnviarMensagem);
    $('btn-registrar').addEventListener('click', abrirRegistro);
    $('btn-ampliar-mapa').addEventListener('click', function () { alternarMapaAmpliado(true); });
    // Menu (folha), foto direta e legenda do mapa dentro do menu
    $('btn-menu').addEventListener('click', function () { abrirMenuFolha(true); });
    $('folha-fechar').addEventListener('click', function () { abrirMenuFolha(false); });
    $('fm-setor').addEventListener('click', function () { abrirMenuFolha(false); escolherTipoSetorP(); });
    $('fm-ponto').addEventListener('click', function () { abrirMenuFolha(false); iniciarDesenhoP('ponto'); });
    $('folha-fundo').addEventListener('click', function () { abrirMenuFolha(false); });
    $('menu-sos').addEventListener('click', function () { abrirMenuFolha(false); pedirSocorro(); });
    $('menu-registrar').addEventListener('click', function () { abrirMenuFolha(false); abrirRegistro(); });
    // a legenda do mapa fica no mapa (civil) ou no menu (militar): ver aplicarTipoUI
    var legendaMapa = document.querySelector('.legenda-civil');
    if (legendaMapa) { legendaMapa.removeAttribute('aria-hidden'); estado.legendaEl = legendaMapa; }
    document.querySelector('#navegacao .nav-topo').addEventListener('click', function () { $('navegacao').classList.toggle('nav-aberta'); });
    $('btn-fechar-mapa').addEventListener('click', function () { alternarMapaAmpliado(false); });
    $('bussola-ativar').addEventListener('click', pedirBussola);
    $('btn-sos').addEventListener('click', pedirSocorro);
    $('conversa-fechar').addEventListener('click', fecharConversa);
    $('btn-onde-estou').addEventListener('click', function () { estado.seguindo = true; centralizarEmMim(true); mostrarMinhasCoordenadas(); });
    $('nav-encerrar').addEventListener('click', encerrarNavegacao);
    $('nav-finalizar').addEventListener('click', finalizarBuscaSetor);
    document.querySelectorAll('.nav-modos [data-modo]').forEach(function (b) {
      b.addEventListener('click', function () { trocarModoNav(b.getAttribute('data-modo')); });
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !$('folha-menu').hidden && !document.querySelector('.modal-fundo')) abrirMenuFolha(false);
      if (ev.key === 'Escape' && !$('camadas-civil').hidden && !document.querySelector('.modal-fundo')) { $('camadas-civil').hidden = true; $('btn-camadas').setAttribute('aria-expanded', 'false'); }
      if (ev.key === 'Escape' && !$('painel-conversa').hidden && !document.querySelector('.modal-fundo')) fecharConversa();
      if (ev.key === 'Escape' && document.querySelector('.mapa-civil-caixa.mapa-ampliado')) alternarMapaAmpliado(false);
    });
    $('ini-cpf').addEventListener('input', function () { this.value = mascararCpf(this.value); });
    $('ini-tel').addEventListener('input', function () { this.value = mascararTelefone(this.value); });
    document.querySelectorAll('input[name="tipo"]').forEach(function (r) { r.addEventListener('change', marcarOpcionais); });
    marcarOpcionais();
    iniciarBussola();
    $('opt-tela').addEventListener('change', function () {
      if (this.checked) pedirTelaLigada(); else liberarTelaLigada();
    });
    $('btn-notif').addEventListener('click', ativarNotificacoes);
    $('perm-verificar').addEventListener('click', verificarPermissaoDeNovo);
    $('perm-recarregar').addEventListener('click', function () { if (NATIVO) APP.configuracoes(); else location.reload(); });
    $('status-acao').addEventListener('click', mostrarComoResolver);
    $('btn-voltar-busca').addEventListener('click', voltarParaBusca);
    $('btn-diag').addEventListener('click', abrirDiagnostico);
    $('btn-diag').hidden = !/(^|[&#?])diag=1(&|$)/.test(location.hash + '&' + location.search);
    $('btn-app').addEventListener('click', abrirBaixarApp);
    $('btn-app-inicio').addEventListener('click', abrirBaixarApp);
    $('btn-app-abrir').addEventListener('click', abrirNoAplicativo);
    if (!NATIVO) oferecerApp();

    // Aberto pelo botão "Abrir no aplicativo": a participação do navegador passa para o aplicativo, sem cadastro novo
    var codigoApp = NATIVO ? lerCodigoApp() : null;
    if (codigoApp && await vincularPeloApp(codigoApp)) return;

    await acompanharPermissao();
    if (estado.permissao === 'denied') mostrarPermissao('navegador');

    // Página recarregada (ou reaberta) por quem já estava na busca: retoma sozinha,
    // sem refazer o cadastro, quando a localização já está permitida.
    if (salvo && salvo.token === estado.token && salvo.participante_id && (salvo.ativo || salvo.removido)) {
      if (await retomarParticipacao(salvo)) return;
    }
    mostrarTela('inicio');
    if (estado.aprovadoPorCodigo) UI.aviso('Acesso aprovado pelos bombeiros! Confira seus dados e toque em COMEÇAR.', 'ok', 10000);
  }

  // Consulta a situação de quem já participava (sem criar sessão nova).
  // Página aberta (ou recarregada) sem internet por quem já estava na busca neste aparelho: retoma o registro
  // com o que ficou guardado (participação, sessão e fila). O servidor confere tudo quando o sinal voltar
  // (sinal_vida encerra a página se a operação acabou ou a pessoa foi removida).
  async function retomarSemInternet() {
    var salvo = C.local.ler(CHAVE_PART, null);
    if (!salvo || salvo.token !== estado.token || !salvo.participante_id || !salvo.ativo || salvo.removido) return false;
    var sessao = null;
    try { sessao = (await C.cliente.auth.getSession()).data.session; } catch (e) { /* sem sessão guardada */ }
    if (!sessao || !sessao.user) return false;
    estado.userId = sessao.user.id;
    estado.info = { operacao: salvo.operacao || 'Operação', grupo: salvo.grupo || null, ativa: true, tipos_permitidos: [], semInternet: true };
    estado.part = { participante_id: salvo.participante_id, nome: salvo.nome, tipo: salvo.tipo, operacao: estado.info.operacao };
    estado.cpf = salvo.cpf;
    estado.telefone = salvo.telefone;
    estado.finalizado = false;
    mostrarTela('rastreio');
    comecarRastreamento(null);
    UI.aviso('Sem internet: o registro continua neste aparelho e vai para os bombeiros quando o sinal voltar.', 'erro', 8000);
    return true;
  }

  async function retomarParticipacao(salvo) {
    var sessao = null;
    try { sessao = (await C.cliente.auth.getSession()).data.session; } catch (e) { /* sem sessão */ }
    if (!sessao) return false;
    var r;
    try {
      r = await C.rpc('sinal_vida', { p_participante: salvo.participante_id, p_rastreando: null, p_gps: null }, 12000);
    } catch (e) {
      return false;   // sem internet: mostra a tela inicial com CONTINUAR
    }
    estado.part = { participante_id: salvo.participante_id, nome: salvo.nome, tipo: salvo.tipo, operacao: estado.info.operacao };
    estado.cpf = salvo.cpf;
    estado.telefone = salvo.telefone;
    if (!r || r.status !== 'ativa') {
      finalizar(r && ['removido', 'liberado', 'inexistente'].indexOf(r.status) !== -1 ? r.status : 'encerrada');
      return true;
    }
    if (salvo.ativo && estado.permissao === 'granted') {
      mostrarTela('inicio');
      await entrarNaBusca({ nome: salvo.nome, tipo: salvo.tipo, cpf: salvo.cpf, tel: salvo.telefone });
      return true;
    }
    estado.part = null;
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Permissão de localização                                             */
  /* ------------------------------------------------------------------ */
  // Acompanha a permissão do navegador (Permissions API, quando existe): se a
  // pessoa liberar a localização nas configurações, a página percebe sozinha.
  async function acompanharPermissao() {
    var r = await window.GPS.consultarPermissao();
    estado.permissao = r.estado;
    if (r.status && !estado.statusPermissao) {
      estado.statusPermissao = r.status;
      r.status.onchange = function () {
        estado.permissao = r.status.state;
        aoMudarPermissao();
      };
    }
  }

  function aoMudarPermissao() {
    if (estado.permissao === 'granted') {
      if (!$('tela-inicio').hidden && !$('ini-permissao').hidden) {
        $('ini-permissao').hidden = true;
        UI.aviso('Localização liberada.', 'ok');
        if (estado.tentouEntrar) $('form-inicio').requestSubmit();
      } else if (estado.rastreando && (estado.gps === 'negado' || estado.gps === 'indisponivel')) {
        religarGps();
      }
    } else if (estado.permissao === 'denied' && estado.rastreando) {
      estado.gps = 'negado';
      atualizarUI();
    }
  }

  // problema: 'navegador' | 'sistema' | 'sinal'
  function mostrarPermissao(problema) {
    var inst = NATIVO ? instrucoesApp(problema === 'sistema' ? 'indisponivel' : 'negado') : window.GPS.instrucoesLocalizacao(problema);
    $('perm-titulo').textContent = inst.titulo;
    $('perm-texto').textContent = problema === 'navegador'
      ? 'Sem a localização os bombeiros não conseguem ver onde você está. Para liberar:'
      : problema === 'sistema' ? 'O navegador pode usar a localização, mas ela está desligada no celular. Para ligar:'
        : 'Para melhorar o sinal:';
    var ol = $('perm-passos');
    ol.innerHTML = '';
    inst.passos.forEach(function (p) { ol.appendChild(UI.el('li', { texto: p })); });
    $('perm-recarregar').hidden = !(problema === 'navegador' && (NATIVO || window.GPS.ambiente().so === 'ios'));
    if (NATIVO) $('perm-recarregar').textContent = 'Abrir configurações do aplicativo';
    $('ini-permissao').hidden = false;
    $('ini-permissao').scrollIntoView({ block: 'start' });
  }

  async function verificarPermissaoDeNovo() {
    await acompanharPermissao();
    var btn = $('perm-verificar');
    btn.disabled = true;
    btn.textContent = 'VERIFICANDO…';
    var teste = await obterPosicaoInicial();
    btn.disabled = false;
    btn.textContent = 'VERIFICAR DE NOVO';
    if (teste.ok || teste.codigo === 3) {
      $('ini-permissao').hidden = true;
      if (estado.tentouEntrar) $('form-inicio').requestSubmit();
      else UI.aviso(teste.ok ? 'Localização funcionando. Toque em COMEÇAR.' : 'Localização permitida. Toque em COMEÇAR.', 'ok', 6000);
      return;
    }
    mostrarPermissao(teste.codigo === 2 ? 'sistema' : 'navegador');
    UI.aviso(teste.codigo === 2 ? 'A localização do celular ainda está desligada.' : 'A localização ainda está bloqueada para este site.', 'erro', 6000);
  }

  // Durante a busca: explica como liberar/ligar e tenta de novo.
  function mostrarComoResolver() {
    if (NATIVO && (estado.gps === 'negado' || estado.gps === 'indisponivel')) return comoResolverNoApp();
    var problema = estado.gps === 'negado' ? 'navegador' : estado.gps === 'indisponivel' ? 'sistema' : 'sinal';
    var inst = window.GPS.instrucoesLocalizacao(problema);
    var ol = UI.el('ol', { classe: 'perm-passos' }, inst.passos.map(function (p) { return UI.el('li', { texto: p }); }));
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', texto: inst.titulo }),
      ol,
      UI.rodape([
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Verificar de novo', onclick: function () { fechar(); religarGps(true); } }),
      ]),
    ]));
  }

  /* ------------------------------------------------------------------ */
  /* CPF e celular                                                        */
  /* ------------------------------------------------------------------ */
  function digitos(v) { return String(v || '').replace(/\D/g, ''); }

  function mascararCpf(v) {
    var d = digitos(v).slice(0, 11);
    return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2');
  }

  function mascararTelefone(v) {
    var d = digitos(v);
    if (d.length > 11 && d.indexOf('55') === 0) d = d.slice(2);
    d = d.slice(0, 11);
    if (d.length <= 2) return d.length ? '(' + d : '';
    if (d.length <= 6) return '(' + d.slice(0, 2) + ') ' + d.slice(2);
    if (d.length <= 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
    return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
  }

  function cpfValido(v) {
    var d = digitos(v);
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    for (var k = 9; k <= 10; k++) {
      var soma = 0;
      for (var i = 0; i < k; i++) soma += Number(d[i]) * (k + 1 - i);
      if (((soma * 10) % 11) % 10 !== Number(d[k])) return false;
    }
    return true;
  }

  function telefoneValido(v) {
    var d = digitos(v);
    if (d.length > 11 && d.indexOf('55') === 0) d = d.slice(2);
    return /^[1-9][0-9]9?[0-9]{8}$/.test(d) && (d.length === 10 || d.length === 11);
  }

  function tipoEscolhido() {
    var marcado = document.querySelector('input[name="tipo"]:checked');
    if (!$('ini-tipo-escolha').hidden && marcado) return marcado.value;
    var tipos = (estado.info && estado.info.tipos_permitidos) || [];
    return tipos.length === 1 && tipos[0] === 'militar' ? 'militar' : 'civil';
  }

  // Barra de baixo por tipo: o civil tem SOS e Registrar; o militar só o Menu (com SOS, mensagens e fotos dentro).
  function aplicarTipoUI() {
    var militar = Boolean(estado.part && estado.part.tipo === 'militar');
    document.body.classList.toggle('militar-em-rastreio', militar);
    $('btn-sos').hidden = militar;
    $('btn-registrar').hidden = militar;
    $('btn-menu').hidden = !militar;
    $('menu-acoes').hidden = !militar;
    // legenda: no menu do militar (que não tem o mapa com a legenda ao lado); no mapa, para o civil
    var leg = estado.legendaEl;
    if (leg) {
      var destino = militar ? $('folha-legenda') : document.querySelector('.mapa-civil-caixa');
      if (destino && leg.parentNode !== destino) destino.appendChild(leg);
    }
  }

  // CPF: opcional para todos. Celular: obrigatório para civis, opcional para militares.
  function marcarOpcionais() {
    var opcional = tipoEscolhido() === 'militar';
    document.querySelectorAll('[data-opcional]').forEach(function (e) { e.hidden = !opcional; });
  }

  /* ------------------------------------------------------------------ */
  /* Início do rastreamento (somente após o toque do usuário)            */
  /* ------------------------------------------------------------------ */
  function erroInicio(texto) {
    var p = $('ini-erro');
    p.textContent = texto;
    p.hidden = !texto;
  }

  function obterPosicaoInicial() {
    if (NATIVO) {
      return APP.permissao().then(function (p) {
        if (p.localizacao !== 'concedida') return { ok: false, codigo: 1 };
        return APP.posicao().then(function (r) { return r.erro ? { ok: false, codigo: r.erro } : { ok: true, pos: posicaoDoApp(r) }; });
      }).catch(function () { return { ok: false, codigo: 3 }; });
    }
    return new Promise(function (resolve) {
      navigator.geolocation.getCurrentPosition(
        function (pos) { resolve({ ok: true, pos: pos }); },
        function (err) { resolve({ ok: false, codigo: err.code, mensagem: err.message }); },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    });
  }

  /* ------------------------------------------------------------------ */
  /* Menu (folha) do rastreio                                             */
  /* ------------------------------------------------------------------ */
  function abrirMenuFolha(abrir) {
    var f = $('folha-menu');
    if (!f || f.hidden === !abrir) return;
    f.hidden = !abrir;
    $('btn-menu').setAttribute('aria-expanded', String(abrir));
    document.body.classList.toggle('folha-aberta', abrir);
    if (abrir) { try { $('folha-fechar').focus(); } catch (e) { /* ignora */ } }
  }
  function fecharMenuFolha() { if ($('folha-menu') && !$('folha-menu').hidden) abrirMenuFolha(false); }

  /* ------------------------------------------------------------------ */
  /* Entrar com o código da operação (migração 069)                       */
  /* ------------------------------------------------------------------ */
  // Letras e números sem 0/O/1/I; o campo mostra "ABC 234".
  function codigoDigitado() { return $('cod-codigo').value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6); }
  function mostrarCodigo() { var c = codigoDigitado(); $('cod-codigo').value = c.length > 3 ? c.slice(0, 3) + ' ' + c.slice(3) : c; }
  function erroCodigo(texto) { $('cod-erro').textContent = texto || ''; $('cod-erro').hidden = !texto; }

  // A participação guardada neste aparelho para o link aberto está em andamento?
  function participacaoAtiva() {
    var salvo = C.local.ler(CHAVE_PART, null);
    return Boolean(salvo && salvo.token === estado.token && salvo.ativo);
  }

  // Vai para a tela do código (sem trocar a busca guardada até os bombeiros aceitarem o pedido).
  function abrirEntradaPorCodigo() {
    if (estado.rastreando && !estado.finalizado) {
      UI.aviso('Saia desta busca antes de entrar em outra.', 'erro', 5000);
      return;
    }
    estado.token = null;
    try { history.replaceState(null, '', location.pathname + location.search + (NATIVO ? '#app=1' : '')); } catch (e) { /* segue */ }
    if (!estado.codigoPronto) iniciarPorCodigo();
    else mostrarTela('codigo');
    var salvo = C.local.ler(CHAVE_PART, null);
    if (salvo && !$('cod-nome').value) {
      $('cod-nome').value = salvo.nome || '';
      $('cod-cpf').value = mascararCpf(salvo.cpf || '');
      $('cod-tel').value = mascararTelefone(salvo.telefone || '');
    }
    setTimeout(function () { $('cod-codigo').focus(); }, 50);
  }

  async function iniciarPorCodigo() {
    if (estado.codigoPronto) { mostrarTela(estado.pedidoAcesso ? 'espera' : 'codigo'); return; }
    estado.codigoPronto = true;
    $('form-codigo').addEventListener('submit', aoPedirAcesso);
    $('cod-codigo').addEventListener('input', mostrarCodigo);
    $('cod-cpf').addEventListener('input', function () { this.value = mascararCpf(this.value); });
    $('cod-tel').addEventListener('input', function () { this.value = mascararTelefone(this.value); });
    $('btn-cancelar-pedido').addEventListener('click', cancelarPedidoAcesso);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && estado.pedidoAcesso) conferirPedido(); });
    var ped = C.local.ler(CHAVE_PEDIDO, null);
    if (ped && ped.pedido) {
      estado.pedidoAcesso = ped;
      $('esp-operacao').textContent = ped.operacao || 'a operação';
      mostrarTela('espera');
      conferirPedido();
      return;
    }
    mostrarTela('codigo');
  }

  async function aoPedirAcesso(ev) {
    ev.preventDefault();
    erroCodigo('');
    var codigo = codigoDigitado();
    var nome = $('cod-nome').value.replace(/\s+/g, ' ').trim();
    var cpf = digitos($('cod-cpf').value), tel = digitos($('cod-tel').value);
    if (codigo.length !== 6) { erroCodigo('O código tem 6 letras e números. Confira com os bombeiros.'); $('cod-codigo').focus(); return; }
    if (nome.length < 2 || nome.length > 40) { erroCodigo('Informe seu nome ou indicativo (2 a 40 caracteres).'); $('cod-nome').focus(); return; }
    if (cpf && !cpfValido(cpf)) { erroCodigo('CPF inválido. Confira os 11 números.'); $('cod-cpf').focus(); return; }
    if (!telefoneValido(tel)) { erroCodigo('Celular inválido. Informe o DDD e o número, por exemplo (21) 99876-5432.'); $('cod-tel').focus(); return; }
    var btn = $('btn-pedir');
    btn.disabled = true;
    btn.textContent = 'ENVIANDO…';
    try {
      await garantirSessao();
      var r = await C.rpc('solicitar_acesso_operacao', { p_codigo: codigo, p_nome: nome, p_cpf: cpf || null, p_telefone: tel });
      if (!r || r.ok === false) { erroCodigo(C.traduzirErro({ message: (r && r.erro) || 'codigo_acesso_invalido' })); return; }
      estado.pedidoAcesso = { pedido: r.pedido, operacao: r.operacao, nome: nome, cpf: cpf, telefone: tel, em: Date.now() };
      C.local.gravar(CHAVE_PEDIDO, estado.pedidoAcesso);
      $('esp-operacao').textContent = r.operacao || 'a operação';
      mostrarTela('espera');
      conferirPedido();
    } catch (e) {
      erroCodigo(e.rede ? 'Sem conexão com a internet. Verifique os dados móveis ou o Wi-Fi e tente de novo.' : e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'PEDIR PARA ENTRAR';
    }
  }

  // Pergunta ao servidor, a cada 4 s, se os bombeiros já responderam
  async function conferirPedido() {
    clearTimeout(estado.timerPedido);
    var ped = estado.pedidoAcesso;
    if (!ped || estado.conferindoPedido) return;
    estado.conferindoPedido = true;
    var r = null;
    try {
      await garantirSessao();
      r = await C.rpc('consultar_pedido_acesso', { p_pedido: ped.pedido }, 12000);
      $('esp-estado').textContent = 'Conferido às ' + C.hora(Date.now(), true) + '. Pode deixar esta tela aberta.';
    } catch (e) {
      if (e.codigo === 'sem_permissao') { limparPedidoAcesso(); mostrarTela('codigo'); estado.conferindoPedido = false; return; }
      $('esp-estado').textContent = e.rede ? 'Sem internet agora. Tentando de novo…' : e.message;
    }
    estado.conferindoPedido = false;
    if (r && r.status === 'aceito' && r.token) return aoAcessoAprovado(r.token, ped);
    if (r && r.status === 'recusado') { limparPedidoAcesso(); mostrarTela('codigo'); erroCodigo(C.traduzirErro({ message: 'acesso_recusado' })); return; }
    if (r && r.status === 'encerrada') { limparPedidoAcesso(); mostrarTela('codigo'); erroCodigo(C.traduzirErro({ message: 'operacao_encerrada' })); return; }
    if (r && r.status === 'cancelado') { limparPedidoAcesso(); mostrarTela('codigo'); return; }
    estado.timerPedido = setTimeout(conferirPedido, 4000);
  }

  function limparPedidoAcesso() {
    clearTimeout(estado.timerPedido);
    estado.pedidoAcesso = null;
    C.local.apagar(CHAVE_PEDIDO);
  }

  async function cancelarPedidoAcesso() {
    var ped = estado.pedidoAcesso;
    if (!ped) { mostrarTela('codigo'); return; }
    try { await C.rpc('cancelar_pedido_acesso', { p_pedido: ped.pedido }, 10000); } catch (e) { /* sai mesmo assim; o responsável vê que não há mais pedido ao recarregar */ }
    limparPedidoAcesso();
    mostrarTela('codigo');
  }

  // Aceito: o aparelho recebe o link da operação. Guarda os dados digitados, avisa o aplicativo e abre a tela de sempre
  // (a localização só começa depois do toque em COMEÇAR).
  async function aoAcessoAprovado(token, ped) {
    C.local.gravar(CHAVE_PRE, { nome: ped.nome || '', cpf: ped.cpf || '', telefone: ped.telefone || '' });
    limparPedidoAcesso();
    if (NATIVO && APP.operacao) { try { await APP.operacao(token); } catch (e) { /* o aplicativo guarda a operação quando a participação começa */ } }
    try { history.replaceState(null, '', location.pathname + location.search + '#t=' + token + (NATIVO ? '&app=1' : '')); } catch (e) { /* segue */ }
    location.reload();
  }

  async function garantirSessao() {
    var r = await C.cliente.auth.getSession();
    if (r.data && r.data.session) return r.data.session;
    var s = await C.cliente.auth.signInAnonymously();
    if (s.error) throw C.criarErro(s.error);
    return s.data.session;
  }

  async function aoIniciar(ev) {
    ev.preventDefault();
    erroInicio('');
    var nome = $('ini-nome').value.replace(/\s+/g, ' ').trim();
    if (nome.length < 2 || nome.length > 40) {
      erroInicio('Informe seu nome ou indicativo (2 a 40 caracteres).');
      $('ini-nome').focus();
      return;
    }
    var tipo = tipoEscolhido();
    var cpf = digitos($('ini-cpf').value);
    var tel = digitos($('ini-tel').value);
    var obrigatorio = tipo === 'civil';
    if (cpf && !cpfValido(cpf)) {
      erroInicio('CPF inválido. Confira os 11 números.');
      $('ini-cpf').focus();
      return;
    }
    if ((obrigatorio || tel) && !telefoneValido(tel)) {
      erroInicio('Celular inválido. Informe o DDD e o número, por exemplo (21) 99876-5432.');
      $('ini-tel').focus();
      return;
    }
    await entrarNaBusca({ nome: nome, tipo: tipo, cpf: cpf, tel: tel });
  }

  // Pede a localização pelo mecanismo oficial do navegador, entra na operação
  // (ou volta para o mesmo registro) e começa a enviar. O rastreamento só é
  // mostrado como ativo depois que a permissão é concedida.
  async function entrarNaBusca(dados) {
    if (estado.entrando) return;
    estado.entrando = true;
    estado.tentouEntrar = true;
    var btn = $('btn-iniciar');
    var textoOriginal = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'OBTENDO LOCALIZAÇÃO…';
    prepararAudio();

    try {
      // 1. Permissão e teste do GPS
      var teste = await obterPosicaoInicial();
      await acompanharPermissao();
      if (!teste.ok && teste.codigo === 1) {
        erroInicio('');
        mostrarPermissao('navegador');
        return;
      }
      $('ini-permissao').hidden = true;

      // 2. Sessão anônima e ingresso (o mesmo aparelho volta para o mesmo registro)
      btn.textContent = 'CONECTANDO…';
      var sessao = await garantirSessao();
      estado.userId = sessao && sessao.user ? sessao.user.id : null;
      var part = await C.rpc('ingressar', {
        p_token: estado.token, p_nome: dados.nome, p_tipo: dados.tipo,
        p_cpf: dados.cpf || null, p_telefone: dados.tel || null,
      });
      if (estado.convite) C.rpc('convite_aceitar', { p_codigo: estado.convite, p_participante: part.participante_id }).catch(function () { /* o convite não impede a participação */ });
      estado.cpf = dados.cpf;
      estado.telefone = dados.tel;
      estado.saidaSolicitadaEm = part.saida_solicitada_em || null;

      if (estado.part && estado.part.participante_id !== part.participante_id) fecharTrilha();
      var salvo = C.local.ler(CHAVE_PART, null);
      if (salvo && salvo.participante_id !== part.participante_id) {
        fecharTrilha();
        estado.filaLegada = null;
        estado.confPendentes = [];
        estado.confirmadasLocal.clear();
      }
      estado.part = part;
      estado.finalizado = false;
      salvarParticipacao(true);

      mostrarTela('rastreio');
      registrarServiceWorker();
      setTimeout(oferecerAppAposCadastro, 1500);
      if (!teste.ok) estado.gps = teste.codigo === 2 ? 'indisponivel' : 'sem_sinal';
      comecarRastreamento(teste.ok ? teste.pos : null);
      if (!teste.ok && teste.codigo === 2) {
        UI.aviso('A localização do celular está desligada. Toque em "Como resolver".', 'erro', 8000);
      } else if (!teste.ok) {
        UI.aviso('Ainda sem sinal de GPS. Se possível, vá para um local aberto. O rastreamento continua tentando.', 'erro', 7000);
      }
    } catch (e) {
      if (e.codigo === 'operacao_encerrada' || e.codigo === 'participante_removido' || e.codigo === 'participante_liberado') {
        if (!estado.part && salvoAtivo()) {
          var s = C.local.ler(CHAVE_PART, null);
          estado.part = { participante_id: s.participante_id, nome: s.nome, tipo: s.tipo, operacao: estado.info.operacao };
        }
        finalizar({ operacao_encerrada: 'encerrada', participante_removido: 'removido', participante_liberado: 'liberado' }[e.codigo]);
        return;
      }
      // servidor ainda sem a migração 029: civil sem CPF é recusado lá
      erroInicio(e.rede ? 'Sem conexão com a internet. Verifique os dados móveis ou o Wi-Fi e tente novamente.'
        : e.codigo === 'cpf_invalido' && !dados.cpf ? 'Nesta operação o CPF ainda é obrigatório para civis. Informe o CPF e toque em COMEÇAR.'
        : e.message);
    } finally {
      estado.entrando = false;
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  }

  function salvoAtivo() {
    var s = C.local.ler(CHAVE_PART, null);
    return Boolean(s && s.token === estado.token && s.participante_id);
  }

  function salvarParticipacao(ativo, removido) {
    if (!estado.part) return;
    C.local.gravar(CHAVE_PART, {
      token: estado.token,
      participante_id: estado.part.participante_id,
      nome: estado.part.nome,
      tipo: estado.part.tipo,
      operacao: (estado.info && estado.info.operacao) || estado.part.operacao || '',
      grupo: (estado.info && estado.info.grupo) || null,
      cpf: estado.cpf || '',
      telefone: estado.telefone || '',
      ativo: Boolean(ativo),
      removido: Boolean(removido),
    });
  }

  /* ---------- Pacotes de mapa offline (servidor próprio de mapas; migração 075) ---------- */
  // Ao entrar na operação: se nenhum pacote guardado cobre o endereço dela (ou, sem endereço, a primeira posição boa do
  // participante), baixa um pacote de 10 km em volta, com zoom até 17 e as camadas configuradas. Os pacotes ficam no aparelho
  // (até 3) e valem para as próximas operações que eles cobrirem. Pode baixar sem Wi-Fi; mostra o progresso e dá para cancelar.
  var CHAVE_PACOTES = 'gbs-mapa-pacotes';
  function modelosPacote() {
    var c = window.APP_CONFIG && window.APP_CONFIG.mapaOffline;
    return c && Object.keys(c).length ? c : null;
  }
  function pacotesMapa() {
    var r = C.local.ler(CHAVE_PACOTES, null);
    return r && r.pacotes ? r.pacotes : [];
  }
  function gravarPacotes(lista) { C.local.gravar(CHAVE_PACOTES, { pacotes: lista }); }
  // O que o pacote guarda: as camadas do servidor próprio (TILES_*) ou, sem ele, o mapa vetorial gratuito (js/mapa-vetor.js).
  function fontesPacote() {
    var proprio = modelosPacote();
    if (proprio) return proprio;
    return estado.vetorUrl && window.MapaVetor ? { vetor: window.MapaVetor.MODELO } : null;
  }
  function ehVetor(modelos) { return Boolean(modelos && modelos.vetor); }
  // Zoom do pacote: o vetorial tem dados até o 15 (acima disso o desenho amplia) e começa no 8 (visão da região)
  function opcPacote(modelos, p) {
    if (ehVetor(modelos)) return { raioM: (p && p.raioM) || undefined, zoomMin: 8, zoomMax: window.MapaVetor.ZOOM_DADOS };
    return { raioM: p && p.raioM, zoomMax: p && p.zoomMax };
  }
  function modelosDoPacote(p) {
    return p && p.camadas && p.camadas.indexOf('vetor') >= 0 ? { vetor: window.MapaVetor ? window.MapaVetor.MODELO : 'https://mapa-vetor.gbs/{z}/{x}/{y}' } : modelosPacote();
  }
  function mesmoTipo(p, modelos) { return (p.camadas || []).slice().sort().join(',') === Object.keys(modelos || {}).sort().join(','); }
  function planoDoPacote(p) { var m = modelosDoPacote(p); return window.MapaOffline.planejarPacote(p.lat, p.lng, m, opcPacote(m, p)); }

  async function carregarLocalOperacao() {
    if (estado.opLocalTentado || !estado.part) return;
    estado.opLocalTentado = true;
    try {
      var r = await C.rpc('local_da_operacao', { p_participante: estado.part.participante_id }, 12000);
      if (r && r.lat != null && r.lng != null) estado.opLocal = { lat: Number(r.lat), lng: Number(r.lng), endereco: r.endereco || '' };
    } catch (e) {
      if (e && e.rede) estado.opLocalTentado = false;   // sem rede agora: tenta de novo depois (sem a migração 075, usa a posição)
    }
  }

  function verificarPacotes() {
    var M = window.MapaOffline;
    if (!M || !M.disponivel() || !estado.part || estado.finalizado || estado.mapaBaixando || estado.pacoteParado || navigator.onLine === false) return;
    if (!estado.opLocalTentado) { carregarLocalOperacao().then(function () { if (estado.opLocalTentado) verificarPacotes(); }); return; }
    var alvo = null, l = estado.ultimaLeitura;
    if (estado.opLocal) alvo = { lat: estado.opLocal.lat, lng: estado.opLocal.lng, motivo: 'endereço', rotulo: estado.opLocal.endereco || 'Local da operação' };
    else if (l && l.prec != null && l.prec <= 150) alvo = { lat: l.lat, lng: l.lng, motivo: 'posição', rotulo: 'Perto de onde você estava' };
    if (!alvo || Date.now() - (estado.mapaFalhaEm || 0) < 120000) return;
    var atuais = fontesPacote();
    var completos = pacotesMapa().filter(function (p) { return p.completo !== false && mesmoTipo(p, atuais); });
    if (M.cobre(completos, alvo.lat, alvo.lng)) return;   // um pacote que já está no aparelho cobre esta operação
    baixarPacoteMapa(alvo);
  }

  async function apagarPacoteMapa(id) {
    var M = window.MapaOffline, todos = pacotesMapa();
    var alvo = todos.filter(function (p) { return p.id === id; })[0];
    if (!alvo) return;
    var resto = todos.filter(function (p) { return p.id !== id; }), manter = {};
    resto.forEach(function (p) { planoDoPacote(p).urls.forEach(function (u) { manter[u] = true; }); });   // o que outro pacote ainda usa fica
    await M.apagarExceto(planoDoPacote(alvo).urls, manter);
    gravarPacotes(resto);
  }

  async function baixarPacoteMapa(alvo) {
    var M = window.MapaOffline, modelos = fontesPacote();
    estado.mapaBaixando = true;
    estado.cancelarPacote = false;
    var cancelar = $('mapa-offline-cancelar');
    try {
      var plano = M.planejarPacote(alvo.lat, alvo.lng, modelos, opcPacote(modelos));
      // espaço livre no aparelho (só impede quando está claramente faltando)
      if (navigator.storage && navigator.storage.estimate) {
        var e = await navigator.storage.estimate();
        if (e && e.quota && e.usage != null && e.quota - e.usage < plano.mb * 1048576 * 1.1) {
          mostrarMapaOffline('Sem espaço no celular para o mapa offline (precisa de ~' + plano.mb + ' MB livres).', true);
          estado.pacoteParado = true;
          return;
        }
      }
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { /* o sistema decide */ });
      var pacotes = pacotesMapa();
      var meu = pacotes.filter(function (p) { return mesmoTipo(p, modelos) && M.distanciaM(p.lat, p.lng, alvo.lat, alvo.lng) < 200; })[0];   // retoma o que ficou pela metade
      while (!meu && pacotes.length >= M.PACOTE.max) {   // limite de pacotes: o mais antigo sai
        var velho = pacotes.slice().sort(function (a, b) { return (a.em || 0) - (b.em || 0); })[0];
        await apagarPacoteMapa(velho.id);
        pacotes = pacotesMapa();
      }
      var pct = -1;
      var texto = function (f) {
        var p = Math.floor(f * 100 / Math.max(1, plano.total));
        if (p === pct) return;
        pct = p;
        mostrarMapaOffline('Baixando o mapa para usar sem internet… ' + p + '% (~' + plano.mb + ' MB no total)', false);
      };
      mostrarMapaOffline('Baixando o mapa para usar sem internet… 0% (~' + plano.mb + ' MB no total)', false);
      if (cancelar) { cancelar.hidden = false; cancelar.onclick = function () { estado.cancelarPacote = true; }; }
      var urlVetor = estado.vetorUrl;
      var r = await M.baixarPacote(plano.urls, { aoProgresso: texto, cancelado: function () { return estado.cancelarPacote; },
        buscar: ehVetor(modelos) ? function (u) { return window.MapaVetor.buscarResposta(urlVetor, u); } : null });
      var guardados = await M.contarGuardados(plano.urls);
      var reg = { id: meu ? meu.id : Date.now().toString(36), lat: alvo.lat, lng: alvo.lng, raioM: plano.raioM, zoomMax: plano.zoomMax, camadas: plano.camadas,
        total: plano.total, guardados: guardados, mb: plano.mb, em: Date.now(), motivo: alvo.motivo, rotulo: alvo.rotulo, completo: guardados >= plano.total,
        url: ehVetor(modelos) ? urlVetor : undefined };
      pacotes = pacotesMapa().filter(function (p) { return p.id !== reg.id; });
      if (guardados) pacotes.push(reg);
      gravarPacotes(pacotes);
      if (r.motivo === 'cancelado') { estado.pacoteParado = true; UI.aviso('Download do mapa cancelado. O que já foi baixado fica guardado.', 'ok', 6000); }
      else if (r.motivo === 'cota') { estado.pacoteParado = true; UI.aviso('O celular ficou sem espaço para o mapa offline.', 'erro', 9000); }
      else if (r.falhas) estado.mapaFalhaEm = Date.now();
    } catch (e) {
      estado.mapaFalhaEm = Date.now();
    } finally {
      estado.mapaBaixando = false;
      if (cancelar) cancelar.hidden = true;
      resumoPacotes();
    }
  }

  // Só avisa quando falta parte do mapa; tudo guardado, a linha some.
  function resumoPacotes() {
    var M = window.MapaOffline;
    if (!M || !M.disponivel()) { mostrarMapaOffline('Este navegador não guarda o mapa para uso sem internet.', true); return; }
    var falta = pacotesMapa().filter(function (p) { return p.completo === false; })[0];
    if (falta) mostrarMapaOffline('Mapa offline incompleto: ' + falta.guardados + ' de ' + falta.total + ' partes. O resto completa com internet.', true);
    else mostrarMapaOffline('', false);
  }

  // Tela "Mapas offline": os pacotes guardados, o espaço aproximado de cada um e o botão de apagar.
  function abrirMapasOffline() {
    var M = window.MapaOffline;
    var lista = UI.el('div', { classe: 'mapas-offline-lista' });
    var resumo = UI.el('p', { classe: 'muted' });
    function desenhar() {
      lista.innerHTML = '';
      var atuais = pacotesMapa(), total = 0;
      if (!atuais.length) lista.appendChild(UI.el('p', { classe: 'muted', texto: 'Nenhum mapa guardado neste aparelho ainda.' }));
      atuais.forEach(function (p) {
        total += p.mb || 0;
        lista.appendChild(UI.el('div', { classe: 'mapa-pacote' }, [
          UI.el('div', { classe: 'mapa-pacote-txt' }, [
            UI.el('strong', { texto: p.rotulo || 'Região' }),
            UI.el('small', { texto: '~' + (p.mb || 0) + ' MB · raio de ' + (p.raioM / 1000) + ' km · ' + (p.completo === false ? 'incompleto' : 'completo') + ' · ' + new Date(p.em || Date.now()).toLocaleDateString('pt-BR') })]),
          UI.el('button', { classe: 'btn btn-pequeno btn-perigo', type: 'button', texto: 'Apagar', onclick: async function () {
            await apagarPacoteMapa(p.id);
            estado.pacoteParado = true;   // apagou de propósito: não baixa de novo sozinho nesta abertura
            desenhar();
            resumoPacotes();
          } }),
        ]));
      });
      resumo.textContent = atuais.length ? 'Total guardado: ~' + total + ' MB (o celular guarda até ' + M.PACOTE.max + ' mapas; o mais antigo sai quando chega outro).' : '';
    }
    desenhar();
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Mapas offline' }),
      UI.el('p', { classe: 'muted', texto: 'Mapas guardados no celular para usar sem internet. Cada mapa cobre 10 km em volta do local da operação.' }),
      lista, resumo,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]));
  }

  /* ---------- Mapa guardado no aparelho (js/mapa-offline.js) ---------- */
  // Guarda a área em volta da primeira posição boa, de cada lugar novo (mais de 1,5 km das áreas guardadas)
  // e do destino recebido. Uma área por vez; sem internet, espera. O estado aparece embaixo do mapa.
  var CHAVE_MAPA_OFF = 'gbs-mapa-offline';
  function areasMapa() {
    var r = C.local.ler(CHAVE_MAPA_OFF, null);
    return r && estado.part && r.participante_id === estado.part.participante_id ? r.areas || [] : [];
  }
  function gravarAreasMapa(areas) {
    if (estado.part) C.local.gravar(CHAVE_MAPA_OFF, { participante_id: estado.part.participante_id, areas: areas });
  }
  function verificarMapaOffline() {
    var M = window.MapaOffline;
    if (!estado.vetorDecidido && configVetor()) { decidirMapaVetor(); return; }   // espera saber se o mapa gratuito existe
    if (fontesPacote()) { verificarPacotes(); return; }
    if (!M || !M.disponivel() || !estado.part || estado.finalizado || estado.mapaBaixando || navigator.onLine === false) return;
    var alvo = null, l = estado.ultimaLeitura;
    if (l && l.prec != null && l.prec <= 150 && M.precisaArea(areasMapa(), l.lat, l.lng)) alvo = { lat: l.lat, lng: l.lng, motivo: 'posição' };
    else if (estado.destino && estado.destino.lat != null && M.precisaArea(areasMapa(), estado.destino.lat, estado.destino.lng)) alvo = { lat: estado.destino.lat, lng: estado.destino.lng, motivo: 'destino' };
    if (!alvo || Date.now() - (estado.mapaFalhaEm || 0) < 120000) return;
    baixarAreaMapa(alvo);
  }
  async function baixarAreaMapa(alvo) {
    var M = window.MapaOffline;
    estado.mapaBaixando = true;
    var plano = M.planejarArea(alvo.lat, alvo.lng, alvo.raioM);
    mostrarMapaOffline('Guardando o mapa para usar sem internet… 0 de ' + plano.urls.length, false);
    try {
      var areas = areasMapa();
      // limite de áreas: a mais antiga sai (os quadros dela são apagados do aparelho)
      while (areas.length >= M.AREAS_MAX) {
        var velha = areas.shift();
        await M.apagar(M.planejarArea(velha.lat, velha.lng, velha.raioM).urls);
      }
      var r = await M.baixar(plano.urls, function (f, t) { mostrarMapaOffline('Guardando o mapa para usar sem internet… ' + f + ' de ' + t, false); });
      var guardados = await M.contar(plano.urls);
      if (guardados) areas.push({ lat: alvo.lat, lng: alvo.lng, raioM: plano.raioM, total: plano.urls.length, guardados: guardados, em: Date.now(), motivo: alvo.motivo });
      gravarAreasMapa(areas);
      if (r.falhas) estado.mapaFalhaEm = Date.now();
    } catch (e) {
      estado.mapaFalhaEm = Date.now();
    } finally {
      estado.mapaBaixando = false;
      resumoMapaOffline();
    }
  }
  function mostrarMapaOffline(texto, ruim) {
    var el = $('mapa-offline');
    if (!el) return;
    el.textContent = texto;
    el.hidden = !texto;
    el.classList.toggle('mapa-offline-ruim', Boolean(ruim));
  }
  // Resumo (com a conferência de quantos quadros estão de fato no aparelho)
  function resumoMapaOffline() {
    if (fontesPacote()) { resumoPacotes(); return; }
    var areas = areasMapa();
    if (!areas.length) { mostrarMapaOffline(window.MapaOffline && window.MapaOffline.disponivel() ? '' : 'Este navegador não guarda o mapa para uso sem internet.', true); return; }
    var total = 0, ok = 0;
    areas.forEach(function (a) { total += a.total; ok += a.guardados; });
    var raioKm = Math.round(areas[areas.length - 1].raioM / 100) / 10;
    var completo = ok >= total;
    if (completo) { mostrarMapaOffline('', false); return; }   // tudo guardado: não precisa avisar
    mostrarMapaOffline('🗺 Mapa incompleto no aparelho: ' + ok + ' de ' + total + ' partes. O resto completa com internet.', true);
  }

  function comecarRastreamento(posInicial) {
    C.sincronizarRelogio();
    estado.rastreando = true;
    estado.ultimoTique = Date.now();
    estado.filtro.reiniciar();
    salvarParticipacao(true);
    if (!NATIVO) abrirTrilha();
    if (posInicial) processarPosicao(posInicial);
    iniciarWatch();
    if (NATIVO) ligarNativo(); else pedirTelaLigada();
    conectarMensagens();

    if (!estado.timerSinal) estado.timerSinal = setInterval(enviarSinal, CFG.sinalVidaMs);
    var visto = C.local.ler(CHAVE_VISTO, null);
    estado.conversaVistaAte = visto && visto.participante_id === estado.part.participante_id ? visto.t : 0;
    iniciarMapa();
    carregarEquipe();
    carregarDestino();
    carregarMeusGrupos();
    if (!estado.timerEquipe) {
      estado.timerEquipe = setInterval(function () { carregarEquipe(); carregarDestino(); carregarMeusGrupos(); enviarFilaMil(); }, CFG.destinoMs);
    }
    setTimeout(function () { desenharPendentesMil(); enviarFilaMil(); }, 2000);
    carregarFilaFotos().then(function () { retomarLocaisPendentes(); processarFilaFotos(); });
    carregarMinhasFotos();
    renderizarHistorico();
    if (!estado.timerUI) estado.timerUI = setInterval(tique, 2000);
    if (!estado.timerMapaOff) estado.timerMapaOff = setInterval(verificarMapaOffline, 10000);
    resumoMapaOffline();
    setTimeout(verificarMapaOffline, 3000);
    enviarSinal();
    agendarEnvio(0);
    atualizarNotifBotao();
    atualizarUI();
  }

  // Um único observador do GPS por vez (nunca duplicado).
  function iniciarWatch() {
    if (estado.watchId != null) return;
    estado.watchIniciadoEm = Date.now();
    if (NATIVO) { estado.watchId = 'nativo'; return; }   // as leituras chegam pelo evento "leitura" do aplicativo
    estado.watchId = navigator.geolocation.watchPosition(processarPosicao, erroGps, {
      enableHighAccuracy: true,   // usa o GPS (não só Wi-Fi/antenas)
      maximumAge: 0,              // nunca aceitar posição guardada em cache
      timeout: 30000,             // sem leitura em 30 s: avisa "procurando sinal" e continua tentando
    });
  }

  function pararWatch() {
    if (estado.watchId != null) {
      if (estado.watchId !== 'nativo') navigator.geolocation.clearWatch(estado.watchId);
      estado.watchId = null;
    }
  }

  // Reinicia a leitura do GPS (depois de liberar a permissão, ligar a localização
  // ou quando o navegador para de entregar leituras).
  function religarGps(avisar) {
    if (!estado.rastreando) return;
    if (NATIVO) { ligarNativo(); return; }
    pararWatch();
    navigator.geolocation.getCurrentPosition(function (pos) {
      processarPosicao(pos);
      if (avisar) UI.aviso('Localização funcionando.', 'ok');
    }, function (err) {
      erroGps(err);
      if (avisar) UI.aviso(err.code === 1 ? 'A localização continua bloqueada para este site.' : err.code === 2 ? 'A localização do celular continua desligada.' : 'Ainda sem sinal de GPS.', 'erro', 6000);
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    iniciarWatch();
  }

  /* ------------------------------------------------------------------ */
  /* GPS                                                                  */
  /* ------------------------------------------------------------------ */
  // Toda leitura passa pelo filtro (gps.js). "atual" é o que a tela mostra como
  // posição agora; "ponto" é o que entra na trilha e vai para os bombeiros.
  function processarPosicao(pos) {
    if (!estado.rastreando) return;
    var r = estado.filtro.processar(pos);
    if (r.atual) {
      var a = r.atual;
      estado.ultimaLeitura = { lat: a.lat, lng: a.lng, prec: a.prec, recebidaEm: a.recebidaEm, t: a.t };
      estado.gps = a.prec != null && a.prec > 50 ? 'fraco' : 'ok';
      atualizarRumoGps(pos, a);
      atualizarMeuMarcador();
      agendarNavegacao();
      if (a.prec == null || a.prec <= 150) verificarRisco(a);
    }
    if (r.pontos.length && NATIVO) {
      estado.ultimoAceito = r.ponto;   // a trilha é gravada e desenhada pelo que o aplicativo guardou (evento "pontos")
    } else if (r.pontos.length) {
      estado.ultimoAceito = r.ponto;
      atualizarMinhaTrilha(r.pontos);
      var rapido = r.rapido;
      // Cada ponto tem um id único gerado aqui: o reenvio nunca duplica no servidor.
      // Primeiro é gravado no aparelho (IndexedDB); depois enviado.
      guardarPontos(r.pontos.map(function (p) {
        return { id: C.uuid(), lat: p.lat, lng: p.lng, prec: p.prec, t: p.t };
      })).then(function () {
        // 1º ponto vai na hora; depois, logo em seguida (mais rápido em veículo).
        agendarEnvio(!estado.ultimoEnviadoT ? 300 : rapido ? CFG.envioRapidoMs : CFG.envioPeMs);
      });
    }
    if (window.GBS_DEBUG_GPS) console.debug('[GPS]', r.motivo, r.atual ? Math.round(r.atual.prec || 0) + ' m' : '');
    atualizarUI();
  }

  function erroGps(err) {
    if (err.code === 1) estado.gps = 'negado';
    else if (err.code === 2) estado.gps = 'indisponivel';
    else if (!estado.ultimaLeitura || Date.now() - estado.ultimaLeitura.recebidaEm > CFG.semGpsMs) estado.gps = 'sem_sinal';
    // timeout (3) com leitura recente: falha temporária, mantém o estado
    estado.filtro.registrar(null, false, err.code === 1 ? 'negado' : err.code === 2 ? 'indisponivel' : 'sem_sinal');
    atualizarUI();
  }

  // Celular com o relógio errado: o servidor recusaria pontos "do futuro" ou de
  // antes da operação. O horário de cada ponto é convertido para o do servidor.
  function paraHoraDoServidor(lote) {
    var desvio = C.agora() - Date.now();
    if (Math.abs(desvio) < 30000) return lote;
    return lote.map(function (p) { return Object.assign({}, p, { t: Math.round(p.t + desvio) }); });
  }

  /* ------------------------------------------------------------------ */
  /* Fila offline dos pontos (IndexedDB — trilha-local.js)                */
  /* ------------------------------------------------------------------ */
  // Abre a fila deste participante. A fila da versão anterior (localStorage)
  // é passada para o IndexedDB e só depois apagada.
  function abrirTrilha() {
    if (!estado.part) return Promise.resolve(null);
    var pid = estado.part.participante_id;
    if (estado.trilha && estado.trilha.ids.participanteId === pid) return Promise.resolve(estado.trilha);
    if (estado.trilhaAbrindo && estado.trilhaAbrindo.pid === pid) return estado.trilhaAbrindo.promessa;
    var legado = estado.filaLegada && estado.filaLegada.participante_id === pid ? estado.filaLegada.pontos : null;
    var promessa = window.TrilhaLocal.abrir({
      participanteId: pid, userId: estado.userId, operacaoId: estado.part.operacao_id || null, legado: legado,
    }).then(function (f) {
      if (!estado.part || estado.part.participante_id !== pid) return null;
      estado.trilha = f;
      estado.trilhaAbrindo = null;
      if (legado) { C.local.apagar(CHAVE_FILA); estado.filaLegada = null; }
      var buf = estado.bufferPontos;
      estado.bufferPontos = [];
      return (buf.length ? f.adicionar(buf).then(avaliarGravacao) : Promise.resolve()).then(function () {
        agendarEnvio(0);
        atualizarUI();
        return f;
      });
    }).catch(function () {
      estado.trilhaAbrindo = null;   // tenta de novo no próximo ponto
      return null;
    });
    estado.trilhaAbrindo = { pid: pid, promessa: promessa };
    return promessa;
  }

  // Ponto só é "salvo" quando o aparelho confirma a gravação. Se não confirmou, o usuário é avisado
  // (no máximo uma vez por minuto) e o ponto continua na memória, sendo regravado a cada tentativa.
  function avaliarGravacao(res) {
    if (res && res.duraveis === false && Date.now() - (estado.ultimoAvisoGravacao || 0) > 60000) {
      estado.ultimoAvisoGravacao = Date.now();
      UI.aviso('Atenção: não foi possível gravar a sua localização no aparelho (pode estar sem espaço). Os pontos estão só na memória: não feche esta página.', 'erro', 12000);
    }
    return res;
  }

  function guardarPontos(pontos) {
    if (estado.trilha && estado.part && estado.trilha.ids.participanteId === estado.part.participante_id) {
      return estado.trilha.adicionar(pontos).then(avaliarGravacao);
    }
    // a fila ainda está abrindo: os pontos esperam aqui, sem limite (nenhum é descartado)
    Array.prototype.push.apply(estado.bufferPontos, pontos);
    return abrirTrilha();
  }

  function qtdPendentes() {
    return (estado.trilha ? estado.trilha.qtdPendentes() : 0) + estado.bufferPontos.length + pendentesNoApp();
  }

  // o que ainda precisa ser enviado agora (com servidor antigo, o já entregue sem confirmação espera)
  function qtdParaEnviar() {
    return (estado.trilha ? estado.trilha.qtdParaEnviar() : 0) + estado.bufferPontos.length + pendentesNoApp();
  }

  function pendentesNoApp() { return NATIVO && estado.nativo ? estado.nativo.pendentes || 0 : 0; }

  // O GPS que parou e voltou também é registrado no aparelho (só a mudança, não cada leitura)
  function registrarGpsNaFila() {
    if (!estado.trilha || !estado.rastreando) return;
    var ruim = estado.gps === 'negado' || estado.gps === 'indisponivel' || estado.gps === 'sem_sinal';
    estado.trilha.transicao('gps', ruim, { motivo: estado.gps });
  }

  function fecharTrilha() {
    estado.trilha = null;
    estado.trilhaAbrindo = null;
    estado.bufferPontos = [];
  }

  // O intervalo máximo sem ponto vem da operação (padrão 15 s).
  function aplicarIntervaloGps(s) {
    var ms = Number(s) * 1000;
    if (ms >= 5000 && ms <= 300000 && estado.filtro.cfg.intervaloParadoMs !== ms) estado.filtro.configurar({ intervaloParadoMs: ms });
  }

  /* ------------------------------------------------------------------ */
  /* Envio ao servidor                                                    */
  /* ------------------------------------------------------------------ */
  // Agenda o envio da fila. Um pedido mais cedo antecipa; um mais tarde não adia
  // o que já estava marcado (senão, andando, o envio nunca aconteceria).
  function agendarEnvio(ms) {
    var alvo = Date.now() + ms;
    if (estado.envioAgendadoPara && estado.envioAgendadoPara <= alvo) return;
    clearTimeout(estado.timerEnvio);
    estado.envioAgendadoPara = alvo;
    estado.timerEnvio = setTimeout(function () { estado.envioAgendadoPara = 0; enviarFila(); }, ms);
  }

  // Envia os pontos pendentes em lote. Um ponto só é marcado como enviado
  // depois que o servidor confirma que ele está gravado (enviar_posicoes_lote).
  async function enviarFila() {
    var fila = estado.trilha;
    if (estado.enviando || !estado.part || estado.finalizado || !fila || !fila.qtdParaEnviar()) return;
    estado.enviando = true;
    try {
      var r = await window.TrilhaLocal.enviarLote(fila, C.rpc, {
        lote: CFG.loteMaximo,
        gps: estado.rastreando ? estado.gps : null,
        ajustarHora: paraHoraDoServidor,
      });
      if (r.recusados) estado.filtro.registrar(null, false, 'servidor_recusou');
      if (r.resp && r.resp.gps_intervalo_s) aplicarIntervaloGps(r.resp.gps_intervalo_s);
      if (r.resp && r.resp.gps_lacuna_s > 0) fila.lacunaMs = r.resp.gps_lacuna_s * 1000;
      if (r.ultimoT != null && (!estado.ultimoEnviadoT || r.ultimoT > estado.ultimoEnviadoT)) estado.ultimoEnviadoT = r.ultimoT;
      marcarSucesso();
      fila.persistirPendentes();   // o que não conseguiu ser gravado no aparelho é tentado de novo
      if (fila.qtdParaEnviar()) agendarEnvio(300);
    } catch (e) {
      if (!tratarErroFatal(e)) {
        if (e.codigo === 'lote_invalido') {
          // Dados corrompidos: marca este lote como recusado para não travar a fila.
          await fila.marcarRecusados(fila.pendentes(CFG.loteMaximo).map(function (p) { return { id: p.id, motivo: 'lote_invalido' }; }));
        } else {
          marcarFalha(e);
          agendarEnvio(Math.min(30000, 2000 * Math.pow(2, Math.min(estado.falhas, 5) - 1)));
        }
      }
    } finally {
      estado.enviando = false;
      if (qtdParaEnviar() && !estado.envioAgendadoPara && !estado.finalizado) agendarEnvio(CFG.envioPeMs);
      atualizarUI();
    }
  }

  async function enviarSinal() {
    if (!estado.part || estado.finalizado) return;
    try {
      var r = await C.rpc('sinal_vida', {
        p_participante: estado.part.participante_id,
        p_rastreando: estado.rastreando,
        p_gps: estado.rastreando ? estado.gps : null,
      }, 12000);
      if (!r || r.status !== 'ativa') {
        finalizar(r && ['removido', 'inexistente', 'liberado'].indexOf(r.status) !== -1 ? r.status : 'encerrada');
        return;
      }
      if (estado.saidaSolicitadaEm && !r.saida_solicitada_em) {
        UI.aviso('Os bombeiros pediram para você continuar na busca.', 'erro', 9000);
        chamarAtencao();
      }
      estado.saidaSolicitadaEm = r.saida_solicitada_em || null;
      estado.gravarTrilha = r.gravar_trilha !== false;   // os bombeiros podem desligar a gravação do caminho desta pessoa
      if (r.gps_intervalo_s) aplicarIntervaloGps(r.gps_intervalo_s);
      marcarSucesso();
      if (qtdParaEnviar()) agendarEnvio(0);
      await buscarMensagens();
      await reenviarConfirmacoes();
      await reenviarMensagens();
      processarFilaFotos();
    } catch (e) {
      if (!tratarErroFatal(e)) marcarFalha(e);
    }
    atualizarUI();
  }

  function tratarErroFatal(e) {
    if (e.codigo === 'operacao_encerrada') { finalizar('encerrada'); return true; }
    if (e.codigo === 'participante_removido') { finalizar('removido'); return true; }
    if (e.codigo === 'participante_liberado') { finalizar('liberado'); return true; }
    if (e.codigo === 'participante_invalido') { finalizar('inexistente'); return true; }
    return false;
  }

  function marcarSucesso() {
    estado.ultimoSucesso = Date.now();
    estado.falhas = 0;
  }

  function marcarFalha() {
    estado.falhas++;
  }

  function estadoInternet() {
    if (navigator.onLine === false) return 'offline';
    if (estado.ultimoSucesso && Date.now() - estado.ultimoSucesso < 40000 && estado.falhas === 0) return 'ok';
    if (!estado.ultimoSucesso && estado.falhas === 0) return 'conectando';
    return estado.falhas >= 2 || (estado.ultimoSucesso && Date.now() - estado.ultimoSucesso >= 40000) ? 'falha' : 'conectando';
  }

  /* ------------------------------------------------------------------ */
  /* Mensagens                                                            */
  /* ------------------------------------------------------------------ */
  function conectarMensagens() {
    if (estado.canal || !estado.part) return;
    var pid = estado.part.participante_id;
    estado.canal = C.cliente
      .channel('mensagens-' + pid)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mensagens', filter: 'participante_id=eq.' + pid },
        function (carga) { if (carga.new && carga.new.id) receberMensagens([carga.new]); })
      // Destino enviado pelos bombeiros: chega na hora (o RLS só entrega o destino
      // deste participante). A consulta confirma o estado atual no servidor.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'destinos', filter: 'participante_id=eq.' + pid },
        function () { carregarDestino(); carregarEquipe(); })
      .subscribe(function (status) {
        estado.statusTempoReal = status;
        // Conectou ou reconectou: recupera o que pode ter chegado enquanto estava fora.
        if (status === 'SUBSCRIBED') { buscarMensagens(); carregarDestino(); }
      });
  }

  async function buscarMensagens() {
    if (!estado.part) return;
    try {
      var dados = await C.consultar(
        C.cliente.from('mensagens').select('*')
          .eq('participante_id', estado.part.participante_id)
          .order('criada_em', { ascending: false })
          .limit(80)
      );
      receberMensagens(dados || []);
    } catch (e) { /* tenta de novo no próximo sinal de vida */ }
  }

  function receberMensagens(lista) {
    var paraEntregar = [];
    var houveNova = false;
    var mudouPendentes = false;
    lista.forEach(function (m) {
      var antiga = estado.mensagens.get(m.id);
      estado.mensagens.set(m.id, m);
      if (m.direcao === 'entrada') {
        // algo que eu enviei: tira da fila local, se ainda estiver lá
        var antes = estado.msgPendentes.length;
        estado.msgPendentes = estado.msgPendentes.filter(function (x) { return x.client_id !== m.client_id; });
        if (estado.msgPendentes.length !== antes) mudouPendentes = true;
        return;
      }
      if (!m.entregue_em) paraEntregar.push(m.id);
      if (!antiga && !m.confirmada_em && !estado.confirmadasLocal.has(m.id) && !estado.alertadas.has(m.id)) {
        houveNova = true;
        estado.alertadas.add(m.id);
      }
    });
    if (paraEntregar.length) {
      C.rpc('marcar_entregues', { p_ids: paraEntregar }).catch(function () { /* nova tentativa depois */ });
    }
    if (mudouPendentes) salvarMsgPendentes();
    if (houveNova) chamarAtencao();
    renderizarHistorico();
    mostrarProximoAlerta();
  }

  function pendentesDeConfirmacao() {
    var lista = [];
    estado.mensagens.forEach(function (m) {
      if (m.direcao !== 'entrada' && !m.confirmada_em && !estado.confirmadasLocal.has(m.id)) lista.push(m);
    });
    return lista.sort(function (a, b) { return C.paraMs(b.criada_em) - C.paraMs(a.criada_em); });
  }

  function mostrarProximoAlerta() {
    var pend = pendentesDeConfirmacao();
    var caixa = $('alerta-msg');
    if (!pend.length) {
      caixa.hidden = true;
      estado.alertaAtual = null;
      return;
    }
    var m = pend[0];
    if (estado.alertaAtual === m.id && !caixa.hidden) {
      $('alerta-fila').textContent = pend.length > 1 ? 'Mais ' + (pend.length - 1) + ' mensagem(ns) dos bombeiros' : '';
      return;
    }
    estado.alertaAtual = m.id;
    var tipo = C.TIPOS_MENSAGEM[m.tipo] || C.TIPOS_MENSAGEM.PERSONALIZADA;
    caixa.className = 'alerta-msg alerta-' + tipo.classe;
    $('alerta-tit').textContent = tipo.titulo;
    $('alerta-texto').textContent = m.texto || tipo.padrao;
    $('alerta-meta').textContent = 'Bombeiros · às ' + C.hora(m.criada_em, false);
    var botoes = $('alerta-botoes');
    botoes.innerHTML = '';
    if (m.tipo === 'CONFIRME') {
      botoes.appendChild(UI.el('button', { classe: 'btn btn-ok btn-gigante', type: 'button', texto: 'ESTOU BEM', onclick: function () { confirmarMensagem(m.id, 'ESTOU_BEM'); } }));
      botoes.appendChild(UI.el('button', { classe: 'btn btn-primario btn-gigante', type: 'button', texto: 'PRECISO DE AJUDA', onclick: function () { confirmarMensagem(m.id, 'PRECISO_AJUDA'); } }));
    } else {
      botoes.appendChild(UI.el('button', { classe: 'btn btn-escuro btn-gigante', type: 'button', texto: 'ENTENDI', onclick: function () { confirmarMensagem(m.id, 'CIENTE'); } }));
    }
    $('alerta-fila').textContent = pend.length > 1 ? 'Mais ' + (pend.length - 1) + ' mensagem(ns) dos bombeiros' : '';
    caixa.hidden = false;
    var b = botoes.querySelector('button');
    if (b) b.focus();
  }

  async function confirmarMensagem(id, resposta) {
    estado.confirmadasLocal.add(id);
    estado.confPendentes = estado.confPendentes.filter(function (c) { return c.id !== id; });
    estado.confPendentes.push({ id: id, resposta: resposta });
    salvarConfirmacoes();
    estado.alertaAtual = null;
    mostrarProximoAlerta();
    renderizarHistorico();
    var ok = await enviarConfirmacao(id, resposta);
    if (ok) UI.aviso(resposta === 'PRECISO_AJUDA' ? 'Pedido de ajuda enviado aos bombeiros.' : 'Resposta enviada.', 'ok');
    else UI.aviso('Sem internet: a resposta vai ser enviada quando o sinal voltar.', 'erro', 7000);
  }

  async function enviarConfirmacao(id, resposta) {
    try {
      var m = await C.rpc('confirmar_mensagem', { p_mensagem: id, p_resposta: resposta });
      estado.confPendentes = estado.confPendentes.filter(function (c) { return c.id !== id; });
      salvarConfirmacoes();
      if (m && m.id) estado.mensagens.set(m.id, m);
      marcarSucesso();
      renderizarHistorico();
      return true;
    } catch (e) {
      if (!e.rede) {
        // Erro definitivo (ex.: mensagem apagada) — não tenta de novo.
        estado.confPendentes = estado.confPendentes.filter(function (c) { return c.id !== id; });
        salvarConfirmacoes();
        return true;
      }
      return false;
    }
  }

  async function reenviarConfirmacoes() {
    var copia = estado.confPendentes.slice();
    for (var i = 0; i < copia.length; i++) await enviarConfirmacao(copia[i].id, copia[i].resposta);
  }

  function salvarConfirmacoes() {
    if (!estado.part) return;
    C.local.gravar(CHAVE_CONF, { participante_id: estado.part.participante_id, itens: estado.confPendentes });
  }

  var CATEGORIAS = {
    MENSAGEM: 'Mensagem', PISTA: 'Possível pista', VESTIGIO: 'Vestígio',
    OBJETO: 'Objeto', OBSTACULO: 'Obstáculo', OUTRO: 'Outra coisa', AJUDA: 'Pedido de ajuda',
    VITIMA: 'Vítima',
  };
  // Termo neutro mostrado no celular. A condição (viva/óbito) só aparece no painel
  // dos responsáveis: o servidor nunca a devolve ao participante (RLS).
  var TEXTO_VITIMA = 'Localizada, ver protocolo';

  // Conversa: o que os bombeiros enviaram (à esquerda) e o que eu enviei (à direita).
  // Só o essencial: quem, o texto e a hora.
  function renderizarHistorico() {
    var ul = $('hist-msgs');
    var itens = Array.from(estado.mensagens.values()).map(function (m) { return { m: m, t: C.paraMs(m.criada_em) }; });
    estado.msgPendentes.forEach(function (x) { itens.push({ local: x, t: x.criada_local }); });
    itens.sort(function (a, b) { return a.t - b.t; });
    $('hist-vazio').hidden = itens.length > 0;
    var noFim = ul.scrollHeight - ul.scrollTop - ul.clientHeight < 40;
    ul.innerHTML = '';
    itens.forEach(function (it) {
      if (it.local) { ul.appendChild(bolhaMinha(it.local, null)); return; }
      var m = it.m;
      if (m.direcao === 'entrada') { ul.appendChild(bolhaMinha(null, m)); return; }
      var tipo = C.TIPOS_MENSAGEM[m.tipo] || C.TIPOS_MENSAGEM.PERSONALIZADA;
      var respondida = m.confirmada_em || estado.confirmadasLocal.has(m.id);
      var li = UI.el('li', { classe: 'bolha bolha-equipe' + (respondida ? '' : ' pendente') }, [
        UI.el('div', { classe: 'bolha-topo', texto: 'Bombeiros' + (m.tipo !== 'PERSONALIZADA' ? ' · ' + tipo.titulo : '') }),
        UI.el('div', { classe: 'bolha-texto', texto: m.texto || tipo.padrao }),
        UI.el('div', { classe: 'bolha-meta', texto: C.hora(m.criada_em, false) }),
      ]);
      if (!respondida) {
        li.appendChild(UI.el('button', {
          classe: 'btn btn-pequeno btn-escuro', type: 'button', texto: 'Responder',
          onclick: function () { estado.alertaAtual = null; mostrarProximoAlerta(); },
        }));
      }
      ul.appendChild(li);
    });
    if (noFim || itens.length < 4) ul.scrollTop = ul.scrollHeight;
    atualizarContadorConversa();
  }

  function bolhaMinha(local, m) {
    var d = m || local;
    var cat = d.categoria || 'MENSAGEM';
    var meta = m ? C.hora(m.criada_em, false) : (local.erro ? 'Não enviada' : 'Esperando internet…');
    var li = UI.el('li', { classe: 'bolha bolha-minha' + (m ? '' : ' na-fila') + (cat !== 'MENSAGEM' ? ' relato' : '') + (cat === 'AJUDA' ? ' sos' : '') }, [
      cat !== 'MENSAGEM' ? UI.el('div', { classe: 'bolha-topo', texto: CATEGORIAS[cat] || cat }) : null,
      UI.el('div', { classe: 'bolha-texto', texto: cat === 'VITIMA' ? TEXTO_VITIMA : d.texto }),
      UI.el('div', { classe: 'bolha-meta', texto: meta }),
    ]);
    if (local && local.erro) {
      li.appendChild(UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Apagar',
        onclick: async function () {
          var ok = await UI.confirmar({ titulo: 'Apagar esta mensagem?', texto: 'Ela ainda não foi enviada. Apagada, não chega à operação.', ok: 'Apagar', perigo: true });
          if (!ok) return;
          estado.msgPendentes = estado.msgPendentes.filter(function (x) { return x !== local; }); salvarMsgPendentes(); renderizarHistorico();
        } }));
    }
    return li;
  }

  /* ------------------------------------------------------------------ */
  /* Conversa: abre só quando o participante pede                         */
  /* ------------------------------------------------------------------ */
  function abrirConversa() {
    $('painel-conversa').hidden = false;
    $('btn-registrar').setAttribute('aria-expanded', 'true');
    document.body.classList.add('conversa-aberta');
    marcarConversaVista();
    renderizarHistorico();
    var ul = $('hist-msgs');
    ul.scrollTop = ul.scrollHeight;
    setTimeout(function () { $('msg-texto').focus({ preventScroll: true }); }, 50);
  }

  function fecharConversa() {
    if ($('painel-conversa').hidden) return;
    $('painel-conversa').hidden = true;
    $('btn-registrar').setAttribute('aria-expanded', 'false');
    document.body.classList.remove('conversa-aberta');
    $('btn-registrar').focus();
  }

  function marcarConversaVista() {
    estado.conversaVistaAte = Date.now();
    if (estado.part) C.local.gravar(CHAVE_VISTO, { participante_id: estado.part.participante_id, t: estado.conversaVistaAte });
    atualizarContadorConversa();
  }

  // Número no botão: mensagens dos bombeiros que chegaram depois da última vez que a conversa foi aberta.
  function atualizarContadorConversa() {
    if (!$('painel-conversa').hidden && estado.part) {
      estado.conversaVistaAte = Date.now();
      C.local.gravar(CHAVE_VISTO, { participante_id: estado.part.participante_id, t: estado.conversaVistaAte });
    }
    var n = 0;
    estado.mensagens.forEach(function (m) {
      if (m.direcao !== 'entrada' && C.paraMs(m.criada_em) > estado.conversaVistaAte) n++;
    });
    var c = $('falar-contador');
    c.textContent = String(n);
    c.hidden = !n;
    $('btn-registrar').classList.toggle('tem-novas', n > 0);
    $('btn-menu').classList.toggle('tem-novas', n > 0);   // militar: as mensagens estão no Menu
  }

  /* ------------------------------------------------------------------ */
  /* Mapa: a minha posição e a dos bombeiros                              */
  /* ------------------------------------------------------------------ */
  // Ampliar: o mapa ocupa a tela dentro deste site (não é o modo tela cheia do navegador). ✕ ou Esc voltam.
  function alternarMapaAmpliado(ligar) {
    var caixa = document.querySelector('.mapa-civil-caixa');
    if (!caixa) return;
    var ampliado = caixa.classList.contains('mapa-ampliado');
    var novo = ligar == null ? !ampliado : ligar;
    if (novo === ampliado) return;
    caixa.classList.toggle('mapa-ampliado', novo);
    $('btn-ampliar-mapa').setAttribute('aria-expanded', String(novo));
    $('btn-fechar-mapa').hidden = !novo;
    if (estado.mapa) setTimeout(function () { estado.mapa.invalidateSize(); }, 60);
  }

  function iniciarMapa() {
    if (estado.mapa) { setTimeout(function () { estado.mapa.invalidateSize(); }, 50); return; }
    if (!window.L) { document.querySelector('.mapa-civil-caixa').hidden = true; return; }
    var mapa = L.map('mapa-civil', { zoomControl: true, attributionControl: true }).setView([-15.79, -47.88], 4);
    estado.prefs = lerPrefsMapa();
    estado.bases = criarBasesMapa();
    estado.baseAtual = estado.bases[estado.prefs.base] ? estado.prefs.base : 'osm';
    estado.bases[estado.baseAtual].addTo(mapa);
    // Se a pessoa arrastar o mapa, ele para de seguir a posição (até tocar em "Onde estou").
    mapa.on('dragstart', function () { estado.seguindo = false; });
    estado.mapa = mapa;
    mapa.on('zoomend moveend', agendarDecoracoesTrilhas);
    montarCamadasCivil();
    setTimeout(function () { mapa.invalidateSize(); }, 80);
    atualizarMeuMarcador();
    if (estado.vetorUrl) usarMapaVetor(estado.vetorUrl); else decidirMapaVetor();
  }

  // Cor de quem é do seu grupo (o primeiro grupo, por nome, igual ao painel); sem grupo, a cor padrão.
  function corMinha() {
    var g = (estado.grupos || [])[0];
    return g ? g.cor : '#3b82f6';
  }

  // Sua trilha: os últimos pontos aceitos nesta sessão (a lista completa fica no aparelho e no servidor).
  var MAX_TRILHA_TELA = 300;

  function atualizarMeuMarcador() {
    var l = estado.ultimaLeitura;
    if (!estado.mapa || !l) return;
    var ll = [l.lat, l.lng];
    if (!estado.meuMarcador) {
      estado.meuCirculo = L.circle(ll, { radius: l.prec || 0, color: corMinha(), weight: 1, fillOpacity: 0.12, interactive: false }).addTo(estado.mapa);
      estado.meuMarcador = L.marker(ll, {
        icon: L.divIcon({ className: 'mk-eu-wrap', html: '<div class="mk-eu"></div><div class="mk-eu-rotulo">Você</div>', iconSize: [0, 0] }),
        keyboard: false, zIndexOffset: 1000, title: 'Você está aqui',
      }).addTo(estado.mapa);
      estado.meuMarcador.on('click', mostrarMinhasCoordenadas);
      estado.mapa.setView(ll, 16);
    } else {
      estado.meuMarcador.setLatLng(ll);
      estado.meuCirculo.setLatLng(ll);
      estado.meuCirculo.setRadius(l.prec || 0);
      if (estado.seguindo && !estado.mapa.getBounds().pad(-0.2).contains(ll)) estado.mapa.panTo(ll);
    }
    pintarMinhaCor();
  }

  // Marcador, círculo e trilha na cor do grupo (ou na padrão). Chamado também quando os grupos mudam.
  function pintarMinhaCor() {
    var cor = corMinha();
    var temGrupo = Boolean((estado.grupos || [])[0]);
    var lgGrupo = $('lg-grupo');
    if (lgGrupo) {
      lgGrupo.hidden = !temGrupo;
      if (temGrupo) lgGrupo.querySelector('i').style.background = cor;
    }
    if (estado.meuCirculo) estado.meuCirculo.setStyle({ color: cor });
    var el = estado.meuMarcador && estado.meuMarcador.getElement();
    var pastilha = el && el.querySelector('.mk-eu');
    if (pastilha) pastilha.style.background = cor;
    if (estado.linhaMinha) estado.linhaMinha.setStyle({ color: cor });
    if (estado.linhaFalhaMinha) estado.linhaFalhaMinha.setStyle({ color: cor });
  }

  // A linha da trilha é desenhada em segmentos: se o GPS ficou sem registrar por mais que o limite de falha, os dois
  // lados NÃO são ligados como se o percurso tivesse sido contínuo; o trecho sem registro aparece tracejado.
  function atualizarMinhaTrilha(pontos) {
    if (!estado.mapa || !pontos || !pontos.length) return;
    var lacunaMs = (estado.trilha && estado.trilha.lacunaMs) || 60000;
    var segs = estado.trilhaMinha = estado.trilhaMinha || [];
    var tempos = estado.temposMinha = estado.temposMinha || [];   // horário de cada ponto, na mesma forma de segs
    var falhas = estado.falhasMinha = estado.falhasMinha || [];
    var G = window.TrilhaGeo;
    pontos.forEach(function (p) {
      // dentro do raio de uma base: o ponto fica guardado e é enviado, mas a linha não passa por ali
      if (G && estado.basesTrilha && estado.basesTrilha.length && !G.dividirNaBase([p], estado.basesTrilha).length) {
        if (segs.length && segs[segs.length - 1].length) { segs.push([]); tempos.push([]); }
        estado.ultimoTMinha = null;
        return;
      }
      var seg = segs[segs.length - 1];
      if (seg && !seg.length) seg = null;
      if (seg && estado.ultimoTMinha != null && p.t - estado.ultimoTMinha > lacunaMs) {
        falhas.push([seg[seg.length - 1], [p.lat, p.lng]]);
        seg = null;
      }
      if (!seg) {
        if (segs.length && !segs[segs.length - 1].length) { seg = segs[segs.length - 1]; }
        else { seg = []; segs.push(seg); tempos.push([]); }
      }
      seg.push([p.lat, p.lng]);
      tempos[tempos.length - 1].push(p.t);
      estado.ultimoTMinha = p.t;
    });
    var total = segs.reduce(function (n, s) { return n + s.length; }, 0);
    while (total > MAX_TRILHA_TELA && segs.length) {   // só limita o que é desenhado na tela (os pontos continuam na fila)
      var sobra = total - MAX_TRILHA_TELA;
      if (segs[0].length <= sobra) { total -= segs[0].length; segs.shift(); tempos.shift(); falhas.shift(); }
      else { segs[0] = segs[0].slice(sobra); tempos[0] = tempos[0].slice(sobra); total = MAX_TRILHA_TELA; }
    }
    if (!estado.linhaMinha) {
      // Estilo AlpineQuest: contorno escuro por baixo, linha grossa e contínua, setas de sentido e a hora do início
      estado.haloMinha = L.polyline(segs, { color: '#0b1220', weight: pesoTrilhaP(6) + 3, opacity: 0.8, interactive: false, lineJoin: 'round', lineCap: 'round', className: 'trilha-halo' }).addTo(estado.mapa);
      estado.linhaMinha = L.polyline(segs, { color: corMinha(), weight: pesoTrilhaP(6), opacity: 1, interactive: false, lineJoin: 'round', lineCap: 'round' }).addTo(estado.mapa);
      estado.linhaFalhaMinha = L.polyline(falhas, { color: corMinha(), weight: 2, opacity: 0.55, dashArray: '4 8', interactive: false }).addTo(estado.mapa);
    } else {
      estado.haloMinha.setLatLngs(segs);
      estado.linhaMinha.setLatLngs(segs);
      estado.linhaFalhaMinha.setLatLngs(falhas);
    }
    agendarDecoracoesTrilhas();
  }

  /* ---------- Trilhas no estilo AlpineQuest: espessura pelo zoom e setas de sentido ---------- */
  var ESPACO_SETAS_PX = 70, MAX_SETAS = 600, ZOOM_SETAS = 15;
  function fatorZoomTrilhaP() {
    var z = estado.mapa ? estado.mapa.getZoom() : 17;
    return z >= 18 ? 1 : z >= 17 ? 0.85 : z >= 16 ? 0.7 : z >= 15 ? 0.55 : z >= 14 ? 0.45 : 0.38;
  }
  function pesoTrilhaP(base) { return Math.max(1.5, Math.round(base * fatorZoomTrilhaP() * 10) / 10); }
  // Setas brancas (uma camada só) sobre as linhas [[lat,lng]…] que aparecem na tela; peso = espessura da linha
  function criarSetasP(listaSegs, peso, anterior, opacidade) {
    var mapa = estado.mapa, G = window.TrilhaGeo;
    if (!mapa || !G || !listaSegs || !listaSegs.length || mapa.getZoom() < ZOOM_SETAS) { if (anterior) anterior.remove(); return null; }
    var vista = mapa.getBounds().pad(0.25);
    var tam = G.tamanhoSeta(peso);   // a seta cabe dentro da linha (sem ponta para fora)
    if (!tam) { if (anterior) anterior.remove(); return null; }
    var poligonos = [], total = 0;
    listaSegs.forEach(function (seg) {
      if (total >= MAX_SETAS || !seg || seg.length < 2) return;
      var px = seg.map(function (ll) { return mapa.latLngToLayerPoint(ll); });
      G.setasAoLongo(px, ESPACO_SETAS_PX, 20000).forEach(function (st) {
        if (total >= MAX_SETAS || !vista.contains(mapa.layerPointToLatLng([st.x, st.y]))) return;
        poligonos.push([G.verticesSeta(st, tam).map(function (q) { return mapa.layerPointToLatLng([q.x, q.y]); })]);
        total++;
      });
    });
    if (!poligonos.length) { if (anterior) anterior.remove(); return null; }
    var estilo = { stroke: false, fill: true, fillColor: '#ffffff', fillOpacity: opacidade, interactive: false, smoothFactor: 0, className: 'trilha-setas' };
    var camada = anterior || L.polygon(poligonos, estilo);
    if (anterior) { camada.setLatLngs(poligonos); camada.setStyle(estilo); }
    if (!mapa.hasLayer(camada)) camada.addTo(mapa);
    return camada;
  }
  function agendarDecoracoesTrilhas() {
    clearTimeout(estado.timerDecoracoes);
    estado.timerDecoracoes = setTimeout(desenharDecoracoesTrilhas, 150);
  }
  function desenharDecoracoesTrilhas() {
    var mapa = estado.mapa;
    if (!mapa) return;
    try {
      // espessuras acompanham o zoom
      if (estado.linhaMinha) { estado.linhaMinha.setStyle({ weight: pesoTrilhaP(6) }); estado.haloMinha.setStyle({ weight: pesoTrilhaP(6) + 3 }); }
      if (estado.camTrilhasEquipe) estado.camTrilhasEquipe.eachLayer(function (l) {
        if (l.options && l.options.className === 'trilha-halo') l.setStyle({ weight: pesoTrilhaP(4) + 2.5 });
        else if (l.setStyle && l.options && l.options.className === 'trilha-equipe') l.setStyle({ weight: pesoTrilhaP(4) });
      });
      // setas: as da equipe (se as trilhas da equipe estão ligadas) e as minhas, por cima
      var equipeLigada = estado.prefs.trilhas && estado.camTrilhasEquipe && mapa.hasLayer(estado.camTrilhasEquipe);
      estado.setasEquipe = criarSetasP(equipeLigada ? estado.segsEquipe : null, pesoTrilhaP(4), estado.setasEquipe, 0.85);
      estado.setasMinha = criarSetasP(estado.trilhaMinha, pesoTrilhaP(6), estado.setasMinha, 1);
      ordemTrilhasP();
    } catch (e) { /* enfeite: nunca atrapalha a trilha nem a navegação */ }
  }
  // Ordem de baixo para cima: equipe, a minha trilha (contorno, linha), as setas
  function ordemTrilhasP() {
    [estado.setasEquipe, estado.haloMinha, estado.linhaMinha, estado.setasMinha].forEach(function (l) { if (l && estado.mapa && estado.mapa.hasLayer(l) && l.bringToFront) l.bringToFront(); });
  }

  // Minhas coordenadas (para passar por telefone ou rádio aos bombeiros).
  function mostrarMinhasCoordenadas() {
    var l = estado.ultimaLeitura;
    if (!estado.mapa || !l || !window.Coords) return;
    var utm = window.Coords.formatar(l.lat, l.lng, 'utm');
    var dec = window.Coords.formatar(l.lat, l.lng, 'dec');
    var caixa = UI.el('div', { classe: 'minhas-coord' }, [
      UI.el('strong', { texto: 'Suas coordenadas' }),
      UI.el('span', { classe: 'mono', texto: dec }),
      UI.el('span', { classe: 'mono muted', texto: 'UTM ' + utm }),
      UI.el('span', { classe: 'muted', texto: 'Precisão: ' + C.precisao(l.prec) }),
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'copiar-coord', texto: 'Copiar', onclick: function () {
        var t = dec + ' (UTM ' + utm + ')';
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { UI.aviso('Coordenadas copiadas.', 'ok'); }, function () { UI.aviso(t, 'ok', 9000); });
        else UI.aviso(t, 'ok', 9000);
      } }),
    ]);
    L.popup({ className: 'popup-info-ponto', maxWidth: 280, offset: [0, -8] }).setLatLng([l.lat, l.lng]).setContent(caixa).openOn(estado.mapa);
  }

  function centralizarEmMim(aviso) {
    var l = estado.ultimaLeitura;
    if (!estado.mapa) return;
    if (!l) { if (aviso) UI.aviso('Ainda procurando o seu sinal de GPS.', 'erro'); return; }
    estado.mapa.setView([l.lat, l.lng], Math.max(estado.mapa.getZoom(), 16));
  }

  function textoIdade(s) {
    if (s < 60) return 'agora há pouco';
    var m = Math.round(s / 60);
    return 'há ' + m + ' min';
  }

  // O que o mapa do participante pode mostrar (mapa_do_participante): militares e
  // responsáveis (sem nomes), os setores atribuídos a ele, pontos de encontro e de
  // risco, e o destino enviado pelos bombeiros. A idade das posições vem do servidor.
  async function carregarEquipe() {
    if (!estado.part || estado.finalizado || !estado.mapa) return;
    var dados;
    try {
      dados = await C.rpc('mapa_do_participante', { p_participante: estado.part.participante_id }, 12000);
    } catch (e) {
      tratarErroFatal(e);
      return;
    }
    if (!estado.mapa || !dados) return;
    estado.permissoes = estado.part && estado.part.tipo === 'militar' && dados.permissoes ? dados.permissoes : {};
    atualizarFerramentasMilitar();
    desenharEquipe(dados.equipe || []);
    desenharExtras(dados.setores || [], dados.pontos || [], dados.areas_proibidas || []);
    if (Date.now() - (estado.trilhasEquipeEm || 0) > 60000) { estado.trilhasEquipeEm = Date.now(); carregarTrilhasEquipe(); }
    if (NATIVO) guardarMapaDaOperacao(dados.setores || [], dados.pontos || []);
    if (estado.destinoSemFuncao) definirDestinoServidor(dados.destino || null);   // servidor sem a migração 004
  }

  // Destino ativo: não depende do mapa (funciona mesmo se o mapa não carregar).
  // Chamado ao entrar, pelo tempo real, ao reconectar, ao voltar para a página
  // e a cada 15 s. Nunca falha em silêncio: avisa se não conseguir verificar.
  async function carregarDestino() {
    if (!estado.part || estado.finalizado || estado.buscandoDestino) return;
    estado.buscandoDestino = true;
    try {
      var d;
      if (estado.destinoSemFuncao) {
        var m = await C.rpc('mapa_do_participante', { p_participante: estado.part.participante_id }, 12000);
        d = m ? m.destino : null;
      } else {
        d = await C.rpc('meu_destino', { p_participante: estado.part.participante_id }, 12000);
      }
      estado.falhasDestino = 0;
      mostrarAvisoDestino('');
      definirDestinoServidor(d);
      if (d && d.id && estado.destinoConfirmado !== d.id && !estado.destinoSemFuncao) confirmarDestino(d.id);
    } catch (e) {
      if (tratarErroFatal(e)) return;
      if (e.codigo === 'funcao_ausente' && !estado.destinoSemFuncao) {
        // Servidor ainda sem a migração 004: usa a consulta da migração 003.
        estado.destinoSemFuncao = true;
        estado.buscandoDestino = false;
        return carregarDestino();
      }
      estado.falhasDestino++;
      if (!e.rede && estado.falhasDestino >= 2) {
        mostrarAvisoDestino('Não foi possível verificar se os bombeiros mandaram um destino (' + e.message + '). Tentando de novo…');
      }
    } finally {
      estado.buscandoDestino = false;
    }
  }

  // Grupos deste participante (só os dele; o servidor não mostra os outros membros).
  async function carregarMeusGrupos() {
    if (!estado.part || estado.finalizado || estado.semGrupos) return;
    try {
      var lista = await C.rpc('meus_grupos', { p_participante: estado.part.participante_id }, 12000);
      estado.grupos = Array.isArray(lista) ? lista : [];
      pintarMinhaCor();
      atualizarUI();
    } catch (e) {
      if (e.codigo === 'funcao_ausente') estado.semGrupos = true;   // servidor sem a migração 008
      else tratarErroFatal(e);
    }
  }

  async function confirmarDestino(id) {
    try {
      await C.rpc('confirmar_destino', { p_destino: id }, 12000);
      estado.destinoConfirmado = id;
    } catch (e) { /* tenta de novo na próxima verificação */ }
  }

  function mostrarAvisoDestino(texto) {
    var p = $('aviso-destino');
    if (p.textContent !== texto) p.textContent = texto;
    p.hidden = !texto;
  }

  // Integrantes do grupo em comum vêm com a cor do grupo (mesma regra do painel do responsável).
  function desenharEquipe(lista) {
    var vistos = new Set();
    (lista || []).forEach(function (b) {
      if (b.lat == null || b.lng == null) return;
      vistos.add(b.id);
      var resp = b.tipo === 'responsavel';
      var civil = b.tipo === 'civil';
      var antigo = b.idade_s > EQUIPE_ATUAL_S;
      var tipoCss = resp ? 'responsavel' : civil ? 'civil' : 'militar';
      var letra = resp ? 'R' : civil ? 'C' : 'M';
      var cor = b.grupo_cor || null;
      var nome = b.nome ? b.nome : civil ? 'Integrante' : resp ? 'Responsável' : 'Bombeiro';
      var rotulo = b.grupo_id ? C.esc(b.nome || '') + (antigo ? ' · ' + textoIdade(b.idade_s) : '') : (antigo ? textoIdade(b.idade_s) : '');
      var html = '<div class="mk mk-equipe ' + tipoCss + (antigo ? ' antigo' : '') + (b.grupo_papel === 'responsavel' ? ' resp-grupo' : '') + '">' +
        '<div class="simbolo simbolo-' + tipoCss + (cor ? ' em-grupo' : '') + '"' + (cor ? ' style="--cor-grupo:' + cor + ';background:' + cor + '"' : '') + '><span>' + letra + '</span></div>' +
        (rotulo ? '<div class="mk-rotulo">' + rotulo + '</div>' : '') + '</div>';
      var grupo = b.grupo_nome ? ' · grupo ' + b.grupo_nome + (b.grupo_papel === 'responsavel' ? ' (responsável)' : '') : '';
      var texto = nome + grupo + ' — ' + (antigo ? 'última posição conhecida ' + textoIdade(b.idade_s) + ' (pode não estar mais aí)' : 'posição atual');
      var mk = estado.equipe.get(b.id);
      if (!mk) {
        mk = L.marker([b.lat, b.lng], { icon: L.divIcon({ className: 'mk-wrap', html: html, iconSize: [0, 0] }), title: texto, keyboard: false, zIndexOffset: resp ? 200 : 100 });
        mk.bindPopup(C.esc(texto));   // o popup lê HTML: nomes escapados
        mk.addTo(estado.mapa);
        mk._gbsHtml = html;
        estado.equipe.set(b.id, mk);
      } else {
        mk.setLatLng([b.lat, b.lng]);
        if (mk._gbsHtml !== html) { mk.setIcon(L.divIcon({ className: 'mk-wrap', html: html, iconSize: [0, 0] })); mk._gbsHtml = html; }
        mk.setPopupContent(C.esc(texto));
        if (mk.getElement()) mk.getElement().title = texto;
      }
    });
    estado.equipe.forEach(function (mk, id) {
      if (!vistos.has(id)) { mk.remove(); estado.equipe.delete(id); }
    });
    // Na primeira vez, mostra você e a equipe juntos.
    if (!estado.jaEnquadrou && vistos.size && estado.ultimaLeitura) {
      estado.jaEnquadrou = true;
      var pts = [[estado.ultimaLeitura.lat, estado.ultimaLeitura.lng]];
      estado.equipe.forEach(function (mk) { var p = mk.getLatLng(); pts.push([p.lat, p.lng]); });
      estado.mapa.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 16 });
      estado.seguindo = false;
    }
  }

  var LETRA_PONTO = { ENCONTRO: 'E', RISCO: '!', BASE: 'B', ULTIMA_LOCALIZACAO: 'U', POSSIVEL_LOCALIZACAO: '?', VESTIGIO: 'V', VITIMA_ENCONTRADA: '✚', OUTRO: '•' };
  var RAIO_ALERTA_PADRAO = 100;   // m — área de risco sem raio definido pelos bombeiros

  // Alarme de proximidade: entrou numa área de risco ou numa área proibida marcada pelos bombeiros.
  function verificarRisco(l) {
    var caixa = $('alerta-risco');
    var dentro = null, proibida = null;
    (estado.pontosRisco || []).forEach(function (pt) {
      if (!dentro && C.distancia(l.lat, l.lng, pt.lat, pt.lng) <= (pt.raio_m || RAIO_ALERTA_PADRAO)) dentro = pt;
    });
    (estado.areasProibidas || []).forEach(function (a) {
      if (!proibida && a.pontos && a.pontos.length >= 3 && dentroDoPoligono(l.lat, l.lng, a.pontos)) proibida = a;
    });
    var alvo = proibida
      ? { id: 'proibida:' + proibida.id, texto: '⛔ Você está numa ÁREA PROIBIDA: ' + proibida.nome + (proibida.motivo ? ' (' + proibida.motivo + ')' : '') + '. Saia daqui e siga as orientações dos bombeiros.' }
      : dentro ? { id: dentro.id, texto: '⚠ Você está numa ÁREA DE RISCO: ' + dentro.titulo + '. Tenha muito cuidado e siga as orientações dos bombeiros.' } : null;
    if (alvo) {
      caixa.textContent = alvo.texto;
      caixa.hidden = false;
      if (estado.riscoAtual !== alvo.id) {
        estado.riscoAtual = alvo.id;
        try { if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]); } catch (e) { /* ignora */ }
        bipe();
        try { caixa.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignora */ }
      }
    } else if (estado.riscoAtual) {
      estado.riscoAtual = null;
      caixa.hidden = true;
      UI.aviso('Você saiu da área de risco.', 'ok');
    }
  }
  var NOME_PONTO = { ENCONTRO: 'Ponto de encontro', RISCO: 'Área de risco — cuidado', BASE: 'Base da operação', ULTIMA_LOCALIZACAO: 'Última localização conhecida',
    POSSIVEL_LOCALIZACAO: 'Possível localização', VESTIGIO: 'Vestígio', VITIMA_ENCONTRADA: 'Vítima encontrada', OUTRO: 'Ponto de interesse' };

  // Setores (o seu em destaque; os públicos mais leves), áreas proibidas e pontos de interesse (os públicos ganham "Rota até aqui").
  function desenharExtras(setores, pontos, proibidas) {
    if (!estado.camSetores) {
      estado.camSetores = L.layerGroup();
      estado.camPontos = L.layerGroup();
      estado.camProibidas = L.layerGroup();
      aplicarCamadasVisiveis();
    }
    var assinatura = JSON.stringify([setores, pontos, proibidas]);
    if (estado.assinaturaExtras === assinatura) return;
    estado.assinaturaExtras = assinatura;
    estado.camSetores.clearLayers();
    estado.camPontos.clearLayers();
    estado.camProibidas.clearLayers();
    var perm = estado.permissoes || {};
    setores.forEach(function (st) {
      var meu = st.meu === undefined ? true : st.meu;   // servidor antigo: só vinham os atribuídos a mim
      var estilo = meu
        ? { color: st.cor, weight: 3.5, opacity: 1, lineJoin: 'round', fillColor: st.cor, fillOpacity: st.status === 'concluido' ? 0.08 : 0.16 }   // contorno contínuo e forte (não parece trilha)
        : { color: st.cor, weight: 2.5, opacity: 0.9, lineJoin: 'round', fillColor: st.cor, fillOpacity: 0.10 };
      var camada = st.forma === 'circulo' ? L.circle([st.centro_lat, st.centro_lng], Object.assign({ radius: st.raio_m }, estilo)) : L.polygon(st.pontos || [], estilo);
      var gerencia = perm.situacao_setor || (perm.setores && st.meu_criado);
      if (meu) camada.bindTooltip('Seu setor: ' + C.esc(st.nome), { permanent: true, direction: 'center', className: 'rotulo-setor' });
      else if (st.meu_criado) camada.bindTooltip(C.esc(st.nome), { permanent: true, direction: 'center', className: 'rotulo-setor' });
      if (gerencia) camada.bindPopup(function () { return corpoSetorMilitar(st); });
      else if (meu) camada.options.interactive = false;
      else camada.bindPopup('Setor: ' + C.esc(st.nome) + (st.status === 'concluido' ? ' · concluído' : ''));
      camada.addTo(estado.camSetores);
    });
    estado.areasProibidas = proibidas || [];
    estado.areasProibidas.forEach(function (a) {
      if (!a.pontos || a.pontos.length < 3) return;
      var pol = L.polygon(a.pontos, { color: '#dc2626', weight: 3, fillColor: '#dc2626', fillOpacity: 0.22, dashArray: '4 6', className: 'area-proibida-civil' });
      pol.bindTooltip('⛔ Proibido: ' + C.esc(a.nome), { permanent: true, direction: 'center', className: 'rotulo-proibida' });
      pol.bindPopup('<strong>⛔ Área proibida: ' + C.esc(a.nome) + '</strong>' + (a.motivo ? '<br>' + C.esc(a.motivo) : '') + '<br>Não entre nesta área.');
      pol.addTo(estado.camProibidas);
    });
    estado.pontosRisco = pontos.filter(function (pt) { return pt.categoria === 'RISCO'; });
    estado.pontosRisco.forEach(function (pt) {
      L.circle([pt.lat, pt.lng], { radius: pt.raio_m || RAIO_ALERTA_PADRAO, color: '#ef4444', weight: 2, dashArray: '6 6', fillColor: '#ef4444', fillOpacity: 0.1, interactive: false, className: 'circulo-risco' }).addTo(estado.camPontos);
    });
    // Base: o raio (padrão 50 m) aparece bem discreto; dentro dele o caminho continua gravado, mas não é desenhado.
    estado.basesTrilha = pontos.filter(function (pt) { return pt.categoria === 'BASE'; }).map(function (pt) { return { lat: pt.lat, lng: pt.lng, raio_m: pt.raio_m || 50 }; });
    pontos.filter(function (pt) { return pt.categoria === 'BASE'; }).forEach(function (pt) {
      L.circle([pt.lat, pt.lng], { radius: pt.raio_m || 50, color: '#0ea5e9', weight: 1, opacity: 0.35, dashArray: '2 6', fill: false, interactive: false, className: 'circulo-base-participante' }).addTo(estado.camPontos);
    });
    pontos.forEach(function (pt) {
      var nomeCat = NOME_PONTO[pt.categoria] || 'Ponto de interesse';
      var corpo = UI.el('div', { classe: 'popup-ponto' }, [
        UI.el('strong', { texto: nomeCat + ': ' + pt.titulo }),
        pt.descricao ? UI.el('p', { texto: pt.descricao }) : null,
        pt.publico !== false ? UI.el('button', { classe: 'btn btn-pequeno btn-primario', type: 'button', texto: '🧭 Rota até aqui', onclick: function () { estado.mapa.closePopup(); rotaAtePonto(pt); } }) : null,
        pt.meu_criado && perm.pontos ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '✎ Editar ponto', onclick: function () { estado.mapa.closePopup(); editarPontoMilitar(pt); } }) : null,
        pt.meu_criado && perm.pontos ? UI.el('button', { classe: 'btn btn-pequeno btn-perigo', type: 'button', texto: '🗑 Excluir ponto', onclick: function () { estado.mapa.closePopup(); excluirPontoMilitar(pt); } }) : null,
      ]);
      L.marker([pt.lat, pt.lng], {
        icon: L.divIcon({ className: 'mk-poi-wrap', html: '<div class="mk-poi poi-' + C.esc(pt.categoria) + '"><span>' + (LETRA_PONTO[pt.categoria] || '•') + '</span></div><div class="mk-poi-rotulo">' + C.esc(pt.titulo) + '</div>', iconSize: [0, 0] }),
        title: nomeCat + ': ' + pt.titulo, keyboard: false,
      }).bindPopup(corpo).addTo(estado.camPontos);
    });
    var lgP = $('lg-proibida');
    if (lgP) lgP.hidden = !estado.areasProibidas.length || !estado.prefs.proibidas;
  }


  /* ------------------------------------------------------------------ */
  /* Ferramentas do militar (migração 072): criar setores, situação dos   */
  /* setores e pontos de interesse, conforme o responsável liberar.       */
  /* ------------------------------------------------------------------ */
  var STATUS_SETOR_P = { pendente: 'Pendente', andamento: 'Em andamento', concluido: 'Concluído' };
  var CATS_PONTO_MILITAR = ['VESTIGIO', 'POSSIVEL_LOCALIZACAO', 'RISCO', 'ENCONTRO', 'BASE', 'OUTRO'];

  function atualizarFerramentasMilitar() {
    var perm = estado.permissoes || {};
    var caixa = $('ferramentas-militar');
    if (!caixa) return;
    var algum = Boolean(perm.setores || perm.pontos || perm.situacao_setor);
    caixa.hidden = !algum;
    $('fm-setor').hidden = !perm.setores;
    $('fm-ponto').hidden = !perm.pontos;
    $('fm-dica').textContent = perm.situacao_setor ? 'Toque num setor do mapa para mudar a situação dele (pendente, em andamento ou concluído).' : '';
  }

  function corpoSetorMilitar(st) {
    var perm = estado.permissoes || {};
    var botoes = [];
    if (perm.situacao_setor) {
      Object.keys(STATUS_SETOR_P).forEach(function (k) {
        botoes.push(UI.el('button', { classe: 'btn btn-pequeno' + (st.status === k ? ' btn-ativo' : ''), type: 'button', 'data-status': k, disabled: st.status === k ? true : null,
          texto: STATUS_SETOR_P[k], onclick: function () { estado.mapa.closePopup(); salvarSetorMilitar(st.id, { status: k }, 'Situação do setor: ' + STATUS_SETOR_P[k] + '.'); } }));
      });
    }
    if (perm.setores && st.meu_criado) {
      botoes.push(UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '✎ Editar setor', onclick: function () { estado.mapa.closePopup(); editarSetorMilitar(st); } }));
      botoes.push(UI.el('button', { classe: 'btn btn-pequeno btn-perigo', type: 'button', texto: '🗑 Excluir setor', onclick: function () { estado.mapa.closePopup(); excluirSetorMilitar(st); } }));
    }
    return UI.el('div', { classe: 'popup-setor-militar' }, [
      UI.el('strong', { texto: 'Setor ' + st.nome }),
      UI.el('p', { classe: 'muted', texto: 'Situação: ' + (STATUS_SETOR_P[st.status] || st.status) + (st.meu_criado ? ' · criado por você' : '') }),
      UI.el('div', { classe: 'popup-botoes' }, botoes),
    ]);
  }

  function erroMilitar(e) {
    UI.aviso(e && e.codigo === 'funcao_ausente' ? 'O servidor ainda não tem esta função (migração 072).' : ((e && e.message) || 'Erro inesperado.'), 'erro', 8000);
  }
  function recarregarMapaMilitar() { estado.assinaturaExtras = null; carregarEquipe(); }

  /* ---------- Ações do militar sem internet: fila no aparelho ---------- */
  // Criar, editar, excluir e mudar a situação de setores e pontos funcionam sem internet: a ação fica guardada no
  // aparelho (sobrevive a recarregar a página) e é enviada na ordem em que foi feita assim que a internet volta.
  // O que foi criado sem internet aparece no mapa tracejado, como "aguardando internet". Um item criado sem internet
  // já nasce com o id do aparelho (novo_id, migração 078), e as ações seguintes sobre ele usam esse id.
  var CHAVE_FILA_MIL = 'gbs-fila-militar';
  var AVISO_GUARDADO = 'Sem internet: guardado no celular. Vai ser enviado sozinho quando a internet voltar.';
  function filaMil() {
    var r = C.local.ler(CHAVE_FILA_MIL, null);
    return r && estado.part && r.participante_id === estado.part.participante_id && Array.isArray(r.itens) ? r.itens : [];
  }
  function gravarFilaMil(itens) {
    if (estado.part) C.local.gravar(CHAVE_FILA_MIL, { participante_id: estado.part.participante_id, itens: itens });
    desenharPendentesMil();
  }
  function semRede(e) { return navigator.onLine === false || Boolean(e && e.rede); }

  // Faz a ação no servidor; sem internet (ou com outras ações ainda na fila, para manter a ordem) guarda no aparelho.
  // Devolve { estado: 'ok', r } ou { estado: 'guardado' }; erro do servidor (permissão, dados) é lançado.
  async function acaoMilitar(fn, args, rotulo, extra) {
    if (!filaMil().length && navigator.onLine !== false) {
      try {
        var r = await C.rpc(fn, Object.assign({ p_participante: estado.part.participante_id }, args), 20000);
        return { estado: 'ok', r: r };
      } catch (e) {
        if (!semRede(e)) throw e;
      }
    }
    var itens = filaMil();
    itens.push(Object.assign({ cid: C.uuid(), fn: fn, args: args, rotulo: rotulo, em: Date.now() }, extra || {}));
    gravarFilaMil(itens);
    agendarFilaMil();
    return { estado: 'guardado' };
  }

  function agendarFilaMil() {
    clearTimeout(estado.timerFilaMil);
    estado.timerFilaMil = setTimeout(enviarFilaMil, 15000);
  }
  // Envia a fila na ordem. Para no primeiro problema de rede (tenta de novo depois); erro do servidor descarta só aquela ação.
  async function enviarFilaMil() {
    if (estado.enviandoFilaMil || !estado.part || navigator.onLine === false) return;
    if (!filaMil().length) return;
    estado.enviandoFilaMil = true;
    var enviados = 0, recusados = [];
    try {
      for (;;) {
        var itens = filaMil();
        if (!itens.length) break;
        var it = itens[0], r;
        try {
          r = await C.rpc(it.fn, Object.assign({ p_participante: estado.part.participante_id }, it.args), 20000);
        } catch (e) {
          if (semRede(e)) { agendarFilaMil(); break; }
          recusados.push((it.rotulo || 'ação') + ': ' + ((e && e.message) || 'erro'));
          r = undefined;
        }
        itens = filaMil().filter(function (x) { return x.cid !== it.cid; });
        // servidor sem a migração 078 cria outro id: as ações seguintes passam a usar o id de verdade
        if (r && it.novoId && r.id && r.id !== it.novoId) {
          itens.forEach(function (x) { if (x.args && x.args.p_id === it.novoId) x.args.p_id = r.id; });
        }
        if (r !== undefined) enviados++;
        gravarFilaMil(itens);
      }
    } finally {
      estado.enviandoFilaMil = false;
    }
    if (enviados) { UI.aviso('Internet de volta: ' + enviados + (enviados === 1 ? ' ação feita sem internet foi enviada.' : ' ações feitas sem internet foram enviadas.'), 'ok', 7000); recarregarMapaMilitar(); }
    if (recusados.length) UI.aviso('Não foi possível enviar: ' + recusados.join(' · '), 'erro', 12000);
  }

  // O que foi criado sem internet e ainda não foi enviado: tracejado no mapa, com o aviso.
  function desenharPendentesMil() {
    var itens = filaMil();
    var caixa = $('fm-pendentes');
    if (caixa) {
      caixa.hidden = !itens.length;
      caixa.textContent = itens.length ? '⏳ ' + itens.length + (itens.length === 1 ? ' ação aguardando internet' : ' ações aguardando internet') + ' (vão ser enviadas sozinhas).' : '';
    }
    if (!estado.mapa || !window.L) return;
    if (!estado.camPendMil) estado.camPendMil = L.layerGroup().addTo(estado.mapa);
    estado.camPendMil.clearLayers();
    var excluidos = {};
    itens.forEach(function (it) { if (/excluir/.test(it.fn) && it.args) excluidos[it.args.p_id] = true; });
    itens.forEach(function (it) {
      if (!it.novoId || excluidos[it.novoId]) return;
      var d = (it.args && it.args.p_dados) || {};
      var estilo = { color: '#f59e0b', weight: 3, dashArray: '6 6', fillOpacity: 0.08, interactive: true };
      var c = null;
      if (it.fn === 'participante_salvar_setor') {
        if (d.forma === 'circulo') c = L.circle([d.centro_lat, d.centro_lng], Object.assign({ radius: d.raio_m }, estilo));
        else if (d.pontos) c = L.polygon(d.pontos, estilo);
      } else if (it.fn === 'participante_salvar_ponto') {
        c = L.circleMarker([d.lat, d.lng], { radius: 9, color: '#f59e0b', weight: 3, dashArray: '3 3', fillColor: '#0b1220', fillOpacity: 0.8 });
      }
      if (c) c.bindTooltip(C.esc(d.nome || d.titulo || 'Novo') + ' · aguardando internet', { direction: 'top' }).addTo(estado.camPendMil);
    });
  }

  async function salvarSetorMilitar(id, dados, msg) {
    var novo = !id;
    var novoId = novo ? C.uuid() : null;
    if (novo) dados = Object.assign({ novo_id: novoId }, dados);
    try {
      var r = await acaoMilitar('participante_salvar_setor', { p_id: id || null, p_dados: dados },
        novo ? 'novo setor "' + (dados.nome || '') + '"' : 'setor', novo ? { novoId: novoId } : null);
      if (r.estado === 'guardado') UI.aviso(AVISO_GUARDADO, 'ok', 8000);
      else { UI.aviso(msg || 'Setor salvo.', 'ok', 6000); recarregarMapaMilitar(); }
      return true;
    } catch (e) { erroMilitar(e); return false; }
  }
  async function excluirSetorMilitar(st) {
    var ok = await UI.confirmar({ titulo: 'Excluir o setor "' + st.nome + '"?', texto: 'Ele some do mapa de todos. Só dá para excluir os setores que você criou.', ok: 'Excluir setor', perigo: true });
    if (!ok) return;
    try {
      var r = await acaoMilitar('participante_excluir_setor', { p_id: st.id }, 'excluir o setor "' + st.nome + '"');
      if (r.estado === 'guardado') UI.aviso(AVISO_GUARDADO, 'ok', 8000);
      else { UI.aviso('Setor excluído.', 'ok'); recarregarMapaMilitar(); }
    } catch (e) { erroMilitar(e); }
  }
  // Edição do que o militar criou (migração 074): ponto (tipo, título, descrição) e setor (nome, observações).
  // Trilhas não são editadas pelo militar. O servidor confere de novo que foi ele quem criou.
  function editarPontoMilitar(pt) {
    var cats = CATS_PONTO_MILITAR.indexOf(pt.categoria) >= 0 ? CATS_PONTO_MILITAR : CATS_PONTO_MILITAR.concat([pt.categoria]);
    var cat = UI.el('select', { classe: 'campo', id: 'em-ponto-cat' }, cats.map(function (k) { return UI.el('option', { value: k, texto: NOME_PONTO[k] || k }); }));
    cat.value = pt.categoria;
    var titulo = UI.el('input', { classe: 'campo', id: 'em-ponto-titulo', maxlength: '80' });
    titulo.value = pt.titulo || '';
    var desc = UI.el('textarea', { classe: 'campo', id: 'em-ponto-desc', rows: '3', maxlength: '1000' });
    desc.value = pt.descricao || '';
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var fechar = UI.abrirModal(UI.el('form', { classe: 'form-padrao', novalidate: true, onsubmit: async function (ev) {
      ev.preventDefault();
      var t = titulo.value.trim();
      if (!t) { erro.textContent = 'Informe o título do ponto.'; erro.hidden = false; return; }
      try {
        var r = await acaoMilitar('participante_editar_ponto', { p_id: pt.id, p_dados: { categoria: cat.value, titulo: t, descricao: desc.value.trim() } }, 'editar o ponto "' + t + '"');
        fechar();
        if (r.estado === 'guardado') UI.aviso(AVISO_GUARDADO, 'ok', 8000);
        else { UI.aviso('Ponto salvo.', 'ok', 6000); recarregarMapaMilitar(); }
      } catch (e) { erroMilitar(e); }
    } }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Editar ponto' }),
      UI.campo('Tipo', cat, { para: 'em-ponto-cat' }),
      UI.campo('Título', titulo, { para: 'em-ponto-titulo' }),
      UI.campo('Descrição', desc, { para: 'em-ponto-desc' }),
      erro,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'em-ponto-salvar', texto: 'Salvar' })]),
    ]));
    setTimeout(function () { try { titulo.focus(); } catch (e) { /* */ } }, 50);
  }

  function editarSetorMilitar(st) {
    var nome = UI.el('input', { classe: 'campo', id: 'em-setor-nome', maxlength: '60' });
    nome.value = st.nome || '';
    var obs = UI.el('textarea', { classe: 'campo', id: 'em-setor-obs', rows: '3', maxlength: '500' });
    obs.value = st.observacoes || '';
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var fechar = UI.abrirModal(UI.el('form', { classe: 'form-padrao', novalidate: true, onsubmit: async function (ev) {
      ev.preventDefault();
      var n = nome.value.trim();
      if (!n) { erro.textContent = 'Informe o nome do setor.'; erro.hidden = false; return; }
      if (await salvarSetorMilitar(st.id, { nome: n, observacoes: obs.value.trim() }, 'Setor salvo.')) fechar();
    } }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Editar setor' }),
      UI.campo('Nome do setor', nome, { para: 'em-setor-nome' }),
      UI.campo('Observações', obs, { para: 'em-setor-obs' }),
      erro,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'em-setor-salvar', texto: 'Salvar' })]),
    ]));
    setTimeout(function () { try { nome.focus(); } catch (e) { /* */ } }, 50);
  }

  async function excluirPontoMilitar(pt) {
    var ok = await UI.confirmar({ titulo: 'Excluir o ponto "' + pt.titulo + '"?', texto: 'Ele some do mapa de todos. Só dá para excluir os pontos que você marcou.', ok: 'Excluir ponto', perigo: true });
    if (!ok) return;
    try {
      var r = await acaoMilitar('participante_excluir_ponto', { p_id: pt.id }, 'excluir o ponto "' + pt.titulo + '"');
      if (r.estado === 'guardado') UI.aviso(AVISO_GUARDADO, 'ok', 8000);
      else { UI.aviso('Ponto excluído.', 'ok'); recarregarMapaMilitar(); }
    } catch (e) { erroMilitar(e); }
  }

  // Desenho no mapa: "setor" = tocar os cantos (3 ou mais); "circulo" e "ponto" = tocar o lugar (ou usar a minha posição).
  // Escolha do setor (padrão do painel dos responsáveis): desenhar a área ou por círculo
  function escolherTipoSetorP() {
    var fechar = UI.abrirModal(UI.el('div', { classe: 'escolha-setor-p' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Novo setor' }),
      UI.el('div', { classe: 'opcoes-setor-p' }, [
        UI.el('button', { classe: 'opcao-setor-p', type: 'button', id: 'setor-p-desenhar', onclick: function () { fechar(true); iniciarDesenhoP('setor'); } }, [
          UI.el('span', { classe: 'opcao-setor-p-ico', 'aria-hidden': 'true', texto: '▱' }),
          UI.el('strong', { texto: 'Desenhar a área' }), UI.el('small', { texto: 'toque nos cantos do setor no mapa' })]),
        UI.el('button', { classe: 'opcao-setor-p', type: 'button', id: 'setor-p-circulo', onclick: function () { fechar(true); iniciarDesenhoP('circulo'); } }, [
          UI.el('span', { classe: 'opcao-setor-p-ico', 'aria-hidden': 'true', texto: '◯' }),
          UI.el('strong', { texto: 'Em círculo' }), UI.el('small', { texto: 'toque no centro e informe o raio' })]),
      ]),
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } })]),
    ]));
  }

  function iniciarDesenhoP(tipo) {
    if (!estado.mapa) return;
    sairDesenhoP();
    var d = estado.desenhoP = { tipo: tipo, pts: [], camada: L.layerGroup().addTo(estado.mapa) };
    var caixa = document.querySelector('.mapa-civil-caixa') || estado.mapa.getContainer().parentNode;
    var texto = UI.el('span', { classe: 'barra-desenho-p-txt' });
    var bDesfazer = UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'dp-desfazer', texto: '↶ Desfazer', onclick: function () { d.pts.pop(); redesenhar(); } });
    var bAqui = UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'dp-aqui', texto: '📍 Minha posição', onclick: function () {
      var l = estado.ultimaLeitura;
      if (!l) { UI.aviso('Sem a sua posição ainda. Toque no mapa.', 'erro'); return; }
      tocar({ latlng: L.latLng(l.lat, l.lng) });
    } });
    var bOk = UI.el('button', { classe: 'btn btn-pequeno btn-ok', type: 'button', id: 'dp-concluir', texto: '✔ Concluir', onclick: function () { concluir(); } });
    var bSair = UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'dp-cancelar', texto: '✕', 'aria-label': 'Cancelar', onclick: function () { sairDesenhoP(); } });
    d.barra = UI.el('div', { classe: 'barra-desenho-p', id: 'barra-desenho-p', role: 'status' }, [texto, tipo === 'setor' ? bDesfazer : bAqui, tipo === 'setor' ? bOk : null, bSair]);
    caixa.appendChild(d.barra);
    estado.mapa.getContainer().classList.add('desenhando-p');
    function redesenhar() {
      d.camada.clearLayers();
      d.pts.forEach(function (q) { L.circleMarker(q, { radius: 6, color: '#0b1220', weight: 2, fillColor: '#f59e0b', fillOpacity: 1, interactive: false }).addTo(d.camada); });
      if (d.pts.length >= 2) L.polygon(d.pts, { color: '#f59e0b', weight: 3, fillOpacity: 0.12, dashArray: d.pts.length < 3 ? '6 6' : null, interactive: false }).addTo(d.camada);
      texto.textContent = tipo === 'setor' ? (d.pts.length < 3 ? 'Toque os cantos do setor no mapa (' + d.pts.length + ' de pelo menos 3)' : d.pts.length + ' cantos · toque Concluir')
        : tipo === 'circulo' ? 'Toque no mapa o centro do setor' : 'Toque no mapa onde fica o ponto';
      bDesfazer.disabled = !d.pts.length;
      bOk.disabled = d.pts.length < 3;
    }
    function tocar(ev) {
      if (estado.desenhoP !== d) return;
      var q = [Math.round(ev.latlng.lat * 1e7) / 1e7, Math.round(ev.latlng.lng * 1e7) / 1e7];
      if (tipo === 'setor') { if (d.pts.length < 300) d.pts.push(q); redesenhar(); return; }
      d.pts = [q];
      redesenhar();
      concluir();
    }
    d.aoClicar = tocar;
    estado.mapa.on('click', tocar);
    redesenhar();
    async function concluir() {
      if (tipo === 'setor') {
        if (d.pts.length < 3) return;
        var nome = await UI.confirmar({ titulo: 'Novo setor', ok: 'Criar setor', texto: d.pts.length + ' cantos marcados. O setor aparece para os responsáveis no painel.',
          campo: { rotulo: 'Nome do setor', valor: '', max: 60, obrigatorio: true } });
        if (!nome) return;
        if (await salvarSetorMilitar(null, { nome: nome.texto.trim(), forma: 'poligono', pontos: d.pts }, 'Setor "' + nome.texto.trim() + '" criado.')) sairDesenhoP();
      } else if (tipo === 'circulo') {
        formCirculo(d.pts[0]);
      } else {
        formPontoMilitar(d.pts[0]);
      }
    }
  }

  function sairDesenhoP() {
    var d = estado.desenhoP;
    if (!d) return;
    estado.desenhoP = null;
    if (estado.mapa) { estado.mapa.off('click', d.aoClicar); estado.mapa.getContainer().classList.remove('desenhando-p'); }
    if (d.camada) d.camada.remove();
    if (d.barra) d.barra.remove();
  }

  function formCirculo(centro) {
    var nome = UI.el('input', { classe: 'campo', id: 'fm-circ-nome', maxlength: '60', required: true });
    var raio = UI.el('input', { classe: 'campo', id: 'fm-circ-raio', type: 'number', min: '5', max: '50000', step: '5', value: '200', inputmode: 'numeric' });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var fechar = UI.abrirModal(UI.el('form', { classe: 'form-padrao', novalidate: true, onsubmit: async function (ev) {
      ev.preventDefault();
      var n = nome.value.trim(), r = Number(raio.value);
      if (!n) { erro.textContent = 'Informe o nome do setor.'; erro.hidden = false; return; }
      if (!(r >= 5 && r <= 50000)) { erro.textContent = 'O raio vai de 5 a 50000 m.'; erro.hidden = false; return; }
      if (await salvarSetorMilitar(null, { nome: n, forma: 'circulo', centro_lat: centro[0], centro_lng: centro[1], raio_m: r }, 'Setor "' + n + '" criado.')) { fechar(); sairDesenhoP(); }
    } }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Novo setor em círculo' }),
      UI.campo('Nome do setor', nome, { para: 'fm-circ-nome' }),
      UI.campo('Raio (m)', raio, { para: 'fm-circ-raio' }),
      erro,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'fm-circ-salvar', texto: 'Criar setor' })]),
    ]));
    setTimeout(function () { try { nome.focus(); } catch (e) { /* */ } }, 50);
  }

  function formPontoMilitar(local) {
    var cat = UI.el('select', { classe: 'campo', id: 'fm-ponto-cat' }, CATS_PONTO_MILITAR.map(function (k) { return UI.el('option', { value: k, texto: NOME_PONTO[k] || k }); }));
    var titulo = UI.el('input', { classe: 'campo', id: 'fm-ponto-titulo', maxlength: '80' });
    var desc = UI.el('textarea', { classe: 'campo', id: 'fm-ponto-desc', rows: '3', maxlength: '1000' });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var fechar = UI.abrirModal(UI.el('form', { classe: 'form-padrao', novalidate: true, onsubmit: async function (ev) {
      ev.preventDefault();
      var t = titulo.value.trim() || (NOME_PONTO[cat.value] || 'Ponto');
      try {
        var novoId = C.uuid();
        var r = await acaoMilitar('participante_salvar_ponto', { p_dados: { novo_id: novoId, categoria: cat.value, titulo: t, descricao: desc.value.trim(), lat: local[0], lng: local[1] } },
          'novo ponto "' + t + '"', { novoId: novoId });
        fechar();
        sairDesenhoP();
        if (r.estado === 'guardado') UI.aviso(AVISO_GUARDADO, 'ok', 8000);
        else { UI.aviso('Ponto "' + t + '" marcado. A equipe e os responsáveis já veem.', 'ok', 6000); recarregarMapaMilitar(); }
      } catch (e) { erro.textContent = e.codigo === 'funcao_ausente' ? 'O servidor ainda não tem esta função (migração 072).' : ((e && e.message) || 'Erro inesperado.'); erro.hidden = false; }
    } }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Marcar ponto de interesse' }),
      UI.campo('Tipo', cat, { para: 'fm-ponto-cat' }),
      UI.campo('Nome', titulo, { para: 'fm-ponto-titulo' }),
      UI.campo('Descrição (opcional)', desc, { para: 'fm-ponto-desc' }),
      erro,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'fm-ponto-salvar', texto: 'Marcar ponto' })]),
    ]));
  }

  /* ------------------------------------------------------------------ */
  /* Camadas do mapa, tema, trilhas da equipe, rota até um ponto e SOS    */
  /* ------------------------------------------------------------------ */
  var CHAVE_PREFS_CIVIL = 'gbs-civil-mapa';
  var CHAVE_TEMA_CIVIL = 'gbs-civil-tema';
  var PADRAO_PREFS = { base: 'osm', setores: true, pontos: true, proibidas: true, trilhas: true };   // abre no mapa de ruas; o satélite fica na escolha de Camadas
  var COR_TRILHA_EQUIPE = '#8aa0b8';   // única cor para as trilhas dos outros; a sua usa a cor do grupo (ou azul)

  function lerPrefsMapa() {
    var salvo = {};
    try { salvo = JSON.parse(localStorage.getItem(CHAVE_PREFS_CIVIL) || 'null') || {}; } catch (e) { salvo = {}; }
    var p = Object.assign({}, PADRAO_PREFS, salvo);
    // o mapa de ruas abre sempre; um fundo guardado só vale se a pessoa escolheu outro de propósito
    if (!salvo.baseEscolhida) p.base = PADRAO_PREFS.base;
    return p;
  }
  function gravarPrefsMapa() {
    try { localStorage.setItem(CHAVE_PREFS_CIVIL, JSON.stringify(estado.prefs)); } catch (e) { /* sem armazenamento: vale nesta tela */ }
  }
  function temaCivil() { return document.documentElement.getAttribute('data-tema') === 'claro' ? 'claro' : 'escuro'; }
  function aplicarTemaCivil(valor) {
    document.documentElement.setAttribute('data-tema', valor === 'claro' ? 'claro' : 'escuro');
    try { localStorage.setItem(CHAVE_TEMA_CIVIL, valor === 'claro' ? 'claro' : 'escuro'); } catch (e) { /* sem armazenamento */ }
    if (estado.vetorUrl) usarMapaVetor(estado.vetorUrl);   // o mapa de ruas acompanha o tema (claro ou escuro)
  }

  // Fundo do mapa (mapa, relevo ou satélite): o mesmo conjunto do painel dos bombeiros.
  function criarBasesMapa() {
    var bases = {
      osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxNativeZoom: 19, maxZoom: 22,
        crossOrigin: true,   // resposta CORS: pode ser guardada para o mapa funcionar sem internet (sw.js)
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }),
      topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxNativeZoom: 17, maxZoom: 19, subdomains: 'abc',
        attribution: '&copy; OpenStreetMap, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
      }),
      satelite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxNativeZoom: 18, maxZoom: 22, attribution: 'Imagens &copy; Esri, Maxar, Earthstar Geographics',
      }),
    };
    // Servidor próprio de mapas (APP_CONFIG.mapaOffline): as camadas configuradas vêm dele, e é isso que o pacote guarda.
    var proprio = modelosPacote();
    if (proprio) {
      var atrib = (window.APP_CONFIG && window.APP_CONFIG.mapaAtribuicao) || '';
      Object.keys(proprio).forEach(function (k) {
        if (!bases[k]) return;
        bases[k] = L.tileLayer(proprio[k], { maxNativeZoom: 17, maxZoom: 22, crossOrigin: true, attribution: atrib });
      });
    }
    return bases;
  }

  /* ---------- Mapa de ruas gratuito (PMTiles no Supabase Storage; js/mapa-vetor.js) ---------- */
  // Decide uma vez por abertura: há pacote vetorial guardado (vale sem internet) ou o arquivo responde no servidor.
  // Sem o arquivo (ainda não enviado ao Storage), tudo segue como antes.
  function configVetor() { return (window.APP_CONFIG && window.APP_CONFIG.mapaVetor) || null; }
  async function decidirMapaVetor() {
    var url = configVetor(), V = window.MapaVetor;
    if (estado.vetorDecidido || estado.vetorDecidindo) return;
    if (!url || !V || !V.disponivel() || modelosPacote()) { estado.vetorDecidido = true; return; }
    var guardado = pacotesMapa().some(function (p) { return (p.camadas || []).indexOf('vetor') >= 0 && p.url === url; });
    estado.vetorDecidindo = true;
    try {
      var ok = guardado || await V.verificar(url, 8000);
      if (!ok && navigator.onLine === false) return;   // sem rede agora: decide depois
      estado.vetorDecidido = true;
      if (ok) usarMapaVetor(url);
    } finally {
      estado.vetorDecidindo = false;
      if (estado.vetorDecidido) verificarMapaOffline();
    }
  }
  function usarMapaVetor(url) {
    estado.vetorUrl = url;
    if (!estado.bases) return;
    var antiga = estado.bases.osm;
    estado.bases.osm = window.MapaVetor.camada(url, { tema: temaCivil() });
    if (estado.mapa && estado.baseAtual === 'osm') {
      if (antiga) antiga.remove();
      estado.bases.osm.addTo(estado.mapa).bringToBack();
    }
    fundoConformeRede();
  }

  // Sem internet, o satélite e o relevo não carregam: mostra o mapa de ruas guardado no aparelho (sem mudar a escolha
  // salva da pessoa) e volta ao fundo escolhido quando a internet voltar.
  function mostrarBase(nome) {
    if (!estado.mapa || !estado.bases || !estado.bases[nome] || estado.baseAtual === nome) return;
    if (estado.baseAtual && estado.bases[estado.baseAtual]) estado.bases[estado.baseAtual].remove();
    estado.bases[nome].addTo(estado.mapa).bringToBack();
    estado.baseAtual = nome;
  }
  function fundoConformeRede() {
    if (!estado.mapa || !estado.vetorUrl) return;
    if (navigator.onLine === false) {
      if (estado.baseAtual !== 'osm') {
        estado.baseAntesSemRede = estado.baseAtual;
        mostrarBase('osm');
        UI.aviso('Sem internet: mostrando o mapa de ruas guardado no celular.', 'ok', 6000);
      }
    } else if (estado.baseAntesSemRede) {
      var volta = estado.baseAntesSemRede;
      estado.baseAntesSemRede = null;
      if (estado.prefs && estado.prefs.base === volta) mostrarBase(volta);
    }
  }

  function trocarBaseMapa(nome) {
    if (!estado.mapa || !estado.bases || !estado.bases[nome]) return;
    estado.baseAntesSemRede = null;   // escolha da pessoa vale mais que a troca automática
    if (estado.baseAtual && estado.bases[estado.baseAtual]) estado.bases[estado.baseAtual].remove();
    estado.bases[nome].addTo(estado.mapa).bringToBack();
    estado.baseAtual = nome;
    estado.prefs.base = nome;
    estado.prefs.baseEscolhida = true;
    gravarPrefsMapa();
  }

  // Liga e desliga o que aparece no mapa (setores, pontos, áreas proibidas, trilhas da equipe).
  function aplicarCamadasVisiveis() {
    if (!estado.mapa) return;
    var p = estado.prefs;
    [['setores', estado.camSetores], ['pontos', estado.camPontos], ['proibidas', estado.camProibidas], ['trilhas', estado.camTrilhasEquipe]].forEach(function (x) {
      var g = x[1];
      if (!g) return;
      if (p[x[0]]) { if (!estado.mapa.hasLayer(g)) g.addTo(estado.mapa); } else if (estado.mapa.hasLayer(g)) g.remove();
    });
    ordemTrilhasP();
    agendarDecoracoesTrilhas();
  }

  // Painel "Camadas" sobre o mapa: fundo, o que mostrar e o tema (escuro ou claro).
  function montarCamadasCivil() {
    var botao = $('btn-camadas'), painel = $('camadas-civil');
    if (!botao || !painel || painel._pronto) return;
    painel._pronto = true;
    function fechar() { painel.hidden = true; botao.setAttribute('aria-expanded', 'false'); }
    function seg(grupo, valorAtual, opcoes, aoEscolher) {
      var caixa = UI.el('div', { classe: 'camadas-seg', role: 'radiogroup', 'aria-label': grupo });
      opcoes.forEach(function (o) {
        var b = UI.el('button', { classe: 'camadas-opcao', type: 'button', role: 'radio', 'data-valor': o[0], 'aria-checked': String(o[0] === valorAtual), texto: o[1],
          onclick: function () {
            caixa.querySelectorAll('.camadas-opcao').forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); });
            aoEscolher(o[0]);
          } });
        caixa.appendChild(b);
      });
      return caixa;
    }
    function chave(rotulo, campo, aoMudar) {
      var inp = UI.el('input', { type: 'checkbox', checked: estado.prefs[campo] ? true : null });
      inp.addEventListener('change', function () { estado.prefs[campo] = inp.checked; gravarPrefsMapa(); aplicarCamadasVisiveis(); if (aoMudar) aoMudar(inp.checked); });
      return UI.el('label', { classe: 'camadas-chave' }, [inp, ' ' + rotulo]);
    }
    painel.appendChild(UI.el('div', { classe: 'camadas-cabeca' }, [
      UI.el('strong', { texto: 'Camadas' }),
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'camadas-fechar', 'aria-label': 'Fechar as camadas', texto: '✕', onclick: fechar }),
    ]));
    painel.appendChild(UI.el('div', { classe: 'camadas-grupo' }, [UI.el('span', { classe: 'camadas-rotulo', texto: 'Fundo do mapa' }),
      seg('Fundo do mapa', estado.prefs.base, [['osm', 'Mapa'], ['topo', 'Relevo'], ['satelite', 'Satélite']], trocarBaseMapa)]));
    painel.appendChild(UI.el('div', { classe: 'camadas-grupo' }, [UI.el('span', { classe: 'camadas-rotulo', texto: 'Mostrar no mapa' }),
      chave('Setores', 'setores'), chave('Pontos de interesse', 'pontos'), chave('Áreas proibidas', 'proibidas'),
      chave('Trilhas da equipe', 'trilhas', function (ligou) { if (ligou) { estado.trilhasEquipeEm = 0; carregarTrilhasEquipe(); } })]));
    painel.appendChild(UI.el('div', { classe: 'camadas-grupo' }, [UI.el('span', { classe: 'camadas-rotulo', texto: 'Tema' }),
      seg('Tema', temaCivil(), [['escuro', 'Escuro'], ['claro', 'Claro']], aplicarTemaCivil)]));
    if (modelosPacote()) {
      painel.appendChild(UI.el('div', { classe: 'camadas-grupo' }, [UI.el('span', { classe: 'camadas-rotulo', texto: 'Sem internet' }),
        UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'camadas-offline', texto: '🗺 Mapas offline', onclick: function () { fechar(); abrirMapasOffline(); } })]));
    }
    botao.addEventListener('click', function () {
      var abrir = painel.hidden;
      painel.hidden = !abrir;
      botao.setAttribute('aria-expanded', String(abrir));
    });
  }

  // Ponto dentro de um polígono ([[lat, lng], …]): algoritmo do raio.
  function dentroDoPoligono(lat, lng, pts) {
    var dentro = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var yi = pts[i][0], xi = pts[i][1], yj = pts[j][0], xj = pts[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) dentro = !dentro;
    }
    return dentro;
  }

  // Rota até um ponto de interesse público: o mesmo painel de navegação dos destinos, só neste aparelho
  // (não avisa o servidor). Um destino enviado pelos bombeiros tem prioridade e não é trocado.
  function rotaAtePonto(pt) {
    if (!estado.mapa) return;
    if (estado.destino && !estado.destino.local) {
      UI.aviso('Os bombeiros já enviaram um destino para você. Termine ou encerre essa navegação antes.', 'erro', 7000);
      return;
    }
    definirDestino({ id: 'local-' + pt.id, local: true, nome: pt.titulo, lat: pt.lat, lng: pt.lng, modo: 'a_pe' });
  }

  // Um destino escolhido pelo próprio participante (local) só sai quando ele encerra ou chega um do servidor.
  function definirDestinoServidor(d) {
    if (!d && estado.destino && estado.destino.local) return;
    definirDestino(d || null);
  }

  // Trilhas dos outros participantes (sem nome), numa cor só; a sua fica na cor do grupo e por cima.
  async function carregarTrilhasEquipe() {
    if (!estado.part || estado.finalizado || !estado.mapa || estado.semTrilhasEquipe || !estado.prefs.trilhas) return;
    var lista;
    try {
      lista = await C.rpc('trilhas_da_equipe', { p_participante: estado.part.participante_id }, 15000);
    } catch (e) {
      if (e.codigo === 'funcao_ausente') estado.semTrilhasEquipe = true;   // servidor sem a migração 065
      else tratarErroFatal(e);
      return;
    }
    desenharTrilhasEquipe(lista || []);
  }

  function desenharTrilhasEquipe(lista) {
    if (!estado.mapa) return;
    if (!estado.camTrilhasEquipe) { estado.camTrilhasEquipe = L.layerGroup(); aplicarCamadasVisiveis(); }
    estado.camTrilhasEquipe.clearLayers();
    estado.segsEquipe = [];
    lista.forEach(function (t) {
      if (!t.pontos || t.pontos.length < 2) return;
      estado.segsEquipe.push(t.pontos);
      L.polyline(t.pontos, { color: '#0b1220', weight: pesoTrilhaP(4) + 2.5, opacity: 0.7, interactive: false, lineJoin: 'round', lineCap: 'round', className: 'trilha-halo' }).addTo(estado.camTrilhasEquipe);
      L.polyline(t.pontos, { color: COR_TRILHA_EQUIPE, weight: pesoTrilhaP(4), opacity: 0.95, interactive: false, lineJoin: 'round', lineCap: 'round', className: 'trilha-equipe' }).addTo(estado.camTrilhasEquipe);
    });
    var lg = $('lg-trilhas-equipe');
    if (lg) lg.hidden = !lista.length || !estado.prefs.trilhas;
    ordemTrilhasP();
    agendarDecoracoesTrilhas();
  }

  // SOS: pedido de ajuda com a localização. Entra na mesma fila dos relatos (vai quando o sinal voltar).
  async function pedirSocorro() {
    if (!estado.part || estado.finalizado) return;
    var r = await UI.confirmar({ titulo: 'Pedir ajuda aos bombeiros?', ok: 'ENVIAR PEDIDO DE AJUDA', cancelar: 'Voltar', perigo: true,
      texto: 'Os bombeiros recebem um alarme com a sua localização. Use só se você ou alguém precisa de ajuda agora.' });
    if (!r) return;
    // Pedido de ajuda não espera o GPS: usa a última leitura (até 2 min) e só procura uma nova se não houver.
    var pos = posicaoRecente() || await obterPosicaoAgora();
    var env = await enviarAosBombeiros('AJUDA', 'Preciso de ajuda', pos);
    if (env.ok) UI.aviso('Pedido de ajuda enviado aos bombeiros.', 'ok', 9000);
    else if (!env.item.erro) UI.aviso('Sem internet: o pedido de ajuda vai ser enviado assim que o sinal voltar.', 'erro', 12000);
  }

  /* ------------------------------------------------------------------ */
  /* Navegação até o destino enviado pelos bombeiros                      */
  /* ------------------------------------------------------------------ */
  var DIRECOES = ['Norte', 'Nordeste', 'Leste', 'Sudeste', 'Sul', 'Sudoeste', 'Oeste', 'Noroeste'];

  function definirDestino(d) {
    var antes = estado.destino;
    if (!d) {
      if (antes) {
        estado.destino = null;
        estado.rota = null;
        desenharRotaCivil();
        atualizarDestinoNoMapa();
        $('navegacao').hidden = true;
        $('lg-destino').hidden = true;
        if (!estado.encerrandoNav) UI.aviso('Os bombeiros encerraram a navegação até "' + antes.nome + '".', 'ok', 7000);
      }
      return;
    }
    var novo = !antes || antes.id !== d.id;
    estado.destino = d;
    if (novo) {
      // modo escolhido pelos bombeiros (a pessoa pode trocar na tela)
      estado.modoNav = window.Rotas.MODOS[d.modo] ? d.modo : 'a_pe';
      estado.rota = null;
      estado.rotaErro = null;
      estado.rotaErroEm = 0;
      estado.rotaEnquadrada = false;
      atualizarBotoesModo();
      desenharRotaCivil();
      renderizarRotaInfo();
    }
    // trajeto desenhado: o caminho já foi escolhido pelos bombeiros (sem trocar a pé/trilha/carro)
    var modosNav = document.querySelector('.nav-modos');
    if (modosNav) modosNav.hidden = window.Rotas.temTrajeto(d);
    $('navegacao').hidden = false;
    $('lg-destino').hidden = false;
    $('nav-nome').textContent = d.nome;
    atualizarMissaoNav(d.missao || null);
    $('nav-coord').textContent = C.coord(d.lat) + ', ' + C.coord(d.lng);
    $('nav-rota').href = window.Rotas.linkGoogle([d.lat, d.lng], estado.modoNav);
    if (novo) {
      ligarBussola();
      if (!d.local) {
        try { if (navigator.vibrate) navigator.vibrate([300, 120, 300]); } catch (e) { /* ignora */ }
        bipe();
      }
      UI.aviso(d.local ? 'Rota até "' + d.nome + '".' : window.Rotas.temTrajeto(d) ? 'Os bombeiros enviaram um trajeto para você seguir: ' + d.nome + '.' : 'Os bombeiros enviaram um destino: ' + d.nome + '.', 'ok', 8000);
      if (!$('painel-conversa').hidden) fecharConversa();
      try { $('navegacao').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* ignora */ }
      if (estado.mapa) {
        var pts = [[d.lat, d.lng]].concat(window.Rotas.temTrajeto(d) ? d.trajeto : []);
        if (estado.ultimaLeitura) pts.push([estado.ultimaLeitura.lat, estado.ultimaLeitura.lng]);
        estado.mapa.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 17 });
        estado.seguindo = false;
      }
    }
    atualizarDestinoNoMapa();
    agendarNavegacao();
    if (novo) calcularRota('novo');
  }

  // Destino enviado ao grupo: mostra a missão e, para o responsável do grupo,
  // o botão para avisar que a busca no setor terminou (começa o retorno à base).
  function atualizarMissaoNav(m) {
    var caixa = $('nav-missao');
    var btn = $('nav-finalizar');
    if (!m) { caixa.hidden = true; btn.hidden = true; return; }
    var txt = (m.volta_base ? 'Retorno à base · ' : 'Missão do grupo ') + m.grupo + (m.setor && !m.volta_base ? ' · Setor ' + m.setor : '');
    if (caixa.textContent !== txt) caixa.textContent = txt;
    caixa.hidden = false;
    btn.hidden = !m.pode_finalizar;
    btn.setAttribute('data-missao', m.id);
  }

  async function finalizarBuscaSetor() {
    var id = $('nav-finalizar').getAttribute('data-missao');
    if (!id) return;
    var r = await UI.confirmar({
      titulo: 'A busca no setor terminou?',
      texto: 'O grupo volta para a base. Confirme só com a busca concluída.',
      ok: 'Sim, busca concluída',
      cancelar: 'Voltar',
    });
    if (!r) return;
    var btn = $('nav-finalizar');
    btn.disabled = true;
    try {
      await C.rpc('finalizar_busca', { p_missao: id }, 15000);
      UI.aviso('Os bombeiros foram avisados. Siga para a base.', 'ok', 7000);
      carregarDestino();
    } catch (e) {
      if (!tratarErroFatal(e)) UI.aviso(e.rede ? 'Sem internet: não deu para avisar. Tente de novo.' : e.message, 'erro', 7000);
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- Rota por caminhos reais -------------------------------- */
  function trocarModoNav(modo) {
    if (!window.Rotas.MODOS[modo] || modo === estado.modoNav) return;
    estado.modoNav = modo;
    estado.rota = null;
    estado.rotaErroEm = 0;
    atualizarBotoesModo();
    desenharRotaCivil();
    if (estado.destino) $('nav-rota').href = window.Rotas.linkGoogle([estado.destino.lat, estado.destino.lng], modo);
    calcularRota('modo');
  }

  function atualizarBotoesModo() {
    document.querySelectorAll('.nav-modos [data-modo]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-modo') === estado.modoNav));
    });
  }

  // Calcula (ou recalcula) a rota da posição atual até o destino.
  //   motivo: 'novo' (destino novo), 'modo' (trocou a pé/trilha/carro), 'gps' (primeira
  //   posição), 'desvio' (saiu da rota), 'tentar' (nova tentativa depois de erro)
  async function calcularRota(motivo) {
    var d = estado.destino, l = estado.ultimaLeitura;
    if (!d || estado.finalizado || estado.rotaCalculando) return;
    var desenhado = window.Rotas.temTrajeto(d);   // trajeto desenhado pelos bombeiros: segue a linha, sem servidor
    if (!l && !desenhado) { estado.rotaErro = null; renderizarRotaInfo('Aguardando o GPS para calcular a rota…'); return; }
    if (navigator.onLine === false && !desenhado) { estado.rotaErro = 'Sem internet: a rota será calculada quando o sinal voltar.'; renderizarRotaInfo(); return; }
    var modo = estado.modoNav, destId = d.id;
    estado.rotaCalculando = true;
    renderizarRotaInfo(motivo === 'desvio' ? 'Você saiu da rota — recalculando…' : 'Calculando a rota…');
    var r = await window.Rotas.paraDestino(d, { origem: l ? [l.lat, l.lng] : null, modo: modo, participante_id: estado.part && estado.part.participante_id });
    estado.rotaCalculando = false;
    if (!estado.destino || estado.destino.id !== destId || estado.modoNav !== modo) {
      if (estado.destino) calcularRota('modo');   // mudou enquanto calculava
      return;
    }
    estado.rotaCalcEm = Date.now();
    estado.rotaForaCont = 0;
    if (!r.ok) {
      estado.rota = null;
      estado.rotaErro = r.mensagem;
      // erros que não se resolvem tentando de novo logo: espera 10 min
      estado.rotaErroEm = Date.now() + (['rota_nao_configurada', 'sem_permissao', 'distancia_grande', 'sem_rota'].indexOf(r.erro) !== -1 ? 9 * 60000 : 0);
      desenharRotaCivil();
      renderizarRotaInfo();
      agendarNavegacao();
      return;
    }
    estado.rota = r.rota;
    estado.rota.destId = destId;
    estado.rotaErro = null;
    desenharRotaCivil();
    renderizarRotaInfo();
    if (motivo === 'desvio') UI.aviso('Rota recalculada a partir de onde você está.', 'ok');
    if (estado.mapa && !estado.rotaEnquadrada) {
      estado.rotaEnquadrada = true;
      var pts = r.rota.geometria.map(function (c) { return [c[0], c[1]]; });
      pts.push([d.lat, d.lng]);
      if (l) pts.push([l.lat, l.lng]);
      estado.mapa.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 17 });
      estado.seguindo = false;
    }
    agendarNavegacao();
  }

  function desenharRotaCivil() {
    if (!estado.mapa) return;
    if (!estado.camadaRota) estado.camadaRota = L.layerGroup().addTo(estado.mapa);
    if (!estado.rota) { estado.camadaRota.clearLayers(); $('lg-rota').hidden = true; return; }
    window.Rotas.desenhar(estado.camadaRota, estado.rota, { peso: 5 });
    $('lg-rota').hidden = false;
  }

  function renderizarRotaInfo(textoEstado) {
    var rota = estado.rota;
    var res = $('nav-rota-resumo');
    var ul = $('nav-avisos-rota');
    var ol = $('nav-passos');
    ul.innerHTML = '';
    ol.innerHTML = '';
    $('nav-passos-caixa').hidden = true;
    $('nav-rota-info').classList.toggle('erro', Boolean(!rota && estado.rotaErro));
    if (!rota) {
      res.textContent = textoEstado || (estado.rotaErro ? 'Rota indisponível agora: siga a seta ou o app de mapas.' : 'Calculando a rota…');
      res.title = estado.rotaErro || '';
      $('nav-proxima').hidden = true;
      return;
    }
    res.textContent = textoEstado || window.Rotas.resumo(rota);
    (rota.avisos || []).forEach(function (a) { ul.appendChild(UI.el('li', { texto: a })); });
    ul.appendChild(UI.el('li', { classe: 'nav-limites', texto: rota.limites }));
    (rota.passos || []).forEach(function (p) {
      ol.appendChild(UI.el('li', { texto: p.instrucao + (p.distancia_m ? ' — ' + window.Rotas.formatarDistancia(p.distancia_m) : '') }));
    });
    $('nav-passos-caixa').hidden = !(rota.passos || []).length;
  }

  function atualizarDestinoNoMapa() {
    if (!estado.mapa) return;
    var d = estado.destino;
    if (!d) {
      if (estado.marcaDestino) { estado.marcaDestino.remove(); estado.marcaDestino = null; }
      if (estado.linhaDestino) { estado.linhaDestino.remove(); estado.linhaDestino = null; }
      return;
    }
    if (!estado.marcaDestino) {
      estado.marcaDestino = L.marker([d.lat, d.lng], {
        icon: L.divIcon({ className: 'mk-destino-wrap', html: '<div class="mk-destino">🧭</div>', iconSize: [0, 0] }),
        keyboard: false, zIndexOffset: 900, title: 'Destino: ' + d.nome,
      }).addTo(estado.mapa);
    } else {
      estado.marcaDestino.setLatLng([d.lat, d.lng]);
    }
    var l = estado.ultimaLeitura;
    if (l) {
      var pts = [[l.lat, l.lng], [d.lat, d.lng]];
      if (!estado.linhaDestino) estado.linhaDestino = L.polyline(pts, { color: '#facc15', weight: 3, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(estado.mapa);
      else estado.linhaDestino.setLatLngs(pts);
      // com rota calculada, a linha reta vira só referência de direção (mais fina)
      var comRota = Boolean(estado.rota);
      if (estado.linhaDestino._comRota !== comRota) {
        estado.linhaDestino._comRota = comRota;
        estado.linhaDestino.setStyle(comRota ? { weight: 2, opacity: 0.6, dashArray: '1 9' } : { weight: 3, opacity: 1, dashArray: '2 8' });
      }
    }
  }

  function rumoEntre(lat1, lng1, lat2, lng2) {
    var k = Math.PI / 180;
    var y = Math.sin((lng2 - lng1) * k) * Math.cos(lat2 * k);
    var x = Math.cos(lat1 * k) * Math.sin(lat2 * k) - Math.sin(lat1 * k) * Math.cos(lat2 * k) * Math.cos((lng2 - lng1) * k);
    return (Math.atan2(y, x) / k + 360) % 360;
  }

  function formatarDistancia(m) {
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: m < 10000 ? 1 : 0 }) + ' km';
  }

  function agendarNavegacao() {
    if (!estado.destino || estado.rafNav) return;
    estado.rafNav = requestAnimationFrame(function () { estado.rafNav = null; atualizarNavegacao(); });
  }

  // Distância e direção em LINHA RETA, recalculadas a cada leitura do GPS.
  function atualizarNavegacao() {
    var d = estado.destino;
    if (!d) return;
    atualizarDestinoNoMapa();
    var l = estado.ultimaLeitura;
    var semGps = !l || Date.now() - l.recebidaEm > 60000 || estado.gps === 'negado' || estado.gps === 'indisponivel';
    var caixa = $('navegacao');
    var aviso = $('nav-aviso');
    if (semGps) {
      caixa.className = 'navegacao sem-gps';
      $('nav-dist').textContent = 'Sem GPS';
      $('nav-dir').textContent = 'Sem GPS, sem direção.';
      aviso.textContent = 'Ligue a localização do celular ou vá para um lugar aberto.';
      $('nav-seta').style.transform = 'rotate(0deg)';
      $('nav-bussola').classList.add('inativa');
      return;
    }
    $('nav-bussola').classList.remove('inativa');
    var dist = C.distancia(l.lat, l.lng, d.lat, d.lng);
    var rumoReta = rumoEntre(l.lat, l.lng, d.lat, d.lng);
    var chegou = dist <= Math.max(15, l.prec || 0);
    var fraco = l.prec != null && l.prec > 50;
    caixa.className = 'navegacao' + (chegou ? ' chegou' : '') + (fraco ? ' gps-fraco' : '');
    // Com rota: distância que falta PELA ROTA e seta apontando para a rota à frente.
    var rota = estado.rota && estado.rota.destId === d.id ? estado.rota : null;
    var prog = rota ? window.Rotas.progresso(rota, l.lat, l.lng) : null;
    var naRota = prog && prog.distanciaDaRota <= Math.max(60, (l.prec || 0) * 1.5);
    var rumo = naRota ? rumoEntre(l.lat, l.lng, prog.alvo[0], prog.alvo[1]) : rumoReta;
    if (prog && !chegou) {
      // saiu da rota (3 leituras seguidas): recalcula, no máximo 1 vez a cada 30 s
      if (prog.distanciaDaRota > Math.max(50, 2 * (l.prec || 0))) estado.rotaForaCont++; else estado.rotaForaCont = 0;
      // trajeto desenhado não se recalcula: a pessoa volta para a linha
      if (!rota.fixa && estado.rotaForaCont >= 3 && Date.now() - estado.rotaCalcEm > 30000) calcularRota('desvio');
      var px = $('nav-proxima');
      px.hidden = false;
      px.textContent = naRota
        ? (prog.proximo ? 'Em ' + formatarDistancia(prog.distManobra) + ': ' + prog.proximo.instrucao : 'Siga a rota até o destino.')
        : 'Você está a ' + formatarDistancia(prog.distanciaDaRota) + ' da linha. Volte para ela.';
    } else if (!rota && !estado.rotaCalculando && Date.now() - estado.rotaErroEm > 60000 && navigator.onLine !== false) {
      calcularRota(estado.rotaErro ? 'tentar' : 'gps');
    }
    $('nav-dist').textContent = chegou ? 'Você chegou' : formatarDistancia(prog ? prog.restante + (naRota ? 0 : prog.distanciaDaRota) : dist);
    var dir = DIRECOES[Math.round(rumoReta / 45) % 8];
    var ra = rumoAtual();
    var bussolaOk = Boolean(ra);
    var giro = bussolaOk ? rumo - ra.graus : rumo;
    $('nav-seta').style.transform = 'rotate(' + Math.round(giro) + 'deg)';
    $('nav-norte').style.transform = 'rotate(' + Math.round(bussolaOk ? -ra.graus : 0) + 'deg) translateY(-34px)';
    $('nav-bussola').classList.toggle('com-bussola', bussolaOk);
    $('nav-dir').textContent = chegou ? 'Destino a menos de ' + Math.round(Math.max(15, l.prec || 0)) + ' m.'
      : dir + ' · ' + Math.round(rumoReta) + '°' + (bussolaOk ? ' · siga a seta' : '');
    aviso.textContent = (fraco ? 'GPS fraco: valores aproximados. ' : '') +
      (prog ? (rota.fixa ? 'Siga a linha dos bombeiros.' : 'Confira o terreno.') : 'Linha reta: confira o terreno.');
  }

  // Bússola. Fontes, da melhor para a pior:
  //   1. evento de orientação ABSOLUTA (Android: deviceorientationabsolute, ou deviceorientation com absolute=true;
  //      iPhone: webkitCompassHeading, com permissão);
  //   2. sensor de orientação do Chrome (AbsoluteOrientationSensor), se os eventos não chegarem;
  //   3. rumo pelo GPS enquanto a pessoa anda (celular sem sensor de direção, ou sensor que não responde).
  // A bússola do mapa e a seta da navegação usam a mesma leitura (rumoAtual()).
  var FRESCO_SENSOR_MS = 3000, FRESCO_GPS_MS = 30000;
  function guardarRumoSensor(graus) {
    if (graus == null || !isFinite(graus)) return;
    estado.rumo = (graus % 360 + 360) % 360;
    estado.rumoEm = Date.now();
    agendarNavegacao();
    agendarBussola();
  }
  function anguloTela() {
    return (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
  }
  function aoGirar(ev) {
    var r = null;
    if (typeof ev.webkitCompassHeading === 'number' && !isNaN(ev.webkitCompassHeading)) r = ev.webkitCompassHeading;
    else if ((ev.type === 'deviceorientationabsolute' || ev.absolute === true) && typeof ev.alpha === 'number' && !isNaN(ev.alpha)) r = 360 - ev.alpha;
    if (r == null) return;
    estado.fonteSensor = 'evento';
    guardarRumoSensor(r + anguloTela());
  }

  // Direção de um quaternion (aparelho → Terra: x leste, y norte, z para cima). Com o celular deitado vale o topo
  // da tela; em pé (tela virada para a pessoa), vale para onde a traseira aponta.
  function rumoDoQuaternion(q) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var topoLeste = 2 * (x * y - z * w), topoNorte = 1 - 2 * (x * x + z * z), topoCima = 2 * (y * z + x * w);
    var e = topoLeste, n = topoNorte;
    if (Math.abs(topoCima) > 0.7) { e = -2 * (x * z + y * w); n = -2 * (y * z - x * w); }
    if (Math.abs(e) < 1e-6 && Math.abs(n) < 1e-6) return null;
    return Math.atan2(e, n) * 180 / Math.PI;
  }
  function ligarSensorGenerico() {
    if (estado.sensorOrientacao || typeof window.AbsoluteOrientationSensor !== 'function') return;
    try {
      var sensor = new window.AbsoluteOrientationSensor({ frequency: 10, referenceFrame: 'screen' });
      sensor.addEventListener('reading', function () {
        if (estado.rumoEm && estado.fonteSensor === 'evento' && Date.now() - estado.rumoEm < FRESCO_SENSOR_MS) return;   // os eventos já respondem
        var r = sensor.quaternion ? rumoDoQuaternion(sensor.quaternion) : null;
        if (r == null) return;
        estado.fonteSensor = 'sensor';
        guardarRumoSensor(r);
      });
      sensor.addEventListener('error', function () { estado.sensorOrientacao = null; });
      sensor.start();
      estado.sensorOrientacao = sensor;
    } catch (e) { estado.sensorOrientacao = null; }
  }

  // Rumo pelo GPS: direção do deslocamento (o GPS informa quando há velocidade; senão, entre duas leituras a 8 m
  // ou mais uma da outra). Só com o GPS bom: com erro grande, a direção sairia errada.
  function atualizarRumoGps(pos, a) {
    var c = pos && pos.coords ? pos.coords : {};
    var agora = Date.now();
    if (a.prec != null && a.prec > 30) return;
    if (typeof c.heading === 'number' && isFinite(c.heading) && typeof c.speed === 'number' && c.speed >= 0.7) {
      estado.rumoGps = c.heading; estado.rumoGpsEm = agora; estado.refRumoGps = { lat: a.lat, lng: a.lng };
      agendarBussola(); agendarNavegacao();
      return;
    }
    var ref = estado.refRumoGps;
    if (!ref) { estado.refRumoGps = { lat: a.lat, lng: a.lng }; return; }
    var dist = C.distancia(ref.lat, ref.lng, a.lat, a.lng);
    if (dist < 8) return;
    var f1 = ref.lat * Math.PI / 180, f2 = a.lat * Math.PI / 180, dl = (a.lng - ref.lng) * Math.PI / 180;
    var r = Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) * 180 / Math.PI;
    estado.rumoGps = (r + 360) % 360; estado.rumoGpsEm = agora; estado.refRumoGps = { lat: a.lat, lng: a.lng };
    agendarBussola(); agendarNavegacao();
  }

  // A melhor direção disponível agora: { graus, fonte: 'sensor' | 'gps' } ou nula.
  function rumoAtual() {
    var agora = Date.now();
    if (estado.rumo != null && agora - estado.rumoEm < FRESCO_SENSOR_MS) return { graus: estado.rumo, fonte: 'sensor' };
    if (estado.rumoGps != null && agora - estado.rumoGpsEm < FRESCO_GPS_MS) return { graus: estado.rumoGps, fonte: 'gps' };
    return null;
  }

  var DIRECAO_CURTA = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
  function agendarBussola() {
    if (estado.rafBussola) return;
    estado.rafBussola = requestAnimationFrame(function () { estado.rafBussola = null; atualizarBussola(); });
  }
  // O disco gira para o Norte ficar em cima do N; a seta fixa mostra para onde o aparelho aponta.
  // Pelo GPS, mostra para onde a pessoa está andando (com "GPS" ao lado).
  function atualizarBussola() {
    var caixa = $('bussola-civil');
    var r = rumoAtual();
    if (!r) {
      // sem nada ainda: depois de alguns segundos procurando, diz o que fazer (em vez de ficar em "Procurando…")
      if (estado.ouvindoBussola && estado.bussolaDesde && Date.now() - estado.bussolaDesde > 8000) {
        caixa.hidden = false;
        caixa.classList.remove('pelo-gps');
        caixa.classList.add('sem-rumo');
        var t0 = 'Ande alguns passos';
        if ($('bussola-direcao').textContent !== t0) $('bussola-direcao').textContent = t0;
        caixa.title = 'O sensor de direção do celular não respondeu. Andando, a direção vem do GPS.';
      }
      return;
    }
    caixa.hidden = false;
    caixa.classList.remove('sem-rumo');
    caixa.classList.toggle('pelo-gps', r.fonte === 'gps');
    caixa.title = r.fonte === 'gps' ? 'Direção em que você está andando (pelo GPS: o celular não tem sensor de direção ou ele não respondeu).' : 'Para onde o celular está apontado.';
    $('bussola-rosa').style.transform = 'rotate(' + Math.round(-r.graus) + 'deg)';
    var txt = DIRECAO_CURTA[Math.round(r.graus / 45) % 8] + ' ' + (Math.round(r.graus) % 360) + '°' + (r.fonte === 'gps' ? ' · GPS' : '');
    if ($('bussola-direcao').textContent !== txt) $('bussola-direcao').textContent = txt;
    if (r.fonte === 'sensor') $('bussola-ativar').hidden = true;   // pelo GPS, o botão continua para ligar o sensor
  }

  // Ao abrir a página. Alguns navegadores pedem permissão para os sensores de movimento (iPhone e, nas versões
  // novas, também o Chrome): pede logo; se o navegador exigir um toque, aparece "Ativar bússola". Antes, quem
  // tinha esse pedido era tratado como iPhone e só escutava a orientação RELATIVA, que no Android não tem o Norte:
  // a bússola ficava em "Procurando…" para sempre. Sem tela de toque (computador), fica escondida.
  function precisaPermissaoBussola() {
    return typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
  }
  function iniciarBussola() {
    if (!('ontouchstart' in window) && !(navigator.maxTouchPoints > 0)) return;
    $('bussola-civil').hidden = false;
    $('bussola-direcao').textContent = 'Procurando…';
    estado.bussolaDesde = Date.now();
    clearInterval(estado.timerBussola);
    estado.timerBussola = setInterval(agendarBussola, 2000);   // troca "Procurando…" por "Ande alguns passos" se nada chegar
    ligarBussola();
  }

  function mostrarAtivarBussola() {
    $('bussola-civil').hidden = false;
    $('bussola-ativar').hidden = false;
    if (!rumoAtual()) $('bussola-direcao').textContent = '';   // só o botão "Ativar" (pequeno), sem texto a mais
  }

  // Liga as fontes de direção (ver o começo desta parte). Com o pedido de permissão, tenta sem toque primeiro.
  function ligarBussola() {
    if (estado.ouvindoBussola) return;
    if (precisaPermissaoBussola() && !estado.permissaoBussola) {
      try {
        DeviceOrientationEvent.requestPermission().then(function (r) {
          if (r === 'granted') { estado.permissaoBussola = true; ligarOuvintesBussola(); }
          else mostrarAtivarBussola();
        }).catch(mostrarAtivarBussola);
      } catch (e) { mostrarAtivarBussola(); }
      return;
    }
    ligarOuvintesBussola();
  }

  function ligarOuvintesBussola() {
    if (estado.ouvindoBussola) return;
    estado.ouvindoBussola = true;
    estado.bussolaDesde = Date.now();
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', aoGirar);
    if ('ondeviceorientation' in window) window.addEventListener('deviceorientation', aoGirar);
    // se os eventos não responderem em 2 s, tenta o sensor do Chrome
    setTimeout(function () { if (!estado.rumoEm) ligarSensorGenerico(); }, 2000);
  }

  // Botão "Ativar bússola" (o toque que o navegador exige para liberar os sensores).
  function pedirBussola() {
    var pedido;
    try { pedido = DeviceOrientationEvent.requestPermission(); } catch (e) { pedido = Promise.reject(e); }
    pedido.then(function (r) {
      if (r === 'granted') {
        estado.permissaoBussola = true;
        $('bussola-ativar').hidden = true;
        if (!rumoAtual()) $('bussola-direcao').textContent = 'Procurando…';
        ligarOuvintesBussola();
      } else {
        $('bussola-direcao').textContent = 'Sem permissão';
        UI.aviso('Sem permissão para a bússola. Libere o acesso a movimento e orientação nas configurações do navegador. Andando, a direção vem do GPS.', 'erro', 8000);
      }
    }).catch(function () {
      $('bussola-direcao').textContent = 'Indisponível';
      UI.aviso('Bússola indisponível neste celular. Andando, a direção vem do GPS.', 'erro');
    });
  }

  async function encerrarNavegacao() {
    var d = estado.destino;
    if (!d) return;
    if (d.local) {   // escolhido por mim: só sai da minha tela
      estado.encerrandoNav = true;
      definirDestino(null);
      estado.encerrandoNav = false;
      return;
    }
    var r = await UI.confirmar({ titulo: 'Encerrar a navegação?', texto: 'O destino "' + d.nome + '" some da sua tela. Os bombeiros podem enviar outro.', ok: 'Encerrar', cancelar: 'Voltar' });
    if (!r) return;
    try {
      await C.rpc('encerrar_destino', { p_destino: d.id });
      estado.encerrandoNav = true;
      definirDestino(null);
      estado.encerrandoNav = false;
      UI.aviso('Navegação encerrada.', 'ok');
    } catch (e) {
      if (!tratarErroFatal(e)) UI.aviso(e.rede ? 'Sem internet: tente de novo.' : e.message, 'erro');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Envio de mensagens e relatos à equipe                                */
  /* ------------------------------------------------------------------ */
  // Posição atual para mensagens e fotos: usa a leitura recente do rastreamento
  // ou pede uma nova ao GPS. Se não conseguir, devolve ok:false (nunca inventa).
  function obterPosicaoAgora() {
    var l = estado.ultimaLeitura;
    var recente = l && l.prec != null && l.prec <= 100 ? l : null;
    if (recente && Date.now() - recente.recebidaEm < 15000) {
      return Promise.resolve({ ok: true, lat: recente.lat, lng: recente.lng, prec: recente.prec, t: recente.recebidaEm });
    }
    if (!('geolocation' in navigator)) return Promise.resolve({ ok: false, motivo: 'aparelho sem GPS' });
    return new Promise(function (resolve) {
      navigator.geolocation.getCurrentPosition(function (p) {
        var agora = Date.now();
        resolve({ ok: true, lat: p.coords.latitude, lng: p.coords.longitude, prec: p.coords.accuracy,
          t: p.timestamp && Math.abs(p.timestamp - agora) < 864e5 ? p.timestamp : agora });
      }, function (e) {
        // Parado no mesmo lugar o GPS pode não entregar leitura nova: usa a última
        // leitura do rastreamento se for de até 2 min atrás (com o horário real dela).
        if (e.code !== 1 && recente && Date.now() - recente.recebidaEm < 120000) {
          resolve({ ok: true, lat: recente.lat, lng: recente.lng, prec: recente.prec, t: recente.recebidaEm });
          return;
        }
        resolve({ ok: false, motivo: e.code === 1 ? 'permissão de localização negada' : e.code === 2 ? 'GPS desligado ou indisponível' : 'sem sinal de GPS' });
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 });
    });
  }

  function salvarMsgPendentes() {
    if (!estado.part) return;
    C.local.gravar(CHAVE_MSGS, { participante_id: estado.part.participante_id, itens: estado.msgPendentes });
  }

  // Posição sem esperar o GPS: a leitura do rastreamento dos últimos 2 min, se houver.
  function posicaoRecente() {
    var l = estado.ultimaLeitura;
    if (l && l.prec != null && l.prec <= 100 && Date.now() - l.recebidaEm < 120000) {
      return { ok: true, lat: l.lat, lng: l.lng, prec: l.prec, t: l.recebidaEm };
    }
    return null;
  }

  // Envia aos bombeiros (mensagem, relato ou pedido de ajuda). A localização vai
  // junto automaticamente quando existir; nunca é inventada.
  async function enviarAosBombeiros(categoria, texto, posicao) {
    var item = { client_id: C.uuid(), categoria: categoria, texto: String(texto).slice(0, 1000), criada_local: Date.now() };
    if (posicao && posicao.ok) {
      item.lat = Math.round(posicao.lat * 1e7) / 1e7;
      item.lng = Math.round(posicao.lng * 1e7) / 1e7;
      item.prec = posicao.prec == null ? null : Math.round(posicao.prec * 10) / 10;
      item.t = posicao.t;
    }
    estado.msgPendentes.push(item);
    salvarMsgPendentes();
    renderizarHistorico();
    var ok = await enviarMensagemPendente(item);
    return { ok: ok, item: item };
  }

  async function aoEnviarMensagem(ev) {
    ev.preventDefault();
    if (!estado.part || estado.finalizado) return;
    var texto = $('msg-texto').value.trim();
    if (!texto) {
      UI.aviso('Escreva a mensagem antes de enviar.', 'erro');
      $('msg-texto').focus();
      return;
    }
    var btn = $('btn-enviar-msg');
    btn.disabled = true;
    try {
      $('msg-texto').value = '';
      var r = await enviarAosBombeiros('MENSAGEM', texto, posicaoRecente());
      if (r.ok) UI.aviso('Mensagem enviada aos bombeiros.', 'ok');
      else if (!r.item.erro) UI.aviso('Sem internet: a mensagem vai ser enviada quando o sinal voltar.', 'erro', 7000);
    } finally {
      btn.disabled = false;
    }
  }

  // Um botão só para o que o participante registra: mensagem, algo encontrado ou foto.
  function abrirRegistro() {
    if (!estado.part || estado.finalizado) return;
    var novas = Number($('falar-contador').textContent) || 0;
    var fechar = null;
    var fotoCamera = UI.el('input', { classe: 'sr-only', type: 'file', accept: 'image/*', capture: 'environment' });
    var fotoGaleria = UI.el('input', { classe: 'sr-only', type: 'file', accept: 'image/*' });
    fotoCamera.addEventListener('change', function (ev) { fechar(); aoEscolherFoto(ev, true); });
    fotoGaleria.addEventListener('change', function (ev) { fechar(); aoEscolherFoto(ev, false); });
    function opcao(icone, titulo, sub, acao) {
      return UI.el('button', { classe: 'opcao-registro', type: 'button', onclick: function () { fechar(); acao(); } }, [
        UI.el('span', { classe: 'opcao-registro-icone', 'aria-hidden': 'true', texto: icone }),
        UI.el('span', { classe: 'opcao-registro-texto' }, [UI.el('strong', { texto: titulo }), UI.el('small', { texto: sub })]),
      ]);
    }
    fechar = UI.abrirModal(UI.el('div', { classe: 'registro' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Registrar informação' }),
      opcao('💬', 'Mensagem aos bombeiros', novas ? novas + ' resposta(s) nova(s)' : 'Escrever o que está acontecendo', abrirConversa),
      opcao('🔍', 'Algo encontrado', 'Pista, objeto, vestígio, obstáculo ou vítima', abrirEncontrei),
      UI.el('div', { classe: 'opcao-registro opcao-registro-foto' }, [
        UI.el('span', { classe: 'opcao-registro-icone', 'aria-hidden': 'true', texto: '📷' }),
        UI.el('span', { classe: 'opcao-registro-texto' }, [UI.el('strong', { texto: 'Foto' }), UI.el('small', { texto: 'Tirar agora ou escolher da galeria' })]),
        UI.el('span', { classe: 'registro-foto-botoes' }, [
          UI.el('label', { classe: 'btn btn-pequeno btn-escuro' }, ['Tirar', fotoCamera]),
          UI.el('label', { classe: 'btn btn-pequeno' }, ['Galeria', fotoGaleria]),
        ]),
      ]),
    ]), { fecharNoFundo: true });
  }

  // "Algo encontrado": escolhe o que é, escreve (se quiser), anexa fotos e envia com a localização.
  function abrirEncontrei() {
    if (!estado.part || estado.finalizado) return;
    var opcoes = [
      ['PISTA', 'Possível pista', 'pegada, rastro, roupa'],
      ['OBJETO', 'Objeto', 'mochila, celular, documento'],
      ['VESTIGIO', 'Vestígio', 'sangue, fogueira, restos'],
      ['OBSTACULO', 'Obstáculo', 'rio, barranco, mata fechada'],
      ['OUTRO', 'Outra coisa', 'informação importante'],
    ];
    var grade = UI.el('div', { classe: 'encontrei-opcoes' });
    var fechar = UI.abrirModal(UI.el('div', { classe: 'encontrei' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'O que você encontrou?' }),
      UI.el('button', { classe: 'opcao-encontrei opcao-vitima', type: 'button', id: 'encontrei-vitima', onclick: function () { escolherCondicaoVitima(); } }, [
        UI.el('strong', { texto: 'Encontrei a vítima' }), UI.el('span', { texto: 'a pessoa que está sendo procurada' }),
      ]),
      grade,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } })]),
    ]));
    opcoes.forEach(function (o) {
      grade.appendChild(UI.el('button', { classe: 'opcao-encontrei', type: 'button', 'data-cat': o[0], onclick: function () { fechar(); detalharEncontrei(o); } }, [
        UI.el('strong', { texto: o[1] }), UI.el('span', { texto: o[2] }),
      ]));
    });
  }

  function detalharEncontrei(o) {
    var area = UI.el('textarea', { classe: 'campo', id: 'encontrei-texto', rows: '2', maxlength: '1000', placeholder: 'Ex.: mochila azul perto da cerca' });
    var btnEnviar = UI.el('button', { classe: 'btn btn-primario btn-gigante', type: 'button', id: 'encontrei-enviar', texto: 'ENVIAR AOS BOMBEIROS' });
    // Fotos do registro: cada uma abre a prévia e segue com a mesma descrição e a localização
    function legendaFoto() { return o[1] + (area.value.trim() ? ': ' + area.value.trim() : ''); }
    var fotoCamera = UI.el('input', { classe: 'sr-only', type: 'file', accept: 'image/*', capture: 'environment', id: 'encontrei-foto-camera' });
    var fotoGaleria = UI.el('input', { classe: 'sr-only', type: 'file', accept: 'image/*', id: 'encontrei-foto-galeria' });
    fotoCamera.addEventListener('change', function (ev) { aoEscolherFoto(ev, true, legendaFoto()); });
    fotoGaleria.addEventListener('change', function (ev) { aoEscolherFoto(ev, false, legendaFoto()); });
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', texto: o[1] }),
      UI.campo('Descreva (opcional)', area, { para: 'encontrei-texto', dica: 'Sua localização vai junto.' }),
      UI.el('div', { classe: 'registro-fotos' }, [
        UI.el('label', { classe: 'btn btn-escuro' }, ['📷 Tirar foto', fotoCamera]),
        UI.el('label', { classe: 'btn' }, ['🖼 Da galeria', fotoGaleria]),
      ]),
      UI.el('div', { classe: 'encontrei-botoes' }, [btnEnviar]),
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Voltar', onclick: function () { fechar(); abrirEncontrei(); } })]),
    ]), { fecharNoFundo: false });
    var enviado = false;
    async function enviar() {
      if (enviado) return;
      enviado = true;
      var texto = area.value.trim() || o[1] + ' encontrado(a) aqui';
      var pos = posicaoRecente() || await obterPosicaoAgora();
      if (!pos.ok) UI.aviso('Sem GPS agora: o aviso vai sem a localização.', 'erro', 6000);
      var r = await enviarAosBombeiros(o[0], texto, pos);
      if (r.ok) UI.aviso('Os bombeiros receberam: ' + o[1] + '.', 'ok', 5000);
      else if (!r.item.erro) UI.aviso('Sem internet: o aviso vai ser enviado quando o sinal voltar.', 'erro', 7000);
    }
    btnEnviar.addEventListener('click', function () { fechar(); enviar(); });
  }

  // "Encontrei a vítima": escolhe a condição, confirma e envia com a localização.
  // A condição vai só ao servidor (corpo da chamada, nunca na URL); depois do envio
  // este aparelho mostra apenas o termo neutro. Sem texto livre neste fluxo.
  function escolherCondicaoVitima() {
    if (!estado.part || estado.finalizado) return;
    var fechar = UI.abrirModal(UI.el('div', { classe: 'encontrei' }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Encontrei a vítima' }, [UI.dica('Só os bombeiros responsáveis veem.')]),
      UI.el('div', { classe: 'encontrei-opcoes' }, [
        UI.el('button', { classe: 'opcao-encontrei opcao-condicao', type: 'button', id: 'vitima-viva', onclick: function () { fechar(); confirmarVitima('viva', 'Viva'); } }, [
          UI.el('strong', { texto: 'Viva' }),
        ]),
        UI.el('button', { classe: 'opcao-encontrei opcao-condicao', type: 'button', id: 'vitima-obito', onclick: function () { fechar(); confirmarVitima('obito', 'Morta'); } }, [
          UI.el('strong', { texto: 'Morta' }),
        ]),
      ]),
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Voltar', onclick: function () { fechar(); } })]),
    ]), { fecharNoFundo: false });
  }

  function confirmarVitima(condicao, rotulo) {
    var btnEnviar = UI.el('button', { classe: 'btn btn-primario btn-gigante', type: 'button', id: 'vitima-confirmar', texto: 'CONFIRMAR E ENVIAR' });
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Confirmar envio?' }, [UI.dica('Sua localização vai junto. Depois, este celular mostra só "' + TEXTO_VITIMA + '".')]),
      UI.el('p', { classe: 'confirma-condicao', texto: 'Vítima: ' + rotulo }),
      UI.el('div', { classe: 'encontrei-botoes' }, [btnEnviar]),
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Voltar', onclick: function () { fechar(); } })]),
    ]), { fecharNoFundo: false });
    var enviado = false;
    btnEnviar.addEventListener('click', async function () {
      if (enviado) return;
      enviado = true;
      fechar();
      var pos = posicaoRecente() || await obterPosicaoAgora();
      if (!pos.ok) UI.aviso('Sem GPS agora: o aviso vai sem a localização.', 'erro', 6000);
      var item = { client_id: C.uuid(), categoria: 'VITIMA', condicao: condicao, texto: TEXTO_VITIMA, criada_local: Date.now() };
      if (pos.ok) {
        item.lat = Math.round(pos.lat * 1e7) / 1e7;
        item.lng = Math.round(pos.lng * 1e7) / 1e7;
        item.prec = pos.prec == null ? null : Math.round(pos.prec * 10) / 10;
        item.t = pos.t;
      }
      // A fila (sem internet) guarda a condição só até o servidor confirmar o envio.
      estado.msgPendentes.push(item);
      salvarMsgPendentes();
      renderizarHistorico();
      var ok = await enviarMensagemPendente(item);
      if (ok) UI.aviso('Os bombeiros foram avisados. ' + TEXTO_VITIMA + '.', 'ok', 6000);
      else if (!item.erro) UI.aviso('Sem internet: o aviso vai ser enviado quando o sinal voltar.', 'erro', 7000);
    });
  }

  // Mensagens em envio agora (por client_id): a volta da internet dispara o reenvio por mais de um
  // caminho ao mesmo tempo; a mesma mensagem nunca vai em dois pedidos paralelos.
  var msgEmEnvio = new Set();

  // Erro de duplicidade de versões antigas do banco: a mensagem já estava gravada; tentar de novo
  // devolve a gravada (o servidor reconhece o client_id).
  function erroDuplicidade(texto) {
    return /mensagens_cliente_unico|duplicate key|23505/.test(String(texto || ''));
  }

  async function enviarMensagemPendente(item) {
    if (msgEmEnvio.has(item.client_id)) return false;
    msgEmEnvio.add(item.client_id);
    try {
      var m = item.categoria === 'VITIMA' ? await C.rpc('participante_registrar_vitima', {
        p_participante: estado.part.participante_id,
        p_condicao: item.condicao,
        p_lat: item.lat != null ? item.lat : null,
        p_lng: item.lng != null ? item.lng : null,
        p_precisao: item.prec != null ? item.prec : null,
        p_posicao_em: item.t ? new Date(item.t).toISOString() : null,
        p_client_id: item.client_id,
      }) : await C.rpc('participante_enviar_mensagem', {
        p_participante: estado.part.participante_id,
        p_categoria: item.categoria,
        p_texto: item.texto,
        p_lat: item.lat != null ? item.lat : null,
        p_lng: item.lng != null ? item.lng : null,
        p_precisao: item.prec != null ? item.prec : null,
        p_posicao_em: item.t ? new Date(item.t).toISOString() : null,
        p_client_id: item.client_id,
      });
      marcarSucesso();
      receberMensagens([m]);
      return true;
    } catch (e) {
      if (tratarErroFatal(e)) return false;
      if (!e.rede && !erroDuplicidade(e.message) && !erroDuplicidade(e.codigo)) {
        item.erro = e.message;
        salvarMsgPendentes();
        renderizarHistorico();
        UI.aviso(e.message, 'erro', 7000);
      }
      return false;
    } finally {
      msgEmEnvio.delete(item.client_id);
    }
  }

  // Reenvia em ordem o que ficou no aparelho. Uma rodada por vez.
  async function reenviarMensagens() {
    if (estado.reenviandoMsgs) return;
    estado.reenviandoMsgs = true;
    try {
      var mudou = false;
      estado.msgPendentes.forEach(function (x) {
        if (x.erro && erroDuplicidade(x.erro)) { delete x.erro; mudou = true; }
      });
      if (mudou) { salvarMsgPendentes(); renderizarHistorico(); }
      var copia = estado.msgPendentes.filter(function (x) { return !x.erro; });
      for (var i = 0; i < copia.length; i++) {
        if (estado.msgPendentes.indexOf(copia[i]) === -1) continue;   // já confirmada por outro caminho
        if (!(await enviarMensagemPendente(copia[i]))) break;
      }
    } finally {
      estado.reenviandoMsgs = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Fotos georreferenciadas                                              */
  /* ------------------------------------------------------------------ */
  // Fila de fotos no aparelho (IndexedDB): sobrevive a falta de internet e a
  // recarregar a página. Sem IndexedDB, a fila fica só na memória.
  var banco = { db: null };
  function abrirBanco() {
    if (banco.db !== null) return Promise.resolve(banco.db);
    return new Promise(function (resolve) {
      try {
        var r = indexedDB.open('gbs-civil', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('fotos', { keyPath: 'id' }); };
        r.onsuccess = function () { banco.db = r.result; resolve(banco.db); };
        r.onerror = function () { banco.db = false; resolve(false); };
      } catch (e) { banco.db = false; resolve(false); }
    });
  }
  async function bancoOp(modo, fn) {
    var db = await abrirBanco();
    if (!db) return null;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction('fotos', modo);
        var req = fn(tx.objectStore('fotos'));
        tx.oncomplete = function () { resolve(req ? req.result : null); };
        tx.onerror = tx.onabort = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function guardarFotoLocal(item) { estado.fotosLocais.set(item.id, item); return bancoOp('readwrite', function (st) { return st.put(item); }); }
  function apagarFotoLocal(id) {
    var it = estado.fotosLocais.get(id);
    if (it && it.urlPrevia) URL.revokeObjectURL(it.urlPrevia);
    estado.fotosLocais.delete(id);
    return bancoOp('readwrite', function (st) { return st.delete(id); });
  }
  async function carregarFilaFotos() {
    var todos = (await bancoOp('readonly', function (st) { return st.getAll(); })) || [];
    todos.forEach(function (it) {
      if (estado.part && it.participante_id === estado.part.participante_id) {
        if (it.estado === 'enviando') it.estado = 'fila';
        estado.fotosLocais.set(it.id, it);
      } else {
        bancoOp('readwrite', function (st) { return st.delete(it.id); });
      }
    });
    renderizarFotos();
  }

  async function aoEscolherFoto(ev, daCamera, legenda) {
    var arquivo = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!arquivo || !estado.part || estado.finalizado) return;
    var f = await window.Fotos.lerArquivo(arquivo, daCamera, obterPosicaoAgora);
    if (!f || !estado.part || estado.finalizado) return;
    // Prévia: confirma ou cancela antes de salvar (Fotos.abrirPrevia).
    window.Fotos.abrirPrevia(f, {
      simples: true,
      legenda: legenda || '',
      obterPosicao: obterPosicaoAgora,
      aoSalvar: async function (d) {
        var item = Object.assign(d, {
          id: C.uuid(),
          participante_id: estado.part.participante_id,
          operacao_id: estado.part.operacao_id,
          criada_local: Date.now(),
          estado: 'fila',
        });
        await guardarFotoLocal(item);
        if (item.origem === 'pendente') {
          lerPendencias().push({ id: item.id, capturada: item.capturada, fix: null });
          gravarPendencias();
          aguardarLocalFoto(item.id, item.capturada);
        }
        renderizarFotos();
        processarFilaFotos();
      },
    });
  }

  /* ---------- Local pendente das fotos (GPS respondeu depois) ----------- */
  var pendencias = null;
  function lerPendencias() {
    if (!pendencias) {
      var v = C.local.ler(CHAVE_FOTOS_PEND, null);
      pendencias = v && estado.part && v.participante_id === estado.part.participante_id && Array.isArray(v.itens) ? v.itens : [];
    }
    return pendencias;
  }
  function gravarPendencias() {
    if (!estado.part) return;
    C.local.gravar(CHAVE_FOTOS_PEND, { participante_id: estado.part.participante_id, itens: lerPendencias() });
  }
  function aguardarLocalFoto(id, capturada) {
    window.Fotos.aguardarLocal(capturada, function (pos) { aplicarLocalPendente(id, pos); });
  }
  // O GPS respondeu (pos) ou o prazo acabou (null)
  async function aplicarLocalPendente(id, pos) {
    var pend = lerPendencias().find(function (x) { return x.id === id; });
    if (!pend) return;
    var it = estado.fotosLocais.get(id);
    if (it && it.estado !== 'enviando') {
      // ainda no aparelho: a foto já sai com o local
      if (pos) Object.assign(it, { origem: 'gps', lat: pos.lat, lng: pos.lng, prec: pos.prec, posicao_em: pos.t });
      else it.origem = 'nenhuma';
      await guardarFotoLocal(it);
      pendencias = lerPendencias().filter(function (x) { return x.id !== id; });
      gravarPendencias();
      renderizarFotos();
      return;
    }
    pend.fix = pos || 'nenhuma';
    gravarPendencias();
    enviarLocaisPendentes();
  }
  // Fotos já registradas no servidor: envia o local que chegou depois
  async function enviarLocaisPendentes() {
    if (!estado.part || estado.enviandoLocais) return;
    estado.enviandoLocais = true;
    try {
      var lista = lerPendencias().filter(function (x) { return x.fix && !estado.fotosLocais.has(x.id); });
      for (var i = 0; i < lista.length; i++) {
        var x = lista[i];
        try {
          var f = await window.Fotos.atualizarLocal(estado.part.participante_id, x.id, x.fix === 'nenhuma' ? null : x.fix);
          pendencias = lerPendencias().filter(function (y) { return y.id !== x.id; });
          gravarPendencias();
          if (f && f.id) estado.minhasFotos = estado.minhasFotos.map(function (m) { return m.id === f.id ? f : m; });
        } catch (e) {
          if (e.rede) break;   // tenta de novo quando a conexão voltar
          if (e.codigo !== 'foto_nao_encontrada') {   // a foto ainda não chegou: espera; outro erro: desiste deste local
            pendencias = lerPendencias().filter(function (y) { return y.id !== x.id; });
            gravarPendencias();
          }
        }
      }
    } finally {
      estado.enviandoLocais = false;
      renderizarFotos();
    }
  }
  // Ao abrir a página: volta a esperar o GPS das fotos ainda no prazo
  function retomarLocaisPendentes() {
    pendencias = null;
    var agora = Date.now();
    lerPendencias().forEach(function (x) {
      if (x.fix) return;
      if (x.capturada + window.Fotos.PENDENTE_DEPOIS_MS > agora) aguardarLocalFoto(x.id, x.capturada);
      else aplicarLocalPendente(x.id, null);
    });
    enviarLocaisPendentes();
  }

  async function processarFilaFotos() {
    if (estado.enviandoFotos || !estado.part || estado.finalizado) return;
    var fila = Array.from(estado.fotosLocais.values())
      .filter(function (it) { return it.estado !== 'erro'; })
      .sort(function (a, b) { return a.criada_local - b.criada_local; });
    if (!fila.length) return;
    estado.enviandoFotos = true;
    try {
      for (var i = 0; i < fila.length; i++) {
        var it = fila[i];
        it.estado = 'enviando';
        renderizarFotos();
        try {
          await enviarFoto(it);
          await apagarFotoLocal(it.id);
          UI.aviso('Foto enviada aos bombeiros.', 'ok');
          enviarLocaisPendentes();
        } catch (e) {
          if (tratarErroFatal(e)) return;
          it.estado = e.rede ? 'fila' : 'erro';
          it.erro = e.rede ? null : e.message;
          await guardarFotoLocal(it);
          renderizarFotos();
          if (e.rede) {
            UI.aviso('Sem internet: a foto ficou guardada e vai ser enviada quando o sinal voltar.', 'erro', 7000);
            break;
          }
          UI.aviso('A foto não foi enviada: ' + e.message, 'erro', 8000);
        }
      }
    } finally {
      estado.enviandoFotos = false;
      renderizarFotos();
    }
  }

  async function enviarFoto(it) {
    var foto = await window.Fotos.enviar(it);
    marcarSucesso();
    estado.minhasFotos = [foto].concat(estado.minhasFotos.filter(function (x) { return x.id !== foto.id; }));
    estado.urlsFotos.set(foto.caminho, { url: URL.createObjectURL(it.blob), exp: Infinity });
  }

  async function carregarMinhasFotos() {
    if (!estado.part) return;
    try {
      var lista = await C.consultar(C.cliente.from('fotos').select('*').eq('participante_id', estado.part.participante_id)
        .order('registrada_em', { ascending: false }).limit(20));
      estado.minhasFotos = lista || [];
      var faltam = estado.minhasFotos.map(function (f) { return f.caminho; }).filter(function (c) { return !estado.urlsFotos.has(c); });
      if (faltam.length) {
        var r = await C.cliente.storage.from('fotos').createSignedUrls(faltam, 3600);
        (r.data || []).forEach(function (d) { if (d.signedUrl) estado.urlsFotos.set(d.path, { url: d.signedUrl }); });
      }
    } catch (e) { /* tenta de novo depois */ }
    renderizarFotos();
  }

  // Suas fotos: miniaturas. Na fila mostra "esperando internet"; se falhar, tentar de novo ou apagar.
  function renderizarFotos() {
    var ul = $('fotos-minhas');
    if (!ul) return;
    ul.innerHTML = '';
    var locais = Array.from(estado.fotosLocais.values()).sort(function (a, b) { return b.criada_local - a.criada_local; });
    locais.forEach(function (it) {
      if (!it.urlPrevia) it.urlPrevia = URL.createObjectURL(it.blob);
      var li = UI.el('li', { classe: 'foto-item ' + (it.estado === 'erro' ? 'erro' : 'fila') }, [
        UI.el('img', { src: it.urlPrevia, alt: it.legenda || 'Foto' }),
        UI.el('span', { classe: 'foto-selo', texto: (it.estado === 'enviando' ? 'Enviando…' : it.estado === 'erro' ? 'Não enviada' : 'Esperando internet') + (it.origem === 'pendente' ? ' · 📍 localizando' : '') }),
      ]);
      if (it.estado === 'erro' || it.estado === 'fila') {
        li.appendChild(UI.el('div', { classe: 'foto-acoes' }, [
          UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Tentar', onclick: function () { it.estado = 'fila'; it.erro = null; processarFilaFotos(); } }),
          UI.el('button', { classe: 'btn btn-pequeno btn-perigo', type: 'button', texto: 'Apagar', onclick: async function () {
            var ok = await UI.confirmar({ titulo: 'Apagar esta foto?', texto: 'Ela ainda não foi enviada. Apagada, a foto se perde.', ok: 'Apagar', perigo: true });
            if (!ok) return;
            await apagarFotoLocal(it.id); renderizarFotos();
          } }),
        ]));
      }
      ul.appendChild(li);
    });
    estado.minhasFotos.forEach(function (f) {
      var u = estado.urlsFotos.get(f.caminho);
      ul.appendChild(UI.el('li', { classe: 'foto-item enviada' }, [
        u ? UI.el('img', { src: u.url, alt: f.legenda || 'Foto enviada' }) : UI.el('div', { classe: 'foto-sem-previa', texto: 'Foto' }),
        UI.el('span', { classe: 'foto-selo ok', texto: '✓ Enviada' + (f.origem_posicao === 'pendente' ? ' · 📍 localizando' : '') }),
      ]));
    });
    $('fotos-civil').hidden = !ul.children.length;
  }

  /* ------------------------------------------------------------------ */
  /* Alertas sonoros, vibração e notificações                            */
  /* ------------------------------------------------------------------ */
  function prepararAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !estado.audio) estado.audio = new AC();
      if (estado.audio && estado.audio.state === 'suspended') estado.audio.resume();
    } catch (e) { /* sem áudio */ }
  }

  function bipe() {
    var ac = estado.audio;
    if (!ac) return;
    try {
      var t = ac.currentTime;
      [0, 0.35, 0.7].forEach(function (d) {
        var o = ac.createOscillator();
        var g = ac.createGain();
        o.type = 'square';
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(0.35, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.25);
        o.connect(g);
        g.connect(ac.destination);
        o.start(t + d);
        o.stop(t + d + 0.3);
      });
    } catch (e) { /* ignora */ }
  }

  function chamarAtencao() {
    try { if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 800]); } catch (e) { /* ignora */ }
    bipe();
    if (NATIVO && document.hidden) {
      var pa = pendentesDeConfirmacao()[0];
      var ta = pa ? (C.TIPOS_MENSAGEM[pa.tipo] || C.TIPOS_MENSAGEM.PERSONALIZADA) : null;
      // o id evita aviso repetido: o serviço do aplicativo também avisa as mensagens com a tela apagada
      APP.notificar('Bombeiros: ' + (ta && pa.tipo !== 'PERSONALIZADA' ? ta.titulo : 'nova mensagem'), pa ? (pa.tipo !== 'PERSONALIZADA' ? ta.titulo + ': ' : '') + (pa.texto || ta.padrao) : 'Abra o aplicativo.', pa ? pa.id : null).catch(function () { /* sem aviso */ });
      return;
    }
    if (document.hidden && estado.swReg && window.Notification && Notification.permission === 'granted') {
      var pend = pendentesDeConfirmacao();
      var m = pend[0];
      var tipo = m ? (C.TIPOS_MENSAGEM[m.tipo] || C.TIPOS_MENSAGEM.PERSONALIZADA) : null;
      try {
        estado.swReg.showNotification('Bombeiros: ' + (tipo && m.tipo !== 'PERSONALIZADA' ? tipo.titulo : 'nova mensagem'), {
          body: m ? (m.texto || tipo.padrao) : 'Abra a página da busca.',
          tag: 'sar-msg',
          renotify: true,
          requireInteraction: true,
          vibrate: [400, 150, 400, 150, 800],
        });
      } catch (e) { /* ignora */ }
    }
  }

  function registrarServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      estado.swReg = reg;
      atualizarNotifBotao();
    }).catch(function () { /* sem SW: notificações indisponíveis */ });
  }

  function atualizarNotifBotao() {
    var b = $('btn-notif');
    b.hidden = !(window.Notification && Notification.permission === 'default' && 'serviceWorker' in navigator);
  }

  function ativarNotificacoes() {
    if (!window.Notification) return;
    Notification.requestPermission().then(function (p) {
      atualizarNotifBotao();
      if (p === 'granted') UI.aviso('Pronto. Mesmo assim, deixe esta tela aberta.', 'ok');
    });
  }

  /* ------------------------------------------------------------------ */
  /* Tela ligada (Wake Lock)                                              */
  /* ------------------------------------------------------------------ */
  async function pedirTelaLigada() {
    if (NATIVO || !estado.rastreando || !$('opt-tela').checked || estado.wakeLock || !('wakeLock' in navigator)) return;
    if (document.visibilityState !== 'visible') return;
    try {
      estado.wakeLock = await navigator.wakeLock.request('screen');
      estado.wakeLock.addEventListener('release', function () { estado.wakeLock = null; });
    } catch (e) { estado.wakeLock = null; }
  }

  function liberarTelaLigada() {
    if (estado.wakeLock) {
      try { estado.wakeLock.release(); } catch (e) { /* ignora */ }
      estado.wakeLock = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Segundo plano: detecção de pausas                                    */
  /* ------------------------------------------------------------------ */
  function avisarPausa(ms) {
    var min = Math.max(1, Math.round(ms / 60000));
    var caixa = $('aviso-fundo');
    caixa.textContent = 'O celular parou de enviar sua localização por cerca de ' + min + ' min. Deixe esta tela aberta e o celular desbloqueado.';
    caixa.hidden = false;
  }

  function tique() {
    var agora = Date.now();
    var gap = agora - estado.ultimoTique;
    estado.ultimoTique = agora;
    if (NATIVO) { tiqueApp(agora); return; }
    if (estado.rastreando && gap > 30000) {
      avisarPausa(gap);
      enviarSinal();
      agendarEnvio(0);
    }
    if (estado.rastreando && estado.ultimaLeitura && agora - estado.ultimaLeitura.recebidaEm > CFG.semGpsMs &&
        (estado.gps === 'ok' || estado.gps === 'fraco')) {
      estado.gps = 'sem_sinal';
    }
    // Parado, alguns aparelhos só avisam quando há mudança: pede uma leitura nova
    // no ritmo do intervalo de GPS da operação (padrão 15 s), para a trilha ter
    // pelo menos um ponto nesse intervalo (o filtro decide se a leitura entra).
    var intervalo = Math.max(5000, estado.filtro.cfg.intervaloParadoMs - 2000);
    if (estado.rastreando && estado.ultimaLeitura && estado.gps !== 'negado' && agora - estado.ultimaLeitura.recebidaEm > intervalo &&
        agora - (estado.leituraPedidaEm || 0) > intervalo) {
      estado.leituraPedidaEm = agora;
      navigator.geolocation.getCurrentPosition(processarPosicao, function () { /* o observador trata os erros */ },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    }
    // Alguns aparelhos param de entregar leituras sem avisar: reinicia o observador
    // (sempre um só) se ficar 90 s sem nada com a tela aberta e a permissão concedida.
    var ultima = estado.ultimaLeitura ? estado.ultimaLeitura.recebidaEm : 0;
    if (estado.rastreando && document.visibilityState === 'visible' && estado.permissao !== 'denied' &&
        estado.gps !== 'negado' && agora - Math.max(ultima, estado.watchIniciadoEm) > CFG.reiniciarGpsMs) {
      pararWatch();
      iniciarWatch();
    }
    atualizarUI();
    agendarNavegacao();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !estado.part) return;
    if (estado.finalizado) { if (estado.timerReinclusao) verificarReinclusao(); return; }
    pedirTelaLigada();
    enviarSinal();
    agendarEnvio(0);
    carregarDestino();
    carregarEquipe();
    acompanharPermissao().then(function () { if (estado.permissao === 'granted' && estado.gps === 'negado') religarGps(); });
  });
  window.addEventListener('online', function () {
    if (estado.part && !estado.finalizado) {
      enviarSinal(); agendarEnvio(0); reenviarMensagens(); processarFilaFotos(); carregarDestino();
      if (estado.destino && !estado.rota) { estado.rotaErroEm = 0; calcularRota('tentar'); }
      enviarFilaMil();
    }
    fundoConformeRede();
    atualizarUI();
  });
  window.addEventListener('offline', function () { fundoConformeRede(); atualizarUI(); });
  // Os avisos sobem logo acima da barra de ações (no militar, o botão Menu fica lá embaixo e não pode ser coberto).
  (function acompanharBarraAvisos() {
    var barra = document.querySelector('#tela-rastreio .acoes-civil');
    var avisos = $('avisos');
    if (!barra || !avisos) return;
    function ajustar() {
      var alto = barra.offsetHeight || 0;
      avisos.style.bottom = (alto ? alto + 14 : 16) + 'px';
    }
    if (window.ResizeObserver) new ResizeObserver(ajustar).observe(barra);
    window.addEventListener('resize', ajustar);
    window.addEventListener('orientationchange', ajustar);
    ajustar();
  })();
  window.addEventListener('pagehide', function () { if (estado.trilha) estado.trilha.persistirPendentes(); });
  window.addEventListener('beforeunload', function (ev) {
    if (estado.rastreando && !window.GBS_RECARREGANDO && !NATIVO) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });

  /* ------------------------------------------------------------------ */
  /* Pedido de encerramento / encerrar                                    */
  /* ------------------------------------------------------------------ */
  // O participante não interrompe o rastreamento: ele pede ao responsável,
  // que libera a saída pelo painel. Até lá, o envio continua normalmente.
  async function aoSolicitarSaida() {
    if (estado.saidaSolicitadaEm) return;
    var r = await UI.confirmar({
      titulo: 'Quer sair da busca?',
      texto: 'Os bombeiros vão receber seu pedido e liberar sua saída. Até lá, deixe esta tela aberta.',
      campo: { rotulo: 'Motivo (se quiser)', valor: '', max: 200 },
      ok: 'Pedir para sair',
      cancelar: 'Voltar',
    });
    if (!r) return;
    var botoesSaida = [$('btn-saida'), $('menu-saida')];
    botoesSaida.forEach(function (b) { b.disabled = true; });
    try {
      var resp = await C.rpc('solicitar_saida', { p_participante: estado.part.participante_id, p_motivo: r.texto || '' });
      estado.saidaSolicitadaEm = resp && resp.saida_solicitada_em ? resp.saida_solicitada_em : new Date().toISOString();
      marcarSucesso();
      UI.aviso('Pedido enviado. Aguarde os bombeiros liberarem.', 'ok', 6000);
    } catch (e) {
      if (!tratarErroFatal(e)) UI.aviso(e.rede ? 'Sem internet: não deu para enviar o pedido. Tente de novo.' : e.message, 'erro', 7000);
    } finally {
      botoesSaida.forEach(function (b) { b.disabled = false; });
      atualizarUI();
    }
  }

  function pararColeta() {
    estado.rastreando = false;
    pararWatch();
    liberarTelaLigada();
    atualizarUI();
  }

  function finalizar(motivo) {
    // o código do aplicativo foi pedido aqui e a participação sumiu desta sessão: o aplicativo assumiu
    if (motivo === 'inexistente' && estado.appVinculoPedidoEm && !NATIVO) motivo = 'aplicativo';
    if (motivo === 'inexistente' && NATIVO) motivo = 'aparelho';   // aberta em outro celular (ou operação excluída)
    if (NATIVO) APP.parar(motivo).catch(function () { /* o aplicativo já parou */ });
    estado.finalizado = true;
    pararColeta();
    estado.filtro.reiniciar();
    clearInterval(estado.timerSinal);
    clearInterval(estado.timerUI);
    clearInterval(estado.timerEquipe);
    estado.timerEquipe = null;
    window.removeEventListener('deviceorientationabsolute', aoGirar);
    window.removeEventListener('deviceorientation', aoGirar);
    $('navegacao').hidden = true;
    $('painel-conversa').hidden = true;
    document.body.classList.remove('conversa-aberta');
    clearTimeout(estado.timerEnvio);
    estado.timerSinal = estado.timerUI = null;
    if (estado.canal) {
      try { C.cliente.removeChannel(estado.canal); } catch (e) { /* ignora */ }
      estado.canal = null;
    }
    $('alerta-msg').hidden = true;
    var podeVoltar = (motivo === 'removido' || motivo === 'liberado') && estado.part;
    if (podeVoltar) salvarParticipacao(false, true);   // guarda para uma reinclusão (sem fila nem mensagens)
    else C.local.apagar(CHAVE_PART);
    C.local.apagar(CHAVE_FILA);
    C.local.apagar(CHAVE_CONF);
    C.local.apagar(CHAVE_MSGS);
    C.local.apagar(CHAVE_VISTO);
    C.local.apagar(CHAVE_FOTOS_PEND);
    pendencias = null;
    var naFila = estado.fotosLocais.size;
    estado.fotosLocais.forEach(function (it, id) { apagarFotoLocal(id); });
    if (naFila) UI.aviso(naFila + ' foto(s) que ainda não tinham sido enviadas foram descartadas.', 'erro', 8000);
    var textos = {
      encerrada: ['Busca encerrada', 'Os bombeiros encerraram esta busca. Obrigado pela sua ajuda!'],
      removido: ['Participação encerrada', 'Os bombeiros encerraram a sua participação nesta busca.'],
      liberado: ['Saída liberada', 'Os bombeiros liberaram a sua saída. Obrigado pela sua ajuda!'],
      inexistente: ['Participação encerrada', 'A operação foi excluída pelos bombeiros. Este link não funciona mais.'],
      aplicativo: ['O registro passou para o aplicativo', 'Sua localização agora vai para os bombeiros pelo aplicativo GBS Busca, neste celular. Esta página parou de enviar.'],
      aparelho: ['Participação encerrada neste celular', 'A participação foi aberta em outro aparelho ou a operação foi excluída pelos bombeiros. Este celular parou de enviar a localização.'],
    };
    var t = textos[motivo] || textos.encerrada;
    estado.motivoFim = motivo;
    // A participação acabou: o servidor não aceita mais pontos. Limpa a fila do aparelho.
    if (estado.trilha) estado.trilha.limpar();
    fecharTrilha();
    estado.filaLegada = null;
    estado.destino = null;
    estado.destinoConfirmado = null;
    $('navegacao').hidden = true;
    $('fim-titulo').textContent = t[0];
    $('fim-texto').textContent = t[1];
    $('fim-voltar').hidden = true;
    $('fim-nota').textContent = podeVoltar
      ? 'Sua localização não está mais sendo compartilhada.'
      : 'Sua localização não está mais sendo compartilhada. Você já pode fechar esta página.';
    $('fim-aguardando').hidden = !podeVoltar;
    clearInterval(estado.timerReinclusao);
    estado.timerReinclusao = podeVoltar ? setInterval(verificarReinclusao, CFG.reinclusaoMs) : null;
    mostrarTela('encerrado');
  }

  /* ------------------------------------------------------------------ */
  /* Reinclusão: os bombeiros chamaram de volta                           */
  /* ------------------------------------------------------------------ */
  // Removido ou com saída liberada: a página verifica (sem enviar localização)
  // se o responsável reincluiu este participante. Se sim, oferece o botão para
  // voltar — o rastreamento só recomeça com o toque da pessoa.
  async function verificarReinclusao() {
    if (!estado.part || !estado.finalizado) return;
    var r;
    try {
      r = await C.rpc('sinal_vida', { p_participante: estado.part.participante_id, p_rastreando: false, p_gps: null }, 12000);
    } catch (e) { return; }
    if (!r) return;
    if (r.status === 'ativa') {
      clearInterval(estado.timerReinclusao);
      estado.timerReinclusao = null;
      $('fim-aguardando').hidden = true;
      $('fim-voltar').hidden = false;
      prepararAudio();
      chamarAtencao();
      $('btn-voltar-busca').focus();
    } else if (r.status === 'encerrada' || r.status === 'inexistente') {
      clearInterval(estado.timerReinclusao);
      estado.timerReinclusao = null;
      C.local.apagar(CHAVE_PART);
      finalizar(r.status);
    }
  }

  async function voltarParaBusca() {
    var s = C.local.ler(CHAVE_PART, null);
    if (!s || s.token !== estado.token) { location.reload(); return; }
    $('fim-voltar').hidden = true;
    $('ini-nome').value = s.nome || '';
    $('ini-cpf').value = mascararCpf(s.cpf || '');
    $('ini-tel').value = mascararTelefone(s.telefone || '');
    $('btn-iniciar').textContent = 'CONTINUAR';
    mostrarTela('inicio');
    await entrarNaBusca({ nome: s.nome, tipo: s.tipo, cpf: s.cpf, tel: s.telefone });
  }

  /* ------------------------------------------------------------------ */
  /* Diagnóstico do GPS (só neste aparelho; abre com ?diag=1 no link)      */
  /* ------------------------------------------------------------------ */
  function abrirDiagnostico() {
    var f = estado.filtro;
    var caixa = UI.el('div', { classe: 'diag-tabela' });
    function render() {
      caixa.innerHTML = window.GPS.tabelaDiagnostico(f, 80);
    }
    render();
    var resumo = f.resumo().map(function (x) { return x.texto + ': ' + x.qtd; }).join(' · ');
    var timer = setInterval(render, 2000);
    var fechar = UI.abrirModal(UI.el('div', { classe: 'modal-diag form-padrao' }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Diagnóstico do GPS' },
        [UI.dica('Fica só neste aparelho; não é enviado. Permissão: ' + estado.permissao + ' · estado: ' + estado.gps + ' · na fila: ' + qtdPendentes() + ' ponto(s) · intervalo máximo: ' + Math.round(f.cfg.intervaloParadoMs / 1000) + ' s.' +
          (estado.trilha ? ' · guardados em ' + estado.trilha.tipo + ' · enviados ' + estado.trilha.qtdEnviados() + ' · recusados ' + estado.trilha.recusados().length + (estado.trilha.falhaGravacao ? ' · falha ao gravar: ' + estado.trilha.falhaGravacao : '') : ''))]),
      UI.el('p', { classe: 'ajuda', texto: resumo || 'Sem leituras ainda.' }),
      caixa,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]), { aoFechar: function () { clearInterval(timer); } });
  }

  /* ------------------------------------------------------------------ */
  /* Aplicativo Android (js/app-nativo.js)                                 */
  /* ------------------------------------------------------------------ */
  function posicaoDoApp(d) {
    return { coords: { latitude: d.lat, longitude: d.lng, accuracy: d.prec, speed: d.vel, heading: d.rumo == null ? null : d.rumo }, timestamp: d.t };
  }

  function lerCodigoApp() {
    var v = (new URLSearchParams(location.hash.replace(/^#/, '')).get('v') || '').trim().toLowerCase();
    return /^[0-9a-f]{32}$/.test(v) ? v : null;
  }

  // O serviço do aplicativo é quem lê e envia o GPS: a página recebe as leituras (mapa, navegação, alerta de risco),
  // os pontos guardados (trilha no mapa) e o estado (pendentes, último envio, situação do GPS).
  function ouvirApp() {
    APP.ao('leitura', function (d) { if (estado.rastreando && !estado.finalizado) processarPosicao(posicaoDoApp(d)); });
    APP.ao('pontos', function (d) { if (estado.rastreando && !estado.finalizado) desenharPontosApp(d.pontos); });
    APP.ao('estado', function (d) {
      estado.nativo = d;
      if (estado.rastreando && ['ok', 'fraco', 'sem_sinal', 'negado', 'indisponivel'].indexOf(d.gps) !== -1) estado.gps = d.gps;
      if (d.ultimoEnvioEm && (!estado.ultimoEnviadoT || d.ultimoEnvioEm > estado.ultimoEnviadoT)) estado.ultimoEnviadoT = d.ultimoEnvioEm;
      if (d.ultimoContatoEm && d.ultimoContatoEm > estado.ultimoSucesso) estado.ultimoSucesso = d.ultimoContatoEm;
      atualizarUI();
    });
    APP.ao('mensagens', function () { if (estado.part && !estado.finalizado) buscarMensagens(); });   // o serviço viu mensagem nova
    APP.ao('finalizado', function (d) { if (estado.part && !estado.finalizado) finalizar(d.motivo || 'encerrada'); });
  }

  // Trilha no mapa com o que o aplicativo guardou: cada ponto uma vez e sempre em ordem (o histórico e os pontos novos
  // podem chegar ao mesmo tempo ao reabrir o aplicativo).
  function desenharPontosApp(pontos) {
    var vistos = estado.idsTrilhaApp = estado.idsTrilhaApp || new Set();
    var novos = (pontos || []).filter(function (q) {
      if (!q || vistos.has(q.id) || (estado.ultimoTMinha != null && q.t <= estado.ultimoTMinha)) return false;
      vistos.add(q.id);
      return true;
    }).sort(function (a, b) { return a.t - b.t; });
    if (novos.length) atualizarMinhaTrilha(novos);
  }

  // Aberto pelo botão "Abrir no aplicativo": resgata o código de uso único (a participação passa para a sessão do
  // aplicativo) e entra na busca com o mesmo cadastro. Sem sucesso, segue o caminho normal da página.
  async function vincularPeloApp(codigo) {
    try { history.replaceState(null, '', location.pathname + location.search + '#t=' + estado.token + '&app=1'); } catch (e) { /* segue */ }
    APP.vinculoUsado().catch(function () { /* o código vence sozinho */ });
    mostrarTela('carregando');
    var r;
    try {
      await garantirSessao();
      try {
        r = await C.rpc('app_vinculo_resgatar', { p_codigo: codigo });
      } catch (e) {
        if (e.codigo !== 'sessao_app_ocupada') throw e;
        // este aplicativo já tinha entrado na busca por conta própria: fica com a participação que veio do navegador
        try { await C.cliente.auth.signOut({ scope: 'local' }); } catch (x) { /* sem sessão */ }
        await garantirSessao();
        r = await C.rpc('app_vinculo_resgatar', { p_codigo: codigo });
      }
    } catch (e) {
      UI.aviso(e.rede ? 'Sem internet para trazer o seu cadastro do navegador. Conecte-se e toque de novo em "Abrir no aplicativo".' : e.message, 'erro', 8000);
      return false;
    }
    C.local.gravar(CHAVE_PART, { token: estado.token, participante_id: r.participante_id, nome: r.nome, tipo: r.tipo, operacao: r.operacao,
      grupo: r.grupo || null, cpf: r.cpf || '', telefone: r.telefone || '', ativo: true, removido: false });
    $('ini-nome').value = r.nome || '';
    $('ini-cpf').value = mascararCpf(r.cpf || '');
    $('ini-tel').value = mascararTelefone(r.telefone || '');
    $('btn-iniciar').textContent = 'CONTINUAR';
    mostrarTela('inicio');
    UI.aviso('Cadastro trazido do navegador. Permita a localização para o aplicativo.', 'ok', 5000);
    await entrarNaBusca({ nome: r.nome, tipo: r.tipo, cpf: r.cpf, tel: r.telefone });
    return true;
  }

  // Entrega ao aplicativo o que o serviço precisa para enviar sozinho. O segredo do aparelho é pedido ao servidor uma vez
  // por participação e fica só no aplicativo (a página não guarda).
  async function ligarNativo() {
    if (!NATIVO || !estado.part || estado.finalizado || !estado.rastreando || estado.ligandoNativo) return;
    estado.ligandoNativo = true;
    estado.nativoTentadoEm = Date.now();
    try {
      var info = await APP.info();
      estado.appInfo = info;
      estado.appInfoEm = Date.now();
      var cfgApp = window.APP_CONFIG || {};
      var dados = {
        supabaseUrl: cfgApp.supabaseUrl, supabaseKey: cfgApp.supabaseKey, participanteId: estado.part.participante_id,
        intervaloParadoMs: estado.filtro.cfg.intervaloParadoMs, nome: estado.part.nome, operacao: estado.part.operacao || '',
      };
      if (!(info.participante === estado.part.participante_id && info.temAparelho)) {
        var d = await C.rpc('app_dispositivo_registrar', { p_participante: estado.part.participante_id, p_modelo: info.modelo || '' });
        dados.dispositivoId = d.dispositivo_id;
        dados.segredo = d.segredo;
      }
      if (!estado.trilhaDoAppCarregada) {
        // o que o serviço já guardou (aplicativo reaberto com o registro em andamento)
        estado.trilhaDoAppCarregada = true;
        desenharPontosApp((await APP.pontos()).pontos);
      }
      var r = await APP.iniciar(dados);
      estado.nativoErro = r.ok ? null : r.erro || 'falha';
      if (r.erro === 'negado') estado.gps = 'negado';
    } catch (e) {
      if (!tratarErroFatal(e)) estado.nativoErro = e.rede ? 'rede' : e.codigo || 'falha';
    } finally {
      estado.ligandoNativo = false;
      atualizarUI();
    }
  }

  function tiqueApp(agora) {
    if (estado.rastreando && !estado.finalizado && (estado.nativoErro || !estado.nativo || !estado.nativo.rastreando) &&
        agora - (estado.nativoTentadoEm || 0) > 15000) ligarNativo();
    if (estado.rastreando && agora - (estado.appInfoEm || 0) > 30000) {
      estado.appInfoEm = agora;
      APP.info().then(function (i) { estado.appInfo = i; }).catch(function () { /* tenta depois */ });
    }
    atualizarUI();
    agendarNavegacao();
  }

  function mostrarEstadoApp() {
    var el = $('fila-estado');
    if (!el) return;
    var txt = APP.textoEstado(estado.nativo);
    if (estado.nativoErro && estado.nativoErro !== 'negado') {
      txt = '📱 O aplicativo ainda não começou a registrar (' + (estado.nativoErro === 'rede' ? 'sem internet para ativar' : estado.nativoErro) + '). Tentando de novo…';
    }
    var bateria = Boolean(estado.appInfo && estado.appInfo.bateriaLiberada === false);
    var chave = txt + '|' + bateria;
    if (el._chave === chave) return;
    el._chave = chave;
    el.textContent = '';
    el.hidden = !txt;
    el.appendChild(UI.el('span', { texto: txt }));
    if (bateria) {
      el.appendChild(UI.el('button', { classe: 'btn btn-pequeno btn-bateria', type: 'button', texto: 'Liberar a bateria (recomendado)', title: 'Tira o aplicativo da economia de bateria do Android: o envio não atrasa com a tela apagada.',
        onclick: function () { APP.bateria().then(function (r) { if (estado.appInfo) estado.appInfo.bateriaLiberada = Boolean(r.ignorando); atualizarUI(); }).catch(function () { /* nada */ }); } }));
    }
  }

  function instrucoesApp(problema) {
    if (problema === 'indisponivel') {
      return { titulo: 'Ligue a localização do celular', passos: ['Toque em "Abrir configurações".', 'Ligue a "Localização" (ou "Usar localização").', 'Volte para o aplicativo.'] };
    }
    return { titulo: 'Permita a localização para o aplicativo', passos: ['Toque em "Abrir configurações".', 'Entre em "Permissões" e depois em "Localização".',
      'Escolha "Permitir durante o uso do app" e deixe "Usar local exato" ligado.', 'Volte para o aplicativo.'] };
  }

  function comoResolverNoApp() {
    var problema = estado.gps;
    var inst = instrucoesApp(problema);
    var fechar = UI.abrirModal(UI.el('div', { classe: 'form-padrao' }, [
      UI.el('h2', { id: 'modal-titulo', texto: inst.titulo }),
      UI.el('ol', { classe: 'perm-passos' }, inst.passos.map(function (p) { return UI.el('li', { texto: p }); })),
      UI.rodape([
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Verificar de novo', onclick: function () { fechar(); ligarNativo(); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Abrir configurações', onclick: function () {
          fechar();
          (problema === 'indisponivel' ? APP.localizacaoDoCelular() : APP.configuracoes()).catch(function () { /* nada */ });
        } }),
      ]),
    ]));
  }

  // No aplicativo, o mapa da região da operação (setores e pontos) é guardado no celular logo ao entrar, além da área
  // em volta da posição (que a página já guarda): o mapa funciona sem internet onde a busca acontece.
  function guardarMapaDaOperacao(setores, pontos) {
    var M = window.MapaOffline;
    if (modelosPacote()) return;   // com servidor próprio de mapas, o pacote de 10 km já cobre a operação
    if (estado.mapaOperacaoFeito || !M || !M.disponivel() || estado.mapaBaixando || navigator.onLine === false) return;
    var lats = [], lngs = [];
    setores.forEach(function (st) {
      if (st.forma === 'circulo' && st.centro_lat != null) { lats.push(st.centro_lat); lngs.push(st.centro_lng); }
      (st.pontos || []).forEach(function (q) { if (q && q.length === 2) { lats.push(q[0]); lngs.push(q[1]); } });
    });
    pontos.forEach(function (q) { if (q.lat != null) { lats.push(q.lat); lngs.push(q.lng); } });
    estado.mapaOperacaoFeito = true;
    if (!lats.length) return;   // operação sem setores nem pontos: fica a área em volta da posição
    var la0 = Math.min.apply(null, lats), la1 = Math.max.apply(null, lats), ln0 = Math.min.apply(null, lngs), ln1 = Math.max.apply(null, lngs);
    var c = { lat: (la0 + la1) / 2, lng: (ln0 + ln1) / 2 };
    var raio = Math.max(M.RAIO_PADRAO_M, Math.min(15000, M.distanciaM(la0, ln0, la1, ln1) / 2 + 500));
    if (M.precisaArea(areasMapa(), c.lat, c.lng)) baixarAreaMapa({ lat: c.lat, lng: c.lng, raioM: raio, motivo: 'operação' });
  }

  /* ---------- Navegador: oferecer o aplicativo ---------- */
  function oferecerApp() {
    if (!APP.ehAndroid(navigator.userAgent) || APP.ehApp(navigator.userAgent) || !window.fetch) return;
    fetch('/api/app', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.disponivel) return;
      estado.appBaixar = j.baixar;
      $('ini-app').hidden = false;
      $('btn-app').hidden = false;
    }).catch(function () { /* sem o botão */ });
  }

  // Logo depois do cadastro (uma vez por participação): abre sozinho o passo a passo do aplicativo. O botão
  // "Baixar aplicativo" (no menu) continua lá para quem fechar o aviso.
  function oferecerAppAposCadastro() {
    if (NATIVO || !estado.appBaixar || !estado.part || estado.finalizado || estado.abrindoApp) return;
    if (document.querySelector('.modal-fundo')) { setTimeout(oferecerAppAposCadastro, 2500); return; }
    var feito = C.local.ler(CHAVE_APP_OFERECIDO, null);
    if (feito && feito.participante_id === estado.part.participante_id) return;
    C.local.gravar(CHAVE_APP_OFERECIDO, { participante_id: estado.part.participante_id, em: Date.now() });
    abrirBaixarApp(true);
  }

  // Quem já tem o aplicativo: abre nele direto (sem o passo a passo). Sem o aplicativo, o Chrome cai no download.
  function abrirNoAplicativo() {
    var origem = location.origin;
    var link = APP.linkApp(origem, estado.token, null);
    try { if (navigator.clipboard) navigator.clipboard.writeText(link).catch(function () { /* sem permissão */ }); } catch (e) { /* segue */ }
    location.href = APP.linkIntent(origem, estado.token, null, origem + (estado.appBaixar || '/api/app?baixar=1'));
  }

  // Passo a passo: baixar, instalar e abrir o aplicativo já nesta busca. Quem já está participando leva o cadastro
  // por um código de uso único (30 min); o aplicativo assume e esta página para de enviar (evita trilha em dobro).
  async function abrirBaixarApp(automatico) {
    if (estado.abrindoApp) return;
    estado.abrindoApp = true;
    var participando = Boolean(estado.part && !estado.finalizado);
    var codigo = null, aviso = null;
    try {
      if (participando) {
        try { if (estado.trilha && qtdParaEnviar()) await enviarFila(); } catch (e) { /* o que faltar fica na fila */ }
        try {
          codigo = (await C.rpc('app_vinculo_criar', { p_participante: estado.part.participante_id }, 12000)).codigo;
          estado.appVinculoPedidoEm = Date.now();
        } catch (e) {
          if (tratarErroFatal(e)) return;
          aviso = e.rede ? 'Sem internet agora. Baixe e instale; para abrir o aplicativo já com o seu cadastro, toque em "Tentar de novo" com internet.' : e.message;
        }
      }
    } finally {
      estado.abrindoApp = false;
    }
    var origem = location.origin;
    var link = APP.linkApp(origem, estado.token, codigo);
    var intent = APP.linkIntent(origem, estado.token, codigo, origem + (estado.appBaixar || '/api/app?baixar=1'));
    // O aplicativo, ao abrir pela primeira vez, lê este link da área de transferência e já entra na busca.
    var copiar = function () { try { if (navigator.clipboard) navigator.clipboard.writeText(link).catch(function () { /* sem permissão */ }); } catch (e) { /* segue */ } };
    var baixar = UI.el('a', { classe: 'btn btn-primario', href: estado.appBaixar || '/api/app?baixar=1', rel: 'noopener', texto: '⬇ Baixar o aplicativo', onclick: copiar });
    var abrir = UI.el('a', { classe: 'btn btn-escuro', href: intent, texto: '📱 Abrir no aplicativo', onclick: copiar });
    var podeAbrir = !participando || Boolean(codigo);
    var fechar = UI.abrirModal(UI.el('div', { classe: 'form-padrao modal-app' }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: automatico === true ? 'Baixe o aplicativo para ajudar melhor' : 'Aplicativo para Android' }, [UI.dica(
        'É a mesma página da busca, com o GPS lido pelo próprio celular: a localização continua indo com a tela apagada e, sem internet, ' +
        'fica guardada no celular e vai sozinha quando o sinal voltar. O arquivo vem do servidor dos bombeiros (não da Play Store), ' +
        'por isso o Android pede para permitir a instalação.')]),
      UI.secao('1. Baixar', [UI.el('p', { classe: 'ajuda', texto: 'Se o Chrome avisar que o arquivo pode ser perigoso, toque em "Baixar mesmo assim".' }), baixar]),
      UI.secao('2. Instalar', [UI.el('p', { classe: 'ajuda', texto: 'Quando terminar, toque em "Abrir" (ou abra gbs-busca.apk em Downloads). ' +
        'Se o Android pedir, permita "Instalar apps desconhecidos" para o Chrome, volte e toque em "Instalar".' })]),
      UI.secao('3. Abrir nesta busca', [
        UI.el('p', { classe: 'ajuda', texto: codigo
          ? 'Depois de instalar, toque abaixo: o aplicativo abre nesta busca com o seu cadastro, sem preencher nada. Quando ele assumir, esta página para de enviar.'
          : 'Depois de instalar, toque abaixo: o aplicativo abre nesta busca.' }),
        podeAbrir ? abrir : null,
      ]),
      aviso ? UI.el('p', { classe: 'erro-form', role: 'alert', texto: aviso }) : null,
      aviso ? UI.rodape([UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Tentar de novo', onclick: function () { abrirBaixarApp(); } })]) : null,
      automatico === true ? UI.rodape([UI.el('button', { classe: 'btn', type: 'button', id: 'app-agora-nao', texto: 'Agora não', onclick: function () { fechar(); } }),
        UI.el('p', { classe: 'ajuda', texto: 'Depois, se quiser, use o botão "Baixar aplicativo" no menu.' })]) : null,
    ]));
  }

  /* ------------------------------------------------------------------ */
  /* Atualização da interface                                             */
  /* ------------------------------------------------------------------ */
  function atualizarUI() {
    if (!estado.part || estado.finalizado) return;
    aplicarTipoUI();
    var grupos = (estado.grupos || []).map(function (g) { return 'Grupo ' + g.nome + (g.papel === 'responsavel' ? ' (responsável)' : ''); });
    var quem = [estado.part.nome, estado.part.operacao].concat(grupos).join(' · ');
    if ($('st-nome').textContent !== quem) $('st-nome').textContent = quem;

    registrarGpsNaFila();
    if (NATIVO) mostrarEstadoApp();
    else if (!estado.filaUI && $('fila-estado') && window.FilaEstado) {
      estado.filaUI = window.FilaEstado.montar($('fila-estado'), {
        fila: function () { return estado.trilha; },
        extra: function () { return { pendentes: estado.bufferPontos.length, naoDuraveis: estado.bufferPontos.length }; },
        ativo: function () { return Boolean(estado.part && !estado.finalizado); },
        // o participante só vê o bloco técnico quando há risco de perder pontos (o resto está no quadro de estado)
        mostrar: function (r) { return r.nivel === 'erro'; },
      });
    }
    if (estado.filaUI) estado.filaUI.atualizar();
    var net = estadoInternet();
    var pend = qtdPendentes();
    var cod, titulo, sub;
    if (!estado.rastreando) {
      cod = 'parado'; titulo = 'Localização desligada'; sub = 'Toque em CONTINUAR para voltar a ajudar.';
    } else if (estado.gps === 'negado') {
      cod = 'erro'; titulo = 'A localização está bloqueada';
      sub = 'Os bombeiros NÃO estão vendo você. Toque em "Como resolver".';
    } else if (estado.gps === 'indisponivel') {
      cod = 'erro'; titulo = 'A localização do celular está desligada';
      sub = 'Os bombeiros NÃO estão vendo você. Toque em "Como resolver".';
    } else if (estado.gps !== 'ok' && estado.gps !== 'fraco') {
      cod = 'sem-gps'; titulo = 'Procurando o sinal de GPS…'; sub = 'Se puder, vá para um lugar aberto, longe de paredes e árvores.';
    } else if (net === 'offline' || net === 'falha') {
      cod = 'sem-internet'; titulo = 'Sem internet agora';
      sub = 'Sua localização está sendo guardada e vai ser enviada quando o sinal voltar.' + (pend ? ' (' + pend + ' guardada' + (pend > 1 ? 's' : '') + ')' : '');
    } else if (net === 'conectando' && !estado.ultimoEnviadoT) {
      cod = 'sem-gps'; titulo = 'Conectando com os bombeiros…'; sub = 'Só um instante.';
    } else if (estado.gravarTrilha === false) {
      cod = 'sem-gps'; titulo = 'Seu caminho não está sendo gravado';
      sub = 'Os bombeiros veem a sua posição, mas o caminho não fica registrado.';
    } else {
      cod = 'ok'; titulo = 'Os bombeiros estão vendo você';
      sub = '';
    }
    var acao = $('status-acao');
    var precisaAjuda = estado.rastreando && (estado.gps === 'negado' || estado.gps === 'indisponivel' ||
      (estado.gps === 'sem_sinal' && estado.ultimaLeitura == null && Date.now() - estado.watchIniciadoEm > 30000));
    if (acao.hidden === precisaAjuda) acao.hidden = !precisaAjuda;
    var caixa = $('status-civil');
    caixa.hidden = cod === 'ok';   // tudo certo: a caixa não aparece (só os problemas)
    if (caixa.getAttribute('data-estado') !== cod) caixa.setAttribute('data-estado', cod);
    if ($('status-titulo').textContent !== titulo) $('status-titulo').textContent = titulo;
    if ($('status-sub').textContent !== sub) $('status-sub').textContent = sub;

    // Pedido de saída
    var pendente = Boolean(estado.saidaSolicitadaEm);
    $('saida-pendente').hidden = !pendente;
    if (pendente) $('saida-hora').textContent = C.hora(estado.saidaSolicitadaEm, false);
    $('btn-saida').hidden = pendente;
    $('menu-saida').hidden = pendente;
    $('btn-menu').classList.toggle('tem-aviso', pendente);
  }

  iniciar();
})();
