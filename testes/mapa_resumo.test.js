// Resumo de longe do mapa (js/mapa-resumo.js): agrupar por distância na tela, contar por família e montar o selo.
// O que depende do Leaflet (camada, clique, zoom) é testado no navegador, fora do repositório.
const assert = require('assert');
const R = require('../public/js/mapa-resumo.js');
let falhas = 0;
function teste(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
const it = (x, y, extra) => Object.assign({ x, y, familia: 'pessoa', cor: '#3b82f6', lat: -24.9, lng: -51.4 }, extra || {});

console.log('Resumo de longe do mapa: núcleo (mapa-resumo.js)');

teste('itens perto viram um grupo; o que está longe fica de fora', () => {
  const g = R.agrupar([it(0, 0), it(10, 5), it(20, 0), it(500, 500)], 56);
  assert.strictEqual(g.length, 2);
  const grande = g.find((x) => x.itens.length === 3);
  assert.ok(grande, 'os três próximos juntos');
  assert.ok(Math.abs(grande.x - 10) < 1 && Math.abs(grande.y - 1.67) < 1, 'o centro fica no meio do grupo');
  assert.strictEqual(g.find((x) => x.itens.length === 1).itens[0].x, 500);
});

teste('o resultado não depende da ordem em que os itens chegam', () => {
  const base = [it(0, 0), it(30, 0), it(60, 0), it(90, 0), it(400, 400), it(420, 410)];
  const a = R.agrupar(base, 56).map((g) => g.itens.length).sort();
  const b = R.agrupar(base.slice().reverse(), 56).map((g) => g.itens.length).sort();
  const c = R.agrupar([base[3], base[0], base[5], base[2], base[1], base[4]], 56).map((g) => g.itens.length).sort();
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a, c);
});

teste('nenhum selo fica a menos do raio de outro (os grupos que se aproximam ao juntar são fundidos)', () => {
  const itens = [];
  for (let i = 0; i < 12; i++) itens.push(it(i * 30, (i % 3) * 20));   // uma fileira de 330 px
  const g = R.agrupar(itens, 56);
  for (let a = 0; a < g.length; a++) for (let b = a + 1; b < g.length; b++) {
    const d = Math.hypot(g[a].x - g[b].x, g[a].y - g[b].y);
    assert.ok(d > 56, 'grupos a ' + d.toFixed(1) + ' px um do outro');
  }
  assert.strictEqual(g.reduce((s, x) => s + x.itens.length, 0), 12, 'nenhum item some');
});

teste('muitos itens no mesmo ponto (e lista vazia) não quebram', () => {
  assert.strictEqual(R.agrupar([], 56).length, 0);
  const g = R.agrupar(Array.from({ length: 500 }, () => it(100, 100)), 56);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].itens.length, 500);
});

teste('resumir: pessoas, pontos por tipo, alertas e cores dos grupos', () => {
  const r = R.resumir([
    it(0, 0, { cor: '#ef4444' }), it(0, 0, { cor: '#ef4444', ajuda: true }), it(0, 0, { cor: '#3b82f6', saida: true }),
    it(0, 0, { familia: 'ponto', tipo: 'relato' }), it(0, 0, { familia: 'ponto', tipo: 'foto' }),
    it(0, 0, { familia: 'ponto', tipo: 'poi', critico: true }), it(0, 0, { familia: 'ponto', tipo: 'qualquer-outro' }),
  ]);
  assert.strictEqual(r.pessoas, 3);
  assert.strictEqual(r.pontos, 4);
  assert.deepStrictEqual(r.porTipo, { relato: 1, foto: 1, poi: 2 }, 'tipo desconhecido conta como ponto de interesse');
  assert.strictEqual(r.ajuda, 1); assert.strictEqual(r.saida, 1); assert.strictEqual(r.criticos, 1);
  assert.strictEqual(r.alertas, 3);
  assert.deepStrictEqual(r.coresPessoas, ['#ef4444', '#ef4444', '#3b82f6']);
  assert.strictEqual(r.total, 7);
});

teste('vítima: relato e ponto da mesma vítima (a menos de 30 m) contam uma vez; outra vítima conta à parte', () => {
  const v = (lat, lng) => it(0, 0, { familia: 'ponto', tipo: 'relato', vitima: true, lat, lng });
  assert.strictEqual(R.resumir([v(-24.9, -51.4), v(-24.90010, -51.4)]).vitimas, 1, 'a ~11 m: a mesma');
  assert.strictEqual(R.resumir([v(-24.9, -51.4), v(-24.9020, -51.4)]).vitimas, 2, 'a ~220 m: outra');
  assert.strictEqual(R.resumir([it(0, 0, { vitima: true })]).vitimas, 0, 'só pontos contam como vítima');
});

teste('distância: 0,001° de latitude são cerca de 111 m', () => {
  const d = R.distanciaM({ lat: -24.9, lng: -51.4 }, { lat: -24.901, lng: -51.4 });
  assert.ok(d > 105 && d < 117, String(d));
  assert.strictEqual(R.distanciaM({ lat: 1, lng: 2 }, { lat: 1, lng: 2 }), 0);
});

