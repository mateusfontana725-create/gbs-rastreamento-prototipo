// Modo SCI (js/sci-dados.js, migração 057): organograma, períodos, pessoas, vítimas, alertas e SCI 201.
const assert = require('assert');
const D = require('../public/js/sci-dados.js');
let falhas = 0;
function teste(nome, fn) { try { fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); } }
const H = 3600e3, agora = Date.parse('2026-11-01T15:00:00Z');
const org = (ids, extra) => ({ ativas: Object.fromEntries(ids.map((i) => [i, Object.assign({ desde: '2026-11-01T10:00:00Z' }, (extra || {})[i] || {})])) });

console.log('Modo SCI: regras (sci-dados.js)');

teste('catálogo igual ao do banco (sci2_funcao): ids, pais e Operações fixa', () => {
  const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'supabase', 'migracoes', '057_sci_posto_comando.sql'), 'utf8');
  const doBanco = [...sql.matchAll(/\('([a-z.]+)', '[^']+', '[^']+', (null|'[a-z.]+'), (true|false)\)/g)].map((m) => [m[1], m[2] === 'null' ? null : m[2].replace(/'/g, ''), m[3] === 'true']);
  assert.strictEqual(doBanco.length, D.CATALOGO.length);
  doBanco.forEach(([id, pai, fixa]) => {
    const f = D.funcao(id);
    assert.ok(f, id);
    assert.strictEqual(f.pai || null, pai, 'pai de ' + id);
    assert.strictEqual(Boolean(f.fixa), fixa, 'fixa de ' + id);
  });
});

teste('organograma: Operações sempre ativa; unidade só com o pai; desativar leva as unidades abaixo', () => {
  assert.ok(D.ativa({}, 'ops') && !D.ativa({}, 'seg'));
  assert.ok(D.podeAtivar({}, 'ops.espera') && !D.podeAtivar({}, 'log.sup') && !D.podeAtivar(org(['log']), 'log.sup') && D.podeAtivar(org(['log', 'log.apoio']), 'log.sup'));
  assert.deepStrictEqual(D.desativacao(org(['log', 'log.apoio', 'log.sup', 'log.serv']), 'log').sort(), ['log', 'log.apoio', 'log.serv', 'log.sup']);
  assert.deepStrictEqual(D.desativacao({}, 'ops'), []);
});

teste('com o CI: staff e seções não ativadas (e Operações sem chefe); quem responde pela seção', () => {
  assert.deepStrictEqual(D.comOCi({}), ['Oficial de Segurança', 'Oficial de Ligação', 'Oficial de Informação Pública', 'Operações', 'Planejamento', 'Logística', 'Adm. e Finanças']);
  const o = org(['seg', 'log', 'ops'], { ops: { nome: 'Ten Souza' }, log: { nome: '' } });
  assert.ok(!D.comOCi(o).includes('Operações') && !D.comOCi(o).includes('Logística') && D.comOCi(o).includes('Planejamento'));
  assert.deepStrictEqual(D.responsavelSecao({}, 'ops'), { comCi: true, texto: 'com o CI' });
  assert.deepStrictEqual(D.responsavelSecao(o, 'ops'), { comCi: false, texto: 'Ten Souza' });
  assert.deepStrictEqual(D.responsavelSecao(o, 'log'), { comCi: false, texto: '[PENDENTE]' });
  assert.deepStrictEqual(D.responsavelSecao(o, 'adm'), { comCi: true, texto: 'com o CI' });
  assert.deepStrictEqual(D.minhasFuncoes(org(['seg'], { seg: { user_id: 'u1' } }), 'u1').map((f) => f.id), ['seg']);
});

teste('menu do Modo SCI: as cinco seções do layout, com Mapa operacional em Operações', () => {
  assert.deepStrictEqual(D.MENU.map((g) => g.titulo), ['Comando', 'Operações', 'Planejamento', 'Logística', 'Administração e Finanças']);
  assert.strictEqual(D.PAGINAS.mapa, 'Mapa operacional e setores');
  assert.strictEqual(Object.keys(D.PAGINAS).length, 11);
});

teste('período atual, próximo e vencido', () => {
  const p = [{ numero: 1, inicio: agora - 13 * H, fim: agora - H }, { numero: 2, inicio: agora - H, fim: agora + 11 * H }, { numero: 3, inicio: agora + 11 * H, fim: agora + 23 * H }];
  const r = D.periodoAtual(p, agora);
  assert.strictEqual(r.atual.numero, 2); assert.strictEqual(r.proximo.numero, 3); assert.strictEqual(r.vencido, null);
  assert.strictEqual(D.periodoAtual([p[0]], agora).vencido.numero, 1);
  assert.strictEqual(D.periodoAtual([], agora).atual, null);
});

teste('balanço de pessoas fecha a soma; equipes por status a partir dos grupos e deslocamentos', () => {
  const b = D.balancoPessoas([{ tipo: 'militar', estado: 'conectado' }, { tipo: 'militar', estado: 'instavel' }, { tipo: 'civil', estado: 'sem_atualizacao' }, { tipo: 'civil', estado: 'removido' }, { tipo: 'responsavel', estado: 'aguardando' }]);
  assert.deepStrictEqual([b.total, b.emCampo, b.semContato, b.sairam, b.aguardando, b.militares, b.civis, b.fecha], [5, 2, 1, 1, 1, 2, 2, true]);
  const g = [{ id: 'a', nome: 'Alfa', disponibilidade: 'disponivel' }, { id: 'b', nome: 'Bravo', disponibilidade: 'disponivel' }, { id: 'c', nome: 'Charlie', disponibilidade: 'em_descanso' }, { id: 'd', nome: 'Delta', disponibilidade: 'indisponivel' }];
  const e = D.equipesPorStatus(g, [{ grupo_id: 'a', status: 'no_setor', nome: 'Setor 2', enviada_em: agora - H }, { grupo_id: 'b', status: 'na_base', nome: 'x', enviada_em: agora - 2 * H }]);
  assert.deepStrictEqual([e.missao.map((x) => x.grupo.nome), e.disponivel.map((x) => x.grupo.nome), e.descanso.length, e.indisponivel.length], [['Alfa'], ['Bravo'], 1, 1]);
  assert.deepStrictEqual(D.progressoSetores([{ status: 'concluido' }, { status: 'andamento' }, { status: 'andamento' }, {}]), { pendente: 1, andamento: 2, concluido: 1, total: 4 });
});

teste('quadro de vítimas: fases, encontradas fora do quadro e fichas ainda procuradas', () => {
  const vit = [{ numero: 2, fase: 'acv', condicao: 'viva', localizacao_id: 'l2', vitima_id: 'f2' }, { numero: 1, fase: 'remocao', condicao: 'viva', localizacao_id: 'l1' }, { numero: 3, fase: 'entregue', condicao: 'obito' }];
  const loc = [{ id: 'l1', condicao: 'viva' }, { id: 'l2', condicao: 'viva', vitima_id: 'f2' }, { id: 'l3', condicao: 'obito', vitima_id: 'f3' }];
  const q = D.quadroVitimas(vit, loc, [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }]);
  assert.deepStrictEqual([q.remocao.map((v) => v.numero), q.acv.map((v) => v.numero), q.entregue.length, q.foraDoQuadro.map((l) => l.id), q.procuradas.map((f) => f.id)], [[1], [2], 1, ['l3'], ['f1']]);
  const n = D.numerosVitimas(q);
  assert.deepStrictEqual([n.procuradas, n.aguardandoEquipe, n.emRemocao, n.foraDaEstrutura, n.vivas, n.obitos, n.localizadas], [1, 1, 1, 2, 2, 2, 4]);
});

