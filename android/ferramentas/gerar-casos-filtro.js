// Gera os casos de teste do filtro nativo (FiltroGpsTest) a partir do filtro do site (public/js/gps.js).
// Rode depois de mudar o gps.js:  node android/ferramentas/gerar-casos-filtro.js
// O teste Java confere que o app decide exatamente como a página: mesmas leituras → mesmos pontos e motivos.
const path = require('path');
const fs = require('fs');
require(path.join(__dirname, '../../public/js/gps.js'));
const GPS = globalThis.GPS;

let semente = 20261030;
const rnd = () => { semente = (semente * 16807) % 2147483647; return semente / 2147483647; };
const M = 1 / 111320;

function cenario(nome, n, cfg, gerar) {
  const filtro = new GPS.Filtro(cfg);
  const passos = [];
  let estado = { lat: -25.43 + rnd() * 0.1, lng: -49.27 + rnd() * 0.1, t: 1.79e12 + Math.round(rnd() * 1e6), agora: 0 };
  estado.agora = estado.t;
  for (let i = 0; i < n; i++) {
    const l = gerar(i, estado);
    const pos = { coords: { latitude: l.lat, longitude: l.lng, accuracy: l.prec, speed: l.vel }, timestamp: l.ts };
    const r = filtro.processar(pos, l.agora);
    passos.push({
      e: [l.lat, l.lng, l.prec, l.vel, l.ts || 0, l.agora],
      m: r.motivo,
      p: r.pontos.map((p) => [p.lat, p.lng, p.prec, p.t]),
      a: r.atual ? [r.atual.lat, r.atual.lng, r.atual.t] : null,
      r: r.rapido,
    });
  }
  return { nome, cfg: cfg || {}, passos };
}

// Caminhada com ruído, paradas, veículo, saltos, leituras velhas, repetidas, fora de ordem, sem precisão e relógio adiantado.
function misto(i, s, opc) {
  const fase = Math.floor(i / 60) % 5;
  const dt = 1000 + (rnd() < 0.1 ? Math.round(rnd() * 4000) : 0);
  s.agora += dt;
  let vel = null, passo = 0;
  if (fase === 1) passo = 1.3;
  else if (fase === 2) passo = 14 + rnd() * 8;
  else if (fase === 3) passo = rnd() < 0.5 ? 0 : 0.6;
  if (passo) {
    const ang = (i / 40) + rnd() * 0.3;
    s.lat += Math.cos(ang) * passo * (dt / 1000) * M;
    s.lng += Math.sin(ang) * passo * (dt / 1000) * M / Math.cos(s.lat * Math.PI / 180);
  }
  if (opc.velocidade && rnd() < 0.8) vel = passo ? passo + (rnd() - 0.5) : rnd() * 0.2;
  let prec = 4 + rnd() * 25;
  if (rnd() < 0.08) prec = 160 + rnd() * 400;
  if (rnd() < 0.05) prec = null;
  const ruido = (prec || 10) * 0.4;
  let lat = s.lat + (rnd() - 0.5) * ruido * M, lng = s.lng + (rnd() - 0.5) * ruido * M;
  if (rnd() < 0.02) { lat += 0.01; lng -= 0.01; }                  // salto isolado (~1,4 km)
  let ts = s.agora - Math.round(rnd() * 800) + (opc.relogio || 0);
  if (rnd() < 0.03) ts = s.agora - 45000;                             // leitura velha (cache)
  if (rnd() < 0.03 && s.ultima) return Object.assign({}, s.ultima, { agora: s.agora });   // repetida
  if (rnd() < 0.02) ts = s.agora - 60000 * 60 * 30;                   // horário absurdo (> 24 h): usa o do aparelho
  if (rnd() < 0.01) { lat = 0; lng = 0; }
  const l = { lat, lng, prec, vel, ts, agora: s.agora };
  s.ultima = l;
  return l;
}

const casos = [
  cenario('misto com velocidade', 600, null, (i, s) => misto(i, s, { velocidade: true })),
  cenario('misto sem velocidade', 600, null, (i, s) => misto(i, s, {})),
  cenario('relógio adiantado 40 s', 400, null, (i, s) => misto(i, s, { velocidade: true, relogio: -40000 })),
  cenario('intervalo da operação 30 s', 500, { intervaloParadoMs: 30000 }, (i, s) => misto(i, s, {})),
  cenario('intervalo da operação 5 s', 300, { intervaloParadoMs: 5000 }, (i, s) => misto(i, s, { velocidade: true })),
  cenario('veículo em rodovia', 300, null, (i, s) => {
    s.agora += 1000;
    s.lat += 25 * M;
    return { lat: s.lat + (rnd() - 0.5) * 5 * M, lng: s.lng, prec: 5 + rnd() * 5, vel: rnd() < 0.5 ? 25 : null, ts: s.agora, agora: s.agora };
  }),
  cenario('parado em mata (precisão ruim)', 400, null, (i, s) => {
    s.agora += 1000 + Math.round(rnd() * 2000);
    const prec = 30 + rnd() * 140;
    return { lat: s.lat + (rnd() - 0.5) * prec * M, lng: s.lng + (rnd() - 0.5) * prec * M, prec, vel: null, ts: s.agora - 300, agora: s.agora };
  }),
];

const destino = process.argv[2] || path.join(__dirname, '../app/src/test/resources/filtro-casos.json');
fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.writeFileSync(destino, JSON.stringify(casos));
const pontos = casos.reduce((n, c) => n + c.passos.reduce((m, p) => m + p.p.length, 0), 0);
console.log('Casos do filtro: ' + casos.length + ' cenários, ' + casos.reduce((n, c) => n + c.passos.length, 0) + ' leituras, ' + pontos + ' pontos → ' + path.relative(process.cwd(), destino));
