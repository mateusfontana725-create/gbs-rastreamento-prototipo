// Teste da geometria das trilhas (public/js/trilha-geo.js) — rode com: node testes/trilha_geo.test.js
require(require('path').join(__dirname, '../public/js/trilha-geo.js'));
const G = globalThis.TrilhaGeo;
let ok = 0, falha = 0;
const chk = (c, m, x) => { if (c) { ok++; console.log('  ✔ ' + m); } else { falha++; console.log('  ✘ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };
const M = 1 / 111320;                       // 1 m em graus de latitude
const L0 = -25.5, G0 = -49.3;
const ponto = (dx, dy) => [L0 + dy * M, G0 + dx * M / Math.cos(L0 * Math.PI / 180)];   // dx leste, dy norte (m)
const reta = (x0, x1) => [ponto(x0, 0), ponto(x1, 0)];
const circ = (x, r) => { const p = ponto(x, 0); return { lat: p[0], lng: p[1], raio_m: r }; };
const compr = (partes) => partes.map((p) => G.comprimentoM(p));

console.log('Áreas sem trilha: recorte por círculos');
let r = G.recortarForaDosCirculos(reta(-200, 200), [circ(0, 50)]);
chk(r.length === 2, 'um círculo no meio divide a linha em duas partes', r.length);
chk(Math.abs(compr(r)[0] - 150) < 0.5 && Math.abs(compr(r)[1] - 150) < 0.5, 'cada parte tem 150 m (200 m menos os 50 m do raio)', compr(r));
r = G.recortarForaDosCirculos(reta(-200, 200), [circ(500, 50)]);
chk(r.length === 1 && Math.abs(compr(r)[0] - 400) < 0.5, 'círculo longe não muda nada', compr(r));
r = G.recortarForaDosCirculos(reta(-20, 20), [circ(0, 50)]);
chk(r.length === 0, 'linha toda dentro do círculo some', r);
r = G.recortarForaDosCirculos(reta(0, 200), [circ(0, 50)]);
chk(r.length === 1 && Math.abs(compr(r)[0] - 150) < 0.5, 'linha que começa dentro: sobra só o que está fora', compr(r));
r = G.recortarForaDosCirculos(reta(-200, 200), [circ(-100, 30), circ(100, 30), circ(-80, 30)]);
chk(r.length === 3, 'vários círculos (inclusive sobrepostos) cortam em três partes', r.length);
// segmento comprido atravessando o círculo sem nenhum vértice dentro
const longa = [ponto(-300, 10), ponto(-100, 10), ponto(100, 10), ponto(300, 10)];
r = G.recortarForaDosCirculos(longa, [circ(0, 50)]);
chk(r.length === 2 && !G.dentroDeAlgum(r[0][r[0].length - 1][0], r[0][r[0].length - 1][1], [{ lat: circ(0, 49).lat, lng: circ(0, 49).lng, raio_m: 49 }]), 'o recorte acompanha a entrada e a saída, mesmo sem vértice dentro', r.length);
chk(G.recortarForaDosCirculos(reta(-10, 10), []).length === 1 && G.recortarForaDosCirculos([ponto(0, 0)], [circ(0, 5)]).length === 0, 'sem círculos devolve a linha; um ponto só não é linha');

console.log('Borracha');
let b = G.apagarComPincel(reta(-100, 100), [ponto(0, 0)], 10);
chk(b.length === 2 && Math.abs(compr(b)[0] - 90) < 0.5, 'um toque apaga só o trecho tocado e a linha se divide em duas', compr(b));
b = G.apagarComPincel(reta(-100, 100), [ponto(-50, 3), ponto(-40, 3), ponto(-30, 3), ponto(-20, 3)], 10);
chk(b.length === 2 && Math.abs(compr(b)[0] - 40.46) < 0.5 && Math.abs(compr(b)[1] - 110.46) < 0.5, 'um arrasto apaga um trecho contínuo (de -59,5 a -10,5)', compr(b));
b = G.apagarComPincel(reta(-100, 100), [ponto(0, 30)], 10);
chk(b.length === 1 && Math.abs(compr(b)[0] - 200) < 0.5, 'o pincel longe da linha não apaga nada', compr(b));
b = G.apagarComPincel(reta(-5, 5), [ponto(0, 0)], 10);
chk(b.length === 0, 'apagar tudo deixa nenhuma parte');
b = G.apagarComPincel(reta(-100, 100), [ponto(-100, 0)], 10);
chk(b.length === 1 && Math.abs(compr(b)[0] - 190) < 0.5, 'apagar a ponta encurta a linha', compr(b));

console.log('Rastro na base');
const pts = [{ id: 1 }, { id: 2 }, { id: 3, na_base: true }, { id: 4, na_base: true }, { id: 5 }, { id: 6, na_base: true }];
const dv = G.dividirNaBase(pts);
chk(dv.length === 2 && dv[0].length === 2 && dv[1].length === 1 && dv[1][0].id === 5, 'os pontos na_base saem do rastro e o dividem', dv.map((x) => x.length));
chk(G.dividirNaBase([]).length === 0 && G.dividirNaBase([{ id: 1 }])[0].length === 1, 'sem pontos / sem marcação');
console.log('Pertinência');
chk(G.dentroDeAlgum(...ponto(10, 0), [circ(0, 50)]) && !G.dentroDeAlgum(...ponto(80, 0), [circ(0, 50)]), 'dentro e fora do círculo');

console.log('\nGeometria das trilhas: ' + ok + ' OK, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
