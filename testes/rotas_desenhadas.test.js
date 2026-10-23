// Teste da geração de rotas desenhadas (public/js/rotas.js): trajeto traçado → rota com
// distância, tempo, instruções de curva e progresso; simplificação; escolha traçado × cálculo.
// Rode com: node testes/rotas_desenhadas.test.js
const path = require('path');
globalThis.window = globalThis;
require(path.join(__dirname, '../public/js/gps.js'));
window.Comunicacao = { cliente: { auth: { getSession: async () => ({ data: { session: null } }) } } };
require(path.join(__dirname, '../public/js/rotas.js'));
const R = window.Rotas;
let ok = 0, falha = 0;
const chk = (c, m, x) => { if (c) { ok++; console.log('  ✔ ' + m); } else { falha++; console.log('  ✘ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };
const perto = (a, b, tol) => Math.abs(a - b) <= tol;

const LAT0 = -23.44, LNG0 = -51.25;
const M_LAT = 1 / 111195, M_LNG = 1 / (111195 * Math.cos(LAT0 * Math.PI / 180));
const p = (norte, leste) => [LAT0 + norte * M_LAT, LNG0 + leste * M_LNG];

(async () => {
  console.log('Trajeto em "L": 300 m para o norte e 200 m para o leste');
  const L = [];
  for (let i = 0; i <= 30; i++) L.push(p(i * 10, (i % 2) * 0.8));        // norte, com tremor de mão de ~1 m
  for (let i = 1; i <= 20; i++) L.push(p(300, i * 10));                  // leste
  const rota = R.deTracado(L, { origem: p(-20, 0), modo: 'a_pe', nome: 'Ponte' });
  chk(rota.desenhada && rota.fixa && rota.geometria.length === L.length, 'vira uma rota desenhada com a linha inteira');
  chk(perto(rota.distancia_m, 500, 8), 'distância ≈ 500 m', rota.distancia_m);
  chk(perto(rota.duracao_s, 500 / 1.2, 15), 'tempo a pé ≈ 7 min (1,2 m/s)', rota.duracao_s);
  const curvas = rota.passos.filter((x) => x.tipo === 'curva');
  chk(curvas.length === 1 && /Vire à direita/.test(curvas[0].instrucao), 'uma curva: "Vire à direita" (o tremor não vira curva)', rota.passos.map((x) => x.instrucao));
  chk(/norte/.test(rota.passos[0].instrucao) && /Chegada: Ponte/.test(rota.passos[rota.passos.length - 1].instrucao), 'começa "para o norte" e termina na chegada');
  chk(perto(rota.passos[0].distancia_m, 300, 8) && perto(curvas[0].distancia_m, 200, 8), 'distância de cada trecho (300 m e 200 m)', rota.passos.map((x) => x.distancia_m));
  chk(rota.inicio_m === 20 || perto(rota.inicio_m, 20, 1), 'sabe a distância até o início do trajeto', rota.inicio_m);
  const trilha = R.deTracado(L, { modo: 'trilha' });
  chk(trilha.duracao_s > rota.duracao_s, 'em trilha o tempo estimado é maior');

  console.log('Progresso ao longo do trajeto');
  const meio = R.progresso(rota, ...p(150, 3));
  chk(perto(meio.percorrido, 150, 6) && perto(meio.restante, 350, 6) && meio.distanciaDaRota < 5, 'no meio do 1º trecho: 150 m feitos, 350 m faltando', meio);
  chk(/Vire à direita/.test(meio.proximo.instrucao) && perto(meio.distManobra, 150, 6), 'próxima instrução: virar à direita em 150 m', meio.proximo);
  const fora = R.progresso(rota, ...p(150, 80));
  chk(perto(fora.distanciaDaRota, 80, 3), 'longe da linha: mede a distância até o trajeto', fora.distanciaDaRota);
  chk(/✎ Trajeto desenhado/.test(R.resumo(rota)), 'resumo diz que é trajeto desenhado', R.resumo(rota));

  console.log('Simplificação');
  const denso = [];
  for (let i = 0; i <= 3000; i++) denso.push(p(i, Math.sin(i / 50) * 30));
  const s5 = R.simplificar(denso, 1, 2000);
  chk(s5.length <= 2000 && s5.length > 20, 'linha com 3001 pontos cabe no limite de 2000', s5.length);
  chk(s5[0][0] === denso[0][0] && s5[s5.length - 1][0] === denso[3000][0], 'mantém início e fim');
  const reta = [p(0, 0), p(50, 0), p(100, 0.2), p(150, 0)];
  chk(R.simplificar(reta, 2).length === 2, 'reta com tremor vira 2 pontos');

  console.log('Destino: traçado × cálculo por caminhos');
  const r1 = await R.paraDestino({ lat: L[L.length - 1][0], lng: L[L.length - 1][1], modo: 'a_pe', trajeto: L, nome: 'Ponte' }, { origem: p(0, 0) });
  chk(r1.ok && r1.rota.desenhada, 'destino com trajeto: segue o traçado (sem servidor)');
  const r2 = await R.paraDestino({ lat: -23.4, lng: -51.2, modo: 'a_pe' }, { origem: p(0, 0) });
  chk(!r2.ok && r2.erro === 'nao_autenticado', 'destino sem trajeto: pede a rota ao servidor (aqui sem sessão)', r2);
  chk(R.deTracado([p(0, 0)]) === null && !R.temTrajeto({ trajeto: [p(0, 0)] }), 'trajeto com 1 ponto: não é rota');

  console.log('\nRotas desenhadas: ' + ok + ' OK, ' + falha + ' falha(s)');
  if (falha) process.exit(1);
})();
