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
{
  // migração 072: pontos dentro do raio de uma base (mesmo sem na_base, ex.: base criada depois) também saem do desenho
  const base = { lat: ponto(0, 0)[0], lng: ponto(0, 0)[1], raio_m: 50 };
  const rastro = [[0, 200], [0, 80], [0, 30], [0, 10], [0, 70], [0, 150]].map(([y, x], i) => { const q = ponto(x, y); return { id: i + 1, lat: q[0], lng: q[1] }; });
  const pb = G.dividirNaBase(rastro, [base]);
  chk(pb.length === 2 && pb[0].map((x) => x.id).join() === '1,2' && pb[1].map((x) => x.id).join() === '5,6', 'pontos dentro do raio da base ficam fora do desenho e dividem a linha', pb.map((x) => x.map((y) => y.id)));
  chk(G.dividirNaBase(rastro, [Object.assign({}, base, { raio_m: null })]).length === 2, 'base sem raio: usa 50 m');
  chk(G.dividirNaBase(rastro, []).length === 1, 'sem bases: a linha inteira');
}
console.log('Pertinência');
chk(G.dentroDeAlgum(...ponto(10, 0), [circ(0, 50)]) && !G.dentroDeAlgum(...ponto(80, 0), [circ(0, 50)]), 'dentro e fora do círculo');

console.log('Áreas: pertinência e divisão de setores');
const sq = [ponto(-100, -100), ponto(-100, 100), ponto(100, 100), ponto(100, -100)];   // quadrado de 200 m de lado
const areaT = G.areaPoligonoM2(sq);
chk(Math.abs(areaT - 40000) < 50, 'área do quadrado de 200 m ≈ 40.000 m²', areaT);
chk(G.pontoNoPoligono(...ponto(10, 10), sq) && !G.pontoNoPoligono(...ponto(150, 10), sq), 'ponto dentro e fora do polígono');
chk(G.pontoNoCirculo(...ponto(30, 0), L0, G0, 50) && !G.pontoNoCirculo(...ponto(80, 0), L0, G0, 50), 'ponto dentro e fora do círculo (centro = origem)');
const disco = G.circuloParaPoligono(L0, G0, 200, 48);
const areaDisco = G.areaPoligonoM2(disco);
chk(disco.length === 48 && Math.abs(areaDisco - Math.PI * 200 * 200) / (Math.PI * 200 * 200) < 0.01, 'círculo de 200 m vira 48 vértices (área a menos de 1% da exata)', areaDisco);
let dv2 = G.dividirPorLinha(sq, ponto(0, -300), ponto(0, 300));
chk(dv2.length === 2 && Math.abs(G.areaPoligonoM2(dv2[0]) - 20000) < 50 && Math.abs(G.areaPoligonoM2(dv2[1]) - 20000) < 50, 'uma linha no meio divide o quadrado em duas metades iguais', dv2.map(G.areaPoligonoM2));
chk(G.dividirPorLinha(sq, ponto(500, -300), ponto(500, 300)).length === 1, 'linha que não cruza o setor não divide');
dv2 = G.dividirPorLinha(disco, ponto(-300, 0), ponto(300, 40));
chk(dv2.length === 2 && Math.abs(G.areaPoligonoM2(dv2[0]) + G.areaPoligonoM2(dv2[1]) - areaDisco) < 5, 'a soma das partes é a área do setor (sem perda nem sobreposição)', dv2.map(G.areaPoligonoM2));
let fatias = G.dividirEmFatias(disco, 4, 0);
chk(fatias.length === 4 && fatias.every((f) => Math.abs(G.areaPoligonoM2(f) - areaDisco / 4) / (areaDisco / 4) < 0.02), 'círculo em 4 fatias de áreas iguais', fatias.map(G.areaPoligonoM2));
chk(Math.abs(fatias.reduce((a, f) => a + G.areaPoligonoM2(f), 0) - areaDisco) < 5, 'as fatias cobrem o círculo inteiro');
fatias = G.dividirEmFatias(disco, 3, 20);
chk(fatias.length === 3 && fatias.every((f) => Math.abs(G.areaPoligonoM2(f) - areaDisco / 3) / (areaDisco / 3) < 0.03), 'círculo em 3 fatias com rumo inicial de 20°', fatias.map(G.areaPoligonoM2));
fatias = G.dividirEmFatias(disco, 2, 0);
chk(fatias.length === 2 && G.pontoNoPoligono(...ponto(50, 0), fatias[0]) !== G.pontoNoPoligono(...ponto(-50, 0), fatias[0]), 'duas fatias são as duas metades (leste e oeste)');
let faixas = G.dividirEmFaixas(sq, 4, 0);
chk(faixas.length === 4 && faixas.every((f) => Math.abs(G.areaPoligonoM2(f) - 10000) < 50), 'quadrado em 4 faixas de 50 m (norte–sul)', faixas.map(G.areaPoligonoM2));
chk(G.pontoNoPoligono(...ponto(-75, 0), faixas[0]) || G.pontoNoPoligono(...ponto(-75, 0), faixas[3]), 'as faixas ficam lado a lado (de oeste para leste)');
faixas = G.dividirEmFaixas(disco, 5, 45);
chk(faixas.length === 5 && Math.abs(faixas.reduce((a, f) => a + G.areaPoligonoM2(f), 0) - areaDisco) < 5, 'faixas inclinadas a 45° também cobrem o setor');
chk(G.dividirEmFaixas(sq, 1, 0).length === 0 && G.dividirEmFatias([[0, 0], [1, 1]], 3, 0).length === 0, 'pedidos inválidos devolvem vazio');
const concavo = [ponto(-100, -100), ponto(-100, 100), ponto(0, 20), ponto(100, 100), ponto(100, -100)];   // "M" côncavo
const aC = G.areaPoligonoM2(concavo);
chk(Math.abs(G.dividirEmFatias(concavo, 4, 10).reduce((a, f) => a + G.areaPoligonoM2(f), 0) - aC) < 30, 'polígono côncavo: a soma das fatias confere com a área (sem perda)');

