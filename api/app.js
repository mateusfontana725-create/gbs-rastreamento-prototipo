// GET /api/app            →  { disponivel, baixar, pacote }: o botão "Baixar aplicativo" da página do participante.
// GET /api/app?baixar=1   →  redireciona para o arquivo do aplicativo Android (APK).
//
// O APK é gerado pelo GitHub Actions (.github/workflows/apk.yml) e publicado no Release "app-android" do repositório.
// APP_ANDROID_URL troca o endereço (ex.: outro repositório ou um bucket público); "desligado" esconde o botão.
const PADRAO = 'https://github.com/mateusfontana725-create/gbs-rastreamento-prototipo/releases/download/app-android/gbs-busca.apk';

function endereco() {
  const v = (process.env.APP_ANDROID_URL || '').trim();
  if (v.toLowerCase() === 'desligado') return null;
  const url = v || PADRAO;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch (e) {
    return null;
  }
}

module.exports = (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ erro: 'metodo_nao_permitido' });
  }
  const url = endereco();
  const q = req.query || {};
  if (q.baixar !== undefined) {
    if (!url) return res.status(404).json({ erro: 'aplicativo_indisponivel' });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Location', url);
    return res.status(302).end();
  }
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({ disponivel: Boolean(url), baixar: url ? '/api/app?baixar=1' : null, pacote: 'br.gbs.busca' });
};
