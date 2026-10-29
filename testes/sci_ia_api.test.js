// Endpoint /api/sci-ia: login, provedor ausente e validação das ações devolvidas pela IA (rede simulada).
process.env.TZ = 'America/Sao_Paulo';
const path = require('path');
const assert = require('assert');
const ARQ = path.join(__dirname, '..', 'api', 'sci-ia.js');
let falhas = 0;
async function teste(nome, fn) { try { await fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); } }
function carregar() { delete require.cache[ARQ]; return require(ARQ); }
function resposta() { return { code: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }
const json = (obj, status) => ({ ok: (status || 200) < 300, status: status || 200, json: async () => obj, text: async () => JSON.stringify(obj) });
const OP = '11111111-2222-4333-8444-555555555555';
function ambiente(extra) {
  ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'POA_IA_PROVEDOR', 'POA_IA_MODELO'].forEach((k) => delete process.env[k]);
  Object.assign(process.env, { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'pub', ANTHROPIC_API_KEY: 'chave' }, extra || {});
}
const req = (corpo, token) => ({ method: 'POST', body: corpo, headers: token ? { authorization: 'Bearer ' + token } : {} });
function rede(dono, respostaIa, chamadas) {
  global.fetch = async (url, op) => {
    chamadas && chamadas.push({ url, corpo: op && op.body });
    if (url.includes('rpc/dono_operacao')) return json(dono);
    if (url.includes('anthropic.com')) return json({ content: [{ text: JSON.stringify(respostaIa) }] });
    throw new Error('rede inesperada ' + url);
  };
}
(async () => {
  console.log('SCI: endpoint /api/sci-ia');
  await teste('sem login: 401', async () => { ambiente(); const r = resposta(); await carregar()(req({ operacao_id: OP, texto: 'x' }), r); assert.strictEqual(r.code, 401); });
  await teste('sem texto ou operação: 400', async () => { ambiente(); const r = resposta(); await carregar()(req({ operacao_id: 'x', texto: '' }, 't'), r); assert.strictEqual(r.code, 400); });
  await teste('quem não é responsável da operação: 403', async () => { ambiente(); rede(false); const r = resposta(); await carregar()(req({ operacao_id: OP, texto: 'x' }, 't'), r); assert.strictEqual(r.code, 403); });
  await teste('sem chave de IA: 503 com aviso (a leitura do painel continua)', async () => {
    ambiente({ ANTHROPIC_API_KEY: '' }); rede(true); const r = resposta(); await carregar()(req({ operacao_id: OP, texto: 'x' }, 't'), r);
    assert.strictEqual(r.code, 503); assert.ok(/leitura das frases/.test(r.body.mensagem));
  });
  await teste('ações da IA validadas: inválidas descartadas, válidas com texto para a tela', async () => {
    ambiente(); const c = [];
    rede(true, { acoes: [{ acao: 'vitima', numero: 3, fase: 'removida', triagem: 'amarelo' }, { acao: 'apagar_banco' }, { acao: 'orgao', nome: 'SAMU', situacao: 'no_local', pessoas: 5 },
      { acao: 'vitima_nova', triagem: 'roxo', sexo: 'Z' }, { acao: 'marco', marco: 'despacho', em: '2026-10-29T07:15:00-03:00' }], resposta: 'Ok, registrado.', faltando: ['Oficial de Segurança'] }, c);
    const r = resposta(); await carregar()(req({ operacao_id: OP, texto: 'V-03 na ACV amarela; SAMU no local com 5', contexto: { vitimas: [{ numero: 3, fase: 'localizada', nome: 'Fulana' }] } }, 't'), r);
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(r.body.acoes.map((a) => a.acao), ['vitima', 'orgao', 'vitima_nova', 'marco']);
    assert.ok(!('triagem' in r.body.acoes[2]) && !('sexo' in r.body.acoes[2]));
    assert.ok(r.body.acoes.every((a) => a.texto_tela));
    assert.strictEqual(r.body.resposta, 'Ok, registrado.'); assert.deepStrictEqual(r.body.faltando, ['Oficial de Segurança']);
    const enviado = c.find((x) => x.url.includes('anthropic')).corpo;
    assert.ok(!enviado.includes('Fulana'), 'nome da vítima não vai para a IA');
  });
  await teste('resposta que não é JSON: 502', async () => {
    ambiente(); global.fetch = async (url) => url.includes('dono') ? json(true) : json({ content: [{ text: 'não sei' }] });
    const r = resposta(); await carregar()(req({ operacao_id: OP, texto: 'x' }, 't'), r); assert.strictEqual(r.code, 502);
  });
  console.log(falhas ? falhas + ' falha(s)' : 'Todos os testes do assistente do SCI passaram.');
  process.exit(falhas ? 1 : 0);
})();
