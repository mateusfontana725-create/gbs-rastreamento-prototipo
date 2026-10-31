// POST /api/convidar-responsavel  →  convida um RESPONSÁVEL por e-mail e dá a ele o acesso ao painel da operação.
//
// Corpo JSON: { "operacao_id": "<uuid>", "nome": "...", "email": "..." }   (sem WhatsApp: o e-mail é obrigatório)
//
// O que acontece:
//   - e-mail sem login: cria o login (o próprio e-mail) com uma senha provisória gerada aqui, cadastra como responsável
//     comum (sem administrador) e inclui na operação. O e-mail leva o login e a senha provisória; no primeiro acesso o
//     painel pede uma senha nova (user_metadata.senha_provisoria).
//   - e-mail de um responsável ativo: só inclui na operação. O e-mail leva o link (sem senha).
//   - e-mail de outro tipo de conta, ou responsável desativado: recusa (409), sem mudar nada.
//
// Segurança:
//   1. Quem chama envia o próprio login (Authorization: Bearer). Tudo que o banco confere é feito COM ESSE LOGIN:
//      responsavel_convite_checar (responsável da operação, operação ativa) e criar_convite.
//   2. A chave secreta (só no servidor) cria o login e inclui na operação. A senha provisória não volta ao navegador
//      nem aparece em registros: só vai no e-mail.
//   3. Ordem: confere tudo e o provedor de e-mail antes de criar conta. Se o e-mail não sair, a conta criada aqui é
//      apagada e a inclusão desfeita, para não sobrar login com senha que ninguém recebeu.
//   4. O e-mail sai pelo mesmo provedor do convite de participante (RESEND_API_KEY, EMAIL_REMETENTE, SITE_URL).

