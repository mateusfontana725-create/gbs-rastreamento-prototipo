// Teste da fila offline da trilha (public/js/trilha-local.js) — rode com: node testes/trilha_local.test.js
// Usa armazenamentos em memória (com falhas simuladas) e um servidor simulado. O IndexedDB de verdade
// (reabrir, migrar o banco antigo, cota) é testado no navegador, fora do repositório.
require(require('path').join(__dirname, '../public/js/trilha-local.js'));
const T = globalThis.TrilhaLocal;
let ok = 0, falha = 0;
const chk = (c, m, x) => { if (c) { ok++; console.log('  ✔ ' + m); } else { falha++; console.log('  ✘ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };
const t0 = 1.7e12;
const idDe = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const ponto = (n, dt) => ({ id: idDe(n), lat: -22.9 + n * 1e-6, lng: -43.2, prec: 8, t: t0 + (dt == null ? n * 15000 : dt) });
const duravel = () => T.memoria({ duravel: true });   // simula um armazenamento durável
const erroQuota = () => { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; return e; };
const tipos = (f) => f.eventos().map((e) => e.tipo);

// Servidor simulado: grava por id (idempotente) e devolve os confirmados.
function servidor(opcoes) {
  opcoes = opcoes || {};
  const gravados = new Map();
  const chamadas = [];
  async function rpc(nome, args) {
    chamadas.push(nome);
    if (opcoes.offline) { const e = new Error('Sem conexão'); e.codigo = 'rede'; e.rede = true; throw e; }
    if (opcoes.erro500) { const e = new Error('Erro interno do servidor'); e.codigo = 'desconhecido'; throw e; }
    if (nome === 'enviar_posicoes_lote' && opcoes.semLote) { const e = new Error('funcao'); e.codigo = 'funcao_ausente'; throw e; }
    if (nome === 'enviar_posicoes_lote' && opcoes.semConfirmados) return { status: 'ativa', inseridos: 0 };   // resposta sem a lista
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
  const memoria = duravel();
  const ids = { participanteId: 'part-1', userId: 'user-1', operacaoId: 'op-1', armazenamento: memoria, persistencia: false };

  console.log('Gravação local: só é "salvo" depois que o aparelho confirma');
  let fila = await T.abrir(ids);
  let g = await fila.adicionar([ponto(3), ponto(1), ponto(2)]);
  chk(g.adicionados === 3 && g.duraveis === true && fila.qtdNaoDuraveis() === 0 && fila.diagnostico().estadoGravacao === 'duravel', 'armazenamento durável confirmou: pontos salvos', g);
  chk(fila.qtdPendentes() === 3 && fila.pendentes().map((p) => p.t).join() === [ponto(1).t, ponto(2).t, ponto(3).t].join(), 'pendentes saem em ordem do horário do GPS');
  const r0 = fila.pendentes()[0];
  chk(r0.id && r0.lat != null && r0.lng != null && r0.prec != null && r0.t && r0.user_id === 'user-1' && r0.operacao_id === 'op-1' && r0.participante_id === 'part-1' && r0.enviado === false && r0.estado === 'p',
    'cada ponto tem id, lat, lng, precisão, hora do GPS, usuário, operação e estado', r0);
  g = await fila.adicionar([ponto(1)]);
  chk(g.adicionados === 0 && fila.qtdPendentes() === 3, 'mesmo id adicionado de novo não duplica');
  const soMemoria = await T.abrir({ participanteId: 'mem-1', armazenamento: T.memoria(), persistencia: false });
  g = await soMemoria.adicionar([ponto(1)]);
  chk(g.duraveis === false && soMemoria.qtdNaoDuraveis() === 1 && soMemoria.diagnostico().estadoGravacao === 'memoria', 'sem armazenamento durável (só memória): o ponto NÃO é dado como salvo', g);

  console.log('Falta de espaço e falha de gravação');
  const memF = duravel();
  const altMem = duravel();
  const fq = await T.abrir({ participanteId: 'q-1', armazenamento: memF, persistencia: false });
  const armazQ = fq.armaz, gravarOriginal = armazQ.gravar;
  armazQ.gravar = () => Promise.reject(erroQuota());
  g = await fq.adicionar([ponto(1), ponto(2)]);
  chk(g.duraveis === false && fq.qtdNaoDuraveis() === 2 && fq.qtdPendentes() === 2, 'gravação recusada (sem espaço): pontos ficam na memória e marcados como não duráveis', g);
  const dq = fq.diagnostico();
  chk(dq.estadoGravacao === 'falha' && /quota/i.test(dq.falhaGravacao) && dq.falhas.includes('armazenamento'), 'diagnóstico mostra a falha de gravação e o motivo', dq);
  chk(tipos(fq).includes('armazenamento_inicio') && fq.eventos().find((e) => e.tipo === 'armazenamento_inicio').motivo === 'sem_espaco', 'a falha foi registrada como evento "sem espaço"', fq.eventos());
  await fq.adicionar([ponto(3)]);
  chk(tipos(fq).filter((x) => x === 'armazenamento_inicio').length === 1, 'falha repetida não enche o registro de eventos (só a transição)');
  chk(fq.qtdNaoDuraveis() === 3, 'cada ponto novo continua pendente e não durável enquanto falha');
  armazQ.gravar = gravarOriginal;   // abriu espaço
  g = await fq.adicionar([ponto(4)]);
  chk(g.duraveis === true && fq.qtdNaoDuraveis() === 0 && (await T.abrir({ participanteId: 'q-1', armazenamento: () => armazQ, persistencia: false })).qtdPendentes() === 4, 'espaço voltou: os pontos antigos são regravados junto com o novo e ficam salvos', g);
  chk(tipos(fq).includes('armazenamento_fim') && fq.diagnostico().estadoGravacao === 'duravel', 'recuperação registrada e estado volta a "durável"');
  // desvio para localStorage
  const prin = duravel(), desv = duravel();
  const fd = await T.abrir({ participanteId: 'd-1', armazenamento: prin, alternativo: desv, persistencia: false });
  const gravarPrin = fd.armaz.gravar;
  fd.armaz.gravar = () => Promise.reject(erroQuota());
  g = await fd.adicionar([ponto(1), ponto(2)]);
  chk(g.duraveis === true && fd.diagnostico().estadoGravacao === 'alternativo' && fd.qtdNaoDuraveis() === 0, 'IndexedDB falhou mas o desvio gravou: continua salvo (estado "alternativo")', fd.diagnostico());
  fd.armaz.gravar = gravarPrin;
  const fd2 = await T.abrir({ participanteId: 'd-1', armazenamento: prin, alternativo: desv, persistencia: false });
  chk(fd2.qtdPendentes() === 2 && (await desv(('d-1')).carregarPendentes()).length === 0, 'ao reabrir, o que estava no desvio volta para o armazenamento principal', fd2.qtdPendentes());

  console.log('Nada pendente é descartado (sem limite de 5.000)');
  const fg = await T.abrir({ participanteId: 'g-1', armazenamento: duravel(), persistencia: false });
  const lote = [];
  for (let i = 1; i <= 6500; i++) lote.push(ponto(i));
  g = await fg.adicionar(lote);
  chk(g.adicionados === 6500 && fg.qtdPendentes() === 6500 && fg.pendentes()[0].id === idDe(1), 'passou de 5.000 pendências: nenhum ponto antigo é removido', fg.qtdPendentes());
  const reg = await T.abrir({ participanteId: 'g-1', armazenamento: () => fg.armaz, persistencia: false });
  chk(reg.qtdPendentes() === 6500, 'e todos continuam gravados ao reabrir');

  console.log('Sem conexão');
  let srv = servidor({ offline: true });
  let erro = null;
  try { await T.enviarLote(fila, srv.rpc); } catch (e) { erro = e; }
  chk(erro && erro.rede, 'sem conexão: o envio falha e avisa (para tentar de novo)');
  chk(fila.qtdPendentes() === 3 && fila.qtdEnviados() === 0 && fila.diagnostico().ultimaConfirmacaoEm === null, 'sem conexão: nada é marcado como enviado');
  try { await T.enviarLote(fila, srv.rpc); } catch (e) { /* segunda falha */ }
  chk(tipos(fila).filter((x) => x === 'sync_inicio').length === 1, 'falha de sincronização repetida registra só a primeira (não a cada tentativa)');
  const reaberta = await T.abrir(ids);
  chk(reaberta.qtdPendentes() === 3, 'fechar e reabrir o navegador: os pendentes são recuperados do armazenamento');

  console.log('Servidor com erro e recuperação');
  const s500 = servidor({ erro500: true });
  try { await T.enviarLote(fila, s500.rpc); } catch (e) { erro = e; }
  chk(fila.qtdPendentes() === 3 && fila.emFalha('sync'), 'erro do servidor: nada marcado como enviado e a falha de sincronização fica em aberto');

  console.log('Conexão de volta: envio em lote com confirmação');
  srv = servidor();
  const antesEnvio = Date.now();
  let r = await T.enviarLote(fila, srv.rpc);
  chk(r.confirmados === 3 && fila.qtdPendentes() === 0 && fila.qtdEnviados() === 3, 'lote enviado: os 3 confirmados pelo servidor são marcados como enviados', r);
  chk(srv.chamadas[0] === 'enviar_posicoes_lote', 'usa enviar_posicoes_lote (confirmação por ponto)');
  const dc = fila.diagnostico();
  chk(dc.ultimaConfirmacaoEm >= antesEnvio && !fila.emFalha('sync') && tipos(fila).includes('sync_fim'), 'última sincronização confirmada registrada; falha encerrada com evento "voltou"', dc);
  const apos = await T.abrir(ids);
  chk(apos.diagnostico().ultimaConfirmacaoEm === dc.ultimaConfirmacaoEm && apos.qtdEnviados() === 3 && apos.qtdPendentes() === 0, 'a última confirmação e os contadores sobrevivem a fechar e abrir');
  r = await T.enviarLote(fila, srv.rpc);
  chk(r.vazio && srv.chamadas.length === 1, 'nada pendente: não chama o servidor de novo');

  console.log('Confirmação só do que o servidor gravou');
  await fila.adicionar([ponto(4), ponto(5), ponto(6)]);
  srv.opcoes.perder = [ponto(5).id];
  srv.opcoes.recusar = [ponto(6).id];
  r = await T.enviarLote(fila, srv.rpc);
  chk(r.confirmados === 1 && r.recusados === 1 && r.semResposta === 1, 'servidor confirmou 1, recusou 1 e não respondeu sobre 1', r);
  chk(fila.pendentes().map((p) => p.id).join() === ponto(5).id, 'o ponto não confirmado continua pendente (será reenviado)');
  chk(fila.recusados().length === 1 && fila.recusados()[0].recusado === 'fora_do_periodo', 'o recusado fica guardado com o motivo e não é reenviado');
  chk(tipos(fila).includes('sync_recusado') && fila.diagnostico().recusados === 1 && fila.diagnostico().perdas >= 1, 'recusa registrada como evento e contada como perda no diagnóstico');
  srv.opcoes.perder = [];
  r = await T.enviarLote(fila, srv.rpc);
  chk(r.confirmados === 1 && fila.qtdPendentes() === 0, 'reenvio do pendente: confirmado');
  const naoConf = servidor({ semConfirmados: true });
  await fila.adicionar([ponto(10)]);
  erro = null;
  try { await T.enviarLote(fila, naoConf.rpc); } catch (e) { erro = e; }
  chk(erro && erro.codigo === 'resposta_sem_confirmacao' && fila.qtdPendentes() === 1 && fila.qtdEnviados() === 5, 'resposta do servidor sem lista de confirmados: nada é dado como enviado');
  await T.enviarLote(fila, srv.rpc);

  console.log('Reenvio não duplica (idempotência pelo id)');
  const antes = srv.gravados.size;
  const outra = await T.abrir({ participanteId: 'part-1', userId: 'user-1', operacaoId: 'op-1', armazenamento: duravel(), persistencia: false });
  await outra.adicionar([ponto(1), ponto(2), ponto(7)]);   // 1 e 2 já estão no servidor
  r = await T.enviarLote(outra, srv.rpc);
  chk(r.confirmados === 3 && srv.gravados.size === antes + 1, 'pontos já gravados são confirmados de novo sem duplicar no servidor', [r.confirmados, srv.gravados.size - antes]);
  const m5 = duravel();
  const f5 = await T.abrir({ participanteId: 'part-5', armazenamento: m5, persistencia: false });
  await f5.adicionar([ponto(20), ponto(21)]);
  const gravarEstado = f5.armaz.gravar;
  let primeira = true;
  f5.armaz.gravar = (regs) => { if (regs.some((x) => x.enviado) && primeira) { primeira = false; return Promise.reject(new Error('falhou')); } return gravarEstado(regs); };
  const s5 = servidor();
  await T.enviarLote(f5, s5.rpc);
  const f5b = await T.abrir({ participanteId: 'part-5', armazenamento: m5, persistencia: false });
  chk(f5b.qtdPendentes() === 2, 'se o aparelho falhar ao anotar "enviado", os pontos voltam como pendentes na reabertura');
  await T.enviarLote(f5b, s5.rpc);
  chk(f5b.qtdPendentes() === 0 && s5.gravados.size === 2, '…e o reenvio é confirmado sem duplicar no servidor');

  console.log('Servidor sem a migração 009 (sem confirmação por ponto)');
  const antigo = servidor({ semLote: true });
  const f2 = await T.abrir({ participanteId: 'part-2', armazenamento: duravel(), persistencia: false });
  await f2.adicionar([ponto(1), ponto(2)]);
  r = await T.enviarLote(f2, antigo.rpc);
  chk(r.antigo && r.confirmados === 0 && r.semConfirmacao === 2 && antigo.chamadas.join() === 'enviar_posicoes_lote,enviar_posicoes', 'cai para enviar_posicoes mas NÃO dá os pontos como enviados', antigo.chamadas);
  chk(f2.qtdPendentes() === 2 && f2.qtdEnviados() === 0 && f2.diagnostico().semConfirmacao === 2 && f2.diagnostico().servidorSemConfirmacao, 'os pontos ficam pendentes e o diagnóstico avisa "enviados sem confirmação"');
  chk(f2.qtdParaEnviar() === 0 && tipos(f2).includes('servidor_sem_confirmacao_inicio'), 'não reenvia sem parar; o evento fica registrado');
  r = await T.enviarLote(f2, antigo.rpc);
  chk(r.vazio && antigo.chamadas.length === 2, 'enquanto o servidor segue antigo, não repete o envio dos mesmos pontos');
  f2.semLoteDesde = Date.now() - 6 * 60 * 1000;   // passou o tempo de rever
  const novo = servidor();
  novo.gravados = antigo.gravados;
  r = await T.enviarLote(f2, novo.rpc);
  chk(r.confirmados === 2 && f2.qtdPendentes() === 0 && f2.diagnostico().semConfirmacao === 0, 'servidor atualizado: os pontos são reenviados e só então confirmados');

  console.log('Intervalos sem ponto (falha de GPS) ficam anotados');
  const fl = await T.abrir({ participanteId: 'l-1', armazenamento: duravel(), persistencia: false, lacunaMs: 60000 });
  await fl.adicionar([ponto(1, 0), ponto(2, 15000), ponto(3, 15000 + 600000), ponto(4, 15000 + 600000 + 10000)]);
  const lac = fl.eventos().filter((e) => e.tipo === 'lacuna');
  chk(lac.length === 1 && lac[0].de === t0 + 15000 && lac[0].ate === t0 + 615000 && lac[0].ms === 600000, 'dez minutos sem ponto viram um evento "lacuna" com início, fim e duração', lac);
  chk(fl.diagnostico().lacunas === 1, 'diagnóstico conta as lacunas');
  const gps = servidor();
  r = await T.enviarLote(fl, gps.rpc);
  chk(r.confirmados === 4, 'os pontos de antes e depois da lacuna seguem normalmente (a trilha é que não os liga)');

  console.log('Resumo para a interface');
  const fr = await T.abrir({ participanteId: 'r-1', armazenamento: duravel(), persistencia: false });
  const agora = t0 + 3600000;
  await fr.adicionar([ponto(1, 0), ponto(2, 15000)]);
  const dr = fr.diagnostico(agora);
  chk(dr.pendentes === 2 && dr.maisAntigaT === t0 && dr.idadeMaisAntigaMs === 3600000 && dr.ultimaConfirmacaoEm === null && dr.estadoGravacao === 'duravel', 'pendentes, idade da mais antiga, última confirmação e estado da gravação', dr);

  console.log('Fila antiga (localStorage) e limpeza');
  const mem3 = duravel();
  const f3 = await T.abrir({ participanteId: 'part-3', armazenamento: mem3, legado: [ponto(8), ponto(9)], persistencia: false });
  chk(f3.qtdPendentes() === 2, 'pontos da fila anterior entram na fila nova');
  chk((await T.abrir({ participanteId: 'part-3', armazenamento: mem3, persistencia: false })).qtdPendentes() === 2, 'e ficam gravados no armazenamento novo');
  const mem4 = duravel();
  const f4 = await T.abrir({ participanteId: 'part-4', armazenamento: mem4, persistencia: false });
  await f4.adicionar([ponto(1)]);
  await f4.marcarEnviados([ponto(1).id], Date.now() - 49 * 3600 * 1000);
  const f4b = await T.abrir({ participanteId: 'part-4', armazenamento: mem4, persistencia: false });
  chk(f4b.qtdEnviados() === 0, 'enviados e confirmados há mais de 48 h são apagados do aparelho ao abrir');
  await f3.limpar();
  const f3b = await T.abrir({ participanteId: 'part-3', armazenamento: mem3, persistencia: false });
  chk(f3.qtdPendentes() === 0 && f3b.qtdPendentes() === 0, 'fim da participação: limpar() apaga a fila deste participante');

  console.log('Volume grande: lotes controlados e tempo');
  const fv = await T.abrir({ participanteId: 'v-1', armazenamento: duravel(), persistencia: false });
  const N = 60000;
  let ini = Date.now();
  for (let i = 0; i < N; i += 2000) {
    const parte = [];
    for (let j = i + 1; j <= Math.min(N, i + 2000); j++) parte.push(ponto(j));
    await fv.adicionar(parte);
  }
  const tAdd = Date.now() - ini;
  const sv = servidor();
  let lotes = 0, maior = 0;
  const rpcContando = async (nome, args) => { lotes++; maior = Math.max(maior, args.p_pontos.length); return sv.rpc(nome, args); };
  ini = Date.now();
  while (fv.qtdParaEnviar()) { const rr = await T.enviarLote(fv, rpcContando, { lote: 200 }); if (rr.vazio) break; }
  const tEnv = Date.now() - ini;
  chk(fv.qtdPendentes() === 0 && sv.gravados.size === N && fv.qtdEnviados() === N, '60.000 pontos acumulados: todos enviados e confirmados, nenhum perdido ou duplicado', [fv.qtdPendentes(), sv.gravados.size]);
  chk(maior <= 500 && lotes <= Math.ceil(N / 500) + 6, 'lotes controlados: com muita coisa acumulada usa lotes de até 500 (limite do servidor)', { lotes, maior });
  chk(tAdd < 15000 && tEnv < 15000, 'tempo razoável para 60.000 pontos (gravar ' + tAdd + ' ms, enviar ' + tEnv + ' ms)');

  console.log('\nFila offline da trilha: ' + ok + ' OK, ' + falha + ' falha(s)');
  process.exit(falha ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
