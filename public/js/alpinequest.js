/* =====================================================================
 * alpinequest.js — leitura dos arquivos binários do AlpineQuest (Psyberia), sem bibliotecas
 *
 *   ler(buffer, nomeArquivo) → { pontos, linhas, areas, avisos, imagens, formato }
 *     (o mesmo formato de Arquivos.importar; ArrayBuffer ou Uint8Array)
 *
 * Formatos:
 *   .ldk  pacote ("Landmark Kit"): uma árvore de pastas com vários arquivos dentro (abaixo)
 *   .wpt  um ponto · .set conjunto de pontos · .rte rota · .are áreas · .trk trilha
 *
 * Baseado nas especificações publicadas pela Psyberia (psyberia_landmarks_files_specs.pdf, atualização 10,
 * e psyberia_archive_file_specs.pdf, atualização 1) e no conversor apq2gpx (Philippe Kehl), que confirma
 * o que as especificações deixam em aberto:
 *   · assinatura do LDK 0x4C444B3A ("LDK:"), versão 1; metadados da pasta a 0x20 bytes do ponteiro;
 *   · cada arquivo dentro do LDK começa com 1 byte de tipo (0x65 wpt, 0x66 set, 0x67 rte, 0x68 trk, 0x69 are);
 *   · arquivos novos começam com 0x5050 + tipo (0x0A…0x0E) + versão; os antigos, com a versão (2 ou 3);
 *   · o tamanho de {Location} não conta o próprio campo de tamanho.
 * Tudo em big endian. Os limites (quantidades, profundidade, posições) protegem contra arquivo corrompido.
 * ===================================================================== */
