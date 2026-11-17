// IPO (public/js/ipo.js) e relatório resumido (public/js/relatorio-pdf.js) — rode com: node testes/ipo.test.js
// O exemplo é um IPO real do 3º BBM (busca terrestre/aquática no Rio Rondon), resumido.
globalThis.window = globalThis;
require('../public/js/ipo.js');
const RP = require('../public/js/relatorio-pdf.js');
const assert = require('assert');
const I = globalThis.Ipo;
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
const local = (a, m, d, h, mi) => new Date(a, m - 1, d, h, mi).toISOString();
const VID = '11111111-1111-4111-8111-111111111111';
const op = {
  codigo: 'Rio Rondon', status: 'ativa', acionado_em: local(2026, 11, 2, 17, 20), criada_em: local(2026, 11, 2, 17, 25), local_lat: -22.8969, local_lng: -51.6602,
  descricao: 'A vítima saiu, pela manhã, para trabalhar, à cavalo, sem meios de comunicação.',
  ipo: {
    destinatarios: '3º BBM', unidade: '3º BBM/2ª CBM/3º PBM - Rolândia', rgo: '20263BBM12221', natureza: 'BUSCA TERRESTRE/AQUÁTICA – PESSOA',
    localidade: 'Guaraci Fazenda União - Rio Rondom', meio_liquido: 'rio', coord_referencia: '22°53\'48.90"S 51°39\'36.78"W', pessoas_perdidas: 1,
    desaparecimento: local(2026, 11, 2, 7, 40), desaparecimento_qualidade: 'estimado', buscas_preliminares: 'sem_necessidade', possibilidade_vida: 'desconhecido',
    procedimentos: ['margens', 'dentro_agua', 'drone', 'k9', 'inexistente', 'k9'],
    recursos_cb: 'ABS BM 13629 3ºBBM/2CIA/3PEL - Rolândia.\n\n\n- ABRESC BM 004 - Canil Setorial 3° BBM.',
    efetivo: [{ dia: '2026-11-03', qtd: 3, nomes: 'Sgt. Correa, Sgt. Berzotti e Cb. Alves' }, { dia: '2026-11-02', qtd: 2, nomes: 'CB. Rolândia' }, { dia: '2026-13-40', qtd: 9 }, { dia: '2026-11-04' }],
    desdobramentos: [{ dia: '2026-11-03', texto: 'Sgt. Berzotti com a K9 Eva e o Cb. Alves nas margens, sentido à jusante.' }, { dia: '2026-11-02', texto: '02 BBMM para primeira resposta.' }],
    orgaos_apoio: 'PMPR: 02 PMs - Patrulha Rural 15°BPM\nHelicóptero BPMOA.', imagens_anexas: true, responsavel_informacoes: 'Cb. Alves/GBS', vitimas_docs: { [VID]: '129.590.679-16', x: 'y' },
  },
};
const vitimas = [{ id: VID, nome: 'Gustavo Teixeira da Silva', sexo: 'M', idade: 19, origem: 'Naturalidade: Cornélio Procópio' }];
const diario = [{ tipo: 'desdobramento', ocorrido_em: local(2026, 11, 4, 15, 0), detalhe: 'Continuidade com K9 e drone Harpia 22.' },
  { tipo: 'recurso', ocorrido_em: local(2026, 11, 3, 9, 0), detalhe: 'ABRESC BM 005 - Canil Setorial 3° BBM' },
  { tipo: 'procedimento', ref_id: 'maquinario', ocorrido_em: local(2026, 11, 4, 9, 0) }];

