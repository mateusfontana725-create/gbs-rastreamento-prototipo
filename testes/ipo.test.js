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
  // o responsável é quem gerou o IPO (extra.responsavel), nunca um nome guardado no cadastro
  assert.ok(texto.trim().endsWith('*Responsável pelas informações:* Não apurado') && !texto.includes('Cb. Alves/GBS'), 'sem quem gerou: Não apurado, e o nome guardado não aparece');
  const comQuem = I.textoWhatsApp(op, { vitimas: [], diario: [], responsavel: 'Sgt. Quem Gerou' });
  assert.ok(comQuem.trim().endsWith('*Responsável pelas informações:* Sgt. Quem Gerou'), 'quem gerou');
  assert.ok(!comQuem.includes('Cb. Alves/GBS'));
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
  assert.ok(/RELATÓRIO FINAL DA OPERAÇÃO/.test(tx) && /Rio Rondon/.test(tx));
  assert.ok(/1 \/ 2/.test(tx), 'setores concluídos');
  assert.ok(/Mapa enquadrado num raio/.test(tx), 'nota do enquadramento');
  assert.ok(/Sgt Borotta/.test(tx) && /0,2 km/.test(tx), 'distância da pessoa sem contar o salto para outra cidade');
  assert.ok(/Fotos \(1 de 1\)/.test(tx));
  assert.ok(/Informe Padrão de Ocorrência/.test(tx) && /20263BBM12221/.test(tx) && /Buscas com emprego de K9/.test(tx) && /Helicóptero BPMOA/.test(tx), 'IPO completo');
  assert.strictEqual(doc.info.title, 'Relatório final — Rio Rondon');
});
teste('relatório final também traz o IPO completo', () => {
  const doc = RP.montarDocumento(Object.assign({ relatorios_anteriores: [] }, dados), {});
  const tx = textos(doc.content).join(' | ');
  assert.ok(/RGO 20263BBM12221/.test(tx) && /Desdobramentos\/situação atual/.test(tx) && /Gustavo Teixeira da Silva\/129\.590\.679-16/.test(tx));
});

console.log('IPO dentro dos relatórios e relatório de comando');
teste('relatório diário e de um comando trazem o IPO', () => {
  const dia = RP.montarDiario(dados, {}, '2026-11-03');
  const cmd = RP.montarComando(dados, {}, { rotulo: 'Comando 2', ini: new Date(2026, 10, 3, 8).getTime(), fim: new Date(2026, 10, 4, 8).getTime(), comandante: 'Sgt Dinardi', passadoA: 'Sgt Borotta' });
  [dia, cmd].forEach((doc) => { const tx = textos(doc.content).join(' | '); assert.ok(/Informe Padrão de Ocorrência/.test(tx) && /RGO 20263BBM12221/.test(tx)); });
});
teste('todos os comandos: tabela com cada comandante e o briefing de cada passagem', () => {
  const comandos = [
    { rotulo: 'Comando 1', comandante: 'Sgt Berzotti', ini: new Date(2026, 10, 2, 17).getTime(), fim: new Date(2026, 10, 5, 8).getTime(), passadoA: 'Sgt Dinardi', fechamento: [['Objetivo', 'varrer a margem direita']] },
    { rotulo: 'Comando 2', comandante: 'Sgt Dinardi', ini: new Date(2026, 10, 5, 8).getTime(), fim: null, passadoA: null, fechamento: null },
  ];
  const tx = textos(RP.montarComandoGeral(dados, {}, comandos).content).join(' | ');
  assert.ok(/TODOS OS COMANDOS/.test(tx) && /Comandos da operação/.test(tx));
  assert.ok(/Sgt Berzotti/.test(tx) && /Sgt Dinardi/.test(tx) && /em andamento/.test(tx));
  assert.ok(/varrer a margem direita/.test(tx), 'briefing da passagem');
  assert.ok(/Informe Padrão de Ocorrência/.test(tx), 'IPO');
});
teste('o relatório da imprensa não traz o IPO (tem nomes)', () => {
  const tx = JSON.stringify(RP.montarImprensa(dados, {}));
  assert.ok(!/Informe Padrão de Ocorrência/.test(tx) && !/Gustavo/.test(tx) && !/Berzotti/.test(tx) && !/Correa/.test(tx));
  assert.ok(/Procura por um homem de 19 anos/.test(tx));
});

