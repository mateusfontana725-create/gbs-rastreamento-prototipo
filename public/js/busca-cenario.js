/* =====================================================================
 * busca-cenario.js — probabilidades de busca no painel (POA, POD e POS), seguindo o guia de implantação
 *   - Cenário por vítima: o responsável distribui o POA entre os setores, com justificativa, hipóteses,
 *     limitações, evidências e o último ponto confiável. Cada versão é rascunho até ser aprovada;
 *     aprovada, nunca mais muda (o servidor garante). Rever cria uma nova versão e o histórico fica.
 *   - Registro manual da busca: o POD vem do que a equipe relatou, nunca do GPS. Pode ser planejada
 *     (previsão) ou pós-execução; pode ficar "não estimada" (não vira zero). Registro errado se anula.
 *   - O cálculo (POA atual, POD acumulado, POS) é de js/pod.js; os dados ficam nas tabelas das migrações 033 e 034.
 *   - Números calculados aqui são uma PRÉVIA do navegador: o que vale e fica guardado são os dados aprovados.
 * Usa a interface window.Painel (militar.js).
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI, P = window.Painel, M = window.POD;
  if (!C || !UI || !P || !M) return;
  var el = UI.el;

  var est = {
    opId: null, vitimas: [], cenarios: [], itens: [], evidencias: [], registros: [], localizacoes: [],
    ausente: false, erro: null, canal: null, timer: null, timerCanal: null,
    vitimaSel: null, renderAtual: null, camadaVitima: null, aba: 'poa', editorSujo: false,
    missoes: [], efeitos: [], semMissoes: false,
  };

  var CONFIANCA = { baixa: 'baixa', media: 'média', alta: 'alta' };
  var ORIGENS = { julgamento_comando: 'julgamento documentado do comando', consenso_documentado: 'consenso documentado da equipe', modelo_validado: 'modelo validado' };
  var METODOS = ['A pé, em linha', 'A pé, em grupo livre', 'Cão de busca', 'Drone', 'Embarcação', 'Mergulho', 'Veículo ou moto', 'Outro'];

  /* ---------- Formatação e dados ---------------------------------------- */
  function pct(v, casas) {
    return v == null ? '—' : (v * 100).toLocaleString('pt-BR', { maximumFractionDigits: casas == null ? 1 : casas }) + '%';
  }
  function podeAlterar() { return Boolean(P.podeAlterar && P.podeAlterar()); }
  function nomeVitima(id) {
    var v = est.vitimas.find(function (x) { return x.id === id; });
    return v ? v.nome : 'Vítima';
  }
  function chaveNova() {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (e) { /* segue */ }
    return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function localizacaoDa(vitimaId) {
    return est.localizacoes.find(function (l) { return l.vitima_id === vitimaId; }) || null;
  }
  function versoesDa(vitimaId) {
    return est.cenarios.filter(function (c) { return c.vitima_id === vitimaId; }).sort(function (a, b) { return a.numero - b.numero; })
      .map(function (c) {
        return Object.assign({}, c, {
          setores: est.itens.filter(function (i) { return i.cenario_id === c.id; }),
          evidencias: est.evidencias.filter(function (e) { return e.cenario_id === c.id; }),
        });
      });
  }
  function aprovadaDa(vitimaId) {
    var l = versoesDa(vitimaId).filter(function (c) { return c.estado === 'aprovada'; });
    return l.length ? l[l.length - 1] : null;
  }
  function rascunhoDa(vitimaId) {
    return versoesDa(vitimaId).filter(function (c) { return c.estado === 'rascunho'; })[0] || null;
  }
  function geometriaDoSetor(s, poa) {
    return { nome: s.nome, poa: poa, forma: s.forma, centroLat: s.centro_lat, centroLng: s.centro_lng, raioM: s.raio_m, pontos: s.pontos };
  }
  function rotuloPonto(p) {
    var c = P.categoriaDoPonto ? P.categoriaDoPonto(p) : P.categorias && P.categorias[p.categoria];
    return (c ? c.rotulo : p.categoria) + ' — ' + p.titulo;
  }
  function dataLocal(ms) {
    var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------- Carga e tempo real ---------------------------------------- */
  async function carregar() {
    var op = P.op();
    if (!op || est.ausente) return;
    var opId = op.id;
    try {
      var r = await Promise.all([
        C.consultar(C.cliente.from('vitimas').select('*').eq('operacao_id', opId).order('criado_em', { ascending: true })),
        C.consultar(C.cliente.from('busca_cenarios').select('*').eq('operacao_id', opId).order('numero', { ascending: true })),
        C.consultar(C.cliente.from('busca_cenario_setores').select('*').eq('operacao_id', opId)),
        C.consultar(C.cliente.from('busca_registros').select('*').eq('operacao_id', opId).order('registrado_em', { ascending: true })),
        C.consultar(C.cliente.from('busca_cenario_evidencias').select('*').eq('operacao_id', opId)),
      ]);
      if (!P.op() || P.op().id !== opId) return;
      est.vitimas = r[0] || []; est.cenarios = r[1] || []; est.itens = r[2] || []; est.registros = r[3] || []; est.evidencias = r[4] || [];
      est.erro = null;
    } catch (e) {
      // banco sem as migrações 033/034: o resto do painel segue
      var t = String(e.original && (e.original.message || e.original.details) || e.message);
      if (/busca_cenarios|busca_registros|busca_cenario_setores|busca_cenario_evidencias/.test(t) || e.codigo === 'funcao_ausente') est.ausente = true;
      est.erro = e.message;
    }
    try {
      est.localizacoes = (await C.consultar(C.cliente.from('vitima_localizacoes').select('vitima_id,condicao,registrado_em').eq('operacao_id', opId))) || [];
    } catch (e) { est.localizacoes = []; }
    try {
      var rm = await Promise.all([
        C.consultar(C.cliente.from('busca_missoes').select('*').eq('operacao_id', opId).order('criada_em', { ascending: true })),
        C.consultar(C.cliente.from('busca_missao_efeitos').select('*').eq('operacao_id', opId)),
      ]);
      if (P.op() && P.op().id === opId) { est.missoes = rm[0] || []; est.efeitos = rm[1] || []; est.semMissoes = false; }
    } catch (e) {
      // banco sem a migração 039: o POA segue, só as missões ficam indisponíveis
      est.missoes = []; est.efeitos = []; est.semMissoes = true;
    }
    atualizarCamada();
    if (est.renderAtual) est.renderAtual();
  }

  function agendar() {
    clearTimeout(est.timer);
    est.timer = setTimeout(carregar, 400);
  }

  function assinar() {
    var op = P.op();
    if (!op || est.ausente) return;
    var opId = op.id;
    if (est.canal) { try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ } }
    try {
      est.canal = C.cliente.channel('op-busca-' + opId + '-' + Date.now());
      ['busca_cenarios', 'busca_cenario_setores', 'busca_cenario_evidencias', 'busca_registros', 'busca_missoes', 'busca_missao_efeitos', 'vitimas', 'vitima_localizacoes'].forEach(function (tabela) {
        est.canal.on('postgres_changes', { event: '*', schema: 'public', table: tabela, filter: 'operacao_id=eq.' + opId }, agendar);
      });
      est.canal.subscribe(function (status) {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(est.timerCanal);
          est.timerCanal = setTimeout(function () { var o = P.op(); if (o && o.id === opId) { carregar(); assinar(); } }, 60000);
        }
      });
    } catch (e) { /* sem tempo real: recarrega ao abrir a operação e ao salvar */ }
  }

  function iniciar() {
    parar();
    var op = P.op();
    if (!op) return;
    est.opId = op.id;
    var carga = carregar();
    assinar();
    return carga;
  }

  function parar() {
    clearTimeout(est.timer);
    clearTimeout(est.timerCanal);
    if (est.canal) { try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ } }
    est.canal = null;
    est.opId = null; est.vitimas = []; est.cenarios = []; est.itens = []; est.evidencias = []; est.registros = []; est.localizacoes = []; est.missoes = []; est.efeitos = []; est.semMissoes = false;
    est.ausente = false; est.erro = null; est.vitimaSel = null; est.renderAtual = null; est.aba = 'poa'; est.editorSujo = false;
    est.camadaVitima = null;
    if (P.camadaProbabilidade) P.camadaProbabilidade(null);
  }

  /* ---------- Camada de POA no mapa (separada da passagem GPS e das missões) ---------- */
  function atualizarCamada() {
    if (!P.camadaProbabilidade) return;
    var vid = est.camadaVitima;
    var ap = vid && aprovadaDa(vid);
    if (!vid || !ap) { P.camadaProbabilidade(null); return; }
    var valores = {};
    ap.setores.forEach(function (i) { if (i.setor_id) valores[i.setor_id] = Number(i.poa); });
    P.camadaProbabilidade(valores, 'POA vigente · ' + nomeVitima(vid) + ' · versão ' + ap.numero + ' · referência ' + C.hora(ap.horario_referencia || ap.aprovada_em, false));
  }

  /* ---------- Peças de tela ---------------------------------------------- */
  function aviso(texto, classe) {
    return el('p', { classe: classe || 'nota', texto: texto });
  }

  function tabela(cabecalho, linhas, classe) {
    return el('div', { classe: 'tabela-pod-rolagem' }, [
      el('table', { classe: 'tabela-pod' + (classe ? ' ' + classe : '') }, [
        el('thead', null, [el('tr', null, cabecalho.map(function (c) { return el('th', { scope: 'col', texto: c }); }))]),
        el('tbody', null, linhas),
      ]),
    ]);
  }
  function celulas(valores) {
    return el('tr', null, valores.map(function (v) { return el('td', null, [v]); }));
  }

  function textoAprovacao(c) {
    return 'Versão ' + c.numero + ' aprovada por ' + (c.aprovada_por_nome || '—') + ' às ' + C.hora(c.aprovada_em, false);
  }

  function blocoReferencia(c) {
    var linhas = [];
    linhas.push(['Horário de referência', c.horario_referencia ? C.hora(c.horario_referencia, false) : '—']);
    linhas.push(['Origem do POA', ORIGENS[c.origem_poa] || c.origem_poa]);
    if (c.confianca) linhas.push(['Sustentação dos dados', CONFIANCA[c.confianca] + ' (julgamento do comando, não intervalo estatístico)']);
    if (c.ponto_confiavel) linhas.push(['Último ponto confiável', c.ponto_confiavel.titulo + ' · ' + Number(c.ponto_confiavel.lat).toFixed(5) + ', ' + Number(c.ponto_confiavel.lng).toFixed(5)]);
    if (c.hipoteses) linhas.push(['Hipóteses', c.hipoteses]);
    if (c.limitacoes) linhas.push(['Limitações', c.limitacoes]);
    var dl = el('dl', { classe: 'dados' });
    linhas.forEach(function (l) { dl.appendChild(el('dt', { texto: l[0] })); dl.appendChild(el('dd', { texto: l[1] })); });
    var partes = [dl];
    if (c.evidencias.length) {
      partes.push(el('p', { classe: 'cenario-just' }, [el('strong', { texto: 'Evidências consideradas:' })]));
      partes.push(el('ul', { classe: 'cenario-evid' }, c.evidencias.map(function (e) {
        return el('li', { texto: e.descricao + ' — ' + (e.confirmada ? 'confirmada' : 'não confirmada') });
      })));
    }
    return el('div', { classe: 'cenario-ref' }, partes);
  }

  var ORIGEM_VALOR = { manual: 'manual', ia: 'sugerido por IA', calculo: 'cálculo pós-busca' };
  function tabelaCenario(c) {
    var linhas = c.setores.slice().sort(function (a, b) { return Number(b.poa) - Number(a.poa) || a.setor_nome.localeCompare(b.setor_nome, 'pt-BR'); }).map(function (i) {
      return celulas([
        el('span', null, [i.setor_nome, i.setor_id ? null : el('small', { classe: 'muted', texto: ' (setor excluído)' })]),
        pct(Number(i.poa)),
        i.area_m2 ? (i.area_m2 / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 3 }) + ' km²' : '—',
        i.origem === 'ia' ? 'sugerido por IA, revisado por ' + (i.ia_revisado_por_nome || '—') : (ORIGEM_VALOR[i.origem] || 'manual'),
        i.justificativa ? el('small', { classe: 'muted', texto: i.justificativa }) : '',
      ]);
    });
    var soma = M.somaPoa(c.setores.map(function (i) { return i.setor_id ? Number(i.poa) : 0; }));
    linhas.push(celulas([el('em', { texto: 'Fora da área' }), pct(c.poa_fora != null ? Number(c.poa_fora) : Math.max(0, 1 - soma)),
      '—', c.poa_fora_origem === 'ia' ? 'sugerido por IA, revisado por ' + (c.aprovada_por_nome || '—') : (ORIGEM_VALOR[c.poa_fora_origem] || 'manual'), '']));
    return tabela(['Setor', 'POA', 'Área', 'Origem', 'Justificativa'], linhas);
  }

  /* ---------- IA opcional (sugestões; o responsável decide) -------------- */
  // Chama /api/poa-ia (a chave da IA fica só no servidor). Devolve { ok, dados } ou { ok: false, mensagem }.
  async function pedirIa(modo, contexto) {
    var sessao = null;
    try { sessao = (await C.cliente.auth.getSession()).data.session; } catch (e) { /* sem sessão */ }
    if (!sessao) return { ok: false, mensagem: 'Entre de novo na sua conta para usar a IA.' };
    try {
      var r = await fetch('/api/poa-ia', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessao.access_token },
        body: JSON.stringify({ modo: modo, operacao_id: P.op().id, contexto: contexto }) });
      var corpo = await r.json().catch(function () { return {}; });
      if (!r.ok) return { ok: false, mensagem: corpo.mensagem || 'A IA não respondeu agora. Preencha manualmente.' };
      return { ok: true, dados: corpo };
    } catch (e) { return { ok: false, mensagem: 'Sem conexão com a IA agora. Preencha manualmente.' }; }
  }
  function centroDoSetor(s) {
    if (s.forma === 'circulo') return [s.centro_lat, s.centro_lng];
    var pts = s.pontos || [];
    if (!pts.length) return null;
    return [pts.reduce(function (a, p) { return a + p[0]; }, 0) / pts.length, pts.reduce(function (a, p) { return a + p[1]; }, 0) / pts.length];
  }
  function setorParaIa(s) {
    return { id: s.id, nome: s.nome, area_km2: Math.round(P.areaSetorM2(s) / 1e4) / 100, centro: centroDoSetor(s), observacoes: s.observacoes || '' };
  }
  // Contexto do POA: descrição da operação, ficha da vítima (sem nome/CPF/telefone), último ponto conhecido, observações, relatos e evidências
  function contextoPoaIa(vitimaId, setores, extra) {
    var op = P.op() || {}, v = est.vitimas.find(function (x) { return x.id === vitimaId; }) || {};
    var pontos = (P.pontosInteresse ? P.pontosInteresse() : []) || [];
    var ult = extra.pontoId ? pontos.find(function (p) { return p.id === extra.pontoId; }) : pontos.find(function (p) { return p.categoria === 'ULTIMA_LOCALIZACAO'; });
    return {
      operacao: { tipo: op.tipo || '', descricao: op.descricao || '', local: op.local_endereco || '', acionado_em: op.acionado_em || '' },
      vitima: { idade: v.idade == null ? null : Number(v.idade), sexo: v.sexo || '', perfil: Array.isArray(v.perfil) ? v.perfil : [], caracteristicas: v.caracteristicas || '', roupas: v.roupas || '', observacoes: v.observacoes || '' },
      ultimo_local: ult ? { titulo: ult.titulo, descricao: ult.descricao || '', lat: ult.lat, lng: ult.lng } : null,
      observacoes: setores.map(function (s) { return s.observacoes ? s.nome + ': ' + s.observacoes : ''; }).filter(Boolean),
      relatos: P.relatos ? P.relatos() : [], evidencias: extra.evidencias || [], hipoteses: extra.hipoteses || '', limitacoes: extra.limitacoes || '', horario_referencia: extra.horario || '',
      setores: setores.map(setorParaIa),
    };
  }

  /* ---------- Peças: dica (i) ------------------------------------------- */
  // Explicação curta atrás de um (i): passa o mouse (title) ou toca para abrir embaixo do rótulo.
  function dica(texto) {
    var tip = el('span', { classe: 'dica-texto', role: 'note', hidden: true, texto: texto });
    var b = el('button', { classe: 'dica', type: 'button', 'aria-label': 'Explicação', title: texto, texto: 'i' });
    b.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); tip.hidden = !tip.hidden; });
    return el('span', { classe: 'dica-caixa' }, [b, tip]);
  }
  function rotuloComDica(texto, para, textoDica) {
    return el('label', { classe: 'rotulo', for: para || null }, [texto, textoDica ? dica(textoDica) : null]);
  }
  var DICA_GERAL = 'POA: chance de a pessoa estar em cada setor. POD: chance de a busca achá-la se ela estiver ali; vem do registro da equipe, nunca do GPS. POS = POA × POD: chance de localizar nesta busca (não é chance de sobrevivência).';

  /* ---------- Tela principal: painel POA/POD (botão do topo) ------------- */
  var ABAS = [['poa', 'POA'], ['buscas', 'Missões'], ['versoes', 'Versões']];

  function abrir(vitimaId) {
    if (vitimaId) est.vitimaSel = vitimaId;
    var corpo = el('div', { classe: 'poa-painel' });
    var fechar;
    est.editorSujo = false;
    function fechando() { est.renderAtual = null; est.editorSujo = false; }

    function rodape() {
      return UI.rodape([el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]);
    }

    function abaPoa(vid, ap, rasc, editavel) {
      if (editavel) return montarEditor(vid, function () { est.editorSujo = false; carregar().then(function () { desenhar(); }); });
      var caixa = el('div', { classe: 'poa-leitura' });
      if (!ap) { caixa.appendChild(aviso('Sem versão publicada.')); return caixa; }
      var soma = M.somaPoa(ap.setores.map(function (i) { return i.setor_id ? Number(i.poa) : 0; }));
      caixa.appendChild(el('ul', { classe: 'poa-lista-leitura' }, ap.setores.slice().sort(function (a, b) { return Number(b.poa) - Number(a.poa); }).map(function (i) {
        return el('li', null, [el('span', { texto: i.setor_nome }), el('strong', { texto: pct(Number(i.poa)) }), i.justificativa ? el('small', { classe: 'muted', texto: i.justificativa }) : null]);
      }).concat([el('li', { classe: 'poa-fora' }, [el('span', { texto: 'Fora da área' }), el('strong', { texto: pct(Math.max(0, 1 - soma)) })])])));
      return caixa;
    }

    function abaMissoes(vid) {
      var sec = el('div', { classe: 'poa-sec' });
      if (est.semMissoes) { sec.appendChild(aviso('Faltam as migrações 038 e 039 no banco.')); return sec; }
      if (podeAlterar()) sec.appendChild(el('div', { classe: 'poa-acoes-topo' }, [el('button', { classe: 'btn btn-prob', type: 'button', id: 'cenario-registrar', texto: 'Nova missão', onclick: function () { abrirMissao({ aoConcluir: desenhar }); } })]));
      var visiveis = est.missoes.filter(function (m) { return !m.vitima_id || m.vitima_id === vid; });
      var ordem = { planejada: 0, concluida: 1, cancelada: 2 };
      visiveis.sort(function (a, b) { return ordem[a.estado] - ordem[b.estado] || (a.estado === 'planejada' ? C.paraMs(a.criada_em) - C.paraMs(b.criada_em) : C.paraMs(b.criada_em) - C.paraMs(a.criada_em)); });
      if (!visiveis.length) sec.appendChild(aviso('Nenhuma missão de busca.'));
      else sec.appendChild(el('ul', { classe: 'poa-missoes' }, visiveis.map(function (m) { return cartaoMissao(m, desenhar); })));
      var antigos = est.registros.filter(function (r) { return !r.vitima_id || r.vitima_id === vid; });
      if (antigos.length) {
        sec.appendChild(el('details', { classe: 'cenario-versao' }, [
          el('summary', { texto: 'Registros anteriores (' + antigos.length + ')' }),
          el('p', { classe: 'muted', texto: 'Formato antigo, por setor. Ficam guardados, mas não entram mais no cálculo do POA.' }),
          el('ul', { classe: 'pod-buscas' }, antigos.slice().reverse().map(function (r) {
            return el('li', { texto: C.hora(r.registrado_em, false) + ' · ' + r.setor_nome + ' · ' + (r.equipe || '—') + ': ' + (r.pod == null ? 'POD não estimada' : 'POD ' + pct(Number(r.pod))) + (r.anulado_em ? ' (anulado)' : '') });
          })),
        ]));
      }
      return sec;
    }

    function abaVersoes(vid, ap) {
      var sec = el('div', { classe: 'poa-sec' });
      if (ap) {
        sec.appendChild(el('h3', { texto: textoAprovacao(ap) }));
        sec.appendChild(tabelaCenario(ap));
        sec.appendChild(el('details', { classe: 'cenario-versao' }, [el('summary', { texto: 'Referência e hipóteses' }), el('p', { classe: 'cenario-just' }, [el('strong', { texto: 'Justificativa: ' }), ap.justificativa]), blocoReferencia(ap)]));
      } else sec.appendChild(aviso('Sem versão publicada.'));
      var vers = versoesDa(vid).slice().reverse();
      if (vers.length) {
        sec.appendChild(el('h3', { texto: 'Histórico' }));
        vers.forEach(function (c) {
          var m = c.missao_id ? est.missoes.find(function (x) { return x.id === c.missao_id; }) : null;
          sec.appendChild(el('details', { classe: 'cenario-versao' }, [
            el('summary', { texto: (c.estado === 'aprovada' ? textoAprovacao(c) : 'Rascunho da versão ' + c.numero) + (m ? ' · calculada: busca negativa em ' + m.setor_nome : '') }),
            el('p', { classe: 'cenario-just' }, [el('strong', { texto: 'Justificativa: ' }), c.justificativa || '—']),
            blocoReferencia(c),
            tabelaCenario(c),
          ]));
        });
      }
      sec.appendChild(el('details', { classe: 'pod-formulas' }, [
        el('summary', { texto: 'Como é calculado' }),
        el('p', { texto: 'Cada busca negativa gera uma nova versão: q = POD × cobertura no setor pesquisado (0 nos demais); r = POA × (1 − q); novo POA = r ÷ Σr, com "Fora da área" entre os valores. Sem POD, não recalcula.' }),
        el('p', { texto: 'POS da missão = POA do setor × POD da missão. O app nunca soma PODs de missões diferentes: cada missão atualiza a versão vigente, uma depois da outra. O GPS não entra.' }),
      ]));
      return sec;
    }

    function desenhar() {
      corpo.innerHTML = '';
      corpo.appendChild(el('h2', { id: 'modal-titulo', classe: 'poa-titulo' }, ['POA/POD', dica(DICA_GERAL)]));
      if (est.ausente) {
        corpo.appendChild(aviso('Faltam as migrações 033 e 034 no banco.'));
        corpo.appendChild(rodape());
        return;
      }
      if (est.erro) corpo.appendChild(aviso('Não foi possível atualizar: ' + est.erro));
      if (!est.vitimas.length) {
        corpo.appendChild(aviso('Cadastre a vítima em "Dados da operação": o cenário é feito por vítima.'));
        corpo.appendChild(rodape());
        return;
      }
      if (!est.vitimaSel || !est.vitimas.some(function (v) { return v.id === est.vitimaSel; })) est.vitimaSel = est.vitimas[0].id;
      var vid = est.vitimaSel;
      var ap = aprovadaDa(vid), rasc = rascunhoDa(vid), loc = localizacaoDa(vid);
      var editavel = podeAlterar() && !loc;

      var linhaTopo = [];
      if (est.vitimas.length > 1) {
        var sel = el('select', { classe: 'campo', id: 'cenario-vitima', 'aria-label': 'Vítima' }, est.vitimas.map(function (v) {
          return el('option', { value: v.id, selected: v.id === vid ? true : null, texto: v.nome + (localizacaoDa(v.id) ? ' (localizada)' : '') });
        }));
        sel.addEventListener('change', function () { est.vitimaSel = sel.value; est.editorSujo = false; desenhar(); });
        linhaTopo.push(sel);
      } else linhaTopo.push(el('strong', { texto: nomeVitima(vid) }));
      linhaTopo.push(el('span', { classe: 'selo selo-prob', texto: ap ? 'Vigente: v' + ap.numero + ' · ref. ' + C.hora(ap.horario_referencia || ap.aprovada_em, false) : 'Sem versão publicada' }));
      if (rasc) linhaTopo.push(el('span', { classe: 'selo selo-prob-rasc', texto: 'Rascunho v' + rasc.numero }));
      if (ap && P.camadaProbabilidade) {
        var ligada = est.camadaVitima === vid;
        linhaTopo.push(el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'cenario-camada', 'aria-pressed': String(ligada), texto: ligada ? 'Ocultar no mapa' : 'Ver no mapa',
          onclick: function () { est.camadaVitima = ligada ? null : vid; atualizarCamada(); desenhar(); } }));
      }
      corpo.appendChild(el('div', { classe: 'poa-cab' }, linhaTopo));
      if (loc) corpo.appendChild(aviso('Vítima localizada (' + (loc.condicao === 'obito' ? 'óbito' : 'com vida') + ') às ' + C.hora(loc.registrado_em, false) + ': cenário só para consulta.', 'nota nota-ok'));

      if (rasc && ap && rasc.base_numero !== ap.numero) corpo.appendChild(aviso('A versão vigente (v' + ap.numero + ') é mais nova que a base deste rascunho. Revise os valores e salve o rascunho de novo antes de publicar.'));
      var abas = el('div', { classe: 'poa-abas', role: 'tablist' }, ABAS.map(function (a) {
        return el('button', { classe: 'poa-aba', type: 'button', role: 'tab', id: 'poa-aba-' + a[0], 'aria-selected': String(est.aba === a[0]), texto: a[1],
          onclick: function () { if (est.aba === a[0]) return; est.aba = a[0]; est.editorSujo = false; desenhar(); } });
      }));
      corpo.appendChild(abas);
      corpo.appendChild(est.aba === 'buscas' ? abaMissoes(vid) : est.aba === 'versoes' ? abaVersoes(vid, ap) : abaPoa(vid, ap, rasc, editavel));
      corpo.appendChild(rodape());
    }

    if (!est.aba) est.aba = 'poa';
    // Atualização em tempo real não apaga o que está sendo digitado no editor
    est.renderAtual = function () { if (est.aba === 'poa' && est.editorSujo) return; desenhar(); };
    desenhar();
    fechar = UI.abrirModal(corpo, { aoFechar: fechando, fecharNoFundo: false });
  }

  /* ---------- Editor de POA (lista de setores → rascunho → publicação) -- */
  function montarEditor(vitimaId, aoConcluir) {
    var setores = (P.setores() || []).slice().sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
    if (!setores.length) return aviso('Desenhe um setor de busca para definir o POA.');
    var ap = aprovadaDa(vitimaId);
    var rasc = rascunhoDa(vitimaId);
    var origem = rasc || ap;   // o rascunho, ou a versão publicada de que a nova parte
    var inicial = {};
    if (origem) origem.setores.forEach(function (i) { if (i.setor_id) inicial[i.setor_id] = i; });
    var pontos = (P.pontosInteresse ? P.pontosInteresse() : []) || [];
    function marcarSujo() { est.editorSujo = true; erro.hidden = true; }

    var campos = setores.map(function (s) {
      var i = inicial[s.id];
      var poa = el('input', { classe: 'campo campo-poa', type: 'number', min: '0', max: '100', step: '0.1', inputmode: 'decimal', 'aria-label': 'POA do setor ' + s.nome + ' (%)',
        value: i ? String(Math.round(Number(i.poa) * 1000) / 10) : '' });
      var just = el('input', { classe: 'campo', maxlength: '500', placeholder: 'Justificativa', 'aria-label': 'Justificativa do setor ' + s.nome, value: i ? i.justificativa : '' });
      var tag = el('span', { classe: 'poa-ia-marca', hidden: true });
      return { s: s, poa: poa, just: just, tag: tag, ia: false };
    });
    var somaInicial = origem ? origem.setores.reduce(function (a, i) { return a + (i.setor_id ? Number(i.poa) : 0); }, 0) : null;
    // "Fora da área" guardado na versão (038). Versão publicada antes disso: é o que sobra. Rascunho sem o valor: fica vazio, para você confirmar.
    var foraInicial = !origem ? '' : origem.poa_fora != null ? String(Math.round(Number(origem.poa_fora) * 1000) / 10)
      : (origem.estado === 'aprovada' ? String(Math.max(0, Math.round((1 - somaInicial) * 1000) / 10)) : '');
    var fora = el('input', { classe: 'campo campo-poa', id: 'poa-fora', type: 'number', min: '0', max: '100', step: '0.1', inputmode: 'decimal', 'aria-label': 'POA fora da área (%)', value: foraInicial });

    var geral = el('textarea', { classe: 'campo', id: 'cenario-just', rows: '2', maxlength: '2000', placeholder: 'Por que esta distribuição?' });
    geral.value = origem && rasc ? rasc.justificativa : '';
    var hip = el('textarea', { classe: 'campo', id: 'cenario-hip', rows: '2', maxlength: '2000', placeholder: 'Deslocamento ou permanência provável' });
    hip.value = origem ? origem.hipoteses : '';
    var lim = el('textarea', { classe: 'campo', id: 'cenario-lim', rows: '2', maxlength: '1000', placeholder: 'O que não se sabe' });
    lim.value = origem ? origem.limitacoes : '';
    var conf = el('select', { classe: 'campo', id: 'cenario-conf' }, [el('option', { value: '', texto: 'não informada' })].concat(Object.keys(CONFIANCA).map(function (k) {
      return el('option', { value: k, selected: origem && origem.confianca === k ? true : null, texto: CONFIANCA[k] });
    })));
    var origemPoa = el('select', { classe: 'campo', id: 'cenario-origem' }, ['julgamento_comando', 'consenso_documentado'].map(function (k) {
      return el('option', { value: k, selected: origem && origem.origem_poa === k ? true : null, texto: ORIGENS[k] });
    }));
    var hr = el('input', { classe: 'campo', id: 'cenario-hr', type: 'datetime-local', value: dataLocal(origem && origem.horario_referencia ? C.paraMs(origem.horario_referencia) : Date.now()) });
    var selPonto = el('select', { classe: 'campo', id: 'cenario-ponto' }, [el('option', { value: '', texto: 'não definido' })].concat(pontos.slice().sort(function (a, b) {
      return (a.categoria === 'ULTIMA_LOCALIZACAO' ? 0 : 1) - (b.categoria === 'ULTIMA_LOCALIZACAO' ? 0 : 1);
    }).map(function (p) { return el('option', { value: p.id, selected: origem && origem.ponto_confiavel_id === p.id ? true : null, texto: rotuloPonto(p) }); })));

    // evidências: pontos de interesse do mapa (com situação de confirmação) e anotações livres
    var evCampos = [];
    var listaEv = el('div', { classe: 'cenario-evid-lista' });
    function linhaEvidencia(e) {
      var marcar = el('input', { type: 'checkbox', checked: e.marcada ? true : null, 'aria-label': 'Considerar: ' + e.texto });
      var confirm = el('input', { type: 'checkbox', checked: e.confirmada ? true : null, 'aria-label': 'Confirmada: ' + e.texto });
      var texto = e.livre ? el('input', { classe: 'campo', maxlength: '300', value: e.texto, 'aria-label': 'Evidência', placeholder: 'Ex.: relato do vizinho' }) : el('span', { texto: e.texto });
      var item = { e: e, marcar: marcar, conf: confirm, texto: texto, linha: null };
      var rem = e.livre ? el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Remover', onclick: function () { evCampos = evCampos.filter(function (x) { return x !== item; }); item.linha.remove(); } }) : null;
      item.linha = el('div', { classe: 'cenario-evid-linha' }, [el('label', null, [marcar, ' usar']), texto, el('label', null, [confirm, ' confirmada']), rem]);
      return item;
    }
    function addEvidencia(e) { var it = linhaEvidencia(e); evCampos.push(it); listaEv.appendChild(it.linha); }
    var jaUsadas = {};
    if (origem) origem.evidencias.forEach(function (ev) { if (ev.ponto_id) jaUsadas[ev.ponto_id] = ev; });
    pontos.forEach(function (p) { var u = jaUsadas[p.id]; addEvidencia({ pontoId: p.id, texto: rotuloPonto(p), marcada: Boolean(u), confirmada: u ? u.confirmada : false }); });
    if (origem) origem.evidencias.filter(function (ev) { return !ev.ponto_id; }).forEach(function (ev) { addEvidencia({ livre: true, texto: ev.descricao, marcada: true, confirmada: ev.confirmada }); });

    var erro = el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var soma = el('div', { classe: 'poa-soma', role: 'status', 'aria-live': 'polite' });
    var sobrep = el('p', { classe: 'nota', role: 'status', hidden: true });

    // valores em décimos de ponto percentual (inteiros): a soma precisa dar exatamente 1000 (100,0%), sem erro de ponto flutuante
    function decimos(input) {
      var t = input.value.trim().replace(',', '.');
      if (t === '') return 0;
      var v = Number(t);
      return isFinite(v) && v >= 0 && v <= 100 ? Math.round(v * 10) : NaN;
    }
    function totalDecimos() { return campos.concat([{ poa: fora }]).reduce(function (a, c) { return a + decimos(c.poa); }, 0); }
    function fmt(d) { return (d / 10).toLocaleString('pt-BR', { maximumFractionDigits: 1 }); }
    var btnSalvar = el('button', { classe: 'btn', type: 'button', id: 'cenario-salvar', texto: 'Salvar rascunho' });
    var btnAprovar = el('button', { classe: 'btn btn-prob', type: 'button', id: 'cenario-aprovar', texto: 'Publicar versão' });
    var btnDescartar = rasc ? el('button', { classe: 'btn btn-pequeno btn-perigo', type: 'button', id: 'cenario-descartar', texto: 'Descartar rascunho' }) : null;
    var ocupadoAgora = false;

    function atualizarTotal() {
      var t = totalDecimos();
      var invalido = isNaN(t);
      var ok = !invalido && t === 1000;
      soma.className = 'poa-soma ' + (ok ? 'poa-soma-ok' : 'poa-soma-pend');
      soma.innerHTML = '';
      soma.appendChild(el('span', { classe: 'poa-soma-rotulo', texto: 'Soma' }));
      soma.appendChild(el('strong', { classe: 'poa-soma-valor', id: 'poa-soma-valor', texto: invalido ? '—' : fmt(t) + '%' }));
      soma.appendChild(el('span', { classe: 'poa-soma-info', texto: invalido ? 'valor fora de 0 a 100' : ok ? '✓ pronto para publicar' : t < 1000 ? 'faltam ' + fmt(1000 - t) + '%' : 'passou ' + fmt(t - 1000) + '%' }));
      btnAprovar.disabled = ocupadoAgora || !ok;
      btnAprovar.title = ok ? '' : 'A soma, com "Fora da área", precisa dar exatamente 100%';
      var pares = M.sobreposicoes(campos.map(function (c) { var d = decimos(c.poa); return geometriaDoSetor(c.s, isNaN(d) ? 0 : d / 1000); }));
      sobrep.hidden = !pares.length;
      sobrep.textContent = pares.length ? 'Sobreposição: ' + pares.map(function (p) { return p.a + ' e ' + p.b + ' (' + Math.round(p.fracao * 100) + '%)'; }).join('; ') + '. Zere o POA de um deles para publicar.' : '';
    }
    [geral, hip, lim, hr, conf, origemPoa, selPonto].concat(campos.map(function (c) { return c.just; })).forEach(function (x) { x.addEventListener('input', marcarSujo); });
    campos.concat([{ poa: fora }]).forEach(function (c) { c.poa.addEventListener('input', function () { marcarSujo(); atualizarTotal(); }); });

    var campoFora = { poa: fora, just: null, tag: el('span', { classe: 'poa-ia-marca', hidden: true }), ia: false };
    // Marcação "sugerido por IA": valor e justificativa com borda tracejada, rótulo embaixo. Editar o valor devolve-o ao modo manual.
    function marcarIa(c, justificativa, insuficiente) {
      c.ia = !insuficiente;
      c.poa.classList.toggle('poa-sugerido', !insuficiente);
      if (c.just) c.just.classList.toggle('poa-sugerido', !insuficiente && Boolean(justificativa));
      c.tag.hidden = false;
      c.tag.textContent = insuficiente ? 'informação insuficiente' : 'sugerido por IA' + (justificativa && !c.just ? ': ' + justificativa : '');
      c.tag.classList.toggle('poa-ia-insuficiente', Boolean(insuficiente));
    }
    function limparIa(c) { c.ia = false; c.poa.classList.remove('poa-sugerido'); if (c.just) c.just.classList.remove('poa-sugerido'); c.tag.hidden = true; }
    campos.forEach(function (c) {
      var i = inicial[c.s.id];
      if (i && i.origem === 'ia') marcarIa(c, i.justificativa, false);
      c.poa.addEventListener('input', function () { limparIa(c); });
      c.just.addEventListener('input', function () { c.just.classList.remove('poa-sugerido'); });
    });
    if (origem && origem.poa_fora_origem === 'ia') marcarIa(campoFora, '', false);
    fora.addEventListener('input', function () { limparIa(campoFora); });
    var modeloIa = origem && origem.ia_modelo || null;
    var linhas = campos.map(function (c) {
      return el('div', { classe: 'poa-linha' }, [el('span', { classe: 'poa-nome', texto: c.s.nome }), el('div', { classe: 'poa-campo' }, [c.poa, el('span', { classe: 'poa-pct', texto: '%' })]), c.just, el('div', { classe: 'poa-linha-ia' }, [c.tag])]);
    });
    linhas.push(el('div', { classe: 'poa-linha poa-linha-fora' }, [
      el('span', { classe: 'poa-nome' }, ['Fora da área', dica('Probabilidade de a pessoa estar fora de todos os setores desenhados. Entra na soma de 100%.')]),
      el('div', { classe: 'poa-campo' }, [fora, el('span', { classe: 'poa-pct', texto: '%' })]),
      el('div', { classe: 'poa-linha-ia' }, [campoFora.tag]),
    ]));

    var msgIa = el('p', { classe: 'poa-ia-msg', role: 'status', hidden: true });
    var btnIa = el('button', { classe: 'btn btn-pequeno btn-ia', type: 'button', id: 'cenario-ia', texto: 'Sugerir com IA',
      title: 'A IA só sugere, com uma frase de justificativa. Nada é publicado: você revisa, ajusta e publica.',
      onclick: async function () {
        btnIa.disabled = true; msgIa.hidden = false; msgIa.textContent = 'A IA está analisando…'; msgIa.classList.remove('poa-ia-erro');
        var ev = evCampos.filter(function (x) { return x.marcar.checked && (x.e.livre ? x.texto.value.trim() : true); }).map(function (x) { return { descricao: x.e.livre ? x.texto.value.trim() : x.e.texto, confirmada: x.conf.checked }; });
        var r = await pedirIa('poa', contextoPoaIa(vitimaId, setores, { pontoId: selPonto.value || null, evidencias: ev, hipoteses: hip.value.trim(), limitacoes: lim.value.trim(), horario: hr.value ? new Date(hr.value).toISOString() : '' }));
        btnIa.disabled = false;
        if (!r.ok) { msgIa.textContent = r.mensagem; msgIa.classList.add('poa-ia-erro'); return; }
        var puladas = 0, aplicadas = 0, insuf = 0;
        r.dados.setores.forEach(function (sg) {
          var c = campos.find(function (x) { return x.s.id === sg.setor_id; });
          if (!c) return;
          var manual = c.poa.value.trim() !== '' && !c.ia;   // o que você digitou não é sobrescrito
          if (manual) { puladas++; return; }
          if (sg.insuficiente || sg.poa == null) { c.poa.value = ''; c.just.value = ''; marcarIa(c, '', true); insuf++; return; }
          c.poa.value = String(Math.round(sg.poa * 1000) / 10); c.just.value = sg.justificativa; marcarIa(c, sg.justificativa, false); aplicadas++;
        });
        var f = r.dados.fora;
        if (f && !(fora.value.trim() !== '' && !campoFora.ia)) {
          if (f.insuficiente || f.poa == null) { fora.value = ''; marcarIa(campoFora, '', true); } else { fora.value = String(Math.round(f.poa * 1000) / 10); marcarIa(campoFora, f.justificativa, false); aplicadas++; }
        }
        if (aplicadas) modeloIa = r.dados.modelo || null;
        marcarSujo(); atualizarTotal();
        msgIa.textContent = 'Sugestão da IA aplicada: revise, ajuste e publique.' + (insuf ? ' ' + insuf + ' setor(es) sem dados suficientes.' : '') + (puladas ? ' ' + puladas + ' setor(es) já preenchido(s) foram mantidos.' : '') + (r.dados.aviso ? ' ' + r.dados.aviso : '');
      } });
    var atalhos = [
      btnIa,
      el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'cenario-distribuir', texto: 'Dividir pela área',
        title: 'Distribuição uniforme proporcional à área. É só um ponto de partida: ajuste e justifique.',
        onclick: function () {
          var d = M.distribuirPelaArea(setores.map(function (s) { return { id: s.id, areaM2: P.areaSetorM2(s) }; }));
          campos.forEach(function (c) { c.poa.value = String(Math.round(d[c.s.id] * 1000) / 10); limparIa(c); });
          fora.value = '0'; limparIa(campoFora); marcarSujo(); atualizarTotal();
        } }),
    ];
    function montarDados() {
      var t = totalDecimos();
      if (isNaN(t)) throw new Error('Cada POA deve ficar entre 0 e 100%.');
      if (t > 1000) throw new Error('A soma passou de 100%. Reduza algum valor.');
      var hrMs = hr.value ? new Date(hr.value).getTime() : null;
      return {
        justificativa: geral.value.trim(),
        hipoteses: hip.value.trim(), limitacoes: lim.value.trim(), confianca: conf.value || null, origem_poa: origemPoa.value,
        horario_referencia: hrMs != null && !isNaN(hrMs) ? new Date(hrMs).toISOString() : null,
        ponto_confiavel_id: selPonto.value || null,
        atualizado_em: rasc ? rasc.atualizado_em : null,
        poa_fora: decimos(fora) / 1000, poa_fora_origem: campoFora.ia ? 'ia' : 'manual',
        ia_modelo: (campoFora.ia || campos.some(function (c) { return c.ia; })) ? modeloIa : null,
        setores: campos.filter(function (c) { return decimos(c.poa) > 0 || c.just.value.trim(); }).map(function (c) {
          return { setor_id: c.s.id, poa: decimos(c.poa) / 1000, justificativa: c.just.value.trim(), origem: c.ia ? 'ia' : 'manual' };
        }),
        evidencias: evCampos.filter(function (x) { return x.marcar.checked && (x.e.livre ? x.texto.value.trim() : true); }).map(function (x) {
          return x.e.livre ? { descricao: x.texto.value.trim(), confirmada: x.conf.checked } : { ponto_id: x.e.pontoId, descricao: x.e.texto, confirmada: x.conf.checked };
        }),
      };
    }
    function ocupado(sim) { ocupadoAgora = sim; [btnSalvar, btnDescartar].forEach(function (b) { if (b) b.disabled = sim; }); atualizarTotal(); }

    var chaveAprovacao = chaveNova();   // a mesma chave se a publicação for reenviada: o servidor não duplica
    async function salvar(aprovar) {
      erro.hidden = true;
      var dados;
      try { dados = montarDados(); } catch (e) { erro.textContent = e.message; erro.hidden = false; return; }
      if (aprovar) {
        if (totalDecimos() !== 1000) { erro.textContent = 'A soma, com "Fora da área", precisa dar exatamente 100%.'; erro.hidden = false; return; }
        if (dados.justificativa.length < 10) { erro.textContent = 'Escreva a justificativa da versão (mín. 10 caracteres).'; erro.hidden = false; geral.focus(); return; }
        if (!dados.setores.some(function (s) { return s.poa > 0; })) { erro.textContent = 'Ao menos um setor precisa ter POA maior que zero.'; erro.hidden = false; return; }
        if (!sobrep.hidden) { erro.textContent = 'Há setores sobrepostos: zere o POA de um deles.'; erro.hidden = false; return; }
        var temIa = campoFora.ia || campos.some(function (c) { return c.ia && decimos(c.poa) > 0; });
        var okAprovar = await UI.confirmar({
          titulo: 'Publicar esta versão?',
          texto: 'Depois de publicada, a versão não pode ser alterada. Para mudar, você publica uma nova versão; o histórico fica no diário.'
            + (temIa ? ' Os valores sugeridos por IA ficam registrados como "sugerido por IA, revisado por" você.' : ''),
          ok: 'Publicar versão', empilhar: true,
        });
        if (!okAprovar) return;
      }
      ocupado(true);
      try {
        var r = await C.rpc('cenario_salvar_rascunho', { p_vitima: vitimaId, p_dados: dados });
        if (aprovar) {
          await C.rpc('cenario_aprovar', { p_cenario: r.cenario.id, p_revisao: r.cenario.atualizado_em, p_chave: chaveAprovacao });
          UI.aviso('Versão ' + r.cenario.numero + ' publicada.', 'ok');
        } else {
          UI.aviso('Rascunho salvo (ainda não vale nos cálculos).', 'ok');
        }
        est.editorSujo = false;
        if (aoConcluir) aoConcluir();
      } catch (e) {
        erro.textContent = e.message; erro.hidden = false;
        if (e.codigo === 'cenario_versao_desatualizada') { erro.textContent += ' Feche e abra o painel para ver a versão do colega.'; }
        ocupado(false);
      }
    }
    btnSalvar.addEventListener('click', function () { salvar(false); });
    btnAprovar.addEventListener('click', function () { salvar(true); });
    if (btnDescartar) btnDescartar.addEventListener('click', async function () {
      var ok = await UI.confirmar({ titulo: 'Descartar o rascunho?', texto: 'As versões publicadas não são afetadas.', ok: 'Descartar rascunho', perigo: true, empilhar: true });
      if (!ok) return;
      ocupado(true);
      try {
        await C.rpc('cenario_descartar_rascunho', { p_cenario: rasc.id });
        UI.aviso('Rascunho descartado.', 'ok');
        est.editorSujo = false;
        if (aoConcluir) aoConcluir();
      } catch (e) { erro.textContent = e.message; erro.hidden = false; ocupado(false); }
    });

    var numero = rasc ? rasc.numero : ((versoesDa(vitimaId).slice(-1)[0] || { numero: 0 }).numero + 1);
    var corpo = el('div', { classe: 'poa-editor' }, [
      el('div', { classe: 'poa-editor-cab' }, [
        el('strong', { texto: 'Versão ' + numero + (rasc ? ' (rascunho)' : '') }),
        el('div', { classe: 'poa-ref' }, [rotuloComDica('Referência', 'cenario-hr', 'A que momento este cenário se refere.'), hr]),
      ]),
      el('div', { classe: 'poa-atalhos' }, atalhos),
      msgIa,
      el('div', { classe: 'poa-lista' }, linhas),
      soma,
      sobrep,
      el('div', { classe: 'grupo' }, [rotuloComDica('Justificativa da versão', 'cenario-just', 'Obrigatória para publicar (mín. 10 caracteres). Ex.: última posição, relato da família, perfil, terreno.'), geral]),
      el('details', { classe: 'poa-mais' }, [
        el('summary', { texto: 'Mais detalhes' }),
        el('div', { classe: 'grupo' }, [rotuloComDica('Hipóteses', 'cenario-hip'), hip]),
        el('div', { classe: 'grupo' }, [rotuloComDica('Limitações', 'cenario-lim', 'O que não se sabe ou pode invalidar o cenário.'), lim]),
        el('div', { classe: 'grupo grupo-2col' }, [
          el('div', null, [rotuloComDica('Último ponto confiável', 'cenario-ponto'), selPonto]),
          el('div', null, [rotuloComDica('Sustentação', 'cenario-conf', 'Julgamento do comando sobre a qualidade dos dados; não é intervalo estatístico.'), conf]),
        ]),
        el('div', { classe: 'grupo' }, [rotuloComDica('Origem do POA', 'cenario-origem'), origemPoa]),
        el('div', { classe: 'grupo' }, [
          rotuloComDica('Evidências', null, 'Marque as que sustentam o cenário e se estão confirmadas. Relato não confirmado não vale como verificado.'),
          listaEv,
          el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'cenario-add-evidencia', texto: '+ Evidência', onclick: function () { addEvidencia({ livre: true, texto: '', marcada: true, confirmada: false }); marcarSujo(); } }),
        ]),
      ]),
      erro,
      el('div', { classe: 'poa-acoes' }, [btnDescartar, btnSalvar, btnAprovar]),
    ]);
    atualizarTotal();
    return corpo;
  }

  /* ---------- Missões de busca: o POD pertence à missão ------------------ */
  var RESULTADOS = { localizado: 'Localizado', nao_localizado: 'Não localizado', nao_concluido: 'Não concluído' };

  function efeitosDe(missaoId) { return est.efeitos.filter(function (e) { return e.missao_id === missaoId; }); }
  function vitimasAtivas() { return est.vitimas.filter(function (v) { return !localizacaoDa(v.id); }); }
  function alvosDaMissao(m) { return m.vitima_id ? [m.vitima_id] : vitimasAtivas().map(function (v) { return v.id; }); }
  function itemDoSetor(vitimaId, setorId) {
    var ap = aprovadaDa(vitimaId);
    return ap ? ap.setores.find(function (i) { return i.setor_id === setorId; }) || null : null;
  }
  function numeroVersao(cenarioId) {
    var c = est.cenarios.find(function (x) { return x.id === cenarioId; });
    return c ? c.numero : null;
  }
  // Entrada de posBusca a partir da versão vigente da vítima
  function entradaPos(vitimaId, setorId, pod, cobertura) {
    var ap = aprovadaDa(vitimaId);
    if (!ap) return null;
    return { setores: ap.setores.map(function (i) { return { id: i.setor_id || i.id, poa: Number(i.poa) }; }), fora: ap.poa_fora != null ? Number(ap.poa_fora) : undefined, setorId: setorId, pod: pod, cobertura: cobertura };
  }
  // Marca "sugerido por IA, revisado por…" ao lado de um valor
  function seloOrigem(origem, revisor) {
    return origem === 'ia' ? el('span', { classe: 'selo selo-ia', title: 'Sugerido por IA e revisado por ' + (revisor || 'um responsável'), texto: 'sugerido por IA · revisado por ' + (revisor || '—') }) : null;
  }

  function cartaoMissao(m, aoMudar) {
    var concluida = m.estado === 'concluida', cancelada = m.estado === 'cancelada';
    var pod = concluida ? m.pod_final : m.pod_planejada;
    var origem = concluida ? m.pod_final_origem : m.pod_planejada_origem, revisor = concluida ? m.pod_final_revisor : m.pod_planejada_revisor;
    var efs = efeitosDe(m.id);
    var estadoTxt = cancelada ? 'Cancelada' : concluida ? RESULTADOS[m.resultado] : 'Planejada';
    var chip = el('span', { classe: 'selo ' + (cancelada ? 'selo-neutro' : concluida ? (m.resultado === 'localizado' ? 'selo-ok' : 'selo-prob') : 'selo-prob-rasc'), texto: estadoTxt });
    var linhas = [
      el('p', { classe: 'poa-meta', texto: m.metodo + ' · área atribuída ' + pct(Number(m.area_atribuida_fracao), 0) + ' do setor' + (m.area_texto ? ' (' + m.area_texto + ')' : '') }),
      el('p', null, [el('strong', { texto: pod == null ? 'POD não estimada' : 'POD ' + pct(Number(pod)) }), ' ', seloOrigem(origem, revisor)]),
    ];
    // POS = POA do setor × POD da missão: "chance de localizar nesta busca" (não é chance de sobrevivência)
    var pos = [];
    if (concluida && efs.length) {
      efs.forEach(function (e) { pos.push(nomeVitima(e.vitima_id) + ': ' + pct(Number(e.pos)) + ' (POA ' + pct(Number(e.poa_setor_antes)) + ' × POD ' + pct(Number(e.q)) + ')'); });
    } else if (!concluida && !cancelada && pod != null) {
      alvosDaMissao(m).forEach(function (vid) {
        var i = itemDoSetor(vid, m.setor_id);
        if (i) pos.push(nomeVitima(vid) + ': ' + pct(Number(i.poa) * Number(pod) * Number(m.area_atribuida_fracao)) + ' (POA ' + pct(Number(i.poa)) + ' × POD ' + pct(Number(pod) * Number(m.area_atribuida_fracao)) + ')');
      });
    }
    if (pos.length) linhas.push(el('p', { classe: 'poa-pos' }, [el('span', { classe: 'muted', texto: 'Chance de localizar nesta busca ' }), dica('POS = POA do setor × POD da missão. É a chance de esta busca localizar a pessoa; não é chance de sobrevivência.'), ' ' + pos.join(' · ')]));
    if (concluida) {
      linhas.push(el('p', { classe: 'muted', texto: 'Execução real: ' + (m.cobertura_real_fracao != null ? pct(Number(m.cobertura_real_fracao), 0) + ' do setor' : 'cobertura não informada')
        + (m.fim_real ? ' · fim ' + C.hora(m.fim_real, false) : '') + ' · registrado por ' + m.resultado_por_nome + ' às ' + C.hora(m.resultado_em, false) + (m.resultado_obs ? ' · ' + m.resultado_obs : '') }));
      var estadoCalc = m.calculo_estado;
      if (estadoCalc === 'aplicado') linhas.push(el('p', { classe: 'poa-calc poa-calc-ok', texto: '✓ POA recalculado: ' + efs.map(function (e) { var n = numeroVersao(e.cenario_depois_id); return nomeVitima(e.vitima_id) + ' → versão ' + (n || '—') + ' (' + pct(Number(e.poa_setor_antes)) + ' → ' + pct(Number(e.poa_setor_depois)) + ')'; }).join(' · ') }));
      else if (estadoCalc === 'pendente_pod') linhas.push(el('p', { classe: 'poa-calc poa-calc-pend', texto: 'Pendente: POD não estimada. O POA não foi recalculado.' }));
      else if (estadoCalc === 'inconsistente') linhas.push(el('p', { classe: 'poa-calc poa-calc-erro', texto: '⚠ ' + m.calculo_detalhe }));
      else if (m.calculo_detalhe) linhas.push(el('p', { classe: 'muted', texto: m.calculo_detalhe }));
    }
    if (cancelada) linhas.push(el('p', { classe: 'muted', texto: 'Cancelada por ' + m.cancelada_por_nome + ': ' + m.cancelada_motivo }));
    var acoes = [];
    if (podeAlterar()) {
      if (m.estado === 'planejada') {
        acoes.push(el('button', { classe: 'btn btn-pequeno btn-prob', type: 'button', texto: 'Registrar resultado', onclick: function () { abrirResultado(m); } }));
        acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Cancelar', onclick: async function () {
          var r = await UI.confirmar({ titulo: 'Cancelar esta missão?', texto: 'Fica no histórico, com o motivo.', campo: { rotulo: 'Motivo', max: 500, obrigatorio: true }, ok: 'Cancelar missão', perigo: true, empilhar: true });
          if (!r) return;
          try { await C.rpc('busca_missao_cancelar', { p_missao: m.id, p_motivo: r.texto }); UI.aviso('Missão cancelada.', 'ok'); await carregar(); if (aoMudar) aoMudar(); } catch (e) { UI.aviso(e.message, 'erro', 7000); }
        } }));
      } else if (concluida && m.calculo_estado === 'pendente_pod') {
        acoes.push(el('button', { classe: 'btn btn-pequeno btn-prob', type: 'button', texto: 'Informar POD', onclick: function () { abrirPod(m); } }));
      }
    }
    return el('li', { classe: 'poa-missao poa-missao-' + m.estado, 'data-missao': m.id }, [
      el('div', { classe: 'poa-missao-topo' }, [el('strong', { texto: m.setor_nome + ' · ' + m.equipe }), chip]),
      el('div', { classe: 'poa-missao-corpo' }, linhas),
      acoes.length ? el('div', { classe: 'poa-missao-acoes' }, acoes) : null,
    ]);
  }

  // Campo com rótulo, controle e ajuda curta, alinhado na grade do formulário
  function campo(rotulo, controle, o) {
    o = o || {};
    return el('div', { classe: 'poa-g' + (o.largo ? ' poa-g-largo' : ''), hidden: o.oculto ? true : null }, [rotuloComDica(rotulo, o.para, o.dica), controle, o.ajuda ? el('small', { classe: 'muted', texto: o.ajuda }) : null]);
  }
  function campoPct(id, valor, placeholder, rotuloAria) {
    return el('div', { classe: 'poa-campo' }, [el('input', { classe: 'campo', id: id, type: 'number', min: '0', max: '100', step: '0.1', inputmode: 'decimal', placeholder: placeholder || '', value: valor == null ? '' : String(valor), 'aria-label': rotuloAria || null }), el('span', { classe: 'poa-pct', texto: '%' })]);
  }
  function lerPct(id) {
    var t = document.getElementById(id).value.trim().replace(',', '.');
    if (t === '') return null;
    var v = Number(t);
    return isFinite(v) ? v / 100 : NaN;
  }

  /* ---------- Nova missão ------------------------------------------------ */
  function abrirMissao(o) {
    o = o || {};
    var setores = (P.setores() || []).slice().sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
    if (!setores.length) { UI.aviso('Desenhe um setor de busca antes de criar a missão.', 'erro', 7000); return; }
    var grupos = (P.grupos ? P.grupos() : []) || [];
    var chave = chaveNova();   // a mesma chave se o envio for repetido: o servidor não duplica
    var selSetor = el('select', { classe: 'campo', id: 'missao-setor' }, setores.map(function (s) { return el('option', { value: s.id, selected: s.id === o.setorId ? true : null, texto: s.nome }); }));
    var selVitima = el('select', { classe: 'campo', id: 'missao-vitima' }, [el('option', { value: '', texto: 'Todas' })].concat(vitimasAtivas().map(function (v) { return el('option', { value: v.id, texto: v.nome }); })));
    var equipe = el('input', { classe: 'campo', id: 'missao-equipe', maxlength: '60', list: 'missao-equipes', placeholder: 'Escolha ou digite', autocomplete: 'off' });
    var lista = el('datalist', { id: 'missao-equipes' }, grupos.map(function (g) { return el('option', { value: g.nome }); }));
    var metodo = el('select', { classe: 'campo', id: 'missao-metodo' }, [el('option', { value: '', texto: 'Escolha' })].concat(METODOS.map(function (m) { return el('option', { value: m, texto: m }); })));
    var area = campoPct('missao-area', 100, '100', 'Área atribuída (% do setor)');
    var areaTxt = el('input', { classe: 'campo', id: 'missao-area-txt', maxlength: '200', placeholder: 'Opcional: onde, dentro do setor' });
    var pod = campoPct('missao-pod', '', 'não estimada', 'POD estimada (%)');
    var base = el('textarea', { classe: 'campo', id: 'missao-base', rows: '2', maxlength: '1000', placeholder: 'Ex.: varredura em linha, 5 m entre buscadores; mata fechada' });
    var gBase = campo('Em que se baseia', base, { para: 'missao-base', oculto: true, largo: true });
    var estado = { origem: 'manual', ia: null };
    var tagOrigem = el('span', { classe: 'poa-ia-marca', hidden: true });
    var previa = el('p', { classe: 'poa-previa', role: 'status' });
    var erro = el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = el('button', { classe: 'btn btn-prob', type: 'submit', id: 'missao-salvar', texto: 'Criar missão' });
    var podInput = pod.querySelector('input');
    var msgIa = el('p', { classe: 'poa-ia-msg', role: 'status', hidden: true });
    var btnIa = el('button', { classe: 'btn btn-pequeno btn-ia', type: 'button', id: 'missao-ia', texto: 'Sugerir POD com IA', title: 'A IA só sugere, com uma frase de justificativa. Você revisa e decide.',
      onclick: async function () {
        if (!metodo.value) { msgIa.hidden = false; msgIa.classList.add('poa-ia-erro'); msgIa.textContent = 'Escolha o método antes de pedir a sugestão.'; return; }
        var ar = lerPct('missao-area');
        var st = setores.find(function (x) { return x.id === selSetor.value; });
        btnIa.disabled = true; msgIa.hidden = false; msgIa.classList.remove('poa-ia-erro'); msgIa.textContent = 'A IA está analisando…';
        var op = P.op() || {};
        var r = await pedirIa('pod', { operacao: { tipo: op.tipo || '', descricao: op.descricao || '' }, setor: { nome: st.nome, area_km2: Math.round(P.areaSetorM2(st) / 1e4) / 100, observacoes: st.observacoes || '' },
          equipe: equipe.value.trim(), metodo: metodo.value, area_fracao: ar == null || isNaN(ar) ? 1 : ar, area_texto: areaTxt.value.trim() });
        btnIa.disabled = false;
        if (!r.ok) { msgIa.classList.add('poa-ia-erro'); msgIa.textContent = r.mensagem; return; }
        if (r.dados.insuficiente || r.dados.pod == null) { msgIa.textContent = 'A IA respondeu: informação insuficiente para estimar o POD. Preencha manualmente.'; return; }
        podInput.value = String(Math.round(r.dados.pod * 1000) / 10);
        base.value = 'Sugestão da IA: ' + r.dados.justificativa;
        estado.origem = 'ia'; estado.ia = r.dados;
        podInput.classList.add('poa-sugerido'); base.classList.add('poa-sugerido');
        tagOrigem.hidden = false; tagOrigem.textContent = 'sugerido por IA · revise o valor e a base antes de criar';
        msgIa.textContent = 'Sugestão aplicada: ' + r.dados.justificativa;
        atualizar();
      } });
    base.addEventListener('input', function () { base.classList.remove('poa-sugerido'); });

    function atualizar() {
      var v = lerPct('missao-pod');
      gBase.hidden = !(v != null && !isNaN(v));
      var ar = lerPct('missao-area');
      var alvos = selVitima.value ? [selVitima.value] : vitimasAtivas().map(function (x) { return x.id; });
      var partes = [];
      alvos.forEach(function (vid) {
        var i = itemDoSetor(vid, selSetor.value);
        if (!i) return;
        partes.push(nomeVitima(vid) + ' ' + (v == null || isNaN(v) || ar == null || isNaN(ar) ? 'POS: informe o POD' : 'POS ' + pct(Number(i.poa) * v * ar) + ' (POA ' + pct(Number(i.poa)) + ')'));
      });
      previa.textContent = !partes.length ? 'Este setor não está na versão vigente (POA zero).' : v == null || isNaN(v) ? 'POD não estimada. ' + partes.join(' · ') : 'Chance de localizar nesta busca: ' + partes.join(' · ');
    }
    podInput.addEventListener('input', function () { estado.origem = 'manual'; estado.ia = null; tagOrigem.hidden = true; podInput.classList.remove('poa-sugerido'); base.classList.remove('poa-sugerido'); atualizar(); });
    [selSetor, selVitima].forEach(function (x) { x.addEventListener('change', atualizar); });
    area.querySelector('input').addEventListener('input', atualizar);

    var form = el('form', { classe: 'poa-form', novalidate: true }, [
      el('h2', { id: 'modal-titulo', texto: 'Nova missão de busca' }),
      el('div', { classe: 'poa-grid' }, [
        campo('Setor', selSetor, { para: 'missao-setor' }), campo('Vítima', selVitima, { para: 'missao-vitima' }),
        campo('Equipe', equipe, { para: 'missao-equipe' }), campo('Método', metodo, { para: 'missao-metodo' }),
        campo('Área atribuída', area, { para: 'missao-area', dica: 'Quanto do setor esta equipe vai cobrir. 100% = o setor inteiro.' }), campo('Descrição da área', areaTxt, { para: 'missao-area-txt' }),
        campo('POD estimada', pod, { para: 'missao-pod', dica: 'Chance de a equipe achar a pessoa SE ela estiver na área coberta. Vem da estimativa da equipe, nunca do GPS. Vazio = "POD não estimada" (não vira zero).', largo: true }),
        gBase,
      ]),
      el('div', { classe: 'poa-ia-linha' }, [btnIa, tagOrigem]),
      msgIa,
      previa, lista, erro,
      el('div', { classe: 'poa-acoes' }, [el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var v = lerPct('missao-pod'), ar = lerPct('missao-area');
      function falha(t) { erro.textContent = t; erro.hidden = false; }
      if (!equipe.value.trim()) return falha('Informe a equipe.');
      if (!metodo.value) return falha('Escolha o método.');
      if (ar == null || isNaN(ar) || ar <= 0 || ar > 1) return falha('A área atribuída deve ficar entre 1% e 100%.');
      if (v != null && (isNaN(v) || v < 0 || v > 1)) return falha('O POD deve ficar entre 0 e 100%.');
      if (v != null && base.value.trim().length < 5) { gBase.hidden = false; return falha('Diga em que o POD se baseia (pelo menos 5 caracteres).'); }
      var g = grupos.find(function (x) { return x.nome === equipe.value.trim(); });
      btn.disabled = true;
      try {
        await C.rpc('busca_missao_criar', { p_operacao: P.op().id, p_dados: {
          setor_id: selSetor.value, vitima_id: selVitima.value || null, grupo_id: g ? g.id : null, equipe: equipe.value.trim(), metodo: metodo.value,
          area_fracao: ar, area_texto: areaTxt.value.trim(), pod: v, pod_base: v == null ? '' : base.value.trim(), pod_origem: v == null ? 'manual' : estado.origem, chave_cliente: chave,
        } });
        UI.aviso('Missão criada.', 'ok');
        fechar(true);
        await carregar();
        if (o.aoConcluir) o.aoConcluir();
      } catch (e) { falha(e.message); btn.disabled = false; }
    });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false, empilhar: true });
    atualizar();
  }

  /* ---------- Resultado da missão (depois do retorno da equipe) ---------- */
  function abrirResultado(m) {
    var res = el('select', { classe: 'campo', id: 'res-resultado' }, Object.keys(RESULTADOS).map(function (k) { return el('option', { value: k, selected: k === 'nao_localizado' ? true : null, texto: RESULTADOS[k] }); }));
    var cob = campoPct('res-cobertura', Math.round(Number(m.area_atribuida_fracao) * 1000) / 10, '', 'Cobertura real (% do setor)');
    var ini = el('input', { classe: 'campo', id: 'res-ini', type: 'datetime-local' });
    var fim = el('input', { classe: 'campo', id: 'res-fim', type: 'datetime-local', value: dataLocal(Date.now()) });
    var pod = campoPct('res-pod', m.pod_planejada == null ? '' : Math.round(Number(m.pod_planejada) * 1000) / 10, 'não estimada', 'POD final (%)');
    var base = el('textarea', { classe: 'campo', id: 'res-base', rows: '2', maxlength: '1000', placeholder: 'Em que o POD se baseia' });
    base.value = m.pod_planejada == null ? '' : m.pod_planejada_base;
    var obs = el('textarea', { classe: 'campo', id: 'res-obs', rows: '2', maxlength: '1000', placeholder: 'Opcional: impedimentos, o que não foi observado, condições' });
    var gBase = campo('Em que se baseia', base, { para: 'res-base', largo: true });
    var gExec = el('div', { classe: 'poa-grid poa-grid-exec' }, [
      campo('Cobertura real', cob, { para: 'res-cobertura', dica: 'Quanto do setor a equipe realmente cobriu. O POD é o da área coberta.' }),
      campo('POD final', pod, { para: 'res-pod', dica: 'Pode ser o planejado ou outro, se a execução foi diferente. Vazio = "POD não estimada": o POA não é recalculado.' }),
      campo('Início real', ini, { para: 'res-ini' }), campo('Fim real', fim, { para: 'res-fim' }),
      gBase,
    ]);
    var previa = el('div', { classe: 'poa-previa', role: 'status' });
    var erro = el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = el('button', { classe: 'btn btn-prob', type: 'submit', id: 'res-salvar', texto: 'Registrar resultado' });
    var estado = { origem: m.pod_planejada_origem, revisor: m.pod_planejada_revisor };
    var podInput = pod.querySelector('input');
    var MOTIVOS_CALC = { pod_desconhecido: 'POD não estimada: o POA não será recalculado (ficará pendente).', z_zero: 'Inconsistência: Z = 0 (todo o POA no setor e POD de 100%). Nada será alterado.', invalido: 'Valores inválidos na versão vigente. Nada será alterado.', setor_fora_do_cenario: 'Este setor não está na versão vigente: o POA não muda.' };

    function atualizar() {
      var r = res.value;
      gExec.hidden = r === 'localizado';
      previa.innerHTML = '';
      if (r === 'localizado') { previa.appendChild(el('p', { texto: 'Registre o encontro em "Vítima encontrada". O POA não é recalculado.' })); return; }
      var c = lerPct('res-cobertura'), p = lerPct('res-pod');
      if (r === 'nao_concluido' && (c == null || isNaN(c))) { previa.appendChild(el('p', { texto: 'Sem cobertura real informada: o POA não é recalculado.' })); return; }
      var alvos = alvosDaMissao(m), alguma = false;
      alvos.forEach(function (vid) {
        var ent = entradaPos(vid, m.setor_id, p == null || isNaN(p) ? null : p, c == null || isNaN(c) ? m.area_atribuida_fracao : c);
        if (!ent) return;
        var out = M.posBusca(ent);
        if (out.motivo === 'setor_fora_do_cenario') return;
        alguma = true;
        var ap = aprovadaDa(vid);
        if (!out.ok) { previa.appendChild(el('p', { classe: 'poa-calc ' + (out.motivo === 'pod_desconhecido' ? 'poa-calc-pend' : 'poa-calc-erro'), texto: nomeVitima(vid) + ': ' + (MOTIVOS_CALC[out.motivo] || out.motivo) })); return; }
        var nomes = {}; ap.setores.forEach(function (i) { nomes[i.setor_id || i.id] = i.setor_nome; });
        previa.appendChild(el('p', { classe: 'poa-calc poa-calc-ok' }, [el('strong', { texto: nomeVitima(vid) + ' → nova versão ' + (Math.max.apply(null, versoesDa(vid).map(function (x) { return x.numero; })) + 1) + ': ' }),
          out.setores.map(function (s) { return nomes[s.id] + ' ' + pct(ent.setores.find(function (x) { return x.id === s.id; }).poa) + ' → ' + pct(s.poa); }).concat(['Fora da área ' + pct(ent.fora != null ? ent.fora : 1 - ent.setores.reduce(function (a, x) { return a + x.poa; }, 0)) + ' → ' + pct(out.fora)]).join(' · '),
          el('br'), el('span', { classe: 'muted', texto: 'Chance de localizar nesta busca: ' + pct(out.pos) })]));
      });
      if (!alguma) previa.appendChild(el('p', { texto: 'Nenhuma vítima com versão vigente que inclua este setor: o POA não muda.' }));
    }
    res.addEventListener('change', atualizar);
    ['res-cobertura', 'res-pod'].forEach(function (id) { var x = (id === 'res-pod' ? pod : cob).querySelector('input'); x.addEventListener('input', function () { if (id === 'res-pod') { estado.origem = 'manual'; estado.revisor = null; } atualizar(); }); });

    var form = el('form', { classe: 'poa-form', novalidate: true }, [
      el('h2', { id: 'modal-titulo', texto: 'Resultado da missão' }),
      el('p', { classe: 'poa-meta', texto: m.setor_nome + ' · ' + m.equipe + ' · ' + m.metodo }),
      el('div', { classe: 'poa-grid' }, [campo('Resultado', res, { para: 'res-resultado', largo: true })]),
      gExec,
      el('div', { classe: 'poa-grid' }, [campo('Observações', obs, { para: 'res-obs', largo: true })]),
      previa, erro,
      el('div', { classe: 'poa-acoes' }, [el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      function falha(t) { erro.textContent = t; erro.hidden = false; }
      var c = lerPct('res-cobertura'), p = lerPct('res-pod');
      var iniMs = ini.value ? new Date(ini.value).getTime() : null, fimMs = fim.value ? new Date(fim.value).getTime() : null;
      var r = res.value;
      if (r !== 'localizado') {
        if (c != null && (isNaN(c) || c <= 0 || c > 1)) return falha('A cobertura real deve ficar entre 1% e 100%.');
        if (r === 'nao_localizado' && c == null) return falha('Informe a cobertura real do setor.');
        if (p != null && (isNaN(p) || p < 0 || p > 1)) return falha('O POD deve ficar entre 0 e 100%.');
      }
      if (iniMs != null && fimMs != null && fimMs < iniMs) return falha('O fim não pode ser antes do início.');
      var mudouPod = p != null && (m.pod_planejada == null || Math.abs(p - Number(m.pod_planejada)) > 1e-9);
      if (p != null && (mudouPod || m.pod_planejada == null) && base.value.trim().length < 5) return falha('Diga em que o POD se baseia (pelo menos 5 caracteres).');
      if (r === 'nao_localizado') {
        var ok = await UI.confirmar({ titulo: 'Registrar busca negativa?', texto: p == null ? 'Sem POD, o POA não será recalculado: a missão fica pendente.' : 'Isto gera uma nova versão do cenário (o POA é recalculado pela busca negativa). As versões anteriores não mudam.', ok: 'Registrar resultado', empilhar: true });
        if (!ok) return;
      }
      btn.disabled = true;
      try {
        var dados = { resultado: r, observacao: obs.value.trim(), inicio_real: iniMs ? new Date(iniMs).toISOString() : null, fim_real: fimMs ? new Date(fimMs).toISOString() : null };
        if (r !== 'localizado') {
          dados.cobertura = c; dados.pod = p; dados.pod_base = p == null ? '' : base.value.trim();
          dados.pod_origem = mudouPod ? estado.origem : m.pod_planejada_origem;
        }
        await C.rpc('busca_missao_resultado', { p_missao: m.id, p_dados: dados });
        UI.aviso('Resultado registrado.', 'ok');
        fechar(true);
        await carregar();
      } catch (e) { falha(e.message); btn.disabled = false; }
    });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false, empilhar: true });
    atualizar();
  }

  /* ---------- Informar o POD que faltava -------------------------------- */
  function abrirPod(m) {
    var pod = campoPct('pod-valor', '', '0 a 100', 'POD (%)');
    var base = el('textarea', { classe: 'campo', id: 'pod-base', rows: '2', maxlength: '1000', placeholder: 'Em que o POD se baseia' });
    var erro = el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = el('button', { classe: 'btn btn-prob', type: 'submit', id: 'pod-salvar', texto: 'Informar e recalcular' });
    var form = el('form', { classe: 'poa-form', novalidate: true }, [
      el('h2', { id: 'modal-titulo', texto: 'POD da missão' }),
      el('p', { classe: 'poa-meta', texto: m.setor_nome + ' · ' + m.equipe + ' · só pode ser informado uma vez; gera uma nova versão do cenário' }),
      el('div', { classe: 'poa-grid' }, [campo('POD', pod, { para: 'pod-valor' }), campo('Em que se baseia', base, { para: 'pod-base', largo: true })]),
      erro,
      el('div', { classe: 'poa-acoes' }, [el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var p = lerPct('pod-valor');
      function falha(t) { erro.textContent = t; erro.hidden = false; }
      if (p == null || isNaN(p) || p < 0 || p > 1) return falha('Informe o POD entre 0 e 100%.');
      if (base.value.trim().length < 5) return falha('Diga em que o POD se baseia (pelo menos 5 caracteres).');
      btn.disabled = true;
      try {
        await C.rpc('busca_missao_definir_pod', { p_missao: m.id, p_pod: p, p_base: base.value.trim(), p_origem: 'manual' });
        UI.aviso('POD informado.', 'ok');
        fechar(true);
        await carregar();
      } catch (e) { falha(e.message); btn.disabled = false; }
    });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false, empilhar: true });
  }

  /* ---------- Bloco no detalhe do setor (só informação; a edição fica no botão POA/POD do topo) ---------- */
  function blocoSetor(d) {
    var sec = el('section', { classe: 'pod-bloco', 'aria-label': 'Probabilidades de busca' }, [el('h3', { texto: 'POA/POD' })]);
    if (est.ausente) { sec.appendChild(el('p', { classe: 'muted', texto: 'Indisponível: faltam as migrações 033 e 034.' })); return sec; }
    if (!est.vitimas.length) { sec.appendChild(el('p', { classe: 'muted', texto: 'Sem vítima cadastrada.' })); return sec; }
    var dl = el('dl', { classe: 'dados' });
    est.vitimas.forEach(function (v) {
      var ap = aprovadaDa(v.id);
      var i = ap && ap.setores.find(function (x) { return x.setor_id === d.id; });
      dl.appendChild(el('dt', { texto: v.nome + (localizacaoDa(v.id) ? ' (localizada)' : '') }));
      dl.appendChild(el('dd', { texto: !ap ? 'Sem versão publicada' : i ? 'v' + ap.numero + ' · POA ' + pct(Number(i.poa)) : 'v' + ap.numero + ' · fora do cenário' }));
    });
    sec.appendChild(dl);
    var ms = est.missoes.filter(function (m) { return m.setor_id === d.id && m.estado !== 'cancelada'; });
    if (ms.length) {
      sec.appendChild(el('ol', { classe: 'pod-buscas' }, ms.slice().reverse().slice(0, 4).map(function (m) {
        var pod = m.estado === 'concluida' ? m.pod_final : m.pod_planejada;
        return el('li', { texto: m.equipe + ' · ' + (m.estado === 'concluida' ? RESULTADOS[m.resultado] : 'planejada') + ' · ' + (pod == null ? 'POD não estimada' : 'POD ' + pct(Number(pod))) });
      })));
    }
    return sec;
  }

  /* ---------- Dados para o relatório final (versões aprovadas e missões de busca) ---------- */
  async function dadosRelatorio() {
    await carregar();
    if (est.ausente || !est.vitimas.length) return null;
    var vitimas = est.vitimas.map(function (v) {
      var loc = localizacaoDa(v.id);
      var versoes = versoesDa(v.id).filter(function (c) { return c.estado === 'aprovada'; });
      return {
        nome: v.nome, localizada: loc ? { condicao: loc.condicao, em: loc.registrado_em } : null,
        versoes: versoes.map(function (c) {
          return { numero: c.numero, aprovada_em: c.aprovada_em, aprovada_por_nome: c.aprovada_por_nome, horario_referencia: c.horario_referencia, justificativa: c.justificativa,
            hipoteses: c.hipoteses, limitacoes: c.limitacoes, confianca: c.confianca, origem_poa: c.origem_poa, ponto_confiavel: c.ponto_confiavel,
            poa_fora: c.poa_fora != null ? Number(c.poa_fora) : null, poa_fora_origem: c.poa_fora_origem, ia_modelo: c.ia_modelo, missao_id: c.missao_id,
            setores: c.setores.map(function (i) { return { nome: i.setor_nome, poa: Number(i.poa), area_m2: i.area_m2, justificativa: i.justificativa, origem: i.origem, ia_revisado_por_nome: i.ia_revisado_por_nome }; }),
            evidencias: c.evidencias.map(function (e) { return { descricao: e.descricao, confirmada: e.confirmada }; }) };
        }),
      };
    });
    var missoes = est.missoes.map(function (m) {
      return { criada_em: m.criada_em, setor: m.setor_nome, equipe: m.equipe, metodo: m.metodo, area_fracao: Number(m.area_atribuida_fracao), area_texto: m.area_texto, estado: m.estado,
        pod_planejada: m.pod_planejada == null ? null : Number(m.pod_planejada), pod_planejada_origem: m.pod_planejada_origem, pod_planejada_revisor: m.pod_planejada_revisor,
        resultado: m.resultado, resultado_em: m.resultado_em, resultado_por: m.resultado_por_nome, cobertura_real: m.cobertura_real_fracao == null ? null : Number(m.cobertura_real_fracao),
        pod_final: m.pod_final == null ? null : Number(m.pod_final), pod_final_base: m.pod_final_base, pod_final_origem: m.pod_final_origem, pod_final_revisor: m.pod_final_revisor,
        calculo_estado: m.calculo_estado, calculo_detalhe: m.calculo_detalhe, cancelada_motivo: m.cancelada_motivo, vitima: m.vitima_id ? nomeVitima(m.vitima_id) : null,
        efeitos: efeitosDe(m.id).map(function (e) { return { vitima: nomeVitima(e.vitima_id), poa_antes: Number(e.poa_setor_antes), poa_depois: Number(e.poa_setor_depois), q: Number(e.q), pos: Number(e.pos), versao: numeroVersao(e.cenario_depois_id) }; }) };
    });
    if (!missoes.length && !est.registros.length && !vitimas.some(function (x) { return x.versoes.length; })) return null;
    var antigos = est.registros.map(function (r) {
      return { registrado_em: r.registrado_em, setor: r.setor_nome, equipe: r.equipe, metodo: r.metodo, pod: r.pod == null ? null : Number(r.pod), anulado: r.anulado_em ? { motivo: r.anulado_motivo } : null };
    });
    return { vitimas: vitimas, missoes: missoes, registros_antigos: antigos };
  }

  window.BuscaCenario = { iniciar: iniciar, parar: parar, abrir: abrir, abrirMissao: abrirMissao, blocoSetor: blocoSetor, recarregar: carregar, dadosRelatorio: dadosRelatorio };
})();