(function (raiz) {
  'use strict';

  var MAGIA_LDK = 0x4C444B3A;
  var NO = 0x00015555, LISTA = 0x00025555, TABELA = 0x00045555, DADOS = 0x00105555, DADOS_MAIS = 0x00205555;
  var TIPO_NOVO = { 0x0A: 'wpt', 0x0B: 'set', 0x0C: 'rte', 0x0D: 'are', 0x0E: 'trk' };
  var TIPO_NO_LDK = { 0x65: 'wpt', 0x66: 'set', 0x67: 'rte', 0x68: 'trk', 0x69: 'are' };
  var MAX_ITENS = 2000000, MAX_PROFUNDIDADE = 32;

  function erro(msg) { var e = new Error(msg); e.alpinequest = true; return e; }

  /* ---------- leitor big endian com limites ---------- */
  function Leitor(bytes) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = 0;
    this.fim = bytes.byteLength;
  }
  Leitor.prototype.precisa = function (n) { if (n < 0 || this.p + n > this.fim) throw erro('arquivo incompleto ou corrompido'); };
  Leitor.prototype.ir = function (pos) { if (pos < 0 || pos > this.fim) throw erro('posição fora do arquivo'); this.p = pos; };
  Leitor.prototype.u8 = function () { this.precisa(1); return this.v.getUint8(this.p++); };
  Leitor.prototype.int = function () { this.precisa(4); var x = this.v.getInt32(this.p); this.p += 4; return x; };
  Leitor.prototype.uint = function () { this.precisa(4); var x = this.v.getUint32(this.p); this.p += 4; return x; };
  Leitor.prototype.long = function () {   // até 2^53: suficiente para horários (ms) e posições no arquivo
    this.precisa(8);
    var alto = this.v.getInt32(this.p), baixo = this.v.getUint32(this.p + 4);
    this.p += 8;
    return alto * 4294967296 + baixo;
  };
  Leitor.prototype.dbl = function () { this.precisa(8); var x = this.v.getFloat64(this.p); this.p += 8; return x; };
  Leitor.prototype.bytes = function (n) { this.precisa(n); var x = this.b.subarray(this.p, this.p + n); this.p += n; return x; };
  Leitor.prototype.texto = function (n) { return utf8(this.bytes(n)); };
  Leitor.prototype.str = function () { var n = this.int(); return this.texto(n); };
  Leitor.prototype.contagem = function () {
    var n = this.int();
    if (n < 0 || n > MAX_ITENS) throw erro('quantidade inválida (' + n + ')');
    return n;
  };

  function utf8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    return Buffer.from(bytes).toString('utf8');   // Node antigo (testes)
  }

  /* ---------- metadados ---------- */
  // variante: 'novo' (arquivos com 0x5050…), 'v2' (antigos com extensão), 'v1' (antigos simples)
  function lerEntradas(l, n) {
    var o = {};
    for (var i = 0; i < n; i++) {
      var nome = l.str();
      var tipo = l.int();
      var valor;
      if (tipo === -1) valor = l.u8() !== 0;
      else if (tipo === -2) valor = l.long();
      else if (tipo === -3) valor = l.dbl();
      else if (tipo === -4) { l.bytes(l.contagem()); valor = null; }
      else if (tipo >= 0) valor = l.texto(tipo);
      else throw erro('tipo de metadado inválido (' + tipo + ')');
      o[nome] = valor;
    }
    return o;
  }
  // {MetadataContent} dos arquivos novos: número de entradas (-1 = nenhuma), entradas e a versão (se houver entradas).
  function lerConteudoNovo(l) {
    var n = l.int();
    if (n === -1) return null;
    if (n < 0 || n > MAX_ITENS) throw erro('quantidade inválida (' + n + ')');
    var o = lerEntradas(l, n);
    l.int();   // versão dos metadados
    return o;
  }
  function lerMetadados(l, variante) {
    if (variante === 'novo') {
      var o = lerConteudoNovo(l);
      if (o !== null) {
        var ext = l.int();   // extensões (-1 = nenhuma)
        if (ext > MAX_ITENS) throw erro('quantidade inválida (' + ext + ')');
        for (var i = 0; i < ext; i++) { l.str(); lerConteudoNovo(l); }
      }
      return o || {};
    }
    var n = l.int();
    var m = n > 0 ? lerEntradas(l, Math.min(n, MAX_ITENS)) : {};
    if (variante === 'v2') {
      var e2 = l.int();
      if (e2 > 0) throw erro('metadados estendidos não suportados');
    }
    return m;
  }

  /* ---------- posições ---------- */
  function lerPosicao(l, novo) {
    var tam = l.int();
    if (tam < 8 || tam > 4096) throw erro('posição inválida');
    var fim = l.p + tam;
    var q = { lng: l.int() * 1e-7, lat: l.int() * 1e-7 };
    if (!novo) {
      var alt = l.int();
      if (alt !== -999999999) q.alt = alt * 1e-3;
      q.t = l.long();
      if (tam > 20) q.prec = l.int();
    } else {
      while (l.p < fim) {
        var tipo = l.u8();
        if (tipo === 0x61) q.prec = l.int() * 1e-2;
        else if (tipo === 0x65) { var a = l.int(); if (a !== -999999999) q.alt = a * 1e-3; }
        else if (tipo === 0x74) q.t = l.long();
        else if (tipo === 0x70 || tipo === 0x76) l.int();
        else if (tipo === 0x62) l.u8();
        else if (tipo === 0x6e) l.bytes(2);
        else if (tipo === 0x73) l.bytes(8);
        else break;   // tipo desconhecido: o resto da posição é pulado abaixo
      }
    }
    l.ir(fim);
    return q;
  }
  function lerPosicoes(l, novo) {
    var n = l.contagem(), r = [];
    for (var i = 0; i < n; i++) r.push(lerPosicao(l, novo));
    return r;
  }
  function lerPontos(l, variante, novo) {
    var n = l.contagem(), r = [];
    for (var i = 0; i < n; i++) {
      var meta = lerMetadados(l, variante);
      r.push({ meta: meta, pos: lerPosicao(l, novo) });
    }
    return r;
  }

  /* ---------- um arquivo (wpt, set, rte, are, trk) ---------- */
  // Devolve { tipo, meta, pontos: [{meta,pos}], segmentos: [[pos…]], areas: [{meta, pos:[…]}] }
  function lerArquivo(bytes, tipoEsperado) {
    var l = new Leitor(bytes);
    var primeiro = l.uint();
    var cabecalho = l.int();
    var novo = (primeiro & 0xFFFF0000) === 0x50500000 && TIPO_NOVO[(primeiro >>> 8) & 0xFF];
    var tipo = novo ? TIPO_NOVO[(primeiro >>> 8) & 0xFF] : tipoEsperado;
    if (!tipo) throw erro('tipo de arquivo do AlpineQuest desconhecido');
    var versao = novo ? 100 + (primeiro & 0xFF) : primeiro;
    if (!novo && (versao < 1 || versao > 3)) throw erro('versão de arquivo desconhecida (' + versao + ')');
    var varMeta = novo ? 'novo' : (tipo === 'trk' ? (versao === 3 ? 'v2' : 'v1') : (versao === 2 ? 'v2' : 'v1'));
    var r = { tipo: tipo, meta: {}, pontos: [], segmentos: [], areas: [] };

    if (tipo === 'wpt') {
      l.ir(8 + Math.max(0, cabecalho));
      r.pontos.push({ meta: lerMetadados(l, varMeta), pos: lerPosicao(l, novo) });
      r.meta = r.pontos[0].meta;
      return r;
    }
    if (novo) lerMetadados(l, 'novo');           // metadados técnicos (comprimento, horários…): não usados
    else l.ir(8 + Math.max(0, cabecalho));       // antigos: cabeçalho de tamanho fixo, pulado
    r.meta = lerMetadados(l, varMeta);

    if (tipo === 'set' || tipo === 'rte') {
      r.pontos = lerPontos(l, varMeta, novo);
    } else if (tipo === 'are') {
      if (novo) {
        var n = l.contagem();
        for (var i = 0; i < n; i++) {
          var meta = lerMetadados(l, 'novo');
          var pos = lerPosicoes(l, true);
          var furos = l.contagem();
          for (var f = 0; f < furos; f++) lerPosicoes(l, true);
          r.areas.push({ meta: meta, pos: pos });
        }
      } else {
        r.areas.push({ meta: r.meta, pos: lerPosicoes(l, false) });
      }
    } else if (tipo === 'trk') {
      r.pontos = lerPontos(l, varMeta, novo);
      var ns = l.contagem();
      for (var s = 0; s < ns; s++) {
        if (novo || versao >= 3) lerMetadados(l, varMeta); else l.int();
        r.segmentos.push(lerPosicoes(l, novo));
      }
    }
    return r;
  }

  /* ---------- pacote LDK ---------- */
  function lerBloco(l, pos) {
    l.ir(pos);
    if (l.int() !== DADOS) throw erro('bloco de dados inválido no LDK');
    l.int();   // flags
    var total = l.long();
    var tam = l.long();
    var proximo = l.long();
    if (total < 0 || total > l.fim || tam < 0 || tam > total) throw erro('tamanho inválido no LDK');
    var saida = new Uint8Array(total), usado = 0;
    var parte = l.bytes(tam);
    saida.set(parte, 0); usado += parte.length;
    var voltas = 0;
    while (proximo && usado < total) {
      if (++voltas > 100000) throw erro('blocos demais no LDK');
      l.ir(proximo);
      if (l.int() !== DADOS_MAIS) throw erro('bloco adicional inválido no LDK');
      var t2 = l.long();
      proximo = l.long();
      if (t2 < 0 || usado + t2 > total) throw erro('tamanho inválido no LDK');
      var p2 = l.bytes(t2);
      saida.set(p2, usado); usado += p2.length;
    }
    return saida.subarray(0, usado);
  }

  function nomeDaPasta(l, ptr) {
    if (!ptr) return '';
    try {
      var bloco = lerBloco(l, ptr);
      var lm = new Leitor(bloco);
      var n = lm.int();
      var m = n > 0 ? lerEntradas(lm, Math.min(n, 1000)) : {};
      return typeof m.name === 'string' ? m.name : '';
    } catch (e) { return ''; }
  }

  function lerEntradasNo(l, magia) {
    var filhos = [], dados = [], voltas = 0;
    function entradas(n, destino) {
      for (var i = 0; i < n; i++) { var ptr = l.long(); l.int(); if (destino) destino.push(ptr); }
    }
    if (magia === TABELA) {
      var nf = l.contagem(), nd = l.contagem();
      entradas(nf, filhos); entradas(nd, dados);
      return { filhos: filhos, dados: dados };
    }
    if (magia !== LISTA) throw erro('pasta inválida no LDK');
    for (;;) {
      var total = l.contagem(), nf2 = l.contagem(), nd2 = l.contagem();
      var mais = l.long();
      if (nf2 + nd2 > total) throw erro('pasta inválida no LDK');
      entradas(nf2, filhos);
      entradas(total - nf2 - nd2, null);   // espaço vazio
      entradas(nd2, dados);
      if (!mais || ++voltas > 10000) break;
      l.ir(mais);
    }
    return { filhos: filhos, dados: dados };
  }

  function lerLdk(bytes) {
    var l = new Leitor(bytes);
    if (l.uint() !== MAGIA_LDK) throw erro('não é um arquivo LDK do AlpineQuest');
    l.int();   // versão do pacote
    var raizPos = l.long();
    var arquivos = [], ignorados = 0, vistos = {};
    function no(pos, caminho, prof) {
      if (prof > MAX_PROFUNDIDADE || vistos[pos]) return;
      vistos[pos] = true;
      l.ir(pos);
      if (l.int() !== NO) throw erro('pasta inválida no LDK');
      l.int();   // flags
      var metaPtr = l.long();
      l.dbl();   // reservado
      var magia = l.int();
      var ent = lerEntradasNo(l, magia);
      var nome = prof > 0 ? nomeDaPasta(l, metaPtr) : '';
      var aqui = nome ? caminho.concat([nome]) : caminho;
      ent.dados.forEach(function (ptr) {
        try {
          var bloco = lerBloco(l, ptr);
          var tipo = TIPO_NO_LDK[bloco[0]];
          if (!tipo) { ignorados++; return; }
          var lido = lerArquivo(bloco.subarray(1), tipo);
          lido.pasta = aqui.join(' / ');
          arquivos.push(lido);
        } catch (e) { ignorados++; }
      });
      ent.filhos.forEach(function (ptr) { no(ptr, aqui, prof + 1); });
    }
    no(raizPos, [], 0);
    return { arquivos: arquivos, ignorados: ignorados };
  }

  /* ---------- para o formato do importador (Arquivos) ---------- */
  function nomeDe(meta, padrao) { var n = meta && typeof meta.name === 'string' ? meta.name.trim() : ''; return n || padrao; }
  function descricaoDe(meta) {
    var d = meta && (meta.description || meta.comment || meta.desc);
    return typeof d === 'string' ? d.trim() : '';
  }
  function ok(q) { return q && isFinite(q.lat) && isFinite(q.lng) && Math.abs(q.lat) <= 90 && Math.abs(q.lng) <= 180 && !(q.lat === 0 && q.lng === 0); }
  function r7(v) { return Math.round(v * 1e7) / 1e7; }
  function iso(t) { return t ? new Date(t).toISOString() : null; }
  function limpo(o) { Object.keys(o).forEach(function (k) { if (o[k] == null || o[k] === '') delete o[k]; }); return o; }

  function paraImportador(arquivos, formato) {
    var r = { pontos: [], linhas: [], areas: [], avisos: [], imagens: [], formato: formato };
    var cont = { ponto: 0, trilha: 0, rota: 0, area: 0 };
    arquivos.forEach(function (a) {
      var pasta = a.pasta ? 'Pasta: ' + a.pasta : '';
      function desc(meta) { return [descricaoDe(meta), pasta].filter(Boolean).join(' · '); }
      if (a.tipo === 'rte') {
        var pr = a.pontos.map(function (w) { return w.pos; }).filter(ok);
        if (pr.length > 1) r.linhas.push(limpo({ nome: nomeDe(a.meta, 'Rota ' + (++cont.rota)), pts: pr.map(function (q) { return [r7(q.lat), r7(q.lng)]; }),
          formato: formato, rota: true, descricao: desc(a.meta) }));
        return;
      }
      a.pontos.forEach(function (w) {
        if (!ok(w.pos)) return;
        r.pontos.push(limpo({ nome: nomeDe(w.meta, 'Ponto ' + (++cont.ponto)), lat: r7(w.pos.lat), lng: r7(w.pos.lng), descricao: desc(w.meta) }));
      });
      if (a.tipo === 'trk') {
        var nome = nomeDe(a.meta, 'Trilha ' + (++cont.trilha));
        a.segmentos.forEach(function (seg) {
          var s = seg.filter(ok);
          if (s.length < 2) return;
          var tempos = s.map(function (q) { return q.t; }).filter(function (t) { return t > 0; });
          r.linhas.push(limpo({ nome: nome, pts: s.map(function (q) { return [r7(q.lat), r7(q.lng)]; }), formato: formato, descricao: desc(a.meta),
            inicio: tempos.length ? iso(Math.min.apply(null, tempos)) : null, fim: tempos.length ? iso(Math.max.apply(null, tempos)) : null }));
        });
      }
      a.areas.forEach(function (ar) {
        var p = ar.pos.filter(ok);
        if (p.length < 3) return;
        r.areas.push(limpo({ nome: nomeDe(ar.meta, nomeDe(a.meta, 'Área ' + (++cont.area))), pts: p.map(function (q) { return [r7(q.lat), r7(q.lng)]; }),
          formato: formato, descricao: desc(ar.meta) }));
      });
    });
    return r;
  }

  function ehAlpineQuest(bytes, nome) {
    if (/\.(ldk|wpt|set|rte|are|trk)$/i.test(nome || '')) return true;
    if (!bytes || bytes.length < 4) return false;
    var v = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
    return v === MAGIA_LDK || ((v & 0xFFFF0000) === 0x50500000 && Boolean(TIPO_NOVO[(v >>> 8) & 0xFF]));
  }

  function ler(entrada, nome) {
    var bytes = entrada instanceof Uint8Array ? entrada : new Uint8Array(entrada);
    var ext = (/\.([a-z]+)$/i.exec(nome || '') || [])[1];
    ext = ext ? ext.toLowerCase() : '';
    var primeiro = bytes.length >= 4 ? new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) : 0;
    if (primeiro === MAGIA_LDK || ext === 'ldk') {
      var pac = lerLdk(bytes);
      var r = paraImportador(pac.arquivos, 'ldk');
      if (pac.ignorados) r.avisos.push(pac.ignorados + ' item(ns) do pacote LDK em formato não reconhecido (fotos, anexos ou versão nova) foram ignorados.');
      return r;
    }
    var porExtensao = { wpt: 'wpt', set: 'set', rte: 'rte', trk: 'trk', are: 'are' }[ext] || null;   // arquivos antigos não dizem o tipo
    var um = lerArquivo(bytes, porExtensao);
    return paraImportador([um], um.tipo);
  }

  var api = { ler: ler, ehAlpineQuest: ehAlpineQuest, _lerArquivo: lerArquivo, _lerLdk: lerLdk };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.AlpineQuest = api;
})(typeof window !== 'undefined' ? window : globalThis);