console.log('IPO (Diário): IPO de cada dia e relatório separado por dia');
teste('gravarDia grava só aquele dia e mantém os dados gerais e os outros dias', () => {
  let ipo = { unidade: 'X', rgo: '1', desdobramentos: [{ dia: '2026-11-03', texto: 'Dia 3' }], efetivo: [{ dia: '2026-11-03', qtd: 4, nomes: 'A' }] };
  ipo = I.gravarDia(ipo, { dia: '2026-11-04', texto: 'Varredura com K9', qtd: '6', nomes: 'B e C', procedimentos: ['k9', 'invalido'], recursos: 'ABTS 12', orgaos: 'PMPR', situacao: 'Amanhã: setor 4', por: 'Sgt Um' });
  assert.strictEqual(ipo.unidade, 'X');
  assert.deepStrictEqual(ipo.desdobramentos.map((x) => x.dia), ['2026-11-03', '2026-11-04']);
  assert.strictEqual(ipo.efetivo[1].qtd, 6);
  assert.deepStrictEqual(ipo.dias[0].procedimentos, ['k9']);
  // regravar o dia troca (não duplica); dia vazio sai das listas
  ipo = I.gravarDia(ipo, { dia: '2026-11-04', texto: 'Outro texto', qtd: null, nomes: '' });
  assert.deepStrictEqual(ipo.desdobramentos.filter((x) => x.dia === '2026-11-04').map((x) => x.texto), ['Outro texto']);
  assert.ok(!ipo.efetivo.some((x) => x.dia === '2026-11-04') && !ipo.dias.length);
  assert.deepStrictEqual(I.diasComIpo(ipo), ['2026-11-03', '2026-11-04']);
});
teste('ipoDoDia junta o IPO do dia e os registros antigos do diário daquele dia', () => {
  const ipo = I.gravarDia({}, { dia: '2026-11-04', texto: 'Feito', procedimentos: ['drone'], situacao: 'Pendente setor 2' });
  const d = I.ipoDoDia(ipo, '2026-11-04', [{ tipo: 'procedimento', ref_id: 'k9', ocorrido_em: local(2026, 11, 4, 10, 0) }, { tipo: 'recurso', detalhe: 'Viatura', ocorrido_em: local(2026, 11, 4, 11, 0) }, { tipo: 'recurso', detalhe: 'Outro dia', ocorrido_em: local(2026, 11, 5, 11, 0) }]);
  assert.deepStrictEqual(d.procedimentos, ['drone', 'k9']);
  assert.strictEqual(d.recursosDiario, 'Viatura');
  assert.ok(!d.vazio && I.ipoDoDia(ipo, '2026-11-05', []).vazio);
});
teste('texto do WhatsApp de um dia traz só aquele dia', () => {
  let ipo = I.gravarDia(op.ipo, { dia: '2026-11-04', texto: 'Só do dia 4', qtd: 3, nomes: 'D', situacao: 'Continuar amanhã' });
  const t = I.textoWhatsApp(Object.assign({}, op, { ipo }), { dia: '2026-11-04' });
  assert.ok(/IPO do dia 04\/11\/2026/.test(t) && /Só do dia 4/.test(t) && /Continuar amanhã/.test(t));
  assert.ok(!/03\/11\/2026:/.test(t), 'não traz outro dia');
});
teste('relatório diário (detalhado) separa cada dia: IPO, pessoas, km, setores e diário só daquele dia', () => {
  const setor = { id: 'S1', nome: 'Setor Margem', forma: 'poligono', pontos: [[-22.90, -51.67], [-22.90, -51.65], [-22.89, -51.65], [-22.89, -51.67]], status: 'andamento', missoes: [] };
  const d = Object.assign({ gerado_em: new Date().toISOString(), gerado_por_nome: 'Sgt Um', vitimas: [], pontos: [], fotos: [], grupos: [] }, {
    operacao: Object.assign({}, op, { ipo: I.gravarDia(Object.assign({}, op.ipo, { desdobramentos: [], efetivo: [] }), { dia: '2026-11-04', texto: 'Varredura na margem com K9', qtd: 5, nomes: 'Equipe Alfa' }) }),
    setores: [setor],
    participantes: [{ id: 'P1', nome: 'Cb Alves', tipo: 'militar', entrou_em: local(2026, 11, 3, 8, 0), grupos: [{ grupo: 'Alfa' }] }, { id: 'P2', nome: 'Voluntário Beto', tipo: 'civil', entrou_em: local(2026, 11, 4, 9, 0), grupos: [] }],
    diario: [
      { id: 1, ocorrido_em: local(2026, 11, 3, 10, 0), categoria: 'setor', tipo: 'setor_iniciado', titulo: 'Setor iniciado', ref_id: 'S1', autor_nome: 'Sistema', origem: 'auto' },
      { id: 2, ocorrido_em: local(2026, 11, 4, 15, 0), categoria: 'observacao', tipo: 'observacao', titulo: 'Observação', detalhe: 'Chuva forte à tarde', autor_nome: 'Sgt Um', origem: 'manual' },
    ],
  });
  const trilhas = [
    { participante_id: 'P1', nome: 'Cb Alves', tipo: 'militar', dia: '2026-11-03', primeiro: local(2026, 11, 3, 8, 0), ultimo: local(2026, 11, 3, 16, 0), n: 40, km: 7.25, pontos: [[-22.895, -51.66], [-22.896, -51.661]] },
    { participante_id: 'P1', nome: 'Cb Alves', tipo: 'militar', dia: '2026-11-04', primeiro: local(2026, 11, 4, 8, 0), ultimo: local(2026, 11, 4, 12, 0), n: 20, km: 3.1, pontos: [[-22.80, -51.60], [-22.81, -51.61]] },
  ];
  const dias = RP.separarDias(d, trilhas, RP.diasEntre('2026-11-03', '2026-11-04'));
  assert.strictEqual(dias.length, 2);
  assert.deepStrictEqual(dias[0].pessoas.map((p) => p.nome), ['Cb Alves']);
  assert.deepStrictEqual(dias[1].pessoas.map((p) => p.nome).sort(), ['Cb Alves', 'Voluntário Beto']);
  assert.ok(dias[1].pessoas.find((p) => p.nome === 'Voluntário Beto').semPosicao);
  assert.strictEqual(dias[0].setores.length, 1, 'dia 3: setor com registro e trilha dentro');
  assert.deepStrictEqual(dias[0].setores[0].pessoas, ['Cb Alves']);
  assert.strictEqual(dias[1].setores.length, 0, 'dia 4: a trilha ficou fora do setor');
  assert.strictEqual(dias[0].numero, 2);
  assert.ok(dias[0].ipo.vazio && !dias[1].ipo.vazio);
  const tx = textos(RP.montarDiarioDias(d, {}, { dias, subtitulo: 'De 03/11 a 04/11', titulo: 'Diário', marca: 'DIÁRIO' }).content).join(' | ');
  assert.ok(/RELATÓRIO DIÁRIO DA OPERAÇÃO/.test(tx) && /Resumo por dia/.test(tx));
  assert.ok(/2º dia da operação/.test(tx) && /3º dia da operação/.test(tx));
  assert.ok(/Varredura na margem com K9/.test(tx) && /Equipe Alfa/.test(tx) && /Chuva forte à tarde/.test(tx));
  assert.ok(/7,3 km|7,2 km/.test(tx) && /IPO do dia não preenchido/.test(tx));
  // mais detalhe: trilhas pessoa a pessoa (tempo e setores percorridos) e um bloco por setor
  assert.ok(/Trilhas do dia, por pessoa/.test(tx) && /Setores com a trilha/.test(tx) && /8 h/.test(tx), 'trilhas por pessoa com o tempo em campo');
  assert.ok(/Setor Margem/.test(tx) && /Equipes|Trilhas dentro do setor/.test(tx), 'bloco do setor');
  assert.ok(/Dados da ocorrência/.test(tx) && /RGO 20263BBM12221/.test(tx));
});

