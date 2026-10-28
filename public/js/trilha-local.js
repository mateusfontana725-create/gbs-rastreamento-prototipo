/* =====================================================================
 * trilha-local.js — fila offline dos pontos da trilha GPS
 * Usado pela página do participante e pela "Minha posição" do responsável.
 *
 * Regras:
 *   1. Um ponto só é considerado SALVO depois que o armazenamento do aparelho confirma a gravação
 *      (IndexedDB com durabilidade "strict"; se falhar, localStorage; sem os dois, só memória, que NÃO é salvo).
 *      Ponto que não conseguiu ser gravado fica na memória marcado como "não durável", é regravado
 *      a cada nova tentativa, e a perda possível é registrada e comunicada (diagnostico()).
 *   2. Um ponto só é considerado ENVIADO depois que o servidor confirma que ele existe lá
 *      (enviar_posicoes_lote devolve os ids gravados). Sem confirmação individual
 *      (servidor sem a migração 009), o ponto continua pendente: é reenviado com confirmação
 *      quando o servidor suportar. Nunca é dado como entregue sem confirmação.
 *   3. NADA pendente é descartado: não há limite de pendentes. Recusados pelo servidor ficam guardados,
 *      marcados com o motivo, e aparecem no diagnóstico. Só enviados e confirmados são apagados (após 48 h).
 *   4. Falhas (GPS, armazenamento, sincronização, pontos recusados, intervalos sem ponto) viram
 *      eventos gravados no aparelho (Fila.eventos()), sem repetir a cada tentativa: só a transição.
 *   5. Desempenho: só os pendentes ficam na memória (enviados ficam só no armazenamento); envio em lotes
 *      de 200 (500 quando há muita coisa acumulada); tentativas não são gravadas a cada ponto.
 *
 * Registro de ponto: { id (UUID do aparelho), participante_id, user_id, operacao_id, lat, lng, prec,
 *   t (hora do GPS), estado ('p' pendente, 'e' enviado, 'r' recusado), enviado, enviado_em, recusado,
 *   tentativas, criado_em, legado_enviado_em }.
 * ===================================================================== */
