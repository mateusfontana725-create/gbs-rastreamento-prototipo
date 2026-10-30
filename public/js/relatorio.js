/* =====================================================================
 * relatorio.js — DIÁRIO DA OPERAÇÃO e RELATÓRIO FINAL (painel).
 *   Diário: lista cronológica por dia (eventos automáticos gravados pelo
 *   banco + observações dos responsáveis), filtros, observação nova,
 *   edição com histórico. Tudo passa pelas funções do banco (RLS).
 *   Relatório: resultado da operação, PDF (pdfmake, carregado só quando
 *   usado), mapas desenhados em canvas e fotos reduzidas. Cada PDF gerado
 *   é guardado no bucket privado "relatorios" (sem exclusão pelo app).
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI;
  if (!C || !UI) return;
  function $(id) { return document.getElementById(id); }
  function P() { return window.Painel || null; }

  var CATEGORIAS = [
    ['todas', 'Tudo'],
    ['setor', 'Setores'],
    ['deslocamento,chegada', 'Deslocamentos e chegadas'],
    ['encontro', 'Encontros'],
    ['alerta', 'Alertas'],
    ['pessoa', 'Pessoas'],
    ['observacao', 'Observações'],
    ['operacao,documento', 'Operação'],
  ];
  var ROTULO_CAT = {
    operacao: 'Operação', setor: 'Setor', deslocamento: 'Deslocamento', chegada: 'Chegada', encontro: 'Encontro',
    alerta: 'Alerta', pessoa: 'Pessoas', observacao: 'Observação', documento: 'Documento',
  };
  // Registros do IPO no diário (categoria operação): procedimento, recurso e desdobramento.
  var TIPOS_IPO = { procedimento: 'Procedimento de busca', recurso: 'Recurso empregado', desdobramento: 'Desdobramento' };
  var TIPOS_NOVOS = [
    ['observacao', 'Observação'],
    ['procedimento', 'Procedimento de busca sendo realizado'],
    ['recurso', 'Recurso empregado (CB deslocado)'],
    ['desdobramento', 'Desdobramento do dia'],
  ];
  var RESULTADOS = [
    ['localizada_viva', 'Vítima localizada com vida'],
    ['localizada_obito', 'Vítima localizada em óbito'],
    ['nao_localizada', 'Vítima não localizada (busca suspensa ou encerrada)'],
    ['outro', 'Outro desfecho (descreva)'],
  ];
  var DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

  function dd(n) { return (n < 10 ? '0' : '') + n; }
  function dataHora(v) {
    var ms = C.paraMs(v);
    if (ms == null) return '—';
    var d = new Date(ms);
    return dd(d.getDate()) + '/' + dd(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + dd(d.getHours()) + ':' + dd(d.getMinutes());
  }
  function horaMin(v) { var d = new Date(C.paraMs(v)); return dd(d.getHours()) + ':' + dd(d.getMinutes()); }
  function chaveDia(v) { var d = new Date(C.paraMs(v)); return d.getFullYear() + '-' + dd(d.getMonth() + 1) + '-' + dd(d.getDate()); }
  function rotuloDia(v) {
    var d = new Date(C.paraMs(v));
    var hoje = new Date(C.agora());
    var ontem = new Date(hoje.getTime() - 864e5);
    var base = dd(d.getDate()) + '/' + dd(d.getMonth() + 1) + '/' + d.getFullYear();
    if (chaveDia(d) === chaveDia(hoje)) return 'Hoje · ' + base;
    if (chaveDia(d) === chaveDia(ontem)) return 'Ontem · ' + base;
    var dia = DIAS[d.getDay()];
    return dia.charAt(0).toUpperCase() + dia.slice(1) + ' · ' + base;
  }
  // ISO ↔ <input type="datetime-local"> no fuso do aparelho
  function paraCampo(v) {
    var d = new Date(C.paraMs(v));
    return d.getFullYear() + '-' + dd(d.getMonth() + 1) + '-' + dd(d.getDate()) + 'T' + dd(d.getHours()) + ':' + dd(d.getMinutes());
  }
  function deCampo(s) {
    if (!s) return null;
    var d = new Date(s);
    return isNaN(d) ? null : d.toISOString();
  }

  /* ================================================================== */
  /* DIÁRIO                                                               */
  /* ================================================================== */
  var diario = { op: null, itens: new Map(), filtro: 'todas', canal: null, render: null, fechar: null, erro: null };

  async function carregarDiario(opId) {
    var linhas = await C.consultarTudo(function () {
      return C.cliente.from('diario').select('*').eq('operacao_id', opId).order('ocorrido_em', { ascending: true }).order('id', { ascending: true });
    });
    diario.itens = new Map(linhas.map(function (l) { return [l.id, l]; }));
  }

  function assinarDiario(opId) {
    pararDiario();
    try {
      diario.canal = C.cliente.channel('diario-' + opId + '-' + Date.now())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'diario', filter: 'operacao_id=eq.' + opId }, function (ev) {
          if (ev.new && ev.new.id) {
            diario.itens.set(ev.new.id, ev.new);
            if (diario.render) diario.render();
          }
        })
        .subscribe();
    } catch (e) { /* o botão "Atualizar" cobre */ }
  }
  function pararDiario() {
    if (diario.canal) { try { C.cliente.removeChannel(diario.canal); } catch (e) { /* ignora */ } }
    diario.canal = null;
  }

  async function abrirDiario(op) {
    if (!op) return;
    diario.op = op;
    diario.filtro = 'todas';
    var lista = UI.el('div', { classe: 'diario-lista', id: 'diario-lista', 'aria-live': 'polite' });
    var resumo = UI.el('p', { classe: 'muted diario-resumo', id: 'diario-resumo', texto: 'Carregando…' });
    var filtros = UI.el('div', { classe: 'diario-filtros', role: 'toolbar', 'aria-label': 'Filtrar o diário' });
    CATEGORIAS.forEach(function (c) {
      filtros.appendChild(UI.el('button', { classe: 'btn btn-pequeno' + (c[0] === 'todas' ? ' btn-ativo' : ''), type: 'button', 'data-cat': c[0],
        'aria-pressed': String(c[0] === 'todas'), texto: c[1], onclick: function () { diario.filtro = c[0]; render(); } }));
    });
    // operação encerrada: diário só para leitura (o servidor também recusa, migração 026)
    var btnNova = op.status === 'ativa' ? UI.el('button', { classe: 'btn btn-primario', type: 'button', id: 'diario-nova', texto: '+ Novo registro', onclick: function () { formObservacao(null); } }) : null;
    var btnAtualizar = UI.el('button', { classe: 'btn', type: 'button', texto: 'Atualizar', onclick: function () { recarregar(); } });
    var btnRelatorio = UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Relatório final (PDF)', onclick: function () { fechar(); abrirRelatorio(op); } });

    var fechar = UI.abrirModal(UI.el('div', { classe: 'modal-diario' }, [
      UI.el('div', { classe: 'diario-topo' }, [
        UI.el('div', null, [
          UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Diário da operação' }, [UI.dica('Os eventos automáticos vêm dos setores, deslocamentos, alertas, relatos e pessoas e não podem ser alterados. As observações podem ser editadas por qualquer responsável da operação; cada edição fica registrada.')]),
          resumo,
        ]),
        UI.el('div', { classe: 'diario-acoes' }, [btnNova, btnRelatorio]),
      ]),
      filtros,
      lista,
      UI.rodape([btnAtualizar, UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]), { aoFechar: function () { pararDiario(); diario.render = null; diario.fechar = null; } });
    diario.fechar = fechar;

    function render() {
      filtros.querySelectorAll('button').forEach(function (b) {
        var ativo = b.getAttribute('data-cat') === diario.filtro;
        b.classList.toggle('btn-ativo', ativo);
        b.setAttribute('aria-pressed', String(ativo));
      });
      var cats = diario.filtro === 'todas' ? null : diario.filtro.split(',');
      var todos = Array.from(diario.itens.values()).sort(function (a, b) { return C.paraMs(a.ocorrido_em) - C.paraMs(b.ocorrido_em) || a.id - b.id; });
      var itens = todos.filter(function (e) { return !cats || cats.indexOf(e.categoria) !== -1; });
      var obs = todos.filter(function (e) { return e.origem === 'manual'; }).length;
      resumo.textContent = todos.length + ' registro(s) · ' + obs + ' observação(ões) · ' + op.codigo;
      lista.innerHTML = '';
      if (!itens.length) {
        lista.appendChild(UI.el('p', { classe: 'muted vazio', texto: cats ? 'Nada neste filtro.' : 'Nenhum registro ainda.' }));
        return;
      }
      var diaAtual = null, ul = null;
      // mais recente em cima (quem está acompanhando quer ver o que acabou de acontecer)
      itens.slice().reverse().forEach(function (e) {
        var k = chaveDia(e.ocorrido_em);
        if (k !== diaAtual) {
          diaAtual = k;
          lista.appendChild(UI.el('h3', { classe: 'diario-dia', texto: rotuloDia(e.ocorrido_em) }));
          ul = UI.el('ol', { classe: 'diario-itens' });
          lista.appendChild(ul);
        }
        ul.appendChild(itemDiario(e));
      });
    }
    diario.render = render;

    async function recarregar() {
      try {
        await carregarDiario(op.id);
        render();
      } catch (e) {
        resumo.textContent = e.codigo === 'desconhecido' && /diario/.test(e.message) ? 'O diário ainda não está disponível no servidor: execute a migração 012 no Supabase.' : e.message;
      }
    }
    assinarDiario(op.id);
    await recarregar();
  }

  function rotuloProcedimento(chave) {
    var p = (window.Ipo && window.Ipo.PROCEDIMENTOS || []).filter(function (x) { return x[0] === chave; })[0];
    return p ? p[1] : chave;
  }

  function tituloDoRegistro(e) {
    if (e.tipo === 'procedimento') return 'Procedimento de busca: ' + rotuloProcedimento(e.ref_id);
    if (TIPOS_IPO[e.tipo]) return TIPOS_IPO[e.tipo];
    return e.origem === 'manual' ? 'Observação' : e.titulo;
  }

  function itemDiario(e) {
    var manual = e.origem === 'manual';
    var acoes = UI.el('div', { classe: 'diario-item-acoes' }, [
      e.lat != null && P() && P().mapa() ? UI.el('button', { classe: 'btn btn-pequeno btn-link', type: 'button', texto: 'Ver no mapa', onclick: function () { verNoMapa(e); } }) : null,
      manual && diario.op && diario.op.status === 'ativa' ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Editar', onclick: function () { formObservacao(e); } }) : null,
      manual && e.versao > 1 ? UI.el('button', { classe: 'btn btn-pequeno btn-link', type: 'button', texto: 'Histórico (' + (e.versao - 1) + ')', onclick: function () { abrirHistorico(e); } }) : null,
    ]);
    return UI.el('li', { classe: 'diario-item cat-' + e.categoria + (e.nivel === 'critico' ? ' critico' : '') + (manual ? ' manual' : '') }, [
      UI.el('span', { classe: 'diario-hora num', texto: horaMin(e.ocorrido_em) }),
      UI.el('div', { classe: 'diario-corpo' }, [
        UI.el('div', { classe: 'diario-cabeca' }, [
          UI.el('span', { classe: 'selo diario-cat', texto: ROTULO_CAT[e.categoria] || e.categoria }),
          UI.el('strong', { texto: tituloDoRegistro(e) }),
        ]),
        e.detalhe ? UI.el('p', { classe: 'diario-detalhe', texto: e.detalhe }) : null,
        UI.el('small', { classe: 'muted', texto: (manual ? 'Escrita por ' : 'Registrado: ') + e.autor_nome +
          (manual && e.editado_em ? ' · editada por ' + e.editado_por_nome + ' em ' + dataHora(e.editado_em) : '') +
          (Math.abs(C.paraMs(e.registrado_em) - C.paraMs(e.ocorrido_em)) > 120000 ? ' · lançada em ' + dataHora(e.registrado_em) : '') }),
        acoes.childNodes.length ? acoes : null,
      ]),
    ]);
  }

  function verNoMapa(e) {
    var p = P();
    if (!p || !p.mapa()) return;
    if (diario.fechar) diario.fechar();
    var mapa = p.mapa();
    mapa.setView([e.lat, e.lng], Math.max(mapa.getZoom(), 16));
    var marca = L.circleMarker([e.lat, e.lng], { radius: 18, color: e.nivel === 'critico' ? '#ef4444' : '#f59e0b', weight: 3, fill: false, className: 'pulso-alerta', interactive: false }).addTo(mapa);
    setTimeout(function () { marca.remove(); }, 8000);
  }

  function formObservacao(e) {
    var op = diario.op;
    var tipo = e && TIPOS_IPO[e.tipo] ? e.tipo : 'observacao';
    var quando = UI.el('input', { classe: 'campo', id: 'obs-quando', type: 'datetime-local', required: true, max: paraCampo(C.agora()), value: paraCampo(e ? e.ocorrido_em : C.agora()) });
    var escolha = UI.el('select', { classe: 'campo', id: 'obs-tipo', disabled: e ? true : null }, TIPOS_NOVOS.map(function (t) {
      return UI.el('option', { value: t[0], selected: t[0] === tipo ? true : null, texto: t[1] });
    }));
    var procedimento = UI.el('select', { classe: 'campo', id: 'obs-procedimento', disabled: e ? true : null },
      [UI.el('option', { value: '', texto: '— escolha —' })].concat(window.Ipo.PROCEDIMENTOS.map(function (p) {
        return UI.el('option', { value: p[0], selected: e && e.ref_id === p[0] ? true : null, texto: p[1] });
      })));
    var grupoProc = UI.el('div', { classe: 'grupo', hidden: tipo !== 'procedimento' }, [
      UI.el('label', { classe: 'rotulo', for: 'obs-procedimento', texto: 'Procedimento' }), procedimento]);
    escolha.addEventListener('change', function () { grupoProc.hidden = escolha.value !== 'procedimento'; });
    var dicas = { observacao: 'O que aconteceu, quem estava envolvido, decisões tomadas…', procedimento: 'Onde e como foi feito, equipe, ponto de início…',
      recurso: 'Ex.: ABS 0015/3º BBM — 2 militares em solo', desdobramento: 'O que foi feito e o que se apurou neste dia da operação' };
    var texto = UI.el('textarea', { classe: 'campo', id: 'obs-texto', rows: '5', maxlength: '4000', placeholder: dicas[tipo] });
    texto.value = e ? e.detalhe : '';
    escolha.addEventListener('change', function () { texto.placeholder = dicas[escolha.value] || dicas.observacao; });
    var erro = UI.el('p', { classe: 'erro-form', hidden: true });
    var salvar = UI.el('button', { classe: 'btn btn-primario', type: 'submit', texto: e ? 'Salvar edição' : 'Adicionar ao diário' });
    var form = UI.el('form', { classe: 'form-observacao form-padrao', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: e ? (TIPOS_IPO[e.tipo] ? 'Editar registro' : 'Editar observação') : 'Novo registro' },
        e ? [UI.dica('Escrito por ' + e.autor_nome + '. A versão anterior fica no histórico.')] : []),
      UI.grade([
        UI.campo('Tipo', escolha, { para: 'obs-tipo', largo: !grupoProc }),
        grupoProc,
        UI.campo('Data e hora', quando, { para: 'obs-quando' }),
      ]),
      UI.campo('Texto', texto, { para: 'obs-texto', largo: true }),
      erro,
      UI.rodape([
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); abrirDiario(op); } }),
        salvar,
      ]),
    ]);
    var fechar = UI.abrirModal(form, { fecharNoFundo: false });
    setTimeout(function () { texto.focus(); }, 40);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var iso = deCampo(quando.value);
      var novoTipo = escolha.value;
      if (!iso) { erro.textContent = 'Informe a data e a hora.'; erro.hidden = false; quando.focus(); return; }
      if (C.paraMs(iso) > C.agora() + 60000) { erro.textContent = 'A data e a hora não podem estar no futuro.'; erro.hidden = false; quando.focus(); return; }
      if (!e && novoTipo === 'procedimento' && !procedimento.value) { erro.textContent = 'Escolha o procedimento de busca.'; erro.hidden = false; procedimento.focus(); return; }
      if (!texto.value.trim()) { erro.textContent = novoTipo === 'observacao' || e ? 'Escreva a observação.' : 'Escreva o texto do registro.'; erro.hidden = false; texto.focus(); return; }
      salvar.disabled = true;
      try {
        var r;
        if (e) r = await C.rpc('diario_editar', { p_id: e.id, p_ocorrido_em: iso, p_texto: texto.value });
        else if (novoTipo === 'observacao') r = await C.rpc('diario_adicionar', { p_operacao: op.id, p_ocorrido_em: iso, p_texto: texto.value });
        else r = await C.rpc('diario_registrar_ipo', { p_operacao: op.id, p_ocorrido_em: iso, p_tipo: novoTipo,
          p_chave: novoTipo === 'procedimento' ? procedimento.value : null, p_texto: texto.value });
        diario.itens.set(r.id, r);
        UI.aviso(e ? 'Registro editado.' : novoTipo === 'observacao' ? 'Observação adicionada ao diário.' : 'Registro adicionado ao diário.', 'ok');
        fechar();
        abrirDiario(op);
      } catch (x) {
        erro.textContent = x.message;
        erro.hidden = false;
        salvar.disabled = false;
      }
    });
  }

  async function abrirHistorico(e) {
    var op = diario.op;
    var ul = UI.el('ol', { classe: 'diario-versoes' }, [UI.el('li', { classe: 'muted', texto: 'Carregando…' })]);
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Histórico da observação' }),
      UI.el('div', { classe: 'diario-versao atual' }, [
        UI.el('strong', { texto: 'Versão atual (' + e.versao + ')' }),
        UI.el('small', { classe: 'muted', texto: ' · fato em ' + dataHora(e.ocorrido_em) + ' · por ' + (e.editado_por_nome || e.autor_nome) }),
        UI.el('p', { texto: e.detalhe }),
      ]),
      ul,
      UI.rodape([UI.el('button', { classe: 'btn', type: 'button', texto: 'Voltar', onclick: function () { fechar(); abrirDiario(op); } })]),
    ]));
    try {
      var v = await C.consultar(C.cliente.from('diario_versoes').select('*').eq('diario_id', e.id).order('versao', { ascending: false }));
      ul.innerHTML = '';
      (v || []).forEach(function (x) {
        ul.appendChild(UI.el('li', { classe: 'diario-versao' }, [
          UI.el('strong', { texto: 'Versão ' + x.versao }),
          UI.el('small', { classe: 'muted', texto: ' · fato em ' + dataHora(x.ocorrido_em) + ' · escrita por ' + x.autor_nome + ' · substituída por ' + x.substituida_por_nome + ' em ' + dataHora(x.substituida_em) }),
          UI.el('p', { texto: x.detalhe }),
        ]));
      });
    } catch (x) {
      ul.innerHTML = '';
      ul.appendChild(UI.el('li', { classe: 'erro-form', texto: x.message }));
    }
  }

  /* ================================================================== */
  /* MAPA EM CANVAS (para o PDF)                                          */
  /* ================================================================== */
  var cacheTiles = new Map();
  function tileUrl(z, x, y) { return 'https://tile.openstreetmap.org/' + z + '/' + x + '/' + y + '.png'; }
  function carregarTile(url) {
    if (cacheTiles.has(url)) return cacheTiles.get(url);
    var p = new Promise(function (resolve) {
      var img = new Image();
      var t = setTimeout(function () { resolve(null); }, 10000);
      img.crossOrigin = 'anonymous';
      img.onload = function () { clearTimeout(t); resolve(img); };
      img.onerror = function () { clearTimeout(t); resolve(null); };
      img.src = url;
    });
    cacheTiles.set(url, p);
    return p;
  }
  function mundoX(lng, z) { return (lng + 180) / 360 * 256 * Math.pow(2, z); }
  function mundoY(lat, z) {
    var s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z);
  }
  function metrosPorPixel(lat, z) { return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z); }

  function pontosSetor(s) {
    if (s.forma === 'poligono') return s.pontos || [];
    var pts = [], R = 6371000;
    for (var i = 0; i < 48; i++) {
      var a = i / 48 * 2 * Math.PI;
      pts.push([s.centro_lat + (s.raio_m * Math.cos(a)) / R * 180 / Math.PI,
        s.centro_lng + (s.raio_m * Math.sin(a)) / (R * Math.cos(s.centro_lat * Math.PI / 180)) * 180 / Math.PI]);
    }
    return pts;
  }

  // o: { largura, altura, enquadrar: [[lat,lng]…], setores, destaque, trilhas, pontos, achados, local, fundo }
  async function desenharMapa(o) {
    var W = o.largura || 1100, H = o.altura || 680;
    var enq = (o.enquadrar || []).filter(function (p) { return p && isFinite(p[0]) && isFinite(p[1]); });
    if (!enq.length) return null;
    var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    enq.forEach(function (p) { minLat = Math.min(minLat, p[0]); maxLat = Math.max(maxLat, p[0]); minLng = Math.min(minLng, p[1]); maxLng = Math.max(maxLng, p[1]); });
    var z = 18;
    for (; z > 3; z--) {
      var w = mundoX(maxLng, z) - mundoX(minLng, z), h = mundoY(minLat, z) - mundoY(maxLat, z);
      if (w <= W * 0.82 && h <= H * 0.82) break;
    }
    if (enq.length === 1 || (maxLat - minLat < 1e-6 && maxLng - minLng < 1e-6)) z = Math.min(z, 16);
    var cx = (mundoX(minLng, z) + mundoX(maxLng, z)) / 2, cy = (mundoY(minLat, z) + mundoY(maxLat, z)) / 2;
    var x0 = cx - W / 2, y0 = cy - H / 2;
    function px(lat, lng) { return [mundoX(lng, z) - x0, mundoY(lat, z) - y0]; }

    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var g = cv.getContext('2d');
    g.fillStyle = '#e8ecef';
    g.fillRect(0, 0, W, H);

    // fundo (OpenStreetMap)
    var falhas = 0, total = 0;
    if (o.fundo !== false) {
      var tx0 = Math.floor(x0 / 256), ty0 = Math.floor(y0 / 256), tx1 = Math.floor((x0 + W) / 256), ty1 = Math.floor((y0 + H) / 256);
      var n = Math.pow(2, z), tarefas = [];
      for (var tx = tx0; tx <= tx1; tx++) {
        for (var ty = ty0; ty <= ty1; ty++) {
          if (ty < 0 || ty >= n) continue;
          (function (tx, ty) {
            total++;
            tarefas.push(carregarTile(tileUrl(z, ((tx % n) + n) % n, ty)).then(function (img) {
              if (img) g.drawImage(img, tx * 256 - x0, ty * 256 - y0, 256, 256);
              else falhas++;
            }));
          })(tx, ty);
        }
      }
      await Promise.all(tarefas);
      g.fillStyle = 'rgba(255,255,255,0.18)';   // clareia o fundo para os desenhos se destacarem
      g.fillRect(0, 0, W, H);
    }
    var semFundo = o.fundo === false || (total && falhas / total > 0.5);
    if (semFundo) {
      g.fillStyle = '#eef1f4';
      g.fillRect(0, 0, W, H);
      g.strokeStyle = '#d7dde3';
      g.lineWidth = 1;
      for (var gx = 0; gx < W; gx += 80) { g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, H); g.stroke(); }
      for (var gy = 0; gy < H; gy += 80) { g.beginPath(); g.moveTo(0, gy); g.lineTo(W, gy); g.stroke(); }
    }

    function caminho(pts, fechar) {
      g.beginPath();
      pts.forEach(function (p, i) { var q = px(p[0], p[1]); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); });
      if (fechar) g.closePath();
    }
    function rotulo(t, x, y, cor) {
      g.font = '600 17px Roboto, Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(255,255,255,0.92)';
      g.strokeText(t, x, y);
      g.fillStyle = cor || '#1f2933';
      g.fillText(t, x, y);
    }

    // setores
    (o.setores || []).forEach(function (s) {
      var dest = o.destaque && o.destaque === s.id;
      var apagado = o.destaque && !dest;
      caminho(pontosSetor(s), true);
      g.globalAlpha = apagado ? 0.08 : dest ? 0.22 : 0.16;
      g.fillStyle = s.cor || '#3b82f6';
      g.fill();
      g.globalAlpha = apagado ? 0.45 : 1;
      g.lineWidth = dest ? 4 : 2.5;
      g.setLineDash(s.status === 'concluido' ? [] : [10, 6]);
      g.strokeStyle = s.cor || '#3b82f6';
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    });
    // trilhas
    var ESTILO = { militar: ['#dc2626', []], civil: ['#16a34a', [9, 6]], responsavel: ['#0891b2', [2, 5]] };
    (o.trilhas || []).forEach(function (t) {
      if (!t.pontos || t.pontos.length < 2) return;
      var e = ESTILO[t.tipo] || ESTILO.civil;
      caminho(t.pontos, false);
      g.lineJoin = 'round'; g.lineCap = 'round';
      g.lineWidth = 5; g.strokeStyle = 'rgba(255,255,255,0.75)'; g.setLineDash([]); g.stroke();
      g.lineWidth = 2.6; g.strokeStyle = e[0]; g.setLineDash(e[1]); g.stroke();
      g.setLineDash([]);
    });
    // trilhas desenhadas no mapa (planejadas tracejadas, percorridas contínuas)
    (o.manuais || []).forEach(function (t) {
      if (!t.pontos || t.pontos.length < 2) return;
      caminho(t.pontos, false);
      g.lineJoin = 'round'; g.lineCap = 'round';
      g.lineWidth = 5; g.strokeStyle = 'rgba(255,255,255,0.75)'; g.setLineDash([]); g.stroke();
      g.lineWidth = 2.6; g.strokeStyle = '#7c3aed'; g.setLineDash(t.estado === 'percorrida' ? [] : [6, 6]); g.stroke();
      g.setLineDash([]);
    });
    // nomes dos setores: logo abaixo da borda de cima (o centro costuma ter marcadores)
    var nomes = [];
    (o.setores || []).forEach(function (s) {
      if (o.destaque && o.destaque !== s.id) return;
      var pts = pontosSetor(s).map(function (p) { return px(p[0], p[1]); });
      var xs = pts.map(function (q) { return q[0]; }), ys = pts.map(function (q) { return q[1]; });
      var topo = Math.min.apply(null, ys), base = Math.max.apply(null, ys);
      nomes.push([s.nome, (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2, Math.min(topo + 24, (topo + base) / 2)]);
    });
    // pontos de interesse
    var LETRA = { ULTIMA_LOCALIZACAO: 'U', POSSIVEL_LOCALIZACAO: 'P', VESTIGIO: 'V', RISCO: '!', ENCONTRO: 'E', VITIMA_ENCONTRADA: '+', BASE: 'B', OUTRO: '•' };
    function marcador(lat, lng, letra, cor, raio) {
      var q = px(lat, lng);
      if (q[0] < -20 || q[1] < -20 || q[0] > W + 20 || q[1] > H + 20) return;
      g.beginPath(); g.arc(q[0], q[1], raio || 12, 0, 2 * Math.PI);
      g.fillStyle = cor; g.fill();
      g.lineWidth = 2.5; g.strokeStyle = '#ffffff'; g.stroke();
      g.font = '700 ' + Math.round((raio || 12) * 1.15) + 'px Roboto, Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#ffffff';
      g.fillText(letra, q[0], q[1] + 1);
    }
    (o.pontos || []).forEach(function (p) {
      // tipo criado pelos usuários: o ícone e a cor dele
      marcador(p.lat, p.lng, p.icone || LETRA[p.categoria] || '•', p.cor || (p.categoria === 'RISCO' ? '#d97706' : p.categoria === 'VITIMA_ENCONTRADA' ? '#a21caf' : '#334155'));
    });
    (o.fotos || []).forEach(function (f) { if (f.lat != null) marcador(f.lat, f.lng, 'F', '#475569', 8); });
    (o.achados || []).forEach(function (a) { marcador(a.lat, a.lng, a.letra || '!', a.cor || '#ea580c', a.raio || 11); });
    if (o.local) marcador(o.local[0], o.local[1], '★', '#b91c1c', 14);
    nomes.forEach(function (n) { rotulo(n[0], n[1], n[2], '#111827'); });

    // escala
    var mpp = metrosPorPixel((minLat + maxLat) / 2, z);
    var opcoes = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
    var metros = opcoes.filter(function (m) { return m / mpp <= W * 0.22; }).pop() || opcoes[0];
    var largura = metros / mpp;
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.fillRect(14, H - 46, largura + 22, 34);
    g.fillStyle = '#1f2933';
    g.fillRect(25, H - 22, largura, 4);
    g.fillRect(25, H - 28, 2, 10); g.fillRect(25 + largura - 2, H - 28, 2, 10);
    g.font = '600 14px Roboto, Arial, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillText(metros >= 1000 ? (metros / 1000) + ' km' : metros + ' m', 25, H - 30);
    // norte
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath(); g.arc(W - 34, 36, 20, 0, 2 * Math.PI); g.fill();
    g.fillStyle = '#1f2933';
    g.beginPath(); g.moveTo(W - 34, 20); g.lineTo(W - 42, 44); g.lineTo(W - 34, 38); g.lineTo(W - 26, 44); g.closePath(); g.fill();
    g.font = '700 11px Roboto, Arial, sans-serif'; g.textAlign = 'center'; g.fillText('N', W - 34, 54);
    // créditos
    var cred = semFundo ? 'Mapa de fundo indisponível no momento da geração' : '© colaboradores do OpenStreetMap';
    g.font = '12px Roboto, Arial, sans-serif'; g.textAlign = 'right';
    var tw = g.measureText(cred).width;
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(W - tw - 14, H - 22, tw + 14, 22);
    g.fillStyle = '#374151'; g.fillText(cred, W - 7, H - 7);
    // moldura
    g.strokeStyle = '#9aa4af'; g.lineWidth = 2; g.strokeRect(1, 1, W - 2, H - 2);
    return cv.toDataURL('image/jpeg', 0.86);
  }

  /* ================================================================== */
  /* FOTOS (Storage privado → JPEG reduzido)                              */
  /* ================================================================== */
  async function fotoReduzida(bucket, caminho, maximo) {
    try {
      var s = await C.cliente.storage.from(bucket).createSignedUrl(caminho, 600);
      if (s.error || !s.data) return null;
      var r = await fetch(s.data.signedUrl);
      if (!r.ok) return null;
      var blob = await r.blob();
      var bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      var k = Math.min(1, (maximo || 1100) / Math.max(bmp.width, bmp.height));
      var cv = document.createElement('canvas');
      cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      if (bmp.close) bmp.close();
      return cv.toDataURL('image/jpeg', 0.78);
    } catch (e) {
      return null;
    }
  }

  /* ================================================================== */
  /* PDF                                                                  */
  /* ================================================================== */
  var carregandoPdf = null;
  // vendor/ fica ao lado de js/: o endereço vem deste próprio arquivo
  var BASE_VENDOR = (function () {
    try { return new URL('../vendor/pdfmake/', document.currentScript.src).href; } catch (e) { return 'vendor/pdfmake/'; }
  })();
  var BASE_IMG = (function () {
    try { return new URL('../img/', document.currentScript.src).href; } catch (e) { return 'img/'; }
  })();
  // Logo do Corpo de Bombeiros para o cabeçalho do relatório (data URL). Sem ela, o PDF sai com o texto.
  async function carregarLogo() {
    try {
      var r = await fetch(BASE_IMG + 'logo-cbmpr.png');
      if (!r.ok) return null;
      var blob = await r.blob();
      return await new Promise(function (resolve) {
        var leitor = new FileReader();
        leitor.onload = function () { resolve(leitor.result); };
        leitor.onerror = function () { resolve(null); };
        leitor.readAsDataURL(blob);
      });
    } catch (e) { return null; }
  }
  function carregarScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Não foi possível carregar o gerador de PDF. Verifique a internet e tente de novo.')); };
      document.head.appendChild(s);
    });
  }
  function carregarPdfMake() {
    if (window.pdfMake && window.pdfMake.vfs) return Promise.resolve(window.pdfMake);
    if (!carregandoPdf) {
      carregandoPdf = carregarScript(BASE_VENDOR + 'pdfmake.min.js')
        .then(function () { return carregarScript(BASE_VENDOR + 'vfs_fonts.js'); })
        .then(function () { return window.pdfMake; })
        .catch(function (e) { carregandoPdf = null; throw e; });
    }
    return carregandoPdf;
  }

  // Trilhas desenhadas no mapa (para o mapa geral). Banco sem a tabela: sem elas.
  async function trilhasDesenhadas(opId) {
    try {
      return (await C.consultar(C.cliente.from('trilhas_manuais').select('nome,estado,pontos').eq('operacao_id', opId))) || [];
    } catch (e) { return []; }
  }

  // Monta todos os recursos (mapas e fotos) e o documento. progresso(texto)
  async function prepararDocumento(dados, opcoes, progresso) {
    var RP = window.RelatorioPDF;
    var limite = opcoes.fotos === 'todas' ? null : opcoes.fotos === 'nenhuma' ? 0 : 6;
    var distrib = RP.distribuirFotos(dados.setores, dados.fotos, limite);
    var recursos = { fotos: {}, fotosVitimas: {}, mapasSetor: {}, fotosPorSetor: distrib.porSetor, fotosOmitidas: distrib.omitidas, fotosForaSetor: distrib.fora };
    if (limite === 0) { recursos.fotosPorSetor = {}; recursos.fotosForaSetor = []; recursos.fotosOmitidas = {}; }

    var op = dados.operacao;
    var trilhas = dados.trilhas || [];
    var achados = dados.diario.filter(function (e) { return e.categoria === 'encontro' && e.lat != null && /^relato_|^vitima_localizada$/.test(e.tipo); })
      .map(function (e) { return e.tipo === 'vitima_localizada' ? { lat: e.lat, lng: e.lng, letra: '+', cor: '#a21caf', raio: 13 } : { lat: e.lat, lng: e.lng, letra: '!', cor: '#ea580c' }; });
    var enquadrarTudo = [];
    dados.setores.forEach(function (s) { pontosSetor(s).forEach(function (p) { enquadrarTudo.push(p); }); });
    trilhas.forEach(function (t) { (t.pontos || []).forEach(function (p) { enquadrarTudo.push(p); }); });
    dados.pontos.forEach(function (p) { enquadrarTudo.push([p.lat, p.lng]); });
    achados.forEach(function (a) { enquadrarTudo.push([a.lat, a.lng]); });
    var manuais = dados.trilhasManuais || [];
    manuais.forEach(function (t) { (t.pontos || []).forEach(function (p) { enquadrarTudo.push(p); }); });
    var fotosMapa = (dados.fotos || []).filter(function (f) { return f.lat != null && f.lng != null; });
    fotosMapa.forEach(function (f) { enquadrarTudo.push([f.lat, f.lng]); });
    if (op.local_lat != null) enquadrarTudo.push([op.local_lat, op.local_lng]);
    var base = { setores: dados.setores, trilhas: trilhas, manuais: manuais, pontos: dados.pontos, achados: achados, local: op.local_lat != null ? [op.local_lat, op.local_lng] : null, fundo: opcoes.fundo !== false };

    progresso('Desenhando o mapa geral…');
    // mapa geral: todos os elementos registrados (também as fotos), haja ou não setores
    recursos.mapaGeral = await desenharMapa(Object.assign({ largura: 1200, altura: 760, enquadrar: enquadrarTudo, fotos: fotosMapa }, base));
    for (var i = 0; i < dados.setores.length; i++) {
      var s = dados.setores[i];
      progresso('Desenhando o mapa do setor ' + s.nome + ' (' + (i + 1) + '/' + dados.setores.length + ')…');
      recursos.mapasSetor[s.id] = await desenharMapa(Object.assign({ largura: 1200, altura: 700, enquadrar: pontosSetor(s), destaque: s.id }, base));
    }
    var fotos = [];
    Object.keys(recursos.fotosPorSetor).forEach(function (k) { fotos = fotos.concat(recursos.fotosPorSetor[k]); });
    fotos = fotos.concat(recursos.fotosForaSetor);
    for (var j = 0; j < fotos.length; j++) {
      progresso('Baixando fotos (' + (j + 1) + '/' + fotos.length + ')…');
      var url = await fotoReduzida('fotos', fotos[j].caminho, 1100);
      if (url) recursos.fotos[fotos[j].id] = url;
    }
    for (var v = 0; v < dados.vitimas.length; v++) {
      if (dados.vitimas[v].foto_caminho) {
        var fv = await fotoReduzida('vitimas', dados.vitimas[v].foto_caminho, 700);
        if (fv) recursos.fotosVitimas[dados.vitimas[v].id] = fv;
      }
    }
    recursos.logo = await carregarLogo();
    progresso('Montando o documento…');
    return RP.montarDocumento(dados, recursos);
  }

  function gerarBlob(pdfMake, doc) {
    return new Promise(function (resolve, reject) {
      var paginas = 0;
      var rodape = doc.footer;
      doc.footer = function (pagina, total) { paginas = total; return rodape(pagina, total); };
      try {
        pdfMake.createPdf(doc).getBlob(function (blob) { resolve({ blob: blob, paginas: paginas }); });
      } catch (e) { reject(e); }
    });
  }

  async function sha256(blob) {
    try {
      var buf = await blob.arrayBuffer();
      var h = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(h)).map(function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
    } catch (e) { return null; }
  }

  function baixarBlob(blob, nome) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = nome; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
  }

  function nomeArquivo(op, quando) {
    var d = new Date(C.paraMs(quando) || Date.now());
    var cod = String(op.codigo || 'operacao').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return 'Relatorio-final-' + cod + '-' + d.getFullYear() + dd(d.getMonth() + 1) + dd(d.getDate()) + '-' + dd(d.getHours()) + dd(d.getMinutes()) + '.pdf';
  }

  // Só o administrador exclui um relatório (o PDF sai do Storage pela limpeza diária; fica registrado no diário).
  async function excluirRelatorio(r, op, depois) {
    var ok = await UI.confirmar({
      titulo: 'Excluir este relatório?',
      texto: 'O PDF de ' + dataHora(r.gerado_em) + ' (gerado por ' + r.gerado_por_nome + ') deixa de estar disponível. A exclusão fica registrada no diário.',
      ok: 'Excluir relatório',
      perigo: true,
    });
    if (!ok) return;
    try {
      await C.rpc('excluir_relatorio', { p_relatorio: r.id });
      UI.aviso('Relatório excluído.', 'ok');
      if (depois) depois();
    } catch (e) {
      UI.aviso('Não foi possível excluir: ' + (e.message || e), 'erro', 8000);
    }
  }

  async function baixarSalvo(r, op) {
    try {
      var s = await C.cliente.storage.from('relatorios').createSignedUrl(r.caminho, 300);
      if (s.error) throw s.error;
      var resp = await fetch(s.data.signedUrl);
      if (!resp.ok) throw new Error('Arquivo indisponível.');
      baixarBlob(await resp.blob(), nomeArquivo(op, r.gerado_em));
    } catch (e) {
      UI.aviso('Não foi possível baixar o relatório: ' + (e.message || e), 'erro', 8000);
    }
  }

  /* ---------- tela do relatório --------------------------------------- */
  async function abrirRelatorio(op, opcoes) {
    if (!op) return;
    opcoes = opcoes || {};
    var selRes = UI.el('select', { classe: 'campo', id: 'rel-resultado' }, [UI.el('option', { value: '', texto: 'Ainda não definido' })].concat(RESULTADOS.map(function (r) {
      return UI.el('option', { value: r[0], texto: r[1] });
    })));
    var txtRes = UI.el('textarea', { classe: 'campo', id: 'rel-resultado-texto', rows: '3', maxlength: '4000', placeholder: 'Resumo do desfecho: onde, quando e em que condições; encaminhamentos.' });
    var infoRes = UI.el('p', { classe: 'muted', id: 'rel-resultado-info' });
    var btnRes = UI.el('button', { classe: 'btn', type: 'button', id: 'rel-resultado-salvar', texto: 'Salvar resultado' });
    var selFotos = UI.el('select', { classe: 'campo', id: 'rel-fotos' }, [
      UI.el('option', { value: 'limite', texto: 'Até 6 por setor (recomendado)' }),
      UI.el('option', { value: 'todas', texto: 'Todas as fotos' }),
      UI.el('option', { value: 'nenhuma', texto: 'Sem fotos' }),
    ]);
    var chkFundo = UI.el('input', { type: 'checkbox', id: 'rel-fundo', checked: true });
    var progresso = UI.el('p', { classe: 'rel-progresso', id: 'rel-progresso', role: 'status', hidden: true });
    var btnGerar = UI.el('button', { classe: 'btn btn-primario', type: 'button', id: 'rel-gerar', texto: 'Gerar PDF' });
    var listaSalvos = UI.el('ul', { classe: 'rel-salvos', id: 'rel-salvos' });
    var erro = UI.el('p', { classe: 'erro-form', hidden: true });

    var fechar = UI.abrirModal(UI.el('div', { classe: 'modal-relatorio form-padrao' }, [
      UI.el('h2', { id: 'modal-titulo', classe: 'titulo-com-dica', texto: 'Relatório final' },
        [UI.dica('PDF com cadastro, pessoas e grupos, setores varridos, diário e resultado. Cada relatório gerado fica guardado; só o administrador pode excluir.')]),
      opcoes.aviso ? UI.el('p', { classe: 'rel-aviso', texto: opcoes.aviso }) : null,
      UI.el('div', { classe: 'form-colunas' }, [
        UI.secao('Resultado da operação', [
          UI.campo('Desfecho', selRes, { para: 'rel-resultado' }),
          UI.campo('Descrição', txtRes, { para: 'rel-resultado-texto' }),
          infoRes,
          UI.el('div', { classe: 'acoes-linha' }, [btnRes]),
        ], { dica: 'O resultado aparece na capa e no fim do relatório.' }),
        UI.secao('Gerar o PDF', [
          UI.campo('Fotos dos setores', selFotos, { para: 'rel-fotos' }),
          UI.el('label', { classe: 'linha-opcao rel-check', for: 'rel-fundo' }, [chkFundo, ' Mapa de fundo nos mapas']),
          progresso,
          erro,
          UI.el('div', { classe: 'acoes-linha' }, [btnGerar]),
        ]),
      ]),
      UI.secao('Relatórios já gerados', [listaSalvos]),
      UI.rodape([
        opcoes.aoFechar ? null : UI.el('button', { classe: 'btn', type: 'button', texto: 'Diário', onclick: function () { fechar(); abrirDiario(op); } }),
        UI.el('button', { classe: 'btn', type: 'button', id: 'rel-fechar', texto: opcoes.textoFechar || 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]), { fecharNoFundo: false, tamanho: 'largo', aoFechar: function () { if (opcoes.aoFechar) opcoes.aoFechar(gerou); } });

    var gerou = false;
    selRes.value = op.resultado || '';
    txtRes.value = op.resultado_texto || '';
    function mostrarInfoRes() {
      infoRes.textContent = op.resultado_em ? 'Registrado por ' + (op.resultado_por_nome || '') + ' em ' + dataHora(op.resultado_em) + '.' : '';
      infoRes.hidden = !op.resultado_em;
    }
    mostrarInfoRes();

    async function carregarSalvos() {
      try {
        var r = await C.consultar(C.cliente.from('relatorios').select('*').eq('operacao_id', op.id).order('gerado_em', { ascending: false }));
        listaSalvos.innerHTML = '';
        if (!r || !r.length) { listaSalvos.appendChild(UI.el('li', { classe: 'muted', texto: 'Nenhum relatório gerado ainda.' })); return; }
        var ehAdmin = Boolean(P() && P().admin && P().admin());
        r.forEach(function (x) {
          listaSalvos.appendChild(UI.el('li', null, [
            UI.el('span', { texto: dataHora(x.gerado_em) + ' · ' + x.gerado_por_nome + (x.paginas ? ' · ' + x.paginas + ' pág.' : '') }),
            UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Baixar', onclick: function () { baixarSalvo(x, op); } }),
            ehAdmin ? UI.el('button', { classe: 'btn btn-pequeno btn-perigo', type: 'button', texto: 'Excluir', onclick: function () { excluirRelatorio(x, op, carregarSalvos); } }) : null,
          ]));
        });
      } catch (e) {
        listaSalvos.innerHTML = '';
        listaSalvos.appendChild(UI.el('li', { classe: 'muted', texto: 'Lista indisponível: ' + e.message }));
      }
    }
    carregarSalvos();

    btnRes.addEventListener('click', async function () {
      if (!selRes.value) { UI.aviso('Escolha o desfecho.', 'erro'); selRes.focus(); return; }
      btnRes.disabled = true;
      try {
        var r = await C.rpc('definir_resultado', { p_operacao: op.id, p_resultado: selRes.value, p_texto: txtRes.value });
        Object.assign(op, r);
        mostrarInfoRes();
        UI.aviso('Resultado registrado no diário.', 'ok');
      } catch (e) {
        UI.aviso(e.message, 'erro');
      } finally {
        btnRes.disabled = false;
      }
    });

    btnGerar.addEventListener('click', async function () {
      erro.hidden = true;
      // resultado preenchido e ainda não salvo: salva antes de gerar
      if (selRes.value && (selRes.value !== (op.resultado || '') || txtRes.value.trim() !== (op.resultado_texto || ''))) {
        try {
          Object.assign(op, await C.rpc('definir_resultado', { p_operacao: op.id, p_resultado: selRes.value, p_texto: txtRes.value }));
          mostrarInfoRes();
        } catch (e) { erro.textContent = e.message; erro.hidden = false; return; }
      }
      btnGerar.disabled = true;
      progresso.hidden = false;
      function passo(t) { progresso.textContent = t; }
      try {
        passo('Carregando o gerador de PDF…');
        var pdfMake = await carregarPdfMake();
        passo('Buscando os dados da operação…');
        var dados = await C.rpc('relatorio_operacao', { p_operacao: op.id }, 60000);
        // probabilidades de busca (cenários aprovados, buscas registradas): se falhar, o relatório sai sem a seção
        try { dados.busca = window.BuscaCenario ? await window.BuscaCenario.dadosRelatorio() : null; } catch (e) { dados.busca = null; }
        dados.trilhasManuais = await trilhasDesenhadas(op.id);
        var doc = await prepararDocumento(dados, { fotos: selFotos.value, fundo: chkFundo.checked }, passo);
        passo('Gerando o PDF…');
        var r = await gerarBlob(pdfMake, doc);
        var nome = nomeArquivo(op, dados.gerado_em);
        baixarBlob(r.blob, nome);
        passo('Guardando uma cópia no servidor…');
        var caminho = op.id + '/' + C.uuid() + '.pdf';
        var up = await C.cliente.storage.from('relatorios').upload(caminho, r.blob, { contentType: 'application/pdf', upsert: false });
        if (up.error) throw new Error('O PDF foi baixado, mas a cópia não foi guardada no servidor: ' + (up.error.message || up.error));
        await C.rpc('registrar_relatorio', { p_operacao: op.id, p_caminho: caminho, p_paginas: r.paginas || null, p_bytes: r.blob.size, p_sha256: await sha256(r.blob) });
        gerou = true;
        passo('Pronto: ' + (r.paginas ? r.paginas + ' página(s), ' : '') + Math.round(r.blob.size / 1024) + ' KB. O arquivo foi baixado e uma cópia foi guardada.');
        UI.aviso('Relatório final gerado.', 'ok');
        carregarSalvos();
      } catch (e) {
        progresso.hidden = true;
        erro.textContent = e.message || String(e);
        erro.hidden = false;
      } finally {
        btnGerar.disabled = false;
      }
    });
  }

  // Quantos relatórios a operação já tem (para os avisos antes de encerrar/apagar)
  async function quantosRelatorios(opId) {
    try {
      var r = await C.cliente.from('relatorios').select('id', { count: 'exact', head: true }).eq('operacao_id', opId);
      return r.error ? null : r.count;
    } catch (e) { return null; }
  }

  window.Relatorio = {
    abrirDiario: abrirDiario,
    abrirRelatorio: abrirRelatorio,
    quantosRelatorios: quantosRelatorios,
    desenharMapa: desenharMapa,
    prepararDocumento: prepararDocumento,
    carregarPdfMake: carregarPdfMake,
    gerarBlob: gerarBlob,
  };
})();
