// POST /api/poa-ia  →  assistente de IA OPCIONAL para sugerir POA (por setor) e POD (de uma missão).
//
// O responsável decide: a IA só devolve SUGESTÕES, com uma frase de justificativa, que a tela marca
// como "sugerido por IA". Nada é publicado aqui, e nada é gravado por esta função.
//
// A chave da API de IA fica SÓ no servidor; o navegador nunca a vê. Dois provedores:
//   - Anthropic: ANTHROPIC_API_KEY (modelo padrão claude-haiku-5-5);
//   - Google Gemini: GEMINI_API_KEY (modelo padrão gemini-3.8-flash).
// POA_IA_PROVEDOR ("anthropic" ou "gemini") escolhe o provedor; sem ela, usa o que tiver chave (Anthropic primeiro).
// POA_IA_MODELO troca o modelo. Sem chave, responde 503 e a tela segue manual.
//
// Corpo JSON:
//   { "modo": "poa" | "pod", "operacao_id": "<uuid>", "contexto": { … } }
//   modo "poa": contexto = { operacao, vitima, ultimo_local, observacoes[], relatos[], evidencias[], hipoteses, limitacoes,
//                            horario_referencia, setores: [{ id, nome, area_km2, centro, observacoes }] }
//   modo "pod": contexto = { setor: { nome, area_km2, observacoes }, equipe, metodo, area_fracao, area_texto, operacao }
//
// Resposta 200:
//   poa → { modelo, setores: [{ setor_id, poa (0 a 1 ou null), justificativa, insuficiente }], fora: { poa, justificativa, insuficiente }, aviso? }
//   pod → { modelo, pod (0 a 1 ou null), justificativa, insuficiente }
//   "insuficiente": a IA não tinha dados para estimar; poa/pod vêm nulos (nunca inventa percentual).
//
// Segurança: quem chama envia o próprio token de login. O banco confere, com o token dele, que é responsável
// desta operação (função dono_operacao). O contexto é limpo e truncado aqui; nome, CPF e telefone não são
// enviados à IA (a tela também não os manda). Limite de pedidos por usuário por minuto.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITE_POR_MIN = 6;
const TEMPO_LIMITE_MS = 20000;   // por tentativa (a função tem até 60 s, com até 3 tentativas)
const TAMANHO_MAX_CORPO = 40000;
const contagem = new Map();

function lerCorpo(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > TAMANHO_MAX_CORPO) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function limitar(chave) {
  const agora = Date.now();
  const lista = (contagem.get(chave) || []).filter((t) => agora - t < 60000);
  lista.push(agora);
  contagem.set(chave, lista);
  if (contagem.size > 5000) contagem.clear();
  return lista.length <= LIMITE_POR_MIN;
}

