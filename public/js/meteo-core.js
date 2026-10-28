/* =====================================================================
 * meteo-core.js — regras do monitoramento meteorológico (sem rede, sem DOM).
 *
 * Usado pelo painel (meteo.js) e pelos testes (testes/meteo_core.test.js).
 * Os limiares abaixo são referências do painel, NÃO são normas oficiais:
 * ajuste-os com o comando da operação. Os alertas oficiais (INMET/CAP) têm
 * prioridade sobre os indicativos calculados aqui.
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var LIMIARES = {
    chuvaModerada: 2.5,      // mm/h: a partir daqui é chuva moderada
    chuvaIntensa: 10,        // mm/h: a partir daqui é chuva intensa
    rajadaAtencao: 40,       // km/h
    rajadaAlerta: 60,        // km/h
    horizonteHoras: 3,       // janela da previsão usada para os alertas
    mmParaChegada: 0.5,      // mm/h que caracteriza a chegada da chuva
    probParaChegada: 60,     // % de probabilidade que também caracteriza a chegada
    incertezaDentroHora: 30, // ± min quando a chegada cai na 1ª hora
    incertezaDepois: 60      // ± min para horários mais distantes
  };

  // Códigos WMO (Open-Meteo): tempestade e granizo.
  var CODIGOS_TEMPESTADE = [95, 96, 99];
  var CODIGOS_GRANIZO = [96, 99];

  var RANK = { informativo: 0, atencao: 1, alerta: 2, critico: 3 };

  function intensidadeChuva(mmh) {
    if (mmh == null || !isFinite(mmh) || mmh <= 0) return 'nenhuma';
    if (mmh < LIMIARES.chuvaModerada) return 'fraca';
    if (mmh < LIMIARES.chuvaIntensa) return 'moderada';
    return 'intensa';
  }

  // Distância em metros (haversine) e rumo em graus (0 = norte, sentido horário).
  function distanciaM(lat1, lng1, lat2, lng2) {
    var R = 6371000, k = Math.PI / 180;
    var dLat = (lat2 - lat1) * k, dLng = (lng2 - lng1) * k;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * k) * Math.cos(lat2 * k) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function rumoGraus(lat1, lng1, lat2, lng2) {
    var k = Math.PI / 180;
    var y = Math.sin((lng2 - lng1) * k) * Math.cos(lat2 * k);
    var x = Math.cos(lat1 * k) * Math.sin(lat2 * k) - Math.sin(lat1 * k) * Math.cos(lat2 * k) * Math.cos((lng2 - lng1) * k);
    return (Math.atan2(y, x) / k + 360) % 360;
  }

  // Severidade CAP → nível do painel. Severidade desconhecida fica como informativo.
  function nivelDeSeveridade(sev) {
    var s = String(sev || '').toLowerCase();
    if (s === 'extreme' || s === 'severe') return 'critico';
    if (s === 'moderate') return 'alerta';
    if (s === 'minor') return 'atencao';
    return 'informativo';
  }

  function maior(a, b) { return RANK[a] >= RANK[b] ? a : b; }

  // Horas da previsão dentro da janela de alerta (uma hora antes de agora até o horizonte).
  function horasNaJanela(horas, agoraMs) {
    var ini = agoraMs - 3600e3, fim = agoraMs + LIMIARES.horizonteHoras * 3600e3;
    return (horas || []).filter(function (h) { var t = Date.parse(h.t); return t >= ini && t <= fim; });
  }

  // Previsão de chegada da chuva ao ponto da operação: primeira hora (a partir de agora) com chuva
  // prevista pelo modelo. NÃO é extrapolação do radar. Retorna null se o modelo não prevê chuva.
  function previsaoChegada(horas, agoraMs) {
    var proximas = (horas || []).filter(function (h) { return Date.parse(h.t) >= agoraMs - 3600e3; });
    for (var i = 0; i < proximas.length; i++) {
      var h = proximas[i];
      if ((h.precip != null && h.precip >= LIMIARES.mmParaChegada) || (h.prob != null && h.prob >= LIMIARES.probParaChegada)) {
        var t = Date.parse(h.t);
        var dentro = t <= agoraMs + 3600e3;
        return { t: h.t, incertezaMin: dentro ? LIMIARES.incertezaDentroHora : LIMIARES.incertezaDepois, tipo: 'previsao_modelo' };
      }
    }
    return null;
  }

  // Alertas derivados da previsão + alertas oficiais já filtrados para a região.
  // Cada alerta tem 'chave' estável: a mesma ocorrência continua com a mesma chave entre atualizações.
  function analisar(previsao, oficiais, agoraMs) {
    var out = [];
    var prev = previsao || {};
    var janela = horasNaJanela(prev.horas, agoraMs);
    var atual = prev.atual || null;

    if (atual && intensidadeChuva(atual.precipitacao) !== 'nenhuma') {
      var forca = intensidadeChuva(atual.precipitacao);
      out.push({ chave: 'chuva-agora', tipo: 'chuva', nivel: forca === 'intensa' ? 'alerta' : forca === 'moderada' ? 'atencao' : 'informativo',
        titulo: 'Chuva ' + forca + ' agora na operação', detalhe: atual.precipitacao.toFixed(1) + ' mm/h (previsão de modelo, não radar)',
        fonte: 'Modelo de previsão', eta: null });
    }

    var pMax = 0, rMax = 0, tempestade = null, granizo = null;
    janela.forEach(function (h) {
      if (h.precip != null && h.precip > pMax) pMax = h.precip;
      if (h.rajada != null && h.rajada > rMax) rMax = h.rajada;
      if (!tempestade && CODIGOS_TEMPESTADE.indexOf(h.codigo) >= 0) tempestade = h;
      if (!granizo && CODIGOS_GRANIZO.indexOf(h.codigo) >= 0) granizo = h;
    });

    var chegada = previsaoChegada(prev.horas, agoraMs);
    if (pMax >= LIMIARES.chuvaIntensa) {
      out.push({ chave: 'chuva-intensa', tipo: 'chuva', nivel: 'alerta', titulo: 'Chuva intensa prevista nas próximas ' + LIMIARES.horizonteHoras + ' h',
        detalhe: 'Até ' + pMax.toFixed(1) + ' mm/h (modelo)', fonte: 'Modelo de previsão', eta: chegada });
    } else if (pMax >= LIMIARES.chuvaModerada) {
      out.push({ chave: 'chuva-moderada', tipo: 'chuva', nivel: 'atencao', titulo: 'Chuva moderada prevista nas próximas ' + LIMIARES.horizonteHoras + ' h',
        detalhe: 'Até ' + pMax.toFixed(1) + ' mm/h (modelo)', fonte: 'Modelo de previsão', eta: chegada });
    }
    if (rMax >= LIMIARES.rajadaAlerta) {
      out.push({ chave: 'rajadas', tipo: 'vento', nivel: 'alerta', titulo: 'Rajadas fortes previstas', detalhe: 'Até ' + Math.round(rMax) + ' km/h (modelo)', fonte: 'Modelo de previsão', eta: null });
    } else if (rMax >= LIMIARES.rajadaAtencao) {
      out.push({ chave: 'rajadas', tipo: 'vento', nivel: 'atencao', titulo: 'Rajadas de vento moderadas previstas', detalhe: 'Até ' + Math.round(rMax) + ' km/h (modelo)', fonte: 'Modelo de previsão', eta: null });
    }
    if (tempestade) {
      out.push({ chave: 'tempestade', tipo: 'tempestade', nivel: 'alerta', titulo: 'Condição favorável a tempestade', detalhe: 'Modelo indica trovoadas nas próximas horas. Raios não são medidos por esta fonte.',
        fonte: 'Modelo de previsão', eta: { t: tempestade.t, incertezaMin: LIMIARES.incertezaDepois, tipo: 'previsao_modelo' } });
    }
    if (granizo) {
      out.push({ chave: 'granizo', tipo: 'granizo', nivel: 'alerta', titulo: 'Risco de granizo (indicativo)', detalhe: 'Código de granizo no modelo. Não é medição de granizo.',
        fonte: 'Modelo de previsão', eta: { t: granizo.t, incertezaMin: LIMIARES.incertezaDepois, tipo: 'previsao_modelo' } });
    }

    (oficiais || []).forEach(function (a) {
      out.push({ chave: 'oficial:' + a.id, tipo: 'oficial', nivel: nivelDeSeveridade(a.severidade), titulo: a.evento || 'Alerta meteorológico oficial',
        detalhe: a.descricao || '', fonte: 'INMET (alerta oficial)', eta: null, inicio: a.inicio || null, fim: a.fim || null, area: a.area || null });
    });
    return out;
  }

  // Dados desatualizados: sem atualização bem-sucedida há mais de limiteMin (ou nunca atualizado).
  function desatualizado(atualizadoEm, agoraMs, limiteMin) {
    var t = atualizadoEm ? Date.parse(atualizadoEm) : NaN;
    if (!isFinite(t)) return true;
    return agoraMs - t > limiteMin * 60e3;
  }

  // Notifica quando o alerta é novo ou quando o nível sobe. Repetição sem mudança é silenciada.
  function deveNotificar(anterior, atual) {
    if (!anterior) return true;
    return RANK[atual.nivel] > RANK[anterior.nivel];
  }

  // Estados entre duas leituras: novo, atualizado (mudou de nível/texto), mantido ou expirado.
  function compararLeituras(antigos, novos) {
    var mapaAntigo = {}, mapaNovo = {};
    antigos.forEach(function (a) { mapaAntigo[a.chave] = a; });
    novos.forEach(function (a) { mapaNovo[a.chave] = a; });
    var estados = novos.map(function (a) {
      var ant = mapaAntigo[a.chave];
      var estado = !ant ? 'novo' : (ant.nivel !== a.nivel || ant.titulo !== a.titulo || ant.detalhe !== a.detalhe) ? 'atualizado' : 'mantido';
      return Object.assign({}, a, { estado: estado });
    });
    antigos.forEach(function (a) {
      if (!mapaNovo[a.chave]) estados.push(Object.assign({}, a, { estado: 'expirado' }));
    });
    return estados;
  }

  // Vento: direção é de onde o vento vem (convenção meteorológica). Componentes para onde ele vai.
  function componentesVento(velocidade, direcaoGraus) {
    var r = (direcaoGraus || 0) * Math.PI / 180;
    return { u: -velocidade * Math.sin(r), v: -velocidade * Math.cos(r) };
  }

  // Grade regular: { lat0, lng0, dlat, dlng, nLin, nCol, valores } com valores em ordem de linhas
  // (linha = latitude crescente, coluna = longitude crescente). Devolve null fora da grade.
  function interpolar(g, lat, lng) {
    var fi = (lat - g.lat0) / g.dlat, fj = (lng - g.lng0) / g.dlng;
    if (!isFinite(fi) || !isFinite(fj) || fi < 0 || fj < 0 || fi > g.nLin - 1 || fj > g.nCol - 1) return null;
    var i0 = Math.min(Math.floor(fi), g.nLin - 2), j0 = Math.min(Math.floor(fj), g.nCol - 2);
    var ti = fi - i0, tj = fj - j0;
    function v(i, j) { return g.valores[i * g.nCol + j]; }
    var a = v(i0, j0), b = v(i0, j0 + 1), c = v(i0 + 1, j0), d = v(i0 + 1, j0 + 1);
    if (a == null || b == null || c == null || d == null) return null;
    return (a * (1 - ti) + c * ti) * (1 - tj) + (b * (1 - ti) + d * ti) * tj;
  }

  // Escala de temperatura no estilo dos mapas de vento: frio em azul, quente em vermelho.
  var PARADAS_TEMP = [[-5, [59, 130, 246]], [5, [56, 189, 248]], [15, [74, 222, 128]], [22, [250, 204, 21]], [30, [249, 115, 22]], [38, [220, 38, 38]]];
  function corTemperatura(t) {
    if (t == null || !isFinite(t)) return null;
    if (t <= PARADAS_TEMP[0][0]) return PARADAS_TEMP[0][1];
    for (var i = 1; i < PARADAS_TEMP.length; i++) {
      if (t <= PARADAS_TEMP[i][0]) {
        var a = PARADAS_TEMP[i - 1], b = PARADAS_TEMP[i], k = (t - a[0]) / (b[0] - a[0]);
        return [0, 1, 2].map(function (c) { return Math.round(a[1][c] + (b[1][c] - a[1][c]) * k); });
      }
    }
    return PARADAS_TEMP[PARADAS_TEMP.length - 1][1];
  }

  // Escala de velocidade do vento (km/h) para as partículas: calmo claro, forte em magenta.
  var PARADAS_VENTO = [[0, [186, 230, 253]], [15, [56, 189, 248]], [30, [129, 140, 248]], [50, [236, 72, 153]]];
  function corVento(kmh) {
    if (kmh == null || !isFinite(kmh)) return PARADAS_VENTO[0][1];
    if (kmh <= PARADAS_VENTO[0][0]) return PARADAS_VENTO[0][1];
    for (var i = 1; i < PARADAS_VENTO.length; i++) {
      if (kmh <= PARADAS_VENTO[i][0]) {
        var a = PARADAS_VENTO[i - 1], b = PARADAS_VENTO[i], k = (kmh - a[0]) / (b[0] - a[0]);
        return [0, 1, 2].map(function (c) { return Math.round(a[1][c] + (b[1][c] - a[1][c]) * k); });
      }
    }
    return PARADAS_VENTO[PARADAS_VENTO.length - 1][1];
  }

  // Direção cardinal de um rumo em graus (ex.: 45 → "NE").
  function direcaoCardeal(rumo) {
    var nomes = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
    return nomes[Math.round(((rumo % 360) + 360) % 360 / 45) % 8];
  }

  // Ponto da grade com chuva mais próxima do centro da operação (ou null).
  function chuvaMaisProxima(pontos, latC, lngC) {
    var melhor = null;
    (pontos || []).forEach(function (p) {
      if (p.precipitacao == null || p.precipitacao < LIMIARES.mmParaChegada) return;
      var d = distanciaM(latC, lngC, p.lat, p.lng);
      if (!melhor || d < melhor.distanciaM) {
        melhor = { lat: p.lat, lng: p.lng, precipitacao: p.precipitacao, distanciaM: d, rumo: rumoGraus(latC, lngC, p.lat, p.lng) };
      }
    });
    return melhor;
  }

  // Alerta de chuva na área: a distância e a direção ajudam a decidir se dá tempo de sair.
  // Não há direção de deslocamento: só a posição atual (modelo), sem extrapolação.
  function alertaChuvaProxima(chuva) {
    if (!chuva) return null;
    var km = chuva.distanciaM / 1000;
    var forte = intensidadeChuva(chuva.precipitacao);
    var nivel = km <= 10 && forte === 'intensa' ? 'alerta' : km <= 25 && forte !== 'fraca' ? 'atencao' : 'informativo';
    return { chave: 'chuva-proxima', tipo: 'chuva', nivel: nivel,
      titulo: 'Chuva a ~' + Math.round(km) + ' km ' + direcaoCardeal(chuva.rumo) + ' da operação',
      detalhe: chuva.precipitacao.toFixed(1) + ' mm/h no ponto mais próximo (modelo, sem direção de deslocamento)',
      fonte: 'Modelo de previsão', eta: null };
  }

  var API = {
    direcaoCardeal: direcaoCardeal, chuvaMaisProxima: chuvaMaisProxima, alertaChuvaProxima: alertaChuvaProxima,
    componentesVento: componentesVento, interpolar: interpolar, corTemperatura: corTemperatura, corVento: corVento,
    PARADAS_TEMP: PARADAS_TEMP, PARADAS_VENTO: PARADAS_VENTO,
    LIMIARES: LIMIARES, intensidadeChuva: intensidadeChuva, distanciaM: distanciaM, rumoGraus: rumoGraus,
    nivelDeSeveridade: nivelDeSeveridade, maior: maior, previsaoChegada: previsaoChegada, analisar: analisar,
    desatualizado: desatualizado, deveNotificar: deveNotificar, compararLeituras: compararLeituras, RANK: RANK,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  raiz.MeteoCore = API;
})(typeof window !== 'undefined' ? window : globalThis);
