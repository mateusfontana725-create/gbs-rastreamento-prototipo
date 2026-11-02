// Relatório para imprensa: o documento não pode trazer nomes, documentos, fotos, trilhas, posições nem observações.
// Os dados de exemplo são cheios desses itens; o teste confere que nada deles aparece no PDF.
const RP = require('../public/js/relatorio-pdf.js');
const assert = require('assert');
const d = {
  gerado_em: new Date().toISOString(), gerado_por_nome: 'Cap. Souza',
  operacao: { codigo: 'OP-2026-014', acionado_em: '2026-10-28T14:00:00Z', encerrada_em: null, resultado: 'localizada_viva', resultado_texto: 'Localizada na trilha norte, Maria Segredo, CPF 123.456.789-00' },
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
};
const doc = RP.montarImprensa(d, { logo: null });
const json = JSON.stringify(doc);
const proibidos = ['Joao', 'Silva', 'Maria', 'Segredo', 'CPF', '123.456', '99999', 'Carlos', 'Resp', 'obs secreta', 'Pedro', 'Ana Civil', 'texto privado', 'Trilha Joao', 'foto.jpg', 'vitima', 'Cap. Souza', 'entrou', 'secreto'];
const vazou = proibidos.filter(t => json.includes(t));
console.log('vazamentos:', JSON.stringify(vazou));
assert.deepStrictEqual(vazou, []);
assert.ok(json.includes('Setor A iniciado'), 'marco automático de setor aparece');
assert.ok(json.includes('Operação acionada'), 'marco automático da operação aparece');
assert.ok(!json.includes('Observação do Joao'), 'observação manual fica de fora');
assert.ok(!json.includes('Pedro Civil entrou'), 'registro de pessoas fica de fora');
assert.ok(json.includes('DIVULGAÇÃO'), 'cabeçalho de divulgação');
assert.ok(!json.includes('DOCUMENTO RESTRITO'), 'sem a marca de documento restrito');
assert.ok(json.includes('Vítima localizada com vida'), 'desfecho geral');
console.log('  OK  imprensa: sem nomes, documentos, fotos, trilhas nem observações; marcos automáticos presentes');
