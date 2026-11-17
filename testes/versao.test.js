// Versão do sistema (public/js/versao.js) — rode com: node testes/versao.test.js
// Confere que o número é o mesmo em todo lugar (versao.js, versao.json e o <meta> das páginas) e que a lista de novidades
// começa pela versão atual: assim nenhuma atualização sai sem subir o número.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const V = require('../public/js/versao.js');
const raiz = path.join(__dirname, '..', 'public');
let falhas = 0;
function teste(nome, fn) { try { fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); } }

teste('número no formato 1.2.3', () => assert.ok(/^\d+\.\d+\.\d+$/.test(V.numero), V.numero));
teste('versao.json tem o mesmo número', () => assert.strictEqual(JSON.parse(fs.readFileSync(path.join(raiz, 'versao.json'), 'utf8')).versao, V.numero));
teste('o <meta name="gbs-versao"> das páginas tem o mesmo número', () => {
  ['comando.html', 'participante.html'].forEach((p) => {
    const m = /<meta name="gbs-versao" content="([^"]+)">/.exec(fs.readFileSync(path.join(raiz, p), 'utf8'));
    assert.ok(m && m[1] === V.numero, p + ': ' + (m && m[1]));
  });
});
teste('as páginas carregam o versao.js e mostram o número', () => {
  ['comando.html', 'participante.html', 'dashboard.html'].forEach((p) => {
    const h = fs.readFileSync(path.join(raiz, p), 'utf8');
    assert.ok(/<script src="js\/versao\.js"><\/script>/.test(h) && /data-versao/.test(h), p);
  });
});
teste('novidades: a primeira é a versão atual, em ordem decrescente e sem repetir', () => {
  assert.strictEqual(V.novidades[0].versao, V.numero);
  assert.strictEqual(V.novidades[0].data, V.data);
  const num = (v) => v.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0);
  for (let i = 1; i < V.novidades.length; i++) assert.ok(num(V.novidades[i - 1].versao) > num(V.novidades[i].versao), V.novidades[i].versao);
  V.novidades.forEach((n) => assert.ok(n.itens.length > 0, n.versao));
});
teste('texto mostrado', () => assert.strictEqual(V.texto(), 'Versão ' + V.numero));

if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
console.log('\nVersão ' + V.numero + ': tudo certo.');
