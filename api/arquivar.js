// /api/arquivar  →  arquiva operações encerradas (migração 055): os dados saem do banco para um arquivo compactado no
// Storage, e o banco fica só com a operação, os relatórios, as vítimas e o registro do arquivo.
//
//   POST { "operacao_id": "<uuid>" } com Authorization: Bearer <login do responsável>
//        arquiva agora. Só quem criou a operação, ou administrador da equipe dela (arquivo_pode_arquivar).
//   GET  com Authorization: Bearer <CRON_SECRET> (Vercel Cron, 1x por dia)
//        arquiva as encerradas há ARQUIVAR_APOS_DIAS dias (padrão 7), as mais antigas primeiro, até ~45 s.
//
// Segurança (nada é apagado sem conferência):
//   1. servidor_arquivo_preparar conta as linhas de cada tabela e lê relatório, SCI e briefing.
//   2. Cada tabela é exportada em páginas; a quantidade exportada tem de bater com a contagem do passo 1.
//   3. O JSON é compactado (gzip) e enviado ao bucket privado "arquivos" (<operacao>/<uuid>.json.gz).
//   4. O arquivo é BAIXADO DE VOLTA: SHA-256, tamanho, formato e a contagem de cada tabela são conferidos.
//   5. servidor_arquivo_confirmar reconta tudo no banco (tem de bater com o arquivo) e só então apaga, numa transação.
//   Se algo falha depois do envio, o arquivo enviado é removido e o banco fica como estava.
//   A chave secreta fica só aqui, no servidor.

const crypto = require('crypto');
const zlib = require('zlib');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATO = 'gbs-arquivo-operacao';
const VERSAO = 1;
const PAGINA = 5000;
const ORCAMENTO_MS = 45000;

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

function cabecalhosServico(chave, extra) {
  const h = Object.assign({ apikey: chave }, extra || {});
  // Chaves antigas (JWT "service_role") também vão no Authorization; as novas (sb_secret_) só no apikey.
  if (!chave.startsWith('sb_')) h.Authorization = `Bearer ${chave}`;
  return h;
}

