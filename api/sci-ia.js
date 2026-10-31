// POST /api/sci-ia  →  assistente OPCIONAL do Posto de Comando (SCI): lê a mensagem do comandante (texto ou voz já
// transcrita) e devolve AÇÕES propostas para o painel, uma resposta curta e o que ainda falta (segurança primeiro).
//
// Nada é gravado aqui: a tela mostra as ações para o comandante conferir e só então grava pelas funções do banco.
// As ações passam pela mesma validação da leitura local (public/js/sci-core.js, normalizarAcoes): ação desconhecida
// ou campo inválido é descartado. A IA não inventa dados: campo sem informação fica de fora ([PENDENTE] na tela).
//
// Corpo JSON: { "operacao_id": "<uuid>", "texto": "V-03 na ACV, amarela", "contexto": { agora, vitimas, orgaos, equipes, marcos, funcoes, total } }
// Resposta 200: { modelo, acoes: [...], resposta, faltando: [...] }
// Mesma configuração de provedor do /api/poa-ia (ANTHROPIC_API_KEY ou GEMINI_API_KEY; POA_IA_PROVEDOR; POA_IA_MODELO).
// Segurança: o banco confere, com o login de quem chama, que é responsável da operação (dono_operacao).

const SciCore = require('../public/js/sci-core.js');
const { perguntar, configurarIa, rpcUsuario, extrairJson } = require('./poa-ia.js')._interno;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITE_POR_MIN = 12;
const contagem = new Map();

function lerCorpo(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 30000) req.destroy(); });
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
const txt = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const lista = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);

// Contexto mínimo para a IA (sem nomes de vítimas, CPF ou telefone)
function limparContexto(c) {
  c = c && typeof c === 'object' ? c : {};
  return {
    agora: txt(c.agora, 40),
    vitimas: lista(c.vitimas, 300).map((v) => ({ numero: Number(v && v.numero) || null, fase: txt(v && v.fase, 20), triagem: txt(v && v.triagem, 20) || null, sexo: txt(v && v.sexo, 1) || null })),
    orgaos: lista(c.orgaos, 60).map((o) => txt(o, 80)).filter(Boolean),
    equipes: lista(c.equipes, 60).map((o) => txt(o, 80)).filter(Boolean),
    marcos: lista(c.marcos, 20).map((o) => txt(o, 30)).filter(Boolean),
    funcoes: lista(c.funcoes, 10).map((o) => txt(o, 120)).filter(Boolean),
    total: Number.isInteger(c.total) ? c.total : null,
    tipo: txt(c.tipo, 40),
  };
}

