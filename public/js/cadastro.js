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

  function textoTipo(op) {
    if (!op || !op.tipo) return '';
    return op.tipo === 'outras' ? 'Outras' + (op.tipo_outro ? ': ' + op.tipo_outro : '') : TIPOS[op.tipo] || op.tipo;
  }

  // Operações antigas (só com o nome) continuam válidas; o painel só sugere completar.
  function incompleto(op) {
    return Boolean(op && (!op.tipo || !op.acionado_em));
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
  // op: operação existente (edição) ou null (nova). opcoes.obrigatorio: tipo e acionamento obrigatórios.
  // Devolve { elemento, ler() } — ler() devolve os dados ou lança Error com a mensagem para o usuário.
  function camposOperacao(op, opcoes) {
    op = op || {};
    opcoes = opcoes || {};
    var pre = opcoes.prefixo || 'cad';
    var local = op.local_lat != null ? { lat: op.local_lat, lng: op.local_lng } : null;

    var tipo = UI.el('select', { classe: 'campo', id: pre + '-tipo' }, [UI.el('option', { value: '', texto: '— escolha —' })].concat(
      Object.keys(TIPOS).map(function (k) { return UI.el('option', { value: k, selected: op.tipo === k ? true : null, texto: TIPOS[k] }); })));
    var outro = UI.el('input', { classe: 'campo', id: pre + '-tipo-outro', maxlength: '60', placeholder: 'Ex.: deslizamento, desabamento…', value: op.tipo_outro || '' });
    var grupoOutro = UI.el('div', { classe: 'grupo', hidden: op.tipo !== 'outras' }, [
      UI.el('label', { classe: 'rotulo', for: pre + '-tipo-outro', texto: 'Qual?' }), outro]);
    tipo.addEventListener('change', function () { grupoOutro.hidden = tipo.value !== 'outras'; if (!grupoOutro.hidden) outro.focus(); });

    var acion = UI.el('input', { classe: 'campo', id: pre + '-acionamento', type: 'datetime-local',
      value: op.acionado_em ? paraCampoData(op.acionado_em) : (opcoes.agoraPadrao ? paraCampoData(Date.now()) : '') });
    var endereco = UI.el('input', { classe: 'campo', id: pre + '-endereco', maxlength: '300', autocomplete: 'off',
      placeholder: 'Rua, número, bairro, cidade ou referência', value: op.local_endereco || '' });
    var coordInfo = UI.el('span', { classe: 'mono', id: pre + '-ponto-info' });
    var coordTxt = UI.el('input', { classe: 'campo mono', id: pre + '-ponto-txt', placeholder: 'ou digite: -22.4508, -42.9762 · 23K 708263 7515869' });
    var coordAviso = UI.el('small', { classe: 'muted' });
    function mostrarLocal() {
      coordInfo.textContent = local ? window.Coords.formatar(local.lat, local.lng, 'dec') : 'nenhum ponto marcado';
      btnLimpar.hidden = !local;
    }
    coordTxt.addEventListener('input', function () {
      var c = window.Coords.interpretar(coordTxt.value);
      if (c) { local = { lat: Math.round(c.lat * 1e7) / 1e7, lng: Math.round(c.lng * 1e7) / 1e7 }; coordAviso.textContent = '✓ coordenada reconhecida'; mostrarLocal(); }
      else coordAviso.textContent = coordTxt.value.trim() ? 'Formato não reconhecido' : '';
    });
    var btnMapa = UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: pre + '-ponto-mapa', texto: '📍 Escolher no mapa', onclick: async function () {
      var p = await escolherPontoNoMapa(local, 'Local da operação');
      if (p) { local = p; coordTxt.value = ''; coordAviso.textContent = ''; mostrarLocal(); }
    } });
    var btnAqui = UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Usar minha posição', onclick: async function () {
      btnAqui.disabled = true;
      var p = await minhaPosicao();
      btnAqui.disabled = false;
      if (!p) { UI.aviso('Não foi possível obter a sua localização agora. Escolha no mapa.', 'erro', 6000); return; }
      local = { lat: p.lat, lng: p.lng };
      coordAviso.textContent = p.prec ? 'Sua posição (± ' + Math.round(p.prec) + ' m)' : '';
      mostrarLocal();
    } });
    var btnLimpar = UI.el('button', { classe: 'btn btn-pequeno btn-link', type: 'button', texto: 'Tirar o ponto', onclick: function () { local = null; mostrarLocal(); } });
    var desc = UI.el('textarea', { classe: 'campo', id: pre + '-descricao', maxlength: '2000', rows: '3',
      placeholder: 'O que aconteceu, quem acionou, informações iniciais…' });
    desc.value = op.descricao || '';
    mostrarLocal();

    var req = opcoes.obrigatorio ? ' *' : '';
    var elemento = UI.el('div', { classe: 'campos-cadastro' }, [
      UI.el('div', { classe: 'grupo-duplo' }, [
        UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: pre + '-tipo', texto: 'Tipo' + req }), tipo]),
        UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: pre + '-acionamento', texto: 'Data e hora do acionamento' + req }), acion]),
      ]),
      grupoOutro,
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: pre + '-endereco', texto: 'Endereço do local' }), endereco]),
      UI.el('div', { classe: 'grupo' }, [
        UI.el('span', { classe: 'rotulo', texto: 'Ponto no mapa' }),
        UI.el('div', { classe: 'linha-ponto' }, [coordInfo, btnLimpar]),
        UI.el('div', { classe: 'acoes-linha' }, [btnMapa, btnAqui]),
        coordTxt, coordAviso,
      ]),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: pre + '-descricao', texto: 'Descrição' }), desc]),
    ]);

    function ler() {
      var t = tipo.value;
      var dados = {
        tipo: t || null,
        tipo_outro: t === 'outras' ? outro.value.replace(/\s+/g, ' ').trim() : null,
        acionado_em: null,
        local_endereco: endereco.value.replace(/\s+/g, ' ').trim(),
        local_lat: local ? local.lat : null,
        local_lng: local ? local.lng : null,
        descricao: desc.value.trim(),
      };
      if (opcoes.obrigatorio && !t) { tipo.focus(); throw new Error('Escolha o tipo da operação.'); }
      if (t === 'outras' && !dados.tipo_outro) { outro.focus(); throw new Error('Em "Outras", descreva o tipo da operação.'); }
      if (acion.value) {
        var ms = new Date(acion.value).getTime();
        if (!isFinite(ms)) { acion.focus(); throw new Error('Data e hora do acionamento inválidas.'); }
        if (ms > Date.now() + 5 * 60000) { acion.focus(); throw new Error('A data e a hora do acionamento não podem estar no futuro.'); }
        dados.acionado_em = new Date(ms).toISOString();
      } else if (opcoes.obrigatorio) {
        acion.focus();
        throw new Error('Informe a data e a hora do acionamento.');
      }
      return dados;
    }

    function limpar() {
      tipo.value = '';
      outro.value = '';
      grupoOutro.hidden = true;
      acion.value = opcoes.agoraPadrao ? paraCampoData(Date.now()) : '';
      endereco.value = '';
      desc.value = '';
      coordTxt.value = '';
      coordAviso.textContent = '';
      local = null;
      mostrarLocal();
    }

    return { elemento: elemento, ler: ler, limpar: limpar };
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
    linha('Tipo', textoTipo(op) || '— não informado');
    linha('Acionamento', op.acionado_em ? dataHora(op.acionado_em) : '— não informado');
    linha('Endereço', op.local_endereco || '— não informado');
    linha('Ponto no mapa', op.local_lat != null ? window.Coords.formatar(op.local_lat, op.local_lng, 'dec') : '— não marcado');
    linha('Descrição', op.descricao || '—');
    if (op.gps_intervalo_s) linha('GPS', 'ponto pelo menos a cada ' + op.gps_intervalo_s + ' s · falha acima de ' + op.gps_lacuna_s + ' s sem ponto');
    linha('Criada', dataHora(op.criada_em));
    if (op.atualizado_por_nome) linha('Alterada', dataHora(op.atualizado_em) + ' por ' + op.atualizado_por_nome);
    var editavel = opcoes.editavel !== false;
    var fechar = UI.abrirModal(UI.el('div', { classe: 'detalhe-operacao' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Dados da operação' }),
      incompleto(op) ? UI.el('p', { classe: 'nota', texto: 'Cadastro incompleto: esta operação foi criada só com o nome. Toque em Editar para completar (tipo, acionamento, local e descrição).' }) : null,
      dl,
      UI.el('div', { classe: 'modal-acoes acoes-detalhe' }, [
        op.local_lat != null && opcoes.verNoMapa ? UI.el('button', { classe: 'btn', type: 'button', texto: 'Ver no mapa', onclick: function () { fechar(); opcoes.verNoMapa(op); } }) : null,
        editavel ? UI.el('button', { classe: 'btn', type: 'button', id: 'dados-editar', texto: 'Editar', onclick: function () { fechar(); editarDados(op, opcoes); } }) : null,
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]));
  }

  function editarDados(op, opcoes) {
    var nome = UI.el('input', { classe: 'campo', id: 'dados-nome', maxlength: '80', value: op.codigo });
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
      temGps ? UI.el('fieldset', { classe: 'grupo-gps' }, [
        UI.el('legend', { texto: 'Trilha GPS' }),
        UI.el('div', { classe: 'grupo-duplo' }, [
          UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'dados-gps-intervalo', texto: 'Ponto pelo menos a cada (s)' }), intervalo]),
          UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'dados-gps-lacuna', texto: 'Falha acima de (s sem ponto)' }), lacuna]),
        ]),
        UI.el('small', { classe: 'muted', texto: 'Andando ou de carro os pontos continuam mais frequentes. Intervalos maiores que o limite aparecem tracejados no mapa, com início e fim marcados.' }),
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
  async function abrirVitimas(op, opcoes) {
    opcoes = opcoes || {};
    var lista = UI.el('ul', { classe: 'lista-vitimas', id: 'lista-vitimas' });
    var vazio = UI.el('p', { classe: 'muted', id: 'vitimas-vazio', texto: 'Nenhuma ficha de vítima ainda.' });
    var editavel = opcoes.editavel !== false;
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
        lista.appendChild(UI.el('li', null, [UI.el('button', { classe: 'item-vitima', type: 'button', 'data-vitima': v.id, onclick: function () { fechar(); abrirFicha(op, v, opcoes); } }, [
          mini,
          UI.el('span', { classe: 'item-area-txt' }, [
            UI.el('strong', { texto: v.nome }),
            UI.el('small', { classe: 'muted', texto: textoIdade(v) + (v.roupas ? ' · ' + resumir(v.roupas, 60) : '') }),
          ]),
        ])]));
      });
    }
    var fechar = UI.abrirModal(UI.el('div', { classe: 'modal-vitimas' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Vítimas' }),
      UI.el('p', { classe: 'ajuda', texto: 'Só os responsáveis desta operação veem estas fichas. Civis e militares de campo não têm acesso.' }),
      lista,
      vazio,
      UI.el('div', { classe: 'modal-acoes' }, [
        editavel ? UI.el('button', { classe: 'btn btn-escuro', type: 'button', id: 'vitima-nova', texto: '＋ Nova ficha', onclick: function () { fechar(); editarFicha(op, null, opcoes); } }) : null,
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]), { aoFechar: function () { if (aberta && aberta.render === render) aberta = null; } });
    aberta = { op: op, render: render };
    render();
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
        UI.el('button', { classe: 'btn', type: 'button', texto: '◀ Fichas', onclick: function () { fechar(); abrirVitimas(op, opcoes); } }),
        editavel ? UI.el('button', { classe: 'btn', type: 'button', id: 'vitima-editar', texto: 'Editar', onclick: function () { fechar(); editarFicha(op, v, opcoes); } }) : null,
        editavel ? rotFoto : null,
        editavel ? inFoto : null,
        editavel && v.foto_caminho ? UI.el('button', { classe: 'btn', type: 'button', texto: 'Tirar foto', onclick: function () { fechar(); removerFoto(op, v, opcoes); } }) : null,
        editavel ? UI.el('button', { classe: 'btn btn-perigo', type: 'button', id: 'vitima-excluir', texto: 'Excluir', onclick: function () { fechar(); excluirFicha(op, v, opcoes); } }) : null,
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]));
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

  function editarFicha(op, v, opcoes) {
    var nova = !v;
    v = v || { nome: '', idade: null, caracteristicas: '', roupas: '', observacoes: '' };
    var nome = UI.el('input', { classe: 'campo', id: 'vitima-nome', maxlength: '80', value: v.nome, placeholder: 'Nome (ou "Não identificada")' });
    var idade = UI.el('input', { classe: 'campo', id: 'vitima-idade', type: 'number', min: '0', max: '130', step: '1', inputmode: 'numeric', value: v.idade == null ? '' : String(v.idade) });
    function area(id, max, valor, ph) { var a = UI.el('textarea', { classe: 'campo', id: id, maxlength: String(max), rows: '3', placeholder: ph || '' }); a.value = valor || ''; return a; }
    var carac = area('vitima-caracteristicas', 1000, v.caracteristicas, 'Altura, porte, cabelo, cor da pele, sinais, tatuagens, cicatrizes…');
    var roupas = area('vitima-roupas', 1000, v.roupas, 'Cores e tipo de roupa, calçado, acessórios, mochila…');
    var obs = area('vitima-observacoes', 2000, v.observacoes, 'Condição de saúde, medicamentos, último contato, hábitos, para onde iria…');
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'vitima-salvar', texto: nova ? 'Criar ficha' : 'Salvar' });
    var form = UI.el('form', { classe: 'form-vitima', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: nova ? 'Nova ficha de vítima' : 'Editar ficha' }),
      UI.el('div', { classe: 'grupo-duplo grupo-duplo-largo' }, [
        UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'vitima-nome', texto: 'Nome *' }), nome]),
        UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'vitima-idade', texto: 'Idade (anos)' }), idade]),
      ]),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'vitima-caracteristicas', texto: 'Características físicas' }), carac]),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'vitima-roupas', texto: 'Roupas' }), roupas]),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'vitima-observacoes', texto: 'Observações' }), obs]),
      nova ? UI.el('p', { classe: 'ajuda', texto: 'A foto pode ser adicionada depois de criar a ficha.' }) : null,
      erro,
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); if (!nova) abrirFicha(op, v, opcoes); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var dados = {
        nome: nome.value.replace(/\s+/g, ' ').trim(),
        idade: idade.value.trim() === '' ? null : Number(idade.value),
        caracteristicas: carac.value.trim(),
        roupas: roupas.value.trim(),
        observacoes: obs.value.trim(),
      };
      if (!dados.nome) { erro.textContent = 'Informe o nome da vítima (ou "Não identificada").'; erro.hidden = false; nome.focus(); return; }
      if (dados.idade != null && !(Number.isInteger(dados.idade) && dados.idade >= 0 && dados.idade <= 130)) {
        erro.textContent = 'Idade: um número inteiro de 0 a 130.'; erro.hidden = false; idade.focus(); return;
      }
      btn.disabled = true;
      try {
        var res = await C.rpc('salvar_vitima', { p_operacao: op.id, p_id: v.id || null, p_dados: dados });
        fechar(true);
        UI.aviso(nova ? 'Ficha de "' + res.nome + '" criada.' : 'Ficha salva.', 'ok');
        abrirFicha(op, res, opcoes);
      } catch (e) {
        erro.textContent = 'Não foi possível salvar: ' + e.message;
        erro.hidden = false;
        btn.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false });
  }

  async function enviarFoto(op, v, arquivo, opcoes) {
    if (arquivo.type && !/^image\//.test(arquivo.type)) { UI.aviso('Escolha um arquivo de imagem.', 'erro'); return; }
    UI.aviso('Preparando a foto…');
    var img;
    try {
      img = await window.Fotos.prepararImagem(arquivo);   // no máximo 1600 px, JPEG
    } catch (e) {
      UI.aviso('Não foi possível abrir esta imagem neste aparelho.', 'erro', 7000);
      return;
    }
    var caminho = op.id + '/' + v.id + '/' + C.uuid() + '.jpg';
    try {
      var up = await C.cliente.storage.from(BUCKET).upload(caminho, await img.blob.arrayBuffer(), { contentType: 'image/jpeg', upsert: false });
      if (up.error) throw C.criarErro(up.error);
      var res = await C.rpc('definir_foto_vitima', { p_vitima: v.id, p_caminho: caminho }, 20000);
      if (opcoes.limparArquivos) opcoes.limparArquivos();   // apaga a foto anterior (se havia)
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
      abrirVitimas(op, opcoes);
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
    escolherPontoNoMapa: escolherPontoNoMapa,
    abrirDados: abrirDados,
    abrirVitimas: abrirVitimas,
    aoMudarVitimas: aoMudarVitimas,
  };
})();
