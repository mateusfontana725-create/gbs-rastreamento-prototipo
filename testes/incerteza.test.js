// Incerteza explícita no IPO (public/js/ipo.js): hora do último momento visto informada, estimada ou desconhecida.
// Ausente continua ausente: não vira "agora" nem zero.
require('../public/js/ipo.js');
const I = globalThis.Ipo;
const assert = require('assert');
let falhas = 0;
function teste(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
console.log('Incerteza (IPO)');
const h = '2026-10-28T08:00';
teste('com hora e sem origem: "informado"', () => assert.strictEqual(I.normalizarIpo({ desaparecimento: h }).desaparecimento_qualidade, 'informado'));
teste('com hora estimada: "estimado"', () => assert.strictEqual(I.normalizarIpo({ desaparecimento: h, desaparecimento_qualidade: 'estimado' }).desaparecimento_qualidade, 'estimado'));
teste('sem hora: vazio (não informado), nunca "informado"', () => {
  assert.strictEqual(I.normalizarIpo({}).desaparecimento_qualidade, '');
  assert.strictEqual(I.normalizarIpo({ desaparecimento_qualidade: 'estimado' }).desaparecimento_qualidade, '');
  assert.strictEqual(I.normalizarIpo({}).desaparecimento, '');
});
teste('sem hora e "desconhecido": guardado como desconhecido', () => assert.strictEqual(I.normalizarIpo({ desaparecimento_qualidade: 'desconhecido' }).desaparecimento_qualidade, 'desconhecido'));
teste('com hora, "desconhecido" vira "informado" (a hora existe)', () => assert.strictEqual(I.qualidadeHora(h, 'desconhecido'), 'informado'));
teste('valor fora da lista é ignorado', () => assert.strictEqual(I.qualidadeHora(h, 'chute'), 'informado'));
teste('texto para a tela', () => {
  const fmt = () => '28/10 08:00';
  assert.strictEqual(I.textoHoraVisto({ desaparecimento: h, desaparecimento_qualidade: 'estimado' }, fmt), '28/10 08:00 (estimado)');
  assert.strictEqual(I.textoHoraVisto({ desaparecimento: h, desaparecimento_qualidade: 'informado' }, fmt), '28/10 08:00');
  assert.strictEqual(I.textoHoraVisto({ desaparecimento_qualidade: 'desconhecido' }, fmt), 'Desconhecido');
  assert.strictEqual(I.textoHoraVisto({}, fmt), '');
});
console.log(falhas ? falhas + ' falha(s)' : 'tudo certo');
process.exit(falhas ? 1 : 0);
