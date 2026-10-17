/* =====================================================================
 * app-android.js — página do civil no Android: botão do aplicativo e
 * o próprio aplicativo (APK, pasta app-android/, Capacitor)
 *
 * No navegador do Android (fora do app): na tela inicial aparecem
 * "BAIXAR O APLICATIVO" e "ABRIR NO APLICATIVO". O app é a mesma página;
 * a diferença é que ele continua mandando a localização com a tela apagada.
 *
 * Dentro do app:
 *   - navigator.geolocation passa a usar o plugin de GPS em segundo plano
 *     (@capacitor-community/background-geolocation). O restante da página
 *     (filtro de GPS, fila no aparelho, envio) não muda.
 *   - as chamadas de campo (posições e sinal de vida) vão pelo HTTP nativo:
 *     o Android limita a rede da página depois de ~5 min em segundo plano.
 *   - o último convite fica guardado: aberto pelo ícone, o app volta a ele.
 * iPhone: nada muda (continua só pelo link).
 * ===================================================================== */
(function () {
  'use strict';

  var APK = '/baixar-app';                     // vercel.json: redireciona para o APK da última versão
  var ESQUEMA = 'gbscivil';                    // AndroidManifest.xml (MainActivity)
  var PACOTE = 'br.gbs.rastreamento.civil';    // capacitor.config.json → appId
  var CHAVE_CONVITE = 'gbs.app.convite';
  var CHAVE_GPS_OK = 'gbs.app.gps_ok';
  var CHAVE_PART = 'sar-civil-participacao';   // civil.js: participação salva no aparelho
  // comunicacao.js: onde o Supabase guarda a sessão desta página
  var CHAVE_SESSAO = 'sar-sessao-' + (document.documentElement.getAttribute('data-pagina') || 'app');

  var cap = window.Capacitor;
  var noApp = Boolean(cap && cap.isNativePlatform && cap.isNativePlatform() && cap.getPlatform() === 'android');
  // Tablets Android abrem o Chrome no modo "site para computador": o navegador se apresenta como Linux.
  // Linux com tela de toque (e não Chromebook) é, na prática, Android.
  var ua = navigator.userAgent || '';
  var android = /Android/i.test(ua) ||
    Boolean(navigator.userAgentData && navigator.userAgentData.platform === 'Android') ||
    (/Linux/i.test(ua) && !/CrOS/i.test(ua) && navigator.maxTouchPoints > 0);

  var api = { noApp: noApp, redirecionando: false, rpc: null, pronto: null };
  window.AppAndroid = api;

  function tokenDaUrl() {
    var doHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('t');
    var daBusca = new URLSearchParams(location.search).get('t');
    var t = (doHash || daBusca || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(t) ? t : null;
  }
  function ler(chave) { try { return localStorage.getItem(chave); } catch (e) { return null; } }
  function gravar(chave, v) { try { localStorage.setItem(chave, v); } catch (e) { /* armazenamento indisponível */ } }

  /* ------------------------------------------------------------------ */
  /* Dentro do app                                                        */
  /* ------------------------------------------------------------------ */
  if (noApp) {
    document.documentElement.classList.add('no-app');
    var convite = tokenDaUrl();
    if (convite) {
      gravar(CHAVE_CONVITE, convite);
    } else if (ler(CHAVE_CONVITE)) {
      // aberto pelo ícone (sem convite no endereço): volta para o último convite
      api.redirecionando = true;
      location.replace(location.pathname + '?t=' + ler(CHAVE_CONVITE));
      return;
    }
    receberSessao();
    instalarGpsNativo();
    api.rpc = criarRpcNativa();
  }

  // Vindo do navegador depois do cadastro: a sessão e a participação chegam no fim do endereço
  // (#s=..., não vai ao servidor). Com a mesma sessão o app continua a mesma pessoa no painel;
  // a página retoma sozinha e o Android pede a localização na hora.
  function receberSessao() {
    var s = new URLSearchParams(location.hash.replace(/^#/, '')).get('s');
    if (!s) return;
    history.replaceState(null, '', location.pathname + location.search);
    var pacote = null;
    try { pacote = JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return; }
    if (!pacote || !pacote.a || !pacote.r) return;
    if (pacote.p) gravar(CHAVE_PART, JSON.stringify(pacote.p));
    gravar(CHAVE_GPS_OK, '1');
    var C = window.Comunicacao;
    if (C && C.cliente) {
      api.pronto = C.cliente.auth.setSession({ access_token: pacote.a, refresh_token: pacote.r }).catch(function () { /* segue sem: cadastro de novo */ });
    }
  }

  // Leituras do plugin no formato do navigator.geolocation (o que civil.js e gps.js esperam)
  function comoPosicao(l) {
    return {
      coords: {
        latitude: l.latitude, longitude: l.longitude, accuracy: l.accuracy,
        altitude: l.altitude, altitudeAccuracy: l.altitudeAccuracy, heading: l.bearing, speed: l.speed,
      },
      timestamp: l.time || Date.now(),
    };
  }
  // O plugin usa NOT_AUTHORIZED tanto para permissão negada quanto para localização desligada.
  function comoErro(e) {
    var msg = (e && e.message) || '';
    var desligada = /disabled/i.test(msg);
    var negada = e && e.code === 'NOT_AUTHORIZED' && !desligada;
    return {
      code: negada ? 1 : 2,
      message: negada ? 'Permissão de localização negada' : desligada ? 'Localização do celular desligada' : msg || 'Falha no GPS',
      PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3,
    };
  }

  // Um só observador nativo para todos os pedidos da página. Com "backgroundMessage" o
  // Android mantém o GPS com a tela apagada, mostrando a notificação fixa.
  function instalarGpsNativo() {
    var BG = cap.registerPlugin('BackgroundGeolocation');
    var geo = navigator.geolocation;
    var observadores = new Map(), seq = 0;
    var esperando = [];            // pedidos de getCurrentPosition aguardando a próxima leitura
    var nativo = null;             // id do observador nativo (ou a promessa enquanto liga)
    var permissao = ler(CHAVE_GPS_OK) ? 'granted' : 'prompt';

    function ligar() {
      if (nativo) return;
      var pedido = BG.addWatcher({
        backgroundTitle: 'Rastreamento GBS',
        backgroundMessage: 'Sua localização está sendo enviada aos bombeiros.',
        requestPermissions: true,
        stale: false,
        distanceFilter: 0,
      }, aoReceber);
      nativo = pedido;
      pedido.then(function (id) {
        // se a página parou de pedir (ou houve erro) enquanto ligava, desliga o que acabou de ligar
        if (nativo === pedido) { nativo = id; desligarSeOcioso(); } else BG.removeWatcher({ id: id }).catch(function () {});
      }, function (e) {
        if (nativo === pedido) nativo = null;
        aoReceber(null, e);
      });
    }
    function desligarSeOcioso() {
      if (observadores.size || esperando.length || !nativo || typeof nativo !== 'string') return;
      var id = nativo;
      nativo = null;
      BG.removeWatcher({ id: id }).catch(function () { /* já parado */ });
    }
    function aoReceber(l, e) {
      if (e) {
        var pe = comoErro(e);
        if (pe.code === 1) {
          permissao = 'denied';
          try { localStorage.removeItem(CHAVE_GPS_OK); } catch (x) { /* ignora */ }
        }
        observadores.forEach(function (o) { if (o.erro) o.erro(pe); });
        esperando.splice(0).forEach(function (x) { clearTimeout(x.timer); if (x.erro) x.erro(pe); });
        // sem permissão o observador nativo não volta sozinho: a página tenta de novo (religarGps)
        if (typeof nativo === 'string') { BG.removeWatcher({ id: nativo }).catch(function () {}); }
        nativo = null;
        return;
      }
      if (!l) return;
      if (permissao !== 'granted') { permissao = 'granted'; gravar(CHAVE_GPS_OK, '1'); }
      var p = comoPosicao(l);
      observadores.forEach(function (o) { o.ok(p); });
      esperando.splice(0).forEach(function (x) { clearTimeout(x.timer); x.ok(p); });
    }

    geo.watchPosition = function (ok, erro) {
      var id = ++seq;
      observadores.set(id, { ok: ok, erro: erro });
      ligar();
      return id;
    };
    geo.clearWatch = function (id) {
      observadores.delete(id);
      desligarSeOcioso();
    };
    geo.getCurrentPosition = function (ok, erro, op) {
      var x = { ok: ok, erro: erro };
      x.timer = setTimeout(function () {
        var i = esperando.indexOf(x);
        if (i !== -1) esperando.splice(i, 1);
        if (erro) erro({ code: 3, message: 'Tempo esgotado', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
        desligarSeOcioso();
      }, (op && op.timeout) || 30000);
      esperando.push(x);
      ligar();
    };

    // A Permissions API do WebView não reflete a permissão do app: usa o que o GPS nativo respondeu.
    if (window.GPS) {
      window.GPS.consultarPermissao = function () { return Promise.resolve({ estado: permissao, status: null }); };
    }
  }

  // Mesmo contrato de Comunicacao.rpc (dados ou erro traduzido), pelo HTTP nativo do Capacitor.
  function criarRpcNativa() {
    var Http = cap.registerPlugin && cap.registerPlugin('CapacitorHttp');
    var cfg = window.APP_CONFIG || {};
    if (!Http || !cfg.supabaseUrl) return null;
    var base = cfg.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/rpc/';
    return async function (nome, args, ms) {
      var C = window.Comunicacao;
      var sessao = null;
      try { sessao = (await C.cliente.auth.getSession()).data.session; } catch (e) { /* segue com a chave pública */ }
      var resp;
      try {
        resp = await Http.request({
          method: 'POST', url: base + nome, data: args || {}, responseType: 'json',
          connectTimeout: ms || 15000, readTimeout: ms || 15000,
          headers: {
            apikey: cfg.supabaseKey, Authorization: 'Bearer ' + (sessao ? sessao.access_token : cfg.supabaseKey),
            'Content-Type': 'application/json', Accept: 'application/json',
          },
        });
      } catch (e) {
        throw C.criarErro({ code: 'rede', message: (e && e.message) || 'timeout' });
      }
      if (resp.status >= 200 && resp.status < 300) return resp.data === '' ? null : resp.data;
      throw C.criarErro(resp.data && typeof resp.data === 'object' ? resp.data : { message: 'HTTP ' + resp.status + ' ' + (resp.data || '') });
    };
  }

  /* ------------------------------------------------------------------ */
  /* No navegador do Android: oferecer o aplicativo                       */
  /* ------------------------------------------------------------------ */
  // Uma faixa discreta antes do cadastro e na tela de rastreamento ([data-app-android] no civil.html).
  if (!noApp && android) {
    document.addEventListener('DOMContentLoaded', function () {
      document.querySelectorAll('[data-app-android]').forEach(function (lugar) {
        lugar.appendChild(faixa());
        lugar.hidden = false;
      });
    });
  }

  function faixa() {
    var el = window.UI.el;
    var passos = el('ol', { classe: 'app-faixa-passos', hidden: true }, [
      'Toque em Baixar (se o Chrome perguntar, Baixar mesmo assim).',
      'Abra o arquivo gbs-civil.apk pela notificação ou em Downloads.',
      'Se aparecer "instalação bloqueada": Configurações → Permitir desta fonte → Instalar.',
      'Se o Play Protect avisar: Mais detalhes → Instalar mesmo assim.',
      'Volte aqui e toque em Abrir no app. Permita a localização e as notificações.',
    ].map(function (t) { return el('li', { texto: t }); }));
    var ajuda = el('button', { classe: 'app-faixa-link', type: 'button', 'aria-expanded': 'false', texto: 'Como instalar' });
    ajuda.addEventListener('click', function () {
      passos.hidden = !passos.hidden;
      ajuda.setAttribute('aria-expanded', String(!passos.hidden));
    });
    return el('div', { classe: 'app-faixa' }, [
      el('p', { classe: 'app-faixa-texto' }, [el('strong', { texto: 'Android: ' }), 'o aplicativo envia sua localização mesmo com a tela apagada.']),
      el('div', { classe: 'app-faixa-acoes' }, [
        el('a', { classe: 'btn btn-pequeno', href: APK, texto: 'Baixar' }),
        el('button', { classe: 'btn btn-pequeno btn-escuro', type: 'button', texto: 'Abrir no app', onclick: abrirNoApp }),
        ajuda,
      ]),
      passos,
    ]);
  }

  // Instalado: abre o app no convite (e, depois do cadastro, na mesma participação).
  // Não instalado: o Chrome segue para o download do APK.
  async function abrirNoApp() {
    var t = tokenDaUrl();
    var sessao = t ? await sessaoParaApp(t) : null;
    if (sessao) vigiarPassagem();
    location.href = 'intent://abrir' + (t ? '?t=' + t + (sessao ? '&s=' + sessao : '') : '') +
      '#Intent;scheme=' + ESQUEMA + ';package=' + PACOTE +
      ';S.browser_fallback_url=' + encodeURIComponent(location.origin + APK) + ';end';
  }

  // Só depois do cadastro: sessão + participação salva, em base64 seguro para endereço.
  async function sessaoParaApp(t) {
    var p = null;
    try { p = JSON.parse(ler(CHAVE_PART) || 'null'); } catch (e) { /* sem participação */ }
    if (!p || p.token !== t || !p.participante_id || !p.ativo) return null;
    var s = null;
    try { s = (await window.Comunicacao.cliente.auth.getSession()).data.session; } catch (e) { /* sem sessão */ }
    if (!s || !s.access_token || !s.refresh_token) return null;
    var json = JSON.stringify({ a: s.access_token, r: s.refresh_token, p: p });
    return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // O app abriu se a página saiu da frente logo depois do toque. Aí o navegador para de rastrear
  // (o mesmo celular não manda a trilha em dobro) e larga a sessão: o servidor derruba uma sessão
  // renovada por dois lugares, e o app ficaria sem ela.
  function vigiarPassagem() {
    var inicio = Date.now();
    function aoSair() {
      if (document.visibilityState !== 'hidden') return;
      document.removeEventListener('visibilitychange', aoSair);
      if (Date.now() - inicio <= 5000) passarParaApp();
    }
    document.addEventListener('visibilitychange', aoSair);
    setTimeout(function () { document.removeEventListener('visibilitychange', aoSair); }, 5000);
  }

  function passarParaApp() {
    try { window.Comunicacao.cliente.auth.stopAutoRefresh(); } catch (e) { /* sem cliente */ }
    try { localStorage.removeItem(CHAVE_SESSAO); localStorage.removeItem(CHAVE_PART); } catch (e) { /* ignora */ }
    window.GBS_RECARREGANDO = true;   // sem o aviso de "sair da página"
    location.replace('app-aberto.html');
  }
})();