// --- Setas de sentido (estilo AlpineQuest) ---
const linhaPx = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];   // 100 px para a direita e 100 px para baixo
const setas = G.setasAoLongo(linhaPx, 40);
chk(setas.length === 5 && setas[0].x === 20 && setas[0].y === 0, 'setas a cada 40 px, a primeira em 20 px', setas.length);
chk(setas.slice(0, 2).every((s) => Math.abs(s.ang) < 1e-9) && setas.slice(3).every((s) => Math.abs(s.ang - Math.PI / 2) < 1e-9), 'cada seta aponta no sentido do trecho (direita, depois para baixo)');
chk(G.setasAoLongo(linhaPx, 40, 2).length === 2, 'respeita o máximo de setas');
chk(G.setasAoLongo([{ x: 5, y: 5 }, { x: 5, y: 5 }], 10).length === 0 && G.setasAoLongo([{ x: 0, y: 0 }], 10).length === 0, 'linha sem comprimento ou com um ponto: nenhuma seta');
// tremor do GPS: um passo curto para trás no meio de um trecho que vai para a direita
const tremido = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 36, y: 0 }, { x: 33, y: 1 }, { x: 40, y: 0 }, { x: 100, y: 0 }];
const st = G.setasAoLongo(tremido, 75);   // a primeira seta cai em 37,5 px, bem no passo para trás
const local = G.setasAoLongo(tremido, 75, 10, 0.01);   // como era antes: só o trechinho onde a seta cai
chk(local.length && Math.abs(Math.abs(local[0].ang) - Math.PI) < 0.5, 'controle: pelo trechinho local a seta apontaria para trás', local.map((s) => Math.round(s.ang * 180 / Math.PI)));
chk(st.length >= 1 && st.every((s) => Math.abs(s.ang) < 0.35), 'um tremor do GPS para trás não vira seta ao contrário (todas para a direita)', st.map((s) => Math.round(s.ang * 180 / Math.PI)));
// vaivém (parado, GPS indo e voltando no mesmo lugar): sem seta ali
const vaivem = [{ x: 0, y: 0 }];
for (let i = 0; i < 20; i++) vaivem.push({ x: i % 2 ? 0 : 8, y: (i % 3) * 2 });
const sv = G.setasAoLongo(vaivem, 40);
chk(sv.length === 0, 'vaivém no mesmo lugar: nenhuma seta (não dá para saber o sentido)', sv.length);
// depois do vaivém, a trilha segue para cima: as setas desse trecho apontam para cima
const depois = vaivem.concat([{ x: 4, y: -40 }, { x: 4, y: -200 }]);
const sd = G.setasAoLongo(depois, 40).filter((s) => s.y < -45);
chk(sd.length >= 2 && sd.every((s) => Math.abs(s.ang + Math.PI / 2) < 0.2), 'no trecho que segue, as setas apontam para onde a pessoa foi', sd.map((s) => Math.round(s.ang * 180 / Math.PI)));
const v = G.verticesSeta({ x: 10, y: 10, ang: 0 }, 5);
chk(v.length === 4 && v[0].x === 15 && v[0].y === 10 && v[1].x < 10 && v[3].x < 10 && v[1].y > 10 && v[3].y < 10, 'a seta tem a ponta à frente e as abas para trás', v);
const vb = G.verticesSeta({ x: 0, y: 0, ang: Math.PI / 2 }, 5);
chk(Math.abs(vb[0].x) < 1e-9 && Math.abs(vb[0].y - 5) < 1e-9, 'girada para baixo, a ponta fica embaixo', vb[0]);

