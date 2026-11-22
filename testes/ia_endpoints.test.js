// Cliente do Gemini com novas tentativas (api/_gemini.js), /api/parse-operacao e /api/assistente.
// A rede é substituída por respostas falsas: nenhuma chamada real à IA é feita.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
let falhas = 0;
async function teste(nome, fn) {
  try { await fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
const API = (n) => path.join(__dirname, '..', 'api', n);
function carregar(n) { Object.keys(require.cache).forEach((k) => { if (k.includes(path.sep + 'api' + path.sep)) delete require.cache[k]; }); return require(API(n)); }
function resposta() { return { code: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }
const json = (obj, status) => ({ ok: (status || 200) < 300, status: status || 200, json: async () => obj, text: async () => JSON.stringify(obj) });
const gem = (texto, extra) => () => json({ candidates: [{ finishReason: 'STOP', content: { parts: [Object.assign({ text: texto }, extra || {})] } }] });
function rede(rotas, chamadas) {
  return async (url, init) => {
    if (chamadas) chamadas.push({ url, init });
    for (const [trecho, fn] of Object.entries(rotas)) if (url.includes(trecho)) return fn(url, init);
    throw new Error('rede indisponível (teste): ' + url);
  };
}
const LOGADO = { 'auth/v1/user': () => json({ id: 'u-' + Math.random() }) };
function ambiente(extra) {
  ['IA_MODELOS_RESERVA', 'IA_MODELO', 'POA_IA_MODELO', 'GOOGLE_API_KEY'].forEach((k) => delete process.env[k]);
  Object.assign(process.env, { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'pub', GEMINI_API_KEY: 'segredo-gemini-teste', IA_ESPERA_MS: '0', POA_IA_ESPERA_MS: '0' }, extra || {});
}
const req = (corpo, token) => ({ method: 'POST', body: corpo, headers: token === null ? {} : { authorization: 'Bearer ' + (token || 'tok-' + Math.random()) } });
async function chamar(arq, corpo, rotas, chamadas) {
  global.fetch = rede(Object.assign({}, LOGADO, rotas || {}), chamadas);
  const r = resposta(); await carregar(arq)(req(corpo), r); return r;
}
function silenciar(fn) { const w = console.warn, log = []; console.warn = (m) => log.push(String(m)); return Promise.resolve().then(fn).finally(() => { console.warn = w; }).then((v) => ({ v, log })); }

(async () => {
  console.log('Cliente do Gemini (api/_gemini.js)');
  await teste('espera exponencial 800, 1600, 3200 ms entre as tentativas, depois o reserva', async () => {
    ambiente({ IA_ESPERA_MS: '800' });
    const G = carregar('_gemini.js');
    const esperas = [], st = global.setTimeout;
    global.setTimeout = (fn, ms) => { if (ms >= 800) esperas.push(ms); return st(fn, 0); };
    const modelos = [];
    try {
      const { v } = await silenciar(() => G.comNovasTentativas(async (m) => { modelos.push(m); return { ok: false, status: 503, motivo: 'high demand' }; }, ['principal', 'reserva']));
      assert.strictEqual(v.esgotou, true); assert.strictEqual(v.status, 503);
    } finally { global.setTimeout = st; }
    assert.deepStrictEqual(esperas, [800, 1600, 3200, 800, 1600, 3200]);
    assert.deepStrictEqual(modelos, ['principal', 'principal', 'principal', 'principal', 'reserva', 'reserva', 'reserva', 'reserva']);
  });
  await teste('loga status, modelo e tentativa de cada falha (sem a chave)', async () => {
    ambiente();
    const G = carregar('_gemini.js');
    const { log } = await silenciar(() => G.comNovasTentativas(async () => ({ ok: false, status: 429, motivo: 'quota' }), ['m1'], { rotulo: 'teste' }));
    assert.strictEqual(log.filter((l) => /status=429 modelo=m1 tentativa=\d/.test(l)).length, 4, log.join('\n'));
    assert.ok(log.every((l) => !/segredo-gemini-teste/.test(l)));
  });
  await teste('outro erro (ex.: 400) não repete e volta com a mensagem real', async () => {
    ambiente();
    const G = carregar('_gemini.js'); let n = 0;
    const { v } = await silenciar(() => G.comNovasTentativas(async () => { n++; return { ok: false, status: 400, motivo: 'Invalid argument' }; }, ['m1', 'm2']));
    assert.strictEqual(n, 1); assert.strictEqual(v.esgotou, false); assert.strictEqual(v.motivo, 'Invalid argument');
  });
  await teste('prazo total: não espera além do limite (cabe nos 60 s da Vercel)', async () => {
    ambiente({ IA_ESPERA_MS: '5000', IA_PRAZO_MS: '6000' });
    const G = carregar('_gemini.js'); let n = 0;
    const st = global.setTimeout; global.setTimeout = (fn) => st(fn, 0);
    try {
      const { v } = await silenciar(() => G.comNovasTentativas(async () => { n++; return { ok: false, status: 503 }; }, ['m1', 'm2']));
      assert.strictEqual(v.esgotou, true); assert.ok(n <= 2, 'tentativas: ' + n);
    } finally { global.setTimeout = st; delete process.env.IA_PRAZO_MS; }
  });
  await teste('modelos: principal + reservas configuráveis num lugar só', async () => {
    ambiente();
    let G = carregar('_gemini.js');
    assert.deepStrictEqual(G.modelosGemini(), ['gemini-3.8-flash', 'gemini-2.5-flash']);
    ambiente({ IA_MODELO: 'x', IA_MODELOS_RESERVA: 'y, z,x' }); G = carregar('_gemini.js');
    assert.deepStrictEqual(G.modelosGemini(), ['x', 'y', 'z']);
  });

  console.log('Preencher nova operação por voz (/api/parse-operacao)');
  const NAT = ['BUSCA TERRESTRE – PESSOA', 'BUSCA AQUÁTICA – PESSOA'];
  await teste('sem login: 401; token recusado: 401 (a IA nem é chamada)', async () => {
    ambiente();
    global.fetch = rede({}); let r = resposta(); await carregar('parse-operacao.js')(req({ texto: 'oi' }, null), r); assert.strictEqual(r.code, 401);
    const ch = [];
    r = await chamar('parse-operacao.js', { texto: 'oi' }, { 'auth/v1/user': () => json({}, 401), generativelanguage: gem('{}') }, ch);
    assert.strictEqual(r.code, 401); assert.ok(!ch.some((c) => /generativelanguage/.test(c.url)));
  });
  await teste('pede JSON estruturado (responseMimeType + responseSchema) com a lista de naturezas da tela', async () => {
    ambiente(); const ch = [];
    const r = await chamar('parse-operacao.js', { texto: 'Busca terrestre na Fazenda União em Guaraci, acionado por Maria. Desapareceu João, 34 anos, de camisa azul.', naturezas: NAT },
      { generativelanguage: gem(JSON.stringify({ codigo: null, endereco: 'Fazenda União, Guaraci', natureza: 'BUSCA TERRESTRE – PESSOA', solicitante_nome: 'Maria', descricao: 'Desapareceu João, 34 anos.', vitimas: [{ nome: 'João', idade: 34, sexo: 'M', roupas: 'camisa azul' }] })) }, ch);
    assert.strictEqual(r.code, 200);
    const pedido = JSON.parse(ch.find((c) => /generativelanguage/.test(c.url)).init.body);
    assert.strictEqual(pedido.generationConfig.responseMimeType, 'application/json');
    assert.deepStrictEqual(pedido.generationConfig.responseSchema.properties.natureza.enum, NAT);
    assert.strictEqual(ch.find((c) => /generativelanguage/.test(c.url)).init.headers['x-goog-api-key'], 'segredo-gemini-teste');
    assert.strictEqual(r.body.campos.endereco, 'Fazenda União, Guaraci'); assert.strictEqual(r.body.campos.natureza, 'BUSCA TERRESTRE – PESSOA');
    assert.deepStrictEqual(r.body.campos.vitimas[0], { nome: 'João', idade: 34, sexo: 'M', origem: null, caracteristicas: null, roupas: 'camisa azul', observacoes: null });
    assert.deepStrictEqual(r.body.faltando, ['codigo']);
    assert.ok(!JSON.stringify(r.body).includes('segredo-gemini-teste'));
  });
  await teste('natureza fora da lista vira "outro"; idade e sexo inválidos são descartados; campo inventado é ignorado', async () => {
    ambiente();
    const r = await chamar('parse-operacao.js', { texto: 'vendaval com árvores caídas', naturezas: NAT },
      { generativelanguage: gem(JSON.stringify({ natureza: 'CORTE DE ÁRVORES', vitimas: [{ nome: 'X', idade: 300, sexo: 'masculino' }], cpf: '123', prioridade: 'alta' })) });
    assert.strictEqual(r.body.campos.natureza, null); assert.strictEqual(r.body.campos.natureza_outra, 'CORTE DE ÁRVORES');
    assert.strictEqual(r.body.campos.vitimas[0].idade, null); assert.strictEqual(r.body.campos.vitimas[0].sexo, null);
    assert.ok(!('cpf' in r.body.campos) && !('prioridade' in r.body.campos));
  });
  await teste('resposta incompleta ou que não é JSON: 200 com campos vazios (não trava)', async () => {
    ambiente();
    const r = await chamar('parse-operacao.js', { texto: 'algo' }, { generativelanguage: gem('não entendi') });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.incompleto, true); assert.strictEqual(r.body.campos.endereco, null); assert.deepStrictEqual(r.body.campos.vitimas, []);
  });
  await teste('sobrecarga que não passa: 503 com tentar_de_novo; sem chave: 503 "não configurada"; texto vazio: 400', async () => {
    ambiente();
    let { v: r } = await silenciar(() => chamar('parse-operacao.js', { texto: 'algo' }, { generativelanguage: () => json({ error: { message: 'high demand' } }, 503) }));
    assert.strictEqual(r.code, 503); assert.strictEqual(r.body.tentar_de_novo, true); assert.strictEqual(r.body.erro, 'ia_sobrecarregada');
    ambiente({ GEMINI_API_KEY: '' }); r = await chamar('parse-operacao.js', { texto: 'algo' }); assert.strictEqual(r.code, 503); assert.strictEqual(r.body.erro, 'ia_nao_configurada');
    ambiente(); r = await chamar('parse-operacao.js', { texto: '   ' }); assert.strictEqual(r.code, 400);
  });

  console.log('Base do assistente (/api/assistente)');
  await teste('responde com base no estado; CPF e telefone não vão para a IA; sem ferramentas no pedido', async () => {
    ambiente(); const ch = [];
    const r = await chamar('assistente.js', { pergunta: 'Quantos estão em campo?', estado: { operacoes: [{ id: 'o1', codigo: 'OP 1', status: 'ativa' }], participantes: [{ nome: 'Ana', estado: 'em campo', cpf: '52998224725', telefone: '41999999999' }], status: { em_campo: 1 } } },
      { generativelanguage: gem('1 pessoa em campo: Ana.') }, ch);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.resposta, '1 pessoa em campo: Ana.'); assert.deepStrictEqual(r.body.acoes_propostas, []);
    const pedido = ch.find((c) => /generativelanguage/.test(c.url)).init.body;
    assert.ok(!/52998224725|41999999999/.test(pedido)); assert.ok(!('tools' in JSON.parse(pedido)));
  });
  await teste('function calling: ação proposta pela IA volta com requer_confirmacao e NÃO é executada; função desconhecida é ignorada', async () => {
    ambiente();
    const A = carregar('assistente.js');
    let executou = false;
    A._interno.FERRAMENTAS.push({ declaracao: { name: 'propor_mensagem', description: 'Propõe uma mensagem', parameters: { type: 'OBJECT', properties: { texto: { type: 'STRING' } } } },
      descricao: (a) => 'Enviar mensagem: ' + a.texto, executar: () => { executou = true; } });
    global.fetch = rede(Object.assign({}, LOGADO, { generativelanguage: () => json({ candidates: [{ content: { parts: [{ functionCall: { name: 'propor_mensagem', args: { texto: 'Voltem à base' } } }, { functionCall: { name: 'apagar_tudo', args: {} } }] } }] }) }));
    const r = resposta(); await A(req({ pergunta: 'Mande todos voltarem' }), r);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.acoes_propostas.length, 1);
    assert.deepStrictEqual(r.body.acoes_propostas[0], { nome: 'propor_mensagem', argumentos: { texto: 'Voltem à base' }, descricao: 'Enviar mensagem: Voltem à base', requer_confirmacao: true });
    assert.strictEqual(executou, false);
  });
  await teste('assistente usa o mesmo retry (503 → reserva) e exige login e pergunta', async () => {
    ambiente(); const modelos = [];
    const { v: r } = await silenciar(() => chamar('assistente.js', { pergunta: 'oi' }, { generativelanguage: (url) => { modelos.push(url.split('/models/')[1].split(':')[0]); return /gemini-2\.5/.test(url) ? gem('olá')() : json({}, 503); } }));
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.modelo, 'gemini-2.5-flash'); assert.strictEqual(modelos.length, 5);
    global.fetch = rede({}); const r2 = resposta(); await carregar('assistente.js')(req({ pergunta: 'oi' }, null), r2); assert.strictEqual(r2.code, 401);
    const r3 = await chamar('assistente.js', { pergunta: '' }); assert.strictEqual(r3.code, 400);
  });

  console.log('Chave fora do front');
  await teste('nenhum arquivo de public/ chama o Gemini direto nem cita a chave', async () => {
    const pasta = path.join(__dirname, '..', 'public');
    const arquivos = [];
    (function andar(d) { fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory()) andar(p); else if (/\.(js|html)$/.test(e.name)) arquivos.push(p); }); })(pasta);
    const ruins = arquivos.filter((p) => /generativelanguage\.googleapis|x-goog-api-key|GEMINI_API_KEY|AIza[0-9A-Za-z_-]{20,}/.test(fs.readFileSync(p, 'utf8')));
    assert.deepStrictEqual(ruins, []);
  });

  console.log(falhas ? '\nFALHARAM ' + falhas + ' teste(s)' : '\nTodos os testes da IA (cliente, voz e assistente) passaram.');
  process.exit(falhas ? 1 : 0);
})();
