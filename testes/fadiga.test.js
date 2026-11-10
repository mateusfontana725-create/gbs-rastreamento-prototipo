// Teste do indicador de fadiga e do descanso (public/js/fadiga.js) — rode com: node testes/fadiga.test.js
const F = require('../public/js/fadiga.js');
const assert = require('assert');
let falhas = 0;
function teste(nome, fn) { try { fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); } }
const MIN = 60000, H = 60 * MIN;
const T0 = Date.parse('2026-11-07T08:00:00Z');
console.log('Fadiga');

teste('sem esforço: verde', () => {
  const r = F.avaliar({ buscaMin: 20, km: 1.2, kmGrupo: 1.5 });
  assert.strictEqual(r.nivel, 'verde');
  assert.strictEqual(r.itens.length, 3);
});
teste('tempo de busca: amarelo a partir de 2 h e vermelho a partir de 4 h', () => {
  assert.strictEqual(F.avaliar({ buscaMin: 119, km: 0, kmGrupo: 0 }).nivel, 'verde');
  assert.strictEqual(F.avaliar({ buscaMin: 120, km: 0, kmGrupo: 0 }).nivel, 'amarelo');
  assert.strictEqual(F.avaliar({ buscaMin: 239, km: 0, kmGrupo: 0 }).nivel, 'amarelo');
  assert.strictEqual(F.avaliar({ buscaMin: 240, km: 0, kmGrupo: 0 }).nivel, 'vermelho');
});
teste('quilometragem individual: amarelo a partir de 8 km e vermelho a partir de 15 km', () => {
  assert.strictEqual(F.avaliar({ buscaMin: 0, km: 7.9, kmGrupo: 0 }).nivel, 'verde');
  assert.strictEqual(F.avaliar({ buscaMin: 0, km: 8, kmGrupo: 0 }).nivel, 'amarelo');
  assert.strictEqual(F.avaliar({ buscaMin: 0, km: 15, kmGrupo: 0 }).nivel, 'vermelho');
});
teste('quilometragem do grupo pesa: pessoa descansada num grupo exausto fica amarela/vermelha', () => {
  assert.strictEqual(F.avaliar({ buscaMin: 10, km: 1, kmGrupo: 7 }).nivel, 'amarelo');
  assert.strictEqual(F.avaliar({ buscaMin: 10, km: 1, kmGrupo: 12 }).nivel, 'vermelho');
});
teste('o nível final é o pior dos três e o texto diz quais pesaram', () => {
  const r = F.avaliar({ buscaMin: 130, km: 16, kmGrupo: 3 });
  assert.strictEqual(r.nivel, 'vermelho');
  assert.ok(/quilometragem 16,0 km \(vermelho\)/.test(r.texto), r.texto);
  assert.ok(/tempo de busca 2 h 10 min \(amarelo\)/.test(r.texto), r.texto);
  assert.strictEqual(r.itens.find((x) => x.chave === 'tempo').nivel, 'amarelo');
});
teste('pessoa sem grupo: só tempo e quilometragem individual', () => {
  const r = F.avaliar({ buscaMin: 10, km: 2, kmGrupo: null });
  assert.strictEqual(r.itens.length, 2);
  assert.strictEqual(r.nivel, 'verde');
});
teste('limites editáveis (valores próprios)', () => {
  const lim = { tempoMin: { amarelo: 30, vermelho: 60 }, km: { amarelo: 1, vermelho: 2 }, kmGrupo: { amarelo: 1, vermelho: 2 }, descansoLongoMin: 10 };
  assert.strictEqual(F.avaliar({ buscaMin: 45, km: 0, kmGrupo: 0 }, lim).nivel, 'amarelo');
});
teste('descansando (descanso longo em andamento): verde, com a contagem zerada', () => {
  const r = F.avaliar({ buscaMin: 300, km: 20, kmGrupo: 18, emDescansoLongo: true });
  assert.strictEqual(r.nivel, 'verde');
  assert.ok(/Descansando/.test(r.texto));
});

