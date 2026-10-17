// Teste do esforço de busca do dashboard da operação (public/js/dashboard.js → Dashboard.calcularEsforco)
// Rode com: node testes/esforco.test.js. Trilhas sintéticas com resposta conhecida.
require(require('path').join(__dirname, '../public/js/dashboard.js'));
const D = globalThis.Dashboard;
let ok = 0, falha = 0;
const chk = (c, m, x) => { if (c) { ok++; console.log('  ✔ ' + m); } else { falha++; console.log('  ✘ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };
const perto = (a, b, tol) => Math.abs(a - b) <= tol;

const LAT0 = -22.45, LNG0 = -42.98;
const M_LAT = 1 / 111195;                                   // graus de latitude por metro
const M_LNG = 1 / (111195 * Math.cos(LAT0 * Math.PI / 180)); // graus de longitude por metro
const MIN = 60000;
const INICIO = new Date(2026, 9, 16, 10, 0, 0).getTime();   // 10:00 local (múltiplo de 15 min)

// caminhada para o norte: `metros` em `minutos`, um ponto a cada 30 s, começando em `desde` min
function caminhada(metros, minutos, desde) {
  const n = minutos * 2, seg = [];
  for (let i = 0; i <= n; i++) seg.push({ lat: LAT0 + (metros * i / n) * M_LAT, lng: LNG0, t: INICIO + (desde * MIN) + i * 30000 });
  return [seg];
}
function quadrado(cx, cy, lado) {   // cx, cy em metros a partir de LAT0/LNG0
  const h = lado / 2;
  return [[cy - h, cx - h], [cy - h, cx + h], [cy + h, cx + h], [cy + h, cx - h]]
    .map(([y, x]) => [LAT0 + y * M_LAT, LNG0 + x * M_LNG]);
}

const G1 = { id: 'g1', nome: 'Alfa', cor: '#ef4444' };
const resumo = {
  agora: INICIO + 95 * MIN,
  participantes: [
    { id: 'a', tipo: 'militar', grupo: G1, segmentos: caminhada(1000, 60, 0) },
    { id: 'b', tipo: 'civil', grupo: G1, segmentos: caminhada(500, 30, 60) },
    { id: 'c', tipo: 'civil', grupo: null, segmentos: [] },
    { id: 'r', tipo: 'responsavel', grupo: null, segmentos: [] },
  ],
  setores: [
    { id: 's1', nome: 'No caminho', areaM2: 40000, vertices: quadrado(0, 500, 200) },
    { id: 's2', nome: 'Longe', areaM2: 40000, vertices: quadrado(10000, 500, 200) },
  ],
};
const e = D.calcularEsforco(resumo, INICIO, null);

console.log('Efetivo e totais');
chk(e.efetivo === 3, 'efetivo = 3 (responsável sem trilha não conta)', e.efetivo);
chk(e.porTipo.militar === 1 && e.porTipo.civil === 2, '1 militar e 2 civis', e.porTipo);
chk(e.emCampo === 1, 'em campo agora = 1 (só quem mandou ponto nos últimos 10 min)', e.emCampo);
chk(perto(e.km, 1.5, 0.01), 'percorrido ≈ 1,5 km', e.km);
chk(perto(e.horas, 1.5, 0.001), 'esforço = 1,5 pessoa·hora', e.horas);

console.log('Por grupo');
chk(e.grupos.length === 2 && e.grupos[0].nome === 'Alfa' && e.grupos[0].pessoas === 2, 'Alfa primeiro, com 2 pessoas', e.grupos);
chk(perto(e.grupos[0].km, 1.5, 0.01) && perto(e.grupos[0].horas, 1.5, 0.001), 'Alfa: 1,5 km e 1,5 h', e.grupos[0]);
chk(e.grupos[1].nome === 'Sem grupo' && e.grupos[1].pessoas === 1 && e.grupos[1].km === 0, 'sem grupo: 1 pessoa, 0 km', e.grupos[1]);

console.log('Pessoas em campo no tempo');
const at = e.atividade;
chk(at && at.passo === 15 * MIN, 'intervalos de 15 min para 1 h 35 min de operação', at && at.passo);
chk(at && at.baldes.length === 7, '7 intervalos (10:00 até 11:35)', at && at.baldes.length);
chk(at && at.baldes[0].pessoas === 1 && at.baldes[4].pessoas === 2 && at.baldes[6].pessoas === 1,
  '1 pessoa no início, 2 quando B entra, 1 no fim', at && at.baldes.map((b) => b.pessoas));
chk(D.calcularEsforco({ agora: INICIO, participantes: [], setores: [] }, null, null).atividade === null,
  'sem início e sem pontos: sem gráfico');

console.log('Cobertura dos setores');
const s1 = e.setores.find((s) => s.id === 's1'), s2 = e.setores.find((s) => s.id === 's2');
chk(perto(s1.cobertura, 1 / 7, 0.03), 'setor no caminho: uma faixa de 7 quadrados de 30 m em 49 (≈ 14%)', s1.cobertura);
// o setor vai de 400 a 600 m ao norte: A atravessa; B termina a caminhada (500 m) dentro dele, aos 90 min
chk(s1.pessoas === 2 && s1.ultimaPassagem === INICIO + 90 * MIN, 'A e B passaram; última passagem aos 90 min (B termina dentro)', [s1.pessoas, s1.ultimaPassagem && (s1.ultimaPassagem - INICIO) / MIN]);
chk(s2.cobertura === 0 && s2.ultimaPassagem === null, 'setor longe: 0%, ninguém passou', s2);
chk(e.setores[0].id === 's2', 'o menos coberto aparece primeiro');
chk(perto(e.coberturaMedia, (1 / 7) / 2, 0.02), 'média ponderada pela área ≈ 7%', e.coberturaMedia);

console.log('\nEsforço de busca: ' + ok + ' OK, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
