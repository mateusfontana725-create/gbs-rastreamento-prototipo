// Mapa guardado no aparelho (public/js/mapa-offline.js): cálculo dos quadros e limite da política do OSM. Não usa rede.
const M = require('../public/js/mapa-offline.js');
const assert = require('assert');
let falhas = 0;
function teste(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
console.log('Mapa offline');
teste('quadro do ponto (fórmula padrão de tiles)', () => {
  assert.deepStrictEqual(M.quadro(-25.43, -49.27, 0), { x: 0, y: 0 });
  assert.deepStrictEqual(M.quadro(-25.43, -49.27, 1), { x: 0, y: 1 });     // hemisfério sul e oeste
  assert.deepStrictEqual(M.quadro(-25.43, -49.27, 16), { x: 23798, y: 37557 });   // conferido à mão pela fórmula
});
teste('área: quadros de zoom 13 ou maior nunca passam de 240 (política do tile.openstreetmap.org: até 250)', () => {
  [[-25.43, -49.27], [-3.1, -60.0], [-33.7, -53.4], [0, -50]].forEach(([lat, lng]) => {
    const p = M.planejarArea(lat, lng);
    const altos = p.quadros.filter((q) => q.z >= 13).length;
    assert.ok(altos <= 240, lat + ': ' + altos);
    assert.ok(altos >= 100, 'cobre a área: ' + altos);
    assert.strictEqual(p.urls.length, p.quadros.length);
    assert.ok(p.urls.every((u) => /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(u)));
  });
});
teste('raio grande demais é reduzido até caber no limite', () => {
  const p = M.planejarArea(-25.43, -49.27, 50000);
  assert.ok(p.raioM < 50000);
  assert.ok(p.quadros.filter((q) => q.z >= 13).length <= 240);
});
teste('sem quadros repetidos', () => {
  const p = M.planejarArea(-25.43, -49.27);
  assert.strictEqual(new Set(p.urls).size, p.urls.length);
});
teste('área nova só quando se afasta mais de 1,5 km das já guardadas', () => {
  const areas = [{ lat: -25.43, lng: -49.27 }];
  assert.strictEqual(M.precisaArea([], -25.43, -49.27), true);
  assert.strictEqual(M.precisaArea(areas, -25.435, -49.27), false);   // ~550 m
  assert.strictEqual(M.precisaArea(areas, -25.45, -49.27), true);     // ~2,2 km
});
if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
console.log('\nTodos os testes do mapa offline passaram.');
