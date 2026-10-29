// POST /api/convidar  →  envia por e-mail o convite de um participante (somente responsáveis da operação).
//
// Corpo JSON: { "convite": "<uuid do convite criado por criar_convite_participante>" }
//
// Segurança:
//   1. Quem chama envia o próprio login (Authorization: Bearer <token>).
//   2. Os dados do envio (e-mail, código, token do link) vêm do banco COM ESSE LOGIN: a função
//      convite_dados_envio só responde a responsável da operação e recusa mais de 5 envios por convite.
//   3. O link é montado AQUI (endereço do site + token da operação lido do banco); o navegador não manda
//      link nem e-mail. Assim a mensagem só leva o convite cadastrado, de um responsável, para o e-mail cadastrado.
//   4. O e-mail sai por um provedor (Resend, https://resend.com). Variáveis de ambiente:
//        RESEND_API_KEY     chave do provedor (sem ela: erro "email_nao_configurado" e o painel oferece copiar o link)
//        EMAIL_REMETENTE    ex.: "Rastreamento GBS <convite@seudominio.com.br>" (domínio verificado no provedor)
//        SITE_URL           (opcional) endereço público do site; sem ele usa o endereço da requisição
//   Resultado do envio (ou da falha) é gravado no convite por convite_registrar_envio.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const CODIGO_RE = /^[0-9a-f]{24}$/;

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

// Endereço público do site, sem barra no fim.
function enderecoSite(req) {
  const fixo = String(process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(fixo)) return fixo;
  const h = req.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return (local ? 'http://' : 'https://') + host;
}

function montarMensagem(d, link) {
  const assunto = 'Convite para a busca "' + d.operacao + '"';
  const texto = [
    'Olá, ' + d.nome + '!',
    '',
    d.responsavel + ', do Corpo de Bombeiros, convidou você para participar da operação de busca "' + d.operacao + '".',
    '',
    'Abra o link no celular, toque em COMEÇAR e permita a localização. Seu celular passa a mostrar sua posição à equipe de busca:',
    link,
    '',
    'Mantenha a página aberta durante a busca. Para sair, use o botão de saída na própria página.',
    '',
    'Se você não esperava este convite, ignore esta mensagem.',
  ].join('\n');
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.5">' +
    '<h2 style="margin:0 0 12px">Convite para a busca “' + esc(d.operacao) + '”</h2>' +
    '<p>Olá, <strong>' + esc(d.nome) + '</strong>!</p>' +
    '<p>' + esc(d.responsavel) + ', do Corpo de Bombeiros, convidou você para participar desta operação de busca.</p>' +
    '<p>Abra o link <strong>no celular</strong>, toque em <strong>COMEÇAR</strong> e permita a localização. ' +
    'Seu celular passa a mostrar sua posição à equipe de busca.</p>' +
    '<p style="margin:22px 0"><a href="' + esc(link) + '" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:bold">Abrir e começar</a></p>' +
    '<p style="font-size:13px;color:#555">Se o botão não abrir, copie este endereço no navegador do celular:<br><span style="word-break:break-all">' + esc(link) + '</span></p>' +
    '<p style="font-size:13px;color:#555">Mantenha a página aberta durante a busca. Se você não esperava este convite, ignore esta mensagem.</p></div>';
  return { assunto, texto, html };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ erro: 'metodo_nao_permitido' });

  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const chavePublica = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  if (!url || !chavePublica) return res.status(500).json({ erro: 'variaveis_de_ambiente_ausentes' });

  const token = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ erro: 'nao_autenticado' });

  const corpo = await lerCorpo(req);
  const convite = String(corpo.convite || '');
  if (!UUID_RE.test(convite)) return res.status(400).json({ erro: 'convite_invalido' });

  const cab = { 'Content-Type': 'application/json', apikey: chavePublica, Authorization: `Bearer ${token}` };
  const rpc = (nome, args) => fetch(`${url}/rest/v1/rpc/${nome}`, { method: 'POST', headers: cab, body: JSON.stringify(args) });

  try {
    // 1. Dados do envio, com o login de quem chama (o banco confere responsável da operação e o limite de envios)
    const dr = await rpc('convite_dados_envio', { p_convite: convite });
    if (dr.status === 401) return res.status(401).json({ erro: 'nao_autenticado' });
    if (!dr.ok) {
      const msg = String((await dr.json().catch(() => ({}))).message || '');
      if (/sem_permissao/.test(msg)) return res.status(403).json({ erro: 'sem_permissao' });
      if (/operacao_encerrada/.test(msg)) return res.status(409).json({ erro: 'operacao_encerrada' });
      if (/convite_envios_limite/.test(msg)) return res.status(429).json({ erro: 'convite_envios_limite' });
      return res.status(502).json({ erro: 'falha_supabase' });
    }
    const d = await dr.json();
    if (!d || !TOKEN_RE.test(String(d.token_civil || '')) || !CODIGO_RE.test(String(d.codigo || ''))) {
      return res.status(502).json({ erro: 'falha_supabase' });
    }

    // 2. Provedor de e-mail
    const chaveEmail = String(process.env.RESEND_API_KEY || '').trim();
    const remetente = String(process.env.EMAIL_REMETENTE || '').trim();
    if (!chaveEmail || !remetente) return res.status(501).json({ erro: 'email_nao_configurado' });
    const site = enderecoSite(req);
    if (!site) return res.status(400).json({ erro: 'endereco_invalido' });
    const link = `${site}/civil.html#t=${d.token_civil}&c=${d.codigo}`;
    const m = montarMensagem(d, link);

    let ok = false, erro = null;
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chaveEmail}` },
        body: JSON.stringify({ from: remetente, to: [d.email], subject: m.assunto, text: m.texto, html: m.html }),
      });
      ok = r.ok;
      if (!r.ok) {
        const rj = await r.json().catch(() => ({}));
        erro = 'provedor ' + r.status + (rj && rj.message ? ': ' + String(rj.message).slice(0, 120) : '');
      }
    } catch (e) {
      erro = 'sem conexão com o provedor de e-mail';
    }

    // 3. Anota o resultado no convite (o painel mostra "enviado" ou o motivo)
    await rpc('convite_registrar_envio', { p_convite: convite, p_erro: ok ? null : erro }).catch(() => null);
    if (!ok) return res.status(502).json({ erro: 'falha_envio', detalhe: erro });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(502).json({ erro: 'falha_rede', detalhe: String(e && e.message).slice(0, 200) });
  }
};