async function rpcUsuario(url, chavePublica, token, nome, args) {
  const r = await fetch(`${url}/rest/v1/rpc/${nome}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: chavePublica, Authorization: `Bearer ${token}` },
    body: JSON.stringify(args || {}),
  });
  const texto = await r.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch (e) { dados = texto; }
  return { ok: r.ok, status: r.status, dados };
}

const texto = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const numero = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
function lista(v, n, max) {
  return (Array.isArray(v) ? v : []).slice(0, n).map((x) => texto(typeof x === 'string' ? x : (x && (x.texto || x.descricao)) || '', max)).filter(Boolean);
}

// Contexto do POA: só campos conhecidos, com tamanho limitado. Sem nome da vítima nem dados de contato.
function limparPoa(c) {
  c = c && typeof c === 'object' ? c : {};
  const op = c.operacao || {}, v = c.vitima || {}, u = c.ultimo_local || null;
  const setores = (Array.isArray(c.setores) ? c.setores : []).slice(0, 40)
    .map((s) => ({ id: texto(s && s.id, 60), nome: texto(s && s.nome, 60), area_km2: numero(s && s.area_km2), centro: Array.isArray(s && s.centro) && s.centro.length === 2 ? s.centro.map(numero) : null, observacoes: texto(s && s.observacoes, 300) }))
    .filter((s) => s.id && s.nome);
  return {
    operacao: { tipo: texto(op.tipo, 60), descricao: texto(op.descricao, 1500), local: texto(op.local, 200), acionado_em: texto(op.acionado_em, 40) },
    vitima: { idade: numero(v.idade), sexo: texto(v.sexo, 30), perfil: lista(v.perfil, 10, 60), caracteristicas: texto(v.caracteristicas, 500), roupas: texto(v.roupas, 300), observacoes: texto(v.observacoes, 800) },
    ultimo_local: u ? { titulo: texto(u.titulo, 100), descricao: texto(u.descricao, 300), lat: numero(u.lat), lng: numero(u.lng) } : null,
    observacoes: lista(c.observacoes, 10, 300),
    relatos: (Array.isArray(c.relatos) ? c.relatos : []).slice(0, 15).map((r) => ({ texto: texto(r && r.texto, 300), quando: texto(r && r.quando, 40), categoria: texto(r && r.categoria, 40), lat: numero(r && r.lat), lng: numero(r && r.lng) })).filter((r) => r.texto),
    evidencias: (Array.isArray(c.evidencias) ? c.evidencias : []).slice(0, 20).map((e) => ({ descricao: texto(e && e.descricao, 300), confirmada: Boolean(e && e.confirmada) })).filter((e) => e.descricao),
    hipoteses: texto(c.hipoteses, 800), limitacoes: texto(c.limitacoes, 500), horario_referencia: texto(c.horario_referencia, 40),
    setores,
  };
}

function limparPod(c) {
  c = c && typeof c === 'object' ? c : {};
  const s = c.setor || {}, op = c.operacao || {};
  return {
    operacao: { tipo: texto(op.tipo, 60), descricao: texto(op.descricao, 600) },
    setor: { nome: texto(s.nome, 60), area_km2: numero(s.area_km2), observacoes: texto(s.observacoes, 300) },
    equipe: texto(c.equipe, 60), metodo: texto(c.metodo, 60), area_fracao: numero(c.area_fracao), area_texto: texto(c.area_texto, 200),
  };
}

const REGRAS = [
  'Você apoia um comando de busca e salvamento de pessoas desaparecidas. Responda SOMENTE com um objeto JSON, sem texto fora dele.',
  'Use APENAS os dados fornecidos. Se os dados não bastam para estimar um valor, devolva null nesse valor, "insuficiente": true e a justificativa "informação insuficiente". Nunca invente percentuais.',
  'Probabilidades ficam entre 0 e 1. Não há modelo de deriva nem de movimento automático: raciocine só com o que foi informado.',
  'Cada justificativa tem UMA frase curta, em português do Brasil, citando o dado que a sustenta.',
  'Sua resposta é uma sugestão para revisão humana; o responsável decide.',
].join(' ');

function promptPoa(ctx) {
  return {
    system: REGRAS,
    user: 'Tarefa: sugerir o POA, a probabilidade de a pessoa estar em cada setor, e a probabilidade de estar fora de todos os setores ("fora"). '
      + 'A soma dos POA dos setores com "fora" não deve passar de 1. Os setores não se sobrepõem. '
      + 'Formato: {"setores":[{"setor_id":"<id>","poa":<0 a 1 ou null>,"justificativa":"<uma frase>","insuficiente":<true|false>}],"fora":{"poa":<0 a 1 ou null>,"justificativa":"<uma frase>","insuficiente":<true|false>}}. '
      + 'Inclua todos os setores da lista.\nDados:\n' + JSON.stringify(ctx),
  };
}

function promptPod(ctx) {
  return {
    system: REGRAS,
    user: 'Tarefa: sugerir o POD de UMA missão de busca, a chance de a equipe achar a pessoa SE ela estiver na área coberta, considerando método, tamanho da área e o que se sabe do terreno. '
      + 'O POD não vem de GPS. Se o método ou a área não bastam, responda insuficiente. '
      + 'Formato: {"pod":<0 a 1 ou null>,"justificativa":"<uma frase>","insuficiente":<true|false>}.\nDados:\n' + JSON.stringify(ctx),
  };
}

function extrairJson(t) {
  if (typeof t !== 'string') return null;
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}

const decimos = (v) => Math.round(v * 1000) / 1000;   // 0,1% (a mesma casa do formulário)
function valorProb(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 1 ? decimos(n) : undefined;   // undefined = inválido
}
const JUST_INSUF = 'informação insuficiente';
function itemSaida(poa, just, insuf) {
  const sem = insuf === true || poa === null;
  return { poa: sem ? null : poa, justificativa: sem ? JUST_INSUF : (texto(just, 300) || JUST_INSUF), insuficiente: sem };
}

// Valida e normaliza a resposta da IA: só setores que existem, valores entre 0 e 1, sem passar de 100%.
function normalizarPoa(bruto, setores) {
  if (!bruto || !Array.isArray(bruto.setores)) return null;
  const ids = new Set(setores.map((s) => s.id));
  const vistos = new Set();
  const saida = [];
  for (const it of bruto.setores) {
    const id = it && texto(it.setor_id, 60);
    if (!id || !ids.has(id) || vistos.has(id)) continue;
    vistos.add(id);
    const v = valorProb(it.poa);
    if (v === undefined) return null;
    saida.push(Object.assign({ setor_id: id }, itemSaida(v, it.justificativa, it.insuficiente)));
  }
  setores.forEach((s) => { if (!vistos.has(s.id)) saida.push(Object.assign({ setor_id: s.id }, itemSaida(null, '', true))); });
  const bf = bruto.fora && typeof bruto.fora === 'object' ? bruto.fora : {};
  const vf = valorProb(bf.poa);
  if (vf === undefined) return null;
  const fora = itemSaida(vf, bf.justificativa, bf.insuficiente);
  let soma = saida.reduce((a, s) => a + (s.poa || 0), 0) + (fora.poa || 0);
  let aviso = null;
  if (soma > 1.0005) {
    const k = 1 / soma;
    saida.forEach((s) => { if (s.poa != null) s.poa = Math.floor(s.poa * k * 1000) / 1000; });
    if (fora.poa != null) fora.poa = Math.floor(fora.poa * k * 1000) / 1000;
    aviso = 'A soma sugerida passava de 100% e foi reduzida proporcionalmente. Revise os valores.';
  }
  return { setores: saida, fora, aviso };
}

function normalizarPod(bruto) {
  if (!bruto || typeof bruto !== 'object') return null;
  const v = valorProb(bruto.pod);
  if (v === undefined) return null;
  const it = itemSaida(v, bruto.justificativa, bruto.insuficiente);
  return { pod: it.poa, justificativa: it.justificativa, insuficiente: it.insuficiente };
}

// Chama o provedor escolhido e devolve { ok, status, texto } com o texto da resposta.
async function perguntar(prov, chave, modelo, p) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TEMPO_LIMITE_MS);
  try {
    if (prov === 'gemini') {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chave },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: p.system }] },
          contents: [{ role: 'user', parts: [{ text: p.user }] }],
          generationConfig: Object.assign({ responseMimeType: 'application/json', maxOutputTokens: 4096, temperature: 0 },
            // o Gemini 2.5 flash gasta o limite de saída "pensando" e podem devolver texto vazio: desliga o raciocínio
            /gemini-2\.5-flash/i.test(modelo) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        }),
        signal: ctrl.signal,
      });
      const corpo = await r.json().catch(() => null);
      const partes = corpo && corpo.candidates && corpo.candidates[0] && corpo.candidates[0].content && corpo.candidates[0].content.parts;
      // chave inválida no Gemini volta como 400 ("API key not valid")
      const chaveRuim = r.status === 400 && /api key/i.test(JSON.stringify(corpo && corpo.error || ''));
      const motivo = (corpo && corpo.error && corpo.error.message) || (corpo && corpo.promptFeedback && corpo.promptFeedback.blockReason) || (corpo && corpo.candidates && corpo.candidates[0] && corpo.candidates[0].finishReason !== 'STOP' ? corpo.candidates[0].finishReason : '') || '';
      return { ok: r.ok, status: chaveRuim ? 401 : r.status, texto: Array.isArray(partes) ? partes.map((c) => c.text || '').join('') : '', motivo: String(motivo).slice(0, 160) };
    }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': chave, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: modelo, max_tokens: 2000, system: p.system, messages: [{ role: 'user', content: p.user }] }),
      signal: ctrl.signal,
    });
    const corpo = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, texto: corpo && Array.isArray(corpo.content) ? corpo.content.map((c) => c.text || '').join('') : '', motivo: String((corpo && corpo.error && corpo.error.message) || '').slice(0, 160) };
  } finally { clearTimeout(t); }
}

// Provedor, chave e modelo a partir das variáveis de ambiente
function configurarIa() {
  const env = process.env;
  const chaveAnthropic = (env.ANTHROPIC_API_KEY || '').trim();
  const chaveGemini = (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '').trim();
  let prov = (env.POA_IA_PROVEDOR || '').trim().toLowerCase();
  if (prov !== 'anthropic' && prov !== 'gemini') prov = chaveAnthropic ? 'anthropic' : chaveGemini ? 'gemini' : 'anthropic';
  const chave = prov === 'gemini' ? chaveGemini : chaveAnthropic;
  const modelo = (env.POA_IA_MODELO || (prov === 'gemini' ? 'gemini-3.8-flash' : 'claude-haiku-5-5')).trim();
  return { prov, chave, modelo, variavel: prov === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY' };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ erro: 'metodo_nao_permitido' });

  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const chavePublica = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  const { prov, chave: chaveIa, modelo, variavel } = configurarIa();
  if (!url || !chavePublica) return res.status(500).json({ erro: 'variaveis_de_ambiente_ausentes' });

  const auth = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return res.status(401).json({ erro: 'nao_autenticado' });

  const corpo = await lerCorpo(req);
  const modo = corpo.modo;
  if ((modo !== 'poa' && modo !== 'pod') || !UUID_RE.test(String(corpo.operacao_id || ''))) return res.status(400).json({ erro: 'dados_invalidos' });

  try {
    // quem pode sugerir: responsável desta operação (conferido pelo banco, com o token do próprio usuário)
    const v = await rpcUsuario(url, chavePublica, token, 'dono_operacao', { p_operacao: corpo.operacao_id });
    if (v.status === 401) return res.status(401).json({ erro: 'nao_autenticado' });
    if (v.dados !== true) return res.status(403).json({ erro: 'sem_permissao' });
    if (!chaveIa) {
      return res.status(503).json({ erro: 'ia_nao_configurada', mensagem: `A IA não está configurada neste servidor: falta a variável ${variavel} (provedor ${prov}). O preenchimento manual continua funcionando.` });
    }
    if (!limitar(token.slice(-24))) return res.status(429).json({ erro: 'muitos_pedidos', mensagem: 'Muitos pedidos à IA em pouco tempo. Aguarde um minuto.' });

    let prompt, ctx;
    if (modo === 'poa') {
      ctx = limparPoa(corpo.contexto);
      if (!ctx.setores.length) return res.status(400).json({ erro: 'sem_setores', mensagem: 'Desenhe os setores antes de pedir a sugestão.' });
      prompt = promptPoa(ctx);
    } else {
      ctx = limparPod(corpo.contexto);
      if (!ctx.setor.nome || !ctx.metodo) return res.status(400).json({ erro: 'dados_invalidos' });
      prompt = promptPod(ctx);
    }

    // Sobrecarga momentânea do provedor (500, 502, 503, 504): tenta de novo, com espera crescente, dentro do prazo da função
    const espera = Number(process.env.POA_IA_ESPERA_MS || 1500), inicio = Date.now();
    let r = await perguntar(prov, chaveIa, modelo, prompt);
    for (let n = 1; n <= 2 && [500, 502, 503, 504].includes(r.status) && Date.now() - inicio < 25000; n++) {
      await new Promise((ok) => setTimeout(ok, espera * n));
      r = await perguntar(prov, chaveIa, modelo, prompt);
    }
    if (r.status === 429) return res.status(503).json({ erro: 'ia_cota', mensagem: `A IA (${prov}) atingiu o limite de uso agora. Tente em alguns minutos ou preencha manualmente.` });
    if (r.status === 401 || r.status === 403) return res.status(503).json({ erro: 'ia_nao_configurada', mensagem: `A chave da IA (${variavel}) foi recusada pelo provedor ${prov}. Confira a chave. O preenchimento manual continua funcionando.` });
    if (!r.ok) return res.status(502).json({ erro: 'ia_indisponivel', mensagem: `A IA (${prov}, ${modelo}) respondeu com erro ${r.status}${r.motivo ? ': ' + r.motivo : ''}. Preencha manualmente ou tente de novo.` });

    const bruto = extrairJson(r.texto);
    if (modo === 'poa') {
      const n = normalizarPoa(bruto, ctx.setores);
      if (!n) return res.status(502).json({ erro: 'ia_resposta_invalida', mensagem: `A IA (${prov}, ${modelo}) devolveu uma resposta que não dá para usar${r.motivo ? ' (' + r.motivo + ')' : ''}. Preencha manualmente ou tente de novo.` });
      return res.status(200).json({ modelo, setores: n.setores, fora: n.fora, aviso: n.aviso });
    }
    const n = normalizarPod(bruto);
    if (!n) return res.status(502).json({ erro: 'ia_resposta_invalida', mensagem: `A IA (${prov}, ${modelo}) devolveu uma resposta que não dá para usar${r.motivo ? ' (' + r.motivo + ')' : ''}. Preencha manualmente ou tente de novo.` });
    return res.status(200).json(Object.assign({ modelo }, n));
  } catch (e) {
    const abortou = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
    return res.status(502).json({ erro: 'ia_indisponivel', mensagem: abortou ? 'A IA demorou demais. Preencha manualmente ou tente de novo.' : `A IA não respondeu agora (${String(e && e.message || e).replace(/key=[^&\s]+/gi, '').slice(0, 100)}). Preencha manualmente ou tente de novo.` });
  }
};

module.exports._interno = { limparPoa, limparPod, normalizarPoa, normalizarPod, extrairJson, perguntar, configurarIa, rpcUsuario };
