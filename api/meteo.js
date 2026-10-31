// GET /api/meteo?lat=-25.4&lng=-49.2  → dados meteorológicos da área da operação (só responsáveis).
//
// Fontes (cada uma independente: a falha de uma não derruba as outras):
//   previsao  MET Norway (Meteorologisk institutt), Locationforecast 2.0: sem chave, cobre o Brasil e
//             é de uso gratuito com atribuição e identificação do aplicativo (User-Agent). Padrão.
//             Se OPEN_METEO_API_KEY estiver definida, usa o Open-Meteo do plano comercial no lugar.
//   radar     RainViewer, SÓ se METEO_RADAR=rainviewer. A licença é apenas pessoal e educacional
//             (não usar em operação); por isso fica desligado por padrão. Sem radar gratuito com
//             licença comercial que cubra o Brasil.
//   alertas   INMET (CAP) URL em METEO_ALERTAS_URL. Sem a variável, o serviço informa "não configurado".
//   satelite  GOES-East (NOAA), infravermelho realçado (canal 13), pelo NASA GIBS: domínio público, sem chave,
//             cobre todo o Brasil, imagem nova a cada 10 min (atraso de ~20–40 min). Mostra as nuvens de
//             tempestade (topos frios), não a chuva medida no chão. ?tipo=satelite devolve os horários disponíveis.
//   Grade da área (vento, temperatura e chuva no mapa): ?tipo=grade&area=operacao (240 km ao redor da operação,
//             usada também nos alertas), area=parana (o estado inteiro) ou area=brasil (o país inteiro).
//   METEO_USER_AGENT (opcional): identificação do aplicativo exigida pela MET Norway (ex.: nome + contato).
//
// Segurança: chamada exige o login de um responsável (eh_responsavel, com o token da própria pessoa).
// As chaves ficam só no servidor (variáveis da Vercel). Cache em memória por instância para não repetir consultas.

const TIMEOUT_MS = 8000;
const GRADE_N = 13;          // pontos por lado da grade (13 × 13 = 169)
const GRADE_MEIA_KM = 120;   // área fixa da grade: 120 km para cada lado da operação
const TTL = { radar: 5 * 60e3, previsao: 15 * 60e3, alertas: 10 * 60e3, satelite: 5 * 60e3, regiao: 30 * 60e3 };
// Áreas fixas da grade: [sul, oeste, norte, leste] e pontos por linha/coluna (MET Norway: uma consulta por ponto;
// Open-Meteo com chave: uma consulta só, então a grade pode ser bem mais densa).
const AREAS = {
  parana: { caixa: [-26.8, -54.7, -22.4, -47.9], metno: [9, 11], openmeteo: [23, 29] },
  brasil: { caixa: [-33.8, -74.0, 5.3, -34.7], metno: [10, 10], openmeteo: [30, 30] },
};
// Satélite GOES-East no NASA GIBS (WMTS, Web Mercator, até o nível 6)
const GIBS_CAMADA = 'GOES-East_ABI_Band13_Clean_Infrared';
const GIBS_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/' + GIBS_CAMADA + '/default/{t}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png';
const SAT_PASSO_MIN = 10, SAT_QUADROS = 12;
const cache = new Map();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cache por chave com validade; guarda também o último erro para informar a interface.
async function comCache(chave, validadeMs, buscar) {
  const agora = Date.now();
  const hit = cache.get(chave);
  if (hit && agora - hit.em < validadeMs) return hit.valor;
  let valor;
  try {
    valor = { ok: true, obtidoEm: new Date(agora).toISOString(), dados: await buscar() };
  } catch (e) {
    // Mantém o último dado bom, mas marca o erro atual.
    const anterior = hit && hit.valor && hit.valor.ok ? hit.valor : null;
    valor = { ok: false, erro: String(e && e.message || e).slice(0, 160), obtidoEm: anterior ? anterior.obtidoEm : null, dados: anterior ? anterior.dados : null };
  }
  cache.set(chave, { em: agora, valor });
  return valor;
}

