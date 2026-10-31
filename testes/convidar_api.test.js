// Endpoint /api/convidar: autorização, link montado no servidor e tolerância a falhas do provedor de e-mail.
// A rede é substituída por respostas falsas, só para testar o código (nenhum e-mail é enviado).
const path = require('path');
const assert = require('assert');
const ARQ = path.join(__dirname, '..', 'api', 'convidar.js');
let falhas = 0;
async function teste(nome, fn) {
  try { await fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
function carregar() { delete require.cache[ARQ]; return require(ARQ); }
function resposta() {
  return { code: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const json = (obj, status) => ({ ok: (status || 200) < 300, status: status || 200, json: async () => obj });
const UUID = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'a'.repeat(64), CODIGO = 'b'.repeat(24);
const DADOS = { id: UUID, nome: 'Ana <b>Souza</b>', email: 'ana@exemplo.com', codigo: CODIGO, operacao: 'Busca "Rio"', token_civil: TOKEN, envios: 0, responsavel: 'Sgt Fontana' };
function ambiente(extra) {
  ['RESEND_API_KEY', 'EMAIL_REMETENTE', 'SITE_URL'].forEach((k) => delete process.env[k]);
  Object.assign(process.env, { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'pub',
    RESEND_API_KEY: 're_teste', EMAIL_REMETENTE: 'Rastreamento <convite@exemplo.com>' }, extra || {});
}
const req = (corpo, token) => ({ method: 'POST', body: corpo, headers: Object.assign({ host: 'app.exemplo.com' }, token ? { authorization: 'Bearer ' + token } : {}) });
// rotas: { dados: resposta da convite_dados_envio, email: resposta do provedor }
function rede(rotas, chamadas) {
  global.fetch = async (url, op) => {
    chamadas.push({ url, corpo: op && op.body ? JSON.parse(op.body) : null, headers: op && op.headers });
    if (url.includes('convite_dados_envio')) return rotas.dados();
    if (url.includes('convite_registrar_envio')) return json({});
    if (url.includes('api.resend.com')) return rotas.email();
    throw new Error('rede inesperada: ' + url);
  };
}

(async () => {
  console.log('Convite por e-mail: endpoint /api/convidar');
  await teste('só aceita POST', async () => {
    ambiente(); const r = resposta(); await carregar()({ method: 'GET', headers: {} }, r);
    assert.strictEqual(r.code, 405);
  });
  await teste('sem login: 401', async () => {
    ambiente(); const r = resposta(); await carregar()(req({ convite: UUID }), r);
    assert.strictEqual(r.code, 401);
  });
  await teste('convite que não é um identificador: 400', async () => {
    ambiente(); const r = resposta(); await carregar()(req({ convite: 'x' }, 't'), r);
    assert.strictEqual(r.code, 400);
  });
  await teste('quem não é responsável da operação: 403 (e nada é enviado)', async () => {
    ambiente(); const c = []; rede({ dados: () => json({ message: 'sem_permissao' }, 400), email: () => { throw new Error('não podia enviar'); } }, c);
    const r = resposta(); await carregar()(req({ convite: UUID }, 't'), r);
    assert.strictEqual(r.code, 403); assert.ok(!c.some((x) => x.url.includes('resend')));
  });
  await teste('mais de 5 envios: 429', async () => {
    ambiente(); const c = []; rede({ dados: () => json({ message: 'convite_envios_limite' }, 400) }, c);
    const r = resposta(); await carregar()(req({ convite: UUID }, 't'), r);
    assert.strictEqual(r.code, 429);
  });
  await teste('sem provedor configurado: 501 "email_nao_configurado"', async () => {
    ambiente({ RESEND_API_KEY: '' }); const c = []; rede({ dados: () => json(DADOS) }, c);
    const r = resposta(); await carregar()(req({ convite: UUID }, 't'), r);
    assert.strictEqual(r.code, 501); assert.strictEqual(r.body.erro, 'email_nao_configurado');
  });
  await teste('envia: link montado no servidor com o token da operação e o código do convite; e-mail vem do banco', async () => {
    ambiente(); const c = []; rede({ dados: () => json(DADOS), email: () => json({ id: 'x' }) }, c);
    const r = resposta(); await carregar()(req({ convite: UUID, email: 'outro@mal.com', link: 'https://mal.com' }, 'meulogin'), r);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.ok, true);
    const envio = c.find((x) => x.url.includes('resend')).corpo;
    assert.deepStrictEqual(envio.to, ['ana@exemplo.com']);
    assert.ok(envio.text.includes('https://app.exemplo.com/civil.html#t=' + TOKEN + '&c=' + CODIGO), envio.text);
    assert.ok(!envio.html.includes('mal.com') && !envio.text.includes('mal.com'));
    assert.strictEqual(envio.from, 'Rastreamento <convite@exemplo.com>');
    const dados = c.find((x) => x.url.includes('convite_dados_envio'));
    assert.strictEqual(dados.headers.Authorization, 'Bearer meulogin');
    const reg = c.find((x) => x.url.includes('convite_registrar_envio')).corpo;
    assert.strictEqual(reg.p_erro, null);
  });
  await teste('bombeiro: link dos bombeiros (token militar) com o código do convite', async () => {
    ambiente(); const c = []; rede({ dados: () => json(Object.assign({}, DADOS, { tipo: 'militar', token_militar: 'c'.repeat(64) })), email: () => json({}) }, c);
    const r = resposta(); await carregar()(req({ convite: UUID }, 't'), r);
    assert.strictEqual(r.code, 200);
    assert.ok(c.find((x) => x.url.includes('resend')).corpo.text.includes('/civil.html#t=' + 'c'.repeat(64) + '&c=' + CODIGO));
  });
  await teste('responsável: link do painel da operação (pede login)', async () => {
    ambiente(); const c = []; rede({ dados: () => json(Object.assign({}, DADOS, { tipo: 'responsavel', operacao_id: UUID })), email: () => json({}) }, c);
    const r = resposta(); await carregar()(req({ convite: UUID }, 't'), r);
    const e = c.find((x) => x.url.includes('resend')).corpo;
    assert.strictEqual(r.code, 200); assert.ok(e.text.includes('/militar.html#op=' + UUID) && /responsável/.test(e.subject + e.text), e.text);
    assert.ok(!e.text.includes('civil.html'));
  });
  await teste('nome e operação com HTML são escapados na mensagem', async () => {
    ambiente(); const c = []; rede({ dados: () => json(DADOS), email: () => json({}) }, c);
    const r = resposta(); await carregar()(req({ convite: UUID }, 't'), r);
    const html = c.find((x) => x.url.includes('resend')).corpo.html;
    assert.ok(html.includes('Ana &lt;b&gt;Souza&lt;/b&gt;') && !html.includes('<b>Souza'), html);
  });
  await teste('SITE_URL fixo vale mais que o endereço da requisição', async () => {
    ambiente({ SITE_URL: 'https://busca.bombeiros.exemplo/' }); const c = []; rede({ dados: () => json(DADOS), email: () => json({}) }, c);
    const r = resposta(); await carregar()(req({ convite: UUID }, 't'), r);
    assert.ok(c.find((x) => x.url.includes('resend')).corpo.text.includes('https://busca.bombeiros.exemplo/civil.html#t='));
  });
  await teste('provedor recusa: 502, e o motivo é gravado no convite', async () => {
    ambiente(); const c = []; rede({ dados: () => json(DADOS), email: () => json({ message: 'domínio não verificado' }, 403) }, c);
    const r = resposta(); await carregar()(req({ convite: UUID }, 't'), r);
    assert.strictEqual(r.code, 502); assert.strictEqual(r.body.erro, 'falha_envio');
    const reg = c.find((x) => x.url.includes('convite_registrar_envio')).corpo;
    assert.ok(/provedor 403/.test(reg.p_erro), reg.p_erro);
  });
  await teste('provedor fora do ar: 502 sem derrubar a função', async () => {
    ambiente(); const c = []; rede({ dados: () => json(DADOS), email: () => { throw new Error('rede'); } }, c);
    const r = resposta(); await carregar()(req({ convite: UUID }, 't'), r);
    assert.strictEqual(r.code, 502); assert.strictEqual(r.body.erro, 'falha_envio');
  });
  console.log(falhas ? falhas + ' falha(s)' : 'Todos os testes do convite por e-mail passaram.');
  process.exit(falhas ? 1 : 0);
})();
