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
      'rainviewer.com': () => json({}, 503),
      'open-meteo.com': ok({ current: { time: AGORA_GMT.slice(0, 16), temperature_2m: 21, precipitation: 0, weather_code: 3, wind_speed_10m: 12, wind_gusts_10m: 30 },
        hourly: { time: [AGORA_GMT.slice(0, 16)], precipitation: [0.2], precipitation_probability: [20], weather_code: [3], wind_gusts_10m: [30] } }),
    });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2' }, 't'), r);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.fontes.radar.ok, false);
    assert.strictEqual(r.body.fontes.previsao.ok, true);
    assert.strictEqual(r.body.radar, null);
    assert.ok(r.body.previsao.atual.temperatura === 21);
    assert.strictEqual(r.body.fontes.alertas.status, 'nao_configurado');
  });
  await teste('radar: quadros com horário e caminho para os tiles', async () => {
    ambiente({ METEO_ALERTAS_URL: '' });
    global.fetch = fetchFalso({
      'rpc/eh_responsavel': ok(true),
      'rainviewer.com/public': ok({ host: 'https://tilecache.rainviewer.com', generated: 1700000000, radar: { past: [{ time: 1700000000 - 600, path: '/v2/radar/a' }, { time: 1700000000, path: '/v2/radar/b' }] } }),
      'open-meteo.com': () => json({}, 500),
    });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2' }, 't'), r);
    assert.strictEqual(r.body.radar.host, 'https://tilecache.rainviewer.com');
    assert.strictEqual(r.body.radar.quadros.length, 2);
    assert.strictEqual(r.body.radar.quadros[1].path, '/v2/radar/b');
    assert.ok(!Number.isNaN(Date.parse(r.body.radar.quadros[1].t)));
    assert.strictEqual(r.body.fontes.previsao.ok, false);
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
  await teste('avisos de licença aparecem junto com os dados', async () => {
    ambiente({ METEO_ALERTAS_URL: '' });
    global.fetch = fetchFalso({ 'rpc/eh_responsavel': ok(true), 'rainviewer.com/public': ok({ host: 'https://h', radar: { past: [{ time: 1, path: '/p' }] } }), 'open-meteo.com': () => json({}, 503) });
    const r = resposta(); await carregar()(req({ lat: '-25.4', lng: '-49.2' }, 't'), r);
    assert.ok(r.body.avisos.some((t) => /RainViewer/.test(t) && /licença/i.test(t)));
  });

  if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
  console.log('\nTodos os testes do endpoint de meteorologia passaram.');
})();
