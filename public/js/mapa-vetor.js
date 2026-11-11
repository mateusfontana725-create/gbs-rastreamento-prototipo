/* =====================================================================
 * mapa-vetor.js — mapa de ruas gratuito (dados do OpenStreetMap) lido de um arquivo PMTiles
 * guardado no Supabase Storage, com uso sem internet (página do participante).
 *
 *   - O arquivo (parana.pmtiles, recorte do Protomaps) fica num bucket público; o endereço vem do
 *     /api/config (APP_CONFIG.mapaVetor). Sem o arquivo no servidor, nada muda: vale o mapa antigo.
 *   - O desenho é feito no próprio celular (protomaps-leaflet), a partir dos quadros vetoriais.
 *   - Cada quadro é procurado primeiro no aparelho (cache "gbs-mapa-areas-v1", o mesmo dos pacotes de
 *     js/mapa-offline.js, com endereço "https://mapa-vetor.gbs/{z}/{x}/{y}"); se não estiver, vem do arquivo
 *     remoto por pedidos de intervalo (Range). Assim o pacote de 10 km baixado na entrada vale sem internet.
 * ===================================================================== */
(function (global) {
  'use strict';

  var CACHE_AREAS = 'gbs-mapa-areas-v1';                 // o mesmo de js/mapa-offline.js e do sw.js
  var MODELO = 'https://mapa-vetor.gbs/{z}/{x}/{y}';      // chave dos quadros guardados (nunca é buscada na rede)
  var ZOOM_DADOS = 15;                                    // o arquivo vai até o zoom 15; acima disso o desenho amplia
  var ATRIBUICAO = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>';

  var remoto = null, urlRemota = null;

  function disponivel() {
    return Boolean(global.pmtiles && global.protomapsL && global.L && global.caches && global.Response);
  }

  function arquivo(url) {
    if (!url || !global.pmtiles) return null;
    if (urlRemota !== url) { remoto = new global.pmtiles.PMTiles(url); urlRemota = url; }
    return remoto;
  }

  function chave(z, x, y) {
    return MODELO.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  }
  function lerChave(url) {
    var m = /\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
    return m ? { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) } : null;
  }

  // O arquivo existe e responde? (cabeçalho do PMTiles; 8 s no máximo). Sem rede ou sem o arquivo: false.
  async function verificar(url, ms) {
    var p = arquivo(url);
    if (!p) return false;
    try {
      var h = await Promise.race([p.getHeader(), new Promise(function (_, rej) { setTimeout(function () { rej(new Error('tempo')); }, ms || 8000); })]);
      return Boolean(h && h.tileType === 1);   // 1 = quadros vetoriais (MVT)
    } catch (e) {
      return false;
    }
  }

  // Quadro guardado no aparelho (ArrayBuffer, vazio = mar/sem dados) ou null se não houver.
  async function doAparelho(z, x, y) {
    try {
      var cache = await global.caches.open(CACHE_AREAS);
      var r = await cache.match(chave(z, x, y));
      return r ? await r.arrayBuffer() : null;
    } catch (e) {
      return null;
    }
  }

  // Busca no arquivo remoto e devolve uma resposta pronta para guardar (usada pelo download do pacote).
  async function buscarResposta(url, chaveQuadro) {
    var q = lerChave(chaveQuadro);
    if (!q) throw new Error('quadro inválido');
    var r = await arquivo(url).getZxy(q.z, q.x, q.y);
    return new global.Response(r && r.data ? r.data : new ArrayBuffer(0), { status: 200, headers: { 'Content-Type': 'application/x-protobuf' } });
  }

  // Fonte para o protomaps-leaflet: primeiro o aparelho, depois o arquivo remoto (com internet).
  function fonte(url) {
    return {
      getZxy: async function (z, x, y, sinal) {
        var local = await doAparelho(z, x, y);
        if (local) return { data: local };
        if (global.navigator && global.navigator.onLine === false) return undefined;
        var p = arquivo(url);
        if (!p) return undefined;
        try {
          return await p.getZxy(z, x, y, sinal);
        } catch (e) {
          return undefined;   // sem rede no meio do caminho: o quadro fica em branco, o resto continua
        }
      },
    };
  }

  // Camada de fundo para o Leaflet.
  function camada(url, opc) {
    opc = opc || {};
    return global.protomapsL.leafletLayer({
      url: fonte(url),
      flavor: opc.tema === 'escuro' ? 'dark' : 'light',
      lang: 'pt',
      maxDataZoom: ZOOM_DADOS,
      maxZoom: 22,
      attribution: ATRIBUICAO,
    });
  }

  global.MapaVetor = {
    MODELO: MODELO, ZOOM_DADOS: ZOOM_DADOS, ATRIBUICAO: ATRIBUICAO,
    disponivel: disponivel, verificar: verificar, fonte: fonte, camada: camada,
    buscarResposta: buscarResposta, chave: chave, lerChave: lerChave,
  };
})(typeof window !== 'undefined' ? window : globalThis);