(function (global) {
  'use strict';

  var NOME_BANCO = 'gbs-trilha';
  var VERSAO_BANCO = 2;
  var STORE = 'pontos', STORE_EVENTOS = 'eventos', STORE_META = 'meta';
  var GUARDAR_ENVIADOS_MS = 48 * 3600 * 1000;
  var MAX_EVENTOS = 300;
  var LOTE_PADRAO = 200, LOTE_GRANDE = 500, ACUMULADO_GRANDE = 1000;
  var SEM_LOTE_REVERIFICAR_MS = 5 * 60 * 1000;
  var TENTATIVAS_ALERTA = 5;
  var LACUNA_PADRAO_MS = 60000;

  function uuid() {
    try { if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID(); } catch (e) { /* segue */ }
    return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function estadoDe(r) { return r.enviado ? 'e' : (r.recusado ? 'r' : 'p'); }

  /* ---------- Armazenamentos ------------------------------------------ */
  // Interface (todas devolvem Promise; gravar só resolve depois da gravação confirmada):
  //   tipo, duravel
  //   carregarPendentes() · carregarRecusados() · contarEnviados() · limparAntigos(agora)
  //   gravar([reg]) · apagar([id]) · lerMeta() · gravarMeta(meta)
  //   carregarEventos() · gravarEvento(ev) · apagarEventos([id]) · apagarTudo()

  var bancoAberto = null;   // Promise<IDBDatabase|null>, compartilhada entre as filas
  function abrirIndexedDB() {
    if (bancoAberto) return bancoAberto;
    bancoAberto = new Promise(function (resolve) {
      try {
        if (!global.indexedDB) { resolve(null); return; }
        var r = global.indexedDB.open(NOME_BANCO, VERSAO_BANCO);
        r.onupgradeneeded = function (ev) {
          var db = r.result, tx = r.transaction, st;
          if (!db.objectStoreNames.contains(STORE)) {
            st = db.createObjectStore(STORE, { keyPath: 'id' });
            st.createIndex('participante', 'participante_id', { unique: false });
          } else {
            st = tx.objectStore(STORE);
          }
          if (!st.indexNames.contains('pp')) st.createIndex('pp', ['participante_id', 'estado'], { unique: false });
          if (!db.objectStoreNames.contains(STORE_EVENTOS)) {
            var ev2 = db.createObjectStore(STORE_EVENTOS, { keyPath: 'id' });
            ev2.createIndex('participante', 'participante_id', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'participante_id' });
          // pontos da versão 1 do banco não têm "estado": completa sem perder nenhum
          if (ev.oldVersion >= 1) {
            st.openCursor().onsuccess = function (e) {
              var c = e.target.result;
              if (!c) return;
              var v = c.value;
              if (!v.estado) { v.estado = estadoDe(v); c.update(v); }
              c.continue();
            };
          }
        };
        r.onsuccess = function () {
          var db = r.result;
          // outra aba pede atualização do banco: libera e reabre na próxima operação
          db.onversionchange = function () { try { db.close(); } catch (e) { /* ignora */ } bancoAberto = null; };
          db.onclose = function () { bancoAberto = null; };
          resolve(db);
        };
        r.onerror = function () { bancoAberto = null; resolve(null); };
        r.onblocked = function () { /* espera: outra aba ainda usa a versão antiga */ };
      } catch (e) { bancoAberto = null; resolve(null); }
    });
    return bancoAberto;
  }

  function armazenamentoIndexedDB(pid) {
    // Uma transação por operação; gravações com durabilidade "strict" (esperam o disco, quando o navegador suporta).
    function transacao(nomes, modo, fn) {
      return abrirIndexedDB().then(function (db) {
        if (!db) throw new Error('IndexedDB indisponível');
        return new Promise(function (resolve, reject) {
          var t;
          try {
            try { t = modo === 'readwrite' ? db.transaction(nomes, modo, { durability: 'strict' }) : db.transaction(nomes, modo); }
            catch (e1) { if (e1 && e1.name === 'TypeError') t = db.transaction(nomes, modo); else throw e1; }
            var saida = fn(t);
            t.oncomplete = function () { resolve(saida && saida.result !== undefined ? saida.result : saida); };
            t.onerror = function () { reject(t.error || (saida && saida.error) || new Error('Falha no IndexedDB')); };
            t.onabort = function () { reject(t.error || new Error('Gravação cancelada pelo IndexedDB')); };
          } catch (e) { reject(e); }
        });
      });
    }
    function porEstado(est) {
      return transacao(STORE, 'readonly', function (t) { return t.objectStore(STORE).index('pp').getAll(global.IDBKeyRange.only([pid, est])); });
    }
    return {
      tipo: 'indexeddb', duravel: true,
      carregarPendentes: function () { return porEstado('p'); },
      carregarRecusados: function () { return porEstado('r'); },
      contarEnviados: function () {
        return transacao(STORE, 'readonly', function (t) { return t.objectStore(STORE).index('pp').count(global.IDBKeyRange.only([pid, 'e'])); });
      },
      limparAntigos: function (agora) {
        var n = 0;
        return transacao(STORE, 'readwrite', function (t) {
          t.objectStore(STORE).index('pp').openCursor(global.IDBKeyRange.only([pid, 'e'])).onsuccess = function (e) {
            var c = e.target.result;
            if (!c) return;
            if (c.value.enviado_em && agora - c.value.enviado_em > GUARDAR_ENVIADOS_MS) { c.delete(); n++; }
            c.continue();
          };
          return null;
        }).then(function () { return n; });
      },
      gravar: function (regs) { return transacao(STORE, 'readwrite', function (t) { var st = t.objectStore(STORE); regs.forEach(function (r) { r.estado = estadoDe(r); st.put(r); }); return null; }); },
      apagar: function (ids) { return transacao(STORE, 'readwrite', function (t) { var st = t.objectStore(STORE); ids.forEach(function (id) { st.delete(id); }); return null; }); },
      lerMeta: function () { return transacao(STORE_META, 'readonly', function (t) { return t.objectStore(STORE_META).get(pid); }); },
      gravarMeta: function (m) { return transacao(STORE_META, 'readwrite', function (t) { t.objectStore(STORE_META).put(Object.assign({}, m, { participante_id: pid })); return null; }); },
      carregarEventos: function () { return transacao(STORE_EVENTOS, 'readonly', function (t) { return t.objectStore(STORE_EVENTOS).index('participante').getAll(pid); }); },
      gravarEvento: function (ev) { return transacao(STORE_EVENTOS, 'readwrite', function (t) { t.objectStore(STORE_EVENTOS).put(ev); return null; }); },
      apagarEventos: function (ids) { return transacao(STORE_EVENTOS, 'readwrite', function (t) { var st = t.objectStore(STORE_EVENTOS); ids.forEach(function (id) { st.delete(id); }); return null; }); },
      apagarTudo: function () {
        return transacao([STORE, STORE_EVENTOS, STORE_META], 'readwrite', function (t) {
          var ps = t.objectStore(STORE);
          ps.index('participante').openKeyCursor(global.IDBKeyRange.only(pid)).onsuccess = function (e) { var c = e.target.result; if (c) { ps.delete(c.primaryKey); c.continue(); } };
          var es = t.objectStore(STORE_EVENTOS);
          es.index('participante').openKeyCursor(global.IDBKeyRange.only(pid)).onsuccess = function (e) { var c = e.target.result; if (c) { es.delete(c.primaryKey); c.continue(); } };
          t.objectStore(STORE_META).delete(pid);
          return null;
        });
      },
    };
  }

  // Lista em localStorage: aparelho sem IndexedDB, ou "desvio" quando a gravação no IndexedDB falha.
  function armazenamentoLocal(pid) {
    var kP = 'gbs-trilha:' + pid, kE = 'gbs-trilha-ev:' + pid, kM = 'gbs-trilha-meta:' + pid;
    function ler(k, padrao) {
      try { var v = JSON.parse(global.localStorage.getItem(k)); return v == null ? padrao : v; } catch (e) { return padrao; }
    }
    function escrever(k, v) { global.localStorage.setItem(k, JSON.stringify(v)); }   // erro (cota) sobe para quem chamou
    function como(fn) { return new Promise(function (resolve, reject) { try { resolve(fn()); } catch (e) { reject(e); } }); }
    return {
      tipo: 'localstorage', duravel: true,
      carregarPendentes: function () { return como(function () { return ler(kP, []).filter(function (r) { return estadoDe(r) === 'p'; }); }); },
      carregarRecusados: function () { return como(function () { return ler(kP, []).filter(function (r) { return estadoDe(r) === 'r'; }); }); },
      contarEnviados: function () { return como(function () { return ler(kP, []).filter(function (r) { return estadoDe(r) === 'e'; }).length; }); },
      limparAntigos: function (agora) {
        return como(function () {
          var lista = ler(kP, []), mantem = lista.filter(function (r) { return !(r.enviado && r.enviado_em && agora - r.enviado_em > GUARDAR_ENVIADOS_MS); });
          if (mantem.length !== lista.length) escrever(kP, mantem);
          return lista.length - mantem.length;
        });
      },
      gravar: function (regs) {
        return como(function () {
          var mapa = new Map(ler(kP, []).map(function (r) { return [r.id, r]; }));
          regs.forEach(function (r) { r.estado = estadoDe(r); mapa.set(r.id, r); });
          escrever(kP, Array.from(mapa.values()));
        });
      },
      apagar: function (ids) { return como(function () { var tirar = new Set(ids); escrever(kP, ler(kP, []).filter(function (r) { return !tirar.has(r.id); })); }); },
      lerMeta: function () { return como(function () { return ler(kM, null); }); },
      gravarMeta: function (m) { return como(function () { escrever(kM, Object.assign({}, m, { participante_id: pid })); }); },
      carregarEventos: function () { return como(function () { return ler(kE, []); }); },
      gravarEvento: function (ev) { return como(function () { var l = ler(kE, []); l.push(ev); escrever(kE, l.slice(-MAX_EVENTOS)); }); },
      apagarEventos: function (ids) { return como(function () { var t = new Set(ids); escrever(kE, ler(kE, []).filter(function (e) { return !t.has(e.id); })); }); },
      apagarTudo: function () { return como(function () { [kP, kE, kM].forEach(function (k) { global.localStorage.removeItem(k); }); }); },
    };
  }

  // Só na memória (testes; ou aparelho sem IndexedDB e sem localStorage). NÃO é armazenamento durável.
  // opcoes.duravel = true SIMULA um armazenamento durável (para testes): sem isso, a memória nunca conta como "salvo".
  function memoria(opcoes) {
    var dados = new Map();   // pid → { pts: Map, ev: Map, meta }
    var simulaDuravel = Boolean(opcoes && opcoes.duravel);
    return function (pid) {
      if (!dados.has(pid)) dados.set(pid, { pts: new Map(), ev: new Map(), meta: null });
      var d = dados.get(pid);
      function copia(r) { return JSON.parse(JSON.stringify(r)); }
      function lista(est) { return Array.from(d.pts.values()).filter(function (r) { return estadoDe(r) === est; }).map(copia); }
      return {
        tipo: 'memoria', duravel: simulaDuravel,
        carregarPendentes: function () { return Promise.resolve(lista('p')); },
        carregarRecusados: function () { return Promise.resolve(lista('r')); },
        contarEnviados: function () { return Promise.resolve(lista('e').length); },
        limparAntigos: function (agora) {
          var n = 0;
          d.pts.forEach(function (r, id) { if (r.enviado && r.enviado_em && agora - r.enviado_em > GUARDAR_ENVIADOS_MS) { d.pts.delete(id); n++; } });
          return Promise.resolve(n);
        },
        gravar: function (regs) { regs.forEach(function (r) { r.estado = estadoDe(r); d.pts.set(r.id, copia(r)); }); return Promise.resolve(); },
        apagar: function (ids) { ids.forEach(function (id) { d.pts.delete(id); }); return Promise.resolve(); },
        lerMeta: function () { return Promise.resolve(d.meta ? copia(d.meta) : null); },
        gravarMeta: function (m) { d.meta = copia(m); return Promise.resolve(); },
        carregarEventos: function () { return Promise.resolve(Array.from(d.ev.values()).map(copia)); },
        gravarEvento: function (ev) { d.ev.set(ev.id, copia(ev)); return Promise.resolve(); },
        apagarEventos: function (ids) { ids.forEach(function (id) { d.ev.delete(id); }); return Promise.resolve(); },
        apagarTudo: function () { d.pts.clear(); d.ev.clear(); d.meta = null; return Promise.resolve(); },
      };
    };
  }

  function temLocalStorage() {
    try { var k = '__gbs_teste__'; global.localStorage.setItem(k, '1'); global.localStorage.removeItem(k); return true; } catch (e) { return false; }
  }

  function motivoDaFalha(e) {
    var nome = e && e.name || '', msg = String((e && e.message) || e || '');
    if (/quota/i.test(nome) || /quota|space|full|espa/i.test(msg)) return 'sem_espaco';
    return 'falha_gravacao';
  }

  /* ---------- Fila ------------------------------------------------------ */
  function Fila(armaz, ids, opcoes) {
    opcoes = opcoes || {};
    this.armaz = armaz;
    this.tipo = armaz.tipo;
    this.alternativo = opcoes.alternativo || null;          // desvio (localStorage) se a gravação no principal falhar
    this.ids = { participanteId: ids.participanteId, userId: ids.userId || null, operacaoId: ids.operacaoId || null };
    this.lacunaMs = opcoes.lacunaMs > 0 ? opcoes.lacunaMs : LACUNA_PADRAO_MS;
    this.pend = new Map();         // id → reg (todos os pendentes, duráveis ou não)
    this.ordenados = null;         // cache: pendentes em ordem cronológica
    this.recus = new Map();        // id → reg
    this.nEnviados = 0;
    this.ultimaConfirmacaoEm = null;
    this.ultimoTConfirmado = null;
    this.naoDuraveis = new Set();  // ids ainda NÃO gravados no armazenamento do aparelho
    this.legadoN = 0;              // pendentes já enviados a servidor sem confirmação individual
    this.semLoteDesde = null;
    this.usouAlternativo = false;
    this.falhaGravacao = null;     // última falha ao gravar no aparelho (diagnóstico)
    this.falhaGravacaoEm = null;
    this.persistente = null;       // navigator.storage.persisted()
    this.uso = null; this.quota = null;
    this.eventosMem = [];
    this.transicoes = {};
    this.ultimoCapturadoT = null;
    this.eventosPendentesGravar = [];
  }

  function ordem(a, b) { return a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

  Fila.prototype._ord = function () {
    if (!this.ordenados) this.ordenados = Array.from(this.pend.values()).sort(ordem);
    return this.ordenados;
  };

  // Eventos: falhas e perdas gravadas no aparelho (com a hora). Nunca derrubam o fluxo principal.
  Fila.prototype.registrarEvento = function (tipo, dados, agora) {
    var ev = Object.assign({ id: uuid(), participante_id: this.ids.participanteId, tipo: tipo, t: agora || Date.now() }, dados || {});
    this.eventosMem.push(ev);
    if (this.eventosMem.length > MAX_EVENTOS) this.eventosMem.splice(0, this.eventosMem.length - MAX_EVENTOS);
    var self = this;
    var p = this.armaz.gravarEvento(ev).catch(function () {
      // o próprio registro de eventos falhou (ex.: sem espaço): fica na memória desta sessão
      self.eventosPendentesGravar.push(ev);
    });
    return { evento: ev, gravado: p };
  };

  // Registra só a mudança de estado (começou a falhar / voltou), não cada tentativa.
  Fila.prototype.transicao = function (chave, falhando, dados, agora) {
    agora = agora || Date.now();
    var atual = this.transicoes[chave];
    if (falhando && !atual) {
      this.transicoes[chave] = { desde: agora, dados: dados || {} };
      this.registrarEvento(chave + '_inicio', dados, agora);
    } else if (!falhando && atual) {
      delete this.transicoes[chave];
      this.registrarEvento(chave + '_fim', Object.assign({ duracao_ms: agora - atual.desde }, atual.dados), agora);
    }
  };

  Fila.prototype.emFalha = function (chave) { return Boolean(this.transicoes[chave]); };

  Fila.prototype.carregar = async function (agora) {
    agora = agora || Date.now();
    var self = this;
    var lista = (await this.armaz.carregarPendentes()) || [];
    lista.forEach(function (r) {
      if (!r || !r.id) return;
      self.pend.set(r.id, r);
      if (r.legado_enviado_em) self.legadoN++;
    });
    ((await this.armaz.carregarRecusados()) || []).forEach(function (r) { if (r && r.id) self.recus.set(r.id, r); });
    try { await this.armaz.limparAntigos(agora); } catch (e) { /* tenta de novo na próxima abertura */ }
    try { this.nEnviados = (await this.armaz.contarEnviados()) || 0; } catch (e) { this.nEnviados = 0; }
    try {
      var meta = await this.armaz.lerMeta();
      if (meta) { this.ultimaConfirmacaoEm = meta.ultima_confirmacao_em || null; this.ultimoTConfirmado = meta.ultimo_t_confirmado || null; }
    } catch (e) { /* ignora */ }
    try {
      var evs = ((await this.armaz.carregarEventos()) || []).sort(function (a, b) { return a.t - b.t; });
      if (evs.length > MAX_EVENTOS) {
        var velhos = evs.splice(0, evs.length - MAX_EVENTOS).map(function (e) { return e.id; });
        try { await this.armaz.apagarEventos(velhos); } catch (e) { /* ignora */ }
      }
      this.eventosMem = evs;
    } catch (e) { /* ignora */ }
    var ord = this._ord();
    var maxT = ord.length ? ord[ord.length - 1].t : null;
    this.ultimoCapturadoT = Math.max(maxT || 0, this.ultimoTConfirmado || 0) || null;
  };

  // Grava no aparelho e devolve { duravel }. Falha → desvio para localStorage → senão fica só na memória (não durável).
  Fila.prototype._gravarPontos = async function (regs) {
    if (!regs.length) return { duravel: true };
    var self = this;
    function marcar(duravel) { regs.forEach(function (r) { if (duravel) self.naoDuraveis.delete(r.id); else self.naoDuraveis.add(r.id); }); }
    if (!this.armaz.duravel) { marcar(false); try { await this.armaz.gravar(regs); } catch (e) { /* memória */ } return { duravel: false }; }
    try {
      await this.armaz.gravar(regs);
      marcar(true);
      if (this.transicoes.armazenamento) this.transicao('armazenamento', false);
      return { duravel: true };
    } catch (e) {
      var motivo = motivoDaFalha(e);
      this.falhaGravacao = String((e && e.message) || e);
      this.falhaGravacaoEm = Date.now();
      if (this.alternativo) {
        try {
          await this.alternativo.gravar(regs);
          this.usouAlternativo = true;
          marcar(true);
          this.transicao('armazenamento_principal', true, { motivo: motivo });
          return { duravel: true, alternativo: true };
        } catch (e2) { motivo = motivoDaFalha(e2) === 'sem_espaco' ? 'sem_espaco' : motivo; }
      }
      marcar(false);
      this.transicao('armazenamento', true, { motivo: motivo, mensagem: this.falhaGravacao });
      return { duravel: false, motivo: motivo };
    }
  };

  // Regrava os pontos que ainda não estão no aparelho (chamado a cada ponto novo e pelos temporizadores dos chamadores).
  Fila.prototype.persistirPendentes = async function () {
    // eventos que não puderam ser gravados antes (ex.: sem espaço) são tentados de novo
    if (this.eventosPendentesGravar.length && this.armaz.duravel) {
      var evs = this.eventosPendentesGravar.splice(0);
      for (var j = 0; j < evs.length; j++) { try { await this.armaz.gravarEvento(evs[j]); } catch (e) { this.eventosPendentesGravar.push(evs[j]); } }
    }
    if (!this.naoDuraveis.size || !this.armaz.duravel) return { restantes: this.naoDuraveis.size };
    var self = this;
    var regs = Array.from(this.naoDuraveis).map(function (id) { return self.pend.get(id); }).filter(Boolean);
    for (var i = 0; i < regs.length; i += 500) await this._gravarPontos(regs.slice(i, i + 500));
    if (!this.naoDuraveis.size) this.registrarEvento('armazenamento_recuperado', { qtd: regs.length });
    return { restantes: this.naoDuraveis.size };
  };

  // Pontos que foram parar no desvio (localStorage) voltam para o IndexedDB quando ele volta a gravar.
  Fila.prototype.reconciliarAlternativo = async function () {
    if (!this.alternativo || !this.armaz.duravel) return 0;
    var desvio;
    try { desvio = (await this.alternativo.carregarPendentes()).concat(await this.alternativo.carregarRecusados()); } catch (e) { return 0; }
    if (!desvio.length) return 0;
    var self = this;
    desvio.forEach(function (r) {
      if (r && r.id && !self.pend.has(r.id) && !self.recus.has(r.id)) {
        if (r.recusado) self.recus.set(r.id, r); else { self.pend.set(r.id, r); self.ordenados = null; if (r.legado_enviado_em) self.legadoN++; }
      }
    });
    try {
      await this.armaz.gravar(desvio);
      await this.alternativo.apagar(desvio.map(function (r) { return r.id; }));
      this.registrarEvento('armazenamento_reconciliado', { qtd: desvio.length });
      return desvio.length;
    } catch (e) { return 0; }   // continua no desvio; tenta na próxima abertura
  };

  // pontos: [{ id, lat, lng, prec, t }] (id = UUID gerado no aparelho).
  // Devolve { adicionados, duraveis, naoDuraveis }: "duraveis" só é true quando o aparelho confirmou a gravação de todos.
  Fila.prototype.adicionar = async function (pontos, agora) {
    agora = agora || Date.now();
    var self = this, novos = [];
    (pontos || []).forEach(function (p) {
      if (!p || !p.id || self.pend.has(String(p.id)) || self.recus.has(String(p.id))) return;
      var r = {
        id: String(p.id), participante_id: self.ids.participanteId, user_id: self.ids.userId, operacao_id: self.ids.operacaoId,
        lat: p.lat, lng: p.lng, prec: p.prec == null ? null : p.prec, t: p.t,
        estado: 'p', enviado: false, enviado_em: null, recusado: null, tentativas: 0, criado_em: agora,
      };
      // intervalo sem registro entre pontos capturados: fica anotado (e a trilha não liga os dois lados como se fosse contínua)
      if (self.ultimoCapturadoT != null && r.t - self.ultimoCapturadoT > self.lacunaMs) {
        self.registrarEvento('lacuna', { de: self.ultimoCapturadoT, ate: r.t, ms: r.t - self.ultimoCapturadoT }, agora);
      }
      if (self.ultimoCapturadoT == null || r.t > self.ultimoCapturadoT) self.ultimoCapturadoT = r.t;
      self.pend.set(r.id, r);
      var ord = self.ordenados;
      if (ord) { if (!ord.length || ordem(ord[ord.length - 1], r) <= 0) ord.push(r); else self.ordenados = null; }
      novos.push(r);
    });
    var regravar = this.naoDuraveis.size ? Array.from(this.naoDuraveis).map(function (id) { return self.pend.get(id); }).filter(function (r) { return r && novos.indexOf(r) === -1; }) : [];
    var res = await this._gravarPontos(novos.concat(regravar));
    if (res.duravel && !res.alternativo && this.usouAlternativo) this.reconciliarAlternativo().catch(function () { /* tenta na próxima */ });
    return { adicionados: novos.length, duraveis: res.duravel && !this.naoDuraveis.size, naoDuraveis: this.naoDuraveis.size };
  };

  // Todos os pendentes (não confirmados pelo servidor) em ordem cronológica do GPS.
  Fila.prototype.pendentes = function (limite) {
    var ord = this._ord();
    return limite ? ord.slice(0, limite) : ord.slice();
  };

  Fila.prototype.servidorAntigoAtivo = function (agora) {
    return this.semLoteDesde != null && (agora || Date.now()) - this.semLoteDesde < SEM_LOTE_REVERIFICAR_MS;
  };

  // Pendentes que vale a pena enviar agora (com servidor antigo, os já enviados sem confirmação esperam o servidor atualizar).
  Fila.prototype.elegiveis = function (limite, agora) {
    var ord = this._ord();
    if (!this.servidorAntigoAtivo(agora)) return limite ? ord.slice(0, limite) : ord.slice();
    var saida = [];
    for (var i = 0; i < ord.length && (!limite || saida.length < limite); i++) if (!ord[i].legado_enviado_em) saida.push(ord[i]);
    return saida;
  };

  Fila.prototype.qtdPendentes = function () { return this.pend.size; };
  Fila.prototype.qtdParaEnviar = function (agora) { return this.servidorAntigoAtivo(agora) ? this.pend.size - this.legadoN : this.pend.size; };
  Fila.prototype.qtdNaoDuraveis = function () { return this.naoDuraveis.size; };
  Fila.prototype.recusados = function () { return Array.from(this.recus.values()).sort(ordem); };
  Fila.prototype.qtdEnviados = function () { return this.nEnviados; };
  Fila.prototype.eventos = function (limite) { return limite ? this.eventosMem.slice(-limite) : this.eventosMem.slice(); };

  // Só depois da confirmação do servidor.
  Fila.prototype.marcarEnviados = async function (ids, quando) {
    quando = quando || Date.now();
    var self = this, mudados = [], maxT = this.ultimoTConfirmado;
    (ids || []).forEach(function (id) {
      var r = self.pend.get(String(id));
      if (!r) return;
      if (r.legado_enviado_em) self.legadoN--;
      r.enviado = true; r.enviado_em = quando; r.recusado = null; r.estado = 'e';
      self.pend.delete(r.id);
      self.naoDuraveis.delete(r.id);
      self.nEnviados++;
      if (maxT == null || r.t > maxT) maxT = r.t;
      mudados.push(r);
    });
    if (!mudados.length) return 0;
    if (this.ordenados) this.ordenados = this.ordenados.filter(function (r) { return self.pend.has(r.id); });
    this.ultimaConfirmacaoEm = quando;
    this.ultimoTConfirmado = maxT;
    try { await this.armaz.gravar(mudados); } catch (e) { /* no pior caso, volta como pendente na próxima abertura e é confirmado de novo (id repetido não duplica) */ }
    try { await this.armaz.gravarMeta({ ultima_confirmacao_em: quando, ultimo_t_confirmado: maxT }); } catch (e) { /* ignora */ }
    return mudados.length;
  };

  // lista: [{ id, motivo }] — o servidor recusou. Ficam guardados com o motivo (não são reenviados nem apagados).
  Fila.prototype.marcarRecusados = async function (lista) {
    var self = this, mudados = [], motivos = {};
    (lista || []).forEach(function (x) {
      var r = x && self.pend.get(String(x.id));
      if (!r) return;
      if (r.legado_enviado_em) self.legadoN--;
      r.recusado = String(x.motivo || 'recusado'); r.estado = 'r';
      self.pend.delete(r.id); self.naoDuraveis.delete(r.id); self.recus.set(r.id, r);
      motivos[r.recusado] = (motivos[r.recusado] || 0) + 1;
      mudados.push(r);
    });
    if (!mudados.length) return 0;
    if (this.ordenados) this.ordenados = this.ordenados.filter(function (r) { return self.pend.has(r.id); });
    try { await this.armaz.gravar(mudados); } catch (e) { /* ignora */ }
    this.registrarEvento('sync_recusado', { qtd: mudados.length, motivos: motivos, de: Math.min.apply(null, mudados.map(function (r) { return r.t; })), ate: Math.max.apply(null, mudados.map(function (r) { return r.t; })) });
    return mudados.length;
  };

  Fila.prototype.registrarTentativa = function (ids) {
    var self = this;
    ids.forEach(function (id) { var r = self.pend.get(id); if (r) r.tentativas = (r.tentativas || 0) + 1; });
  };

  Fila.prototype._marcarLegado = async function (regs, quando) {
    var self = this, mudados = [];
    regs.forEach(function (r) { if (!r.legado_enviado_em) { r.legado_enviado_em = quando; self.legadoN++; mudados.push(r); } });
    try { await this.armaz.gravar(mudados); } catch (e) { /* ignora */ }
    return mudados.length;
  };

  // Resumo do estado para a interface (síncrono). O que o usuário precisa saber: o que está pendente, desde quando,
  // se está gravado no aparelho, quando o servidor confirmou pela última vez e o que se perdeu ou falhou.
  Fila.prototype.diagnostico = function (agora) {
    agora = agora || Date.now();
    var ord = this._ord();
    var mais = ord.length ? ord[0] : null;
    var estadoGravacao;
    if (!this.armaz.duravel) estadoGravacao = 'memoria';
    else if (this.naoDuraveis.size) estadoGravacao = 'falha';
    else if (this.armaz.tipo === 'localstorage' || this.usouAlternativo) estadoGravacao = 'alternativo';
    else estadoGravacao = 'duravel';
    var tentativasAltas = 0;
    this.pend.forEach(function (r) { if ((r.tentativas || 0) >= TENTATIVAS_ALERTA) tentativasAltas++; });
    var perdas = this.eventosMem.filter(function (e) { return e.tipo === 'lacuna' || e.tipo === 'sync_recusado'; });
    return {
      tipo: this.tipo, estadoGravacao: estadoGravacao, persistente: this.persistente, uso: this.uso, quota: this.quota,
      pendentes: this.pend.size, naoDuraveis: this.naoDuraveis.size, semConfirmacao: this.legadoN, semConfirmacaoRepetida: tentativasAltas,
      maisAntigaT: mais ? mais.t : null, idadeMaisAntigaMs: mais ? Math.max(0, agora - mais.t) : null,
      enviados: this.nEnviados, recusados: this.recus.size, ultimaConfirmacaoEm: this.ultimaConfirmacaoEm,
      falhaGravacao: this.falhaGravacao, falhaGravacaoEm: this.falhaGravacaoEm, servidorSemConfirmacao: this.servidorAntigoAtivo(agora) || this.legadoN > 0,
      falhas: Object.keys(this.transicoes), lacunas: this.eventosMem.filter(function (e) { return e.tipo === 'lacuna'; }).length,
      perdas: perdas.length, eventosRecentes: this.eventosMem.slice(-8),
    };
  };

  // Pede ao navegador que não apague o armazenamento sozinho e mede o espaço. Nunca falha.
  Fila.prototype.verificarArmazenamento = async function () {
    try {
      var s = global.navigator && global.navigator.storage;
      if (s && s.persisted) {
        var p = await s.persisted();
        if (!p && s.persist) p = await s.persist();
        this.persistente = Boolean(p);
        if (!p && !this._avisouPersist) { this._avisouPersist = true; this.registrarEvento('armazenamento_nao_persistente', {}); }
      }
      if (s && s.estimate) {
        var e = await s.estimate();
        this.uso = e.usage == null ? null : e.usage; this.quota = e.quota == null ? null : e.quota;
        if (this.quota && this.uso / this.quota > 0.8 && !this._avisouEspaco) { this._avisouEspaco = true; this.registrarEvento('armazenamento_quase_cheio', { uso: this.uso, quota: this.quota }); }
      }
    } catch (err) { /* sem suporte */ }
  };

  // Fim da participação: apaga tudo deste participante no aparelho.
  Fila.prototype.limpar = async function () {
    this.pend.clear(); this.recus.clear(); this.ordenados = null; this.naoDuraveis.clear(); this.legadoN = 0; this.eventosMem = [];
    try { await this.armaz.apagarTudo(); } catch (e) { /* ignora */ }
    if (this.alternativo) { try { await this.alternativo.apagarTudo(); } catch (e) { /* ignora */ } }
  };

  /* ---------- Abertura -------------------------------------------------- */
  // o: { participanteId, userId, operacaoId, legado?: [pontos da fila antiga], armazenamento?: fábrica(pid),
  //      alternativo?: fábrica(pid), lacunaMs?, persistencia?: boolean (padrão true) }
  async function abrir(o) {
    var pid = o.participanteId;
    var armaz = null, alt = null;
    if (o.armazenamento) {
      armaz = o.armazenamento(pid);
      if (o.alternativo) alt = o.alternativo(pid);
    } else {
      var db = await abrirIndexedDB();
      if (db) {
        armaz = armazenamentoIndexedDB(pid);
        if (temLocalStorage()) alt = armazenamentoLocal(pid);
      } else if (temLocalStorage()) {
        armaz = armazenamentoLocal(pid);
      } else {
        armaz = memoria()(pid);
      }
    }
    var fila = new Fila(armaz, o, { alternativo: alt, lacunaMs: o.lacunaMs });
    try {
      await fila.carregar();
    } catch (e) {
      // o armazenamento principal não abriu: tenta o desvio; se nada abrir, segue só na memória (e avisa)
      var motivo = motivoDaFalha(e);
      var outro = alt || (temLocalStorage() && armaz.tipo !== 'localstorage' ? armazenamentoLocal(pid) : null);
      if (outro) {
        fila = new Fila(outro, o, { lacunaMs: o.lacunaMs });
        try { await fila.carregar(); } catch (e2) { fila = new Fila(memoria()(pid), o, { lacunaMs: o.lacunaMs }); }
      } else {
        fila = new Fila(memoria()(pid), o, { lacunaMs: o.lacunaMs });
      }
      fila.registrarEvento('armazenamento_indisponivel', { motivo: motivo, usando: fila.tipo });
      fila.transicao('armazenamento_principal', true, { motivo: motivo });
    }
    if (!armaz.duravel && armaz.tipo === 'memoria' && !o.armazenamento) fila.registrarEvento('armazenamento_indisponivel', { motivo: 'sem_armazenamento', usando: 'memoria' });
    if (fila.alternativo) await fila.reconciliarAlternativo();
    if (o.legado && o.legado.length) await fila.adicionar(o.legado);
    if (o.persistencia !== false) fila.verificarArmazenamento();
    return fila;
  }

  /* ---------- Envio ------------------------------------------------------ */
  // rpc(nome, args, ms) → Promise (Comunicacao.rpc). opcoes: { lote, gps, ajustarHora(pontos), tempoMs }
  // Devolve { vazio, confirmados, recusados, restantes, semConfirmacao, resp, lote, ultimoT }. Erros de rede sobem.
  async function enviarLote(fila, rpc, opcoes) {
    opcoes = opcoes || {};
    var agora = Date.now();
    var n = opcoes.lote || LOTE_PADRAO;
    if (fila.qtdParaEnviar(agora) > ACUMULADO_GRANDE) n = Math.max(n, LOTE_GRANDE);   // muito acumulado: lotes maiores (limite do servidor: 500)
    n = Math.min(n, LOTE_GRANDE);
    var lote = fila.elegiveis(n, agora);
    if (!lote.length) return { vazio: true, confirmados: 0, recusados: 0, semConfirmacao: 0, restantes: fila.qtdPendentes(), lote: [] };
    var pontos = lote.map(function (r) { return { id: r.id, lat: r.lat, lng: r.lng, prec: r.prec, t: r.t }; });
    if (opcoes.ajustarHora) pontos = opcoes.ajustarHora(pontos);
    var args = { p_participante: fila.ids.participanteId, p_pontos: pontos, p_gps: opcoes.gps == null ? null : opcoes.gps };
    fila.registrarTentativa(lote.map(function (r) { return r.id; }));
    var resp, antigo = false;
    try {
      if (fila.servidorAntigoAtivo(agora)) {
        antigo = true;
      } else {
        try {
          resp = await rpc('enviar_posicoes_lote', args, opcoes.tempoMs || 20000);
        } catch (e) {
          if (!e || e.codigo !== 'funcao_ausente') throw e;
          antigo = true;
          fila.semLoteDesde = Date.now();
        }
      }
      if (antigo) {
        // Servidor sem a confirmação por ponto (migração 009 ausente): entrega os que ainda não foram, mas NÃO os dá como
        // enviados. Ficam pendentes ("sem confirmação") e são confirmados quando o servidor suportar o lote.
        var novos = lote.filter(function (r) { return !r.legado_enviado_em; });
        if (!novos.length) return { vazio: true, confirmados: 0, recusados: 0, semConfirmacao: 0, restantes: fila.qtdPendentes(), lote: lote, antigo: true };
        var pn = args.p_pontos.filter(function (p) { return novos.some(function (r) { return r.id === p.id; }); });
        resp = await rpc('enviar_posicoes', Object.assign({}, args, { p_pontos: pn }), opcoes.tempoMs || 20000);
        await fila._marcarLegado(novos, Date.now());
        fila.transicao('servidor_sem_confirmacao', true, { qtd: novos.length });
        fila.transicao('sync', false);
        return { vazio: false, confirmados: 0, recusados: 0, semConfirmacao: novos.length, restantes: fila.qtdPendentes(), antigo: true, resp: resp, lote: lote, ultimoT: null };
      }
    } catch (e) {
      fila.transicao('sync', true, { codigo: (e && e.codigo) || 'erro', mensagem: String((e && e.message) || e).slice(0, 200) });
      throw e;
    }
    if (!resp || !Array.isArray(resp.confirmados)) {
      // resposta sem a lista de confirmados: nada pode ser dado como enviado
      var errResp = new Error('O servidor não confirmou os pontos.');
      errResp.codigo = 'resposta_sem_confirmacao';
      fila.transicao('sync', true, { codigo: errResp.codigo, mensagem: errResp.message });
      throw errResp;
    }
    fila.transicao('servidor_sem_confirmacao', false);
    fila.transicao('sync', false);
    var noLote = new Set(lote.map(function (r) { return r.id; }));
    var confirmados = resp.confirmados.map(String).filter(function (id) { return noLote.has(id); });
    var recusados = (resp.recusados || []).filter(function (x) { return x && x.id && noLote.has(String(x.id)); });
    var nConf = await fila.marcarEnviados(confirmados);
    var nRec = recusados.length ? await fila.marcarRecusados(recusados) : 0;
    var ultimoT = null;
    var conf = new Set(confirmados);
    lote.forEach(function (r) { if (conf.has(r.id) && (ultimoT == null || r.t > ultimoT)) ultimoT = r.t; });
    var semResposta = lote.length - nConf - nRec;   // nem confirmado nem recusado: continua pendente
    if (semResposta > 0) fila.registrarEvento('sync_nao_confirmado', { qtd: semResposta });
    return { vazio: false, confirmados: nConf, recusados: nRec, semConfirmacao: 0, semResposta: semResposta, restantes: fila.qtdPendentes(), antigo: false, resp: resp, lote: lote, ultimoT: ultimoT };
  }

  global.TrilhaLocal = {
    abrir: abrir,
    enviarLote: enviarLote,
    memoria: memoria,
    armazenamentoLocal: armazenamentoLocal,
    Fila: Fila,
    LOTE_PADRAO: LOTE_PADRAO,
  };
})(typeof window !== 'undefined' ? window : globalThis);
