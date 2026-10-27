/* =====================================================================
 * fila-estado.js — o que a fila offline (trilha-local.js) mostra ao usuário
 *   Quantos pontos estão pendentes e há quanto tempo, se estão gravados no aparelho, quando o servidor
 *   confirmou pela última vez, o que foi recusado ou perdido e os intervalos sem registro.
 *   Usado pela página do participante e pela "Minha posição" do responsável.
 *   formatar(diagnostico, agora, extra) é puro (testado em testes/fila_estado.test.js); montar() desenha.
 * ===================================================================== */
(function (global) {
  'use strict';

  function dd(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(ms) { var d = new Date(ms); return dd(d.getHours()) + ':' + dd(d.getMinutes()); }
  function duracao(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s + ' s';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    return h + ' h' + (m % 60 ? ' ' + dd(m % 60) + ' min' : '');
  }
  function mb(b) { return (b / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' MB'; }

  var MOTIVOS = {
    fora_do_periodo: 'horário fora da operação', invalido: 'dados inválidos', lote_invalido: 'lote inválido',
    sem_espaco: 'sem espaço no aparelho', falha_gravacao: 'falha ao gravar',
    negado: 'localização bloqueada', indisponivel: 'localização desligada', sem_sinal: 'sem sinal de GPS',
    rede: 'sem internet', funcao_ausente: 'servidor desatualizado', resposta_sem_confirmacao: 'servidor não confirmou',
  };
  function motivo(m) { return MOTIVOS[m] || m || 'motivo não informado'; }

  // Uma frase para cada evento registrado (para a lista de ocorrências).
  function textoEvento(e) {
    var q = e.qtd;
    switch (e.tipo) {
      case 'gps_inicio': return 'GPS parou de registrar (' + motivo(e.motivo) + ')';
      case 'gps_fim': return 'GPS voltou a registrar' + (e.duracao_ms ? ' depois de ' + duracao(e.duracao_ms) : '');
      case 'armazenamento_inicio': return 'Não foi possível gravar no aparelho (' + motivo(e.motivo) + '): pontos só na memória';
      case 'armazenamento_fim': return 'Gravação no aparelho voltou' + (e.duracao_ms ? ' depois de ' + duracao(e.duracao_ms) : '');
      case 'armazenamento_recuperado': return q + ' ponto(s) que estavam só na memória foram gravados no aparelho';
      case 'armazenamento_principal_inicio': return 'Armazenamento principal indisponível (' + motivo(e.motivo) + '): usando o reserva';
      case 'armazenamento_principal_fim': return 'Armazenamento principal voltou';
      case 'armazenamento_reconciliado': return q + ' ponto(s) do armazenamento reserva voltaram para o principal';
      case 'armazenamento_indisponivel': return 'Este aparelho não tem armazenamento seguro (' + motivo(e.motivo) + '): usando ' + (e.usando || 'memória');
      case 'armazenamento_nao_persistente': return 'O navegador pode apagar os dados guardados se faltar espaço no aparelho';
      case 'armazenamento_quase_cheio': return 'Armazenamento do navegador quase cheio (' + mb(e.uso) + ' de ' + mb(e.quota) + ')';
      case 'sync_inicio': return 'Falha ao enviar para os bombeiros (' + motivo(e.codigo) + ')';
      case 'sync_fim': return 'Envio voltou' + (e.duracao_ms ? ' depois de ' + duracao(e.duracao_ms) : '');
      case 'sync_recusado': return q + ' ponto(s) recusados pelo servidor (' + Object.keys(e.motivos || {}).map(motivo).join(', ') + '): não entram na trilha';
      case 'sync_nao_confirmado': return q + ' ponto(s) enviados sem confirmação do servidor: continuam pendentes';
      case 'servidor_sem_confirmacao_inicio': return 'Servidor desatualizado: não confirma ponto a ponto. ' + (e.qtd || '') + ' ponto(s) entregues, mas sem confirmação';
      case 'servidor_sem_confirmacao_fim': return 'Servidor voltou a confirmar ponto a ponto';
      case 'lacuna': return 'Sem pontos por ' + duracao(e.ms) + ' (' + hhmm(e.de) + ' a ' + hhmm(e.ate) + '): a trilha fica interrompida nesse trecho';
      default: return e.tipo;
    }
  }

  /*
   * d: Fila.diagnostico(). extra: { pendentes, naoDuraveis } pontos que ainda não entraram na fila (buffer da abertura).
   * Devolve { nivel: 'ok' | 'atencao' | 'erro', titulo, alerta (texto sempre visível ou null), linhas: [[rotulo, valor, nivel]], eventos: [texto] }.
   */
  function formatar(d, agora, extra) {
    agora = agora || Date.now();
    extra = extra || {};
    var pend = d.pendentes + (extra.pendentes || 0);
    var naoDur = d.naoDuraveis + (extra.naoDuraveis || 0);
    var nivel = 'ok', alertas = [], linhas = [];
    function sobe(n) { if (n === 'erro' || (n === 'atencao' && nivel === 'ok')) nivel = n; }

    // gravação no aparelho
    var grav;
    if (d.estadoGravacao === 'memoria') { grav = ['Sem armazenamento seguro: os pontos só existem na memória desta página', 'erro']; }
    else if (naoDur > 0) { grav = [naoDur + ' ponto(s) ainda NÃO gravados no aparelho (' + (d.falhaGravacao ? motivo(/quota|space|espa/i.test(d.falhaGravacao) ? 'sem_espaco' : 'falha_gravacao') : 'abrindo o armazenamento') + ')', 'erro']; }
    else if (d.estadoGravacao === 'alternativo') { grav = ['Gravados no armazenamento reserva do aparelho', 'atencao']; }
    else { grav = ['Gravados com segurança no aparelho', 'ok']; }
    if (grav[1] === 'erro') alertas.push(d.estadoGravacao === 'memoria' || naoDur > 0 ? 'Não feche nem recarregue esta página: ' + (naoDur || pend) + ' ponto(s) só existem na memória e seriam perdidos.' : '');
    sobe(grav[1]);

    // pendentes
    var pendTxt = pend + ' ponto(s)';
    var idade = d.idadeMaisAntigaMs;
    if (pend && idade != null) pendTxt += ' · o mais antigo é de há ' + duracao(idade);
    var nPend = pend && idade != null && idade > 10 * 60000 ? 'atencao' : 'ok';
    sobe(nPend);

    // sincronização
    var sinc = d.ultimaConfirmacaoEm ? hhmm(d.ultimaConfirmacaoEm) + ' (há ' + duracao(Math.max(0, agora - d.ultimaConfirmacaoEm)) + ')' : 'ainda nenhuma neste aparelho';
    var nSinc = 'ok';
    if (d.falhas.indexOf('sync') !== -1) { nSinc = 'atencao'; sinc += ' · falhando agora'; }
    if (d.servidorSemConfirmacao) { nSinc = 'atencao'; alertas.push('O servidor não confirma ponto a ponto (versão antiga). Os pontos foram entregues, mas continuam guardados aqui até haver confirmação.'); }
    sobe(nSinc);

    linhas.push(['Gravação no aparelho', grav[0], grav[1]]);
    linhas.push(['Pontos pendentes', pendTxt, nPend]);
    linhas.push(['Última sincronização confirmada', sinc, nSinc]);
    if (d.semConfirmacao) linhas.push(['Entregues sem confirmação', d.semConfirmacao + ' ponto(s)', 'atencao']);
    if (d.semConfirmacaoRepetida) { linhas.push(['Sem confirmação após várias tentativas', d.semConfirmacaoRepetida + ' ponto(s)', 'atencao']); sobe('atencao'); }
    if (d.recusados) {
      linhas.push(['Recusados pelo servidor', d.recusados + ' ponto(s): não entram na trilha', 'atencao']);
      alertas.push(d.recusados + ' ponto(s) foram recusados pelo servidor e não aparecem na trilha dos bombeiros.');
      sobe('atencao');
    }
    if (d.lacunas) { linhas.push(['Intervalos sem registro', d.lacunas + ' (a trilha fica interrompida, sem ligar os lados)', 'atencao']); sobe('atencao'); }
    if (d.falhas.indexOf('gps') !== -1) { linhas.push(['GPS', 'sem registrar agora', 'atencao']); sobe('atencao'); }
    var arm = d.tipo === 'indexeddb' ? 'IndexedDB' : d.tipo === 'localstorage' ? 'localStorage' : 'memória';
    if (d.persistente === false) { arm += ' · o navegador pode apagar se faltar espaço'; sobe('atencao'); }
    else if (d.persistente === true) arm += ' · protegido contra limpeza automática';
    if (d.quota && d.uso != null) {
      arm += ' · ' + mb(d.uso) + ' de ' + mb(d.quota);
      if (d.uso / d.quota > 0.8) { arm += ' (quase cheio)'; sobe('atencao'); }
    }
    linhas.push(['Armazenamento', arm, d.persistente === false ? 'atencao' : 'ok']);

    alertas = alertas.filter(Boolean);
    var titulo = nivel === 'erro'
      ? 'Atenção: pontos sem gravação segura no aparelho'
      : nivel === 'atencao' ? 'Pontos guardados, mas há avisos' + (pend ? ' · ' + pend + ' pendente(s)' : '')
        : pend ? pend + ' ponto(s) aguardando envio, gravados no aparelho' : 'Pontos gravados e sincronizados';
    return {
      nivel: nivel, titulo: titulo, alerta: alertas.length ? alertas.join(' ') : null, linhas: linhas,
      eventos: (d.eventosRecentes || []).slice().reverse().map(function (e) { return hhmm(e.t) + ' — ' + textoEvento(e); }),
    };
  }

  /*
   * Desenha um bloco "Detalhes do envio" dentro de `container`. opcoes: { fila: () => Fila|null, extra: () => {pendentes, naoDuraveis}, ativo: () => bool }.
   * Devolve { atualizar }. Atualiza sozinho a cada 3 s enquanto o bloco está visível.
   */
  function montar(container, opcoes) {
    var el = global.UI && global.UI.el;
    if (!container || !el) return { atualizar: function () {} };
    container.innerHTML = '';
    var alerta = el('p', { classe: 'fila-alerta', role: 'alert', hidden: true });
    var resumo = el('span', { classe: 'fila-resumo' });
    var lista = el('dl', { classe: 'fila-linhas' });
    var eventos = el('ul', { classe: 'fila-eventos' });
    var det = el('details', { classe: 'fila-detalhes' }, [
      el('summary', null, [el('i', { classe: 'fila-ponto', 'aria-hidden': 'true' }), resumo]),
      lista,
      el('p', { classe: 'fila-sub', texto: 'Ocorrências neste aparelho (as mais recentes primeiro):' }),
      eventos,
    ]);
    container.appendChild(alerta);
    container.appendChild(det);
    function atualizar() {
      var fila = opcoes.fila();
      var ativo = !opcoes.ativo || opcoes.ativo();
      container.hidden = !fila || !ativo;
      if (!fila || !ativo) return;
      var r = formatar(fila.diagnostico(), Date.now(), opcoes.extra ? opcoes.extra() : null);
      container.setAttribute('data-nivel', r.nivel);
      resumo.textContent = r.titulo;
      alerta.hidden = !r.alerta;
      alerta.textContent = r.alerta || '';
      lista.innerHTML = '';
      r.linhas.forEach(function (l) {
        lista.appendChild(el('dt', { texto: l[0] }));
        lista.appendChild(el('dd', { classe: 'fila-' + l[2], texto: l[1] }));
      });
      eventos.innerHTML = '';
      if (!r.eventos.length) eventos.appendChild(el('li', { classe: 'muted', texto: 'Nenhuma falha registrada.' }));
      r.eventos.forEach(function (t) { eventos.appendChild(el('li', { texto: t })); });
    }
    var timer = setInterval(function () { if (!container.hidden) atualizar(); }, 3000);
    atualizar();
    return { atualizar: atualizar, parar: function () { clearInterval(timer); } };
  }

  global.FilaEstado = { formatar: formatar, montar: montar, textoEvento: textoEvento, duracao: duracao };
  if (typeof module === 'object' && module.exports) module.exports = global.FilaEstado;
})(typeof window !== 'undefined' ? window : globalThis);
