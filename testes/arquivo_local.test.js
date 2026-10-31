// Leitura de operação arquivada (js/arquivo-local.js) e a ligação com comunicacao.js.
// 1) núcleo: os operadores do supabase-js aplicados às linhas do arquivo;
// 2) comunicacao.js de verdade, num ambiente simulado: operação arquivada responde do arquivo e as demais
//    consultas chegam ao servidor com a MESMA cadeia de chamadas de antes.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const A = require('../public/js/arquivo-local.js');
let falhas = 0;
async function teste(nome, fn) {
  try { await fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
const OP = '11111111-2222-4333-8444-555555555555';
const OUTRA = '99999999-2222-4333-8444-555555555555';
const doc = () => ({
  formato: 'gbs-arquivo-operacao', versao: 1, operacao: { id: OP, codigo: 'OP 1' },
  contagens: { posicoes: 4, participantes: 3, diario_versoes: 1 },
  tabelas: {
    posicoes: [
      { id: 3, operacao_id: OP, participante_id: 'p1', registrado_em: '2026-10-28T14:00:02+00:00' },
      { id: 1, operacao_id: OP, participante_id: 'p1', registrado_em: '2026-10-28T14:00:00+00:00' },
      { id: 2, operacao_id: OP, participante_id: 'p2', registrado_em: '2026-10-28T14:00:01+00:00' },
      { id: 10, operacao_id: OP, participante_id: 'p2', registrado_em: null },
    ],
    participantes: [
      { id: 'p1', operacao_id: OP, tipo: 'militar', removido: false, nome: 'Ana', saiu_em: null },
      { id: 'p2', operacao_id: OP, tipo: 'civil', removido: true, nome: 'Beto', saiu_em: '2026-10-28T15:00:00+00:00' },
      { id: 'r1', operacao_id: OP, tipo: 'responsavel', removido: false, nome: 'Sgt', saiu_em: null },
    ],
    diario_versoes: [{ id: 7, diario_id: 42, versao: 1, operacao_id: OP }],
  },
  leituras: { relatorio_operacao: { gerado_em: '2026-10-28T20:00:00Z', gerado_por_nome: 'Arquivamento', operacao: { id: OP, codigo: 'OP 1', resultado: null, resultado_texto: '' } } },
});
const reg = () => ({ [OP]: { doc: doc(), extras: { operacao: { id: OP, codigo: 'OP 1', resultado: 'localizada_viva', resultado_texto: 'Na trilha', outra_coluna: 'x' }, usuarioNome: 'Cap. Souza' } } });
const passos = (...p) => p;

(async () => {
  console.log('Operação arquivada: leitura pelo arquivo (arquivo-local.js)');

  await teste('select com colunas, eq e order crescente', async () => {
    const r = A.aplicar(doc().tabelas.posicoes, passos(['select', ['id,participante_id']], ['eq', ['participante_id', 'p1']], ['order', ['id', { ascending: true }]]));
    assert.deepStrictEqual(r.data, [{ id: 1, participante_id: 'p1' }, { id: 3, participante_id: 'p1' }]);
    assert.strictEqual(r.error, null);
  });
  await teste('order: nulos por último na crescente e primeiro na decrescente (como o PostgreSQL)', async () => {
    const asc = A.aplicar(doc().tabelas.posicoes, passos(['select', ['*']], ['order', ['registrado_em', { ascending: true }]])).data.map((x) => x.id);
    const desc = A.aplicar(doc().tabelas.posicoes, passos(['select', ['*']], ['order', ['registrado_em', { ascending: false }]])).data.map((x) => x.id);
    assert.deepStrictEqual(asc, [1, 2, 3, 10]);
    assert.deepStrictEqual(desc, [10, 3, 2, 1]);
  });
  await teste('datas em formatos diferentes (+00:00 e Z) comparam pelo instante', async () => {
    const r = A.aplicar(doc().tabelas.posicoes, passos(['select', ['id']], ['gte', ['registrado_em', '2026-10-28T14:00:01.000Z']], ['order', ['id']]));
    assert.deepStrictEqual(r.data.map((x) => x.id), [2, 3]);
  });
  await teste('neq, is null, in, limit e contagem sem linhas (head)', async () => {
    const parts = doc().tabelas.participantes;
    assert.deepStrictEqual(A.aplicar(parts, passos(['select', ['id']], ['neq', ['tipo', 'responsavel']], ['eq', ['removido', false]])).data, [{ id: 'p1' }]);
    assert.deepStrictEqual(A.aplicar(parts, passos(['select', ['id']], ['is', ['saiu_em', null]])).data.map((x) => x.id), ['p1', 'r1']);
    assert.deepStrictEqual(A.aplicar(parts, passos(['select', ['id']], ['in', ['id', ['r1', 'p2']]])).data.map((x) => x.id), ['p2', 'r1']);
    assert.strictEqual(A.aplicar(parts, passos(['select', ['*']], ['limit', [2]])).data.length, 2);
    const c = A.aplicar(parts, passos(['select', ['id', { count: 'exact', head: true }]], ['neq', ['tipo', 'responsavel']], ['eq', ['removido', false]]));
    assert.strictEqual(c.count, 1); assert.strictEqual(c.data, null);
  });
  await teste('range pagina como o consultarTudo (páginas sem repetir nem perder)', async () => {
    const t = doc().tabelas.posicoes;
    const p1 = A.aplicar(t, passos(['select', ['id']], ['order', ['id']], ['range', [0, 1]])).data.map((x) => x.id);
    const p2 = A.aplicar(t, passos(['select', ['id']], ['order', ['id']], ['range', [2, 3]])).data.map((x) => x.id);
    assert.deepStrictEqual(p1.concat(p2), [1, 2, 3, 10]);
  });
  await teste('maybeSingle e single', async () => {
    const parts = doc().tabelas.participantes;
    assert.strictEqual(A.aplicar(parts, passos(['select', ['*']], ['eq', ['id', 'p1']], ['maybeSingle', []])).data.nome, 'Ana');
    assert.strictEqual(A.aplicar(parts, passos(['select', ['*']], ['eq', ['id', 'zz']], ['maybeSingle', []])).data, null);
    assert.ok(A.aplicar(parts, passos(['select', ['*']], ['single', []])).error, 'single com várias linhas é erro, como no supabase-js');
  });
  await teste('operador desconhecido: erro claro (não volta vazio em silêncio)', async () => {
    const r = A.aplicar(doc().tabelas.posicoes, passos(['select', ['*']], ['ilike', ['x', '%a%']]));
    assert.ok(r.error && /operação arquivada/.test(r.error.message));
  });
  await teste('as linhas devolvidas são cópias (quem altera não estraga o arquivo)', async () => {
    const d = doc();
    const r = A.aplicar(d.tabelas.participantes, passos(['select', ['*']], ['eq', ['id', 'p1']]));
    r.data[0].nome = 'Mudado';
    assert.strictEqual(d.tabelas.participantes[0].nome, 'Ana');
  });
  await teste('escolhe o arquivo: filtro operacao_id desta operação → arquivo; de outra → servidor', async () => {
    const r = reg();
    assert.ok(A.resolver(r, 'posicoes', passos(['select', ['*']], ['eq', ['operacao_id', OP]])));
    assert.strictEqual(A.resolver(r, 'posicoes', passos(['select', ['*']], ['eq', ['operacao_id', OUTRA]])), null);
    assert.strictEqual(A.resolver(r, 'relatorios', passos(['select', ['*']], ['eq', ['operacao_id', OP]])), null, 'tabela que ficou no banco vai ao servidor');
  });
  await teste('sem operacao_id: usa o arquivo só se as linhas batem com o filtro (ex.: versões do diário)', async () => {
    const r = reg();
    assert.strictEqual(A.resolver(r, 'diario_versoes', passos(['select', ['*']], ['eq', ['diario_id', 42]])).data.length, 1);
    assert.strictEqual(A.resolver(r, 'diario_versoes', passos(['select', ['*']], ['eq', ['diario_id', 43]])), null);
    assert.strictEqual(A.resolver(r, 'tipos_ponto', passos(['select', ['*']])), null, 'tabela geral vai ao servidor');
  });
  await teste('relatório completo vem do arquivo com o resultado e o nome atuais', async () => {
    const r = A.resolverRpc(reg(), 'relatorio_operacao', { p_operacao: OP });
    assert.strictEqual(r.operacao.resultado, 'localizada_viva');
    assert.strictEqual(r.operacao.resultado_texto, 'Na trilha');
    assert.ok(!('outra_coluna' in r.operacao), 'só as colunas que o relatório já tinha');
    assert.strictEqual(r.gerado_por_nome, 'Cap. Souza');
    assert.notStrictEqual(r.gerado_em, '2026-10-28T20:00:00Z');
  });
  await teste('leitura que não foi guardada: erro "operacao_arquivada"; outras funções e operações vão ao servidor', async () => {
    assert.throws(() => A.resolverRpc(reg(), 'sci_contexto', { p_operacao: OP }), (e) => e.codigo === 'operacao_arquivada');
    assert.strictEqual(A.resolverRpc(reg(), 'listar_responsaveis', { p_operacao: OP }), undefined);
    assert.strictEqual(A.resolverRpc(reg(), 'relatorio_operacao', { p_operacao: OUTRA }), undefined);
  });
  await teste('validação: arquivo de outra operação ou com tabela incompleta é recusado', async () => {
    assert.throws(() => A.validar(doc(), OUTRA), /outra operação/);
    const d = doc(); d.tabelas.posicoes.pop();
    assert.throws(() => A.validar(d, OP), /incompleto/);
    assert.doesNotThrow(() => A.validar(doc(), OP));
  });

  // ---- comunicacao.js de verdade, com supabase-js simulado ----
  await teste('comunicacao.js: operação arquivada responde do arquivo; as demais vão ao servidor com a mesma cadeia', async () => {
    const enviados = [];
    function construtor(tabela) {
      const cadeia = [];
      const b = new Proxy({}, { get(_, nome) {
        if (nome === 'then') return (ok, erro) => { enviados.push({ tabela, cadeia: JSON.stringify(cadeia) }); return Promise.resolve({ data: ['do servidor'], error: null }).then(ok, erro); };
        return (...args) => { cadeia.push([nome, args]); return b; };
      } });
      return b;
    }
    const janela = {
      APP_CONFIG: { supabaseUrl: 'https://x.supabase.co', supabaseKey: 'k' },
      supabase: { createClient: () => ({ from: construtor, rpc: async (n) => ({ data: 'rpc ' + n, error: null }), auth: {}, storage: {} }) },
      ArquivoLocal: A, Proxy, setTimeout, clearTimeout, navigator: { onLine: true },
    };
    janela.window = janela;
    const ctx = vm.createContext(Object.assign(janela, { document: { documentElement: { getAttribute: () => 'app' } }, console, Promise, Date, Math, JSON }));
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'comunicacao.js'), 'utf8'), ctx);
    const C = janela.Comunicacao;
    A.registrar(OP, doc(), { operacao: { id: OP } });
    const local = await C.consultar(C.cliente.from('posicoes').select('id').eq('operacao_id', OP).order('id', { ascending: true }));
    assert.deepStrictEqual(local, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 10 }]);
    assert.strictEqual(enviados.length, 0, 'nada foi ao servidor');
    const vivo = await C.consultar(C.cliente.from('posicoes').select('id').eq('operacao_id', OUTRA).order('id', { ascending: true }).range(0, 999));
    assert.deepStrictEqual(vivo, ['do servidor']);
    assert.strictEqual(enviados.length, 1);
    assert.strictEqual(enviados[0].cadeia, JSON.stringify([['select', ['id']], ['eq', ['operacao_id', OUTRA]], ['order', ['id', { ascending: true }]], ['range', [0, 999]]]), 'mesma cadeia de chamadas de antes');
    const todas = await C.consultarTudo(() => C.cliente.from('participantes').select('*').eq('operacao_id', OP).order('id'), 2);
    assert.strictEqual(todas.length, 3, 'consultarTudo pagina sobre o arquivo');
    const rel = await C.rpc('relatorio_operacao', { p_operacao: OP });
    assert.strictEqual(rel.operacao.codigo, 'OP 1');
    assert.strictEqual(await C.rpc('agora', {}), 'rpc agora', 'outras funções vão ao servidor');
    A.esquecer(OP);
  });

  console.log(falhas ? '\nFalhas: ' + falhas : '\nLeitura do arquivo: todos OK');
  process.exit(falhas ? 1 : 0);
})();