async function rpcServico(url, chave, nome, args) {
  const r = await fetch(`${url}/rest/v1/rpc/${nome}`, {
    method: 'POST', headers: cabecalhosServico(chave, { 'Content-Type': 'application/json' }), body: JSON.stringify(args || {}),
  });
  const texto = await r.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch (e) { dados = texto; }
  if (!r.ok) {
    const msg = String((dados && dados.message) || texto || r.status);
    const e = new Error(nome + ': ' + msg.slice(0, 200));
    e.codigo = (msg.match(/[a-z_]{6,}/) || [''])[0];
    throw e;
  }
  return dados;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function contar(tabelas) {
  const c = {};
  Object.keys(tabelas || {}).forEach((k) => { c[k] = Array.isArray(tabelas[k]) ? tabelas[k].length : -1; });
  return c;
}

// Confere o arquivo baixado de volta: mesmo conteúdo enviado, formato certo, contagens iguais às exportadas
function conferirArquivo(baixado, enviado, opId, contagens) {
  if (baixado.length !== enviado.bytes) throw new Error('arquivo_divergente: tamanho ' + baixado.length + ' ≠ ' + enviado.bytes);
  if (sha256(baixado) !== enviado.sha256) throw new Error('arquivo_divergente: SHA-256 do arquivo baixado é outro');
  let doc;
  try { doc = JSON.parse(zlib.gunzipSync(baixado).toString('utf8')); } catch (e) { throw new Error('arquivo_divergente: não abriu (' + e.message + ')'); }
  if (!doc || doc.formato !== FORMATO || doc.versao !== VERSAO) throw new Error('arquivo_divergente: formato');
  if (!doc.operacao || doc.operacao.id !== opId) throw new Error('arquivo_divergente: operação');
  const c = contar(doc.tabelas);
  const nomes = new Set([...Object.keys(c), ...Object.keys(contagens)]);
  for (const n of nomes) if (c[n] !== contagens[n]) throw new Error('arquivo_divergente: ' + n + ' com ' + c[n] + ' linha(s), esperado ' + contagens[n]);
  return doc;
}

// Arquiva uma operação. Devolve o resumo; em qualquer falha, desfaz o envio e lança o erro (o banco fica como estava).
async function arquivarOperacao(url, chave, opId) {
  const prep = await rpcServico(url, chave, 'servidor_arquivo_preparar', { p_operacao: opId });
  const tabelas = {};
  const contagens = {};
  for (const t of prep.tabelas || []) {
    const linhas = [];
    for (let inicio = 0; ; inicio += PAGINA) {
      const pagina = await rpcServico(url, chave, 'servidor_arquivo_tabela', { p_operacao: opId, p_tabela: t.tabela, p_inicio: inicio, p_limite: PAGINA });
      if (!Array.isArray(pagina)) throw new Error('exportacao_incompleta: ' + t.tabela);
      for (const l of pagina) linhas.push(l);
      if (pagina.length < PAGINA) break;
    }
    if (linhas.length !== Number(t.total)) throw new Error('exportacao_incompleta: ' + t.tabela + ' exportou ' + linhas.length + ' de ' + t.total);
    tabelas[t.tabela] = linhas;
    contagens[t.tabela] = linhas.length;
  }
  const doc = {
    formato: FORMATO, versao: VERSAO, gerado_em: new Date().toISOString(),
    operacao: prep.operacao, contagens, tabelas, leituras: prep.leituras || {}, storage: prep.storage || [],
  };
  const json = Buffer.from(JSON.stringify(doc), 'utf8');
  const gz = zlib.gzipSync(json, { level: 9 });
  const enviado = { bytes: gz.length, sha256: sha256(gz) };
  const caminho = opId + '/' + crypto.randomUUID() + '.json.gz';
  const objeto = `${url}/storage/v1/object/arquivos/${caminho}`;

  const up = await fetch(objeto, { method: 'POST', headers: cabecalhosServico(chave, { 'Content-Type': 'application/gzip', 'x-upsert': 'false' }), body: gz });
  if (!up.ok) throw new Error('arquivamento_sem_arquivo: Storage ' + up.status + ' ' + String(await up.text().catch(() => '')).slice(0, 120));
  try {
    const down = await fetch(objeto, { headers: cabecalhosServico(chave) });
    if (!down.ok) throw new Error('arquivamento_sem_arquivo: não baixou de volta (' + down.status + ')');
    conferirArquivo(Buffer.from(await down.arrayBuffer()), enviado, opId, contagens);
    const conf = await rpcServico(url, chave, 'servidor_arquivo_confirmar', {
      p_operacao: opId, p_caminho: caminho, p_bytes: enviado.bytes, p_sha256: enviado.sha256, p_contagens: contagens,
    });
    return { operacao_id: opId, codigo: prep.operacao && prep.operacao.codigo, caminho, bytes: enviado.bytes, bytes_json: json.length,
      linhas: Object.values(contagens).reduce((a, b) => a + b, 0), apagadas: conf && conf.apagadas };
  } catch (e) {
    // desfaz o envio: o arquivo não fica órfão e o banco continua com tudo
    await fetch(`${url}/storage/v1/object/arquivos`, {
      method: 'DELETE', headers: cabecalhosServico(chave, { 'Content-Type': 'application/json' }), body: JSON.stringify({ prefixes: [caminho] }),
    }).catch(() => null);
    throw e;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const chavePublica = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  const chave = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !chave) return res.status(500).json({ erro: 'variaveis_de_ambiente_ausentes' });
  const autorizacao = String((req.headers && req.headers.authorization) || '');

  // Vercel Cron: arquiva as encerradas há N dias, dentro do tempo da função
  if (req.method === 'GET') {
    const segredo = process.env.CRON_SECRET;
    if (!segredo || autorizacao !== `Bearer ${segredo}`) return res.status(401).json({ erro: 'nao_autorizado' });
    const dias = Math.max(0, parseInt(process.env.ARQUIVAR_APOS_DIAS || '7', 10) || 0);
    const inicio = Date.now();
    const feitas = [];
    const falhas = [];
    try {
      const lista = (await rpcServico(url, chave, 'servidor_arquivo_candidatas', { p_dias: dias, p_limite: 20 })) || [];
      for (const item of lista) {
        if (Date.now() - inicio > ORCAMENTO_MS) break;
        const id = typeof item === 'string' ? item : item && (item.servidor_arquivo_candidatas || item.id);
        if (!UUID_RE.test(String(id || ''))) continue;
        try { feitas.push(await arquivarOperacao(url, chave, id)); } catch (e) { falhas.push({ operacao_id: id, erro: String(e.message).slice(0, 200) }); }
      }
      return res.status(200).json({ ok: true, dias, arquivadas: feitas, falhas });
    } catch (e) {
      return res.status(502).json({ erro: 'falha_supabase', detalhe: String(e.message).slice(0, 200), arquivadas: feitas, falhas });
    }
  }

  // Painel: "Arquivar agora" (quem criou a operação, ou administrador da equipe dela)
  if (req.method !== 'POST') return res.status(405).json({ erro: 'metodo_nao_permitido' });
  if (!chavePublica) return res.status(500).json({ erro: 'variaveis_de_ambiente_ausentes' });
  const token = autorizacao.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ erro: 'nao_autenticado' });
  const corpo = await lerCorpo(req);
  const opId = String(corpo.operacao_id || '');
  if (!UUID_RE.test(opId)) return res.status(400).json({ erro: 'operacao_invalida' });
  try {
    const v = await fetch(`${url}/rest/v1/rpc/arquivo_pode_arquivar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: chavePublica, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ p_operacao: opId }),
    });
    if (v.status === 401) return res.status(401).json({ erro: 'nao_autenticado' });
    if (!v.ok) {
      const msg = String((await v.json().catch(() => ({}))).message || '');
      if (/operacao_ativa/.test(msg)) return res.status(409).json({ erro: 'operacao_ativa' });
      if (/operacao_ja_arquivada/.test(msg)) return res.status(409).json({ erro: 'operacao_ja_arquivada' });
      return res.status(403).json({ erro: 'sem_permissao' });
    }
    const r = await arquivarOperacao(url, chave, opId);
    return res.status(200).json(Object.assign({ ok: true }, r));
  } catch (e) {
    const msg = String(e && e.message);
    // código devolvido pelo banco (e.codigo) ou o do início da mensagem dos erros deste endpoint ("arquivo_divergente: ...")
    const conhecido = /^(arquivo_[a-z_]+|arquivamento_[a-z_]+|exportacao_incompleta|operacao_[a-z_]+|sem_responsavel_ativo|sem_permissao)$/;
    const inicio = (msg.match(/^([a-z_]+):/) || [])[1];
    const codigo = conhecido.test(e && e.codigo) ? e.codigo : conhecido.test(inicio) ? inicio : 'falha_arquivamento';
    return res.status(502).json({ erro: codigo, detalhe: msg.slice(0, 300) });
  }
};

module.exports._teste = { conferirArquivo, contar, FORMATO, VERSAO };
