// GET /api/meteo?lat=-25.4&lng=-49.2  → dados meteorológicos da área da operação (só responsáveis).
//
// Fontes (cada uma independente: a falha de uma não derruba as outras):
//   radar     RainViewer  https://api.rainviewer.com/public/weather-maps.json (sem chave).
//             Uso gratuito restrito a fins pessoais e educacionais: confirmar licença antes do uso operacional.
//   previsao  Open-Meteo  sem chave no uso não comercial; OPEN_METEO_API_KEY (opcional) usa o plano comercial.
//   alertas   INMET (CAP) URL em METEO_ALERTAS_URL. Sem a variável, o serviço informa "não configurado".
//
// Segurança: chamada exige o login de um responsável (eh_responsavel, com o token da própria pessoa).
// As chaves ficam só no servidor (variáveis da Vercel). Cache em memória por instância para não repetir consultas.

const TIMEOUT_MS = 8000;
const TTL = { radar: 5 * 60e3, previsao: 15 * 60e3, alertas: 10 * 60e3 };
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
    hourly: 'precipitation,precipitation_probability,weather_code,wind_gusts_10m',
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
        codigo: h.weather_code ? h.weather_code[i] : null, rajada: h.wind_gusts_10m ? h.wind_gusts_10m[i] : null };
    }),
  };
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

// Open-Meteo aceita várias coordenadas numa só chamada; a resposta vem como lista, na mesma ordem.
// (formato de múltiplas localizações conforme a documentação do Open-Meteo; não verificado ao vivo)
async function gradeOpenMeteo(lat, lng, meiaKm) {
  const g = montarGrade(lat, lng, meiaKm, 9);
  const chave = (process.env.OPEN_METEO_API_KEY || '').trim();
  const base = chave ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://api.open-meteo.com/v1/forecast';
  // Vírgulas literais, como na documentação do Open-Meteo para várias coordenadas.
  let url = base + '?latitude=' + g.pontos.map((p) => p.lat).join(',') + '&longitude=' + g.pontos.map((p) => p.lng).join(',') +
    '&current=temperature_2m,wind_speed_10m,wind_direction_10m';
  if (chave) url += '&apikey=' + encodeURIComponent(chave);
  const j = await getJson(url);
  const lista = Array.isArray(j) ? j : [j];
  if (lista.length !== g.pontos.length) throw new Error('grade incompleta');
  return {
    lat0: g.lat0, lng0: g.lng0, dlat: g.dlat, dlng: g.dlng, nLin: g.nLin, nCol: g.nCol,
    pontos: lista.map(function (x, i) {
      const c = x.current || {};
      return { lat: g.pontos[i].lat, lng: g.pontos[i].lng, temperatura: c.temperature_2m, vento: c.wind_speed_10m, direcao: c.wind_direction_10m };
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

  const lat = Number(req.query && req.query.lat), lng = Number(req.query && req.query.lng);
  const grade = req.query && req.query.tipo === 'grade';
  if (!isFinite(lat) || !isFinite(lng) || lat < -35 || lat > 6 || lng < -75 || lng > -28) {
    return res.status(400).json({ erro: 'posicao_invalida', mensagem: 'Serviço disponível para operações no Brasil.' });
  }
  // Arredonda para agrupar consultas parecidas no cache (≈ 1 km).
  const latR = Math.round(lat * 100) / 100, lngR = Math.round(lng * 100) / 100;

  if (grade) {
    const meia = Math.min(40, Math.max(5, Number(req.query.raio) || 15));
    const chaveG = 'grade:' + latR + ',' + lngR + ',' + meia;
    const r = await comCache(chaveG, TTL.previsao, function () { return gradeOpenMeteo(latR, lngR, meia); });
    return res.status(200).json({
      atualizadoEm: new Date().toISOString(),
      fonte: 'Open-Meteo',
      ok: r.ok, obtidoEm: r.obtidoEm, erro: r.erro || null,
      grade: r.ok ? r.dados : null,
    });
  }

  const [radar, previsao, inmet] = await Promise.all([
    comCache('radar', TTL.radar, radarRainViewer),
    comCache('previsao:' + latR + ',' + lngR, TTL.previsao, function () { return previsaoOpenMeteo(latR, lngR); }),
    comCache('alertas', TTL.alertas, alertasInmet),
  ]);

  const avisos = [];
  if (radar.ok) avisos.push('Radar RainViewer: uso gratuito restrito a fins pessoais e educacionais. Confirme a licença antes do uso operacional.');
  if (previsao.ok && (process.env.OPEN_METEO_API_KEY || '').trim() === '') avisos.push('Previsão Open-Meteo: uso gratuito não comercial; confirme a licença para este uso.');

  return res.status(200).json({
    atualizadoEm: new Date().toISOString(),
    fontes: {
      radar: { nome: 'RainViewer', ok: radar.ok, obtidoEm: radar.obtidoEm, erro: radar.erro || null },
      previsao: { nome: 'Open-Meteo', ok: previsao.ok, obtidoEm: previsao.obtidoEm, erro: previsao.erro || null },
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