teste('alertas: segurança antes das vítimas, vítimas antes do comando; pendências do SCI', () => {
  const q = D.quadroVitimas([{ numero: 1, fase: 'plotada', criado_em: agora - 45 * 60000 }], [{ id: 'lx', condicao: 'viva' }], []);
  const a = D.alertas({ agora, estado: {}, quadro: q, pedidosAjuda: [{ participante_nome: 'Cb Souza', estado: 'recebido', recebido_em: agora - 600000 }], equipes: { missao: [{}] } });
  assert.strictEqual(a[0].nivel, 'critico'); assert.ok(/Cb Souza SEM ATENDIMENTO/.test(a[0].texto));
  assert.ok(a.findIndex((x) => /V-01 aguardando equipe há 45 min/.test(x.texto)) < a.findIndex((x) => /não estabelecido/.test(x.texto)));
  assert.ok(a.some((x) => /fora do quadro/.test(x.texto)) && a.some((x) => /Oficial de Segurança com o CI e 1 equipe/.test(x.texto)));
  const ok = D.alertas({ agora, estado: { estabelecido_em: agora - H, boletim: 'ok', comando: { pc_texto: 'Ponte' }, organograma: org(['seg']) }, periodos: [{ numero: 1, inicio: agora - H, fim: agora + H, objetivos: [{ texto: 'x' }] }], informacoes: [{}], equipes: { missao: [{}] } });
  assert.deepStrictEqual(ok.map((x) => x.texto), ['1 informação(ões) NÃO CONFIRMADA(S) aguardando a equipe.']);
  assert.ok(D.alertas({ agora, estado: { estabelecido_em: 1, boletim: 'x', comando: { pc_texto: 'y' } }, periodos: [{ numero: 4, inicio: agora - 3 * H, fim: agora - H }] }).some((x) => /Período operacional 4 terminou/.test(x.texto)));
  assert.strictEqual(D.alertas({ agora, ativa: false, estado: {} }).length, 0, 'operação encerrada: sem pendências do SCI');
});

