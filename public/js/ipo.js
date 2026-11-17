/* =====================================================================
 * ipo.js — Informe Padrão de Ocorrência (IPO) do CBMPR: listas de opções e limpeza dos
 * dados antes de salvar. Os campos ficam no próprio cadastro da operação (cadastro.js),
 * que é o mesmo formulário do IPO. Procedimentos, recursos e desdobramentos vão para o diário.
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var DESTINO_PADRAO = '2 CRBM / 3 BBM';
  var MEIOS = [['mar', 'Mar'], ['rio', 'Rio'], ['lago', 'Lago/represa/tanque'], ['cachoeira', 'Cachoeira']];
  var BUSCAS = [['sim', 'Sim'], ['nao', 'Não'], ['ainda_nao', 'Ainda não foi possível'], ['sem_necessidade', 'Sem necessidade (vítimas certamente perdidas)']];
  // De onde vem a hora do último momento visto: ausente não é "agora" nem zero
  var QUALIDADE_HORA = [['informado', 'Informado (testemunha, câmera, registro)'], ['estimado', 'Estimado'], ['desconhecido', 'Desconhecido']];
  var VIDA = [['sim', 'Sim'], ['nao_corpo', 'Não'], ['desconhecido', 'Não sabido']];
  // Procedimentos de busca do IPO (as chaves antigas continuam valendo: entram nos registros do diário já gravados)
  var PROCEDIMENTOS = [
    ['margens', 'Busca terrestre nas margens/areia'], ['dentro_agua', 'Buscas por dentro do rio/água'], ['superficie', 'Busca de superfície com embarcações'],
    ['scuba', 'Mergulho com equipamento SCUBA'], ['livre', 'Mergulho livre'], ['rede', 'Rede de busca/garatéia'],
    ['terrestre', 'Varredura terrestre (pente-fino)'], ['k9', 'Buscas com emprego de K9'], ['drone', 'Buscas aéreas com drone'],
    ['aeronave', 'Busca com aeronave (helicóptero/avião)'], ['maquinario', 'Emprego de maquinário'],
  ];
  // Natureza da ocorrência: busca aquática, terrestre, SARP ou BREC; "Outro" abre um campo para descrever.
  // (Operações antigas com outra natureza continuam com o texto gravado, como "Outro".)
  // Para acrescentar um tipo novo: incluir aqui, em tipoDaNatureza, no banco (operacoes_tipo_check e
  // aplicar_cadastro_operacao) e nos rótulos de cadastro.js, dashboard.js, sci-modo.js e relatorio-pdf.js.
  var NATUREZAS = ['BUSCA AQUÁTICA – PESSOA', 'BUSCA TERRESTRE – PESSOA', 'BUSCA TERRESTRE/AQUÁTICA – PESSOA', 'SARP – AERONAVE REMOTAMENTE PILOTADA',
    'BREC – BUSCA E RESGATE EM ESTRUTURAS COLAPSADAS'];
  // natureza da lista → tipo da operação (terrestre e aquática juntas contam como aquática: tem meio líquido)
  var TIPO_NATUREZA = ['aquatica', 'terrestre', 'aquatica', 'sarp', 'brec'];
  var OUTRA_NATUREZA = '__outra__';
  // Perfis da vítima (estudos): valores fixos gravados no banco; o formulário só seleciona.
  var PERFIS_VITIMA = [['idoso', 'Idoso'], ['crianca', 'Criança'], ['adolescente', 'Adolescente'], ['demencia', 'Alzheimer / demência'],
    ['autismo', 'Autismo (TEA)'], ['deficiencia_intelectual', 'Deficiência intelectual'], ['transtorno_mental', 'Transtorno mental'], ['outro', 'Outro']];
  var MAX_TEXTO = 300, MAX_LONGO = 1000;

  // Natureza → tipo da operação (o tipo não é mais escolhido à parte: vem da natureza).
  // Só as da lista viram aquática, terrestre, SARP ou BREC; qualquer outra (o "Outro" descrito) é "outras".
  function semAcento(t) { return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase(); }
  function ehAquatica(natureza) { return semAcento(natureza).indexOf('AQUATIC') >= 0; }
  function tipoDaNatureza(natureza) {
    var limpo = String(natureza || '').replace(/\s+/g, ' ').trim();
    var t = semAcento(limpo);
    if (!limpo) return { tipo: null, tipo_outro: null };
    for (var k = 0; k < NATUREZAS.length; k++) if (t === semAcento(NATUREZAS[k])) return { tipo: TIPO_NATUREZA[k], tipo_outro: null };
    return { tipo: 'outras', tipo_outro: limpo.slice(0, 60) };
  }
  // Data e hora (campo datetime-local) → ISO; vazio ou inválido → ''
  function dataIso(v) {
    var t = String(v || '').trim();
    if (!t) return '';
    var d = new Date(t);
    return isNaN(d) ? '' : d.toISOString();
  }

  function opcao(lista, valor) { return lista.some(function (x) { return x[0] === valor; }) ? valor : ''; }
  function texto(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
  function inteiro(v, min, max) {
    var n = parseInt(v, 10);
    return isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  }

  // Com hora: informado (padrão) ou estimado. Sem hora: só "desconhecido" (apurado e ninguém sabe) ou vazio (não informado).
  function qualidadeHora(hora, q) {
    var tem = Boolean(dataIso(hora));
    q = opcao(QUALIDADE_HORA, q);
    if (!tem) return q === 'desconhecido' ? 'desconhecido' : '';
    return q === 'estimado' ? 'estimado' : 'informado';
  }
  function textoHoraVisto(ipo, fmt) {
    ipo = ipo || {};
    if (ipo.desaparecimento) return fmt(ipo.desaparecimento) + (ipo.desaparecimento_qualidade === 'estimado' ? ' (estimado)' : '');
    return ipo.desaparecimento_qualidade === 'desconhecido' ? 'Desconhecido' : '';
  }

  // Texto de várias linhas (desdobramentos, recursos, órgãos de apoio): mantém as quebras de linha, tira espaços
  // repetidos dentro de cada linha e no máximo uma linha em branco seguida.
  function textoLongo(v, max) {
    return String(v == null ? '' : v).replace(/\r\n?/g, '\n').split('\n').map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); })
      .join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
  }
  function diaValido(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
    if (!m) return '';
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 ? m[0] : '';
  }
  // Listas por dia (efetivo e desdobramentos): dia válido, sem linha vazia, em ordem de dia.
  function listaPorDia(lista, campos, max) {
    if (!Array.isArray(lista)) return [];
    return lista.map(function (x) {
      x = x || {};
      var dia = diaValido(x.dia);
      if (!dia) return null;
      var r = { dia: dia };
      var vazio = true;
      Object.keys(campos).forEach(function (k) {
        var c = campos[k];
        r[k] = c === 'qtd' ? inteiro(x[k], 0, 999) : textoLongo(x[k], c);
        if (r[k] != null && r[k] !== '') vazio = false;
      });
      return vazio ? null : r;
    }).filter(Boolean).sort(function (a, b) { return a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0; }).slice(0, max);
  }
  function procedimentosValidos(v) {
    var vistos = {};
    return (Array.isArray(v) ? v : []).filter(function (k) {
      if (vistos[k] || !PROCEDIMENTOS.some(function (p) { return p[0] === k; })) return false;
      vistos[k] = true;
      return true;
    });
  }
  function documentosValidos(v) {
    var r = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return r;
    Object.keys(v).slice(0, 50).forEach(function (k) {
      var t = texto(v[k], 40);
      if (/^[0-9a-f-]{36}$/i.test(k) && t) r[k.toLowerCase()] = t;
    });
    return r;
  }

  // Dados do formulário → objeto limpo, com tudo dentro dos limites que o banco aceita.
  // Campos do informe real (CBMPR): unidade e RGO no cabeçalho, localidade escrita, coordenada de referência, hora do
  // acionamento do CB, procedimentos marcados, recursos, efetivo e desdobramentos de cada dia e órgãos de apoio.
  function normalizarIpo(raw) {
    raw = raw || {};
    return {
      unidade: texto(raw.unidade, 120),
      rgo: texto(raw.rgo, 40),
      localidade: texto(raw.localidade, MAX_TEXTO),
      coord_referencia: texto(raw.coord_referencia, 120),
      acionamento_cb: dataIso(raw.acionamento_cb),
      procedimentos: procedimentosValidos(raw.procedimentos),
      procedimentos_outros: texto(raw.procedimentos_outros, MAX_TEXTO),
      recursos_cb: textoLongo(raw.recursos_cb, 4000),
      efetivo: listaPorDia(raw.efetivo, { qtd: 'qtd', nomes: 1000 }, 200),
      desdobramentos: listaPorDia(raw.desdobramentos, { texto: 4000 }, 200),
      orgaos_apoio: textoLongo(raw.orgaos_apoio, 4000),
      vitimas_docs: documentosValidos(raw.vitimas_docs),
      destinatarios: texto(raw.destinatarios, 120) || DESTINO_PADRAO,
      natureza: texto(raw.natureza, MAX_TEXTO),
      solicitante_nome: texto(raw.solicitante_nome, 120),
      solicitante_documento: texto(raw.solicitante_documento, 40),
      desaparecimento: dataIso(raw.desaparecimento),
      desaparecimento_qualidade: qualidadeHora(raw.desaparecimento, raw.desaparecimento_qualidade),
      meio_liquido: opcao(MEIOS, raw.meio_liquido),
      pessoas_perdidas: inteiro(raw.pessoas_perdidas, 0, 999),
      buscas_preliminares: opcao(BUSCAS, raw.buscas_preliminares),
      possibilidade_vida: opcao(VIDA, raw.possibilidade_vida),
      bms_envolvidos: inteiro(raw.bms_envolvidos, 0, 999),
      imagens_anexas: raw.imagens_anexas === true ? true : raw.imagens_anexas === false ? false : null,
      responsavel_informacoes: texto(raw.responsavel_informacoes, MAX_LONGO),
    };
  }

  /* ---------- O informe montado (texto do WhatsApp e relatório) ----------
   * itens(op, extra) devolve a lista, na ordem do IPO do CBMPR, de { rotulo, valor } (texto numa linha),
   * { rotulo, linhas } (lista embaixo) ou { rotulo, marcas: [[texto, marcado]] } (as opções "( X )").
   * extra: { vitimas (fichas), diario (registros procedimento/recurso/desdobramento), coordenada (fn lat,lng → texto) }.
   * Usado pelo texto para o WhatsApp e pela seção do IPO nos relatórios: os dois saem iguais. */
  var MESES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  function dd(n) { return (n < 10 ? '0' : '') + n; }
  function dataOk(v) { var d = v ? new Date(v) : null; return d && !isNaN(d) ? d : null; }
  function dataExtensa(v) {   // 02 nov. 26, 17h20min
    var d = dataOk(v);
    return d ? dd(d.getDate()) + ' ' + MESES_ABREV[d.getMonth()] + '. ' + String(d.getFullYear()).slice(2) + ', ' + dd(d.getHours()) + 'h' + dd(d.getMinutes()) + 'min' : '';
  }
  function dataCurta(v) {     // 02/11/26 às 17h20min
    var d = dataOk(v);
    return d ? dd(d.getDate()) + '/' + dd(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2) + ' às ' + dd(d.getHours()) + 'h' + dd(d.getMinutes()) + 'min' : '';
  }
  function diaBr(dia) { var p = String(dia).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : dia; }
  function diaDoRegistro(v) { var d = dataOk(v); return d ? d.getFullYear() + '-' + dd(d.getMonth() + 1) + '-' + dd(d.getDate()) : ''; }
  function dois(n) { return n == null ? '' : n < 10 ? '0' + n : String(n); }
  var SEXO = { M: 'Masculino', F: 'Feminino' };
  function rotuloDe(lista, chave) { var x = lista.filter(function (y) { return y[0] === chave; })[0]; return x ? x[1] : ''; }

  function itens(op, extra) {
    op = op || {};
    extra = extra || {};
    var i = normalizarIpo(op.ipo || {});
    var vit = (extra.vitimas || []).filter(function (v) { return v && v.nome; });
    var diario = extra.diario || [];
    var out = [];
    function add(rotulo, valor) { if (valor != null && valor !== '') out.push({ rotulo: rotulo, valor: valor }); }
    // cabeçalho
    if (i.unidade) out.push({ cabecalho: i.unidade });
    if (i.rgo) out.push({ cabecalho: 'RGO ' + i.rgo });
    if (i.natureza) out.push({ cabecalho: 'Natureza: ' + i.natureza });
    add('Localidade/Município/Região', i.localidade || op.local_endereco || '');
    add('Data/hora do início das operações', dataExtensa(op.acionado_em));
    if (i.meio_liquido && ehAquatica(i.natureza)) add('Tipo de meio líquido', '( X ) ' + rotuloDe(MEIOS, i.meio_liquido));
    var refCoord = i.coord_referencia;
    if (!refCoord) {
      var ulv = vit.filter(function (v) { return v.ulv_lat != null && v.ulv_lng != null; })[0];
      var lat = ulv ? ulv.ulv_lat : op.local_lat, lng = ulv ? ulv.ulv_lng : op.local_lng;
      if (lat != null && lng != null) refCoord = extra.coordenada ? extra.coordenada(lat, lng) : Number(lat).toFixed(6) + ', ' + Number(lng).toFixed(6);
    }
    add('Coord. Geo. de Referência (último avistamento)', refCoord || '');
    var nPerd = i.pessoas_perdidas != null ? i.pessoas_perdidas : (vit.length || null);
    add('Nº de pessoas perdidas', nPerd != null ? dois(nPerd) : '');
    if (vit.length) {
      var porSexo = {};
      vit.forEach(function (v) { var k = SEXO[v.sexo] || 'Sexo não informado'; (porSexo[k] = porSexo[k] || []).push(v.idade != null ? v.idade + ' anos' : 'idade não informada'); });
      add('Sexo/Idade da(s) vítima(s)', Object.keys(porSexo).map(function (k) { return dois(porSexo[k].length) + ' ' + k + ' / ' + porSexo[k].join(', '); }).join('; '));
      add('Nome da vítima', vit.map(function (v) { var doc = i.vitimas_docs[String(v.id || '').toLowerCase()]; return v.nome + (doc ? '/' + doc : ''); }).join('; '));
      add('Origem da(s) vítima(s)', vit.map(function (v) { return v.origem || ''; }).filter(Boolean).join('; '));
    }
    var desap = i.desaparecimento ? (i.desaparecimento_qualidade === 'estimado' ? 'estima-se que ' : '') + dataCurta(i.desaparecimento).replace(' às ', ', ') : i.desaparecimento_qualidade === 'desconhecido' ? 'desconhecido' : '';
    add('Data/Horário provável do desaparecimento', desap);
    add('Data/Horário do acionamento do CB', dataCurta(i.acionamento_cb || op.acionado_em));
    out.push({ rotulo: 'Buscas preliminares realizadas em casas de parentes, hospitais, etc.?', marcas: BUSCAS.map(function (b) { return [b[1], i.buscas_preliminares === b[0]]; }) });
    out.push({ rotulo: 'Possibilidade real de vida?', marcas: VIDA.map(function (b) { return [b[1], i.possibilidade_vida === b[0]]; }) });
    var proc = i.procedimentos.slice();
    diario.forEach(function (e) { if (e.tipo === 'procedimento' && e.ref_id && proc.indexOf(e.ref_id) === -1 && PROCEDIMENTOS.some(function (p) { return p[0] === e.ref_id; })) proc.push(e.ref_id); });
    var marcasProc = PROCEDIMENTOS.filter(function (p) { return proc.indexOf(p[0]) !== -1; }).map(function (p) { return [p[1], true]; });
    if (i.procedimentos_outros) marcasProc.push([i.procedimentos_outros, true]);
    if (marcasProc.length) out.push({ rotulo: 'Procedimentos de Busca sendo realizados', marcas: marcasProc, soMarcados: true });
    add('Contexto/histórico/cenário do desaparecimento', op.descricao || '');
    var rec = i.recursos_cb ? i.recursos_cb.split('\n').filter(function (l) { return l.trim(); }).map(function (l) { return /^[-•]/.test(l) ? l : '- ' + l; }) : [];
    diario.forEach(function (e) { if (e.tipo === 'recurso' && e.detalhe) rec.push('- ' + e.detalhe); });
    if (rec.length) out.push({ rotulo: 'Recursos CB deslocados e sendo utilizados', linhas: rec });
    if (i.efetivo.length) {
      out.push({ rotulo: 'Quantidade de BMs diretamente envolvidos na resposta', linhas: i.efetivo.map(function (x) {
        return diaBr(x.dia) + ': ' + (x.qtd != null ? dois(x.qtd) + ' BBMM' : '') + (x.nomes ? (x.qtd != null ? ' - ' : '') + x.nomes : '') + '.';
      }) });
    } else if (i.bms_envolvidos != null) add('Quantidade de BMs diretamente envolvidos na resposta', dois(i.bms_envolvidos));
    // desdobramentos: os do IPO e os registrados no diário, juntos por dia
    var porDia = {};
    i.desdobramentos.forEach(function (x) { (porDia[x.dia] = porDia[x.dia] || []).push(x.texto); });
    diario.forEach(function (e) { if (e.tipo === 'desdobramento' && e.detalhe) { var k = diaDoRegistro(e.ocorrido_em); if (k) (porDia[k] = porDia[k] || []).push(e.detalhe); } });
    var dias = Object.keys(porDia).sort();
    if (dias.length) out.push({ rotulo: 'Desdobramentos/situação atual', linhas: dias.map(function (k) { return diaBr(k) + ': ' + porDia[k].join('\n'); }), espacado: true });
    if (i.orgaos_apoio) out.push({ rotulo: 'Órgãos de Apoio', linhas: i.orgaos_apoio.split('\n').filter(function (l) { return l.trim(); }), espacado: true });
    if (i.imagens_anexas != null) out.push({ rotulo: 'Imagens anexas junto a esta mensagem?', marcas: [['Sim', i.imagens_anexas === true], ['Não', i.imagens_anexas === false]] });
    if (i.responsavel_informacoes) out.push({ rotulo: 'Responsável pelas informações', valor: i.responsavel_informacoes, semPonto: true });
    return out;
  }

  // Texto para colar no WhatsApp (negrito com *), no formato do IPO do CBMPR.
  function textoWhatsApp(op, extra) {
    var i = normalizarIpo((op || {}).ipo || {});
    var l = ['*' + (i.destinatarios || DESTINO_PADRAO) + ' - Informe Padrão de Ocorrência (IPO)*', '', '*ATENÇÃO: uso exclusivo nos grupos do CBMPR.* ', '__________________________________________ ', ''];
    itens(op, extra).forEach(function (x) {
      if (x.cabecalho) { l.push('*' + x.cabecalho + '*'); return; }
      if (l[l.length - 1] !== '') l.push('');
      if (x.marcas) {
        l.push('*' + x.rotulo + (/\?$/.test(x.rotulo) ? '' : ':') + '* ');
        x.marcas.forEach(function (m) { l.push((m[1] ? '( X ) ' : '(    ) ') + m[0] + ';'); });
      } else if (x.linhas) {
        l.push('*' + x.rotulo + ':*' + (x.espacado ? '' : ' '));
        if (x.espacado) l.push('');
        x.linhas.forEach(function (t, k) { l.push(t); if (x.espacado && k < x.linhas.length - 1) l.push(''); });
      } else {
        l.push('*' + x.rotulo + ':* ' + x.valor + (x.semPonto || /[;.!?]$/.test(x.valor) ? '' : ';'));
      }
    });
    return l.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  raiz.Ipo = {
    normalizarIpo: normalizarIpo, itens: itens, textoWhatsApp: textoWhatsApp, dataExtensa: dataExtensa, dataCurta: dataCurta, diaValido: diaValido,
    MEIOS: MEIOS, BUSCAS: BUSCAS, QUALIDADE_HORA: QUALIDADE_HORA, qualidadeHora: qualidadeHora, textoHoraVisto: textoHoraVisto, VIDA: VIDA, PROCEDIMENTOS: PROCEDIMENTOS, DESTINO_PADRAO: DESTINO_PADRAO,
    NATUREZAS: NATUREZAS, OUTRA_NATUREZA: OUTRA_NATUREZA, PERFIS_VITIMA: PERFIS_VITIMA,
    ehAquatica: ehAquatica, tipoDaNatureza: tipoDaNatureza,
  };
})(typeof window !== 'undefined' ? window : globalThis);