teste('graduação e QRA a partir do nome digitado', () => {
  assert.deepStrictEqual(RP.graduacaoQra('Cb. Souza'), { grad: 'Cb.', qra: 'Souza' });
  assert.deepStrictEqual(RP.graduacaoQra('1º Sgt Alves'), { grad: '1º Sgt', qra: 'Alves' });
  assert.deepStrictEqual(RP.graduacaoQra('Sd. QPM 1-0 Bartolomeu Cavalcanti'), { grad: 'Sd.', qra: 'Bartolomeu Cavalcanti' });
  assert.deepStrictEqual(RP.graduacaoQra('Maria Voluntária'), { grad: '—', qra: 'Maria Voluntária' });
});
teste('relatório IPO (curto): informe do dia + participantes do dia, trilhas e pontos', () => {
  const setor = { id: 'S1', nome: 'Setor Margem', forma: 'poligono', pontos: [[-22.90, -51.67], [-22.90, -51.65], [-22.89, -51.65], [-22.89, -51.67]], status: 'concluido', missoes: [] };
  const d = Object.assign({ gerado_em: new Date().toISOString(), gerado_por_nome: 'Sgt Um', vitimas: [], fotos: [], grupos: [] }, {
    operacao: Object.assign({}, op, { ipo: I.gravarDia(Object.assign({}, op.ipo, { desdobramentos: [], efetivo: [] }), { dia: '2026-11-04', texto: 'Varredura na margem com K9', qtd: 2, nomes: 'Equipe Alfa', situacao: 'Amanhã: setor 4' }) }),
    setores: [setor],
    participantes: [{ id: 'P1', nome: 'Cb. Alves', tipo: 'militar', entrou_em: local(2026, 11, 4, 8, 0), grupos: [] }, { id: 'P2', nome: 'Beto Voluntário', tipo: 'civil', entrou_em: local(2026, 11, 4, 9, 0), grupos: [] }],
    pontos: [{ criado_em: local(2026, 11, 4, 11, 0), categoria: 'VESTIGIO', titulo: 'Boné encontrado', lat: -22.895, lng: -51.66 }],
    diario: [{ id: 1, ocorrido_em: local(2026, 11, 4, 10, 0), categoria: 'setor', tipo: 'setor_concluido', titulo: 'Setor concluído', ref_id: 'S1', autor_nome: 'Sistema', origem: 'auto' }],
  });
  const trilhas = [{ participante_id: 'P1', nome: 'Cb. Alves', tipo: 'militar', dia: '2026-11-04', primeiro: local(2026, 11, 4, 8, 0), ultimo: local(2026, 11, 4, 12, 0), n: 20, km: 3.1, pontos: [[-22.895, -51.66], [-22.896, -51.661]] },
    { participante_id: 'P2', nome: 'Beto Voluntário', tipo: 'civil', dia: '2026-11-04', primeiro: local(2026, 11, 4, 9, 0), ultimo: local(2026, 11, 4, 11, 0), n: 10, km: 1, pontos: [[-22.894, -51.66], [-22.895, -51.662]] }];
  const dias = RP.separarDias(d, trilhas, RP.diasEntre('2026-11-04', '2026-11-04'));
  d.gerado_por_nome = 'Sgt. Quem Gerou';
  const tx = textos(RP.montarIpo(d, { mapasDia: { '2026-11-04': 'data:image/png;base64,AA' } }, { dias, subtitulo: '2º dia · 04/11/2026', titulo: 'IPO', marca: 'IPO' }).content).join(' | ');
  assert.ok(/Informe Padrão de Ocorrência/.test(tx) && /IPO do dia 04\/11\/2026/.test(tx) && /RGO 20263BBM12221/.test(tx), 'o informe no modelo');
  assert.ok(/Varredura na margem com K9/.test(tx) && /Amanhã: setor 4/.test(tx), 'o IPO do dia');
  // participantes do dia (1.13.4): todo mundo, militar e civil, com o nome e a hora em que entrou no dia, por ordem de entrada
  assert.ok(/Participantes do dia \(2\)/.test(tx) && !/Militares do dia/.test(tx), 'tabela de participantes no lugar da de militares');
  assert.ok(tx.indexOf('Cb. Alves') !== -1 && tx.indexOf('Beto Voluntário') > tx.indexOf('Cb. Alves'), 'todos, em ordem de entrada (08:00 antes de 09:00)');
  assert.ok(/08:00/.test(tx) && /09:00/.test(tx), 'a hora em que cada um entrou no dia');
  assert.ok(!/Setores varridos/.test(tx), 'não existe mais "Setores varridos" (o que foi varrido é visto pelas trilhas)');
  assert.ok(/Mapa do dia/.test(tx) && !/Setores marcados no mapa/.test(tx), 'mapa do dia sem a lista de setores (o que foi feito está nas trilhas)');
  assert.ok(/Ponto e descrição/.test(tx) && /Coordenada/.test(tx), 'pontos com a descrição e a coordenada');
  assert.ok(/Responsável pelas informações/.test(tx) && /Sgt\. Quem Gerou/.test(tx) && !/Cb\. Alves\/GBS/.test(tx), 'responsável = quem gerou o relatório');
  assert.ok(/Trilhas feitas/.test(tx) && /Terreno percorrido/.test(tx) && !/4,1 km/.test(tx) && /Pessoas com trilha/.test(tx), 'trilhas feitas: terreno (não a soma 3,1 + 1 das pessoas)');
  assert.ok(/Pontos de interesse do dia/.test(tx) && /Boné encontrado/.test(tx), 'pontos do dia');
  assert.ok(!/Diário do dia|Encontros e relatos/.test(tx), 'curto: sem o diário completo');
});

