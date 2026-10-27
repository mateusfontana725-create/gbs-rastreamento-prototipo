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
    vitimaSel: null, renderAtual: null, camadaVitima: null,
  };

  var MOTIVOS = {
    anulado: 'anulado',
    outra_vitima: 'vale para outra vítima',
    setor_fora_do_cenario: 'setor fora deste cenário',
    anterior_a_versao: 'lançado antes da versão aprovada',
    inconsistente: 'inconsistente com o cenário (POD 100% onde estava toda a probabilidade): revise o POD ou o cenário',
    planejada: 'planejada: não altera o POA',
    sem_estimativa: 'POD não estimada: não altera o POA',
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
  function registrosParaCalculo() {
    return est.registros.map(function (r) {
      return { id: r.id, setorId: r.setor_id, vitimaId: r.vitima_id, finalidade: r.finalidade, pod: r.pod == null ? null : Number(r.pod),
        coberturaFracao: r.cobertura_fracao == null ? null : Number(r.cobertura_fracao), registradoEm: C.paraMs(r.registrado_em), anulado: Boolean(r.anulado_em) };
    });
  }
  function resultadoDa(vitimaId) {
    var ap = aprovadaDa(vitimaId);
    if (!ap) return null;
    return M.calcular({
      vitimaId: vitimaId, registros: registrosParaCalculo(),
      cenario: { id: ap.id, numero: ap.numero, aprovadaEm: C.paraMs(ap.aprovada_em),
        setores: ap.setores.map(function (i) { return { setorId: i.setor_id, nome: i.setor_nome, poa: Number(i.poa), areaM2: i.area_m2 }; }) },
    });
  }
  function geometriaDoSetor(s, poa) {
    return { nome: s.nome, poa: poa, forma: s.forma, centroLat: s.centro_lat, centroLng: s.centro_lng, raioM: s.raio_m, pontos: s.pontos };
  }
  function rotuloPonto(p) {
    var c = P.categorias && P.categorias[p.categoria];
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
        C.consultar(C.cliente.from('vitimas').select('id,nome').eq('operacao_id', opId).order('criado_em', { ascending: true })),
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
      ['busca_cenarios', 'busca_cenario_setores', 'busca_cenario_evidencias', 'busca_registros', 'vitimas', 'vitima_localizacoes'].forEach(function (tabela) {
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
    carregar();
    assinar();
  }

  function parar() {
    clearTimeout(est.timer);
    clearTimeout(est.timerCanal);
    if (est.canal) { try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ } }
    est.canal = null;
    est.opId = null; est.vitimas = []; est.cenarios = []; est.itens = []; est.evidencias = []; est.registros = []; est.localizacoes = [];
    est.ausente = false; est.erro = null; est.vitimaSel = null; est.renderAtual = null;
    est.camadaVitima = null;
    if (P.camadaProbabilidade) P.camadaProbabilidade(null);
  }

  /* ---------- Camada de POA no mapa (separada da passagem GPS e das missões) ---------- */
  function atualizarCamada() {
    if (!P.camadaProbabilidade) return;
    var vid = est.camadaVitima;
    var ap = vid && aprovadaDa(vid);
    if (!vid || !ap) { P.camadaProbabilidade(null); return; }
    var res = resultadoDa(vid), valores = {};
    res.setores.forEach(function (s) { valores[s.setorId] = s.poaAtual; });
    P.camadaProbabilidade(valores, 'POA atual · ' + nomeVitima(vid) + ' · versão ' + ap.numero + ' · referência ' + C.hora(ap.horario_referencia || ap.aprovada_em, false) + ' (prévia)');
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

  function tabelaCenario(c, resultado) {
    var linhas = c.setores.slice().sort(function (a, b) { return Number(b.poa) - Number(a.poa) || a.setor_nome.localeCompare(b.setor_nome, 'pt-BR'); }).map(function (i) {
      var s = resultado && i.setor_id ? resultado.setores.find(function (x) { return x.setorId === i.setor_id; }) : null;
      var podTxt = !s ? '—' : s.pod != null ? pct(s.pod) + ' (' + s.registros + ' busca' + (s.registros > 1 ? 's' : '') + ')' : (s.semEstimativa ? 'não estimada' : '—');
      return celulas([
        el('span', null, [i.setor_nome, i.setor_id ? null : el('small', { classe: 'muted', texto: ' (setor excluído)' })]),
        pct(Number(i.poa)),
        i.area_m2 ? (i.area_m2 / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 3 }) + ' km²' : '—',
        s && s.pdenPorKm2 != null ? s.pdenPorKm2.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '—',
        podTxt,
        s ? pct(s.pos) : '—',
        s ? pct(s.poaAtual) : '—',
        i.justificativa ? el('small', { classe: 'muted', texto: i.justificativa }) : '',
      ]);
    });
    var soma = M.somaPoa(c.setores.map(function (i) { return i.setor_id ? Number(i.poa) : 0; }));
    linhas.push(celulas([
      el('em', { texto: 'Fora dos setores desenhados' }), pct(resultado ? resultado.poaFora : Math.max(0, 1 - soma)), '—', '—', '—', '—',
      resultado ? pct(resultado.poaForaAtual) : '—', el('small', { classe: 'muted', texto: 'o que sobra de 100%; não tem busca nem área' }),
    ]));
    return tabela(['Setor', 'POA aprovado', 'Área', 'Densidade (% por km²)', 'POD acumulado', 'POS', 'POA atual', 'Justificativa do setor'], linhas);
  }

  /* ---------- Tela principal: cenário da vítima ------------------------- */
  function abrir(vitimaId) {
    if (vitimaId) est.vitimaSel = vitimaId;
    var corpo = el('div', { classe: 'cenario-busca' });
    var fechar;
    function fechando() { est.renderAtual = null; }

    function desenhar() {
      corpo.innerHTML = '';
      corpo.appendChild(el('h2', { id: 'modal-titulo', texto: 'Probabilidades de busca (POA, POD e POS)' }));
      corpo.appendChild(el('p', { classe: 'ajuda', texto: 'POA: onde a pessoa pode estar (decisão do responsável, com justificativa). POD: chance de a busca achá-la se ela estiver no setor — vem do registro manual da equipe, nunca do GPS. POS: POA × POD, a probabilidade de a busca localizar a pessoa (não é probabilidade de sobrevivência nem de resgate com vida).' }));
      if (est.ausente) {
        corpo.appendChild(aviso('Este banco ainda não tem as migrações 033 e 034. Peça ao administrador para rodar supabase/migracoes/033_cenario_busca_pod_poa.sql e 034_poa_pod_guia.sql no Supabase.'));
        corpo.appendChild(rodape());
        return;
      }
      if (est.erro) corpo.appendChild(aviso('Não foi possível atualizar: ' + est.erro));
      if (!est.vitimas.length) {
        corpo.appendChild(aviso('Esta operação ainda não tem vítima cadastrada. O cenário é feito por vítima: cadastre a ficha em "Dados da operação" e volte aqui.'));
        corpo.appendChild(rodape());
        return;
      }
      if (!est.vitimaSel || !est.vitimas.some(function (v) { return v.id === est.vitimaSel; })) est.vitimaSel = est.vitimas[0].id;
      var vid = est.vitimaSel;

      if (est.vitimas.length > 1) {
        var sel = el('select', { classe: 'campo', id: 'cenario-vitima', 'aria-label': 'Vítima' }, est.vitimas.map(function (v) {
          return el('option', { value: v.id, selected: v.id === vid ? true : null, texto: v.nome + (localizacaoDa(v.id) ? ' (localizada)' : '') });
        }));
        sel.addEventListener('change', function () { est.vitimaSel = sel.value; desenhar(); });
        corpo.appendChild(el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'cenario-vitima', texto: 'Cenário da vítima' }), sel]));
      } else {
        corpo.appendChild(el('h3', { texto: 'Cenário: ' + nomeVitima(vid) }));
      }

      var ap = aprovadaDa(vid), rasc = rascunhoDa(vid), res = resultadoDa(vid), loc = localizacaoDa(vid);
      var editavel = podeAlterar() && !loc;

      if (loc) corpo.appendChild(aviso('Vítima localizada (' + (loc.condicao === 'obito' ? 'óbito' : 'com vida') + ') às ' + C.hora(loc.registrado_em, false) + ': o cenário dela está encerrado e fica só para consulta. Os cenários das demais vítimas continuam.', 'nota nota-ok'));

      // versão aprovada
      var secAp = el('section', { classe: 'cenario-sec', 'aria-label': 'Versão aprovada' });
      if (ap) {
        secAp.appendChild(el('h3', { texto: textoAprovacao(ap) }));
        secAp.appendChild(el('p', { classe: 'cenario-just' }, [el('strong', { texto: 'Justificativa: ' }), ap.justificativa]));
        secAp.appendChild(blocoReferencia(ap));
        secAp.appendChild(tabelaCenario(ap, res));
        if (res.registros.some(function (x) { return x.motivo === 'inconsistente'; })) secAp.appendChild(aviso('Atenção: há registro de busca inconsistente com o cenário (a busca negativa seria impossível). Ele não foi aplicado; revise o POD informado ou o cenário.'));
        secAp.appendChild(el('p', { classe: 'ajuda', texto: 'Cálculo (prévia do navegador; o aprovado é o que está guardado no servidor). POS total desde esta versão: ' + pct(res.posTotal) + '. O POA atual é o POA aprovado atualizado pelas buscas lançadas depois da aprovação (regra de Bayes); a probabilidade migra para o que ainda não foi visto. A densidade é só apoio ao planejamento: onde atuar também depende de risco, urgência, acesso e recursos.' }));
      } else {
        secAp.appendChild(el('h3', { texto: 'Nenhuma versão aprovada' }));
        secAp.appendChild(aviso('Sem um cenário aprovado o app não calcula POS nem POA atual: ele não inventa a probabilidade de a pessoa estar em cada setor. Se ainda não há base para percentuais, trate as prioridades como qualitativas: não existe distribuição probabilística publicada.'));
      }
      if (rasc) secAp.appendChild(aviso('RASCUNHO da versão ' + rasc.numero + ' (por ' + rasc.criado_por_nome + ', salvo às ' + C.hora(rasc.atualizado_em, false) + '). Ainda não vale: só a versão aprovada entra nos cálculos.'));
      var acoes = [];
      if (editavel) {
        acoes.push(el('button', { classe: 'btn btn-escuro', type: 'button', id: 'cenario-editar', texto: rasc ? 'Continuar rascunho (versão ' + rasc.numero + ')' : (ap ? 'Rever o cenário (nova versão)' : 'Montar cenário'),
          onclick: function () { abrirEditor(vid, function () { carregar(); }); } }));
      }
      if (podeAlterar()) acoes.push(el('button', { classe: 'btn', type: 'button', id: 'cenario-registrar', texto: 'Registrar busca (POD)', onclick: function () { abrirRegistro({}); } }));
      if (ap && P.camadaProbabilidade) {
        var ligada = est.camadaVitima === vid;
        acoes.push(el('button', { classe: 'btn', type: 'button', id: 'cenario-camada', 'aria-pressed': String(ligada), texto: ligada ? 'Ocultar POA no mapa' : 'Mostrar POA atual no mapa',
          onclick: function () { est.camadaVitima = ligada ? null : vid; atualizarCamada(); desenhar(); } }));
      }
      secAp.appendChild(el('div', { classe: 'modal-acoes cenario-acoes' }, acoes));
      corpo.appendChild(secAp);

      // buscas registradas
      var mapaReg = {};
      if (res) res.registros.forEach(function (x) { mapaReg[x.id] = x; });
      var visiveis = est.registros.filter(function (r) { return !r.vitima_id || r.vitima_id === vid; }).slice().reverse();
      var secReg = el('section', { classe: 'cenario-sec', 'aria-label': 'Buscas registradas' }, [el('h3', { texto: 'Buscas registradas (origem do POD)' })]);
      if (!visiveis.length) {
        secReg.appendChild(aviso('Nenhuma busca registrada ainda. Quando uma equipe terminar um setor, registre o POD que ela estimou e em que se baseou. Se não houver base para estimar, registre a busca como "POD não estimada": ela não reduz o POA.'));
      } else {
        secReg.appendChild(tabela(['Quando', 'Setor', 'Equipe e método', 'Tipo', 'POD', 'Base da estimativa', 'Situação', ''], visiveis.map(function (r) {
          var x = mapaReg[r.id];
          var situacao = r.anulado_em ? 'Anulado: ' + r.anulado_motivo + ' (' + (r.anulado_por_nome || '—') + ')'
            : !res ? 'Aguardando cenário aprovado'
              : x && x.conta ? 'Conta no cálculo'
                : x && x.motivo === 'planejada' ? 'Planejada: não altera o POA' + (x.posPrevista != null ? ' · POS prevista ' + pct(x.posPrevista) : '')
                  : 'Não conta: ' + (MOTIVOS[x && x.motivo] || '—');
          var podTxt = r.pod == null ? 'não estimada' : pct(Number(r.pod)) + (r.alcance === 'parcial' ? ' em ' + pct(Number(r.cobertura_fracao), 0) + ' do setor' : '');
          var extra = [r.observadores ? r.observadores + ' observador(es)' : '', r.impedimentos ? 'Impedimentos: ' + r.impedimentos : '', r.areas_nao_observadas ? 'Não observado: ' + r.areas_nao_observadas : '', r.condicoes].filter(Boolean).join(' · ');
          return el('tr', { classe: r.anulado_em ? 'registro-anulado' : null }, [
            el('td', { texto: C.hora(r.registrado_em, false) }),
            el('td', { texto: r.setor_nome }),
            el('td', { texto: [(r.equipe || '—') + (r.vitima_id ? ' · só ' + nomeVitima(r.vitima_id) : ''), r.metodo].filter(Boolean).join(' · ') }),
            el('td', { texto: r.finalidade === 'planejada' ? 'planejada' : 'executada' }),
            el('td', { texto: podTxt }),
            el('td', null, [el('small', { texto: r.base_estimativa + (extra ? ' — ' + extra : '') + ' [' + (ORIGENS[r.origem_pod] || r.origem_pod) + ']' })]),
            el('td', null, [el('small', { classe: 'muted', texto: situacao })]),
            el('td', null, [podeAlterar() && !r.anulado_em ? el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Anular', onclick: function () { abrirAnulacao(r); } }) : null]),
          ]);
        })));
        secReg.appendChild(el('p', { classe: 'ajuda', texto: 'Registro não se edita: se errou, anule (fica no histórico) e lance outro. Só entra no cálculo o registro de busca executada, com POD estimada, não anulado, válido para a vítima e lançado depois da aprovação da versão. Um trecho que chegar atrasado (ex.: trilha) não muda sozinho uma versão aprovada: registre e aprove uma nova versão.' }));
      }
      corpo.appendChild(secReg);

      // histórico de versões
      var vers = versoesDa(vid).slice().reverse();
      if (vers.length) {
        var secHist = el('section', { classe: 'cenario-sec', 'aria-label': 'Histórico de versões' }, [el('h3', { texto: 'Histórico de versões' })]);
        vers.forEach(function (c) {
          secHist.appendChild(el('details', { classe: 'cenario-versao' }, [
            el('summary', { texto: c.estado === 'aprovada' ? textoAprovacao(c) : 'RASCUNHO da versão ' + c.numero + ' (ainda não aprovado)' }),
            el('p', { classe: 'cenario-just' }, [el('strong', { texto: 'Justificativa: ' }), c.justificativa || '—']),
            blocoReferencia(c),
            tabela(['Setor', 'POA', 'Área', 'Justificativa do setor'], c.setores.slice().sort(function (a, b) { return Number(b.poa) - Number(a.poa); }).map(function (i) {
              return celulas([i.setor_nome + (i.setor_id ? '' : ' (excluído)'), pct(Number(i.poa)), i.area_m2 ? (i.area_m2 / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 3 }) + ' km²' : '—', i.justificativa || '']);
            })),
            el('p', { classe: 'ajuda', texto: c.estado === 'aprovada' ? 'Versão aprovada: não pode mais ser alterada nem apagada. A geometria dos setores é a de quando foi aprovada.' : 'Criado por ' + c.criado_por_nome + ' em ' + C.hora(c.criado_em, false) + (c.base_numero ? ' a partir da versão ' + c.base_numero : '') + '.' }),
          ]));
        });
        corpo.appendChild(secHist);
      }

      corpo.appendChild(el('details', { classe: 'pod-formulas' }, [
        el('summary', { texto: 'Como é calculado' }),
        el('p', { texto: 'POA: a distribuição que o responsável aprovou (soma até 100%; o que sobra é "fora dos setores desenhados", sem busca). Os setores com POA não podem se sobrepor: a mesma área seria contada duas vezes.' }),
        el('p', { texto: 'POD acumulado do setor = 1 − (1 − POD₁) × (1 − POD₂) × …, só com registros de busca executada, com POD estimada, não anulados, lançados depois da aprovação e válidos para a vítima. Supõe buscas independentes: repetir o mesmo método no mesmo lugar tende a render menos, então é uma estimativa generosa. POD não estimada nunca vira zero e não reduz o POA. Busca em parte do setor entra como POD da área coberta × fração coberta, supondo a pessoa distribuída de forma uniforme no setor.' }),
        el('p', { texto: 'POS do setor = POA × POD acumulado. POS total = soma dos POS (é a base da versão aprovada; não some POS de buscas sucessivas sem esse contexto).' }),
        el('p', { texto: 'POA atual = POA × (1 − POD acumulado), dividido pelo total que sobra (Bayes). A probabilidade migra para os setores menos vistos e para "fora dos setores". Vale para alvo parado; se a pessoa pode estar se deslocando, faça um novo cenário com hipóteses revistas.' }),
        el('p', { texto: 'POS é a probabilidade de a busca localizar a pessoa. Não é probabilidade de sobrevivência, de resgate com vida nem de conclusão segura da operação.' }),
        el('p', { classe: 'muted', texto: 'O GPS não entra: a trilha mostra por onde a equipe passou, não o que ela observou. Referência: Koopman, Search and Screening (1980); manual IAMSAR, vol. II; Guarda Costeira dos EUA, The Theory of Search.' }),
      ]));
      corpo.appendChild(rodape());
    }

    function rodape() {
      return el('div', { classe: 'modal-acoes' }, [el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]);
    }

    est.renderAtual = desenhar;
    desenhar();
    fechar = UI.abrirModal(corpo, { aoFechar: fechando });
  }

  /* ---------- Editor de versão (rascunho → aprovação) -------------------- */
  function abrirEditor(vitimaId, aoConcluir) {
    var setores = (P.setores() || []).slice().sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
    if (!setores.length) { UI.aviso('Desenhe pelo menos um setor de busca antes de montar o cenário.', 'erro', 7000); return; }
    if (localizacaoDa(vitimaId)) { UI.aviso('Esta vítima já foi localizada: o cenário dela está encerrado.', 'erro', 7000); return; }
    var ap = aprovadaDa(vitimaId);
    var rasc = rascunhoDa(vitimaId);
    var origem = rasc || ap;   // o rascunho, ou a versão aprovada de que a nova parte
    var inicial = {};
    if (origem) origem.setores.forEach(function (i) { if (i.setor_id) inicial[i.setor_id] = i; });
    var pontos = (P.pontosInteresse ? P.pontosInteresse() : []) || [];

    var campos = setores.map(function (s) {
      var i = inicial[s.id];
      var poa = el('input', { classe: 'campo campo-poa', type: 'number', min: '0', max: '100', step: '0.1', inputmode: 'decimal', 'aria-label': 'POA do setor ' + s.nome + ' (%)',
        value: i ? String(Math.round(Number(i.poa) * 1000) / 10) : '' });
      var just = el('input', { classe: 'campo', maxlength: '500', placeholder: 'Por que este valor? (opcional)', 'aria-label': 'Justificativa do setor ' + s.nome, value: i ? i.justificativa : '' });
      return { s: s, poa: poa, just: just };
    });
    var geral = el('textarea', { classe: 'campo', id: 'cenario-just', rows: '3', maxlength: '2000', placeholder: 'Por que esta distribuição? Ex.: última posição conhecida, relato da família, perfil da vítima, resultado das buscas anteriores…' });
    geral.value = origem && rasc ? rasc.justificativa : '';
    var hip = el('textarea', { classe: 'campo', id: 'cenario-hip', rows: '2', maxlength: '2000', placeholder: 'Hipóteses de deslocamento ou permanência que sustentam o cenário' });
    hip.value = origem ? origem.hipoteses : '';
    var lim = el('textarea', { classe: 'campo', id: 'cenario-lim', rows: '2', maxlength: '1000', placeholder: 'O que não se sabe ou pode invalidar este cenário' });
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
      item.linha = el('div', { classe: 'cenario-evid-linha' }, [el('label', null, [marcar, ' considerar']), texto, el('label', null, [confirm, ' confirmada']), rem]);
      return item;
    }
    function addEvidencia(e) { var it = linhaEvidencia(e); evCampos.push(it); listaEv.appendChild(it.linha); }
    var jaUsadas = {};
    if (origem) origem.evidencias.forEach(function (ev) { if (ev.ponto_id) jaUsadas[ev.ponto_id] = ev; });
    pontos.forEach(function (p) { var u = jaUsadas[p.id]; addEvidencia({ pontoId: p.id, texto: rotuloPonto(p), marcada: Boolean(u), confirmada: u ? u.confirmada : false }); });
    if (origem) origem.evidencias.filter(function (ev) { return !ev.ponto_id; }).forEach(function (ev) { addEvidencia({ livre: true, texto: ev.descricao, marcada: true, confirmada: ev.confirmada }); });

    var total = el('p', { classe: 'cenario-total', role: 'status' });
    var sobrep = el('p', { classe: 'nota', role: 'status', hidden: true });
    var erro = el('p', { classe: 'erro-form', role: 'alert', hidden: true });

    function valorPct(c) { var t = c.poa.value.trim().replace(',', '.'); return t === '' ? 0 : Number(t); }
    function somaPct() { return campos.reduce(function (a, c) { var v = valorPct(c); return a + (v >= 0 ? v : 0); }, 0); }
    function atualizarTotal() {
      var soma = somaPct();
      var invalido = campos.some(function (c) { var v = valorPct(c); return !(v >= 0 && v <= 100); });
      total.textContent = 'Soma dos setores: ' + (Math.round(soma * 10) / 10).toLocaleString('pt-BR') + '% · fora dos setores desenhados: ' + (Math.round((100 - soma) * 10) / 10).toLocaleString('pt-BR') + '%' +
        (soma > 100.0001 ? ' — passou de 100%' : '') + (invalido ? ' — há valor fora de 0 a 100' : '');
      total.classList.toggle('cenario-total-erro', soma > 100.0001 || invalido);
      var pares = M.sobreposicoes(campos.map(function (c) { return geometriaDoSetor(c.s, invalido ? 0 : valorPct(c)); }));
      sobrep.hidden = !pares.length;
      sobrep.textContent = pares.length ? 'Sobreposição: ' + pares.map(function (p) { return p.a + ' e ' + p.b + ' (' + Math.round(p.fracao * 100) + '% do menor)'; }).join('; ') +
        '. A mesma área seria contada duas vezes: a aprovação é recusada. Ajuste os setores ou deixe o POA de um deles em zero. Pode salvar como rascunho.' : '';
    }
    [geral, hip, lim].concat(campos.map(function (c) { return c.just; })).forEach(function (x) { x.addEventListener('input', function () { erro.hidden = true; }); });
    campos.forEach(function (c) { c.poa.addEventListener('input', function () { erro.hidden = true; atualizarTotal(); }); });

    var tabelaCampos = tabela(['Setor', 'POA (%)', 'Justificativa do setor'], campos.map(function (c) {
      return el('tr', null, [el('td', { texto: c.s.nome }), el('td', null, [c.poa]), el('td', null, [c.just])]);
    }), 'tabela-editor');

    var recursos = [
      el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'cenario-distribuir', texto: 'Preencher proporcional à área', title: 'Hipótese de distribuição uniforme (POA proporcional à área). Não é conclusão sobre o caso: ajuste e justifique.',
        onclick: function () {
          var d = M.distribuirPelaArea(setores.map(function (s) { return { id: s.id, areaM2: P.areaSetorM2(s) }; }));
          campos.forEach(function (c) { c.poa.value = String(Math.round(d[c.s.id] * 1000) / 10); });
          atualizarTotal();
        } }),
    ];
    var resAtual = ap ? resultadoDa(vitimaId) : null;
    if (resAtual && resAtual.registros.some(function (x) { return x.conta; })) {
      recursos.push(el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'cenario-usar-atual', texto: 'Usar o POA atual (depois das buscas)',
        title: 'Proposta de atualização: preenche com o POA atualizado pelas buscas registradas. Confirme que a hipótese espacial ainda vale (principalmente se a pessoa pode estar se deslocando) e justifique.',
        onclick: function () {
          var s = M.sugerirProximaVersao(resAtual);
          campos.forEach(function (c) { c.poa.value = s[c.s.id] != null ? String(Math.round(s[c.s.id] * 1000) / 10) : '0'; });
          atualizarTotal();
        } }));
    }

    var btnSalvar = el('button', { classe: 'btn', type: 'button', id: 'cenario-salvar', texto: 'Salvar rascunho' });
    var btnAprovar = el('button', { classe: 'btn btn-escuro', type: 'button', id: 'cenario-aprovar', texto: 'Aprovar versão' });
    var btnDescartar = rasc ? el('button', { classe: 'btn btn-perigo', type: 'button', id: 'cenario-descartar', texto: 'Descartar rascunho' }) : null;
    var btnCancelar = el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } });

    function montarDados() {
      if (campos.some(function (c) { var v = valorPct(c); return !(v >= 0 && v <= 100); })) throw new Error('Cada POA deve ficar entre 0 e 100%.');
      if (somaPct() > 100.0001) throw new Error('A soma dos POA passou de 100%. Reduza algum setor.');
      var hrMs = hr.value ? new Date(hr.value).getTime() : null;
      return {
        justificativa: geral.value.trim(),
        hipoteses: hip.value.trim(), limitacoes: lim.value.trim(), confianca: conf.value || null, origem_poa: origemPoa.value,
        horario_referencia: hrMs != null && !isNaN(hrMs) ? new Date(hrMs).toISOString() : null,
        ponto_confiavel_id: selPonto.value || null,
        atualizado_em: rasc ? rasc.atualizado_em : null,
        setores: campos.filter(function (c) { return valorPct(c) > 0 || c.just.value.trim(); }).map(function (c) {
          return { setor_id: c.s.id, poa: Math.round(valorPct(c) * 1e4) / 1e6, justificativa: c.just.value.trim() };
        }),
        evidencias: evCampos.filter(function (x) { return x.marcar.checked && (x.e.livre ? x.texto.value.trim() : true); }).map(function (x) {
          return x.e.livre ? { descricao: x.texto.value.trim(), confirmada: x.conf.checked } : { ponto_id: x.e.pontoId, descricao: x.e.texto, confirmada: x.conf.checked };
        }),
      };
    }
    function ocupado(sim) { [btnSalvar, btnAprovar, btnDescartar].forEach(function (b) { if (b) b.disabled = sim; }); }

    var chaveAprovacao = chaveNova();   // a mesma chave se a aprovação for reenviada: o servidor não duplica
    async function salvar(aprovar) {
      erro.hidden = true;
      var dados;
      try { dados = montarDados(); } catch (e) { erro.textContent = e.message; erro.hidden = false; return; }
      if (aprovar) {
        if (dados.justificativa.length < 10) { erro.textContent = 'Para aprovar, escreva a justificativa da versão (pelo menos 10 caracteres).'; erro.hidden = false; geral.focus(); return; }
        if (!dados.setores.some(function (s) { return s.poa > 0; })) { erro.textContent = 'Para aprovar, ao menos um setor precisa ter POA maior que zero.'; erro.hidden = false; return; }
        if (!sobrep.hidden) { erro.textContent = 'Setores com POA se sobrepõem: ajuste antes de aprovar (ou salve como rascunho).'; erro.hidden = false; return; }
        var okAprovar = await UI.confirmar({
          titulo: 'Aprovar esta versão do cenário?',
          texto: 'Depois de aprovada, a versão NÃO pode ser alterada nem apagada. Para rever, você cria uma nova versão e o histórico fica registrado no diário. Confira hipóteses, limitações e evidências.',
          ok: 'Aprovar versão', empilhar: true,
        });
        if (!okAprovar) return;
      }
      ocupado(true);
      try {
        var r = await C.rpc('cenario_salvar_rascunho', { p_vitima: vitimaId, p_dados: dados });
        if (aprovar) {
          await C.rpc('cenario_aprovar', { p_cenario: r.cenario.id, p_revisao: r.cenario.atualizado_em, p_chave: chaveAprovacao });
          UI.aviso('Versão ' + r.cenario.numero + ' aprovada.', 'ok');
        } else {
          UI.aviso('Rascunho salvo (ainda não vale nos cálculos).', 'ok');
        }
        fechar(true);
        if (aoConcluir) aoConcluir();
      } catch (e) {
        erro.textContent = e.message; erro.hidden = false;
        if (e.codigo === 'cenario_versao_desatualizada') { erro.textContent += ' Feche e abra o cenário de novo para ver a versão do colega.'; }
        ocupado(false);
      }
    }
    btnSalvar.addEventListener('click', function () { salvar(false); });
    btnAprovar.addEventListener('click', function () { salvar(true); });
    if (btnDescartar) btnDescartar.addEventListener('click', async function () {
      var ok = await UI.confirmar({ titulo: 'Descartar o rascunho?', texto: 'O rascunho da versão ' + rasc.numero + ' será apagado. As versões aprovadas não são afetadas.', ok: 'Descartar rascunho', perigo: true, empilhar: true });
      if (!ok) return;
      ocupado(true);
      try {
        await C.rpc('cenario_descartar_rascunho', { p_cenario: rasc.id });
        UI.aviso('Rascunho descartado.', 'ok');
        fechar(true);
        if (aoConcluir) aoConcluir();
      } catch (e) { erro.textContent = e.message; erro.hidden = false; ocupado(false); }
    });

    var numero = rasc ? rasc.numero : ((versoesDa(vitimaId).slice(-1)[0] || { numero: 0 }).numero + 1);
    var corpo = el('div', { classe: 'editor-cenario' }, [
      el('h2', { id: 'modal-titulo', texto: 'Cenário de ' + nomeVitima(vitimaId) + ' — versão ' + numero + ' (' + (rasc ? 'rascunho' : 'nova versão') + ')' }),
      aviso('POA é a chance de a pessoa estar em cada setor. É uma decisão sua (perfil, última posição, relatos, terreno): registre o raciocínio. A soma pode ficar abaixo de 100%; o resto é "fora dos setores desenhados". Setores com POA não podem se sobrepor.'),
      origem && !rasc ? aviso('Parte da versão ' + ap.numero + ' aprovada. Ela continua no histórico; esta cria a versão ' + numero + '.') : null,
      el('div', { classe: 'cenario-recursos' }, recursos),
      tabelaCampos,
      total,
      sobrep,
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'cenario-just', texto: 'Justificativa da versão (obrigatória para aprovar)' }), geral]),
      el('div', { classe: 'grupo grupo-2col' }, [
        el('div', null, [el('label', { classe: 'rotulo', for: 'cenario-hr', texto: 'Horário de referência (a que momento o cenário se refere)' }), hr]),
        el('div', null, [el('label', { classe: 'rotulo', for: 'cenario-ponto', texto: 'Último ponto confiável' }), selPonto]),
      ]),
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'cenario-hip', texto: 'Hipóteses (deslocamento ou permanência)' }), hip]),
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'cenario-lim', texto: 'Limitações' }), lim]),
      el('div', { classe: 'grupo grupo-2col' }, [
        el('div', null, [el('label', { classe: 'rotulo', for: 'cenario-conf', texto: 'Sustentação dos dados (julgamento, não intervalo estatístico)' }), conf]),
        el('div', null, [el('label', { classe: 'rotulo', for: 'cenario-origem', texto: 'Origem do POA' }), origemPoa]),
      ]),
      el('div', { classe: 'grupo' }, [
        el('span', { classe: 'rotulo', texto: 'Evidências consideradas (marque as que sustentam o cenário e se estão confirmadas; relato não confirmado não vale como verificado)' }),
        listaEv,
        el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'cenario-add-evidencia', texto: '+ Outra evidência', onclick: function () { addEvidencia({ livre: true, texto: '', marcada: true, confirmada: false }); } }),
      ]),
      erro,
      el('div', { classe: 'modal-acoes' }, [btnCancelar, btnDescartar, btnSalvar, btnAprovar]),
    ]);
    var fechar = UI.abrirModal(corpo, { fecharNoFundo: false, empilhar: true });
    atualizarTotal();
  }

  /* ---------- Registro manual da busca (POD) ----------------------------- */
  function abrirRegistro(o) {
    o = o || {};
    var setores = (P.setores() || []).slice().sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
    if (!setores.length) { UI.aviso('Desenhe pelo menos um setor de busca antes de registrar uma busca.', 'erro', 7000); return; }
    var grupos = (P.grupos ? P.grupos() : []) || [];
    var missoes = (P.missoes ? P.missoes() : []) || [];
    var chave = chaveNova();   // a mesma chave se o envio for repetido: o servidor não duplica

    var selSetor = el('select', { classe: 'campo', id: 'busca-setor' }, setores.map(function (s) {
      return el('option', { value: s.id, selected: s.id === o.setorId ? true : null, texto: s.nome });
    }));
    var finalidade = el('select', { classe: 'campo', id: 'busca-final' }, [
      el('option', { value: 'pos_execucao', texto: 'Busca realizada (pós-execução)' }),
      el('option', { value: 'planejada', texto: 'Busca planejada (previsão: não altera o POA)' }),
    ]);
    var equipe = el('input', { classe: 'campo', id: 'busca-equipe', maxlength: '60', list: 'busca-equipes', placeholder: 'Grupo ou equipe que fez a busca' });
    var lista = el('datalist', { id: 'busca-equipes' }, grupos.map(function (g) { return el('option', { value: g.nome }); }));
    var metodo = el('select', { classe: 'campo', id: 'busca-metodo' }, [el('option', { value: '', texto: 'não informado' })].concat(METODOS.map(function (m) { return el('option', { value: m, texto: m }); })));
    var observ = el('input', { classe: 'campo campo-poa', id: 'busca-observ', type: 'number', min: '1', max: '500', step: '1', inputmode: 'numeric', placeholder: 'nº' });
    var selMissao = el('select', { classe: 'campo', id: 'busca-missao' });
    function atualizarMissoes() {
      selMissao.innerHTML = '';
      selMissao.appendChild(el('option', { value: '', texto: 'nenhum' }));
      missoes.filter(function (m) { return m.setor_id === selSetor.value; }).forEach(function (m) {
        selMissao.appendChild(el('option', { value: m.id, texto: m.grupo_nome + (m.chegou_setor_em ? ' · chegou às ' + C.hora(m.chegou_setor_em, false) : '') }));
      });
    }
    selSetor.addEventListener('change', atualizarMissoes);
    atualizarMissoes();
    var alcance = el('select', { classe: 'campo', id: 'busca-alcance' }, [
      el('option', { value: 'setor_inteiro', texto: 'O setor inteiro' }),
      el('option', { value: 'parcial', texto: 'Só parte do setor' }),
    ]);
    var cobertura = el('input', { classe: 'campo campo-poa', id: 'busca-cobertura', type: 'number', min: '1', max: '99', step: '1', inputmode: 'decimal', placeholder: '% do setor' });
    var gCobertura = el('div', { classe: 'grupo', hidden: true }, [
      el('label', { classe: 'rotulo', for: 'busca-cobertura', texto: 'Quanto do setor foi coberto (%)' }), cobertura,
      el('p', { classe: 'ajuda', texto: 'O POD abaixo é o da parte coberta. O app o converte para o setor inteiro (POD × fração coberta), supondo a pessoa, se estiver no setor, distribuída de forma uniforme nele. Se isso não vale (trilha, ponto específico), divida o setor em setores menores.' }),
    ]);
    alcance.addEventListener('change', function () { gCobertura.hidden = alcance.value !== 'parcial'; });
    var naoEst = el('input', { type: 'checkbox', id: 'busca-nao-estimada' });
    var pod = el('input', { classe: 'campo campo-poa', id: 'busca-pod', type: 'number', min: '0', max: '100', step: '1', inputmode: 'decimal', placeholder: '0 a 100' });
    var rotBase = el('label', { classe: 'rotulo', for: 'busca-base', texto: 'Em que o POD se baseia (obrigatório)' });
    var base = el('textarea', { classe: 'campo', id: 'busca-base', rows: '2', maxlength: '1000', placeholder: 'Ex.: varredura em linha, 5 m entre buscadores, cobrimos 80% do setor; mata fechada' });
    function aoMudarEstimativa() {
      var nao = naoEst.checked && finalidade.value !== 'planejada';
      pod.disabled = nao;
      if (nao) pod.value = '';
      rotBase.textContent = nao ? 'Por que não foi possível estimar o POD (obrigatório)' : 'Em que o POD se baseia (obrigatório)';
      base.placeholder = nao ? 'Ex.: equipe sem observador treinado, sem relato do que foi visto' : 'Ex.: varredura em linha, 5 m entre buscadores, cobrimos 80% do setor; mata fechada';
    }
    naoEst.addEventListener('change', aoMudarEstimativa);
    finalidade.addEventListener('change', function () { if (finalidade.value === 'planejada') naoEst.checked = false; naoEst.disabled = finalidade.value === 'planejada'; aoMudarEstimativa(); });
    var origemPod = el('select', { classe: 'campo', id: 'busca-origem' }, ['julgamento_comando', 'consenso_documentado'].map(function (k) { return el('option', { value: k, texto: ORIGENS[k] }); }));
    var cond = el('input', { classe: 'campo', id: 'busca-cond', maxlength: '500', placeholder: 'Visibilidade, clima, terreno (opcional)' });
    var imped = el('input', { classe: 'campo', id: 'busca-imped', maxlength: '500', placeholder: 'Obstáculos, pausas, desvios (opcional)' });
    var naoObs = el('input', { classe: 'campo', id: 'busca-nao-obs', maxlength: '500', placeholder: 'Trechos que ficaram sem observação adequada (opcional)' });
    var ini = el('input', { classe: 'campo', id: 'busca-ini', type: 'datetime-local' });
    var fim = el('input', { classe: 'campo', id: 'busca-fim', type: 'datetime-local' });
    var vale = el('select', { classe: 'campo', id: 'busca-vale' }, [el('option', { value: '', texto: 'Todas as vítimas' })].concat(est.vitimas.map(function (v) {
      return el('option', { value: v.id, selected: v.id === o.vitimaId ? true : null, texto: 'Só ' + v.nome });
    })));
    var erro = el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'busca-salvar', texto: 'Registrar busca' });

    var form = el('form', { classe: 'form-busca', novalidate: true }, [
      el('h2', { id: 'modal-titulo', texto: 'Registrar busca (POD)' }),
      aviso('O POD é o que a equipe estima: se a pessoa estivesse neste setor, quantas chances em 100 a equipe teria tido de achá-la? Vem do relato, não do GPS (a trilha mostra por onde passaram, não o que viram). Sem base para estimar, marque "POD não estimada": a busca fica registrada, mas não reduz o POA (e não vira zero). Não dá para editar depois; se errar, anule e lance outro.'),
      el('div', { classe: 'grupo grupo-2col' }, [
        el('div', null, [el('label', { classe: 'rotulo', for: 'busca-setor', texto: 'Setor pesquisado' }), selSetor]),
        el('div', null, [el('label', { classe: 'rotulo', for: 'busca-final', texto: 'Tipo de registro' }), finalidade]),
      ]),
      el('div', { classe: 'grupo grupo-2col' }, [
        el('div', null, [el('label', { classe: 'rotulo', for: 'busca-equipe', texto: 'Equipe' }), equipe, lista]),
        el('div', null, [el('label', { classe: 'rotulo', for: 'busca-metodo', texto: 'Método' }), metodo]),
      ]),
      el('div', { classe: 'grupo grupo-2col' }, [
        el('div', null, [el('label', { classe: 'rotulo', for: 'busca-observ', texto: 'Observadores efetivos' }), observ]),
        el('div', null, [el('label', { classe: 'rotulo', for: 'busca-missao', texto: 'Deslocamento relacionado' }), selMissao]),
      ]),
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'busca-alcance', texto: 'A busca cobriu' }), alcance]),
      gCobertura,
      el('div', { classe: 'grupo' }, [
        el('label', { classe: 'rotulo', for: 'busca-pod', texto: 'POD estimado (%)' }), pod,
        el('label', { classe: 'cenario-nao-est' }, [naoEst, ' POD não estimada (sem base para estimar)']),
      ]),
      el('div', { classe: 'grupo' }, [rotBase, base]),
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'busca-origem', texto: 'Origem da estimativa' }), origemPod]),
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'busca-cond', texto: 'Condições da busca' }), cond]),
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'busca-imped', texto: 'Impedimentos' }), imped]),
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'busca-nao-obs', texto: 'Áreas não observadas' }), naoObs]),
      el('div', { classe: 'grupo grupo-2col' }, [
        el('div', null, [el('label', { classe: 'rotulo', for: 'busca-ini', texto: 'Início (opcional)' }), ini]),
        el('div', null, [el('label', { classe: 'rotulo', for: 'busca-fim', texto: 'Fim (opcional)' }), fim]),
      ]),
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'busca-vale', texto: 'Vale para' }), vale]),
      erro,
      el('div', { classe: 'modal-acoes' }, [el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var planejada = finalidade.value === 'planejada';
      var naoEstimada = naoEst.checked && !planejada;
      var v = naoEstimada ? null : Number(pod.value.replace(',', '.'));
      if (!naoEstimada && (pod.value.trim() === '' || !(v >= 0 && v <= 100))) { erro.textContent = 'Informe o POD entre 0 e 100% ou marque "POD não estimada".'; erro.hidden = false; return; }
      if (base.value.trim().length < 5) { erro.textContent = naoEstimada ? 'Diga por que não foi possível estimar (pelo menos 5 caracteres).' : 'Diga em que o POD se baseia (pelo menos 5 caracteres).'; erro.hidden = false; base.focus(); return; }
      var cob = null;
      if (alcance.value === 'parcial') {
        cob = Number(cobertura.value.replace(',', '.')) / 100;
        if (!(cob > 0 && cob < 1)) { erro.textContent = 'Informe quanto do setor foi coberto, entre 1% e 99%.'; erro.hidden = false; return; }
      }
      var iniMs = ini.value ? new Date(ini.value).getTime() : null, fimMs = fim.value ? new Date(fim.value).getTime() : null;
      if (iniMs != null && fimMs != null && fimMs < iniMs) { erro.textContent = 'O fim não pode ser antes do início.'; erro.hidden = false; return; }
      var nomeEquipe = equipe.value.trim();
      var grupo = grupos.find(function (g) { return g.nome.trim().toLowerCase() === nomeEquipe.toLowerCase(); });
      btn.disabled = true;
      try {
        await C.rpc('busca_registrar', { p_operacao: P.op().id, p_dados: {
          setor_id: selSetor.value, finalidade: finalidade.value, pod: v == null ? null : Math.round(v * 100) / 10000, base_estimativa: base.value.trim(), condicoes: cond.value.trim(),
          origem_pod: origemPod.value, metodo: metodo.value || null, missao_id: selMissao.value || null,
          alcance: alcance.value, cobertura_fracao: cob == null ? null : Math.round(cob * 1e4) / 1e4, observadores: observ.value ? Number(observ.value) : null,
          impedimentos: imped.value.trim(), areas_nao_observadas: naoObs.value.trim(),
          equipe: nomeEquipe, grupo_id: grupo ? grupo.id : null, vitima_id: vale.value || null, chave_cliente: chave,
          inicio: iniMs != null ? new Date(iniMs).toISOString() : null, fim: fimMs != null ? new Date(fimMs).toISOString() : null,
        } });
        UI.aviso(planejada ? 'Busca planejada registrada.' : naoEstimada ? 'Busca registrada (POD não estimada: o POA não foi alterado).' : 'Busca registrada.', 'ok');
        fechar(true);
        carregar();
      } catch (e) {
        erro.textContent = e.message; erro.hidden = false; btn.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false, empilhar: true });
    pod.focus();
  }

  function abrirAnulacao(r) {
    var motivo = el('textarea', { classe: 'campo', id: 'anular-motivo', rows: '2', maxlength: '500', placeholder: 'Ex.: lancei no setor errado' });
    var erro = el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = el('button', { classe: 'btn btn-perigo', type: 'submit', id: 'anular-confirmar', texto: 'Anular registro' });
    var form = el('form', { novalidate: true }, [
      el('h2', { id: 'modal-titulo', texto: 'Anular registro de busca' }),
      aviso('Setor ' + r.setor_nome + ' · ' + (r.pod == null ? 'POD não estimada' : 'POD ' + pct(Number(r.pod))) + ' · ' + (r.equipe || 'equipe não informada') + '. O registro continua no histórico, mas deixa de contar no cálculo.'),
      el('div', { classe: 'grupo' }, [el('label', { classe: 'rotulo', for: 'anular-motivo', texto: 'Motivo (obrigatório)' }), motivo]),
      erro,
      el('div', { classe: 'modal-acoes' }, [el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      if (motivo.value.trim().length < 3) { erro.textContent = 'Escreva o motivo da anulação.'; erro.hidden = false; return; }
      btn.disabled = true;
      try {
        await C.rpc('busca_anular', { p_registro: r.id, p_motivo: motivo.value.trim() });
        UI.aviso('Registro anulado.', 'ok');
        fechar(true);
        carregar();
      } catch (e) { erro.textContent = e.message; erro.hidden = false; btn.disabled = false; }
    });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false, empilhar: true });
    motivo.focus();
  }

  /* ---------- Bloco no detalhe do setor ---------------------------------- */
  function blocoSetor(d) {
    var sec = el('section', { classe: 'pod-bloco', 'aria-label': 'Probabilidades de busca' }, [el('h3', { texto: 'Probabilidades de busca' })]);
    if (est.ausente) { sec.appendChild(el('p', { classe: 'muted', texto: 'Disponível depois de rodar as migrações 033 e 034 no banco.' })); return sec; }
    if (!est.vitimas.length) {
      sec.appendChild(el('p', { classe: 'muted', texto: 'Sem vítima cadastrada: o cenário (POA) é feito por vítima.' }));
    } else {
      var dl = el('dl', { classe: 'dados' });
      est.vitimas.forEach(function (v) {
        var ap = aprovadaDa(v.id);
        var res = ap ? resultadoDa(v.id) : null;
        var s = res && res.setores.find(function (x) { return x.setorId === d.id; });
        var rasc = rascunhoDa(v.id);
        dl.appendChild(el('dt', { texto: v.nome + (localizacaoDa(v.id) ? ' (localizada)' : '') }));
        dl.appendChild(el('dd', null, [
          ap
            ? (s ? 'POA ' + pct(s.poa) + ' (versão ' + ap.numero + ') · POD ' + (s.pod != null ? pct(s.pod) : (s.semEstimativa ? 'não estimada' : '—')) + ' · POS ' + pct(s.pos) + ' · POA atual ' + pct(s.poaAtual)
              : 'Este setor não está na versão ' + ap.numero + ' aprovada (POA zero).')
            : 'Sem cenário aprovado (POA não definido).',
          rasc ? el('small', { classe: 'muted', texto: ' Há rascunho da versão ' + rasc.numero + ' (não vale ainda).' }) : null,
        ]));
      });
      sec.appendChild(dl);
    }
    var regs = est.registros.filter(function (r) { return r.setor_id === d.id; }).slice().reverse();
    sec.appendChild(regs.length
      ? el('ol', { classe: 'pod-buscas' }, regs.map(function (r) {
        return el('li', { classe: r.anulado_em ? 'registro-anulado' : null, texto: C.hora(r.registrado_em, false) + ' · ' + (r.equipe || 'Equipe não informada') + (r.finalidade === 'planejada' ? ' (planejada)' : '') + ': ' +
          (r.pod == null ? 'POD não estimada' : 'POD ' + pct(Number(r.pod)) + (r.alcance === 'parcial' ? ' em ' + pct(Number(r.cobertura_fracao), 0) + ' do setor' : '')) +
          (r.vitima_id ? ' (só ' + nomeVitima(r.vitima_id) + ')' : '') + (r.anulado_em ? ' — anulado: ' + r.anulado_motivo : '') });
      }))
      : el('p', { classe: 'muted', texto: 'Nenhuma busca registrada neste setor. O POD vem do registro manual da equipe, nunca do GPS.' }));
    var acoes = [el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'setor-abrir-cenario', texto: 'Abrir cenário', onclick: function () { UI.fecharModal(); abrir(); } })];
    if (podeAlterar()) acoes.unshift(el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'setor-registrar-busca', texto: 'Registrar busca neste setor', onclick: function () { UI.fecharModal(); abrirRegistro({ setorId: d.id }); } }));
    sec.appendChild(el('div', { classe: 'cenario-recursos' }, acoes));
    return sec;
  }

  /* ---------- Dados para o relatório final (versões aprovadas, buscas e situação atual) ---------- */
  async function dadosRelatorio() {
    await carregar();
    if (est.ausente || !est.vitimas.length) return null;
    var vitimas = est.vitimas.map(function (v) {
      var versoes = versoesDa(v.id).filter(function (c) { return c.estado === 'aprovada'; });
      var res = resultadoDa(v.id);
      var loc = localizacaoDa(v.id);
      return {
        nome: v.nome, localizada: loc ? { condicao: loc.condicao, em: loc.registrado_em } : null,
        versoes: versoes.map(function (c) {
          return { numero: c.numero, aprovada_em: c.aprovada_em, aprovada_por_nome: c.aprovada_por_nome, horario_referencia: c.horario_referencia, justificativa: c.justificativa,
            hipoteses: c.hipoteses, limitacoes: c.limitacoes, confianca: c.confianca, origem_poa: c.origem_poa, ponto_confiavel: c.ponto_confiavel,
            setores: c.setores.map(function (i) { return { nome: i.setor_nome, poa: Number(i.poa), area_m2: i.area_m2, justificativa: i.justificativa }; }),
            evidencias: c.evidencias.map(function (e) { return { descricao: e.descricao, confirmada: e.confirmada }; }) };
        }),
        atual: res ? { versao: res.versao, posTotal: res.posTotal, poaFora: res.poaFora, poaForaAtual: res.poaForaAtual,
          setores: res.setores.map(function (s) { return { nome: s.nome, poa: s.poa, pod: s.pod, semEstimativa: s.semEstimativa, pos: s.pos, poaAtual: s.poaAtual }; }) } : null,
      };
    });
    var registros = est.registros.map(function (r) {
      return { registrado_em: r.registrado_em, setor: r.setor_nome, equipe: r.equipe, metodo: r.metodo, finalidade: r.finalidade, pod: r.pod == null ? null : Number(r.pod),
        cobertura_fracao: r.cobertura_fracao == null ? null : Number(r.cobertura_fracao), base_estimativa: r.base_estimativa, origem_pod: r.origem_pod,
        vitima: r.vitima_id ? nomeVitima(r.vitima_id) : null, anulado: r.anulado_em ? { motivo: r.anulado_motivo, por: r.anulado_por_nome } : null };
    });
    if (!registros.length && !vitimas.some(function (x) { return x.versoes.length; })) return null;
    return { vitimas: vitimas, registros: registros };
  }

  window.BuscaCenario = { iniciar: iniciar, parar: parar, abrir: abrir, abrirRegistro: abrirRegistro, blocoSetor: blocoSetor, recarregar: carregar, dadosRelatorio: dadosRelatorio };
})();
