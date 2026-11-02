// Endpoint /api/convidar-responsavel: convite de responsável por e-mail, com login e senha provisória.
// A rede é substituída por respostas falsas, só para testar o código (nenhum e-mail é enviado, nenhuma conta é criada).
const path = require('path');
const assert = require('assert');
const ARQ = path.join(__dirname, '..', 'api', 'convidar-responsavel.js');
let falhas = 0;
async function teste(nome, fn) {
  try { await fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
function carregar() { delete require.cache[ARQ]; return require(ARQ); }
function resposta() {
  return { code: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const json = (obj, status) => ({ ok: (status || 200) < 300, status: status || 200, json: async () => obj, text: async () => JSON.stringify(obj) });
const OP = '11111111-2222-4333-8444-555555555555';
const QUEM = 'aaaaaaaa-0000-4000-8000-000000000001';
const NOVO = 'bbbbbbbb-0000-4000-8000-000000000002';
const EXISTENTE = 'cccccccc-0000-4000-8000-000000000003';
const CONVITE = { id: 'dddddddd-0000-4000-8000-000000000004' };
const CHECAR = { operacao_id: OP, codigo: 'OP 2026-014', convidado_por: 'Sgt Fontana', quem: QUEM };
function ambiente(extra) {
  ['RESEND_API_KEY', 'EMAIL_REMETENTE', 'SITE_URL'].forEach((k) => delete process.env[k]);
  Object.assign(process.env, { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'pub', SUPABASE_SECRET_KEY: 'sb_secret_x',
    RESEND_API_KEY: 're_teste', EMAIL_REMETENTE: 'Rastreamento <convite@exemplo.com>' }, extra || {});
}
const req = (corpo, token) => ({ method: 'POST', body: corpo, headers: Object.assign({ host: 'app.exemplo.com' }, token ? { authorization: 'Bearer ' + token } : {}) });
const CORPO = { operacao_id: OP, nome: 'Carla Lima', email: 'Carla.Lima@Exemplo.com' };
// rotas: respostas de cada chamada. Registra todas as chamadas em `c`.
function rede(r, c) {
  global.fetch = async (url, op) => {
    const corpo = op && op.body ? JSON.parse(op.body) : null;
    c.push({ url, corpo, metodo: op && op.method, headers: op && op.headers });
    if (url.includes('responsavel_convite_checar')) return (r.checar || (() => json(CHECAR)))();
    if (url.includes('servidor_situacao_email')) return (r.situacao || (() => json(null)))();
    if (url.includes('criar_convite')) return (r.convite || (() => json(CONVITE)))();
    if (url.includes('servidor_vincular_responsavel')) return (r.vincular || (() => json(true)))();
    if (url.includes('servidor_salvar_responsavel')) return (r.salvar || (() => json(null)))();
    if (url.includes('servidor_desvincular_responsavel')) return json(null);
    if (url.includes('convite_registrar_envio')) return json(null);
    if (url.includes('/auth/v1/admin/users') && op && op.method === 'POST') return (r.criarConta || (() => json({ id: NOVO })))();
    if (url.includes('/auth/v1/admin/users/') && op && op.method === 'DELETE') return json({});
    if (url.includes('api.resend.com')) return (r.email || (() => json({ id: 'm1' })))();
    throw new Error('rede inesperada: ' + url);
  };
}
const chamadas = (c, parte) => c.filter((x) => x.url.includes(parte));

(async () => {
  console.log('Convite de responsável com acesso: /api/convidar-responsavel');

  await teste('só aceita POST', async () => {
    ambiente(); const r = resposta(); await carregar()({ method: 'GET', headers: {} }, r);
    assert.strictEqual(r.code, 405);
  });
  await teste('sem login: 401', async () => {
    ambiente(); const r = resposta(); await carregar()(req(CORPO), r);
    assert.strictEqual(r.code, 401);
  });
  await teste('e-mail inválido ou nome curto: 400, sem chamar o banco', async () => {
    ambiente(); const c = []; rede({}, c);
    const r = resposta(); await carregar()(req(Object.assign({}, CORPO, { email: 'sem-arroba' }), 't'), r);
    assert.strictEqual(r.code, 400); assert.strictEqual(r.body.erro, 'email_invalido');
    const r2 = resposta(); await carregar()(req(Object.assign({}, CORPO, { nome: 'x' }), 't'), r2);
    assert.strictEqual(r2.body.erro, 'nome_invalido');
    assert.strictEqual(c.length, 0);
  });
  await teste('sem provedor de e-mail: 501 antes de criar qualquer coisa', async () => {
    ambiente({ RESEND_API_KEY: '' }); const c = []; rede({}, c);
    const r = resposta(); await carregar()(req(CORPO, 't'), r);
    assert.strictEqual(r.code, 501); assert.strictEqual(r.body.erro, 'email_nao_configurado');
    assert.strictEqual(c.length, 0);
  });
  await teste('quem não é responsável da operação: 403, nada criado nem enviado', async () => {
    ambiente(); const c = []; rede({ checar: () => json({ message: 'sem_permissao' }, 400) }, c);
    const r = resposta(); await carregar()(req(CORPO, 't'), r);
    assert.strictEqual(r.code, 403);
    assert.strictEqual(chamadas(c, '/auth/v1/admin/users').length, 0);
    assert.strictEqual(chamadas(c, 'resend').length, 0);
  });
  await teste('operação encerrada: 409', async () => {
    ambiente(); const c = []; rede({ checar: () => json({ message: 'operacao_encerrada' }, 400) }, c);
    const r = resposta(); await carregar()(req(CORPO, 't'), r);
    assert.strictEqual(r.code, 409); assert.strictEqual(r.body.erro, 'operacao_encerrada');
  });
  await teste('e-mail de conta que não é de responsável: 409 "email_em_uso", sem criar nada', async () => {
    ambiente(); const c = []; rede({ situacao: () => json({ user_id: EXISTENTE, responsavel: false, ativo: false }) }, c);
    const r = resposta(); await carregar()(req(CORPO, 't'), r);
    assert.strictEqual(r.code, 409); assert.strictEqual(r.body.erro, 'email_em_uso');
    assert.strictEqual(chamadas(c, 'criar_convite').length, 0);
    assert.strictEqual(chamadas(c, '/auth/v1/admin/users').length, 0);
  });
  await teste('responsável desativado: 409 "conta_desativada"', async () => {
    ambiente(); const c = []; rede({ situacao: () => json({ user_id: EXISTENTE, responsavel: true, ativo: false }) }, c);
    const r = resposta(); await carregar()(req(CORPO, 't'), r);
    assert.strictEqual(r.body.erro, 'conta_desativada');
  });

  await teste('e-mail novo: cria o login com o próprio e-mail, cadastra como responsável comum e inclui na operação', async () => {
    ambiente(); const c = []; rede({}, c);
    const r = resposta(); await carregar()(req(CORPO, 't'), r);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.conta_criada, true);
    const criar = chamadas(c, '/auth/v1/admin/users').find((x) => x.metodo === 'POST').corpo;
    assert.strictEqual(criar.email, 'carla.lima@exemplo.com');
    assert.strictEqual(criar.email_confirm, true);
    assert.strictEqual(criar.user_metadata.senha_provisoria, true);
    assert.ok(criar.password.length >= 12, 'senha provisória com tamanho razoável');
    const salvar = chamadas(c, 'servidor_salvar_responsavel')[0].corpo;
    assert.strictEqual(salvar.p_admin, false, 'nunca cria administrador por convite');
    assert.strictEqual(salvar.p_user, NOVO);
    const vincular = chamadas(c, 'servidor_vincular_responsavel')[0].corpo;
    assert.deepStrictEqual(vincular, { p_operacao: OP, p_user: NOVO, p_por: QUEM });
  });
  await teste('o convite é registrado com a categoria responsável, por e-mail, com o login de quem convida', async () => {
    ambiente(); const c = []; rede({}, c);
    await carregar()(req(CORPO, 'token-de-quem-convida'), resposta());
    const cc = chamadas(c, 'criar_convite')[0];
    assert.strictEqual(cc.corpo.p_operacao, OP);
    assert.deepStrictEqual(cc.corpo.p_dados, { nome: 'Carla Lima', email: 'carla.lima@exemplo.com', tipo: 'responsavel', canal: 'email' });
    assert.strictEqual(cc.headers.Authorization, 'Bearer token-de-quem-convida', 'o convite é criado com o login de quem convida, não com a chave do servidor');
  });
  await teste('o e-mail leva o login (o e-mail) e a senha provisória, e a senha não aparece na resposta', async () => {
    ambiente(); const c = []; rede({}, c);
    const r = resposta(); await carregar()(req(CORPO, 't'), r);
    const senha = chamadas(c, '/auth/v1/admin/users').find((x) => x.metodo === 'POST').corpo.password;
    const envio = chamadas(c, 'resend')[0].corpo;
    assert.deepStrictEqual(envio.to, ['carla.lima@exemplo.com']);
    assert.ok(envio.text.includes('Login (seu e-mail): carla.lima@exemplo.com'));
    assert.ok(envio.text.includes('Senha provisória: ' + senha), 'a senha provisória vai no e-mail');
    assert.ok(envio.html.includes(senha));
    assert.ok(!JSON.stringify(r.body).includes(senha), 'a senha não volta ao navegador');
    assert.ok(envio.text.includes('https://app.exemplo.com/militar.html'), 'link do painel montado no servidor');
  });
  await teste('e-mail de responsável que já tem login: só inclui na operação e envia o link (sem senha)', async () => {
    ambiente(); const c = []; rede({ situacao: () => json({ user_id: EXISTENTE, responsavel: true, ativo: true }) }, c);
    const r = resposta(); await carregar()(req(CORPO, 't'), r);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.conta_criada, false);
    assert.strictEqual(chamadas(c, '/auth/v1/admin/users').length, 0, 'não cria login nem troca senha');
    assert.strictEqual(chamadas(c, 'servidor_vincular_responsavel')[0].corpo.p_user, EXISTENTE);
    const envio = chamadas(c, 'resend')[0].corpo;
    assert.ok(!/Senha provisória/.test(envio.text), 'o e-mail não traz senha');
  });
  await teste('falha ao enviar o e-mail: desfaz a conta criada, registra o motivo no convite e responde 502', async () => {
    ambiente(); const c = []; rede({ email: () => json({ message: 'domínio não verificado' }, 422) }, c);
    const r = resposta(); await carregar()(req(CORPO, 't'), r);
    assert.strictEqual(r.code, 502); assert.strictEqual(r.body.erro, 'falha_envio');
    const apaga = chamadas(c, '/auth/v1/admin/users/' + NOVO);
    assert.ok(apaga.some((x) => x.metodo === 'DELETE'), 'a conta criada é apagada, para não sobrar senha que ninguém recebeu');
    const reg = chamadas(c, 'convite_registrar_envio').pop().corpo;
    assert.ok(reg.p_erro && /provedor 422/.test(reg.p_erro), 'o motivo fica no convite');
  });
  await teste('falha ao enviar para quem já tinha login: desfaz só a inclusão, não apaga a conta', async () => {
    ambiente(); const c = []; rede({ situacao: () => json({ user_id: EXISTENTE, responsavel: true, ativo: true }), email: () => json({ message: 'x' }, 500) }, c);
    const r = resposta(); await carregar()(req(CORPO, 't'), r);
    assert.strictEqual(r.code, 502);
    assert.strictEqual(chamadas(c, '/auth/v1/admin/users/' + EXISTENTE).length, 0, 'a conta existente não é tocada');
    const desv = chamadas(c, 'servidor_desvincular_responsavel')[0].corpo;
    assert.deepStrictEqual(desv, { p_operacao: OP, p_user: EXISTENTE });
  });
  await teste('quem já estava na operação não é removido se o e-mail falhar', async () => {
    ambiente(); const c = []; rede({ situacao: () => json({ user_id: EXISTENTE, responsavel: true, ativo: true }), vincular: () => json(false), email: () => json({}, 500) }, c);
    await carregar()(req(CORPO, 't'), resposta());
    assert.strictEqual(chamadas(c, 'servidor_desvincular_responsavel').length, 0, 'não desfaz inclusão que não foi feita agora');
  });
  await teste('falha ao cadastrar o responsável: desfaz a conta criada e não envia e-mail', async () => {
    ambiente(); const c = []; rede({ salvar: () => json({ message: 'nome_invalido' }, 400) }, c);
    const r = resposta(); await carregar()(req(CORPO, 't'), r);
    assert.strictEqual(r.code, 502);
    assert.ok(chamadas(c, '/auth/v1/admin/users/' + NOVO).some((x) => x.metodo === 'DELETE'));
    assert.strictEqual(chamadas(c, 'resend').length, 0);
  });

  console.log(falhas ? '\nFalhas: ' + falhas : '\nConvite de responsável (API): todos OK');
  process.exit(falhas ? 1 : 0);
})();