teste('IPO e Diário: sem trilha, sem setor e sem ponto no dia, essas seções (e o mapa) não aparecem', () => {
  const d = { gerado_em: new Date().toISOString(), gerado_por_nome: 'Sgt. Quem Gerou', operacao: Object.assign({}, op, { ipo: Object.assign({}, op.ipo, { desdobramentos: [], efetivo: [] }) }),
    setores: [{ id: 'S1', nome: 'Setor Parado', forma: 'poligono', pontos: [[-22.90, -51.67], [-22.90, -51.65], [-22.89, -51.65]], status: 'pendente', missoes: [] }],
    participantes: [{ id: 'P1', nome: 'Cb. Alves', tipo: 'militar', entrou_em: local(2026, 11, 9, 8, 0), grupos: [] }], pontos: [], fotos: [], vitimas: [], grupos: [], diario: [] };
  // só pontos dentro da base ou apagados com a borracha: a pessoa tem registro no dia, mas nenhuma linha desenhada
  const semLinha = [{ participante_id: 'P1', nome: 'Cb. Alves', tipo: 'militar', dia: '2026-11-09', primeiro: local(2026, 11, 9, 8, 0), ultimo: local(2026, 11, 9, 9, 0), n: 5, km: 0, pontos: [] }];
  const dias = RP.separarDias(d, semLinha, RP.diasEntre('2026-11-09', '2026-11-09'));
  assert.strictEqual(dias[0].trilhas.length, 0);
  const ipoTx = textos(RP.montarIpo(d, {}, { dias, subtitulo: 'x', titulo: 'IPO', marca: 'IPO' }).content).join(' | ');
  assert.ok(!/Trilhas feitas|Setores varridos|Mapa do dia|Pontos de interesse/.test(ipoTx), 'IPO sem nada do dia: sem essas seções');
  const diaTx = textos(RP.montarDiarioDias(d, {}, { dias, subtitulo: 'x', titulo: 'D', marca: 'D' }).content).join(' | ');
  assert.ok(!/Trilhas do dia, por pessoa|Setores marcados no dia|Nenhum setor|Ninguém com posição/.test(diaTx), 'Diário sem nada do dia: sem seções vazias nem avisos de "nenhum"');
});

