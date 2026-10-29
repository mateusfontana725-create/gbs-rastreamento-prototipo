// Escolha de cor livre (public/js/cores.js): conversões e cor ainda não usada. Não usa a tela.
const C = require('../public/js/cores.js');
const assert = require('assert');
let falhas = 0;
function teste(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
console.log('Cores');
teste('normaliza: com ou sem #, 3 ou 6 dígitos, maiúsculas', () => {
  assert.strictEqual(C.normalizar('ABC'), '#aabbcc');
  assert.strictEqual(C.normalizar('#A1B2C3'), '#a1b2c3');
  assert.strictEqual(C.normalizar(' #0f0 '), '#00ff00');
});
teste('recusa o que não é cor (o banco só aceita #rrggbb)', () => {
  ['', 'xyz', '#12', '#12345', '#1234567', 'rgb(1,2,3)', null, undefined, '#gggggg'].forEach((v) => assert.strictEqual(C.normalizar(v), null, String(v)));
});
teste('hex → HSL nas cores de referência', () => {
  assert.deepStrictEqual(C.hexParaHsl('#ff0000'), { h: 0, s: 100, l: 50 });
  assert.deepStrictEqual(C.hexParaHsl('#00ff00'), { h: 120, s: 100, l: 50 });
  assert.deepStrictEqual(C.hexParaHsl('#0000ff'), { h: 240, s: 100, l: 50 });
  assert.deepStrictEqual(C.hexParaHsl('#ffffff'), { h: 0, s: 0, l: 100 });
  assert.deepStrictEqual(C.hexParaHsl('#000000'), { h: 0, s: 0, l: 0 });
});
teste('HSL → hex e volta (erro de arredondamento de até 6 por canal)', () => {
  assert.strictEqual(C.hslParaHex(120, 100, 50), '#00ff00');
  assert.strictEqual(C.hslParaHex(0, 0, 100), '#ffffff');
  assert.strictEqual(C.hslParaHex(360, 100, 50), '#ff0000');
  assert.strictEqual(C.hslParaHex(-120, 100, 50), '#0000ff');
  for (let i = 0; i < 300; i++) {
    const h = '#' + Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0');
    const a = C.hexParaHsl(h), b = C.hslParaHex(a.h, a.s, a.l);
    [1, 3, 5].forEach((k) => assert.ok(Math.abs(parseInt(h.slice(k, k + 2), 16) - parseInt(b.slice(k, k + 2), 16)) <= 6, h + ' → ' + b));
    assert.ok(/^#[0-9a-f]{6}$/.test(b));
  }
});
teste('próxima cor livre: pula as usadas (sem diferenciar maiúsculas) e recomeça quando acabam', () => {
  const lista = ['#111111', '#222222', '#333333'];
  assert.strictEqual(C.livre(lista, []), '#111111');
  assert.strictEqual(C.livre(lista, ['#111111', '#222222']), '#333333');
  assert.strictEqual(C.livre(lista, ['#111111', '#222222']), '#333333');
  assert.strictEqual(C.livre(['#AAAAAA', '#bbbbbb'], ['#aaaaaa']), '#bbbbbb');
  assert.strictEqual(C.livre(lista, ['#111111', '#222222', '#333333']), '#111111');
  assert.strictEqual(C.livre(lista, ['#ab12cd', 'lixo']), '#111111');
});
teste('texto legível sobre o fundo', () => {
  assert.strictEqual(C.textoSobre('#ffff00'), '#000000');
  assert.strictEqual(C.textoSobre('#000080'), '#ffffff');
});
console.log(falhas ? falhas + ' falha(s)' : 'tudo certo');
process.exit(falhas ? 1 : 0);
