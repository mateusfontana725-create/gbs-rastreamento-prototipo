/* =====================================================================
 * meteo.js — camada "Meteorologia" do painel do responsável.
 *   - radar de precipitação (RainViewer): quadros recentes, linha do tempo e animação
 *   - previsão para o centro da operação (Open-Meteo) e chegada estimada da chuva
 *   - alertas oficiais (INMET/CAP, quando configurado) e alertas indicativos
 *   - aviso no mapa (pode ser ocultado sem parar o monitoramento), histórico e som
 * Os dados vêm de /api/meteo (servidor). Nada é simulado: se uma fonte falhar, o aviso diz isso
 * e o mapa e o rastreamento continuam funcionando.
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, P = window.Painel, Core = window.MeteoCore;
  if (!P || !Core || !window.L) return;
  function $(id) { return document.getElementById(id); }

  var CHAVE_LIG = 'gbs-meteo-ligada', CHAVE_SOM = 'gbs-meteo-som', CHAVE_RAIO = 'gbs-meteo-raio';
  var CHAVE_HIST = 'gbs-meteo-historico:';
  var INTERVALO_MS = 5 * 60e3, LIMITE_DESATUALIZADO_MIN = 20, MIN_ENTRE_SONS_MS = 10 * 60e3;
  var NIVEIS = { informativo: 'Informativo', atencao: 'Atenção', alerta: 'Alerta', critico: 'Crítico' };
  var ESTADOS = { novo: 'novo', atualizado: 'atualizado', mantido: 'ativo', expirado: 'expirado' };

  function lerLocal(k, padrao) { try { return C.local.ler(k, padrao); } catch (e) { return padrao; } }
  function gravarLocal(k, v) { try { C.local.gravar(k, v); } catch (e) { /* sem armazenamento: vale só nesta página */ } }
  function hora(t) { return t ? new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : '—'; }

  var est = {
    ligada: Boolean(lerLocal(CHAVE_LIG, false)),
    som: lerLocal(CHAVE_SOM, true) !== false,
    raioKm: Number(lerLocal(CHAVE_RAIO, 10)) || 10,
    opId: null,
    alertas: [],         // alertas ativos na última leitura
    estados: [],         // inclui os expirados desta leitura
    historico: [],
    previsao: null,
    quadros: [], host: null, quadro: 0, tocando: null,
    atualizadoEm: null,   // última leitura bem-sucedida (ISO)
    fontes: null,
    camadaRadar: null, circulo: null, ultimoSom: {}, ctx: null, timer: null, buscando: false,
    tilesOk: 0, tilesErro: 0,   // contagem dos tiles do radar no quadro atual (diagnóstico)
    vento: Boolean(lerLocal('gbs-meteo-vento', false)),
    temp: Boolean(lerLocal('gbs-meteo-temp', false)),
    grade: null, gradeEm: null, gradeErro: null, camadaVento: null, camadaTemp: null,
  };

  /* ------------------------------ camada e painel ------------------------------ */
  function mapa() { return P.mapa(); }

  function atualizarBotao() {
    var b = $('opt-meteo');
    if (b) b.setAttribute('aria-pressed', String(est.ligada));
  }

  function ligar(valor) {
    est.ligada = valor;
    gravarLocal(CHAVE_LIG, valor);
    atualizarBotao();
    if (valor) { prepararSom(); $('meteo-painel').hidden = false; if (est.vento || est.temp) buscarGrade(); }
    else { parar(); $('meteo-painel').hidden = true; }
    aplicarCamada();
    desenharSituacao();
  }

  // Radar e área de monitoramento só aparecem com a camada ligada. A previsão e os alertas continuam.
  function aplicarCamada() {
    var m = mapa();
    if (!m) return;
    if (est.ligada && est.quadros.length) {
      if (!est.camadaRadar) {
        est.camadaRadar = L.tileLayer(urlQuadro(est.quadro), { tileSize: 512, opacity: 0.6, zIndex: 400,
          attribution: 'Radar © RainViewer', maxNativeZoom: 7 });
        est.camadaRadar.on('tileload', function () { est.tilesOk++; desenharRadarEstado(); });
        est.camadaRadar.on('tileerror', function () { est.tilesErro++; desenharRadarEstado(); });
      } else est.camadaRadar.setUrl(urlQuadro(est.quadro));
      est.camadaRadar.addTo(m);
    } else if (est.camadaRadar) {
      m.removeLayer(est.camadaRadar);
    }
    aplicarGradeCamadas();
    desenharArea();
  }

  // Vento (partículas) e temperatura (campo) sobre a grade de pontos ao redor da operação.
  function aplicarGradeCamadas() {
    var m = mapa();
    if (!m || !window.MeteoMapa) return;
    if (!est.camadaVento) est.camadaVento = MeteoMapa.criarVento();
    if (!est.camadaTemp) est.camadaTemp = MeteoMapa.criarTemperatura();
    var vento = est.ligada && est.vento, temp = est.ligada && est.temp;
    [[est.camadaVento, vento], [est.camadaTemp, temp]].forEach(function (par) {
      var camada = par[0], quer = par[1];
      if (quer && !m.hasLayer(camada)) camada.addTo(m);
      if (!quer && m.hasLayer(camada)) m.removeLayer(camada);
      if (quer && est.grade) camada.setGrade(est.grade);
    });
    $('meteo-escala-vento').hidden = !vento;
    $('meteo-escala-temp').hidden = !temp;
  }

  async function buscarGrade() {
    var o = op();
    if (!o || o.local_lat == null || !est.ligada || !(est.vento || est.temp)) return;
    try {
      var sessao = (await C.cliente.auth.getSession()).data.session;
      if (!sessao) throw new Error('Sessão expirada.');
      var r = await fetch('/api/meteo?tipo=grade&raio=15&lat=' + o.local_lat + '&lng=' + o.local_lng, { headers: { Authorization: 'Bearer ' + sessao.access_token } });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok || !d.ok) throw new Error(d.erro || d.mensagem || 'grade indisponível');
      est.grade = d.grade; est.gradeEm = d.obtidoEm; est.gradeErro = null;
    } catch (e) {
      est.gradeErro = e.message;
    }
    aplicarGradeCamadas();
    desenharGradeEstado();
  }

  function desenharGradeEstado() {
    var el = $('meteo-grade-estado');
    if (!el) return;
    if (!est.ligada || !(est.vento || est.temp)) { el.textContent = ''; return; }
    if (est.gradeErro) el.textContent = 'Vento e temperatura indisponíveis: ' + est.gradeErro;
    else if (!est.grade) el.textContent = 'Carregando vento e temperatura…';
    else el.textContent = 'Vento e temperatura (previsão de modelo, Open-Meteo) · área de ~30 km' + (est.gradeEm ? ' · ' + hora(est.gradeEm) : '');
    el.className = 'muted meteo-radar-tiles' + (est.gradeErro ? ' meteo-desat' : '');
  }

  function montarEscalas() {
    var t = Core.PARADAS_TEMP.map(function (p) { return 'rgb(' + p[1].join(',') + ') ' + ((p[0] + 5) / 43 * 100).toFixed(1) + '%'; });
    $('meteo-barra-temp').style.background = 'linear-gradient(to right, ' + t.join(', ') + ')';
    var v = Core.PARADAS_VENTO.map(function (p) { return 'rgb(' + p[1].join(',') + ') ' + (p[0] / 50 * 100).toFixed(1) + '%'; });
    $('meteo-barra-vento').style.background = 'linear-gradient(to right, ' + v.join(', ') + ')';
  }

  function urlQuadro(i) {
    var q = est.quadros[i];
    return q ? est.host + q.path + '/512/{z}/{x}/{y}/2/1_1.png' : '';
  }

  function desenharArea() {
    var m = mapa(), op = P.op();
    if (!m || !op || op.local_lat == null) return;
    if (est.circulo) { m.removeLayer(est.circulo); est.circulo = null; }
    if (!est.ligada) return;
    est.circulo = L.circle([op.local_lat, op.local_lng], { radius: est.raioKm * 1000, color: '#38bdf8', weight: 2,
      dashArray: '6 6', fillOpacity: 0.04, interactive: false, className: 'meteo-area' }).addTo(m);
  }

  function parar() {
    if (est.tocando) { clearInterval(est.tocando); est.tocando = null; }
    var b = $('meteo-play');
    if (b) { b.textContent = '▶'; b.setAttribute('aria-label', 'Animar o radar'); }
  }

  function tocar() {
    if (est.tocando) { parar(); return; }
    if (est.quadros.length < 2) return;
    var b = $('meteo-play');
    b.textContent = '❚❚';
    b.setAttribute('aria-label', 'Pausar a animação');
    est.tocando = setInterval(function () {
      mostrarQuadro((est.quadro + 1) % est.quadros.length);
    }, 700);
  }

  function mostrarQuadro(i) {
    est.quadro = i;
    $('meteo-range').value = String(i);
    var q = est.quadros[i];
    $('meteo-radar-hora').textContent = q ? 'Radar observado · ' + hora(q.t) : 'Sem quadros de radar';
    est.tilesOk = 0; est.tilesErro = 0;
    if (est.camadaRadar) est.camadaRadar.setUrl(urlQuadro(i));
    desenharRadarEstado();
  }

  // Diagnóstico visível: quantos tiles do quadro carregaram. Sem tiles, o mapa não mostra chuva.
  function desenharRadarEstado() {
    var el = $('meteo-radar-tiles');
    if (!el) return;
    if (!est.ligada) { el.textContent = ''; return; }
    var total = est.tilesOk + est.tilesErro;
    if (!total) { el.textContent = 'Imagens do radar: carregando…'; el.className = 'muted meteo-radar-tiles'; return; }
    if (est.tilesOk === 0) {
      el.textContent = 'Imagens do radar não carregaram (' + est.tilesErro + ' com erro). Veja o console do navegador.';
      el.className = 'meteo-radar-tiles meteo-desat';
    } else {
      el.textContent = 'Imagens do radar: ' + est.tilesOk + ' carregadas' + (est.tilesErro ? ', ' + est.tilesErro + ' com erro' : '') + '. Sem cor na área = sem chuva no radar.';
      el.className = 'muted meteo-radar-tiles';
    }
  }

  /* ------------------------------ leitura ------------------------------ */
  function op() { return P.op(); }

  // Troca de operação: limpa o estado e carrega o histórico daquela operação.
  function trocarOperacao() {
    var o = op();
    var id = o ? o.id : null;
    if (id === est.opId) return;
    est.opId = id;
    est.alertas = []; est.estados = []; est.previsao = null; est.quadros = []; est.atualizadoEm = null;
    est.historico = id ? (lerLocal(CHAVE_HIST + id, []) || []) : [];
    est.ultimoSom = {};
  }

  async function consultar() {
    trocarOperacao();
    var o = op();
    if (!o || o.local_lat == null || est.buscando) { desenharSituacao(); return; }
    est.buscando = true;
    try {
      var sessao = (await C.cliente.auth.getSession()).data.session;
      if (!sessao) throw new Error('Sessão expirada. Entre novamente.');
      var r = await fetch('/api/meteo?lat=' + o.local_lat + '&lng=' + o.local_lng, { headers: { Authorization: 'Bearer ' + sessao.access_token } });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(d.mensagem || 'Serviço meteorológico indisponível (' + (d.erro || r.status) + ').');
      processar(d);
    } catch (e) {
      est.erro = e.message;
    } finally {
      est.buscando = false;
      desenharSituacao();
    }
  }

  function processar(d) {
    est.erro = null;
    est.fontes = d.fontes || null;
    est.atualizadoEm = d.atualizadoEm || est.atualizadoEm;
    est.previsao = d.previsao || est.previsao;
    if (d.radar && d.radar.quadros && d.radar.quadros.length) {
      var anterior = est.quadros.length;
      est.quadros = d.radar.quadros;
      est.host = d.radar.host;
      $('meteo-range').max = String(est.quadros.length - 1);
      if (!anterior || est.quadro >= est.quadros.length - 1) mostrarQuadro(est.quadros.length - 1);
    }
    var antigos = est.alertas;
    var novos = Core.analisar(d.previsao, d.alertas || [], Date.now());
    var mudancas = Core.compararLeituras(antigos, novos);
    est.alertas = novos;
    est.estados = mudancas;
    mudancas.forEach(function (a) {
      if (a.estado === 'mantido') return;
      registrar(a);
      var anterior = antigos.filter(function (x) { return x.chave === a.chave; })[0];
      if (a.estado !== 'expirado' && Core.deveNotificar(anterior, a)) avisarSom(a);
    });
    aplicarCamada();
    if (est.ligada && (est.vento || est.temp)) buscarGrade();
    desenharAviso();
  }

  // Histórico da operação: novos, atualizados e expirados (máximo de 50 registros).
  function registrar(a) {
    est.historico.unshift({ quando: new Date().toISOString(), chave: a.chave, titulo: a.titulo, nivel: a.nivel, estado: a.estado, fonte: a.fonte });
    est.historico = est.historico.slice(0, 50);
    if (est.opId) gravarLocal(CHAVE_HIST + est.opId, est.historico);
  }

  /* ------------------------------ som ------------------------------ */
  function prepararSom() {
    if (!est.som || est.ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC) { try { est.ctx = new AC(); } catch (e) { est.ctx = null; } }
  }

  function avisarSom(a) {
    if (!est.som || (a.nivel !== 'alerta' && a.nivel !== 'critico')) return;
    var agora = Date.now();
    if (est.ultimoSom[a.chave] && agora - est.ultimoSom[a.chave] < MIN_ENTRE_SONS_MS) return;
    est.ultimoSom[a.chave] = agora;
    if (!est.ctx) return;   // o navegador só toca som depois de um toque da pessoa
    try {
      var c = est.ctx;
      [0, 0.45].forEach(function (dt) {
        var o = c.createOscillator(), g = c.createGain();
        o.frequency.value = a.nivel === 'critico' ? 1000 : 760;
        g.gain.value = 0.12;
        o.connect(g); g.connect(c.destination);
        o.start(c.currentTime + dt); o.stop(c.currentTime + dt + 0.3);
      });
    } catch (e) { /* som indisponível: o aviso visual continua */ }
  }

  /* ------------------------------ textos e telas ------------------------------ */
  function desenharAviso() {
    var aviso = $('meteo-aviso');
    var ativos = est.alertas.filter(function (a) { return a.nivel === 'alerta' || a.nivel === 'critico'; });
    var principal = ativos.sort(function (a, b) { return Core.RANK[b.nivel] - Core.RANK[a.nivel]; })[0];
    if (!principal || est.avisoOculto) { aviso.hidden = true; return; }
    aviso.hidden = false;
    aviso.className = 'meteo-aviso meteo-' + principal.nivel;
    $('meteo-aviso-texto').textContent = NIVEIS[principal.nivel] + ': ' + principal.titulo;
  }

  function desenharSituacao() {
    var p = $('meteo-painel');
    if (!p) return;
    var o = op();
    var desat = Core.desatualizado(est.atualizadoEm, Date.now(), LIMITE_DESATUALIZADO_MIN);
    var st = $('meteo-status');
    if (!o || o.local_lat == null) st.textContent = 'Defina o local da operação para o monitoramento.';
    else if (est.erro) st.textContent = 'Não foi possível atualizar: ' + est.erro;
    else if (!est.atualizadoEm) st.textContent = 'Carregando dados meteorológicos…';
    else st.textContent = (desat ? 'Dados desatualizados · ' : 'Atualizado às ' + hora(est.atualizadoEm) + ' · ') + 'centro da operação, área de ' + est.raioKm + ' km';
    st.className = 'meteo-status' + (desat || est.erro ? ' meteo-desat' : '');

    var lista = $('meteo-alertas');
    lista.innerHTML = '';
    var mostrar = est.estados.filter(function (a) { return a.estado !== 'expirado'; });
    mostrar.forEach(function (a) {
      lista.appendChild(elementoAlerta(a));
    });
    $('meteo-alertas-vazio').hidden = mostrar.length > 0 || !est.atualizadoEm;
    $('meteo-alertas-vazio').textContent = 'Nenhum alerta ativo para a área da operação.';

    desenharFontes();
    desenharPrevisao();
    desenharHistorico();
    $('meteo-som').setAttribute('aria-pressed', String(est.som));
    $('meteo-som').textContent = est.som ? '🔔 Som ligado' : '🔕 Som desligado';
    $('meteo-raio').value = String(est.raioKm);
    $('meteo-radar-bloco').hidden = !est.quadros.length;
    desenharAviso();
    desenharRadarEstado();
    desenharGradeEstado();
  }

  function elementoAlerta(a) {
    var div = document.createElement('div');
    div.className = 'meteo-item meteo-' + a.nivel;
    var cab = document.createElement('div');
    cab.className = 'meteo-item-cab';
    var nivel = document.createElement('span'); nivel.className = 'meteo-selo'; nivel.textContent = NIVEIS[a.nivel];
    var est2 = document.createElement('span'); est2.className = 'meteo-selo meteo-estado'; est2.textContent = ESTADOS[a.estado] || a.estado;
    cab.appendChild(nivel); cab.appendChild(est2);
    var titulo = document.createElement('strong'); titulo.textContent = a.titulo;
    var det = document.createElement('p'); det.className = 'meteo-detalhe'; det.textContent = a.detalhe || '';
    var fonte = document.createElement('p'); fonte.className = 'meteo-fonte';
    var txt = 'Fonte: ' + a.fonte;
    if (a.eta) txt += ' · chegada prevista ~' + hora(a.eta.t) + ' (±' + a.eta.incertezaMin + ' min, previsão de modelo)';
    if (a.inicio || a.fim) txt += ' · válido ' + (a.inicio ? hora(a.inicio) : '') + (a.fim ? ' até ' + hora(a.fim) : '');
    if (a.tipo === 'oficial') txt += ' · consulte o comando e o alerta oficial';
    fonte.textContent = txt;
    div.appendChild(cab); div.appendChild(titulo); div.appendChild(det); div.appendChild(fonte);
    return div;
  }

  function desenharFontes() {
    var f = est.fontes;
    var linhas = [];
    if (f) {
      Object.keys(f).forEach(function (k) {
        var x = f[k];
        var txt = x.nome + ': ' + (x.ok ? 'ok' + (x.obtidoEm ? ' às ' + hora(x.obtidoEm) : '') : (x.status === 'nao_configurado' ? 'não configurado' : 'indisponível'));
        linhas.push(txt + (x.erro && !x.ok && x.status !== 'nao_configurado' ? ' (' + x.erro + ')' : ''));
      });
    }
    $('meteo-fontes').textContent = linhas.join(' · ');
    $('meteo-fontes').hidden = !linhas.length;
  }

  function desenharPrevisao() {
    var pv = est.previsao, bloco = $('meteo-previsao');
    if (!pv || !pv.atual) { bloco.textContent = 'Previsão indisponível.'; return; }
    var a = pv.atual;
    var partes = [];
    if (a.temperatura != null) partes.push(Math.round(a.temperatura) + ' °C');
    if (a.vento != null) partes.push('vento ' + Math.round(a.vento) + ' km/h');
    if (a.rajada != null) partes.push('rajadas ' + Math.round(a.rajada) + ' km/h');
    var chegada = Core.previsaoChegada(pv.horas, Date.now());
    var linha = 'Agora: ' + partes.join(' · ');
    if (chegada) linha += '. Chuva prevista por volta de ' + hora(chegada.t) + ' (±' + chegada.incertezaMin + ' min).';
    else linha += '. Sem chuva prevista pelo modelo nas próximas horas.';
    bloco.textContent = linha + ' Previsão de modelo, não extrapolação do radar.';
  }

  function desenharHistorico() {
    var ul = $('meteo-historico');
    ul.innerHTML = '';
    est.historico.slice(0, 12).forEach(function (h) {
      var li = document.createElement('li');
      li.textContent = hora(h.quando) + ' · ' + (ESTADOS[h.estado] || h.estado) + ' · ' + h.titulo;
      ul.appendChild(li);
    });
    $('meteo-historico-vazio').hidden = est.historico.length > 0;
  }

  /* ------------------------------ ligação com a interface ------------------------------ */
  function iniciar() {
    atualizarBotao();
    $('opt-meteo').addEventListener('click', function () { ligar(!est.ligada); });
    $('meteo-fechar').addEventListener('click', function () { $('meteo-painel').hidden = true; });
    $('meteo-aviso-ver').addEventListener('click', function () { $('meteo-painel').hidden = false; desenharSituacao(); });
    $('meteo-aviso-ocultar').addEventListener('click', function () { est.avisoOculto = true; desenharAviso(); });
    $('meteo-range').addEventListener('input', function () { parar(); mostrarQuadro(Number(this.value)); });
    $('meteo-play').addEventListener('click', tocar);
    $('meteo-som').addEventListener('click', function () { est.som = !est.som; gravarLocal(CHAVE_SOM, est.som); if (est.som) prepararSom(); desenharSituacao(); });
    $('meteo-raio').addEventListener('change', function () { est.raioKm = Number(this.value); gravarLocal(CHAVE_RAIO, est.raioKm); desenharArea(); desenharSituacao(); });
    $('meteo-atualizar').addEventListener('click', function () { consultar(); });
    montarEscalas();
    function marcar(id, valor) { $(id).setAttribute('aria-pressed', String(valor)); }
    marcar('meteo-vento', est.vento); marcar('meteo-temp', est.temp);
    $('meteo-vento').addEventListener('click', function () {
      est.vento = !est.vento; gravarLocal('gbs-meteo-vento', est.vento); marcar('meteo-vento', est.vento);
      if (est.vento && est.ligada) buscarGrade(); else aplicarGradeCamadas();
      desenharGradeEstado();
    });
    $('meteo-temp').addEventListener('click', function () {
      est.temp = !est.temp; gravarLocal('gbs-meteo-temp', est.temp); marcar('meteo-temp', est.temp);
      if (est.temp && est.ligada) buscarGrade(); else aplicarGradeCamadas();
      desenharGradeEstado();
    });

    if (est.ligada) { $('meteo-painel').hidden = false; }
    // Monitoramento: primeira leitura logo após abrir a operação, depois a cada 5 min (só com a aba visível).
    setTimeout(consultar, 2500);
    est.timer = setInterval(function () { if (document.visibilityState === 'visible') consultar(); }, INTERVALO_MS);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') consultar(); });
    // Aguarda o mapa existir antes de desenhar a camada.
    var tent = setInterval(function () { if (mapa()) { clearInterval(tent); aplicarCamada(); } }, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
  window.MeteoPainel = { consultar: consultar, estado: function () { return est; } };
})();
