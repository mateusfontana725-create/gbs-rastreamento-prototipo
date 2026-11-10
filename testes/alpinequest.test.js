// Leitura dos arquivos do AlpineQuest (public/js/alpinequest.js) — rode com: node testes/alpinequest.test.js
// Os arquivos são montados aqui seguindo as especificações da Psyberia (big endian), já que não há amostras reais no repositório.
const AQ = require(require('path').join(__dirname, '../public/js/alpinequest.js'));
let ok = 0, falha = 0;
const chk = (c, m, x) => { if (c) { ok++; console.log('  ✔ ' + m); } else { falha++; console.log('  ✘ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };
const perto = (a, b) => Math.abs(a - b) < 1e-6;

class Escritor {
  constructor() { this.b = []; }
  u8(x) { this.b.push(x & 255); return this; }
  int(x) { const v = Buffer.alloc(4); v.writeInt32BE(x); this.b.push(...v); return this; }
  uint(x) { const v = Buffer.alloc(4); v.writeUInt32BE(x >>> 0); this.b.push(...v); return this; }
  long(x) { const v = Buffer.alloc(8); v.writeBigInt64BE(BigInt(x)); this.b.push(...v); return this; }
  dbl(x) { const v = Buffer.alloc(8); v.writeDoubleBE(x); this.b.push(...v); return this; }
  bytes(a) { for (const x of a) this.b.push(x); return this; }
  str(s) { const e = Buffer.from(s, 'utf8'); this.int(e.length); return this.bytes(e); }
  get tam() { return this.b.length; }
  saida() { return Uint8Array.from(this.b); }
}

// {Metadata} dos arquivos novos: null = nenhuma entrada (-1)
function meta(w, o) {
  if (!o) return w.int(-1);
  const ks = Object.keys(o);
  w.int(ks.length);
  ks.forEach((k) => {
    w.str(k);
    const v = o[k];
    if (typeof v === 'string') { const e = Buffer.from(v, 'utf8'); w.int(e.length).bytes(e); }
    else if (typeof v === 'boolean') w.int(-1).u8(v ? 1 : 0);
    else w.int(-3).dbl(v);
  });
  return w.int(7).int(-1);   // versão dos metadados e nenhuma extensão
}
// {Location} novo: tamanho (sem contar o próprio campo), longitude, latitude e valores
function loc(w, lat, lng, o = {}) {
  const c = new Escritor().int(Math.round(lng * 1e7)).int(Math.round(lat * 1e7));
  if (o.alt != null) c.u8(0x65).int(Math.round(o.alt * 1e3));
  if (o.t != null) c.u8(0x74).long(o.t);
  if (o.prec != null) c.u8(0x61).int(Math.round(o.prec * 100));
  if (o.bateria != null) c.u8(0x62).u8(o.bateria);
  if (o.sat) c.u8(0x73).bytes([0, 5, 1, 3, 0, 2, 4, 0]);
  return w.int(c.tam).bytes(c.b);
}
function locAntiga(w, lat, lng, alt, t) {
  return w.int(20).int(Math.round(lng * 1e7)).int(Math.round(lat * 1e7)).int(Math.round(alt * 1e3)).long(t);
}

const L0 = -25.5, G0 = -49.3, T0 = Date.UTC(2026, 10, 8, 12, 0, 0);

function trkNovo() {
  const w = new Escritor().uint(0x50500E01).int(0);
  meta(w, { tl: 1234.5 });                       // técnicos
  meta(w, { name: 'Trilha Alfa', description: 'subida pela crista' });
  w.int(1); meta(w, { name: 'Pegada' }); loc(w, L0 + 0.001, G0, { alt: 900 });          // 1 ponto
  w.int(2);                                      // 2 trechos
  meta(w, null); w.int(3);
  loc(w, L0, G0, { alt: 850.5, t: T0, prec: 4.2, bateria: 80, sat: true });
  loc(w, L0 + 0.0005, G0 + 0.0005, { alt: 860, t: T0 + 60000 });
  loc(w, L0 + 0.001, G0 + 0.0008, { t: T0 + 120000 });
  meta(w, { name: 'volta' }); w.int(2);
  loc(w, L0 + 0.002, G0, { t: T0 + 600000 }); loc(w, L0 + 0.0025, G0 + 0.0003, { t: T0 + 660000 });
  return w.saida();
}
function setNovo() {
  const w = new Escritor().uint(0x50500B01).int(0);
  meta(w, null); meta(w, { name: 'Pontos de apoio' });
  w.int(2);
  meta(w, { name: 'Base', comment: 'viatura' }); loc(w, L0, G0 + 0.002);
  meta(w, { name: 'Ação' }); loc(w, L0 - 0.001, G0 + 0.002, { alt: 700 });
  return w.saida();
}
function areNovo() {
  const w = new Escritor().uint(0x50500D01).int(0);
  meta(w, null); meta(w, { name: 'Setor arquivo' });
  w.int(1);
  meta(w, { name: 'Mata fechada' });
  w.int(4); loc(w, L0, G0); loc(w, L0, G0 + 0.01); loc(w, L0 + 0.01, G0 + 0.01); loc(w, L0 + 0.01, G0);
  w.int(1); w.int(3); loc(w, L0 + 0.002, G0 + 0.002); loc(w, L0 + 0.003, G0 + 0.002); loc(w, L0 + 0.003, G0 + 0.003);   // furo
  return w.saida();
}
function rteNovo() {
  const w = new Escritor().uint(0x50500C01).int(0);
  meta(w, null); meta(w, { name: 'Rota do rio' });
  w.int(3);
  [[0, 0], [0.001, 0.001], [0.002, 0.001]].forEach(([a, b], i) => { meta(w, { name: 'R' + i }); loc(w, L0 + a, G0 + b); });
  return w.saida();
}
function wptNovo() {
  const w = new Escritor().uint(0x50500A01).int(0);
  meta(w, { name: 'Último visto' }); loc(w, L0 + 0.004, G0 - 0.001, { alt: 1001 });
  return w.saida();
}
function trkAntigoV3() {
  const w = new Escritor().int(3).int(12).bytes(new Array(12).fill(0xAB));   // cabeçalho antigo (pulado)
  w.int(1).str('name').int(Buffer.byteLength('Trilha antiga')).bytes(Buffer.from('Trilha antiga')).int(-1);   // metadados v2
  w.int(0);   // sem pontos
  w.int(1);   // 1 trecho
  w.int(0).int(-1);   // metadados do trecho (v2: nenhuma entrada e extensão -1)
  w.int(3); locAntiga(w, L0, G0, 800, T0); locAntiga(w, L0 + 0.001, G0, 801, T0 + 30000); locAntiga(w, L0 + 0.002, G0, 802, T0 + 60000);
  return w.saida();
}

console.log('Arquivos avulsos (formato novo)');
{
  const r = AQ.ler(trkNovo(), 'alfa.trk');
  chk(r.formato === 'trk' && r.linhas.length === 2, 'trilha: dois trechos viram duas linhas', r.linhas.length);
  chk(r.linhas[0].nome === 'Trilha Alfa' && r.linhas[0].pts.length === 3 && r.linhas[1].pts.length === 2, 'nome da trilha e pontos de cada trecho', r.linhas.map((l) => l.pts.length));
  chk(perto(r.linhas[0].pts[0][0], L0) && perto(r.linhas[0].pts[0][1], G0), 'coordenadas (graus × 1e7) na ordem certa: latitude, longitude', r.linhas[0].pts[0]);
  chk(r.linhas[0].inicio === new Date(T0).toISOString() && r.linhas[0].fim === new Date(T0 + 120000).toISOString(), 'início e fim pelo horário dos pontos', [r.linhas[0].inicio, r.linhas[0].fim]);
  chk(r.linhas[0].descricao === 'subida pela crista', 'descrição dos metadados', r.linhas[0].descricao);
  chk(r.pontos.length === 1 && r.pontos[0].nome === 'Pegada', 'pontos marcados na trilha', r.pontos);
  const s = AQ.ler(setNovo(), 'apoio.set');
  chk(s.pontos.length === 2 && s.pontos[0].nome === 'Base' && s.pontos[0].descricao === 'viatura' && s.pontos[1].nome === 'Ação', 'conjunto de pontos com nome (acentos em UTF-8) e comentário', s.pontos);
  const a = AQ.ler(areNovo(), 'setor.are');
  chk(a.areas.length === 1 && a.areas[0].nome === 'Mata fechada' && a.areas[0].pts.length === 4, 'área: contorno com 4 vértices (o furo não vira outra área)', a.areas);
  const rt = AQ.ler(rteNovo(), 'rio.rte');
  chk(rt.linhas.length === 1 && rt.linhas[0].rota === true && rt.linhas[0].pts.length === 3 && rt.linhas[0].nome === 'Rota do rio', 'rota vira linha marcada como rota', rt.linhas);
  const wp = AQ.ler(wptNovo(), 'ponto.wpt');
  chk(wp.pontos.length === 1 && wp.pontos[0].nome === 'Último visto', 'ponto avulso (.wpt)', wp.pontos);
  chk(AQ.ehAlpineQuest(trkNovo(), 'x.bin') && AQ.ehAlpineQuest(new Uint8Array(4), 'y.ldk') && !AQ.ehAlpineQuest(Uint8Array.from(Buffer.from('<gpx')), 'z.gpx'), 'reconhece pelo conteúdo ou pela extensão');
}

console.log('Arquivo antigo (AlpineQuest < 2.2.8)');
{
  const r = AQ.ler(trkAntigoV3(), 'velha.trk');
  chk(r.linhas.length === 1 && r.linhas[0].nome === 'Trilha antiga' && r.linhas[0].pts.length === 3, 'trilha versão 3: cabeçalho pulado, nome e pontos', r.linhas);
  chk(r.linhas[0].inicio === new Date(T0).toISOString(), 'horário dos pontos antigos', r.linhas[0].inicio);
}

console.log('Pacote LDK');
// Monta um LDK: raiz (lista) com 1 pasta e 1 arquivo; pasta (tabela) com 2 arquivos; um dos dados dividido em 2 blocos.
function ldk() {
  const trk = trkNovo(), set = setNovo(), are = areNovo();
  const conteudos = [
    { tipo: 0x68, bytes: trk, dividir: 40 },   // trilha, em dois blocos
    { tipo: 0x66, bytes: set },
    { tipo: 0x69, bytes: are },
    { tipo: 0x30, bytes: Uint8Array.from([1, 2, 3]) },   // anexo desconhecido: ignorado
  ];
  // metadados da pasta (dentro de um bloco de dados): n, entradas
  const mPasta = new Escritor().int(1).str('name').int(Buffer.byteLength('Equipe Bravo')).bytes(Buffer.from('Equipe Bravo')).int(-1);
  // posições: cabeçalho 48; raiz; pasta; bloco de metadados; blocos de dados
  const tamRaiz = 24 + 4 + 4 + 4 + 4 + 8 + 12 * 3;   // lista: total 3 (1 pasta, 1 vazio, 1 dado)
  const tamPasta = 24 + 4 + 4 + 4 + 12 * 3;            // tabela: 0 pastas, 3 dados
  let pos = 48;
  const pRaiz = pos; pos += tamRaiz;
  const pPasta = pos; pos += tamPasta;
  const pMeta = pos; pos += 32 + mPasta.tam;
  const blocos = conteudos.map((c) => {
    const corpo = Uint8Array.from([c.tipo, ...c.bytes]);
    const b = { corpo, pos, dividir: c.dividir };
    pos += 32 + (c.dividir ? c.dividir : corpo.length);
    if (c.dividir) { b.pos2 = pos; pos += 20 + (corpo.length - c.dividir); }
    return b;
  });
  const w = new Escritor().uint(0x4C444B3A).int(1).long(pRaiz).dbl(0).dbl(0).dbl(0).dbl(0);
  // raiz: lista com 1 pasta, 1 entrada vazia e 1 dado (a trilha)
  w.int(0x00015555).int(0).long(0).dbl(0).int(0x00025555).int(3).int(1).int(1).long(0);
  w.long(pPasta).int(11); w.long(0).int(0); w.long(blocos[0].pos).int(21);
  // pasta: tabela com 3 dados (conjunto, área, anexo)
  w.int(0x00015555).int(0).long(pMeta).dbl(0).int(0x00045555).int(0).int(3);
  w.long(blocos[1].pos).int(31); w.long(blocos[2].pos).int(32); w.long(blocos[3].pos).int(33);
  // bloco de metadados da pasta
  w.int(0x00105555).int(0).long(mPasta.tam).long(mPasta.tam).long(0).bytes(mPasta.b);
  blocos.forEach((b) => {
    const n1 = b.dividir || b.corpo.length;
    w.int(0x00105555).int(0).long(b.corpo.length).long(n1).long(b.dividir ? b.pos2 : 0).bytes(b.corpo.subarray(0, n1));
    if (b.dividir) w.int(0x00205555).long(b.corpo.length - n1).long(0).bytes(b.corpo.subarray(n1));
  });
  if (w.tam !== pos) throw new Error('montagem do LDK com posições erradas: ' + w.tam + ' ≠ ' + pos);
  return w.saida();
}
{
  const r = AQ.ler(ldk(), 'operacao.ldk');
  chk(r.formato === 'ldk', 'formato ldk');
  chk(r.linhas.length === 2 && r.linhas[0].nome === 'Trilha Alfa' && r.linhas[0].pts.length === 3, 'a trilha dividida em dois blocos de dados é lida inteira', r.linhas.map((l) => l.pts.length));
  chk(r.pontos.some((p) => p.nome === 'Base' && /Pasta: Equipe Bravo/.test(p.descricao || '')), 'pontos da pasta trazem o nome da pasta', r.pontos.map((p) => [p.nome, p.descricao]));
  chk(r.areas.length === 1 && r.areas[0].nome === 'Mata fechada', 'área dentro da pasta', r.areas);
  chk(r.avisos.length === 1 && /1 item/.test(r.avisos[0]), 'o anexo desconhecido é ignorado com aviso (não derruba o resto)', r.avisos);
}

// para testes de navegador: grava o pacote montado acima (GRAVAR_LDK=/caminho/arquivo.ldk)
if (process.env.GRAVAR_LDK) require('fs').writeFileSync(process.env.GRAVAR_LDK, Buffer.from(ldk()));

console.log('Arquivo corrompido');
{
  const cortado = trkNovo().subarray(0, 60);
  let msg = '';
  try { AQ.ler(cortado, 'x.trk'); } catch (e) { msg = e.message; }
  chk(/incompleto|corrompido|inválid/.test(msg), 'trilha cortada no meio: erro claro (sem travar)', msg);
  let msg2 = '';
  try { AQ.ler(Uint8Array.from([0x4C, 0x44, 0x4B, 0x3A, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0x10, 0]), 'x.ldk'); } catch (e) { msg2 = e.message; }
  chk(msg2 !== '', 'LDK com a raiz fora do arquivo: erro', msg2);
}

console.log('\n' + ok + ' OK, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