function montarPrompt(texto, ctx) {
  const system = [
    'Você é o assistente do Posto de Comando de uma ocorrência do Corpo de Bombeiros, no Sistema de Comando em Incidentes (SCI).',
    'O comandante manda frases curtas (às vezes transcritas de áudio). Converta cada informação em AÇÕES para o painel de comando.',
    'Regras: nunca invente dados; o que não foi dito fica de fora. Informação de terceiros não confirmada pela equipe: nao_confirmada = true.',
    'Horários: ISO 8601 com o fuso -03:00, no dia de "agora" (se a hora não foi dita, omita "em"). Vítimas são numeradas V-01, V-02…',
    'A cor da triagem (verde, amarelo, vermelho, cinza = óbito) só vale depois da triagem na ACV.',
    'Responda SOMENTE com JSON: {"acoes":[...],"resposta":"confirmação curta em português","faltando":["o que ainda falta saber, segurança primeiro"]}.',
    'Ações possíveis (use exatamente estes nomes e valores):',
    '{"acao":"marco","marco":"acionamento|despacho|chegada|pc|comunicacoes|sci|danos|identificacao|localizacao|resgate|consolidacao|termino","em":"…"}',
    '{"acao":"vitima_nova","numero":N?,"sexo":"M|F"?,"idade":N?,"local":"…"?,"fase":"localizada|removida|transportada"?,"triagem":"verde|amarelo|vermelho|cinza"?,"destino":"…"?,"em":"…"?}',
    '{"acao":"vitima","numero":N,"fase":…?,"triagem":…?,"sexo":…?,"idade":…?,"destino":…?,"nome":…?,"em":…?}   (vítima que já está no quadro)',
    '{"acao":"total","total":N,"confirmado":true|false}',
    '{"acao":"funcao","funcao":"ci|seguranca|operacoes|logistica|planejamento|ligacao|informacao_publica|adm_financas","nome":"…","acumula_ci":true|false}',
    '{"acao":"orgao","nome":"…","situacao":"acionado|a_caminho|no_local|desmobilizado"?,"pessoas":N?,"viaturas":N?,"missao":"…"?,"em":…?}',
    '{"acao":"equipe","nome":"…","status":"designada|em_deslocamento|em_operacao|disponivel|desmobilizada"?,"efetivo":N?,"missao":"…"?,"chefe":"…"?,"orgao":"…"?,"meios":"…"?}',
    '{"acao":"recurso","nome":"…","tipo":"viatura|embarcacao|aeronave|equipamento|outro"?,"status":"solicitado|a_caminho|no_local|em_uso|indisponivel|desmobilizado"?,"orgao":"…"?,"qtd":N?,"local":"…"?,"nota":"…"?,"em":…?}',
    '{"acao":"instalacao","tipo":"pc|area_espera|acv|zpa|abrigo|ggi|outra","estado":"ativa|planejada|desativada"?,"nome":"…"?,"responsavel":"…"?,"local":"…"?,"motivo":"…"?}',
    '{"acao":"leitura_rio","nivel":"…"?,"tendencia":"subindo|estavel|descendo|a_confirmar","ponto":"…"?,"vazao":"…"?,"fonte":"…"?,"em":…?}',
    '{"acao":"situacao","texto":"situação atual resumida"}',
    '{"acao":"evento","categoria":"decisao|seguranca|resgate|informacao|recurso|comunicacao","texto":"…","nao_confirmada":true|false,"em":…?}',
    'Use "evento" para o que não cabe nas outras ações (decisões, riscos, andamento do resgate). Uma frase pode gerar várias ações.',
  ].join('\n');
  const user = 'Situação atual do painel (JSON): ' + JSON.stringify(ctx) + '\n\nMensagem do comandante: ' + JSON.stringify(texto);
  return { system, user };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ erro: 'metodo_nao_permitido' });
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const chavePublica = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  const { prov, chave, modelo, variavel } = configurarIa();
  if (!url || !chavePublica) return res.status(500).json({ erro: 'variaveis_de_ambiente_ausentes' });
  const token = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ erro: 'nao_autenticado' });
  const corpo = await lerCorpo(req);
  const texto = txt(corpo.texto, 2000);
  if (!UUID_RE.test(String(corpo.operacao_id || '')) || !texto) return res.status(400).json({ erro: 'dados_invalidos' });
  try {
    const v = await rpcUsuario(url, chavePublica, token, 'dono_operacao', { p_operacao: corpo.operacao_id });
    if (v.status === 401) return res.status(401).json({ erro: 'nao_autenticado' });
    if (v.dados !== true) return res.status(403).json({ erro: 'sem_permissao' });
    if (!chave) return res.status(503).json({ erro: 'ia_nao_configurada', mensagem: `A IA não está configurada neste servidor (falta ${variavel}). A leitura das frases no próprio painel continua funcionando.` });
    if (!limitar(token.slice(-24))) return res.status(429).json({ erro: 'muitos_pedidos', mensagem: 'Muitas mensagens à IA em pouco tempo. Aguarde um minuto.' });
    const ctx = limparContexto(corpo.contexto);
    const r = await perguntar(prov, chave, modelo, montarPrompt(texto, ctx));
    if (r.status === 429) return res.status(503).json({ erro: 'ia_cota', mensagem: `A IA (${prov}) atingiu o limite de uso agora. Use a leitura do painel ou tente em alguns minutos.` });
    if (r.status === 401 || r.status === 403) return res.status(503).json({ erro: 'ia_nao_configurada', mensagem: `A chave da IA (${variavel}) foi recusada pelo provedor ${prov}.` });
    if (!r.ok) return res.status(502).json({ erro: 'ia_indisponivel', mensagem: `A IA (${prov}) respondeu com erro ${r.status}. Use a leitura do painel ou tente de novo.` });
    const bruto = extrairJson(r.texto);
    if (!bruto || !Array.isArray(bruto.acoes)) return res.status(502).json({ erro: 'ia_resposta_invalida', mensagem: 'A IA devolveu uma resposta que não dá para usar. Tente de novo ou registre manualmente.' });
    const d = { vitimas: ctx.vitimas, estado: {}, itens: [] };
    return res.status(200).json({
      modelo,
      acoes: SciCore.normalizarAcoes(bruto.acoes, d),
      resposta: txt(bruto.resposta, 400),
      faltando: lista(bruto.faltando, 8).map((x) => txt(x, 200)).filter(Boolean),
    });
  } catch (e) {
    const abortou = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
    return res.status(502).json({ erro: 'ia_indisponivel', mensagem: abortou ? 'A IA demorou demais. Registre manualmente ou tente de novo.' : 'A IA não respondeu agora. Registre manualmente ou tente de novo.' });
  }
};

module.exports._interno = { limparContexto, montarPrompt };
