/* =====================================================================
 * meteo.js — painel "Meteorologia" do responsável.
 *   - alertas: chuva na área (distância e direção), previsão e alertas oficiais
 *   - camadas no mapa: Chuva (mapa de chuva em cores de radar, da grade de previsão), Radar (RainViewer, desligado
 *     por padrão), Vento e Temperatura (previsão de modelo: MET Norway)
 *   - aviso no mapa que pode ser ocultado sem parar o monitoramento; som só para Alerta e Crítico
 * Dados sempre de /api/meteo (servidor). Se uma fonte falhar, o painel diz qual; o mapa e o GPS seguem.
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, P = window.Painel, Core = window.MeteoCore;
  if (!P || !Core || !window.L) return;
  function $(id) { return document.getElementById(id); }

  var CHAVE_LIG = 'gbs-meteo-ligada', CHAVE_SOM = 'gbs-meteo-som';
  var CHAVE_RADAR = 'gbs-meteo-radar', CHAVE_VENTO = 'gbs-meteo-vento', CHAVE_TEMP = 'gbs-meteo-temp', CHAVE_CHUVA = 'gbs-meteo-chuva';
  var CHAVE_HIST = 'gbs-meteo-historico:';
  var INTERVALO_MS = 5 * 60e3, LIMITE_DESATUALIZADO_MIN = 20, MIN_ENTRE_SONS_MS = 10 * 60e3;
  var NIVEIS = { informativo: 'Informativo', atencao: 'Atenção', alerta: 'Alerta', critico: 'Crítico' };
  var ESTADOS = { novo: 'novo', atualizado: 'atualizado', mantido: 'ativo', expirado: 'expirado' };
  var VISIVEIS_ANTES_DE_MOSTRAR_MAIS = 3;

  function lerLocal(k, padrao) { try { return C.local.ler(k, padrao); } catch (e) { return padrao; } }
  function gravarLocal(k, v) { try { C.local.gravar(k, v); } catch (e) { /* sem armazenamento: vale só nesta página */ } }
  function hora(t) { return t ? new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : '—'; }
  function ordenarPorNivel(lista) { return lista.slice().sort(function (a, b) { return Core.RANK[b.nivel] - Core.RANK[a.nivel]; }); }

  var est = {
    ligada: Boolean(lerLocal(CHAVE_LIG, false)),
    radar: lerLocal(CHAVE_RADAR, true) !== false,
    vento: Boolean(lerLocal(CHAVE_VENTO, false)),
    temp: Boolean(lerLocal(CHAVE_TEMP, false)),
    chuva: lerLocal(CHAVE_CHUVA, true) !== false,   // ligada por padrão: é o "radar" visual disponível sempre
    som: lerLocal(CHAVE_SOM, true) !== false,
    opId: null, alertas: [], estados: [], historico: [], chuvaHist: [], previsao: null,
    quadros: [], host: null, quadro: 0, tocando: null,
    atualizadoEm: null, fontes: null, erro: null, buscando: false,
    grade: null, gradeEm: null, gradeErro: null,
    camadaRadar: null, camadaVento: null, camadaTemp: null, camadaChuva: null,
    tilesOk: 0, tilesErro: 0, ultimoSom: {}, ctx: null, avisoOculto: false, verTodos: false,
  };

  function mapa() { return P.mapa(); }
  function op() { return P.op(); }

  /* ------------------------------ camadas no mapa ------------------------------ */
  function atualizarBotoes() {
    var b = $('opt-meteo');
    if (b) b.setAttribute('aria-pressed', String(est.ligada));
    [['meteo-radar', est.radar], ['meteo-chuva', est.chuva], ['meteo-vento', est.vento], ['meteo-temp', est.temp], ['meteo-som', est.som]].forEach(function (x) {
      var el = $(x[0]);
      if (el) el.setAttribute('aria-pressed', String(x[1]));
    });
    $('meteo-som').textContent = est.som ? '🔔 Som ligado' : '🔕 Som desligado';
  }

  // O painel abre logo acima do botão "Meteorologia" (que fica acima da legenda, no mapa)
  function posicionarPainel() {
    var bt = $('opt-meteo'), pn = $('meteo-painel');
    if (!bt || !pn || pn.hidden || !pn.offsetParent) return;
    var rc = pn.offsetParent.getBoundingClientRect(), rb = bt.getBoundingClientRect();
    if (!rb.height) return;
    pn.style.bottom = Math.max(10, Math.round(rc.bottom - rb.top + 8)) + 'px';
  }

  function ligar(valor) {
    est.ligada = valor;
    gravarLocal(CHAVE_LIG, valor);
    atualizarBotoes();
    if (valor) { prepararSom(); $('meteo-painel').hidden = false; posicionarPainel(); consultar(); }
    else { parar(); $('meteo-painel').hidden = true; }
    aplicarCamadas();
    desenharSituacao();
  }

  // Cada camada só aparece com a Meteorologia ligada e com a própria opção marcada.
  function aplicarCamadas() {
    var m = mapa();
    if (!m || !window.MeteoMapa) return;
    var quer = est.ligada && est.radar && est.quadros.length > 0;
    if (!est.camadaRadar) {
      // Tiles de 512 px do RainViewer: zoomOffset -1 faz o Leaflet pedir o mesmo tile que o provedor usa
      // (sem isso o pedido cai em outra região). maxNativeZoom 8 limita a URL ao zoom 7, que o provedor serve.
      est.camadaRadar = L.tileLayer(urlQuadro(est.quadro), { tileSize: 512, zoomOffset: -1, maxNativeZoom: 8,
        opacity: 0.6, zIndex: 400, attribution: 'Radar © RainViewer' });
      est.camadaRadar.on('tileload', function () { est.tilesOk++; desenharRadarEstado(); });
      est.camadaRadar.on('tileerror', function () { est.tilesErro++; desenharRadarEstado(); });
    }
    if (quer) { est.camadaRadar.setUrl(urlQuadro(est.quadro)); est.camadaRadar.addTo(m); }
    else if (m.hasLayer(est.camadaRadar)) m.removeLayer(est.camadaRadar);

    if (!est.camadaVento) est.camadaVento = MeteoMapa.criarVento();
    if (!est.camadaTemp) est.camadaTemp = MeteoMapa.criarTemperatura();
    if (!est.camadaChuva && MeteoMapa.criarChuva) est.camadaChuva = MeteoMapa.criarChuva();
    // Chuva da grade: com o radar real ligado e carregado, ele substitui (não sobrepõe duas camadas de chuva)
    var querChuva = est.ligada && est.chuva && !quer;
    [[est.camadaChuva, querChuva], [est.camadaVento, est.ligada && est.vento], [est.camadaTemp, est.ligada && est.temp]].forEach(function (par) {
      if (!par[0]) return;
      var camada = par[0], quer2 = par[1];
      if (quer2 && !m.hasLayer(camada)) camada.addTo(m);
      if (!quer2 && m.hasLayer(camada)) m.removeLayer(camada);
      if (quer2 && est.grade) camada.setGrade(est.grade);
    });
  }

  // Tile do radar sobre a operação: endereço para abrir numa aba e conferir a resposta do provedor.
  function tileDaOperacao(lat, lng, z) {
    var n = Math.pow(2, z), r = lat * Math.PI / 180;
    return { x: Math.floor((lng + 180) / 360 * n),
      y: Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n), z: z };
  }

  function desenharTesteTile() {
    var a = $('meteo-teste-tile'), o = op();
    if (!a) return;
    var q = est.quadros[est.quadro];
    if (!q || !est.host || !o || o.local_lat == null) { a.hidden = true; return; }
    // Mesmo zoom que o mapa usa para o radar (maxNativeZoom), para testar exatamente o tile que aparece.
    var t = tileDaOperacao(o.local_lat, o.local_lng, 7);
    a.href = est.host + q.path + '/512/' + t.z + '/' + t.x + '/' + t.y + '/2/1_1.png';
    a.hidden = false;
  }

  function urlQuadro(i) {
    var q = est.quadros[i];
    return q ? est.host + q.path + '/512/{z}/{x}/{y}/2/1_1.png' : '';
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
    est.tocando = setInterval(function () { mostrarQuadro((est.quadro + 1) % est.quadros.length); }, 700);
  }

  function mostrarQuadro(i) {
    est.quadro = i;
    est.tilesOk = 0; est.tilesErro = 0;
    $('meteo-range').value = String(i);
    var q = est.quadros[i];
    $('meteo-radar-hora').textContent = q ? 'Radar observado · ' + hora(q.t) : '';
    if (est.camadaRadar && mapa() && mapa().hasLayer(est.camadaRadar)) est.camadaRadar.setUrl(urlQuadro(i));
    desenharRadarEstado();
  }

  // Diagnóstico: quantos tiles do quadro carregaram. Sem tiles, o mapa não mostra chuva.
  function desenharRadarEstado() {
    var el = $('meteo-radar-tiles');
    if (!el) return;
    var total = est.tilesOk + est.tilesErro;
    if (!est.ligada || !est.radar || !est.quadros.length) { el.textContent = ''; return; }
    if (!total) { el.textContent = 'Imagens do radar: carregando…'; el.className = 'meteo-detalhe meteo-radar-tiles'; return; }
    if (est.tilesOk === 0) {
      el.textContent = 'Imagens do radar não carregaram (' + est.tilesErro + ' com erro). Veja o console do navegador.';
      el.className = 'meteo-detalhe meteo-radar-tiles meteo-desat';
    } else {
      el.textContent = 'Imagens do radar: ' + est.tilesOk + ' carregadas' + (est.tilesErro ? ', ' + est.tilesErro + ' com erro' : '') + '.';
      el.className = 'meteo-detalhe meteo-radar-tiles';
    }
  }

  /* ------------------------------ leitura ------------------------------ */
  function trocarOperacao() {
    var o = op(), id = o ? o.id : null;
    if (id === est.opId) return;
    est.opId = id;
    est.alertas = []; est.estados = []; est.chuvaHist = []; est.previsao = null; est.quadros = []; est.atualizadoEm = null; est.grade = null;
    est.historico = id ? (lerLocal(CHAVE_HIST + id, []) || []) : [];
    est.ultimoSom = {};
  }

  async function sessaoToken() {
    var sessao = (await C.cliente.auth.getSession()).data.session;
    if (!sessao) throw new Error('Sessão expirada. Entre novamente.');
    return sessao.access_token;
  }

  function chaveOperacao() {
    var o = op();
    return o ? o.id + ':' + o.local_lat + ',' + o.local_lng : '';
  }
  function vigiarOperacao() {
    var chave = chaveOperacao(), o = op();
    if (chave !== est.chaveConsulta) {
      est.chaveConsulta = chave;
      est.ultimaTentativa = 0;
      if (o && o.local_lat != null) consultar(); else desenharSituacao();
    } else if (est.erro && o && o.local_lat != null && !est.buscando && document.visibilityState === 'visible' && Date.now() - (est.ultimaTentativa || 0) > 30000) {
      consultar();
    }
  }

  async function consultar() {
    trocarOperacao();
    var o = op();
    if (o && o.local_lat != null && est.buscando) { est.refazer = true; return; }   // chegou outra operação/local durante a consulta
    if (!o || o.local_lat == null || est.buscando) { desenharSituacao(); return; }
    est.ultimaTentativa = Date.now();
    est.buscando = true;
    try {
      var token = await sessaoToken();
      var r = await fetch('/api/meteo?lat=' + o.local_lat + '&lng=' + o.local_lng, { headers: { Authorization: 'Bearer ' + token } });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(d.mensagem || 'Serviço meteorológico indisponível (' + (d.erro || r.status) + ').');
      processar(d);
      await buscarGrade();
    } catch (e) {
      est.erro = e.message;
    } finally {
      est.buscando = false;
      desenharSituacao();
      if (est.refazer) { est.refazer = false; consultar(); }
    }
  }

  // Grade da área (vento, temperatura e chuva por ponto). Serve às camadas e ao alerta de distância.
  async function buscarGrade() {
    var o = op();
    if (!o || o.local_lat == null) return;
    try {
      var token = await sessaoToken();
      var r = await fetch('/api/meteo?tipo=grade&lat=' + o.local_lat + '&lng=' + o.local_lng, { headers: { Authorization: 'Bearer ' + token } });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok || !d.ok) throw new Error(d.erro || d.mensagem || 'grade indisponível');
      est.grade = d.grade; est.gradeEm = d.obtidoEm; est.gradeErro = null;
    } catch (e) {
      est.gradeErro = e.message;
    }
    integrarAlertas();
    aplicarCamadas();
  }

  function processar(d) {
    est.erro = null;
    est.fontes = d.fontes || null;
    est.atualizadoEm = d.atualizadoEm || est.atualizadoEm;
    est.previsao = d.previsao || est.previsao;
    if (d.radar && d.radar.quadros && d.radar.quadros.length) {
      var antes = est.quadros.length;
      est.quadros = d.radar.quadros;
      est.host = d.radar.host;
      $('meteo-range').max = String(est.quadros.length - 1);
      if (!antes || est.quadro >= est.quadros.length - 1) mostrarQuadro(est.quadros.length - 1);
    }
    // Os alertas são integrados depois, em buscarGrade, quando a grade da área já está disponível.
    est.oficiais = d.alertas || [];
  }

  // Junta os alertas (previsão, chuva na área e oficiais) e registra as mudanças.
  function integrarAlertas(oficiais) {
    if (oficiais) est.oficiais = oficiais;
    var agora = Date.now();
    var novos = Core.analisar(est.previsao, est.oficiais || [], agora);
    var chuvaArea = est.grade ? Core.chuvaMaisProxima(est.grade.pontos, op().local_lat, op().local_lng) : null;
    // Histórico da chuva mais próxima (uma entrada por leitura nova da grade), para estimar se ela se aproxima
    var tLeitura = est.gradeEm ? Date.parse(est.gradeEm) : NaN;
    if (est.grade && isFinite(tLeitura) && (!est.chuvaHist.length || est.chuvaHist[est.chuvaHist.length - 1].t !== tLeitura)) {
      est.chuvaHist.push({ t: tLeitura, distanciaM: chuvaArea ? chuvaArea.distanciaM : null });
      est.chuvaHist = est.chuvaHist.slice(-12);
    }
    if (chuvaArea) novos.push(Core.alertaChuvaProxima(chuvaArea, Core.tendenciaChuva(est.chuvaHist, agora)));
    var antigos = est.alertas;
    var mudancas = Core.compararLeituras(antigos, novos);
    est.alertas = novos;
    est.estados = mudancas;
    mudancas.forEach(function (a) {
      if (a.estado === 'mantido') return;
      registrar(a);
      var anterior = antigos.filter(function (x) { return x.chave === a.chave; })[0];
      if (a.estado !== 'expirado' && Core.deveNotificar(anterior, a)) avisarSom(a);
    });
    desenharAviso();
  }

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

  /* ------------------------------ tela ------------------------------ */
  function desenharAviso() {
    var aviso = $('meteo-aviso');
    var principal = ordenarPorNivel(est.alertas.filter(function (a) { return a.nivel === 'alerta' || a.nivel === 'critico'; }))[0];
    if (!principal || est.avisoOculto) { aviso.hidden = true; return; }
    aviso.hidden = false;
    aviso.className = 'meteo-aviso meteo-' + principal.nivel;
    $('meteo-aviso-texto').textContent = NIVEIS[principal.nivel] + ': ' + principal.titulo;
  }

  function desenharSituacao() {
    if (!$('meteo-painel')) return;
    atualizarBotoes();
    var o = op();
    var desat = Core.desatualizado(est.atualizadoEm, Date.now(), LIMITE_DESATUALIZADO_MIN);
    var st = $('meteo-status');
    if (!o || o.local_lat == null) st.textContent = 'Defina o local da operação.';
    else if (est.erro) st.textContent = 'Não atualizou: ' + est.erro;
    else if (!est.atualizadoEm) st.textContent = 'Carregando…';
    else st.textContent = desat ? 'Desatualizado' : 'Atualizado às ' + hora(est.atualizadoEm);
    st.className = 'meteo-status' + (desat || est.erro ? ' meteo-desat' : '');

    desenharAlertas();
    desenharLegenda();
    $('meteo-radar-bloco').hidden = !(est.radar && est.quadros.length);
    // Sem radar no servidor (desligado por padrão), o botão Radar não aparece
    $('meteo-radar').hidden = !est.quadros.length;
    desenharPrevisao();
    desenharFontes();
    desenharGradeEstado();
    desenharHistorico();
    desenharRadarEstado();
    desenharTesteTile();
    desenharAviso();
  }

  function desenharAlertas() {
    var lista = $('meteo-alertas');
    lista.innerHTML = '';
    var mostrar = ordenarPorNivel(est.estados.filter(function (a) { return a.estado !== 'expirado'; }));
    var cortar = est.verTodos ? mostrar.length : VISIVEIS_ANTES_DE_MOSTRAR_MAIS;
    mostrar.slice(0, cortar).forEach(function (a) { lista.appendChild(elementoAlerta(a)); });
    var mais = $('meteo-mais-alertas');
    mais.hidden = mostrar.length <= VISIVEIS_ANTES_DE_MOSTRAR_MAIS;
    mais.textContent = est.verTodos ? 'Mostrar menos' : 'Mostrar mais (' + (mostrar.length - VISIVEIS_ANTES_DE_MOSTRAR_MAIS) + ')';
    var vazio = $('meteo-alertas-vazio');
    vazio.hidden = mostrar.length > 0 || !est.atualizadoEm;
    vazio.textContent = 'Sem alertas para a área da operação.';
  }

  function elementoAlerta(a) {
    var div = document.createElement('div');
    div.className = 'meteo-item meteo-' + a.nivel;
    var cab = document.createElement('div');
    cab.className = 'meteo-item-cab';
    var nivel = document.createElement('span'); nivel.className = 'meteo-selo'; nivel.textContent = NIVEIS[a.nivel];
    var estado = document.createElement('span'); estado.className = 'meteo-selo meteo-estado'; estado.textContent = ESTADOS[a.estado] || a.estado;
    cab.appendChild(nivel); cab.appendChild(estado);
    var titulo = document.createElement('strong'); titulo.textContent = a.titulo;
    var det = document.createElement('p'); det.className = 'meteo-detalhe'; det.textContent = a.detalhe || '';
    var fonte = document.createElement('p'); fonte.className = 'meteo-fonte';
    var txt = a.fonte;
    if (a.eta) txt += a.eta.iniciada ? ' · previsão para o período iniciado às ' + hora(a.eta.t) : ' · chegada prevista ~' + hora(a.eta.t) + ' (±' + a.eta.incertezaMin + ' min)';
    if (a.inicio || a.fim) txt += ' · válido ' + (a.inicio ? hora(a.inicio) : '') + (a.fim ? ' até ' + hora(a.fim) : '');
    if (a.tipo === 'oficial') txt += ' · confira o alerta oficial';
    fonte.textContent = txt;
    div.appendChild(cab); div.appendChild(titulo); div.appendChild(det); div.appendChild(fonte);
    return div;
  }

  // Legenda só da camada ligada, cada uma com o seu título e a sua unidade.
  function desenharLegenda() {
    var bloco = $('meteo-legenda');
    var partes = [];
    if (est.ligada && est.radar && est.quadros.length) partes.push('<div class="meteo-legenda-bloco"><strong>Radar · intensidade da chuva</strong><p class="meteo-legenda-linha"><span class="meteo-swatch meteo-swatch-radar"></span>tons claros = fraca; escuros e vermelhos = intensa</p></div>');
    if (est.ligada && est.chuva && !(est.radar && est.quadros.length)) partes.push('<div class="meteo-legenda-bloco"><strong>Chuva · intensidade (mm/h)</strong><div class="meteo-escala"><div class="meteo-barra" id="meteo-barra-chuva"></div><div class="meteo-escala-rotulos"><span>0,1</span><span>2,5</span><span>10</span><span>50+ mm/h</span></div></div><p class="meteo-legenda-linha muted">Previsão de modelo para agora (grade de ~40 km): mostra onde chove, não substitui o radar.</p></div>');
    if (est.ligada && est.vento) partes.push('<div class="meteo-legenda-bloco"><strong>Vento · velocidade (km/h)</strong><div class="meteo-escala"><div class="meteo-barra" id="meteo-barra-vento"></div><div class="meteo-escala-rotulos"><span>0</span><span>25</span><span>50+ km/h</span></div></div></div>');
    if (est.ligada && est.temp) partes.push('<div class="meteo-legenda-bloco"><strong>Temperatura (°C)</strong><div class="meteo-escala"><div class="meteo-barra" id="meteo-barra-temp"></div><div class="meteo-escala-rotulos"><span>-5 °C</span><span>16 °C</span><span>38 °C</span></div></div></div>');
    bloco.innerHTML = partes.join('');
    bloco.hidden = !partes.length;
    var barraT = bloco.querySelector('#meteo-barra-temp'), barraV = bloco.querySelector('#meteo-barra-vento'), barraC = bloco.querySelector('#meteo-barra-chuva');
    if (barraC) barraC.style.background = 'linear-gradient(to right, ' + Core.PARADAS_CHUVA.map(function (p, i) {
      return 'rgb(' + p[1].join(',') + ') ' + (i / (Core.PARADAS_CHUVA.length - 1) * 100).toFixed(1) + '%'; }).join(', ') + ')';
    if (barraT) barraT.style.background = 'linear-gradient(to right, ' +
      Core.PARADAS_TEMP.map(function (p) { return 'rgb(' + p[1].join(',') + ') ' + ((p[0] + 5) / 43 * 100).toFixed(1) + '%'; }).join(', ') + ')';
    if (barraV) barraV.style.background = 'linear-gradient(to right, ' +
      Core.PARADAS_VENTO.map(function (p) { return 'rgb(' + p[1].join(',') + ') ' + (p[0] / 50 * 100).toFixed(1) + '%'; }).join(', ') + ')';
  }

  // Valores de agora em três cartões, e uma frase para a chegada da chuva.
  function desenharPrevisao() {
    var pv = est.previsao;
    var cartoes = $('meteo-agora');
    if (!pv || !pv.atual) {
      cartoes.innerHTML = '';
      $('meteo-previsao').textContent = est.atualizadoEm ? 'Previsão indisponível.' : '';
      return;
    }
    var a = pv.atual;
    var itens = [
      ['Temperatura', a.temperatura != null ? Math.round(a.temperatura) + ' °C' : '—'],
      ['Vento', a.vento != null ? Math.round(a.vento) + ' km/h · Bf ' + Core.beaufort(a.vento).forca : '—'],
      ['Rajadas', a.rajada != null ? Math.round(a.rajada) + ' km/h' : '—'],
    ];
    cartoes.innerHTML = '';
    itens.forEach(function (x) {
      var div = document.createElement('div'); div.className = 'meteo-stat';
      var r = document.createElement('span'); r.textContent = x[0];
      var v = document.createElement('strong'); v.textContent = x[1];
      div.appendChild(r); div.appendChild(v); cartoes.appendChild(div);
    });
    var chegada = Core.previsaoChegada(pv.horas, Date.now());
    $('meteo-previsao').textContent = chegada
      ? (chegada.iniciada
        ? 'Chuva prevista desde ' + hora(chegada.t) + ' (período já iniciado), segundo o modelo.'
        : 'Chegada da chuva prevista por volta de ' + hora(chegada.t) + ' (±' + chegada.incertezaMin + ' min), segundo o modelo.')
      : 'Sem chuva prevista nas próximas horas, segundo o modelo.';
  }

  // Cada fonte com o papel, o horário do dado e a idade (o servidor guarda o dado até 15 min; mostra quando foi obtido)
  var PAPEL_FONTE = { radar: 'Radar', previsao: 'Previsão', alertas: 'Alertas oficiais' };
  function desenharFontes() {
    var f = est.fontes, linhas = [], caixa = $('meteo-fontes');
    if (f) {
      Object.keys(f).forEach(function (k) {
        var x = f[k], papel = PAPEL_FONTE[k] || k, quando = x.obtidoEm ? hora(x.obtidoEm) + ' (' + C.idade(x.obtidoEm) + ')' : null;
        var txt = papel + ' · ' + x.nome + ': ' + (x.ok ? 'dado de ' + (quando || 'horário não informado')
          : x.status === 'nao_configurado' ? 'não configurado' : x.status === 'desligado' ? 'desligado'
          : 'indisponível' + (quando ? ' (último dado bom de ' + quando + ')' : ''));
        linhas.push({ txt: txt, ruim: !x.ok && x.status !== 'desligado' && x.status !== 'nao_configurado' });
      });
    }
    if (est.grade && est.gradeEm) linhas.push({ txt: 'Grade de vento, temperatura e chuva · dado de ' + hora(est.gradeEm) + ' (' + C.idade(est.gradeEm) + ')', ruim: false });
    caixa.innerHTML = '';
    linhas.forEach(function (l) {
      var d = document.createElement('span');
      d.className = 'meteo-fonte-linha' + (l.ruim ? ' meteo-desat' : '');
      d.textContent = l.txt;
      caixa.appendChild(d);
    });
    caixa.hidden = !linhas.length;
  }

  function desenharGradeEstado() {
    var el = $('meteo-grade-estado');
    if (est.gradeErro) el.textContent = 'Vento, temperatura e chuva na região indisponíveis: ' + est.gradeErro;
    else if (!est.grade) el.textContent = '';
    else el.textContent = 'Vento, temperatura e chuva por ponto da região (previsão de modelo' + (est.gradeEm ? ', ' + hora(est.gradeEm) : '') + '). Previsão: MET Norway, com atribuição.';
    el.className = 'meteo-detalhe' + (est.gradeErro ? ' meteo-desat' : '');
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

  /* ------------------------------ ligação ------------------------------ */
  function alternar(chave) {
    est[chave.nome] = !est[chave.nome];
    gravarLocal(chave.chave, est[chave.nome]);
    if (est[chave.nome] && est.ligada) consultar(); else aplicarCamadas();
    desenharSituacao();
  }

  function iniciar() {
    atualizarBotoes();
    $('meteo-fechar').addEventListener('click', function () { $('meteo-painel').hidden = true; });
    $('meteo-aviso-ver').addEventListener('click', function () { $('meteo-painel').hidden = false; posicionarPainel(); desenharSituacao(); });
    window.addEventListener('resize', posicionarPainel);
    document.addEventListener('toggle', function () { setTimeout(posicionarPainel, 0); }, true);   // a legenda abriu/fechou
    $('meteo-aviso-ocultar').addEventListener('click', function () { est.avisoOculto = true; desenharAviso(); });
    $('meteo-mais-alertas').addEventListener('click', function () { est.verTodos = !est.verTodos; desenharAlertas(); });
    $('meteo-range').addEventListener('input', function () { parar(); mostrarQuadro(Number(this.value)); });
    $('meteo-play').addEventListener('click', tocar);
    $('meteo-radar').addEventListener('click', function () { alternar({ nome: 'radar', chave: CHAVE_RADAR }); });
    $('meteo-vento').addEventListener('click', function () { alternar({ nome: 'vento', chave: CHAVE_VENTO }); });
    $('meteo-temp').addEventListener('click', function () { alternar({ nome: 'temp', chave: CHAVE_TEMP }); });
    $('meteo-chuva').addEventListener('click', function () { alternar({ nome: 'chuva', chave: CHAVE_CHUVA }); });
    $('meteo-som').addEventListener('click', function () { est.som = !est.som; gravarLocal(CHAVE_SOM, est.som); if (est.som) prepararSom(); desenharSituacao(); });
    $('meteo-atualizar').addEventListener('click', function () { consultar(); });

    if (est.ligada) { $('meteo-painel').hidden = false; var posTent = setInterval(function () { if ($('opt-meteo')) { clearInterval(posTent); posicionarPainel(); } }, 500); }
    // A consulta inicial pode acontecer antes de a operação carregar: vigia a operação (id e local) e consulta de novo
    // assim que ela carrega ou muda; depois de um erro tenta outra vez em 30 s, sem esperar o ciclo de 5 min.
    setInterval(vigiarOperacao, 1000);
    setInterval(function () { if (document.visibilityState === 'visible') consultar(); }, INTERVALO_MS);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') consultar(); });
    var tent = setInterval(function () { if (mapa()) { clearInterval(tent); aplicarCamadas(); } }, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
  window.MeteoPainel = { consultar: consultar, estado: function () { return est; }, alternar: function () { ligar(!est.ligada); } };   // o botão fica no mapa (militar.js)
})();
