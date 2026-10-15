/* =====================================================================
 * meteo-mapa.js — desenho do vento (partículas animadas) e da temperatura (campo colorido)
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

  // Camada base: canvas posicionado no painel de sobreposição, redesenhado conforme o mapa muda.
  var Camada = L.Layer.extend({
    initialize: function (tipo) { this._tipo = tipo; this._grade = null; this._part = []; this._quadro = null; },

    setGrade: function (g) {
      this._grade = g ? (this._tipo === 'vento' ? gradeVento(g) : gradeTemperatura(g)) : null;
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
      if (!this._grade || this._tipo !== 'temperatura') return;
      var m = this._map, bloco = 6, g = this._grade;
      for (var y = 0; y < this._canvas.height; y += bloco) {
        for (var x = 0; x < this._canvas.width; x += bloco) {
          var ll = m.containerPointToLatLng([x + bloco / 2, y + bloco / 2]);
          var t = Core.interpolar(g, ll.lat, ll.lng);
          var cor = Core.corTemperatura(t);
          if (!cor) continue;
          ctx.fillStyle = 'rgba(' + cor[0] + ',' + cor[1] + ',' + cor[2] + ',0.42)';
          ctx.fillRect(x, y, bloco, bloco);
        }
      }
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

  window.MeteoMapa = {
    criarVento: function () { return new Camada('vento'); },
    criarTemperatura: function () { return new Camada('temperatura'); },
  };
})();
