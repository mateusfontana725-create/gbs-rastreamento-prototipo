/* =====================================================================
 * sci-dados.js — regras do Modo SCI (Posto de Comando, migração 057), sem tela.
 *   - catálogo do organograma (o mesmo de sci2_funcao no banco) e quem responde por cada seção;
 *   - menu do Modo SCI (as seções e páginas do layout de referência);
 *   - números da operação, balanço de pessoas, equipes por status, progresso dos setores;
 *   - quadro de vítimas (plotada → em remoção → ACV → entregue) e as encontradas ainda fora do quadro;
 *   - alertas em ordem de prioridade (segurança da equipe › vítimas › comando) e pendências do SCI;
 *   - texto do SCI 201 (Resumo do Incidente) montado do que está registrado ([PENDENTE] no que falta).
 *   Tudo recebe os dados prontos (do painel e das tabelas sci2_*) e devolve objetos simples.
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var PENDENTE = '[PENDENTE]';

  // id, nome, título de quem responde, descrição, pai (seção ou setor), fixa = sempre ativa (Operações)
  var CATALOGO = [
    { id: 'seg', nome: 'Oficial de Segurança', titulo: 'Oficial', desc: 'riscos e condições inseguras; pode parar a operação', tipo: 'staff' },
    { id: 'lig', nome: 'Oficial de Ligação', titulo: 'Oficial', desc: 'contato com órgãos e instituições', tipo: 'staff' },
    { id: 'inf', nome: 'Oficial de Informação Pública', titulo: 'Oficial', desc: 'imprensa, famílias e redes', tipo: 'staff' },
    { id: 'ops', nome: 'Seção de Operações', curto: 'Operações', titulo: 'Chefe', desc: 'equipes em campo, setores e vítimas', tipo: 'secao', fixa: true },
    { id: 'ops.espera', nome: 'Área de Espera', titulo: 'Encarregado', desc: 'recursos aguardando designação', tipo: 'unidade', pai: 'ops' },
    { id: 'ops.acv', nome: 'ACV – Área de Concentração de Vítimas', titulo: 'Encarregado', desc: 'triagem e entrega ao SAMU', tipo: 'unidade', pai: 'ops' },
    { id: 'plan', nome: 'Seção de Planejamento', curto: 'Planejamento', titulo: 'Chefe', desc: 'situação, recursos, documentação e plano de ação', tipo: 'secao' },
    { id: 'plan.rec', nome: 'Unidade de Recursos', titulo: 'Líder', desc: 'check-in e situação das equipes', tipo: 'unidade', pai: 'plan' },
    { id: 'plan.sit', nome: 'Unidade de Situação', titulo: 'Líder', desc: 'balanço, setores e mapa', tipo: 'unidade', pai: 'plan' },
    { id: 'plan.doc', nome: 'Unidade de Documentação', titulo: 'Líder', desc: 'linha do tempo e formulários SCI', tipo: 'unidade', pai: 'plan' },
    { id: 'plan.desm', nome: 'Unidade de Desmobilização', titulo: 'Líder', desc: 'plano de desmobilização', tipo: 'unidade', pai: 'plan' },
    { id: 'plan.ma', nome: 'Unidade de Meio Ambiente', titulo: 'Líder', desc: 'impacto ambiental e contenção', tipo: 'unidade', pai: 'plan' },
    { id: 'plan.esp', nome: 'Especialistas', titulo: 'Líder', desc: 'engenheiro, químico, mergulhador…', tipo: 'unidade', pai: 'plan' },
    { id: 'log', nome: 'Seção de Logística', curto: 'Logística', titulo: 'Chefe', desc: 'instalações, materiais, alimentação e comunicações', tipo: 'secao' },
    { id: 'log.serv', nome: 'Setor de Serviços', titulo: 'Coordenador', desc: 'comunicações, médica e alimentação', tipo: 'unidade', pai: 'log' },
    { id: 'log.com', nome: 'Unidade de Comunicações', titulo: 'Líder', desc: 'plano de rádio', tipo: 'unidade', pai: 'log.serv' },
    { id: 'log.med', nome: 'Unidade Médica', titulo: 'Líder', desc: 'atendimento à equipe', tipo: 'unidade', pai: 'log.serv' },
    { id: 'log.ali', nome: 'Unidade de Alimentação', titulo: 'Líder', desc: 'água e refeições', tipo: 'unidade', pai: 'log.serv' },
    { id: 'log.apoio', nome: 'Setor de Apoio', titulo: 'Coordenador', desc: 'suprimentos, instalações e transporte', tipo: 'unidade', pai: 'log' },
    { id: 'log.sup', nome: 'Unidade de Suprimentos', titulo: 'Líder', desc: 'pedidos e materiais', tipo: 'unidade', pai: 'log.apoio' },
    { id: 'log.inst', nome: 'Unidade de Instalações', titulo: 'Líder', desc: 'base, acampamento e posto de comando', tipo: 'unidade', pai: 'log.apoio' },
    { id: 'log.ter', nome: 'Unidade de Suporte Terrestre', titulo: 'Líder', desc: 'viaturas e combustível', tipo: 'unidade', pai: 'log.apoio' },
    { id: 'adm', nome: 'Seção de Administração e Finanças', curto: 'Adm. e Finanças', titulo: 'Chefe', desc: 'tempo, provedoria e custos', tipo: 'secao' },
    { id: 'adm.tempo', nome: 'Unidade de Tempo', titulo: 'Líder', desc: 'horas do pessoal e dos equipamentos', tipo: 'unidade', pai: 'adm' },
    { id: 'adm.prov', nome: 'Unidade de Provedoria', titulo: 'Líder', desc: 'aquisições e contratos', tipo: 'unidade', pai: 'adm' },
    { id: 'adm.cus', nome: 'Unidade de Custos', titulo: 'Líder', desc: 'apuração de custos', tipo: 'unidade', pai: 'adm' },
  ];
  var POR_ID = {};
  CATALOGO.forEach(function (f) { POR_ID[f.id] = f; });

  // Tipos de recurso tático (equipes = grupos do app)
  var TIPOS_EQUIPE = { ei: 'Equipe de Intervenção', ft: 'Força-Tarefa', ru: 'Recurso Único', setor: 'Setor', grupo: 'Grupo' };

  // Menu do Modo SCI: as seções e páginas do layout de referência. secao = de quem é a seção no organograma.
  var MENU = [
    { titulo: 'Comando', paginas: [['resumo', 'Resumo'], ['painel', 'Painel do Comando'], ['organograma', 'SCI · organograma']] },
    { titulo: 'Operações', secao: 'ops', paginas: [['operacoes', 'Visão geral e períodos'], ['mapa', 'Mapa operacional e setores'], ['vitimas', 'Vítimas e ACV'], ['espera', 'Área de Espera']] },
    { titulo: 'Planejamento', secao: 'plan', paginas: [['recursos', 'Recursos e fatores humanos'], ['formularios', 'Formulários e relatórios']] },
    { titulo: 'Logística', secao: 'log', paginas: [['logistica', 'Logística e materiais']] },
    { titulo: 'Administração e Finanças', secao: 'adm', paginas: [['admfin', 'Tempo, provedoria e custos']] },
  ];
  var PAGINAS = {};
  MENU.forEach(function (g) { g.paginas.forEach(function (p) { PAGINAS[p[0]] = p[1]; }); });

  var FASES = [['plotada', 'Plotada · aguardando equipe'], ['remocao', 'Em remoção'], ['acv', 'Na ACV'], ['entregue', 'Entregue']];
  var CONDICAO = { viva: 'com vida', obito: 'óbito', desconhecida: 'condição a confirmar' };
  var ESTADO_OBJETIVO = { pendente: 'Pendente', em_curso: 'Em curso', cumprido: 'Cumprido' };
  var MISSAO_ATIVA = ['enviada', 'em_deslocamento', 'no_setor', 'busca_finalizada', 'retorno_atrasado'];

  function vazio(v) { return v == null || String(v).trim() === ''; }
  function ms(v) { var t = typeof v === 'number' ? v : Date.parse(v); return isNaN(t) ? null : t; }
  function dois(n) { return (n < 10 ? '0' : '') + n; }
  function vnum(n) { return 'V-' + dois(n); }
  function duracao(m) {
    m = Math.max(0, Math.round(m / 60000));
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return h + 'h' + (r ? dois(r) : '');
  }
  function horaCurta(v) { var d = new Date(ms(v)); return dois(d.getHours()) + 'h' + dois(d.getMinutes()); }

  /* ---------- Organograma ---------- */
  function ativas(org) { return (org && org.ativas) || {}; }
  function ativa(org, id) { var f = POR_ID[id]; return Boolean(f && (f.fixa || ativas(org)[id])); }
  function podeAtivar(org, id) { var f = POR_ID[id]; return Boolean(f) && !ativa(org, id) && (!f.pai || ativa(org, f.pai)); }
  function filhos(id) { return CATALOGO.filter(function (f) { return f.pai === id; }); }
  // a função e as unidades abaixo dela que estão ativas (voltam ao CI ao desativar)
  function desativacao(org, id) {
    var f = POR_ID[id];
    if (!f || f.fixa || !ativa(org, id)) return [];
    var out = [id];
    filhos(id).forEach(function (c) { out = out.concat(ativa(org, c.id) ? desativacao(org, c.id) : []); });
    return out;
  }
  function nome(org, id) { var a = ativas(org)[id]; return (a && a.nome) || ''; }
  // "Funções não ativadas ficam com o CI": staff e seções sem ativação (e Operações sem chefe)
  function comOCi(org) {
    return CATALOGO.filter(function (f) { return f.tipo !== 'unidade' && (f.fixa ? !nome(org, f.id) : !ativa(org, f.id)); })
      .map(function (f) { return f.curto || f.nome; });
  }
  // quem responde pela seção do menu: o chefe, "com o CI" ou [PENDENTE] (ativada sem nome)
  function responsavelSecao(org, id) {
    if (!id) return null;
    if (!ativa(org, id)) return { comCi: true, texto: 'com o CI' };
    var n = nome(org, id);
    if (n) return { comCi: false, texto: n };
    return POR_ID[id].fixa ? { comCi: true, texto: 'com o CI' } : { comCi: false, texto: PENDENTE };
  }
  function minhasFuncoes(org, usuario) {
    if (!usuario) return [];
    var a = ativas(org);
    return CATALOGO.filter(function (f) { return a[f.id] && a[f.id].user_id === usuario; });
  }

  /* ---------- Período operacional ---------- */
  function periodoAtual(periodos, agora) {
    var lista = (periodos || []).slice().sort(function (a, b) { return a.numero - b.numero; });
    var atual = lista.filter(function (p) { return ms(p.inicio) <= agora && agora < ms(p.fim); }).pop() || null;
    var proximo = lista.filter(function (p) { return ms(p.inicio) > agora; })[0] || null;
    var ultimo = lista[lista.length - 1] || null;
    return { atual: atual, proximo: proximo, ultimo: ultimo, vencido: !atual && !proximo && ultimo && ms(ultimo.fim) <= agora ? ultimo : null };
  }

  /* ---------- Pessoas e equipes ---------- */
  // participantes: [{ tipo: militar|civil|responsavel, estado: conectado|instavel|parado|sem_atualizacao|aguardando|removido|encerrado }]
  function balancoPessoas(participantes) {
    var b = { total: 0, emCampo: 0, semContato: 0, aguardando: 0, sairam: 0, militares: 0, civis: 0, responsaveis: 0 };
    (participantes || []).forEach(function (p) {
      b.total++;
      if (p.tipo === 'militar') b.militares++; else if (p.tipo === 'civil') b.civis++; else b.responsaveis++;
      if (p.estado === 'removido') b.sairam++;
      else if (p.estado === 'conectado' || p.estado === 'instavel') b.emCampo++;
      else if (p.estado === 'aguardando') b.aguardando++;
      else b.semContato++;   // parado, sem atualização, encerrado
    });
    b.fecha = b.emCampo + b.semContato + b.aguardando + b.sairam === b.total;
    return b;
  }
  // grupos do app × deslocamentos ativos → em missão, disponíveis, em descanso, indisponíveis
  function equipesPorStatus(grupos, missoes) {
    var r = { missao: [], disponivel: [], descanso: [], indisponivel: [] };
    (grupos || []).forEach(function (g) {
      var m = (missoes || []).filter(function (x) { return x.grupo_id === g.id && MISSAO_ATIVA.indexOf(x.status) !== -1; })
        .sort(function (a, b) { return ms(b.enviada_em) - ms(a.enviada_em); })[0];
      if (m) r.missao.push({ grupo: g, missao: m });
      else if (g.disponibilidade === 'em_descanso') r.descanso.push({ grupo: g });
      else if (g.disponibilidade === 'indisponivel') r.indisponivel.push({ grupo: g });
      else r.disponivel.push({ grupo: g });
    });
    return r;
  }
  function progressoSetores(setores) {
    var r = { pendente: 0, andamento: 0, concluido: 0, total: 0 };
    (setores || []).forEach(function (s) { r.total++; r[s.status === 'concluido' ? 'concluido' : s.status === 'andamento' ? 'andamento' : 'pendente']++; });
    return r;
  }

  /* ---------- Vítimas ---------- */
  // vitimas: linhas de sci2_vitimas; localizacoes: vítimas encontradas do app; fichas: cadastro de vítimas
  function quadroVitimas(vitimas, localizacoes, fichas) {
    var q = { plotada: [], remocao: [], acv: [], entregue: [], foraDoQuadro: [], procuradas: [] };
    var noQuadro = {};
    (vitimas || []).slice().sort(function (a, b) { return a.numero - b.numero; }).forEach(function (v) {
      if (v.localizacao_id) noQuadro[v.localizacao_id] = true;
      (q[v.fase] || q.plotada).push(v);
    });
    (localizacoes || []).forEach(function (l) { if (!noQuadro[l.id]) q.foraDoQuadro.push(l); });
    var achadas = {};
    (localizacoes || []).forEach(function (l) { if (l.vitima_id) achadas[l.vitima_id] = true; });
    (vitimas || []).forEach(function (v) { if (v.vitima_id) achadas[v.vitima_id] = true; });
    q.procuradas = (fichas || []).filter(function (f) { return !achadas[f.id]; });
    return q;
  }
  function numerosVitimas(q) {
    var todas = q.plotada.concat(q.remocao, q.acv, q.entregue);
    var obitos = todas.filter(function (v) { return v.condicao === 'obito'; }).length + q.foraDoQuadro.filter(function (l) { return l.condicao === 'obito'; }).length;
    var vivas = todas.filter(function (v) { return v.condicao === 'viva'; }).length + q.foraDoQuadro.filter(function (l) { return l.condicao === 'viva'; }).length;
    return {
      procuradas: q.procuradas.length, aguardandoEquipe: q.plotada.length + q.foraDoQuadro.length, emRemocao: q.remocao.length,
      foraDaEstrutura: q.acv.length + q.entregue.length, naAcv: q.acv.length, entregues: q.entregue.length, vivas: vivas, obitos: obitos,
      localizadas: todas.length + q.foraDoQuadro.length,
    };
  }

  /* ---------- Alertas (ordem: segurança da equipe › vítimas › comando) ---------- */
  // d: { estado (sci2_estado), periodos, informacoes, quadro (quadroVitimas), pedidosAjuda, alertasApp, equipes (equipesPorStatus), setores, agora, ativa }
  function alertas(d) {
    var out = [], agora = d.agora || Date.now();
    function add(nivel, grupo, texto, pagina) { out.push({ nivel: nivel, grupo: grupo, texto: texto, pagina: pagina }); }
    (d.pedidosAjuda || []).forEach(function (p) {
      add('critico', 'seguranca', 'Pedido de ajuda de ' + (p.participante_nome || 'participante') + (p.estado === 'recebido' ? ' SEM ATENDIMENTO' : '') + (p.recebido_em ? ' (desde ' + horaCurta(p.recebido_em) + ')' : '') + '.', 'painel');
    });
    (d.alertasApp || []).filter(function (a) { return a.nivel === 'critico'; }).forEach(function (a) { add('critico', 'seguranca', a.titulo + (a.texto ? ': ' + a.texto : ''), 'painel'); });
    var q = d.quadro;
    if (q) {
      q.plotada.forEach(function (v) {
        var t = ms(v.criado_em);
        if (t && agora - t > 30 * 60000) add('alerta', 'vitimas', vnum(v.numero) + ' aguardando equipe há ' + duracao(agora - t) + '.', 'vitimas');
      });
      q.remocao.forEach(function (v) {
        var t = ms(v.remocao_em);
        if (t && agora - t > 60 * 60000) add('alerta', 'vitimas', vnum(v.numero) + ' em remoção pela ' + (v.equipe_nome || 'equipe') + ' há ' + duracao(agora - t) + '.', 'vitimas');
      });
      if (q.foraDoQuadro.length) add('alerta', 'vitimas', q.foraDoQuadro.length + ' vítima(s) encontrada(s) no mapa ainda fora do quadro de vítimas.', 'vitimas');
    }
    if (d.ativa !== false) {
      var e = d.estado || {};
      if (!e.estabelecido_em) add('pendencia', 'comando', 'SCI ainda não estabelecido (comando inicial, informações e 1º período).', 'estabelecer');
      else {
        var c = e.comando || {};
        if (!c.pc_ponto_id && vazio(c.pc_texto)) add('pendencia', 'comando', 'Posto de Comando ' + PENDENTE + ': marque no mapa ou descreva.', 'organograma');
        var p = periodoAtual(d.periodos, agora);
        if (p.vencido) add('alerta', 'comando', 'Período operacional ' + p.vencido.numero + ' terminou às ' + horaCurta(p.vencido.fim) + ': defina o próximo.', 'operacoes');
        else if (!p.atual && !p.proximo) add('pendencia', 'comando', 'Nenhum período operacional definido.', 'operacoes');
        else if (p.atual && !(p.atual.objetivos || []).length) add('pendencia', 'comando', 'Período ' + p.atual.numero + ' sem objetivos.', 'operacoes');
        if (vazio(e.boletim)) add('pendencia', 'comando', 'Boletim do CI ' + PENDENTE + '.', 'resumo');
      }
      var nc = (d.informacoes || []).filter(function (i) { return !i.confirmada_em && !i.descartada_em; }).length;
      if (nc) add('pendencia', 'comando', nc + ' informação(ões) NÃO CONFIRMADA(S) aguardando a equipe.', 'operacoes');
      var org = e.organograma;
      var emMissao = d.equipes ? d.equipes.missao.length : 0;
      if (emMissao && !ativa(org, 'seg')) add('pendencia', 'seguranca', 'Oficial de Segurança com o CI e ' + emMissao + ' equipe(s) em missão.', 'organograma');
    }
    var ordem = { critico: 0, alerta: 1, pendencia: 2 }, ordemGrupo = { seguranca: 0, vitimas: 1, comando: 2 };
    return out.sort(function (a, b) { return ordem[a.nivel] - ordem[b.nivel] || ordemGrupo[a.grupo] - ordemGrupo[b.grupo]; });
  }

  /* ---------- SCI 201: Resumo do Incidente ---------- */
  // d: { op, ci, estado, periodos, informacoes, setores, equipes, quadro, agora }
  function sci201(d) {
    var o = d.op || {}, e = d.estado || {}, c = e.comando || {}, agora = d.agora || Date.now();
    var p = periodoAtual(d.periodos, agora).atual;
    var nv = d.quadro ? numerosVitimas(d.quadro) : null;
    function v(x) { return vazio(x) ? PENDENTE : x; }
    var linhas = [
      'SCI 201 — RESUMO DO INCIDENTE',
      'Ocorrência: ' + v(o.codigo) + (o.local_endereco ? ' · ' + o.local_endereco : ''),
      'Comandante do Incidente: ' + v(d.ci),
      'Comando: ' + (c.modalidade === 'unificado' ? 'unificado' + ((c.instituicoes || []).length ? ' (' + c.instituicoes.join(', ') + ')' : '') : c.modalidade === 'unico' ? 'único' : PENDENTE),
      'Posto de Comando: ' + v(c.pc_texto) + ' · Base: ' + v(c.base_texto),
      'Canais: comando ' + v(c.canal_comando) + ' · tático ' + v(c.canal_tatico),
      '',
      'SITUAÇÃO ATUAL' + (e.boletim_em ? ' (' + horaCurta(e.boletim_em) + ')' : ''),
      v(e.boletim),
      '',
      'PERÍODO OPERACIONAL: ' + (p ? p.numero + ' · ' + horaCurta(p.inicio) + ' → ' + horaCurta(p.fim) : PENDENTE),
      'OBJETIVOS:',
    ];
    var obj = p ? p.objetivos || [] : [];
    if (obj.length) obj.forEach(function (x) { linhas.push('  • ' + x.texto + ' (' + (ESTADO_OBJETIVO[x.estado] || x.estado) + ')'); });
    else linhas.push('  ' + PENDENTE);
    linhas.push('', 'SETORES: ' + ((d.setores || []).length ? d.setores.map(function (s) { return s.nome + ' (' + ({ pendente: 'pendente', andamento: 'em andamento', concluido: 'concluído' }[s.status] || s.status || '—') + ')'; }).join('; ') : PENDENTE));
    if (d.equipes) {
      var eq = d.equipes;
      linhas.push('RECURSOS: ' + eq.missao.length + ' equipe(s) em missão, ' + eq.disponivel.length + ' disponível(is), ' + eq.descanso.length + ' em descanso');
      eq.missao.forEach(function (x) { linhas.push('  • ' + x.grupo.nome + ': ' + x.missao.nome + (x.missao.setor_nome ? ' (setor ' + x.missao.setor_nome + ')' : '')); });
    }
    if (nv) linhas.push('VÍTIMAS: ' + nv.procuradas + ' procurada(s) · ' + nv.localizadas + ' localizada(s) (' + nv.vivas + ' com vida, ' + nv.obitos + ' óbito) · ' + nv.naAcv + ' na ACV · ' + nv.entregues + ' entregue(s)');
    var conf = (d.informacoes || []).filter(function (i) { return !i.descartada_em; });
    if (conf.length) {
      linhas.push('', 'INFORMAÇÕES RECEBIDAS:');
      conf.forEach(function (i) { linhas.push('  • ' + i.texto + (i.fonte ? ' — ' + i.fonte : '') + (i.confirmada_em ? '' : ' (NÃO CONFIRMADA)')); });
    }
    return linhas.join('\n');
  }

  var API = {
    PENDENTE: PENDENTE, CATALOGO: CATALOGO, TIPOS_EQUIPE: TIPOS_EQUIPE, MENU: MENU, PAGINAS: PAGINAS, FASES: FASES, CONDICAO: CONDICAO,
    ESTADO_OBJETIVO: ESTADO_OBJETIVO, MISSAO_ATIVA: MISSAO_ATIVA,
    funcao: function (id) { return POR_ID[id] || null; }, ativa: ativa, podeAtivar: podeAtivar, filhos: filhos, desativacao: desativacao, nome: nome,
    comOCi: comOCi, responsavelSecao: responsavelSecao, minhasFuncoes: minhasFuncoes, periodoAtual: periodoAtual, balancoPessoas: balancoPessoas,
    equipesPorStatus: equipesPorStatus, progressoSetores: progressoSetores, quadroVitimas: quadroVitimas, numerosVitimas: numerosVitimas,
    alertas: alertas, sci201: sci201, vnum: vnum, duracao: duracao, horaCurta: horaCurta, vazio: vazio,
  };
  raiz.SciDados = API;
  if (typeof module === 'object' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
