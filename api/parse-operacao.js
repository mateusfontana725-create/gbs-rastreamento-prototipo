// POST /api/parse-operacao  →  transforma o que foi DITO (texto da transcrição por voz) nos campos do formulário
// "Nova operação". A IA só EXTRAI: devolve os valores para a tela preencher; a pessoa revisa e só ela cria a
// operação (botão "Criar operação"). Nada é gravado aqui.
//
// Campos (os que já existem no formulário de nova operação): nome ou código, endereço/município/região, ponto (coordenada
// falada), natureza (da lista do formulário ou "outro"), nome do solicitante, observação e vítimas (nome, idade, sexo,
// origem, características, roupas, observações).
//
// Corpo JSON: { "texto": "<transcrição>", "naturezas": ["BUSCA TERRESTRE – PESSOA", …] }  (a lista vem da própria tela)
// Resposta 200: { modelo, campos: { codigo, endereco, coordenada, natureza, natureza_outra, solicitante_nome, descricao,
//   vitimas: [{ nome, idade, sexo, origem, caracteristicas, roupas, observacoes }] }, faltando: [nomes dos campos vazios] }
//   Campo não dito volta null (a IA não inventa). Resposta incompleta: devolve o que der.
// Falhas: 401 sem login; 503 IA sem chave ou sobrecarregada/cota depois das novas tentativas (tentar_de_novo); 502 outro erro.
// Segurança: precisa do token de login (conferido no Supabase); chave GEMINI_API_KEY só no servidor; limite por minuto.

const G = require('./_gemini');

const LIMITE_POR_MIN = 10;
const MAX_TEXTO = 3000;
const limitar = G.criarLimite(LIMITE_POR_MIN);

const texto = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const textoOuNulo = (v, max) => { const t = texto(v, max); return t ? t : null; };

function esquema(naturezas) {
  const s = (descricao) => ({ type: 'STRING', nullable: true, description: descricao });
  return {
    type: 'OBJECT',
    properties: {
      codigo: s('Nome ou código curto da operação, se foi dito (ex.: "BUSCA SERRA AZUL 09/10"). Não invente.'),
      endereco: s('Endereço, município, região ou referência do local da operação, como foi dito.'),
      coordenada: s('Coordenada geográfica, só se foi dita em números (ex.: "-25.4281, -49.3205" ou UTM "22J 650000 7190000").'),
      natureza: naturezas.length
        ? { type: 'STRING', nullable: true, enum: naturezas, description: 'Natureza da ocorrência, SÓ se corresponder a um item da lista.' }
        : s('Natureza da ocorrência.'),
      natureza_outra: s('Natureza da ocorrência quando NÃO está na lista (ex.: "corte de árvores após vendaval").'),
      solicitante_nome: s('Nome de quem acionou/solicitou, se foi dito.'),
      descricao: s('Breve descrição do que aconteceu (quem, onde, circunstâncias), em português, com as palavras de quem falou.'),
      vitimas: {
        type: 'ARRAY',
        description: 'Pessoas desaparecidas ou vítimas citadas. Lista vazia se nenhuma.',
        items: {
          type: 'OBJECT',
          properties: {
            nome: s('Nome da vítima ou "Não identificada".'),
            idade: { type: 'INTEGER', nullable: true, description: 'Idade em anos, se dita.' },
            sexo: { type: 'STRING', nullable: true, enum: ['M', 'F'], description: 'M para masculino, F para feminino; null se não dito.' },
            origem: s('Cidade ou bairro de onde a vítima é.'),
            caracteristicas: s('Características físicas (altura, cabelo, sinais).'),
            roupas: s('Roupas, calçado, acessórios.'),
            observacoes: s('Saúde, medicamentos, hábitos, último contato.'),
          },
        },
      },
    },
  };
}

const REGRAS = [
  'Você extrai dados de um relato falado para preencher o formulário de abertura de uma operação do Corpo de Bombeiros (CBMPR).',
  'Use SOMENTE o que está no texto. Campo que não foi dito fica null (ou lista vazia). Nunca invente nomes, idades, locais nem coordenadas.',
  'Não tome decisões nem faça recomendações: só organize o que foi dito. Responda em português do Brasil, só com o JSON pedido.',
].join(' ');

