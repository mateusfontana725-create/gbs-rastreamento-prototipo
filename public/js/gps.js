/* =====================================================================
 * gps.js — filtro das leituras do GPS e montagem das trilhas
 * Usado pela página do participante, pela "Minha posição" do responsável
 * e pelo desenho das trilhas no painel.
 *
 * Princípios
 *   - Andando, cada ponto gravado é uma leitura real do aparelho: o filtro só
 *     decide QUAIS entram (um a cada passo proporcional à precisão).
 *   - Parado, o ponto gravado é o centro (mediana) das leituras reais no
 *     lugar: uma leitura solta tem o erro do GPS e faz a trilha "tremer".
 *   - Dois estados, parado e andando. Sair do lugar é afastamento que se
 *     mantém e cresce aos poucos (passo); afastamento de uma vez é pulo do
 *     GPS (perto de prédios, troca do GPS pelo Wi-Fi) e é ignorado.
 *   - Leituras imprecisas, antigas, repetidas, fora de ordem ou com salto
 *     impossível não entram na trilha. O motivo fica no diagnóstico local.
 *   - O diagnóstico fica só na memória do aparelho (nunca é enviado) e guarda
 *     apenas horário, coordenadas arredondadas (~1 m), precisão e motivo.
 * ===================================================================== */
