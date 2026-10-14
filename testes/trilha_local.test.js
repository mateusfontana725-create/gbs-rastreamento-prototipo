// Teste da fila offline da trilha (public/js/trilha-local.js) — rode com: node testes/trilha_local.test.js
// Usa o armazenamento em memória (o mesmo código da fila do IndexedDB) e um servidor simulado.
require(require('path').join(__dirname, '../public/js/trilha-local.js'));
const T = globalThis.TrilhaLocal;
let ok = 0, falha = 0;
const chk = (c, m, x) => { if (c) { ok++; console.log('  ✔ ' + m); } else { falha++; console.log('  ✘ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };
const t0 = 1.7e12;
const ponto = (n, dt) => ({ id: '00000000-0000-4000-8000-' + String(n).padStart(12, '0'), lat: -22.9 + n * 1e-5, lng: -43.2, prec: 8, t: t0 + (dt == null ? n * 15000 : dt) });

// Servidor simulado: grava por id (idempotente) e devolve os confirmados.
function servidor(opcoes) {
  opcoes = opcoes || {};
  const gravados = new Map();
  const chamadas = [];
  async function rpc(nome, args) {
    chamadas.push(nome);
    if (opcoes.offline) { const e = new Error('Sem conexão'); e.codigo = 'rede'; e.rede = true; throw e; }
    if (nome === 'enviar_posicoes_lote' && opcoes.semLote) { const e = new Error('funcao'); e.codigo = 'funcao_ausente'; throw e; }
    const recusados = [];
    let inseridos = 0;
    args.p_pontos.forEach((p) => {
      if (opcoes.recusar && opcoes.recusar.includes(p.id)) { recusados.push({ id: p.id, motivo: 'fora_do_periodo' }); return; }
      if (opcoes.perder && opcoes.perder.includes(p.id)) return;   // simula um ponto que não entrou
      if (!gravados.has(p.id)) { gravados.set(p.id, p); inseridos++; }
    });
    if (nome === 'enviar_posicoes') return { status: 'ativa', recebidos: args.p_pontos.length, inseridos };
    const confirmados = args.p_pontos.map((p) => p.id).filter((id) => gravados.has(id));
    return { status: 'ativa', inseridos, confirmados, recusados, gps_intervalo_s: 15 };
  }
  return { rpc, gravados, chamadas, opcoes };
}

(async () => {
  const memoria = T.memoria();
  const ids = { participanteId: 'part-1', userId: 'user-1', operacaoId: 'op-1', armazenamento: memoria };

  console.log('Gravação local');
  let fila = await T.abrir(ids);
  await fila.adicionar([ponto(3), ponto(1), ponto(2)]);
  chk(fila.qtdPendentes() === 3, 'três pontos ficam pendentes no aparelho', fila.qtdPendentes());
  chk(fila.pendentes().map((p) => p.t).join() === [ponto(1).t, ponto(2).t, ponto(3).t].join(), 'pendentes saem em ordem do horário do GPS');
  const r0 = fila.pendentes()[0];
  chk(r0.id && r0.lat != null && r0.lng != null && r0.prec != null && r0.t && r0.user_id === 'user-1' && r0.operacao_id === 'op-1' &&
      r0.participante_id === 'part-1' && r0.enviado === false, 'cada ponto tem id, lat, lng, precisão, hora do GPS, usuário, operação e indicador de envio', r0);
  await fila.adicionar([ponto(1)]);
  chk(fila.qtdPendentes() === 3, 'mesmo id adicionado de novo não duplica');

  console.log('Sem conexão');
  let srv = servidor({ offline: true });
  let erro = null;
  try { await T.enviarLote(fila, srv.rpc); } catch (e) { erro = e; }
  chk(erro && erro.rede, 'sem conexão: o envio falha e avisa (para tentar de novo)');
  chk(fila.qtdPendentes() === 3 && fila.qtdEnviados() === 0, 'sem conexão: nada é marcado como enviado');
  const reaberta = await T.abrir(ids);
  chk(reaberta.qtdPendentes() === 3, 'recarregar a página (abrir de novo) recupera os pendentes do armazenamento');

  console.log('Conexão de volta: envio em lote');
  srv = servidor();
  let r = await T.enviarLote(fila, srv.rpc);
  chk(r.confirmados === 3 && fila.qtdPendentes() === 0 && fila.qtdEnviados() === 3, 'lote enviado: os 3 confirmados pelo servidor são marcados como enviados', r);
  chk(srv.chamadas[0] === 'enviar_posicoes_lote', 'usa enviar_posicoes_lote (confirmação por ponto)');
  r = await T.enviarLote(fila, srv.rpc);
  chk(r.vazio && srv.chamadas.length === 1, 'nada pendente: não chama o servidor de novo');

  console.log('Confirmação só do que o servidor gravou');
  await fila.adicionar([ponto(4), ponto(5), ponto(6)]);
  srv.opcoes.perder = [ponto(5).id];
  srv.opcoes.recusar = [ponto(6).id];
  r = await T.enviarLote(fila, srv.rpc);
  chk(r.confirmados === 1 && r.recusados === 1, 'servidor confirmou 1, recusou 1 e não respondeu sobre 1', r);
  chk(fila.pendentes().map((p) => p.id).join() === ponto(5).id, 'o ponto não confirmado continua pendente (será reenviado)');
  chk(fila.recusados().length === 1 && fila.recusados()[0].recusado === 'fora_do_periodo', 'o recusado fica marcado com o motivo e não é reenviado');
  srv.opcoes.perder = [];
  r = await T.enviarLote(fila, srv.rpc);
  chk(r.confirmados === 1 && fila.qtdPendentes() === 0, 'reenvio do pendente: confirmado');

  console.log('Reenvio não duplica (idempotência pelo id)');
  const antes = srv.gravados.size;
  const outra = await T.abrir({ participanteId: 'part-1', userId: 'user-1', operacaoId: 'op-1', armazenamento: T.memoria() });
  await outra.adicionar([ponto(1), ponto(2), ponto(7)]);   // 1 e 2 já estão no servidor
  r = await T.enviarLote(outra, srv.rpc);
  chk(r.confirmados === 3 && srv.gravados.size === antes + 1, 'pontos já gravados são confirmados de novo sem duplicar no servidor', [r.confirmados, srv.gravados.size - antes]);

  console.log('Servidor sem a migração 009');
  const antigo = servidor({ semLote: true });
  const f2 = await T.abrir({ participanteId: 'part-2', armazenamento: T.memoria() });
  await f2.adicionar([ponto(1), ponto(2)]);
  r = await T.enviarLote(f2, antigo.rpc);
  chk(r.antigo && r.confirmados === 2 && antigo.chamadas.join() === 'enviar_posicoes_lote,enviar_posicoes', 'cai para enviar_posicoes e considera o lote entregue (como antes)', antigo.chamadas);

  console.log('Fila antiga (localStorage) e limpeza');
  const mem3 = T.memoria();
  const f3 = await T.abrir({ participanteId: 'part-3', armazenamento: mem3, legado: [ponto(8), ponto(9)] });
  chk(f3.qtdPendentes() === 2, 'pontos da fila anterior entram na fila nova');
  chk((await T.abrir({ participanteId: 'part-3', armazenamento: mem3 })).qtdPendentes() === 2, 'e ficam gravados no armazenamento novo');
  const mem4 = T.memoria();
  const f4 = await T.abrir({ participanteId: 'part-4', armazenamento: mem4 });
  await f4.adicionar([ponto(1)]);
  await f4.marcarEnviados([ponto(1).id], Date.now() - 49 * 3600 * 1000);
  const f4b = await T.abrir({ participanteId: 'part-4', armazenamento: mem4 });
  chk(f4b.qtdEnviados() === 0, 'enviados há mais de 48 h são apagados do aparelho ao abrir');
  await f3.limpar();
  const f3b = await T.abrir({ participanteId: 'part-3', armazenamento: mem3 });
  chk(f3.qtdPendentes() === 0 && f3b.qtdPendentes() === 0, 'fim da participação: limpar() apaga a fila deste participante');

  console.log('\nFila offline da trilha: ' + ok + ' OK, ' + falha + ' falha(s)');
  process.exit(falha ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
