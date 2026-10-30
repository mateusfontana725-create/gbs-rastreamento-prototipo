// Catálogo de ícones (public/js/icones.js): busca e validação, sem rede.
const I = require('../public/js/icones.js');
const assert = require('assert');
let falhas = 0;
function teste(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
console.log('Ícones');
teste('catálogo grande, por assunto, sem repetir dentro do assunto', () => {
  const total = I.CATEGORIAS.reduce((n, c) => n + c.itens.length, 0);
  assert.ok(total >= 250, 'tem ' + total);
  I.CATEGORIAS.forEach((c) => { const v = c.itens.map((x) => x[0]); assert.strictEqual(new Set(v).size, v.length, c.nome); });
});
teste('busca pelo começo das palavras, sem acento', () => {
  assert.deepStrictEqual(I.buscar('cão').map((x) => x[0]), ['🐕', '🐕‍🦺']);
  assert.ok(I.buscar('cao').length === 2, 'sem acento');
  assert.ok(I.buscar('barco').some((x) => x[0] === '⛵'));
  assert.ok(!I.buscar('cão').some((x) => x[0] === '⚠️'), '"atenção" não entra em "cão"');
  assert.ok(I.buscar('').length > 250, 'vazio = todos');
});
teste('ícone válido: 1 a 8 caracteres', () => {
  assert.strictEqual(I.normalizar(' PC '), 'PC');
  assert.strictEqual(I.normalizar('🐕‍🦺'), '🐕‍🦺');
  assert.strictEqual(I.normalizar(''), null);
  assert.strictEqual(I.normalizar('ABCDEFGHI'), null);
});
if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
console.log('\nTodos os testes de ícones passaram.');
