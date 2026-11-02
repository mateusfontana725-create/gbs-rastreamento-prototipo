// GET /api/app            →  { disponivel, baixar, pacote }: o botão "Baixar aplicativo" da página do participante.
// GET /api/app?baixar=1   →  entrega o arquivo do aplicativo Android (APK) por este mesmo endereço.
//
// O APK é gerado pelo GitHub Actions (.github/workflows/apk.yml) e publicado no Release "app-android" do repositório.
// APP_ANDROID_URL troca o endereço (ex.: outro repositório ou um bucket público); "desligado" esconde o botão.
//
// Por que não só redirecionar: o GitHub manda o navegador para um link assinado que vale poucos minutos.
// No Android o download às vezes começa depois (ou o link é repassado) e chega "expirado": o arquivo baixado
// vira uma página de erro e não instala. Aqui o servidor busca o APK e entrega com nome e tipo certos.
// Se a busca falhar (ou o arquivo passar do limite da função), volta ao redirecionamento de antes.
const PADRAO = 'https://github.com/mateusfontana725-create/gbs-rastreamento-prototipo/releases/download/app-android/gbs-busca.apk';
// deploy da branch testes (Vercel informa a branch em VERCEL_GIT_COMMIT_REF): o APK gerado da testes, com o de produção de reserva
const TESTES = 'https://github.com/mateusfontana725-create/gbs-rastreamento-prototipo/releases/download/app-android-testes/gbs-busca.apk';
const LIMITE_BYTES = 4 * 1024 * 1024;   // a resposta da função tem limite (~4,5 MB); acima disso, redireciona
const TIPO_APK = 'application/vnd.android.package-archive';

// Endereços a tentar, em ordem ([] = aplicativo desligado ou endereço inválido).
function enderecos() {
  const v = (process.env.APP_ANDROID_URL || '').trim();
  if (v.toLowerCase() === 'desligado') return [];
  if (!v) return (process.env.VERCEL_GIT_COMMIT_REF || '').trim() === 'testes' ? [TESTES, PADRAO] : [PADRAO];
  return endereco(v) ? [v] : [];
}

function endereco(url) {
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch (e) {
    return null;
  }
}

function redirecionar(res, url) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', url);
  return res.status(302).end();
}

// Busca o APK (seguindo os redirecionamentos do GitHub). Devolve Buffer ou null (quem chama redireciona).
async function buscarApk(url) {
  if (typeof fetch !== 'function') return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 15000) : null;
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctl ? ctl.signal : undefined, headers: { Accept: 'application/octet-stream' } });
    if (!r.ok) return null;
    const tam = Number(r.headers.get('content-length') || 0);
    if (tam > LIMITE_BYTES) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    // um APK é um ZIP: começa com "PK". Página de erro (HTML/XML) nunca é entregue como aplicativo.
    if (buf.length < 4 || buf.length > LIMITE_BYTES || buf[0] !== 0x50 || buf[1] !== 0x4b) return null;
    return buf;
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ erro: 'metodo_nao_permitido' });
  }
  const lista = enderecos();
  const url = lista[0] || null;
  const q = req.query || {};
  if (q.baixar !== undefined) {
    if (!url) return res.status(404).json({ erro: 'aplicativo_indisponivel' });
    let apk = null;
    for (let i = 0; i < lista.length && !apk; i++) apk = await buscarApk(lista[i]);
    if (!apk) return redirecionar(res, lista[lista.length - 1]);
    res.setHeader('Content-Type', TIPO_APK);
    res.setHeader('Content-Disposition', 'attachment; filename="gbs-busca.apk"');
    res.setHeader('Content-Length', String(apk.length));
    // a CDN guarda por 5 min (um APK novo aparece em até 5 min); o celular não guarda
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
    res.status(200);
    return req.method === 'HEAD' ? res.end() : res.end(apk);
  }
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({ disponivel: Boolean(url), baixar: url ? '/api/app?baixar=1' : null, pacote: 'br.gbs.busca' });
};
