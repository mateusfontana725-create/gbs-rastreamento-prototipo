/* =====================================================================
 * mapa-resumo.js — agrupamento ÚNICO do mapa quando se está longe.
 *
 *   O mapa tem camadas que agrupam cada uma o que é seu: pessoas (js/mapa-rotulos.js) e pontos, relatos e fotos
 *   (militar.js). Cada camada não enxerga a outra: de longe sobram vários "grupos" no mesmo lugar, empilhados, com as
 *   etiquetas de vítima e de quem pede ajuda uma por cima da outra.
 *
 *   Aqui, até o zoom do nível "longe" (14, o mesmo do mapa-rotulos.js), tudo é agrupado JUNTO, por distância na tela,
 *   e cada região vira UM selo, com pessoas e pontos lado a lado:
 *       [ (14) ▢8 ]  +3 (vítimas, verde)  ! (alerta, vermelho)   etiquetas: "3 VÍTIMAS" / "2 PEDEM AJUDA"
 *   Quem está sozinho continua igual ao de antes (mesmo ícone, mesmo clique, toque longo e balão). De perto
 *   (zoom 15 em diante) este módulo não faz nada e valem os agrupamentos de sempre.
 *
 *   Os agrupamentos de sempre continuam existindo por baixo: o resumo só os esconde (CSS, classe "mapa-resumo")
 *   e desenha por cima, numa camada própria. Nada é apagado nem movido.
 *   O núcleo (agrupar, resumir, htmlResumo) não depende do navegador e é testado no Node (testes/mapa_resumo.test.js).
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var RAIO_PX = 56;          // dois símbolos a menos disso na tela viram um só
  var RAIO_VITIMA_M = 30;    // relato e ponto da mesma vítima (a menos de 30 m) contam como uma só
  var TEMPO_VERIFICAR_MS = 1500;
  var EVENTOS_REPASSADOS = ['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'mouseout'];
  var COR_PONTO = { poi: '#38bdf8', relato: '#f97316', foto: '#a855f7', verif: '#fbbf24', import: '#84cc16' };
  var ORDEM_PONTO = ['poi', 'relato', 'foto', 'verif', 'import'];
  var ROTULO_PONTO = {
    poi: ['ponto de interesse', 'pontos de interesse'], relato: ['relato', 'relatos'], foto: ['foto', 'fotos'],
    verif: ['indicação a verificar', 'indicações a verificar'], import: ['ponto importado', 'pontos importados'],
  };

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- núcleo (sem navegador) ------------------------------------ */

  // Distância aproximada em metros entre dois pontos {lat, lng} (suficiente para menos de poucos km)
  function distanciaM(a, b) {
    var rad = Math.PI / 180, R = 6371000;
    var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
    return Math.sqrt(dLat * dLat + dLng * dLng) * R;
  }

  // Agrupa itens {x, y, ...} (posição em pixels) cujos centros ficam a menos de "raio" um do outro.
  // Devolve [{ x, y, itens: [...] }] com (x, y) no centro do grupo. Depois de agrupar, funde os grupos que ficaram
  // perto demais (o centro anda ao juntar), para nenhum selo cobrir outro.
  function agrupar(itens, raio) {
    raio = raio || RAIO_PX;
    var ordenados = itens.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    var grupos = [];
    function dist(g, i) { var dx = g.x - i.x, dy = g.y - i.y; return Math.sqrt(dx * dx + dy * dy); }
    ordenados.forEach(function (i) {
      var melhor = null, d = Infinity;
      for (var k = 0; k < grupos.length; k++) {
        var dk = dist(grupos[k], i);
        if (dk < d) { d = dk; melhor = grupos[k]; }
      }
      if (melhor && d <= raio) {
        var n = melhor.itens.length;
        melhor.x = (melhor.x * n + i.x) / (n + 1);
        melhor.y = (melhor.y * n + i.y) / (n + 1);
        melhor.itens.push(i);
      } else {
        grupos.push({ x: i.x, y: i.y, itens: [i] });
      }
    });
    var mudou = true, voltas = 0;
    while (mudou && voltas++ < 20) {
      mudou = false;
      for (var a = 0; a < grupos.length && !mudou; a++) {
        for (var b = a + 1; b < grupos.length; b++) {
          if (dist(grupos[a], grupos[b]) <= raio) {
            var ga = grupos[a], gb = grupos[b], na = ga.itens.length, nb = gb.itens.length;
            ga.x = (ga.x * na + gb.x * nb) / (na + nb);
            ga.y = (ga.y * na + gb.y * nb) / (na + nb);
            ga.itens = ga.itens.concat(gb.itens);
            grupos.splice(b, 1);
            mudou = true;
            break;
          }
        }
      }
    }
    return grupos;
  }

  // O que o selo mostra: contagens por família. Item: { familia: 'pessoa'|'ponto', cor, nome, ajuda, saida,
  // tipo, critico, vitima, lat, lng }.
  function resumir(itens) {
    var r = { total: itens.length, pessoas: 0, pontos: 0, porTipo: {}, coresPessoas: [], ajuda: 0, saida: 0, criticos: 0, vitimas: 0 };
    var vitimas = [];
    itens.forEach(function (i) {
      if (i.familia === 'pessoa') {
        r.pessoas++;
        r.coresPessoas.push(i.cor || '#64748b');
        if (i.ajuda) r.ajuda++;
        if (i.saida) r.saida++;
      } else {
        r.pontos++;
        var t = ORDEM_PONTO.indexOf(i.tipo) >= 0 ? i.tipo : 'poi';
        r.porTipo[t] = (r.porTipo[t] || 0) + 1;
        if (i.critico) r.criticos++;
        if (i.vitima) vitimas.push(i);
      }
    });
    // relato e ponto da mesma vítima contam como uma só
    r.vitimas = vitimas.filter(function (v, k) { return !vitimas.slice(0, k).some(function (o) { return distanciaM(o, v) < RAIO_VITIMA_M; }); }).length;
    r.alertas = r.ajuda + r.saida + r.criticos;
    return r;
  }

  // Anel com a proporção das cores (mesma regra do mapa-rotulos.js)
  function fatiasDeCor(cores) {
    var cont = {}, ordem = [];
    cores.forEach(function (c) { if (!cont[c]) { cont[c] = 0; ordem.push(c); } cont[c]++; });
    var total = cores.length, acc = 0;
    return ordem.map(function (c) {
      var ini = acc; acc += cont[c] / total * 360;
      return c + ' ' + ini.toFixed(1) + 'deg ' + acc.toFixed(1) + 'deg';
    }).join(', ');
  }

  function plural(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }

  // Texto do balão (title): tudo que o selo resume
  function textoResumo(r) {
    var p = [];
    if (r.pessoas) p.push(plural(r.pessoas, 'pessoa', 'pessoas'));
    if (r.vitimas) p.push(plural(r.vitimas, 'vítima localizada', 'vítimas localizadas'));
    if (r.pontos) {
      var tipos = ORDEM_PONTO.filter(function (t) { return r.porTipo[t]; })
        .map(function (t) { return r.porTipo[t] + ' ' + ROTULO_PONTO[t][r.porTipo[t] === 1 ? 0 : 1]; });
      p.push(r.pontos + (r.pontos === 1 ? ' marca no mapa' : ' marcas no mapa') + ' (' + tipos.join(', ') + ')');
    }
    if (r.ajuda) p.push(r.ajuda === 1 ? '1 pede ajuda' : r.ajuda + ' pedem ajuda');
    if (r.saida) p.push(r.saida === 1 ? '1 pede para sair' : r.saida + ' pedem para sair');
    if (r.criticos) p.push(plural(r.criticos, 'área de risco ou pedido de ajuda', 'áreas de risco ou pedidos de ajuda'));
    return p.join(' · ') + '. Toque para aproximar.';
  }

  // HTML do selo: pessoas (círculo com o anel das cores dos grupos) e pontos (quadrado arredondado com o anel
  // dos tipos) lado a lado; "+" verde com a quantidade de vítimas, "!" vermelho de alerta e as etiquetas ao lado.
  function htmlResumo(r) {
    var tam = r.pessoas >= 20 ? 44 : r.pessoas >= 8 ? 40 : 36;
    var partes = '';
    if (r.pessoas) {
      partes += '<div class="resumo-pessoas" style="width:' + tam + 'px;height:' + tam + 'px;background:conic-gradient(' + fatiasDeCor(r.coresPessoas) + ')"><b>' + r.pessoas + '</b></div>';
    }
    if (r.pontos) {
      var cores = [];
      ORDEM_PONTO.forEach(function (t) { for (var k = 0; k < (r.porTipo[t] || 0); k++) cores.push(COR_PONTO[t]); });
      partes += '<div class="resumo-pontos" style="background:conic-gradient(' + fatiasDeCor(cores) + ')"><b>' + r.pontos + '</b></div>';
    }
    var rotulos = '';
    if (r.vitimas) rotulos += '<span class="resumo-rotulo-vitima">' + (r.vitimas > 1 ? r.vitimas + ' VÍTIMAS' : 'VÍTIMA') + '</span>';
    if (r.ajuda) rotulos += '<span class="resumo-rotulo-ajuda">' + (r.ajuda > 1 ? r.ajuda + ' PEDEM AJUDA' : 'PEDE AJUDA') + '</span>';
    return '<div class="resumo' + (r.vitimas ? ' resumo-vitima' : '') + (r.alertas ? ' resumo-alerta' : '') + (r.pessoas && r.pontos ? ' resumo-duplo' : '') +
      '" title="' + esc(textoResumo(r)) + '">' + partes +
      (r.alertas ? '<i class="cl-alerta" aria-hidden="true">!</i>' : '') +
      (r.vitimas ? '<i class="cl-vitima" aria-hidden="true">+' + (r.vitimas > 1 ? r.vitimas : '') + '</i>' : '') +
      (rotulos ? '<div class="resumo-rotulos">' + rotulos + '</div>' : '') + '</div>';
  }

  // Largura do selo, para o Leaflet centralizar o ícone
  function tamanhoIcone(r) {
    var tam = r.pessoas >= 20 ? 44 : r.pessoas >= 8 ? 40 : 36;
    var w = (r.pessoas ? tam : 0) + (r.pontos ? 36 : 0) + (r.pessoas && r.pontos ? 4 : 0);
    return [Math.max(w, 36), r.pessoas ? tam : 36];
  }

  /* ---------- Leaflet ---------------------------------------------------- */

  // Instala o resumo num mapa Leaflet. opcoes.coletar(): lista de itens do mapa. Cada item:
  //   { id, familia: 'pessoa'|'ponto', lat, lng, chave (muda quando o desenho muda), icon (L.Icon ou função que o cria),
  //     marcador (o marcador original, para repassar cliques), titulo, alt, zIndexOffset,
  //     pessoa: cor, nome, ajuda, saida · ponto: tipo, critico, vitima }
  function instalar(mapa, opcoes) {
    var L = raiz.L;
    opcoes = opcoes || {};
    var el = mapa.getContainer();
    var painel = mapa.createPane('resumo');
    painel.style.zIndex = 620;   // acima das pessoas e dos pontos, abaixo dos balões
    var camada = L.layerGroup().addTo(mapa);
    var zoomMaximo = (raiz.MapaRotulos && raiz.MapaRotulos.ZOOM_MEDIO ? raiz.MapaRotulos.ZOOM_MEDIO : 15) - 1;
    var ativo = false, assinatura = '', timer = null;

    function coletar() {
      return (opcoes.coletar ? opcoes.coletar() : []).filter(function (i) { return isFinite(i.lat) && isFinite(i.lng); });
    }

    function limpar() { camada.clearLayers(); }

    function marcadorIsolado(i) {
      var m = L.marker([i.lat, i.lng], {
        icon: typeof i.icon === 'function' ? i.icon() : i.icon, pane: 'resumo', keyboard: true, riseOnHover: true,
        title: i.titulo || '', alt: i.alt || '', zIndexOffset: i.zIndexOffset || 0,
      });
      // mesmo comportamento do marcador original: clique, balão, toque longo, duplo clique
      if (i.marcador && i.marcador.fire) {
        m.on(EVENTOS_REPASSADOS.join(' '), function (ev) { i.marcador.fire(ev.type, ev); });
      }
      return m;
    }

    function marcadorResumo(g, z) {
      var r = resumir(g.itens);
      var tam = tamanhoIcone(r);
      var centro = mapa.unproject(L.point(g.x, g.y), z);
      var m = L.marker(centro, {
        icon: L.divIcon({ className: 'resumo-wrap', html: htmlResumo(r), iconSize: tam, iconAnchor: [tam[0] / 2, tam[1] / 2] }),
        pane: 'resumo', keyboard: true, riseOnHover: true, title: textoResumo(r), alt: plural(r.total, 'item', 'itens'),
        zIndexOffset: r.alertas ? 1000 : r.vitimas ? 500 : 0,
      });
      var limites = L.latLngBounds(g.itens.map(function (i) { return [i.lat, i.lng]; }));
      // aproximar leva ao zoom 15 ou mais: o resumo sai e os agrupamentos de sempre voltam
      m.on('click', function (ev) {
        L.DomEvent.stopPropagation(ev);
        mapa.fitBounds(limites, { padding: [80, 80], maxZoom: Math.max(zoomMaximo + 3, 17) });
      });
      return m;
    }

    function desenhar(forcar) {
      var deveAtivar = mapa.getZoom() <= zoomMaximo;
      if (deveAtivar !== ativo) {
        ativo = deveAtivar;
        el.classList.toggle('mapa-resumo', ativo);
        forcar = true;
      }
      if (!ativo) { if (forcar) { limpar(); assinatura = ''; } return; }
      var z = mapa.getZoom();
      var itens = coletar();
      var sig = z + '|' + itens.map(function (i) { return [i.id, i.lat.toFixed(5), i.lng.toFixed(5), i.chave].join(':'); }).join(';');
      if (!forcar && sig === assinatura) return;
      assinatura = sig;
      limpar();
      var comPixel = itens.map(function (i) {
        var p = mapa.project([i.lat, i.lng], z);
        return Object.assign({}, i, { x: p.x, y: p.y });
      });
      agrupar(comPixel, RAIO_PX).forEach(function (g) {
        camada.addLayer(g.itens.length === 1 ? marcadorIsolado(g.itens[0]) : marcadorResumo(g, z));
      });
    }

    mapa.on('zoomend', function () { desenhar(true); });
    timer = setInterval(function () { if (!document.hidden) desenhar(false); }, TEMPO_VERIFICAR_MS);
    mapa.on('unload', function () { clearInterval(timer); timer = null; });   // o mapa foi destruído (operação fechada)
    desenhar(true);
    return { atualizar: function () { desenhar(true); }, ativo: function () { return ativo; }, zoomMaximo: zoomMaximo };
  }

  var api = {
    RAIO_PX: RAIO_PX, distanciaM: distanciaM, agrupar: agrupar, resumir: resumir, textoResumo: textoResumo,
    htmlResumo: htmlResumo, tamanhoIcone: tamanhoIcone, fatiasDeCor: fatiasDeCor, instalar: instalar,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.MapaResumo = api;
})(typeof window !== 'undefined' ? window : this);
