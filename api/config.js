// GET /api/config  →  entrega ao navegador SOMENTE a configuração pública.
//
// A URL do projeto e a chave PUBLICÁVEL (anon/publishable) do Supabase são
// públicas por definição: a proteção dos dados é feita pelas regras de
// segurança (RLS) e pelas funções do banco. A chave SECRETA (service_role)
// nunca sai do servidor — ela é usada apenas em /api/limpeza.
module.exports = (req, res) => {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const chave = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();

  const config = {
    supabaseUrl: url,
    supabaseKey: chave,
    configurado: Boolean(url && chave),
  };
  // Servidor próprio de mapas (pacote offline, 10 km, zoom até 17). Cada camada é um endereço com {z}/{x}/{y}. Sem nenhuma
  // configurada, o app segue como antes (mapas públicos, área pequena guardada). O servidor precisa mandar o cabeçalho CORS.
  // O domínio do servidor também tem de entrar no img-src e no connect-src da CSP (vercel.json), senão o navegador bloqueia.
  const mapaOffline = {};
  [['osm', 'TILES_MAPA_URL'], ['topo', 'TILES_TOPO_URL'], ['satelite', 'TILES_SATELITE_URL']].forEach(([camada, nome]) => {
    const v = (process.env[nome] || '').trim();
    if (/^https:\/\/[^\s]+$/.test(v) && v.includes('{z}') && v.includes('{x}') && v.includes('{y}')) mapaOffline[camada] = v;
  });
  if (Object.keys(mapaOffline).length) {
    config.mapaOffline = mapaOffline;
    const atrib = (process.env.TILES_ATRIBUICAO || '').trim();
    if (atrib) config.mapaAtribuicao = atrib.slice(0, 200);
  }

  // Mapa de ruas gratuito (OpenStreetMap, arquivo PMTiles do Paraná) guardado no Supabase Storage, bucket público "mapas"
  // (migração 077). MAPA_PMTILES_URL troca o endereço; sem ela, vale o arquivo padrão do próprio projeto. Se o arquivo não
  // estiver lá, o app percebe sozinho e segue com o mapa antigo.
  const vetor = (process.env.MAPA_PMTILES_URL || '').trim();
  if (/^https:\/\/[^\s]+\.pmtiles$/.test(vetor)) config.mapaVetor = vetor;
  else if (url) config.mapaVetor = url + '/storage/v1/object/public/mapas/parana.pmtiles';

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send('window.APP_CONFIG = ' + JSON.stringify(config) + ';\n');
};
