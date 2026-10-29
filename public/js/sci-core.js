/* =====================================================================
 * sci-core.js — regras do painel de comando SCI, sem tela (usado no painel, na janela própria e no servidor)
 *   - rótulos (funções, marcos, fases, triagem, instalações, órgãos, recursos);
 *   - totais de vítimas (sem inventar: total não informado fica [PENDENTE]) e divergências;
 *   - alertas do comando e "o que falta" (segurança primeiro);
 *   - resumo para WhatsApp e texto para a imprensa, só com o que foi registrado;
 *   - leitura de frases curtas do comandante ("V-03 na ACV, amarela", "SAMU no local com 5", "despacho 7h15")
 *     em ações que a tela mostra para confirmar antes de gravar; e a normalização das ações vindas da IA.
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var PENDENTE = '[PENDENTE]';
  var MARCOS = [
    ['acionamento', 'Acionamento'], ['despacho', 'Despacho da equipe'], ['chegada', 'Chegada ao local e assunção do Comando'],
    ['pc', 'Posto de Comando instalado'], ['comunicacoes', 'Comunicações estabelecidas'], ['sci', 'SCI montado'],
    ['danos', 'Relatório primário de danos ao PC'], ['identificacao', 'Início da identificação de vítimas'],
    ['localizacao', 'Início da localização de vítimas'], ['resgate', 'Início da operação de resgate'],
    ['consolidacao', 'Consolidação dos dados ao GGI'], ['termino', 'Término e hot debriefing'],
  ];
  var FUNCOES = [
    ['ci', 'Comandante do Incidente'], ['seguranca', 'Oficial de Segurança'], ['operacoes', 'Chefe de Operações'],
    ['logistica', 'Logística'], ['planejamento', 'Planejamento'], ['ligacao', 'Oficial de Ligação'],
    ['informacao_publica', 'Informação Pública'], ['adm_financas', 'Adm./Finanças'],
  ];
  var CATEGORIAS = { decisao: 'Decisão do Comando', seguranca: 'Segurança', resgate: 'Resgate', informacao: 'Informação', recurso: 'Recurso', comunicacao: 'Comunicação' };
  var FASES = [['localizada', 'Vítimas localizadas', 'Aguardando remoção'], ['removida', 'Removidas para a ACV', 'Área de concentração de vítimas'],
    ['transportada', 'Transportadas', 'Hospital ou outro destino']];
  var TRIAGEM = { verde: 'Verde', amarelo: 'Amarelo', vermelho: 'Vermelho', cinza: 'Cinza – óbito' };
  var INSTALACOES = { pc: 'Posto de Comando', area_espera: 'Área de Espera', acv: 'Área de Concentração de Vítimas', zpa: 'ZPA – Zona de Pouso de Aeronaves',
    abrigo: 'Abrigo', ggi: 'GGI – Gabinete de Gestão Integrada', outra: 'Outra instalação' };
  var ESTADO_INSTALACAO = { ativa: 'Ativa', planejada: 'Planejada', desativada: 'Desativada' };
  var STATUS_EQUIPE = { designada: 'Designada', em_deslocamento: 'Em deslocamento', em_operacao: 'Em operação', disponivel: 'Disponível', desmobilizada: 'Desmobilizada' };
  var SITUACAO_ORGAO = { acionado: 'Acionado', a_caminho: 'A caminho', no_local: 'No local', desmobilizado: 'Desmobilizado' };
  var TIPO_RECURSO = { viatura: 'Viatura', embarcacao: 'Embarcação', aeronave: 'Aeronave', equipamento: 'Equipamento', outro: 'Outro' };
  var STATUS_RECURSO = { solicitado: 'Solicitado', a_caminho: 'A caminho', no_local: 'No local – disponível', em_uso: 'Em uso', indisponivel: 'Indisponível', desmobilizado: 'Desmobilizado' };
  var MISSAO_ATIVA = ['enviada', 'em_deslocamento', 'no_setor', 'busca_finalizada', 'retorno_atrasado'];
  var STATUS_MISSAO = { enviada: 'Enviada', em_deslocamento: 'Em deslocamento', no_setor: 'No setor', busca_finalizada: 'Busca finalizada (retornando)', retorno_atrasado: 'RETORNO ATRASADO' };
  var DISPONIBILIDADE = { disponivel: 'Disponível', em_descanso: 'Em descanso', indisponivel: 'Indisponível' };
  var ESTADO_AJUDA = { recebido: 'sem atendimento', assumido: 'assumido', equipe_enviada: 'equipe enviada', em_atendimento: 'em atendimento' };
  var TENDENCIA = { subindo: 'Subindo', estavel: 'Estável', descendo: 'Descendo', a_confirmar: 'A confirmar' };
  var LOGISTICA = [['agua', 'Água'], ['alimentacao', 'Alimentação'], ['combustivel', 'Combustível'], ['energia', 'Energia']];
  var ORGAOS_CONHECIDOS = ['CBMPR', 'Corpo de Bombeiros', 'SAMU', 'Defesa Civil', 'Polícia Militar', 'Polícia Civil', 'Polícia Rodoviária Federal', 'Guarda Municipal',
    'Prefeitura', 'Assistência Social', 'Copel', 'Sanepar', 'CMTU', 'Tiro de Guerra', 'Exército', 'Radiocomunicadores', 'Radioamadores', 'Cruz Vermelha',
    'Secretaria de Saúde', 'Secretaria de Obras', 'Secretaria de Agricultura', 'IAT', 'DER', 'Concessionária'];
  var APELIDOS_ORGAO = { pm: 'Polícia Militar', 'policia militar': 'Polícia Militar', bombeiros: 'CBMPR', 'corpo de bombeiros': 'CBMPR', prf: 'Polícia Rodoviária Federal',
    gm: 'Guarda Municipal', 'guarda': 'Guarda Municipal', 'defesa civil': 'Defesa Civil', 'assistencia social': 'Assistência Social', radioamadores: 'Radiocomunicadores' };

  function rotulo(lista, chave) { var x = lista.filter(function (i) { return i[0] === chave; })[0]; return x ? x[1] : chave; }
  function semAcento(t) { return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function vnum(n) { return 'V-' + (n < 10 ? '0' : '') + n; }
  function ms(v) { var t = typeof v === 'number' ? v : Date.parse(v); return isFinite(t) ? t : null; }
  function dois(n) { return (n < 10 ? '0' : '') + n; }
  function horaCurta(v) { var t = ms(v); if (t == null) return '—'; var d = new Date(t); return dois(d.getDate()) + '/' + dois(d.getMonth() + 1) + ' ' + dois(d.getHours()) + 'h' + dois(d.getMinutes()); }
  function duracao(msTot) {
    if (msTot == null || msTot < 0) return '—';
    var min = Math.floor(msTot / 60000);
    return min < 60 ? min + ' min' : Math.floor(min / 60) + 'h' + dois(min % 60);
  }
  function vazio(v) { return v == null || String(v).trim() === ''; }
  function ou(v) { return vazio(v) ? PENDENTE : String(v); }

  /* ---------- Coordenadas e links ---------- */
  function dmsUm(v, pos, neg) {
    var a = Math.abs(v), g = Math.floor(a), mf = (a - g) * 60, m = Math.floor(mf), s = Math.round((mf - m) * 60);
    if (s === 60) { s = 0; m++; }
    if (m === 60) { m = 0; g++; }
    return (v < 0 ? neg : pos) + ' ' + g + '°' + dois(m) + "'" + dois(s) + '"';
  }
  function dms(lat, lng) { return lat == null || lng == null ? PENDENTE : dmsUm(lat, 'N', 'S') + ' ' + dmsUm(lng, 'E', 'W'); }
  function links(lat, lng) {
    var c = lat + ',' + lng;
    return {
      maps: 'https://www.google.com/maps/search/?api=1&query=' + c,
      satelite: 'https://www.google.com/maps/@' + c + ',300m/data=!3m1!1e3',
      earth: 'https://earth.google.com/web/@' + c + ',300a,800d,35y,0h,0t,0r',
      osm: 'https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lng + '#map=17/' + lat + '/' + lng,
      rota: 'https://www.google.com/maps/dir/?api=1&destination=' + c,
    };
  }

  /* ---------- Vítimas ---------- */
  // total: o informado (pode estar NÃO CONFIRMADO); sem total informado, "ainda não localizadas" fica [PENDENTE].
  // fichas (opcional): as vítimas cadastradas no app. As que ainda não estão no quadro são as "procuradas".
  function totais(vitimas, estado, fichas) {
    vitimas = vitimas || []; estado = estado || {};
    var r = { informado: estado.total_vitimas == null ? null : estado.total_vitimas, confirmado: Boolean(estado.total_confirmado),
      localizadas: vitimas.length, removidas: 0, transportadas: 0, obitos: 0, porFase: {}, divergencia: null };
    FASES.forEach(function (f) { r.porFase[f[0]] = { n: 0, verde: 0, amarelo: 0, vermelho: 0, cinza: 0, sem: 0 }; });
    vitimas.forEach(function (v) {
      var pf = r.porFase[v.fase] || r.porFase.localizada;
      pf.n++;
      if (v.triagem && v.fase !== 'localizada') pf[v.triagem]++; else pf.sem++;
      if (v.fase === 'removida' || v.fase === 'transportada') r.removidas++;
      if (v.fase === 'transportada') r.transportadas++;
      if (v.triagem === 'cinza') r.obitos++;
    });
    var noQuadro = {};
    vitimas.forEach(function (v) { if (v.vitima_id) noQuadro[v.vitima_id] = true; });
    r.procuradas = (fichas || []).filter(function (f) { return !noQuadro[f.id]; });
    r.fichas = (fichas || []).length;
    // sem total informado, as fichas ainda procuradas dizem quantas faltam; sem fichas nem total: [PENDENTE]
    r.naoLocalizadas = r.informado != null ? Math.max(0, r.informado - r.localizadas) : r.fichas ? r.procuradas.length : null;
    if (r.informado != null && r.localizadas > r.informado) r.divergencia = 'O quadro tem ' + r.localizadas + ' vítimas, mas o total informado é ' + r.informado + '.';
    return r;
  }
  function proximoNumero(vitimas) { return (vitimas || []).reduce(function (m, v) { return Math.max(m, v.numero || 0); }, 0) + 1; }

  /* ---------- Itens ---------- */
  function porTipo(itens, tipo) { return (itens || []).filter(function (i) { return i.tipo === tipo; }); }
  function instalacao(itens, tipo) { return porTipo(itens, 'instalacao').filter(function (i) { return i.dados.tipo === tipo && i.dados.estado !== 'desativada'; })[0] || null; }
  function totaisOrgaos(itens) {
    var o = porTipo(itens, 'orgao'), r = { orgaos: o.length, noLocal: 0, pessoas: 0, viaturas: 0, semEfetivo: 0, semViaturas: 0 };
    o.forEach(function (x) {
      var d = x.dados;
      if (d.situacao === 'no_local') r.noLocal++;
      if (d.situacao === 'desmobilizado') return;
      if (d.pessoas == null) { if (d.situacao === 'no_local') r.semEfetivo++; } else r.pessoas += d.pessoas;
      if (d.viaturas == null) r.semViaturas++; else r.viaturas += d.viaturas;
    });
    return r;
  }
  function ultimaLeitura(itens) {
    return porTipo(itens, 'leitura_rio').slice().sort(function (a, b) { return (ms(b.dados.em) || 0) - (ms(a.dados.em) || 0); })[0] || null;
  }
  function nomeFuncao(estado, chave) {
    var f = estado && estado.funcoes && estado.funcoes[chave];
    if (!f) return '';
    if (f.acumula_ci) { var ci = estado.funcoes.ci && estado.funcoes.ci.nome; return (ci || PENDENTE) + ' (acumula como CI)'; }
    return f.nome || '';
  }

  /* ---------- Alertas e "o que falta" ---------- */
  // d: { estado, vitimas, eventos, itens, op }. Devolve [{ nivel: 'critico'|'alerta'|'pendencia', texto, bloco }], segurança primeiro.
  function alertas(d, agora) {
    agora = agora || Date.now();
    var e = d.estado || {}, vit = d.vitimas || [], it = d.itens || [], out = [];
    function add(nivel, texto, bloco) { out.push({ nivel: nivel, texto: texto, bloco: bloco }); }
    var cx = d.ctx || {};
    var t = totais(vit, e, cx.fichas);
    var equipesAtivas = porTipo(it, 'equipe').filter(function (x) { return x.dados.status === 'em_operacao'; })
      .concat((cx.equipes || []).filter(function (g) { return g.missao && MISSAO_ATIVA.indexOf(g.missao.status) !== -1; }));
    var marcos = e.marcos || {};
    var emCena = Boolean(marcos.chegada || marcos.acionamento || equipesAtivas.length || vit.length);
    // o que o app já cobra (pedidos de ajuda, retorno atrasado, sem comunicação…) aparece aqui também
    (cx.pedidos_ajuda || []).forEach(function (p) {
      add('critico', 'Pedido de ajuda de ' + p.participante_nome + (p.estado === 'recebido' ? ' SEM ATENDIMENTO' : ' — ' + (ESTADO_AJUDA[p.estado] || p.estado)) + ' (desde ' + horaCurta(p.recebido_em).slice(6) + ').', 'geral');
    });
    (cx.alertas || []).filter(function (a) { return a.tipo !== 'vitima_localizada'; }).forEach(function (a) { add('critico', a.titulo + (a.texto ? ': ' + a.texto : ''), 'equipes'); });
    (cx.equipes || []).filter(function (g) { return g.missao && g.missao.status === 'retorno_atrasado'; }).forEach(function (g) {
      if (!(cx.alertas || []).some(function (a) { return a.tipo === 'retorno_atrasado'; })) add('critico', 'Equipe ' + g.nome + ' com retorno atrasado.', 'equipes');
    });
    if (cx.comando && cx.comando.passagem_pendente) add('alerta', 'Passagem de comando para ' + cx.comando.passagem_pendente + ' aguardando aceite.', 'comando');
    var emCena0 = emCena || ((cx.participantes || {}).em_campo > 0);
    if (emCena0 && vazio(nomeFuncao(e, 'seguranca'))) add('critico', 'Sem Oficial de Segurança designado' + (equipesAtivas.length ? ' com ' + equipesAtivas.length + ' equipe(s) em operação' : '') + '.', 'comando');
    vit.filter(function (v) { return v.triagem === 'vermelho' && v.fase !== 'transportada'; }).forEach(function (v) {
      add('critico', vnum(v.numero) + ' VERMELHA ' + (v.fase === 'removida' ? 'na ACV aguardando transporte' : 'ainda em cena') + '.', 'vitimas');
    });
    var ul = ultimaLeitura(it);
    if (ul && ul.dados.tendencia === 'subindo') add('critico', 'Rio SUBINDO na última leitura (' + horaCurta(ul.dados.em) + (ul.dados.ponto ? ', ' + ul.dados.ponto : '') + ').', 'recursos');
    var aquatica = d.op && d.op.tipo === 'aquatica';
    if (ul) {
      var idade = agora - (ms(ul.dados.em) || agora);
      if (idade > 30 * 60000 && !marcos.termino) add('alerta', 'Última leitura de nível há ' + duracao(idade) + '.', 'recursos');
    } else if (aquatica && emCena && !marcos.termino) add('alerta', 'Nenhuma leitura do nível do rio registrada.', 'recursos');
    if (t.divergencia) add('alerta', t.divergencia + ' Confira a contagem.', 'vitimas');
    if (t.informado == null && vit.length) add('alerta', 'Total de vítimas ' + PENDENTE + ': informe quantas são (mesmo que não confirmado).', 'vitimas');
    else if (t.informado != null && !t.confirmado) add('alerta', 'Total de ' + t.informado + ' vítimas NÃO CONFIRMADO pela equipe.', 'vitimas');
    vit.filter(function (v) { return v.fase === 'removida' && !v.triagem; }).forEach(function (v) { add('alerta', vnum(v.numero) + ' na ACV sem triagem.', 'vitimas'); });
    vit.filter(function (v) { return v.fase === 'localizada' && agora - (ms(v.localizada_em) || agora) > 30 * 60000; }).forEach(function (v) {
      add('alerta', vnum(v.numero) + ' localizada há ' + duracao(agora - ms(v.localizada_em)) + ' e ainda não removida.', 'vitimas');
    });
    (cx.decisoes || []).forEach(function (x) {
      var venceu = x.prazo && ms(x.prazo) < agora;
      add(venceu ? 'alerta' : 'pendencia', 'Decisão pendente' + (venceu ? ' (prazo vencido)' : '') + ': ' + x.texto + (x.responsavel_nome ? ' — ' + x.responsavel_nome : ''), 'comando');
    });
    var vf = cx.verificacao || {};
    if (vf.indicacoes_em_analise) add('pendencia', vf.indicacoes_em_analise + ' indicação(ões) do cão em análise (confirmar por outro meio).', 'equipes');
    if (vf.focos_a_verificar) add('pendencia', vf.focos_a_verificar + ' foco(s) térmico(s) do drone a verificar.', 'equipes');
    var nc = (d.eventos || []).filter(function (x) { return x.nao_confirmada && !x.anulado_em; }).length;
    if (nc) add('pendencia', nc + ' informação(ões) no registro aguardando confirmação.', 'linha');
    // o que falta
    FUNCOES.forEach(function (f) {
      if (f[0] === 'seguranca') return;
      if (emCena && vazio(nomeFuncao(e, f[0])) && ['ci', 'operacoes', 'logistica'].indexOf(f[0]) !== -1) add('pendencia', f[1] + ': ' + PENDENTE + '.', 'comando');
    });
    porTipo(it, 'instalacao').forEach(function (x) {
      if (x.dados.estado !== 'desativada' && vazio(x.dados.responsavel)) add('pendencia', (x.dados.nome || INSTALACOES[x.dados.tipo]) + ': responsável ' + PENDENTE + '.', 'comando');
    });
    if (vit.some(function (v) { return v.triagem !== 'cinza'; }) && !instalacao(it, 'acv')) add('pendencia', 'ACV (Área de Concentração de Vítimas) não registrada.', 'comando');
    porTipo(it, 'orgao').forEach(function (x) { if (x.dados.situacao === 'no_local' && x.dados.pessoas == null) add('pendencia', x.dados.nome + ' no local sem efetivo informado.', 'equipes'); });
    equipesAtivas.forEach(function (x) {
      var nome = x.dados ? x.dados.nome : x.nome, chefe = x.dados ? x.dados.chefe : x.responsavel;
      if (vazio(chefe)) add('pendencia', 'Equipe ' + nome + ' sem responsável' + (x.dados ? '.' : ' (★ no grupo).'), 'equipes');
    });
    if (emCena) {
      ['despacho', 'chegada', 'pc', 'comunicacoes', 'sci'].forEach(function (k) { if (!marcos[k]) add('pendencia', 'Horário de "' + rotulo(MARCOS, k) + '" ' + PENDENTE + '.', 'linha'); });
    }
    if (e.danos && !e.danos_confirmado) add('pendencia', 'Relatório de danos NÃO CONFIRMADO.', 'local');
    var ordem = { critico: 0, alerta: 1, pendencia: 2 };
    return out.sort(function (a, b) { return ordem[a.nivel] - ordem[b.nivel]; });
  }

  /* ---------- Textos ---------- */
  function resumo(d, agora) {
    agora = agora || Date.now();
    var e = d.estado || {}, op = d.op || {}, vit = d.vitimas || [], cx = d.ctx || {}, t = totais(vit, e, cx.fichas), it = d.itens || [], to = totaisOrgaos(it);
    var l = [];
    l.push('*' + (op.codigo || 'Ocorrência') + '* — ' + horaCurta(agora));
    if (op.local_endereco || op.local_lat != null) l.push('Local: ' + (op.local_endereco || '') + (op.local_lat != null ? ' (' + dms(op.local_lat, op.local_lng) + ')' : ''));
    var ac = (e.marcos || {}).acionamento || op.acionado_em;
    if (ac) l.push('Acionamento ' + horaCurta(ac) + ' · decorrido ' + duracao(agora - ms(ac)) + ((e.marcos || {}).termino ? ' · TÉRMINO ' + horaCurta(e.marcos.termino) : ''));
    l.push('CI: ' + ou(nomeFuncao(e, 'ci')) + ' · Segurança: ' + ou(nomeFuncao(e, 'seguranca')));
    if (t.fichas) l.push('Procuradas (fichas): ' + (t.procuradas.length ? t.procuradas.map(function (f) { return f.nome; }).join(', ') : 'nenhuma'));
    l.push('Vítimas: ' + (t.informado == null ? PENDENTE : t.informado + (t.confirmado ? '' : ' (NÃO CONFIRMADO)')) + ' total · ' + t.localizadas + ' localizadas · ' +
      t.removidas + ' removidas · ' + t.transportadas + ' transportadas · ' + t.obitos + ' óbitos');
    var tri = { verde: 0, amarelo: 0, vermelho: 0 };
    vit.forEach(function (v) { if (v.fase !== 'localizada' && tri[v.triagem] != null) tri[v.triagem]++; });
    if (tri.verde + tri.amarelo + tri.vermelho) l.push('Triagem: ' + tri.vermelho + ' vermelhas, ' + tri.amarelo + ' amarelas, ' + tri.verde + ' verdes');
    var pa = cx.participantes;
    var eqCampo = (cx.equipes || []).filter(function (g) { return g.missao && MISSAO_ATIVA.indexOf(g.missao.status) !== -1; }).length;
    if (pa) l.push('Em campo pelo app: ' + pa.em_campo + ' de ' + pa.total + ' rastreados (' + pa.militares + ' militares, ' + pa.civis + ' civis) · ' + eqCampo + ' equipe(s) em deslocamento/busca');
    l.push('Órgãos: ' + to.orgaos + ' (' + to.noLocal + ' no local) · ' + to.pessoas + ' pessoas' + (to.semEfetivo ? ' (' + to.semEfetivo + ' sem efetivo informado)' : ''));
    if (e.situacao) l.push('Situação: ' + e.situacao);
    var al = alertas(d, agora).filter(function (a) { return a.nivel !== 'pendencia'; });
    if (al.length) l.push('Alertas: ' + al.map(function (a) { return a.texto; }).join(' | '));
    return l.join('\n');
  }

  function imprensa(d, agora) {
    agora = agora || Date.now();
    var e = d.estado || {}, op = d.op || {}, vit = d.vitimas || [], t = totais(vit, e), to = totaisOrgaos(d.itens || []);
    var orgs = porTipo(d.itens, 'orgao').filter(function (o) { return o.dados.situacao !== 'acionado'; }).map(function (o) { return o.dados.nome; });
    var tri = { verde: 0, amarelo: 0, vermelho: 0 };
    vit.forEach(function (v) { if (tri[v.triagem] != null) tri[v.triagem]++; });
    var p = [];
    var ac = (e.marcos || {}).acionamento || op.acionado_em;
    p.push('O Corpo de Bombeiros' + (ac ? ' foi acionado às ' + horaCurta(ac).slice(6).replace('h', 'h') : ' atende') + ' para ' +
      (op.ipo && op.ipo.natureza ? op.ipo.natureza.toLowerCase() : 'uma ocorrência') + (op.local_endereco ? ' em ' + op.local_endereco : '') + '.');
    if (vit.length) {
      p.push('Até o momento, ' + t.localizadas + ' pessoa(s) foram localizadas' + (t.transportadas ? ', ' + t.transportadas + ' já transportadas' : '') +
        (t.obitos ? ', com ' + t.obitos + ' óbito(s) confirmado(s)' : ', sem registro de óbitos') + '.' +
        (tri.amarelo + tri.vermelho ? ' ' + (tri.vermelho + tri.amarelo) + ' receberam atendimento pré-hospitalar e foram encaminhadas para atendimento médico.' : ''));
    }
    if (orgs.length) p.push('Atuam na ocorrência ' + orgs.length + ' órgão(s): ' + orgs.join(', ') + (to.pessoas ? ', com cerca de ' + to.pessoas + ' pessoas' : '') + '.');
    if (e.situacao) p.push(e.situacao);
    p.push('O comando da operação é do ' + ou(nomeFuncao(e, 'ci')) + '. Novas informações serão divulgadas pelo Corpo de Bombeiros.');
    return p.join('\n\n');
  }

  /* ---------- Frases curtas → ações ---------- */
  // Hora no texto ("7h15", "07:15", "às 8h"): o mesmo dia de "agora" (ou a véspera, se ficaria no futuro).
  function horaDoTexto(texto, agora) {
    var m = /(?:^|[^\d])([01]?\d|2[0-3])\s*(?:h|:)\s*([0-5]\d)?(?![\d])/i.exec(texto);
    if (!m) return null;
    var d = new Date(agora || Date.now());
    d.setHours(Number(m[1]), m[2] ? Number(m[2]) : 0, 0, 0);
    if (d.getTime() > (agora || Date.now()) + 5 * 60000) d.setDate(d.getDate() - 1);
    return d.toISOString();
  }
  var NUMEROS = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15, vinte: 20 };
  function numero(t) { return /^\d+$/.test(t) ? Number(t) : NUMEROS[semAcento(t)] || null; }

  var PAL_MARCOS = [
    ['despacho', /\bdespach/], ['acionamento', /\bacionament|\bfomos acionad|\bequipes? acionad/], ['chegada', /\bchegada ao local|\bchegamos|\bequipe no local|\bassun(c|ç)ao do comando|\bassumi(u|mos) o comando/],
    ['pc', /\b(pc|posto de comando) (estabelecid|instalad|montad|ativad)/], ['comunicacoes', /\bcomunicac(o|õ)es (estabelecid|ativ)/], ['sci', /\bsci (montad|implantad|estabelecid)/],
    ['identificacao', /\binicio da identificac/], ['localizacao', /\binicio da localizac/], ['resgate', /\binicio d[oa] (operacao de )?resgate|\bresgate iniciad/],
    ['consolidacao', /\bconsolidac/], ['termino', /\btermino\b|\boperacao (finalizada|encerrada)|\bhot debriefing/],
  ];
  var PAL_FUNCOES = [['seguranca', /seguranca/], ['operacoes', /operacoes/], ['logistica', /logistica/], ['planejamento', /planejamento/], ['ligacao', /ligacao/],
    ['informacao_publica', /informacao publica|imprensa/], ['adm_financas', /financas|administracao/], ['ci', /comandante do incidente|\bci\b/]];

  function categoriaDoTexto(s) {
    if (/seguranc|risco|colete|correnteza|evacu|interdit|desabament/.test(s)) return 'seguranca';
    if (/resgat|vitima|embarcac|maca|tirolesa|bote|retirad|triad|acv\b/.test(s)) return 'resgate';
    if (/chegou|chegaram|viatura|ambulanc|aeronave|helicoptero|recurso|solicitad/.test(s)) return 'recurso';
    if (/radio|comunicac|zello|starlink|vhf|uhf/.test(s)) return 'comunicacao';
    if (/informa|relatorio|segundo|confirma/.test(s)) return 'informacao';
    return 'decisao';
  }
  function orgaoNoTexto(s, d) {
    var nomes = porTipo(d && d.itens, 'orgao').map(function (o) { return o.dados.nome; }).concat(ORGAOS_CONHECIDOS);
    for (var i = 0; i < nomes.length; i++) { var n = semAcento(nomes[i]); if (new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(s)) return nomes[i]; }
    for (var k in APELIDOS_ORGAO) if (new RegExp('\\b' + k + '\\b').test(s)) return APELIDOS_ORGAO[k];
    return null;
  }

  // Devolve { acoes: [...], entendeu: boolean }. Cada ação traz "texto" (para a tela) e os campos do registro.
  function interpretar(frase, d, agora) {
    d = d || {}; agora = agora || Date.now();
    var orig = String(frase || '').replace(/\s+/g, ' ').trim();
    var s = semAcento(orig), em = horaDoTexto(s, agora), acoes = [], m;
    if (!orig) return { acoes: [], entendeu: false };
    var naoConf = /nao confirmad|a confirmar|segundo (a|o)|informou que|sem confirmac/.test(s);
    // marcos
    PAL_MARCOS.forEach(function (p) { if (p[1].test(s)) acoes.push({ acao: 'marco', marco: p[0], em: em }); });
    // vítimas já numeradas: "V-03 na ACV amarela", "V-01 transportada ao hospital"
    var re = /\bv\s*-?\s*0*(\d{1,3})\b/g, nums = [];
    while ((m = re.exec(s))) if (nums.indexOf(Number(m[1])) === -1) nums.push(Number(m[1]));
    var tri = /\bverde/.test(s) ? 'verde' : /\bamarel/.test(s) ? 'amarelo' : /\bvermelh/.test(s) ? 'vermelho' : /\bcinza|\bobito|\bmort/.test(s) ? 'cinza' : null;
    var sexo = /\bfeminin|\bmulher/.test(s) ? 'F' : /\bmasculin|\bhomem/.test(s) ? 'M' : null;
    var idadeM = /(\d{1,3}) anos/.exec(s);
    var fase = /\b(transportad|hospital|abrigo|saiu para|levad)/.test(s) ? 'transportada' : /\bacv\b|\bremovid|\bretirad/.test(s) ? 'removida' : null;
    var destM = /\b(?:para o|para a|ao|a)\s+(hospital[^,.;]*?|abrigo[^,.;]*?|upa[^,.;]*?)(?=\s+pel[oa]s?\b|[,.;]|$)/.exec(s);
    // trecho do texto original (com acentos e maiúsculas) na mesma posição do texto sem acento
    function original(trecho) { var i = s.indexOf(trecho); return i >= 0 ? orig.slice(i, i + trecho.length) : trecho; }
    nums.forEach(function (n) {
      var existe = (d.vitimas || []).some(function (v) { return v.numero === n; });
      var a = { acao: existe ? 'vitima' : 'vitima_nova', numero: n, em: em };
      if (fase) a.fase = fase;
      if (tri) a.triagem = tri;
      if (sexo) a.sexo = sexo;
      if (idadeM) a.idade = Number(idadeM[1]);
      if (destM && fase === 'transportada') a.destino = original(destM[1].trim()).replace(/^./, function (c) { return c.toUpperCase(); });
      if (!existe && /\blocalizad/.test(s) && !fase) a.fase = 'localizada';
      acoes.push(a);
    });
    // "duas vítimas localizadas na água"
    if (!nums.length && (m = /\b(\d+|uma?|duas?|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze) vitimas? (localizad|encontrad|avistad)/.exec(s))) {
      var q = numero(m[1]) || 1, local = original((/\b(na agua|na margem[^,.;]*|na ilha[^,.;]*|ilhad[ao]s?)/.exec(s) || [])[1] || '');
      for (var i = 0; i < Math.min(q, 50); i++) acoes.push({ acao: 'vitima_nova', em: em, local: local, sexo: q === 1 ? sexo : null });
    }
    // total de vítimas
    if ((m = /\btotal(?: de vitimas)?\s*(?:e|de|:|=)?\s*(\d{1,4})\b/.exec(s)) || (m = /\b(\d{1,4}) vitimas no total\b/.exec(s))) {
      acoes.push({ acao: 'total', total: Number(m[1]), confirmado: /\bconfirm/.test(s) && !naoConf });
    }
    // função: "segurança: Sgt Dinardi", "Sgt Gustavo assume operações"
    PAL_FUNCOES.forEach(function (f) {
      var r1 = new RegExp('(?:^|\\b)' + f[1].source + '\\s*(?::|=|-|e o|e a|fica com|com o|com a)\\s*([^,.;]+)'), r2 = new RegExp('([a-z0-9 .]+?)\\s+(?:assume|assumiu|na|no|responsavel pela|responsavel pelo)\\s+' + f[1].source);
      var mm = r1.exec(s) || r2.exec(s);
      if (mm && !/^(pendente|vazio)$/.test(mm[1].trim())) {
        var nomeAlvo = mm[1].trim(), i0 = semAcento(orig).indexOf(nomeAlvo);
        acoes.push({ acao: 'funcao', funcao: f[0], nome: i0 >= 0 ? orig.slice(i0, i0 + nomeAlvo.length) : nomeAlvo });
      }
    });
    // órgão: "SAMU no local com 5 pessoas", "Copel acionada", "PM a caminho"
    var org = orgaoNoTexto(s, d);
    if (org) {
      var sit = /\bno local\b|\bchegou|\bchegaram/.test(s) ? 'no_local' : /\ba caminho|\bdeslocando/.test(s) ? 'a_caminho' : /\bacionad|\bsolicitad/.test(s) ? 'acionado' : /\bdesmobiliz|\bliberad/.test(s) ? 'desmobilizado' : null;
      var pes = /\b(\d{1,4})\s*(?:pessoas|integrantes|militares|homens|agentes)\b/.exec(s) || /\bcom\s+(\d{1,4})\b/.exec(s);
      var vtr = /\b(\d{1,3})\s*(?:viaturas?|vtrs?)\b/.exec(s);
      if (!naoConf && (sit || (pes && /\befetivo\b/.test(s)))) {
        var ao = { acao: 'orgao', nome: org, em: em };
        if (sit) ao.situacao = sit;
        if (pes) ao.pessoas = Number(pes[1]);
        if (vtr) ao.viaturas = Number(vtr[1]);
        acoes.push(ao);
      }
    }
    // nível do rio
    if (/\brio\b|\bnivel\b|\bvazao\b|\bvertedouro/.test(s) && /\bsubindo|\bestavel|\bbaixando|\bdescendo|\bnivel/.test(s)) {
      acoes.push({ acao: 'leitura_rio', em: em, tendencia: /\bsubindo/.test(s) ? 'subindo' : /\bestavel/.test(s) ? 'estavel' : /\bbaixando|\bdescendo/.test(s) ? 'descendo' : 'a_confirmar',
        nivel: (/\b(muito alto|alto|baixo|normal|medio)\b/.exec(s) || [])[1] || '', fonte: /\bdrone/.test(s) ? 'Drone' : '' });
    }
    var entendeu = acoes.length > 0;
    // a frase em si vai para a linha do tempo quando não virou registro específico (de terceiros: NÃO CONFIRMADA)
    if (!entendeu) acoes.push({ acao: 'evento', categoria: categoriaDoTexto(s), texto: orig, nao_confirmada: naoConf, em: em });
    return { acoes: normalizarAcoes(acoes, d), entendeu: entendeu };
  }

  /* ---------- Normalização (tela e IA) ---------- */
  function txt(v, n) { return vazio(v) ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, n); }
  function inteiro(v, min, max) { var n = typeof v === 'string' ? Number(v) : v; return typeof n === 'number' && isFinite(n) && n === Math.floor(n) && n >= min && n <= max ? n : null; }
  function quando(v) { var t = ms(v); return t == null ? null : new Date(t).toISOString(); }
  function chaveDe(lista, v) { return lista.some(function (x) { return x[0] === v; }) ? v : null; }
  // Aceita só ações conhecidas, com campos válidos. Devolve a lista limpa (cada uma com "texto" para mostrar).
  function normalizarAcoes(lista, d) {
    var saida = [];
    (Array.isArray(lista) ? lista : []).slice(0, 60).forEach(function (a) {
      if (!a || typeof a !== 'object') return;
      var em = quando(a.em), r = null;
      if (a.acao === 'marco' && chaveDe(MARCOS, a.marco)) r = { acao: 'marco', marco: a.marco, em: em };
      else if (a.acao === 'vitima' || a.acao === 'vitima_nova') {
        r = { acao: a.acao, em: em };
        var n = inteiro(a.numero, 1, 9999);
        if (n != null) r.numero = n;
        if (a.acao === 'vitima' && n == null) return;
        if (chaveDe(FASES, a.fase)) r.fase = a.fase;
        if (TRIAGEM[a.triagem]) r.triagem = a.triagem;
        if (a.sexo === 'M' || a.sexo === 'F') r.sexo = a.sexo;
        var id = inteiro(a.idade, 0, 130); if (id != null) r.idade = id;
        ['nome', 'local', 'destino', 'observacoes'].forEach(function (k) { var t = txt(a[k], k === 'observacoes' ? 500 : 120); if (t) r[k] = t; });
      } else if (a.acao === 'total') {
        var tt = inteiro(a.total, 0, 100000); if (tt == null) return;
        r = { acao: 'total', total: tt, confirmado: a.confirmado === true };
      } else if (a.acao === 'funcao' && chaveDe(FUNCOES, a.funcao)) {
        r = { acao: 'funcao', funcao: a.funcao, nome: txt(a.nome, 80), acumula_ci: a.acumula_ci === true };
        if (!r.nome && !r.acumula_ci) return;
      } else if (a.acao === 'orgao' && txt(a.nome, 80)) {
        r = { acao: 'orgao', nome: txt(a.nome, 80), em: em };
        if (SITUACAO_ORGAO[a.situacao]) r.situacao = a.situacao;
        var pe = inteiro(a.pessoas, 0, 100000); if (pe != null) r.pessoas = pe;
        var vi = inteiro(a.viaturas, 0, 10000); if (vi != null) r.viaturas = vi;
        var mi = txt(a.missao, 300); if (mi) r.missao = mi;
        if (!r.situacao && r.pessoas == null && r.viaturas == null && !r.missao) return;
      } else if (a.acao === 'equipe' && txt(a.nome, 80)) {
        r = { acao: 'equipe', nome: txt(a.nome, 80) };
        if (STATUS_EQUIPE[a.status]) r.status = a.status;
        ['missao', 'chefe', 'orgao', 'meios'].forEach(function (k) { var t = txt(a[k], 300); if (t) r[k] = t; });
        var ef = inteiro(a.efetivo, 0, 10000); if (ef != null) r.efetivo = ef;
      } else if (a.acao === 'recurso' && txt(a.nome, 80)) {
        r = { acao: 'recurso', nome: txt(a.nome, 80), em: em };
        if (TIPO_RECURSO[a.tipo]) r.tipo = a.tipo;
        if (STATUS_RECURSO[a.status]) r.status = a.status;
        ['orgao', 'local', 'nota'].forEach(function (k) { var t = txt(a[k], 200); if (t) r[k] = t; });
        var qt = inteiro(a.qtd, 0, 10000); if (qt != null) r.qtd = qt;
      } else if (a.acao === 'instalacao' && INSTALACOES[a.tipo]) {
        r = { acao: 'instalacao', tipo: a.tipo };
        if (ESTADO_INSTALACAO[a.estado]) r.estado = a.estado;
        ['nome', 'responsavel', 'local', 'motivo'].forEach(function (k) { var t = txt(a[k], 200); if (t) r[k] = t; });
      } else if (a.acao === 'leitura_rio') {
        r = { acao: 'leitura_rio', em: em, tendencia: TENDENCIA[a.tendencia] ? a.tendencia : 'a_confirmar' };
        ['nivel', 'ponto', 'vazao', 'fonte'].forEach(function (k) { var t = txt(a[k], 120); if (t) r[k] = t; });
      } else if (a.acao === 'situacao' && txt(a.texto, 2000)) r = { acao: 'situacao', texto: txt(a.texto, 2000) };
      else if (a.acao === 'evento' && txt(a.texto, 1000)) r = { acao: 'evento', categoria: CATEGORIAS[a.categoria] ? a.categoria : 'informacao', texto: txt(a.texto, 1000), nao_confirmada: a.nao_confirmada === true, em: em };
      if (!r) return;
      r.texto_tela = descrever(r, d);
      saida.push(r);
    });
    return saida;
  }

  function descrever(a, d) {
    var h = a.em ? ' às ' + horaCurta(a.em).slice(6) : '';
    switch (a.acao) {
      case 'marco': return 'Marco: ' + rotulo(MARCOS, a.marco) + (h || ' (agora)');
      case 'vitima_nova': return 'Nova vítima' + (a.numero ? ' ' + vnum(a.numero) : '') + [a.sexo ? (a.sexo === 'F' ? 'feminino' : 'masculino') : '', a.idade != null ? a.idade + ' anos' : '', a.local || '',
        a.fase && a.fase !== 'localizada' ? '→ ' + rotulo(FASES, a.fase) : '', a.triagem ? 'triagem ' + TRIAGEM[a.triagem] : ''].filter(Boolean).map(function (x) { return ' · ' + x; }).join('') + h;
      case 'vitima': return vnum(a.numero) + ': ' + [a.fase ? rotulo(FASES, a.fase) : '', a.triagem ? 'triagem ' + TRIAGEM[a.triagem] : '', a.sexo ? (a.sexo === 'F' ? 'feminino' : 'masculino') : '',
        a.idade != null ? a.idade + ' anos' : '', a.destino ? 'destino ' + a.destino : '', a.nome || ''].filter(Boolean).join(' · ') + h;
      case 'total': return 'Total de vítimas: ' + a.total + (a.confirmado ? ' (confirmado)' : ' (NÃO CONFIRMADO)');
      case 'funcao': return rotulo(FUNCOES, a.funcao) + ': ' + (a.acumula_ci ? 'acumulada pelo CI' : a.nome);
      case 'orgao': return a.nome + ': ' + [a.situacao ? SITUACAO_ORGAO[a.situacao] : '', a.pessoas != null ? a.pessoas + ' pessoas' : '', a.viaturas != null ? a.viaturas + ' viaturas' : '', a.missao || ''].filter(Boolean).join(' · ') + h;
      case 'equipe': return 'Equipe ' + a.nome + ': ' + [a.status ? STATUS_EQUIPE[a.status] : '', a.efetivo != null ? a.efetivo + ' pessoas' : '', a.missao || '', a.chefe ? 'resp. ' + a.chefe : ''].filter(Boolean).join(' · ');
      case 'recurso': return 'Recurso ' + a.nome + ': ' + [a.status ? STATUS_RECURSO[a.status] : '', a.orgao || '', a.local || ''].filter(Boolean).join(' · ') + h;
      case 'instalacao': return INSTALACOES[a.tipo] + ': ' + [a.estado ? ESTADO_INSTALACAO[a.estado] : '', a.responsavel ? 'resp. ' + a.responsavel : '', a.local || '', a.motivo || ''].filter(Boolean).join(' · ');
      case 'leitura_rio': return 'Nível do rio: ' + [a.nivel || '', TENDENCIA[a.tendencia], a.ponto || '', a.fonte ? 'fonte ' + a.fonte : ''].filter(Boolean).join(' · ') + h;
      case 'situacao': return 'Situação atual: ' + a.texto;
      case 'evento': return 'Linha do tempo (' + CATEGORIAS[a.categoria] + (a.nao_confirmada ? ', NÃO CONFIRMADA' : '') + '): ' + a.texto + h;
    }
    return '';
  }

  // Avisos antes de gravar: o que contradiz o que já está no painel (o comandante decide).
  function divergencias(acoes, d) {
    d = d || {}; var out = [], vit = d.vitimas || [], e = d.estado || {};
    var novas = acoes.filter(function (a) { return a.acao === 'vitima_nova'; }).length;
    acoes.forEach(function (a) {
      if (a.acao === 'vitima' && !vit.some(function (v) { return v.numero === a.numero; })) out.push(vnum(a.numero) + ' não está no quadro: será criada.');
      if (a.acao === 'vitima_nova' && a.numero && vit.some(function (v) { return v.numero === a.numero; })) out.push(vnum(a.numero) + ' já existe no quadro.');
      if (a.acao === 'marco' && e.marcos && e.marcos[a.marco]) out.push('"' + rotulo(MARCOS, a.marco) + '" já tinha horário (' + horaCurta(e.marcos[a.marco]) + '): será corrigido.');
      if (a.acao === 'total' && a.total < vit.length + novas) out.push('Total ' + a.total + ' é menor que as ' + (vit.length + novas) + ' vítimas do quadro.');
      if (a.acao === 'vitima' && a.triagem) {
        var v = vit.filter(function (x) { return x.numero === a.numero; })[0];
        if (v && v.fase === 'localizada' && !a.fase) out.push(vnum(a.numero) + ' ainda não foi removida para a ACV: a cor só aparece depois da triagem na ACV.');
        if (v && v.triagem && v.triagem !== a.triagem) out.push(vnum(a.numero) + ' era ' + TRIAGEM[v.triagem] + ': passa a ' + TRIAGEM[a.triagem] + '.');
      }
      if (a.acao === 'funcao' && a.nome) {
        var atual = nomeFuncao(e, a.funcao);
        if (atual && semAcento(atual) !== semAcento(a.nome)) out.push(rotulo(FUNCOES, a.funcao) + ' era ' + atual + ': passa a ' + a.nome + '.');
      }
    });
    if (e.total_vitimas != null && vit.length + novas > e.total_vitimas && !acoes.some(function (a) { return a.acao === 'total'; })) {
      out.push('Com estas vítimas o quadro passa a ' + (vit.length + novas) + ', acima do total informado (' + e.total_vitimas + ').');
    }
    return out;
  }

  var API = {
    PENDENTE: PENDENTE, MARCOS: MARCOS, FUNCOES: FUNCOES, CATEGORIAS: CATEGORIAS, FASES: FASES, TRIAGEM: TRIAGEM, INSTALACOES: INSTALACOES,
    ESTADO_INSTALACAO: ESTADO_INSTALACAO, MISSAO_ATIVA: MISSAO_ATIVA, STATUS_MISSAO: STATUS_MISSAO, DISPONIBILIDADE: DISPONIBILIDADE, STATUS_EQUIPE: STATUS_EQUIPE, SITUACAO_ORGAO: SITUACAO_ORGAO, TIPO_RECURSO: TIPO_RECURSO,
    STATUS_RECURSO: STATUS_RECURSO, TENDENCIA: TENDENCIA, LOGISTICA: LOGISTICA, ORGAOS_CONHECIDOS: ORGAOS_CONHECIDOS,
    rotulo: rotulo, vnum: vnum, dms: dms, links: links, horaCurta: horaCurta, duracao: duracao, ou: ou, vazio: vazio,
    totais: totais, proximoNumero: proximoNumero, porTipo: porTipo, instalacao: instalacao, totaisOrgaos: totaisOrgaos, ultimaLeitura: ultimaLeitura,
    nomeFuncao: nomeFuncao, alertas: alertas, resumo: resumo, imprensa: imprensa,
    horaDoTexto: horaDoTexto, interpretar: interpretar, normalizarAcoes: normalizarAcoes, descrever: descrever, divergencias: divergencias,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  raiz.SciCore = API;
})(typeof window !== 'undefined' ? window : globalThis);
