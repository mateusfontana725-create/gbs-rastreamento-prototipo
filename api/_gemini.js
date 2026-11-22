// Cliente do Google Gemini (e das outras IAs) com novas tentativas — usado por /api/poa-ia, /api/parse-operacao e
// /api/assistente. Arquivo com "_" na frente: a Vercel NÃO o publica como rota.
//
// A chave fica SÓ no servidor (variável GEMINI_API_KEY); vai no cabeçalho x-goog-api-key e nunca aparece em
// mensagens nem no log.
//
// Modelos (configurados AQUI, num lugar só):
//   - principal: IA_MODELO (ou POA_IA_MODELO, nome antigo) ou o padrão abaixo;
//   - reservas: IA_MODELOS_RESERVA, lista separada por vírgula, ou a lista padrão abaixo.
// Novas tentativas: só para 503 (modelo sobrecarregado) e 429 (cota/limite). Cada modelo é tentado 1 vez + até 3
// novas tentativas, com espera exponencial (IA_ESPERA_MS × 1, 2, 4: 800, 1600, 3200 ms por padrão); depois passa ao
// próximo modelo da lista. Qualquer outro erro volta na hora, com o status e a mensagem real do provedor.
// Tudo dentro de um prazo total (IA_PRAZO_MS, 45 s por padrão), para caber nos 60 s da função na Vercel.

const MODELO_PADRAO_GEMINI = 'gemini-3.8-flash';
const RESERVAS_PADRAO_GEMINI = ['gemini-2.5-flash'];
const STATUS_TRANSITORIO = [503, 429];
const TENTATIVAS_EXTRAS = 3;
const TEMPO_LIMITE_MS = 20000;   // por chamada

function modelosGemini(env) {
  env = env || process.env;
  const principal = String(env.IA_MODELO || env.POA_IA_MODELO || MODELO_PADRAO_GEMINI).trim();
  const reservas = env.IA_MODELOS_RESERVA != null && String(env.IA_MODELOS_RESERVA).trim() !== ''
    ? String(env.IA_MODELOS_RESERVA).split(',').map((m) => m.trim()).filter(Boolean)
    : RESERVAS_PADRAO_GEMINI;
  return [principal].concat(reservas.filter((m) => m !== principal));
}

const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Uma chamada ao Gemini. p = { system, user, json (bool), schema (responseSchema), maxTokens, ferramentas (functionDeclarations) }
// Devolve { ok, status, texto, motivo, chamadasFuncao: [{ nome, argumentos }] }.
async function chamarGemini(chave, modelo, p) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TEMPO_LIMITE_MS);
  try {
    const generationConfig = Object.assign({ maxOutputTokens: p.maxTokens || 4096, temperature: p.temperatura != null ? p.temperatura : 0 },
      p.json || p.schema ? { responseMimeType: 'application/json' } : {},
      p.schema ? { responseSchema: p.schema } : {},
      // o Gemini 2.5 flash gasta o limite de saída "pensando" e pode devolver texto vazio: desliga o raciocínio
      /gemini-2\.5-flash/i.test(modelo) ? { thinkingConfig: { thinkingBudget: 0 } } : {});
    const corpoPedido = {
      systemInstruction: { parts: [{ text: p.system || '' }] },
      contents: [{ role: 'user', parts: [{ text: p.user || '' }] }],
      generationConfig,
    };
    if (Array.isArray(p.ferramentas) && p.ferramentas.length) corpoPedido.tools = [{ functionDeclarations: p.ferramentas }];
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chave },
      body: JSON.stringify(corpoPedido),
      signal: ctrl.signal,
    });
    const corpo = await r.json().catch(() => null);
    const cand = corpo && corpo.candidates && corpo.candidates[0];
    const partes = cand && cand.content && cand.content.parts;
    // chave inválida no Gemini volta como 400 ("API key not valid")
    const chaveRuim = r.status === 400 && /api key/i.test(JSON.stringify((corpo && corpo.error) || ''));
    const motivo = (corpo && corpo.error && corpo.error.message) || (corpo && corpo.promptFeedback && corpo.promptFeedback.blockReason)
      || (cand && cand.finishReason && cand.finishReason !== 'STOP' ? cand.finishReason : '') || '';
    const lista = Array.isArray(partes) ? partes : [];
    return {
      ok: r.ok, status: chaveRuim ? 401 : r.status,
      texto: lista.map((c) => c.text || '').join(''),
      chamadasFuncao: lista.filter((c) => c.functionCall).map((c) => ({ nome: String(c.functionCall.name || ''), argumentos: c.functionCall.args || {} })),
      motivo: String(motivo).replace(/key=[^&\s]+/gi, '').slice(0, 300),
    };
  } finally { clearTimeout(t); }
}

