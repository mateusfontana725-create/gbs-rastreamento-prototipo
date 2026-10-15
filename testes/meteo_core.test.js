// Regras do monitoramento meteorológico (public/js/meteo-core.js). Não usa rede.
const M = require('../public/js/meteo-core.js');
const assert = require('assert');
let falhas = 0;
function teste(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
const agora = Date.parse('2026-10-15T20:00:00Z');
const hora = (h) => ({ t: new Date(agora + h * 3600e3).toISOString(), precip: 0, prob: 0, codigo: 1, rajada: 10 });
const nomes = (lista) => lista.map((a) => a.chave).sort();

console.log('Meteorologia: regras');
teste('faixas de chuva', () => {
  assert.strictEqual(M.intensidadeChuva(0), 'nenhuma');
  assert.strictEqual(M.intensidadeChuva(1), 'fraca');
  assert.strictEqual(M.intensidadeChuva(2.5), 'moderada');
  assert.strictEqual(M.intensidadeChuva(10), 'intensa');
});
teste('severidade CAP vira nível do painel', () => {
  assert.strictEqual(M.nivelDeSeveridade('Extreme'), 'critico');
  assert.strictEqual(M.nivelDeSeveridade('Severe'), 'critico');
  assert.strictEqual(M.nivelDeSeveridade('Moderate'), 'alerta');
  assert.strictEqual(M.nivelDeSeveridade('Minor'), 'atencao');
  assert.strictEqual(M.nivelDeSeveridade('Unknown'), 'informativo');
});
teste('distância e rumo (haversine): 0,1° de latitude ≈ 11,1 km, para o norte', () => {
  const d = M.distanciaM(-25.4, -49.2, -25.3, -49.2);
  assert.ok(Math.abs(d - 11119) < 30, 'distância ' + d);
  assert.ok(Math.abs(M.rumoGraus(-25.4, -49.2, -25.3, -49.2)) < 0.5);
});
teste('chuva intensa prevista gera alerta com chegada e incerteza', () => {
  const horas = [0, 1, 2, 3].map(hora);
  horas[2].precip = 11;
  horas[1].prob = 70;
  const r = M.analisar({ atual: { precipitacao: 0 }, horas }, [], agora);
  const intensa = r.find((a) => a.chave === 'chuva-intensa');
  assert.ok(intensa && intensa.nivel === 'alerta');
  assert.strictEqual(intensa.eta.t, horas[1].t, 'chegada pela primeira hora com probabilidade ≥ 60%');
  assert.strictEqual(intensa.eta.incertezaMin, 30);
});
teste('tempestade e granizo são indicativos e não aparecem sem o código do modelo', () => {
  assert.deepStrictEqual(nomes(M.analisar({ atual: { precipitacao: 0 }, horas: [0, 1, 2].map(hora) }, [], agora)), []);
  const horas = [0, 1, 2].map(hora);
  horas[1].codigo = 96;
  assert.deepStrictEqual(nomes(M.analisar({ atual: { precipitacao: 0 }, horas }, [], agora)), ['granizo', 'tempestade']);
});
teste('rajadas: atenção a partir de 40 km/h, alerta a partir de 60 km/h', () => {
  const horas = [0, 1].map(hora);
  horas[1].rajada = 45;
  assert.strictEqual(M.analisar({ horas }, [], agora).find((a) => a.chave === 'rajadas').nivel, 'atencao');
  horas[1].rajada = 61;
  assert.strictEqual(M.analisar({ horas }, [], agora).find((a) => a.chave === 'rajadas').nivel, 'alerta');
});
teste('chegada: sem chuva prevista no modelo, nada é estimado (null)', () => {
  assert.strictEqual(M.previsaoChegada([0, 1, 2].map(hora), agora), null);
});
teste('chegada depois da 1ª hora usa incerteza maior', () => {
  const horas = [0, 1, 2, 3].map(hora);
  horas[3].prob = 80;
  assert.strictEqual(M.previsaoChegada(horas, agora).incertezaMin, 60);
});
teste('alerta oficial mantém a chave, o nível e o horário de validade', () => {
  const oficial = { id: 'INMET-1', evento: 'Tempestades', severidade: 'Severe', inicio: '2026-10-15T20:00:00Z', fim: '2026-10-16T02:00:00Z', descricao: 'x', area: 'Paraná' };
  const r = M.analisar({ horas: [] }, [oficial], agora);
  assert.strictEqual(r[0].chave, 'oficial:INMET-1');
  assert.strictEqual(r[0].nivel, 'critico');
  assert.strictEqual(r[0].fim, oficial.fim);
});
teste('dados desatualizados: nunca atualizado ou além do limite', () => {
  assert.strictEqual(M.desatualizado(null, agora, 20), true);
  assert.strictEqual(M.desatualizado(new Date(agora - 10 * 60e3).toISOString(), agora, 20), false);
  assert.strictEqual(M.desatualizado(new Date(agora - 25 * 60e3).toISOString(), agora, 20), true);
});
teste('sem repetição: só notifica alerta novo ou nível que subiu', () => {
  const a = { nivel: 'alerta' };
  assert.strictEqual(M.deveNotificar(undefined, a), true);
  assert.strictEqual(M.deveNotificar(a, { nivel: 'alerta' }), false);
  assert.strictEqual(M.deveNotificar(a, { nivel: 'critico' }), true);
  assert.strictEqual(M.deveNotificar(a, { nivel: 'atencao' }), false);
});
teste('estados entre leituras: novo, atualizado, mantido e expirado', () => {
  const antes = [{ chave: 'x', nivel: 'alerta', titulo: 'T', detalhe: '' }, { chave: 'y', nivel: 'atencao', titulo: 'U', detalhe: '' }];
  const depois = [{ chave: 'x', nivel: 'critico', titulo: 'T', detalhe: '' }, { chave: 'z', nivel: 'alerta', titulo: 'V', detalhe: '' }];
  const e = Object.fromEntries(M.compararLeituras(antes, depois).map((a) => [a.chave, a.estado]));
  assert.deepStrictEqual(e, { x: 'atualizado', z: 'novo', y: 'expirado' });
});

if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
console.log('\nTodos os testes de meteorologia passaram.');
