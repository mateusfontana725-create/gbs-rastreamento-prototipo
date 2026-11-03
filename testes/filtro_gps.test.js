// Teste do filtro de GPS (public/js/gps.js) — rode com: node testes/filtro_gps.test.js
// Simula sequências de leituras como as de um celular (1 leitura por segundo)
// e confere quantos pontos entram na trilha, o atraso e o que é descartado.
require(require('path').join(__dirname, '../public/js/gps.js'));
const GPS = globalThis.GPS;
const M = 1 / 111320;                  // graus de latitude por metro
const ML = 1 / (111320 * Math.cos(22.9 * Math.PI / 180)); // graus de longitude por metro
const pos = (lat, lng, acc, t, speed) => ({ coords: { latitude: lat, longitude: lng, accuracy: acc, speed: speed == null ? null : speed }, timestamp: t });
let ok = 0, falha = 0;
const chk = (c, m, x) => { if (c) { ok++; console.log('  ✔ ' + m); } else { falha++; console.log('  ✘ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const ruido = (m) => (rnd() - 0.5) * 2 * m;
const t0 = 1.7e12;

// Roda uma sequência: f(i) -> [latMetros, lngMetros, prec, speed|null]
function rodar(n, f, cfg) {
  const fil = new GPS.Filtro(cfg); const pts = []; const mot = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + i * 1000;
    const [y, x, acc, v] = f(i);
    const r = fil.processar(pos(-22.9 + y * M, -43.2 + x * ML, acc, t, v), t);
    mot.push(r.motivo);
    r.pontos.forEach((p) => pts.push(Object.assign({ i }, p)));
  }
  return { pts, mot, fil };
}
const dist = (a, b) => GPS.distancia(a.lat, a.lng, b.lat, b.lng);
const maiorIntervalo = (pts) => pts.slice(1).reduce((m, p, k) => Math.max(m, p.t - pts[k].t), 0) / 1000;

// Erro do GPS parado: deriva lenta (cada leitura parecida com a anterior), como nos aparelhos reais.
function deriva(amp) {
  let x = 0, y = 0;
  return () => { x = 0.9 * x + ruido(amp * 0.45); y = 0.9 * y + ruido(amp * 0.45); return [y, x]; };
}
console.log('Parado');
let dv = deriva(6);
let r = rodar(300, () => dv().concat([10]));
chk(r.pts.length <= 26, 'parado 5 min, erro de ±6 m, precisão 10 m, aparelho SEM velocidade: poucos pontos além da confirmação a cada 15 s', r.pts.length);
chk(maiorIntervalo(r.pts) <= 16, 'parado: nunca mais de ~15 s sem ponto (intervalo máximo padrão)', maiorIntervalo(r.pts));
dv = deriva(6);
r = rodar(300, () => dv().concat([10, 0]));
chk(r.pts.length <= 21, 'mesmo caso com o GPS informando velocidade 0 (Android): só a confirmação periódica (a cada 15 s)', r.pts.length);
chk(r.pts.length >= 19, 'velocidade 0: a confirmação periódica acontece (≈ 20 pontos em 5 min)', r.pts.length);
dv = deriva(20);
r = rodar(300, () => dv().concat([35]));
chk(r.pts.length <= 26, 'parado 5 min, erro de ±20 m, precisão 35 m (mata): poucos pontos além da confirmação a cada 15 s', r.pts.length);
r = rodar(300, () => [ruido(6), ruido(6), 10]);
chk(r.pts.length <= 35, 'ruído extremo (cada leitura sorteada ±6 m): poucos pontos (≈ 1 a cada 9 s)', r.pts.length);
dv = deriva(6);
r = rodar(300, () => dv().concat([10, 0]), { intervaloParadoMs: 30000 });
chk(r.pts.length <= 11, 'intervalo configurado em 30 s (operação): parado, confirmação a cada 30 s', r.pts.length);
{ const fc = new GPS.Filtro(); fc.configurar({ intervaloParadoMs: 20000, inexistente: 1 });
  chk(fc.cfg.intervaloParadoMs === 20000 && !('inexistente' in fc.cfg), 'configurar() muda o intervalo sem aceitar chaves desconhecidas', fc.cfg.intervaloParadoMs); }

// Parado junto a prédio: além do erro, o GPS pula 20–40 m por alguns segundos (multicaminho, troca para o Wi-Fi) e volta.
function comPulos(amp, chance) {
  const dv0 = deriva(amp); let pulo = null;
  return (i) => {
    if (!pulo && rnd() < chance) { const a = rnd() * 6.28, d = 20 + 20 * rnd(); pulo = { y: Math.cos(a) * d, x: Math.sin(a) * d, fim: i + 3 + Math.floor(rnd() * 12) }; }
    if (pulo && i >= pulo.fim) pulo = null;
    const e = dv0();
    return [e[0] + (pulo ? pulo.y : 0), e[1] + (pulo ? pulo.x : 0), pulo ? 30 : 15];
  };
}
const comprimento = (pts) => pts.slice(1).reduce((s, p, k) => s + dist(pts[k], p), 0);
const afastamento = (pts) => Math.max(...pts.map((p) => GPS.distancia(-22.9, -43.2, p.lat, p.lng)));
let fp = comPulos(6, 0.03);
r = rodar(600, fp);
chk(comprimento(r.pts) < 150 && afastamento(r.pts) < 20, 'parado 10 min junto a prédio, com pulos de 20–40 m: trilha não vira estrela (comprimento e afastamento pequenos)', [Math.round(comprimento(r.pts)), Math.round(afastamento(r.pts))]);
chk(r.mot.includes('pulo_parado'), 'os pulos aparecem no diagnóstico como "pulo do GPS parado"', r.mot.filter((m) => m === 'pulo_parado').length);
r = rodar(120, (i) => (i >= 40 && i < 48 ? [30 + ruido(2), ruido(2), 25] : [ruido(2), ruido(2), 8]));
chk(!r.pts.some((p) => dist(p, { lat: -22.9, lng: -43.2 }) > 15), 'pulo de 30 m por 8 s, parado: ignorado', r.pts.map((p) => Math.round(dist(p, { lat: -22.9, lng: -43.2 }))));
r = rodar(120, (i) => (i >= 40 ? [30 + ruido(2), ruido(2), 8] : [ruido(2), ruido(2), 8]));
chk(r.mot.includes('salto_confirmado') && dist(r.pts[r.pts.length - 1], { lat: -22.9 + 30 * M, lng: -43.2 }) < 6, 'o mesmo deslocamento de uma vez que DURA (30 s): mudança de lugar real, aceita', r.mot.filter((m) => m === 'salto_confirmado').length);
r = rodar(150, (i) => (i < 60 ? [ruido(2), ruido(2), 8] : [(i - 60) * 1.0 + ruido(2), ruido(2), 8]));
{ const saida = r.pts.find((p) => p.i > 60 && dist(p, { lat: -22.9, lng: -43.2 }) > 4);
  chk(saida && saida.i <= 75, 'parado 1 min e sai andando devagar (1 m/s): o começo do trecho entra (perto da hora da saída)', saida && saida.i); }
r = rodar(80, (i) => [i * 1.0 + ruido(2), ruido(2), 8]);
chk(r.pts.filter((p) => p.i <= 30).length >= 3, 'sai andando devagar logo na primeira leitura: o lugar não "persegue" quem anda', r.pts.map((p) => p.i));
{ const todos = [rodar(600, comPulos(6, 0.03)), rodar(300, (i) => (Math.floor(i / 60) % 2 ? [i * 1.3 + ruido(8), ruido(8), 25] : [Math.floor(i / 120) * 78 + ruido(8), ruido(8), 25]))];
  chk(todos.every((x) => x.pts.every((p, k) => !k || p.t > x.pts[k - 1].t)), 'pontos sempre em ordem cronológica (a saída grava as leituras de antes sem cruzar a confirmação)'); }

console.log('A pé');
r = rodar(120, (i) => [i * 1.4 + ruido(2), ruido(2), 6]);
chk(r.pts.length >= 20, 'andando 1,4 m/s com precisão 6 m, sem velocidade do GPS: ponto a cada ~5 s (≈7 m)', r.pts.length);
chk(maiorIntervalo(r.pts) <= 8, 'maior intervalo entre pontos andando ≤ 8 s', maiorIntervalo(r.pts));
chk(dist(r.pts[0], r.pts[r.pts.length - 1]) > 150, 'percurso registrado até o fim (≈166 m)', Math.round(dist(r.pts[0], r.pts[r.pts.length - 1])));
dv = deriva(8);
r = rodar(120, (i) => { const e = dv(); return [i * 1.2 + e[0], e[1], 30]; });
chk(r.pts.length >= 6 && maiorIntervalo(r.pts) <= 35, 'andando com precisão ruim (30 m, mata), sem velocidade do GPS: ainda registra (≤ 35 s entre pontos)', [r.pts.length, maiorIntervalo(r.pts)]);
r = rodar(120, (i) => [i * 1.2 + ruido(8), ruido(8), 30, 1.2]);
chk(r.pts.length >= 8 && maiorIntervalo(r.pts) <= 35, 'mesma situação com velocidade do GPS, precisão 30 m: a velocidade sozinha não basta (ruído de Doppler); ponto quando afasta ~12 m (≤ 35 s)', [r.pts.length, maiorIntervalo(r.pts)]);
r = rodar(120, (i) => [i * 1.2 + ruido(3), ruido(3), 8, 1.2]);
chk(r.pts.length >= 15 && maiorIntervalo(r.pts) <= 10, 'andando com precisão boa (8 m) e velocidade do GPS: um ponto a cada ~6 m (0,8 × precisão), sem buracos', [r.pts.length, maiorIntervalo(r.pts)]);
r = rodar(300, (i) => [i * 0.3, 0, 5]);
chk(r.pts.length >= 20, 'passos lentos (0,3 m/s): deslocamento pequeno registrado', r.pts.length);

console.log('Veículo');
r = rodar(120, (i) => [i * 20 + ruido(3), ruido(3), 5]);
chk(r.pts.length >= 100, 'carro a 72 km/h SEM velocidade do GPS: quase 1 ponto por segundo', r.pts.length);
chk(r.pts[0].i === 0 && r.pts.slice(-1)[0].i >= 118, 'trilha do carro vai do início ao fim, sem atraso', [r.pts[0].i, r.pts.slice(-1)[0].i]);
r = rodar(120, (i) => [i * 30 + ruido(3), ruido(3), 5, 30]);
chk(r.pts.length >= 110, 'carro a 108 km/h COM velocidade do GPS: 1 ponto por segundo', r.pts.length);
r = rodar(60, (i) => (i < 20 ? [ruido(3), ruido(3), 6] : [(i - 20) * 15, 0, 6]));
chk(r.mot.slice(20, 25).every((m) => m !== 'salto_suspeito') || r.pts.filter((p) => p.i >= 20 && p.i <= 23).length >= 2, 'parado → arranca de carro: pontos de arrancada entram', r.mot.slice(19, 26));
chk(r.pts.filter((p) => p.i >= 20).length >= 30, 'parado → carro: trilha acompanha', r.pts.filter((p) => p.i >= 20).length);
r = rodar(60, (i) => (i === 30 ? [i * 20 + 900, 0, 8] : [i * 20, 0, 5]));
chk(!r.pts.some((p) => p.i === 30), 'pico de 900 m no meio do trajeto de carro: descartado', r.mot[30]);
r = rodar(60, (i) => (i === 30 ? [i * 1.4 + 400, 0, 8] : [i * 1.4, 0, 5]));
chk(!r.pts.some((p) => p.i === 30), 'pico de 400 m andando: descartado', r.mot[30]);
r = rodar(30, (i) => (i < 10 ? [0, 0, 5] : [3000 + (i - 10) * 1, 0, 5]));
chk(r.mot.includes('salto_confirmado'), 'mudança real de lugar (3 km) confirmada por leituras seguidas', r.mot.slice(9, 14));

console.log('Precisão e leituras ruins');
r = rodar(180, () => [ruido(150), 0, 350]);
chk(r.pts.length <= 7, 'precisão 350 m: só 1 posição aproximada a cada 30 s', r.pts.length);
chk(GPS.trilha(r.pts).segmentos.every((s) => s.length === 0) || GPS.trilha(r.pts).segmentos.length === 0, 'posições aproximadas não entram na linha da trilha');
r = rodar(120, (i) => [i * 1.4, 0, i % 10 === 5 ? 120 : 8]);
chk(r.pts.length >= 18 && maiorIntervalo(r.pts) <= 15, 'andando com algumas leituras de 120 m: não para a trilha', r.pts.length);
let f = new GPS.Filtro();
chk(f.processar(pos(-22.9, -43.2, 5, t0 - 120000), t0).motivo === 'leitura_antiga', 'leitura antiga (cache) descartada');
chk(f.processar(pos(-22.9, -43.2, 5, t0), t0).motivo === 'primeiro_ponto', 'primeira leitura aceita na hora');
chk(f.processar(pos(-22.9, -43.2, 5, t0), t0 + 500).motivo === 'duplicada', 'leitura repetida');
chk(f.processar(pos(-22.91, -43.2, 5, t0 - 5000), t0 + 600).motivo === 'fora_de_ordem', 'fora de ordem');
chk(f.processar(pos(0, 0, 5, t0 + 7000), t0 + 7000).motivo === 'coordenada_invalida', '0,0 inválida');
{ const fl = new GPS.Filtro(); const ms = []; for (let i = 0; i < 10; i++) { const ag = t0 + i * 1000; ms.push(fl.processar(pos(-22.9 + i * 3 * M, -43.2, 5, ag - 300000), ag).motivo); }
  chk(ms.slice(2).every((m) => m !== 'leitura_antiga'), 'relógio do GPS 5 min diferente do celular: corrigido após 3 leituras', ms); }

console.log('Desenho da trilha');
const linha = (n, passo, prec) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * 2000, lat: -22.9 + i * passo * M, lng: -43.2, prec }));
let tr = GPS.trilha(linha(50, 3, 6));
chk(tr.segmentos.length === 1 && tr.segmentos[0].length === 50, 'todos os pontos registrados viram vértices (nada escondido)', tr.segmentos[0].length);
const comLacuna = linha(10, 3, 6).concat(linha(10, 3, 6).map((p) => ({ t: p.t + 400000, lat: p.lat + 500 * M, lng: p.lng, prec: 6 })));
tr = GPS.trilha(comLacuna);
chk(tr.segmentos.length === 2 && tr.lacunas.length === 1, '6 min sem pontos e 500 m adiante: falha separada, não uma linha contínua', [tr.segmentos.length, tr.lacunas.length]);
chk(tr.lacunas[0].t0 === comLacuna[9].t && tr.lacunas[0].t1 === comLacuna[10].t, 'a falha informa início (último ponto antes) e fim (primeiro depois)', [tr.lacunas[0].t0, tr.lacunas[0].t1]);
const parada = linha(10, 3, 6).concat([{ t: t0 + 200000, lat: -22.9 + 27 * M, lng: -43.2, prec: 6 }]);
chk(GPS.trilha(parada).lacunas.length === 1, 'mais de 60 s sem pontos é falha mesmo sem sair do lugar (limite padrão)');
chk(GPS.trilha(parada, { lacunaMs: 300000 }).lacunas.length === 0, 'com o limite configurado em 5 min, a mesma pausa não é falha');
const ritmo = Array.from({ length: 20 }, (_, i) => ({ t: t0 + i * 15000, lat: -22.9 + i * 2 * M, lng: -43.2, prec: 8 }));
chk(GPS.trilha(ritmo).lacunas.length === 0 && GPS.trilha(ritmo).segmentos.length === 1, 'pontos a cada 15 s (intervalo padrão): trilha contínua, sem falha');
const salto61 = [{ t: t0, lat: -22.9, lng: -43.2, prec: 5 }, { t: t0 + 61000, lat: -22.9 + 3 * M, lng: -43.2, prec: 5 }];
chk(GPS.trilha(salto61).lacunas.length === 1, '61 s entre dois pontos seguidos: falha (acima do limite de 60 s)');
const desordem = [{ t: t0, lat: -22.9, lng: -43.2, prec: 5 }, { t: t0, lat: -22.9, lng: -43.2, prec: 5 }, { t: t0 + 2000, lat: -22.9 + 4 * M, lng: -43.2, prec: 5 }];
chk(GPS.trilha(desordem).segmentos[0].length === 2, 'pontos duplicados ignorados no desenho');

console.log('\nFiltro de GPS: ' + ok + ' OK, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