async function getJson(url, opcoes) {
  const r = await fetch(url, Object.assign({ headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) }, opcoes || {}));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function radarRainViewer() {
  const j = await getJson('https://api.rainviewer.com/public/weather-maps.json');
  const past = (j.radar && j.radar.past) || [];
  if (!j.host || !past.length) throw new Error('resposta sem quadros de radar');
  return {
    host: j.host,
    quadros: past.map(function (q) { return { t: new Date(q.time * 1000).toISOString(), path: q.path }; }),
  };
}

// Open-Meteo: horário em GMT (sem deslocamento) para não depender do fuso do servidor.
async function previsaoOpenMeteo(lat, lng) {
  const chave = (process.env.OPEN_METEO_API_KEY || '').trim();
  const base = chave ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://api.open-meteo.com/v1/forecast';
  const q = new URLSearchParams({
    latitude: String(lat), longitude: String(lng), timezone: 'GMT', forecast_hours: '12',
    current: 'temperature_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m',
    hourly: 'precipitation,precipitation_probability,weather_code,wind_gusts_10m,wind_speed_10m',
  });
  if (chave) q.set('apikey', chave);
  const j = await getJson(base + '?' + q.toString());
  const c = j.current || {};
  const h = j.hourly || {};
  const iso = function (s) { return new Date(s + 'Z').toISOString(); };
  return {
    atual: { t: iso(c.time), temperatura: c.temperature_2m, precipitacao: c.precipitation, codigo: c.weather_code, vento: c.wind_speed_10m, rajada: c.wind_gusts_10m },
    horas: (h.time || []).map(function (t, i) {
      return { t: iso(t), precip: h.precipitation ? h.precipitation[i] : null, prob: h.precipitation_probability ? h.precipitation_probability[i] : null,
        codigo: h.weather_code ? h.weather_code[i] : null, rajada: h.wind_gusts_10m ? h.wind_gusts_10m[i] : null,
        vento: h.wind_speed_10m ? h.wind_speed_10m[i] : null };
    }),
  };
}

