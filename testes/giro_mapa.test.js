// Contas do giro do mapa conforme o celular (public/js/giro-mapa.js) — rode com: node testes/giro_mapa.test.js
const assert = require('assert');
const G = require('../public/js/giro-mapa.js');
let falhas = 0;
function teste(nome, fn) { try { fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); } }

teste('normalizar fica entre 0 e 360', () => { assert.strictEqual(G.normalizar(-10), 350); assert.strictEqual(G.normalizar(370), 10); assert.strictEqual(G.normalizar(360), 0); });
teste('diferença pelo caminho mais curto', () => {
  assert.strictEqual(G.diferenca(350, 10), 20);
  assert.strictEqual(G.diferenca(10, 350), -20);
  assert.strictEqual(G.diferenca(0, 180), 180);
  assert.strictEqual(G.diferenca(90, 90), 0);
});
teste('bearing do mapa = 360 − rumo (a frente do celular fica em cima)', () => {
  assert.strictEqual(G.bearingParaRumo(0), 0);      // apontando para o norte: nada gira
  assert.strictEqual(G.bearingParaRumo(90), 270);   // leste: o mapa gira para o leste ficar em cima
  assert.strictEqual(G.bearingParaRumo(180), 180);
  assert.strictEqual(G.bearingParaRumo(270), 90);
});
teste('suavizar passa pelo 0 sem dar a volta inteira', () => {
  assert.strictEqual(G.suavizar(350, 10, 0.5), 0);
  assert.strictEqual(G.suavizar(10, 350, 0.5), 0);
  assert.strictEqual(G.suavizar(100, 100, 0.3), 100);
  assert.ok(Math.abs(G.suavizar(0, 90, 0.25) - 22.5) < 1e-9);
});
teste('só redesenha quando muda mais que o mínimo', () => {
  assert.strictEqual(G.mudouBastante(10, 11), false);
  assert.strictEqual(G.mudouBastante(10, 13), true);
  assert.strictEqual(G.mudouBastante(359, 0), false);   // 1° pelo lado do 0
  assert.strictEqual(G.mudouBastante(359, 1), true);    // 2°: chegou ao mínimo
  assert.strictEqual(G.mudouBastante(359, 3, 5), false);
});

if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
console.log('\nGiro do mapa conforme o celular: tudo certo.');