teste('o IPO traz TODOS os campos do modelo; o que não foi preenchido sai como "Não apurado"', () => {
  const vazio = { codigo: 'OP', status: 'ativa', ipo: {} };
  const t = I.textoWhatsApp(vazio, { vitimas: [], diario: [] });
  const campos = ['Localidade/Município/Região', 'Data/hora do início das operações', 'Coord. Geo. de Referência (último avistamento)', 'Nº de pessoas perdidas',
    'Sexo/Idade da(s) vítima(s)', 'Nome da vítima', 'Origem da(s) vítima(s)', 'Data/Horário provável do desaparecimento', 'Data/Horário do acionamento do CB',
    'Buscas preliminares realizadas em casas de parentes, hospitais, etc.?', 'Possibilidade real de vida?', 'Procedimentos de Busca sendo realizados',
    'Contexto/histórico/cenário do desaparecimento', 'Recursos CB deslocados e sendo utilizados', 'Quantidade de BMs diretamente envolvidos na resposta',
    'Desdobramentos/situação atual', 'Órgãos de Apoio', 'Imagens anexas junto a esta mensagem?', 'Responsável pelas informações'];
  campos.forEach((c) => assert.ok(t.includes('*' + c), 'falta o campo: ' + c));
  ['Unidade: Não apurado', 'RGO: Não apurado', 'Natureza: Não apurado'].forEach((c) => assert.ok(t.includes(c), 'falta ' + c));
  // campos de texto vazios: "Não apurado"
  ['*Localidade/Município/Região:* Não apurado', '*Nome da vítima:* Não apurado', '*Procedimentos de Busca sendo realizados:* Não apurado', '*Recursos CB deslocados e sendo utilizados:* Não apurado',
    '*Quantidade de BMs diretamente envolvidos na resposta:* Não apurado', '*Desdobramentos/situação atual:* Não apurado', '*Órgãos de Apoio:* Não apurado'].forEach((c) => assert.ok(t.includes(c), 'sem "Não apurado" em: ' + c));
  // natureza aquática: o meio líquido também aparece (Não apurado se faltar); terrestre pura: não se aplica
  assert.ok(I.textoWhatsApp({ ipo: { natureza: 'BUSCA AQUÁTICA – PESSOA' } }, {}).includes('*Tipo de meio líquido:* Não apurado'));
  assert.ok(!I.textoWhatsApp({ ipo: { natureza: 'BUSCA TERRESTRE – PESSOA' } }, {}).includes('Tipo de meio líquido'));
  // IPO de um dia (relatório): mesmos campos
  const dia = I.textoWhatsApp(vazio, { dia: '2026-11-04', responsavel: 'Sgt. X' });
  campos.forEach((c) => assert.ok(dia.includes('*' + c), 'IPO do dia sem o campo: ' + c));
  assert.ok(dia.includes('*Responsável pelas informações:* Sgt. X'));
  // dados gerais do Diário continuam sem o vazio
  assert.ok(!I.itens(vazio, { geral: true }).some((x) => x.valor === 'Não apurado'));
});
teste('relatório IPO (PDF): todos os campos do modelo, com "Não apurado"', () => {
  const d = { gerado_em: new Date().toISOString(), gerado_por_nome: '', operacao: { codigo: 'OP', status: 'ativa', ipo: {} }, setores: [], participantes: [], pontos: [], fotos: [], vitimas: [], grupos: [], diario: [] };
  const dias = RP.separarDias(d, [], RP.diasEntre('2026-11-04', '2026-11-04'));
  const tx = textos(RP.montarIpo(d, {}, { dias, subtitulo: 'x', titulo: 'IPO', marca: 'IPO' }).content).join(' | ');
  ['Localidade/Município/Região', 'Nome da vítima', 'Procedimentos de Busca sendo realizados', 'Recursos CB deslocados e sendo utilizados', 'Quantidade de BMs diretamente envolvidos na resposta',
    'Desdobramentos/situação atual', 'Órgãos de Apoio', 'Imagens anexas junto a esta mensagem?', 'Responsável pelas informações'].forEach((c) => assert.ok(tx.includes(c), 'PDF sem o campo: ' + c));
  assert.ok((tx.match(/Não apurado/g) || []).length >= 10, 'vários "Não apurado"');
});