// MET Norway: uma consulta por ponto. Vento vem em m/s (convertido para km/h, como o resto do painel);
// não há rajadas nem probabilidade de chuva nesta fonte, então esses campos ficam vazios.
const METNO_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
function agenteUsuario() {
  return (process.env.METEO_USER_AGENT || '').trim() || 'GBS-Rastreamento/1.0 (https://github.com/mateusfontana725-create/gbs-rastreamento-prototipo)';
}
async function getJsonMet(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': agenteUsuario() }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
// Símbolo da MET (ex.: "rain_day", "heavyrainandthunder") → código WMO usado pelos alertas do painel.
function codigoMet(sim) {
  if (!sim) return null;
  const base = String(sim).replace(/_(day|night|polartwilight)$/, '');
  if (/thunder/.test(base)) return 95;
  if (/^heavyrain/.test(base)) return 65;
  if (/^rain(showers)?$/.test(base) || base === 'rainshowers') return 61;
  if (/^lightrain/.test(base)) return 51;
  if (/sleet/.test(base)) return 66;
  if (/snow/.test(base)) return 71;
  if (base === 'fog') return 45;
  if (base === 'cloudy') return 3;
  if (base === 'partlycloudy') return 2;
  if (base === 'fair') return 1;
  if (base === 'clearsky') return 0;
  return null;
}
function linhaMet(bloco) {
  const d = bloco.data || {};
  const inst = (d.instant && d.instant.details) || {};
  const n1 = d.next_1_hours || {};
  return {
    t: new Date(bloco.time).toISOString(),
    temperatura: inst.air_temperature != null ? inst.air_temperature : null,
    vento: inst.wind_speed != null ? Math.round(inst.wind_speed * 3.6 * 10) / 10 : null,
    direcao: inst.wind_from_direction != null ? inst.wind_from_direction : null,
    precip: n1.details && n1.details.precipitation_amount != null ? n1.details.precipitation_amount : null,
    codigo: codigoMet(n1.summary && n1.summary.symbol_code),
  };
}
function seriesMet(j) {
  const serie = (j && j.properties && j.properties.timeseries) || [];
  if (!serie.length) throw new Error('resposta sem previsão');
  return serie.map(linhaMet);
}
async function previsaoMetNorway(lat, lng) {
  const linhas = seriesMet(await getJsonMet(METNO_URL + '?lat=' + lat + '&lon=' + lng)).slice(0, 12);
  const a = linhas[0];
  return {
    atual: { t: a.t, temperatura: a.temperatura, precipitacao: a.precip, codigo: a.codigo, vento: a.vento, rajada: null, direcao: a.direcao },
    horas: linhas.map(function (l) { return { t: l.t, precip: l.precip, prob: null, codigo: l.codigo, rajada: null, vento: l.vento }; }),
  };
}
// Grade mais leve que a do Open-Meteo (uma consulta por ponto): 7 × 7 ao redor da operação, em lotes.
// tolerancia (fração de pontos que pode faltar): 0 na grade da operação (usada nos alertas: falha sem inventar
// pontos); nas grades do Paraná e do Brasil, um ponto sem resposta fica vazio (o mapa não pinta ali).
const GRADE_N_METNO = 7;
async function gradeMetNorway(lat, lng, meiaKm) {
  return consultarGradeMet(montarGrade(lat, lng, meiaKm, GRADE_N_METNO), 6, 0);
}
async function consultarGradeMet(g, simultaneas, tolerancia) {
  const pontos = [];
  let faltam = 0;
  for (let i = 0; i < g.pontos.length; i += simultaneas) {
    const lote = g.pontos.slice(i, i + simultaneas);
    const res = await Promise.all(lote.map(function (p) {
      return getJsonMet(METNO_URL + '?lat=' + p.lat + '&lon=' + p.lng).then(function (j) { return seriesMet(j)[0]; }).catch(function () { return null; });
    }));
    res.forEach(function (x, k) {
      if (!x) {
        faltam++;
        if (faltam > Math.floor(g.pontos.length * tolerancia)) throw new Error('grade incompleta: a fonte não respondeu para um dos pontos');
        pontos.push({ lat: lote[k].lat, lng: lote[k].lng, temperatura: null, vento: null, direcao: null, precipitacao: null });
        return;
      }
      pontos.push({ lat: lote[k].lat, lng: lote[k].lng, temperatura: x.temperatura, vento: x.vento, direcao: x.direcao, precipitacao: x.precip });
    });
  }
  return { lat0: g.lat0, lng0: g.lng0, dlat: g.dlat, dlng: g.dlng, nLin: g.nLin, nCol: g.nCol, pontos: pontos };
}

// Grade de uma área fixa (Paraná ou Brasil), igual para todas as operações (um cache só para todos).
async function gradeRegiao(nome, openMeteo) {
  const a = AREAS[nome];
  const n = openMeteo ? a.openmeteo : a.metno;
  const g = montarGradeCaixa(a.caixa[0], a.caixa[1], a.caixa[2], a.caixa[3], n[0], n[1]);
  return openMeteo ? consultarGradeOpenMeteo(g) : consultarGradeMet(g, 10, 0.15);
}

// Satélite: procura o horário mais recente já publicado (a cada 10 min, com atraso) testando um tile sobre o
// Sul do Brasil, e devolve os últimos quadros para animar.
async function sateliteGoes() {
  const passo = SAT_PASSO_MIN * 60e3;
  const base = Math.floor(Date.now() / passo) * passo;
  for (let k = 1; k <= 12; k++) {
    const t = new Date(base - k * passo).toISOString().replace('.000Z', 'Z');
    const url = GIBS_URL.replace('{t}', t).replace('{z}', '4').replace('{y}', '9').replace('{x}', '5');
    let r = null;
    try { r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) }); } catch (e) { r = null; }
    if (r && r.ok) {
      const quadros = [];
      for (let i = SAT_QUADROS - 1; i >= 0; i--) quadros.push(new Date(Date.parse(t) - i * passo).toISOString().replace('.000Z', 'Z'));
      return { camada: GIBS_CAMADA, url: GIBS_URL, maxZoom: 6, quadros: quadros };
    }
  }
  throw new Error('nenhuma imagem de satélite recente');
}

