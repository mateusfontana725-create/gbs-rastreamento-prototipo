/* =====================================================================
 * relatorio-pdf.js — monta o documento do RELATÓRIO FINAL (pdfmake).
 *   Função pura: recebe os dados de relatorio_operacao() e as imagens já
 *   prontas (mapas e fotos em data URL) e devolve a definição do documento.
 *   Não acessa rede nem a tela (por isso também roda no Node, nos testes).
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var COR = {
    texto: '#1f2933',
    suave: '#5b6673',
    linha: '#d5dae0',
    fundo: '#f3f5f7',
    acento: '#b91c1c',        // vermelho bombeiro
    critico: '#fdecec',
    observacao: '#eef4fb',
  };

  var TIPO_PESSOA = { civil: 'Civil', militar: 'Militar', responsavel: 'Responsável' };
  var STATUS_SETOR = { pendente: 'Pendente', andamento: 'Em andamento', concluido: 'Concluído' };
  var RESULTADO = {
    localizada_viva: { rotulo: 'Vítima localizada com vida', cor: '#166534', fundo: '#e7f6ec' },
    localizada_obito: { rotulo: 'Vítima localizada em óbito', cor: '#3b0764', fundo: '#f1eaf8' },
    nao_localizada: { rotulo: 'Vítima não localizada', cor: '#92400e', fundo: '#fdf3e2' },
    outro: { rotulo: 'Outro desfecho', cor: '#1f2933', fundo: '#f3f5f7' },
  };
  var CATEGORIA = {
    operacao: 'Operação', setor: 'Setor', deslocamento: 'Deslocamento', chegada: 'Chegada', encontro: 'Encontro',
    alerta: 'Alerta', pessoa: 'Pessoas', observacao: 'Observação', documento: 'Documento',
  };
  var PONTO = {
    ULTIMA_LOCALIZACAO: 'Última localização conhecida', POSSIVEL_LOCALIZACAO: 'Possível localização', VESTIGIO: 'Vestígio',
    RISCO: 'Área de risco', ENCONTRO: 'Ponto de encontro', VITIMA_ENCONTRADA: 'Vítima encontrada', BASE: 'Base da operação', OUTRO: 'Outro',
  };
  var DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  var MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

  /* ---------- formatação ------------------------------------------------ */
  function dd(n) { return (n < 10 ? '0' : '') + n; }
  function data(v) { if (!v) return null; var d = new Date(v); return isNaN(d) ? null : d; }
  function dataHora(v) { var d = data(v); return d ? dd(d.getDate()) + '/' + dd(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + dd(d.getHours()) + ':' + dd(d.getMinutes()) : '—'; }
  // Nas tabelas: "12/10 17:30" (o ano está na capa); outro ano → data completa
  var ANO_REF = null;
  function dataHoraCurta(v) {
    var d = data(v);
    if (!d) return '—';
    if (ANO_REF != null && d.getFullYear() !== ANO_REF) return dataHora(v);
    return dd(d.getDate()) + '/' + dd(d.getMonth() + 1) + ' ' + dd(d.getHours()) + ':' + dd(d.getMinutes());
  }
  function hora(v) { var d = data(v); return d ? dd(d.getHours()) + ':' + dd(d.getMinutes()) : '—'; }
  function chaveDia(v) { var d = data(v); return d ? d.getFullYear() + '-' + dd(d.getMonth() + 1) + '-' + dd(d.getDate()) : ''; }
  function diaExtenso(v) {
    var d = data(v);
    if (!d) return '';
    var t = DIAS[d.getDay()] + ', ' + d.getDate() + ' de ' + MESES[d.getMonth()] + ' de ' + d.getFullYear();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function duracao(a, b) {
    var x = data(a), y = data(b);
    if (!x || !y || y < x) return '—';
    var min = Math.round((y - x) / 60000);
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60), m = min % 60;
    if (h < 48) return h + ' h' + (m ? ' ' + dd(m) + ' min' : '');
    return Math.floor(h / 24) + ' d ' + (h % 24) + ' h';
  }
  function coord(lat, lng) {
    if (lat == null || lng == null) return '—';
    return Number(lat).toFixed(6) + ', ' + Number(lng).toFixed(6);
  }
  function vazio(v) { return v == null || String(v).trim() === ''; }
  function txt(v, alt) { return vazio(v) ? (alt == null ? '—' : alt) : String(v); }

  // Área de um setor (m²)
  function areaSetor(s) {
    if (s.forma === 'circulo' && s.raio_m) return Math.PI * s.raio_m * s.raio_m;
    var pts = s.pontos || [];
    if (pts.length < 3) return 0;
    var R = 6371000, k = Math.PI / 180, soma = 0;
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      soma += (b[1] - a[1]) * k * (2 + Math.sin(a[0] * k) + Math.sin(b[0] * k));
    }
    return Math.abs(soma * R * R / 2);
  }
  function textoArea(m2) {
    if (!m2) return '—';
    if (m2 < 10000) return Math.round(m2).toLocaleString('pt-BR') + ' m²';
    return (m2 / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' ha';
  }

  /* ---------- blocos reutilizáveis ------------------------------------- */
  var LAYOUT_TABELA = {
    hLineWidth: function (i, no) { return i === 0 || i === 1 || i === no.table.body.length ? 0.8 : 0.4; },
    vLineWidth: function () { return 0; },
    hLineColor: function (i) { return i === 1 ? '#9aa4af' : COR.linha; },
    paddingLeft: function (i) { return i === 0 ? 0 : 6; },
    paddingRight: function () { return 6; },
    paddingTop: function () { return 4; },
    paddingBottom: function () { return 4; },
  };
  var LAYOUT_FICHA = {
    hLineWidth: function () { return 0.4; },
    vLineWidth: function () { return 0; },
    hLineColor: function () { return COR.linha; },
    paddingLeft: function (i) { return i === 0 ? 0 : 8; },
    paddingRight: function () { return 4; },
    paddingTop: function () { return 4; },
    paddingBottom: function () { return 4; },
  };

  function secao(numero, titulo, quebra) {
    return {
      text: numero + '. ' + titulo, style: 'h1', tocItem: true, tocStyle: 'toc', tocMargin: [0, 3, 0, 0],
      pageBreak: quebra ? 'before' : undefined,
    };
  }
  function subtitulo(t, extra) { return Object.assign({ text: t, style: 'h2', headlineLevel: 1 }, extra || {}); }
  function nota(t) { return { text: t, style: 'nota' }; }

  // Tabela de rótulo/valor (ficha)
  function ficha(linhas) {
    var corpo = linhas.filter(Boolean).map(function (l) {
      return [{ text: l[0], style: 'rotulo' }, typeof l[1] === 'object' && l[1] !== null ? l[1] : { text: txt(l[1]), style: 'valor' }];
    });
    if (!corpo.length) return null;
    return { table: { widths: [130, '*'], body: corpo }, layout: LAYOUT_FICHA, margin: [0, 0, 0, 10] };
  }

  // Tabela com cabeçalho repetido a cada página
  function tabela(cabecalho, linhas, larguras, opcoes) {
    opcoes = opcoes || {};
    var corpo = [cabecalho.map(function (c) { return { text: c, style: 'th' }; })];
    linhas.forEach(function (l) { corpo.push(l.map(function (c) { return typeof c === 'object' && c !== null ? c : { text: txt(c), style: 'td' }; })); });
    return {
      table: { headerRows: 1, dontBreakRows: true, widths: larguras, body: corpo },
      layout: Object.assign({}, LAYOUT_TABELA, opcoes.preenchimento ? { fillColor: opcoes.preenchimento } : {}),
      margin: [0, 2, 0, 12],
    };
  }

  function caixaResultado(op) {
    var r = RESULTADO[op.resultado];
    if (!r) {
      return {
        table: { widths: ['*'], body: [[{ stack: [
          { text: 'RESULTADO', style: 'rotuloCaixa' },
          { text: 'Resultado ainda não registrado', fontSize: 13, bold: true, color: COR.suave, margin: [0, 2, 0, 0] },
        ], fillColor: COR.fundo, margin: [10, 8, 10, 8] }]] },
        layout: 'noBorders', margin: [0, 0, 0, 14],
      };
    }
    return {
      table: { widths: [4, '*'], body: [[
        { text: '', fillColor: r.cor },
        { stack: [
          { text: 'RESULTADO', style: 'rotuloCaixa', color: r.cor },
          { text: r.rotulo, fontSize: 15, bold: true, color: r.cor, margin: [0, 2, 0, 0] },
          vazio(op.resultado_texto) ? null : { text: op.resultado_texto, fontSize: 10, color: COR.texto, margin: [0, 5, 0, 0] },
          { text: 'Registrado por ' + txt(op.resultado_por_nome) + ' em ' + dataHora(op.resultado_em), style: 'nota', margin: [0, 5, 0, 0] },
        ].filter(Boolean), fillColor: r.fundo, margin: [10, 8, 10, 9] },
      ]] },
      layout: 'noBorders', margin: [0, 0, 0, 14],
    };
  }

  function imagem(dataUrl, largura, altura) {
    if (!dataUrl) return null;
    var img = { image: dataUrl, width: largura };
    if (altura) img = { image: dataUrl, fit: [largura, altura] };
    return img;
  }

  /* ---------- seções ---------------------------------------------------- */
  function capa(d, recursos) {
    var op = d.operacao;
    var pessoas = d.participantes.length;
    var concluidos = d.setores.filter(function (s) { return s.status === 'concluido'; }).length;
    var numeros = [
      [String(pessoas), 'pessoas de campo'],
      [String(d.grupos.length), 'grupos'],
      [concluidos + ' / ' + d.setores.length, 'setores concluídos'],
      [String(registrosDiario(d).length), 'registros no diário'],
      [String(d.fotos.length), 'fotos'],
    ];
    // Logo do Corpo de Bombeiros também na capa (acima do título), como no cabeçalho das páginas
    var topo = recursos.logo ? [{ image: recursos.logo, width: 180, margin: [0, 26, 0, 22] }] : [];
    return topo.concat([
      { text: 'RELATÓRIO FINAL DE OPERAÇÃO', style: 'sobretitulo', margin: [0, recursos.logo ? 0 : 30, 0, 6] },
      { canvas: [{ type: 'rect', x: 0, y: 0, w: 48, h: 3, color: COR.acento }], margin: [0, 0, 0, 14] },
      { text: op.codigo, style: 'tituloCapa' },
      { text: txt(window.Ipo.normalizarIpo(op.ipo || {}).natureza, ''), style: 'subtituloCapa', margin: [0, 6, 0, 22] },
      {
        table: { widths: ['*', '*', '*'], body: [[
          bloco('Acionamento', dataHora(op.acionado_em)),
          bloco('Início no sistema', dataHora(op.criada_em)),
          bloco('Encerramento', op.encerrada_em ? dataHora(op.encerrada_em) : 'Em andamento'),
        ], [
          bloco('Duração', duracao(op.acionado_em || op.criada_em, op.encerrada_em || d.gerado_em)),
          bloco('Responsável (criador)', txt(op.criador_nome)),
          bloco('Situação', op.status === 'encerrada' ? 'Encerrada' : 'Ativa'),
        ]] },
        layout: {
          hLineWidth: function (i) { return i === 1 ? 0.4 : 0; }, vLineWidth: function () { return 0; },
          hLineColor: function () { return COR.linha; }, paddingLeft: function () { return 0; }, paddingRight: function () { return 10; },
          paddingTop: function () { return 6; }, paddingBottom: function () { return 6; },
        },
        margin: [0, 0, 0, 16],
      },
      {
        table: { widths: ['*', '*', '*', '*', '*'], body: [numeros.map(function (n) {
          return { stack: [{ text: n[0], style: 'numero' }, { text: n[1], style: 'numeroRotulo' }], fillColor: COR.fundo, margin: [8, 7, 4, 7] };
        })] },
        layout: { hLineWidth: function () { return 0; }, vLineWidth: function (i) { return i > 0 && i < 5 ? 3 : 0; }, vLineColor: function () { return '#ffffff'; },
          paddingLeft: function () { return 0; }, paddingRight: function () { return 0; }, paddingTop: function () { return 0; }, paddingBottom: function () { return 0; } },
        margin: [0, 0, 0, 22],
      },
      { text: 'SUMÁRIO', style: 'rotuloCaixa', margin: [0, 0, 0, 6] },
      { toc: { title: { text: '' } } },
      op.dados_apagados_em ? {
        margin: [0, 16, 0, 0],
        table: { widths: ['*'], body: [[{ text: 'Os dados pessoais desta operação (participantes, trilhas, mensagens e fotos) foram apagados em ' +
          dataHora(op.dados_apagados_em) + ', conforme a política de retenção. Este relatório foi montado com o cadastro, o diário e o resultado, que são preservados.',
          style: 'nota', fillColor: COR.fundo, margin: [8, 6, 8, 6] }]] }, layout: 'noBorders',
      } : null,
    ].filter(Boolean));
  }

  function bloco(rotulo, valor) {
    return { stack: [{ text: rotulo.toUpperCase(), style: 'rotuloCaixa' }, { text: valor, fontSize: 11, margin: [0, 2, 0, 0] }] };
  }

  function nomesGrupos(p) { return (p.grupos || []).map(function (g) { return g.grupo + (g.papel === 'responsavel' ? ' (resp.)' : ''); }).join(', '); }

  function situacao(p) {
    if (p.removido) return 'Removido' + (p.removido_em ? ' ' + dataHoraCurta(p.removido_em) : '');
    if (p.liberado_em) return 'Saída ' + dataHoraCurta(p.liberado_em);
    return 'Até o encerramento';
  }

  function secaoPessoas(d) {
    var out = [secao(1, 'Pessoas e grupos', true)];
    out.push(subtitulo('Responsáveis pela operação'));
    out.push(tabela(['Nome', 'Função', 'Desde'], d.responsaveis.map(function (r) {
      return [{ text: r.nome, style: 'td', bold: true }, r.criador ? 'Criou a operação' : 'Responsável adicionado', dataHoraCurta(r.desde)];
    }), ['*', 150, 100]));

    out.push(subtitulo('Grupos'));
    if (!d.grupos.length) out.push(nota('Nenhum grupo criado.'));
    else out.push(tabela(['Grupo', 'Membros'], d.grupos.map(function (g) {
      return [{ columns: [{ canvas: [{ type: 'rect', x: 0, y: 2, w: 8, h: 8, r: 1, color: g.cor || '#888888' }], width: 14 }, { text: g.nome, style: 'td' }] }, String(g.membros)];
    }), ['*', 80]));

    out.push(subtitulo('Pessoas de campo'));
    if (!d.participantes.length) {
      var doDiario = d.diario.filter(function (e) { return e.tipo === 'pessoa_entrou'; });
      if (d.operacao.dados_apagados_em && doDiario.length) {
        out.push(nota('Os cadastros foram apagados pela retenção. Lista reconstituída a partir do diário:'));
        out.push(tabela(['Entrada', 'Registro'], doDiario.map(function (e) { return [dataHora(e.ocorrido_em), e.titulo]; }), [100, '*']));
      } else {
        out.push(nota('Nenhum participante de campo entrou na operação.'));
      }
      return out;
    }
    var civis = d.participantes.filter(function (p) { return p.tipo === 'civil'; }).length;
    out.push(nota(d.participantes.length + ' pessoa(s): ' + (d.participantes.length - civis) + ' militar(es) e ' + civis + ' civil(is). CPF e celular parcialmente ocultos.'));
    out.push(tabela(['Nome', 'Tipo', 'Grupo', 'CPF', 'Celular', 'Entrada', 'Situação'], d.participantes.map(function (p) {
      return [{ text: p.nome, style: 'td', bold: true }, TIPO_PESSOA[p.tipo] || p.tipo, txt(nomesGrupos(p)), { text: txt(p.cpf), style: 'tdMono' },
        { text: txt(p.telefone), style: 'tdMono' }, dataHoraCurta(p.entrou_em), situacao(p)];
    }), ['*', 40, 76, 68, 64, 56, 70]));
    return out;
  }

  function secaoSetores(d, recursos) {
    var out = [secao(2, 'Setores varridos', true)];
    if (!d.setores.length) {
      out.push(nota('Nenhum setor de busca foi definido nesta operação.'));
      // o mapa geral sai mesmo assim: trilhas, pontos, relatos e o local da operação
      if (recursos.mapaGeral) {
        out.push(subtitulo('Mapa geral da operação'));
        out.push({ image: recursos.mapaGeral, width: 515, margin: [0, 0, 0, 4] });
        out.push(legendaMapa());
      }
      return out;
    }
    var concl = d.setores.filter(function (s) { return s.status === 'concluido'; });
    var area = concl.reduce(function (a, s) { return a + areaSetor(s); }, 0);
    out.push({ text: concl.length + ' de ' + d.setores.length + ' setor(es) concluído(s), somando ' + textoArea(area) + ' varridos.', style: 'corpo', margin: [0, 0, 0, 8] });
    if (recursos.mapaGeral) {
      out.push({ image: recursos.mapaGeral, width: 515, margin: [0, 0, 0, 4] });
      out.push(legendaMapa());
    }
    out.push(tabela(['Setor', 'Situação', 'Equipe / grupo', 'Início', 'Fim', 'Duração', 'Área'], d.setores.map(function (s) {
      var grupos = (s.missoes || []).map(function (m) { return m.grupo; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', ');
      return [{ columns: [{ canvas: [{ type: 'rect', x: 0, y: 2, w: 8, h: 8, r: 1, color: s.cor || '#3b82f6' }], width: 14 }, { text: s.nome, style: 'td', bold: true }] },
        STATUS_SETOR[s.status] || s.status, txt([s.equipe, grupos].filter(Boolean).join(' · ')), dataHoraCurta(s.inicio_em), dataHoraCurta(s.fim_em),
        duracao(s.inicio_em, s.fim_em), textoArea(areaSetor(s))];
    }), ['*', 58, 88, 56, 56, 50, 46]));
    out.push(nota('Início e fim correspondem à mudança de situação do setor no painel, registrada pelo sistema no diário. No mapa, contorno contínuo = setor concluído; tracejado = pendente ou em andamento. Mapa de fundo © colaboradores do OpenStreetMap.'));

    d.setores.forEach(function (s) {
      var bloco = [subtitulo('Setor ' + s.nome, { pageBreak: 'before', fontSize: 13, margin: [0, 0, 0, 8] })];
      var mapa = recursos.mapasSetor && recursos.mapasSetor[s.id];
      if (mapa) bloco.push({ image: mapa, width: 515, margin: [0, 0, 0, 10] });
      bloco.push(ficha([
        ['Situação', STATUS_SETOR[s.status] || s.status],
        ['Forma', s.forma === 'circulo' ? 'Círculo de ' + Math.round(s.raio_m).toLocaleString('pt-BR') + ' m de raio (centro ' + coord(s.centro_lat, s.centro_lng) + ')' : 'Área desenhada com ' + (s.pontos || []).length + ' vértices'],
        ['Área', textoArea(areaSetor(s))],
        ['Equipe', txt(s.equipe)],
        ['Responsável no setor', txt(s.responsavel_nome)],
        ['Início da varredura', dataHora(s.inicio_em)],
        ['Fim da varredura', dataHora(s.fim_em)],
        ['Duração', duracao(s.inicio_em, s.fim_em)],
        vazio(s.observacoes) ? null : ['Observações', s.observacoes],
      ]));
      if ((s.missoes || []).length) {
        bloco.push({ text: 'Deslocamentos de grupos para este setor', style: 'h3', headlineLevel: 1 });
        bloco.push(tabela(['Grupo', 'Enviado', 'Início', 'Chegada', 'Busca finalizada', 'Na base'], s.missoes.map(function (m) {
          return [m.grupo, hora(m.enviada_em), hora(m.iniciada_em), hora(m.chegou_setor_em), hora(m.busca_finalizada_em), hora(m.chegou_base_em)];
        }), ['*', 52, 52, 52, 72, 52]));
      }
      var fotos = (recursos.fotosPorSetor && recursos.fotosPorSetor[s.id]) || [];
      if (fotos.length) {
        bloco.push(gradeFotos(fotos, recursos, 'Fotos registradas no setor ' + s.nome));
      }
      var omitidas = recursos.fotosOmitidas && recursos.fotosOmitidas[s.id];
      if (omitidas) bloco.push(nota(omitidas + ' foto(s) deste setor não foram incluídas para manter o tamanho do documento.'));
      out.push.apply(out, bloco);
    });

    var soltas = recursos.fotosForaSetor || [];
    if (soltas.length) {
      out.push(subtitulo('Fotos fora dos setores', { pageBreak: 'before' }));
      out.push(gradeFotos(soltas, recursos, 'Fotos fora dos setores'));
    }
    return out;
  }

  function legendaMapa() {
    function linha(cor, tracejado) { return { text: tracejado ? '- - - ' : '—— ', color: cor, bold: true }; }
    return { text: [
      'Trilhas: ', linha('#dc2626'), 'militar    ', linha('#16a34a', true), 'civil    ', linha('#0891b2', true), 'responsável    ',
      linha('#7c3aed', true), 'desenhada no mapa',
      '        Marcadores: ★ local da operação · ! relato de campo · + vítima · B base · U última localização · F foto',
    ], fontSize: 7.5, color: COR.suave, margin: [0, 3, 0, 8] };
  }

  function gradeFotos(fotos, recursos, titulo) {
    var linhas = [[{ text: titulo || 'Fotos', style: 'h3', colSpan: 3, margin: [0, 0, 0, 0] }, {}, {}]];
    for (var i = 0; i < fotos.length; i += 3) {
      linhas.push([0, 1, 2].map(function (k) {
        var f = fotos[i + k];
        if (!f || !recursos.fotos[f.id]) return { text: '' };
        return { stack: [
          { image: recursos.fotos[f.id], fit: [163, 122], alignment: 'center' },
          { text: dataHora(f.capturada_em) + ' · ' + txt(f.autor_nome), style: 'legendaFoto', margin: [0, 4, 0, 0] },
          vazio(f.legenda) ? null : { text: f.legenda, style: 'legendaFoto', color: COR.texto },
          { text: coord(f.lat, f.lng), style: 'legendaFoto' },
        ].filter(Boolean) };
      }));
    }
    return { table: { widths: ['*', '*', '*'], body: linhas, headerRows: 1, keepWithHeaderRows: 1, dontBreakRows: true }, layout: {
      hLineWidth: function () { return 0; }, vLineWidth: function () { return 0; },
      paddingLeft: function (i) { return i === 0 ? 0 : 5; }, paddingRight: function (i) { return i === 2 ? 0 : 5; },
      paddingTop: function () { return 4; }, paddingBottom: function () { return 10; },
    }, margin: [0, 2, 0, 8] };
  }

  function secaoPontos(d) {
    var out = [secao(3, 'Pontos de interesse e encontros', true)];
    var encontros = d.diario.filter(function (e) { return e.categoria === 'encontro'; });
    out.push(subtitulo('Encontros e relatos de campo'));
    if (!encontros.length) out.push(nota('Nenhum encontro ou relato de campo registrado.'));
    else out.push(tabela(['Data e hora', 'Registro', 'Local', 'Registrado por'], encontros.map(function (e) {
      return [dataHoraCurta(e.ocorrido_em), { stack: [{ text: e.titulo, style: 'td', bold: true }, vazio(e.detalhe) ? null : { text: e.detalhe, style: 'tdSuave' }].filter(Boolean) },
        { text: coord(e.lat, e.lng), style: 'tdMono' }, e.autor_nome];
    }), [56, '*', 92, 90], { preenchimento: function (i) { return i > 0 && encontros[i - 1].nivel === 'critico' ? COR.critico : null; } }));

    out.push(subtitulo('Pontos de interesse marcados no mapa'));
    if (!d.pontos.length) out.push(nota('Nenhum ponto de interesse marcado.'));
    else out.push(tabela(['Data e hora', 'Tipo', 'Título e descrição', 'Coordenadas', 'Por'], d.pontos.map(function (p) {
      return [dataHoraCurta(p.criado_em), p.tipo_nome || PONTO[p.categoria] || p.categoria,
        { stack: [{ text: p.titulo, style: 'td', bold: true }, vazio(p.descricao) ? null : { text: p.descricao, style: 'tdSuave' }].filter(Boolean) },
        { text: coord(p.lat, p.lng), style: 'tdMono' }, p.criado_por_nome];
    }), [56, 72, '*', 92, 70]));
    return out;
  }

  function secaoDiario(d) {
    var entradas = registrosDiario(d);
    var out = [secao(4, 'Diário consolidado', true)];
    out.push({ text: 'Registro cronológico de tudo o que aconteceu na operação. Os eventos automáticos são gravados pelo sistema e não podem ser alterados; as observações foram escritas pelos responsáveis (as edições ficam registradas). Procedimentos, recursos e desdobramentos do IPO estão na seção Ocorrência, e não se repetem aqui.', style: 'corpo', margin: [0, 0, 0, 10] });
    if (!entradas.length) {
      out.push(nota('Nenhum registro no diário.'));
      return out;
    }
    var dias = [];
    entradas.forEach(function (e) {
      var k = chaveDia(e.ocorrido_em);
      if (!dias.length || dias[dias.length - 1].k !== k) dias.push({ k: k, t: e.ocorrido_em, itens: [] });
      dias[dias.length - 1].itens.push(e);
    });
    dias.forEach(function (dia) {
      out.push({ text: diaExtenso(dia.t) + '  ·  ' + dia.itens.length + ' registro(s)', style: 'dia', headlineLevel: 1 });
      out.push(tabela(['Hora', 'Categoria', 'Registro', 'Por'], dia.itens.map(function (e) {
        var obs = e.origem === 'manual';
        var corpo = [{ text: e.tipo === 'procedimento' ? 'Procedimento de busca: ' + nomeProcedimento(e.ref_id) : obs ? 'Observação' : e.titulo, style: 'td', bold: true }];
        if (!vazio(e.detalhe)) corpo.push({ text: e.detalhe, style: obs ? 'td' : 'tdSuave' });
        if (obs && e.editado_em) corpo.push({ text: 'Editada por ' + txt(e.editado_por_nome) + ' em ' + dataHora(e.editado_em) + ' (versão ' + e.versao + ')', style: 'tdNota' });
        if (e.lat != null) corpo.push({ text: coord(e.lat, e.lng), style: 'tdNota' });
        return [{ text: hora(e.ocorrido_em), style: 'tdMono', bold: true }, { text: CATEGORIA[e.categoria] || e.categoria, style: 'tdSuave' }, { stack: corpo }, { text: e.autor_nome, style: 'tdSuave' }];
      }), [34, 64, '*', 92], { preenchimento: function (i) {
        if (i === 0) return null;
        var e = dia.itens[i - 1];
        return e.nivel === 'critico' ? COR.critico : e.origem === 'manual' ? COR.observacao : null;
      } }));
    });
    out.push(nota('Fundo vermelho claro: evento crítico. Fundo azul claro: observação escrita por um responsável.'));
    return out;
  }

  /* ---------- Probabilidades de busca (POA, POD e POS) ------------------- */
  var ORIGEM_PROB = { julgamento_comando: 'julgamento documentado do comando', consenso_documentado: 'consenso documentado da equipe', modelo_validado: 'modelo validado', calculo_pos_busca: 'cálculo pós-busca (busca negativa)' };
  var ORIGEM_VALOR_PDF = function (o, revisor) { return o === 'ia' ? 'sugerido por IA, revisado por ' + (revisor || '—') : o === 'calculo' ? 'cálculo' : 'manual'; };
  var RESULTADO_MISSAO = { localizado: 'localizado', nao_localizado: 'não localizado', nao_concluido: 'não concluído' };
  function porc(v, casas) { return v == null ? '—' : (v * 100).toLocaleString('pt-BR', { maximumFractionDigits: casas == null ? 1 : casas }) + '%'; }

  function secaoBusca(d, numero) {
    var b = d.busca;
    if (!b) return [];
    var out = [secao(numero, 'Probabilidades de busca (POA, POD e POS)', true)];
    out.push(nota('POA: probabilidade de a pessoa estar no setor, decidida pelo comando e aprovada em versões (uma versão aprovada nunca é alterada). POD: probabilidade de a busca achá-la se ela estiver no setor, vinda do registro manual da equipe, nunca do GPS. POS = POA × POD: probabilidade de a busca localizar a pessoa (não é probabilidade de sobrevivência nem de resgate com vida). Os valores de "situação atual" são calculados a partir dos dados abaixo.'));
    (b.vitimas || []).forEach(function (v) {
      if (!v.versoes.length) return;
      out.push(subtitulo('Cenário de ' + v.nome + (v.localizada ? ' — vítima localizada em ' + dataHora(v.localizada.em) + ' (cenário encerrado)' : '')));
      v.versoes.forEach(function (c) {
        out.push({ text: 'Versão ' + c.numero + ' · aprovada por ' + txt(c.aprovada_por_nome) + ' em ' + dataHora(c.aprovada_em), style: 'dia', headlineLevel: 2 });
        out.push(ficha([
          ['Horário de referência', dataHora(c.horario_referencia)],
          ['Origem do POA', ORIGEM_PROB[c.origem_poa] || c.origem_poa],
          c.confianca ? ['Sustentação dos dados', c.confianca + ' (julgamento do comando, não intervalo estatístico)'] : null,
          c.ponto_confiavel ? ['Último ponto confiável', c.ponto_confiavel.titulo + ' · ' + coord(c.ponto_confiavel.lat, c.ponto_confiavel.lng)] : null,
          ['Justificativa', c.justificativa],
          vazio(c.hipoteses) ? null : ['Hipóteses', c.hipoteses],
          vazio(c.limitacoes) ? null : ['Limitações', c.limitacoes],
        ]));
        var soma = c.setores.reduce(function (a, s) { return a + (s.poa || 0); }, 0);
        out.push(tabela(['Setor', 'POA', 'Área', 'Origem', 'Justificativa do setor'], c.setores.map(function (s) {
          return [{ text: s.nome, style: 'td', bold: true }, porc(s.poa), s.area_m2 ? textoArea(s.area_m2) : '—', ORIGEM_VALOR_PDF(s.origem, s.ia_revisado_por_nome), txt(s.justificativa, '')];
        }).concat([[{ text: 'Fora da área', style: 'td', italics: true }, porc(c.poa_fora != null ? c.poa_fora : Math.max(0, 1 - soma)), '—', ORIGEM_VALOR_PDF(c.poa_fora_origem, c.aprovada_por_nome), '']]), [110, 44, 62, 90, '*']));
        if ((c.evidencias || []).length) {
          out.push({ text: 'Evidências consideradas', style: 'rotulo' });
          out.push({ ul: c.evidencias.map(function (e) { return e.descricao + ' — ' + (e.confirmada ? 'confirmada' : 'não confirmada'); }), style: 'td', margin: [0, 2, 0, 8] });
        }
      });
    });
    if ((b.missoes || []).length) {
      out.push(subtitulo('Missões de busca (o POD pertence à missão)'));
      out.push(tabela(['Quando', 'Setor, equipe e método', 'POD', 'Resultado e execução real', 'POA recalculado'], b.missoes.map(function (m) {
        var pod = m.estado === 'concluida' ? m.pod_final : m.pod_planejada;
        var origem = m.estado === 'concluida' ? m.pod_final_origem : m.pod_planejada_origem, revisor = m.estado === 'concluida' ? m.pod_final_revisor : m.pod_planejada_revisor;
        return [{ text: dataHoraCurta(m.criada_em), style: 'tdMono' },
          { stack: [{ text: m.setor, style: 'td', bold: true }, { text: [m.equipe, m.metodo, 'área ' + porc(m.area_fracao, 0)].join(' · ') + (m.vitima ? ' · só ' + m.vitima : ''), style: 'tdSuave' }] },
          { text: (pod == null ? 'não estimada' : porc(pod)) + (origem === 'ia' ? ' (sugerido por IA, revisado por ' + txt(revisor) + ')' : ''), style: 'td' },
          m.estado === 'cancelada' ? 'Cancelada: ' + txt(m.cancelada_motivo) : m.estado === 'planejada' ? 'Planejada' : { stack: [{ text: RESULTADO_MISSAO[m.resultado] + ' · ' + txt(m.resultado_por), style: 'td' }, { text: 'cobertura real ' + (m.cobertura_real == null ? 'não informada' : porc(m.cobertura_real, 0)), style: 'tdSuave' }] },
          m.calculo_estado === 'aplicado' ? { stack: m.efeitos.map(function (e) { return { text: e.vitima + ': versão ' + e.versao + ' (POA ' + porc(e.poa_antes) + ' → ' + porc(e.poa_depois) + '; POS ' + porc(e.pos) + ')', style: 'tdSuave' }; }) }
            : m.calculo_estado === 'pendente_pod' ? 'Pendente: POD não estimada' : m.calculo_estado === 'inconsistente' ? 'Inconsistente: ' + txt(m.calculo_detalhe) : '—'];
      }), [52, '*', 70, 90, '*']));
      out.push(nota('POS = POA do setor × POD da missão: a chance de aquela busca localizar a pessoa (não é chance de sobrevivência). Cada busca negativa gera uma nova versão do cenário; as anteriores não mudam e PODs de missões diferentes nunca são somados.'));
    }
    if ((b.registros_antigos || []).length) {
      out.push(subtitulo('Registros de busca anteriores (formato antigo, não entram no cálculo)'));
      out.push(tabela(['Quando', 'Setor e equipe', 'POD', 'Situação'], b.registros_antigos.map(function (r) {
        return [{ text: dataHoraCurta(r.registrado_em), style: 'tdMono' }, [r.setor, txt(r.equipe, 'equipe não informada')].join(' · '), r.pod == null ? 'não estimada' : porc(r.pod), r.anulado ? 'Anulado: ' + r.anulado.motivo : 'Válido'];
      }), [52, '*', 60, 90]));
    }
    return out;
  }

  function secaoResultado(d, numero) {
    var op = d.operacao;
    var out = [secao(numero || 5, 'Resultado', true), caixaResultado(op)];
    var anteriores = d.relatorios_anteriores || [];
    out.push(ficha([
      ['Relatório gerado', dataHora(d.gerado_em) + ' por ' + txt(d.gerado_por_nome)],
      ['Versões anteriores', anteriores.length ? anteriores.map(function (r) { return dataHora(r.gerado_em) + ' (' + r.gerado_por_nome + ')'; }).join('; ') : 'Nenhuma'],
    ]));
    return out;
  }

  /* ---------- documento ------------------------------------------------- */
  // IPO (Informe Padrão de Ocorrência): mesma ordem e rótulos do modelo do CBMPR.
  // Opções aparecem como "(X)" marcada e "(   )" não marcada, como no formulário impresso.
  function marcas(lista, valores) {
    var marcados = [].concat(valores || []);
    return lista.map(function (x) { return (marcados.indexOf(x[0]) >= 0 ? '(X) ' : '(   ) ') + x[1]; });
  }
  // Registros do diário que vêm do IPO (procedimento, recurso, desdobramento).
  function registrosIpo(d, tipo) {
    return (d.diario || []).filter(function (e) { return e.tipo === tipo; });
  }
  function nomeProcedimento(chave) {
    var p = window.Ipo.PROCEDIMENTOS.filter(function (x) { return x[0] === chave; })[0];
    return p ? p[1] : txt(chave);
  }
  function listaIpo(linhas) {
    return linhas.length ? { stack: linhas.map(function (t) { return { text: t, style: 'corpo' }; }), margin: [0, 0, 0, 10] } : nota('Nenhum registro no diário.');
  }
  // Registros do diário que já aparecem na seção da ocorrência (IPO): procedimento, recurso e desdobramento.
  function registrosDiario(d) {
    return (d.diario || []).filter(function (e) { return ['procedimento', 'recurso', 'desdobramento'].indexOf(e.tipo) === -1; });
  }

  // Dados da ocorrência, no formato do IPO do CBMPR. O IPO é o próprio cadastro da operação:
  // cada dado aparece uma só vez no relatório.
  function secaoOcorrencia(d, recursos) {
    var op = d.operacao;
    var i = window.Ipo.normalizarIpo(op.ipo || {});
    var sexo = { M: 'Masculino', F: 'Feminino' };
    var fotos = (recursos && recursos.fotosVitimas) || {};
    var vitimas = (d.vitimas || []).length
      ? d.vitimas.map(function (v) {
        var dados = ficha([
          ['VÍTIMA', txt(v.nome) + (v.nascimento ? ' (nascim: ' + v.nascimento + ')' : '')],
          ['Sexo / idade', txt(sexo[v.sexo]) + ' / ' + (v.idade != null ? v.idade + ' anos' : '—')],
          ['Origem da vítima', txt(v.origem)],
          vazio(v.caracteristicas) ? null : ['Características físicas', v.caracteristicas],
          vazio(v.roupas) ? null : ['Roupas', v.roupas],
          vazio(v.observacoes) ? null : ['Observações', v.observacoes],
        ]);
        var foto = fotos[v.id];
        return foto
          ? { columns: [{ image: foto, fit: [110, 140], width: 120 }, Object.assign({ width: '*' }, dados)], columnGap: 10, margin: [0, 0, 0, 10], unbreakable: true }
          : dados;
      })
      : [nota('Nenhuma vítima informada.')];
    var procedimentos = registrosIpo(d, 'procedimento');
    var recursosCb = registrosIpo(d, 'recurso');
    var desdobramentos = registrosIpo(d, 'desdobramento');
    var marcadosProc = procedimentos.map(function (e) { return e.ref_id; });

    var partes = [
      { text: 'IPO: ' + i.destinatarios, style: 'h2', pageBreak: 'before', margin: [0, 0, 0, 2] },
      { text: 'Informe Padrão de Ocorrência - IPO', style: 'h1', margin: [0, 0, 0, 4] },
      { text: 'ATENÇÃO: uso exclusivo nos grupos do CBMPR.', style: 'nota', margin: [0, 0, 0, 12] },
      ficha([
        ['Natureza', txt(i.natureza)],
        ['Nome do solicitante', txt(i.solicitante_nome) + (i.solicitante_documento ? ' (' + i.solicitante_documento + ')' : '')],
        ['Localidade / município / região', txt(op.local_endereco)],
        ['Início das operações (acionamento do CB)', op.acionado_em ? dataHora(op.acionado_em) : '—'],
        ['Coordenadas de referência (último avistamento)', coord(op.local_lat, op.local_lng)],
        ['Data e hora do último momento visto', (window.Ipo ? window.Ipo.textoHoraVisto(i, dataHora) : (i.desaparecimento ? dataHora(i.desaparecimento) : '')) || '—'],
        ['Nº de pessoas perdidas', i.pessoas_perdidas != null ? String(i.pessoas_perdidas) : '—'],
      ]),
      subtitulo('Vítima(s)'),
    ].concat(vitimas);
    if (i.meio_liquido) partes.push(subtitulo('Meio líquido'), listaIpo(marcas(window.Ipo.MEIOS, [i.meio_liquido])));
    return partes.concat([
      subtitulo('Buscas preliminares (casas de parentes, hospitais etc.)?'),
      listaIpo(marcas(window.Ipo.BUSCAS, i.buscas_preliminares ? [i.buscas_preliminares] : [])),
      subtitulo('Possibilidade real de vida?'),
      listaIpo(marcas(window.Ipo.VIDA, i.possibilidade_vida ? [i.possibilidade_vida] : [])),
      subtitulo('Procedimentos de busca sendo realizados'),
      listaIpo(marcas(window.Ipo.PROCEDIMENTOS, marcadosProc)),
      listaIpo(procedimentos.map(function (e) {
        return hora(e.ocorrido_em) + ' · ' + nomeProcedimento(e.ref_id) + (vazio(e.detalhe) ? '' : ' — ' + e.detalhe);
      })),
      subtitulo('Descrição da ocorrência'),
      { text: txt(op.descricao), style: 'corpo', margin: [0, 0, 0, 10] },
      subtitulo('Recursos CB deslocados e sendo utilizados'),
      listaIpo(recursosCb.map(function (e) { return dataHora(e.ocorrido_em) + ' · ' + e.detalhe; })),
      ficha([['Quantidade de BMs diretamente envolvidos na resposta', i.bms_envolvidos != null ? String(i.bms_envolvidos) : '—']]),
      subtitulo('Desdobramentos / situação atual'),
      listaIpo(desdobramentos.map(function (e) { return dataHora(e.ocorrido_em) + ' · ' + e.detalhe; })),
      subtitulo('Imagens anexas junto a esta mensagem?'),
      listaIpo(marcas([['sim', 'Sim'], ['nao', 'Não']], i.imagens_anexas === true ? ['sim'] : i.imagens_anexas === false ? ['nao'] : [])),
      ficha([
        ['Responsável pelas informações', txt(i.responsavel_informacoes)],
        ['Guarda dos dados', op.dados_apagados_em ? 'Dados pessoais apagados em ' + dataHora(op.dados_apagados_em) + ' (regra antiga de retenção)' : 'Guardados até a exclusão da operação'],
      ]),
    ]);
  }

  function montarDocumento(d, recursos) {
    recursos = recursos || {};
    recursos.fotos = recursos.fotos || {};
    var op = d.operacao;
    var ref = data(op.acionado_em || op.criada_em);
    ANO_REF = ref ? ref.getFullYear() : null;
    var conteudo = []
      .concat(capa(d, recursos))
      .concat(secaoOcorrencia(d, recursos))
      .concat(secaoPessoas(d))
      .concat(secaoSetores(d, recursos))
      .concat(secaoPontos(d))
      .concat(secaoDiario(d))
      .concat(secaoBusca(d, 5))
      .concat(secaoResultado(d, d.busca ? 6 : 5));
    return documento(d, recursos, conteudo, { titulo: 'Relatório final — ' + op.codigo, assunto: 'Relatório final de operação de busca e salvamento', marca: 'RELATÓRIO FINAL' });
  }

  // Página com cabeçalho (logo e código), rodapé (gerado em, página X de Y) e estilos comuns aos relatórios.
  // o: { titulo, assunto, marca (texto do cabeçalho), cabecalhoNaPrimeira }
  function documento(d, recursos, conteudo, o) {
    var op = d.operacao;
    return {
      pageSize: 'A4',
      pageMargins: [40, 58, 40, 52],
      info: {
        title: o.titulo,
        author: d.gerado_por_nome || '',
        subject: o.assunto,
        creator: 'Rastreamento GBS',
      },
      // Cabeçalho das páginas seguintes à capa: logo do Corpo de Bombeiros à esquerda e
      // código da operação à direita (sem a logo, sai só o nome da corporação).
      header: function (pagina) {
        if (pagina === 1 && !o.cabecalhoNaPrimeira) return null;
        var marca = recursos.logo
          ? { image: recursos.logo, width: 112 }
          : { text: 'CORPO DE BOMBEIROS MILITAR', fontSize: 8, bold: true, color: COR.texto };
        return {
          margin: [40, 14, 40, 0],
          stack: [
            { columns: [
              marca,
              { width: '*', stack: [
                { text: op.codigo, fontSize: 8, bold: true, color: COR.texto, alignment: 'right' },
                { text: o.marca + '  ·  DOCUMENTO RESTRITO', fontSize: 7.5, color: COR.acento, bold: true, alignment: 'right', characterSpacing: 0.6, margin: [0, 2, 0, 0] },
              ] },
            ] },
            { canvas: [{ type: 'line', x1: 0, y1: 5, x2: 515, y2: 5, lineWidth: 0.5, lineColor: COR.linha }] },
          ],
        };
      },
      footer: function (pagina, total) {
        return {
          margin: [40, 16, 40, 0],
          columns: [
            { text: 'Gerado em ' + dataHora(d.gerado_em) + ' por ' + txt(d.gerado_por_nome) + '. Contém dados pessoais e informações sensíveis: uso restrito.', fontSize: 7, color: COR.suave },
            { text: 'Página ' + pagina + ' de ' + total, fontSize: 7.5, color: COR.suave, alignment: 'right', width: 80 },
          ],
        };
      },
      content: conteudo,
      // título nunca fica sozinho no pé da página
      pageBreakBefore: function (no, seguintes) { return no.headlineLevel === 1 && seguintes.length === 0; },
      defaultStyle: { font: 'Roboto', fontSize: 9.5, color: COR.texto, lineHeight: 1.18 },
      styles: {
        sobretitulo: { fontSize: 10, bold: true, color: COR.acento, characterSpacing: 1.5 },
        tituloCapa: { fontSize: 26, bold: true, lineHeight: 1.05 },
        subtituloCapa: { fontSize: 12, color: COR.suave },
        rotuloCaixa: { fontSize: 7, bold: true, color: COR.suave, characterSpacing: 0.8 },
        numero: { fontSize: 15, bold: true },
        numeroRotulo: { fontSize: 7.5, color: COR.suave },
        h1: { fontSize: 16, bold: true, margin: [0, 0, 0, 12] },
        h2: { fontSize: 11.5, bold: true, margin: [0, 8, 0, 6] },
        h3: { fontSize: 9.5, bold: true, color: COR.suave, margin: [0, 4, 0, 4] },
        dia: { fontSize: 10.5, bold: true, color: COR.acento, margin: [0, 6, 0, 2] },
        toc: { fontSize: 10.5 },
        corpo: { fontSize: 9.5 },
        nota: { fontSize: 8, color: COR.suave, italics: true, margin: [0, 0, 0, 8] },
        rotulo: { fontSize: 8, color: COR.suave },
        valor: { fontSize: 9.5 },
        th: { fontSize: 7.5, bold: true, color: COR.suave, characterSpacing: 0.3 },
        td: { fontSize: 8.5 },
        tdSuave: { fontSize: 8, color: COR.suave },
        tdNota: { fontSize: 7.5, color: COR.suave, italics: true },
        tdMono: { fontSize: 8 },
        legendaFoto: { fontSize: 7, color: COR.suave, alignment: 'center' },
      },
    };
  }

  /* ---------- relatório diário ------------------------------------------ */
  // dia = 'AAAA-MM-DD' (dia local). Situação ao fim do dia (mapa geral, setores, vítimas) e o que aconteceu no dia
  // (números, encontros e o diário daquele dia). Mesmo cabeçalho e estilos do relatório final, sem sumário.
  function montarDiario(d, recursos, dia) {
    recursos = recursos || {};
    var op = d.operacao;
    var ref = data(dia + 'T12:00:00');
    ANO_REF = ref ? ref.getFullYear() : null;
    function noDia(v) { return chaveDia(v) === dia; }
    var doDia = registrosDiario(d).filter(function (e) { return noDia(e.ocorrido_em); });
    var encontros = doDia.filter(function (e) { return e.categoria === 'encontro'; });
    var concluidos = doDia.filter(function (e) { return e.tipo === 'setor_concluido'; });
    var entraram = (d.participantes || []).filter(function (p) { return noDia(p.entrou_em); });
    var fotos = (d.fotos || []).filter(function (f) { return noDia(f.capturada_em); });
    var pontos = (d.pontos || []).filter(function (p) { return noDia(p.criado_em); });
    var numeros = [
      [String(doDia.length), 'registros no diário'], [String(encontros.length), 'encontros e relatos'],
      [String(concluidos.length), 'setores concluídos'], [String(entraram.length), 'pessoas entraram'], [String(fotos.length), 'fotos'],
    ];
    var conteudo = [];
    if (recursos.logo) conteudo.push({ image: recursos.logo, width: 150, margin: [0, 0, 0, 14] });
    conteudo.push({ text: 'RELATÓRIO DIÁRIO DA OPERAÇÃO', style: 'sobretitulo', margin: [0, 0, 0, 6] });
    conteudo.push({ canvas: [{ type: 'rect', x: 0, y: 0, w: 48, h: 3, color: COR.acento }], margin: [0, 0, 0, 10] });
    conteudo.push({ text: op.codigo, style: 'tituloCapa', fontSize: 20 });
    conteudo.push({ text: diaExtenso(dia + 'T12:00:00'), style: 'subtituloCapa', margin: [0, 4, 0, 12] });
    conteudo.push(ficha([
      ['Acionamento', dataHora(op.acionado_em)],
      ['Situação', op.status === 'encerrada' ? 'Encerrada em ' + dataHora(op.encerrada_em) : 'Em andamento'],
      ['Dia da operação', ref && data(op.acionado_em || op.criada_em) ? String(Math.floor((ref - new Date(chaveDia(op.acionado_em || op.criada_em) + 'T12:00:00')) / 86400000) + 1) + 'º dia' : '—'],
      ['Gerado', 'automaticamente pelo painel, com os dados do fim do dia'],
    ]));
    conteudo.push({
      table: { widths: ['*', '*', '*', '*', '*'], body: [numeros.map(function (n) {
        return { stack: [{ text: n[0], style: 'numero' }, { text: n[1], style: 'numeroRotulo' }], fillColor: COR.fundo, margin: [8, 7, 4, 7] };
      })] },
      layout: { hLineWidth: function () { return 0; }, vLineWidth: function (i) { return i > 0 && i < 5 ? 3 : 0; }, vLineColor: function () { return '#ffffff'; },
        paddingLeft: function () { return 0; }, paddingRight: function () { return 0; }, paddingTop: function () { return 0; }, paddingBottom: function () { return 0; } },
      margin: [0, 0, 0, 14],
    });
    if (recursos.mapaGeral) {
      conteudo.push(subtitulo('Mapa geral (situação até o fim do dia)'));
      conteudo.push({ image: recursos.mapaGeral, width: 515, margin: [0, 0, 0, 4] });
      conteudo.push(legendaMapa());
    }
    conteudo.push(subtitulo('Setores'));
    if (!d.setores.length) conteudo.push(nota('Nenhum setor de busca definido.'));
    else conteudo.push(tabela(['Setor', 'Situação', 'Equipe / grupo', 'Área'], d.setores.map(function (s) {
      var grupos = (s.missoes || []).map(function (m) { return m.grupo; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', ');
      return [{ text: s.nome, style: 'td', bold: true }, STATUS_SETOR[s.status] || s.status, txt([s.equipe, grupos].filter(Boolean).join(' · ')), textoArea(areaSetor(s))];
    }), ['*', 80, 150, 60]));
    conteudo.push(subtitulo('Vítimas'));
    if (!(d.vitimas || []).length) conteudo.push(nota('Nenhuma ficha de vítima.'));
    else conteudo.push(tabela(['Vítima', 'Idade', 'Características'], d.vitimas.map(function (v) {
      return [{ text: v.nome, style: 'td', bold: true }, v.idade == null ? '—' : String(v.idade), txt([v.caracteristicas, v.roupas].filter(function (x) { return !vazio(x); }).join(' · '))];
    }), ['*', 40, 230]));
    conteudo.push(subtitulo('Encontros e relatos do dia'));
    if (!encontros.length) conteudo.push(nota('Nenhum encontro ou relato de campo neste dia.'));
    else conteudo.push(tabela(['Hora', 'Registro', 'Local', 'Por'], encontros.map(function (e) {
      return [hora(e.ocorrido_em), { stack: [{ text: e.titulo, style: 'td', bold: true }, vazio(e.detalhe) ? null : { text: e.detalhe, style: 'tdSuave' }].filter(Boolean) },
        { text: coord(e.lat, e.lng), style: 'tdMono' }, e.autor_nome];
    }), [36, '*', 92, 80]));
    conteudo.push(subtitulo('Diário do dia'));
    if (!doDia.length) conteudo.push(nota('Nenhum registro no diário neste dia.'));
    else conteudo.push(tabela(['Hora', 'Tipo', 'Registro', 'Por'], doDia.map(function (e) {
      return [{ text: hora(e.ocorrido_em), style: 'tdMono', bold: true }, { text: CATEGORIA[e.categoria] || e.categoria, style: 'tdSuave' },
        { stack: [{ text: e.titulo, style: 'td' }, vazio(e.detalhe) ? null : { text: e.detalhe, style: 'tdSuave' }].filter(Boolean) }, { text: txt(e.autor_nome), style: 'tdSuave' }];
    }), [36, 64, '*', 80]));
    if (pontos.length) {
      conteudo.push(subtitulo('Pontos marcados no dia'));
      conteudo.push(tabela(['Hora', 'Tipo', 'Título', 'Coordenadas'], pontos.map(function (p) {
        return [hora(p.criado_em), p.tipo_nome || PONTO[p.categoria] || p.categoria, { text: p.titulo, style: 'td', bold: true }, { text: coord(p.lat, p.lng), style: 'tdMono' }];
      }), [36, 100, '*', 92]));
    }
    var data0 = dia.split('-');
    return documento(d, recursos, conteudo, { titulo: 'Relatório diário ' + data0[2] + '/' + data0[1] + '/' + data0[0] + ' — ' + op.codigo,
      assunto: 'Relatório diário de operação de busca e salvamento', marca: 'RELATÓRIO DIÁRIO ' + data0[2] + '/' + data0[1] });
  }

  /* ---------- relatório da passagem de comando --------------------------- */
  // pas: a passagem (passagens_comando); linhas: o briefing do momento em linhas "RÓTULO: texto" (Briefing.textoPuro).
  var ESTADO_PASSAGEM = { pendente: 'Aguardando aceite', aceita: 'Aceita', recusada: 'Recusada', cancelada: 'Cancelada', assumida: 'Comando assumido' };
  function montarPassagem(op, pas, linhas, recursos, extra) {
    recursos = recursos || {};
    extra = extra || {};
    var d = { operacao: op, gerado_em: extra.gerado_em || new Date().toISOString(), gerado_por_nome: extra.gerado_por_nome || '' };
    ANO_REF = null;
    var conteudo = [];
    if (recursos.logo) conteudo.push({ image: recursos.logo, width: 150, margin: [0, 0, 0, 14] });
    conteudo.push({ text: 'PASSAGEM DE COMANDO', style: 'sobretitulo', margin: [0, 0, 0, 6] });
    conteudo.push({ canvas: [{ type: 'rect', x: 0, y: 0, w: 48, h: 3, color: COR.acento }], margin: [0, 0, 0, 10] });
    conteudo.push({ text: op.codigo, style: 'tituloCapa', fontSize: 20, margin: [0, 0, 0, 12] });
    conteudo.push(ficha([
      ['Quem passou', txt(pas.de_nome)],
      ['Quem recebeu', txt(pas.para_nome)],
      ['Pedido em', dataHora(pas.criada_em)],
      ['Situação', (ESTADO_PASSAGEM[pas.estado] || pas.estado) + (pas.respondida_em ? ' em ' + dataHora(pas.respondida_em) : '')],
      vazio(pas.nota) ? null : ['Recado de quem passou', pas.nota],
      vazio(pas.resposta_nota) ? null : ['Resposta', pas.resposta_nota],
      vazio(pas.motivo) ? null : ['Motivo', pas.motivo],
      ['Acionamento da operação', dataHora(op.acionado_em)],
    ]));
    conteudo.push(subtitulo('Briefing entregue (foto de ' + dataHora((pas.resumo && pas.resumo.gerado_em) || pas.criada_em) + ')'));
    var corpo = (linhas || []).slice(1).map(function (l) {
      var i = l.indexOf(': ');
      return i > 0 ? [l.slice(0, i).charAt(0) + l.slice(1, i).toLowerCase(), l.slice(i + 2)] : ['', l];
    });
    conteudo.push(corpo.length ? ficha(corpo) : nota('Briefing indisponível.'));
    if (extra.observacoes) conteudo.push(ficha([['Observações', extra.observacoes]]));
    conteudo.push(nota('O comando só muda quando quem recebe aceita; o horário do aceite fica registrado no diário da operação. Este documento reproduz o briefing que foi entregue no momento da passagem.'));
    return documento(d, recursos, conteudo, { titulo: 'Passagem de comando — ' + op.codigo, assunto: 'Relatório de passagem de comando', marca: 'PASSAGEM DE COMANDO' });
  }

  // Fotos de cada setor (dentro do círculo ou do polígono) e as que ficaram fora.
  function distribuirFotos(setores, fotos, limitePorSetor) {
    var porSetor = {}, omitidas = {}, fora = [];
    fotos.forEach(function (f) {
      if (f.lat == null) { fora.push(f); return; }
      var s = setores.find(function (x) { return dentroSetor(x, f.lat, f.lng); });
      if (!s) { fora.push(f); return; }
      porSetor[s.id] = porSetor[s.id] || [];
      if (limitePorSetor == null || porSetor[s.id].length < limitePorSetor) porSetor[s.id].push(f);
      else omitidas[s.id] = (omitidas[s.id] || 0) + 1;
    });
    if (limitePorSetor != null && fora.length > limitePorSetor) fora = fora.slice(0, limitePorSetor);
    return { porSetor: porSetor, omitidas: omitidas, fora: fora };
  }

  function dentroSetor(s, lat, lng) {
    if (s.forma === 'circulo') {
      var R = 6371000, k = Math.PI / 180;
      var dLat = (lat - s.centro_lat) * k, dLng = (lng - s.centro_lng) * k;
      var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(s.centro_lat * k) * Math.cos(lat * k) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(a))) <= s.raio_m;
    }
    var pts = s.pontos || [], dentro = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var yi = pts[i][0], xi = pts[i][1], yj = pts[j][0], xj = pts[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) dentro = !dentro;
    }
    return dentro;
  }

  var api = { montarDocumento: montarDocumento, montarDiario: montarDiario, montarPassagem: montarPassagem, distribuirFotos: distribuirFotos, dentroSetor: dentroSetor, areaSetor: areaSetor, RESULTADO: RESULTADO };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.RelatorioPDF = api;
})(typeof window !== 'undefined' ? window : this);
