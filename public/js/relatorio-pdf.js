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

  // o módulo do IPO (no navegador, window.Ipo; nos testes do Node pode não existir)
  function moduloIpo() { return typeof window !== 'undefined' && window.Ipo ? window.Ipo : (raiz.Ipo || null); }

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
          { text: 'Não apurado', fontSize: 13, bold: true, color: COR.suave, margin: [0, 2, 0, 0] },
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
      { text: 'RELATÓRIO FINAL DETALHADO DE OPERAÇÃO', style: 'sobretitulo', margin: [0, recursos.logo ? 0 : 30, 0, 6] },
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
        if (recursos.mapaNota) out.push(nota(recursos.mapaNota));
      }
      return out;
    }
    var concl = d.setores.filter(function (s) { return s.status === 'concluido'; });
    var area = concl.reduce(function (a, s) { return a + areaSetor(s); }, 0);
    out.push({ text: concl.length + ' de ' + d.setores.length + ' setor(es) concluído(s), somando ' + textoArea(area) + ' varridos.', style: 'corpo', margin: [0, 0, 0, 8] });
    if (recursos.mapaGeral) {
      out.push({ image: recursos.mapaGeral, width: 515, margin: [0, 0, 0, 4] });
      out.push(legendaMapa());
      if (recursos.mapaNota) out.push(nota(recursos.mapaNota));
    }
    out.push(tabela(['Setor', 'Situação', 'Equipe / grupo', 'Início', 'Fim', 'Duração', 'Área'], d.setores.map(function (s) {
      var grupos = (s.missoes || []).map(function (m) { return m.grupo; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', ');
      return [{ columns: [{ canvas: [{ type: 'rect', x: 0, y: 2, w: 8, h: 8, r: 1, color: s.cor || '#3b82f6' }], width: 14 }, { text: s.nome, style: 'td', bold: true }] },
        STATUS_SETOR[s.status] || s.status, txt([s.equipe, grupos].filter(Boolean).join(' · ')), dataHoraCurta(s.inicio_em), dataHoraCurta(s.fim_em),
        duracao(s.inicio_em, s.fim_em), textoArea(areaSetor(s))];
    }), ['*', 58, 88, 56, 56, 50, 46]));
    out.push(nota('Início e fim correspondem à mudança de situação do setor no painel, registrada pelo sistema no diário. No mapa, contorno contínuo = setor concluído; tracejado = pendente ou em andamento. Imagens de satélite © Esri, Maxar, Earthstar Geographics.'));

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

  // Dados da ocorrência, no formato do IPO do CBMPR (Ipo.itens: a mesma montagem do texto que vai para o WhatsApp).
  // As fichas das vítimas (com foto) vêm logo depois do informe.
  // dia: 'AAAA-MM-DD' ou nulo; acumulado: o IPO acumulado até o dia (como o modelo do CBMPR) em vez de só o dia
  function blocoIpo(d, dia, acumulado) {
    var op = d.operacao;
    var I = window.Ipo;
    var lista = I.itens(op, { vitimas: d.vitimas || [], diario: d.diario || [], dia: acumulado ? null : (dia || null), ate: acumulado ? dia : null, responsavel: d.gerado_por_nome || '', coordenada: function (lat, lng) { return coord(lat, lng); } });
    var out = [], fichaAtual = [];
    function fecharFicha() { if (fichaAtual.length) { out.push(ficha(fichaAtual)); fichaAtual = []; } }
    lista.forEach(function (x) {
      if (x.cabecalho) { fecharFicha(); out.push({ text: x.cabecalho, bold: true, fontSize: 10, margin: [0, 0, 0, 2] }); return; }
      if (x.valor != null) { fichaAtual.push([x.rotulo, x.valor]); return; }
      fecharFicha();
      out.push(subtitulo(x.rotulo));
      if (x.marcas) out.push(listaIpo(x.marcas.map(function (m) { return (m[1] ? '(X) ' : '(   ) ') + m[0]; })));
      else out.push({ stack: x.linhas.map(function (t) { return { text: t, style: 'corpo', margin: [0, 0, 0, x.espacado ? 6 : 1] }; }), margin: [0, 0, 0, 10] });
    });
    fecharFicha();
    return out;
  }
  function secaoOcorrencia(d, recursos) {
    var op = d.operacao;
    var i = window.Ipo.normalizarIpo(op.ipo || {});
    var sexo = { M: 'Masculino', F: 'Feminino' };
    var fotos = (recursos && recursos.fotosVitimas) || {};
    var vitimas = (d.vitimas || []).map(function (v) {
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
    });
    return [
      { text: 'IPO: ' + i.destinatarios, style: 'h2', pageBreak: 'before', margin: [0, 0, 0, 2] },
      { text: 'Informe Padrão de Ocorrência - IPO', style: 'h1', margin: [0, 0, 0, 4] },
      { text: 'ATENÇÃO: uso exclusivo nos grupos do CBMPR.', style: 'nota', margin: [0, 0, 0, 12] },
    ].concat(blocoIpo(d))
      .concat(vitimas.length ? [subtitulo('Ficha da(s) vítima(s)')].concat(vitimas) : [])
      .concat([ficha([
        i.solicitante_nome ? ['Solicitante', i.solicitante_nome + (i.solicitante_documento ? ' (' + i.solicitante_documento + ')' : '')] : null,
        ['Guarda dos dados', op.dados_apagados_em ? 'Dados pessoais apagados em ' + dataHora(op.dados_apagados_em) + ' (regra antiga de retenção)' : 'Guardados até a exclusão da operação'],
      ])]);
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
    return documento(d, recursos, conteudo, { titulo: 'Relatório final detalhado — ' + op.codigo, assunto: 'Relatório final detalhado de operação de busca e salvamento', marca: 'RELATÓRIO FINAL DETALHADO' });
  }

  /* ---------- relatório resumido ------------------------------------------ */
  // O essencial em poucas páginas: situação, números, o mapa geral (setores, trilhas das pessoas e fotos, enquadrado na
  // área da operação), os setores, as pessoas com o quanto andaram, algumas fotos e o IPO.
  function kmTrilha(pontos) {
    var m = 0;
    for (var k = 1; k < (pontos || []).length; k++) {
      var a = pontos[k - 1], b = pontos[k];
      var dLat = (b[0] - a[0]) * Math.PI / 180, dLng = (b[1] - a[1]) * Math.PI / 180;
      var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
      var seg = 12742000 * Math.asin(Math.sqrt(h));
      if (seg < 1500) m += seg;   // salto grande (falha de sinal, outro lugar) não conta como caminhada
    }
    return m / 1000;
  }
  function montarResumido(d, recursos) {
    recursos = recursos || {};
    recursos.fotos = recursos.fotos || {};
    var op = d.operacao;
    var ref = data(op.acionado_em || op.criada_em);
    ANO_REF = ref ? ref.getFullYear() : null;
    var ipo = window.Ipo.normalizarIpo(op.ipo || {});
    var kmPorPessoa = {};
    (d.trilhas || []).forEach(function (t) { kmPorPessoa[t.participante_id] = (kmPorPessoa[t.participante_id] || 0) + kmTrilha(t.pontos); });
    var kmTotal = Object.keys(kmPorPessoa).reduce(function (a, k) { return a + kmPorPessoa[k]; }, 0);
    var concluidos = d.setores.filter(function (s) { return s.status === 'concluido'; });
    var areaConcluida = concluidos.reduce(function (a, s) { return a + (areaSetor(s) || 0); }, 0);
    var numeros = [
      [String(d.participantes.length), 'pessoas de campo'],
      [concluidos.length + ' / ' + d.setores.length, 'setores concluídos'],
      [areaConcluida ? textoArea(areaConcluida) : '—', 'área varrida (concluídos)'],
      [kmTotal ? kmTotal.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' km' : '—', 'percorridos (trilhas)'],
      [String((d.fotos || []).length), 'fotos'],
    ];
    var conteudo = [];
    if (recursos.logo) conteudo.push({ image: recursos.logo, width: 150, margin: [0, 0, 0, 12] });
    conteudo.push({ text: 'RELATÓRIO FINAL DA OPERAÇÃO', style: 'sobretitulo', margin: [0, 0, 0, 6] });
    conteudo.push({ canvas: [{ type: 'rect', x: 0, y: 0, w: 48, h: 3, color: COR.acento }], margin: [0, 0, 0, 10] });
    conteudo.push({ text: op.codigo, style: 'tituloCapa', fontSize: 20 });
    conteudo.push({ text: txt(ipo.natureza, ''), style: 'subtituloCapa', margin: [0, 4, 0, 10] });
    conteudo.push(ficha([
      ['Local', txt(ipo.localidade || op.local_endereco || (op.local_lat != null ? coord(op.local_lat, op.local_lng) : ''))],
      ['Início das operações', dataHora(op.acionado_em)],
      ['Situação', op.status === 'encerrada' ? 'Encerrada em ' + dataHora(op.encerrada_em) : 'Em andamento'],
      ['Duração', duracao(op.acionado_em || op.criada_em, op.encerrada_em || d.gerado_em)],
      ['Responsável (criador)', txt(op.criador_nome)],
    ]));
    conteudo.push(caixaResultado(op));
    conteudo.push({
      table: { widths: ['*', '*', '*', '*', '*'], body: [numeros.map(function (n) {
        return { stack: [{ text: n[0], style: 'numero' }, { text: n[1], style: 'numeroRotulo' }], fillColor: COR.fundo, margin: [8, 7, 4, 7] };
      })] },
      layout: { hLineWidth: function () { return 0; }, vLineWidth: function (i) { return i > 0 && i < 5 ? 3 : 0; }, vLineColor: function () { return '#ffffff'; },
        paddingLeft: function () { return 0; }, paddingRight: function () { return 0; }, paddingTop: function () { return 0; }, paddingBottom: function () { return 0; } },
      margin: [0, 0, 0, 14],
    });
    if (recursos.mapaGeral) {
      conteudo.push(subtitulo('Mapa da operação'));
      conteudo.push({ image: recursos.mapaGeral, width: 515, margin: [0, 0, 0, 4] });
      conteudo.push(legendaMapa());
      if (recursos.mapaNota) conteudo.push(nota(recursos.mapaNota));
    }
    conteudo.push(subtitulo('Setores'));
    if (!d.setores.length) conteudo.push(nota('Nenhum setor de busca definido.'));
    else conteudo.push(tabela(['Setor', 'Situação', 'Equipe / grupo', 'Área'], d.setores.map(function (s) {
      var grupos = (s.missoes || []).map(function (m) { return m.grupo; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', ');
      return [{ text: s.nome, style: 'td', bold: true }, STATUS_SETOR[s.status] || s.status, txt([s.equipe, grupos].filter(Boolean).join(' · ')), textoArea(areaSetor(s))];
    }), ['*', 80, 150, 60]));
    conteudo.push(subtitulo('Pessoas de campo'));
    if (!d.participantes.length) conteudo.push(nota('Nenhum participante de campo entrou na operação.'));
    else conteudo.push(tabela(['Nome', 'Tipo', 'Grupo', 'Percorreu'], d.participantes.slice().sort(function (a, b) { return (kmPorPessoa[b.id] || 0) - (kmPorPessoa[a.id] || 0); }).map(function (p) {
      var km = kmPorPessoa[p.id];
      return [{ text: p.nome, style: 'td', bold: true }, TIPO_PESSOA[p.tipo] || p.tipo, txt(nomesGrupos(p)), km ? km.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' km' : '—'];
    }), ['*', 60, 140, 60]));
    var fotosRes = (recursos.fotosResumo || []).filter(function (f) { return recursos.fotos[f.id]; });
    if (fotosRes.length) conteudo.push(gradeFotos(fotosRes, recursos, 'Fotos (' + fotosRes.length + ' de ' + (d.fotos || []).length + ')'));
    conteudo.push(nota('Distâncias aproximadas, pelas trilhas resumidas do GPS. O relatório final detalhado traz o diário, os pontos, cada setor com o mapa próprio e todas as fotos.'));
    return documento(d, recursos, conteudo.concat(secaoOcorrencia(d, recursos)), { titulo: 'Relatório final — ' + op.codigo, assunto: 'Relatório final de operação de busca e salvamento', marca: 'RELATÓRIO FINAL' });
  }

  // Relatório para imprensa (divulgação): dados reduzidos. Sem nomes, documentos, telefones, fotos, trilhas, posições,
  // observações e registros de pessoas. Traz só números gerais, o desfecho geral e a linha do tempo dos marcos
  // automáticos da operação e dos setores (horário e título).
  function montarImprensa(d, recursos) {
    recursos = recursos || {};
    var op = d.operacao;
    var IPO = moduloIpo();
    var ipo = IPO ? IPO.normalizarIpo(op.ipo || {}) : {};
    var ativos = d.participantes.filter(function (p) { return !p.removido; });
    var militares = ativos.filter(function (p) { return p.tipo === 'militar' || p.tipo === 'responsavel'; }).length;
    var voluntarios = ativos.filter(function (p) { return p.tipo === 'civil'; }).length;
    var concluidos = d.setores.filter(function (s) { return s.status === 'concluido'; });
    var areaVarrida = concluidos.reduce(function (a, s) { return a + (areaSetor(s) || 0); }, 0);
    var km = (d.trilhas || []).reduce(function (a, t) { return a + kmTrilha(t.pontos); }, 0);
    var inicio = op.acionado_em || op.criada_em;
    var fim = op.encerrada_em || d.gerado_em || new Date().toISOString();
    var dias = inicio ? Math.max(1, Math.round((new Date(chaveDia(fim) + 'T12:00:00') - new Date(chaveDia(inicio) + 'T12:00:00')) / 86400000) + 1) : null;
    // efetivo: a soma do IPO por dia (militares-dia), quando houver
    var militaresDia = (ipo.efetivo || []).reduce(function (a, x) { return a + (x.qtd || 0); }, 0);
    var numeros = [
      [dias ? String(dias) : '—', dias === 1 ? 'dia de buscas' : 'dias de buscas'],
      [String(militares), 'militares'],
      [String(voluntarios), 'voluntários e civis'],
      [concluidos.length + ' / ' + d.setores.length, 'setores concluídos'],
      [areaVarrida ? textoArea(areaVarrida) : '—', 'área varrida'],
      [km ? km.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + ' km' : '—', 'percorridos a pé'],
    ];
    var r = op.resultado && RESULTADO[op.resultado] ? RESULTADO[op.resultado] : null;
    var situacaoTxt = r ? r.rotulo : op.status === 'encerrada' ? 'Buscas encerradas sem localização da vítima' : 'Buscas em andamento';
    var tipoOp = { aquatica: 'aquática', terrestre: 'terrestre', aerea: 'aérea', sarp: 'com SARP', brec: 'em estrutura colapsada (BREC)' }[op.tipo] || (op.tipo_outro ? op.tipo_outro.toLowerCase() : null);
    // a pessoa procurada, sem nome: "homem de 19 anos"
    var vit = (d.vitimas || []).map(function (v) {
      var q = v.sexo === 'M' ? 'um homem' : v.sexo === 'F' ? 'uma mulher' : 'uma pessoa';
      return q + (v.idade != null ? ' de ' + v.idade + ' anos' : '');
    });
    // local: só cidade/região (o que estiver antes do primeiro traço ou vírgula da localidade do IPO)
    var local = String(ipo.localidade || op.local_endereco || '').split(/\s[-–]\s|,/)[0].trim();
    // meios empregados: os procedimentos marcados no IPO (sem nomes)
    var meios = IPO ? IPO.PROCEDIMENTOS.filter(function (pr) { return (ipo.procedimentos || []).indexOf(pr[0]) !== -1; }).map(function (pr) { return pr[1]; }) : [];
    // órgãos de apoio: só o nome do órgão (o que vem antes de ":"); linhas sem ":" só se forem curtas
    var orgaos = String(ipo.orgaos_apoio || '').split('\n').map(function (l) {
      var t = l.replace(/^[-•]\s*/, '').trim();
      var k = t.indexOf(':');
      t = k > 0 ? t.slice(0, k) : t.length <= 40 ? t.replace(/\.$/, '') : '';
      return t.trim();
    }).filter(Boolean);
    var minuscula = function (t) { return t.charAt(0).toLowerCase() + t.slice(1); };
    var unicos = function (lista) { var v = {}; return lista.filter(function (t) { var k = t.toLowerCase(); if (v[k]) return false; v[k] = true; return true; }); };
    // buscas realizadas: os procedimentos marcados no IPO (geral e de cada dia) e os registrados no diário
    var chavesMeios = (ipo.procedimentos || []).slice();
    (ipo.dias || []).forEach(function (x) { (x.procedimentos || []).forEach(function (k) { if (chavesMeios.indexOf(k) === -1) chavesMeios.push(k); }); });
    (d.diario || []).forEach(function (e) { if (e.tipo === 'procedimento' && e.ref_id && chavesMeios.indexOf(e.ref_id) === -1) chavesMeios.push(e.ref_id); });
    meios = IPO ? IPO.PROCEDIMENTOS.filter(function (pr) { return chavesMeios.indexOf(pr[0]) !== -1; }).map(function (pr) { return pr[1]; }) : [];
    if (ipo.procedimentos_outros) meios.push(ipo.procedimentos_outros);
    // forças e órgãos de apoio (só o nome do órgão), do IPO geral e de cada dia
    var textoOrgaos = [ipo.orgaos_apoio].concat((ipo.dias || []).map(function (x) { return x.orgaos; })).join('\n');
    orgaos = unicos(textoOrgaos.split('\n').map(function (l) {
      var t = l.replace(/^[-•]\s*/, '').trim();
      var k = t.indexOf(':');
      t = k > 0 ? t.slice(0, k) : t.length <= 40 ? t.replace(/\.$/, '') : '';
      return t.trim();
    }).filter(Boolean));
    // recursos empregados (viaturas, aeronaves, embarcações, equipamentos): as linhas do IPO e os registros do diário
    var textoRecursos = [ipo.recursos_cb].concat((ipo.dias || []).map(function (x) { return x.recursos; }))
      .concat((d.diario || []).filter(function (e) { return e.tipo === 'recurso' && e.detalhe; }).map(function (e) { return e.detalhe; })).join('\n');
    var recursosUsados = unicos(textoRecursos.split('\n').map(function (l) { return l.replace(/^[-•]\s*/, '').replace(/[.;]\s*$/, '').trim(); }).filter(Boolean));
    var pendentes = d.setores.length - concluidos.length;
    var desap = IPO && ipo.desaparecimento ? IPO.textoHoraVisto(ipo, dataHora) : '';
    var paragrafos = function (t) { return String(t || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean); };

    // Resumo: o essencial em duas ou três frases
    var frases = [
      'Operação de busca' + (tipoOp ? ' ' + tipoOp : '') + (local ? ' em ' + local : '') + ', iniciada em ' + dataHora(inicio) +
        (op.encerrada_em ? ' e encerrada em ' + dataHora(op.encerrada_em) + ' (duração de ' + duracao(inicio, op.encerrada_em) + ')' : ', ainda em andamento') + '.',
      r ? r.rotulo + '.' : null,
    ].filter(Boolean);
    // Pessoa procurada: só sexo e idade e o último momento visto (nunca nome, documento ou características)
    var pessoa = [
      vit.length ? 'Procura por ' + (vit.length === 1 ? vit[0] : vit.length + ' pessoas (' + vit.join('; ') + ')') + '.' : null,
      desap ? 'Último momento em que foi vista: ' + desap + '.' : null,
    ].filter(Boolean);

    // Como aconteceu: o texto escrito pelo comando para a imprensa; sem ele, um texto padrão com os dados do IPO
    var comoAconteceu = paragrafos(ipo.imprensa_como);
    if (!comoAconteceu.length) {
      comoAconteceu = [
        'O Corpo de Bombeiros foi acionado em ' + dataHora(inicio) + (vit.length ? ' para procurar ' + (vit.length === 1 ? vit[0] : vit.length + ' pessoas') : ' para uma operação de busca') + (local ? ', na região de ' + local : '') + '.',
      ];
    }
    // Estratégia: idem
    var estrategia = paragrafos(ipo.imprensa_estrategia);
    if (!estrategia.length) {
      estrategia = [op.encerrada_em
        ? 'As buscas foram encerradas' + (r ? ': ' + minuscula(r.rotulo) : '') + '.'
        : 'As equipes trabalham em setores de busca definidos pelo comando a partir das informações disponíveis' + (meios.length ? ', combinando ' + meios.map(minuscula).join(', ') : '') + '. ' +
          (d.setores.length ? (pendentes > 0 ? 'Restam ' + pendentes + (pendentes === 1 ? ' setor' : ' setores') + ' a vistoriar; ' : 'Todos os setores definidos foram vistoriados; ') : '') +
          'novas informações e o resultado de cada varredura orientam os próximos passos.'];
    }
    // Buscas: números e meios
    var buscas = [
      dias ? 'As buscas ' + (op.encerrada_em ? 'duraram ' : 'já somam ') + dias + (dias === 1 ? ' dia' : ' dias') + '.' : null,
      d.setores.length ? 'O terreno foi dividido em ' + d.setores.length + (d.setores.length === 1 ? ' setor' : ' setores') + ', ' + concluidos.length + (concluidos.length === 1 ? ' concluído' : ' concluídos') +
        (areaVarrida ? ', cobrindo cerca de ' + textoArea(areaVarrida) : '') + '.' : null,
      km ? 'As equipes percorreram cerca de ' + km.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + ' km a pé, registrados por GPS.' : null,
    ].filter(Boolean);
    // Forças: bombeiros, voluntários e os órgãos de apoio
    var forcas = [];
    if (ativos.length) forcas.push('Corpo de Bombeiros: ' + militares + (militares === 1 ? ' militar' : ' militares') + (militaresDia ? ' (' + militaresDia + ' militares-dia no total)' : '') +
      ((d.grupos || []).length ? ', em ' + d.grupos.length + (d.grupos.length === 1 ? ' equipe' : ' equipes') : ''));
    if (voluntarios) forcas.push('Voluntários e civis: ' + voluntarios);
    orgaos.forEach(function (o) { forcas.push(o); });

    var conteudo = [
      { text: 'DIVULGAÇÃO PÚBLICA', style: 'sobretitulo', margin: [0, 0, 0, 10] },
      { text: 'Operação de busca e salvamento', style: 'tituloCapa' },
      { text: op.codigo, fontSize: 14, bold: true, margin: [0, 8, 0, 2] },
      { text: [ipo.natureza || null, local || null].filter(Boolean).join('  ·  ') || ' ', style: 'subtituloCapa', margin: [0, 0, 0, 4] },
      { text: 'Início: ' + dataHora(inicio) + '   ·   ' + (op.encerrada_em ? 'Encerrada em ' + dataHora(op.encerrada_em) : 'em andamento'), style: 'subtituloCapa', margin: [0, 0, 0, 16] },
      { table: { widths: ['*'], body: [[{ stack: [{ text: 'SITUAÇÃO', style: 'rotuloCaixa', color: r ? r.cor : COR.suave }, { text: situacaoTxt, fontSize: 14, bold: true, color: r ? r.cor : COR.texto, margin: [0, 2, 0, 0] }],
        fillColor: r ? r.fundo : COR.fundo, margin: [10, 8, 10, 8] }]] }, layout: 'noBorders', margin: [0, 0, 0, 16] },
      { table: { widths: ['*', '*', '*'], body: [numeros.slice(0, 3), numeros.slice(3)].map(function (lin) {
        return lin.map(function (n) { return { stack: [{ text: n[0], style: 'numero' }, { text: n[1], style: 'numeroRotulo' }], fillColor: COR.fundo, margin: [8, 7, 4, 7] }; });
      }) }, layout: { hLineWidth: function (i) { return i === 1 ? 3 : 0; }, hLineColor: function () { return '#ffffff'; }, vLineWidth: function (i) { return i > 0 && i < 3 ? 3 : 0; }, vLineColor: function () { return '#ffffff'; },
        paddingLeft: function () { return 0; }, paddingRight: function () { return 0; }, paddingTop: function () { return 0; }, paddingBottom: function () { return 0; } }, margin: [0, 0, 0, 18] },
    ];
    function secaoTexto(titulo, linhas) {
      if (!linhas.length) return;
      conteudo.push({ text: titulo, style: 'h2', headlineLevel: 1 });
      linhas.forEach(function (t) { conteudo.push({ text: t, fontSize: 10, lineHeight: 1.35, margin: [0, 0, 0, 6] }); });
      conteudo.push({ text: '', margin: [0, 0, 0, 6] });
    }
    function secaoLista(titulo, itens) {
      if (!itens.length) return;
      conteudo.push({ text: titulo, style: 'h2', headlineLevel: 1 }, { ul: itens, fontSize: 10, margin: [0, 0, 0, 12] });
    }
    secaoTexto('Resumo', [frases.join(' ')]);
    secaoTexto('Pessoa procurada', pessoa);
    secaoTexto('Como aconteceu', comoAconteceu);
    secaoTexto('Buscas realizadas', buscas);
    secaoLista('Meios empregados nas buscas', meios);
    secaoTexto('Estratégia e próximos passos', estrategia);
    secaoLista('Forças envolvidas', forcas);
    secaoLista('Recursos empregados', recursosUsados);
    conteudo.push({ text: 'Documento preparado para divulgação. Não traz nomes, documentos, telefones, fotos, trilhas, posições nem observações de campo. Distâncias e áreas aproximadas.',
      fontSize: 8, color: COR.suave, margin: [0, 18, 0, 0] });
    return documento(d, recursos, conteudo, { titulo: 'Relatório para imprensa — ' + op.codigo, assunto: 'Relatório para divulgação', marca: 'DIVULGAÇÃO', publico: true });
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
        author: o.publico ? '' : (d.gerado_por_nome || ''),
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
                { text: o.marca + (o.publico ? '' : '  ·  DOCUMENTO RESTRITO'), fontSize: 7.5, color: COR.acento, bold: true, alignment: 'right', characterSpacing: 0.6, margin: [0, 2, 0, 0] },
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
            { text: o.publico
              ? 'Gerado em ' + dataHora(d.gerado_em) + '. Divulgação: sem dados pessoais.'
              : 'Gerado em ' + dataHora(d.gerado_em) + ' por ' + txt(d.gerado_por_nome) + '. Contém dados pessoais e informações sensíveis: uso restrito.', fontSize: 7, color: COR.suave },
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
  // Relatório de um período (um dia ou um comando): p = { ini, fim (ms), ref (Date), sobretitulo, subtitulo, rotuloMapa,
  // geradoTexto, titulo, assunto, marca, sufixo ('do dia' | 'do comando'), linhasExtra, fechamento }.
  function montarPeriodo(d, recursos, p) {
    recursos = recursos || {};
    var op = d.operacao;
    var ref = p.ref;
    ANO_REF = ref ? ref.getFullYear() : null;
    function noDia(v) { var t = data(v); return Boolean(t) && t.getTime() >= p.ini && t.getTime() < p.fim; }
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
    conteudo.push({ text: p.sobretitulo, style: 'sobretitulo', margin: [0, 0, 0, 6] });
    conteudo.push({ canvas: [{ type: 'rect', x: 0, y: 0, w: 48, h: 3, color: COR.acento }], margin: [0, 0, 0, 10] });
    conteudo.push({ text: op.codigo, style: 'tituloCapa', fontSize: 20 });
    conteudo.push({ text: p.subtitulo, style: 'subtituloCapa', margin: [0, 4, 0, 12] });
    conteudo.push(ficha([
      ['Acionamento', dataHora(op.acionado_em)],
      ['Situação', op.status === 'encerrada' ? 'Encerrada em ' + dataHora(op.encerrada_em) : 'Em andamento'],
      ['Dia da operação', ref && data(op.acionado_em || op.criada_em) ? String(Math.floor((ref - new Date(chaveDia(op.acionado_em || op.criada_em) + 'T12:00:00')) / 86400000) + 1) + 'º dia' : '—'],
      ['Gerado', p.geradoTexto],
    ]));
    if (p.linhasExtra) conteudo.push(ficha(p.linhasExtra));
    conteudo.push({
      table: { widths: ['*', '*', '*', '*', '*'], body: [numeros.map(function (n) {
        return { stack: [{ text: n[0], style: 'numero' }, { text: n[1], style: 'numeroRotulo' }], fillColor: COR.fundo, margin: [8, 7, 4, 7] };
      })] },
      layout: { hLineWidth: function () { return 0; }, vLineWidth: function (i) { return i > 0 && i < 5 ? 3 : 0; }, vLineColor: function () { return '#ffffff'; },
        paddingLeft: function () { return 0; }, paddingRight: function () { return 0; }, paddingTop: function () { return 0; }, paddingBottom: function () { return 0; } },
      margin: [0, 0, 0, 14],
    });
    if (recursos.mapaGeral) {
      conteudo.push(subtitulo(p.rotuloMapa));
      conteudo.push({ image: recursos.mapaGeral, width: 515, margin: [0, 0, 0, 4] });
      conteudo.push(legendaMapa());
      if (recursos.mapaNota) conteudo.push(nota(recursos.mapaNota));
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
    conteudo.push(subtitulo('Encontros e relatos ' + p.sufixo));
    if (!encontros.length) conteudo.push(nota('Nenhum encontro ou relato de campo neste período.'));
    else conteudo.push(tabela(['Hora', 'Registro', 'Local', 'Por'], encontros.map(function (e) {
      return [hora(e.ocorrido_em), { stack: [{ text: e.titulo, style: 'td', bold: true }, vazio(e.detalhe) ? null : { text: e.detalhe, style: 'tdSuave' }].filter(Boolean) },
        { text: coord(e.lat, e.lng), style: 'tdMono' }, e.autor_nome];
    }), [36, '*', 92, 80]));
    conteudo.push(subtitulo('Diário ' + p.sufixo));
    if (!doDia.length) conteudo.push(nota('Nenhum registro no diário neste período.'));
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
    if (p.fechamento) {
      conteudo.push(subtitulo('Situação ao passar o comando'));
      conteudo.push(p.fechamento.length ? ficha(p.fechamento) : nota('Briefing indisponível.'));
    }
    if (p.comandos && p.comandos.length) {
      conteudo.push(subtitulo('Comandos da operação'));
      conteudo.push(tabela(['Comando', 'Comandante', 'Início', 'Fim', 'Passado a'], p.comandos.map(function (c) {
        return [{ text: c.rotulo, style: 'td', bold: true }, txt(c.comandante), dataHora(c.ini), c.fim ? dataHora(c.fim) : 'em andamento', txt(c.passadoA)];
      }), [60, '*', 80, 80, '*']));
      p.comandos.forEach(function (c) {
        if (!c.fechamento || !c.fechamento.length) return;
        conteudo.push(subtitulo('Situação ao passar o ' + c.rotulo.toLowerCase() + ' (' + txt(c.comandante) + ' → ' + txt(c.passadoA) + ')'));
        conteudo.push(ficha(c.fechamento));
      });
    }
    // o IPO vai dentro de todos os relatórios internos (não no da imprensa)
    if (p.ipo !== false && moduloIpo()) conteudo = conteudo.concat(secaoOcorrencia(d, recursos));
    return documento(d, recursos, conteudo, { titulo: p.titulo, assunto: p.assunto, marca: p.marca });
  }

  // Relatório diário de um dia ('AAAA-MM-DD'): o que aconteceu no dia e a situação ao fim dele (feito à mão pelo painel).
  function montarDiario(d, recursos, dia) {
    var ini = data(dia + 'T00:00:00');
    var fim = new Date(ini.getTime()); fim.setDate(fim.getDate() + 1);
    var partes = dia.split('-');
    return montarPeriodo(d, recursos, {
      ini: ini.getTime(), fim: fim.getTime(), ref: data(dia + 'T12:00:00'),
      sobretitulo: 'RELATÓRIO DIÁRIO DA OPERAÇÃO', subtitulo: diaExtenso(dia + 'T12:00:00'),
      rotuloMapa: 'Mapa geral (situação até o fim do dia)', geradoTexto: 'pelo painel, com os dados do momento da geração',
      titulo: 'Relatório diário ' + partes[2] + '/' + partes[1] + '/' + partes[0] + ' — ' + d.operacao.codigo,
      assunto: 'Relatório diário de operação de busca e salvamento', marca: 'RELATÓRIO DIÁRIO ' + partes[2] + '/' + partes[1],
      sufixo: 'do dia',
    });
  }

  // Relatório de um comando: cmd = { rotulo, ini (ms), fim (ms ou null = ainda em andamento), comandante, passadoA, fechamento }.
  // Mostra o que o comando fez no período e, se já foi passado, o briefing entregue na passagem.
  function montarComando(d, recursos, cmd) {
    var ini = cmd.ini;
    var fim = cmd.fim || Date.now() + 1;
    var quando = dataHora(ini);
    return montarPeriodo(d, recursos, {
      ini: ini, fim: fim, ref: new Date(ini),
      sobretitulo: 'RELATÓRIO DO COMANDO', subtitulo: cmd.rotulo,
      rotuloMapa: 'Mapa geral da operação', geradoTexto: 'pelo painel, com os dados do momento da geração',
      titulo: 'Relatório do comando — ' + cmd.rotulo + ' — ' + d.operacao.codigo,
      assunto: 'Relatório de comando de operação de busca e salvamento', marca: 'RELATÓRIO DO COMANDO',
      sufixo: 'do comando',
      linhasExtra: [
        ['Comandante', txt(cmd.comandante)],
        ['Início do comando', quando],
        ['Fim do comando', cmd.fim ? dataHora(cmd.fim) : 'em andamento'],
        ['Passado a', txt(cmd.passadoA)],
      ],
      fechamento: cmd.fechamento || null,
    });
  }

  // Todos os comandos: a operação inteira (do acionamento até agora ou o encerramento), com a tabela dos comandos e o
  // briefing entregue em cada passagem.
  function montarComandoGeral(d, recursos, comandos) {
    var op = d.operacao;
    var ini = data(op.acionado_em || op.criada_em) || new Date();
    var fimMs = op.encerrada_em ? data(op.encerrada_em).getTime() + 1 : Date.now() + 1;
    var lista = comandos || [];
    return montarPeriodo(d, recursos, {
      ini: ini.getTime(), fim: fimMs, ref: ini,
      sobretitulo: 'RELATÓRIO DE COMANDO · TODOS OS COMANDOS', subtitulo: lista.length + (lista.length === 1 ? ' comando' : ' comandos') + ' na operação',
      rotuloMapa: 'Mapa geral da operação', geradoTexto: 'pelo painel, com os dados do momento da geração',
      titulo: 'Relatório de comando (todos) — ' + op.codigo, assunto: 'Relatório de comando de operação de busca e salvamento', marca: 'RELATÓRIO DE COMANDO',
      sufixo: 'da operação',
      linhasExtra: [['Comandante atual', txt(lista.length ? lista[lista.length - 1].comandante : op.comando_nome)], ['Período', dataHora(ini) + ' até ' + (op.encerrada_em ? dataHora(op.encerrada_em) : 'agora')]],
      comandos: lista,
    });
  }

  /* ---------- relatório DIÁRIO (detalhado) e relatório IPO (curto): um dia, um período ou tudo, separados dia a dia ---------- */
  // Dias entre dois 'AAAA-MM-DD' (inclusive)
  function diasEntre(ini, fim) {
    var out = [];
    var d = new Date(ini + 'T12:00:00'), f = new Date(fim + 'T12:00:00');
    while (d <= f && out.length < 400) { out.push(chaveDia(d)); d.setDate(d.getDate() + 1); }
    return out;
  }
  // O que aconteceu em cada dia, só daquele dia: IPO do dia, pessoas que andaram (trilhasDias: relatorio_trilhas_dias),
  // setores trabalhados (registros, missões ou trilha passando dentro), diário, encontros, pontos e fotos.
  function separarDias(d, trilhasDias, dias) {
    var op = d.operacao;
    var I = moduloIpo();
    var inicioOp = chaveDia(op.acionado_em || op.criada_em);
    var porId = {};
    (d.participantes || []).forEach(function (p) { porId[p.id] = p; });
    var setores = d.setores || [];
    return dias.map(function (k) {
      var ini = new Date(k + 'T00:00:00').getTime();
      var fimD = new Date(k + 'T00:00:00'); fimD.setDate(fimD.getDate() + 1);
      var fim = fimD.getTime();
      function noDia(v) { var t = data(v); return Boolean(t) && t.getTime() >= ini && t.getTime() < fim; }
      var todosDoDia = (d.diario || []).filter(function (e) { return noDia(e.ocorrido_em); });
      var diario = registrosDiario({ diario: todosDoDia });
      var trilhas = (trilhasDias || []).filter(function (t) { return t.dia === k; });
      var pessoas = trilhas.map(function (t) {
        var p = porId[t.participante_id] || {};
        return { id: t.participante_id, nome: t.nome || p.nome || '—', tipo: t.tipo || p.tipo, grupos: (p.grupos || []).map(function (g) { return g.grupo; }),
          primeiro: t.primeiro, ultimo: t.ultimo, km: Number(t.km) || 0, n: t.n, pontos: t.pontos || [] };
      });
      // quem entrou na operação no dia e não mandou posição também esteve no dia
      (d.participantes || []).forEach(function (p) {
        if (noDia(p.entrou_em) && !pessoas.some(function (x) { return x.id === p.id; })) {
          pessoas.push({ id: p.id, nome: p.nome, tipo: p.tipo, grupos: (p.grupos || []).map(function (g) { return g.grupo; }), primeiro: p.entrou_em, ultimo: null, km: 0, n: 0, pontos: [], semPosicao: true });
        }
      });
      pessoas.sort(function (a, b) { return String(a.nome).localeCompare(String(b.nome), 'pt-BR'); });
      var setoresDia = [];
      setores.forEach(function (s) {
        var eventos = todosDoDia.filter(function (e) { return e.ref_id && String(e.ref_id) === String(s.id); });
        var missoes = (s.missoes || []).filter(function (m) {
          return [m.enviada_em, m.iniciada_em, m.chegou_setor_em, m.busca_finalizada_em, m.chegou_base_em].some(noDia);
        });
        var dentroP = pessoas.filter(function (p) { return p.pontos.some(function (q) { return dentroSetor(s, q[0], q[1]); }); });
        var dentro = dentroP.map(function (p) { return p.nome; });
        if (!eventos.length && !missoes.length && !dentro.length) return;
        dentroP.forEach(function (p) { (p.setoresNomes = p.setoresNomes || []).push(s.nome); });
        var ini = eventos.filter(function (e) { return e.tipo === 'setor_iniciado'; })[0], fimE = eventos.filter(function (e) { return e.tipo === 'setor_concluido'; }).slice(-1)[0];
        setoresDia.push({ setor: s, eventos: eventos, grupos: missoes.map(function (m) { return m.grupo; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; }), pessoas: dentro,
          missoes: missoes, inicioEm: ini ? ini.ocorrido_em : null, fimEm: fimE ? fimE.ocorrido_em : null,
          concluido: eventos.some(function (e) { return e.tipo === 'setor_concluido'; }) });
      });
      return {
        dia: k,
        numero: inicioOp ? Math.floor((new Date(k + 'T12:00:00') - new Date(inicioOp + 'T12:00:00')) / 86400000) + 1 : null,
        ipo: I ? I.ipoDoDia(op.ipo, k, d.diario || []) : null,
        pessoas: pessoas,
        // trilhas de verdade: quem tem linha desenhada no dia (os pontos só dentro da base ou apagados com a borracha não contam)
        trilhas: pessoas.filter(function (p) { return p.pontos.length > 1; }),
        km: pessoas.filter(function (p) { return p.pontos.length > 1; }).reduce(function (a, p) { return a + p.km; }, 0),
        setores: setoresDia,
        diario: diario,
        encontros: diario.filter(function (e) { return e.categoria === 'encontro'; }),
        pontos: (d.pontos || []).filter(function (p) { return noDia(p.criado_em); }),
        fotos: (d.fotos || []).filter(function (f) { return noDia(f.capturada_em); }),
      };
    });
  }
  function kmTexto(km) { return km < 0.05 ? '0 km' : km.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' km'; }
  function blocoIpoDia(dia) {
    var x = dia.ipo, out = [];
    if (!x || x.vazio) return [nota('IPO do dia não preenchido (IPO · Diário → IPO do dia).')];
    var linhas = [];
    var feito = [x.texto, x.textoDiario].filter(Boolean).join('\n');
    if (feito) linhas.push(['O que foi feito', feito]);
    if (x.qtd != null || x.nomes) linhas.push(['Efetivo (BMs)', (x.qtd != null ? dd(x.qtd) + ' BBMM' : '') + (x.nomes ? (x.qtd != null ? ' - ' : '') + x.nomes : '')]);
    var procs = x.procedimentos.map(nomeProcedimento).concat(x.procedimentos_outros ? [x.procedimentos_outros] : []);
    if (procs.length) linhas.push(['Procedimentos de busca', procs.join('; ')]);
    var rec = [x.recursos, x.recursosDiario].filter(Boolean).join('\n');
    if (rec) linhas.push(['Recursos CB empregados', rec]);
    if (x.orgaos) linhas.push(['Órgãos de apoio', x.orgaos]);
    if (x.situacao) linhas.push(['Situação ao fim do dia / próximos passos', x.situacao]);
    out.push(ficha(linhas));
    if (x.por) out.push(nota('IPO do dia preenchido por ' + x.por + (x.em ? ' em ' + dataHora(x.em) : '') + '.'));
    return out;
  }
  // p = { dias: separarDias(...), subtitulo, titulo, marca }. recursos.mapasDia[dia] = imagem do mapa daquele dia.
  function montarDiarioDias(d, recursos, p) {
    recursos = recursos || {};
    var op = d.operacao;
    var I = moduloIpo();
    var dias = p.dias || [];
    ANO_REF = dias.length ? new Date(dias[0].dia + 'T12:00:00').getFullYear() : null;
    var conteudo = [];
    if (recursos.logo) conteudo.push({ image: recursos.logo, width: 150, margin: [0, 0, 0, 14] });
    conteudo.push({ text: 'RELATÓRIO DIÁRIO DA OPERAÇÃO', style: 'sobretitulo', margin: [0, 0, 0, 6] });
    conteudo.push({ canvas: [{ type: 'rect', x: 0, y: 0, w: 48, h: 3, color: COR.acento }], margin: [0, 0, 0, 10] });
    conteudo.push({ text: op.codigo, style: 'tituloCapa', fontSize: 20 });
    conteudo.push({ text: p.subtitulo, style: 'subtituloCapa', margin: [0, 4, 0, 12] });
    var kmTotal = dias.reduce(function (a, x) { return a + x.km; }, 0);
    var nomes = {};
    dias.forEach(function (x) { x.trilhas.forEach(function (q) { nomes[q.id] = true; }); });
    conteudo.push(ficha([
      ['Acionamento', dataHora(op.acionado_em)],
      ['Situação', op.status === 'encerrada' ? 'Encerrada em ' + dataHora(op.encerrada_em) : 'Em andamento'],
      ['Período', dias.length === 1 ? diaExtenso(dias[0].dia + 'T12:00:00') : dias.length ? diaExtenso(dias[0].dia + 'T12:00:00') + ' a ' + diaExtenso(dias[dias.length - 1].dia + 'T12:00:00') : '—'],
      ['Dias no relatório', String(dias.length)],
      ['Gerado', dataHora(d.gerado_em) + ' por ' + txt(d.gerado_por_nome)],
    ]));
    // resumo: uma linha por dia
    conteudo.push(subtitulo('Resumo por dia'));
    conteudo.push(tabela(['Dia', 'Data', 'Pessoas', 'Km', 'Setores', 'O que foi feito'], dias.map(function (x) {
      var feito = x.ipo && !x.ipo.vazio ? [x.ipo.texto, x.ipo.textoDiario].filter(Boolean).join(' ') : '';
      return [{ text: x.numero ? x.numero + 'º' : '—', style: 'td', bold: true }, { text: x.dia.split('-').reverse().join('/'), style: 'tdMono' }, String(x.trilhas.length), kmTexto(x.km),
        String(x.setores.length), { text: feito ? (feito.length > 160 ? feito.slice(0, 157) + '…' : feito) : 'IPO do dia não preenchido', style: feito ? 'td' : 'tdNota' }];
    }), [30, 58, 42, 44, 42, '*']));
    conteudo.push(nota('No período: ' + Object.keys(nomes).length + ' pessoa(s) diferentes com posição, ' + kmTexto(kmTotal) + ' percorridos (sem os trechos dentro da base e os apagados do mapa).'));
    // dados gerais da ocorrência (o que vale para a operação inteira)
    if (I) {
      conteudo.push({ text: 'Dados da ocorrência', style: 'h1', pageBreak: 'before', margin: [0, 0, 0, 4] });
      conteudo.push({ text: 'ATENÇÃO: uso exclusivo nos grupos do CBMPR.', style: 'nota', margin: [0, 0, 0, 10] });
      var lista = I.itens(op, { vitimas: d.vitimas || [], geral: true, coordenada: function (lat, lng) { return coord(lat, lng); } });
      var atual = [];
      lista.forEach(function (x) {
        if (x.cabecalho) { if (atual.length) { conteudo.push(ficha(atual)); atual = []; } conteudo.push({ text: x.cabecalho, bold: true, fontSize: 10, margin: [0, 0, 0, 2] }); return; }
        if (x.valor != null) { atual.push([x.rotulo, x.valor]); return; }
        if (x.marcas) { atual.push([x.rotulo, x.marcas.filter(function (m) { return m[1]; }).map(function (m) { return m[0]; }).join('; ') || 'não informado']); return; }
        if (x.linhas) atual.push([x.rotulo, x.linhas.join('\n')]);
      });
      if (atual.length) conteudo.push(ficha(atual));
    }
    // cada dia
    dias.forEach(function (x) {
      conteudo.push({ text: (x.numero ? x.numero + 'º dia da operação' : 'Dia') + '  ·  ' + diaExtenso(x.dia + 'T12:00:00'), style: 'h1', pageBreak: 'before', margin: [0, 0, 0, 8] });
      conteudo.push({
        table: { widths: ['*', '*', '*', '*', '*'], body: [[
          [String(x.trilhas.length), 'pessoas com trilha'], [kmTexto(x.km), 'percorridos'], [String(x.setores.length), 'setores marcados'],
          [String(x.setores.filter(function (s) { return s.concluido; }).length), 'setores concluídos'], [String(x.encontros.length), 'encontros e relatos'],
        ].map(function (n) { return { stack: [{ text: n[0], style: 'numero' }, { text: n[1], style: 'numeroRotulo' }], fillColor: COR.fundo, margin: [8, 7, 4, 7] }; })] },
        layout: { hLineWidth: function () { return 0; }, vLineWidth: function (i) { return i > 0 && i < 5 ? 3 : 0; }, vLineColor: function () { return '#ffffff'; },
          paddingLeft: function () { return 0; }, paddingRight: function () { return 0; }, paddingTop: function () { return 0; }, paddingBottom: function () { return 0; } },
        margin: [0, 0, 0, 12],
      });
      conteudo.push(subtitulo('IPO do dia'));
      conteudo = conteudo.concat(blocoIpoDia(x));
      var mapa = recursos.mapasDia && recursos.mapasDia[x.dia];
      if (mapa) {
        conteudo.push(subtitulo('Mapa do dia (setores, trilhas e pontos do dia)'));
        conteudo.push({ image: mapa, width: 515, margin: [0, 0, 0, 4] });
        conteudo.push(legendaMapa());
      }
      // trilhas do dia, pessoa por pessoa (só quem tem trilha; sem trilha, a seção nem aparece)
      if (x.trilhas.length) {
        conteudo.push(subtitulo('Trilhas do dia, por pessoa'));
        conteudo.push(tabela(['Pessoa', 'Tipo / grupo', 'Início', 'Fim', 'Tempo', 'Km', 'Setores com a trilha'], x.trilhas.map(function (q) {
          return [{ text: q.nome, style: 'td', bold: true }, { stack: [{ text: TIPO_PESSOA[q.tipo] || txt(q.tipo), style: 'td' }, q.grupos.length ? { text: q.grupos.join(', '), style: 'tdSuave' } : null].filter(Boolean) },
            { text: hora(q.primeiro), style: 'tdMono' }, { text: hora(q.ultimo), style: 'tdMono' }, duracao(q.primeiro, q.ultimo), kmTexto(q.km), { text: txt((q.setoresNomes || []).join(', '), '—'), style: 'tdSuave' }];
        }), ['*', 74, 34, 34, 46, 40, 90]));
        conteudo.push(nota('Quilômetros pelo GPS, sem os trechos dentro da base nem os apagados do mapa. Tempo = do primeiro ao último ponto do dia.'));
        x.trilhas.forEach(function (q) {
          var mt = recursos.mapasTrilhaDia && recursos.mapasTrilhaDia[x.dia + '|' + q.id];
          if (mt) conteudo.push({ stack: [{ text: 'Trilha de ' + q.nome + '  ·  ' + hora(q.primeiro) + ' às ' + hora(q.ultimo) + '  ·  ' + kmTexto(q.km), style: 'dia', headlineLevel: 2 }, { image: mt, width: 400, margin: [0, 2, 0, 8] }], unbreakable: true });
        });
      }
      // setores marcados no dia (onde foram marcados; o que foi varrido é visto pelas trilhas). Sem setor, a seção nem aparece.
      if (x.setores.length) {
        conteudo.push(subtitulo('Setores marcados no dia'));
        conteudo.push(tabela(['Setor', 'Situação', 'Início', 'Conclusão', 'Área', 'Equipes'], x.setores.map(function (z) {
          return [{ text: z.setor.nome, style: 'td', bold: true }, z.concluido ? 'Concluído no dia' : (STATUS_SETOR[z.setor.status] || txt(z.setor.status)),
            { text: z.inicioEm ? hora(z.inicioEm) : '—', style: 'tdMono' }, { text: z.fimEm ? hora(z.fimEm) : '—', style: 'tdMono' }, textoArea(areaSetor(z.setor)), { text: txt(z.grupos.join(', '), '—'), style: 'tdSuave' }];
        }), ['*', 80, 38, 48, 56, 90]));
        x.setores.forEach(function (z) {
          var corpo = [{ text: z.setor.nome + '  ·  ' + (z.concluido ? 'concluído no dia' : (STATUS_SETOR[z.setor.status] || '')), style: 'dia', headlineLevel: 2 }];
          var linhas = [
            ['Área', textoArea(areaSetor(z.setor))],
            ['Responsável', txt(z.setor.responsavel_nome, '')],
            z.grupos.length ? ['Equipes no dia', z.grupos.join(', ')] : null,
            z.pessoas.length ? ['Trilhas dentro do setor', z.pessoas.join(', ')] : null,
            z.setor.observacoes && String(z.setor.observacoes).trim() ? ['Observações do setor', z.setor.observacoes] : null,
          ].filter(function (l) { return l && l[1] !== ''; });
          var cronologia = z.eventos.map(function (e) { return hora(e.ocorrido_em) + '  ' + e.titulo + (vazio(e.detalhe) ? '' : ' — ' + e.detalhe); });
          corpo.push(ficha(linhas));
          if (cronologia.length) corpo.push({ ul: cronologia, style: 'tdSuave', margin: [0, 0, 0, 4] });
          conteudo.push({ stack: corpo, margin: [0, 0, 0, 6] });
        });
      }
      if (x.encontros.length) {
        conteudo.push(subtitulo('Encontros e relatos do dia'));
        conteudo.push(tabela(['Hora', 'Registro', 'Local', 'Por'], x.encontros.map(function (e) {
          return [hora(e.ocorrido_em), { stack: [{ text: e.titulo, style: 'td', bold: true }, vazio(e.detalhe) ? null : { text: e.detalhe, style: 'tdSuave' }].filter(Boolean) },
            { text: coord(e.lat, e.lng), style: 'tdMono' }, txt(e.autor_nome)];
        }), [36, '*', 92, 80]));
      }
      conteudo.push(subtitulo('Diário do dia'));
      if (!x.diario.length) conteudo.push(nota('Nenhum registro no diário neste dia.'));
      else conteudo.push(tabela(['Hora', 'Tipo', 'Registro', 'Por'], x.diario.map(function (e) {
        var obs = e.origem === 'manual';
        return [{ text: hora(e.ocorrido_em), style: 'tdMono', bold: true }, { text: CATEGORIA[e.categoria] || e.categoria, style: 'tdSuave' },
          { stack: [{ text: obs ? 'Observação' : e.titulo, style: 'td', bold: obs }, vazio(e.detalhe) ? null : { text: e.detalhe, style: obs ? 'td' : 'tdSuave' }].filter(Boolean) }, { text: txt(e.autor_nome), style: 'tdSuave' }];
      }), [36, 64, '*', 80], { preenchimento: function (i) {
        if (i === 0) return null;
        var e = x.diario[i - 1];
        return e.nivel === 'critico' ? COR.critico : e.origem === 'manual' ? COR.observacao : null;
      } }));
      if (x.pontos.length) {
        conteudo.push(subtitulo('Pontos marcados no dia'));
        conteudo.push(tabela(['Hora', 'Tipo', 'Título', 'Coordenadas'], x.pontos.map(function (q) {
          return [hora(q.criado_em), q.tipo_nome || PONTO[q.categoria] || q.categoria, { text: q.titulo, style: 'td', bold: true }, { text: coord(q.lat, q.lng), style: 'tdMono' }];
        }), [36, 100, '*', 92]));
      }
      if (x.fotos.length) conteudo.push(nota(x.fotos.length + ' foto(s) registrada(s) neste dia (estão no relatório final detalhado).'));
    });
    return documento(d, recursos, conteudo, { titulo: p.titulo, assunto: 'Relatório diário de operação de busca e salvamento', marca: p.marca });
  }

  // Graduação e QRA a partir do nome digitado no app ("Cb. Souza", "1º Sgt Alves", "Sd. QPM 1-0 Fulano"): a graduação
  // reconhecida no começo e o resto como QRA. Sem graduação: "—" e o texto todo.
  function graduacaoQra(nome) {
    var t = String(nome || '').replace(/\s+/g, ' ').trim();
    var m = /^((?:[123][ºo°]\s*)?(?:Sd|Cb|Sgt|Subten|ST|Asp|Al|Cad|Ten|Cap|Maj|TC|Cel)\.?)(?:\s+(.*))?$/i.exec(t);
    var qra = (m ? (m[2] || '') : t).replace(/^QPM\s*\d+-\d+\s*/i, '').trim();
    return { grad: m ? m[1] : '—', qra: qra || t };
  }

  // Relatório IPO (curto): o IPO de cada dia no modelo do CBMPR e, embaixo, o resumo do dia: militares (graduação e QRA),
  // setores varridos, trilhas feitas (números e mapa) e pontos de interesse. p = { dias: separarDias(...), subtitulo, titulo, marca }.
  // recursos.mapasDia[dia] = mapa do dia (só quando o período é curto).
  function montarIpo(d, recursos, p) {
    recursos = recursos || {};
    var op = d.operacao;
    var I = moduloIpo();
    var dias = p.dias || [];
    ANO_REF = dias.length ? new Date(dias[0].dia + 'T12:00:00').getFullYear() : null;
    var i = I ? I.normalizarIpo(op.ipo || {}) : { destinatarios: '' };
    var conteudo = [];
    if (recursos.logo) conteudo.push({ image: recursos.logo, width: 120, margin: [0, 0, 0, 8] });
    conteudo.push({ text: 'IPO: ' + (i.destinatarios || ''), style: 'h2', margin: [0, 0, 0, 2] });
    conteudo.push({ text: 'Informe Padrão de Ocorrência - IPO', style: 'h1', margin: [0, 0, 0, 2] });
    conteudo.push({ text: 'ATENÇÃO: uso exclusivo nos grupos do CBMPR.  ·  ' + p.subtitulo, style: 'nota', margin: [0, 0, 0, 10] });
    dias.forEach(function (x, k) {
      var mil = x.pessoas.filter(function (q) { return q.tipo === 'militar'; });
      var civis = x.trilhas.filter(function (q) { return q.tipo === 'civil'; }).length;
      var topo = { text: 'IPO do dia ' + x.dia.split('-').reverse().join('/') + (x.numero ? '  ·  ' + x.numero + 'º dia' : ''), style: 'h2', margin: [0, k ? 0 : 4, 0, 6] };
      if (k) topo.pageBreak = 'before';
      conteudo.push(topo);
      // o informe do dia, no modelo (cabeçalho, local, vítima, procedimentos, recursos, efetivo, desdobramentos, órgãos)
      conteudo = conteudo.concat(I ? blocoIpo(d, x.dia, p.acumulado) : []);
      // mapa do dia (padrão em todo relatório): tudo o que foi feito naquele dia (trilhas, pontos e setores marcados); sem nada, sem mapa
      var mapaDia = recursos.mapasDia && recursos.mapasDia[x.dia];
      if (mapaDia) {
        conteudo.push(subtitulo('Mapa do dia'));
        conteudo.push({ image: mapaDia, fit: [515, 330], margin: [0, 2, 0, 2] });
        conteudo.push(legendaMapa());
        if (x.setores.length) conteudo.push(nota('Setores marcados no mapa: ' + x.setores.map(function (z) { return z.setor.nome; }).join(', ') + '.'));
      }
      // militares: só graduação e QRA
      conteudo.push(subtitulo('Militares do dia'));
      if (mil.length) {
        var nomes = mil.map(function (q) { return graduacaoQra(q.nome); });
        conteudo.push(tabela(['Graduação', 'QRA'], nomes.map(function (n) { return [{ text: n.grad, style: 'td' }, { text: n.qra, style: 'td', bold: true }]; }), [90, '*']));
      } else conteudo.push(nota('Nenhum militar com posição registrada pelo app neste dia.'));
      if (civis) conteudo.push(nota('Voluntários e civis em campo: ' + civis + '.'));
      // trilhas feitas: só aparece se alguém fez trilha no dia (linha desenhada); os mapas por trilha só se foram pedidos
      if (x.trilhas.length) {
        conteudo.push(subtitulo('Trilhas feitas'));
        conteudo.push(ficha([['Pessoas com trilha', String(x.trilhas.length)], ['Percorrido', kmTexto(x.km)]]));
        x.trilhas.forEach(function (q) {
          var mt = recursos.mapasTrilhaDia && recursos.mapasTrilhaDia[x.dia + '|' + q.id];
          if (mt) conteudo.push({ stack: [{ text: 'Trilha de ' + q.nome + '  ·  ' + kmTexto(q.km), style: 'dia', headlineLevel: 2 }, { image: mt, width: 380, margin: [0, 2, 0, 8] }], unbreakable: true });
        });
      }
      // pontos de interesse do dia
      if (x.pontos.length) {
        conteudo.push(subtitulo('Pontos de interesse do dia'));
        var linhas = x.pontos.slice(0, 12).map(function (q) { return [hora(q.criado_em), q.tipo_nome || PONTO[q.categoria] || q.categoria, { text: q.titulo, style: 'td', bold: true }]; });
        conteudo.push(tabela(['Hora', 'Tipo', 'Ponto'], linhas, [36, 110, '*']));
        if (x.pontos.length > 12) conteudo.push(nota('+ ' + (x.pontos.length - 12) + ' outro(s) ponto(s) neste dia.'));
      }
    });
    return documento(d, recursos, conteudo, { titulo: p.titulo, assunto: 'Informe Padrão de Ocorrência (IPO)', marca: p.marca });
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

  var api = { montarDiarioDias: montarDiarioDias, montarIpo: montarIpo, graduacaoQra: graduacaoQra, separarDias: separarDias, diasEntre: diasEntre, montarComandoGeral: montarComandoGeral, montarResumido: montarResumido, montarDocumento: montarDocumento, montarDiario: montarDiario, montarComando: montarComando, montarPassagem: montarPassagem, montarImprensa: montarImprensa, distribuirFotos: distribuirFotos, dentroSetor: dentroSetor, areaSetor: areaSetor, RESULTADO: RESULTADO };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.RelatorioPDF = api;
})(typeof window !== 'undefined' ? window : this);
