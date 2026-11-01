// SCI que cresce com a ocorrência (js/sci-org.js, migração 057): catálogo, pontos de partida, ativação e menu do Comando.
const assert = require('assert');
const O = require('../public/js/sci-org.js');
let falhas = 0;
function teste(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
const est = (ids, extra) => ({ inicio: '2026-11-01T10:00:00Z', ativas: Object.fromEntries(ids.map((i) => [i, Object.assign({ desde: '2026-11-01T10:00:00Z' }, (extra || {})[i] || {})])) });

console.log('SCI que cresce: núcleo (sci-org.js)');

teste('catálogo: ids únicos, todo pai existe e as funções do staff e das seções ligam com sci_estado.funcoes', () => {
  const ids = O.CATALOGO.map((f) => f.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  O.CATALOGO.forEach((f) => { if (f.pai) assert.ok(O.funcao(f.pai), 'pai de ' + f.id); });
  const chaves = O.CATALOGO.filter((f) => f.funcao).map((f) => f.funcao).sort();
  assert.deepStrictEqual(chaves, ['adm_financas', 'informacao_publica', 'ligacao', 'logistica', 'operacoes', 'planejamento', 'seguranca']);
  O.CATALOGO.forEach((f) => assert.ok(O.PAGINAS[f.pagina], 'página de ' + f.id));
});

teste('começa pequena: só Operações (fixa) está ativa e o resto fica com o CI', () => {
  const e = O.normalizar(null);
  assert.ok(O.ativa(e, 'ops'));
  assert.ok(!O.ativa(e, 'seg') && !O.ativa(e, 'log') && !O.ativa(e, 'ops.espera'));
  assert.strictEqual(O.contagem(e), 0);
  assert.ok(!O.configurada(e));
  const ci = O.acumuladasPeloCi(e);
  ['Oficial de Segurança', 'Planejamento', 'Logística', 'Administração e Finanças', 'Operações'].forEach((n) => assert.ok(ci.includes(n), n));
});

teste('unidade só com o pai ativo (seção ou setor); Operações não pode ser desativada', () => {
  assert.ok(O.podeAtivar({}, 'ops.espera'), 'unidade de Operações: já pode');
  assert.ok(!O.podeAtivar({}, 'log.sup'), 'Logística desligada: não');
  assert.ok(!O.podeAtivar(est(['log']), 'log.sup'), 'falta o Setor de Apoio');
  assert.ok(O.podeAtivar(est(['log', 'log.apoio']), 'log.sup'));
  assert.ok(!O.podeAtivar(est(['seg']), 'seg'), 'já ativa');
  assert.deepStrictEqual(O.desativacao({}, 'ops'), []);
});

teste('desativar uma seção leva junto as unidades ativas abaixo dela (setores e unidades dos setores)', () => {
  const e = est(['log', 'log.apoio', 'log.sup', 'log.serv', 'seg']);
  assert.deepStrictEqual(O.desativacao(e, 'log').sort(), ['log', 'log.apoio', 'log.serv', 'log.sup']);
  assert.deepStrictEqual(O.desativacao(e, 'log.apoio').sort(), ['log.apoio', 'log.sup']);
  assert.deepStrictEqual(O.desativacao(e, 'adm'), [], 'não ativa: nada a desativar');
});

teste('pontos de partida: só ativam o que falta, em ordem de pai para filho', () => {
  assert.deepStrictEqual(O.aplicarPonto({}, 'pequena'), []);
  const media = O.aplicarPonto({}, 'media');
  assert.ok(media.includes('seg') && media.includes('ops.acv') && media.includes('log.sup'));
  assert.ok(!O.aplicarPonto(est(['seg']), 'media').includes('seg'), 'o que já está ativo fica como está');
  O.PONTOS_DE_PARTIDA.forEach((p) => p.ids.forEach((id, i) => {
    const f = O.funcao(id);
    assert.ok(f, id);
    if (f.pai && !O.funcao(f.pai).fixa) assert.ok(p.ids.indexOf(f.pai) > -1 && p.ids.indexOf(f.pai) < i, p.id + ': ' + f.pai + ' antes de ' + id);
  }));
  const grande = O.aplicarPonto({}, 'grande');
  assert.ok(['lig', 'inf', 'adm', 'adm.cus', 'log.ter'].every((x) => grande.includes(x)));
  assert.deepStrictEqual(O.aplicarPonto({}, 'inexistente'), []);
});

teste('menu da operação pequena: Comando, Operações e Planejamento abertos; Logística, Adm., Segurança e Área de Espera em "Com o CI"', () => {
  const m = O.menu({});
  assert.deepStrictEqual(m.grupos.map((g) => g.id), ['comando', 'operacoes', 'planejamento']);
  const pags = m.comCi.map((i) => i.pagina).sort();
  assert.deepStrictEqual(pags, ['admfin', 'espera', 'logistica', 'seguranca']);
  assert.strictEqual(m.grupos[1].responsavel.texto, 'com o CI', 'Operações sem chefe: com o CI');
  assert.strictEqual(m.grupos[2].responsavel.texto, 'com o CI');
  assert.ok(m.grupos[0].itens.some((i) => i.pagina === 'org'));
});

teste('menu cresce com o organograma: seção ativada aparece aberta com o chefe; sem nome, [PENDENTE]', () => {
  const m = O.menu(est(['seg', 'log', 'ops.espera', 'adm'], { log: { nome: 'Ten Rocha' } }));
  assert.deepStrictEqual(m.grupos.map((g) => g.id), ['comando', 'staff', 'operacoes', 'planejamento', 'logistica', 'adm']);
  assert.strictEqual(m.grupos.find((g) => g.id === 'logistica').responsavel.texto, 'Ten Rocha');
  assert.strictEqual(m.grupos.find((g) => g.id === 'adm').responsavel.texto, '[PENDENTE]');
  assert.ok(m.grupos.find((g) => g.id === 'operacoes').itens.some((i) => i.pagina === 'espera'));
  assert.deepStrictEqual(m.comCi, []);
});

teste('janela própria do SCI: sem o item "Mapa operacional" (o mapa fica no painel)', () => {
  assert.ok(O.menu({}).grupos[1].itens.some((i) => i.pagina === 'mapa'));
  assert.ok(!O.menu({}, { semMapa: true }).grupos[1].itens.some((i) => i.pagina === 'mapa'));
});

teste('minha função: só as ativas designadas para a conta, com a página de cada uma', () => {
  const e = est(['seg', 'log', 'log.apoio', 'log.sup'], { seg: { nome: 'Sgt Lima', user_id: 'u1' }, 'log.sup': { nome: 'Cb Dias', user_id: 'u1' }, log: { nome: 'Ten Rocha', user_id: 'u2' } });
  assert.deepStrictEqual(O.minhasFuncoes(e, 'u1').map((f) => f.id + ':' + f.pagina), ['seg:seguranca', 'log.sup:logistica']);
  assert.deepStrictEqual(O.minhasFuncoes(e, 'u3'), []);
  assert.deepStrictEqual(O.minhasFuncoes(e, null), []);
  assert.deepStrictEqual(O.menu(e, { usuario: 'u2' }).minhas.map((f) => f.id), ['log']);
});

console.log(falhas ? '\nFalhas: ' + falhas : '\nSCI que cresce: todos OK');
process.exit(falhas ? 1 : 0);
