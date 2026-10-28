// Endpoint /api/poa-ia: autorização, limpeza do contexto, validação da resposta da IA e falhas.
// A rede é substituída por respostas falsas: nenhuma chamada real à IA é feita.
const path = require('path');
const assert = require('assert');
const ARQ = path.join(__dirname, '..', 'api', 'poa-ia.js');
let falhas = 0;
async function teste(nome, fn) {
  try { await fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
function carregar() { delete require.cache[ARQ]; return require(ARQ); }
function resposta() {
  return { code: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const json = (obj, status) => ({ ok: (status || 200) < 300, status: status || 200, json: async () => obj, text: async () => JSON.stringify(obj) });
const OP = '11111111-1111-4111-8111-111111111111';
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'pub', ANTHROPIC_API_KEY: 'chave-secreta-de-teste' };
function ambiente(extra) { delete process.env.POA_IA_MODELO; delete process.env.POA_IA_PROVEDOR; delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY; Object.assign(process.env, ENV, extra || {}); }
const req = (corpo, token) => ({ method: 'POST', body: corpo, headers: token === null ? {} : { authorization: 'Bearer ' + (token || 'tok-' + Math.random()) } });
const SETORES = [{ id: 's1', nome: 'Norte', area_km2: 0.4 }, { id: 's2', nome: 'Sul', area_km2: 0.3 }];
const CTX = { operacao: { tipo: 'terrestre', descricao: 'Idoso saiu para caminhar' }, vitima: { idade: 78, sexo: 'M', perfil: ['idoso'], nome: 'Seu Antônio', cpf: '52998224725', telefone: '21998765432', caracteristicas: 'usa bengala' },
  ultimo_local: { titulo: 'Casa do filho', lat: -25.4, lng: -49.2 }, setores: SETORES };
const ia = (texto, status) => () => json({ content: [{ type: 'text', text: texto }] }, status);
function rede(rotas, chamadas) {
  return async (url, init) => {
    if (chamadas) chamadas.push({ url, init });
    for (const [trecho, fn] of Object.entries(rotas)) if (url.includes(trecho)) return fn(url, init);
    throw new Error('rede indisponível (teste): ' + url);
  };
}
const AUTORIZADO = { 'rpc/dono_operacao': () => json(true) };
async function chamar(corpo, rotas, token) {
  global.fetch = rede(Object.assign({}, AUTORIZADO, rotas || {}));
  const r = resposta(); await carregar()(req(corpo, token), r); return r;
}

(async () => {
  console.log('IA do POA/POD: endpoint /api/poa-ia');
  await teste('só POST', async () => { ambiente(); const r = resposta(); await carregar()({ method: 'GET', headers: {} }, r); assert.strictEqual(r.code, 405); });
  await teste('sem login: 401', async () => { ambiente(); global.fetch = rede(AUTORIZADO); const r = resposta(); await carregar()(req({ modo: 'poa', operacao_id: OP }, null), r); assert.strictEqual(r.code, 401); });
  await teste('modo ou operação inválidos: 400', async () => {
    ambiente(); assert.strictEqual((await chamar({ modo: 'x', operacao_id: OP })).code, 400); assert.strictEqual((await chamar({ modo: 'poa', operacao_id: 'abc' })).code, 400);
  });
  await teste('quem não é responsável da operação: 403 (e a IA nem é chamada)', async () => {
    ambiente(); const ch = []; global.fetch = rede({ 'rpc/dono_operacao': () => json(false), 'anthropic': ia('{}') }, ch);
    const r = resposta(); await carregar()(req({ modo: 'poa', operacao_id: OP, contexto: CTX }), r);
    assert.strictEqual(r.code, 403); assert.ok(!ch.some((c) => c.url.includes('anthropic')));
  });
  await teste('token recusado pelo banco: 401', async () => { ambiente(); const r = await chamar({ modo: 'poa', operacao_id: OP, contexto: CTX }, { 'rpc/dono_operacao': () => json({}, 401) }); assert.strictEqual(r.code, 401); });
  await teste('sem chave da IA: 503 com a mensagem de que o manual continua', async () => {
    ambiente({ ANTHROPIC_API_KEY: '' }); const r = await chamar({ modo: 'poa', operacao_id: OP, contexto: CTX });
    assert.strictEqual(r.code, 503); assert.strictEqual(r.body.erro, 'ia_nao_configurada'); assert.ok(/manual/.test(r.body.mensagem) && /ANTHROPIC_API_KEY/.test(r.body.mensagem));
  });
  await teste('sem setores: 400', async () => { ambiente(); const r = await chamar({ modo: 'poa', operacao_id: OP, contexto: { operacao: {}, vitima: {}, setores: [] } }); assert.strictEqual(r.code, 400); });

  console.log('Sugestão de POA');
  await teste('sugestão válida: setores, "fora" e "informação insuficiente" sem percentual inventado', async () => {
    ambiente(); const ch = [];
    global.fetch = rede(Object.assign({}, AUTORIZADO, { 'api.anthropic.com': ia('Aqui está: {"setores":[{"setor_id":"s1","poa":0.55,"justificativa":"Mais perto da última localização.","insuficiente":false},{"setor_id":"s2","poa":null,"justificativa":"","insuficiente":true}],"fora":{"poa":0.2,"justificativa":"Pode ter saído da área.","insuficiente":false}}') }), ch);
    const r = resposta(); await carregar()(req({ modo: 'poa', operacao_id: OP, contexto: CTX }), r);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.setores[0].poa, 0.55); assert.strictEqual(r.body.setores[0].insuficiente, false);
    assert.strictEqual(r.body.setores[1].poa, null); assert.strictEqual(r.body.setores[1].insuficiente, true); assert.strictEqual(r.body.setores[1].justificativa, 'informação insuficiente');
    assert.strictEqual(r.body.fora.poa, 0.2); assert.strictEqual(r.body.modelo, 'claude-haiku-5-5');
    assert.ok(!JSON.stringify(r.body).includes('chave-secreta'), 'a chave não pode aparecer na resposta');
    const c = ch.find((x) => x.url.includes('anthropic'));
    assert.strictEqual(c.init.headers['x-api-key'], 'chave-secreta-de-teste');
  });
  await teste('nome, CPF e telefone da vítima não vão para a IA', async () => {
    ambiente(); const ch = []; global.fetch = rede(Object.assign({}, AUTORIZADO, { 'api.anthropic.com': ia('{}') }), ch);
    await carregar()(req({ modo: 'poa', operacao_id: OP, contexto: CTX }), resposta());
    const enviado = ch.find((x) => x.url.includes('anthropic')).init.body;
    assert.ok(!/Antônio|52998224725|21998765432/.test(enviado), 'dados pessoais vazaram'); assert.ok(/usa bengala/.test(enviado) && /Casa do filho/.test(enviado));
  });
  await teste('textos longos são truncados antes de ir para a IA', async () => {
    ambiente(); const ch = []; global.fetch = rede(Object.assign({}, AUTORIZADO, { 'api.anthropic.com': ia('{}') }), ch);
    await carregar()(req({ modo: 'poa', operacao_id: OP, contexto: Object.assign({}, CTX, { operacao: { descricao: 'x'.repeat(9000) } }) }), resposta());
    const enviado = JSON.parse(ch.find((x) => x.url.includes('anthropic')).init.body).messages[0].content;
    assert.ok(enviado.length < 4000, 'contexto grande demais: ' + enviado.length);
  });
  await teste('setor inventado pela IA é ignorado; setor que ela esqueceu volta como insuficiente', async () => {
    ambiente(); const r = await chamar({ modo: 'poa', operacao_id: OP, contexto: CTX }, { 'api.anthropic.com': ia('{"setores":[{"setor_id":"x9","poa":0.9,"justificativa":"?"},{"setor_id":"s1","poa":0.4,"justificativa":"ok"}],"fora":{"poa":null,"insuficiente":true}}') });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.setores.length, 2);
    assert.ok(!r.body.setores.some((s) => s.setor_id === 'x9')); assert.strictEqual(r.body.setores.find((s) => s.setor_id === 's2').insuficiente, true); assert.strictEqual(r.body.fora.poa, null);
  });
  await teste('soma acima de 100%: reduzida e avisada (a IA não publica nada)', async () => {
    ambiente(); const r = await chamar({ modo: 'poa', operacao_id: OP, contexto: CTX }, { 'api.anthropic.com': ia('{"setores":[{"setor_id":"s1","poa":0.8,"justificativa":"a"},{"setor_id":"s2","poa":0.6,"justificativa":"b"}],"fora":{"poa":0.1,"justificativa":"c"}}') });
    const soma = r.body.setores.reduce((a, s) => a + s.poa, 0) + r.body.fora.poa;
    assert.ok(soma <= 1.0001 && /reduzida/.test(r.body.aviso), 'soma ' + soma);
  });
  await teste('valor fora de 0–1 ou resposta que não é JSON: 502', async () => {
    ambiente();
    assert.strictEqual((await chamar({ modo: 'poa', operacao_id: OP, contexto: CTX }, { 'api.anthropic.com': ia('{"setores":[{"setor_id":"s1","poa":1.5}],"fora":{"poa":0}}') })).body.erro, 'ia_resposta_invalida');
    assert.strictEqual((await chamar({ modo: 'poa', operacao_id: OP, contexto: CTX }, { 'api.anthropic.com': ia('não sei dizer') })).body.erro, 'ia_resposta_invalida');
  });
  await teste('falhas da IA: indisponível, cota, chave inválida e tempo esgotado', async () => {
    ambiente();
    let r = await chamar({ modo: 'poa', operacao_id: OP, contexto: CTX }, { 'api.anthropic.com': () => json({}, 500) }); assert.strictEqual(r.code, 502); assert.strictEqual(r.body.erro, 'ia_indisponivel');
    r = await chamar({ modo: 'poa', operacao_id: OP, contexto: CTX }, { 'api.anthropic.com': () => json({}, 429) }); assert.strictEqual(r.code, 503); assert.strictEqual(r.body.erro, 'ia_cota');
    r = await chamar({ modo: 'poa', operacao_id: OP, contexto: CTX }, { 'api.anthropic.com': () => json({}, 401) }); assert.strictEqual(r.code, 503); assert.strictEqual(r.body.erro, 'ia_nao_configurada');
    r = await chamar({ modo: 'poa', operacao_id: OP, contexto: CTX }, { 'api.anthropic.com': () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } }); assert.strictEqual(r.code, 502); assert.ok(/demorou/.test(r.body.mensagem));
    assert.ok(/Preencha manualmente/.test(r.body.mensagem));
  });
  await teste('o modelo pode ser trocado por variável de ambiente', async () => {
    ambiente({ POA_IA_MODELO: 'outro-modelo' }); const ch = []; global.fetch = rede(Object.assign({}, AUTORIZADO, { 'api.anthropic.com': ia('{"setores":[],"fora":{"poa":null}}') }), ch);
    const r = resposta(); await carregar()(req({ modo: 'poa', operacao_id: OP, contexto: CTX }), r);
    assert.strictEqual(JSON.parse(ch.find((x) => x.url.includes('anthropic')).init.body).model, 'outro-modelo'); assert.strictEqual(r.body.modelo, 'outro-modelo');
  });

  console.log('Sugestão de POD');
  const CTX_POD = { setor: { nome: 'Norte', area_km2: 0.4 }, metodo: 'A pé, em linha', equipe: 'Alfa', area_fracao: 1, operacao: { tipo: 'terrestre' } };
  await teste('POD sugerido com justificativa', async () => {
    ambiente(); const r = await chamar({ modo: 'pod', operacao_id: OP, contexto: CTX_POD }, { 'api.anthropic.com': ia('{"pod":0.6,"justificativa":"Varredura em linha em área pequena.","insuficiente":false}') });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.pod, 0.6); assert.strictEqual(r.body.insuficiente, false); assert.ok(r.body.justificativa);
  });
  await teste('POD sem dados: "informação insuficiente", nulo (nunca zero)', async () => {
    ambiente(); const r = await chamar({ modo: 'pod', operacao_id: OP, contexto: CTX_POD }, { 'api.anthropic.com': ia('{"pod":null,"justificativa":"x","insuficiente":true}') });
    assert.strictEqual(r.body.pod, null); assert.strictEqual(r.body.insuficiente, true); assert.strictEqual(r.body.justificativa, 'informação insuficiente');
  });
  await teste('POD inválido: 502; sem método: 400', async () => {
    ambiente();
    assert.strictEqual((await chamar({ modo: 'pod', operacao_id: OP, contexto: CTX_POD }, { 'api.anthropic.com': ia('{"pod":7}') })).code, 502);
    assert.strictEqual((await chamar({ modo: 'pod', operacao_id: OP, contexto: { setor: { nome: 'Norte' } } })).code, 400);
  });

  console.log('Gemini');
  const gem = (texto, status) => () => json({ candidates: [{ content: { parts: [{ text: texto }] } }] }, status);
  await teste('só GEMINI_API_KEY: usa o Gemini (chave no cabeçalho, JSON pedido, modelo padrão)', async () => {
    ambiente({ ANTHROPIC_API_KEY: '', GEMINI_API_KEY: 'chave-gemini-teste' }); const ch = [];
    global.fetch = rede(Object.assign({}, AUTORIZADO, { 'generativelanguage.googleapis.com': gem('{"setores":[{"setor_id":"s1","poa":0.6,"justificativa":"Perto da casa."},{"setor_id":"s2","poa":null,"insuficiente":true}],"fora":{"poa":0.1,"justificativa":"Pode ter saído."}}') }), ch);
    const r = resposta(); await carregar()(req({ modo: 'poa', operacao_id: OP, contexto: CTX }), r);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.setores[0].poa, 0.6); assert.strictEqual(r.body.setores[1].poa, null); assert.strictEqual(r.body.modelo, 'gemini-2.5-flash');
    const c = ch.find((x) => x.url.includes('generativelanguage'));
    assert.ok(c.url.includes('/models/gemini-2.5-flash:generateContent')); assert.strictEqual(c.init.headers['x-goog-api-key'], 'chave-gemini-teste');
    assert.ok(!c.url.includes('chave-gemini-teste'), 'a chave não vai na URL'); assert.strictEqual(JSON.parse(c.init.body).generationConfig.responseMimeType, 'application/json');
    assert.ok(!/Antônio|52998224725|21998765432/.test(c.init.body), 'dados pessoais vazaram'); assert.ok(!ch.some((x) => x.url.includes('anthropic')));
    assert.ok(!JSON.stringify(r.body).includes('chave-gemini-teste'));
  });
  await teste('POA_IA_PROVEDOR escolhe entre as duas chaves; POA_IA_MODELO troca o modelo', async () => {
    ambiente({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', POA_IA_PROVEDOR: 'gemini', POA_IA_MODELO: 'gemini-x' }); const ch = [];
    global.fetch = rede(Object.assign({}, AUTORIZADO, { 'generativelanguage.googleapis.com': gem('{"pod":0.5,"justificativa":"ok"}') }), ch);
    const r = resposta(); await carregar()(req({ modo: 'pod', operacao_id: OP, contexto: { setor: { nome: 'Norte' }, metodo: 'Drone' } }), r);
    assert.strictEqual(r.body.pod, 0.5); assert.strictEqual(r.body.modelo, 'gemini-x'); assert.ok(ch.some((x) => x.url.includes('models/gemini-x:')));
  });
  await teste('provedor escolhido sem a chave dele: 503 "não configurada" (não usa a outra)', async () => {
    ambiente({ ANTHROPIC_API_KEY: 'a', POA_IA_PROVEDOR: 'gemini' }); const r = await chamar({ modo: 'poa', operacao_id: OP, contexto: CTX }); assert.strictEqual(r.code, 503); assert.strictEqual(r.body.erro, 'ia_nao_configurada'); assert.ok(/GEMINI_API_KEY/.test(r.body.mensagem));
  });
  await teste('falhas do Gemini: cota (429), chave inválida (400 "API key not valid"), erro 500 e resposta sem JSON', async () => {
    ambiente({ ANTHROPIC_API_KEY: '', GEMINI_API_KEY: 'g' });
    const g = (fn) => chamar({ modo: 'poa', operacao_id: OP, contexto: CTX }, { 'generativelanguage.googleapis.com': fn });
    let r = await g(() => json({ error: { message: 'quota' } }, 429)); assert.strictEqual(r.body.erro, 'ia_cota');
    r = await g(() => json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }, 400)); assert.strictEqual(r.code, 503); assert.strictEqual(r.body.erro, 'ia_nao_configurada');
    r = await g(() => json({}, 500)); assert.strictEqual(r.body.erro, 'ia_indisponivel');
    r = await g(gem('não sei')); assert.strictEqual(r.body.erro, 'ia_resposta_invalida');
    r = await g(() => json({ candidates: [] })); assert.strictEqual(r.body.erro, 'ia_resposta_invalida');
  });

  console.log('Limite de uso');
  await teste('7º pedido no mesmo minuto: 429', async () => {
    ambiente(); global.fetch = rede(Object.assign({}, AUTORIZADO, { 'api.anthropic.com': ia('{"pod":0.5,"justificativa":"ok"}') }));
    const fn = carregar(); let ultimo;
    for (let i = 0; i < 7; i++) { ultimo = resposta(); await fn(req({ modo: 'pod', operacao_id: OP, contexto: CTX_POD }, 'mesmo-token-de-teste'), ultimo); }
    assert.strictEqual(ultimo.code, 429);
  });

  console.log(falhas ? '\nFALHARAM ' + falhas + ' teste(s)' : '\nTodos os testes do endpoint de IA passaram.');
  process.exit(falhas ? 1 : 0);
})();
