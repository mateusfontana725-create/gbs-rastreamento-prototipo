/* =====================================================================
 * sci-org.js — SCI que cresce com a ocorrência (migração 057), sem tela.
 *   A operação começa pequena: só o Comandante do Incidente (CI), com Operações. Cada função do SCI
 *   (staff do comando, seções e unidades) é ativada quando precisa; o que não está ativado fica com o CI.
 *   O menu do Comando acompanha: as áreas ativadas aparecem abertas; as outras ficam em "Com o CI",
 *   sempre à mão (operação pequena também tem vítima, material e área de espera).
 *   Pontos de partida (pequena, média, grande) são só atalhos: ativam um conjunto e nada fica travado.
 *   O catálogo é o mesmo do servidor (sci_estrutura_catalogo, migração 057).
 * ===================================================================== */
(function (raiz) {
  'use strict';

  // id, nome, título de quem responde, descrição, tipo, pai, chave em sci_estado.funcoes, página do Comando
  var CATALOGO = [
    { id: 'seg', nome: 'Oficial de Segurança', titulo: 'Oficial', desc: 'riscos, condições inseguras, pode parar a operação', tipo: 'staff', funcao: 'seguranca', pagina: 'seguranca' },
    { id: 'lig', nome: 'Oficial de Ligação', titulo: 'Oficial', desc: 'contato com os órgãos e instituições', tipo: 'staff', funcao: 'ligacao', pagina: 'equipes' },
    { id: 'inf', nome: 'Oficial de Informação Pública', titulo: 'Oficial', desc: 'imprensa, famílias e redes', tipo: 'staff', funcao: 'informacao_publica', pagina: 'geral' },

    { id: 'ops', nome: 'Operações', titulo: 'Chefe da Seção', desc: 'equipes em campo, setores, vítimas', tipo: 'secao', funcao: 'operacoes', pagina: 'geral', fixa: true },
    { id: 'ops.espera', nome: 'Área de Espera', titulo: 'Encarregado', desc: 'recursos aguardando designação', tipo: 'unidade', pai: 'ops', pagina: 'espera' },
    { id: 'ops.acv', nome: 'ACV – Área de Concentração de Vítimas', titulo: 'Encarregado', desc: 'triagem e entrega ao SAMU', tipo: 'unidade', pai: 'ops', pagina: 'vitimas' },

    { id: 'plan', nome: 'Planejamento', titulo: 'Chefe da Seção', desc: 'situação, recursos, documentação e plano de ação', tipo: 'secao', funcao: 'planejamento', pagina: 'recursos' },
    { id: 'plan.rec', nome: 'Unidade de Recursos', titulo: 'Líder', desc: 'check-in e situação das equipes', tipo: 'unidade', pai: 'plan', pagina: 'recursos' },
    { id: 'plan.sit', nome: 'Unidade de Situação', titulo: 'Líder', desc: 'balanço, setores, mapa', tipo: 'unidade', pai: 'plan', pagina: 'geral' },
    { id: 'plan.doc', nome: 'Unidade de Documentação', titulo: 'Líder', desc: 'linha do tempo e formulários', tipo: 'unidade', pai: 'plan', pagina: 'linha' },
    { id: 'plan.desm', nome: 'Unidade de Desmobilização', titulo: 'Líder', desc: 'plano de desmobilização', tipo: 'unidade', pai: 'plan', pagina: 'recursos' },
    { id: 'plan.ma', nome: 'Unidade de Meio Ambiente', titulo: 'Líder', desc: 'impacto ambiental, contenção', tipo: 'unidade', pai: 'plan', pagina: 'local' },
    { id: 'plan.esp', nome: 'Especialistas', titulo: 'Líder', desc: 'engenheiro, químico, mergulhador…', tipo: 'unidade', pai: 'plan', pagina: 'recursos' },

    { id: 'log', nome: 'Logística', titulo: 'Chefe da Seção', desc: 'instalações, materiais, alimentação, comunicações', tipo: 'secao', funcao: 'logistica', pagina: 'logistica' },
    { id: 'log.serv', nome: 'Setor de Serviços', titulo: 'Coordenador', desc: 'comunicações, médica, alimentação', tipo: 'unidade', pai: 'log', pagina: 'logistica' },
    { id: 'log.com', nome: 'Unidade de Comunicações', titulo: 'Líder', desc: 'plano de rádio', tipo: 'unidade', pai: 'log.serv', pagina: 'logistica' },
    { id: 'log.med', nome: 'Unidade Médica', titulo: 'Líder', desc: 'atendimento à equipe', tipo: 'unidade', pai: 'log.serv', pagina: 'logistica' },
    { id: 'log.ali', nome: 'Unidade de Alimentação', titulo: 'Líder', desc: 'água e refeições', tipo: 'unidade', pai: 'log.serv', pagina: 'logistica' },
    { id: 'log.apoio', nome: 'Setor de Apoio', titulo: 'Coordenador', desc: 'suprimentos, instalações, transporte', tipo: 'unidade', pai: 'log', pagina: 'logistica' },
    { id: 'log.sup', nome: 'Unidade de Suprimentos', titulo: 'Líder', desc: 'pedidos e materiais', tipo: 'unidade', pai: 'log.apoio', pagina: 'logistica' },
    { id: 'log.inst', nome: 'Unidade de Instalações', titulo: 'Líder', desc: 'base, acampamento, posto de comando', tipo: 'unidade', pai: 'log.apoio', pagina: 'logistica' },
    { id: 'log.ter', nome: 'Unidade de Suporte Terrestre', titulo: 'Líder', desc: 'viaturas e combustível', tipo: 'unidade', pai: 'log.apoio', pagina: 'logistica' },

    { id: 'adm', nome: 'Administração e Finanças', titulo: 'Chefe da Seção', desc: 'tempo, aquisições e custos', tipo: 'secao', funcao: 'adm_financas', pagina: 'admfin' },
    { id: 'adm.tempo', nome: 'Unidade de Tempo', titulo: 'Líder', desc: 'horas do pessoal e dos equipamentos', tipo: 'unidade', pai: 'adm', pagina: 'admfin' },
    { id: 'adm.prov', nome: 'Unidade de Provedoria', titulo: 'Líder', desc: 'aquisições e contratos', tipo: 'unidade', pai: 'adm', pagina: 'admfin' },
    { id: 'adm.cus', nome: 'Unidade de Custos', titulo: 'Líder', desc: 'apuração de custos', tipo: 'unidade', pai: 'adm', pagina: 'admfin' },
  ];
  var POR_ID = {};
  CATALOGO.forEach(function (f) { POR_ID[f.id] = f; });

  // Pontos de partida: só ativam (nunca desativam o que já está ativo). Depois cada função é ajustada à parte.
  var PONTOS_DE_PARTIDA = [
    { id: 'pequena', rotulo: 'Pequena', desc: 'Só o CI (com Operações). Mapa, equipes, vítimas e relatórios já estão à mão; o resto entra quando precisar.', ids: [] },
    { id: 'media', rotulo: 'Média', desc: 'CI, Oficial de Segurança, Área de Espera, ACV, Planejamento (recursos e situação) e Logística (suprimentos).',
      ids: ['seg', 'ops.espera', 'ops.acv', 'plan', 'plan.rec', 'plan.sit', 'log', 'log.apoio', 'log.sup'] },
    { id: 'grande', rotulo: 'Grande', desc: 'Staff completo e as quatro seções com as unidades principais (operação longa, várias instituições).',
      ids: ['seg', 'lig', 'inf', 'ops.espera', 'ops.acv', 'plan', 'plan.rec', 'plan.sit', 'plan.doc', 'plan.desm', 'log', 'log.serv', 'log.com', 'log.med', 'log.ali',
        'log.apoio', 'log.sup', 'log.inst', 'log.ter', 'adm', 'adm.tempo', 'adm.prov', 'adm.cus'] },
  ];

  // Páginas do Comando: grupo do menu e rótulo. "acao" = abre algo fora do Comando (mapa, relatórios).
  var PAGINAS = {
    geral: { rotulo: 'Resumo', grupo: 'comando' },
    org: { rotulo: 'Organograma SCI', grupo: 'comando' },
    linha: { rotulo: 'Linha do tempo', grupo: 'comando' },
    seguranca: { rotulo: 'Segurança', grupo: 'staff', funcao: 'seg' },
    mapa: { rotulo: 'Mapa operacional', grupo: 'operacoes', acao: true },
    vitimas: { rotulo: 'Vítimas e ACV', grupo: 'operacoes' },
    equipes: { rotulo: 'Equipes e órgãos', grupo: 'operacoes' },
    espera: { rotulo: 'Área de Espera', grupo: 'operacoes', funcao: 'ops.espera' },
    local: { rotulo: 'Local e danos', grupo: 'operacoes' },
    recursos: { rotulo: 'Recursos', grupo: 'planejamento' },
    relatorios: { rotulo: 'Formulários e relatórios', grupo: 'planejamento', acao: true },
    logistica: { rotulo: 'Logística e materiais', grupo: 'logistica', funcao: 'log' },
    admfin: { rotulo: 'Tempo, aquisições e custos', grupo: 'adm', funcao: 'adm' },
  };
  var GRUPOS = [
    { id: 'comando', titulo: 'Comando', paginas: ['geral', 'org', 'linha'] },
    { id: 'staff', titulo: 'Staff do comando', paginas: ['seguranca'] },
    { id: 'operacoes', titulo: 'Operações', secao: 'ops', paginas: ['mapa', 'vitimas', 'equipes', 'espera', 'local'] },
    { id: 'planejamento', titulo: 'Planejamento', secao: 'plan', paginas: ['recursos', 'relatorios'] },
    { id: 'logistica', titulo: 'Logística', secao: 'log', paginas: ['logistica'] },
    { id: 'adm', titulo: 'Administração e Finanças', secao: 'adm', paginas: ['admfin'] },
  ];

  function normalizar(e) {
    e = e && typeof e === 'object' ? e : {};
    return { ativas: e.ativas && typeof e.ativas === 'object' ? e.ativas : {}, inicio: e.inicio || null, ponto: e.ponto || null };
  }
  function funcao(id) { return POR_ID[id] || null; }
  function ativa(e, id) {
    var f = POR_ID[id];
    if (!f) return false;
    if (f.fixa) return true;
    return Boolean(normalizar(e).ativas[id]);
  }
  // Uma unidade só existe com o pai ativo (a seção ou o setor). Staff e seções: sempre podem ser ativados.
  function podeAtivar(e, id) {
    var f = POR_ID[id];
    if (!f || ativa(e, id)) return false;
    return !f.pai || ativa(e, f.pai);
  }
  function filhos(id) { return CATALOGO.filter(function (f) { return f.pai === id; }).map(function (f) { return f.id; }); }
  function descendentes(id) {
    var out = [];
    filhos(id).forEach(function (c) { out.push(c); out = out.concat(descendentes(c)); });
    return out;
  }
  // Ao desativar: a função e as unidades abaixo dela que estavam ativas (voltam ao CI).
  function desativacao(e, id) {
    var f = POR_ID[id];
    if (!f || f.fixa || !ativa(e, id)) return [];
    return [id].concat(descendentes(id).filter(function (c) { return ativa(e, c); }));
  }
  function nome(e, id) { var a = normalizar(e).ativas[id]; return (a && a.nome) || ''; }
  // Staff e seções que estão com o CI (não ativadas), como diz o organograma.
  function acumuladasPeloCi(e) {
    return CATALOGO.filter(function (f) { return (f.tipo === 'staff' || f.tipo === 'secao') && !f.fixa && !ativa(e, f.id); }).map(function (f) { return f.nome; })
      .concat(ativa(e, 'ops') && !nome(e, 'ops') ? ['Operações'] : []);
  }
  // Quem responde por um grupo do menu: o chefe da seção ou o CI.
  function responsavelDoGrupo(e, g) {
    if (!g.secao) return null;
    if (!ativa(e, g.secao)) return { comCi: true, texto: 'com o CI' };
    var n = nome(e, g.secao);
    if (n) return { comCi: false, texto: n };
    // Operações nasce ativa: sem chefe designado, quem responde é o CI; seção ativada sem nome = [PENDENTE]
    return POR_ID[g.secao].fixa ? { comCi: true, texto: 'com o CI' } : { comCi: false, texto: '[PENDENTE]' };
  }
  function paginaVisivel(e, p) {
    var pg = PAGINAS[p];
    return Boolean(pg) && (!pg.funcao || ativa(e, pg.funcao));
  }
  // Menu do Comando: grupos ativos abertos; páginas de funções não ativadas em "Com o CI" (sempre acessíveis).
  function menu(e, opcoes) {
    opcoes = opcoes || {};
    e = normalizar(e);
    var comCi = [];
    var grupos = [];
    GRUPOS.forEach(function (g) {
      var itens = [], fora = [];
      g.paginas.forEach(function (p) {
        if (p === 'mapa' && opcoes.semMapa) return;
        (paginaVisivel(e, p) ? itens : fora).push({ pagina: p, rotulo: PAGINAS[p].rotulo, acao: Boolean(PAGINAS[p].acao), funcao: PAGINAS[p].funcao || null });
      });
      comCi = comCi.concat(fora);
      if (itens.length) grupos.push({ id: g.id, titulo: g.titulo, responsavel: responsavelDoGrupo(e, g), itens: itens });
    });
    return { grupos: grupos, comCi: comCi, minhas: minhasFuncoes(e, opcoes.usuario) };
  }
  // Funções designadas para este usuário (conta de responsável ligada no organograma).
  function minhasFuncoes(e, usuario) {
    if (!usuario) return [];
    var a = normalizar(e).ativas;
    return CATALOGO.filter(function (f) { return a[f.id] && a[f.id].user_id === usuario && ativa(e, f.id); })
      .map(function (f) { return { id: f.id, nome: f.nome, pagina: f.pagina }; });
  }
  function ponto(id) { return PONTOS_DE_PARTIDA.filter(function (p) { return p.id === id; })[0] || null; }
  // O que um ponto de partida ativaria agora (o que já está ativo fica como está).
  function aplicarPonto(e, id) {
    var p = ponto(id);
    if (!p) return [];
    return p.ids.filter(function (x) { return !ativa(e, x); });
  }
  function configurada(e) { return Boolean(normalizar(e).inicio); }
  function contagem(e) {
    var n = 0;
    CATALOGO.forEach(function (f) { if (!f.fixa && ativa(e, f.id)) n++; });
    return n;
  }

  var API = {
    CATALOGO: CATALOGO, PONTOS_DE_PARTIDA: PONTOS_DE_PARTIDA, PAGINAS: PAGINAS, GRUPOS: GRUPOS,
    normalizar: normalizar, funcao: funcao, ativa: ativa, podeAtivar: podeAtivar, filhos: filhos, descendentes: descendentes, desativacao: desativacao,
    nome: nome, acumuladasPeloCi: acumuladasPeloCi, menu: menu, minhasFuncoes: minhasFuncoes, ponto: ponto, aplicarPonto: aplicarPonto,
    configurada: configurada, contagem: contagem, paginaVisivel: paginaVisivel,
  };
  raiz.SciOrg = API;
  if (typeof module === 'object' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