// Alertas no formato CAP (campos com nomes de CAP). A estrutura exata do feed do INMET não foi
// verificada nesta versão: a leitura é tolerante e o que não for reconhecido é descartado.
async function alertasInmet() {
  const url = (process.env.METEO_ALERTAS_URL || '').trim();
  if (!url) return { configurado: false, lista: [] };
  const j = await getJson(url);
  const bruto = Array.isArray(j) ? j : Array.isArray(j.alerts) ? j.alerts : Array.isArray(j.features) ? j.features.map(function (f) { return f.properties || f; }) : null;
  if (!bruto) throw new Error('formato de alerta não reconhecido');
  const lista = bruto.map(function (a, i) {
    const area = String(a.areaDesc || a.area || '');
    const geocodes = [].concat(a.geocode || a.geocodes || []).map(String);
    return {
      id: String(a.identifier || a.id || i),
      evento: a.event || a.headline || 'Alerta meteorológico',
      severidade: a.severity || '',
      inicio: a.onset || a.sent || null,
      fim: a.expires || null,
      descricao: a.description || a.instruction || '',
      area: area,
      noParana: /paran[aá]/i.test(area) || geocodes.some(function (g) { return /^41/.test(g); }),
    };
  }).filter(function (a) { return a.noParana; });
  return { configurado: true, lista: lista };
}

// Pergunta ao banco, com o login da própria pessoa, se ela é responsável ativa.
async function ehResponsavel(token) {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const chavePublica = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  const r = await fetch(url + '/rest/v1/rpc/eh_responsavel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: chavePublica, Authorization: 'Bearer ' + token },
    body: '{}',
  });
  if (r.status === 401) return 401;
  if (!r.ok) return false;
  return (await r.json()) === true;
}

// Grade de pontos ao redor da operação (n × n, em ordem de linhas: latitude crescente, depois longitude).
// Usada para desenhar vento e temperatura no mapa. meia = metade da largura, em km.
function montarGrade(lat, lng, meiaKm, n) {
  const dLat = meiaKm / 111.32;
  const dLng = meiaKm / (111.32 * Math.cos(lat * Math.PI / 180));
  const pontos = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      pontos.push({
        lat: Math.round((lat - dLat + (2 * dLat * i) / (n - 1)) * 10000) / 10000,
        lng: Math.round((lng - dLng + (2 * dLng * j) / (n - 1)) * 10000) / 10000,
      });
    }
  }
  return { lat0: lat - dLat, lng0: lng - dLng, dlat: (2 * dLat) / (n - 1), dlng: (2 * dLng) / (n - 1), nLin: n, nCol: n, pontos: pontos };
}

// Grade retangular de uma caixa [sul, oeste, norte, leste] (nLin × nCol, em ordem de linhas).
function montarGradeCaixa(sul, oeste, norte, leste, nLin, nCol) {
  const dlat = (norte - sul) / (nLin - 1), dlng = (leste - oeste) / (nCol - 1);
  const pontos = [];
  for (let i = 0; i < nLin; i++) {
    for (let j = 0; j < nCol; j++) pontos.push({ lat: Math.round((sul + dlat * i) * 10000) / 10000, lng: Math.round((oeste + dlng * j) * 10000) / 10000 });
  }
  return { lat0: sul, lng0: oeste, dlat: dlat, dlng: dlng, nLin: nLin, nCol: nCol, pontos: pontos };
}

