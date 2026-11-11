"""Gera o arquivo do mapa de ruas gratuito (parana.pmtiles) para o bucket "mapas" do Supabase.

Lê só os pedaços necessários do arquivo público diário do Protomaps (https://build.protomaps.com) e grava um
PMTiles novo com a área pedida. Usa só a biblioteca padrão do Python 3 (sem instalar nada).

Uso (Paraná inteiro, zoom até 15; leva alguns minutos e baixa ~450 MB):
  python3 tools/extrair_mapa_parana.py https://build.protomaps.com/20261110.pmtiles parana.pmtiles -54.62 -26.72 -48.02 -22.51 15

Troque 20261110 pela data de um build disponível em https://build-metadata.protomaps.dev/builds.json.
Os dados são do OpenStreetMap (© OpenStreetMap, ODbL) e o app mostra o crédito.
"""
import sys, struct, gzip, math, json, urllib.request, time

URL, SAIDA = sys.argv[1], sys.argv[2]
LON0, LAT0, LON1, LAT1 = map(float, sys.argv[3:7])
ZMAX = int(sys.argv[7])


def baixar(ini, tam, tentativas=6):
    for t in range(tentativas):
        try:
            req = urllib.request.Request(URL, headers={'Range': 'bytes=%d-%d' % (ini, ini + tam - 1), 'User-Agent': 'extrator-pmtiles'})
            with urllib.request.urlopen(req, timeout=120) as r:
                dados = r.read()
            if len(dados) != tam:
                raise IOError('tamanho %d != %d' % (len(dados), tam))
            return dados
        except Exception as e:
            if t == tentativas - 1:
                raise
            time.sleep(2 * (t + 1))


def varint(b, i):
    v = s = 0
    while True:
        x = b[i]; i += 1
        v |= (x & 0x7f) << s
        if x < 0x80:
            return v, i
        s += 7


def wvarint(v, out):
    while v >= 0x80:
        out.append((v & 0x7f) | 0x80); v >>= 7
    out.append(v)


def ler_dir(b, comp):
    if comp == 2:
        b = gzip.decompress(b)
    i = 0
    n, i = varint(b, i)
    ids, runs, lens, offs = [], [], [], []
    last = 0
    for _ in range(n):
        d, i = varint(b, i); last += d; ids.append(last)
    for _ in range(n):
        r, i = varint(b, i); runs.append(r)
    for _ in range(n):
        l, i = varint(b, i); lens.append(l)
    for k in range(n):
        o, i = varint(b, i)
        offs.append(offs[k - 1] + lens[k - 1] if (o == 0 and k > 0) else o - 1)
    return list(zip(ids, runs, lens, offs))


def gravar_dir(entradas):
    out = bytearray()
    wvarint(len(entradas), out)
    last = 0
    for e in entradas:
        wvarint(e[0] - last, out); last = e[0]
    for e in entradas: wvarint(e[1], out)
    for e in entradas: wvarint(e[2], out)
    for k, e in enumerate(entradas):
        if k > 0 and e[3] == entradas[k - 1][3] + entradas[k - 1][2]:
            wvarint(0, out)
        else:
            wvarint(e[3] + 1, out)
    return gzip.compress(bytes(out))


def hilbert(z, x, y):
    n = 1 << z
    d = 0
    s = n >> 1
    while s > 0:
        rx = 1 if (x & s) else 0
        ry = 1 if (y & s) else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x = s - 1 - x; y = s - 1 - y
            x, y = y, x
        s >>= 1
    return d


def tile_id(z, x, y):
    return ((1 << (2 * z)) - 1) // 3 + hilbert(z, x, y)


def lon2x(lon, z): return int((lon + 180) / 360 * (1 << z))
def lat2y(lat, z):
    r = math.radians(lat)
    return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * (1 << z))


cab = baixar(0, 127)
assert cab[:7] == b'PMTiles' and cab[7] == 3, 'não é PMTiles v3'
(rdo, rdl, mdo, mdl, ldo, ldl, tdo, tdl, _a, _b, _c) = struct.unpack('<11Q', cab[8:96])
clustered, icomp, tcomp, ttype, zmin, zmaxsrc = cab[96:102]
print('origem: tile_type', ttype, 'comp', tcomp, 'zoom', zmin, '-', zmaxsrc, flush=True)
zmax = min(ZMAX, zmaxsrc)

queridos = set()
for z in range(0, zmax + 1):
    x0, x1 = lon2x(LON0, z), lon2x(LON1, z)
    y0, y1 = lat2y(LAT1, z), lat2y(LAT0, z)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            queridos.add(tile_id(z, x, y))
