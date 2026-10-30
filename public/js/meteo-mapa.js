/* =====================================================================
 * meteo-mapa.js — desenho do vento (partículas animadas), da temperatura e da chuva (campos coloridos)
 * sobre o mapa do Leaflet, no estilo dos mapas de vento. Os dados vêm da grade de /api/meteo?tipo=grade.
 * O desenho acontece num canvas próprio; a grade é interpolada com MeteoCore.
 * ===================================================================== */
(function () {
  'use strict';
  var Core = window.MeteoCore;
  if (!window.L || !Core) return;

  var PARTICULAS = 900, VIDA_MAX = 90;
  // Segundos de vento por quadro da animação: 10 m/s ≈ 80 m por quadro (visual, não é previsão).
  var SEG_POR_QUADRO = 8;

  // Grade de vento: componentes u (leste) e v (norte) em m/s, mesma forma da grade de temperatura.
  function gradeVento(g) {
    var u = [], v = [];
    g.pontos.forEach(function (p) {
      var c = Core.componentesVento((p.vento || 0) / 3.6, p.direcao || 0);
      u.push(p.vento == null ? null : c.u);
      v.push(p.vento == null ? null : c.v);
    });
    var base = { lat0: g.lat0, lng0: g.lng0, dlat: g.dlat, dlng: g.dlng, nLin: g.nLin, nCol: g.nCol };
    return { u: Object.assign({ valores: u }, base), v: Object.assign({ valores: v }, base), velocidadeKmh: g.pontos.map(function (p) { return p.vento; }) };
  }
  function gradeTemperatura(g) {
    return Object.assign({ valores: g.pontos.map(function (p) { return p.temperatura == null ? null : p.temperatura; }) },
      { lat0: g.lat0, lng0: g.lng0, dlat: g.dlat, dlng: g.dlng, nLin: g.nLin, nCol: g.nCol });
  }

  function gradeChuva(g) {
    return Object.assign({ valores: g.pontos.map(function (p) { return p.precipitacao == null ? null : Math.max(0, p.precipitacao); }) },
      { lat0: g.lat0, lng0: g.lng0, dlat: g.dlat, dlng: g.dlng, nLin: g.nLin, nCol: g.nCol });
  }

  // Camada base: canvas posicionado no painel de sobreposição, redesenhado conforme o mapa muda.
  var Camada = L.Layer.extend({
    initialize: function (tipo) { this._tipo = tipo; this._grade = null; this._part = []; this._quadro = null; },

    setGrade: function (g) {
      this._grade = g ? (this._tipo === 'vento' ? gradeVento(g) : this._tipo === 'chuva' ? gradeChuva(g) : gradeTemperatura(g)) : null;
      this._part = [];
      if (this._map) this._pintarCampo();
    },

    onAdd: function (map) {
      this._map = map;
      this._canvas = L.DomUtil.create('canvas', 'meteo-canvas');
      this._canvas.style.pointerEvents = 'none';
      map.getPane('overlayPane').appendChild(this._canvas);
      map.on('move zoom resize', this._pintarCampo, this);
      this._dimensionar();
      this._pintarCampo();
      if (this._tipo === 'vento') this._animar();
    },

    onRemove: function (map) {
      if (this._quadro) cancelAnimationFrame(this._quadro);
      this._quadro = null;
      map.off('move zoom resize', this._pintarCampo, this);
      L.DomUtil.remove(this._canvas);
      this._map = null;
    },

    _dimensionar: function () {
      var t = this._map.getSize();
      this._canvas.width = t.x;
      this._canvas.height = t.y;
      // O canvas acompanha a origem do painel: as coordenadas de desenho são as do contêiner.
      L.DomUtil.setPosition(this._canvas, this._map.containerPointToLayerPoint([0, 0]));
    },

    _pintarCampo: function () {
      if (!this._map) return;
      this._dimensionar();
      var ctx = this._canvas.getContext('2d');
      ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      if (!this._grade || this._tipo === 'vento') return;
      if (this._tipo === 'chuva') { this._desenharCampo(ctx, function (mm) { var c = Core.corChuva(mm); return c ? c.concat(Core.opacidadeChuva(mm)) : null; }); return; }
      this._desenharCampo(ctx, function (t) { var c = Core.corTemperatura(t); return c ? c.concat(0.42) : null; });
    },

    // Campo contínuo: calcula num canvas pequeno (1 pixel a cada 6) e amplia com suavização, para as cores
    // passarem de um ponto da grade a outro sem degraus. cor(valor) → [r, g, b, opacidade] ou null.
    _desenharCampo: function (ctx, cor) {
      var m = this._map, g = this._grade, passo = 6;
      var w = Math.ceil(this._canvas.width / passo), h = Math.ceil(this._canvas.height / passo);
      var pequeno = document.createElement('canvas');
      pequeno.width = w; pequeno.height = h;
      var pc = pequeno.getContext('2d'), img = pc.createImageData(w, h), d = img.data;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var ll = m.containerPointToLatLng([x * passo + passo / 2, y * passo + passo / 2]);
          var c = cor(Core.interpolar(g, ll.lat, ll.lng));
          if (!c) continue;
          var k = (y * w + x) * 4;
          d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = Math.round(c[3] * 255);
        }
      }
      pc.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(pequeno, 0, 0, w * passo, h * passo);
    },

    _novaParticula: function () {
      var g = this._grade, bounds = { lat0: g.u.lat0, lng0: g.u.lng0, nLin: g.u.nLin, nCol: g.u.nCol, dlat: g.u.dlat, dlng: g.u.dlng };
      return { lat: bounds.lat0 + Math.random() * bounds.dlat * (bounds.nLin - 1),
        lng: bounds.lng0 + Math.random() * bounds.dlng * (bounds.nCol - 1), vida: Math.floor(Math.random() * VIDA_MAX) };
    },

    _animar: function () {
      var self = this;
      function quadro() {
        self._quadro = requestAnimationFrame(quadro);
        self._passo();
      }
      this._quadro = requestAnimationFrame(quadro);
    },

    _passo: function () {
      var m = this._map;
      if (!m || !this._grade) return;
      var ctx = this._canvas.getContext('2d');
      // Apaga aos poucos: o rastro some sem limpar o mapa todo.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(0, 0, this._canvas.width, this._canvas.height);
      ctx.globalCompositeOperation = 'source-over';
      if (this._part.length < PARTICULAS) {
        while (this._part.length < PARTICULAS) this._part.push(this._novaParticula());
      }
      var g = this._grade;
      for (var i = 0; i < this._part.length; i++) {
        var p = this._part[i];
        var u = Core.interpolar(g.u, p.lat, p.lng), v = Core.interpolar(g.v, p.lat, p.lng);
        if (u == null || v == null || ++p.vida > VIDA_MAX) { this._part[i] = this._novaParticula(); continue; }
        var kmh = Math.sqrt(u * u + v * v) * 3.6;
        var dlat = (v * SEG_POR_QUADRO) / 111320;
        var dlng = (u * SEG_POR_QUADRO) / (111320 * Math.cos(p.lat * Math.PI / 180));
        var a = m.latLngToContainerPoint([p.lat, p.lng]);
        var nl = { lat: p.lat + dlat, lng: p.lng + dlng };
        var b = m.latLngToContainerPoint([nl.lat, nl.lng]);
        var c = Core.corVento(kmh);
        ctx.strokeStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',0.85)';
        ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        p.lat = nl.lat; p.lng = nl.lng;
      }
    },
  });

  // Satélite GOES-East (infravermelho realçado, NASA GIBS): cada tile é filtrado num canvas para deixar só as
  // nuvens — as coloridas (topos muito frios: tempestade e chuva forte) quase opacas, as brancas (nuvens altas)
  // translúcidas e o resto (chão e nuvens baixas, em cinza escuro) transparente. Assim o mapa continua visível.
  var Satelite = L.GridLayer.extend({
    options: { tileSize: 256, maxNativeZoom: 6, minZoom: 2, opacity: 0.9, zIndex: 380, attribution: 'Satélite GOES-East © NOAA, via NASA GIBS' },
    initialize: function (url) { this._urlBase = url; this._t = null; this.ok = 0; this.erros = 0; },
    setTempo: function (t, url) {
      if (url) this._urlBase = url;
      if (t === this._t) return;
      this._t = t;
      if (this._map) this.redraw();
    },
    createTile: function (c, pronto) {
      var tile = document.createElement('canvas');
      tile.width = tile.height = 256;
      var self = this;
      if (!this._t || !this._urlBase || c.z > 6) { setTimeout(function () { pronto(null, tile); }, 0); return tile; }
      var n = Math.pow(2, c.z), x = ((c.x % n) + n) % n;
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        var ctx = tile.getContext('2d');
        ctx.drawImage(img, 0, 0, 256, 256);
        try {
          var dados = ctx.getImageData(0, 0, 256, 256), p = dados.data;
          for (var i = 0; i < p.length; i += 4) {
            var r = p[i], g = p[i + 1], b = p[i + 2];
            var mx = Math.max(r, g, b), sat = mx - Math.min(r, g, b);
            if (sat > 40) p[i + 3] = 225;                                   // colorido: topo frio (tempestade)
            else { p[i + 3] = Math.max(0, Math.min(150, (mx - 150) * 2)); p[i] = p[i + 1] = p[i + 2] = 235; }   // branco: nuvem alta
          }
          ctx.putImageData(dados, 0, 0);
          self.ok++;
        } catch (e) { /* sem CORS: fica a imagem sem filtro */ }
        pronto(null, tile);
      };
      img.onerror = function () { self.erros++; pronto(null, tile); };
      img.src = this._urlBase.replace('{t}', this._t).replace('{z}', c.z).replace('{y}', c.y).replace('{x}', x);
      return tile;
    },
  });

  window.MeteoMapa = {
    criarSatelite: function (url) { return new Satelite(url); },
    criarVento: function () { return new Camada('vento'); },
    criarTemperatura: function () { return new Camada('temperatura'); },
    criarChuva: function () { return new Camada('chuva'); },
  };
})();
