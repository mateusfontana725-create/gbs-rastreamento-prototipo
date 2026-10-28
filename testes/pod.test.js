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
  chk(todas.registros[0].conta && todas.registros[1].motivo === 'inconsistente' && perto(set(todas, 'B').poaAtual, 1), 'POD 100% nos dois setores sem achar: a segunda busca negativa é impossível, fica marcada inconsistente', todas);
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

console.log('Exemplo do guia (cap. 13): A 45%, B 25%, C 20%, externo 10%');
{
  const setores = [{ setorId: 'A', nome: 'A', poa: 0.45 }, { setorId: 'B', nome: 'B', poa: 0.25 }, { setorId: 'C', nome: 'C', poa: 0.20 }];
  const m1 = reg('M1', 'A', 0.6, 5), m2 = reg('M2', 'B', 0.5, 10);
  const r1 = P.calcular({ cenario: cenario(setores), registros: [m1], vitimaId: 'v' });
  chk(perto(r1.registros[0].pos, 0.27), 'POS de M1 = 0,45 × 0,60 = 27%');
  chk(perto(set(r1, 'A').poaAtual, 0.18 / 0.73) && perto(set(r1, 'B').poaAtual, 0.25 / 0.73) && perto(set(r1, 'C').poaAtual, 0.20 / 0.73) && perto(r1.poaForaAtual, 0.10 / 0.73), 'depois de M1: A 24,66%, B 34,25%, C 27,40%, externo 13,70%', r1);
  const r2 = P.calcular({ cenario: cenario(setores), registros: [m1, m2], vitimaId: 'v' });
  chk(perto(r2.registros[1].pos, (0.25 / 0.73) * 0.5), 'POS de M2 dado M1 negativa = (0,25 ÷ 0,73) × 0,50 ≈ 17,12%', r2.registros[1].pos);
  chk(perto(set(r2, 'A').poaAtual, 0.18 / 0.605) && perto(set(r2, 'B').poaAtual, 0.125 / 0.605) && perto(set(r2, 'C').poaAtual, 0.20 / 0.605) && perto(r2.poaForaAtual, 0.10 / 0.605), 'depois de M1 e M2: A 29,75%, B 20,66%, C 33,06%, externo 16,53%', r2);
  chk(perto(r2.posTotal, 0.395), 'probabilidade cumulativa de detecção na base inicial = 39,5% (não 27% + 17,12%)', r2.posTotal);
}

console.log('Denominador zero: inconsistência explícita, sem inventar posterior');
{
  const r = P.calcular({ cenario: cenario([{ setorId: 'A', nome: 'A', poa: 1 }]), registros: [reg('r', 'A', 1, 5)], vitimaId: 'v' });
  chk(r.registros[0].conta === false && r.registros[0].motivo === 'inconsistente' && perto(set(r, 'A').poaAtual, 1) && set(r, 'A').pod === null, 'POD 100% onde estava 100%: registro marcado inconsistente, cenário anterior mantido', r);
}

console.log('POD planejada, não estimada e busca em parte do setor (guia, cap. 2.1, 3, 5.4 e 18)');
{
  const setores = [{ setorId: 'A', nome: 'A', poa: 0.5, areaM2: 1e6 }, { setorId: 'B', nome: 'B', poa: 0.3, areaM2: 250000 }];
  const base = P.calcular({ cenario: cenario(setores), registros: [], vitimaId: 'v' });
  const plan = P.calcular({ cenario: cenario(setores), registros: [reg('p', 'A', 0.8, 5, { finalidade: 'planejada' })], vitimaId: 'v' });
  chk(plan.registros[0].motivo === 'planejada' && perto(plan.registros[0].posPrevista, 0.5 * 0.8) && perto(set(plan, 'A').poaAtual, set(base, 'A').poaAtual) && plan.posTotal === 0, 'POD planejada só gera POS prevista; não altera POA atual nem POS', plan.registros[0]);
  const sem = P.calcular({ cenario: cenario(setores), registros: [reg('n', 'A', null, 5)], vitimaId: 'v' });
  chk(sem.registros[0].motivo === 'sem_estimativa' && set(sem, 'A').pod === null && set(sem, 'A').semEstimativa === 1 && perto(set(sem, 'A').poaAtual, 0.5) && sem.posTotal === 0, 'POD não estimada: a busca fica registrada, mas não reduz o POA e não vira POD zero', sem);
  const zero = P.calcular({ cenario: cenario(setores), registros: [reg('z', 'A', 0, 5)], vitimaId: 'v' });
  chk(zero.registros[0].conta === true && perto(set(zero, 'A').pod, 0), 'POD estimada em zero é diferente de não estimada (conta, com POD 0)');
  const parc = P.calcular({ cenario: cenario(setores), registros: [reg('c', 'A', 0.8, 5, { coberturaFracao: 0.5 })], vitimaId: 'v' });
  chk(perto(set(parc, 'A').pod, 0.4) && perto(parc.registros[0].podInformado, 0.8) && perto(set(parc, 'A').pos, 0.2), 'busca em metade do setor com POD 80% na parte coberta: POD do setor 40% (hipótese uniforme explícita)', parc.setores[0]);
  chk(perto(set(base, 'A').pdenPorKm2, 50) && perto(set(base, 'B').pdenPorKm2, 120), 'densidade de probabilidade em % por km² (apoio, não ordem automática)', base.setores.map((s) => s.pdenPorKm2));
}

