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

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send('window.APP_CONFIG = ' + JSON.stringify(config) + ';\n');
};
