// Endpoint /api/meteo: autorização, validação e tolerância a falhas de fonte.
// A rede é substituída por respostas no formato documentado, só para testar o código.
// Estes dados NÃO são meteorologia real e não são usados pelo aplicativo.
const path = require('path');
const assert = require('assert');
const ARQ = path.join(__dirname, '..', 'api', 'meteo.js');
let falhas = 0;
async function teste(nome, fn) {
  try { await fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
function carregar() { delete require.cache[ARQ]; return require(ARQ); }
function resposta() {
  return { code: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
function fetchFalso(rotas) {
  return async (url) => {
    for (const [trecho, fn] of Object.entries(rotas)) {
      if (url.includes(trecho)) return fn(url);
    }
    throw new Error('rede indisponível (teste): ' + url);
  };
}
const json = (obj, status) => ({ ok: (status || 200) < 300, status: status || 200, json: async () => obj });
const ok = (obj) => () => json(obj);
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'pub' };
function ambiente(extra) { Object.assign(process.env, ENV, extra || {}); }
const req = (query, token) => ({ method: 'GET', query: query, headers: token ? { authorization: 'Bearer ' + token } : {} });
const RESP_OK = { 'rpc/eh_responsavel': ok(true) };
const AGORA_GMT = new Date().toISOString().slice(0, 13) + ':00';
// Resposta no formato do MET Norway (Locationforecast 2.0, compact): vento em m/s, direção de onde vem
function metResp(temp, ventoMs, dir, precip, sim) {
  const bloco = { time: new Date().toISOString(), data: {
    instant: { details: { air_temperature: temp, wind_speed: ventoMs, wind_from_direction: dir } },
    next_1_hours: { summary: { symbol_code: sim || 'clearsky_day' }, details: { precipitation_amount: precip } } } };
  return { properties: { timeseries: Array.from({ length: 13 }, () => bloco) } };
}
const MET = (fn) => (url) => json(fn(url));

(async () => {
  console.log('Meteorologia: endpoint /api/meteo');
  await teste('sem login: 401', async () => {
    ambiente({}); global.fetch = fetchFalso(RESP_OK);
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2' }), r);
    assert.strictEqual(r.code, 401);
  });
  await teste('login de quem não é responsável: 403', async () => {
    ambiente({}); global.fetch = fetchFalso({ 'rpc/eh_responsavel': ok(false) });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2' }, 't'), r);
    assert.strictEqual(r.code, 403);
  });
  await teste('token recusado pelo banco: 401', async () => {
    ambiente({}); global.fetch = fetchFalso({ 'rpc/eh_responsavel': () => json({}, 401) });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2' }, 't'), r);
    assert.strictEqual(r.code, 401);
  });
  await teste('posição fora do Brasil: 400 (o serviço não é usado para outros países)', async () => {
    ambiente({}); global.fetch = fetchFalso(RESP_OK);
    const r = resposta(); await carregar()(req({ lat: '48.8', lng: '2.3' }, 't'), r);
    assert.strictEqual(r.code, 400);
  });
  await teste('falha de uma fonte não derruba as outras', async () => {
    ambiente({ METEO_ALERTAS_URL: '' });
    global.fetch = fetchFalso({
      'rpc/eh_responsavel': ok(true),
      'api.met.no/weatherapi/locationforecast': MET(() => metResp(21, 3.3, 90, 0.2, 'lightrain_day')),
    });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2' }, 't'), r);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.fontes.radar.ok, false);
    assert.strictEqual(r.body.fontes.radar.status, 'desligado');
    assert.strictEqual(r.body.fontes.previsao.ok, true);
    assert.strictEqual(r.body.fontes.previsao.nome, 'MET Norway');
    assert.strictEqual(r.body.radar, null);
    assert.strictEqual(r.body.previsao.atual.temperatura, 21);
    assert.strictEqual(r.body.fontes.alertas.status, 'nao_configurado');
  });
  await teste('radar desligado por padrão: não consulta o RainViewer', async () => {
    ambiente({ METEO_ALERTAS_URL: '' }); delete process.env.METEO_RADAR;
    let chamouRainViewer = false;
    global.fetch = fetchFalso({ 'rpc/eh_responsavel': ok(true), 'api.met.no/weatherapi/locationforecast': MET(() => metResp(20, 1, 0, 0)),
      'rainviewer.com': () => { chamouRainViewer = true; return json({}, 503); } });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2' }, 't'), r);
    assert.strictEqual(chamouRainViewer, false);
    assert.strictEqual(r.body.radar, null);
  });
  await teste('radar: quadros com horário e caminho para os tiles (quando ligado)', async () => {
    ambiente({ METEO_ALERTAS_URL: '', METEO_RADAR: 'rainviewer' });
    global.fetch = fetchFalso({
      'rpc/eh_responsavel': ok(true),
      'rainviewer.com/public': ok({ host: 'https://tilecache.rainviewer.com', generated: 1700000000, radar: { past: [{ time: 1700000000 - 600, path: '/v2/radar/a' }, { time: 1700000000, path: '/v2/radar/b' }] } }),
      'api.met.no/weatherapi/locationforecast': () => json({}, 500),
    });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2' }, 't'), r);
    assert.strictEqual(r.body.radar.host, 'https://tilecache.rainviewer.com');
    assert.strictEqual(r.body.radar.quadros.length, 2);
    assert.strictEqual(r.body.radar.quadros[1].path, '/v2/radar/b');
    assert.ok(!Number.isNaN(Date.parse(r.body.radar.quadros[1].t)));
    assert.strictEqual(r.body.fontes.previsao.ok, false);
    delete process.env.METEO_RADAR;
  });
  await teste('alertas oficiais: só os do Paraná, com severidade e validade', async () => {
    ambiente({ METEO_ALERTAS_URL: 'https://alertas.exemplo.test/cap.json' });
    global.fetch = fetchFalso({
      'rpc/eh_responsavel': ok(true),
      'alertas.exemplo.test': ok([
        { identifier: 'A1', event: 'Tempestades', severity: 'Severe', onset: '2026-10-15T20:00:00Z', expires: '2026-10-16T02:00:00Z', areaDesc: 'Paraná - Curitiba', description: 'x' },
        { identifier: 'A2', event: 'Vendaval', severity: 'Moderate', areaDesc: 'Santa Catarina' },
      ]),
      'rainviewer.com': () => json({}, 503), 'open-meteo.com': () => json({}, 503),
    });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2' }, 't'), r);
    assert.strictEqual(r.body.alertas.length, 1);
    assert.strictEqual(r.body.alertas[0].id, 'A1');
    assert.strictEqual(r.body.alertas[0].severidade, 'Severe');
    assert.strictEqual(r.body.fontes.alertas.ok, true);
  });
  await teste('alerta em formato desconhecido: fonte marcada como erro, sem derrubar o restante', async () => {
    ambiente({ METEO_ALERTAS_URL: 'https://alertas.exemplo.test/xml' });
    global.fetch = fetchFalso({
      'rpc/eh_responsavel': ok(true),
      'alertas.exemplo.test': () => ({ ok: true, status: 200, json: async () => { throw new Error('não é JSON'); } }),
      'rainviewer.com': () => json({}, 503), 'open-meteo.com': () => json({}, 503),
    });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2' }, 't'), r);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.fontes.alertas.status, 'erro');
    assert.deepStrictEqual(r.body.alertas, []);
  });
  await teste('avisos de licença aparecem junto com os dados (radar ligado e MET Norway)', async () => {
    ambiente({ METEO_ALERTAS_URL: '', METEO_RADAR: 'rainviewer' }); delete process.env.OPEN_METEO_API_KEY;
    global.fetch = fetchFalso({ 'rpc/eh_responsavel': ok(true), 'rainviewer.com/public': ok({ host: 'https://h', radar: { past: [{ time: 1, path: '/p' }] } }),
      'api.met.no/weatherapi/locationforecast': MET(() => metResp(20, 1, 0, 0)) });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2' }, 't'), r);
    assert.ok(r.body.avisos.some((t) => /RainViewer/.test(t) && /licença/i.test(t)));
    assert.ok(r.body.avisos.some((t) => /MET Norway/.test(t) && /atribuição/i.test(t)));
    delete process.env.METEO_RADAR;
  });
  await teste('MET Norway: vento convertido de m/s para km/h, direção e chuva da hora', async () => {
    ambiente({ METEO_ALERTAS_URL: '' }); delete process.env.OPEN_METEO_API_KEY;
    global.fetch = fetchFalso({ 'rpc/eh_responsavel': ok(true), 'api.met.no/weatherapi/locationforecast': MET(() => metResp(18.5, 5, 225, 1.4, 'rain_night')) });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2' }, 't'), r);
    assert.strictEqual(r.body.previsao.atual.vento, 18);
    assert.strictEqual(r.body.previsao.atual.direcao, 225);
    assert.strictEqual(r.body.previsao.atual.precipitacao, 1.4);
    assert.strictEqual(r.body.previsao.atual.codigo, 61);
    assert.strictEqual(r.body.previsao.atual.rajada, null);
    assert.strictEqual(r.body.previsao.horas.length, 12);
    assert.strictEqual(r.body.previsao.horas[0].vento, 18);   // vento por hora (km/h), para o alerta Beaufort
  });
  await teste('identifica o aplicativo na consulta à MET Norway (User-Agent)', async () => {
    ambiente({ METEO_ALERTAS_URL: '' }); delete process.env.OPEN_METEO_API_KEY; process.env.METEO_USER_AGENT = 'GBS-Teste/9.9 (contato@exemplo.test)';
    let cabecalho = null;
    global.fetch = async (url, opcoes) => {
      if (url.includes('rpc/eh_responsavel')) return ok(true)();
      if (url.includes('api.met.no')) { cabecalho = opcoes.headers['user-agent']; return json(metResp(20, 1, 0, 0)); }
      throw new Error('rede indisponível (teste): ' + url);
    };
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2' }, 't'), r);
    assert.strictEqual(cabecalho, 'GBS-Teste/9.9 (contato@exemplo.test)');
    delete process.env.METEO_USER_AGENT;
  });
  await teste('com chave do Open-Meteo, usa o plano comercial no lugar do MET Norway', async () => {
    ambiente({ METEO_ALERTAS_URL: '', OPEN_METEO_API_KEY: 'chave-teste' });
    let usouCustomer = false;
    global.fetch = fetchFalso({ 'rpc/eh_responsavel': ok(true),
      'customer-api.open-meteo.com': () => { usouCustomer = true; return json({ current: { time: AGORA_GMT.slice(0, 16), temperature_2m: 21, precipitation: 0, weather_code: 3, wind_speed_10m: 12 }, hourly: { time: [] } }); },
      'api.met.no': () => { throw new Error('não deveria chamar o MET Norway'); } });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2' }, 't'), r);
    assert.ok(usouCustomer);
    assert.strictEqual(r.body.fontes.previsao.nome, 'Open-Meteo');
    delete process.env.OPEN_METEO_API_KEY;
  });

  await teste('grade: n × n em ordem de linhas, cobrindo 2 × meia-largura ao redor do centro', async () => {
    const g = carregar().montarGrade(-25.4, -49.2, 15, 9);
    assert.strictEqual(g.pontos.length, 81);
    assert.ok(Math.abs(g.pontos[0].lat - g.lat0) < 1e-4 && Math.abs(g.pontos[0].lng - g.lng0) < 1e-4);
    assert.ok(Math.abs(g.pontos[80].lat - (g.lat0 + 8 * g.dlat)) < 1e-3);
    const km = (g.pontos[8].lng - g.pontos[0].lng) * 111.32 * Math.cos(-25.4 * Math.PI / 180);
    assert.ok(Math.abs(km - 30) < 0.5, 'largura ' + km);
  });
  await teste('endpoint de grade (MET Norway): 7 × 7 pontos com vento em km/h, sem chave no retorno', async () => {
    ambiente({}); delete process.env.OPEN_METEO_API_KEY;
    let consultas = 0;
    global.fetch = fetchFalso({
      'rpc/eh_responsavel': ok(true),
      'api.met.no/weatherapi/locationforecast': () => { consultas++; return json(metResp(15, 2, 270, 0)); },
    });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2', tipo: 'grade' }, 't'), r);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.fonte, 'MET Norway');
    assert.strictEqual(r.body.grade.pontos.length, 49);
    assert.strictEqual(consultas, 49);
    assert.strictEqual(r.body.grade.pontos[0].vento, 7.2);
    assert.strictEqual(r.body.grade.pontos[0].direcao, 270);
    assert.strictEqual(r.body.grade.nLin, 7);
    assert.ok(!JSON.stringify(r.body).includes('apikey'));
  });
  await teste('grade com um ponto sem resposta da fonte: falha sem inventar pontos', async () => {
    ambiente({}); delete process.env.OPEN_METEO_API_KEY;
    let n = 0;
    global.fetch = fetchFalso({ 'rpc/eh_responsavel': ok(true),
      'api.met.no/weatherapi/locationforecast': () => { n++; return n === 5 ? json({}, 503) : json(metResp(1, 1, 0, 0)); } });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2', tipo: 'grade' }, 't'), r);
    assert.strictEqual(r.body.ok, false);
    assert.strictEqual(r.body.grade, null);
  });
  await teste('grade com Open-Meteo (chave): usa o endpoint comercial', async () => {
    ambiente({ OPEN_METEO_API_KEY: 'chave-teste' });
    let usou = false;
    global.fetch = fetchFalso({ 'rpc/eh_responsavel': ok(true),
      'customer-api.open-meteo.com': (url) => {
        usou = true;
        const n = url.split('latitude=')[1].split('&')[0].split(',').length;
        return json(Array.from({ length: n }, (_, i) => ({ current: { temperature_2m: i, wind_speed_10m: 8, wind_direction_10m: 270 } })));
      } });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2', tipo: 'grade' }, 't'), r);
    assert.ok(usou);
    assert.strictEqual(r.body.fonte, 'Open-Meteo');
    assert.strictEqual(r.body.grade.pontos.length, 169);
    delete process.env.OPEN_METEO_API_KEY;
  });
  await teste('grade do Paraná: o estado inteiro (9 × 11), igual para todas as operações (sem lat/lng)', async () => {
    ambiente({}); delete process.env.OPEN_METEO_API_KEY;
    let consultas = 0;
    global.fetch = fetchFalso({ 'rpc/eh_responsavel': ok(true),
      'api.met.no/weatherapi/locationforecast': () => { consultas++; return json(metResp(18, 3, 90, 1.5)); } });
    const r = resposta(); await carregar()(req({ tipo: 'grade', area: 'parana' }, 't'), r);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.area, 'parana');
    const g = r.body.grade;
    assert.strictEqual(g.pontos.length, 99); assert.strictEqual(consultas, 99);
    assert.strictEqual(g.nLin, 9); assert.strictEqual(g.nCol, 11);
    assert.ok(g.lat0 <= -26.7 && g.lat0 + g.dlat * 8 >= -22.5 && g.lng0 <= -54.6 && g.lng0 + g.dlng * 10 >= -48, 'cobre o Paraná');
  });
  await teste('grade do Brasil: o país inteiro; alguns pontos sem resposta ficam vazios (não derrubam o mapa)', async () => {
    ambiente({}); delete process.env.OPEN_METEO_API_KEY;
    let n = 0;
    global.fetch = fetchFalso({ 'rpc/eh_responsavel': ok(true),
      'api.met.no/weatherapi/locationforecast': () => { n++; return n % 20 === 0 ? json({}, 503) : json(metResp(25, 2, 0, 0)); } });
    const r = resposta(); await carregar()(req({ tipo: 'grade', area: 'brasil' }, 't'), r);
    assert.strictEqual(r.body.ok, true);
    const g = r.body.grade;
    assert.strictEqual(g.pontos.length, 100);
    assert.strictEqual(g.pontos.filter((p) => p.temperatura === null).length, 5);
    assert.ok(g.lat0 <= -33 && g.lat0 + g.dlat * (g.nLin - 1) >= 5 && g.lng0 <= -73 && g.lng0 + g.dlng * (g.nCol - 1) >= -35, 'cobre o Brasil');
  });
  await teste('satélite: acha a imagem mais recente publicada e devolve 12 horários de 10 em 10 min', async () => {
    ambiente({});
    const pedidos = [];
    global.fetch = fetchFalso({ 'rpc/eh_responsavel': ok(true),
      'gibs.earthdata.nasa.gov': (url) => { pedidos.push(url); return { ok: pedidos.length >= 3, status: pedidos.length >= 3 ? 200 : 404 }; } });
    const r = resposta(); await carregar()(req({ tipo: 'satelite' }, 't'), r);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.ok, true);
    const s = r.body.satelite;
    assert.strictEqual(s.quadros.length, 12);
    assert.ok(/GOES-East_ABI_Band13_Clean_Infrared/.test(s.url) && /\{t\}/.test(s.url) && /\{z\}\/\{y\}\/\{x\}/.test(s.url));
    const ult = Date.parse(s.quadros[11]);
    assert.ok(Date.now() - ult >= 30 * 60e3 && Date.now() - ult < 41 * 60e3, 'o 3º horário testado (o 1º publicado)');
    assert.strictEqual(Date.parse(s.quadros[11]) - Date.parse(s.quadros[10]), 600e3);
    assert.ok(pedidos[2].includes(s.quadros[11]));
  });
  await teste('satélite fora do ar: informa o erro sem derrubar', async () => {
    ambiente({});
    global.fetch = fetchFalso({ 'rpc/eh_responsavel': ok(true), 'gibs.earthdata.nasa.gov': () => ({ ok: false, status: 503 }) });
    const r = resposta(); await carregar()(req({ tipo: 'satelite' }, 't'), r);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.ok, false);
    assert.strictEqual(r.body.satelite, null);
    assert.ok(r.body.erro);
  });
  await teste('satélite e grade regional também exigem login de responsável', async () => {
    ambiente({}); global.fetch = fetchFalso({ 'rpc/eh_responsavel': ok(false) });
    const r = resposta(); await carregar()(req({ tipo: 'satelite' }, 't'), r);
    assert.strictEqual(r.code, 403);
    const r2 = resposta(); await carregar()(req({ tipo: 'grade', area: 'brasil' }), r2);
    assert.strictEqual(r2.code, 401);
  });

  if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
  console.log('\nTodos os testes do endpoint de meteorologia passaram.');
})();