console.log('IPO: dados');
teste('natureza terrestre/aquática conta como aquática (tem meio líquido)', () => {
  assert.deepStrictEqual(I.tipoDaNatureza('BUSCA TERRESTRE/AQUÁTICA – PESSOA'), { tipo: 'aquatica', tipo_outro: null });
  assert.deepStrictEqual(I.tipoDaNatureza('BUSCA TERRESTRE – PESSOA'), { tipo: 'terrestre', tipo_outro: null });
  assert.strictEqual(I.tipoDaNatureza('Resgate em altura').tipo, 'outras');
});
teste('campos novos: procedimentos válidos e sem repetição, dias válidos e em ordem, linha vazia sai', () => {
  const n = I.normalizarIpo(op.ipo);
  assert.deepStrictEqual(n.procedimentos, ['margens', 'dentro_agua', 'drone', 'k9']);
  assert.deepStrictEqual(n.efetivo.map((x) => x.dia), ['2026-11-02', '2026-11-03']);
  assert.deepStrictEqual(n.desdobramentos.map((x) => x.dia), ['2026-11-02', '2026-11-03']);
  assert.strictEqual(n.recursos_cb.split('\n').length, 3, 'no máximo uma linha em branco seguida');
  assert.deepStrictEqual(Object.keys(n.vitimas_docs), [VID]);
  assert.strictEqual(n.unidade, '3º BBM/2ª CBM/3º PBM - Rolândia');
});
teste('dados antigos (sem os campos novos) continuam válidos', () => {
  const n = I.normalizarIpo({ natureza: 'BUSCA AQUÁTICA – PESSOA', bms_envolvidos: 4 });
  assert.deepStrictEqual(n.efetivo, []);
  assert.deepStrictEqual(n.procedimentos, []);
  assert.strictEqual(n.bms_envolvidos, 4);
});

console.log('IPO: texto para o WhatsApp (formato do 3º BBM)');
const texto = I.textoWhatsApp(op, { vitimas, diario });
teste('cabeçalho, unidade, RGO e natureza em negrito', () => {
  assert.ok(texto.startsWith('*3º BBM - Informe Padrão de Ocorrência (IPO)*'));
  assert.ok(/\*ATENÇÃO: uso exclusivo nos grupos do CBMPR\.\*/.test(texto));
  assert.ok(/\*3º BBM\/2ª CBM\/3º PBM - Rolândia\*\n\*RGO 20263BBM12221\*\n\*Natureza: BUSCA TERRESTRE\/AQUÁTICA – PESSOA\*/.test(texto));
});
teste('datas no formato do informe', () => {
  assert.ok(texto.includes('*Data/hora do início das operações:* 02 nov. 26, 17h20min;'));
  assert.ok(texto.includes('*Data/Horário provável do desaparecimento:* estima-se que 02/11/26, 07h40min;'));
  assert.ok(texto.includes('*Data/Horário do acionamento do CB:* 02/11/26 às 17h20min;'), 'sem a hora própria, vale o início das operações');
});
teste('vítima vem da ficha, com o documento do IPO', () => {
  assert.ok(texto.includes('*Sexo/Idade da(s) vítima(s):* 01 Masculino / 19 anos;'));
  assert.ok(texto.includes('*Nome da vítima:* Gustavo Teixeira da Silva/129.590.679-16;'));
  assert.ok(texto.includes('*Nº de pessoas perdidas:* 01;'));
});
teste('opções marcadas com ( X ), procedimentos do IPO e do diário', () => {
  assert.ok(texto.includes('( X ) Sem necessidade (vítimas certamente perdidas);'));
  assert.ok(texto.includes('( X ) Não sabido;') && texto.includes('(    ) Sim;'));
  assert.ok(texto.includes('( X ) Buscas com emprego de K9;') && texto.includes('( X ) Emprego de maquinário;'));
  assert.ok(texto.includes('*Tipo de meio líquido:* ( X ) Rio;'));
});
teste('recursos, efetivo por dia, desdobramentos (IPO + diário) e órgãos de apoio', () => {
  assert.ok(texto.includes('- ABS BM 13629 3ºBBM/2CIA/3PEL - Rolândia.') && texto.includes('- ABRESC BM 005 - Canil Setorial 3° BBM'));
  assert.ok(texto.includes('02/11/2026: 02 BBMM - CB. Rolândia.\n03/11/2026: 03 BBMM - Sgt. Correa, Sgt. Berzotti e Cb. Alves.'));
  const iD = texto.indexOf('*Desdobramentos/situação atual:*');
  assert.ok(iD > 0 && texto.indexOf('02/11/2026: 02 BBMM para primeira resposta.') > iD && texto.indexOf('04/11/2026: Continuidade com K9') > texto.indexOf('03/11/2026: Sgt. Berzotti'));
  assert.ok(texto.includes('*Órgãos de Apoio:*') && texto.includes('Helicóptero BPMOA.'));
  assert.ok(texto.trim().endsWith('*Responsável pelas informações:* Cb. Alves/GBS'));
});
teste('sem coordenada escrita: usa o último local visto da ficha, depois o local da operação', () => {
  const o2 = Object.assign({}, op, { ipo: Object.assign({}, op.ipo, { coord_referencia: '' }) });
  const t1 = I.textoWhatsApp(o2, { vitimas: [Object.assign({}, vitimas[0], { ulv_lat: -22.1, ulv_lng: -51.2 })], coordenada: (a, b) => a + '|' + b });
  assert.ok(t1.includes('(último avistamento):* -22.1|-51.2;'));
  const t2 = I.textoWhatsApp(o2, { vitimas, coordenada: (a, b) => a + '|' + b });
  assert.ok(t2.includes('(último avistamento):* -22.8969|-51.6602;'));
});

