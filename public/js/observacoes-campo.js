/* =====================================================================
 * observacoes-campo.js — drone e água (migração 042)
 *   Drone: plano de voo (o que se pretende voar), telemetria importada de arquivo (o que foi voado),
 *          área observada (o que foi de fato visto, com sensor e qualidade) e foco térmico (a verificar).
 *   Água:  indicação na água (posição), possível área de origem, corrente (medida, estimada ou DESCONHECIDA),
 *          vento com a fonte do dado e condições.
 *   Cada registro guarda a fonte, a hora observada e um estado; verificar, descartar e "inconclusivo" pedem
 *   justificativa. Plano não prova voo; foco térmico não é vítima; corrente desconhecida é um valor válido.
 *   Usa a interface window.Painel (militar.js) e window.Arquivos (importar GPX/KML/GeoJSON/CSV).
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI, P = window.Painel;
  if (!C || !UI || !P) return;
  var el = UI.el;

  var TIPOS = {
    plano_voo: { rotulo: 'Plano de voo', modalidade: 'drone', geo: 'linha', ico: '✈', nota: 'Plano não prova voo: a cobertura vem da telemetria ou da área observada.' },
    telemetria: { rotulo: 'Telemetria', modalidade: 'drone', geo: 'linha', ico: '⌁', nota: 'Trajeto voado, lido do arquivo do drone (GPX, KML, GeoJSON ou CSV).' },
    area_observada: { rotulo: 'Área observada', modalidade: 'drone', geo: 'area', ico: '▣', nota: 'O que foi de fato visto nas imagens, com sensor e qualidade.' },
    foco_termico: { rotulo: 'Foco térmico', modalidade: 'drone', geo: 'ponto', ico: '◉', nota: 'Foco térmico não é vítima: fica "a verificar" até alguém conferir.' },
    indicacao_aquatica: { rotulo: 'Indicação na água', modalidade: 'aquatica', geo: 'ponto', ico: '≈', nota: 'Corrente desconhecida é uma resposta válida: não invente valor.' },
  };
  var ESTADOS = {
    planejado: { rotulo: 'Planejado', classe: 'selo-neutro' },
    registrado: { rotulo: 'Registrado', classe: 'selo-neutro' },
    a_verificar: { rotulo: 'A verificar', classe: 'selo-alerta' },
    verificado: { rotulo: 'Verificado', classe: 'selo-ok' },
    descartado: { rotulo: 'Descartado', classe: 'selo-neutro selo-riscado' },
    inconclusivo: { rotulo: 'Inconclusivo', classe: 'selo-neutro' },
  };
  var CORES = { plano_voo: '#60a5fa', telemetria: '#22d3ee', area_observada: '#34d399', foco_termico: '#f97316', indicacao_aquatica: '#3b82f6' };
  var SENSORES = [['rgb', 'Câmera comum (RGB)'], ['termico', 'Térmico'], ['ambos', 'RGB e térmico'], ['', 'Não informado']];
  var QUALIDADE = [['boa', 'Boa'], ['parcial', 'Parcial (vegetação, sombra, reflexo)'], ['ruim', 'Ruim'], ['', 'Não informada']];
  var CONHECIMENTO = [['desconhecida', 'Desconhecida'], ['estimada', 'Estimada'], ['medida', 'Medida no local']];
  var FONTES_VENTO = [['', 'Não informado'], ['medido', 'Medido no local (anemômetro)'], ['previsao', 'Previsão (meteorologia do app)'], ['estimado', 'Estimado pela equipe'], ['desconhecido', 'Desconhecido']];
  var MAX_PTS = 5000;

  var est = { marcadores: [], opId: null, itens: new Map(), ausente: false, erro: null, canal: null, timer: null, camada: null, renderAtual: null, aba: 'drone', ouvintes: [] };

  function podeAlterar() { return Boolean(P.podeAlterar && P.podeAlterar()); }

  /* ---------- Dados ------------------------------------------------------ */
  async function carregar() {
    var op = P.op();
    if (!op || est.ausente) return;
    var opId = op.id;
    try {
      var r = await C.consultar(C.cliente.from('observacoes_campo').select('*').eq('operacao_id', opId).order('registrado_em', { ascending: true }));
      if (!P.op() || P.op().id !== opId) return;
      est.itens = new Map((r || []).map(function (o) { return [o.id, o]; }));
      est.erro = null;
    } catch (e) {
      var t = String(e.original && (e.original.message || e.original.details) || e.message);
      if (/observacoes_campo/.test(t) || e.codigo === 'funcao_ausente') est.ausente = true;
      est.erro = e.message;
    }
    atualizar();
  }

  function atualizar() {
    desenharMapa();
    var q = document.getElementById('menu-obs-qtd');
    if (q) { var r = resumo(); q.textContent = r.focosAVerificar ? r.focosAVerificar + ' a verificar' : ''; }
    if (est.renderAtual) est.renderAtual();
    est.ouvintes.forEach(function (f) { try { f(); } catch (e) { /* ignora */ } });
  }
  function agendar() { clearTimeout(est.timer); est.timer = setTimeout(carregar, 400); }

  function iniciar() {
    parar();
    var op = P.op();
    if (!op) return;
    est.opId = op.id;
    if (P.mapa() && window.L) est.camada = L.layerGroup().addTo(P.mapa());
    var carga = carregar();
    try {
      est.canal = C.cliente.channel('op-obs-campo-' + op.id + '-' + Date.now());
      est.canal.on('postgres_changes', { event: '*', schema: 'public', table: 'observacoes_campo', filter: 'operacao_id=eq.' + op.id }, agendar);
      est.canal.subscribe();
    } catch (e) { /* sem tempo real */ }
    return carga;
  }

  function parar() {
    clearTimeout(est.timer);
    if (est.canal) { try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ } }
    if (est.camada) { try { est.camada.remove(); } catch (e) { /* ignora */ } }
    if (P.desagruparMarcadores) P.desagruparMarcadores(est.marcadores);
    est.marcadores = [];
    est.canal = null; est.camada = null; est.opId = null; est.itens = new Map(); est.ausente = false; est.erro = null; est.renderAtual = null;
  }

  function aplicar(o) { if (o && o.id) est.itens.set(o.id, o); atualizar(); }

  /* ---------- Contas ----------------------------------------------------- */
  function distM(a, b) {
    var R = 6371000, r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function comprimentoM(pts) { var s = 0; for (var i = 1; i < pts.length; i++) s += distM(pts[i - 1], pts[i]); return s; }
  function areaM2(pts) {
    if (!pts || pts.length < 3) return 0;
    var lat0 = pts[0][0] * Math.PI / 180, R = 6371000, s = 0;
    var xy = pts.map(function (p) { return [p[1] * Math.PI / 180 * R * Math.cos(lat0), p[0] * Math.PI / 180 * R]; });
    for (var i = 0; i < xy.length; i++) { var a = xy[i], b = xy[(i + 1) % xy.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return Math.abs(s / 2);
  }
  function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1).replace('.', ',') + ' km' : Math.round(m) + ' m'; }
  function fmtArea(m2) { return m2 >= 10000 ? (m2 / 10000).toFixed(1).replace('.', ',') + ' ha' : Math.round(m2) + ' m²'; }
  // Reduz a linha para caber no limite do servidor (mantém o primeiro e o último ponto)
  function reduzir(pts) {
    if (pts.length <= MAX_PTS) return pts;
    var passo = pts.length / (MAX_PTS - 1), r = [];
    for (var i = 0; i < MAX_PTS - 1; i++) r.push(pts[Math.floor(i * passo)]);
    r.push(pts[pts.length - 1]);
    return r;
  }
  function arred(p) { return [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]; }
  function textoGeo(g) {
    if (!g || !g.pts || !g.pts.length) return 'Sem desenho no mapa.';
    if (g.tipo === 'ponto') return C.coord(g.pts[0][0]) + ', ' + C.coord(g.pts[0][1]);
    if (g.tipo === 'linha') return g.pts.length + ' pontos · ' + fmtDist(comprimentoM(g.pts));
    return 'Área de ' + fmtArea(areaM2(g.pts)) + ' (' + g.pts.length + ' vértices)';
  }

  /* ---------- Mapa ------------------------------------------------------- */
  function desenharMapa() {
    if (!est.camada || !window.L) return;
    est.camada.clearLayers();
    if (P.desagruparMarcadores) P.desagruparMarcadores(est.marcadores);
    est.marcadores = [];
    est.itens.forEach(function (o) {
      var cor = CORES[o.tipo] || '#94a3b8', t = TIPOS[o.tipo];
      var apagado = o.estado === 'descartado';
      var titulo = t.rotulo + ': ' + o.titulo + ' (' + ESTADOS[o.estado].rotulo.toLowerCase() + ')';
      var g = o.geometria;
      if (o.tipo === 'indicacao_aquatica' && o.dados && Array.isArray(o.dados.area_origem) && o.dados.area_origem.length >= 3) {
        L.polygon(o.dados.area_origem, { color: cor, weight: 2, dashArray: '4 6', fillOpacity: 0.06 }).bindTooltip('Possível área de origem: ' + C.esc(o.titulo), { sticky: true }).addTo(est.camada);
      }
      if (!g || !g.pts || !g.pts.length) return;
      var camada;
      if (g.tipo === 'ponto') {
        camada = L.marker(g.pts[0], { icon: L.divIcon({ className: 'mk-obs-wrap', html: '<div class="mk-obs mk-obs-' + o.tipo + ' mk-obs-' + o.estado + '">' + t.ico + '</div>', iconSize: [0, 0] }), title: titulo });
        est.marcadores.push(camada);   // pontos (focos, indicações) entram no agrupamento do mapa
      } else if (g.tipo === 'linha') {
        camada = L.polyline(g.pts, { color: cor, weight: o.tipo === 'telemetria' ? 3 : 2.5, opacity: apagado ? 0.35 : 0.9, dashArray: o.tipo === 'plano_voo' ? '10 8' : null });
      } else {
        camada = L.polygon(g.pts, { color: cor, weight: 2, opacity: apagado ? 0.35 : 0.9, fillOpacity: apagado ? 0.04 : 0.15, dashArray: o.tipo === 'plano_voo' ? '10 8' : null });
      }
      camada.bindPopup(function () { return popup(o); });
      if (g.tipo !== 'ponto') camada.addTo(est.camada);
    });
    if (P.agruparMarcadores) P.agruparMarcadores(est.marcadores, 'verif'); else est.marcadores.forEach(function (mk) { mk.addTo(est.camada); });
  }

  function popup(o) {
    var t = TIPOS[o.tipo];
    return el('div', { classe: 'popup-binomio' }, [
      el('strong', { texto: t.ico + ' ' + t.rotulo + ': ' + o.titulo }),
      el('div', null, [el('span', { classe: 'selo ' + ESTADOS[o.estado].classe, texto: ESTADOS[o.estado].rotulo })]),
      el('div', { classe: 'muted', texto: (o.observado_em ? C.hora(o.observado_em, false) : 'hora não informada') + (o.fonte ? ' · ' + o.fonte : '') }),
      el('div', { classe: 'muted', texto: t.nota }),
      el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Abrir', onclick: function () { abrir(t.modalidade, o.id); } }),
    ]);
  }

  /* ---------- Desenho no mapa -------------------------------------------- */
  // tipo: 'ponto' | 'linha' | 'area'; volta(pts | null)
  function desenhar(tipo, inicial, texto, volta) {
    UI.fecharTodos();
    var pts = (inicial || []).slice();
    var feito = false;
    var ctl = P.iniciarDesenho({
      aoClicar: function (ll) {
        if (tipo === 'ponto') { feito = true; ctl.encerrar(); volta([arred(ll)]); return; }
        pts.push(arred(ll)); redesenhar();
      },
      aoCancelar: function () { if (!feito) volta(null); },
    });
    if (!ctl) { volta(null); return; }
    function botao(t, id, fn, desab) { return el('button', { classe: 'btn btn-pequeno', type: 'button', id: id, texto: t, disabled: desab ? true : null, onclick: fn }); }
    function redesenhar() {
      ctl.camada.clearLayers();
      if (pts.length >= 2) (tipo === 'area' && pts.length >= 3 ? L.polygon(pts, { color: '#facc15', weight: 3, fillOpacity: 0.12, interactive: false }) : L.polyline(pts, { color: '#facc15', weight: 3, dashArray: '8 6', interactive: false })).addTo(ctl.camada);
      pts.forEach(function (p) { L.circleMarker(p, { radius: 5, color: '#000', weight: 1.5, fillColor: '#facc15', fillOpacity: 1, interactive: false }).addTo(ctl.camada); });
      var min = tipo === 'area' ? 3 : 2;
      ctl.barra(tipo === 'ponto' ? texto : texto + ' (' + pts.length + ' ponto' + (pts.length === 1 ? '' : 's') + ')', null, tipo === 'ponto'
        ? [botao('Cancelar', 'obs-cancelar', function () { ctl.encerrar(); })]
        : [botao('Desfazer', 'obs-desfazer', function () { pts.pop(); redesenhar(); }, !pts.length),
          botao('Concluir', 'obs-concluir', function () { feito = true; var c = pts.slice(); ctl.encerrar(); volta(c); }, pts.length < min),
          botao('Cancelar', 'obs-cancelar', function () { ctl.encerrar(); })]);
    }
    redesenhar();
  }

  /* ---------- Formulário ------------------------------------------------- */
  function dataLocal(ms) {
    var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function selecao(id, lista, valor) {
    return el('select', { classe: 'campo', id: id }, lista.map(function (x) { return el('option', { value: x[0], selected: x[0] === (valor || '') ? true : null, texto: x[1] }); }));
  }
  function numero(id, valor, min, max, passo, ph) {
    var i = el('input', { classe: 'campo', id: id, type: 'number', inputmode: 'decimal', min: String(min), max: String(max), step: String(passo || 'any'), placeholder: ph || '' });
    i.value = valor == null ? '' : String(valor);
    return i;
  }
  function lerNum(i) { var v = String(i.value || '').replace(',', '.').trim(); if (!v) return null; var n = Number(v); return isFinite(n) ? n : null; }

  // o: observação existente; base: { tipo } para nova; rascunho: estado guardado ao voltar do mapa
  function form(o, base, rascunho) {
    var novo = !o;
    var tipo = o ? o.tipo : base.tipo, t = TIPOS[tipo];
    var r = rascunho || {
      titulo: o ? o.titulo : '', fonte: o ? o.fonte : '', nota: o ? o.nota : '',
      quando: o && o.observado_em ? dataLocal(C.paraMs(o.observado_em)) : (tipo === 'plano_voo' ? '' : dataLocal(Date.now())),
      geometria: o ? o.geometria : (base.geometria || null), dados: Object.assign({}, o ? o.dados : (base.dados || {})),
    };
    var d = r.dados;
    var erro = el('p', { classe: 'erro-form', hidden: true });
    var titulo = el('input', { classe: 'campo', id: 'obs-titulo', type: 'text', maxlength: '80', placeholder: tipo === 'indicacao_aquatica' ? 'Ex.: mochila boiando perto da ponte' : 'Ex.: Voo 1 — margem leste' });
    titulo.value = r.titulo;
    var fonte = el('input', { classe: 'campo', id: 'obs-fonte', type: 'text', maxlength: '120', placeholder: tipo === 'indicacao_aquatica' ? 'Quem viu / como (barco, margem, sonar)' : 'Piloto, aeronave, arquivo' });
    fonte.value = r.fonte;
    var quando = el('input', { classe: 'campo', id: 'obs-quando', type: 'datetime-local', value: r.quando || '' });
    var nota = el('textarea', { classe: 'campo', id: 'obs-nota', maxlength: '500', rows: '2' });
    nota.value = r.nota;
    var geoTxt = el('p', { classe: 'muted', id: 'obs-geo', texto: textoGeo(r.geometria) });
    function guardar() {
      return { titulo: titulo.value, fonte: fonte.value, nota: nota.value, quando: quando.value, geometria: r.geometria, dados: Object.assign({}, d, coletar()) };
    }
    var geoTipo = t.geo;
    var geoBotoes = el('div', { classe: 'acoes-linha' }, [
      tipo !== 'telemetria' ? el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'obs-desenhar', texto: r.geometria ? 'Redesenhar no mapa' : (geoTipo === 'ponto' ? 'Marcar no mapa' : 'Desenhar no mapa'), onclick: function () {
        var g = guardar();
        var txt = geoTipo === 'ponto' ? 'Toque no mapa no ponto.' : geoTipo === 'area' ? 'Toque nos vértices da área.' : 'Toque nos pontos do trajeto.';
        desenhar(geoTipo, [], txt, function (pts) { if (pts) g.geometria = { tipo: geoTipo, pts: pts }; form(o, base, g); });
      } }) : null,
      tipo === 'plano_voo' ? el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Desenhar como área', onclick: function () {
        var g = guardar();
        desenhar('area', [], 'Toque nos vértices da área a voar.', function (pts) { if (pts) g.geometria = { tipo: 'area', pts: pts }; form(o, base, g); });
      } }) : null,
      tipo === 'indicacao_aquatica' ? el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'obs-origem', texto: d.area_origem ? 'Redesenhar área de origem' : 'Possível área de origem', onclick: function () {
        var g = guardar();
        desenhar('area', [], 'Toque nos vértices da possível área de origem.', function (pts) { if (pts) g.dados.area_origem = pts; form(o, base, g); });
      } }) : null,
    ]);
    // Arquivo de telemetria
    var arquivo = null;
    if (tipo === 'telemetria') {
      arquivo = el('input', { classe: 'campo', id: 'obs-arquivo', type: 'file', accept: '.gpx,.kml,.kmz,.geojson,.json,.csv,.txt' });
      arquivo.addEventListener('change', async function () {
        var f = arquivo.files && arquivo.files[0];
        if (!f) return;
        erro.hidden = true;
        try {
          var lido = await window.Arquivos.importar(f);
          var linhas = (lido.linhas || []).slice().sort(function (a, b) { return b.pts.length - a.pts.length; });
          if (!linhas.length) throw new Error('o arquivo não tem trajeto (só pontos ou áreas).');
          var l = linhas[0];
          var pts = reduzir(l.pts.map(arred));
          r.geometria = { tipo: 'linha', pts: pts };
          d.arquivo = String(f.name).slice(0, 120);
          d.pontos_arquivo = l.pts.length;
          d.distancia_m = Math.round(comprimentoM(l.pts));
          d.inicio = l.inicio || null; d.fim = l.fim || null;
          if (l.inicio) quando.value = dataLocal(Date.parse(l.inicio));
          if (!titulo.value.trim()) titulo.value = String(l.nome || f.name).slice(0, 80);
          if (!fonte.value.trim()) fonte.value = 'Arquivo ' + String(f.name).slice(0, 100);
          geoTxt.textContent = textoGeo(r.geometria) + (l.inicio ? ' · ' + C.hora(l.inicio, false) + '–' + C.hora(l.fim, false) : ' · arquivo sem horários');
        } catch (e) {
          erro.textContent = 'Não foi possível ler "' + f.name + '": ' + (e.message || e);
          erro.hidden = false;
        }
      });
    }
    // Campos de cada tipo
    var extras = [], coletar = function () { return {}; };
    if (tipo === 'plano_voo' || tipo === 'area_observada') {
      var sensor = selecao('obs-sensor', SENSORES, d.sensor);
      var alt = numero('obs-alt', d.altitude_m, 0, 1000, 1, 'm');
      var campos = [UI.campo('Sensor', sensor, { para: 'obs-sensor' }), UI.campo('Altura de voo (m)', alt, { para: 'obs-alt', opcional: true })];
      var qual = null;
      if (tipo === 'area_observada') { qual = selecao('obs-qual', QUALIDADE, d.qualidade); campos.push(UI.campo('Qualidade da observação', qual, { para: 'obs-qual', largo: true })); }
      extras.push(UI.secao('Voo', [UI.grade(campos)]));
      coletar = function () { return { sensor: sensor.value || null, altitude_m: lerNum(alt), qualidade: qual ? qual.value || null : undefined }; };
    } else if (tipo === 'foco_termico') {
      var temp = numero('obs-temp', d.temperatura_c, -40, 120, 0.1, '°C');
      var ref = el('input', { classe: 'campo', id: 'obs-imagem', type: 'text', maxlength: '120', placeholder: 'Ex.: DJI_0042.JPG' });
      ref.value = d.imagem || '';
      extras.push(UI.secao('Foco', [UI.grade([UI.campo('Temperatura (°C)', temp, { para: 'obs-temp', opcional: true }), UI.campo('Imagem / quadro', ref, { para: 'obs-imagem', opcional: true })])]));
      coletar = function () { return { temperatura_c: lerNum(temp), imagem: ref.value.trim() || null }; };
    } else if (tipo === 'indicacao_aquatica') {
      var cor = d.corrente || {}, ven = d.vento || {};
      var tipoInd = selecao('obs-tipo-ind', [['', 'Não informado'], ['objeto', 'Objeto flutuante'], ['mancha', 'Mancha / bolhas'], ['testemunha', 'Testemunha'], ['cao', 'Indicação de cão'], ['sonar', 'Sonar'], ['outro', 'Outro']], d.indicacao);
      var corCon = selecao('obs-cor-con', CONHECIMENTO, cor.conhecimento || 'desconhecida');
      var corDir = numero('obs-cor-dir', cor.para_graus, 0, 360, 1, 'graus (para onde vai)');
      var corVel = numero('obs-cor-vel', cor.velocidade_ms, 0, 10, 0.1, 'm/s');
      var venFonte = selecao('obs-ven-fonte', FONTES_VENTO, ven.fonte);
      var venDir = numero('obs-ven-dir', ven.de_graus, 0, 360, 1, 'graus (de onde vem)');
      var venVel = numero('obs-ven-vel', ven.velocidade_kmh, 0, 250, 1, 'km/h');
      var cond = el('textarea', { classe: 'campo', id: 'obs-cond', maxlength: '500', rows: '2', placeholder: 'Visibilidade, temperatura da água, profundidade, nível do rio' });
      cond.value = d.condicoes || '';
      var blocoCor = UI.grade([UI.campo('Direção', corDir, { para: 'obs-cor-dir', opcional: true }), UI.campo('Velocidade (m/s)', corVel, { para: 'obs-cor-vel', opcional: true })]);
      function mostrarCor() { blocoCor.hidden = corCon.value === 'desconhecida'; }
      corCon.addEventListener('change', mostrarCor);
      mostrarCor();
      extras.push(UI.campo('Tipo de indicação', tipoInd, { para: 'obs-tipo-ind' }));
      extras.push(UI.secao('Corrente', [UI.campo('Conhecimento', corCon, { para: 'obs-cor-con' }), blocoCor], { dica: 'Desconhecida é um valor válido: melhor que um número inventado.' }));
      extras.push(UI.secao('Vento', [UI.grade([UI.campo('Fonte do dado', venFonte, { para: 'obs-ven-fonte', largo: true }), UI.campo('Direção', venDir, { para: 'obs-ven-dir', opcional: true }), UI.campo('Velocidade (km/h)', venVel, { para: 'obs-ven-vel', opcional: true })])]));
      extras.push(UI.campo('Condições', cond, { para: 'obs-cond', opcional: true }));
      coletar = function () {
        var conhecida = corCon.value !== 'desconhecida';
        return {
          indicacao: tipoInd.value || null,
          corrente: { conhecimento: corCon.value, para_graus: conhecida ? lerNum(corDir) : null, velocidade_ms: conhecida ? lerNum(corVel) : null },
          vento: { fonte: venFonte.value || null, de_graus: lerNum(venDir), velocidade_kmh: lerNum(venVel) },
          condicoes: cond.value.trim() || null,
        };
      };
    }
    var btnOk = el('button', { classe: 'btn btn-escuro', type: 'submit', texto: novo ? 'Registrar' : 'Salvar' });
    var f = el('form', { classe: 'form-obs', novalidate: true }, [
      el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, [(novo ? '' : 'Editar: ') + t.rotulo, UI.dica(t.nota)]),
      UI.grade([
        UI.campo('Título', titulo, { para: 'obs-titulo' }),
        UI.campo(tipo === 'plano_voo' ? 'Horário previsto' : 'Quando foi observado', quando, { para: 'obs-quando', opcional: true }),
        UI.campo('Fonte', fonte, { para: 'obs-fonte', opcional: true, largo: true }),
      ]),
      arquivo ? UI.campo('Arquivo do voo', arquivo, { para: 'obs-arquivo', ajuda: 'GPX, KML/KMZ, GeoJSON ou CSV exportado do app do drone.' }) : null,
      UI.secao(tipo === 'indicacao_aquatica' ? 'Posição da indicação' : 'No mapa', [geoTxt, d.area_origem ? el('p', { classe: 'muted', texto: 'Possível área de origem: ' + fmtArea(areaM2(d.area_origem)) }) : null, geoBotoes]),
    ].concat(extras).concat([
      UI.campo('Observação', nota, { para: 'obs-nota', opcional: true }),
      erro,
      UI.rodape([el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); abrir(t.modalidade); } }), btnOk]),
    ]));
    f.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      if (!titulo.value.trim()) { erro.textContent = 'Dê um título.'; erro.hidden = false; titulo.focus(); return; }
      if (tipo === 'telemetria' && !r.geometria) { erro.textContent = 'Escolha o arquivo do voo.'; erro.hidden = false; return; }
      var dados = Object.assign({}, d, coletar());
      Object.keys(dados).forEach(function (k) { if (dados[k] === undefined) delete dados[k]; });
      var qd = quando.value ? new Date(quando.value) : null;
      var p = { titulo: titulo.value.trim(), fonte: fonte.value.trim(), nota: nota.value.trim(), dados: dados, geometria: r.geometria || null,
        observado_em: qd && !isNaN(qd) ? qd.toISOString() : null };
      if (novo) { p.modalidade = t.modalidade; p.tipo = tipo; }
      btnOk.disabled = true;
      try {
        var res = await C.rpc('salvar_observacao_campo', { p_operacao: P.op().id, p_id: novo ? null : o.id, p_dados: p });
        UI.aviso(novo ? 'Registro salvo: ' + t.rotulo.toLowerCase() + ' (' + ESTADOS[res.estado].rotulo.toLowerCase() + ').' : 'Salvo.', 'ok');
        fechar(); aplicar(res); abrir(t.modalidade, res.id);
      } catch (x) { erro.textContent = C.traduzirErro(x); erro.hidden = false; btnOk.disabled = false; }
    });
    var fechar = UI.abrirModal(f);
  }

  function formEstado(o) {
    var t = TIPOS[o.tipo];
    var escolhido = o.estado;
    var opcoes = (o.tipo === 'plano_voo' ? ['planejado'] : o.tipo === 'telemetria' || o.tipo === 'area_observada' ? ['registrado'] : ['a_verificar']).concat(['verificado', 'descartado', 'inconclusivo']);
    var nota = el('textarea', { classe: 'campo', id: 'obs-just', maxlength: '500', rows: '3', placeholder: o.tipo === 'foco_termico' ? 'Ex.: equipe foi ao local: animal / pedra aquecida / vítima' : 'Como foi verificado' });
    var erro = el('p', { classe: 'erro-form', hidden: true });
    var btnOk = el('button', { classe: 'btn btn-escuro', type: 'submit', texto: 'Salvar' });
    var f = el('form', { novalidate: true }, [
      el('h2', { id: 'modal-titulo', texto: t.rotulo + ': ' + o.titulo }),
      UI.secao('Estado', [UI.escolhas('obs-estado', opcoes.map(function (k) { return { valor: k, rotulo: ESTADOS[k].rotulo, marcado: k === escolhido }; }), function (v) { escolhido = v; })]),
      UI.campo('Justificativa', nota, { para: 'obs-just', ajuda: 'Obrigatória para verificado, descartado ou inconclusivo.' }),
      erro,
      UI.rodape([el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); abrir(t.modalidade, o.id); } }), btnOk]),
    ]);
    f.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var tx = nota.value.trim();
      if (['verificado', 'descartado', 'inconclusivo'].indexOf(escolhido) !== -1 && !tx) { erro.textContent = 'Escreva a justificativa.'; erro.hidden = false; nota.focus(); return; }
      btnOk.disabled = true;
      try {
        var res = await C.rpc('revisar_observacao_campo', { p_id: o.id, p_estado: escolhido, p_nota: tx });
        UI.aviso(o.titulo + ': ' + ESTADOS[res.estado].rotulo.toLowerCase() + '.', 'ok');
        fechar(); aplicar(res); abrir(t.modalidade, o.id);
      } catch (x) { erro.textContent = C.traduzirErro(x); erro.hidden = false; btnOk.disabled = false; }
    });
    var fechar = UI.abrirModal(f, { tamanho: 'estreito' });
  }

  /* ---------- Tela ------------------------------------------------------- */
  var ROT_SENSOR = { rgb: 'RGB', termico: 'térmico', ambos: 'RGB e térmico' };
  var ROT_FONTE_VENTO = { medido: 'medido no local', previsao: 'previsão', estimado: 'estimado', desconhecido: 'desconhecido' };
  function resumoDados(o) {
    var d = o.dados || {}, partes = [];
    if (o.tipo === 'telemetria') {
      partes.push(d.arquivo ? 'Arquivo ' + d.arquivo : null);
      partes.push(d.distancia_m != null ? fmtDist(d.distancia_m) + ' voados' : null);
      partes.push(d.inicio ? C.hora(d.inicio, false) + '–' + C.hora(d.fim, false) : 'sem horários no arquivo');
    } else if (o.tipo === 'plano_voo' || o.tipo === 'area_observada') {
      partes.push('Sensor: ' + (ROT_SENSOR[d.sensor] || 'não informado'));
      partes.push(d.altitude_m != null ? d.altitude_m + ' m de altura' : null);
      if (o.tipo === 'area_observada') partes.push('Qualidade: ' + ({ boa: 'boa', parcial: 'parcial', ruim: 'ruim' }[d.qualidade] || 'não informada'));
    } else if (o.tipo === 'foco_termico') {
      partes.push(d.temperatura_c != null ? String(d.temperatura_c).replace('.', ',') + ' °C' : 'temperatura não informada');
      partes.push(d.imagem ? 'Imagem ' + d.imagem : null);
    } else if (o.tipo === 'indicacao_aquatica') {
      var c = d.corrente || {}, v = d.vento || {};
      partes.push('Corrente: ' + (c.conhecimento === 'desconhecida' || !c.conhecimento ? 'desconhecida' : c.conhecimento + (c.para_graus != null ? ', para ' + Math.round(c.para_graus) + '°' : '') + (c.velocidade_ms != null ? ', ' + String(c.velocidade_ms).replace('.', ',') + ' m/s' : '')));
      partes.push('Vento: ' + (v.velocidade_kmh != null || v.de_graus != null ? (v.de_graus != null ? 'de ' + Math.round(v.de_graus) + '° ' : '') + (v.velocidade_kmh != null ? v.velocidade_kmh + ' km/h ' : '') : 'não informado ') + '(' + (ROT_FONTE_VENTO[v.fonte] || 'fonte não informada') + ')');
      partes.push(d.area_origem ? 'Possível origem: ' + fmtArea(areaM2(d.area_origem)) : null);
      partes.push(d.condicoes || null);
    }
    return partes.filter(Boolean).join(' · ');
  }

  function cartao(o, destacar) {
    var t = TIPOS[o.tipo];
    var g = o.geometria;
    var acoes = [];
    if (g && g.pts && g.pts.length && P.mapa()) acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Mapa', onclick: function () {
      UI.fecharTodos();
      if (g.pts.length === 1) P.irPara(g.pts[0][0], g.pts[0][1]);
      else try { P.mapa().fitBounds(L.latLngBounds(g.pts), { padding: [40, 40], maxZoom: 18 }); } catch (e) { /* ignora */ }
    } }));
    if (podeAlterar()) {
      acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Editar', onclick: function () { form(o); } }));
      acoes.push(el('button', { classe: 'btn btn-pequeno btn-escuro', type: 'button', texto: 'Estado', onclick: function () { formEstado(o); } }));
    }
    return el('li', { classe: 'ajuda-cartao obs-cartao obs-' + o.estado + (destacar ? ' obs-destaque' : ''), 'data-obs': o.id }, [
      el('div', { classe: 'ajuda-topo' }, [
        el('span', { classe: 'obs-ico', style: 'color:' + CORES[o.tipo], 'aria-hidden': 'true', texto: t.ico }),
        el('strong', { classe: 'ajuda-nome', texto: o.titulo }),
        el('span', { classe: 'selo selo-neutro', texto: t.rotulo }),
        el('span', { classe: 'selo ' + ESTADOS[o.estado].classe, texto: ESTADOS[o.estado].rotulo }),
      ]),
      el('p', { classe: 'muted', texto: (o.observado_em ? (o.tipo === 'plano_voo' ? 'Previsto ' : 'Observado ') + C.hora(o.observado_em, false) : 'Hora não informada') +
        ' · fonte: ' + (o.fonte || 'não informada') + ' · ' + textoGeo(g) }),
      resumoDados(o) ? el('p', { texto: resumoDados(o) }) : null,
      o.nota ? el('p', { classe: 'revisao-nota', texto: o.nota }) : null,
      acoes.length ? el('div', { classe: 'acoes-linha ajuda-acoes' }, acoes) : null,
    ]);
  }

  function abrir(modalidade, destaque) {
    if (modalidade === 'drone' || modalidade === 'aquatica') est.aba = modalidade;
    var corpo = el('div', { classe: 'ajuda-corpo obs-corpo' });
    var fechar;
    function desenharTela() {
      corpo.innerHTML = '';
      corpo.appendChild(el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica' }, ['Drone e água',
        UI.dica('Plano não prova voo · foco térmico não é vítima · corrente desconhecida é válida. Cada registro guarda fonte, hora e estado.')]));
      if (est.ausente) {
        corpo.appendChild(el('p', { classe: 'nota', texto: 'Os registros de drone e água ainda não estão no servidor: rode a migração 042 no Supabase.' }));
        corpo.appendChild(UI.rodape([el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]));
        return;
      }
      if (est.erro) corpo.appendChild(el('p', { classe: 'nota', texto: 'Não foi possível atualizar: ' + est.erro }));
      var todos = Array.from(est.itens.values());
      var nDrone = todos.filter(function (o) { return o.modalidade === 'drone'; }).length;
      corpo.appendChild(el('div', { classe: 'ajuda-abas', role: 'tablist' }, [['drone', 'Drone (' + nDrone + ')'], ['aquatica', 'Água (' + (todos.length - nDrone) + ')']].map(function (a) {
        return el('button', { classe: 'btn btn-pequeno' + (est.aba === a[0] ? ' btn-ativo' : ''), type: 'button', role: 'tab', 'aria-selected': String(est.aba === a[0]), 'data-aba': a[0], texto: a[1], onclick: function () { est.aba = a[0]; desenharTela(); } });
      })));
      var lista = todos.filter(function (o) { return o.modalidade === est.aba; })
        .sort(function (a, b) { return C.paraMs(b.observado_em || b.registrado_em) - C.paraMs(a.observado_em || a.registrado_em); });
      if (est.aba === 'drone') {
        var cob = todos.filter(function (o) { return o.tipo === 'area_observada' && o.estado !== 'descartado' && o.geometria; }).reduce(function (s, o) { return s + areaM2(o.geometria.pts); }, 0);
        var focos = todos.filter(function (o) { return o.tipo === 'foco_termico' && o.estado === 'a_verificar'; }).length;
        corpo.appendChild(el('p', { classe: 'muted', texto: 'Área observada registrada: ' + (cob ? fmtArea(cob) : 'nenhuma') + ' · focos térmicos a verificar: ' + focos + '.' }));
      }
      if (!lista.length) corpo.appendChild(el('p', { classe: 'muted', texto: est.aba === 'drone' ? 'Nenhum registro de drone.' : 'Nenhuma indicação na água.' }));
      corpo.appendChild(el('ul', { classe: 'ajuda-lista' }, lista.map(function (o) { return cartao(o, o.id === destaque); })));
      var novos = !podeAlterar() ? [] : est.aba === 'drone'
        ? [['plano_voo', '+ Plano de voo'], ['telemetria', '+ Telemetria'], ['area_observada', '+ Área observada'], ['foco_termico', '+ Foco térmico']]
        : [['indicacao_aquatica', '+ Indicação na água']];
      corpo.appendChild(el('div', { classe: 'acoes-linha obs-novos' }, novos.map(function (n) {
        return el('button', { classe: 'btn btn-pequeno', type: 'button', 'data-novo': n[0], texto: n[1], onclick: function () { fechar(); form(null, { tipo: n[0] }); } });
      })));
      corpo.appendChild(UI.rodape([el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]));
    }
    est.renderAtual = desenharTela;
    desenharTela();
    fechar = UI.abrirModal(corpo, { tamanho: 'largo', aoFechar: function () { est.renderAtual = null; } });
    if (destaque) {
      var alvo = corpo.querySelector('[data-obs="' + destaque + '"]');
      if (alvo && alvo.scrollIntoView) alvo.scrollIntoView({ block: 'nearest' });
    }
  }

  function resumo() {
    var todos = Array.from(est.itens.values());
    return {
      total: todos.length,
      focosAVerificar: todos.filter(function (o) { return o.tipo === 'foco_termico' && o.estado === 'a_verificar'; }).length,
      indicacoesAgua: todos.filter(function (o) { return o.tipo === 'indicacao_aquatica'; }).length,
      areaObservadaM2: todos.filter(function (o) { return o.tipo === 'area_observada' && o.estado !== 'descartado' && o.geometria; }).reduce(function (s, o) { return s + areaM2(o.geometria.pts); }, 0),
    };
  }

  window.ObservacoesCampo = {
    iniciar: iniciar, parar: parar, abrir: abrir, recarregar: carregar, resumo: resumo,
    itens: function () { return Array.from(est.itens.values()); },
    aoMudar: function (f) { est.ouvintes.push(f); },
    disponivel: function () { return !est.ausente; },
    _teste: { reduzir: reduzir, areaM2: areaM2, comprimentoM: comprimentoM },
  };
  // operação aberta antes deste arquivo carregar: começa agora
  if (P.op && P.op() && !est.opId) iniciar();
})();
