// Endpoint /api/arquivar: arquivamento de operação encerrada (migração 055).
// O Supabase (funções e Storage) é simulado em memória: nenhum dado real é tocado.
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const assert = require('assert');
const ARQ = path.join(__dirname, '..', 'api', 'arquivar.js');
let falhas = 0;
async function teste(nome, fn) {
  try { await fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
function carregar() { delete require.cache[ARQ]; return require(ARQ); }
function resposta() {
  return { code: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const OP = '11111111-2222-4333-8444-555555555555';
function ambiente(extra) {
  ['ARQUIVAR_APOS_DIAS', 'CRON_SECRET'].forEach((k) => delete process.env[k]);
  Object.assign(process.env, { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'pub', SUPABASE_SECRET_KEY: 'sb_secret_x', CRON_SECRET: 'segredo' }, extra || {});
}
const req = (metodo, corpo, auth) => ({ method: metodo, body: corpo, headers: auth ? { authorization: 'Bearer ' + auth } : {} });
const linhas = (n, pre) => Array.from({ length: n }, (_, i) => ({ id: pre + i, operacao_id: OP, lat: -22.9 }));

// Supabase em memória. opcoes: { tabelas: {nome: n}, pode, corromper, confirmarErro, faltarLinha }
function supabase(opcoes) {
  opcoes = opcoes || {};
  const tab = opcoes.tabelas || { posicoes: 3, participantes: 2, vitimas: 1 };
  const dados = {}; Object.keys(tab).forEach((k) => { dados[k] = linhas(tab[k], k + '-'); });
  const s = { chamadas: [], storage: {}, confirmado: null, removidos: [] };
  global.fetch = async (url, op) => {
    op = op || {};
    const metodo = op.method || 'GET';
    s.chamadas.push(metodo + ' ' + url.replace('https://proj.supabase.co', ''));
    const json = (obj, st) => ({ ok: (st || 200) < 300, status: st || 200, json: async () => obj, text: async () => JSON.stringify(obj) });
    if (url.endsWith('/rpc/arquivo_pode_arquivar')) return opcoes.pode === false ? json({ message: 'sem_permissao' }, 400) : json({ ok: true });
    if (url.endsWith('/rpc/servidor_arquivo_candidatas')) return json([OP]);
    if (url.endsWith('/rpc/servidor_arquivo_preparar')) {
      return json({ operacao: { id: OP, codigo: 'OP 1' }, tabelas: Object.keys(tab).map((k) => ({ tabela: k, total: tab[k], apagar: k !== 'vitimas' })),
        leituras: { relatorio_operacao: { operacao: { codigo: 'OP 1' } } }, storage: [{ bucket: 'fotos', caminho: OP + '/a/b.jpg' }] });
    }
    if (url.endsWith('/rpc/servidor_arquivo_tabela')) {
      const a = JSON.parse(op.body);
      let lista = dados[a.p_tabela].slice(a.p_inicio, a.p_inicio + a.p_limite);
      if (opcoes.faltarLinha === a.p_tabela && a.p_inicio === 0) lista = lista.slice(1);
      return json(lista);
    }
    if (url.endsWith('/rpc/servidor_arquivo_confirmar')) {
      s.confirmado = JSON.parse(op.body);
      if (opcoes.confirmarErro) return json({ message: opcoes.confirmarErro }, 400);
      return json({ apagadas: s.confirmado.p_contagens });
    }
    const m = url.match(/\/storage\/v1\/object\/arquivos\/(.+)$/);
    if (m && metodo === 'POST') { s.storage[m[1]] = Buffer.from(op.body); return json({ Key: m[1] }); }
    if (m && metodo === 'GET') {
      let b = s.storage[m[1]];
      if (!b) return json({}, 404);
      if (opcoes.corromper) { b = Buffer.from(b); b[b.length - 5] ^= 0xff; }
      return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    }
    if (url.endsWith('/storage/v1/object/arquivos') && metodo === 'DELETE') {
      const p = JSON.parse(op.body).prefixes; s.removidos.push(...p); p.forEach((k) => delete s.storage[k]); return json([]);
    }
    throw new Error('rede inesperada: ' + metodo + ' ' + url);
  };
  return s;
}

(async () => {
  console.log('Arquivamento de operação encerrada: /api/arquivar');

  await teste('sem login: 401; operação que não é identificador: 400', async () => {
    ambiente(); supabase();
    const r = resposta(); await carregar()(req('POST', { operacao_id: OP }), r);
    assert.strictEqual(r.code, 401);
    const r2 = resposta(); await carregar()(req('POST', { operacao_id: 'x' }, 'tok'), r2);
    assert.strictEqual(r2.code, 400);
  });
  await teste('quem não pode arquivar: 403, sem exportar nem enviar nada', async () => {
    ambiente(); const s = supabase({ pode: false });
    const r = resposta(); await carregar()(req('POST', { operacao_id: OP }, 'tok'), r);
    assert.strictEqual(r.code, 403);
    assert.ok(!s.chamadas.some((c) => /servidor_arquivo|storage/.test(c)));
  });
  await teste('arquiva: exporta, compacta, envia, baixa de volta, confere e só então confirma', async () => {
    ambiente(); const s = supabase();
    const r = resposta(); await carregar()(req('POST', { operacao_id: OP }, 'tok'), r);
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.ok, true);
    const caminho = Object.keys(s.storage)[0];
    assert.ok(new RegExp('^' + OP + '/[0-9a-f-]{36}\\.json\\.gz$').test(caminho), 'caminho na pasta da operação');
    const gz = s.storage[caminho];
    const doc = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
    assert.strictEqual(doc.formato, 'gbs-arquivo-operacao');
    assert.strictEqual(doc.tabelas.posicoes.length, 3);
    assert.ok(doc.leituras.relatorio_operacao, 'o arquivo leva o relatório completo');
    assert.deepStrictEqual(s.confirmado.p_contagens, { posicoes: 3, participantes: 2, vitimas: 1 });
    assert.strictEqual(s.confirmado.p_bytes, gz.length);
    assert.strictEqual(s.confirmado.p_sha256, crypto.createHash('sha256').update(gz).digest('hex'));
    const iGet = s.chamadas.findIndex((c) => c.startsWith('GET /storage'));
    const iConf = s.chamadas.findIndex((c) => c.includes('servidor_arquivo_confirmar'));
    assert.ok(iGet >= 0 && iGet < iConf, 'baixa de volta e confere ANTES de confirmar');
  });
  await teste('tabela grande: exporta em páginas e não perde linha', async () => {
    ambiente(); const s = supabase({ tabelas: { posicoes: 12001, participantes: 1 } });
    const r = resposta(); await carregar()(req('POST', { operacao_id: OP }, 'tok'), r);
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(s.chamadas.filter((c) => c.includes('servidor_arquivo_tabela')).length, 3 + 1);
    assert.strictEqual(s.confirmado.p_contagens.posicoes, 12001);
  });
  await teste('exportação com linha faltando: recusa, sem enviar e sem confirmar', async () => {
    ambiente(); const s = supabase({ faltarLinha: 'posicoes' });
    const r = resposta(); await carregar()(req('POST', { operacao_id: OP }, 'tok'), r);
    assert.strictEqual(r.code, 502); assert.strictEqual(r.body.erro, 'exportacao_incompleta');
    assert.strictEqual(Object.keys(s.storage).length, 0);
    assert.strictEqual(s.confirmado, null, 'não confirma: nada é apagado');
  });
  await teste('arquivo diferente ao baixar de volta: remove o envio e não confirma', async () => {
    ambiente(); const s = supabase({ corromper: true });
    const r = resposta(); await carregar()(req('POST', { operacao_id: OP }, 'tok'), r);
    assert.strictEqual(r.code, 502); assert.strictEqual(r.body.erro, 'arquivo_divergente');
    assert.strictEqual(s.confirmado, null, 'não confirma: nada é apagado');
    assert.strictEqual(s.removidos.length, 1, 'o arquivo enviado é removido');
    assert.strictEqual(Object.keys(s.storage).length, 0);
  });
  await teste('banco recusa a confirmação (contagem mudou): remove o arquivo enviado', async () => {
    ambiente(); const s = supabase({ confirmarErro: 'arquivo_divergente' });
    const r = resposta(); await carregar()(req('POST', { operacao_id: OP }, 'tok'), r);
    assert.strictEqual(r.code, 502); assert.strictEqual(r.body.erro, 'arquivo_divergente');
    assert.strictEqual(s.removidos.length, 1);
  });
  await teste('cron: segredo errado 401; com o segredo arquiva as candidatas', async () => {
    ambiente(); supabase();
    const r = resposta(); await carregar()(req('GET', null, 'errado'), r);
    assert.strictEqual(r.code, 401);
    ambiente({ ARQUIVAR_APOS_DIAS: '3' }); const s = supabase();
    const r2 = resposta(); await carregar()(req('GET', null, 'segredo'), r2);
    assert.strictEqual(r2.code, 200, JSON.stringify(r2.body));
    assert.strictEqual(r2.body.dias, 3);
    assert.strictEqual(r2.body.arquivadas.length, 1);
    assert.strictEqual(r2.body.falhas.length, 0);
    assert.ok(s.confirmado);
  });
  await teste('conferência do arquivo: tabela a mais ou a menos é divergência', async () => {
    const { conferirArquivo } = carregar()._teste;
    const doc = { formato: 'gbs-arquivo-operacao', versao: 1, operacao: { id: OP }, tabelas: { a: [1, 2] } };
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(doc)));
    const env = { bytes: gz.length, sha256: crypto.createHash('sha256').update(gz).digest('hex') };
    assert.doesNotThrow(() => conferirArquivo(gz, env, OP, { a: 2 }));
    assert.throws(() => conferirArquivo(gz, env, OP, { a: 2, b: 0 }), /arquivo_divergente/);
    assert.throws(() => conferirArquivo(gz, env, OP, { a: 3 }), /arquivo_divergente/);
    assert.throws(() => conferirArquivo(gz, env, '00000000-0000-4000-8000-000000000000', { a: 2 }), /operação/);
  });

  console.log(falhas ? '\nFalhas: ' + falhas : '\nArquivamento (API): todos OK');
  process.exit(falhas ? 1 : 0);
})();