teste('IPO acumulado até o dia (modelo do CBMPR): efetivo e desdobramentos trazem todos os dias até ali', () => {
  const op2 = Object.assign({}, op, { ipo: Object.assign({}, op.ipo, { dias: [{ dia: '2026-11-03', procedimentos: ['aeronave'], recursos: 'Drone M30', orgaos: 'Defesa Civil de Guaraci', situacao: 'Seguir pela margem direita' }, { dia: '2026-11-05', procedimentos: ['scuba'], recursos: 'Moto-bomba', orgaos: 'Guarda Municipal', situacao: 'Suspender' }] }) });
  const ate3 = I.textoWhatsApp(op2, { vitimas, diario: [], ate: '2026-11-03' });
  assert.ok(ate3.includes('*IPO do dia 03/11/2026 (acumulado)*'));
  assert.ok(ate3.includes('02/11/2026: 02 BBMM - CB. Rolândia.') && ate3.includes('03/11/2026: 03 BBMM'), 'efetivo dos dias 2 e 3');
  assert.ok(ate3.includes('02/11/2026: 02 BBMM para primeira resposta.') && ate3.includes('03/11/2026: Sgt. Berzotti'), 'desdobramentos dos dias 2 e 3');
  assert.ok(ate3.includes('Busca com aeronave') && ate3.includes('Defesa Civil de Guaraci') && ate3.includes('Drone M30'), 'o que foi usado até o dia 3');
  assert.ok(!ate3.includes('Mergulho com equipamento SCUBA') && !ate3.includes('Guarda Municipal') && !ate3.includes('Moto-bomba'), 'nada do dia 5 antes do dia 5');
  assert.ok(ate3.includes('Seguir pela margem direita') && !ate3.includes('Suspender'), 'a situação é a do próprio dia');
  const ate2 = I.textoWhatsApp(op2, { vitimas, diario: [], ate: '2026-11-02' });
  assert.ok(ate2.includes('02/11/2026: 02 BBMM - CB. Rolândia.') && !ate2.includes('03/11/2026: 03 BBMM') && !ate2.includes('03/11/2026: Sgt. Berzotti'), 'até o dia 2: só o dia 2');
  const ate5 = I.textoWhatsApp(op2, { vitimas, diario: [], ate: '2026-11-05' });
  assert.ok(ate5.includes('Mergulho com equipamento SCUBA') && ate5.includes('Guarda Municipal') && ate5.includes('Suspender') && ate5.includes('03/11/2026: 03 BBMM'));
});