const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lerCorpo(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 5000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Endereço público do site, sem barra no fim (mesma regra do convite de participante).
function enderecoSite(req) {
  const fixo = String(process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(fixo)) return fixo;
  const h = req.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return (local ? 'http://' : 'https://') + host;
}

// Senha provisória: 14 caracteres aleatórios (letras e números), gerada só aqui.
function gerarSenhaProvisoria() {
  return crypto.randomBytes(12).toString('base64url').slice(0, 14);
}

function cabecalhosServico(chave) {
  const h = { 'Content-Type': 'application/json', apikey: chave };
  // Chaves antigas (JWT "service_role") também vão no Authorization; as novas (sb_secret_) só no apikey.
  if (!chave.startsWith('sb_')) h.Authorization = `Bearer ${chave}`;
  return h;
}

async function rpcServico(url, chave, nome, args) {
  const r = await fetch(`${url}/rest/v1/rpc/${nome}`, { method: 'POST', headers: cabecalhosServico(chave), body: JSON.stringify(args || {}) });
  const texto = await r.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch (e) { dados = texto; }
  return { ok: r.ok, status: r.status, dados, texto };
}

// Mensagem do e-mail: com senha provisória (conta nova) ou só o link (responsável que já tinha login).
function montarMensagem(d, link) {
  const assunto = 'Acesso ao painel da operação "' + d.codigo + '"';
  if (d.senha) {
    const texto = [
      'Olá, ' + d.nome + '!', '',
      d.convidado_por + ', do Corpo de Bombeiros, convidou você para acompanhar como responsável a operação "' + d.codigo + '".', '',
      'Dados de acesso ao painel:',
      'Login (seu e-mail): ' + d.email,
      'Senha provisória: ' + d.senha, '',
      'Entre pelo endereço abaixo. No primeiro acesso, o painel pede que você crie a sua senha.',
      link, '',
      'Não compartilhe esta senha. Se você não esperava este convite, ignore esta mensagem.',
    ].join('\n');
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.5">' +
      '<h2 style="margin:0 0 12px">Acesso ao painel da operação “' + esc(d.codigo) + '”</h2>' +
      '<p>Olá, <strong>' + esc(d.nome) + '</strong>!</p>' +
      '<p>' + esc(d.convidado_por) + ', do Corpo de Bombeiros, convidou você para acompanhar como responsável esta operação.</p>' +
      '<table style="border-collapse:collapse;margin:14px 0"><tr><td style="padding:4px 14px 4px 0;color:#555">Login (seu e-mail)</td><td><strong>' + esc(d.email) + '</strong></td></tr>' +
      '<tr><td style="padding:4px 14px 4px 0;color:#555">Senha provisória</td><td><strong style="font-family:monospace;font-size:16px">' + esc(d.senha) + '</strong></td></tr></table>' +
      '<p style="margin:22px 0"><a href="' + esc(link) + '" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:bold">Abrir o painel</a></p>' +
      '<p>No primeiro acesso, o painel pede que você crie a sua senha.</p>' +
      '<p style="font-size:13px;color:#555">Não compartilhe esta senha. Se você não esperava este convite, ignore esta mensagem.</p></div>';
    return { assunto, texto, html };
  }
  const texto = [
    'Olá, ' + d.nome + '!', '',
    d.convidado_por + ', do Corpo de Bombeiros, convidou você para acompanhar como responsável a operação "' + d.codigo + '".', '',
    'Entre com a sua senha de sempre:', link, '',
    'Se você não esperava este convite, ignore esta mensagem.',
  ].join('\n');
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.5">' +
    '<h2 style="margin:0 0 12px">Operação “' + esc(d.codigo) + '”</h2>' +
    '<p>Olá, <strong>' + esc(d.nome) + '</strong>!</p>' +
    '<p>' + esc(d.convidado_por) + ', do Corpo de Bombeiros, convidou você para acompanhar como responsável esta operação.</p>' +
    '<p style="margin:22px 0"><a href="' + esc(link) + '" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:bold">Abrir o painel</a></p>' +
    '<p style="font-size:13px;color:#555">Entre com a sua senha de sempre. Se você não esperava este convite, ignore esta mensagem.</p></div>';
  return { assunto, texto, html };
}

// Erros do banco (as funções levantam mensagens conhecidas)
function erroDoBanco(msg) {
  if (/sem_permissao/.test(msg)) return [403, 'sem_permissao'];
  if (/operacao_encerrada/.test(msg)) return [409, 'operacao_encerrada'];
  if (/email_convite_invalido|nome_convite_invalido|dados_invalidos/.test(msg)) return [400, 'dados_invalidos'];
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ erro: 'metodo_nao_permitido' });

  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const chavePublica = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  const chaveSecreta = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !chavePublica || !chaveSecreta) return res.status(500).json({ erro: 'variaveis_de_ambiente_ausentes' });

  const token = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ erro: 'nao_autenticado' });

  const corpo = await lerCorpo(req);
  const operacaoId = String(corpo.operacao_id || '');
  const nome = String(corpo.nome || '').replace(/\s+/g, ' ').trim();
  const email = String(corpo.email || '').trim().toLowerCase();
  if (!UUID_RE.test(operacaoId)) return res.status(400).json({ erro: 'operacao_invalida' });
  if (nome.length < 2 || nome.length > 40) return res.status(400).json({ erro: 'nome_invalido' });
  if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ erro: 'email_invalido' });

  // Provedor de e-mail antes de criar qualquer coisa
  const chaveEmail = String(process.env.RESEND_API_KEY || '').trim();
  const remetente = String(process.env.EMAIL_REMETENTE || '').trim();
  if (!chaveEmail || !remetente) return res.status(501).json({ erro: 'email_nao_configurado' });
  const site = enderecoSite(req);
  if (!site) return res.status(400).json({ erro: 'endereco_invalido' });

  const cabUsuario = { 'Content-Type': 'application/json', apikey: chavePublica, Authorization: `Bearer ${token}` };
  const rpcUsuario = (nomeRpc, args) => fetch(`${url}/rest/v1/rpc/${nomeRpc}`, { method: 'POST', headers: cabUsuario, body: JSON.stringify(args) });

  // Enquanto o convite não é registrado, a conta fica sem registro de envio; cada passo que falha desfaz o anterior.
  let convite = null, contaCriada = null, vinculado = null, quemConvida = null;
  // Desfaz o que este pedido criou: a conta nova (e a inclusão com ela) ou só a inclusão de quem já tinha login
  const desfazer = async () => {
    if (contaCriada) await fetch(`${url}/auth/v1/admin/users/${contaCriada}`, { method: 'DELETE', headers: cabecalhosServico(chaveSecreta) }).catch(() => null);
    else if (vinculado) await rpcServico(url, chaveSecreta, 'servidor_desvincular_responsavel', { p_operacao: operacaoId, p_user: vinculado }).catch(() => null);
  };

  try {
    // 1. Quem convida é responsável da operação, e ela está ativa (com o login de quem chama)
    const ch = await rpcUsuario('responsavel_convite_checar', { p_operacao: operacaoId });
    if (ch.status === 401) return res.status(401).json({ erro: 'nao_autenticado' });
    if (!ch.ok) {
      const msg = String((await ch.json().catch(() => ({}))).message || '');
      const e = erroDoBanco(msg);
      return res.status(e ? e[0] : 502).json({ erro: e ? e[1] : 'falha_supabase' });
    }
    const dc = await ch.json();
    quemConvida = dc.quem;

    // 2. Situação do e-mail: sem login, responsável ativo (só inclui) ou outra conta (recusa)
    const sit = await rpcServico(url, chaveSecreta, 'servidor_situacao_email', { p_email: email });
    if (!sit.ok) return res.status(502).json({ erro: 'falha_supabase' });
    const existente = sit.dados && sit.dados.user_id ? sit.dados : null;
    if (existente && !existente.responsavel) return res.status(409).json({ erro: 'email_em_uso' });
    if (existente && !existente.ativo) return res.status(409).json({ erro: 'conta_desativada' });

    // 3. Registro do convite (mesmo cadastro dos convites de participante, com o login de quem convida)
    const cc = await rpcUsuario('criar_convite', { p_operacao: operacaoId, p_dados: { nome, email, tipo: 'responsavel', canal: 'email' } });
    if (!cc.ok) {
      const msg = String((await cc.json().catch(() => ({}))).message || '');
      const e = erroDoBanco(msg);
      return res.status(e ? e[0] : 502).json({ erro: e ? e[1] : 'falha_supabase' });
    }
    convite = await cc.json();

    // 4. Login e inclusão na operação
    let senha = null;
    if (existente) {
      const v = await rpcServico(url, chaveSecreta, 'servidor_vincular_responsavel', { p_operacao: operacaoId, p_user: existente.user_id, p_por: quemConvida });
      if (!v.ok) return res.status(502).json({ erro: 'falha_supabase' });
      // só desfaz a inclusão se ela foi feita agora (quem já estava na operação continua como estava)
      if (v.dados === true) vinculado = existente.user_id;
    } else {
      senha = gerarSenhaProvisoria();
      const c = await fetch(`${url}/auth/v1/admin/users`, {
        method: 'POST',
        headers: cabecalhosServico(chaveSecreta),
        body: JSON.stringify({ email, password: senha, email_confirm: true, user_metadata: { nome, senha_provisoria: true } }),
      });
      const cj = await c.json().catch(() => ({}));
      if (!c.ok || !cj.id) {
        await registrar(url, cabUsuario, convite.id, 'não foi possível criar o acesso');
        return res.status(502).json({ erro: 'falha_supabase' });
      }
      contaCriada = cj.id;
      const s = await rpcServico(url, chaveSecreta, 'servidor_salvar_responsavel', { p_user: contaCriada, p_nome: nome, p_admin: false });
      if (!s.ok) { await desfazer(); await registrar(url, cabUsuario, convite.id, 'não foi possível cadastrar o responsável'); return res.status(502).json({ erro: 'falha_supabase' }); }
      const v = await rpcServico(url, chaveSecreta, 'servidor_vincular_responsavel', { p_operacao: operacaoId, p_user: contaCriada, p_por: quemConvida });
      if (!v.ok) { await desfazer(); await registrar(url, cabUsuario, convite.id, 'não foi possível incluir na operação'); return res.status(502).json({ erro: 'falha_supabase' }); }
      vinculado = contaCriada;
    }

    // 5. E-mail (com login e senha provisória quando a conta é nova)
    const link = `${site}/militar.html`;
    const m = montarMensagem({ nome, email, codigo: dc.codigo, convidado_por: dc.convidado_por, senha }, link);
    let ok = false, erro = null;
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chaveEmail}` },
        body: JSON.stringify({ from: remetente, to: [email], subject: m.assunto, text: m.texto, html: m.html }),
      });
      ok = r.ok;
      if (!r.ok) {
        const rj = await r.json().catch(() => ({}));
        erro = 'provedor ' + r.status + (rj && rj.message ? ': ' + String(rj.message).slice(0, 120) : '');
      }
    } catch (e) {
      erro = 'sem conexão com o provedor de e-mail';
    }

    // 6. Não saiu: desfaz o acesso criado e registra o motivo no convite
    if (!ok) {
      await desfazer();
      await registrar(url, cabUsuario, convite.id, erro);
      return res.status(502).json({ erro: 'falha_envio', detalhe: erro });
    }
    await registrar(url, cabUsuario, convite.id, null);
    return res.status(200).json({ ok: true, conta_criada: Boolean(contaCriada) });
  } catch (e) {
    if (convite) { await desfazer(); await registrar(url, cabUsuario, convite.id, 'falha de rede'); }
    return res.status(502).json({ erro: 'falha_rede', detalhe: String(e && e.message).slice(0, 200) });
  }
};

// Anota no convite o resultado do envio (o painel mostra "enviado" ou o motivo)
async function registrar(url, cabUsuario, conviteId, erro) {
  await fetch(`${url}/rest/v1/rpc/convite_registrar_envio`, { method: 'POST', headers: cabUsuario, body: JSON.stringify({ p_convite: conviteId, p_erro: erro }) }).catch(() => null);
}