console.log('Relatório resumido');
const dados = {
  gerado_em: local(2026, 11, 15, 18, 0), gerado_por_nome: 'Cb. Alves',
  operacao: Object.assign({}, op, { criador_nome: 'Sgt Berzotti' }),
  participantes: [{ id: 'p1', nome: 'Sgt Borotta', tipo: 'militar', grupos: [{ grupo: 'BOMBEIROS' }] }, { id: 'p2', nome: 'João', tipo: 'civil', grupos: [] }],
  setores: [{ id: 's1', nome: 'Margem direita', status: 'concluido', forma: 'circulo', centro_lat: -22.9, centro_lng: -51.66, raio_m: 200, missoes: [] },
    { id: 's2', nome: 'Barragem', status: 'pendente', forma: 'circulo', centro_lat: -22.91, centro_lng: -51.66, raio_m: 100, missoes: [] }],
  trilhas: [{ participante_id: 'p1', tipo: 'militar', pontos: [[-22.9, -51.66], [-22.901, -51.66], [-22.902, -51.66], [-25.4, -49.2]] }],
  vitimas, diario, grupos: [], pontos: [], fotos: [{ id: 'f1', capturada_em: local(2026, 11, 3, 10, 0), autor_nome: 'Sgt Borotta', lat: -22.9, lng: -51.66 }], responsaveis: [],
};
teste('mapa, números, setores, pessoas com a distância, fotos e o IPO', () => {
  const doc = RP.montarResumido(dados, { mapaGeral: 'data:image/jpeg;base64,AA==', mapaNota: 'Mapa enquadrado num raio de 1,2 km em volta do local da operação.', fotos: { f1: 'data:image/jpeg;base64,AA==' }, fotosResumo: dados.fotos });
  const tx = textos(doc.content).join(' | ');
  assert.ok(/RELATÓRIO RESUMIDO DA OPERAÇÃO/.test(tx) && /Rio Rondon/.test(tx));
  assert.ok(/1 \/ 2/.test(tx), 'setores concluídos');
  assert.ok(/Mapa enquadrado num raio/.test(tx), 'nota do enquadramento');
  assert.ok(/Sgt Borotta/.test(tx) && /0,2 km/.test(tx), 'distância da pessoa sem contar o salto para outra cidade');
  assert.ok(/Fotos \(1 de 1\)/.test(tx));
  assert.ok(/Informe Padrão de Ocorrência/.test(tx) && /20263BBM12221/.test(tx) && /Buscas com emprego de K9/.test(tx) && /Helicóptero BPMOA/.test(tx), 'IPO completo');
  assert.strictEqual(doc.info.title, 'Relatório resumido — Rio Rondon');
});
teste('relatório final também traz o IPO completo', () => {
  const doc = RP.montarDocumento(Object.assign({ relatorios_anteriores: [] }, dados), {});
  const tx = textos(doc.content).join(' | ');
  assert.ok(/RGO 20263BBM12221/.test(tx) && /Desdobramentos\/situação atual/.test(tx) && /Gustavo Teixeira da Silva\/129\.590\.679-16/.test(tx));
});

if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
console.log('\nTodos os testes do IPO e do relatório resumido passaram.');
