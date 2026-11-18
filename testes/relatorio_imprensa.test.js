// Relatório para imprensa: o documento não pode trazer nomes, documentos, fotos, trilhas, posições nem observações.
// Os dados de exemplo são cheios desses itens; o teste confere que nada deles aparece no PDF.
globalThis.window = globalThis;
require('../public/js/ipo.js');
const RP = require('../public/js/relatorio-pdf.js');
const assert = require('assert');
const d = {
  gerado_em: new Date().toISOString(), gerado_por_nome: 'Cap. Souza',
  operacao: { ipo: { natureza: 'BUSCA TERRESTRE – PESSOA', localidade: 'Guaraci - Fazenda União, Rio Rondon', procedimentos: ['k9', 'drone'], recursos_cb: 'ABS BM 13629 3ºBBM - Rolândia.\nABRESC BM 004 - Canil Setorial', dias: [{ dia: '2026-10-29', procedimentos: ['aeronave'], recursos: 'Drone M30 - SARP', orgaos: 'Guarda Municipal: Sd. Zé Silva', situacao: 'nota interna' }],
    imprensa_como: 'Um homem de 70 anos saiu para uma caminhada e não voltou.', imprensa_estrategia: 'Varredura em setores, com cães e drone.',
    orgaos_apoio: 'PMPR: 02 PMs - Cb. Jairo\nPolícia Civil: Agentes Elton Cesar Belido\nHelicóptero BPMOA.\nVoluntários da comunidade com o Sr. Fulano de Tal e família toda', desdobramentos: [{ dia: '2026-10-28', texto: 'Sgt. Berzotti com a K9 Eva' }] },
    codigo: 'OP-2026-014', acionado_em: '2026-10-28T14:00:00Z', encerrada_em: null, resultado: 'localizada_viva', resultado_texto: 'Localizada na trilha norte, Maria Segredo, CPF 123.456.789-00' },
  participantes: [{ nome: 'Joao Silva', cpf: '123.456.789-00', telefone: '(41) 99999-0000', tipo: 'militar' }, { nome: 'Ana Civil', tipo: 'civil', removido: true }, { nome: 'Pedro Civil', tipo: 'civil' }],
  setores: [{ nome: 'Setor A', status: 'concluido', responsavel_nome: 'Carlos Resp', observacoes: 'obs secreta' }, { nome: 'Setor B', status: 'em_andamento' }],
  vitimas: [{ nome: 'Maria Segredo', idade: 70, caracteristicas: 'marca', foto_caminho: 'x.jpg' }],
  fotos: [{ caminho: 'foto.jpg', lat: -25.4, lng: -49.2, legenda: 'vitima' }],
  trilhas: [{ nome: 'Trilha Joao', pontos: [[-25.4, -49.2]] }],
  diario: [
    { ocorrido_em: '2026-10-28T14:05:00Z', origem: 'automatico', categoria: 'operacao', titulo: 'Operação acionada', detalhe: 'Joao Silva registrou', autor_nome: 'Joao Silva' },
    { ocorrido_em: '2026-10-28T15:00:00Z', origem: 'automatico', categoria: 'setor', titulo: 'Setor A iniciado', detalhe: 'por Carlos Resp' },
    { ocorrido_em: '2026-10-28T16:00:00Z', origem: 'manual', categoria: 'observacao', titulo: 'Observação do Joao', detalhe: 'texto privado' },
    { ocorrido_em: '2026-10-28T17:00:00Z', origem: 'automatico', categoria: 'pessoa', titulo: 'Pedro Civil entrou', detalhe: '' },
  ],
  busca: { secreto: true },
  participantes_grupos: [],
  grupos: [{ nome: 'Alfa' }, { nome: 'Bravo' }],
};
const doc = RP.montarImprensa(d, { logo: null });
const json = JSON.stringify(doc);
const proibidos = ['Joao', 'Silva', 'Maria', 'Segredo', 'CPF', '123.456', '99999', 'Carlos', 'Resp', 'obs secreta', 'Pedro', 'Ana Civil', 'texto privado', 'Trilha Joao', 'foto.jpg', 'vitima', 'Cap. Souza', 'entrou', 'secreto'];
const vazou = proibidos.filter(t => json.includes(t));
console.log('vazamentos:', JSON.stringify(vazou));
assert.deepStrictEqual(vazou, []);
assert.ok(!json.includes('Linha do tempo') && !json.includes('Setor A iniciado') && !json.includes('Operação acionada'), 'sem linha do tempo');
assert.ok(!json.includes('Observação do Joao'), 'observação manual fica de fora');
assert.ok(!json.includes('Pedro Civil entrou'), 'registro de pessoas fica de fora');
assert.ok(json.includes('DIVULGAÇÃO'), 'cabeçalho de divulgação');
assert.ok(!json.includes('DOCUMENTO RESTRITO'), 'sem a marca de documento restrito');
assert.ok(json.includes('Vítima localizada com vida'), 'desfecho geral');
// resumo em texto: tipo, datas, quantas pessoas e equipes, setores (sem nomes)
assert.ok(json.includes('Resumo'), 'seção de resumo');
assert.ok(json.includes('Corpo de Bombeiros: 1 militar') && json.includes('em 2 equipes') && json.includes('Voluntários e civis: 1'), 'forças contam militares, voluntários e equipes (sem a removida)');
assert.ok(json.includes('dividido em 2 setores, 1 concluído'), 'buscas contam setores e concluídos');
// informações novas: natureza, cidade, a pessoa sem o nome, meios e órgãos (só o nome do órgão)
assert.ok(json.includes('BUSCA TERRESTRE – PESSOA') && json.includes('em Guaraci'), 'natureza e cidade (sem a fazenda)');
assert.ok(!json.includes('Fazenda União'), 'só a cidade, não o endereço');
assert.ok(json.includes('Procura por uma pessoa de 70 anos'), 'a pessoa procurada sem o nome');
assert.ok(json.includes('Buscas com emprego de K9') && json.includes('Buscas aéreas com drone'), 'meios empregados');
assert.ok(json.includes('PMPR') && json.includes('Polícia Civil') && json.includes('Helicóptero BPMOA'), 'órgãos de apoio');
// seções novas: como aconteceu, buscas, estratégia, forças e recursos
['Como aconteceu', 'Buscas realizadas', 'Meios empregados nas buscas', 'Estratégia e próximos passos', 'Forças envolvidas', 'Recursos empregados'].forEach((t) => assert.ok(json.includes(t), 'seção: ' + t));
assert.ok(json.includes('Um homem de 70 anos saiu para uma caminhada') && json.includes('Varredura em setores, com cães e drone'), 'textos escritos pelo comando para a imprensa');
assert.ok(json.includes('Guarda Municipal') && json.includes('Corpo de Bombeiros: 1 militar'), 'forças: Bombeiros e órgãos (inclusive os de um dia)');
assert.ok(json.includes('Busca com aeronave'), 'meios de um dia entram');
assert.ok(json.includes('ABS BM 13629 3ºBBM - Rolândia') && json.includes('Drone M30 - SARP') && json.includes('ABRESC BM 004'), 'recursos empregados (do IPO e dos dias)');
assert.ok(!json.includes('Zé Silva') && !json.includes('nota interna'), 'nome de agente e situação interna do dia não vazam');
['Jairo', 'Elton', 'Belido', 'Fulano', 'Berzotti', 'Eva'].forEach((n) => assert.ok(!json.includes(n), 'nome de agente ou de militar não vaza: ' + n));
assert.ok(json.includes('dias de buscas') || json.includes('dia de buscas'), 'dias de buscas');
// sem texto do comando: texto padrão com os dados da operação
const sem = JSON.stringify(RP.montarImprensa(Object.assign({}, d, { operacao: Object.assign({}, d.operacao, { ipo: Object.assign({}, d.operacao.ipo, { imprensa_como: '', imprensa_estrategia: '' }) }) }), {}));
assert.ok(sem.includes('O Corpo de Bombeiros foi acionado em') && sem.includes('As equipes trabalham em setores') || sem.includes('As buscas foram encerradas'), 'texto padrão quando o comando não escreveu');
console.log('  OK  imprensa: sem nomes, documentos, fotos, trilhas nem observações; sem linha do tempo; com buscas, estratégia, forças e recursos');
