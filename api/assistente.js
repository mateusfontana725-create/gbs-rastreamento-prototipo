// POST /api/assistente  →  BASE do assistente geral (estrutura; a tela completa vem depois).
// Recebe uma pergunta e um resumo do estado atual do app e responde em português, com o mesmo tratamento de novas
// tentativas do Gemini (api/_gemini.js: 503/429 → espera exponencial → modelo reserva).
//
// O assistente NÃO altera dados e NÃO toma decisões. Ponto de extensão para function calling: FERRAMENTAS (abaixo).
// Hoje a lista está vazia. Quando houver ferramentas, uma chamada de função vinda da IA NUNCA é executada aqui: ela volta
// em "acoes_propostas", sempre com requer_confirmacao: true, e a tela só executa depois de a pessoa confirmar
// explicitamente (e pelo caminho normal do app, com as permissões de quem confirmou).
//
// Corpo JSON:
//   { "pergunta": "<texto>", "estado": { "operacoes": [{ id, codigo, status, tipo, acionado_em, local }],
//     "participantes": [{ nome, tipo, estado, grupo, ultimo_contato }], "status": { <chave>: <número ou texto curto> } } }
//   Só esses campos passam (CPF, telefone e o resto são descartados aqui); listas e textos são truncados.
// Resposta 200: { modelo, resposta, acoes_propostas: [{ nome, argumentos, descricao, requer_confirmacao: true }] }
// Falhas: 401 sem login; 400 sem pergunta; 503 IA sem chave ou sobrecarregada/cota depois das tentativas; 502 outro erro.

const G = require('./_gemini');

const LIMITE_POR_MIN = 10;
const limitar = G.criarLimite(LIMITE_POR_MIN);

// Ponto de extensão (function calling). Cada item: { declaracao: { name, description, parameters }, descricao(args) → texto
// para a tela de confirmação }. NÃO coloque aqui nada que execute ação: a execução fica na tela, depois da confirmação.
const FERRAMENTAS = [];

const texto = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : (typeof v === 'number' && isFinite(v) ? String(v) : ''));

function limparEstado(e) {
  e = e && typeof e === 'object' ? e : {};
  const operacoes = (Array.isArray(e.operacoes) ? e.operacoes : []).slice(0, 20).map((o) => ({
    id: texto(o && o.id, 40), codigo: texto(o && o.codigo, 80), status: texto(o && o.status, 30), tipo: texto(o && o.tipo, 60),
    acionado_em: texto(o && o.acionado_em, 40), local: texto(o && o.local, 160),
  })).filter((o) => o.codigo || o.id);
  const participantes = (Array.isArray(e.participantes) ? e.participantes : []).slice(0, 200).map((p) => ({
    nome: texto(p && p.nome, 60), tipo: texto(p && p.tipo, 20), estado: texto(p && p.estado, 40), grupo: texto(p && p.grupo, 60), ultimo_contato: texto(p && p.ultimo_contato, 40),
  })).filter((p) => p.nome);
  const status = {};
  const s = e.status && typeof e.status === 'object' && !Array.isArray(e.status) ? e.status : {};
  Object.keys(s).slice(0, 30).forEach((k) => {
    const v = s[k];
    if (typeof v === 'number' && isFinite(v)) status[texto(k, 40)] = v;
    else if (typeof v === 'string' || typeof v === 'boolean') status[texto(k, 40)] = typeof v === 'boolean' ? v : texto(v, 200);
  });
  return { operacoes, participantes, status };
}

const REGRAS = [
  'Você é o assistente do painel de comando de um app de rastreamento de equipes do Corpo de Bombeiros (CBMPR), usado em buscas e em outras operações.',
  'Responda em português do Brasil, de forma curta e direta, usando SOMENTE o estado fornecido. Se a informação não está no estado, diga que não sabe.',
  'Você não toma decisões, não faz previsões de sobrevivência nem de onde a pessoa está, e não estima probabilidades: apoia quem decide, resumindo o que existe.',
  'Você não executa ações. Se uma ação ajudaria, descreva-a como sugestão; ela só acontece se o responsável confirmar e fizer pelo app.',
].join(' ');

// Chamadas de função vindas da IA → ações PROPOSTAS (nada é executado). Só nomes que existem em FERRAMENTAS.
function acoesPropostas(chamadas) {
  const nomes = new Map(FERRAMENTAS.map((f) => [f.declaracao.name, f]));
  return (Array.isArray(chamadas) ? chamadas : []).filter((c) => c && nomes.has(c.nome)).slice(0, 5).map((c) => {
    const f = nomes.get(c.nome);
    let descricao = '';
    try { descricao = f.descricao ? String(f.descricao(c.argumentos || {})).slice(0, 300) : ''; } catch (e) { descricao = ''; }
    return { nome: c.nome, argumentos: c.argumentos || {}, descricao, requer_confirmacao: true };
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ erro: 'metodo_nao_permitido' });
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const chavePublica = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  const chaveIa = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (!url || !chavePublica) return res.status(500).json({ erro: 'variaveis_de_ambiente_ausentes' });
  const token = G.tokenDe(req);
  if (!token) return res.status(401).json({ erro: 'nao_autenticado' });
  const corpo = await G.lerCorpo(req, 60000);
  const pergunta = texto(corpo.pergunta, 1000);
  if (!pergunta) return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Escreva a pergunta.' });
  try {
    const u = await G.usuarioDoToken(url, chavePublica, token);
    if (!u) return res.status(401).json({ erro: 'nao_autenticado' });
    if (!chaveIa) return res.status(503).json({ erro: 'ia_nao_configurada', mensagem: 'O assistente não está configurado neste servidor (falta GEMINI_API_KEY).' });
    if (!limitar(u.id)) return res.status(429).json({ erro: 'muitos_pedidos', mensagem: 'Muitas perguntas em pouco tempo. Aguarde um minuto.' });
    const estado = limparEstado(corpo.estado);
    const prompt = {
      system: REGRAS, maxTokens: 1500, temperatura: 0.2,
      user: 'Estado atual do app (resumo):\n' + JSON.stringify(estado) + '\n\nPergunta: ' + pergunta,
      ferramentas: FERRAMENTAS.map((f) => f.declaracao),
    };
    const r = await G.comNovasTentativas((m) => G.chamarGemini(chaveIa, m, prompt), G.modelosGemini(), { rotulo: 'assistente' });
    if (r.esgotou) return res.status(503).json({ erro: r.status === 429 ? 'ia_cota' : 'ia_sobrecarregada', tentar_de_novo: true, mensagem: G.mensagemEsgotada(r) });
    if (r.status === 401 || r.status === 403) return res.status(503).json({ erro: 'ia_nao_configurada', mensagem: 'A chave da IA (GEMINI_API_KEY) foi recusada pelo Gemini. Confira a chave na Vercel.' });
    if (!r.ok) return res.status(502).json({ erro: 'ia_indisponivel', mensagem: `A IA (${r.modelo}) respondeu com erro ${r.status}${r.motivo ? ': ' + r.motivo : ''}.` });
    return res.status(200).json({ modelo: r.modelo, resposta: String(r.texto || '').trim() || 'Sem resposta da IA.', acoes_propostas: acoesPropostas(r.chamadasFuncao) });
  } catch (e) {
    const abortou = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
    return res.status(502).json({ erro: 'ia_indisponivel', mensagem: abortou ? 'A IA demorou demais. Tente de novo.' : 'A IA não respondeu agora (' + String((e && e.message) || e).slice(0, 100) + ').' });
  }
};

module.exports._interno = { limparEstado, acoesPropostas, FERRAMENTAS };
