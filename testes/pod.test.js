// Teste de POD, POA e POS (public/js/pod.js). Rode com: node testes/pod.test.js
// Trilhas sintéticas em linha reta, com resposta conhecida pelas fórmulas do módulo.
require(require('path').join(__dirname, '../public/js/pod.js'));
const P = globalThis.POD;
let ok = 0, falha = 0;
const chk = (c, m, x) => { if (c) { ok++; console.log('  ✔ ' + m); } else { falha++; console.log('  ✘ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };
const perto = (a, b, tol) => Math.abs(a - b) <= tol;

const LAT0 = -22.45, LNG0 = -42.98;
const M_LAT = 1 / 111195, M_LNG = 1 / (111195 * Math.cos(LAT0 * Math.PI / 180));
const MIN = 60000;
const T0 = new Date(2026, 9, 16, 10, 0, 0).getTime();

// quadrado de `lado` metros centrado em (x, y) metros a partir do ponto de origem
function quadrado(x, y, lado) {
  const h = lado / 2;
  return [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]].map(([mx, my]) => [LAT0 + my * M_LAT, LNG0 + mx * M_LNG]);
}
// trilha em linha reta de (x1,y1) a (x2,y2) em metros, um ponto a cada 5 s, começando em `desde` min
function reta(x1, y1, x2, y2, minutos, desde) {
  const n = minutos * 12, pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    pts.push({ lat: LAT0 + (y1 + (y2 - y1) * f) * M_LAT, lng: LNG0 + (x1 + (x2 - x1) * f) * M_LNG, t: T0 + desde * MIN + i * 5000 });
  }
  return pts;
}
const AGORA = T0 + 600 * MIN;

// Setor único de 200 m (x de -100 a 100) e uma varredura de lado a lado, no meio
const SETOR_A = { id: 'A', nome: 'Setor A', poligono: quadrado(0, 0, 200) };
const PASSA_A = reta(-150, 0, 150, 0, 4, 0);

console.log('Sem trilhas');
{
  const r = P.calcular({ setores: [SETOR_A], buscas: [], agora: AGORA });
  chk(r.setores.length === 1 && perto(r.setores[0].poa, 1, 1e-9), 'único setor: POA atual 100%', r.setores[0]);
  chk(r.posTotal === 0 && r.setores[0].pos === 0 && r.setores[0].pod === 0, 'sem buscas: POS 0 e POD 0', [r.posTotal, r.setores[0].pod]);
}

console.log('Uma busca');
const umaBusca = P.calcular({ setores: [SETOR_A], buscas: [{ id: 'b1', setorId: 'A', grupo: 'Alfa', inicio: T0, fim: T0 + 4 * MIN, trilhas: [PASSA_A] }], agora: AGORA });
const b1 = umaBusca.buscas[0];
chk(b1.pos > 0 && b1.pos < 1, 'POS da busca entre 0 e 100%', b1.pos);
chk(perto(umaBusca.posTotal, b1.pos, 1e-9), 'uma busca: POS acumulado = POS da busca', [umaBusca.posTotal, b1.pos]);
chk(perto(umaBusca.setores[0].pos, umaBusca.posTotal, 1e-9) && perto(umaBusca.setores[0].poa, 1, 1e-9), 'setor único: POA continua 100% (é toda a área)');
chk(b1.pod > 0 && b1.pod < 1 && perto(b1.pod, b1.pos, 1e-9), 'POD médio do setor = POS quando o setor tem toda a probabilidade', [b1.pod, b1.pos]);
chk(b1.percorridoM > 190 && b1.percorridoM < 230, 'trilha dentro do setor: ≈ 200 m percorridos (aproximado pela amostragem)', b1.percorridoM);

console.log('Buscas sucessivas e sobreposição');
// mesma trilha duas vezes em buscas separadas, contra a mesma trilha duas vezes numa só busca
const duasBuscas = P.calcular({ setores: [SETOR_A], agora: AGORA, buscas: [
  { id: 'b1', setorId: 'A', inicio: T0, fim: T0 + 4 * MIN, trilhas: [PASSA_A] },
  { id: 'b2', setorId: 'A', inicio: T0 + 10 * MIN, fim: T0 + 14 * MIN, trilhas: [reta(-150, 0, 150, 0, 4, 10)] },
] });
const dobrada = P.calcular({ setores: [SETOR_A], agora: AGORA, buscas: [
  { id: 'b1', setorId: 'A', inicio: T0, fim: T0 + 20 * MIN, trilhas: [PASSA_A, reta(-150, 0, 150, 0, 4, 10)] },
] });
chk(duasBuscas.posTotal <= 1 + 1e-12 && dobrada.posTotal <= 1 + 1e-12, 'POS acumulado nunca passa de 100%', [duasBuscas.posTotal, dobrada.posTotal]);
chk(duasBuscas.buscas[1].pos < duasBuscas.buscas[0].pos, 'a segunda busca na mesma área acha menos (a probabilidade já foi vista)', [duasBuscas.buscas[0].pos, duasBuscas.buscas[1].pos]);
chk(perto(duasBuscas.posTotal, dobrada.posTotal, 1e-9), 'duas buscas seguidas = uma busca com o esforço somado (1 − e^(−2C), sem dupla contagem)', [duasBuscas.posTotal, dobrada.posTotal]);
chk(duasBuscas.posTotal < 2 * umaBusca.posTotal - 1e-9, 'duas buscas não somam POS (menos que o dobro)', [duasBuscas.posTotal, umaBusca.posTotal]);
chk(perto(duasBuscas.posTotal, 1 - (1 - duasBuscas.buscas[0].pos) * (1 - duasBuscas.buscas[1].pos), 1e-9), 'POS acumulado = 1 − Π(1 − POS de cada busca)', [duasBuscas.posTotal]);

console.log('Setores que se sobrepõem');
const SETOR_B = { id: 'B', nome: 'Setor B', poligono: quadrado(100, 0, 200) };   // metade em comum com o A
const dois = P.calcular({ setores: [SETOR_A, SETOR_B], agora: AGORA, buscas: [
  { id: 'b1', setorId: 'A', inicio: T0, fim: T0 + 4 * MIN, trilhas: [PASSA_A] },
  { id: 'b2', setorId: 'B', inicio: T0 + 10 * MIN, fim: T0 + 14 * MIN, trilhas: [reta(-50, 0, 250, 0, 6, 10)] },
] });
const somaSetores = dois.setores[0].pos + dois.setores[1].pos;
chk(dois.posTotal <= 1 + 1e-12 && dois.setores.every(s => s.pos <= 1 + 1e-12), 'POS de cada setor e do total ≤ 100%', [dois.posTotal, dois.setores.map(s => s.pos)]);
chk(dois.posTotal < somaSetores - 1e-6, 'a área sobreposta conta uma vez: o total é menor que a soma dos setores', [dois.posTotal, somaSetores]);
chk(dois.posTotal >= Math.max(dois.setores[0].pos, dois.setores[1].pos) - 1e-12, 'o total não é menor que o de nenhum setor', dois.posTotal);
chk(dois.setores[0].poaInicial > 0.5 && dois.setores[0].poaInicial < 1 && dois.setores[1].poaInicial < 1 &&
  dois.setores[0].poaInicial + dois.setores[1].poaInicial > 1,
  'POA inicial de setores sobrepostos: a área comum pertence aos dois (soma > 100%, mas o total continua 100%)', [dois.setores[0].poaInicial, dois.setores[1].poaInicial]);

console.log('Setores disjuntos');
const SETOR_C = { id: 'C', nome: 'Setor C', poligono: quadrado(400, 0, 200) };   // sem sobreposição com o A
const disj = P.calcular({ setores: [SETOR_A, SETOR_C], agora: AGORA, buscas: [
  { id: 'b1', setorId: 'A', inicio: T0, fim: T0 + 4 * MIN, trilhas: [PASSA_A] },
] });
const [sA, sC] = disj.setores;
chk(perto(sA.poaInicial, 0.5, 1e-6) && perto(sC.poaInicial, 0.5, 1e-6), 'POA inicial divide a probabilidade pela área (50% / 50%)', [sA.poaInicial, sC.poaInicial]);
chk(sA.poa < sA.poaInicial && sC.poa > sC.poaInicial, 'depois de varrer A, a probabilidade migra para C', [sA.poa, sC.poa]);
chk(perto(sA.poa + sC.poa, 1, 1e-9), 'POA atual dos setores soma 100%', sA.poa + sC.poa);
chk(perto(disj.posTotal, sA.pos, 1e-9) && sC.pos === 0, 'POS total vem só da busca feita no A', [disj.posTotal, sA.pos]);
chk(disj.buscas[0].poaDepois < disj.buscas[0].poaAntes, 'busca reduz o POA do setor pesquisado', [disj.buscas[0].poaAntes, disj.buscas[0].poaDepois]);

console.log('Limites e entradas');
// 25 buscas: a faixa varrida (1/7 da área) fica quase toda vista; o resto da área nunca é tocado
const muitas = P.calcular({ setores: [SETOR_A], agora: AGORA, buscas: Array.from({ length: 25 }, (_, i) => (
  { id: 'm' + i, setorId: 'A', inicio: T0 + i * 10 * MIN, fim: T0 + (i * 10 + 4) * MIN, trilhas: [reta(-150, 0, 150, 0, 4, i * 10)] })) });
chk(muitas.posTotal <= 1 && muitas.posTotal > 0.13 && muitas.posTotal < 0.15, 'muitas buscas na mesma faixa: POS satura na parte da área que a faixa cobre (≈ 1/7)', muitas.posTotal);
chk(muitas.buscas[24].pos < 1e-6, 'a última busca já não acha nada novo', muitas.buscas[24].pos);
chk(muitas.setores[0].pod <= 1 && muitas.buscas.every(b => b.pod == null || b.pod <= 1 + 1e-12), 'POD nunca passa de 100%');
const fora = P.calcular({ setores: [SETOR_A], agora: AGORA, buscas: [{ id: 'x', setorId: 'A', inicio: T0 + 30 * MIN, fim: T0 + 34 * MIN, trilhas: [PASSA_A] }] });
chk(fora.posTotal === 0, 'pontos fora da janela da busca não contam', fora.posTotal);
const emAndamento = P.calcular({ setores: [SETOR_A], agora: T0 + 4 * MIN, buscas: [{ id: 'x', setorId: 'A', inicio: T0, fim: null, trilhas: [PASSA_A] }] });
chk(emAndamento.posTotal > 0 && emAndamento.buscas[0].fim === null, 'busca sem fim usa o horário atual e segue em andamento', emAndamento.posTotal);
const ordem = P.calcular({ setores: [SETOR_A], agora: AGORA, buscas: [
  { id: 'b2', setorId: 'A', inicio: T0 + 10 * MIN, fim: T0 + 14 * MIN, trilhas: [reta(-150, 0, 150, 0, 4, 10)] },
  { id: 'b1', setorId: 'A', inicio: T0, fim: T0 + 4 * MIN, trilhas: [PASSA_A] },
] });
chk(perto(ordem.posTotal, duasBuscas.posTotal, 1e-9), 'a ordem das buscas na entrada não muda o resultado (ordenadas por horário)', [ordem.posTotal, duasBuscas.posTotal]);
const semArea = P.calcular({ setores: [{ id: 'z', nome: 'Linha', poligono: [[LAT0, LNG0], [LAT0, LNG0 + M_LNG]] }], buscas: [], agora: AGORA });
chk(semArea.setores.length === 0 && semArea.posTotal === null, 'setor sem área (menos de 3 vértices) é ignorado');

console.log('\nPOD, POA e POS: ' + ok + ' OK, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