console.log('Ciclo e descanso');
teste('sem descanso: o tempo de busca vai do primeiro ponto até agora', () => {
  const c = F.ciclo([], T0 + 3 * H, T0);
  assert.strictEqual(Math.round(c.buscaMin), 180);
  assert.strictEqual(c.inicioMs, T0);
  assert.strictEqual(c.descansando, null);
});
teste('descanso curto (10 min) não zera: só é descontado do tempo de busca', () => {
  const c = F.ciclo([{ inicio: T0 + H, fim: T0 + H + 10 * MIN }], T0 + 3 * H, T0);
  assert.strictEqual(Math.round(c.buscaMin), 170);
  assert.strictEqual(c.inicioMs, T0);
  assert.strictEqual(Math.round(c.descansoTotalMin), 10);
});
teste('descanso longo (40 min) zera a contagem: o ciclo recomeça no fim dele', () => {
  const c = F.ciclo([{ inicio: T0 + H, fim: T0 + H + 40 * MIN }], T0 + 3 * H, T0);
  assert.strictEqual(c.inicioMs, T0 + H + 40 * MIN);
  assert.strictEqual(Math.round(c.buscaMin), 80);
});
teste('descanso em andamento: conta o tempo na base e informa há quanto tempo', () => {
  const c = F.ciclo([{ inicio: T0 + 2 * H, fim: null }], T0 + 2 * H + 12 * MIN, T0);
  assert.ok(c.descansando && Math.round(c.descansando.min) === 12 && c.descansando.longo === false);
  assert.strictEqual(Math.round(c.buscaMin), 120);   // os 12 min de base não contam como busca
});
teste('descanso em andamento há mais de 30 min é longo (zera a contagem)', () => {
  const c = F.ciclo([{ inicio: T0 + 2 * H, fim: null }], T0 + 2 * H + 45 * MIN, T0);
  assert.ok(c.descansando.longo);
  assert.strictEqual(Math.round(c.buscaMin), 0);
});
teste('vários descansos: ordem qualquer e o total soma todos', () => {
  const c = F.ciclo([{ inicio: T0 + 3 * H, fim: T0 + 3 * H + 5 * MIN }, { inicio: T0 + H, fim: T0 + H + 5 * MIN }], T0 + 4 * H, T0);
  assert.strictEqual(Math.round(c.descansoTotalMin), 10);
  assert.strictEqual(Math.round(c.buscaMin), 230);
});
teste('sem primeiro ponto: busca zero', () => {
  assert.strictEqual(F.ciclo([], T0, null).buscaMin, 0);
});

console.log('Quilometragem');
const M = 1 / 111320;
const seg = (n, t0, passoM, passoMs) => Array.from({ length: n }, (_, i) => ({ lat: -25.5 + i * passoM * M, lng: -49.3, t: t0 + i * passoMs }));
teste('km de um trecho reto (100 pontos de 10 m = 990 m)', () => {
  const km = F.kmDesde([seg(100, T0, 10, 10000)], T0);
  assert.ok(Math.abs(km - 0.99) < 0.005, km);
});
teste('só conta o que veio depois do instante (depois do descanso longo)', () => {
  const s = seg(100, T0, 10, 10000);
  const km = F.kmDesde([s], T0 + 50 * 10000);
  assert.ok(Math.abs(km - 0.49) < 0.005, km);
});
teste('segmentos separados (falhas) não são ligados por uma reta', () => {
  const a = seg(10, T0, 10, 10000), b = seg(10, T0 + 3600000, 10, 10000).map((p) => Object.assign({}, p, { lat: p.lat + 0.05 }));
  const km = F.kmDesde([a, b], T0);
  assert.ok(Math.abs(km - 0.18) < 0.01, km);
});
teste('média do grupo ignora quem não tem valor', () => {
  assert.strictEqual(F.mediaKm([2, 4, null, undefined]), 3);
  assert.strictEqual(F.mediaKm([]), null);
});
teste('textos', () => {
  assert.strictEqual(F.textoMinutos(45), '45 min');
  assert.strictEqual(F.textoMinutos(120), '2 h');
  assert.strictEqual(F.textoMinutos(131), '2 h 11 min');
  assert.strictEqual(F.textoKm(9.26), '9,3 km');
});
teste('barra de cansaço: folga pelo limite vermelho mais próximo (sem mudar o nível)', () => {
  // 60 min de busca = 25% do limite vermelho (240 min) → folga 75%
  assert.strictEqual(Math.round(F.restante([{ chave: 'tempo', valor: 60 }]) * 100), 75);
  // o limite amarelo (120 min) cai exatamente na metade da barra
  assert.strictEqual(Math.round(F.restante([{ chave: 'tempo', valor: 120 }]) * 100), 50);
  // a estatística mais alta manda: 3 km (de 15) não pesa mais que 5 h (de 4 h)
  assert.strictEqual(F.restante([{ chave: 'tempo', valor: 300 }, { chave: 'km', valor: 3 }]), 0);
  assert.strictEqual(F.restante([{ chave: 'km', valor: 3 }]) > 0.79, true);
  // grupo entra pelo limite do grupo
  assert.strictEqual(Math.round(F.restante([{ chave: 'grupo', valor: 6 }]) * 100), 50);
  // sem estatística: cheia
  assert.strictEqual(F.restante([]), 1);
  // o nível continua o mesmo cálculo de avaliar()
  assert.strictEqual(F.avaliar({ buscaMin: 300, km: 1, kmGrupo: null, emDescansoLongo: false }).nivel, 'vermelho');
});
console.log(falhas ? falhas + ' falha(s)' : 'tudo certo');
process.exit(falhas ? 1 : 0);
