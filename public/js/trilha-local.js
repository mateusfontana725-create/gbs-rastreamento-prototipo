/* =====================================================================
 * trilha-local.js — fila offline dos pontos da trilha GPS
 * Usado pela página do participante e pela "Minha posição" do responsável.
 *
 *   - Cada ponto aceito pelo filtro (gps.js) é gravado PRIMEIRO no aparelho
 *     (IndexedDB; sem ele, localStorage; sem os dois, só na memória) e só
 *     depois enviado. Registro: { id (UUID do aparelho), participante_id,
 *     user_id, operacao_id, lat, lng, prec, t (hora do GPS), enviado,
 *     enviado_em, recusado, tentativas }.
 *   - Envio em lote (enviar_posicoes_lote). O servidor ignora ids repetidos
 *     e devolve QUAIS pontos confirmou: só esses são marcados como enviados.
 *     Os recusados (horário fora da operação, dados inválidos) ficam marcados
 *     e não são reenviados para sempre. Nada some sem registro.
 *   - Servidor ainda sem a migração 009: usa enviar_posicoes (resposta sem a
 *     lista de ids) e considera o lote entregue, como antes.
 *   - Enviados ficam guardados até 48 h (diagnóstico) e depois são apagados.
 * ===================================================================== */
(function (global) {
  'use strict';

  var NOME_BANCO = 'gbs-trilha';
  var VERSAO_BANCO = 1;
  var STORE = 'pontos';
  var LIMITE_PENDENTES = 5000;
  var GUARDAR_ENVIADOS_MS = 48 * 3600 * 1000;
  var GUARDAR_QUALQUER_MS = 7 * 24 * 3600 * 1000;

  /* ---------- Armazenamentos ------------------------------------------ */
  // Interface: { tipo, carregar() → Promise<[reg]>, gravar([reg]) → Promise, apagar([id]) → Promise }

  var bancoAberto = null;   // Promise<IDBDatabase|null>, compartilhada entre as filas
  function abrirIndexedDB() {
    if (bancoAberto) return bancoAberto;
    bancoAberto = new Promise(function (resolve) {
      try {
        if (!global.indexedDB) { resolve(null); return; }
        var r = global.indexedDB.open(NOME_BANCO, VERSAO_BANCO);
        r.onupgradeneeded = function () {
          var db = r.result;
          if (!db.objectStoreNames.contains(STORE)) {
            var st = db.createObjectStore(STORE, { keyPath: 'id' });
            st.createIndex('participante', 'participante_id', { unique: false });
          }
        };
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { resolve(null); };
        r.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return bancoAberto;
  }

  function armazenamentoIndexedDB(db, pid) {
    function transacao(modo, fn) {
      return new Promise(function (resolve, reject) {
        try {
          var t = db.transaction(STORE, modo);
          var pedido = fn(t.objectStore(STORE));
          t.oncomplete = function () { resolve(pedido ? pedido.result : undefined); };
          t.onerror = t.onabort = function () { reject(t.error || new Error('Falha no IndexedDB')); };
        } catch (e) { reject(e); }
      });
    }
    return {
      tipo: 'indexeddb',
      carregar: function () { return transacao('readonly', function (st) { return st.index('participante').getAll(pid); }); },
      gravar: function (regs) { return transacao('readwrite', function (st) { regs.forEach(function (r) { st.put(r); }); return null; }); },
      apagar: function (ids) { return transacao('readwrite', function (st) { ids.forEach(function (id) { st.delete(id); }); return null; }); },
    };
  }

  function armazenamentoLocal(pid) {
    var chave = 'gbs-trilha:' + pid;
    function ler() {
      try { return JSON.parse(global.localStorage.getItem(chave) || '[]') || []; } catch (e) { return []; }
    }
    function escrever(lista) {
      global.localStorage.setItem(chave, JSON.stringify(lista));   // erro (cota) sobe para quem chamou
    }
    return {
      tipo: 'localstorage',
      carregar: function () { return Promise.resolve(ler()); },
      gravar: function (regs) {
        return new Promise(function (resolve) {
          var mapa = new Map(ler().map(function (r) { return [r.id, r]; }));
          regs.forEach(function (r) { mapa.set(r.id, r); });
          escrever(Array.from(mapa.values()));
          resolve();
        });
      },
      apagar: function (ids) {
        return new Promise(function (resolve) {
          var tirar = new Set(ids);
          escrever(ler().filter(function (r) { return !tirar.has(r.id); }));
          resolve();
        });
      },
    };
  }

  // Só na memória (testes; ou aparelho sem IndexedDB e sem localStorage).
  function memoria() {
    var dados = new Map();   // pid → Map(id → reg)
    return function (pid) {
      if (!dados.has(pid)) dados.set(pid, new Map());
      var m = dados.get(pid);
      function copia(r) { return JSON.parse(JSON.stringify(r)); }
      return {
        tipo: 'memoria',
        carregar: function () { return Promise.resolve(Array.from(m.values()).map(copia)); },
        gravar: function (regs) { regs.forEach(function (r) { m.set(r.id, copia(r)); }); return Promise.resolve(); },
        apagar: function (ids) { ids.forEach(function (id) { m.delete(id); }); return Promise.resolve(); },
      };
    };
  }

  function temLocalStorage() {
    try { var k = '__gbs_teste__'; global.localStorage.setItem(k, '1'); global.localStorage.removeItem(k); return true; } catch (e) { return false; }
  }

  /* ---------- Fila ------------------------------------------------------ */
  function Fila(armaz, ids) {
    this.armaz = armaz;
    this.tipo = armaz.tipo;
    this.ids = { participanteId: ids.participanteId, userId: ids.userId || null, operacaoId: ids.operacaoId || null };
    this.regs = new Map();
    this.falhaGravacao = null;   // última falha ao gravar no aparelho (diagnóstico)
  }

  function ordem(a, b) { return a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

  Fila.prototype.carregar = async function (agora) {
    agora = agora || Date.now();
    var lista = (await this.armaz.carregar()) || [];
    var velhos = [];
    var self = this;
    lista.forEach(function (r) {
      if (!r || !r.id) return;
      if ((r.enviado && r.enviado_em && agora - r.enviado_em > GUARDAR_ENVIADOS_MS) ||
          (r.criado_em && agora - r.criado_em > GUARDAR_QUALQUER_MS && (r.enviado || r.recusado))) {
        velhos.push(r.id);
        return;
      }
      self.regs.set(r.id, r);
    });
    if (velhos.length) { try { await this.armaz.apagar(velhos); } catch (e) { /* tenta de novo na próxima abertura */ } }
  };

  Fila.prototype.gravar = async function (regs) {
    if (!regs.length) return;
    try {
      await this.armaz.gravar(regs);
      this.falhaGravacao = null;
    } catch (e) {
      // Sem espaço ou banco indisponível: os pontos continuam na memória e são enviados mesmo assim.
      this.falhaGravacao = String((e && e.message) || e);
    }
  };

  // pontos: [{ id, lat, lng, prec, t }] (id = UUID gerado no aparelho)
  Fila.prototype.adicionar = async function (pontos, agora) {
    agora = agora || Date.now();
    var self = this;
    var novos = [];
    (pontos || []).forEach(function (p) {
      if (!p || !p.id || self.regs.has(p.id)) return;
      var r = {
        id: String(p.id), participante_id: self.ids.participanteId, user_id: self.ids.userId, operacao_id: self.ids.operacaoId,
        lat: p.lat, lng: p.lng, prec: p.prec == null ? null : p.prec, t: p.t,
        enviado: false, enviado_em: null, recusado: null, tentativas: 0, criado_em: agora,
      };
      self.regs.set(r.id, r);
      novos.push(r);
    });
    await this.gravar(novos);
    // Limite de pendentes no aparelho: descarta os mais antigos (como a fila anterior).
    var pend = this.pendentes();
    if (pend.length > LIMITE_PENDENTES) {
      var fora = pend.slice(0, pend.length - LIMITE_PENDENTES).map(function (r) { return r.id; });
      fora.forEach(function (id) { self.regs.delete(id); });
      try { await this.armaz.apagar(fora); } catch (e) { /* ignora */ }
    }
    return novos;
  };

  // Pendentes (não enviados nem recusados), em ordem cronológica do GPS.
  Fila.prototype.pendentes = function (limite) {
    var lista = [];
    this.regs.forEach(function (r) { if (!r.enviado && !r.recusado) lista.push(r); });
    lista.sort(ordem);
    return limite ? lista.slice(0, limite) : lista;
  };

  Fila.prototype.qtdPendentes = function () {
    var n = 0;
    this.regs.forEach(function (r) { if (!r.enviado && !r.recusado) n++; });
    return n;
  };

  Fila.prototype.recusados = function () {
    var lista = [];
    this.regs.forEach(function (r) { if (r.recusado) lista.push(r); });
    return lista.sort(ordem);
  };

  Fila.prototype.qtdEnviados = function () {
    var n = 0;
    this.regs.forEach(function (r) { if (r.enviado) n++; });
    return n;
  };

  // Só depois da confirmação do servidor.
  Fila.prototype.marcarEnviados = async function (ids, quando) {
    quando = quando || Date.now();
    var self = this, mudados = [];
    (ids || []).forEach(function (id) {
      var r = self.regs.get(String(id));
      if (r && !r.enviado) { r.enviado = true; r.enviado_em = quando; r.recusado = null; mudados.push(r); }
    });
    await this.gravar(mudados);
    return mudados.length;
  };

  // lista: [{ id, motivo }]
  Fila.prototype.marcarRecusados = async function (lista) {
    var self = this, mudados = [];
    (lista || []).forEach(function (x) {
      var r = x && self.regs.get(String(x.id));
      if (r && !r.enviado) { r.recusado = String(x.motivo || 'recusado'); mudados.push(r); }
    });
    await this.gravar(mudados);
    return mudados.length;
  };

  Fila.prototype.registrarTentativa = async function (ids) {
    var self = this, mudados = [];
    ids.forEach(function (id) { var r = self.regs.get(id); if (r) { r.tentativas = (r.tentativas || 0) + 1; mudados.push(r); } });
    await this.gravar(mudados);
  };

  // Fim da participação: apaga tudo deste participante no aparelho.
  Fila.prototype.limpar = async function () {
    var ids = Array.from(this.regs.keys());
    this.regs.clear();
    if (ids.length) { try { await this.armaz.apagar(ids); } catch (e) { /* ignora */ } }
  };

  /* ---------- Abertura -------------------------------------------------- */
  // o: { participanteId, userId, operacaoId, legado?: [pontos da fila antiga], armazenamento?: fábrica(pid) }
  async function abrir(o) {
    var pid = o.participanteId;
    var armaz = null;
    if (o.armazenamento) {
      armaz = o.armazenamento(pid);
    } else {
      var db = await abrirIndexedDB();
      if (db) armaz = armazenamentoIndexedDB(db, pid);
      else if (temLocalStorage()) armaz = armazenamentoLocal(pid);
      else armaz = memoria()(pid);
    }
    var fila = new Fila(armaz, o);
    try {
      await fila.carregar();
    } catch (e) {
      if (armaz.tipo === 'indexeddb' && temLocalStorage()) {
        fila = new Fila(armazenamentoLocal(pid), o);
        await fila.carregar();
      }
    }
    if (o.legado && o.legado.length) await fila.adicionar(o.legado);
    return fila;
  }

  /* ---------- Envio ------------------------------------------------------ */
  // rpc(nome, args, ms) → Promise (Comunicacao.rpc). opcoes: { lote, gps, ajustarHora(pontos), tempoMs }
  // Devolve { vazio, confirmados, recusados, restantes, antigo, resp, lote }. Erros de rede sobem.
  async function enviarLote(fila, rpc, opcoes) {
    opcoes = opcoes || {};
    var lote = fila.pendentes(opcoes.lote || 200);
    if (!lote.length) return { vazio: true, confirmados: 0, recusados: 0, restantes: 0, lote: [] };
    var pontos = lote.map(function (r) { return { id: r.id, lat: r.lat, lng: r.lng, prec: r.prec, t: r.t }; });
    if (opcoes.ajustarHora) pontos = opcoes.ajustarHora(pontos);
    var args = { p_participante: fila.ids.participanteId, p_pontos: pontos, p_gps: opcoes.gps == null ? null : opcoes.gps };
    await fila.registrarTentativa(lote.map(function (r) { return r.id; }));
    var resp, antigo = false;
    try {
      resp = await rpc('enviar_posicoes_lote', args, opcoes.tempoMs || 20000);
    } catch (e) {
      if (!e || e.codigo !== 'funcao_ausente') throw e;
      antigo = true;
      resp = await rpc('enviar_posicoes', args, opcoes.tempoMs || 20000);
    }
    var confirmados, recusados = [];
    if (!antigo && resp && Array.isArray(resp.confirmados)) {
      confirmados = resp.confirmados.map(String);
      recusados = (resp.recusados || []).filter(function (x) { return x && x.id; });
    } else {
      // Servidor sem a confirmação por ponto: o banco ignora ids repetidos,
      // então o lote é considerado entregue (comportamento anterior).
      confirmados = lote.map(function (r) { return r.id; });
    }
    var nConf = await fila.marcarEnviados(confirmados);
    var nRec = recusados.length ? await fila.marcarRecusados(recusados) : 0;
    var ultimoT = null;
    var conf = new Set(confirmados);
    lote.forEach(function (r) { if (conf.has(r.id) && (ultimoT == null || r.t > ultimoT)) ultimoT = r.t; });
    return { vazio: false, confirmados: nConf, recusados: nRec, restantes: fila.qtdPendentes(), antigo: antigo, resp: resp, lote: lote, ultimoT: ultimoT };
  }

  global.TrilhaLocal = {
    abrir: abrir,
    enviarLote: enviarLote,
    memoria: memoria,
    Fila: Fila,
    LIMITE_PENDENTES: LIMITE_PENDENTES,
  };
})(typeof window !== 'undefined' ? window : globalThis);
