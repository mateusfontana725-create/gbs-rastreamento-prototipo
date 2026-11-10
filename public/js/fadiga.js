/* =====================================================================
 * fadiga.js — indicador de fadiga (verde, amarelo, vermelho) e descanso na base
 *
 * Conta por DIA (quem descansou de um dia para o outro chega zerado) e, dentro do dia, desde o último
 * DESCANSO LONGO (na base). São três coisas:
 *   · tempo de busca (tempo em campo, sem contar os descansos curtos);
 *   · quilometragem individual;
 *   · quilometragem do grupo (média por integrante).
 * O nível final é o pior dos três. Tudo é indicação para o comando decidir a troca de equipe: não há
 * limite científico único, por isso os valores abaixo são padrões editáveis (LIMITES).
 *
 * Funções puras (sem tela): ciclo(), kmDesde(), avaliar(), mediaKm(), textoMinutos().
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var LIMITES = {
    tempoMin: { amarelo: 120, vermelho: 240 },   // minutos de busca desde o último descanso longo
    km: { amarelo: 8, vermelho: 15 },            // km do próprio participante no mesmo período
    kmGrupo: { amarelo: 7, vermelho: 12 },       // média de km do grupo (por integrante) no mesmo período
    descansoLongoMin: 30,                        // descanso na base que zera a contagem
  };
  var NOMES = ['verde', 'amarelo', 'vermelho'];
  var ROTULOS = { verde: 'Verde', amarelo: 'Amarela', vermelho: 'Vermelha' };   // "fadiga" é feminino

  function nivelDe(valor, lim) {
    if (valor == null || isNaN(valor)) return 0;
    return valor >= lim.vermelho ? 2 : valor >= lim.amarelo ? 1 : 0;
  }

  function textoMinutos(min) {
    min = Math.max(0, Math.round(min));
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60), m = min % 60;
    return h + ' h' + (m ? ' ' + (m < 10 ? '0' : '') + m + ' min' : '');
  }
  function textoKm(km) { return (Math.round(km * 10) / 10).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' km'; }

  function distanciaM(lat1, lng1, lat2, lng2) {
    var R = 6371008.8, rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Descansos [{ inicio, fim|null }] (ms) → o ciclo de esforço atual.
  //   inicioMs: começo do ciclo (primeiro ponto, ou o fim do último descanso longo)
  //   buscaMin: tempo de busca no ciclo, sem os descansos curtos
  //   descansando: { desdeMs, min, longo } se está na base agora (descanso aberto)
  //   descansoTotalMin: soma de todos os descansos
  function ciclo(descansos, agoraMs, primeiroMs, limites) {
    var lim = limites || LIMITES;
    var longoMs = lim.descansoLongoMin * 60000;
    var lista = (descansos || []).map(function (d) { return { i: d.inicio, f: d.fim == null ? null : d.fim }; })
      .filter(function (d) { return d.i != null && d.i <= agoraMs; })
      .sort(function (a, b) { return a.i - b.i; });
    var inicio = primeiroMs != null ? primeiroMs : agoraMs;
    var descansando = null, total = 0;
    lista.forEach(function (d) {
      var fim = d.f == null ? agoraMs : Math.min(d.f, agoraMs);
      var dur = Math.max(0, fim - d.i);
      total += dur;
      if (d.f == null) descansando = { desdeMs: d.i, min: dur / 60000, longo: dur >= longoMs };
      if (dur >= longoMs) inicio = Math.max(inicio, d.f == null ? agoraMs : fim);   // descanso longo: a contagem recomeça depois dele
    });
    // descansos curtos dentro do ciclo não contam como busca
    var descontar = 0;
    lista.forEach(function (d) {
      var fim = d.f == null ? agoraMs : Math.min(d.f, agoraMs);
      var a = Math.max(d.i, inicio), b = Math.min(fim, agoraMs);
      if (b > a) descontar += b - a;
    });
    var busca = Math.max(0, agoraMs - inicio - descontar) / 60000;
    return { inicioMs: inicio, buscaMin: busca, descansando: descansando, descansoTotalMin: total / 60000 };
  }

  // Quilômetros percorridos a partir de um instante. segmentos: [[{ lat, lng, t }, …], …] (a trilha já filtrada).
  // ateMs (opcional): só conta até esse instante (dia já passado).
  function kmDesde(segmentos, desdeMs, ateMs) {
    var m = 0, fim = ateMs == null ? Infinity : ateMs;
    (segmentos || []).forEach(function (seg) {
      for (var i = 1; i < seg.length; i++) {
        if (seg[i].t >= desdeMs && seg[i - 1].t >= desdeMs && seg[i].t <= fim && seg[i - 1].t <= fim) m += distanciaM(seg[i - 1].lat, seg[i - 1].lng, seg[i].lat, seg[i].lng);
      }
    });
    return m / 1000;
  }

  function mediaKm(lista) {
    var v = (lista || []).filter(function (x) { return x != null && !isNaN(x); });
    return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
  }

  // entrada: { buscaMin, km, kmGrupo (ou nulo), emDescansoLongo }
  // Devolve { nivel: 'verde'|'amarelo'|'vermelho', indice, itens: [{ chave, rotulo, valor, texto, nivel }], texto }
  function avaliar(entrada, limites) {
    var lim = limites || LIMITES;
    var itens = [];
    var t = nivelDe(entrada.buscaMin, lim.tempoMin);
    itens.push({ chave: 'tempo', rotulo: 'Tempo de busca', valor: entrada.buscaMin, texto: textoMinutos(entrada.buscaMin || 0), nivel: NOMES[t] });
    var k = nivelDe(entrada.km, lim.km);
    itens.push({ chave: 'km', rotulo: 'Quilometragem', valor: entrada.km, texto: textoKm(entrada.km || 0), nivel: NOMES[k] });
    var g = 0;
    if (entrada.kmGrupo != null) {
      g = nivelDe(entrada.kmGrupo, lim.kmGrupo);
      itens.push({ chave: 'grupo', rotulo: 'Média do grupo', valor: entrada.kmGrupo, texto: textoKm(entrada.kmGrupo), nivel: NOMES[g] });
    }
    var indice = entrada.emDescansoLongo ? 0 : Math.max(t, k, g);
    return {
      nivel: NOMES[indice], indice: indice, itens: itens,
      texto: (entrada.emDescansoLongo ? 'Descansando: contagem zerada · ' : '') + itens.map(function (x) { return x.rotulo.toLowerCase() + ' ' + x.texto + (x.nivel !== 'verde' ? ' (' + x.nivel + ')' : ''); }).join(' · '),
    };
  }

  // Só para a representação (barra de cansaço): quanto de "energia" resta, de 0 a 1. Usa as mesmas estatísticas e os
  // mesmos limites vermelhos: a que está mais perto do vermelho manda. Não muda o nível (verde, amarelo, vermelho),
  // que continua vindo de avaliar(). Sem estatística, fica cheia (1).
  function restante(itens, limites) {
    var lim = limites || LIMITES;
    var pior = 0;
    (itens || []).forEach(function (x) {
      var ref = x.chave === 'tempo' ? lim.tempoMin.vermelho : x.chave === 'km' ? lim.km.vermelho : x.chave === 'grupo' ? lim.kmGrupo.vermelho : null;
      if (!ref || x.valor == null || isNaN(x.valor)) return;
      pior = Math.max(pior, x.valor / ref);
    });
    return Math.max(0, 1 - Math.min(1, pior));
  }

  var API = { LIMITES: LIMITES, NOMES: NOMES, ROTULOS: ROTULOS, nivelDe: nivelDe, ciclo: ciclo, kmDesde: kmDesde, mediaKm: mediaKm,
    avaliar: avaliar, textoMinutos: textoMinutos, textoKm: textoKm, distanciaM: distanciaM, restante: restante };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  raiz.Fadiga = API;
})(typeof window !== 'undefined' ? window : globalThis);
