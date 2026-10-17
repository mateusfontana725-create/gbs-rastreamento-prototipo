/* =====================================================================
 * cadastro.js — cadastro completo da operação e ficha da vítima (painel)
 *   - campos do cadastro (tipo, acionamento, local, descrição), usados na
 *     criação e na edição da operação
 *   - escolha do ponto no mapa (janela própria, funciona fora do painel)
 *   - "Dados da operação": ver e editar o cadastro e o intervalo do GPS
 *   - fichas das vítimas: foto (bucket privado "vitimas"), nome, idade,
 *     características físicas, roupas e observações
 * Tudo passa por funções do banco que conferem a permissão (RLS): só os
 * responsáveis da operação leem e alteram.
 * ===================================================================== */
(function () {
  'use strict';

  var C = window.Comunicacao;
  var UI = window.UI;

  var TIPOS = { aquatica: 'Aquática', terrestre: 'Terrestre', aerea: 'Aérea', outras: 'Outras' };
  var BUCKET = 'vitimas';

  // Data e hora do formulário (datetime-local) → ISO; vazio ou inválido → ''
  function isoLocal(v) {
    if (!v) return '';
    var d = new Date(v);
    return isNaN(d) ? '' : d.toISOString();
  }

  function textoIpo(lista, valor) {
    var x = lista.filter(function (o) { return o[0] === valor; })[0];
    return x ? x[1] : valor;
  }

  function textoTipo(op) {
    if (!op || !op.tipo) return '';
    return op.tipo === 'outras' ? 'Outras' + (op.tipo_outro ? ': ' + op.tipo_outro : '') : TIPOS[op.tipo] || op.tipo;
  }

  // Operações antigas (só com o nome) continuam válidas; o painel só sugere completar.
  function incompleto(op) {
    return Boolean(op && (!op.tipo || !op.acionado_em || !op.local_endereco));
  }

  function doisDigitos(n) { return (n < 10 ? '0' : '') + n; }

  // ISO (UTC) → valor de <input type="datetime-local"> no fuso do aparelho
  function paraCampoData(v) {
    var ms = C.paraMs(v);
    if (ms == null) return '';
    var d = new Date(ms);
    return d.getFullYear() + '-' + doisDigitos(d.getMonth() + 1) + '-' + doisDigitos(d.getDate()) + 'T' +
      doisDigitos(d.getHours()) + ':' + doisDigitos(d.getMinutes());
  }

  function dataHora(v) {
    var ms = C.paraMs(v);
    if (ms == null) return '—';
    var d = new Date(ms);
    return doisDigitos(d.getDate()) + '/' + doisDigitos(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + doisDigitos(d.getHours()) + ':' + doisDigitos(d.getMinutes());
  }

  /* ------------------------------------------------------------------ */
  /* Escolher um ponto no mapa                                            */
  /* ------------------------------------------------------------------ */
  // inicial: {lat, lng} ou null. Devolve Promise<{lat, lng} | null>.
  function escolherPontoNoMapa(inicial, titulo) {
    return new Promise(function (resolve) {
      var escolhido = inicial && inicial.lat != null ? { lat: inicial.lat, lng: inicial.lng } : null;
      var caixaMapa = UI.el('div', { classe: 'mapa-escolha', role: 'region', 'aria-label': 'Mapa para escolher o ponto' });
      var info = UI.el('p', { classe: 'ajuda mono', id: 'escolha-coord' });
      var btnOk = UI.el('button', { classe: 'btn btn-escuro', type: 'button', id: 'escolha-usar', texto: 'Usar este ponto', disabled: escolhido ? null : true });
      var resolvido = false;
      var mapa = null, marcador = null;
      function mostrar() {
        info.textContent = escolhido ? window.Coords.formatar(escolhido.lat, escolhido.lng, 'dec') : 'Toque no mapa para marcar o ponto.';
        btnOk.disabled = !escolhido;
      }
      function marcar(ll) {
        escolhido = { lat: Math.round(ll.lat * 1e7) / 1e7, lng: Math.round(ll.lng * 1e7) / 1e7 };
        if (!marcador) marcador = L.marker([escolhido.lat, escolhido.lng]).addTo(mapa);
        else marcador.setLatLng([escolhido.lat, escolhido.lng]);
        mostrar();
      }
      var fechar = UI.abrirModal(UI.el('div', { classe: 'modal-mapa-escolha' }, [
        UI.el('h2', { id: 'modal-titulo', texto: titulo || 'Escolher o local no mapa' }),
        caixaMapa,
        info,
        UI.el('div', { classe: 'modal-acoes' }, [
          UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }),
          btnOk,
        ]),
      ]), {
        fecharNoFundo: false,
        empilhar: true,   // abre por cima do formulário, sem perder o que já foi preenchido
        aoFechar: function () {
          if (mapa) { try { mapa.remove(); } catch (e) { /* ignora */ } }
          if (!resolvido) { resolvido = true; resolve(null); }
        },
      });
      btnOk.addEventListener('click', function () {
        if (!escolhido) return;
        resolvido = true;
        resolve(escolhido);
        fechar();
      });
      setTimeout(function () {
        mapa = L.map(caixaMapa, { zoomControl: true }).setView(escolhido ? [escolhido.lat, escolhido.lng] : [-15.79, -47.88], escolhido ? 15 : 4);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(mapa);
        if (escolhido) marcar(escolhido);
        mapa.on('click', function (e) { marcar(e.latlng); });
        mapa.invalidateSize();
      }, 60);
      mostrar();
    });
  }

  function minhaPosicao() {
    return new Promise(function (resolve) {
      if (!('geolocation' in navigator)) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition(function (p) {
        resolve({ lat: Math.round(p.coords.latitude * 1e7) / 1e7, lng: Math.round(p.coords.longitude * 1e7) / 1e7, prec: p.coords.accuracy });
      }, function () { resolve(null); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Campos do cadastro (criação e edição)                                */
  /* ------------------------------------------------------------------ */
  // Um só formulário para o cadastro da operação (criação e painel).
  // opcoes.inicial: a criação mostra só o que se informa de imediato (coordenadas, início automático,
  // solicitante, natureza e observação). Sem ele, o cadastro completo: tipo, localidade, dados do IPO.
  // Devolve { elemento, ler(), limpar() } — ler() devolve os dados ou lança Error com a mensagem para o usuário.
  function camposOperacao(op, opcoes) {
    op = op || {};
    opcoes = opcoes || {};
    var inicial = opcoes.inicial === true;
    var pre = opcoes.prefixo || 'cad';
    var id = function (s) { return pre + '-' + s; };
    var local = op.local_lat != null ? { lat: op.local_lat, lng: op.local_lng } : null;
    var ipo = window.Ipo.normalizarIpo(op.ipo || {});
    var raiz = null;

    /* ---- local: ou um ponto no mapa, ou só um endereço. Os dois juntos confundiam: o endereço
       podia ser de outro lugar que o ponto marcado. Por isso a escolha é uma só. ---- */
    var modoNome = id('local-modo');
    var modoInicial = !local && op.local_endereco ? 'endereco' : 'mapa';
    var coordInfo = UI.el('span', { classe: 'mono', id: id('ponto-info') });
    var coordTxt = UI.el('input', { classe: 'campo mono', id: id('ponto-txt'), placeholder: 'ou digite: -22.4508, -42.9762 · 23K 708263 7515869' });
    var coordAviso = UI.el('small', { classe: 'muted' });
    var miniMapaEl = UI.el('div', { classe: 'mini-mapa', id: id('mini-mapa'), role: 'img', 'aria-label': 'Mapa com o ponto da operação' });
    var miniVazio = UI.el('p', { classe: 'mini-mapa-vazio muted', texto: 'Nenhum ponto marcado ainda. Escolha no mapa, use sua posição ou digite as coordenadas.' });
    var mapaMini = null, marcadorMini = null;

    function atualizarMiniMapa() {
      if (!local || !window.L) return;
      function desenhar() {
        if (!local) return;
        if (!mapaMini) {
          mapaMini = L.map(miniMapaEl, { zoomControl: true, attributionControl: false }).setView([local.lat, local.lng], 15);
          L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(mapaMini);
          marcadorMini = L.marker([local.lat, local.lng]).addTo(mapaMini);
        } else {
          marcadorMini.setLatLng([local.lat, local.lng]);
          mapaMini.setView([local.lat, local.lng], Math.max(mapaMini.getZoom(), 15));
        }
        mapaMini.invalidateSize();
      }
      // o mapa só tem tamanho quando está visível: desenha depois que o painel aparece
      if (miniMapaEl.offsetParent) desenhar(); else setTimeout(desenhar, 80);
    }
    function mostrarLocal() {
      coordInfo.textContent = local ? window.Coords.formatar(local.lat, local.lng, 'dec') : 'nenhum ponto marcado';
      btnLimpar.hidden = !local;
      miniVazio.hidden = Boolean(local);
      miniMapaEl.hidden = !local;
      atualizarMiniMapa();
    }
    coordTxt.addEventListener('input', function () {
      var c = window.Coords.interpretar(coordTxt.value);
      if (c) { local = { lat: Math.round(c.lat * 1e7) / 1e7, lng: Math.round(c.lng * 1e7) / 1e7 }; coordAviso.textContent = '✓ coordenada reconhecida'; mostrarLocal(); }
      else coordAviso.textContent = coordTxt.value.trim() ? 'Formato não reconhecido' : '';
    });
    var btnMapa = UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: id('ponto-mapa'), texto: '📍 Escolher no mapa', onclick: async function () {
      var p = await escolherPontoNoMapa(local, 'Local da operação');
      if (p) { local = p; coordTxt.value = ''; coordAviso.textContent = ''; mostrarLocal(); }
    } });
    var btnAqui = UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Usar minha posição', onclick: async function () {
      btnAqui.disabled = true;
      var p = await minhaPosicao();
      btnAqui.disabled = false;
      if (!p) { UI.aviso('Não foi possível obter a sua localização agora. Escolha no mapa.', 'erro', 6000); return; }
      local = { lat: p.lat, lng: p.lng };
      coordTxt.value = '';
      coordAviso.textContent = p.prec ? 'Sua posição (± ' + Math.round(p.prec) + ' m)' : '';
      mostrarLocal();
    } });
    var btnLimpar = UI.el('button', { classe: 'btn btn-pequeno btn-link', type: 'button', texto: 'Tirar o ponto', onclick: function () { local = null; coordTxt.value = ''; coordAviso.textContent = ''; mostrarLocal(); } });
    var avisoLegado = op.local_endereco && local
      ? UI.el('p', { classe: 'nota', texto: 'Este cadastro também tinha um endereço escrito ("' + op.local_endereco + '"). Ao salvar com o ponto no mapa, o endereço é retirado.' })
      : null;
    var painelMapa = UI.el('div', { classe: 'cad-local-mapa' }, [
      UI.el('div', { classe: 'cad-local-controles' }, [
        UI.el('span', { classe: 'rotulo', texto: 'Ponto da operação' }),
        UI.el('div', { classe: 'linha-ponto' }, [coordInfo, btnLimpar]),
        UI.el('div', { classe: 'acoes-linha' }, [btnMapa, btnAqui]),
        coordTxt, coordAviso, avisoLegado,
      ]),
      UI.el('div', { classe: 'cad-local-visual' }, [miniMapaEl, miniVazio]),
    ]);

    var endereco = UI.el('input', { classe: 'campo', id: id('endereco'), maxlength: '300', autocomplete: 'off',
      placeholder: 'Rua, número, bairro, cidade ou referência', value: op.local_endereco || '' });
    var painelEndereco = UI.el('div', { classe: 'cad-local-endereco' }, [
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: id('endereco'), texto: 'Endereço' }), endereco]),
      UI.el('p', { classe: 'ajuda', texto: 'Sem ponto no mapa, a operação não aparece no mapa e não entra nos cálculos de distância (ULV).' }),
    ]);
    var radiosModo = UI.el('div', { classe: 'cad-modo', role: 'radiogroup', 'aria-label': 'Como informar o local' }, [
      ['mapa', 'Marcar no mapa'], ['endereco', 'Só endereço (sem ponto)'],
    ].map(function (m) {
      return UI.el('label', { classe: 'cad-modo-opcao' }, [UI.el('input', { type: 'radio', name: modoNome, value: m[0], checked: modoInicial === m[0] ? true : null }), ' ' + m[1]]);
    }));
    function modoAtual() {
      var r = radiosModo.querySelector('input:checked');
      return r ? r.value : 'mapa';
    }
    function aplicarModo() {
      var m = modoAtual();
      painelMapa.hidden = m !== 'mapa';
      painelEndereco.hidden = m !== 'endereco';
      if (m === 'mapa') atualizarMiniMapa();
    }
    radiosModo.addEventListener('change', aplicarModo);
    var secaoLocal = secao('Local', 'larg', [radiosModo, painelMapa, painelEndereco]);

    /* ---- ocorrência ---- */
    var solicNome = UI.el('input', { classe: 'campo', id: id('solic-nome'), maxlength: '120', autocomplete: 'off', value: ipo.solicitante_nome });
    // Natureza: lista de opções; "Outros" abre um campo para descrever
    var naturezaConhecida = window.Ipo.NATUREZAS.indexOf(ipo.natureza) >= 0;
    var naturezaSel = UI.el('select', { classe: 'campo', id: id('natureza') }, [UI.el('option', { value: '', texto: '— escolha —' })].concat(
      window.Ipo.NATUREZAS.map(function (n) { return UI.el('option', { value: n, selected: naturezaConhecida && ipo.natureza === n ? true : null, texto: n }); }),
      [UI.el('option', { value: window.Ipo.OUTRA_NATUREZA, selected: ipo.natureza && !naturezaConhecida ? true : null, texto: 'Outros (descrever)' })]));
    var naturezaOutra = UI.el('input', { classe: 'campo', id: id('natureza-outra'), maxlength: '300', autocomplete: 'off',
      placeholder: 'Descreva a natureza da ocorrência', value: naturezaConhecida ? '' : ipo.natureza || '' });
    var grupoOutraNat = UI.el('div', { classe: 'grupo', hidden: !(ipo.natureza && !naturezaConhecida) }, [
      UI.el('label', { classe: 'rotulo', for: id('natureza-outra'), texto: 'Qual natureza?' }), naturezaOutra]);
    naturezaSel.addEventListener('change', function () {
      grupoOutraNat.hidden = naturezaSel.value !== window.Ipo.OUTRA_NATUREZA;
      if (!grupoOutraNat.hidden) naturezaOutra.focus();
    });
    function naturezaValor() {
      if (naturezaSel.value === window.Ipo.OUTRA_NATUREZA) return naturezaOutra.value.replace(/\s+/g, ' ').trim();
      return naturezaSel.value;
    }
    function naturezaLimpar() {
      naturezaSel.value = '';
      naturezaOutra.value = '';
      grupoOutraNat.hidden = true;
    }
    var desc = UI.el('textarea', { classe: 'campo', id: id('descricao'), maxlength: '2000', rows: '3',
      placeholder: 'Breve descrição do que aconteceu: quem desapareceu, onde, em que circunstâncias…' });
    desc.value = op.descricao || '';
    var grupoSolic = UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: id('solic-nome'), texto: 'Nome do solicitante' }), solicNome]);
    var grupoNatureza = UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: id('natureza'), texto: 'Natureza' }), naturezaSel, grupoOutraNat]);
    var grupoDesc = UI.el('div', { classe: 'grupo cad-largo' }, [UI.el('label', { classe: 'rotulo', for: id('descricao'), texto: 'Observação (breve descrição da ocorrência)' }), desc]);

    /* ---- cadastro completo (painel): o restante do IPO ---- */
    var acion = UI.el('input', { classe: 'campo', id: id('acionamento'), type: 'datetime-local', value: op.acionado_em ? paraCampoData(op.acionado_em) : '' });
    var solicDoc = UI.el('input', { classe: 'campo', id: id('solic-doc'), maxlength: '40', autocomplete: 'off', value: ipo.solicitante_documento });
    var destino = UI.el('input', { classe: 'campo', id: id('destino'), maxlength: '120', autocomplete: 'off', value: ipo.destinatarios });
    var desap = UI.el('input', { classe: 'campo', id: id('desap'), type: 'datetime-local', value: ipo.desaparecimento ? paraCampoData(ipo.desaparecimento) : '' });
    var pessoas = UI.el('input', { classe: 'campo', id: id('pessoas'), type: 'number', min: '0', max: '999', value: ipo.pessoas_perdidas != null ? ipo.pessoas_perdidas : '' });
    var bms = UI.el('input', { classe: 'campo', id: id('bms'), type: 'number', min: '0', max: '999', value: ipo.bms_envolvidos != null ? ipo.bms_envolvidos : '' });
    var responsavel = UI.el('input', { classe: 'campo', id: id('resp'), maxlength: '1000', autocomplete: 'off', placeholder: 'Ex.: Sgt. Fulano — equipe GBS', value: ipo.responsavel_informacoes });
    var nomeMeio = id('meio'), nomeBuscas = id('buscas'), nomeVida = id('vida'), nomeImagens = id('imagens');
    function marcadoEm(nome) {
      var r = raiz.querySelector('input[name="' + nome + '"]:checked');
      return r ? r.value : '';
    }
    // Meio líquido: só aparece na busca aquática (a natureza decide)
    var grupoMeio = radiosCampo(nomeMeio, 'Meio líquido', window.Ipo.MEIOS, ipo.meio_liquido);
    function atualizarMeio() { grupoMeio.hidden = !window.Ipo.ehAquatica(naturezaValor()); }
    naturezaSel.addEventListener('change', atualizarMeio);
    naturezaOutra.addEventListener('input', atualizarMeio);
    atualizarMeio();

    var grupoAcion = UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: id('acionamento'), texto: 'Data e hora do início das operações *' }), acion]);
    var grupoDesap = UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: id('desap'), texto: 'Data e hora do último momento visto' }), desap]);
    var grupoDestino = UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: id('destino'), texto: 'IPO para (destinatários)' }), destino]);
    var grupoSolicDoc = UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: id('solic-doc'), texto: 'Documento do solicitante (RG/CPF)' }), solicDoc]);
    var grupoResp = UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: id('resp'), texto: 'Responsável pelas informações' }), responsavel]);
    var grupoPessoas = UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: id('pessoas'), texto: 'Nº de pessoas perdidas' }), pessoas]);
    var grupoBms = UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: id('bms'), texto: 'BMs diretamente envolvidos' }), bms]);
    var grupoBuscas = radiosCampo(nomeBuscas, 'Buscas preliminares (casas de parentes, hospitais etc.)?', window.Ipo.BUSCAS, ipo.buscas_preliminares);
    var grupoVida = radiosCampo(nomeVida, 'Possibilidade real de vida?', window.Ipo.VIDA, ipo.possibilidade_vida);
    var grupoImagens = radiosCampo(nomeImagens, 'Imagens anexas junto a esta mensagem?', [['sim', 'Sim'], ['nao', 'Não']],
      ipo.imagens_anexas === true ? 'sim' : ipo.imagens_anexas === false ? 'nao' : '');

    // Na criação, o início é automático (a hora em que a operação for criada)
    var inicioAuto = UI.el('p', { classe: 'ajuda', id: id('inicio-auto'), texto: 'Início das operações: automático, a data e a hora em que a operação for criada.' });

    // (cada campo é um nó do DOM: aparece em uma única seção)
    var secoes = inicial
      ? [secaoLocal, secao('Início e solicitação', 'larg', [inicioAuto, grupoSolic, grupoNatureza]), secao('Observação', 'larg', [grupoDesc])]
      : [secaoLocal,
        secao('Ocorrência', 'meia', [grupoAcion, grupoNatureza, grupoDesap, grupoMeio]),
        secao('Solicitante e destinatários', 'meia', [grupoSolic, grupoSolicDoc, grupoDestino, grupoResp]),
        secao('Busca', 'meia', [grupoPessoas, grupoBms, grupoBuscas, grupoVida, grupoImagens]),
        secao('Observação', 'meia', [grupoDesc])];
    raiz = UI.el('div', { classe: 'campos-cadastro' }, secoes);
    mostrarLocal();
    aplicarModo();

    function ler() {
      var noMapa = modoAtual() === 'mapa';
      var dados = {
        local_lat: noMapa && local ? local.lat : null,
        local_lng: noMapa && local ? local.lng : null,
        local_endereco: noMapa ? '' : endereco.value.replace(/\s+/g, ' ').trim(),
        descricao: desc.value.trim(),
        ipo: null,
      };
      if (inicial) {
        var tipCriacao = window.Ipo.tipoDaNatureza(naturezaValor());
        dados.tipo = tipCriacao.tipo;
        dados.tipo_outro = tipCriacao.tipo_outro;
        dados.ipo = window.Ipo.normalizarIpo({ natureza: naturezaValor(), solicitante_nome: solicNome.value });
        return dados;
      }
      if (!acion.value) { acion.focus(); throw new Error('Informe a data e a hora do início das operações.'); }
      var ms = new Date(acion.value).getTime();
      if (!isFinite(ms)) { acion.focus(); throw new Error('Data e hora do início das operações inválidas.'); }
      if (ms > Date.now() + 5 * 60000) { acion.focus(); throw new Error('A data e a hora do início das operações não podem estar no futuro.'); }
      var tip = window.Ipo.tipoDaNatureza(naturezaValor());
      dados.tipo = tip.tipo;
      dados.tipo_outro = tip.tipo_outro;
      dados.acionado_em = new Date(ms).toISOString();
      dados.ipo = window.Ipo.normalizarIpo({
        natureza: naturezaValor(), solicitante_nome: solicNome.value, solicitante_documento: solicDoc.value,
        destinatarios: destino.value, desaparecimento: isoLocal(desap.value), meio_liquido: window.Ipo.ehAquatica(naturezaValor()) ? marcadoEm(nomeMeio) : '',
        pessoas_perdidas: pessoas.value, buscas_preliminares: marcadoEm(nomeBuscas), possibilidade_vida: marcadoEm(nomeVida),
        bms_envolvidos: bms.value, imagens_anexas: marcadoEm(nomeImagens) === 'sim' ? true : marcadoEm(nomeImagens) === 'nao' ? false : null,
        responsavel_informacoes: responsavel.value,
      });
      return dados;
    }

    function limpar() {
      solicNome.value = '';
      naturezaLimpar();
      atualizarMeio();
      desc.value = '';
      local = null;
      coordTxt.value = '';
      coordAviso.textContent = '';
      mostrarLocal();
      radiosModo.querySelector('input[value="mapa"]').checked = true;
      aplicarModo();
      if (inicial) return;
      acion.value = '';
      endereco.value = '';
      solicDoc.value = '';
      destino.value = window.Ipo.DESTINO_PADRAO;
      desap.value = '';
      pessoas.value = '';
      bms.value = '';
      responsavel.value = '';
      [nomeMeio, nomeBuscas, nomeVida, nomeImagens].forEach(function (nome) {
        raiz.querySelectorAll('input[name="' + nome + '"]').forEach(function (r) { r.checked = false; });
      });
    }

    return { elemento: raiz, ler: ler, limpar: limpar };
  }

  // Seção do formulário: "larg" ocupa a largura toda; "meia" fica lado a lado em tela maior.
  function secao(titulo, largura, filhos) {
    return UI.el('section', { classe: 'cad-secao cad-' + largura }, [
      UI.el('h3', { classe: 'cad-secao-titulo', texto: titulo }),
      UI.el('div', { classe: 'cad-campos' }, filhos),
    ]);
  }

  // Opções de uma escolha única (meio líquido, buscas, possibilidade de vida, imagens)
  function radiosCampo(nome, t, lista, marcado) {
    return UI.el('div', { classe: 'grupo' }, [UI.el('span', { classe: 'rotulo', texto: t }),
      UI.el('div', { classe: 'opcoes-ipo' }, lista.map(function (x) {
        return UI.el('label', { classe: 'linha-opcao' }, [UI.el('input', { type: 'radio', name: nome, value: x[0], checked: marcado === x[0] ? true : null }), ' ' + x[1]]);
      }))]);
  }

  /* ------------------------------------------------------------------ */
  /* Dados da operação: ver e editar                                      */
  /* ------------------------------------------------------------------ */
  // opcoes.aoSalvar(op) — chamado com a operação atualizada; opcoes.verNoMapa(op)
  function abrirDados(op, opcoes) {
    opcoes = opcoes || {};
    var dl = UI.el('dl', { classe: 'dados' });
    function linha(rot, valor) { dl.appendChild(UI.el('dt', { texto: rot })); dl.appendChild(UI.el('dd', null, [valor])); }
    linha('Nome', op.codigo);
    linha('Acionamento (início das operações)', op.acionado_em ? dataHora(op.acionado_em) : '— não informado');
    linha('Localidade / endereço', op.local_endereco || '— não informado');
    linha('Ponto no mapa', op.local_lat != null ? window.Coords.formatar(op.local_lat, op.local_lng, 'dec') : '— não marcado');
    linha('Contexto / descrição', op.descricao || '—');
    var ipo = window.Ipo.normalizarIpo(op.ipo || {});
    if (ipo.natureza || ipo.solicitante_nome || ipo.meio_liquido || ipo.pessoas_perdidas != null) {
      linha('IPO para', ipo.destinatarios);
      if (ipo.natureza) linha('Natureza', ipo.natureza);
      if (ipo.solicitante_nome) linha('Solicitante', [ipo.solicitante_nome, ipo.solicitante_documento].filter(Boolean).join(' · '));
      if (ipo.desaparecimento) linha('Data e hora do último momento visto', dataHora(ipo.desaparecimento));
      if (ipo.meio_liquido) linha('Meio líquido', textoIpo(window.Ipo.MEIOS, ipo.meio_liquido));
      if (ipo.pessoas_perdidas != null) linha('Pessoas perdidas', String(ipo.pessoas_perdidas));
      if (ipo.bms_envolvidos != null) linha('BMs diretamente envolvidos', String(ipo.bms_envolvidos));
      if (ipo.buscas_preliminares) linha('Buscas preliminares', textoIpo(window.Ipo.BUSCAS, ipo.buscas_preliminares));
      if (ipo.possibilidade_vida) linha('Possibilidade real de vida', textoIpo(window.Ipo.VIDA, ipo.possibilidade_vida));
      if (ipo.imagens_anexas != null) linha('Imagens anexas', ipo.imagens_anexas ? 'Sim' : 'Não');
      if (ipo.responsavel_informacoes) linha('Responsável pelas informações', ipo.responsavel_informacoes);
    }
    if (op.gps_intervalo_s) linha('GPS', 'ponto pelo menos a cada ' + op.gps_intervalo_s + ' s · falha acima de ' + op.gps_lacuna_s + ' s sem ponto');
    if ('permanencia_limite_min' in op) linha('Permanência no setor', op.permanencia_limite_min ? 'alerta depois de ' + textoMinutos(op.permanencia_limite_min) + ' no mesmo setor' : 'alerta desligado');
    linha('Criada', dataHora(op.criada_em));
    if (op.atualizado_por_nome) linha('Alterada', dataHora(op.atualizado_em) + ' por ' + op.atualizado_por_nome);
    var editavel = opcoes.editavel !== false;
    var fechar = UI.abrirModal(UI.el('div', { classe: 'detalhe-operacao' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Dados da operação' }),
      incompleto(op) ? UI.el('p', { classe: 'nota', texto: 'Cadastro inicial: o restante (tipo, localidade e os dados do IPO) pode ser completado depois em Editar, no painel da operação.' }) : null,
      dl,
      UI.el('div', { classe: 'modal-acoes acoes-detalhe' }, [
        op.local_lat != null && opcoes.verNoMapa ? UI.el('button', { classe: 'btn', type: 'button', texto: 'Ver no mapa', onclick: function () { fechar(); opcoes.verNoMapa(op); } }) : null,
        editavel ? UI.el('button', { classe: 'btn', type: 'button', id: 'dados-editar', texto: 'Editar', onclick: function () { fechar(); editarDados(op, opcoes); } }) : null,
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]));
  }

  function textoMinutos(m) { return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); }

  function editarDados(op, opcoes) {
    var nome = UI.el('input', { classe: 'campo', id: 'dados-nome', maxlength: '80', value: op.codigo });
    // Alerta de tempo de permanência em setor (migração 013): 0 = desligado
    var temPerm = 'permanencia_limite_min' in op;
    var opcoesPerm = [0, 30, 45, 60, 90, 120, 180, 240];
    if (temPerm && opcoesPerm.indexOf(op.permanencia_limite_min) === -1) opcoesPerm.push(op.permanencia_limite_min);
    var perm = UI.el('select', { classe: 'campo', id: 'dados-permanencia' }, opcoesPerm.sort(function (a, b) { return a - b; }).map(function (m) {
      return UI.el('option', { value: String(m), selected: m === op.permanencia_limite_min ? true : null,
        texto: m ? 'Depois de ' + textoMinutos(m) + (m === 60 ? ' (padrão)' : '') : 'Desligado' });
    }));
    var campos = camposOperacao(op, { prefixo: 'dados' });
    var temGps = op.gps_intervalo_s != null;
    var intervalo = UI.el('input', { classe: 'campo', id: 'dados-gps-intervalo', type: 'number', min: '5', max: '300', step: '1', inputmode: 'numeric', value: String(op.gps_intervalo_s || 15) });
    var lacuna = UI.el('input', { classe: 'campo', id: 'dados-gps-lacuna', type: 'number', min: '30', max: '3600', step: '5', inputmode: 'numeric', value: String(op.gps_lacuna_s || 60) });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'dados-salvar', texto: 'Salvar' });
    var form = UI.el('form', { classe: 'form-dados', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Editar dados da operação' }),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'dados-nome', texto: 'Nome ou código da operação' }), nome]),
      campos.elemento,
      secaoFichas(op, opcoes),
      temGps ? UI.el('fieldset', { classe: 'grupo-gps' }, [
        UI.el('legend', { texto: 'Trilha GPS' }),
        UI.el('div', { classe: 'grupo-duplo' }, [
          UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'dados-gps-intervalo', texto: 'Ponto pelo menos a cada (s)' }), intervalo]),
          UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'dados-gps-lacuna', texto: 'Falha acima de (s sem ponto)' }), lacuna]),
        ]),
        UI.el('small', { classe: 'muted', texto: 'Andando ou de carro os pontos continuam mais frequentes. Intervalos maiores que o limite aparecem tracejados no mapa, com início e fim marcados.' }),
      ]) : null,
      temPerm ? UI.el('fieldset', { classe: 'grupo-gps' }, [
        UI.el('legend', { texto: 'Tempo de permanência em setor' }),
        UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'dados-permanencia', texto: 'Alertar quando uma pessoa ou grupo estiver no mesmo setor' }), perm]),
        UI.el('small', { classe: 'muted', texto: 'Calculado pela trilha GPS: conta da entrada à saída do setor. Um alerta por limite atingido (1×, 2×…), para avaliar a troca da equipe.' }),
      ]) : null,
      erro,
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var dados;
      try {
        dados = campos.ler();
      } catch (e) {
        erro.textContent = e.message;
        erro.hidden = false;
        return;
      }
      dados.codigo = nome.value.replace(/\s+/g, ' ').trim();
      if (dados.codigo.length < 2) { erro.textContent = 'Informe o nome ou código da operação (2 a 80 caracteres).'; erro.hidden = false; return; }
      var gi = Number(intervalo.value), gl = Number(lacuna.value);
      var mudouGps = temGps && (gi !== op.gps_intervalo_s || gl !== op.gps_lacuna_s);
      if (mudouGps && !(gi >= 5 && gi <= 300 && gl >= 30 && gl <= 3600 && gl > gi)) {
        erro.textContent = C.traduzirErro({ message: 'gps_config_invalida' });
        erro.hidden = false;
        return;
      }
      btn.disabled = true;
      try {
        var atual = await C.rpc('atualizar_operacao', { p_operacao: op.id, p_dados: dados });
        if (mudouGps) atual = await C.rpc('configurar_gps_operacao', { p_operacao: op.id, p_intervalo_s: gi, p_lacuna_s: gl });
        if (temPerm && Number(perm.value) !== op.permanencia_limite_min) {
          atual = await C.rpc('configurar_permanencia', { p_operacao: op.id, p_limite_min: Number(perm.value) });
        }
        fechar(true);
        UI.aviso('Dados da operação salvos.', 'ok');
        if (opcoes.aoSalvar) opcoes.aoSalvar(atual);
      } catch (e) {
        erro.textContent = 'Não foi possível salvar: ' + e.message;
        erro.hidden = false;
        btn.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false });
  }

  /* ------------------------------------------------------------------ */
  /* Fichas das vítimas                                                   */
  /* ------------------------------------------------------------------ */
  var cacheUrls = new Map();   // caminho → { url, exp }
  async function urlsFotos(caminhos) {
    var agora = Date.now();
    var faltam = caminhos.filter(function (c) { var x = cacheUrls.get(c); return c && (!x || x.exp < agora + 120000); });
    if (faltam.length) {
      var r = await C.cliente.storage.from(BUCKET).createSignedUrls(faltam, 3600);
      if (r.error) throw C.criarErro(r.error);
      (r.data || []).forEach(function (d) { if (d.signedUrl && d.path) cacheUrls.set(d.path, { url: d.signedUrl, exp: agora + 3600 * 1000 }); });
    }
    var res = {};
    caminhos.forEach(function (c) { var x = cacheUrls.get(c); if (x) res[c] = x.url; });
    return res;
  }

  var aberta = null;   // { op, opcoes, render } — janela de vítimas aberta (atualiza pelo tempo real)

  async function carregarVitimas(op) {
    return (await C.consultar(C.cliente.from('vitimas').select('*').eq('operacao_id', op.id).order('criado_em', { ascending: true }))) || [];
  }

  function textoIdade(v) { return v.idade == null ? 'idade não informada' : v.idade + (v.idade === 1 ? ' ano' : ' anos'); }

  // opcoes: { editavel, limparArquivos() } — limparArquivos apaga do Storage as fotos substituídas
  // Fichas de vítima dentro do formulário de dados da operação (Dados da operação → Editar).
  // Cada ficha abre por cima do formulário; ao fechar uma ficha, a lista se atualiza.
  function secaoFichas(op, opcoes) {
    opcoes = opcoes || {};
    var editavel = opcoes.editavel !== false;
    var lista = UI.el('ul', { classe: 'lista-vitimas', id: 'lista-vitimas' });
    var vazio = UI.el('p', { classe: 'muted', id: 'vitimas-vazio', texto: 'Nenhuma ficha de vítima ainda.' });
    var filhas = { editavel: editavel, limparArquivos: opcoes.limparArquivos, aoMudar: function () { render(); } };
    async function render() {
      var vitimas;
      try {
        vitimas = await carregarVitimas(op);
      } catch (e) {
        lista.innerHTML = '';
        lista.appendChild(UI.el('li', { classe: 'erro-form', texto: e.codigo === 'desconhecido' || /vitimas/.test(e.message) ? 'Fichas de vítima indisponíveis: execute a migração 007 no Supabase.' : e.message }));
        return;
      }
      var urls = {};
      try { urls = await urlsFotos(vitimas.map(function (v) { return v.foto_caminho; }).filter(Boolean)); } catch (e) { /* sem miniaturas */ }
      lista.innerHTML = '';
      vazio.hidden = vitimas.length > 0;
      vitimas.forEach(function (v) {
        var mini = v.foto_caminho && urls[v.foto_caminho]
          ? UI.el('img', { classe: 'vitima-mini', src: urls[v.foto_caminho], alt: 'Foto de ' + v.nome })
          : UI.el('span', { classe: 'vitima-mini vitima-sem-foto', 'aria-hidden': 'true', texto: '👤' });
        lista.appendChild(UI.el('li', null, [UI.el('button', { classe: 'item-vitima', type: 'button', 'data-vitima': v.id, onclick: function () { abrirFicha(op, v, filhas); } }, [
          mini,
          UI.el('span', { classe: 'item-area-txt' }, [
            UI.el('strong', { texto: v.nome }),
            UI.el('small', { classe: 'muted', texto: textoIdade(v) + (v.roupas ? ' · ' + resumir(v.roupas, 60) : '') }),
          ]),
        ])]));
      });
    }
    aberta = { op: op, render: render };
    render();
    return UI.el('section', { classe: 'dados-vitimas' }, [
      UI.el('h3', { texto: 'Vítimas' }),
      UI.el('p', { classe: 'ajuda', texto: 'Só os responsáveis desta operação veem estas fichas. Civis e militares de campo não têm acesso.' }),
      lista,
      vazio,
      editavel ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'vitima-nova', texto: '＋ Nova ficha', onclick: function () { editarFicha(op, null, filhas); } }) : null,
    ]);
  }

  function resumir(t, n) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  async function abrirFicha(op, v, opcoes) {
    var editavel = opcoes.editavel !== false;
    var dl = UI.el('dl', { classe: 'dados' });
    function linha(rot, valor) { dl.appendChild(UI.el('dt', { texto: rot })); dl.appendChild(UI.el('dd', { classe: 'texto-longo' }, [valor])); }
    linha('Idade', v.idade == null ? 'não informada' : textoIdade(v));
    if (v.nascimento) linha('Nascimento', v.nascimento);
    if (v.sexo) linha('Sexo', v.sexo === 'M' ? 'Masculino' : 'Feminino');
    if (v.origem) linha('Origem', v.origem);
    if ((v.perfil || []).length) linha('Perfil', v.perfil.map(function (x) { return textoIpo(window.Ipo.PERFIS_VITIMA, x); }).join(', '));
    linha('Características físicas', v.caracteristicas || '—');
    linha('Roupas', v.roupas || '—');
    linha('Observações', v.observacoes || '—');
    linha('Registrada', dataHora(v.criado_em) + ' por ' + v.criado_por_nome);
    if (v.atualizado_por_nome && v.atualizado_em !== v.criado_em) linha('Alterada', dataHora(v.atualizado_em) + ' por ' + v.atualizado_por_nome);
    var caixaFoto = UI.el('div', { classe: 'vitima-foto' }, [UI.el('span', { classe: 'muted', texto: v.foto_caminho ? 'Carregando a foto…' : 'Sem foto.' })]);
    var inFoto = UI.el('input', { classe: 'sr-only', type: 'file', accept: 'image/*', id: 'vitima-foto-arquivo' });
    var rotFoto = UI.el('label', { classe: 'btn', for: 'vitima-foto-arquivo', texto: v.foto_caminho ? 'Trocar foto' : 'Adicionar foto' });
    inFoto.addEventListener('change', async function () {
      var arq = inFoto.files && inFoto.files[0];
      inFoto.value = '';
      if (!arq) return;
      fechar();
      await enviarFoto(op, v, arq, opcoes);
    });
    var fechar = UI.abrirModal(UI.el('div', { classe: 'detalhe-vitima' }, [
      UI.el('h2', { id: 'modal-titulo', texto: v.nome }),
      caixaFoto,
      dl,
      UI.el('div', { classe: 'modal-acoes acoes-detalhe' }, [
        editavel ? UI.el('button', { classe: 'btn', type: 'button', id: 'vitima-editar', texto: 'Editar', onclick: function () { fechar(); editarFicha(op, v, opcoes); } }) : null,
        editavel ? rotFoto : null,
        editavel ? inFoto : null,
        editavel && v.foto_caminho ? UI.el('button', { classe: 'btn', type: 'button', texto: 'Tirar foto', onclick: function () { fechar(); removerFoto(op, v, opcoes); } }) : null,
        editavel ? UI.el('button', { classe: 'btn btn-perigo', type: 'button', id: 'vitima-excluir', texto: 'Excluir', onclick: function () { fechar(); excluirFicha(op, v, opcoes); } }) : null,
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]), { empilhar: true, aoFechar: function () { if (opcoes.aoMudar) opcoes.aoMudar(); } });
    if (v.foto_caminho) {
      try {
        var urls = await urlsFotos([v.foto_caminho]);
        caixaFoto.innerHTML = '';
        if (urls[v.foto_caminho]) caixaFoto.appendChild(UI.el('img', { src: urls[v.foto_caminho], alt: 'Foto de ' + v.nome }));
        else caixaFoto.appendChild(UI.el('span', { classe: 'muted', texto: 'Foto indisponível.' }));
      } catch (e) {
        caixaFoto.innerHTML = '';
        caixaFoto.appendChild(UI.el('span', { classe: 'erro-form', texto: 'Não foi possível abrir a foto: ' + e.message }));
      }
    }
  }

  // Campos da ficha de vítima, com a validação. Usados na ficha (prefixo "vitima")
  // e no cadastro da operação nova (vários blocos, cada um com o seu prefixo).
  function camposVitima(v, prefixo, opcoes) {
    prefixo = prefixo || 'vitima';
    v = v || { nome: '', idade: null, caracteristicas: '', roupas: '', observacoes: '' };
    var nome = UI.el('input', { classe: 'campo', id: prefixo + '-nome', maxlength: '80', value: v.nome, placeholder: 'Nome (ou "Não identificada")' });
    var idade = UI.el('input', { classe: 'campo', id: prefixo + '-idade', type: 'number', min: '0', max: '130', step: '1', inputmode: 'numeric', value: v.idade == null ? '' : String(v.idade) });
    function area(id, max, valor, ph) { var a = UI.el('textarea', { classe: 'campo', id: prefixo + '-' + id, maxlength: String(max), rows: '3', placeholder: ph || '' }); a.value = valor || ''; return a; }
    var carac = area('caracteristicas', 1000, v.caracteristicas, 'Altura, porte, cabelo, cor da pele, sinais, tatuagens, cicatrizes…');
    var roupas = area('roupas', 1000, v.roupas, 'Cores e tipo de roupa, calçado, acessórios, mochila…');
    var obs = area('observacoes', 2000, v.observacoes, 'Condição de saúde, medicamentos, último contato, hábitos, para onde iria…');
    // dados do IPO (nascimento, sexo e origem), para o informe da ocorrência
    var nasc = UI.el('input', { classe: 'campo', id: prefixo + '-nascimento', maxlength: '20', autocomplete: 'off', placeholder: 'dd/mm/aaaa', value: v.nascimento || '' });
    var sexo = UI.el('select', { classe: 'campo', id: prefixo + '-sexo' }, [
      UI.el('option', { value: '', texto: '—' }),
      UI.el('option', { value: 'M', selected: v.sexo === 'M' ? true : null, texto: 'Masculino' }),
      UI.el('option', { value: 'F', selected: v.sexo === 'F' ? true : null, texto: 'Feminino' }),
    ]);
    var origem = UI.el('input', { classe: 'campo', id: prefixo + '-origem', maxlength: '120', autocomplete: 'off', placeholder: 'Cidade ou bairro', value: v.origem || '' });
    // Perfil para os estudos: uma só lista de seleção, com valores fixos
    var perfilSel = UI.el('select', { classe: 'campo', id: prefixo + '-perfil' }, [UI.el('option', { value: '', texto: '— nenhum —' })].concat(
      window.Ipo.PERFIS_VITIMA.map(function (x) {
        return UI.el('option', { value: x[0], selected: (v.perfil || [])[0] === x[0] ? true : null, texto: x[1] });
      })));
    var perfil = UI.el('div', { classe: 'grupo' }, [
      UI.el('label', { classe: 'rotulo', for: prefixo + '-perfil', texto: 'Perfil da vítima (para estudos)' }), perfilSel,
      UI.el('small', { classe: 'muted', texto: 'Idoso: 60 anos ou mais · Criança: até 12 anos · Adolescente: 13 a 17 anos.' }),
    ]);
    // Foto da vítima (opcional): tirada agora ou escolhida; é enviada quando a ficha é salva
    var foto = UI.el('input', { classe: 'campo', type: 'file', accept: 'image/*', id: prefixo + '-foto' });
    var grupoFoto = UI.el('div', { classe: 'grupo' }, [
      UI.el('label', { classe: 'rotulo', for: prefixo + '-foto', texto: 'Foto da vítima' }), foto,
      v.foto_caminho ? UI.el('small', { classe: 'muted', texto: 'Já tem foto: escolher outra substitui a atual.' }) : null,
    ]);
    var elementos = [
      UI.el('div', { classe: 'grupo-duplo grupo-duplo-largo' }, [
        UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: prefixo + '-nome', texto: 'Nome *' }), nome]),
        UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: prefixo + '-idade', texto: 'Idade (anos)' }), idade]),
      ]),
      UI.el('div', { classe: 'grupo-duplo' }, [
        UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: prefixo + '-nascimento', texto: 'Nascimento' }), nasc]),
        UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: prefixo + '-sexo', texto: 'Sexo' }), sexo]),
      ]),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: prefixo + '-origem', texto: 'Origem (cidade/bairro)' }), origem]),
      perfil,
      grupoFoto,
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: prefixo + '-caracteristicas', texto: 'Características físicas' }), carac]),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: prefixo + '-roupas', texto: 'Roupas' }), roupas]),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: prefixo + '-observacoes', texto: 'Observações' }), obs]),
    ];
    function ler() {
      return {
        nome: nome.value.replace(/\s+/g, ' ').trim(),
        idade: idade.value.trim() === '' ? null : Number(idade.value),
        caracteristicas: carac.value.trim(),
        roupas: roupas.value.trim(),
        observacoes: obs.value.trim(),
        nascimento: nasc.value.trim(),
        sexo: sexo.value,
        origem: origem.value.replace(/\s+/g, ' ').trim(),
        perfil: perfilSel.value ? [perfilSel.value] : [],
      };
    }
    // null = tudo certo; senão { texto, campo } para mostrar o erro e pôr o foco no campo
    function validar(dados) {
      if (!dados.nome) return { texto: 'Informe o nome da vítima (ou "Não identificada").', campo: nome };
      if (dados.idade != null && !(Number.isInteger(dados.idade) && dados.idade >= 0 && dados.idade <= 130)) {
        return { texto: 'Idade: um número inteiro de 0 a 130.', campo: idade };
      }
      return null;
    }
    function bloquear(sim) {
      [nome, idade, nasc, sexo, origem, carac, roupas, obs].forEach(function (c) { c.disabled = Boolean(sim); });
      perfil.querySelectorAll('select').forEach(function (c) { c.disabled = Boolean(sim); });
      foto.disabled = Boolean(sim);
    }
    return { elementos: elementos, ler: ler, validar: validar, bloquear: bloquear, nome: nome,
      arquivo: function () { return foto.files && foto.files[0] ? foto.files[0] : null; } };
  }

  function editarFicha(op, v, opcoes) {
    opcoes = opcoes || {};
    var nova = !v;
    v = v || { nome: '', idade: null, caracteristicas: '', roupas: '', observacoes: '' };
    var campos = camposVitima(v, 'vitima');
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'vitima-salvar', texto: nova ? 'Criar ficha' : 'Salvar' });
    var form = UI.el('form', { classe: 'form-vitima', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: nova ? 'Nova ficha de vítima' : 'Editar ficha' }),
    ].concat(campos.elementos, [
      erro,
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); if (!nova) abrirFicha(op, v, opcoes); } }), btn]),
    ]));
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var dados = campos.ler();
      var invalido = campos.validar(dados);
      if (invalido) { erro.textContent = invalido.texto; erro.hidden = false; invalido.campo.focus(); return; }
      btn.disabled = true;
      try {
        var res = await C.rpc('salvar_vitima', { p_operacao: op.id, p_id: v.id || null, p_dados: dados });
        var aviso = nova ? 'Ficha de "' + res.nome + '" criada.' : 'Ficha salva.';
        var arq = campos.arquivo();
        if (arq) {
          try {
            res = await subirFoto(op, res, arq, opcoes);
            aviso += ' Foto salva.';
          } catch (e) {
            UI.aviso('A ficha foi salva, mas a foto não: ' + e.message, 'erro', 8000);
          }
        }
        fechar(true);
        UI.aviso(aviso, 'ok');
        abrirFicha(op, res, opcoes);
      } catch (e) {
        erro.textContent = 'Não foi possível salvar: ' + e.message;
        erro.hidden = false;
        btn.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false, empilhar: true, aoFechar: function () { if (opcoes.aoMudar) opcoes.aoMudar(); } });
  }

  // Envia a foto (já reduzida) para a ficha e devolve a ficha com o caminho da foto.
  async function subirFoto(op, v, arquivo, opcoes) {
    opcoes = opcoes || {};
    if (arquivo.type && !/^image\//.test(arquivo.type)) throw new Error('escolha um arquivo de imagem.');
    var img;
    try {
      img = await window.Fotos.prepararImagem(arquivo);   // no máximo 1600 px, JPEG
    } catch (e) {
      throw new Error('não foi possível abrir esta imagem neste aparelho.');
    }
    var caminho = op.id + '/' + v.id + '/' + C.uuid() + '.jpg';
    var up = await C.cliente.storage.from(BUCKET).upload(caminho, await img.blob.arrayBuffer(), { contentType: 'image/jpeg', upsert: false });
    if (up.error) throw C.criarErro(up.error);
    var res = await C.rpc('definir_foto_vitima', { p_vitima: v.id, p_caminho: caminho }, 20000);
    if (opcoes.limparArquivos) opcoes.limparArquivos();   // apaga a foto anterior (se havia)
    return res;
  }

  async function enviarFoto(op, v, arquivo, opcoes) {
    UI.aviso('Preparando a foto…');
    try {
      var res = await subirFoto(op, v, arquivo, opcoes);
      UI.aviso('Foto salva na ficha.', 'ok');
      abrirFicha(op, res, opcoes);
    } catch (e) {
      UI.aviso('A foto não foi salva: ' + e.message, 'erro', 8000);
      abrirFicha(op, v, opcoes);
    }
  }

  async function removerFoto(op, v, opcoes) {
    var r = await UI.confirmar({ titulo: 'Tirar a foto da ficha?', texto: 'O arquivo da foto é apagado do servidor.', ok: 'Tirar a foto', perigo: true });
    if (!r) { abrirFicha(op, v, opcoes); return; }
    try {
      var res = await C.rpc('definir_foto_vitima', { p_vitima: v.id, p_caminho: null });
      if (opcoes.limparArquivos) opcoes.limparArquivos();
      UI.aviso('Foto retirada.', 'ok');
      abrirFicha(op, res, opcoes);
    } catch (e) {
      UI.aviso(e.message, 'erro');
      abrirFicha(op, v, opcoes);
    }
  }

  async function excluirFicha(op, v, opcoes) {
    var r = await UI.confirmar({
      titulo: 'Excluir a ficha de "' + v.nome + '"?',
      texto: 'A ficha e a foto são apagadas para todos os responsáveis. Esta ação não pode ser desfeita.',
      ok: 'Excluir ficha',
      perigo: true,
    });
    if (!r) { abrirFicha(op, v, opcoes); return; }
    try {
      await C.rpc('excluir_vitima', { p_id: v.id });
      if (opcoes.limparArquivos) opcoes.limparArquivos();
      UI.aviso('Ficha excluída.', 'ok');
      if (opcoes.aoMudar) opcoes.aoMudar();
    } catch (e) {
      UI.aviso(e.codigo === 'sem_permissao' ? 'Só quem criou a ficha, quem criou a operação ou um administrador pode excluí-la.' : e.message, 'erro', 7000);
      abrirFicha(op, v, opcoes);
    }
  }

  // Tempo real: outra pessoa alterou as fichas → atualiza a lista aberta.
  function aoMudarVitimas(operacaoId) {
    if (aberta && aberta.op.id === operacaoId) aberta.render();
  }

  window.Cadastro = {
    TIPOS: TIPOS,
    textoTipo: textoTipo,
    incompleto: incompleto,
    dataHora: dataHora,
    camposOperacao: camposOperacao,
    camposVitima: camposVitima,
    escolherPontoNoMapa: escolherPontoNoMapa,
    abrirDados: abrirDados,
    secaoFichas: secaoFichas,
    subirFoto: subirFoto,
    aoMudarVitimas: aoMudarVitimas,
  };
})();
