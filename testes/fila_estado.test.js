// Teste do resumo da fila offline na interface (public/js/fila-estado.js) — rode com: node testes/fila_estado.test.js
require(require('path').join(__dirname, '../public/js/trilha-local.js'));
const F = require(require('path').join(__dirname, '../public/js/fila-estado.js'));
const T = globalThis.TrilhaLocal;
let ok = 0, falha = 0;
const chk = (c, m, x) => { if (c) { ok++; console.log('  ✔ ' + m); } else { falha++; console.log('  ✘ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };
const t0 = 1.7e12;
const ponto = (n, dt) => ({ id: '00000000-0000-4000-8000-' + String(n).padStart(12, '0'), lat: -22.9, lng: -43.2, prec: 8, t: t0 + (dt == null ? n * 15000 : dt) });
const quota = () => { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; return e; };
const linha = (r, rotulo) => r.linhas.find((l) => l[0] === rotulo);

(async () => {
  const durRaiz = T.memoria({ duravel: true });
  console.log('Tudo certo');
  let f = await T.abrir({ participanteId: 'a', armazenamento: durRaiz, persistencia: false });
  let r = F.formatar(f.diagnostico(t0), t0);
  chk(r.nivel === 'ok' && /gravados e sincronizados/i.test(r.titulo) && r.alerta === null, 'sem pendências: nível ok, sem alerta', r);
  chk(linha(r, 'Última sincronização confirmada')[1] === 'ainda nenhuma neste aparelho', 'ainda não houve sincronização confirmada');
  await f.adicionar([ponto(1, 0), ponto(2, 15000)]);
  r = F.formatar(f.diagnostico(t0 + 125000), t0 + 125000);
  chk(r.nivel === 'ok' && linha(r, 'Pontos pendentes')[1] === '2 ponto(s) · o mais antigo é de há 2 min' && linha(r, 'Gravação no aparelho')[2] === 'ok', 'mostra a quantidade e a idade do mais antigo pendente', linha(r, 'Pontos pendentes'));
  r = F.formatar(f.diagnostico(t0 + 30 * 60000), t0 + 30 * 60000);
  chk(r.nivel === 'atencao' && linha(r, 'Pontos pendentes')[1].includes('30 min'), 'pendência com mais de 10 min vira aviso');
  await f.marcarEnviados([ponto(1, 0).id, ponto(2, 15000).id], t0 + 40 * 60000);
  r = F.formatar(f.diagnostico(t0 + 41 * 60000), t0 + 41 * 60000);
  chk(/há 1 min/.test(linha(r, 'Última sincronização confirmada')[1]) && r.nivel === 'ok', 'última sincronização confirmada, com hora e há quanto tempo');

  console.log('Gravação no aparelho');
  const mem = T.memoria();
  const fm = await T.abrir({ participanteId: 'b', armazenamento: mem, persistencia: false });
  await fm.adicionar([ponto(1)]);
  r = F.formatar(fm.diagnostico());
  chk(r.nivel === 'erro' && /não feche/i.test(r.alerta) && linha(r, 'Gravação no aparelho')[2] === 'erro', 'sem armazenamento seguro: erro e pede para não fechar a página', r);
  const fq = await T.abrir({ participanteId: 'c', armazenamento: durRaiz, persistencia: false });
  const g = fq.armaz.gravar; fq.armaz.gravar = () => Promise.reject(quota());
  await fq.adicionar([ponto(1), ponto(2)]);
  r = F.formatar(fq.diagnostico());
  chk(r.nivel === 'erro' && /2 ponto\(s\) ainda NÃO gravados no aparelho \(sem espaço no aparelho\)/.test(linha(r, 'Gravação no aparelho')[1]), 'falta de espaço: diz quantos pontos não estão gravados e por quê', linha(r, 'Gravação no aparelho'));
  r = F.formatar(fq.diagnostico(), Date.now(), { pendentes: 3, naoDuraveis: 3 });
  chk(/5 ponto\(s\) ainda NÃO/.test(linha(r, 'Gravação no aparelho')[1]) && /5 ponto\(s\) só existem/.test(r.alerta), 'pontos do buffer da abertura entram na conta de não gravados');
  chk(r.eventos.some((e) => /Não foi possível gravar no aparelho \(sem espaço no aparelho\)/.test(e)), 'a ocorrência aparece na lista de eventos', r.eventos);
  fq.armaz.gravar = g;

  console.log('Falhas de envio, recusas e lacunas');
  const fs = await T.abrir({ participanteId: 'd', armazenamento: durRaiz, persistencia: false });
  await fs.adicionar([ponto(1, 0), ponto(2, 600000)]);
  fs.transicao('sync', true, { codigo: 'rede' });
  r = F.formatar(fs.diagnostico());
  chk(r.nivel === 'atencao' && /falhando agora/.test(linha(r, 'Última sincronização confirmada')[1]) && r.eventos.some((e) => /Falha ao enviar.*sem internet/.test(e)), 'falha de envio em aberto aparece com o motivo', r);
  chk(linha(r, 'Intervalos sem registro') && /interrompida/.test(linha(r, 'Intervalos sem registro')[1]) && r.eventos.some((e) => /Sem pontos por 10 min/.test(e)), 'intervalo sem registro: avisa que a trilha fica interrompida e não liga os lados');
  await fs.marcarRecusados([{ id: ponto(1, 0).id, motivo: 'fora_do_periodo' }]);
  r = F.formatar(fs.diagnostico());
  chk(linha(r, 'Recusados pelo servidor') && /não aparecem na trilha/.test(r.alerta) && r.eventos.some((e) => /1 ponto\(s\) recusados pelo servidor \(horário fora da operação\)/.test(e)), 'ponto recusado: comunicado ao usuário e listado com o motivo', r);
  fs.transicao('gps', true, { motivo: 'negado' });
  r = F.formatar(fs.diagnostico());
  chk(linha(r, 'GPS') && r.eventos.some((e) => /GPS parou de registrar \(localização bloqueada\)/.test(e)), 'falha de GPS registrada');

  console.log('Servidor antigo e armazenamento');
  const fa = await T.abrir({ participanteId: 'e', armazenamento: durRaiz, persistencia: false });
  await fa.adicionar([ponto(1)]);
  await fa._marcarLegado(fa.pendentes(), Date.now());
  fa.semLoteDesde = Date.now();
  r = F.formatar(fa.diagnostico());
  chk(r.nivel === 'atencao' && /não confirma ponto a ponto/.test(r.alerta) && linha(r, 'Entregues sem confirmação')[1] === '1 ponto(s)', 'servidor sem confirmação: avisa que entregou mas não confirmou');
  const d = fa.diagnostico(); d.persistente = false; d.uso = 90e6; d.quota = 100e6; d.tipo = 'indexeddb';
  r = F.formatar(d);
  chk(/pode apagar/.test(linha(r, 'Armazenamento')[1]) && /quase cheio/.test(linha(r, 'Armazenamento')[1]), 'armazenamento não persistente e quase cheio é sinalizado');

  console.log('\nResumo da fila na interface: ' + ok + ' OK, ' + falha + ' falha(s)');
  process.exit(falha ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