// Tenta cada modelo da lista: 1 vez + até 3 novas tentativas se o erro for 503 ou 429 (espera exponencial); depois o
// próximo modelo. chamar(modelo) → { ok, status, texto, motivo }. Devolve o resultado com { modelo, tentativa, esgotou }.
//   esgotou = true: todas as tentativas falharam com 503/429 (ou acabou o prazo) → o endpoint responde 503 com mensagem clara.
//   esgotou = false e ok = false: outro erro → o endpoint repassa o status e a mensagem real.
async function comNovasTentativas(chamar, modelos, opcoes) {
  opcoes = opcoes || {};
  const env = opcoes.env || process.env;
  const base = opcoes.esperaMs != null ? opcoes.esperaMs : Number(env.IA_ESPERA_MS != null ? env.IA_ESPERA_MS : (env.POA_IA_ESPERA_MS != null ? env.POA_IA_ESPERA_MS : 800));
  const prazo = opcoes.prazoMs != null ? opcoes.prazoMs : Number(env.IA_PRAZO_MS || 45000);
  const rotulo = opcoes.rotulo || 'ia';
  const transitorio = opcoes.transitorio || STATUS_TRANSITORIO;
  const inicio = Date.now();
  let ultimo = null, chamadas = 0;
  for (let i = 0; i < modelos.length; i++) {
    const modelo = modelos[i];
    for (let tentativa = 1; tentativa <= 1 + TENTATIVAS_EXTRAS; tentativa++) {
      const r = await chamar(modelo);
      chamadas++;
      if (r.ok) return Object.assign({}, r, { modelo, tentativa, chamadas, esgotou: false });
      ultimo = Object.assign({}, r, { modelo, tentativa, chamadas });
      // log no servidor: status, modelo e tentativa (sem a chave nem o conteúdo do pedido)
      console.warn(`[${rotulo}] falha status=${r.status} modelo=${modelo} tentativa=${tentativa}${r.motivo ? ' motivo="' + String(r.motivo).slice(0, 120) + '"' : ''}`);
      if (!transitorio.includes(r.status)) return Object.assign(ultimo, { esgotou: false });
      if (tentativa > TENTATIVAS_EXTRAS) break;
      const espera = base * Math.pow(2, tentativa - 1);   // 800, 1600, 3200 ms
      if (Date.now() - inicio + espera > prazo) return Object.assign(ultimo, { esgotou: true });
      if (espera > 0) await dormir(espera);
    }
    if (i < modelos.length - 1) console.warn(`[${rotulo}] modelo ${modelo} sobrecarregado: passando ao reserva ${modelos[i + 1]}`);
  }
  return Object.assign(ultimo || { ok: false, status: 503, texto: '', motivo: '' }, { esgotou: true });
}

// Mensagem para o usuário quando as tentativas acabaram (sempre respondida com status 503)
function mensagemEsgotada(r) {
  return r && r.status === 429
    ? 'A IA atingiu o limite de uso (cota) agora. Ela foi tentada de novo algumas vezes, inclusive com um modelo reserva, sem sucesso. Tente em alguns minutos.'
    : 'A IA está sobrecarregada (alta demanda no provedor). Ela foi tentada de novo algumas vezes, inclusive com um modelo reserva, sem sucesso. Tente de novo em instantes.';
}

function extrairJson(t) {
  if (typeof t !== 'string') return null;
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}

// Confere o login (token do Supabase) sem precisar de operação: GET /auth/v1/user com o token da pessoa.
async function usuarioDoToken(url, chavePublica, token) {
  const r = await fetch(`${url}/auth/v1/user`, { headers: { apikey: chavePublica, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? u : null;
}

function lerCorpo(req, max) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > (max || 40000)) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Limite simples de pedidos por chave (memória da instância)
function criarLimite(porMinuto) {
  const contagem = new Map();
  return function limitar(chave) {
    const agora = Date.now();
    const lista = (contagem.get(chave) || []).filter((t) => agora - t < 60000);
    lista.push(agora);
    contagem.set(chave, lista);
    if (contagem.size > 5000) contagem.clear();
    return lista.length <= porMinuto;
  };
}

function tokenDe(req) {
  const auth = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

module.exports = {
  MODELO_PADRAO_GEMINI, RESERVAS_PADRAO_GEMINI, STATUS_TRANSITORIO, TENTATIVAS_EXTRAS,
  modelosGemini, chamarGemini, comNovasTentativas, mensagemEsgotada, extrairJson, usuarioDoToken, lerCorpo, criarLimite, tokenDe,
};
