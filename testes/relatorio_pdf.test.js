// Relatório diário e da passagem de comando (public/js/relatorio-pdf.js): montagem do documento, sem rede.
const RP = require('../public/js/relatorio-pdf.js');
const assert = require('assert');
let falhas = 0;
function teste(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); }
}
function textos(no, acc) {
  acc = acc || [];
  if (no == null) return acc;
  if (typeof no === 'string') { acc.push(no); return acc; }
  if (Array.isArray(no)) { no.forEach((x) => textos(x, acc)); return acc; }
  if (typeof no === 'object') {
    if (no.text != null) textos(no.text, acc);
    ['stack', 'columns', 'content'].forEach((k) => no[k] && textos(no[k], acc));
    if (no.table) textos(no.table.body, acc);
  }
  return acc;
}
const dia = '2026-10-29';
const t = (h) => new Date(2026, 9, 29, h, 0).toISOString();
const dados = {
  gerado_em: new Date(2026, 9, 30, 0, 5).toISOString(), gerado_por_nome: 'Sgt Fontana',
  operacao: { codigo: 'OP RIO', status: 'ativa', acionado_em: new Date(2026, 9, 28, 8).toISOString(), criada_em: new Date(2026, 9, 28, 8).toISOString() },
  participantes: [{ nome: 'Cb Silva', entrou_em: t(9) }, { nome: 'Sd Ana', entrou_em: new Date(2026, 9, 28, 9).toISOString() }],
  setores: [{ id: 's1', nome: 'A', status: 'concluido', forma: 'circulo', centro_lat: -25, centro_lng: -49, raio_m: 100, missoes: [] }],
  vitimas: [{ id: 'v1', nome: 'José', idade: 78, caracteristicas: 'grisalho', roupas: 'camisa azul' }],
  pontos: [{ categoria: 'OUTRO', tipo_nome: 'Heliponto', titulo: 'H1', lat: -25, lng: -49, criado_em: t(10) }],
  fotos: [{ capturada_em: t(11) }, { capturada_em: new Date(2026, 9, 28, 11).toISOString() }],
  diario: [
    { ocorrido_em: t(9), categoria: 'pessoa', tipo: 'participante_entrou', titulo: 'Cb Silva entrou', autor_nome: 'sistema' },
    { ocorrido_em: t(12), categoria: 'encontro', tipo: 'relato_vestigio', titulo: 'Vestígio: boné', detalhe: 'na trilha', lat: -25, lng: -49, autor_nome: 'Cb Silva' },
    { ocorrido_em: t(15), categoria: 'setor', tipo: 'setor_concluido', titulo: 'Setor A concluído', autor_nome: 'Sgt' },
    { ocorrido_em: new Date(2026, 9, 28, 15).toISOString(), categoria: 'observacao', tipo: 'observacao', titulo: 'Ontem: chuva', autor_nome: 'Sgt' },
  ],
};

console.log('Relatório diário e da passagem de comando');
teste('diário: só o que aconteceu no dia, com a situação ao fim dele', () => {
  const doc = RP.montarDiario(dados, { mapaGeral: 'data:image/png;base64,AA' }, dia);
  const tx = textos(doc.content).join(' | ');
  assert.ok(/RELATÓRIO DIÁRIO DA OPERAÇÃO/.test(tx));
  assert.ok(/29 de outubro de 2026/.test(tx), 'data por extenso');
  assert.ok(/Vestígio: boné/.test(tx) && /Setor A concluído/.test(tx) && /Cb Silva entrou/.test(tx), 'registros do dia');
  assert.ok(!/Ontem: chuva/.test(tx), 'registro de outro dia fica de fora');
  assert.ok(/Heliponto/.test(tx), 'ponto do dia com o nome do tipo');
  assert.ok(/José/.test(tx) && /2º dia/.test(tx), 'vítimas e dia da operação');
  const numeros = doc.content.find((c) => c.table && c.table.widths && c.table.widths.length === 5);
  const n = numeros.table.body[0].map((c) => c.stack[0].text);
  assert.deepStrictEqual(n, ['3', '1', '1', '1', '1'], 'registros, encontros, setores concluídos, pessoas que entraram e fotos do dia');
  assert.ok(doc.content.some((c) => c.image === 'data:image/png;base64,AA'), 'mapa geral');
  assert.ok(/RELATÓRIO DIÁRIO 29\/10/.test(JSON.stringify(doc.header(2))), 'cabeçalho com o dia');
});
teste('passagem de comando: quem passou, quem recebeu, horários e o briefing entregue', () => {
  const pas = { de_nome: 'Ten Um', para_nome: 'Cap Dois', estado: 'aceita', criada_em: t(18), respondida_em: t(18.5), nota: 'Equipe Alfa no setor B', resumo: { gerado_em: t(18) } };
  const linhas = ['BRIEFING — OP RIO (18:00)', 'Comando: Ten Um', 'OBJETIVO: localizar o Sr. José', 'VÍTIMAS: José (78)'];
  const doc = RP.montarPassagem(dados.operacao, pas, linhas, {}, { gerado_por_nome: 'Cap Dois' });
  const tx = textos(doc.content).join(' | ');
  assert.ok(/PASSAGEM DE COMANDO/.test(tx) && /Ten Um/.test(tx) && /Cap Dois/.test(tx) && /Aceita em/.test(tx));
  assert.ok(/Equipe Alfa no setor B/.test(tx), 'recado');
  assert.ok(/Objetivo/.test(tx) && /localizar o Sr\. José/.test(tx) && /Vítimas/.test(tx), 'briefing em ficha');
  assert.strictEqual(doc.info.title, 'Passagem de comando — OP RIO');
});

if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
console.log('\nTodos os testes dos relatórios diário e da passagem passaram.');