// Open-Meteo aceita várias coordenadas numa só chamada; a resposta vem como lista, na mesma ordem.
// (formato de múltiplas localizações conforme a documentação do Open-Meteo; não verificado ao vivo)
async function gradeOpenMeteo(lat, lng, meiaKm) {
  return consultarGradeOpenMeteo(montarGrade(lat, lng, meiaKm, GRADE_N));
}
async function consultarGradeOpenMeteo(g) {
  const chave = (process.env.OPEN_METEO_API_KEY || '').trim();
  const base = chave ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://api.open-meteo.com/v1/forecast';
  // Vírgulas literais, como na documentação do Open-Meteo para várias coordenadas.
  let url = base + '?latitude=' + g.pontos.map((p) => p.lat).join(',') + '&longitude=' + g.pontos.map((p) => p.lng).join(',') +
    '&current=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation';
  if (chave) url += '&apikey=' + encodeURIComponent(chave);
  const j = await getJson(url);
  const lista = Array.isArray(j) ? j : [j];
  if (lista.length !== g.pontos.length) throw new Error('grade incompleta');
  // Precipitação de cada ponto: mostra onde já chove e a que distância da operação.
  return {
    lat0: g.lat0, lng0: g.lng0, dlat: g.dlat, dlng: g.dlng, nLin: g.nLin, nCol: g.nCol,
    pontos: lista.map(function (x, i) {
      const c = x.current || {};
      return { lat: g.pontos[i].lat, lng: g.pontos[i].lng, temperatura: c.temperature_2m, vento: c.wind_speed_10m, direcao: c.wind_direction_10m, precipitacao: c.precipitation };
    }),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ erro: 'metodo_nao_permitido' });

  const url = (process.env.SUPABASE_URL || '').trim();
  const chavePublica = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  if (!url || !chavePublica) return res.status(500).json({ erro: 'variaveis_de_ambiente_ausentes' });

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ erro: 'nao_autenticado' });
  let autorizado;
  try { autorizado = await ehResponsavel(token); } catch (e) { return res.status(502).json({ erro: 'falha_rede' }); }
  if (autorizado === 401) return res.status(401).json({ erro: 'nao_autenticado' });
  if (autorizado !== true) return res.status(403).json({ erro: 'sem_permissao' });

  const tipo = req.query && req.query.tipo;
  // Satélite: igual para todos (não depende da operação)
  if (tipo === 'satelite') {
    const s = await comCache('satelite', TTL.satelite, sateliteGoes);
    return res.status(200).json({ ok: s.ok, obtidoEm: s.obtidoEm, erro: s.erro || null, fonte: 'GOES-East (NOAA) · NASA GIBS', satelite: s.ok ? s.dados : null });
  }
  const area = req.query && req.query.area;
  // Grade do Paraná ou do Brasil: não depende do local da operação (cache único, 30 min)
  if (tipo === 'grade' && AREAS[area]) {
    const om = Boolean((process.env.OPEN_METEO_API_KEY || '').trim());
    const rg = await comCache('regiao:' + area + ':' + (om ? 'om' : 'met'), TTL.regiao, function () { return gradeRegiao(area, om); });
    return res.status(200).json({ atualizadoEm: new Date().toISOString(), fonte: om ? 'Open-Meteo' : 'MET Norway', area: area,
      ok: rg.ok, obtidoEm: rg.obtidoEm, erro: rg.erro || null, grade: rg.ok ? rg.dados : null });
  }

  const lat = Number(req.query && req.query.lat), lng = Number(req.query && req.query.lng);
  const grade = tipo === 'grade';
  if (!isFinite(lat) || !isFinite(lng) || lat < -35 || lat > 6 || lng < -75 || lng > -28) {
    return res.status(400).json({ erro: 'posicao_invalida', mensagem: 'Serviço disponível para operações no Brasil.' });
  }
  // Arredonda para agrupar consultas parecidas no cache (≈ 1 km).
  const latR = Math.round(lat * 100) / 100, lngR = Math.round(lng * 100) / 100;

  // Previsão: Open-Meteo só com chave (plano comercial); sem chave, MET Norway (gratuito).
  const openMeteo = Boolean((process.env.OPEN_METEO_API_KEY || '').trim());
  const nomePrevisao = openMeteo ? 'Open-Meteo' : 'MET Norway';
  // Radar: desligado por padrão (licença só pessoal/educacional); ligue com METEO_RADAR=rainviewer.
  const radarLigado = (process.env.METEO_RADAR || '').trim() === 'rainviewer';

  if (grade) {
    const chaveG = 'grade:' + nomePrevisao + ':' + latR + ',' + lngR;
    const r = await comCache(chaveG, TTL.previsao, function () {
      return openMeteo ? gradeOpenMeteo(latR, lngR, GRADE_MEIA_KM) : gradeMetNorway(latR, lngR, GRADE_MEIA_KM);
    });
    return res.status(200).json({
      atualizadoEm: new Date().toISOString(),
      fonte: nomePrevisao,
      ok: r.ok, obtidoEm: r.obtidoEm, erro: r.erro || null,
      grade: r.ok ? r.dados : null,
    });
  }

  const [radar, previsao, inmet] = await Promise.all([
    radarLigado ? comCache('radar', TTL.radar, radarRainViewer) : Promise.resolve({ ok: false, obtidoEm: null, erro: null, dados: null }),
    comCache('previsao:' + nomePrevisao + ':' + latR + ',' + lngR, TTL.previsao, function () {
      return openMeteo ? previsaoOpenMeteo(latR, lngR) : previsaoMetNorway(latR, lngR);
    }),
    comCache('alertas', TTL.alertas, alertasInmet),
  ]);

  const avisos = [];
  if (radarLigado && radar.ok) avisos.push('Radar RainViewer: uso gratuito restrito a fins pessoais e educacionais. Confirme a licença antes do uso operacional.');
  if (previsao.ok && !openMeteo) avisos.push('Previsão MET Norway: exige atribuição ("MET Norway") e identificação do aplicativo. Confira os termos de uso.');
  if (previsao.ok && openMeteo) avisos.push('Previsão Open-Meteo: plano comercial com chave.');

  return res.status(200).json({
    atualizadoEm: new Date().toISOString(),
    fontes: {
      radar: { nome: 'RainViewer', ok: radar.ok, status: radarLigado ? (radar.ok ? 'ok' : 'erro') : 'desligado', obtidoEm: radar.obtidoEm, erro: radar.erro || (radarLigado ? null : 'Desligado: sem radar gratuito com licença comercial para o Brasil.') },
      previsao: { nome: nomePrevisao, ok: previsao.ok, obtidoEm: previsao.obtidoEm, erro: previsao.erro || null },
      alertas: inmet.ok && inmet.dados && !inmet.dados.configurado
        ? { nome: 'INMET (CAP)', ok: false, status: 'nao_configurado', erro: 'Defina METEO_ALERTAS_URL na Vercel para ver os alertas oficiais.' }
        : { nome: 'INMET (CAP)', ok: inmet.ok, obtidoEm: inmet.obtidoEm, status: inmet.ok ? 'ok' : 'erro', erro: inmet.erro || null },
    },
    radar: radar.ok ? radar.dados : null,
    previsao: previsao.ok ? previsao.dados : null,
    alertas: inmet.ok && inmet.dados ? inmet.dados.lista : [],
    avisos: avisos,
  });
};

module.exports.montarGrade = montarGrade;
module.exports.montarGradeCaixa = montarGradeCaixa;
module.exports.AREAS = AREAS;