alvo = sorted(queridos)
print('quadros na área:', len(alvo), flush=True)

# percorre os diretórios: root e só as folhas que cobrem algum quadro querido
import bisect
achados = {}  # tile_id -> (offset, length) na origem


def visitar(entradas):
    for k, (tid, run, ln, off) in enumerate(entradas):
        fim = entradas[k + 1][0] if k + 1 < len(entradas) else (1 << 62)
        if run == 0:
            a = bisect.bisect_left(alvo, tid)
            if a < len(alvo) and alvo[a] < fim:
                visitar(ler_dir(baixar(ldo + off, ln), icomp))
        else:
            a = bisect.bisect_left(alvo, tid)
            while a < len(alvo) and alvo[a] < tid + run:
                achados[alvo[a]] = (off, ln); a += 1


visitar(ler_dir(baixar(rdo, rdl), icomp))
print('quadros existentes:', len(achados), flush=True)

# baixa os dados únicos, juntando intervalos próximos
unicos = sorted(set(achados.values()))
blocos = []
for off, ln in unicos:
    if blocos and off - (blocos[-1][0] + blocos[-1][1]) <= 32768 and (off + ln - blocos[-1][0]) <= 8 << 20:
        b = blocos[-1]; b[1] = max(b[1], off + ln - b[0]); b[2].append((off, ln))
    else:
        blocos.append([off, ln, [(off, ln)]])
print('pedidos de dados:', len(blocos), 'MB a baixar ~', round(sum(b[1] for b in blocos) / 1e6, 1), flush=True)
conteudo = {}
for i, (ini, tam, itens) in enumerate(blocos):
    dados = baixar(tdo + ini, tam)
    for off, ln in itens:
        conteudo[(off, ln)] = dados[off - ini: off - ini + ln]
    if i % 200 == 0:
        print('  bloco', i, 'de', len(blocos), flush=True)

# grava o arquivo novo
novo_off = {}
dados_out = bytearray()
entradas = []
for tid in sorted(achados):
    chave = achados[tid]
    if chave not in novo_off:
        novo_off[chave] = len(dados_out)
        dados_out += conteudo[chave]
    o, l = novo_off[chave], chave[1]
    if entradas and entradas[-1][3] == o and entradas[-1][0] + entradas[-1][1] == tid:
        entradas[-1][1] += 1
    else:
        entradas.append([tid, 1, l, o])

raiz = gravar_dir(entradas)
folhas = b''
if len(raiz) > 16000:
    tam_folha = 4096
    while True:
        folhas = bytearray(); raiz_ent = []
        for i in range(0, len(entradas), tam_folha):
            parte = entradas[i:i + tam_folha]
            f = gravar_dir(parte)
            raiz_ent.append([parte[0][0], 0, len(f), len(folhas)])
            folhas += f
        raiz = gravar_dir(raiz_ent)
        if len(raiz) <= 16000:
            break
        tam_folha *= 2
    folhas = bytes(folhas)

meta = gzip.decompress(baixar(mdo, mdl)) if icomp == 2 else baixar(mdo, mdl)
try:
    mj = json.loads(meta); mj['description'] = 'Recorte do Paraná (OpenStreetMap via Protomaps) para uso offline'
    meta = json.dumps(mj).encode()
except Exception:
    pass
meta = gzip.compress(meta)

H = 127
p_raiz = H; p_meta = p_raiz + len(raiz); p_folhas = p_meta + len(meta); p_dados = p_folhas + len(folhas)
n_end = sum(e[1] for e in entradas)
cab_novo = bytearray(b'PMTiles' + bytes([3]))
cab_novo += struct.pack('<11Q', p_raiz, len(raiz), p_meta, len(meta), p_folhas, len(folhas), p_dados, len(dados_out),
                        n_end, len(entradas), len(novo_off))
cab_novo += bytes([1, 2, tcomp, ttype, 0, zmax])
cab_novo += struct.pack('<4i', int(LON0 * 1e7), int(LAT0 * 1e7), int(LON1 * 1e7), int(LAT1 * 1e7))
cab_novo += bytes([min(zmax, 10)])
cab_novo += struct.pack('<2i', int((LON0 + LON1) / 2 * 1e7), int((LAT0 + LAT1) / 2 * 1e7))
assert len(cab_novo) == 127
with open(SAIDA, 'wb') as f:
    f.write(cab_novo); f.write(raiz); f.write(meta); f.write(folhas); f.write(dados_out)
print('gravado', SAIDA, round((127 + len(raiz) + len(meta) + len(folhas) + len(dados_out)) / 1e6, 1), 'MB', flush=True)
