// Painel de comando SCI (public/js/sci-core.js): totais, alertas, textos e leitura das frases do comandante.
// Frases e números do Simulado Integrado El Niño (Usina Três Bocas, Londrina/PR). Não usa rede nem tela.
process.env.TZ = 'America/Sao_Paulo';   // horas faladas são do relógio de quem está no PC
const S = require('../public/js/sci-core.js');
const assert = require('assert');
let falhas = 0;
function teste(nome, fn) { try { fn(); console.log('  OK  ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + ': ' + e.message); } }
const AGORA = new Date('2026-10-29T10:30:00-03:00').getTime();
const em = (h) => new Date('2026-10-29T' + h + ':00-03:00').toISOString();
const ler = (f, d) => S.interpretar(f, d || { vitimas: [], estado: { marcos: {}, funcoes: {} }, itens: [] }, AGORA).acoes;

console.log('SCI: coordenadas e totais');
teste('coordenadas em graus, minutos e segundos (como no PC)', () => {
  assert.strictEqual(S.dms(-23.3844, -51.0761), 'S 23°23\'04" W 51°04\'34"');
  assert.strictEqual(S.dms(null, null), '[PENDENTE]');
  assert.ok(S.links(-23.3844, -51.0761).rota.includes('destination=-23.3844,-51.0761'));
});
teste('total não informado fica [PENDENTE] (nunca zero) e "ainda não localizadas" também', () => {
  const t = S.totais([{ numero: 1, fase: 'localizada' }], {});
  assert.strictEqual(t.informado, null); assert.strictEqual(t.naoLocalizadas, null); assert.strictEqual(t.localizadas, 1);
});
teste('Três Bocas no fim: 14 transportadas (11 verdes, 3 amarelas), sem óbitos', () => {
  const v = [];
  for (let i = 1; i <= 14; i++) v.push({ numero: i, fase: 'transportada', triagem: i <= 3 ? 'amarelo' : 'verde' });
  const t = S.totais(v, { total_vitimas: 14, total_confirmado: true });
  assert.deepStrictEqual([t.localizadas, t.naoLocalizadas, t.removidas, t.transportadas, t.obitos], [14, 0, 14, 14, 0]);
  assert.strictEqual(t.porFase.transportada.verde, 11); assert.strictEqual(t.porFase.transportada.amarelo, 3);
  assert.strictEqual(t.divergencia, null);
});
teste('cor só depois da ACV: localizada com triagem conta como "sem cor"', () => {
  const t = S.totais([{ numero: 1, fase: 'localizada', triagem: 'amarelo' }], {});
  assert.strictEqual(t.porFase.localizada.sem, 1); assert.strictEqual(t.porFase.localizada.amarelo, 0);
});
teste('soma que não fecha é divergência', () => {
  assert.ok(/total informado é 2/.test(S.totais([{ fase: 'localizada' }, { fase: 'localizada' }, { fase: 'removida' }], { total_vitimas: 2 }).divergencia));
});
teste('órgãos: sem efetivo informado não vira zero', () => {
  const it = [{ tipo: 'orgao', dados: { nome: 'CBMPR', situacao: 'no_local', pessoas: 15 } }, { tipo: 'orgao', dados: { nome: 'Radiocomunicadores', situacao: 'no_local' } },
    { tipo: 'orgao', dados: { nome: 'Copel', situacao: 'acionado', pessoas: 0 } }];
  const t = S.totaisOrgaos(it);
  assert.deepStrictEqual([t.orgaos, t.noLocal, t.pessoas, t.semEfetivo], [3, 2, 15, 1]);
});

console.log('SCI: alertas do comando');
const base = () => ({ op: { tipo: 'aquatica' }, estado: { marcos: { chegada: em('07:47') }, funcoes: { ci: { nome: 'Asp Of BM Gaffo' } } }, vitimas: [], eventos: [], itens: [] });
teste('segurança primeiro: sem Oficial de Segurança com equipe em operação é crítico e vem antes', () => {
  const d = base(); d.itens.push({ tipo: 'equipe', dados: { nome: 'Bote', status: 'em_operacao', chefe: 'Sgt Gustavo' } });
  const a = S.alertas(d, AGORA);
  assert.strictEqual(a[0].nivel, 'critico'); assert.ok(/Sem Oficial de Segurança/.test(a[0].texto));
});
teste('vítima vermelha em cena, rio subindo e sem leitura recente', () => {
  const d = base(); d.estado.funcoes.seguranca = { nome: 'Sgt Dinardi' };
  d.vitimas.push({ numero: 3, fase: 'removida', triagem: 'vermelho' });
  d.itens.push({ tipo: 'leitura_rio', dados: { em: em('09:50'), ponto: 'transposição', tendencia: 'subindo' } });
  const t = S.alertas(d, AGORA).map((x) => x.texto).join(' | ');
  assert.ok(/V-03 VERMELHA na ACV/.test(t), t); assert.ok(/Rio SUBINDO/.test(t), t); assert.ok(/Última leitura de nível há 40 min/.test(t), t);
});
teste('total não confirmado, ACV sem triagem, informações aguardando confirmação e pendências', () => {
  const d = base(); d.estado.total_vitimas = 14;
  d.vitimas.push({ numero: 1, fase: 'removida' });
  d.eventos.push({ nao_confirmada: true }, { nao_confirmada: true, anulado_em: em('09:00') });
  d.itens.push({ tipo: 'orgao', dados: { nome: 'SAMU', situacao: 'no_local' } }, { tipo: 'instalacao', dados: { tipo: 'area_espera', nome: 'Área de Espera' } });
  const t = S.alertas(d, AGORA).map((x) => x.texto).join(' | ');
  ['Total de 14 vítimas NÃO CONFIRMADO', 'V-01 na ACV sem triagem', '1 informação(ões) no registro aguardando confirmação', 'SAMU no local sem efetivo informado',
    'Área de Espera: responsável [PENDENTE]', 'ACV (Área de Concentração de Vítimas) não registrada', 'Horário de "Despacho da equipe" [PENDENTE]', 'Chefe de Operações: [PENDENTE]']
    .forEach((x) => assert.ok(t.includes(x), x + ' → ' + t));
});
teste('antes da ocorrência (nada em cena): sem cobranças', () => {
  const d = base(); d.estado.marcos = {};
  assert.deepStrictEqual(S.alertas(d, AGORA), []);
});

console.log('SCI: textos');
teste('resumo para WhatsApp só com o que foi registrado', () => {
  const d = base(); d.op = { codigo: 'Simulado Três Bocas', local_endereco: 'Usina Três Bocas, Londrina/PR', local_lat: -23.3844, local_lng: -51.0761, acionado_em: em('07:19') };
  d.estado.total_vitimas = 14; d.vitimas = [{ numero: 1, fase: 'transportada', triagem: 'amarelo' }];
  const r = S.resumo(d, AGORA);
  assert.ok(r.includes('*Simulado Três Bocas*') && r.includes('S 23°23\'04" W 51°04\'34"') && r.includes('decorrido 3h11'), r);
  assert.ok(r.includes('Vítimas: 14 (NÃO CONFIRMADO) total · 1 localizadas') && r.includes('Segurança: [PENDENTE]'), r);
});
teste('texto para a imprensa sem dados pessoais', () => {
  const d = base(); d.vitimas = [{ numero: 1, nome: 'Fulana de Tal', fase: 'transportada', triagem: 'amarelo' }];
  const t = S.imprensa(d, AGORA);
  assert.ok(!t.includes('Fulana') && t.includes('1 pessoa(s) foram localizadas') && t.includes('sem registro de óbitos'), t);
});

console.log('SCI: frases do comandante');
teste('marcos com a hora falada ("despacho 7h15", "PC estabelecido", "operação finalizada às 10h00")', () => {
  const a = ler('despacho 7h15');
  assert.strictEqual(a[0].acao, 'marco'); assert.strictEqual(a[0].marco, 'despacho'); assert.strictEqual(a[0].em, em('07:15'));
  assert.strictEqual(ler('PC estabelecido')[0].marco, 'pc'); assert.strictEqual(ler('PC estabelecido')[0].em, null);
  assert.strictEqual(ler('operação finalizada às 10h00')[0].marco, 'termino');
});
teste('hora mais tarde que agora é da véspera', () => { assert.ok(S.horaDoTexto('23h50', AGORA).startsWith('2026-10-29T02:50') || S.horaDoTexto('23h50', AGORA) < new Date(AGORA).toISOString()); });
teste('"duas vítimas localizadas na água" → duas vítimas novas, com acento preservado', () => {
  const a = ler('duas vítimas localizadas na água');
  assert.strictEqual(a.length, 2); assert.ok(a.every((x) => x.acao === 'vitima_nova' && x.local === 'na água'));
});
teste('"V-03 na ACV, amarela" move e tria; "V-01 amarela, feminino"', () => {
  const d = { vitimas: [{ numero: 1, fase: 'removida' }, { numero: 3, fase: 'localizada' }], estado: {}, itens: [] };
  const a = ler('V-03 na ACV, amarela', d)[0];
  assert.deepStrictEqual([a.acao, a.numero, a.fase, a.triagem], ['vitima', 3, 'removida', 'amarelo']);
  const b = ler('V-01 amarela, feminino', d)[0];
  assert.deepStrictEqual([b.triagem, b.sexo], ['amarelo', 'F']);
});
teste('"V-01 e V-02 transportadas ao hospital pelo SAMU": as duas, destino Hospital', () => {
  const a = ler('V-01 e V-02 transportadas ao hospital pelo SAMU', { vitimas: [{ numero: 1, fase: 'removida' }, { numero: 2, fase: 'removida' }], estado: {}, itens: [] });
  assert.strictEqual(a.length, 2); assert.ok(a.every((x) => x.fase === 'transportada' && x.destino === 'Hospital'));
});
teste('órgão no local com efetivo; acionado', () => {
  const a = ler('SAMU no local com 5 pessoas')[0];
  assert.deepStrictEqual([a.acao, a.nome, a.situacao, a.pessoas], ['orgao', 'SAMU', 'no_local', 5]);
  assert.strictEqual(ler('Copel acionada para a rede elétrica')[0].situacao, 'acionado');
  assert.strictEqual(ler('PM no local')[0].nome, 'Polícia Militar');
});
teste('funções: "Segurança: Sgt Dinardi" e "Sgt Gustavo assume operações"', () => {
  const a = ler('Segurança: Sgt Dinardi')[0]; assert.deepStrictEqual([a.funcao, a.nome], ['seguranca', 'Sgt Dinardi']);
  const b = ler('Sgt Gustavo assume operações')[0]; assert.deepStrictEqual([b.funcao, b.nome], ['operacoes', 'Sgt Gustavo']);
});
teste('total: não confirmado por padrão; "confirma" confirma', () => {
  assert.strictEqual(ler('total de vítimas 14')[0].confirmado, false);
  const a = ler('Defesa Civil confirma: não há mais vítimas ilhadas. Total de vítimas: 14').filter((x) => x.acao === 'total')[0];
  assert.deepStrictEqual([a.total, a.confirmado], [14, true]);
});
teste('informação de terceiros vira registro NÃO CONFIRMADA (e não muda o efetivo do órgão)', () => {
  const a = ler('segundo a Defesa Civil há 40 pessoas desabrigadas');
  assert.strictEqual(a.length, 1); assert.strictEqual(a[0].acao, 'evento'); assert.strictEqual(a[0].nao_confirmada, true);
});
teste('nível do rio pelo drone', () => {
  const a = ler('rio estável segundo o drone');
  assert.strictEqual(a.length, 1); assert.deepStrictEqual([a[0].acao, a[0].tendencia, a[0].fonte], ['leitura_rio', 'estavel', 'Drone']);
});
teste('frase sem registro específico vai para a linha do tempo com a categoria provável', () => {
  const a = ler('Embarcação removendo os primeiros ilhados');
  assert.deepStrictEqual([a[0].acao, a[0].categoria], ['evento', 'resgate']);
  assert.strictEqual(ler('Ilhados sendo removidos pela embarcação, todos com colete')[0].categoria, 'seguranca');
});
teste('divergências apontadas antes de gravar', () => {
  const d = { vitimas: [{ numero: 1, fase: 'localizada', triagem: null }], estado: { total_vitimas: 1, marcos: { despacho: em('07:15') }, funcoes: { seguranca: { nome: 'Sgt Dinardi' } } }, itens: [] };
  const acoes = S.normalizarAcoes([{ acao: 'vitima', numero: 1, triagem: 'amarelo' }, { acao: 'vitima_nova' }, { acao: 'marco', marco: 'despacho', em: em('07:20') }, { acao: 'funcao', funcao: 'seguranca', nome: 'Sgt Pereira' }], d);
  const t = S.divergencias(acoes, d).join(' | ');
  ['ainda não foi removida para a ACV', 'já tinha horário', 'era Sgt Dinardi', 'acima do total informado (1)'].forEach((x) => assert.ok(t.includes(x), x + ' → ' + t));
});
teste('normalização recusa ação desconhecida e campos inválidos (respostas da IA)', () => {
  const a = S.normalizarAcoes([{ acao: 'apagar_tudo' }, { acao: 'vitima', numero: 'x' }, { acao: 'vitima_nova', triagem: 'azul', sexo: 'X', idade: 300 }, { acao: 'marco', marco: 'pouso' },
    { acao: 'total', total: -1 }, { acao: 'evento', texto: 'Ok', categoria: 'fofoca' }], {});
  assert.strictEqual(a.length, 2);
  assert.deepStrictEqual(Object.keys(a[0]).sort(), ['acao', 'em', 'texto_tela']);
  assert.strictEqual(a[1].categoria, 'informacao');
});
console.log(falhas ? falhas + ' falha(s)' : 'tudo certo');
process.exit(falhas ? 1 : 0);
