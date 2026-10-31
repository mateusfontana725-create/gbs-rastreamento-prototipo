/* =====================================================================
 * arquivo-local.js — leitura de operação ARQUIVADA (migração 055, api/arquivar.js).
 *
 *   Operação arquivada não tem mais as linhas no banco: elas estão num arquivo JSON compactado no Storage
 *   (bucket privado "arquivos"). Ao abrir o painel (ou o SCI) dessa operação, o arquivo é baixado uma vez,
 *   conferido (SHA-256) e registrado aqui. A partir daí, comunicacao.js pergunta a este módulo antes de ir ao
 *   servidor:
 *     - consultas (C.cliente.from(...)) às tabelas que estão no arquivo, filtradas por esta operação, são
 *       respondidas daqui, com os mesmos operadores do supabase-js (select, eq, neq, is, in, gt, gte, lt, lte,
 *       order, limit, range, maybeSingle, single, contagem);
 *     - relatorio_operacao, sci_contexto e briefing_operacao_dados vêm das leituras guardadas no arquivo
 *       (o relatório recebe o resultado e os dados atuais da operação).
 *   Tudo o mais (operações ativas, outras tabelas, Storage, gravações) segue para o servidor sem mudança.
 *   O núcleo (resolver/aplicar) não depende do navegador e é testado no Node (testes/arquivo_local.test.js).
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var FORMATO = 'gbs-arquivo-operacao';
  var LEITURAS_DO_ARQUIVO = ['relatorio_operacao', 'sci_contexto', 'briefing_operacao_dados'];
  var SEM_EFEITO = ['abortSignal', 'returns', 'throwOnError'];
  var registro = {};          // opId → { doc, extras, ordem }
  var contador = 0;
  var MAXIMO = 2;             // arquivos guardados na memória ao mesmo tempo

  /* ---------- comparação no estilo do PostgreSQL ------------------------ */
  var ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/;
  function numero(v) { return typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : null); }
  function comparar(a, b) {
    var na = numero(a), nb = numero(b);
    if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
    if (typeof a === 'string' && typeof b === 'string' && ISO.test(a) && ISO.test(b)) {
      var da = Date.parse(a), db = Date.parse(b);
      if (!isNaN(da) && !isNaN(db)) return da < db ? -1 : da > db ? 1 : 0;
    }
    var sa = String(a), sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  function igual(a, b) {
    if (b === null || b === undefined) return a === null || a === undefined;
    if (a === null || a === undefined) return false;
    if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
    return comparar(a, b) === 0 || String(a) === String(b);
  }

  /* ---------- aplica a cadeia de chamadas sobre as linhas --------------- */
  // passos: [[metodo, [args...]], ...]. Devolve { data, error, count, status } como o supabase-js.
  function aplicar(linhasOriginais, passos) {
    var linhas = linhasOriginais.slice();
    var colunas = null, contar = false, cabeca = false, ordens = [], limite = null, faixa = null, umSo = null;
    for (var i = 0; i < passos.length; i++) {
      var m = passos[i][0], a = passos[i][1] || [];
      if (m === 'select') {
        colunas = a[0];
        var o = a[1] || {};
        contar = Boolean(o.count);
        cabeca = Boolean(o.head);
      } else if (m === 'eq') linhas = linhas.filter(function (l) { return igual(l[a[0]], a[1]); });
      else if (m === 'neq') linhas = linhas.filter(function (l) { return !igual(l[a[0]], a[1]); });
      else if (m === 'is') linhas = linhas.filter(function (l) { return a[1] === null ? l[a[0]] === null || l[a[0]] === undefined : l[a[0]] === a[1]; });
      else if (m === 'in') linhas = linhas.filter(function (l) { return (a[1] || []).some(function (v) { return igual(l[a[0]], v); }); });
      else if (m === 'gt' || m === 'gte' || m === 'lt' || m === 'lte') {
        linhas = linhas.filter(function (l) {
          if (l[a[0]] === null || l[a[0]] === undefined) return false;
          var c = comparar(l[a[0]], a[1]);
          return m === 'gt' ? c > 0 : m === 'gte' ? c >= 0 : m === 'lt' ? c < 0 : c <= 0;
        });
      } else if (m === 'order') ordens.push({ col: a[0], asc: !(a[1] && a[1].ascending === false), nullsFirst: a[1] && a[1].nullsFirst });
      else if (m === 'limit') limite = Number(a[0]);
      else if (m === 'range') faixa = [Number(a[0]), Number(a[1])];
      else if (m === 'maybeSingle' || m === 'single') umSo = m;
      else if (SEM_EFEITO.indexOf(m) === -1) {
        return { data: null, count: null, status: 400, statusText: 'Bad Request',
          error: { message: 'Consulta não disponível na operação arquivada (' + m + ').', code: 'arquivo_consulta' } };
      }
    }
    if (ordens.length) {
      linhas = linhas.map(function (l, i) { return { l: l, i: i }; }).sort(function (x, y) {
        for (var k = 0; k < ordens.length; k++) {
          var o = ordens[k], va = x.l[o.col], vb = y.l[o.col];
          var na = va === null || va === undefined, nb = vb === null || vb === undefined;
          if (na || nb) {
            if (na && nb) continue;
            // PostgreSQL: nulos por último na crescente e primeiro na decrescente (salvo nullsFirst)
            var nulosPrimeiro = o.nullsFirst === undefined ? !o.asc : Boolean(o.nullsFirst);
            return (na ? -1 : 1) * (nulosPrimeiro ? 1 : -1);
          }
          var c = comparar(va, vb);
          if (c) return o.asc ? c : -c;
        }
        return x.i - y.i;
      }).map(function (x) { return x.l; });
    }
    var total = linhas.length;
    if (faixa) linhas = linhas.slice(faixa[0], faixa[1] + 1);
    if (limite !== null) linhas = linhas.slice(0, limite);
    if (colunas && colunas.trim() !== '*') {
      var cols = colunas.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
      linhas = linhas.map(function (l) { var r = {}; cols.forEach(function (c) { r[c] = l[c] === undefined ? null : l[c]; }); return r; });
    } else {
      linhas = linhas.map(function (l) { return Object.assign({}, l); });
    }
    var res = { error: null, status: 200, statusText: 'OK', count: contar ? total : null, data: cabeca ? null : linhas };
    if (umSo && !cabeca) {
      if (umSo === 'single' && linhas.length !== 1) {
        return { data: null, count: res.count, status: 406, statusText: 'Not Acceptable',
          error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
      }
      res.data = linhas.length ? linhas[0] : null;
    }
    return res;
  }

  /* ---------- qual arquivo responde a esta consulta ---------------------- */
  // Com filtro operacao_id: o arquivo dessa operação (se registrado e se tem a tabela).
  // Sem ele (ex.: diario_versoes por diario_id): o arquivo que tem linhas que batem com todos os filtros eq.
  function escolher(reg, tabela, passos) {
    var eqs = passos.filter(function (p) { return p[0] === 'eq'; });
    var porOp = eqs.filter(function (p) { return p[1] && p[1][0] === 'operacao_id'; })[0];
    if (porOp) {
      var e = reg[String(porOp[1][1])];
      return e && Array.isArray(e.doc.tabelas[tabela]) ? e : null;
    }
    if (!eqs.length) return null;
    var ids = Object.keys(reg);
    for (var i = 0; i < ids.length; i++) {
      var linhas = reg[ids[i]].doc.tabelas[tabela];
      if (!Array.isArray(linhas)) continue;
      var bate = linhas.some(function (l) { return eqs.every(function (p) { return igual(l[p[1][0]], p[1][1]); }); });
      if (bate) return reg[ids[i]];
    }
    return null;
  }

  // Consulta: resultado do arquivo, ou null (vai ao servidor)
  function resolver(reg, tabela, passos) {
    var e = escolher(reg, tabela, passos);
    return e ? aplicar(e.doc.tabelas[tabela], passos) : null;
  }

  function clonar(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  // RPC: leitura guardada no arquivo, ou undefined (vai ao servidor)
  function resolverRpc(reg, nome, args) {
    var id = args && args.p_operacao;
    var e = id && reg[String(id)];
    if (!e) return undefined;
    var leituras = e.doc.leituras || {};
    if (LEITURAS_DO_ARQUIVO.indexOf(nome) === -1) return undefined;
    if (leituras[nome] === undefined || leituras[nome] === null) {
      var erro = new Error('Esta leitura não foi guardada no arquivo da operação (' + nome + ').');
      erro.codigo = 'operacao_arquivada';
      throw erro;
    }
    var r = clonar(leituras[nome]);
    if (nome === 'relatorio_operacao' && r && r.operacao) {
      // dados atuais da operação (o resultado pode ser registrado depois do arquivamento) e a data desta geração
      var viva = (e.extras && e.extras.operacao) || {};
      Object.keys(r.operacao).forEach(function (k) { if (Object.prototype.hasOwnProperty.call(viva, k)) r.operacao[k] = viva[k]; });
      r.gerado_em = new Date().toISOString();
      if (e.extras && e.extras.usuarioNome) r.gerado_por_nome = e.extras.usuarioNome;
    }
    return r;
  }

  /* ---------- registro e carga do arquivo -------------------------------- */
  function validar(doc, opId) {
    if (!doc || doc.formato !== FORMATO || !doc.tabelas || typeof doc.tabelas !== 'object') throw new Error('arquivo em formato desconhecido');
    if (!doc.operacao || String(doc.operacao.id) !== String(opId)) throw new Error('o arquivo é de outra operação');
    var c = doc.contagens || {};
    Object.keys(c).forEach(function (k) {
      if (!Array.isArray(doc.tabelas[k]) || doc.tabelas[k].length !== c[k]) throw new Error('arquivo incompleto (' + k + ')');
    });
  }
  function registrar(opId, doc, extras) {
    validar(doc, opId);
    registro[String(opId)] = { doc: doc, extras: extras || {}, ordem: ++contador };
    var ids = Object.keys(registro).sort(function (a, b) { return registro[b].ordem - registro[a].ordem; });
    ids.slice(MAXIMO).forEach(function (k) { delete registro[k]; });
    return doc;
  }
  function atualizarExtras(opId, extras) { var e = registro[String(opId)]; if (e) Object.assign(e.extras, extras || {}); }

  async function hexSha256(buf) {
    var h = await crypto.subtle.digest('SHA-256', buf);
    return Array.prototype.map.call(new Uint8Array(h), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  async function descompactar(buf) {
    if (typeof DecompressionStream === 'undefined') throw new Error('este navegador não abre arquivos compactados; atualize o navegador');
    var fluxo = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(fluxo).text();
  }

  // Baixa, confere e registra o arquivo da operação (uma vez por sessão). opcoes: { usuarioNome, progresso(texto) }
  async function carregar(op, opcoes) {
    opcoes = opcoes || {};
    var C = raiz.Comunicacao;
    var passo = opcoes.progresso || function () {};
    var ja = registro[String(op.id)];
    if (ja) { atualizarExtras(op.id, { operacao: op, usuarioNome: opcoes.usuarioNome }); return ja.doc; }
    passo('Localizando o arquivo da operação…');
    var info = await C.consultar(C.cliente.from('operacao_arquivos').select('caminho,sha256,bytes,versao').eq('operacao_id', op.id).maybeSingle());
    if (!info) throw new Error('arquivo da operação não encontrado');
    var s = await C.cliente.storage.from('arquivos').createSignedUrl(info.caminho, 600);
    if (s.error) throw s.error;
    passo('Baixando o arquivo (' + Math.max(1, Math.round(info.bytes / 1024)) + ' KB)…');
    var resp = await fetch(s.data.signedUrl);
    if (!resp.ok) throw new Error('não foi possível baixar o arquivo (' + resp.status + ')');
    var buf = await resp.arrayBuffer();
    if (raiz.crypto && raiz.crypto.subtle && info.sha256) {
      if ((await hexSha256(buf)) !== info.sha256) throw new Error('o arquivo baixado não confere (SHA-256)');
    }
    passo('Abrindo o arquivo…');
    var doc = JSON.parse(await descompactar(buf));
    return registrar(op.id, doc, { operacao: op, usuarioNome: opcoes.usuarioNome });
  }

  var api = {
    FORMATO: FORMATO,
    aplicar: aplicar,
    resolver: resolver,
    resolverRpc: resolverRpc,
    validar: validar,
    // usados por comunicacao.js e pelas telas
    consulta: function (tabela, passos) { return resolver(registro, tabela, passos); },
    rpc: function (nome, args) { return resolverRpc(registro, nome, args); },
    registrar: registrar,
    carregar: carregar,
    ativo: function (opId) { return Boolean(registro[String(opId)]); },
    esquecer: function (opId) { delete registro[String(opId)]; },
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.ArquivoLocal = api;
})(typeof window !== 'undefined' ? window : this);