teste('natureza: sem a do IPO, vem do tipo da operação', () => {
  assert.ok(I.textoWhatsApp({ tipo: 'terrestre', ipo: {} }, {}).includes('*Natureza: BUSCA TERRESTRE – PESSOA*'));
  assert.ok(I.textoWhatsApp({ tipo: 'aquatica', ipo: {} }, {}).includes('*Natureza: BUSCA AQUÁTICA – PESSOA*') && I.textoWhatsApp({ tipo: 'aquatica', ipo: {} }, {}).includes('Tipo de meio líquido'));
  assert.ok(I.textoWhatsApp({ tipo: 'outras', tipo_outro: 'Resgate em altura', ipo: {} }, {}).includes('*Natureza: Resgate em altura*'));
  assert.ok(I.textoWhatsApp({ tipo: 'terrestre', ipo: { natureza: 'SARP – AERONAVE REMOTAMENTE PILOTADA' } }, {}).includes('*Natureza: SARP'), 'a do IPO vence');
  assert.ok(I.textoWhatsApp({ ipo: {} }, {}).includes('Natureza: Não apurado'));
});

teste('IPO preenchido direto (sem ficha de vítima): nome, sexo, idade, origem, documento, contexto e início', () => {
  const o = { codigo: 'OP', acionado_em: local(2026, 11, 2, 17, 20), descricao: 'Contexto do cadastro', ipo: I.normalizarIpo({ natureza: 'BUSCA TERRESTRE – PESSOA', vitima_nome: 'Gustavo Teixeira', vitima_sexo: 'M', vitima_idade: '19', vitima_origem: 'Cornélio Procópio', vitima_doc: '129.590.679-16', contexto: 'Contexto do IPO', inicio_operacoes: local(2026, 11, 2, 18, 0) }) };
  const t = I.textoWhatsApp(o, { vitimas: [], diario: [] });
  assert.ok(t.includes('*Nº de pessoas perdidas:* 01') && t.includes('*Sexo/Idade da(s) vítima(s):* 01 Masculino / 19 anos') && t.includes('*Nome da vítima:* Gustavo Teixeira/129.590.679-16') && t.includes('*Origem da(s) vítima(s):* Cornélio Procópio'));
  assert.ok(t.includes('*Contexto/histórico/cenário do desaparecimento:* Contexto do IPO') && !t.includes('Contexto do cadastro'), 'o contexto do IPO vence o do cadastro');
  assert.ok(t.includes('18h00min'), 'o início digitado no IPO vence o do cadastro');
  // com ficha de vítima, vale a ficha
  const comFicha = I.textoWhatsApp(o, { vitimas: [{ id: 'v1', nome: 'Da Ficha', sexo: 'F', idade: 30 }], diario: [] });
  assert.ok(comFicha.includes('Da Ficha') && !comFicha.includes('Gustavo Teixeira'));
  // sem nada digitado: o contexto e o início vêm do cadastro
  const so = I.textoWhatsApp({ codigo: 'OP', acionado_em: local(2026, 11, 2, 17, 20), descricao: 'Contexto do cadastro', ipo: {} }, {});
  assert.ok(so.includes('Contexto do cadastro') && so.includes('17h20min'));
  // limites
  const n = I.normalizarIpo({ vitima_sexo: 'X', vitima_idade: 500, vitima_nome: 'a'.repeat(900) });
  assert.strictEqual(n.vitima_sexo, ''); assert.strictEqual(n.vitima_idade, 120); assert.strictEqual(n.vitima_nome.length, 300);
});

