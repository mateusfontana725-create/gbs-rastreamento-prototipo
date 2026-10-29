// Mapa do responsável menos poluído em operações grandes.
//  1) Nível de detalhe pelo zoom: de longe só os símbolos (e quem pede atenção);
//     no meio, os nomes sem o "há X min"; de perto, tudo. A fonte também acompanha.
//  2) Rótulos que se sobrepõem: fica o mais importante; os outros somem até haver
//     espaço (passar o mouse ou tocar no marcador mostra o nome escondido).
//  3) Pessoas próximas se agrupam de longe (um círculo com o número e as cores dos
//     grupos). Quem pede ajuda, quer sair, está selecionado ou é você nunca entra no grupo.
(function (raiz) {
  'use strict';

  var ZOOM_MEDIO = 15;   // a partir daqui aparecem os nomes
  var ZOOM_PERTO = 17;   // a partir daqui aparece tudo (idade da posição, situação do setor)
  var ZOOM_SEM_AGRUPAR = 19;   // a partir daqui (escala de ~25 m) ninguém fica agrupado; de 200 m e de 100 m ainda agrupa
  var NIVEIS = ['zoom-longe', 'zoom-medio', 'zoom-perto'];

  // Tamanho dos símbolos pelo zoom (1 = tamanho cheio): de longe tudo diminui para o mapa não ficar
  // coberto de ícones, e de muito perto (escala de 100 m para menos, zoom 17 em diante) diminui de novo,
  // porque o mapa já mostra pouco chão e os ícones grandes cobririam o que se quer ver.
  // Vai na variável CSS --esc-mapa. O tamanho cheio fica por volta da escala de 200 m (zoom 16).
  function escalaDoZoom(z) {
    return z >= 20 ? 0.5 : z >= 19 ? 0.58 : z >= 18 ? 0.68 : z >= 17 ? 0.8 : z >= 16 ? 0.9 : z >= 15 ? 0.76 : z >= 14 ? 0.66 : z >= 13 ? 0.58 : 0.52;
  }

  function nivelDoZoom(z) {
    return z >= ZOOM_PERTO ? 'zoom-perto' : z >= ZOOM_MEDIO ? 'zoom-medio' : 'zoom-longe';
  }

  // Quem pede atenção: o rótulo aparece sempre e fica fora do agrupamento.
  var CLASSES_DESTAQUE = ['ajuda', 'saida', 'selecionado', 'eu'];
  function ehDestaque(classes) {
    var c = ' ' + String(classes || '') + ' ';
    return CLASSES_DESTAQUE.some(function (x) { return c.indexOf(' ' + x + ' ') >= 0; });
  }

  // Prioridade de cada rótulo (maior fica). Infinity = nunca esconde.
  var POI_IMPORTANTE = ['poi-VITIMA_ENCONTRADA', 'poi-RISCO', 'poi-BASE', 'poi-ULTIMA_LOCALIZACAO'];
  function prioridade(no) {
    if (no.classList.contains('mk-rotulo')) {
      var mk = no.parentNode;
      if (mk && ehDestaque(mk.className)) return Infinity;
      return mk && mk.classList.contains('antigo') ? 55 : 60;
    }
    if (no.classList.contains('mk-poi-rotulo')) {
      var placa = no.previousElementSibling;
      var imp = placa && POI_IMPORTANTE.some(function (c) { return placa.classList.contains(c); });
      return imp ? 70 : 45;
    }
    if (no.classList.contains('rotulo-setor')) return 40;
    return 10;   // local da operação e outros
  }

  var SEL_ROTULOS = '.mk-rotulo, .mk-poi-rotulo, .leaflet-tooltip.rotulo-setor, .mk-local-rotulo';
  // símbolos que um rótulo não pode cobrir (o de outro marcador)
  var SEL_SIMBOLOS = '.mk .simbolo, .mk-poi, .mk-relato, .mk-foto, .cluster, .cluster-pessoas, .mk-local';

  function cruza(a, b, folga) {
    return a.left < b.right + folga && b.left < a.right + folga && a.top < b.bottom + folga && b.top < a.bottom + folga;
  }
  function visivel(r) { return r.width > 0 && r.height > 0; }

  // Posições alternativas do rótulo (classe CSS → deslocamento em relação à posição normal, à direita).
  // dx em função da largura do próprio rótulo: o rótulo passa para o outro lado do símbolo.
  var POSICOES = {
    pessoa: [['', 0, 0], ['rot-esq', 'esq', 0], ['rot-acima', 0, -20], ['rot-abaixo', 0, 20]],
    ponto: [['', 0, 0], ['rot-esq', 'esq', 0], ['rot-acima', 0, -20]],
    setor: [['', 0, 0], ['rot-acima', 0, -24], ['rot-abaixo', 0, 24]],
  };
  var CLASSES_POS = ['rot-esq', 'rot-acima', 'rot-abaixo'];
  function deslocado(r, dx, dy) {
    if (dx === 'esq') dx = -(r.width + 32);
    return { left: r.left + dx, right: r.right + dx, top: r.top + dy, bottom: r.bottom + dy };
  }

  // Coloca os rótulos do mais importante para o menos: cada um tenta a posição normal e as
  // alternativas; se todas cobrem um rótulo já posto ou o símbolo de outro marcador, some
  // (visibility). Devolve quantos ficaram escondidos.
  function resolver(container) {
    if (!container) return 0;
    var limite = container.getBoundingClientRect();
    var nos = Array.prototype.slice.call(container.querySelectorAll(SEL_ROTULOS));
    nos.forEach(function (no) { CLASSES_POS.forEach(function (c) { if (no.classList.contains(c)) no.classList.remove(c); }); });
    var rotulos = nos.map(function (no, i) {
      var tipo = no.classList.contains('mk-rotulo') ? 'pessoa' : no.classList.contains('mk-poi-rotulo') ? 'ponto' : no.classList.contains('rotulo-setor') ? 'setor' : null;
      return { no: no, r: no.getBoundingClientRect(), p: prioridade(no), i: i, tipo: tipo, dono: no.closest('.leaflet-marker-icon') };
    }).filter(function (x) { return visivel(x.r) && cruza(x.r, limite, 0); });
    var simbolos = Array.prototype.map.call(container.querySelectorAll(SEL_SIMBOLOS), function (no) {
      return { r: no.getBoundingClientRect(), dono: no.closest('.leaflet-marker-icon') };
    }).filter(function (x) { return visivel(x.r) && cruza(x.r, limite, 0); });
    rotulos.sort(function (a, b) { return b.p - a.p || a.i - b.i; });
    var postos = [], escondidos = 0;
    rotulos.forEach(function (x) {
      var setor = x.no.classList.contains('rotulo-setor');   // fica abaixo dos marcadores: só disputa com rótulos
      function livre(r) {
        return !postos.some(function (o) { return cruza(r, o, 2); }) &&
          (setor || !simbolos.some(function (s) { return s.dono !== x.dono && cruza(r, s.r, 0); }));
      }
      var escolha = null;
      if (x.p === Infinity) escolha = ['', x.r];
      else {
        (POSICOES[x.tipo] || [['', 0, 0]]).some(function (pos) {
          var r = pos[0] ? deslocado(x.r, pos[1], pos[2]) : x.r;
          if (livre(r)) { escolha = [pos[0], r]; return true; }
          return false;
        });
      }
      var bate = !escolha;
      if (x.no.classList.contains('rotulo-colide') !== bate) x.no.classList.toggle('rotulo-colide', bate);
      if (bate) { escondidos++; return; }
      if (escolha[0]) x.no.classList.add(escolha[0]);
      postos.push(escolha[1]);
    });
    return escondidos;
  }

  // Liga o nível pelo zoom e a resolução de sobreposições a um mapa Leaflet.
  function instalar(mapa) {
    var el = mapa.getContainer();
    var espera = null;
    el.classList.add('mapa-adaptativo');
    function aplicarNivel() {
      var nivel = nivelDoZoom(mapa.getZoom());
      NIVEIS.forEach(function (n) { el.classList.toggle(n, n === nivel); });
      el.style.setProperty('--esc-mapa', String(escalaDoZoom(mapa.getZoom())));
    }
    function agendar() {
      if (espera) clearTimeout(espera);
      espera = setTimeout(function () {
        espera = null;
        // no meio da animação do zoom ou do agrupamento os ícones ainda estão se movendo: espera
        var painel = mapa.getPane('mapPane');
        if (mapa._animatingZoom || (painel && painel.classList.contains('leaflet-cluster-anim'))) agendar();
        else resolver(el);
      }, 120);
    }
    // depois do zoom os ícones ainda deslizam um pouco (animação do agrupamento): confere de novo
    mapa.on('zoomend', function () { aplicarNivel(); agendar(); setTimeout(agendar, 450); setTimeout(agendar, 900); });
    mapa.on('moveend layeradd layerremove tooltipopen resize', agendar);
    // o tamanho dos rótulos muda sem evento do mapa (fonte carregada, "há X min" atualizado)
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', agendar);
    setInterval(function () { if (!document.hidden) agendar(); }, 5000);
    aplicarNivel();
    agendar();
    return { agendar: agendar, resolver: function () { return resolver(el); }, nivel: function () { return nivelDoZoom(mapa.getZoom()); } };
  }

  // Agrupamento de pessoas próximas (Leaflet.markercluster). Cada marcador informa a sua cor
  // em options.corAgrupado e o nome em options.alt. Sem a biblioteca: camada simples.
  function criarGrupoPessoas(L) {
    if (!L.markerClusterGroup) return L.featureGroup();
    return L.markerClusterGroup({
      maxClusterRadius: 40,
      disableClusteringAtZoom: ZOOM_SEM_AGRUPAR,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: false,
      zoomToBoundsOnClick: true,
      iconCreateFunction: function (grupo) { return iconeGrupo(L, grupo.getAllChildMarkers()); },
    });
  }

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Anel com a proporção das cores (grupos) de quem está no grupo; o número no meio.
  function fatiasDeCor(cores) {
    var cont = {}, ordem = [];
    cores.forEach(function (c) { if (!cont[c]) { cont[c] = 0; ordem.push(c); } cont[c]++; });
    var total = cores.length, acc = 0;
    return ordem.map(function (c) {
      var ini = acc; acc += cont[c] / total * 360;
      return c + ' ' + ini.toFixed(1) + 'deg ' + acc.toFixed(1) + 'deg';
    }).join(', ');
  }

  function iconeGrupo(L, marcadores) {
    var cores = marcadores.map(function (m) { return m.options.corAgrupado || '#64748b'; });
    var nomes = marcadores.map(function (m) { return m.options.alt || ''; }).filter(Boolean).sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); });
    var dica = marcadores.length + ' pessoas aqui: ' + nomes.slice(0, 8).join(', ') + (nomes.length > 8 ? ' e mais ' + (nomes.length - 8) : '') + '. Toque para aproximar.';
    var tam = marcadores.length >= 20 ? 44 : marcadores.length >= 8 ? 40 : 36;
    return L.divIcon({
      className: 'cluster-wrap cluster-pessoas-wrap',
      html: '<div class="cluster-pessoas" style="width:' + tam + 'px;height:' + tam + 'px;background:conic-gradient(' + fatiasDeCor(cores) + ')" title="' + esc(dica) + '">' +
        '<b>' + marcadores.length + '</b></div>',
      iconSize: [tam, tam],
      iconAnchor: [tam / 2, tam / 2],
    });
  }

  raiz.MapaRotulos = {
    instalar: instalar, resolver: resolver, nivelDoZoom: nivelDoZoom, escalaDoZoom: escalaDoZoom, ehDestaque: ehDestaque,
    criarGrupoPessoas: criarGrupoPessoas, fatiasDeCor: fatiasDeCor,
    ZOOM_MEDIO: ZOOM_MEDIO, ZOOM_PERTO: ZOOM_PERTO, ZOOM_SEM_AGRUPAR: ZOOM_SEM_AGRUPAR,
  };
})(typeof window !== 'undefined' ? window : globalThis);
