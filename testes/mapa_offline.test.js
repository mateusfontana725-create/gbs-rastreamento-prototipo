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

console.log('Pacotes de 10 km (servidor próprio de mapas)');
const MODELOS = { osm: 'https://mapas.exemplo.com/osm/{z}/{x}/{y}.png', topo: 'https://mapas.exemplo.com/topo/{z}/{x}/{y}.png', satelite: 'https://mapas.exemplo.com/sat/{z}/{y}/{x}.jpg' };
teste('pacote padrão: raio de 10 km, zoom de 10 a 17, até 3 pacotes', () => {
  assert.strictEqual(M.PACOTE.raioM, 10000);
  assert.strictEqual(M.PACOTE.zoomMin, 10);
  assert.strictEqual(M.PACOTE.zoomMax, 17);
  assert.strictEqual(M.PACOTE.max, 3);
});
teste('quadros do círculo: do zoom 10 ao 17 e só os que tocam o círculo (menos que o quadrado)', () => {
  const q = M.quadrosDoCirculo(-25.43, -49.27, 10000, 10, 17);
  const zooms = new Set(q.map((x) => x.z));
  assert.deepStrictEqual(Array.from(zooms).sort((a, b) => a - b), [10, 11, 12, 13, 14, 15, 16, 17]);
  const z17 = q.filter((x) => x.z === 17).length;
  const quadrado = M.quadrosDaArea(-25.43, -49.27, 10000, 17, 17).length;
  assert.ok(z17 < quadrado, z17 + ' < ' + quadrado);
  assert.ok(z17 > 3800 && z17 < 5200, 'zoom 17: ' + z17);   // ≈ 314 km² / (0,277 km)²
});
teste('plano: uma URL por quadro e por camada; marcadores {z}/{x}/{y} em qualquer ordem; estimativa de tamanho', () => {
  const p = M.planejarPacote(-25.43, -49.27, MODELOS);
  assert.deepStrictEqual(p.camadas, ['osm', 'topo', 'satelite']);
  assert.strictEqual(p.total, p.quadros * 3);
  assert.strictEqual(p.urls.length, p.total);
  assert.ok(p.urls.every((u) => !/[{}]/.test(u)), 'sem marcadores sobrando');
  assert.ok(p.urls.some((u) => /\/sat\/\d+\/\d+\/\d+\.jpg$/.test(u)));
  assert.ok(p.mb > 300 && p.mb < 600, 'estimativa: ' + p.mb + ' MB (3 camadas)');
  assert.strictEqual(new Set(p.urls).size, p.urls.length, 'sem URL repetida');
});
teste('só as camadas configuradas entram no plano', () => {
  const p = M.planejarPacote(-25.43, -49.27, { osm: MODELOS.osm });
  assert.deepStrictEqual(p.camadas, ['osm']);
  assert.strictEqual(p.total, p.quadros);
});
teste('cobertura: o ponto precisa estar bem dentro (margem de 2 km) de um pacote guardado', () => {
  const pac = [{ lat: -25.43, lng: -49.27, raioM: 10000 }];
  assert.strictEqual(M.cobre(pac, -25.43, -49.27), true);
  assert.strictEqual(M.cobre(pac, -25.43 + 7500 / 111320, -49.27), true);     // a 7,5 km do centro: dentro da margem
  assert.strictEqual(M.cobre(pac, -25.43 + 8500 / 111320, -49.27), false);    // a 8,5 km: perto demais da borda
  assert.strictEqual(M.cobre(pac, -26.5, -49.27), false);                     // outra região
  assert.strictEqual(M.cobre([], -25.43, -49.27), false);
  assert.strictEqual(M.cobre(pac, -25.43 + 8500 / 111320, -49.27, 0), true);  // sem margem
});

// cache e rede simulados
function simular(opcoes) {
  const guardado = new Map();
  let chamadas = 0;
  global.caches = { open: async () => ({
    match: async (u) => guardado.get(u),
    put: async (u, r) => { guardado.set(u, r); },
    delete: async (u) => guardado.delete(u),
    keys: async () => Array.from(guardado.keys()).map((u) => ({ url: u })),
  }) };
  Object.defineProperty(global, 'navigator', { value: { onLine: true }, configurable: true, writable: true });   // no Node novo, navigator é só leitura
  global.fetch = async (u) => {
    chamadas++;
    if (opcoes && opcoes.falhaEm && opcoes.falhaEm(u)) return { ok: false, status: 500 };
    return { ok: true, status: 200, url: u };
  };
  return { guardado, chamadas: () => chamadas };
}
const urls50 = M.planejarPacote(-25.43, -49.27, { osm: MODELOS.osm }, { raioM: 500, zoomMax: 14 }).urls;

(async () => {
  async function teste2(nome, fn) { try { await fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); } }
  await teste2('baixar: guarda todos, com progresso, vários ao mesmo tempo', async () => {
    const sim = simular(); let ultimo = 0;
    const r = await M.baixarPacote(urls50, { paralelo: 4, aoProgresso: (f) => { ultimo = f; } });
    assert.strictEqual(r.feitos, urls50.length); assert.strictEqual(r.falhas, 0); assert.strictEqual(r.motivo, null);
    assert.strictEqual(ultimo, urls50.length);
    assert.strictEqual(sim.guardado.size, urls50.length);
    assert.strictEqual(await M.contarGuardados(urls50), urls50.length);
  });
  await teste2('retomar: o que já está guardado não é baixado de novo', async () => {
    const sim = simular();
    await M.baixarPacote(urls50.slice(0, 5));
    const antes = sim.chamadas();
    await M.baixarPacote(urls50);
    assert.strictEqual(sim.chamadas() - antes, urls50.length - 5);
  });
  await teste2('cancelar: para no meio e o que veio fica guardado', async () => {
    const sim = simular(); let pedir = false;
    const r = await M.baixarPacote(urls50, { paralelo: 1, aoProgresso: (f) => { if (f >= 3) pedir = true; }, cancelado: () => pedir });
    assert.strictEqual(r.motivo, 'cancelado');
    assert.ok(sim.guardado.size >= 3 && sim.guardado.size < urls50.length, 'guardados: ' + sim.guardado.size);
  });
  await teste2('sem internet no meio: para com o motivo "sem_rede"', async () => {
    simular(); let k = 0;
    const r = await M.baixarPacote(urls50, { paralelo: 1, aoProgresso: () => { if (++k === 2) global.navigator.onLine = false; } });
    assert.strictEqual(r.motivo, 'sem_rede');
    assert.ok(r.feitos >= 2 && r.feitos < urls50.length);
  });
  await teste2('falha de um quadro é contada e o resto continua', async () => {
    simular({ falhaEm: (u) => u === urls50[1] });
    const r = await M.baixarPacote(urls50, { paralelo: 2 });
    assert.strictEqual(r.falhas, 1); assert.strictEqual(r.feitos, urls50.length - 1);
  });
  await teste2('apagar: não apaga o que outro pacote ainda usa', async () => {
    const sim = simular();
    await M.baixarPacote(urls50);
    const manter = {}; urls50.slice(0, 4).forEach((u) => { manter[u] = true; });
    const apagados = await M.apagarExceto(urls50, manter);
    assert.strictEqual(apagados, urls50.length - 4);
    assert.strictEqual(sim.guardado.size, 4);
  });
  if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
  console.log('\nTodos os testes do mapa offline passaram.');
})();