teste('relatórios: a trilha vem em trechos (não liga os lados de uma falha) e sem ponto solto', () => {
  const d = { gerado_em: new Date().toISOString(), operacao: { codigo: 'OP', ipo: {} }, setores: [], participantes: [], pontos: [], fotos: [], vitimas: [], grupos: [], diario: [] };
  const t = [{ participante_id: 'P1', nome: 'A', tipo: 'militar', dia: '2026-11-15', n: 9, km: 1,
    pontos: [[-25.5, -49.3], [-25.501, -49.3], [-25.6, -49.3], [-25.601, -49.3]],
    segmentos: [[[-25.5, -49.3], [-25.501, -49.3], [-25.502, -49.3]], [[-25.6, -49.3], [-25.601, -49.3]], [[-25.7, -49.3]]] }];
  const x = RP.separarDias(d, t, ['2026-11-15'])[0];
  assert.strictEqual(x.trilhas[0].segmentos.length, 2, 'dois trechos (o de um ponto só não é linha)');
  assert.ok(!x.trilhas[0].segmentos.some((sg) => sg.some((p, i) => i && Math.abs(p[0] - sg[i - 1][0]) > 0.05)), 'nenhum trecho liga lugares distantes');
  const semTrechos = RP.separarDias(d, [Object.assign({}, t[0], { segmentos: undefined })], ['2026-11-15'])[0];
  assert.strictEqual(semTrechos.trilhas[0].segmentos.length, 1, 'banco antigo (sem trechos): um trecho só, como antes');
});

if (falhas) { console.log('\n' + falhas + ' falha(s)'); process.exit(1); }
console.log('\nTodos os testes do IPO e do relatório resumido passaram.');