teste('SCI 201: monta do que está registrado e marca [PENDENTE] no que falta', () => {
  const t = D.sci201({ op: { codigo: 'BUSCA RIO' }, ci: 'Ten Fontana', agora, estado: { comando: { modalidade: 'unificado', instituicoes: ['CBMPR', 'Defesa Civil'], pc_texto: 'Ponte' }, boletim: 'Busca nos setores 1 e 2.', boletim_em: agora - H },
    periodos: [{ numero: 1, inicio: agora - H, fim: agora + H, objetivos: [{ texto: 'Varrer setor 1', estado: 'em_curso' }] }], setores: [{ nome: 'S1', status: 'andamento' }],
    equipes: D.equipesPorStatus([{ id: 'a', nome: 'Alfa' }], [{ grupo_id: 'a', status: 'no_setor', nome: 'Varredura', setor_nome: 'S1', enviada_em: agora }]), informacoes: [{ texto: '2 pessoas na água', fonte: 'COPOM' }],
    quadro: D.quadroVitimas([], [], [{ id: 'f' }]) });
  assert.ok(/Comandante do Incidente: Ten Fontana/.test(t) && /Comando: unificado \(CBMPR, Defesa Civil\)/.test(t) && /Base: \[PENDENTE\]/.test(t));
  assert.ok(/Varrer setor 1 \(Em curso\)/.test(t) && /S1 \(em andamento\)/.test(t) && /Alfa: Varredura \(setor S1\)/.test(t) && /2 pessoas na água — COPOM \(NÃO CONFIRMADA\)/.test(t) && /1 procurada/.test(t));
  assert.ok(/OBJETIVOS:\n  \[PENDENTE\]/.test(D.sci201({ agora })));
});

console.log(falhas ? '\nFalhas: ' + falhas : '\nModo SCI: todos OK');
process.exit(falhas ? 1 : 0);