console.log('Setores sobrepostos (guia, cap. 1 e 8.3) — mesmos números do banco');
{
  const d = (m) => m / 111194.93;
  const circ = (lat, r) => ({ forma: 'circulo', centroLat: lat, centroLng: -49.2, raioM: r });
  const A = circ(-25.40, 300), f = (b) => P.sobreposicaoFracao(P.poligonoDoSetor(A), P.poligonoDoSetor(b));
  chk(f(circ(-25.40 + d(2000), 300)) === 0 && f(circ(-25.40 + d(700), 300)) === 0, 'setores afastados ou com folga: sem sobreposição');
  chk(perto(f(circ(-25.40 + d(400), 300)), 0.22033898305084745, 1e-9), 'dois círculos de 300 m com centros a 400 m: 22% do menor em comum');
  chk(f(circ(-25.40, 100)) === 1 && f(circ(-25.40, 300)) === 1, 'setor dentro de outro e setores idênticos: 100%');
  chk(f(circ(-25.40 + d(595), 300)) <= P.LIMITE_SOBREPOSICAO, 'encosto de poucos metros (divisa desenhada à mão) não conta como sobreposição');
  const quad = { forma: 'poligono', pontos: [[-25.40179864315756, -49.199100678421225], [-25.40179864315756, -49.1955033921061], [-25.39820135684244, -49.1955033921061], [-25.39820135684244, -49.199100678421225]] };
  chk(perto(f(quad), 0.5088888888888888, 1e-9), 'círculo e quadrado (polígono desenhado): 50,9%');
  const pares = P.sobreposicoes([{ nome: 'A', poa: 0.4, ...A }, { nome: 'B', poa: 0.3, ...circ(-25.40 + d(400), 300) }, { nome: 'C', poa: 0, ...circ(-25.40, 300) }]);
  chk(pares.length === 1 && pares[0].a === 'A' && pares[0].b === 'B', 'só pares com POA > 0 entram na conta (C tem POA zero)', pares);
}

console.log('Atualização pós-busca negativa (posBusca): r = p × (1 − q), Z = Σr, p\' = r/Z — igual à do servidor');
{
  const base = { setores: [{ id: 'A', poa: 0.5 }, { id: 'B', poa: 0.3 }], fora: 0.2, setorId: 'A' };
  const r = P.posBusca(Object.assign({ pod: 0.6 }, base));
  chk(r.ok && perto(r.z, 0.7) && perto(r.q, 0.6) && perto(r.pos, 0.3, 1e-6), 'q = 60%, Z = 0,7 e POS = POA × POD = 50% × 60% = 30%', r);
  chk(perto(r.setores[0].poa, 0.2 / 0.7, 1e-6) && perto(r.setores[1].poa, 0.3 / 0.7, 1e-6) && perto(r.fora, 0.2 / 0.7, 1e-6), 'novo POA: Alfa 28,57%, Bravo 42,86%, fora 28,57%', r);
  chk(perto(r.setores.reduce((a, s) => a + s.poa, 0) + r.fora, 1, 1e-12), 'a soma, com "Fora da área", fecha em exatamente 100%');
  const c = P.posBusca(Object.assign({ pod: 0.5, cobertura: 0.4 }, base));
  chk(perto(c.q, 0.2) && perto(c.setores[0].poa, 0.4 / 0.9, 1e-6), 'cobertura real de 40%: q = POD × cobertura = 20%', c);
  chk(P.posBusca(Object.assign({ pod: null }, base)).motivo === 'pod_desconhecido' && P.posBusca(Object.assign({}, base)).motivo === 'pod_desconhecido', 'POD desconhecido não recalcula (pendência), nunca vira zero');
  chk(P.posBusca({ setores: [{ id: 'A', poa: 1 }], fora: 0, setorId: 'A', pod: 1 }).motivo === 'z_zero', 'Z = 0 (tudo no setor, POD 100%): inconsistência, sem resultado');
  chk(P.posBusca(Object.assign({ pod: 0.5 }, base, { setorId: 'X' })).motivo === 'setor_fora_do_cenario', 'setor fora do cenário: nada a atualizar');
  chk(P.posBusca({ setores: [{ id: 'A', poa: 0.7 }, { id: 'B', poa: 0.5 }], fora: 0, setorId: 'A', pod: 0.5 }).motivo === 'invalido' && P.posBusca(Object.assign({ pod: 1.5 }, base)).motivo === 'invalido', 'soma diferente de 100% ou POD fora de 0–1: inválido');
  // sequência: duas missões em setores diferentes = aplicar uma depois da outra (sem somar PODs)
  const um = P.posBusca(Object.assign({ pod: 0.6 }, base));
  const dois = P.posBusca({ setores: um.setores, fora: um.fora, setorId: 'B', pod: 0.5 });
  const rA = 0.2 / 0.7, rB = (0.3 / 0.7) * 0.5, rF = 0.2 / 0.7, Z = rA + rB + rF;
  chk(dois.ok && perto(dois.setores[0].poa, rA / Z, 1e-6) && perto(dois.setores[1].poa, rB / Z, 1e-6), 'missões em sequência: a segunda parte da versão já atualizada (igual ao teste do banco)', dois);
  const mesmo = P.posBusca({ setores: um.setores, fora: um.fora, setorId: 'A', pod: 0.6 });
  chk(perto(mesmo.setores[0].poa, (0.2 / 0.7 * 0.4) / ((0.2 / 0.7) * 0.4 + 0.3 / 0.7 + 0.2 / 0.7), 1e-6), 'mesmo setor de novo: usa o POA já atualizado (1 − POD aplicado sobre o que sobrou)');
}

console.log('\nPOA, POD e POS: ' + ok + ' OK, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
