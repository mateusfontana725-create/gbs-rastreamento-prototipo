// Agrupamento na visão 3D (public/js/agrupar-3d.js) — rode com: node testes/agrupar_3d.test.js
const A = require(require('path').join(__dirname, '../public/js/agrupar-3d.js'));
let ok = 0, falha = 0;
const chk = (c, m, x) => { if (c) { ok++; console.log('  ✔ ' + m); } else { falha++; console.log('  ✘ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };

console.log('Altura da câmera');
const base = { lat: -25.5, alturaTelaPx: 800, pitchGraus: 0 };
const z17 = A.alturaCameraM(Object.assign({ zoom: 17 }, base));
const z18 = A.alturaCameraM(Object.assign({ zoom: 18 }, base));
chk(Math.abs(z18 * 2 - z17) / z17 < 0.01, 'cada nível de zoom a mais divide a altura pela metade', [z17, z18]);
chk(z17 > 500 && z17 < 800, 'zoom 17 de tela de 800 px, de cima: ~650 m de altura', Math.round(z17));
chk(A.alturaCameraM(Object.assign({ zoom: 17 }, base, { pitchGraus: 60 })) < z17 / 1.9, 'inclinar a câmera (60°) baixa a altura em relação ao chão', A.alturaCameraM(Object.assign({ zoom: 17 }, base, { pitchGraus: 60 })));
chk(A.alturaCameraM(Object.assign({ zoom: 17 }, base, { lat: -60 })) < z17, 'mais perto dos polos a mesma escala dá altura menor', 'lat -60');
chk(A.ALTURA_AGRUPAR_M === 50, 'limite de agrupamento: 50 m');
// zoom em que a altura passa de 50 m com a câmera olhando para baixo, tela de 800 px
let z = 14; while (A.alturaCameraM(Object.assign({ zoom: z }, base)) >= 50) z++;
chk(z >= 19 && z <= 21, 'a 50 m (câmera de cima, tela de 800 px) o zoom está em torno de 20', z);

console.log('Agrupamento na tela');
const pts = [
  { x: 100, y: 100, i: 0 }, { x: 110, y: 105, i: 1 }, { x: 120, y: 100, i: 2 },   // perto uns dos outros
  { x: 400, y: 400, i: 3 },                                                       // sozinho
  { x: 405, y: 398, i: 4 },
];
const g = A.agruparPorTela(pts, 36);
chk(g.length === 2, 'itens a menos de 36 px viram um grupo; o resto fica separado', g.map((x) => x.membros));
chk(g[0].membros.join() === '0,1,2' && g[1].membros.join() === '3,4', 'os membros de cada grupo são os certos', g.map((x) => x.membros));
const cx = g[0].x;
chk(Math.abs(cx - 110) < 1e-9, 'o grupo fica no centro dos seus membros', cx);
chk(A.agruparPorTela(pts, 1).length === 5, 'raio pequeno: nenhum agrupa (cada item sozinho)');
chk(A.agruparPorTela(pts, 1000).length === 1, 'raio grande: tudo num grupo só');
chk(A.agruparPorTela([], 36).length === 0, 'sem itens: nenhum grupo');

console.log('\n' + ok + ' OK, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