teste('selo com pessoas e pontos: dois símbolos lado a lado com as contagens', () => {
  const h = R.htmlResumo(R.resumir([it(0, 0), it(0, 0), it(0, 0, { familia: 'ponto', tipo: 'poi' })]));
  assert.ok(/class="resumo[^"]*resumo-duplo/.test(h), 'duplo');
  assert.ok(/class="resumo-pessoas"[^>]*><b>2<\/b>/.test(h));
  assert.ok(/class="resumo-pontos"[^>]*><b>1<\/b>/.test(h));
  assert.ok(!/cl-alerta|cl-vitima|resumo-rotulos/.test(h), 'sem alerta, vítima nem etiqueta quando não há');
});

teste('selo só de pessoas ou só de pontos: um símbolo só', () => {
  const so = R.htmlResumo(R.resumir([it(0, 0), it(0, 0)]));
  assert.ok(/resumo-pessoas/.test(so) && !/resumo-pontos|resumo-duplo/.test(so));
  const pt = R.htmlResumo(R.resumir([it(0, 0, { familia: 'ponto', tipo: 'foto' }), it(0, 0, { familia: 'ponto', tipo: 'foto' })]));
  assert.ok(/resumo-pontos/.test(pt) && !/resumo-pessoas|resumo-duplo/.test(pt));
});

teste('etiquetas: singular e plural, uma embaixo da outra, e o "!" quando há alerta', () => {
  const um = R.htmlResumo(R.resumir([it(0, 0, { ajuda: true }), it(0, 0, { familia: 'ponto', tipo: 'relato', vitima: true })]));
  assert.ok(/>VÍTIMA</.test(um) && /PEDE AJUDA</.test(um));
  assert.ok(/cl-alerta/.test(um) && /cl-vitima/.test(um) && /resumo-vitima/.test(um) && /resumo-alerta/.test(um));
  const varios = R.htmlResumo(R.resumir([
    it(0, 0, { ajuda: true }), it(0, 0, { ajuda: true }),
    it(0, 0, { familia: 'ponto', tipo: 'relato', vitima: true, lat: -24.9, lng: -51.4 }),
    it(0, 0, { familia: 'ponto', tipo: 'relato', vitima: true, lat: -24.91, lng: -51.4 }),
  ]));
  assert.ok(/>2 VÍTIMAS</.test(varios) && />2 PEDEM AJUDA</.test(varios));
  assert.ok(varios.indexOf('resumo-rotulo-vitima') < varios.indexOf('resumo-rotulo-ajuda'), 'vítima em cima, ajuda embaixo');
  assert.ok(/cl-vitima[^>]*>\+2</.test(varios), 'o "+" mostra a quantidade');
});

teste('pedir para sair ou risco dá o "!" mas não a etiqueta de ajuda', () => {
  const h = R.htmlResumo(R.resumir([it(0, 0, { saida: true }), it(0, 0, { familia: 'ponto', tipo: 'poi', critico: true })]));
  assert.ok(/cl-alerta/.test(h));
  assert.ok(!/resumo-rotulo-ajuda/.test(h));
});

teste('texto do balão: tudo que o selo resume, no singular e no plural', () => {
  const t = R.textoResumo(R.resumir([
    it(0, 0), it(0, 0, { ajuda: true }), it(0, 0, { saida: true }),
    it(0, 0, { familia: 'ponto', tipo: 'relato', vitima: true }), it(0, 0, { familia: 'ponto', tipo: 'foto' }),
  ]));
  assert.ok(/3 pessoas/.test(t) && /1 vítima localizada/.test(t) && /2 marcas no mapa/.test(t));
  assert.ok(/1 relato/.test(t) && /1 foto/.test(t) && /1 pede ajuda/.test(t) && /1 pede para sair/.test(t) && /Toque para aproximar\.$/.test(t));
  const s = R.textoResumo(R.resumir([it(0, 0)]));
  assert.ok(/^1 pessoa\./.test(s), s);
});

teste('o texto vai escapado no atributo (nenhum HTML entra pelo balão)', () => {
  const h = R.htmlResumo({ total: 2, pessoas: 2, pontos: 0, porTipo: {}, coresPessoas: ['#111', '#222'], ajuda: 0, saida: 0, criticos: 0, vitimas: 0, alertas: 0 });
  assert.ok(/title="2 pessoas\./.test(h));
  assert.ok(!/title="[^"]*[<>]/.test(h));
});

teste('tamanho do ícone: acompanha o que o selo tem', () => {
  const so = R.tamanhoIcone({ pessoas: 3, pontos: 0 });
  const duplo = R.tamanhoIcone({ pessoas: 3, pontos: 2 });
  const grande = R.tamanhoIcone({ pessoas: 25, pontos: 0 });
  assert.ok(duplo[0] > so[0], 'duplo é mais largo');
  assert.ok(grande[1] > so[1], 'muita gente: círculo maior');
  assert.deepStrictEqual(R.tamanhoIcone({ pessoas: 0, pontos: 3 }), [36, 36]);
});

console.log(falhas ? '\nFalhas: ' + falhas : '\nResumo de longe: todos OK');
process.exit(falhas ? 1 : 0);
