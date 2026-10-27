// Teste de POA, POD e POS (public/js/pod.js). Rode com: node testes/pod.test.js
// O POD vem só dos registros manuais; as respostas esperadas saem das fórmulas do módulo, feitas à mão.
require(require('path').join(__dirname, '../public/js/pod.js'));
const P = globalThis.POD;
let ok = 0, falha = 0;
const chk = (c, m, x) => { if (c) { ok++; console.log('  ✔ ' + m); } else { falha++; console.log('  ✘ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };
const perto = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-9 : tol);

const T0 = new Date(2026, 9, 16, 10, 0, 0).getTime();
const MIN = 60000;
const cenario = (setores, extra) => Object.assign({ id: 'c1', numero: 1, aprovadaEm: T0, setores }, extra || {});
const reg = (id, setorId, pod, min, extra) => Object.assign({ id, setorId, vitimaId: null, pod, registradoEm: T0 + min * MIN, anulado: false }, extra || {});
const set = (r, id) => r.setores.find((s) => s.setorId === id);

console.log('Sem cenário aprovado');
chk(P.calcular({ cenario: null, registros: [reg('r', 'A', 0.5, 1)], vitimaId: 'v' }) === null, 'sem versão aprovada não há cálculo (o app não inventa POA)');

console.log('POD acumulado');
chk(perto(P.acumular([]), 0) && perto(P.acumular([0.5]), 0.5), 'nenhuma busca = 0; uma busca = o próprio POD');
chk(perto(P.acumular([0.5, 0.5]), 0.75) && perto(P.acumular([0.6, 0.5, 0.5]), 0.9), 'várias buscas: 1 − Π(1 − POD)');
chk(perto(P.acumular([1, 0.3]), 1) && P.acumular([0.99, 0.99, 0.99]) < 1, 'nunca passa de 100%');
chk(perto(P.acumular([2, -1]), 1), 'valores fora de 0–1 são limitados');

console.log('Sem buscas: o POA atual é o aprovado');
{
  const r = P.calcular({ cenario: cenario([{ setorId: 'A', nome: 'A', poa: 0.5 }, { setorId: 'B', nome: 'B', poa: 0.3 }]), registros: [], vitimaId: 'v' });
  chk(perto(set(r, 'A').poaAtual, 0.5) && perto(set(r, 'B').poaAtual, 0.3) && perto(r.poaFora, 0.2) && perto(r.poaForaAtual, 0.2), 'POA atual = POA aprovado; o que sobra fica "fora dos setores"', r);
  chk(set(r, 'A').pod === null && set(r, 'A').pos === 0 && r.posTotal === 0, 'sem registro não há POD (nulo), POS é zero');
}

console.log('Uma busca, conta feita à mão');
{
  // A 50%, B 30%, fora 20%. Busca em A com POD 60%.
  // POS(A) = 0,5 × 0,6 = 0,3. Sobra: A 0,2, B 0,3, fora 0,2 → Z = 0,7.
  const r = P.calcular({ cenario: cenario([{ setorId: 'A', nome: 'A', poa: 0.5 }, { setorId: 'B', nome: 'B', poa: 0.3 }]), registros: [reg('r1', 'A', 0.6, 5)], vitimaId: 'v' });
  chk(perto(set(r, 'A').pod, 0.6) && perto(set(r, 'A').pos, 0.3), 'POD do setor = registro; POS = POA × POD', set(r, 'A'));
  chk(perto(r.posTotal, 0.3), 'POS total = 30%', r.posTotal);
  chk(perto(set(r, 'A').poaAtual, 0.2 / 0.7) && perto(set(r, 'B').poaAtual, 0.3 / 0.7) && perto(r.poaForaAtual, 0.2 / 0.7), 'Bayes: a probabilidade migra para o que não foi visto (A cai, B e fora sobem)', r);
  chk(perto(set(r, 'A').poaAtual + set(r, 'B').poaAtual + r.poaForaAtual, 1), 'o POA atual soma 100%');
  chk(r.ordem[0] === 'B' && r.ordem[r.ordem.length - 1] === 'A', 'ordem sugerida: do maior POA atual para o menor', r.ordem);
  const x = r.registros[0];
  chk(x.conta && perto(x.pos, 0.3) && perto(x.poaAntes, 0.5) && perto(x.poaDepois, 0.2 / 0.7), 'o registro mostra POA antes e depois e o POS da busca', x);
}

console.log('Várias buscas: nunca passa de 100% e não importa a ordem');
{
  const setores = [{ setorId: 'A', nome: 'A', poa: 0.6 }, { setorId: 'B', nome: 'B', poa: 0.4 }];
  const r = P.calcular({ cenario: cenario(setores), registros: [reg('r1', 'A', 0.5, 1), reg('r2', 'A', 0.5, 2), reg('r3', 'B', 0.9, 3)], vitimaId: 'v' });
  chk(perto(set(r, 'A').pod, 0.75), 'duas buscas de 50% no mesmo setor: POD acumulado 75%', set(r, 'A'));
  // POS = 0,6 × 0,75 + 0,4 × 0,9 = 0,45 + 0,36 = 0,81; Z = 0,19
  chk(perto(r.posTotal, 0.81), 'POS total = soma dos POS dos setores', r.posTotal);
  chk(perto(r.registros.reduce((z, x) => z * (1 - x.pos), 1), 1 - r.posTotal, 1e-9), 'POS total = 1 − Π(1 − POS de cada busca)');
  const invertido = P.calcular({ cenario: cenario(setores), registros: [reg('r3', 'B', 0.9, 1), reg('r2', 'A', 0.5, 2), reg('r1', 'A', 0.5, 3)], vitimaId: 'v' });
  chk(perto(set(invertido, 'A').poaAtual, set(r, 'A').poaAtual) && perto(invertido.posTotal, r.posTotal), 'a ordem das buscas não muda o resultado final');
  const todas = P.calcular({ cenario: cenario(setores), registros: [reg('r1', 'A', 1, 1), reg('r2', 'B', 1, 2)], vitimaId: 'v' });
  chk(perto(todas.posTotal, 1) && perto(todas.poaForaAtual, 0), 'POD 100% em tudo: POS 100%, nada sobra', todas);
}

console.log('Quais registros contam');
{
  const setores = [{ setorId: 'A', nome: 'A', poa: 0.5 }, { setorId: 'B', nome: 'B', poa: 0.5 }];
  const regs = [
    reg('antes', 'A', 0.9, -30),                                         // lançado antes da aprovação: a versão já sabia
    reg('anulado', 'A', 0.9, 5, { anulado: true }),
    reg('outra', 'A', 0.9, 6, { vitimaId: 'outro' }),
    reg('semsetor', 'Z', 0.9, 7),
    reg('orfao', null, 0.9, 8),
    reg('vale', 'B', 0.4, 9, { vitimaId: 'v' }),                          // só desta vítima
    reg('todas', 'A', 0.2, 10),                                          // vale para todas
  ];
  const r = P.calcular({ cenario: cenario(setores), registros: regs, vitimaId: 'v' });
  const m = Object.fromEntries(r.registros.map((x) => [x.id, x.motivo]));
  chk(m.antes === 'anterior_a_versao' && m.anulado === 'anulado' && m.outra === 'outra_vitima' && m.semsetor === 'setor_fora_do_cenario' && m.orfao === 'setor_fora_do_cenario', 'ignora: anterior à versão, anulado, de outra vítima e de setor fora do cenário', m);
  chk(m.vale === null && m.todas === null, 'conta: da própria vítima e os que valem para todas', m);
  chk(perto(set(r, 'A').pod, 0.2) && perto(set(r, 'B').pod, 0.4), 'só os que contam entram no POD acumulado', r.setores);
}

console.log('Setor excluído depois da aprovação');
{
  const r = P.calcular({ cenario: cenario([{ setorId: 'A', nome: 'A', poa: 0.5 }, { setorId: null, nome: 'Leste (excluído)', poa: 0.3 }]), registros: [], vitimaId: 'v' });
  chk(r.setores.length === 1 && perto(r.poaFora, 0.5) && perto(r.poaForaAtual, 0.5), 'o POA do setor excluído passa para "fora dos setores"', r);
}

console.log('O GPS não entra no cálculo');
{
  const r = P.calcular({ cenario: cenario([{ setorId: 'A', nome: 'A', poa: 1 }]), registros: [], vitimaId: 'v', trilhas: [[{ lat: 0, lng: 0, t: 1 }]], buscas: [{ setorId: 'A', trilhas: [[{ lat: 0, lng: 0, t: 1 }]] }] });
  chk(set(r, 'A').pod === null && r.posTotal === 0, 'trilhas e missões passadas ao cálculo são ignoradas: sem registro manual, sem POD');
  chk(!/trilha|gps/i.test(P.calcular.toString()), 'o código do cálculo não lê trilhas nem GPS');
}

console.log('Sugestões');
{
  const a = P.distribuirPelaArea([{ id: 'A', areaM2: 10000 }, { id: 'B', areaM2: 30000 }]);
  chk(perto(a.A, 0.25) && perto(a.B, 0.75), 'distribuir pela área: POA proporcional à área', a);
  const b = P.distribuirPelaArea([{ id: 'A', areaM2: 1 }, { id: 'B', areaM2: 1 }, { id: 'C', areaM2: 1 }], 0.9);
  chk(P.somaPoa(Object.values(b)) <= 0.9 + 1e-9 && perto(b.A, 0.3), 'distribuir 90% em três setores iguais: arredonda para baixo, nunca passa do total', b);
  chk(P.somaPoa(Object.values(P.distribuirPelaArea([{ id: 'A', areaM2: 1 }, { id: 'B', areaM2: 1 }, { id: 'C', areaM2: 1 }]))) <= 1, 'em três partes iguais a soma não passa de 100%');
  const r = P.calcular({ cenario: cenario([{ setorId: 'A', nome: 'A', poa: 0.5 }, { setorId: 'B', nome: 'B', poa: 0.3 }]), registros: [reg('r1', 'A', 0.6, 5)], vitimaId: 'v' });
  const s = P.sugerirProximaVersao(r);
  chk(perto(s.A, 0.285) && perto(s.B, 0.428) && P.somaPoa(Object.values(s)) <= 1, 'sugestão da próxima versão = POA atual (Bayes), em 0,1%', s);
  chk(Object.keys(P.sugerirProximaVersao(null)).length === 0, 'sem resultado não há sugestão');
}

console.log('\nPOA, POD e POS: ' + ok + ' OK, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
