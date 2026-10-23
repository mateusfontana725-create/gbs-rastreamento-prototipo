/* =====================================================================
 * rotas.js — geração de rotas (único lugar do app que monta rotas)
 *   - Rota por ruas, caminhos e trilhas: pede ao servidor (/api/rota → openrouteservice,
 *     chave só no servidor).
 *   - Rota DESENHADA: um trajeto traçado à mão no mapa vira uma rota igual às outras
 *     (distância acumulada, tempo estimado, instruções de curva), sem servidor.
 *   - paraDestino(): escolhe sozinho — destino com trajeto segue o traçado; sem trajeto, calcula.
 *   - progresso(), desenhar(), resumo(): funcionam para os dois tipos.
 *   - simplificar(): reduz linhas desenhadas ou importadas sem perder a forma.
 * Usado pela página do participante e pelo painel (envio de trajeto, ficha, trilhas).
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao;

  var MODOS = {
    a_pe: { rotulo: 'A pé', icone: '🚶', descricao: 'ruas, calçadas e caminhos', google: 'walking' },
    trilha: { rotulo: 'Trilha', icone: '🥾', descricao: 'prioriza trilhas e caminhos de terra', google: 'walking' },
    carro: { rotulo: 'Carro', icone: '🚗', descricao: 'estradas e ruas para veículos', google: 'driving' },
  };

  // Velocidade média para estimar o tempo de um trajeto desenhado (m/s).
  var VELOCIDADE = { a_pe: 1.2, trilha: 0.75, carro: 8 };

  function dist(a, b) { return window.GPS.distancia(a[0], a[1], b[0], b[1]); }

  /* ---------- Simplificação (Douglas-Peucker) ------------------------- */
  // Sobre pontos {x, y} (pixels ou metros). Devolve os índices mantidos, em ordem.
  function simplificarIndices(pts, tol) {
    if (pts.length < 3) return pts.map(function (p, i) { return i; });
    var manter = new Uint8Array(pts.length), pilha = [[0, pts.length - 1]], t2 = tol * tol;
    manter[0] = manter[pts.length - 1] = 1;
    while (pilha.length) {
      var par = pilha.pop(), a = pts[par[0]], b = pts[par[1]], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy, max = -1, im = -1;
      for (var i = par[0] + 1; i < par[1]; i++) {
        var p = pts[i], t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        var ex = a.x + t * dx - p.x, ey = a.y + t * dy - p.y, d = ex * ex + ey * ey;
        if (d > max) { max = d; im = i; }
      }
      if (max > t2) { manter[im] = 1; pilha.push([par[0], im], [im, par[1]]); }
    }
    var out = [];
    for (var k = 0; k < pts.length; k++) if (manter[k]) out.push(k);
    return out;
  }
  function emMetros(latlngs) {
    var lat0 = latlngs[0][0] * Math.PI / 180, k = 111320;
    return latlngs.map(function (q) { return { x: q[1] * k * Math.cos(lat0), y: q[0] * k }; });
  }
  // Linha [[lat, lng], …] simplificada com tolerância em metros; com "maximo", aumenta a
  // tolerância até caber (ex.: 2000 pontos, o limite do banco).
  function simplificar(latlngs, tolM, maximo) {
    if (!latlngs || latlngs.length < 3) return (latlngs || []).slice();
    var m = emMetros(latlngs), tol = tolM || 2, idx;
    do { idx = simplificarIndices(m, tol); tol *= 1.6; } while (maximo && idx.length > maximo && tol < 5000);
    return idx.map(function (i) { return [latlngs[i][0], latlngs[i][1]]; });
  }

  /* ---------- Rota desenhada (trajeto traçado no mapa) ---------------- */
  function rumo(a, b) {
    var k = Math.PI / 180;
    var y = Math.sin((b[1] - a[1]) * k) * Math.cos(b[0] * k);
    var x = Math.cos(a[0] * k) * Math.sin(b[0] * k) - Math.sin(a[0] * k) * Math.cos(b[0] * k) * Math.cos((b[1] - a[1]) * k);
    return (Math.atan2(y, x) / k + 360) % 360;
  }
  var DIRECOES = ['norte', 'nordeste', 'leste', 'sudeste', 'sul', 'sudoeste', 'oeste', 'noroeste'];
  function textoCurva(giro) {
    var a = Math.abs(giro), lado = giro > 0 ? 'direita' : 'esquerda';
    if (a >= 140) return 'Faça o retorno (curva fechada à ' + lado + ')';
    if (a >= 60) return 'Vire à ' + lado;
    return 'Vire levemente à ' + lado;
  }
  // Instruções a partir da forma da linha: curvas de 30° ou mais (depois de alisar o traço em ~12 m).
  function gerarPassos(g, cumul, nomeDestino) {
    var idx = simplificarIndices(emMetros(g), 12);
    var passos = [];
    var r0 = rumo(g[idx[0]], g[idx[1]]);
    passos.push({ instrucao: 'Siga o trajeto para o ' + DIRECOES[Math.round(r0 / 45) % 8], de: 0, tipo: 'inicio' });
    for (var k = 1; k < idx.length - 1; k++) {
      var giro = ((rumo(g[idx[k]], g[idx[k + 1]]) - rumo(g[idx[k - 1]], g[idx[k]]) + 540) % 360) - 180;
      if (Math.abs(giro) >= 30) passos.push({ instrucao: textoCurva(giro), de: idx[k], tipo: 'curva' });
    }
    passos.push({ instrucao: 'Chegada' + (nomeDestino ? ': ' + nomeDestino : ' ao fim do trajeto'), de: g.length - 1, tipo: 'chegada' });
    for (var i = 0; i < passos.length; i++) {
      var ate = i + 1 < passos.length ? passos[i + 1].de : g.length - 1;
      passos[i].ate = ate;
      passos[i].distancia_m = Math.round(cumul[ate] - cumul[passos[i].de]);
    }
    return passos;
  }
  // Trajeto [[lat, lng], …] → rota (mesmo formato da rota calculada).
  //   o: { origem: [lat, lng] (onde a pessoa está), modo, nome (do destino) }
  function deTracado(pontos, o) {
    o = o || {};
    var g = (pontos || []).map(function (q) { return [Number(q[0]), Number(q[1])]; });
    if (g.length < 2) return null;
    var modo = MODOS[o.modo] ? o.modo : 'a_pe';
    var rota = { provedor: 'trajeto desenhado', modo: modo, desenhada: true, fixa: true, geometria: g, calculada_em: 'tracado' };
    preparar(rota);
    rota.distancia_m = Math.round(rota.total);
    rota.duracao_s = Math.round(rota.total / VELOCIDADE[modo]);
    rota.subida_m = null;
    rota.passos = gerarPassos(g, rota.cumul, o.nome);
    rota.origem = o.origem || null;
    rota.destino = g[g.length - 1];
    rota.fora_inicio_m = 0;   // a linha do início não é desenhada: a pessoa vai até o trajeto
    rota.fora_fim_m = 0;
    rota.inicio_m = o.origem ? Math.round(dist(o.origem, g[0])) : null;
    rota.avisos = [];
    if (rota.inicio_m != null && rota.inicio_m > 40) {
      rota.avisos.push('O trajeto começa a ' + formatarDistancia(rota.inicio_m) + ' de você: vá até o início (ponto verde) e siga a linha.');
    }
    rota.limites = 'Trajeto desenhado pelos bombeiros no mapa: não foi calculado por caminhos. Siga a linha conferindo o terreno e as orientações da equipe.';
    return rota;
  }

  // Rota para um destino: com trajeto desenhado segue o traçado (sem internet); sem, calcula por caminhos.
  //   destino: { lat, lng, modo, trajeto?, nome? }   o: { origem, modo, participante_id }
  async function paraDestino(destino, o) {
    o = o || {};
    var modo = o.modo || destino.modo || 'a_pe';
    if (temTrajeto(destino)) {
      var rota = deTracado(destino.trajeto, { origem: o.origem, modo: modo, nome: destino.nome });
      return rota ? { ok: true, rota: rota } : { ok: false, erro: 'trajeto_invalido', mensagem: 'Trajeto inválido.' };
    }
    return calcular({ origem: o.origem, destino: [destino.lat, destino.lng], modo: modo, participante_id: o.participante_id });
  }
  function temTrajeto(d) { return Boolean(d && Array.isArray(d.trajeto) && d.trajeto.length >= 2); }

  // Pede a rota. Devolve { ok: true, rota } ou { ok: false, erro, mensagem }.
  async function calcular(o) {
    var sessao = null;
    try { sessao = (await C.cliente.auth.getSession()).data.session; } catch (e) { /* sem sessão */ }
    if (!sessao) return { ok: false, erro: 'nao_autenticado', mensagem: 'Sessão expirada.' };
    var corpo = { origem: o.origem, destino: o.destino, modo: o.modo || 'a_pe' };
    if (o.participante_id) corpo.participante_id = o.participante_id;
    var r;
    try {
      r = await Promise.race([
        fetch('/api/rota', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessao.access_token },
          body: JSON.stringify(corpo),
        }),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 20000); }),
      ]);
    } catch (e) {
      return { ok: false, erro: 'rede', mensagem: 'Sem conexão para calcular a rota.' };
    }
    var dados = null;
    try { dados = await r.json(); } catch (e) { /* resposta inválida */ }
    if (!r.ok || !dados || !Array.isArray(dados.geometria)) {
      return { ok: false, erro: (dados && dados.erro) || 'rota_indisponivel', mensagem: (dados && dados.mensagem) || 'Não foi possível calcular a rota agora.' };
    }
    preparar(dados);
    dados.origem = o.origem;
    dados.destino = o.destino;
    return { ok: true, rota: dados };
  }

  // Distâncias acumuladas ao longo da rota.
  function preparar(rota) {
    var g = rota.geometria;
    rota.cumul = [0];
    for (var i = 1; i < g.length; i++) rota.cumul.push(rota.cumul[i - 1] + dist(g[i - 1], g[i]));
    rota.total = rota.cumul[rota.cumul.length - 1];
    return rota;
  }

  // Onde a pessoa está em relação à rota: ponto mais próximo, distância até a
  // rota, quanto falta pela rota, próxima instrução e um ponto ~40 m à frente
  // (para a seta da bússola seguir a rota, e não a linha reta).
  function progresso(rota, lat, lng) {
    var g = rota.geometria, kLat = 111320, kLng = 111320 * Math.cos(lat * Math.PI / 180);
    var melhor = { d: Infinity, i: 0, f: 0 };
    for (var i = 0; i < g.length - 1; i++) {
      var ax = (g[i][1] - lng) * kLng, ay = (g[i][0] - lat) * kLat;
      var bx = (g[i + 1][1] - lng) * kLng, by = (g[i + 1][0] - lat) * kLat;
      var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      var f = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      var px = ax + f * dx, py = ay + f * dy;
      var d = Math.sqrt(px * px + py * py);
      if (d < melhor.d) melhor = { d: d, i: i, f: f };
    }
    var segLen = rota.cumul[melhor.i + 1] - rota.cumul[melhor.i];
    var percorrido = rota.cumul[melhor.i] + melhor.f * segLen;
    var restante = Math.max(0, rota.total - percorrido) + (rota.fora_fim_m || 0);
    // ponto 40 m à frente na rota
    var alvoDist = Math.min(rota.total, percorrido + 40), j = melhor.i;
    while (j < g.length - 2 && rota.cumul[j + 1] < alvoDist) j++;
    var fj = rota.cumul[j + 1] > rota.cumul[j] ? (alvoDist - rota.cumul[j]) / (rota.cumul[j + 1] - rota.cumul[j]) : 0;
    var alvo = [g[j][0] + fj * (g[j + 1][0] - g[j][0]), g[j][1] + fj * (g[j + 1][1] - g[j][1])];
    // instrução: o passo em que está e a próxima manobra
    var passos = rota.passos || [], k = 0;
    for (var p = 0; p < passos.length; p++) { if (passos[p].de <= melhor.i) k = p; }
    var prox = passos[k + 1] || null;
    var distManobra = prox ? Math.max(0, rota.cumul[Math.min(prox.de, rota.cumul.length - 1)] - percorrido) : restante;
    return {
      distanciaDaRota: melhor.d, indice: melhor.i, percorrido: percorrido, restante: restante, alvo: alvo,
      passoAtual: passos[k] || null, proximo: prox, distManobra: distManobra,
    };
  }

  function formatarDuracao(s) {
    if (!s && s !== 0) return '';
    var m = Math.round(s / 60);
    if (m < 1) return 'menos de 1 min';
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  }

  function formatarDistancia(m) {
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: m < 10000 ? 1 : 0 }) + ' km';
  }

  function resumo(rota) {
    var md = MODOS[rota.modo] || MODOS.a_pe;
    var t = (rota.desenhada ? '✎ Trajeto desenhado (' + md.rotulo.toLowerCase() + ')' : md.icone + ' ' + md.rotulo) + ': ' +
      formatarDistancia(rota.distancia_m + (rota.fora_inicio_m || 0) + (rota.fora_fim_m || 0));
    if (rota.duracao_s) t += ' · ~' + formatarDuracao(rota.duracao_s);
    if (rota.subida_m != null) t += ' · ↑' + rota.subida_m + ' m ↓' + (rota.descida_m || 0) + ' m';
    return t;
  }

  // Desenha a rota num grupo do Leaflet: contorno claro, linha azul, trechos
  // íngremes em laranja e, tracejados em cinza, os trechos sem caminho mapeado.
  function desenhar(grupo, rota, opcoes) {
    opcoes = opcoes || {};
    grupo.clearLayers();
    var pts = rota.geometria.map(function (c) { return [c[0], c[1]]; });
    var peso = opcoes.peso || 5;
    L.polyline(pts, { color: '#ffffff', weight: peso + 4, opacity: 0.7, interactive: false, lineJoin: 'round', className: 'rota-halo' }).addTo(grupo);
    L.polyline(pts, { color: '#2563eb', weight: peso, opacity: 0.95, interactive: false, lineJoin: 'round', className: 'rota-linha' + (rota.desenhada ? ' rota-desenhada' : '') }).addTo(grupo);
    if (rota.desenhada) {
      // início (verde) e fim do trajeto: a pessoa sabe por onde entrar na linha
      L.circleMarker(pts[0], { radius: 6, color: '#0b1220', weight: 2, fillColor: '#22c55e', fillOpacity: 1, interactive: false, className: 'rota-inicio' }).addTo(grupo);
    }
    (rota.trechos_ingremes || []).forEach(function (t) {
      var trecho = pts.slice(t[0], t[1] + 1);
      if (trecho.length > 1) {
        L.polyline(trecho, { color: Math.abs(t[2]) >= 5 ? '#dc2626' : '#f97316', weight: peso, opacity: 1, interactive: false, className: 'rota-ingreme' }).addTo(grupo);
      }
    });
    var fora = { color: '#6b7280', weight: 3, dashArray: '4 6', opacity: 0.9, interactive: false, className: 'rota-fora' };
    if (rota.origem && rota.fora_inicio_m > 30) L.polyline([rota.origem, pts[0]], fora).addTo(grupo);
    if (rota.destino && rota.fora_fim_m > 30) L.polyline([pts[pts.length - 1], rota.destino], fora).addTo(grupo);
    return grupo;
  }

  function linkGoogle(destino, modo) {
    return 'https://www.google.com/maps/dir/?api=1&destination=' + destino[0] + ',' + destino[1] + '&travelmode=' + ((MODOS[modo] || MODOS.a_pe).google);
  }

  window.Rotas = {
    MODOS: MODOS, VELOCIDADE: VELOCIDADE, calcular: calcular, preparar: preparar, progresso: progresso, desenhar: desenhar,
    deTracado: deTracado, paraDestino: paraDestino, temTrajeto: temTrajeto, gerarPassos: gerarPassos,
    simplificar: simplificar, simplificarIndices: simplificarIndices,
    resumo: resumo, formatarDuracao: formatarDuracao, formatarDistancia: formatarDistancia, linkGoogle: linkGoogle,
  };
})();
