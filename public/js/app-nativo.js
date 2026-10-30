/* =====================================================================
 * app-nativo.js — ligação da página do participante com o aplicativo Android (GBS Busca).
 *
 *   No navegador comum não faz nada (window.GBSApp.disponivel = false): a página funciona como sempre.
 *   Dentro do aplicativo, a página recebe o objeto GBSNativo (só para a origem do servidor). O GPS passa a ser lido
 *   e enviado pelo serviço do aplicativo (continua com a tela apagada); a página mostra o mapa, as mensagens e o estado.
 *
 *   Também monta os links do botão "Baixar aplicativo": o de abrir o aplicativo já com a busca
 *   (gbsbusca://vincular?o=servidor&t=token&v=código de uso único) e a versão "intent:" do Chrome no Android.
 * ===================================================================== */
(function (global) {
  'use strict';

  var PACOTE = 'br.gbs.busca';
  var ESQUEMA = 'gbsbusca';

  function linkApp(origem, token, codigo) {
    var q = 'o=' + encodeURIComponent(origem) + '&t=' + encodeURIComponent(token) + (codigo ? '&v=' + encodeURIComponent(codigo) : '');
    return ESQUEMA + '://vincular?' + q;
  }

  // Chrome no Android: abre o aplicativo instalado; sem ele, volta para o endereço de reserva.
  function linkIntent(origem, token, codigo, reserva) {
    var q = linkApp(origem, token, codigo).slice((ESQUEMA + '://').length);
    return 'intent://' + q + '#Intent;scheme=' + ESQUEMA + ';package=' + PACOTE +
      (reserva ? ';S.browser_fallback_url=' + encodeURIComponent(reserva) : '') + ';end';
  }

  function ehAndroid(ua) { return /Android/i.test(ua || ''); }
  function ehApp(ua) { return /GBSApp\//.test(ua || ''); }

  function duracao(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' s';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  }

  // Uma linha sobre o registro feito pelo aplicativo (pontos guardados no celular e último envio confirmado).
  function textoEstado(e, agora) {
    if (!e) return '';
    agora = agora || Date.now();
    var partes = [];
    if (!e.rastreando) partes.push('📱 Aplicativo: registro parado');
    else partes.push('📱 Registro pelo aplicativo (continua com a tela apagada)');
    if (e.pendentes > 0) partes.push(e.pendentes + ' ponto' + (e.pendentes > 1 ? 's' : '') + ' guardado' + (e.pendentes > 1 ? 's' : '') + ' no celular, aguardando envio');
    if (e.ultimoEnvioEm) partes.push('último envio confirmado há ' + duracao(agora - e.ultimoEnvioEm));
    if (e.falhaGravacao) partes.push('⚠ não foi possível gravar no celular (espaço cheio?)');
    if (e.ultimoErro === 'funcao_ausente') partes.push('⚠ servidor desatualizado: avise os bombeiros');
    return partes.join(' · ');
  }

  var API = { PACOTE: PACOTE, ESQUEMA: ESQUEMA, linkApp: linkApp, linkIntent: linkIntent, ehAndroid: ehAndroid, ehApp: ehApp, textoEstado: textoEstado, disponivel: false };

  var N = global.GBSNativo;
  if (N && typeof N.postMessage === 'function') {
    var pendentes = {}, seq = 0, ouvintes = {};
    N.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && pendentes[m.id]) {
        var p = pendentes[m.id];
        delete pendentes[m.id];
        clearTimeout(p.timer);
        p.resolve(m.dados || {});
      } else if (m.evento) {
        (ouvintes[m.evento] || []).forEach(function (fn) { try { fn(m.dados || {}); } catch (e) { /* um ouvinte com erro não para os outros */ } });
      }
    };
    var pedir = function (acao, dados, ms) {
      return new Promise(function (resolve, reject) {
        var id = 'p' + (++seq);
        pendentes[id] = {
          resolve: resolve,
          timer: setTimeout(function () { delete pendentes[id]; reject(new Error('aplicativo_sem_resposta')); }, ms || 15000),
        };
        N.postMessage(JSON.stringify({ id: id, acao: acao, dados: dados || {} }));
      });
    };
    API.disponivel = true;
    API.ao = function (evento, fn) { (ouvintes[evento] = ouvintes[evento] || []).push(fn); };
    API.info = function () { return pedir('ola'); };
    API.permissao = function () { return pedir('permissao', null, 300000); };
    API.posicao = function () { return pedir('posicao', null, 25000); };
    API.iniciar = function (cfg) { return pedir('iniciar', cfg); };
    API.parar = function (motivo) { return pedir('parar', { motivo: motivo }); };
    API.estado = function () { return pedir('estado'); };
    API.pontos = function () { return pedir('pontos'); };
    API.vinculoUsado = function () { return pedir('vinculoUsado'); };
    API.bateria = function () { return pedir('bateria'); };
    API.configuracoes = function () { return pedir('configuracoes'); };
    API.localizacaoDoCelular = function () { return pedir('localizacaoDoCelular'); };
    API.notificar = function (titulo, texto) { return pedir('notificar', { titulo: titulo, texto: texto }); };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.GBSApp = API;
})(typeof window !== 'undefined' ? window : globalThis);
