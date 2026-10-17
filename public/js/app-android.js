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

  var cap = window.Capacitor;
  var noApp = Boolean(cap && cap.isNativePlatform && cap.isNativePlatform() && cap.getPlatform() === 'android');
  var android = /Android/i.test(navigator.userAgent || '');

  var api = { noApp: noApp, redirecionando: false, rpc: null };
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
    instalarGpsNativo();
    api.rpc = criarRpcNativa();
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
  /* No navegador do Android: oferecer o aplicativo na tela inicial       */
  /* ------------------------------------------------------------------ */
  if (!noApp && android) {
    document.addEventListener('DOMContentLoaded', function () {
      var caixa = document.getElementById('app-android');
      if (!caixa) return;
      caixa.hidden = false;
      document.getElementById('app-baixar').setAttribute('href', APK);
      document.getElementById('app-abrir').addEventListener('click', function () {
        var t = tokenDaUrl();
        // instalado: abre o app no convite; não instalado: o Chrome baixa o APK
        var reserva = location.origin + APK;
        location.href = 'intent://abrir' + (t ? '?t=' + t : '') + '#Intent;scheme=' + ESQUEMA + ';package=' + PACOTE +
          ';S.browser_fallback_url=' + encodeURIComponent(reserva) + ';end';
      });
    });
  }
})();