// --- Borracha na trilha de GPS: intervalos apagados ---
const rastro = []; for (let k = 0; k < 10; k++) rastro.push({ id: k + 1, t: 1000 * k });
chk(G.dividirPorIntervalos(rastro, []).length === 1 && G.dividirPorIntervalos(rastro, null)[0].length === 10, 'sem intervalos: o rastro segue inteiro');
const gr = G.dividirPorIntervalos(rastro, [{ de: 3000, ate: 5000 }]);
chk(gr.length === 2 && gr[0].length === 3 && gr[1].length === 4 && gr[0][2].t === 2000 && gr[1][0].t === 6000, 'o trecho apagado some e o rastro se divide nele (sem ligar por cima)', gr.map((g) => g.length));
chk(G.dividirPorIntervalos(rastro, [{ de: 0, ate: 4000 }, { de: 7000, ate: 9000 }]).map((g) => g.length).join() === '2', 'apagado no começo e no fim: sobra um grupo só');
chk(G.dividirPorIntervalos(rastro, [{ de: -1, ate: 99999 }]).length === 0, 'tudo apagado: nenhum grupo');
chk(G.dividirPorIntervalos(rastro, [{ de: 3000, ate: 3000 }])[0].length === 3, 'o intervalo inclui as duas pontas (de 3000 a 3000 apaga o ponto de 3000)');
// pontos novos depois do trecho apagado continuam aparecendo
const comNovos = rastro.concat([{ id: 11, t: 20000 }, { id: 12, t: 21000 }]);
chk(G.dividirPorIntervalos(comNovos, [{ de: 3000, ate: 5000 }]).slice(-1)[0].length === 6, 'os pontos que chegam depois (quem ainda anda) continuam aparecendo');
const ap = new Set([4, 5, 6, 9]);
const iv = G.intervalosApagados(rastro, ap);
chk(iv.length === 2 && iv[0].de === 3000 && iv[0].ate === 5000 && iv[1].de === 8000 && iv[1].ate === 8000, 'sequências apagadas viram intervalos de horário', iv);
const base = rastro.map((p) => Object.assign({}, p, { na_base: p.id === 5 }));
const iv2 = G.intervalosApagados(base, new Set([4, 6]), (p) => !p.na_base);
chk(iv2.length === 1 && iv2[0].de === 3000 && iv2[0].ate === 5000, 'ponto da base (que não aparece) no meio não separa uma sequência apagada', iv2);
chk(G.unirIntervalos([{ de: 5, ate: 8 }, { de: 1, ate: 3 }, { de: 3, ate: 6 }, { de: 20, ate: 30 }]).map((i) => i.de + '-' + i.ate).join() === '1-8,20-30', 'intervalos que se tocam ou se sobrepõem são unidos');

console.log('\nGeometria das trilhas: ' + ok + ' OK, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