(function (global) {
  'use strict';

  // Valores revisados (v3). A versão anterior (v2) era restritiva demais: exigia
  // afastamento de até 40 m parado, juntava os envios em lotes de 10 s e
  // rejeitava qualquer velocidade acima de 43 km/h (quem ia de carro ficava sem
  // trilha). Aqui: pontos frequentes andando, 1 por segundo em veículo, envio
  // rápido, e "salto" só quando a velocidade é incoerente com o movimento recente.
  var PADRAO = {
    precisaoBoaM: 20,           // até aqui a leitura é "boa"
    precisaoVelocidadeM: 20,    // a velocidade do GPS só é usada com precisão até aqui (pior que isso, oscila sozinha)
    precisaoTrilhaM: 150,       // pior que isso: só posição aproximada (não entra na linha da trilha)
    intervaloRuimMs: 30000,     // posição aproximada: no máximo 1 a cada 30 s
    distanciaMinimaM: 3,        // deslocamento mínimo considerado
    fatorOscilacao: 1,          // parado: o raio do lugar é ao menos 1 × a precisão…
    limiteOscilacaoM: 25,       // …limitado a 25 m (mata/vale com precisão ruim não "congela" a trilha)
    confirmacoesMovimento: 3,   // parado: 3 leituras seguidas fora do lugar para começar a andar
    fatorDispersao: 3,          // …e cobre 3 × a dispersão observada das leituras paradas (a deriva lenta do GPS)
    fatorSaida: 1.5,            // parado → andando: afastamento de 1,5 × o raio (ou 1 × com a velocidade do GPS confirmando)
    velocidadePeMs: 3,          // a pé ninguém sai do lugar mais rápido que isso: afastamento brusco é pulo do GPS (multicaminho)
    confirmacaoPuloMs: 30000,   // pulo que dura 30 s é mudança de lugar de verdade
    janelaParado: 60,           // parado: o centro é a mediana das últimas 60 leituras no lugar
    fatorPasso: 0.8,            // andando: um ponto a cada 0,8 × precisão (de 3 m a passoMaxM): com GPS ruim, pontos colados só desenham o ruído
    passoMaxM: 20,
    janelaParadaMs: 20000,      // andando → parado: deslocamento líquido em 20 s…
    fatorParada: 0.4,           // …menor que 0,4 × precisão (mín. 3 m)…
    confirmacoesParada: 3,      // …em 3 leituras seguidas
    velocidadeMinimaMs: 0.7,    // velocidade medida pelo GPS que indica movimento real
    intervaloMinimoMs: 2000,    // a pé: no máximo 1 ponto a cada 2 s
    velocidadeRapidaMs: 5,      // acima de 18 km/h: modo veículo
    intervaloMinimoRapidoMs: 1000, // veículo: até 1 ponto por segundo…
    distanciaMinimaRapidoM: 8,     // …a cada 8 m ou mais
    intervaloParadoMs: 15000,   // intervalo MÁXIMO sem ponto: parado, confirma a posição a cada 15 s (configurável por operação)
    velocidadeBaseMs: 12,       // velocidade máxima aceita sem histórico (a pé/bicicleta)
    fatorVelocidade: 2.5,       // ou 2,5 × a velocidade recente (carro acelerando, rodovia…)
    velocidadeAbsurdaMs: 70,    // 252 km/h: nunca é movimento terrestre
    confirmacoesSalto: 2,       // 2 leituras seguidas e coerentes confirmam um deslocamento brusco
    idadeMaximaMs: 30000,       // leitura mais velha que isso é antiga (cache do aparelho)
    // painel (desenho da trilha)
    lacunaMs: 60000,            // mais de 60 s entre dois pontos seguidos: falha (tracejado, configurável por operação)
    diagnosticoMax: 400,
  };

  function mesclar(cfg) {
    var r = {};
    Object.keys(PADRAO).forEach(function (k) { r[k] = cfg && cfg[k] != null ? cfg[k] : PADRAO[k]; });
    r.objetos = Boolean(cfg && cfg.objetos);   // trilha(): segmentos com os pontos originais (para exportar)
    return r;
  }

  function distancia(lat1, lng1, lat2, lng2) {
    var R = 6371000, k = Math.PI / 180;
    var dLat = (lat2 - lat1) * k, dLng = (lng2 - lng1) * k;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * k) * Math.cos(lat2 * k) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function med1(v) { v = v.slice().sort(function (a, b) { return a - b; }); return v[Math.floor(v.length / 2)]; }
  function mediana(ls) {
    return { lat: med1(ls.map(function (l) { return l.lat; })), lng: med1(ls.map(function (l) { return l.lng; })) };
  }
  function r5(v) { return Math.round(v * 1e5) / 1e5; }

  var MOTIVOS = {
    primeiro_ponto: 'primeira leitura',
    primeiro_ponto_impreciso: 'primeira leitura (imprecisa, só aproximada)',
    movimento: 'deslocamento',
    movimento_rapido: 'deslocamento (veículo)',
    parado_periodico: 'parado (confirmação periódica)',
    aproximado: 'imprecisa: posição aproximada, fora da linha da trilha',
    salto_confirmado: 'deslocamento brusco confirmado por leituras seguidas',
    coordenada_invalida: 'coordenada inválida',
    leitura_antiga: 'leitura antiga (cache)',
    duplicada: 'leitura repetida',
    fora_de_ordem: 'fora de ordem',
    baixa_precisao: 'precisão ruim (aguardando)',
    salto_suspeito: 'salto incoerente (aguardando confirmação)',
    intervalo_curto: 'intervalo curto',
    oscilacao_parado: 'oscilação parado',
    pulo_parado: 'pulo do GPS parado (multicaminho): ignorado',
    negado: 'erro: permissão negada',
    indisponivel: 'erro: localização do aparelho desligada/indisponível',
    sem_sinal: 'erro: sem leitura no tempo limite',
    servidor_recusou: 'servidor recusou pontos (horário fora da operação)',
  };

  /* ------------------------------------------------------------------ */
  /* Filtro de leituras (no aparelho que coleta)                          */
  /* ------------------------------------------------------------------ */
  function Filtro(cfg) {
    this.cfg = mesclar(cfg);
    this.diag = [];
    this.contagem = {};
    this.offsets = [];
    this.reiniciar();
  }

  // Muda a configuração sem perder o estado (ex.: intervalo de GPS definido na operação).
  Filtro.prototype.configurar = function (cfg) {
    var self = this;
    Object.keys(cfg || {}).forEach(function (k) { if (cfg[k] != null && k in PADRAO) self.cfg[k] = cfg[k]; });
  };

  Filtro.prototype.reiniciar = function () {
    this.ancora = null;          // último ponto aceito na linha da trilha
    this.ultimoRuimT = 0;        // último ponto impreciso aceito (aproximado)
    this.ultimaLeitura = null;   // última leitura válida (para a tela)
    this.suspeitos = [];
    this.velRecente = 0;         // m/s: velocidade recente (GPS ou deslocamento líquido dos últimos pontos)
    this.janela = [];            // leituras válidas dos últimos 30 s (decisões de parado/andando)
    this.aceitos = [];           // últimos 4 pontos aceitos (velocidade líquida e retidão)
    this.estado = null;          // 'parado' ou 'andando'
    this.parado = null;          // parado: { leituras, centro, fora, ultimoDentroT, ultimaLeitura, anterior }
    this.paradaSeguida = 0;      // andando: leituras seguidas com cara de parado
  };

  Filtro.prototype.registrar = function (leitura, aceito, motivo, extra) {
    this.contagem[motivo] = (this.contagem[motivo] || 0) + 1;
    var e = {
      em: Date.now(),
      aceito: aceito,
      motivo: motivo,
      lat: leitura ? r5(leitura.lat) : null,
      lng: leitura ? r5(leitura.lng) : null,
      prec: leitura && leitura.prec != null ? Math.round(leitura.prec) : null,
      idade_s: leitura ? Math.round((leitura.recebidaEm - leitura.t) / 100) / 10 : null,
      vel: leitura && leitura.vel != null ? Math.round(leitura.vel * 10) / 10 : null,
      dist: extra && extra.dist != null ? Math.round(extra.dist) : null,
      dt_s: extra && extra.dt != null ? Math.round(extra.dt / 100) / 10 : null,
    };
    this.diag.push(e);
    if (this.diag.length > this.cfg.diagnosticoMax) this.diag.splice(0, this.diag.length - this.cfg.diagnosticoMax);
    return e;
  };

  // Velocidade máxima aceitável agora (sem confirmação), conforme o movimento recente.
  Filtro.prototype.velocidadeMaxima = function (vel) {
    var cfg = this.cfg;
    var v = Math.max(cfg.velocidadeBaseMs, cfg.fatorVelocidade * this.velRecente, vel != null ? vel * 1.5 + 5 : 0);
    return Math.min(v, cfg.velocidadeAbsurdaMs);
  };

  // Veículo: velocidade do GPS alta, ou deslocamento recente rápido E em linha
  // (a oscilação de quem está parado vai e volta e não forma uma linha).
  Filtro.prototype.emMovimentoRapido = function (vel) {
    if (vel != null) return vel >= this.cfg.velocidadeRapidaMs;
    return this.velRecente >= this.cfg.velocidadeRapidaMs && this.retidao() >= 0.7;
  };

  Filtro.prototype.retidao = function () {
    var p = this.aceitos;
    if (p.length < 3) return 0;
    var soma = 0;
    for (var i = 1; i < p.length; i++) soma += distancia(p[i - 1].lat, p[i - 1].lng, p[i].lat, p[i].lng);
    return soma > 0 ? distancia(p[0].lat, p[0].lng, p[p.length - 1].lat, p[p.length - 1].lng) / soma : 0;
  };

  // Recebe a posição do navegador (GeolocationPosition) e devolve:
  //   atual  -> leitura que pode ser mostrada como "onde estou agora" (ou null)
  //   pontos -> pontos a gravar na trilha, em ordem ([] se nenhum) { lat, lng, prec, t }
  //   ponto  -> o último deles (ou null)
  //   motivo -> código do motivo (MOTIVOS)
  //   rapido -> true se está em deslocamento rápido (veículo)
  Filtro.prototype.processar = function (pos, agora) {
    var cfg = this.cfg;
    agora = agora || Date.now();
    var c = pos && pos.coords;
    var lat = c ? num(c.latitude) : null, lng = c ? num(c.longitude) : null;
    if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) {
      this.registrar(null, false, 'coordenada_invalida');
      return this.resultado(null, [], 'coordenada_invalida');
    }
    var ts = num(pos.timestamp);
    var t;
    if (ts && Math.abs(ts - agora) < 24 * 3600 * 1000) {
      // Alguns aparelhos marcam a leitura com o horário do GPS, e o relógio do
      // celular pode estar adiantado/atrasado. Se a diferença for estável em 3
      // leituras seguidas, é relógio (não leitura velha): corrige o horário.
      this.offsets.push(agora - ts);
      if (this.offsets.length > 3) this.offsets.shift();
      var minO = Math.min.apply(null, this.offsets), maxO = Math.max.apply(null, this.offsets);
      var desvio = this.offsets.length === 3 && maxO - minO < 5000 && Math.abs(minO) > 5000 ? minO : 0;
      t = Math.min(ts + desvio, agora);
    } else {
      t = agora;
    }
    var prec = num(c.accuracy);
    if (prec != null && prec < 0) prec = null;
    var vel = num(c.speed);
    if (vel != null && (vel < 0 || vel > cfg.velocidadeAbsurdaMs)) vel = null;
    var leitura = { lat: lat, lng: lng, prec: prec, t: t, vel: vel, recebidaEm: agora };

    if (agora - t > cfg.idadeMaximaMs) {
      this.registrar(leitura, false, 'leitura_antiga');
      return this.resultado(null, [], 'leitura_antiga');
    }
    var u = this.ultimaLeitura;
    if (u && u.t === t && u.lat === lat && u.lng === lng) {
      // a mesma leitura repetida não é sinal novo: não "renova" a posição atual
      this.registrar(leitura, false, 'duplicada');
      return this.resultado(null, [], 'duplicada');
    }
    var a = this.ancora;
    if (a && t <= a.t) {
      this.registrar(leitura, false, 'fora_de_ordem');
      return this.resultado(null, [], 'fora_de_ordem');
    }
    this.ultimaLeitura = leitura;
    if (vel != null) this.velRecente = 0.5 * this.velRecente + 0.5 * vel;
    var ruim = prec != null && prec > cfg.precisaoTrilhaM;
    if (!ruim) {
      this.janela.push(leitura);
      while (this.janela.length > 60 || t - this.janela[0].t > 30000) this.janela.shift();
    }

    if (!a) {
      if (ruim) {
        if (this.ultimoRuimT && t - this.ultimoRuimT < cfg.intervaloRuimMs) return this.descartar(leitura, 'baixa_precisao');
        this.ultimoRuimT = t;
        return this.aceitar([leitura], 'primeiro_ponto_impreciso', null, true);
      }
      var r0 = this.aceitar([leitura], 'primeiro_ponto');
      this.ficarParado([leitura]);
      return r0;
    }

    var dt = t - a.t;
    var d = distancia(a.lat, a.lng, lat, lng);
    var extra = { dist: d, dt: dt };

    if (ruim) {
      // Não move a âncora: a linha continua a partir do último ponto confiável.
      if (t - Math.max(this.ultimoRuimT, a.t) < cfg.intervaloRuimMs) return this.descartar(leitura, 'baixa_precisao', extra);
      this.ultimoRuimT = t;
      return this.aceitar([leitura], 'aproximado', extra, true);
    }

    // Salto: distância maior que a soma das incertezas, numa velocidade incoerente
    // com o movimento recente. Não descarta de vez: se as leituras seguintes
    // confirmarem o novo local (ex.: entrou num carro), todas entram na trilha.
    var incerteza = (prec || 0) + (a.prec || 0) + 20;
    var vImplicita = d / Math.max(dt / 1000, 0.5);
    if (d > incerteza && vImplicita > this.velocidadeMaxima(vel)) {
      var s = this.suspeitos;
      var ult = s[s.length - 1];
      if (ult) {
        var ds = distancia(ult.lat, ult.lng, lat, lng);
        var dts = Math.max((t - ult.t) / 1000, 0.5);
        var coerente = ds <= (prec || 0) + (ult.prec || 0) + 20 || ds / dts <= cfg.velocidadeAbsurdaMs;
        if (!coerente) s.length = 0;
      }
      s.push(leitura);
      if (s.length >= cfg.confirmacoesSalto) {
        var conf = s.slice();
        this.suspeitos = [];
        var ultimo = conf[conf.length - 1], primeiro = conf[0];
        var dtc = Math.max((ultimo.t - primeiro.t) / 1000, 0.5);
        this.velRecente = Math.max(this.velRecente, distancia(primeiro.lat, primeiro.lng, ultimo.lat, ultimo.lng) / dtc);
        this.andar();
        return this.aceitar(conf, 'salto_confirmado', extra);
      }
      return this.descartar(leitura, 'salto_suspeito', extra);
    }
    this.suspeitos = [];

    var rapido = this.emMovimentoRapido(vel);
    if (rapido) {
      if (dt < cfg.intervaloMinimoRapidoMs) return this.descartar(leitura, 'intervalo_curto', extra);
      if (d >= cfg.distanciaMinimaRapidoM) { this.andar(); return this.aceitar([leitura], 'movimento_rapido', extra); }
    }
    return this.estado === 'andando' ? this.processarAndando(leitura, extra) : this.processarParado(leitura, extra);
  };

  /* Parado: as leituras de quem está no mesmo lugar formam uma nuvem em volta da posição real. O centro da nuvem
   * (mediana das leituras no lugar) é a posição; a confirmação periódica grava o centro, nunca uma leitura solta.
   * Sair do lugar é afastamento que se mantém (3 leituras seguidas) e cresce aos poucos, como num passo; afastamento
   * de uma vez (20–40 m em 1 s) é pulo do GPS — perto de prédios, ou quando o aparelho troca o GPS pelo Wi-Fi — e
   * só vale se durar (mudança de lugar de verdade). */
  Filtro.prototype.ficarParado = function (leituras) {
    var ls = leituras.slice(-this.cfg.janelaParado);
    this.estado = 'parado';
    this.parado = { leituras: ls, centro: mediana(ls), fora: [], ultimoDentroT: ls[ls.length - 1].t, ultimaLeitura: ls[ls.length - 1], anterior: null };
  };

  Filtro.prototype.andar = function () { this.estado = 'andando'; this.parado = null; this.paradaSeguida = 0; };

  function precMediana(ls) { return med1(ls.map(function (l) { return l.prec == null ? 0 : l.prec; })); }

  // Raio do "mesmo lugar": pela precisão informada e pela dispersão real das leituras paradas.
  Filtro.prototype.raioParado = function () {
    var cfg = this.cfg, P = this.parado, c = P.centro;
    var r = cfg.fatorOscilacao * precMediana(P.leituras);
    if (P.leituras.length >= 10) {   // com poucas leituras a dispersão ainda não diz nada (e cresceria junto com quem anda)
      r = Math.max(r, cfg.fatorDispersao * med1(P.leituras.map(function (l) { return distancia(c.lat, c.lng, l.lat, l.lng); })));
    }
    return Math.max(cfg.distanciaMinimaM, Math.min(cfg.limiteOscilacaoM, r));
  };

  // A velocidade do GPS confirma movimento só com precisão boa e nas 3 últimas leituras.
  Filtro.prototype.velocidadeConfirma = function (minima) {
    var cfg = this.cfg, j = this.janela.slice(-3);
    return j.length === 3 && j.every(function (l) { return l.vel != null && (l.prec || 0) <= cfg.precisaoVelocidadeM && (minima ? l.vel >= cfg.velocidadeMinimaMs : l.vel < 0.3); });
  };

  Filtro.prototype.processarParado = function (leitura, extra) {
    var P = this.parado;
    var r = this.processarParadoLeitura(leitura, extra);
    if (this.parado === P) P.ultimaLeitura = leitura;
    return r;
  };

  Filtro.prototype.processarParadoLeitura = function (leitura, extra) {
    var cfg = this.cfg, P = this.parado;
    var R = this.raioParado();
    if (distancia(P.centro.lat, P.centro.lng, leitura.lat, leitura.lng) <= R) {
      P.fora = [];
      P.leituras.push(leitura);
      if (P.leituras.length > cfg.janelaParado) P.leituras.shift();
      P.centro = mediana(P.leituras);
      P.ultimoDentroT = leitura.t;
      var saida = this.tendencia();
      if (saida) { this.andar(); return this.aceitar(saida, 'movimento', extra); }
      return this.confirmarParado(leitura, extra, 'oscilacao_parado');
    }
    if (!P.fora.length) P.anterior = P.ultimaLeitura;   // última leitura antes de sair do lugar
    P.fora.push(leitura);
    var f0 = P.fora[0];
    var salto0 = distancia(P.centro.lat, P.centro.lng, f0.lat, f0.lng);
    var precMed = precMediana(P.leituras);
    var permitido = R + cfg.velocidadePeMs * Math.max(1, (f0.t - P.ultimoDentroT) / 1000) + 0.5 * precMed;
    // degrau entre duas leituras seguidas (o erro de leituras seguidas é quase o mesmo): pulo, não passo
    var ant = P.anterior;
    var degrau = ant && distancia(ant.lat, ant.lng, f0.lat, f0.lng) > cfg.velocidadePeMs * Math.max(1, (f0.t - ant.t) / 1000) + Math.max(cfg.distanciaMinimaM, 0.5 * precMed);
    var med = mediana(P.fora.slice(-3));
    var dMed = distancia(P.centro.lat, P.centro.lng, med.lat, med.lng);
    // o pulo fica onde caiu; quem anda continua se afastando do ponto da saída
    var pulo = (salto0 > permitido || degrau) && distancia(f0.lat, f0.lng, med.lat, med.lng) < R;
    if (pulo) {
      // pulo: só conta se durar (mudou de lugar de verdade); enquanto isso, a posição continua a do centro
      if (leitura.t - f0.t >= cfg.confirmacaoPuloMs) {
        this.ficarParado(P.fora);
        var novo = this.parado;
        return this.aceitar([{ lat: novo.centro.lat, lng: novo.centro.lng, prec: precMediana(novo.leituras), t: leitura.t, vel: leitura.vel,
          recebidaEm: leitura.recebidaEm }], 'salto_confirmado', extra);
      }
      return this.confirmarParado(leitura, extra, 'pulo_parado');
    }
    var porVel = this.velocidadeConfirma(true);
    if (P.fora.length >= (porVel ? 2 : cfg.confirmacoesMovimento) && dMed >= (porVel ? 1 : cfg.fatorSaida) * R &&
        leitura.t - this.ancora.t >= cfg.intervaloMinimoMs) {
      // começou a andar: entram as leituras desde a saída do lugar (o começo do trecho não se perde)
      var saida = this.espacar(P.fora);
      this.andar();
      return this.aceitar(saida, 'movimento', extra);
    }
    return this.confirmarParado(leitura, extra, 'oscilacao_parado');
  };

  // Andando devagar ainda dentro do raio: as leituras do lugar nos últimos ~20 s têm deslocamento líquido
  // (centro do começo × centro do fim) maior que 1,5 × o raio da precisão (1 × com a velocidade do GPS
  // confirmando). A deriva do GPS vai e volta; quem anda, não. Devolve as leituras do deslocamento ou null.
  Filtro.prototype.tendencia = function () {
    var cfg = this.cfg, P = this.parado, ls = P.leituras, ult = ls[ls.length - 1];
    var porVel = this.velocidadeConfirma(true);   // com a velocidade do GPS confirmando, basta menos
    var w = ls.filter(function (l) { return ult.t - l.t <= cfg.janelaParadaMs; });
    if (w.length < (porVel ? 3 : 6) || ult.t - w[0].t < (porVel ? 2000 : cfg.janelaParadaMs * 0.5) || ult.t - this.ancora.t < cfg.intervaloMinimoMs) return null;
    var n = Math.floor(w.length / 3);
    var a = mediana(w.slice(0, n)), b = mediana(w.slice(-n));
    var rPrec = Math.max(cfg.distanciaMinimaM, Math.min(cfg.limiteOscilacaoM, cfg.fatorOscilacao * precMediana(w)));
    if (distancia(a.lat, a.lng, b.lat, b.lng) < (porVel ? 1 : cfg.fatorSaida) * rPrec) return null;
    return this.espacar(w.slice(n));
  };

  // Parado: a cada intervaloParadoMs, grava o centro (a posição de quem está parado), não a leitura.
  Filtro.prototype.confirmarParado = function (leitura, extra, motivo) {
    var P = this.parado, dtA = leitura.t - this.ancora.t;
    // com saída do lugar em análise, a confirmação espera (senão o centro entraria no meio das leituras da saída),
    // mas nunca mais que 2 × o intervalo
    if (dtA >= this.cfg.intervaloParadoMs && (!P.fora.length || dtA >= 2 * this.cfg.intervaloParadoMs)) {
      return this.aceitar([{ lat: P.centro.lat, lng: P.centro.lng, prec: precMediana(P.leituras), t: leitura.t, vel: leitura.vel,
        recebidaEm: leitura.recebidaEm }], 'parado_periodico', extra);
    }
    return this.descartar(leitura, motivo, extra);
  };

  // Passo entre pontos andando: proporcional à precisão (com GPS ruim, pontos colados só desenham o ruído).
  Filtro.prototype.passo = function (prec) {
    var cfg = this.cfg;
    return Math.max(cfg.distanciaMinimaM, Math.min(cfg.passoMaxM, cfg.fatorPasso * (prec || 0)));
  };

  // Das leituras desde a saída do lugar, as que ficam a um passo umas das outras (a última sempre entra).
  Filtro.prototype.espacar = function (ls) {
    var out = [], ref = this.ancora;
    for (var i = 0; i < ls.length; i++) {
      var l = ls[i];
      if (l.t - ref.t < this.cfg.intervaloMinimoMs) continue;
      if (i === ls.length - 1 || distancia(ref.lat, ref.lng, l.lat, l.lng) >= this.passo(l.prec)) { out.push(l); ref = l; }
    }
    return out.length ? out : [ls[ls.length - 1]];
  };

  // Andando → parado: o deslocamento líquido em ~20 s (centro do começo × centro do fim da janela) é pequeno,
  // ou o GPS, com precisão boa, informa velocidade ~0 nas 3 últimas leituras.
  Filtro.prototype.parou = function () {
    var cfg = this.cfg, j = this.janela, ult = j[j.length - 1];
    var w = j.filter(function (l) { return ult.t - l.t <= cfg.janelaParadaMs; });
    if (w.length < 6 || ult.t - w[0].t < cfg.janelaParadaMs * 0.75) return false;
    var n = Math.floor(w.length / 3);
    var a = mediana(w.slice(0, n)), b = mediana(w.slice(-n));
    return distancia(a.lat, a.lng, b.lat, b.lng) < Math.max(cfg.distanciaMinimaM, cfg.fatorParada * precMediana(w));
  };

  Filtro.prototype.processarAndando = function (leitura, extra) {
    var cfg = this.cfg, a = this.ancora, j = this.janela;
    this.paradaSeguida = this.parou() ? this.paradaSeguida + 1 : 0;
    if (this.paradaSeguida >= cfg.confirmacoesParada || this.velocidadeConfirma(false)) {
      this.ficarParado(j.slice(-3));
      return this.confirmarParado(leitura, extra, 'oscilacao_parado');
    }
    if (leitura.t - a.t < cfg.intervaloMinimoMs) return this.descartar(leitura, 'intervalo_curto', extra);
    // a decisão usa a mediana das 3 últimas leituras (um pico isolado não vira passo); o ponto gravado é a leitura
    var med = mediana(j.slice(-3));
    if (distancia(a.lat, a.lng, med.lat, med.lng) >= this.passo(leitura.prec)) return this.aceitar([leitura], 'movimento', extra);
    if (leitura.t - a.t >= cfg.intervaloParadoMs) return this.aceitar([leitura], 'parado_periodico', extra);
    return this.descartar(leitura, 'oscilacao_parado', extra);
  };

  Filtro.prototype.resultado = function (atual, pontos, motivo) {
    return { atual: atual, pontos: pontos, ponto: pontos.length ? pontos[pontos.length - 1] : null, motivo: motivo, rapido: this.emMovimentoRapido(null) };
  };

  Filtro.prototype.aceitar = function (leituras, motivo, extra, aproximado) {
    var self = this;
    var pontos = leituras.map(function (l) {
      return {
        lat: Math.round(l.lat * 1e7) / 1e7,
        lng: Math.round(l.lng * 1e7) / 1e7,
        prec: l.prec == null ? null : Math.round(l.prec * 10) / 10,
        t: l.t,
      };
    });
    var ultima = leituras[leituras.length - 1];
    if (!aproximado) {
      leituras.forEach(function (l) { self.aceitos.push(l); });
      while (this.aceitos.length > 4) this.aceitos.shift();
      // sem velocidade do GPS: velocidade LÍQUIDA (primeiro→último dos últimos pontos)
      if (ultima.vel == null && this.aceitos.length >= 2) {
        var p0 = this.aceitos[0];
        var dtA = (ultima.t - p0.t) / 1000;
        if (dtA > 0) this.velRecente = 0.5 * this.velRecente + 0.5 * (distancia(p0.lat, p0.lng, ultima.lat, ultima.lng) / dtA);
      }
      if (motivo === 'parado_periodico') this.velRecente *= 0.3;
      this.ancora = { lat: ultima.lat, lng: ultima.lng, prec: ultima.prec, t: ultima.t };
    }
    leituras.forEach(function (l, i) { self.registrar(l, true, motivo, i === leituras.length - 1 ? extra : null); });
    return this.resultado(ultima, pontos, motivo);
  };

  Filtro.prototype.descartar = function (leitura, motivo, extra) {
    this.registrar(leitura, false, motivo, extra);
    return this.resultado(leitura, [], motivo);
  };

  Filtro.prototype.resumo = function () {
    var self = this;
    return Object.keys(this.contagem).map(function (k) {
      return { motivo: k, texto: MOTIVOS[k] || k, qtd: self.contagem[k] };
    }).sort(function (a, b) { return b.qtd - a.qtd; });
  };

  /* ------------------------------------------------------------------ */
  /* Trilha no painel: segmentos a desenhar                               */
  /* ------------------------------------------------------------------ */
  // pontos: [{ t, lat, lng, prec }] em ordem cronológica (pelo horário do GPS).
  // Devolve { segmentos: [[lat,lng]…], lacunas: [{ de:[lat,lng], ate:[lat,lng], t0, t1 }] }.
  // Liga TODOS os pontos registrados (nenhum vértice é escondido), exceto:
  //   - pontos aproximados (precisão pior que precisaoTrilhaM): não entram na linha;
  //   - repetidos (mesmo horário e lugar);
  //   - falhas (mais de lacunaMs entre dois pontos seguidos, mesmo parado) e saltos
  //     impossíveis: a linha é interrompida e a falha é devolvida à parte, para ser
  //     desenhada tracejada, com início e fim marcados.
  function trilha(pontos, cfg) {
    cfg = mesclar(cfg);
    var segs = [], seg = [], lacunas = [], ant = null;
    for (var i = 0; i < pontos.length; i++) {
      var pt = pontos[i];
      if (pt == null || num(pt.lat) == null || num(pt.lng) == null) continue;
      if (pt.prec != null && pt.prec > cfg.precisaoTrilhaM) continue;
      if (ant) {
        var dt = pt.t - ant.t;
        if (dt <= 0 && pt.lat === ant.lat && pt.lng === ant.lng) continue;   // repetido
        var d = distancia(ant.lat, ant.lng, pt.lat, pt.lng);
        var incerteza = (pt.prec || 0) + (ant.prec || 0) + 20;
        var impossivel = d > incerteza && d / Math.max(dt / 1000, 0.5) > cfg.velocidadeAbsurdaMs;
        var semRegistro = dt > cfg.lacunaMs;
        if (impossivel || semRegistro) {
          if (seg.length) segs.push(seg);
          seg = [];
          lacunas.push({ de: [ant.lat, ant.lng], ate: [pt.lat, pt.lng], t0: ant.t, t1: pt.t, impossivel: impossivel });
        }
      }
      seg.push(cfg.objetos ? pt : [pt.lat, pt.lng]);
      ant = pt;
    }
    if (seg.length) segs.push(seg);
    return { segmentos: segs, lacunas: lacunas };
  }

  // Compatibilidade: só os segmentos.
  function segmentosTrilha(pontos, cfg) { return trilha(pontos, cfg).segmentos; }

  /* ------------------------------------------------------------------ */
  /* Permissão de localização                                             */
  /* ------------------------------------------------------------------ */
  // Estado da permissão do NAVEGADOR para este site: 'granted', 'denied',
  // 'prompt' ou 'desconhecido' (navegador sem a Permissions API).
  // Não diz nada sobre a localização do sistema (GPS do celular ligado ou não):
  // isso só aparece quando o navegador tenta ler a posição (erro 2).
  function consultarPermissao() {
    try {
      if (!global.navigator || !navigator.permissions || !navigator.permissions.query) {
        return Promise.resolve({ estado: 'desconhecido', status: null });
      }
      return navigator.permissions.query({ name: 'geolocation' }).then(
        function (st) { return { estado: st.state, status: st }; },
        function () { return { estado: 'desconhecido', status: null }; });
    } catch (e) {
      return Promise.resolve({ estado: 'desconhecido', status: null });
    }
  }

  function ambiente() {
    var ua = (global.navigator && navigator.userAgent) || '';
    var ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && global.navigator && navigator.maxTouchPoints > 1);
    var android = /Android/i.test(ua);
    var nav = /SamsungBrowser/i.test(ua) ? 'samsung'
      : /EdgA?\//i.test(ua) ? 'edge'
      : /FxiOS|Firefox/i.test(ua) ? 'firefox'
      : /CriOS/i.test(ua) ? 'chrome'
      : /Chrome/i.test(ua) ? 'chrome'
      : /Safari/i.test(ua) ? 'safari' : 'outro';
    return { so: ios ? 'ios' : android ? 'android' : 'computador', navegador: nav };
  }

  // Instruções para o aparelho e o navegador em uso.
  //   problema: 'navegador' (site bloqueado), 'sistema' (localização do celular
  //   desligada) ou 'sinal' (ligada, mas sem sinal de GPS).
  // Não existe forma padronizada de uma página abrir as configurações do
  // celular; por isso não há botão "Abrir configurações": só os passos.
  function instrucoesLocalizacao(problema) {
    var a = ambiente();
    var passos = [];
    if (problema === 'sistema') {
      if (a.so === 'android') {
        passos = ['Puxe a barra de notificações do topo da tela para baixo.',
          'Toque em "Localização" para ligar (ou abra Configurações › Localização › Usar localização).',
          'Se aparecer "Precisão da localização", deixe ligada.',
          'Volte para esta página e toque em VERIFICAR DE NOVO.'];
      } else if (a.so === 'ios') {
        passos = ['Abra os Ajustes do iPhone › Privacidade e Segurança › Serviços de Localização.',
          'Ligue "Serviços de Localização".',
          'Na mesma tela, toque em ' + (a.navegador === 'chrome' ? '"Chrome"' : '"Sites do Safari"') + ' e escolha "Ao Usar o App".',
          'Volte para esta página e toque em VERIFICAR DE NOVO.'];
      } else {
        passos = ['Ligue a localização do computador nas configurações do sistema (Privacidade › Localização).',
          'Permita a localização para o navegador.', 'Volte e clique em VERIFICAR DE NOVO.'];
      }
      return { titulo: 'A localização do celular está desligada', passos: passos };
    }
    if (problema === 'sinal') {
      return { titulo: 'O celular ainda não encontrou o sinal de GPS', passos: [
        'Vá para um lugar aberto, longe de paredes, telhados e árvores densas.',
        'Espere alguns segundos com esta tela aberta.',
        a.so === 'android' ? 'Confira se a "Precisão da localização" está ligada nas configurações de Localização.' : 'Confira se a localização está ligada no celular.'] };
    }
    if (a.so === 'android') {
      if (a.navegador === 'samsung') {
        passos = ['Toque no cadeado ao lado do endereço do site.', 'Toque em "Permissões" e ligue "Localização".'];
      } else if (a.navegador === 'firefox') {
        passos = ['Toque no cadeado ao lado do endereço do site.', 'Toque em "Editar permissões do site" e marque Localização como "Permitida".'];
      } else {
        passos = ['Toque no ícone ao lado do endereço do site (cadeado ou ajustes).', 'Toque em "Permissões" › "Localização" e escolha "Permitir".'];
      }
      passos.push('Se não aparecer: Configurações do celular › Apps › ' +
        ({ samsung: 'Samsung Internet', firefox: 'Firefox', edge: 'Edge' }[a.navegador] || 'Chrome') + ' › Permissões › Localização › Permitir.');
    } else if (a.so === 'ios') {
      if (a.navegador === 'chrome') {
        passos = ['Abra os Ajustes do iPhone › Chrome › Localização e escolha "Ao Usar o App".'];
      } else {
        passos = ['Toque em "aA" na barra de endereço › "Ajustes do Site" › Localização › "Permitir".',
          'Se não houver essa opção: Ajustes do iPhone › Apps › Safari › Localização › "Perguntar" ou "Permitir".'];
      }
      passos.push('No iPhone, depois de liberar, pode ser preciso recarregar esta página (seus dados continuam).');
    } else {
      passos = ['Clique no cadeado (ou ícone de ajustes) à esquerda do endereço do site.', 'Em "Localização", escolha "Permitir".'];
    }
    passos.push('Volte para esta página e toque em VERIFICAR DE NOVO.');
    return { titulo: 'A localização está bloqueada para este site', passos: passos };
  }

  // Tabela do diagnóstico (só números e textos fixos; seguro para innerHTML).
  function tabelaDiagnostico(filtro, max) {
    var linhas = filtro.diag.slice(-(max || 60)).reverse().map(function (e) {
      var h = new Date(e.em);
      var hora = ('0' + h.getHours()).slice(-2) + ':' + ('0' + h.getMinutes()).slice(-2) + ':' + ('0' + h.getSeconds()).slice(-2);
      function v(x, suf) { return x == null ? '—' : String(x) + (suf || ''); }
      return '<tr class="' + (e.aceito ? 'diag-ok' : 'diag-desc') + '"><td>' + hora + '</td><td>' + (e.aceito ? '✓' : '✗') + ' ' +
        (MOTIVOS[e.motivo] || 'outro') + '</td><td class="num">' + v(e.prec, ' m') + '</td><td class="num">' + v(e.dist, ' m') +
        '</td><td class="num">' + v(e.idade_s, ' s') + '</td><td class="mono">' + (e.lat == null ? '—' : e.lat.toFixed(5) + ', ' + e.lng.toFixed(5)) + '</td></tr>';
    }).join('');
    return '<table class="tabela-diag"><thead><tr><th>Hora</th><th>Resultado</th><th>Precisão</th><th>Distância</th><th>Idade</th><th>Coordenadas</th></tr></thead><tbody>' +
      (linhas || '<tr><td colspan="6">Nenhuma leitura ainda.</td></tr>') + '</tbody></table>';
  }

  global.GPS = {
    PADRAO: PADRAO,
    MOTIVOS: MOTIVOS,
    Filtro: Filtro,
    distancia: distancia,
    segmentosTrilha: segmentosTrilha,
    trilha: trilha,
    consultarPermissao: consultarPermissao,
    ambiente: ambiente,
    instrucoesLocalizacao: instrucoesLocalizacao,
    tabelaDiagnostico: tabelaDiagnostico,
  };
})(typeof window !== 'undefined' ? window : globalThis);
