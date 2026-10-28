// Regras do monitoramento meteorológico (public/js/meteo-core.js). Não usa rede.
const M = require('../public/js/meteo-core.js');
const assert = require('assert');
let falhas = 0;
function teste(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
const agora = Date.parse('2026-10-15T20:00:00Z');
const hora = (h) => ({ t: new Date(agora + h * 3600e3).toISOString(), precip: 0, prob: 0, codigo: 1, rajada: 10 });
const nomes = (lista) => lista.map((a) => a.chave).sort();

console.log('Meteorologia: regras');
teste('faixas de chuva', () => {
  assert.strictEqual(M.intensidadeChuva(0), 'nenhuma');
  assert.strictEqual(M.intensidadeChuva(1), 'fraca');
  assert.strictEqual(M.intensidadeChuva(2.5), 'moderada');
  assert.strictEqual(M.intensidadeChuva(10), 'intensa');
});
teste('severidade CAP vira nível do painel', () => {
  assert.strictEqual(M.nivelDeSeveridade('Extreme'), 'critico');
  assert.strictEqual(M.nivelDeSeveridade('Severe'), 'critico');
  assert.strictEqual(M.nivelDeSeveridade('Moderate'), 'alerta');
  assert.strictEqual(M.nivelDeSeveridade('Minor'), 'atencao');
  assert.strictEqual(M.nivelDeSeveridade('Unknown'), 'informativo');
});
teste('distância e rumo (haversine): 0,1° de latitude ≈ 11,1 km, para o norte', () => {
  const d = M.distanciaM(-25.4, -49.2, -25.3, -49.2);
  assert.ok(Math.abs(d - 11119) < 30, 'distância ' + d);
  assert.ok(Math.abs(M.rumoGraus(-25.4, -49.2, -25.3, -49.2)) < 0.5);
});
teste('chuva intensa prevista gera alerta com chegada e incerteza', () => {
  const horas = [0, 1, 2, 3].map(hora);
  horas[2].precip = 11;
  horas[1].prob = 70;
  const r = M.analisar({ atual: { precipitacao: 0 }, horas }, [], agora);
  const intensa = r.find((a) => a.chave === 'chuva-intensa');
  assert.ok(intensa && intensa.nivel === 'alerta');
  assert.strictEqual(intensa.eta.t, horas[1].t, 'chegada pela primeira hora com probabilidade ≥ 60%');
  assert.strictEqual(intensa.eta.incertezaMin, 30);
});
teste('tempestade e granizo são indicativos e não aparecem sem o código do modelo', () => {
  assert.deepStrictEqual(nomes(M.analisar({ atual: { precipitacao: 0 }, horas: [0, 1, 2].map(hora) }, [], agora)), []);
  const horas = [0, 1, 2].map(hora);
  horas[1].codigo = 96;
  assert.deepStrictEqual(nomes(M.analisar({ atual: { precipitacao: 0 }, horas }, [], agora)), ['granizo', 'tempestade']);
});
teste('rajadas: atenção a partir de 40 km/h, alerta a partir de 60 km/h', () => {
  const horas = [0, 1].map(hora);
  horas[1].rajada = 45;
  assert.strictEqual(M.analisar({ horas }, [], agora).find((a) => a.chave === 'rajadas').nivel, 'atencao');
  horas[1].rajada = 61;
  assert.strictEqual(M.analisar({ horas }, [], agora).find((a) => a.chave === 'rajadas').nivel, 'alerta');
});
teste('chegada: sem chuva prevista no modelo, nada é estimado (null)', () => {
  assert.strictEqual(M.previsaoChegada([0, 1, 2].map(hora), agora), null);
});
teste('chegada depois da 1ª hora usa incerteza maior', () => {
  const horas = [0, 1, 2, 3].map(hora);
  horas[3].prob = 80;
  assert.strictEqual(M.previsaoChegada(horas, agora).incertezaMin, 60);
});
teste('alerta oficial mantém a chave, o nível e o horário de validade', () => {
  const oficial = { id: 'INMET-1', evento: 'Tempestades', severidade: 'Severe', inicio: '2026-10-15T20:00:00Z', fim: '2026-10-16T02:00:00Z', descricao: 'x', area: 'Paraná' };
  const r = M.analisar({ horas: [] }, [oficial], agora);
  assert.strictEqual(r[0].chave, 'oficial:INMET-1');
  assert.strictEqual(r[0].nivel, 'critico');
  assert.strictEqual(r[0].fim, oficial.fim);
});
teste('dados desatualizados: nunca atualizado ou além do limite', () => {
  assert.strictEqual(M.desatualizado(null, agora, 20), true);
  assert.strictEqual(M.desatualizado(new Date(agora - 10 * 60e3).toISOString(), agora, 20), false);
  assert.strictEqual(M.desatualizado(new Date(agora - 25 * 60e3).toISOString(), agora, 20), true);
});
teste('sem repetição: só notifica alerta novo ou nível que subiu', () => {
  const a = { nivel: 'alerta' };
  assert.strictEqual(M.deveNotificar(undefined, a), true);
  assert.strictEqual(M.deveNotificar(a, { nivel: 'alerta' }), false);
  assert.strictEqual(M.deveNotificar(a, { nivel: 'critico' }), true);
  assert.strictEqual(M.deveNotificar(a, { nivel: 'atencao' }), false);
});
teste('estados entre leituras: novo, atualizado, mantido e expirado', () => {
  const antes = [{ chave: 'x', nivel: 'alerta', titulo: 'T', detalhe: '' }, { chave: 'y', nivel: 'atencao', titulo: 'U', detalhe: '' }];
  const depois = [{ chave: 'x', nivel: 'critico', titulo: 'T', detalhe: '' }, { chave: 'z', nivel: 'alerta', titulo: 'V', detalhe: '' }];
  const e = Object.fromEntries(M.compararLeituras(antes, depois).map((a) => [a.chave, a.estado]));
  assert.deepStrictEqual(e, { x: 'atualizado', z: 'novo', y: 'expirado' });
});

console.log('Meteorologia: vento e temperatura');
teste('componentes do vento: direção é de onde vem; vento de oeste empurra para leste', () => {
  const c = M.componentesVento(10, 270);
  assert.ok(Math.abs(c.u - 10) < 1e-9 && Math.abs(c.v) < 1e-9, JSON.stringify(c));
  const n = M.componentesVento(10, 0);   // vem do norte: vai para o sul
  assert.ok(Math.abs(n.v + 10) < 1e-9);
});
teste('interpolação bilinear no centro da grade e nulo fora dela', () => {
  const g = { lat0: -25, lng0: -50, dlat: 0.1, dlng: 0.1, nLin: 3, nCol: 3, valores: [10, 11, 12, 20, 21, 22, 30, 31, 32] };
  assert.ok(Math.abs(M.interpolar(g, -24.9, -49.9) - 21) < 1e-9);
  assert.strictEqual(M.interpolar(g, -30, -49), null);
});
teste('interpolação com ponto ausente na grade devolve nulo (não inventa valor)', () => {
  const g = { lat0: 0, lng0: 0, dlat: 1, dlng: 1, nLin: 2, nCol: 2, valores: [1, null, 3, 4] };
  assert.strictEqual(M.interpolar(g, 0.5, 0.5), null);
});
teste('escalas de cor: frio azul, quente vermelho, nulo sem cor', () => {
  assert.deepStrictEqual(M.corTemperatura(-10), M.PARADAS_TEMP[0][1]);
  assert.deepStrictEqual(M.corTemperatura(40), M.PARADAS_TEMP[M.PARADAS_TEMP.length - 1][1]);
  assert.strictEqual(M.corTemperatura(null), null);
  assert.deepStrictEqual(M.corVento(0), M.PARADAS_VENTO[0][1]);
});

console.log('Meteorologia: chuva na área e distância');
teste('chuva mais próxima: distância e direção a partir do centro, ignorando pontos secos', () => {
  const pts = [{ lat: -25.5, lng: -49.2, precipitacao: 0 }, { lat: -25.4, lng: -49.0, precipitacao: 3 }, { lat: -25.7, lng: -49.2, precipitacao: 6 }];
  const c = M.chuvaMaisProxima(pts, -25.4, -49.2);
  assert.ok(Math.abs(c.lng + 49.0) < 1e-9, 'escolhe o ponto molhado mais próximo, não o seco');
  assert.strictEqual(M.direcaoCardeal(c.rumo), 'L');
  assert.ok(Math.abs(c.distanciaM - M.distanciaM(-25.4, -49.2, -25.4, -49.0)) < 1e-6);
});
teste('nenhum ponto com chuva: sem alerta de chuva na área', () => {
  assert.strictEqual(M.chuvaMaisProxima([{ lat: 0, lng: 0, precipitacao: 0 }], -25, -49), null);
  assert.strictEqual(M.alertaChuvaProxima(null), null);
});
teste('alerta de chuva na área: nível pela distância e intensidade, sem prometer deslocamento', () => {
  const perto = M.alertaChuvaProxima({ distanciaM: 8000, precipitacao: 12, rumo: 0, lat: 0, lng: 0 });
  assert.strictEqual(perto.nivel, 'alerta');
  assert.ok(/8 km N/.test(perto.titulo), perto.titulo);
  assert.strictEqual(M.alertaChuvaProxima({ distanciaM: 20000, precipitacao: 3, rumo: 90 }).nivel, 'atencao');
  assert.strictEqual(M.alertaChuvaProxima({ distanciaM: 60000, precipitacao: 3, rumo: 90 }).nivel, 'informativo');
  assert.ok(/sem direção de deslocamento/.test(perto.detalhe));
});

teste('escala Beaufort: forças e nomes pelos limites em km/h', () => {
  const casos = [[0, 0, 'Calmaria'], [5, 1, 'Aragem'], [6, 2, 'Brisa leve'], [19, 3, 'Brisa fraca'], [28, 4, 'Brisa moderada'], [29, 5, 'Brisa forte'],
    [38, 5, 'Brisa forte'], [39, 6, 'Vento fresco'], [49, 6, 'Vento fresco'], [50, 7, 'Vento forte'], [62, 8, 'Ventania'], [75, 9, 'Ventania forte'],
    [89, 10, 'Tempestade'], [103, 11, 'Tempestade violenta'], [118, 12, 'Furacão'], [200, 12, 'Furacão']];
  casos.forEach(([kmh, forca, nome]) => {
    const b = M.beaufort(kmh);
    assert.strictEqual(b.forca, forca, kmh + ' km/h');
    assert.strictEqual(b.nome, nome, kmh + ' km/h');
  });
  assert.strictEqual(M.beaufort(null), null);
  assert.strictEqual(M.beaufort(-3), null);
});
teste('Beaufort: nível do alerta pela força (nenhum até 4; atenção em 6; alerta em 7–8; crítico a partir de 9)', () => {
  assert.strictEqual(M.alertaBeaufort(4), null);
  assert.strictEqual(M.alertaBeaufort(5).nivel, 'informativo');
  assert.strictEqual(M.alertaBeaufort(6).nivel, 'atencao');
  assert.strictEqual(M.alertaBeaufort(7).nivel, 'alerta');
  assert.strictEqual(M.alertaBeaufort(8).nivel, 'alerta');
  assert.strictEqual(M.alertaBeaufort(9).nivel, 'critico');
  assert.strictEqual(M.alertaBeaufort(12).nivel, 'critico');
});
teste('vento calmo ou fraco não gera alerta de Beaufort', () => {
  const horas = [0, 1, 2].map((h) => Object.assign(hora(h), { vento: 18 }));
  const r = M.analisar({ atual: { precipitacao: 0, vento: 12 }, horas }, [], agora);
  assert.ok(!r.some((a) => a.chave === 'beaufort'));
});
teste('vento agora em força 7: alerta com o efeito para a equipe e sem horário de chegada', () => {
  const horas = [0, 1, 2].map((h) => Object.assign(hora(h), { vento: 20 }));
  const a = M.analisar({ atual: { precipitacao: 0, vento: 55 }, horas }, [], agora).find((x) => x.chave === 'beaufort');
  assert.strictEqual(a.nivel, 'alerta');
  assert.ok(/Vento forte \(Beaufort 7\)/.test(a.titulo), a.titulo);
  assert.ok(/drones/.test(a.detalhe) && /agora/.test(a.detalhe), a.detalhe);
  assert.strictEqual(a.eta, null);
});
teste('vento forte previsto para daqui a 2 h: alerta com a hora do pico', () => {
  const horas = [0, 1, 2].map((h) => Object.assign(hora(h), { vento: h === 2 ? 80 : 15 }));
  const a = M.analisar({ atual: { precipitacao: 0, vento: 14 }, horas }, [], agora).find((x) => x.chave === 'beaufort');
  assert.strictEqual(a.nivel, 'critico');
  assert.ok(/Ventania forte \(Beaufort 9\)/.test(a.titulo), a.titulo);
  assert.ok(/agora 14 km\/h/.test(a.detalhe), a.detalhe);
  assert.strictEqual(a.eta.t, horas[2].t);
});
teste('vento fora da janela de alerta (muito à frente) não conta', () => {
  const horas = [0, 1].map(hora).concat([Object.assign(hora(8), { vento: 90 })]);
  assert.ok(!M.analisar({ atual: { precipitacao: 0, vento: 10 }, horas }, [], agora).some((a) => a.chave === 'beaufort'));
});

teste('chuva se aproximando: velocidade e chegada pela queda da distância entre leituras', () => {
  const min = 60e3;
  const hist = [{ t: agora - 30 * min, distanciaM: 70000 }, { t: agora - 15 * min, distanciaM: 55000 }, { t: agora, distanciaM: 40000 }];
  const t = M.tendenciaChuva(hist, agora);
  assert.ok(Math.abs(t.velKmh - 60) < 0.5, 'velocidade ' + t.velKmh);       // 30 km em 30 min
  assert.ok(Math.abs(t.etaMin - 40) <= 1, 'chegada ' + t.etaMin);            // 40 km a 60 km/h
  assert.strictEqual(t.distanciaM, 40000);
});
teste('tendência: sem leituras suficientes, distância estável, afastando ou ruído absurdo não geram aproximação', () => {
  const min = 60e3;
  assert.strictEqual(M.tendenciaChuva([], agora), null);
  assert.strictEqual(M.tendenciaChuva([{ t: agora, distanciaM: 30000 }], agora), null);
  assert.strictEqual(M.tendenciaChuva([{ t: agora - 5 * min, distanciaM: 50000 }, { t: agora, distanciaM: 30000 }], agora), null, 'intervalo curto');
  assert.strictEqual(M.tendenciaChuva([{ t: agora - 30 * min, distanciaM: 40000 }, { t: agora, distanciaM: 39000 }], agora), null, 'queda pequena');
  assert.strictEqual(M.tendenciaChuva([{ t: agora - 30 * min, distanciaM: 30000 }, { t: agora, distanciaM: 50000 }], agora), null, 'afastando');
  assert.strictEqual(M.tendenciaChuva([{ t: agora - 20 * min, distanciaM: 90000 }, { t: agora, distanciaM: 20000 }], agora), null, '210 km/h é ruído');
  assert.strictEqual(M.tendenciaChuva([{ t: agora - 120 * min, distanciaM: 80000 }, { t: agora, distanciaM: 30000 }], agora), null, 'leitura velha demais');
});
teste('tendência: um "sem chuva" no meio zera a série', () => {
  const min = 60e3;
  const hist = [{ t: agora - 45 * min, distanciaM: 80000 }, { t: agora - 30 * min, distanciaM: null }, { t: agora - 15 * min, distanciaM: 50000 }, { t: agora, distanciaM: 48000 }];   // só 2 km depois do zerar; os 30 km antes do "sem chuva" não contam
  assert.strictEqual(M.tendenciaChuva(hist, agora), null);
});
teste('alerta de chuva se aproximando: título com a chegada, nível sobe com o tempo restante e o aviso de que não é radar', () => {
  const chuva = { distanciaM: 40000, precipitacao: 4, rumo: 270, lat: 0, lng: 0 };
  const perto = M.alertaChuvaProxima(chuva, { velKmh: 60, etaMin: 40, distanciaM: 40000 });
  assert.strictEqual(perto.nivel, 'alerta');
  assert.ok(/se aproximando: ~40 km O, chega em ~40 min/.test(perto.titulo), perto.titulo);
  assert.ok(/60 km\/h/.test(perto.detalhe) && /não é radar/.test(perto.detalhe), perto.detalhe);
  assert.strictEqual(perto.eta.tipo, 'estimativa_tendencia');
  assert.strictEqual(M.alertaChuvaProxima(chuva, { velKmh: 20, etaMin: 120, distanciaM: 40000 }).nivel, 'atencao');
  assert.strictEqual(M.alertaChuvaProxima(chuva, { velKmh: 8, etaMin: 300, distanciaM: 40000 }).nivel, 'informativo');
  assert.strictEqual(M.alertaChuvaProxima({ distanciaM: 40000, precipitacao: 0.8, rumo: 0 }, { velKmh: 60, etaMin: 40 }).nivel, 'informativo', 'chuva fraca não escala');
  assert.ok(/h/.test(M.alertaChuvaProxima(chuva, { velKmh: 8, etaMin: 300, distanciaM: 40000 }).titulo));
});

if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
console.log('\nTodos os testes de meteorologia passaram.');