// Limpa a resposta da IA: só os campos do formulário, com os tamanhos máximos do formulário; o resto é ignorado.
function normalizar(bruto, naturezas) {
  const b = bruto && typeof bruto === 'object' ? bruto : {};
  let natureza = textoOuNulo(b.natureza, 300), outra = textoOuNulo(b.natureza_outra, 300);
  if (natureza && naturezas.indexOf(natureza) === -1) { outra = outra || natureza; natureza = null; }
  const vitimas = (Array.isArray(b.vitimas) ? b.vitimas : []).slice(0, 5).map((v) => {
    v = v && typeof v === 'object' ? v : {};
    const idade = typeof v.idade === 'number' && Number.isInteger(v.idade) && v.idade >= 0 && v.idade <= 130 ? v.idade : null;
    return {
      nome: textoOuNulo(v.nome, 80), idade, sexo: v.sexo === 'M' || v.sexo === 'F' ? v.sexo : null,
      origem: textoOuNulo(v.origem, 120), caracteristicas: textoOuNulo(v.caracteristicas, 1000), roupas: textoOuNulo(v.roupas, 1000), observacoes: textoOuNulo(v.observacoes, 2000),
    };
  }).filter((v) => Object.keys(v).some((k) => v[k] != null));
  const campos = {
    codigo: textoOuNulo(b.codigo, 80), endereco: textoOuNulo(b.endereco, 300), coordenada: textoOuNulo(b.coordenada, 80),
    natureza, natureza_outra: natureza ? null : outra, solicitante_nome: textoOuNulo(b.solicitante_nome, 120),
    descricao: typeof b.descricao === 'string' ? (b.descricao.trim().slice(0, 2000) || null) : null, vitimas,
  };
  const faltando = ['codigo', 'endereco', 'natureza', 'solicitante_nome', 'descricao'].filter((k) => !campos[k] && !(k === 'natureza' && campos.natureza_outra));
  return { campos, faltando };
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
  const corpo = await G.lerCorpo(req, 20000);
  const fala = texto(corpo.texto, MAX_TEXTO);
  if (!fala) return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Nada foi transcrito. Fale de novo ou digite.' });
  const naturezas = (Array.isArray(corpo.naturezas) ? corpo.naturezas : []).slice(0, 20).map((n) => texto(n, 120)).filter(Boolean);
  try {
    const u = await G.usuarioDoToken(url, chavePublica, token);
    if (!u) return res.status(401).json({ erro: 'nao_autenticado' });
    if (!chaveIa) return res.status(503).json({ erro: 'ia_nao_configurada', mensagem: 'A IA não está configurada neste servidor (falta GEMINI_API_KEY). Preencha o formulário à mão.' });
    if (!limitar(u.id)) return res.status(429).json({ erro: 'muitos_pedidos', mensagem: 'Muitos pedidos em pouco tempo. Aguarde um minuto.' });
    const prompt = { system: REGRAS, user: 'Relato falado (transcrição automática, pode ter erros):\n"""\n' + fala + '\n"""', schema: esquema(naturezas), maxTokens: 2048 };
    const r = await G.comNovasTentativas((m) => G.chamarGemini(chaveIa, m, prompt), G.modelosGemini(), { rotulo: 'parse-operacao' });
    if (r.esgotou) return res.status(503).json({ erro: r.status === 429 ? 'ia_cota' : 'ia_sobrecarregada', tentar_de_novo: true, mensagem: G.mensagemEsgotada(r) + ' O texto falado continua na tela.' });
    if (r.status === 401 || r.status === 403) return res.status(503).json({ erro: 'ia_nao_configurada', mensagem: 'A chave da IA (GEMINI_API_KEY) foi recusada pelo Gemini. Confira a chave na Vercel.' });
    if (!r.ok) return res.status(502).json({ erro: 'ia_indisponivel', mensagem: `A IA (${r.modelo}) respondeu com erro ${r.status}${r.motivo ? ': ' + r.motivo : ''}.` });
    const bruto = G.extrairJson(r.texto);
    const n = normalizar(bruto, naturezas);   // resposta ruim ou vazia: campos nulos (a tela preenche o que der)
    return res.status(200).json({ modelo: r.modelo, campos: n.campos, faltando: n.faltando, incompleto: !bruto });
  } catch (e) {
    const abortou = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
    return res.status(502).json({ erro: 'ia_indisponivel', mensagem: abortou ? 'A IA demorou demais. Tente de novo ou preencha à mão.' : 'A IA não respondeu agora (' + String((e && e.message) || e).slice(0, 100) + ').' });
  }
};

module.exports._interno = { normalizar, esquema };
