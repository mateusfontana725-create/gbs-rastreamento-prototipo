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

  var TIPO_OPERACAO = { aquatica: 'Aquática', terrestre: 'Terrestre', aerea: 'Aérea', outras: 'Outras' };
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
  function tipoOperacao(op) {
    if (!op.tipo) return '—';
    return op.tipo === 'outras' ? 'Outras' + (op.tipo_outro ? ' (' + op.tipo_outro + ')' : '') : TIPO_OPERACAO[op.tipo] || op.tipo;
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
      [String(d.diario.length), 'registros no diário'],
      [String(d.fotos.length), 'fotos'],
    ];
    return [
      { text: 'RELATÓRIO FINAL DE OPERAÇÃO', style: 'sobretitulo', margin: [0, 30, 0, 6] },
      { canvas: [{ type: 'rect', x: 0, y: 0, w: 48, h: 3, color: COR.acento }], margin: [0, 0, 0, 14] },
      { text: op.codigo, style: 'tituloCapa' },
      { text: [tipoOperacao(op), vazio(op.local_endereco) ? '' : '  ·  ' + op.local_endereco].join(''), style: 'subtituloCapa', margin: [0, 6, 0, 22] },
      caixaResultado(op),
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
    ].filter(Boolean);
  }

  function bloco(rotulo, valor) {
    return { stack: [{ text: rotulo.toUpperCase(), style: 'rotuloCaixa' }, { text: valor, fontSize: 11, margin: [0, 2, 0, 0] }] };
  }

  function secaoCadastro(d, recursos) {
    var op = d.operacao;
    var out = [secao(1, 'Dados do cadastro', true)];
    out.push(ficha([
      ['Código da operação', op.codigo],
      ['Tipo', tipoOperacao(op)],
      ['Data e hora do acionamento', dataHora(op.acionado_em)],
      ['Local', txt(op.local_endereco)],
      ['Coordenadas do local', coord(op.local_lat, op.local_lng)],
      ['Criada no sistema', dataHora(op.criada_em) + (op.criador_nome ? ' por ' + op.criador_nome : '')],
      ['Encerrada', op.encerrada_em ? dataHora(op.encerrada_em) : 'Operação ainda ativa'],
      ['Retenção dos dados', op.retencao_horas ? op.retencao_horas + ' h após o encerramento' : 'Apagados no encerramento'],
    ]));
    if (!vazio(op.descricao)) {
      out.push(subtitulo('Descrição da ocorrência'));
      out.push({ text: op.descricao, style: 'corpo', margin: [0, 0, 0, 12] });
    }
    out.push(subtitulo('Vítima(s)'));
    if (!d.vitimas.length) out.push(nota('Nenhuma ficha de vítima cadastrada.'));
    d.vitimas.forEach(function (v) {
      var dados = ficha([
        ['Nome', v.nome],
        ['Idade', v.idade != null ? v.idade + ' anos' : '—'],
        vazio(v.caracteristicas) ? null : ['Características físicas', v.caracteristicas],
        vazio(v.roupas) ? null : ['Roupas', v.roupas],
        vazio(v.observacoes) ? null : ['Observações', v.observacoes],
      ]);
      var foto = recursos.fotosVitimas && recursos.fotosVitimas[v.id];
      out.push(foto
        ? { columns: [{ image: foto, fit: [110, 140], width: 120 }, Object.assign({ width: '*' }, dados)], columnGap: 10, margin: [0, 0, 0, 10], unbreakable: true }
        : dados);
    });
    return out;
  }

  function nomesGrupos(p) { return (p.grupos || []).map(function (g) { return g.grupo + (g.papel === 'responsavel' ? ' (resp.)' : ''); }).join(', '); }

  function situacao(p) {
    if (p.removido) return 'Removido' + (p.removido_em ? ' ' + dataHoraCurta(p.removido_em) : '');
    if (p.liberado_em) return 'Saída ' + dataHoraCurta(p.liberado_em);
    return 'Até o encerramento';
  }

  function secaoPessoas(d) {
    var out = [secao(2, 'Pessoas e grupos', true)];
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
    var out = [secao(3, 'Setores varridos', true)];
    if (!d.setores.length) {
      out.push(nota('Nenhum setor de busca foi definido nesta operação.'));
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
      'Trilhas: ', linha('#dc2626'), 'militar    ', linha('#16a34a', true), 'civil    ', linha('#0891b2', true), 'responsável',
      '        Marcadores: ★ local da operação · ! relato de campo · + vítima · B base · U última localização',
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
    var out = [secao(4, 'Pontos de interesse e encontros', true)];
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
      return [dataHoraCurta(p.criado_em), PONTO[p.categoria] || p.categoria,
        { stack: [{ text: p.titulo, style: 'td', bold: true }, vazio(p.descricao) ? null : { text: p.descricao, style: 'tdSuave' }].filter(Boolean) },
        { text: coord(p.lat, p.lng), style: 'tdMono' }, p.criado_por_nome];
    }), [56, 72, '*', 92, 70]));
    return out;
  }

  function secaoDiario(d) {
    var out = [secao(5, 'Diário consolidado', true)];
    out.push({ text: 'Registro cronológico de tudo o que aconteceu na operação. Os eventos automáticos são gravados pelo sistema e não podem ser alterados; as observações foram escritas pelos responsáveis (as edições ficam registradas).', style: 'corpo', margin: [0, 0, 0, 10] });
    if (!d.diario.length) {
      out.push(nota('Nenhum registro no diário.'));
      return out;
    }
    var dias = [];
    d.diario.forEach(function (e) {
      var k = chaveDia(e.ocorrido_em);
      if (!dias.length || dias[dias.length - 1].k !== k) dias.push({ k: k, t: e.ocorrido_em, itens: [] });
      dias[dias.length - 1].itens.push(e);
    });
    dias.forEach(function (dia) {
      out.push({ text: diaExtenso(dia.t) + '  ·  ' + dia.itens.length + ' registro(s)', style: 'dia', headlineLevel: 1 });
      out.push(tabela(['Hora', 'Categoria', 'Registro', 'Por'], dia.itens.map(function (e) {
        var obs = e.origem === 'manual';
        var corpo = [{ text: obs ? 'Observação' : e.titulo, style: 'td', bold: true }];
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

  function secaoResultado(d) {
    var op = d.operacao;
    var out = [secao(6, 'Resultado', true), caixaResultado(op)];
    var anteriores = d.relatorios_anteriores || [];
    out.push(ficha([
      ['Encerramento', op.encerrada_em ? dataHora(op.encerrada_em) : 'Operação ainda ativa no momento deste relatório'],
      ['Duração total', duracao(op.acionado_em || op.criada_em, op.encerrada_em || d.gerado_em)],
      ['Relatório gerado', dataHora(d.gerado_em) + ' por ' + txt(d.gerado_por_nome)],
      ['Versões anteriores', anteriores.length ? anteriores.map(function (r) { return dataHora(r.gerado_em) + ' (' + r.gerado_por_nome + ')'; }).join('; ') : 'Nenhuma'],
    ]));
    out.push({ text: 'Assinaturas', style: 'h2', margin: [0, 26, 0, 30] });
    out.push({ columns: [assinatura('Responsável pela operação'), assinatura('Comandante / superior imediato')], columnGap: 40 });
    return out;
  }

  function assinatura(rotulo) {
    return { stack: [
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 230, y2: 0, lineWidth: 0.6, lineColor: '#6b7280' }] },
      { text: rotulo, fontSize: 9, bold: true, margin: [0, 4, 0, 0] },
      { text: 'Nome, posto/graduação e matrícula', style: 'nota' },
      { text: 'Data: ____/____/________', style: 'nota', margin: [0, 6, 0, 0] },
    ] };
  }

  /* ---------- documento ------------------------------------------------- */
  function montarDocumento(d, recursos) {
    recursos = recursos || {};
    recursos.fotos = recursos.fotos || {};
    var op = d.operacao;
    var ref = data(op.acionado_em || op.criada_em);
    ANO_REF = ref ? ref.getFullYear() : null;
    var conteudo = []
      .concat(capa(d, recursos))
      .concat(secaoCadastro(d, recursos))
      .concat(secaoPessoas(d))
      .concat(secaoSetores(d, recursos))
      .concat(secaoPontos(d))
      .concat(secaoDiario(d))
      .concat(secaoResultado(d));

    return {
      pageSize: 'A4',
      pageMargins: [40, 58, 40, 52],
      info: {
        title: 'Relatório final — ' + op.codigo,
        author: d.gerado_por_nome || '',
        subject: 'Relatório final de operação de busca e salvamento',
        creator: 'Rastreamento GBS',
      },
      header: function (pagina) {
        if (pagina === 1) return null;
        return {
          margin: [40, 22, 40, 0],
          stack: [
            { columns: [
              { text: op.codigo, fontSize: 8, bold: true, color: COR.texto },
              { text: 'RELATÓRIO FINAL  ·  DOCUMENTO RESTRITO', fontSize: 7.5, color: COR.acento, bold: true, alignment: 'right', characterSpacing: 0.6 },
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

  var api = { montarDocumento: montarDocumento, distribuirFotos: distribuirFotos, dentroSetor: dentroSetor, areaSetor: areaSetor, RESULTADO: RESULTADO };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.RelatorioPDF = api;
})(typeof window !== 'undefined' ? window : this);
