// Teste das regras puras do mapa adaptativo (public/js/mapa-rotulos.js)
// Rode com: node testes/mapa_rotulos.test.js
require(require('path').join(__dirname, '../public/js/mapa-rotulos.js'));
const M = globalThis.MapaRotulos;
let ok = 0, falha = 0;
const chk = (c, m, x) => { if (c) { ok++; console.log('  ✔ ' + m); } else { falha++; console.log('  ✘ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };

console.log('Nível de detalhe pelo zoom');
chk(M.nivelDoZoom(12) === 'zoom-longe' && M.nivelDoZoom(14) === 'zoom-longe', 'até o zoom 14: longe (só símbolos)');
chk(M.nivelDoZoom(15) === 'zoom-medio' && M.nivelDoZoom(16) === 'zoom-medio', 'zoom 15 e 16: médio (nomes curtos)');
chk(M.nivelDoZoom(17) === 'zoom-perto' && M.nivelDoZoom(19) === 'zoom-perto', 'a partir do 17: perto (tudo)');
chk(M.ZOOM_SEM_AGRUPAR === 19, 'pessoas ainda se agrupam nas escalas de 200 m (zoom 16) e 100 m (zoom 17); só a partir do zoom 19 ficam soltas');

console.log('Tamanho dos ícones pelo zoom');
chk(M.escalaDoZoom(16) === 0.9 && M.escalaDoZoom(16) > M.escalaDoZoom(14) && M.escalaDoZoom(14) > M.escalaDoZoom(12), 'de longe diminui até o zoom 12');
chk(M.escalaDoZoom(17) < M.escalaDoZoom(16) && M.escalaDoZoom(18) < M.escalaDoZoom(17) && M.escalaDoZoom(19) < M.escalaDoZoom(18) && M.escalaDoZoom(20) < M.escalaDoZoom(19), 'da escala de 100 m (zoom 17) para menos os ícones diminuem a cada nível');
chk(M.escalaDoZoom(22) === 0.5 && [10, 13, 16, 17, 18, 19, 20, 22].every((z) => M.escalaDoZoom(z) >= 0.5 && M.escalaDoZoom(z) <= 1), 'nunca menor que a metade');

console.log('Quem pede atenção fica sempre à vista');
['mk ajuda', 'mk antigo saida', 'mk selecionado', 'mk eu resp-grupo'].forEach((c) => chk(M.ehDestaque(c), '"' + c + '" é destaque'));
['mk', 'mk antigo msg-nova', 'mk resp-grupo', 'mk ajudante'].forEach((c) => chk(!M.ehDestaque(c), '"' + c + '" não é destaque'));

console.log('Cores do círculo de pessoas agrupadas');
chk(M.fatiasDeCor(['#a', '#a', '#b', '#c']) === '#a 0.0deg 180.0deg, #b 180.0deg 270.0deg, #c 270.0deg 360.0deg', 'proporção de cada grupo no anel');
chk(M.fatiasDeCor(['#a']) === '#a 0.0deg 360.0deg', 'um grupo só: anel inteiro');

console.log('\nMapa adaptativo: ' + ok + ' OK, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
