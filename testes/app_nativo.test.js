// Aplicativo Android: links de abertura (js/app-nativo.js), texto do estado e o endpoint /api/app (link do APK).
const path = require('path');
const assert = require('assert');
let falhas = 0;
async function teste(nome, fn) {
  try { await fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
const ARQ_API = path.join(__dirname, '..', 'api', 'app.js');
function api() { delete require.cache[ARQ_API]; return require(ARQ_API); }
function resposta() {
  return { code: 200, body: null, headers: {}, fim: false, setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { this.fim = true; return this; } };
}

(async () => {
  const A = require(path.join(__dirname, '..', 'public', 'js', 'app-nativo.js'));
  const T = 'a'.repeat(64), V = 'b'.repeat(32);

  await teste('fora do aplicativo a ponte fica desligada (página web igual)', () => {
    assert.strictEqual(A.disponivel, false);
    assert.strictEqual(typeof A.iniciar, 'undefined');
  });
  await teste('link do aplicativo leva servidor, token e código', () => {
    assert.strictEqual(A.linkApp('https://busca.exemplo.com', T, V), 'gbsbusca://vincular?o=https%3A%2F%2Fbusca.exemplo.com&t=' + T + '&v=' + V);
    assert.strictEqual(A.linkApp('https://busca.exemplo.com', T, null), 'gbsbusca://vincular?o=https%3A%2F%2Fbusca.exemplo.com&t=' + T);
  });
  await teste('link intent do Chrome: só o pacote do aplicativo abre; sem ele, baixa o APK', () => {
    const i = A.linkIntent('https://busca.exemplo.com', T, V, 'https://busca.exemplo.com/api/app?baixar=1');
    assert.ok(i.startsWith('intent://vincular?o=https%3A%2F%2Fbusca.exemplo.com&t=' + T + '&v=' + V + '#Intent;'));
    assert.ok(i.includes(';scheme=gbsbusca;package=br.gbs.busca;'));
    assert.ok(i.includes('S.browser_fallback_url=' + encodeURIComponent('https://busca.exemplo.com/api/app?baixar=1')));
    assert.ok(i.endsWith(';end'));
  });
  await teste('Android e aplicativo pelo user agent', () => {
    assert.ok(A.ehAndroid('Mozilla/5.0 (Linux; Android 14; SM-A145M) Chrome/130'));
    assert.ok(!A.ehAndroid('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'));
    assert.ok(A.ehApp('Mozilla/5.0 (Linux; Android 14) Chrome/130 GBSApp/1.0.3'));
  });
  await teste('estado do registro em uma linha', () => {
    const agora = 1.79e12;
    assert.strictEqual(A.textoEstado(null), '');
    const t = A.textoEstado({ rastreando: true, pendentes: 12, ultimoEnvioEm: agora - 125000 }, agora);
    assert.ok(t.includes('Pelo aplicativo'), t);
    assert.ok(t.includes('12 guardados no celular'), t);
    assert.ok(t.includes('enviado há 2 min'), t);
    assert.ok(A.textoEstado({ rastreando: true, pendentes: 1, ultimoErro: 'funcao_ausente' }, agora).includes('servidor desatualizado'));
    assert.ok(A.textoEstado({ rastreando: false, pendentes: 0 }, agora).includes('Aplicativo parado'));
  });
  await teste('ponte do aplicativo: pedido e resposta pelo id, eventos para os ouvintes', async () => {
    const enviados = [];
    const g = { GBSNativo: { postMessage: (m) => enviados.push(JSON.parse(m)) } };
    const ARQ = path.join(__dirname, '..', 'public', 'js', 'app-nativo.js');
    const codigo = require('fs').readFileSync(ARQ, 'utf8').replace("typeof window !== 'undefined' ? window : globalThis", 'g');
    new Function('g', 'module', codigo)(g, undefined);
    const B = g.GBSApp;
    assert.strictEqual(B.disponivel, true);
    const p = B.iniciar({ participanteId: 'x' });
    assert.strictEqual(enviados[0].acao, 'iniciar');
    g.GBSNativo.onmessage({ data: JSON.stringify({ id: enviados[0].id, dados: { ok: true } }) });
    assert.deepStrictEqual(await p, { ok: true });
    let recebido = null;
    B.ao('estado', (d) => { recebido = d; });
    g.GBSNativo.onmessage({ data: JSON.stringify({ evento: 'estado', dados: { pendentes: 3 } }) });
    assert.strictEqual(recebido.pendentes, 3);
    g.GBSNativo.onmessage({ data: 'não é json' });
  });

  await teste('/api/app: informa o link de download', () => {
    delete process.env.APP_ANDROID_URL;
    const r = resposta();
    api()({ method: 'GET', query: {} }, r);
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(r.body, { disponivel: true, baixar: '/api/app?baixar=1', pacote: 'br.gbs.busca' });
  });
  await teste('/api/app?baixar=1 redireciona para o APK do Release', () => {
    const r = resposta();
    api()({ method: 'GET', query: { baixar: '1' } }, r);
    assert.strictEqual(r.code, 302);
    assert.ok(/^https:\/\/github\.com\/.+\/releases\/download\/app-android\/gbs-busca\.apk$/.test(r.headers.Location), r.headers.Location);
    assert.strictEqual(r.headers['Cache-Control'], 'no-store');
  });
  await teste('APP_ANDROID_URL troca o endereço; http e lixo são recusados; "desligado" esconde o botão', () => {
    process.env.APP_ANDROID_URL = 'https://arquivos.exemplo.com/gbs.apk';
    let r = resposta(); api()({ method: 'GET', query: { baixar: '' } }, r);
    assert.strictEqual(r.headers.Location, 'https://arquivos.exemplo.com/gbs.apk');
    process.env.APP_ANDROID_URL = 'http://inseguro.exemplo.com/gbs.apk';
    r = resposta(); api()({ method: 'GET', query: {} }, r);
    assert.strictEqual(r.body.disponivel, false);
    process.env.APP_ANDROID_URL = 'javascript:alert(1)';
    r = resposta(); api()({ method: 'GET', query: { baixar: '1' } }, r);
    assert.strictEqual(r.code, 404);
    process.env.APP_ANDROID_URL = 'desligado';
    r = resposta(); api()({ method: 'GET', query: {} }, r);
    assert.deepStrictEqual(r.body, { disponivel: false, baixar: null, pacote: 'br.gbs.busca' });
    delete process.env.APP_ANDROID_URL;
  });
  await teste('/api/app só aceita GET', () => {
    const r = resposta(); api()({ method: 'POST', query: {} }, r);
    assert.strictEqual(r.code, 405);
  });

  await teste('casos do filtro nativo atualizados com o gps.js (senão: node android/ferramentas/gerar-casos-filtro.js e rodar os testes do app)', () => {
    const fs = require('fs'), os = require('os');
    const tmp = path.join(os.tmpdir(), 'filtro-casos-' + process.pid + '.json');
    require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'android', 'ferramentas', 'gerar-casos-filtro.js'), tmp], { stdio: 'ignore' });
    const novo = fs.readFileSync(tmp, 'utf8');
    fs.unlinkSync(tmp);
    assert.ok(novo === fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'test', 'resources', 'filtro-casos.json'), 'utf8'));
  });

  console.log(falhas ? '\n' + falhas + ' falha(s)' : '\nAplicativo Android (links e /api/app): tudo OK');
  process.exit(falhas ? 1 : 0);
})();
