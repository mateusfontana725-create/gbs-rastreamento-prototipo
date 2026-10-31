/* =====================================================================
 * icones.js — catálogo de ícones para pontos, tipos de ponto e grupos, e o seletor (UI.seletorIcone).
 *   Ícone = um emoji ou até 8 letras/números/símbolos. Nada fixo: o seletor abre o catálogo inteiro
 *   (por assunto, com busca por palavra) e aceita qualquer coisa digitada.
 *   Cada item: [ícone, palavras para a busca].
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var CATEGORIAS = [
    { nome: 'Resgate e emergência', itens: [
      ['🚒', 'bombeiro caminhão viatura'], ['🚑', 'ambulância samu socorro'], ['🚓', 'polícia viatura'], ['🚁', 'helicóptero aeronave pouso heliponto'],
      ['🛟', 'boia salva-vidas resgate aquático'], ['🧯', 'extintor incêndio'], ['⛑️', 'capacete resgate socorro'], ['🩺', 'médico estetoscópio saúde'],
      ['🩹', 'curativo ferido'], ['💉', 'seringa medicação'], ['🏥', 'hospital'], ['⚕️', 'saúde médico'], ['🆘', 'socorro sos ajuda'],
      ['🚨', 'sirene alerta emergência'], ['🔥', 'fogo incêndio queimada'], ['💥', 'explosão colisão'], ['⚠️', 'atenção perigo risco cuidado'],
      ['☢️', 'radiação perigo'], ['☣️', 'risco biológico'], ['🚧', 'obra bloqueio interdição'], ['⛔', 'proibido entrada'], ['🚫', 'proibido não'],
      ['🛑', 'pare stop'], ['🔔', 'alarme sino'], ['📢', 'aviso megafone'], ['🪢', 'corda nó'], ['🧗', 'escalada rapel altura'], ['🪜', 'escada'],
      ['🔦', 'lanterna'], ['🧭', 'bússola orientação'], ['🗺️', 'mapa'], ['📍', 'local alfinete marcador'], ['📌', 'tachinha marcador'],
      ['🚩', 'bandeira marco'], ['🏁', 'chegada bandeira'], ['🎯', 'alvo objetivo'], ['🧰', 'caixa ferramentas equipamento'], ['🪓', 'machado'],
      ['⛏️', 'picareta escavação'], ['🔨', 'martelo'], ['🪚', 'serra'], ['🧲', 'ímã'], ['⚡', 'energia elétrica raio'],
    ] },
    { nome: 'Pessoas', itens: [
      ['🧍', 'pessoa em pé'], ['🚶', 'pessoa andando caminhando'], ['🏃', 'correndo'], ['🧎', 'ajoelhado'], ['🧑‍🚒', 'bombeiro'], ['👮', 'policial'],
      ['🧑‍⚕️', 'socorrista médico enfermeiro'], ['🪖', 'militar capacete exército'], ['👷', 'trabalhador operário'], ['👴', 'idoso'], ['👵', 'idosa'],
      ['🧒', 'criança'], ['👶', 'bebê'], ['🧑‍🦯', 'deficiente visual bengala'], ['🧑‍🦽', 'cadeira de rodas'], ['👥', 'grupo equipe pessoas'],
      ['👣', 'pegadas rastro pés'], ['🙋', 'pessoa acenando'], ['🤕', 'ferido machucado'], ['🛌', 'pessoa deitada abrigo'], ['🧘', 'pessoa sentada'],
      ['🫂', 'abraço família'], ['👤', 'silhueta pessoa'], ['🗣️', 'testemunha fala'], ['👁️', 'avistamento olho visto'],
    ] },
    { nome: 'Animais', itens: [
      ['🐕', 'cão cachorro'], ['🐕‍🦺', 'cão de serviço busca faro k9'], ['🐾', 'rastro patas animal'], ['🐈', 'gato'], ['🐎', 'cavalo'],
      ['🐄', 'vaca gado'], ['🐖', 'porco'], ['🐍', 'cobra serpente'], ['🦂', 'escorpião'], ['🐝', 'abelha enxame'], ['🦟', 'mosquito'],
      ['🐊', 'jacaré'], ['🦈', 'tubarão'], ['🐟', 'peixe'], ['🦅', 'águia ave'], ['🐦', 'pássaro'], ['🕷️', 'aranha'], ['🐗', 'javali'],
    ] },
    { nome: 'Veículos', itens: [
      ['🚗', 'carro automóvel'], ['🚙', 'carro utilitário suv'], ['🛻', 'caminhonete picape'], ['🚚', 'caminhão'], ['🚛', 'carreta'],
      ['🚌', 'ônibus'], ['🏍️', 'moto motocicleta'], ['🛵', 'moto scooter'], ['🚲', 'bicicleta'], ['🚜', 'trator'], ['🚂', 'trem'],
      ['🛶', 'canoa caiaque'], ['🚤', 'lancha'], ['⛵', 'veleiro barco'], ['🛥️', 'barco motor'], ['🚢', 'navio'], ['✈️', 'avião'],
      ['🛩️', 'avião pequeno'], ['🛸', 'drone objeto voador'], ['🪂', 'paraquedas'], ['🚀', 'foguete'], ['🛞', 'pneu roda'],
      ['🅿️', 'estacionamento'], ['⛽', 'combustível posto'], ['🔋', 'bateria'], ['🚏', 'ponto de ônibus parada'],
    ] },
    { nome: 'Terreno e natureza', itens: [
      ['⛰️', 'montanha morro serra'], ['🏔️', 'montanha neve pico'], ['🌋', 'vulcão'], ['🏕️', 'acampamento'], ['⛺', 'barraca acampamento base'],
      ['🌲', 'mata floresta pinheiro'], ['🌳', 'árvore'], ['🌴', 'palmeira'], ['🌾', 'plantação lavoura capim'], ['🌵', 'cacto'],
      ['🪨', 'pedra rocha'], ['🕳️', 'buraco poço caverna'], ['🍄', 'cogumelo'], ['🌿', 'vegetação mato'], ['🏞️', 'parque rio paisagem'],
      ['🏜️', 'deserto areia'], ['🌧️', 'chuva'], ['⛈️', 'tempestade'], ['🌩️', 'raio'], ['🌪️', 'tornado vendaval'], ['🌫️', 'neblina'],
      ['❄️', 'frio neve'], ['☀️', 'sol calor'], ['🌙', 'noite lua'], ['🌬️', 'vento'],
    ] },
    { nome: 'Água', itens: [
      ['🌊', 'água onda rio mar correnteza'], ['💧', 'água gota ponto de água'], ['🚣', 'remo barco'], ['🏊', 'nadador natação'], ['🤿', 'mergulho mergulhador'],
      ['⚓', 'âncora'], ['🌉', 'ponte'], ['🏝️', 'ilha'], ['🏖️', 'praia'], ['🚰', 'água potável torneira'], ['🧊', 'gelo'], ['🫗', 'vazamento'],
    ] },
    { nome: 'Construções e vias', itens: [
      ['🏠', 'casa residência'], ['🏚️', 'casa abandonada ruína'], ['🛖', 'cabana'], ['🏢', 'prédio edifício'], ['🏫', 'escola'],
      ['🏭', 'fábrica indústria'], ['🏛️', 'prefeitura órgão público'], ['⛪', 'igreja'], ['🏪', 'loja comércio mercado'], ['🏨', 'hotel'],
      ['🏗️', 'obra construção'], ['🧱', 'muro parede'], ['🚪', 'porta entrada'], ['🗼', 'torre antena'], ['🛣️', 'estrada rodovia'],
      ['🛤️', 'ferrovia trilho'], ['🏟️', 'estádio ginásio'], ['⛲', 'praça fonte'], ['🏡', 'chácara sítio'], ['🌁', 'ponte neblina'],
      ['🚻', 'banheiro'], ['🍽️', 'alimentação refeição'], ['🛏️', 'alojamento descanso dormitório'],
    ] },
    { nome: 'Objetos e vestígios', itens: [
      ['🎒', 'mochila'], ['👕', 'camiseta roupa'], ['👖', 'calça'], ['👗', 'vestido'], ['🧥', 'casaco jaqueta'], ['👟', 'tênis calçado'],
      ['🥾', 'bota'], ['🩴', 'chinelo'], ['🧢', 'boné'], ['👒', 'chapéu'], ['🧤', 'luva'], ['🧣', 'cachecol'], ['👓', 'óculos'],
      ['📱', 'celular telefone'], ['👜', 'bolsa'], ['💼', 'pasta'], ['🔑', 'chave'], ['⌚', 'relógio'], ['💍', 'anel'], ['🧸', 'brinquedo pelúcia'],
      ['🍼', 'mamadeira'], ['☂️', 'guarda-chuva'], ['🪪', 'documento identidade'], ['📄', 'papel documento'], ['💊', 'remédio'],
      ['🩸', 'sangue'], ['🦴', 'osso'], ['🔪', 'faca'], ['🚬', 'cigarro'], ['🍶', 'garrafa'], ['🥫', 'lata'], ['📦', 'caixa pacote'],
      ['🧴', 'frasco'], ['🕯️', 'vela'], ['🧵', 'linha fio'], ['🪵', 'madeira tronco'],
    ] },
    { nome: 'Equipamento e comunicação', itens: [
      ['📡', 'antena rádio comunicação'], ['📻', 'rádio'], ['📶', 'sinal celular'], ['📵', 'sem sinal'], ['🔌', 'tomada energia'], ['💡', 'luz iluminação'],
      ['🔭', 'binóculo observação luneta'], ['📷', 'câmera foto'], ['🎥', 'filmagem vídeo'], ['🖥️', 'computador posto de comando'], ['📟', 'pager'],
      ['🛰️', 'satélite gps'], ['🌡️', 'termômetro temperatura'], ['⏱️', 'cronômetro tempo'], ['🧪', 'amostra'], ['🪫', 'bateria fraca'],
    ] },
    { nome: 'Sinais e símbolos', itens: [
      ['❗', 'exclamação importante'], ['❓', 'interrogação dúvida possível'], ['✅', 'ok confirmado concluído'], ['❌', 'não descartado'], ['⭐', 'estrela destaque'],
      ['★', 'estrela'], ['⚑', 'bandeira'], ['✚', 'cruz socorro'], ['✝️', 'cruz óbito'], ['♿', 'acessibilidade'], ['ℹ️', 'informação'], ['➜', 'seta direção'],
      ['⬆️', 'norte cima'], ['⬇️', 'baixo sul'], ['⬅️', 'esquerda oeste'], ['➡️', 'direita leste'], ['🔄', 'retorno'], ['🔁', 'repetir ronda'],
      ['●', 'ponto círculo'], ['■', 'quadrado'], ['▲', 'triângulo'], ['◆', 'losango'], ['✖', 'xis'], ['✔', 'certo'], ['◎', 'alvo círculo duplo'],
      ['🔴', 'vermelho'], ['🟠', 'laranja'], ['🟡', 'amarelo'], ['🟢', 'verde'], ['🔵', 'azul'], ['🟣', 'roxo'], ['⚫', 'preto'], ['⚪', 'branco'],
      ['🔺', 'triângulo vermelho'], ['🔶', 'losango laranja'], ['🟥', 'quadrado vermelho'], ['🟩', 'quadrado verde'],
    ] },
    { nome: 'Letras e números', itens: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').map(function (c) { return [c, 'letra número ' + c.toLowerCase()]; })
      .concat([['B1', 'base 1'], ['B2', 'base 2'], ['PC', 'posto de comando'], ['ACV', 'área de concentração de vítimas'], ['E1', 'equipe 1'], ['E2', 'equipe 2'], ['HP', 'heliponto pouso']]) },
  ];

  function semAcento(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

  // Busca por palavra (sem acento); vazio = todos. Devolve [ícone, palavras, categoria].
  function buscar(q) {
    var termos = semAcento(q).split(/\s+/).filter(Boolean);
    var out = [];
    CATEGORIAS.forEach(function (c) {
      c.itens.forEach(function (it) {
        // cada termo casa com o começo de uma palavra ("cão" acha cão, não "atenção")
        var palavras = semAcento(it[1] + ' ' + c.nome).split(/[\s-]+/);
        if (termos.every(function (t) { return palavras.some(function (w) { return w.indexOf(t) === 0; }); })) out.push([it[0], it[1], c.nome]);
      });
    });
    return out;
  }

  // Ícone válido: 1 a 8 caracteres (como o banco aceita), sem espaços nas pontas.
  function normalizar(v) {
    var t = String(v == null ? '' : v).trim();
    return t && Array.from(t).length <= 8 && t.length <= 16 ? t : null;
  }

  var API = { CATEGORIAS: CATEGORIAS, buscar: buscar, normalizar: normalizar };
  if (typeof module === 'object' && module.exports) { module.exports = API; return; }
  raiz.Icones = API;

  var UI = raiz.UI;
  if (!UI || !raiz.document) return;
  var el = UI.el;

  // Catálogo inteiro numa janela por cima: busca, assuntos e "digite o seu". aoEscolher(ícone)
  function abrirCatalogo(atual, aoEscolher) {
    var busca = el('input', { classe: 'campo', id: 'icones-busca', type: 'search', placeholder: 'Buscar (ex.: cão, barco, base, ferido)', autocomplete: 'off' });
    var livre = el('input', { classe: 'campo icones-livre', id: 'icones-livre', maxlength: '8', placeholder: 'Ou digite', value: atual || '', 'aria-label': 'Ícone digitado (letra, número ou emoji)' });
    var abas = el('div', { classe: 'icones-abas', role: 'tablist' });
    var grade = el('div', { classe: 'icones-grade', role: 'listbox', 'aria-label': 'Ícones' });
    var cat = null;
    function escolher(ic) { fechar(); aoEscolher(ic); }
    function desenhar() {
      grade.innerHTML = '';
      var q = busca.value.trim();
      var lista = q ? buscar(q) : CATEGORIAS.filter(function (c) { return !cat || c.nome === cat; }).reduce(function (a, c) {
        return a.concat(c.itens.map(function (it) { return [it[0], it[1], c.nome]; }));
      }, []);
      var ultimaCat = null;
      lista.forEach(function (it) {
        if (!q && !cat && it[2] !== ultimaCat) { ultimaCat = it[2]; grade.appendChild(el('div', { classe: 'icones-titulo', texto: it[2] })); }
        grade.appendChild(el('button', { classe: 'icones-item' + (it[0] === atual ? ' marcado' : ''), type: 'button', role: 'option', title: it[1],
          'aria-label': it[0] + ' — ' + it[1], 'data-icone': it[0], onclick: function () { escolher(it[0]); } }, [el('span', { texto: it[0] })]));
      });
      if (!lista.length) grade.appendChild(el('p', { classe: 'muted', texto: 'Nada encontrado. Digite o ícone no campo "Ou digite".' }));
      Array.prototype.forEach.call(abas.children, function (b) { b.setAttribute('aria-selected', String((b.getAttribute('data-cat') || null) === cat && !q)); });
    }
    abas.appendChild(el('button', { classe: 'icones-aba', type: 'button', role: 'tab', texto: 'Todos', onclick: function () { cat = null; busca.value = ''; desenhar(); } }));
    CATEGORIAS.forEach(function (c) {
      abas.appendChild(el('button', { classe: 'icones-aba', type: 'button', role: 'tab', 'data-cat': c.nome, texto: c.nome, onclick: function () { cat = c.nome; busca.value = ''; desenhar(); } }));
    });
    busca.addEventListener('input', desenhar);
    var usar = el('button', { classe: 'btn btn-escuro', type: 'button', id: 'icones-usar', texto: 'Usar o digitado', onclick: function () {
      var v = normalizar(livre.value);
      if (!v) { UI.aviso('Digite de 1 a 8 caracteres (letra, número ou emoji).', 'erro'); livre.focus(); return; }
      escolher(v);
    } });
    livre.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); usar.click(); } });
    var fechar = UI.abrirModal(el('div', { classe: 'icones-catalogo' }, [
      el('h2', { id: 'modal-titulo', texto: 'Escolher ícone' }),
      UI.dica('Toque num ícone para usar. Também vale qualquer letra, sigla ou emoji digitado (até 8 caracteres).'),
      el('div', { classe: 'icones-topo' }, [busca, el('div', { classe: 'icones-livre-linha' }, [livre, usar])]),
      abas,
      grade,
      UI.rodape([el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } })]),
    ]), { empilhar: true, tamanho: 'largo' });
    desenhar();
    setTimeout(function () { busca.focus(); }, 30);
  }

  // o: { rotulo, valor, aoMudar(ícone), cor (fundo da prévia), vazio (texto quando não há ícone; com ele, dá para tirar o ícone) }
  // Devolve o elemento; .valor() devolve o ícone escolhido (ou null).
  UI.seletorIcone = function (o) {
    o = o || {};
    var atual = normalizar(o.valor);
    var previa = el('span', { classe: 'icone-previa', 'aria-hidden': 'true' });
    var botao = el('button', { classe: 'btn icone-escolher', type: 'button', id: o.id || null, title: 'Abrir todos os ícones' }, [previa, el('span', { classe: 'icone-escolher-txt', texto: 'Escolher ícone' })]);
    var tirar = o.vazio ? el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Sem ícone', onclick: function () { definir(null); } }) : null;
    var caixa = el('div', { classe: 'icone-seletor', role: 'group', 'aria-label': o.rotulo || 'Ícone' }, [botao, tirar]);
    function pintar() {
      previa.textContent = atual || (o.vazio ? '—' : '•');
      if (o.cor) { previa.style.background = o.cor; previa.style.color = raiz.Cores ? raiz.Cores.textoSobre(o.cor) : '#fff'; }
      if (tirar) tirar.hidden = !atual;
    }
    function definir(v) { atual = v; pintar(); if (o.aoMudar) o.aoMudar(atual); }
    botao.addEventListener('click', function () { abrirCatalogo(atual, definir); });
    pintar();
    caixa.valor = function () { return atual; };
    caixa.definirCor = function (c) { o.cor = c; pintar(); };
    return caixa;
  };
  UI.abrirCatalogoIcones = abrirCatalogo;
})(typeof window !== 'undefined' ? window : globalThis);
