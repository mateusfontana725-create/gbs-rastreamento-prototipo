// Teste do banco (schema.sql e migrações 007–033) num PostgreSQL REAL rodando no Node (PGlite),
// simulando o Supabase: papéis anon/authenticated/service_role, auth.uid() pela claim do JWT,
// Storage (buckets/objects com RLS) e a publicação do Realtime. Confere instalação, idempotência,
// RLS e o fluxo completo (cadastro, vítimas, grupos, trilha com confirmação, deslocamento e retorno).
//
// Não faz parte do "npm test" (precisa de um pacote). Para rodar:
//   npm install --no-save @electric-sql/pglite@0.2.17
//   npm run test:banco
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch (e) {
  console.error('Instale antes: npm install --no-save @electric-sql/pglite@0.2.17');
  process.exit(1);
}

const RAIZ = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (p) => readFileSync(join(RAIZ, p), 'utf8');
let ok = 0, falha = 0;
const chk = (c, m, x) => { if (c) { ok++; console.log('  ✔ ' + m); } else { falha++; console.log('  ✘ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };

const db = new PGlite();

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, is_anonymous boolean not null default false,
    created_at timestamptz not null default now(), last_sign_in_at timestamptz);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid,
    created_at timestamptz default now(), unique (bucket_id, name));
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated, service_role;
  grant select, insert, delete on storage.objects to authenticated;
  create publication supabase_realtime;
`);

console.log('Instalação');
const schema = ler('supabase/schema.sql');
try { await db.exec(schema); chk(true, 'schema.sql completo executa num banco novo'); } catch (e) { chk(false, 'schema.sql num banco novo', e.message); process.exit(1); }
try { await db.exec(schema); chk(true, 'schema.sql executa de novo por cima (idempotente)'); } catch (e) { chk(false, 'schema.sql de novo', e.message); process.exit(1); }
for (const m of ['007_cadastro_operacao_vitimas', '008_grupos', '009_trilha_offline', '010_missoes_alertas', '011_vitima_localizada', '012_diario_relatorio', '013_permanencia_setor', '014_fotos_localizacao', '015_grupos_no_mapa_civil', '016_admin_todas_operacoes', '017_excluir_responsavel', '018_pedido_acesso_responsavel', '019_ipo_operacao', '020_admin_excluir_sem_restricao', '021_ipo_no_cadastro', '022_cadastro_inicial', '023_estudos_perfil_distancia', '024_admin_excluir_relatorio', '025_responsavel_registra_vitima', '026_operacao_encerrada_somente_leitura', '027_dados_so_saem_ao_excluir', '028_trilhas_manuais', '029_nomes_painel_cpf_opcional', '030_percursos_trajetos', '031_vitima_encontrada_detalhes', '032_controle_tempo_missoes', '033_cenario_busca_pod_poa', '034_poa_pod_guia', '035_pedidos_ajuda', '036_recursos_equipes', '037_briefing_comando', '038_poa_fora_origem', '039_missoes_busca_pos', '040_retencao_criar_operacao', '041_excluir_operacao_com_registros', '042_proveniencia_binomio_drone', '043_qualidade_estudos', '044_cadastro_rapido_convites', '045_sci', '046_sci_integrado', '047_convites_categorias_tipos_ponto', '048_dashboard_publico_vitimas', '049_relatorios_diario_passagem', '050_icones_grupos_categorias', '051_aplicativo_android', '052_relatorio_comando', '053_convite_responsavel', '054_relatorio_imprensa']) {
  try { await db.exec(ler('supabase/migracoes/' + m + '.sql')); chk(true, 'migração ' + m + ' executa de novo (idempotente)'); }
  catch (e) { chk(false, 'migração ' + m, e.message); }
}
const pub = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1`)).rows.map((r) => r.tablename);
chk(['vitimas', 'grupos', 'grupo_membros', 'missoes', 'missao_membros', 'alertas'].every((t) => pub.includes(t)), 'tabelas novas publicadas no Realtime', pub);
const crit = (await db.query(`select proname, pg_get_function_identity_arguments(p.oid) a from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and proname='criar_operacao'`)).rows;
chk(crit.length === 1 && /jsonb/.test(crit[0].a), 'criar_operacao: só a versão nova (com p_dados) fica no banco', crit);

// --- usuários ---
async function usuario(email, anon) {
  return (await db.query(`insert into auth.users (email, is_anonymous) values ($1, $2) returning id`, [email, Boolean(anon)])).rows[0].id;
}
const resp1 = await usuario('r1@cbm', false), resp2 = await usuario('r2@cbm', false);
const anA = await usuario(null, true), anB = await usuario(null, true), anC = await usuario(null, true);
await db.query(`insert into public.responsaveis (user_id, nome) values ($1, 'Sgt Um'), ($2, 'Sgt Dois')`, [resp1, resp2]);

async function como(uid, sql, params, role) {
  await db.exec(`set role ${role || 'authenticated'}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  try { return await db.query(sql, params || []); }
  finally { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claim.sub', '', false)`); }
}
async function rpc(uid, fn, args) {
  // Desde a 038 o rascunho guarda "Fora da área". Os testes antigos (033/034) montam só os setores: aqui o "fora" é completado
  // com o que sobra, como a tela faz. Os testes da 038 usam "__sem_fora" para enviar sem esse campo.
  if (fn === 'cenario_salvar_rascunho' && typeof args.p_dados === 'string') {
    const d = JSON.parse(args.p_dados);
    if (d.__sem_fora) delete d.__sem_fora;
    else if (d.poa_fora === undefined) d.poa_fora = Math.max(0, Math.round((1 - (d.setores || []).reduce((a, x) => a + Number(x.poa), 0)) * 1e6) / 1e6);
    args = Object.assign({}, args, { p_dados: JSON.stringify(d) });
  }
  const nomes = Object.keys(args || {});
  const sql = `select public.${fn}(${nomes.map((k, i) => k + ' => $' + (i + 1)).join(', ')}) as r`;
  const r = await como(uid, sql, nomes.map((k) => args[k]));
  return r.rows[0].r;
}
async function erroDe(p) { try { await p; return null; } catch (e) { return e.message; } }

console.log('Cadastro da operação');
const agora = Date.now();
let op = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP TESTE', p_retencao_horas: 72, p_dados: JSON.stringify({
  tipo: 'outras', tipo_outro: 'Deslizamento', acionado_em: new Date(agora - 3600e3).toISOString(),
  local_endereco: 'Rua A, 1', local_lat: -22.9, local_lng: -43.2, descricao: 'Pessoa desaparecida' }) });
chk(op.tipo === 'outras' && op.tipo_outro === 'Deslizamento' && op.local_lat === -22.9 && op.gps_intervalo_s === 15, 'cria com tipo, acionamento, local e descrição', op);
// Migração 040: o painel envia 2160 h (90 dias, dados guardados até a exclusão); antes era recusado
const ret90 = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP RETENCAO 90', p_retencao_horas: 2160, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
chk(ret90.retencao_horas === 2160, 'criar operação com retenção de 90 dias (2160 h) funciona', ret90.retencao_horas);
chk(/retencao_invalida/.test(await erroDe(rpc(resp1, 'criar_operacao', { p_codigo: 'OP RET X', p_retencao_horas: 100 }))), 'retenção fora da lista continua recusada');
const antiga = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP ANTIGA', p_retencao_horas: 0 });
chk(antiga.tipo === null && antiga.descricao === '', 'chamada antiga (só nome) continua funcionando e a operação fica válida');
const cadInicial = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP CADASTRO INICIAL', p_retencao_horas: 0, p_dados: JSON.stringify({ natureza_x: 1, ipo: { natureza: 'BUSCA', solicitante_nome: 'Israel' }, descricao: 'Breve' }) });
chk(cadInicial.tipo === null && cadInicial.acionado_em && Math.abs(Date.now() - new Date(cadInicial.acionado_em).getTime()) < 120e3, 'cadastro inicial sem tipo: aceito, com início automático (a hora da criação)', cadInicial);
chk(cadInicial.ipo.natureza === 'BUSCA' && cadInicial.descricao === 'Breve', 'cadastro inicial grava natureza no IPO e a observação na descrição');
chk(/acionamento_invalido/.test(await erroDe(rpc(resp1, 'criar_operacao', { p_codigo: 'X Y', p_retencao_horas: 0,
  p_dados: JSON.stringify({ tipo: 'terrestre', acionado_em: new Date(agora + 3600e3).toISOString() }) }))), 'acionamento no futuro: recusado');
chk(/tipo_operacao_invalido/.test(await erroDe(rpc(resp1, 'criar_operacao', { p_codigo: 'X Y', p_retencao_horas: 0,
  p_dados: JSON.stringify({ tipo: 'outras', acionado_em: new Date(agora).toISOString() }) }))), '"Outras" sem o texto: recusado');
const atu = await rpc(resp1, 'atualizar_operacao', { p_operacao: antiga.id, p_dados: JSON.stringify({ tipo: 'aquatica', acionado_em: new Date(agora - 60e3).toISOString() }) });
chk(atu.tipo === 'aquatica' && atu.tipo_outro === null && atu.atualizado_por_nome === 'Sgt Um', 'operação antiga completada depois');
chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'atualizar_operacao', { p_operacao: op.id, p_dados: '{}' }))), 'responsável de outra operação não edita');
const info = await rpc(null, 'info_operacao', { p_token: op.token_civil });
chk(info.operacao === 'OP TESTE' && !('descricao' in info) && !('local_endereco' in info), 'participante continua vendo só o nome da operação');

console.log('Ficha da vítima');
let v = await rpc(resp1, 'salvar_vitima', { p_operacao: op.id, p_id: null, p_dados: JSON.stringify({ nome: 'João', idade: 34, caracteristicas: 'alto', roupas: 'camisa azul' }) });
chk(v.nome === 'João' && v.idade === 34, 'ficha criada');
chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'salvar_vitima', { p_operacao: op.id, p_id: v.id, p_dados: JSON.stringify({ idade: 200 }) }))), 'idade fora de 0–130: recusada');
const caminho = op.id + '/' + v.id + '/' + '11111111-1111-4111-8111-111111111111.jpg';
chk(/foto_nao_enviada/.test(await erroDe(rpc(resp1, 'definir_foto_vitima', { p_vitima: v.id, p_caminho: caminho }))), 'registrar foto sem o arquivo no Storage: recusado');
await como(resp1, `insert into storage.objects (bucket_id, name) values ('vitimas', $1)`, [caminho]);
chk(true, 'responsável da operação envia o arquivo ao bucket vitimas (regra do Storage)');
chk(/row-level security/.test(await erroDe(como(resp2, `insert into storage.objects (bucket_id, name) values ('vitimas', $1)`, [op.id + '/' + v.id + '/22222222-2222-4222-8222-222222222222.jpg']))), 'responsável de outra operação não envia foto');
v = await rpc(resp1, 'definir_foto_vitima', { p_vitima: v.id, p_caminho: caminho });
chk(v.foto_caminho === caminho, 'foto registrada na ficha');
chk((await como(resp1, `select count(*)::int n from storage.objects where bucket_id='vitimas'`)).rows[0].n === 1, 'responsável vê a foto (regra de leitura)');
chk((await como(resp1, `select count(*)::int n from public.vitimas`)).rows[0].n === 1, 'responsável lê a ficha');
chk((await como(resp2, `select count(*)::int n from public.vitimas`)).rows[0].n === 0, 'responsável de outra operação não lê a ficha');

console.log('Grupos e ingresso pelo link do grupo');
const g = await rpc(resp1, 'salvar_grupo', { p_operacao: op.id, p_id: null, p_dados: JSON.stringify({ nome: 'Polícia Civil', cor: '#3b82f6' }) });
const g2 = await rpc(resp1, 'salvar_grupo', { p_operacao: op.id, p_id: null, p_dados: JSON.stringify({ nome: 'Bombeiros' }) });
chk(/grupo_existente/.test(await erroDe(rpc(resp1, 'salvar_grupo', { p_operacao: op.id, p_id: null, p_dados: JSON.stringify({ nome: 'polícia civil' }) }))), 'nome de grupo repetido: recusado');
const link = await rpc(resp1, 'link_do_grupo', { p_grupo: g.id });
chk(link.token && link.token.length === 64, 'link do grupo gerado');
const infoG = await rpc(null, 'info_operacao', { p_token: link.token });
chk(infoG.grupo === 'Polícia Civil' && JSON.stringify(infoG.tipos_permitidos) === '["civil"]', 'tela inicial pelo link do grupo mostra o grupo (só civil)', infoG);
const cpf = '52998224725', tel = '21998765432';
const pA = await rpc(anA, 'ingressar', { p_token: link.token, p_nome: 'Ana', p_tipo: 'militar', p_cpf: cpf, p_telefone: tel });
chk(pA.grupo === 'Polícia Civil' && pA.tipo === 'civil', 'entra pelo link do grupo: no grupo e como civil (link não concede militar)', pA);
const pB = await rpc(anB, 'ingressar', { p_token: op.token_civil, p_nome: 'Beto', p_tipo: 'civil', p_cpf: cpf, p_telefone: tel });
const pC = await rpc(anC, 'ingressar', { p_token: op.token_civil, p_nome: 'Caio', p_tipo: 'civil', p_cpf: cpf, p_telefone: tel });
await rpc(resp1, 'definir_membro', { p_grupo: g.id, p_participante: pB.participante_id, p_papel: 'responsavel' });
await rpc(resp1, 'definir_membro', { p_grupo: g2.id, p_participante: pC.participante_id, p_papel: 'membro' });
const papelA = (await como(anA, `select papel, origem from public.grupo_membros`)).rows;
chk(papelA.length === 1 && papelA[0].papel === 'membro' && papelA[0].origem === 'link', 'participante lê só a própria linha de membro (papel membro, pelo link)', papelA);
chk((await como(anA, `select nome from public.grupos`)).rows.map((r) => r.nome).join() === 'Polícia Civil', 'participante vê só o grupo dele');
chk((await como(anC, `select nome from public.grupos`)).rows.map((r) => r.nome).join() === 'Bombeiros', 'outro participante vê só o grupo dele');
chk((await como(anA, `select count(*)::int n from public.grupo_convites`)).rows[0].n === 0, 'participante não lê os links dos grupos');
chk((await como(anA, `select count(*)::int n from public.vitimas`)).rows[0].n === 0, 'participante não lê fichas de vítimas');
chk((await como(anA, `select count(*)::int n from storage.objects where bucket_id='vitimas'`)).rows[0].n === 0, 'participante não vê a foto da vítima');
chk((await como(resp2, `select count(*)::int n from public.grupos`)).rows[0].n === 0, 'responsável de outra operação não vê os grupos');
chk((await como(resp1, `select count(*)::int n from public.grupo_membros`)).rows[0].n === 3, 'responsável da operação vê todos os vínculos');
const meus = await rpc(anB, 'meus_grupos', { p_participante: pB.participante_id });
chk(meus.length === 1 && meus[0].papel === 'responsavel', 'meus_grupos: responsável do grupo no celular', meus);
chk(/row-level security|permission denied/.test(await erroDe(como(anA, `insert into public.grupo_membros (grupo_id, participante_id, operacao_id) values ($1, $2, $3)`, [g2.id, pA.participante_id, op.id]))), 'participante não grava vínculo direto na tabela');
const novo = await rpc(resp1, 'gerar_novo_link_grupo', { p_grupo: g.id });
chk(novo.token !== link.token && (await rpc(null, 'info_operacao', { p_token: link.token })) === null, 'novo link invalida o anterior na hora');

console.log('Trilha: lote com confirmação por ponto');
const uid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const M = 1 / 111320;
const pt = (n, lat, lng, t) => ({ id: uid(n), lat, lng, prec: 8, t: t == null ? Date.now() : t });
let lote = await rpc(anA, 'enviar_posicoes_lote', { p_participante: pA.participante_id, p_gps: 'ok', p_pontos: JSON.stringify([
  pt(1, -22.9, -43.2), { id: 'nao-e-uuid', lat: -22.9, lng: -43.2, t: Date.now() }, pt(2, -22.9, -43.2, Date.parse('2001-01-01'))]) });
chk(lote.confirmados.length === 1 && lote.confirmados[0] === uid(1) && lote.recusados.length === 2, 'confirma o válido e recusa os inválidos com o motivo', lote);
chk(lote.recusados.some((r) => r.motivo === 'fora_do_periodo') && lote.recusados.some((r) => r.motivo === 'invalido'), 'motivos: fora_do_periodo e invalido');
lote = await rpc(anA, 'enviar_posicoes_lote', { p_participante: pA.participante_id, p_gps: 'ok', p_pontos: JSON.stringify([pt(1, -22.9, -43.2)]) });
chk(lote.confirmados.length === 1 && lote.inseridos === 0, 'reenvio do mesmo ponto: confirmado de novo sem duplicar');
chk((await db.query(`select count(*)::int n from public.posicoes where participante_id = $1`, [pA.participante_id])).rows[0].n === 1, 'um único ponto gravado');
const sv = await rpc(anA, 'sinal_vida', { p_participante: pA.participante_id, p_rastreando: true, p_gps: 'ok' });
chk(sv.gps_intervalo_s === 15, 'sinal_vida informa o intervalo de GPS da operação');
const cfg = await rpc(resp1, 'configurar_gps_operacao', { p_operacao: op.id, p_intervalo_s: 20, p_lacuna_s: 90 });
chk(cfg.gps_intervalo_s === 20 && cfg.gps_lacuna_s === 90, 'intervalo e limite de falha configuráveis');
chk(/gps_config_invalida/.test(await erroDe(rpc(resp1, 'configurar_gps_operacao', { p_operacao: op.id, p_intervalo_s: 60, p_lacuna_s: 40 }))), 'limite de falha menor que o intervalo: recusado');

console.log('Destino ao grupo, eventos pela trilha e controle de retorno');
const setor = await rpc(resp1, 'salvar_setor', { p_operacao: op.id, p_id: null, p_dados: JSON.stringify({ nome: 'S1', forma: 'circulo', centro_lat: -22.95, centro_lng: -43.2, raio_m: 300 }) });
const base = await rpc(resp1, 'salvar_ponto', { p_operacao: op.id, p_id: null, p_dados: JSON.stringify({ categoria: 'BASE', titulo: 'Base 1', lat: -22.9, lng: -43.2, raio_m: 100 }) });
chk(base.categoria === 'BASE' && base.raio_m === 100, 'ponto de interesse do tipo Base, com raio');
let n = 10;
async function andar(anon, part, lat, lng, t) { return rpc(anon, 'enviar_posicoes_lote', { p_participante: part, p_gps: 'ok', p_pontos: JSON.stringify([pt(n++, lat, lng, t)]) }); }
await andar(anB, pB.participante_id, -22.9, -43.2);   // B na base
chk(/grupo_vazio/.test(await erroDe(rpc(resp1, 'enviar_destino_grupo', { p_grupo: (await rpc(resp1, 'salvar_grupo', { p_operacao: op.id, p_id: null, p_dados: JSON.stringify({ nome: 'Vazio' }) })).id,
  p_nome: 'X', p_lat: -22.95, p_lng: -43.2 }))), 'grupo sem membros de campo: recusado');
chk(/grupo_sem_responsavel/.test(await erroDe(rpc(resp1, 'enviar_destino_grupo', { p_grupo: g2.id, p_nome: 'X', p_lat: -22.95, p_lng: -43.2, p_publico: 'responsavel' }))), 'só o responsável, num grupo sem responsável: recusado');
let env = await rpc(resp1, 'enviar_destino_grupo', { p_grupo: g.id, p_nome: 'Setor S1', p_lat: -22.95, p_lng: -43.2, p_publico: 'responsavel', p_modo: 'a_pe',
  p_setor: setor.id, p_ponto: null, p_base: base.id, p_raio_base_m: null, p_prazo_min: 5 });
const missao = env.missao;
chk(env.destinatarios === 1 && env.acompanhados === 2 && missao.raio_base_m === 100, 'só o responsável recebe o destino; os 2 membros são acompanhados', env);
const dB = await rpc(anB, 'meu_destino', { p_participante: pB.participante_id });
const dA = await rpc(anA, 'meu_destino', { p_participante: pA.participante_id });
chk(dB && dB.missao && dB.missao.pode_finalizar === true && dB.missao.grupo === 'Polícia Civil', 'celular do responsável do grupo: destino com a missão e o botão de finalizar', dB);
chk(dA === null, 'membro comum não recebe o destino (público: só o responsável)');
await andar(anA, pA.participante_id, -22.9 + 400 * M, -43.2);
let al = (await db.query(`select tipo from public.alertas order by id`)).rows.map((r) => r.tipo);
chk(al.join() === 'deslocamento_iniciado', 'início do deslocamento detectado pela trilha (≥ 100 m da posição no envio)', al);
await andar(anA, pA.participante_id, -22.95, -43.2);
al = (await db.query(`select tipo from public.alertas order by id`)).rows.map((r) => r.tipo);
chk(!al.includes('chegou_setor'), '1 ponto dentro do setor ainda não conta como chegada');
await andar(anA, pA.participante_id, -22.9501, -43.2001);
al = (await db.query(`select tipo from public.alertas order by id`)).rows.map((r) => r.tipo);
chk(al.join() === 'deslocamento_iniciado,chegou_setor', 'chegada ao setor com 2 pontos seguidos dentro do círculo', al);
await andar(anA, pA.participante_id, -22.9502, -43.2002);
chk((await db.query(`select count(*)::int n from public.alertas`)).rows[0].n === 2, 'novos pontos não repetem alertas');
chk(/sem_permissao/.test(await erroDe(rpc(anA, 'finalizar_busca', { p_missao: missao.id }))), 'membro comum não finaliza a busca');
const fin = await rpc(anB, 'finalizar_busca', { p_missao: missao.id });
chk(fin.status === 'busca_finalizada' && fin.prazo_retorno_em, 'responsável do grupo finaliza a busca pelo celular; prazo de retorno começa', fin.status);
const volta = await rpc(anA, 'meu_destino', { p_participante: pA.participante_id });
chk(volta && /Volte para a base/.test(volta.nome) && volta.missao.volta_base === true, 'todos recebem "Volte para a base"', volta && volta.nome);
chk(/sem_permissao/.test(await erroDe(rpc(resp1, 'verificar_retornos', {}))), 'verificar_retornos sem operação: só o agendador (pg_cron)');
chk((await rpc(resp1, 'verificar_retornos', { p_operacao: op.id })) === 0, 'antes do prazo: sem alerta de atraso');
await db.query(`update public.missoes set prazo_retorno_em = now() - interval '1 minute' where id = $1`, [missao.id]);
chk((await rpc(resp1, 'verificar_retornos', { p_operacao: op.id })) === 1, 'prazo vencido sem todos na base: alerta gerado');
const crit2 = (await db.query(`select nivel, titulo, texto from public.alertas where tipo = 'retorno_atrasado'`)).rows[0];
chk(crit2 && crit2.nivel === 'critico' && /PERDIDA/.test(crit2.titulo) && /Ana/.test(crit2.texto) && /Beto/.test(crit2.texto), 'alerta crítico lista quem falta', crit2);
chk((await db.query(`select verificar_retornos() n`)).rows[0].n === 0, 'pg_cron (sem usuário) roda e não repete o mesmo alerta');
await andar(anA, pA.participante_id, -22.9, -43.2);
chk((await db.query(`select status from public.missoes where id = $1`, [missao.id])).rows[0].status === 'retorno_atrasado', 'um membro na base, outro não: continua atrasado');
await andar(anB, pB.participante_id, -22.9002, -43.2);
const fim = (await db.query(`select status from public.missoes where id = $1`, [missao.id])).rows[0].status;
const tbase = (await db.query(`select texto from public.alertas where tipo = 'chegou_base'`)).rows[0];
chk(fim === 'na_base' && tbase && /depois do prazo/.test(tbase.texto), 'todos na base: missão "na base" e alerta informa que foi depois do prazo', [fim, tbase]);
chk((await rpc(anA, 'meu_destino', { p_participante: pA.participante_id })) === null, 'navegação até a base encerrada ao chegarem');
chk((await como(anA, `select count(*)::int n from public.alertas`)).rows[0].n === 0, 'participante não lê alertas');
chk((await como(resp2, `select count(*)::int n from public.missoes`)).rows[0].n === 0, 'responsável de outra operação não lê os deslocamentos');
const ack = await rpc(resp1, 'reconhecer_alerta', { p_alerta: (await db.query(`select id from public.alertas where tipo='retorno_atrasado'`)).rows[0].id });
chk(ack.reconhecido_por_nome === 'Sgt Um', 'Ciente registra quem reconheceu');
// polígono
const poli = await rpc(resp1, 'salvar_setor', { p_operacao: op.id, p_id: null, p_dados: JSON.stringify({ nome: 'P1', forma: 'poligono', pontos: [[-22.80, -43.30], [-22.80, -43.10], [-22.70, -43.10], [-22.70, -43.30]] }) });
const dentro = (await db.query(`select public.ponto_no_setor(s, -22.75, -43.2) d, public.ponto_no_setor(s, -22.85, -43.2) f from public.setores s where id = $1`, [poli.id])).rows[0];
chk(dentro.d === true && dentro.f === false, 'ponto dentro/fora de setor desenhado (polígono)');

console.log('Encontrei a vítima (condição só para os responsáveis)');
const anM = await usuario(null, true);
const pM = await rpc(anM, 'ingressar', { p_token: op.token_militar, p_nome: 'Cb Militar', p_tipo: 'militar', p_cpf: cpf, p_telefone: tel });
console.log('Mapa do civil: integrantes do próprio grupo (migração 015)');
{
  // posições recentes para os civis do grupo, o militar sem grupo e o responsável do grupo
  await db.query(`update public.participantes set ultima_lat = -22.9, ultima_lng = -43.2, ultima_precisao = 8,
                    ultima_posicao_em = now(), rastreando = true, removido = false, liberado_em = null
                  where id = any($1::uuid[])`, [[pA.participante_id, pB.participante_id, pC.participante_id, pM.participante_id]]);
  const grupoDe = async (pid) => (await db.query(`select count(*)::int n from public.grupo_membros where participante_id = $1`, [pid])).rows[0].n;
  chk((await grupoDe(pM.participante_id)) === 0 && (await grupoDe(pA.participante_id)) === 1, 'pré-condição: militar sem grupo; civil no grupo G1');
  const porId = (lista) => Object.fromEntries((lista || []).map((x) => [x.id, x]));
  const eqA = await rpc(anA, 'equipe_no_mapa', { p_participante: pA.participante_id });
  const vistosA = porId(eqA);
  chk(vistosA[pB.participante_id] && vistosA[pB.participante_id].tipo === 'civil', 'civil vê o integrante civil do próprio grupo (responsável do grupo)', eqA);
  chk(vistosA[pB.participante_id] && vistosA[pB.participante_id].nome === 'Beto' && vistosA[pB.participante_id].grupo_papel === 'responsavel', 'nome e papel no grupo para quem é do mesmo grupo');
  chk(vistosA[pB.participante_id] && vistosA[pB.participante_id].grupo_cor === '#3b82f6' && vistosA[pB.participante_id].grupo_nome === 'Polícia Civil', 'cor e nome do grupo em comum');
  chk(vistosA[pM.participante_id] && vistosA[pM.participante_id].nome === null && vistosA[pM.participante_id].grupo_id === null, 'militar sem grupo continua visível, sem nome nem grupo (como antes)');
  chk(!vistosA[pC.participante_id], 'civil de OUTRO grupo não aparece para o civil do G1', Object.keys(vistosA));
  chk(!vistosA[pA.participante_id], 'a própria pessoa não aparece na lista dela');
  const eqC = await rpc(anC, 'equipe_no_mapa', { p_participante: pC.participante_id });
  chk(!porId(eqC)[pA.participante_id] && !porId(eqC)[pB.participante_id], 'civil de outro grupo NÃO vê integrantes do G1', Object.keys(porId(eqC)));
  chk(porId(eqC)[pM.participante_id] && porId(eqC)[pM.participante_id].nome === null, 'quem está no G2 vê o militar sem grupo, sem nome');
  const texto = JSON.stringify(eqA) + JSON.stringify(eqC);
  chk(!/cpf|telefone|trilha/i.test(texto) && !texto.includes('52998224725') && !texto.includes('21998765432'), 'nenhum CPF, telefone ou trilha na resposta');
  await db.query(`update public.participantes set rastreando = false where id = $1`, [pB.participante_id]);
  const eqA2 = await rpc(anA, 'equipe_no_mapa', { p_participante: pA.participante_id });
  chk(!porId(eqA2)[pB.participante_id], 'integrante do grupo que parou de compartilhar some do mapa do colega');
  await db.query(`update public.participantes set rastreando = true where id = $1`, [pB.participante_id]);
  chk(/participante_invalido/.test(await erroDe(rpc(anC, 'equipe_no_mapa', { p_participante: pA.participante_id }))), 'não consulta o mapa em nome de outro participante');
  const g1 = await db.query(`select count(*)::int n from public.grupo_membros where participante_id = $1`, [pC.participante_id]);
  chk(g1.rows[0].n === 1, 'pré-condição: civil do G2 segue no grupo');
}

const cidV = '33333333-3333-4333-8333-333333333333';
const neutra = await rpc(anM, 'participante_registrar_vitima', { p_participante: pM.participante_id, p_condicao: 'obito',
  p_lat: -22.91, p_lng: -43.21, p_precisao: 8, p_posicao_em: new Date().toISOString(), p_client_id: cidV });
chk(neutra.categoria === 'VITIMA' && neutra.texto === 'Localizada, ver protocolo' && !/obito|viva|morta/i.test(JSON.stringify(neutra)),
  'registro devolve só a mensagem neutra (sem a condição)', neutra);
const neutra2 = await rpc(anM, 'participante_registrar_vitima', { p_participante: pM.participante_id, p_condicao: 'viva', p_client_id: cidV });
chk(neutra2.id === neutra.id && (await db.query(`select count(*)::int n from public.vitima_localizacoes`)).rows[0].n === 1, 'reenvio com o mesmo client_id não duplica');
const reg = (await como(resp1, `select condicao, registrado_por_nome, registrado_por_tipo, lat, registrado_em from public.vitima_localizacoes`)).rows;
chk(reg.length === 1 && reg[0].condicao === 'obito' && reg[0].registrado_por_nome === 'Cb Militar' && reg[0].registrado_por_tipo === 'militar' && reg[0].lat === -22.91 && reg[0].registrado_em,
  'responsável da operação lê condição, local, data/hora e quem registrou', reg);
chk((await como(anM, `select count(*)::int n from public.vitima_localizacoes`)).rows[0].n === 0, 'quem registrou NÃO lê a condição (RLS)');
chk((await como(anA, `select count(*)::int n from public.vitima_localizacoes`)).rows[0].n === 0, 'outro participante de campo NÃO lê a condição (RLS)');
chk((await como(resp2, `select count(*)::int n from public.vitima_localizacoes`)).rows[0].n === 0, 'responsável de outra operação NÃO lê a condição');
chk(/permission denied/.test(await erroDe(como(null, `select * from public.vitima_localizacoes`, [], 'anon'))), 'anon não tem acesso à tabela');
chk(/permission denied|row-level security/.test(await erroDe(como(anM, `insert into public.vitima_localizacoes (operacao_id, participante_id, mensagem_id, condicao, registrado_por, registrado_por_nome, registrado_por_tipo)
  values ($1, $2, $3, 'viva', $4, 'x', 'civil')`, [op.id, pM.participante_id, neutra.id, anM]))), 'participante não grava direto na tabela');
const minhas = (await como(anM, `select texto, categoria from public.mensagens where direcao = 'entrada'`)).rows;
chk(minhas.length === 1 && minhas[0].texto === 'Localizada, ver protocolo', 'quem registrou vê na conversa só o termo neutro', minhas);
chk((await como(anA, `select count(*)::int n from public.mensagens where categoria = 'VITIMA'`)).rows[0].n === 0, 'outro participante não vê o registro');
const alV = (await como(resp1, `select nivel, titulo, texto, lat from public.alertas where tipo = 'vitima_localizada'`)).rows;
chk(alV.length === 1 && alV[0].nivel === 'critico' && alV[0].lat === -22.91 && !/obito|óbito|viva|morta/i.test(alV[0].titulo + alV[0].texto),
  'alerta crítico ao responsável, com texto neutro', alV);
chk(/tipo_invalido/.test(await erroDe(rpc(anA, 'participante_enviar_mensagem', { p_participante: pA.participante_id, p_categoria: 'VITIMA', p_texto: 'morta' }))),
  'categoria VITIMA com texto livre: recusada');
chk(/dados_invalidos/.test(await erroDe(rpc(anA, 'participante_registrar_vitima', { p_participante: pA.participante_id, p_condicao: 'ferida' }))), 'condição inválida: recusada');
chk(/participante_invalido/.test(await erroDe(rpc(anA, 'participante_registrar_vitima', { p_participante: pM.participante_id, p_condicao: 'viva' }))), 'não registra em nome de outro participante');
chk(/permission denied/.test(await erroDe(como(null, `select public.participante_registrar_vitima($1, 'viva')`, [pM.participante_id], 'anon'))), 'anon não chama a função');
const pubV = (await db.query(`select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'vitima_localizacoes'`)).rows;
chk(pubV.length === 1, 'vitima_localizacoes publicada no Realtime');

console.log('Responsável registra vítima encontrada (migração 025)');
{
  const opV = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP VITIMA RESP', p_retencao_horas: 24, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  const uE = await usuario(null, true);
  const enc = await rpc(uE, 'ingressar', { p_token: opV.token_militar, p_nome: 'Sd Achou', p_tipo: 'militar', p_cpf: cpf, p_telefone: tel });
  const r = await rpc(resp1, 'responsavel_registrar_vitima', { p_operacao: opV.id, p_condicao: 'viva', p_lat: -22.95, p_lng: -43.25, p_precisao: 6,
    p_posicao_em: new Date().toISOString(), p_encontrou: enc.participante_id });
  chk(r.mensagem.categoria === 'VITIMA' && r.mensagem.texto === 'Localizada, ver protocolo' && r.registro.condicao === 'viva', 'responsável registra a vítima encontrada (mensagem neutra + condição)', r);
  const rv = (await como(resp1, `select condicao, registrado_por_tipo, registrado_por_nome, lat from public.vitima_localizacoes where operacao_id = $1`, [opV.id])).rows;
  chk(rv.length === 1 && rv[0].registrado_por_tipo === 'responsavel' && /Sgt Um \(encontrada por Sd Achou\)/.test(rv[0].registrado_por_nome) && rv[0].lat === -22.95,
    'registro com quem registrou (responsável) e quem encontrou', rv);
  const pr = (await db.query(`select tipo, nome from public.participantes where operacao_id = $1 and user_id = $2`, [opV.id, resp1])).rows;
  chk(pr.length === 1 && pr[0].tipo === 'responsavel', 'o registro do responsável na operação é criado se faltava', pr);
  const al = (await como(resp1, `select nivel, texto, participante_id from public.alertas where operacao_id = $1 and tipo = 'vitima_localizada'`, [opV.id])).rows;
  chk(al.length === 1 && al[0].nivel === 'critico' && al[0].participante_id === enc.participante_id && !/viva|óbito|obito|morta/i.test(al[0].texto),
    'alerta crítico neutro para os responsáveis, apontando quem encontrou', al);
  const dv = (await como(resp1, `select titulo from public.diario where operacao_id = $1 and tipo = 'vitima_localizada'`, [opV.id])).rows;
  chk(dv.length === 1 && /VIVA/.test(dv[0].titulo), 'entra no diário com a condição', dv);
  chk((await como(uE, `select count(*)::int n from public.mensagens where categoria = 'VITIMA'`)).rows[0].n === 0, 'participante de campo não vê o registro do responsável');
  const semLocal = await rpc(resp1, 'responsavel_registrar_vitima', { p_operacao: opV.id, p_condicao: 'obito' });
  chk(semLocal.registro.lat === null && semLocal.registro.condicao === 'obito', 'pode registrar sem localização (segunda vítima, por exemplo)', semLocal.registro);
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'responsavel_registrar_vitima', { p_operacao: opV.id, p_condicao: 'viva' }))), 'responsável de outra operação não registra');
  chk(/sem_permissao/.test(await erroDe(rpc(uE, 'responsavel_registrar_vitima', { p_operacao: opV.id, p_condicao: 'viva' }))), 'participante de campo não usa a função do responsável');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'responsavel_registrar_vitima', { p_operacao: opV.id, p_condicao: 'ferida' }))), 'condição inválida: recusada');
  chk(/posicao_invalida/.test(await erroDe(rpc(resp1, 'responsavel_registrar_vitima', { p_operacao: opV.id, p_condicao: 'viva', p_lat: -22.9 }))), 'só latitude, sem longitude: recusada');
  chk(/participante_invalido/.test(await erroDe(rpc(resp1, 'responsavel_registrar_vitima', { p_operacao: opV.id, p_condicao: 'viva', p_encontrou: pM.participante_id }))), 'quem encontrou precisa ser desta operação');
  chk(/permission denied/.test(await erroDe(como(null, `select public.responsavel_registrar_vitima($1, 'viva')`, [opV.id], 'anon'))), 'anon não chama a função');
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opV.id });
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'responsavel_registrar_vitima', { p_operacao: opV.id, p_condicao: 'viva' }))), 'operação encerrada: não registra');
}

console.log('Tempo de permanência em setor');
{
  const opP = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP PERMANENCIA', p_retencao_horas: 24, p_dados: JSON.stringify({ tipo: 'terrestre', acionado_em: new Date(Date.now() - 6 * 3600e3).toISOString() }) });
  await db.query(`update public.operacoes set criada_em = now() - interval '5 hours' where id = $1`, [opP.id]);
  chk(opP.permanencia_limite_min === 60, 'limite padrão de permanência: 60 min', opP.permanencia_limite_min);
  const setorP = await rpc(resp1, 'salvar_setor', { p_operacao: opP.id, p_id: null, p_dados: JSON.stringify({ nome: 'Mata', forma: 'circulo', centro_lat: -23.5, centro_lng: -46.6, raio_m: 300 }) });
  const [uS, uG1, uG2] = [await usuario(null, true), await usuario(null, true), await usuario(null, true)];
  const solo = await rpc(uS, 'ingressar', { p_token: opP.token_militar, p_nome: 'Solo', p_tipo: 'militar', p_cpf: cpf, p_telefone: tel });
  const g1 = await rpc(uG1, 'ingressar', { p_token: opP.token_militar, p_nome: 'Gama', p_tipo: 'militar', p_cpf: cpf, p_telefone: tel });
  const g2m = await rpc(uG2, 'ingressar', { p_token: opP.token_civil, p_nome: 'Delta', p_tipo: 'civil', p_cpf: cpf, p_telefone: tel });
  const grpP = await rpc(resp1, 'salvar_grupo', { p_operacao: opP.id, p_id: null, p_dados: JSON.stringify({ nome: 'Equipe Alfa' }) });
  await rpc(resp1, 'definir_membro', { p_grupo: grpP.id, p_participante: g1.participante_id, p_papel: 'responsavel' });
  await rpc(resp1, 'definir_membro', { p_grupo: grpP.id, p_participante: g2m.participante_id, p_papel: 'membro' });
  const T0 = Date.now() - 150 * 60e3;
  const DENTRO = [-23.5005, -46.6003], FORA = [-23.51, -46.6];
  const minT = (m) => T0 + m * 60e3;
  async function trilha(u, pid, pts) {
    return rpc(u, 'enviar_posicoes_lote', { p_participante: pid, p_gps: 'ok', p_pontos: JSON.stringify(pts.map(([m, onde]) => pt(n++, onde[0], onde[1], minT(m)))) });
  }
  const alertasP = async () => (await db.query(`select tipo, titulo, texto, grupo_id, participante_id, chave from public.alertas where operacao_id = $1 and tipo = 'permanencia_setor' order by id`, [opP.id])).rows;
  const perms = async (pid) => (await db.query(`select id, entrou_em, saiu_em, avisado_min from public.setor_permanencias where participante_id = $1 order by entrou_em`, [pid])).rows;

  // pessoa sozinha: entra (2 pontos dentro), fica 65 min
  await trilha(uS, solo.participante_id, [[0, FORA], [1, DENTRO], [2, DENTRO]]);
  let ps = await perms(solo.participante_id);
  chk(ps.length === 1 && !ps[0].saiu_em && Math.abs(Date.parse(ps[0].entrou_em) - minT(1)) < 1500, 'entrada no setor pela trilha: começa no 1º ponto dentro', ps);
  const passos = []; for (let m = 7; m <= 55; m += 6) passos.push([m, DENTRO]);
  await trilha(uS, solo.participante_id, passos);
  chk((await alertasP()).length === 0, 'antes de 1 h no setor: sem alerta');
  await trilha(uS, solo.participante_id, [[63, DENTRO], [64, FORA], [65, DENTRO], [66, DENTRO]]);   // 1 ponto fora (oscilação) não é saída
  let al = await alertasP();
  chk(al.length === 1 && al[0].participante_id === solo.participante_id && /Solo/.test(al[0].titulo) && /1 h/.test(al[0].titulo) && /Avalie a troca/.test(al[0].texto),
    'passou de 1 h: um alerta para o responsável avaliar a troca', al);
  for (let m = 67; m <= 75; m += 2) await trilha(uS, solo.participante_id, [[m, DENTRO]]);
  chk((await alertasP()).length === 1, 'novos pontos no setor não repetem o alerta');
  await trilha(uS, solo.participante_id, [[76, DENTRO]]);   // reenvio do mesmo trecho com outros pontos não duplica
  ps = await perms(solo.participante_id);
  chk(ps.length === 1 && !ps[0].saiu_em && ps[0].avisado_min === 60, 'continua a mesma permanência (avisado até 60 min)', ps);
  // sai (3 pontos fora) e volta em 3 min: mesma permanência (não zera o tempo)
  await trilha(uS, solo.participante_id, [[77, FORA], [77.5, FORA], [78, FORA]]);
  ps = await perms(solo.participante_id);
  chk(ps.length === 1 && ps[0].saiu_em && Math.abs(Date.parse(ps[0].saiu_em) - minT(77)) < 1500, 'saída: 3 pontos fora; termina no 1º ponto fora', ps);
  await trilha(uS, solo.participante_id, [[80, DENTRO], [80.5, DENTRO]]);
  ps = await perms(solo.participante_id);
  chk(ps.length === 1 && !ps[0].saiu_em, 'voltou em menos de 5 min: a permanência continua (oscilação na borda)', ps);
  const resto = []; for (let m = 85; m <= 122; m += 6) resto.push([m, DENTRO]);
  await trilha(uS, solo.participante_id, resto);
  al = await alertasP();
  chk(al.length === 2 && /2 h/.test(al[1].titulo), '2× o limite: um segundo alerta (um por limite atingido)', al.map((a) => a.titulo));

  // grupo: dois membros no setor → UM alerta do grupo
  // os dois celulares enviam ao mesmo tempo (lotes intercalados)
  for (let m = 70; m <= 136; m += 6) {
    await trilha(uG1, g1.participante_id, m === 70 ? [[69, FORA], [m, DENTRO]] : [[m, DENTRO]]);
    await trilha(uG2, g2m.participante_id, m === 70 ? [[69, FORA], [m, DENTRO]] : [[m, DENTRO]]);
  }
  al = (await alertasP()).filter((a) => a.grupo_id === grpP.id);
  chk(al.length === 1 && /Equipe Alfa/.test(al[0].titulo) && /Gama/.test(al[0].texto) && /Delta/.test(al[0].texto), 'grupo no mesmo setor: um alerta só, listando os membros', al);

  // configuração do limite
  chk(/sem_permissao/.test(await erroDe(rpc(uS, 'configurar_permanencia', { p_operacao: opP.id, p_limite_min: 30 }))), 'participante não muda o limite');
  chk(/permanencia_invalida/.test(await erroDe(rpc(resp1, 'configurar_permanencia', { p_operacao: opP.id, p_limite_min: 5 }))), 'limite fora de 10–720 min: recusado');
  const cfg = await rpc(resp1, 'configurar_permanencia', { p_operacao: opP.id, p_limite_min: 0 });
  chk(cfg.permanencia_limite_min === 0, 'responsável desliga o alerta (0)');
  await trilha(uG1, g1.participante_id, [[140, DENTRO], [145, DENTRO]]);
  chk((await alertasP()).length === 3, 'desligado: não gera novos alertas');
  await rpc(resp1, 'configurar_permanencia', { p_operacao: opP.id, p_limite_min: 45 });
  const dlim = (await db.query(`select titulo from public.diario where operacao_id = $1 and tipo = 'permanencia_limite' order by id`, [opP.id])).rows;
  chk(dlim.length === 2 && /45 min/.test(dlim[1].titulo), 'mudança do limite registrada no diário', dlim);
  const dal = (await db.query(`select categoria from public.diario where operacao_id = $1 and tipo = 'alerta_permanencia_setor'`, [opP.id])).rows;
  chk(dal.length === 3 && dal.every((x) => x.categoria === 'alerta'), 'alertas de permanência entram no diário como Alerta', dal);

  // leitura (RLS) e deslocamentos continuam funcionando com o novo gancho
  chk((await como(resp1, `select count(*)::int n from public.setor_permanencias where operacao_id = $1`, [opP.id])).rows[0].n >= 3, 'responsável lê as permanências');
  chk((await como(uS, `select count(*)::int n from public.setor_permanencias`)).rows[0].n === 0, 'participante não lê as permanências');
  chk((await como(resp2, `select count(*)::int n from public.setor_permanencias where operacao_id = $1`, [opP.id])).rows[0].n === 0, 'responsável de outra operação não lê');
  chk(/permission denied/.test(await erroDe(como(resp1, `select * from public.setor_presenca`))), 'estado interno (setor_presenca) não é lido pelo navegador');
  const pub = (await db.query(`select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'setor_permanencias'`)).rows;
  chk(pub.length === 1, 'setor_permanencias publicada no Realtime');
  const gancho = (await db.query(`select prosrc from pg_proc where proname = 'apos_posicoes'`)).rows;
  chk(gancho.length === 1 && /apos_posicoes_missoes/.test(gancho[0].prosrc) && /avaliar_permanencia/.test(gancho[0].prosrc), 'gancho apos_posicoes chama deslocamentos e permanência');
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opP.id });
}

console.log('Fotos: setor, localização pendente e atualização pelo GPS');
{
  const opF = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP FOTOS', p_retencao_horas: 24, p_dados: JSON.stringify({ tipo: 'terrestre', acionado_em: new Date(Date.now() - 3 * 3600e3).toISOString() }) });
  await db.query(`update public.operacoes set criada_em = now() - interval '2 hours' where id = $1`, [opF.id]);
  const setF = await rpc(resp1, 'salvar_setor', { p_operacao: opF.id, p_id: null, p_dados: JSON.stringify({ nome: 'Margem', forma: 'circulo', centro_lat: -23.6, centro_lng: -46.7, raio_m: 400 }) });
  const [uF, uF2] = [await usuario(null, true), await usuario(null, true)];
  const pF = await rpc(uF, 'ingressar', { p_token: opF.token_civil, p_nome: 'Fotógrafa', p_tipo: 'civil', p_cpf: cpf, p_telefone: tel });
  const pF2 = await rpc(uF2, 'ingressar', { p_token: opF.token_civil, p_nome: 'Outro', p_tipo: 'civil', p_cpf: cpf, p_telefone: tel });
  let k = 900;
  async function foto(u, part, origem, extra) {
    const cid = uid(k++);
    await como(u, `insert into storage.objects (bucket_id, name) values ('fotos', $1)`, [opF.id + '/' + part + '/' + cid + '.jpg']);
    const f = await rpc(u, 'registrar_foto', Object.assign({ p_participante: part, p_client_id: cid, p_origem: origem, p_lat: null, p_lng: null, p_precisao: null,
      p_posicao_em: null, p_capturada_em: new Date().toISOString(), p_legenda: '', p_bytes: 1000, p_largura: 800, p_altura: 600 }, extra || {}));
    return { f, cid };
  }
  // com GPS no momento: dados completos e setor calculado
  const agora = Date.now();
  const a = await foto(uF, pF.participante_id, 'gps', { p_lat: -23.601, p_lng: -46.7005, p_precisao: 6, p_posicao_em: new Date(agora - 2000).toISOString(), p_capturada_em: new Date(agora).toISOString() });
  chk(a.f.origem_posicao === 'gps' && a.f.setor_id === setF.id && a.f.setor_nome === 'Margem' && a.f.capturada_em && a.f.precisao === 6 && a.f.autor_nome === 'Fotógrafa',
    'foto com GPS: horário do aparelho, coordenadas, precisão, operação, setor e autor gravados na tabela', a.f);
  // sem GPS: fica pendente; o celular completa quando o GPS responder
  const capt = Date.now() - 60e3;
  const b = await foto(uF, pF.participante_id, 'pendente', { p_capturada_em: new Date(capt).toISOString() });
  chk(b.f.origem_posicao === 'pendente' && b.f.lat === null && b.f.setor_id === null, 'sem GPS: foto registrada mesmo assim, com localização pendente', b.f);
  chk(/local_fora_do_prazo/.test(await erroDe(rpc(uF, 'atualizar_local_foto', { p_participante: pF.participante_id, p_client_id: b.cid,
    p_lat: -23.6, p_lng: -46.7, p_precisao: 10, p_posicao_em: new Date(capt + 15 * 60e3).toISOString() }))), 'leitura do GPS muito depois da captura (15 min): recusada');
  chk(/foto_nao_encontrada|participante_invalido/.test(await erroDe(rpc(uF2, 'atualizar_local_foto', { p_participante: pF2.participante_id, p_client_id: b.cid,
    p_lat: -23.6, p_lng: -46.7, p_precisao: 10, p_posicao_em: new Date(capt + 60e3).toISOString() }))), 'outra pessoa não altera o local da foto');
  const b2 = await rpc(uF, 'atualizar_local_foto', { p_participante: pF.participante_id, p_client_id: b.cid,
    p_lat: -23.6002, p_lng: -46.7001, p_precisao: 12, p_posicao_em: new Date(capt + 3 * 60e3).toISOString() });
  chk(b2.origem_posicao === 'gps' && b2.lat === -23.6002 && b2.setor_nome === 'Margem' && b2.local_atualizado_em, 'GPS respondeu 3 min depois: local completado e setor calculado', b2);
  const b3 = await rpc(uF, 'atualizar_local_foto', { p_participante: pF.participante_id, p_client_id: b.cid, p_lat: -23.7, p_lng: -46.8, p_precisao: 5, p_posicao_em: new Date(capt + 4 * 60e3).toISOString() });
  chk(b3.lat === -23.6002, 'local já completado não é trocado por um envio repetido');
  // pendente, mas a trilha GPS tem um ponto do momento da foto: completa sozinha
  const capt2 = Date.now() - 90e3;
  await rpc(uF, 'enviar_posicoes_lote', { p_participante: pF.participante_id, p_gps: 'ok', p_pontos: JSON.stringify([pt(k++, -23.6011, -46.7002, capt2 - 40e3)]) });
  const c = await foto(uF, pF.participante_id, 'pendente', { p_capturada_em: new Date(capt2).toISOString() });
  chk(c.f.origem_posicao === 'trilha' && c.f.lat === -23.6011 && c.f.setor_nome === 'Margem', 'pendente com ponto da trilha 40 s antes: completada pela trilha GPS na hora', c.f);
  // pendente, e a trilha chega depois (celular estava sem internet): completa quando os pontos chegam
  const capt3 = Date.now() - 10 * 60e3;   // longe dos pontos anteriores da trilha
  const d = await foto(uF, pF.participante_id, 'pendente', { p_capturada_em: new Date(capt3).toISOString() });
  chk(d.f.origem_posicao === 'pendente', 'pendente sem ponto na trilha: continua pendente');
  await rpc(uF, 'enviar_posicoes_lote', { p_participante: pF.participante_id, p_gps: 'ok', p_pontos: JSON.stringify([pt(k++, -23.59, -46.69, capt3 + 50e3)]) });
  const d2 = (await db.query(`select origem_posicao, lat, setor_id from public.fotos where client_id = $1`, [d.cid])).rows[0];
  chk(d2.origem_posicao === 'trilha' && d2.lat === -23.59 && d2.setor_id === null, 'pontos da trilha chegaram depois: foto pendente completada (fora de setor = sem setor)', d2);
  // desistiu: sem GPS até o fim do prazo
  const e = await foto(uF, pF.participante_id, 'pendente', { p_capturada_em: new Date(Date.now() - 20 * 60e3).toISOString() });
  const e2 = await rpc(uF, 'atualizar_local_foto', { p_participante: pF.participante_id, p_client_id: e.cid });
  chk(e.f.origem_posicao === 'pendente' && e2.origem_posicao === 'nenhuma', 'GPS não respondeu no prazo: fica "sem localização"');
  // setor criado depois e fotos antigas
  chk(/posicao_invalida/.test(await erroDe(foto(uF, pF.participante_id, 'pendente', { p_lat: -23.6, p_lng: -46.7 }))), 'pendente com coordenadas: recusado');
  // RLS: metadados só para quem tem acesso à operação
  chk((await como(resp1, `select count(*)::int n from public.fotos where operacao_id = $1`, [opF.id])).rows[0].n === 5, 'responsável da operação lê os metadados das fotos');
  chk((await como(resp2, `select count(*)::int n from public.fotos where operacao_id = $1`, [opF.id])).rows[0].n === 0, 'responsável de outra operação não lê');
  chk((await como(uF2, `select count(*)::int n from public.fotos where operacao_id = $1`, [opF.id])).rows[0].n === 0, 'outro participante não lê as fotos de quem tirou');
  chk((await como(uF, `select count(*)::int n from public.fotos where operacao_id = $1`, [opF.id])).rows[0].n === 5, 'quem tirou vê as próprias fotos');
  chk(/permission denied|row-level/.test(await erroDe(como(uF, `update public.fotos set lat = 1 where operacao_id = $1`, [opF.id]).then((r) => { if (!r.affectedRows) throw new Error('row-level: nada alterado'); }))), 'ninguém altera a tabela direto pelo navegador');
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opF.id });
}

console.log('Diário da operação');
const tipos = async () => (await como(resp1, `select tipo from public.diario where operacao_id = $1`, [op.id])).rows.map((r) => r.tipo);
let td = await tipos();
chk(['operacao_criada', 'acionamento', 'pessoa_entrou', 'grupo_criado', 'ficha_vitima', 'missao_enviada', 'alerta_chegou_setor',
  'alerta_retorno_atrasado', 'alerta_chegou_base', 'alerta_ciente', 'vitima_localizada', 'setor_criado'].every((t) => td.includes(t)),
  'eventos automáticos chegam dos outros módulos (operação, pessoas, grupos, deslocamento, chegadas, alertas, vítima, setores)', td);
const vtx = (await como(resp1, `select titulo, nivel from public.diario where tipo = 'vitima_localizada'`)).rows[0];
chk(vtx && /MORTA/.test(vtx.titulo) && vtx.nivel === 'critico', 'vítima localizada no diário com a condição (só responsáveis leem)', vtx);
const setD = await rpc(resp1, 'salvar_setor', { p_operacao: op.id, p_id: null, p_dados: JSON.stringify({ nome: 'Diario S', forma: 'circulo', centro_lat: -22.9, centro_lng: -43.2, raio_m: 300 }) });
await rpc(resp1, 'salvar_setor', { p_operacao: op.id, p_id: setD.id, p_dados: JSON.stringify({ status: 'andamento' }) });
await rpc(resp1, 'salvar_setor', { p_operacao: op.id, p_id: setD.id, p_dados: JSON.stringify({ status: 'concluido' }) });
td = await tipos();
chk(td.includes('setor_iniciado') && td.includes('setor_concluido'), 'início e fim da varredura do setor registrados pelo banco');
chk((await como(anA, `select count(*)::int n from public.diario`)).rows[0].n === 0, 'participante de campo NÃO lê o diário (RLS)');
chk((await como(resp2, `select count(*)::int n from public.diario where operacao_id = $1`, [op.id])).rows[0].n === 0, 'responsável de outra operação NÃO lê o diário');
const ob = await rpc(resp1, 'diario_adicionar', { p_operacao: op.id, p_ocorrido_em: new Date(Date.now() - 2 * 3600e3).toISOString(), p_texto: 'Chuva forte, buscas na encosta suspensas por 30 min.' });
chk(ob.origem === 'manual' && ob.autor_nome === 'Sgt Um' && Date.parse(ob.ocorrido_em) < Date.now() - 3600e3, 'responsável adiciona observação com data e hora no passado');
chk(/data_invalida/.test(await erroDe(rpc(resp1, 'diario_adicionar', { p_operacao: op.id, p_ocorrido_em: new Date(Date.now() + 3600e3).toISOString(), p_texto: 'x' }))), 'observação com data no futuro: recusada');
chk(/sem_permissao/.test(await erroDe(rpc(anA, 'diario_adicionar', { p_operacao: op.id, p_ocorrido_em: new Date().toISOString(), p_texto: 'x' }))), 'participante não escreve no diário');
await rpc(resp1, 'adicionar_responsavel', { p_operacao: op.id, p_email: 'r2@cbm' }).catch(() => db.query(`insert into public.operacao_responsaveis (operacao_id, user_id) values ($1, $2)`, [op.id, resp2]));
const ed = await rpc(resp2, 'diario_editar', { p_id: ob.id, p_ocorrido_em: ob.ocorrido_em, p_texto: 'Chuva forte: buscas na encosta suspensas por 40 min.' });
chk(ed.versao === 2 && ed.editado_por_nome === 'Sgt Dois' && ed.autor_nome === 'Sgt Um', 'outro responsável da operação edita a observação (autor original mantido)', ed);
const vers = (await como(resp1, `select versao, detalhe, autor_nome, substituida_por_nome from public.diario_versoes where diario_id = $1`, [ob.id])).rows;
chk(vers.length === 1 && /30 min/.test(vers[0].detalhe) && vers[0].substituida_por_nome === 'Sgt Dois', 'versão anterior guardada no histórico', vers);
const idAuto = (await como(resp1, `select id from public.diario where tipo = 'operacao_criada' and operacao_id = $1`, [op.id])).rows[0].id;
chk(/diario_evento_automatico/.test(await erroDe(rpc(resp1, 'diario_editar', { p_id: idAuto, p_ocorrido_em: new Date().toISOString(), p_texto: 'alterado' }))), 'evento automático não é editável');
chk(/permission denied|row-level/.test(await erroDe(como(resp1, `delete from public.diario where id = $1`, [ob.id]))), 'responsável não apaga observação direto na tabela');
chk(/diario_nao_apaga/.test(await erroDe(db.query(`delete from public.diario where id = $1`, [ob.id]))), 'nem o banco apaga linha do diário fora da exclusão da operação');
chk(/diario_somente_funcao|diario_evento_automatico/.test(await erroDe(db.query(`update public.diario set detalhe = 'x' where id = $1`, [idAuto]))), 'nem o banco altera evento automático');

console.log('Resultado e relatório final');
chk(/texto_obrigatorio/.test(await erroDe(rpc(resp1, 'definir_resultado', { p_operacao: op.id, p_resultado: 'outro', p_texto: '' }))), 'resultado "outro" exige texto');
const res = await rpc(resp1, 'definir_resultado', { p_operacao: op.id, p_resultado: 'localizada_obito', p_texto: 'Corpo localizado na encosta norte.' });
chk(res.resultado === 'localizada_obito' && res.resultado_por_nome === 'Sgt Um' && (await tipos()).includes('resultado'), 'resultado registrado e lançado no diário');
const relat = await rpc(resp1, 'relatorio_operacao', { p_operacao: op.id });
chk(relat.operacao.codigo === 'OP TESTE' && relat.operacao.resultado === 'localizada_obito' && relat.diario.length > 10 && relat.setores.length >= 1,
  'relatorio_operacao reúne cadastro, resultado, setores e diário', { d: relat.diario.length, s: relat.setores.length });
const sd = relat.setores.find((s) => s.nome === 'Diario S');
chk(sd && sd.inicio_em && sd.fim_em, 'setor no relatório com início e fim da varredura', sd);
chk(relat.participantes.every((p) => !p.cpf || /^\*\*\*\.\d{3}\.\d{3}-\*\*$/.test(p.cpf)), 'CPF mascarado no relatório', relat.participantes.map((p) => p.cpf));
chk(/sem_permissao/.test(await erroDe(rpc(anA, 'relatorio_operacao', { p_operacao: op.id }))), 'participante NÃO gera relatório');
const opR2 = await rpc(resp2, 'criar_operacao', { p_codigo: 'OP R2', p_retencao_horas: 0 });
const opSoR1 = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP SO R1', p_retencao_horas: 0 });
chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'relatorio_operacao', { p_operacao: opSoR1.id }))), 'responsável comum NÃO gera relatório de operação de outro responsável');
chk((await rpc(resp1, 'relatorio_operacao', { p_operacao: opR2.id })).operacao.codigo === 'OP R2', 'administrador gera relatório de qualquer operação');
const opsAdm = (await como(resp1, `select count(*)::int n from public.operacoes`)).rows[0].n;
const opsResp2 = (await como(resp2, `select count(*)::int n from public.operacoes`)).rows[0].n;
chk(opsAdm >= 3 && opsResp2 < opsAdm, 'administrador lista todas as operações; responsável comum só as que criou ou em que foi adicionado', { opsAdm, opsResp2 });
console.log('Excluir responsável (migração 017)');
const resp3 = await usuario('r3@cbm', false);
await db.query(`insert into public.responsaveis (user_id, nome) values ($1, 'Sgt Tres')`, [resp3]);
chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'admin_excluir_responsavel', { p_user: resp3 }))), 'responsável comum NÃO exclui outro responsável');
chk(/nao_pode_alterar_a_si/.test(await erroDe(rpc(resp1, 'admin_excluir_responsavel', { p_user: resp1 }))), 'administrador não exclui a si mesmo');
chk(/responsavel_com_registros/.test(await erroDe(rpc(resp1, 'admin_excluir_responsavel', { p_user: resp2 }))), 'responsável que criou operação NÃO é excluído (o histórico ficaria órfão)');
chk((await db.query(`select count(*)::int n from public.responsaveis where user_id = $1`, [resp2])).rows[0].n === 1, 'o cadastro recusado continua existindo');
const listaSemTres = await rpc(resp1, 'admin_excluir_responsavel', { p_user: resp3 });
chk(!listaSemTres.some((r) => r.user_id === resp3) && listaSemTres.some((r) => r.user_id === resp1), 'administrador exclui responsável sem histórico e recebe a lista atualizada', listaSemTres.map((r) => r.nome));
chk(/responsavel_nao_encontrado/.test(await erroDe(rpc(resp1, 'admin_excluir_responsavel', { p_user: resp3 }))), 'excluir de novo: responsável não encontrado');
chk(/permission denied/.test(await erroDe(como(null, `select public.admin_excluir_responsavel($1)`, [resp2], 'anon'))), 'visitante anônimo não executa a exclusão');
console.log('Pedido de acesso de responsável (migração 018)');
const pedinte = await usuario('pedinte@cbm', false);
await como(null, `select public.servidor_criar_solicitacao($1, $2, $3)`, [pedinte, 'Cb Novato', 'pedinte@cbm'], 'service_role');
const solId = (await db.query(`select id from public.solicitacoes_responsavel where user_id = $1`, [pedinte])).rows[0].id;
chk(/permission denied/.test(await erroDe(como(resp1, `select public.servidor_criar_solicitacao($1, $2, $3)`, [pedinte, 'X', 'x@x']))), 'pedido de acesso só é criado pelo servidor (chave secreta)');
chk(/permission denied/.test(await erroDe(como(pedinte, `select count(*) from public.solicitacoes_responsavel`))), 'quem pede acesso não lê a tabela de pedidos');
chk((await rpc(pedinte, 'meu_status_acesso', {})).status === 'pendente', 'pedido recém-enviado fica pendente, sem acesso', await rpc(pedinte, 'meu_status_acesso', {}));
chk((await rpc(anA, 'meu_status_acesso', {})).status === 'sem_pedido', 'visitante sem pedido recebe sem_pedido');
chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'admin_listar_solicitacoes', {}))), 'responsável comum não vê os pedidos');
chk((await rpc(resp1, 'admin_listar_solicitacoes', {})).some((x) => x.nome === 'Cb Novato'), 'administrador vê o pedido pendente');
chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'admin_decidir_solicitacao', { p_id: solId, p_aprovar: true }))), 'responsável comum não aprova pedido');
chk(/permission denied/.test(await erroDe(como(null, `select public.meu_status_acesso()`, [], 'anon'))), 'visitante anônimo não consulta status de acesso');
const recusou = await rpc(resp1, 'admin_decidir_solicitacao', { p_id: solId, p_aprovar: false });
chk(!recusou.some((x) => x.nome === 'Cb Novato'), 'recusar tira o pedido da lista de pendentes');
chk((await rpc(pedinte, 'meu_status_acesso', {})).status === 'recusada', 'pedido recusado: status recusada, sem acesso');
chk((await db.query(`select count(*)::int n from public.responsaveis where user_id = $1`, [pedinte])).rows[0].n === 0, 'pedido recusado não cria responsável');
await rpc(resp1, 'admin_decidir_solicitacao', { p_id: solId, p_aprovar: true });
const apr = (await db.query(`select nome, admin, ativo from public.responsaveis where user_id = $1`, [pedinte])).rows[0];
chk(apr && apr.nome === 'Cb Novato' && apr.admin === false && apr.ativo === true, 'aprovação cria responsável comum e ativo (sem administrador)', apr);
chk((await rpc(pedinte, 'meu_status_acesso', {})).status === 'ativo', 'depois da aprovação o status é ativo');
chk(/solicitacao_ja_decidida/.test(await erroDe(rpc(resp1, 'admin_decidir_solicitacao', { p_id: solId, p_aprovar: false }))), 'pedido já aprovado não muda de decisão');
console.log('IPO da operação (migração 019)');
const ipoDados = { destinatarios: '2 CRBM / 3 BBM', natureza: 'BUSCA TERRESTRE/AQUÁTICA – PESSOA', meio_liquido: 'lago', pessoas_perdidas: 1, procedimentos: ['scuba'] };
const ipoSalvo = await rpc(resp1, 'salvar_ipo_operacao', { p_operacao: opSoR1.id, p_ipo: ipoDados });
chk(ipoSalvo.ipo.meio_liquido === 'lago' && ipoSalvo.ipo.procedimentos[0] === 'scuba', 'o responsável salva o IPO da operação');
chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'salvar_ipo_operacao', { p_operacao: opSoR1.id, p_ipo: { natureza: 'x' } }))), 'responsável que não é dono não altera o IPO');
chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'salvar_ipo_operacao', { p_operacao: opSoR1.id, p_ipo: ['lista'] }))), 'IPO que não é um objeto é recusado');
chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'salvar_ipo_operacao', { p_operacao: opSoR1.id, p_ipo: { texto: 'x'.repeat(31000) } }))), 'IPO grande demais é recusado');
const relIpo = await rpc(resp1, 'relatorio_operacao', { p_operacao: opSoR1.id });
chk(relIpo.operacao.ipo && relIpo.operacao.ipo.natureza === 'BUSCA TERRESTRE/AQUÁTICA – PESSOA', 'o relatório devolve os dados do IPO');
console.log('IPO no cadastro (migração 021)');
const ipoAgora = new Date(Date.now() - 3600e3).toISOString();
const opIpo = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP IPO CADASTRO', p_retencao_horas: 0, p_dados: JSON.stringify({ tipo: 'aquatica', acionado_em: ipoAgora, local_endereco: 'Represa privada', descricao: 'Contexto do caso',
  ipo: { destinatarios: '2 CRBM / 3 BBM', natureza: 'BUSCA AQUÁTICA – PESSOA', meio_liquido: 'lago', pessoas_perdidas: 1, bms_envolvidos: 5 } }) });
chk(opIpo.ipo.natureza === 'BUSCA AQUÁTICA – PESSOA' && opIpo.ipo.bms_envolvidos === 5 && opIpo.local_endereco === 'Represa privada', 'criar com o IPO grava o IPO e o endereço no cadastro', opIpo.ipo);
chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'criar_operacao', { p_codigo: 'OP IPO RUIM', p_retencao_horas: 0, p_dados: JSON.stringify({ tipo: 'aquatica', acionado_em: ipoAgora, ipo: ['x'] }) }))), 'IPO que não é objeto: recusado ao criar');
const ipoTroca = await rpc(resp1, 'atualizar_operacao', { p_operacao: opIpo.id, p_dados: JSON.stringify({ ipo: { natureza: 'BUSCA AQUÁTICA 2' } }) });
chk(ipoTroca.ipo.natureza === 'BUSCA AQUÁTICA 2', 'editar o cadastro troca o IPO');
const ipoMantem = await rpc(resp1, 'atualizar_operacao', { p_operacao: opIpo.id, p_dados: JSON.stringify({ descricao: 'Contexto novo' }) });
chk(ipoMantem.ipo.natureza === 'BUSCA AQUÁTICA 2' && ipoMantem.descricao === 'Contexto novo', 'editar outro campo do cadastro mantém o IPO');
chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'atualizar_operacao', { p_operacao: opIpo.id, p_dados: JSON.stringify({ ipo: { natureza: 'x' } }) }))), 'responsável de outra operação não altera o IPO pelo cadastro');

const vitIpo = await rpc(resp1, 'salvar_vitima', { p_operacao: opIpo.id, p_id: null, p_dados: JSON.stringify({ nome: 'Eduardo Dias', idade: 18, nascimento: '29/10/2008', sexo: 'M', origem: 'Bandeirantes' }) });
chk(vitIpo.sexo === 'M' && vitIpo.nascimento === '29/10/2008' && vitIpo.origem === 'Bandeirantes', 'ficha de vítima guarda nascimento, sexo e origem (vítima do IPO)', vitIpo);
chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'salvar_vitima', { p_operacao: opIpo.id, p_id: vitIpo.id, p_dados: JSON.stringify({ sexo: 'X' }) }))), 'sexo fora de M/F: recusado');
const vitEd = await rpc(resp1, 'salvar_vitima', { p_operacao: opIpo.id, p_id: vitIpo.id, p_dados: JSON.stringify({ origem: 'Andirá' }) });
chk(vitEd.origem === 'Andirá' && vitEd.sexo === 'M', 'editar a ficha mantém sexo e nascimento');

const dIpo = (tipo, chave, texto, quando) => rpc(resp1, 'diario_registrar_ipo', { p_operacao: opIpo.id, p_ocorrido_em: quando || ipoAgora, p_tipo: tipo, p_chave: chave, p_texto: texto });
const procScuba = await dIpo('procedimento', 'scuba', 'Mergulho no ponto do sonar');
chk(procScuba.tipo === 'procedimento' && procScuba.ref_id === 'scuba' && procScuba.categoria === 'operacao' && procScuba.origem === 'manual', 'procedimento de busca entra no diário com a chave', procScuba);
chk(/procedimento_invalido/.test(await erroDe(dIpo('procedimento', 'drone', 'x'))), 'procedimento fora da lista: recusado');
chk(/texto_obrigatorio/.test(await erroDe(dIpo('recurso', null, '   '))), 'recurso sem descrição: recusado');
chk(/tipo_invalido/.test(await erroDe(dIpo('outro', null, 'x'))), 'tipo desconhecido: recusado');
chk(/data_invalida/.test(await erroDe(dIpo('desdobramento', null, 'Dia 1', new Date(Date.now() + 3 * 3600e3).toISOString()))), 'desdobramento no futuro: recusado');
const recIpo = await dIpo('recurso', null, 'ABS 0015/3º BBM');
const desIpo = await dIpo('desdobramento', null, 'Dia 1 - busca terrestre em solo');
chk(recIpo.tipo === 'recurso' && desIpo.tipo === 'desdobramento', 'recurso e desdobramento entram no diário');
chk(/sem_permissao/.test(await erroDe(rpc(anA, 'diario_registrar_ipo', { p_operacao: opIpo.id, p_ocorrido_em: ipoAgora, p_tipo: 'recurso', p_chave: null, p_texto: 'x' }))), 'participante não registra recurso no diário');
const relIpo2 = await rpc(resp1, 'relatorio_operacao', { p_operacao: opIpo.id });
chk(relIpo2.diario.some((d) => d.tipo === 'procedimento' && d.ref_id === 'scuba') && relIpo2.vitimas.some((v) => v.sexo === 'M' && v.origem === 'Andirá'), 'relatório traz procedimentos (com chave) e as vítimas com o IPO', { d: relIpo2.diario.length, v: relIpo2.vitimas });
const relEd = await rpc(resp1, 'diario_editar', { p_id: procScuba.id, p_ocorrido_em: ipoAgora, p_texto: 'Mergulho SCUBA, 2º ponto' });
chk(relEd.ref_id === 'scuba' && relEd.tipo === 'procedimento' && relEd.detalhe === 'Mergulho SCUBA, 2º ponto', 'procedimento editado mantém a chave e o tipo');

const pdfCam = op.id + '/44444444-4444-4444-8444-444444444444.pdf';

chk(/arquivo_nao_enviado/.test(await erroDe(rpc(resp1, 'registrar_relatorio', { p_operacao: op.id, p_caminho: pdfCam, p_paginas: 12, p_bytes: 1000, p_sha256: 'a'.repeat(64) }))), 'registrar relatório sem o PDF no Storage: recusado');
chk(/row-level security/.test(await erroDe(como(anA, `insert into storage.objects (bucket_id, name) values ('relatorios', $1)`, [pdfCam]))), 'participante não envia PDF ao bucket relatorios');
await como(resp1, `insert into storage.objects (bucket_id, name) values ('relatorios', $1)`, [pdfCam]);
const rr = await rpc(resp1, 'registrar_relatorio', { p_operacao: op.id, p_caminho: pdfCam, p_paginas: 12, p_bytes: 1000, p_sha256: 'a'.repeat(64) });
chk(rr.gerado_por_nome === 'Sgt Um' && (await tipos()).includes('relatorio_gerado'), 'relatório registrado e lançado no diário');
chk((await como(anA, `select count(*)::int n from storage.objects where bucket_id = 'relatorios'`)).rows[0].n === 0, 'participante não vê o PDF');
chk(/permission denied|row-level/.test(await erroDe(como(resp1, `delete from storage.objects where bucket_id = 'relatorios'`).then((r) => { if (!r.affectedRows) throw new Error('row-level: nada apagado'); }))), 'PDF do relatório não pode ser apagado pelo app');
chk(/relatorio_nao_apaga/.test(await erroDe(db.query(`delete from public.relatorios where id = $1`, [rr.id]))), 'registro do relatório não pode ser apagado');
const opComAtividade = await rpc(resp2, 'criar_operacao', { p_codigo: 'OP COM ATIVIDADE', p_retencao_horas: 0 });
const pdfAtividade = opComAtividade.id + '/55555555-5555-4555-8555-555555555555.pdf';
await db.query(`insert into public.relatorios (operacao_id, caminho, paginas, bytes, sha256, gerado_por_nome) values ($1, $2, 1, 10, $3, 'Sgt Dois')`, [opComAtividade.id, pdfAtividade, 'b'.repeat(64)]);
// Migração 041: quem criou exclui mesmo com atividade (antes: "operacao_com_registros")
const opCriador = await rpc(resp2, 'criar_operacao', { p_codigo: 'OP DO CRIADOR', p_retencao_horas: 0 });
const pdfCriador = opCriador.id + '/77777777-7777-4777-8777-777777777777.pdf';
await db.query(`insert into public.relatorios (operacao_id, caminho, paginas, bytes, sha256, gerado_por_nome) values ($1, $2, 1, 10, $3, 'Sgt Dois')`, [opCriador.id, pdfCriador, 'd'.repeat(64)]);
await rpc(resp2, 'diario_adicionar', { p_operacao: opCriador.id, p_ocorrido_em: new Date(Date.now() - 60e3).toISOString(), p_texto: 'Busca na encosta.' });
chk(/sem_permissao/.test(await erroDe(rpc(anA, 'excluir_operacao', { p_operacao: opCriador.id })) || ''), 'participante não exclui a operação');
const excCriador = await rpc(resp2, 'excluir_operacao', { p_operacao: opCriador.id });
chk(excCriador.operacao === 'OP DO CRIADOR', 'criador que não é administrador exclui operação com relatório e diário', excCriador);
chk((await db.query(`select (select count(*) from public.operacoes where id = $1)::int o, (select count(*) from public.diario where operacao_id = $1)::int d, (select count(*) from public.relatorios where operacao_id = $1)::int r`, [opCriador.id])).rows[0].o === 0, 'a operação do criador sai do banco com diário e relatórios');
chk((await db.query(`select bucket from public.arquivos_pendentes where caminho = $1`, [pdfCriador])).rows[0]?.bucket === 'relatorios', 'o PDF da operação excluída pelo criador entra na fila do Storage');

console.log('Administrador exclui relatório (migração 024)');
const caminhoRel = opSoR1.id + '/66666666-6666-4666-8666-666666666666.pdf';
await db.query(`insert into public.relatorios (operacao_id, caminho, paginas, bytes, sha256, gerado_por_nome) values ($1, $2, 1, 10, $3, 'Sgt Um')`, [opSoR1.id, caminhoRel, 'c'.repeat(64)]);
const idRel = (await db.query(`select id from public.relatorios where caminho = $1`, [caminhoRel])).rows[0].id;
chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'excluir_relatorio', { p_relatorio: idRel }))), 'responsável comum não exclui relatório');
chk(/sem_permissao/.test(await erroDe(rpc(anA, 'excluir_relatorio', { p_relatorio: idRel }))), 'participante não exclui relatório');
chk(/relatorio_nao_apaga/.test(await erroDe(db.query(`delete from public.relatorios where id = $1`, [idRel]))), 'exclusão direta do registro continua bloqueada');
const exRel = await rpc(resp1, 'excluir_relatorio', { p_relatorio: idRel });
chk(exRel.id === idRel, 'administrador exclui o relatório', exRel);
chk((await db.query(`select count(*)::int n from public.relatorios where id = $1`, [idRel])).rows[0].n === 0, 'o relatório sai da lista');
const filaRel = (await db.query(`select bucket, excluido_por from public.arquivos_pendentes where caminho = $1`, [caminhoRel])).rows[0];
chk(filaRel && filaRel.bucket === 'relatorios' && filaRel.excluido_por === null, 'o PDF entra na fila de limpeza do Storage', filaRel);
chk((await db.query(`select count(*)::int n from public.diario where operacao_id = $1 and tipo = 'relatorio_excluido'`, [opSoR1.id])).rows[0].n === 1, 'a exclusão fica registrada no diário');
chk(/relatorio_nao_encontrado/.test(await erroDe(rpc(resp1, 'excluir_relatorio', { p_relatorio: idRel }))), 'excluir de novo: relatório não encontrado');

console.log('Perfil da vítima e estudos (migração 023)');
const fichaPerfil = await rpc(resp1, 'salvar_vitima', { p_operacao: op.id, p_id: null, p_dados: JSON.stringify({ nome: 'Idosa Teste', idade: 81, perfil: ['idoso', 'demencia'] }) });
chk(fichaPerfil.perfil.includes('idoso') && fichaPerfil.perfil.length === 2, 'ficha guarda o perfil', fichaPerfil.perfil);
chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'salvar_vitima', { p_operacao: op.id, p_id: null, p_dados: JSON.stringify({ nome: 'X', perfil: ['zumbi'] }) }))), 'perfil fora da lista: recusado');
chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'salvar_vitima', { p_operacao: op.id, p_id: null, p_dados: JSON.stringify({ nome: 'X', perfil: 'idoso' }) }))), 'perfil que não é lista: recusado');
const perfilEd = await rpc(resp1, 'salvar_vitima', { p_operacao: op.id, p_id: fichaPerfil.id, p_dados: JSON.stringify({ origem: 'Andirá' }) });
chk(perfilEd.perfil.length === 2, 'editar a ficha sem o perfil mantém o perfil', perfilEd.perfil);
const estOp = await rpc(resp1, 'estudo_operacao', { p_operacao: op.id });
chk(estOp.localizacao && typeof estOp.localizacao.distancia_km === 'number' && estOp.localizacao.distancia_km >= 0, 'estudo da operação: distância do ULV à primeira localização', estOp.localizacao);
chk(estOp.perfis.idoso >= 1 && estOp.perfis.demencia >= 1, 'estudo da operação conta os perfis', estOp.perfis);
chk(!/Idosa Teste|cpf|telefone/i.test(JSON.stringify(estOp)), 'estudo da operação não traz nomes nem dados pessoais');
chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'estudo_operacao', { p_operacao: opSoR1.id }))), 'responsável de outra operação não vê o estudo da operação');
const estGeral = await rpc(resp1, 'estudo_geral', {});
chk(estGeral.operacoes.total >= 3, 'estudo geral conta as operações do administrador', estGeral.operacoes);
chk(estGeral.distancia_km.mediana === null && estGeral.distancia_km.casos === null, 'com menos de 5 casos, a mediana fica oculta', estGeral.distancia_km);
chk(estGeral.perfis.every((p) => p.fichas === null && p.mediana_km === null), 'perfis com menos de 5 fichas aparecem ocultos', estGeral.perfis);
chk(!/Idosa Teste|cpf/i.test(JSON.stringify(estGeral)), 'estudo geral não traz nomes');
chk(/permission denied/.test(await erroDe(como(null, `select public.estudo_geral()`, [], 'anon'))), 'anônimo não vê o estudo geral');

console.log('Operação encerrada: somente leitura (migração 026)');
{
  const opE = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP SO LEITURA', p_retencao_horas: 24, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  const uE1 = await usuario(null, true);
  const pE = await rpc(uE1, 'ingressar', { p_token: opE.token_militar, p_nome: 'Cb Leitura', p_tipo: 'militar', p_cpf: cpf, p_telefone: tel });
  const sE = await rpc(resp1, 'salvar_setor', { p_operacao: opE.id, p_id: null, p_dados: JSON.stringify({ nome: 'S1', forma: 'circulo', centro_lat: -22.9, centro_lng: -43.2, raio_m: 200 }) });
  const ptE = await rpc(resp1, 'salvar_ponto', { p_operacao: opE.id, p_id: null, p_dados: JSON.stringify({ categoria: 'OUTRO', titulo: 'P1', lat: -22.9, lng: -43.2 }) });
  const gE = await rpc(resp1, 'salvar_grupo', { p_operacao: opE.id, p_id: null, p_dados: JSON.stringify({ nome: 'G' }) });
  await rpc(resp1, 'definir_membro', { p_grupo: gE.id, p_participante: pE.participante_id, p_papel: 'membro' });
  const vE = await rpc(resp1, 'salvar_vitima', { p_operacao: opE.id, p_id: null, p_dados: JSON.stringify({ nome: 'Fulano' }) });
  const obE = await rpc(resp1, 'diario_adicionar', { p_operacao: opE.id, p_ocorrido_em: new Date().toISOString(), p_texto: 'antes de encerrar' });
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opE.id });
  const bloqueado = async (rot, p) => chk(/operacao_encerrada/.test(await erroDe(p) || ''), 'encerrada: ' + rot + ' é recusado');
  await bloqueado('editar setor', rpc(resp1, 'salvar_setor', { p_operacao: opE.id, p_id: sE.id, p_dados: JSON.stringify({ status: 'concluido' }) }));
  await bloqueado('criar setor', rpc(resp1, 'salvar_setor', { p_operacao: opE.id, p_id: null, p_dados: JSON.stringify({ nome: 'S2', forma: 'circulo', centro_lat: -22.9, centro_lng: -43.2, raio_m: 200 }) }));
  await bloqueado('excluir setor', rpc(resp1, 'excluir_setor', { p_id: sE.id }));
  await bloqueado('excluir ponto', rpc(resp1, 'excluir_ponto', { p_id: ptE.id }));
  await bloqueado('excluir grupo', rpc(resp1, 'excluir_grupo', { p_id: gE.id }));
  await bloqueado('tirar membro do grupo', rpc(resp1, 'remover_membro', { p_grupo: gE.id, p_participante: pE.participante_id }));
  await bloqueado('excluir ficha da vítima', rpc(resp1, 'excluir_vitima', { p_id: vE.id }));
  await bloqueado('adicionar responsável', rpc(resp1, 'adicionar_responsavel', { p_operacao: opE.id, p_email: 'r2@cbm' }));
  await bloqueado('anotação no diário', rpc(resp1, 'diario_adicionar', { p_operacao: opE.id, p_ocorrido_em: new Date().toISOString(), p_texto: 'depois' }));
  await bloqueado('editar anotação do diário', rpc(resp1, 'diario_editar', { p_id: obE.id, p_ocorrido_em: new Date().toISOString(), p_texto: 'mudou' }));
  await bloqueado('editar o cadastro', rpc(resp1, 'atualizar_operacao', { p_operacao: opE.id, p_dados: JSON.stringify({ descricao: 'mudou' }) }));
  await bloqueado('editar o IPO', rpc(resp1, 'salvar_ipo_operacao', { p_operacao: opE.id, p_ipo: JSON.stringify({ natureza: 'X' }) }));
  await bloqueado('remover participante', rpc(resp1, 'remover_participante', { p_participante: pE.participante_id }));
  const contE = (await db.query(`select (select count(*) from public.setores where operacao_id=$1)::int s, (select count(*) from public.pontos_interesse where operacao_id=$1)::int p,
    (select count(*) from public.grupo_membros where operacao_id=$1)::int m, (select count(*) from public.vitimas where operacao_id=$1)::int v,
    (select descricao from public.operacoes where id=$1) d`, [opE.id])).rows[0];
  chk(contE.s === 1 && contE.p === 1 && contE.m === 1 && contE.v === 1 && contE.d === '', 'nada foi alterado', contE);
  chk((await como(resp1, `select count(*)::int n from public.setores where operacao_id = $1`, [opE.id])).rows[0].n === 1, 'responsável continua vendo os dados da operação encerrada');
  const resE = await rpc(resp1, 'definir_resultado', { p_operacao: opE.id, p_resultado: 'nao_localizada', p_texto: '' });
  chk(resE.resultado === 'nao_localizada', 'encerrada: o resultado da operação continua podendo ser registrado', resE);
  chk((await db.query(`select count(*)::int n from public.diario where operacao_id = $1 and tipo = 'resultado'`, [opE.id])).rows[0].n === 1, 'e o evento automático do resultado entra no diário');
  chk(/apagar_dados_desativado/.test(await erroDe(rpc(resp1, 'apagar_dados_operacao', { p_operacao: opE.id })) || ''), 'encerrada: "apagar dados" está desativado (migração 027)');
  const depE = (await db.query(`select (select count(*) from public.setores where operacao_id=$1)::int s, (select count(*) from public.grupos where operacao_id=$1)::int g,
    (select count(*) from public.vitimas where operacao_id=$1)::int v, (select dados_apagados_em from public.operacoes where id=$1) a`, [opE.id])).rows[0];
  chk(depE.s === 1 && depE.g === 1 && depE.v === 1 && depE.a === null, 'encerrada: os dados continuam guardados', depE);
  const opZ = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP RETENCAO ZERO', p_retencao_horas: 0, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  const uZ = await usuario(null, true);
  const pZ = await rpc(uZ, 'ingressar', { p_token: opZ.token_militar, p_nome: 'Sd Zero', p_tipo: 'militar', p_cpf: cpf, p_telefone: tel });
  const gZ = await rpc(resp1, 'salvar_grupo', { p_operacao: opZ.id, p_id: null, p_dados: JSON.stringify({ nome: 'GZ' }) });
  await rpc(resp1, 'definir_membro', { p_grupo: gZ.id, p_participante: pZ.participante_id, p_papel: 'membro' });
  await rpc(resp1, 'salvar_setor', { p_operacao: opZ.id, p_id: null, p_dados: JSON.stringify({ nome: 'SZ', forma: 'circulo', centro_lat: -22.9, centro_lng: -43.2, raio_m: 200 }) });
  const encZ = await rpc(resp1, 'encerrar_operacao', { p_operacao: opZ.id });
  const ficaZ = (await db.query(`select (select count(*) from public.participantes where operacao_id=$1)::int p, (select count(*) from public.grupo_membros where operacao_id=$1)::int m,
    (select count(*) from public.setores where operacao_id=$1)::int s`, [opZ.id])).rows[0];
  chk(encZ.status === 'encerrada' && !encZ.dados_apagados_em && encZ.expira_em === null && ficaZ.p === 1 && ficaZ.m === 1 && ficaZ.s === 1,
    'encerrar não apaga nada, nem a operação antiga com "apagar ao encerrar" (migração 027)', { encZ, ficaZ });
  const exZ = await rpc(resp1, 'excluir_operacao', { p_operacao: opZ.id });
  chk(exZ.operacao === 'OP RETENCAO ZERO', 'excluir operação encerrada continua funcionando', exZ);
}

console.log('Trilhas desenhadas à mão (migração 028)');
{
  const pubT = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`)).rows.map((r) => r.tablename);
  chk(pubT.includes('trilhas_manuais') && pubT.includes('operacoes'), 'trilhas e operações publicadas no Realtime (painel e mapa do dashboard)', pubT);
  const opT = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP TRILHAS', p_retencao_horas: 0, p_dados: JSON.stringify({ tipo: 'terrestre', local_lat: -23.44, local_lng: -51.25 }) });
  const uT = await usuario(null, true);
  const pT = await rpc(uT, 'ingressar', { p_token: opT.token_militar, p_nome: 'Sd Trilha', p_tipo: 'militar', p_cpf: cpf, p_telefone: tel });
  const gT = await rpc(resp1, 'salvar_grupo', { p_operacao: opT.id, p_id: null, p_dados: JSON.stringify({ nome: 'Alfa' }) });
  const sT = await rpc(resp1, 'salvar_setor', { p_operacao: opT.id, p_id: null, p_dados: JSON.stringify({ nome: 'S1', forma: 'poligono', pontos: [[-23.44, -51.25], [-23.44, -51.24], [-23.45, -51.24]] }) });
  const pontos = [[-23.4401, -51.2501], [-23.4405, -51.2490], [-23.4399, -51.2480], [-23.4410, -51.2475], [-23.4420, -51.2481]];
  const cid = '7c1d2b8e-4f1a-4c3e-9b2a-1a2b3c4d5e6f';
  const t1 = await rpc(resp1, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: null, p_dados: JSON.stringify({
    client_id: cid, nome: 'Margem do córrego', estado: 'planejada', pontos, grupo_id: gT.id, participante_id: pT.participante_id, observacoes: 'Ida pela margem esquerda' }) });
  chk(t1.estado === 'planejada' && t1.percorrida_em === null && t1.criado_por_nome === 'Sgt Um' && t1.grupo_id === gT.id, 'cria trilha planejada (salvar não marca como percorrida)', t1);
  chk(JSON.stringify(t1.pontos) === JSON.stringify(pontos), 'os pontos ficam na ordem em que foram marcados');
  chk(t1.comprimento_m > 300 && t1.comprimento_m < 600, 'comprimento calculado pelo servidor (m)', t1.comprimento_m);
  const t1b = await rpc(resp1, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: null, p_dados: JSON.stringify({ client_id: cid, nome: 'Margem do córrego', estado: 'planejada', pontos }) });
  const nT = async () => (await db.query(`select count(*)::int n from public.trilhas_manuais where operacao_id = $1`, [opT.id])).rows[0].n;
  chk(t1b.id === t1.id && await nT() === 1, 'reenviar o mesmo desenho (mesmo client_id) não duplica');
  chk(/nome_repetido/.test(await erroDe(rpc(resp1, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: null, p_dados: JSON.stringify({
    client_id: '8c1d2b8e-4f1a-4c3e-9b2a-1a2b3c4d5e6f', nome: 'MARGEM DO CÓRREGO', estado: 'planejada', pontos }) })) || ''), 'nome repetido na mesma operação: recusado');
  chk(/trilha_invalida/.test(await erroDe(rpc(resp1, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: null, p_dados: JSON.stringify({
    client_id: '9c1d2b8e-4f1a-4c3e-9b2a-1a2b3c4d5e6f', nome: 'Um ponto só', estado: 'planejada', pontos: [[-23.44, -51.25]] }) })) || ''), 'linha com 1 ponto: recusada');
  chk(/trilha_invalida/.test(await erroDe(rpc(resp1, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: null, p_dados: JSON.stringify({
    client_id: '9c1d2b8e-4f1a-4c3e-9b2a-1a2b3c4d5e6f', nome: 'Fora do mundo', estado: 'planejada', pontos: [[-23.44, -51.25], [95, -51.2]] }) })) || ''), 'coordenada inválida: recusada');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: null, p_dados: JSON.stringify({
    client_id: '9c1d2b8e-4f1a-4c3e-9b2a-1a2b3c4d5e6f', nome: 'Sem estado', pontos }) })) || ''), 'sem informar planejada/percorrida: recusado');
  chk(/responsavel_trajeto_invalido/.test(await erroDe(rpc(resp1, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: t1.id, p_dados: JSON.stringify({ participante_id: pA.participante_id }) })) || ''), 'participante de outra operação: recusado');
  chk(/grupo_invalido/.test(await erroDe(rpc(resp1, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: t1.id, p_dados: JSON.stringify({ grupo_id: g.id }) })) || ''), 'grupo de outra operação: recusado');
  chk(/data_invalida/.test(await erroDe(rpc(resp1, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: t1.id, p_dados: JSON.stringify({ estado: 'percorrida', percorrida_em: new Date(Date.now() + 3600e3).toISOString() }) })) || ''), 'percorrida no futuro: recusada');
  chk((await como(resp2, `select count(*)::int n from public.trilhas_manuais`)).rows[0].n === 0, 'responsável de outra operação não lê as trilhas');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: t1.id, p_dados: JSON.stringify({ nome: 'Invasão' }) })) || ''), 'responsável de outra operação não altera');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'excluir_trilha_manual', { p_id: t1.id })) || ''), 'responsável de outra operação não exclui');
  chk(/sem_permissao/.test(await erroDe(rpc(uT, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: t1.id, p_dados: JSON.stringify({ nome: 'X' }) })) || ''), 'participante (celular) não altera trilhas');
  chk(/permission denied/.test(await erroDe(como(resp1, `insert into public.trilhas_manuais (operacao_id, client_id, nome, estado, pontos, criado_por_nome) values ($1, gen_random_uuid(), 'Direto', 'planejada', '[[0,1],[1,1]]', 'x')`, [opT.id])) || ''), 'gravação direta na tabela: bloqueada (só pela função)');
  const novos = [[-23.4401, -51.2501], [-23.4430, -51.2470]];
  const t1c = await rpc(resp1, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: t1.id, p_dados: JSON.stringify({ pontos: novos.concat([[-23.4440, -51.2460]]), nome: 'Margem do córrego (trecho 1)' }) });
  chk(t1c.pontos.length === 3 && t1c.estado === 'planejada' && t1c.observacoes === 'Ida pela margem esquerda', 'editar o traçado e o nome mantém os outros campos', t1c);
  const quando = new Date(Date.now() - 1800e3).toISOString();
  const t1d = await rpc(resp1, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: t1.id, p_dados: JSON.stringify({ estado: 'percorrida', percorrida_em: quando }) });
  chk(t1d.estado === 'percorrida' && Math.abs(new Date(t1d.percorrida_em) - new Date(quando)) < 1000 && t1d.percorrida_por_nome === 'Sgt Um', 'marcar como percorrida guarda quando e quem informou', t1d);
  chk((await db.query(`select count(*)::int n from public.diario where operacao_id = $1 and tipo = 'trilha_percorrida'`, [opT.id])).rows[0].n === 1, 'trajeto percorrido entra no diário');
  const t1e = await rpc(resp1, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: t1.id, p_dados: JSON.stringify({ estado: 'planejada' }) });
  chk(t1e.estado === 'planejada' && t1e.percorrida_em === null, 'voltar para planejada limpa o horário de percurso', t1e);
  const t2 = await rpc(resp1, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: null, p_dados: JSON.stringify({
    client_id: 'ac1d2b8e-4f1a-4c3e-9b2a-1a2b3c4d5e6f', nome: 'Picada norte', estado: 'percorrida', pontos: [[-23.43, -51.25], [-23.431, -51.251], [-23.432, -51.249]] }) });
  chk(t2.estado === 'percorrida' && t2.percorrida_em, 'criar já como percorrida (escolha do usuário): horário = agora', t2);
  const sDepois = (await db.query(`select status, pontos from public.setores where id = $1`, [sT.id])).rows[0];
  chk(sDepois.status === 'pendente' && JSON.stringify(sDepois.pontos) === JSON.stringify(sT.pontos), 'trilhas não mudam setores (nem a situação do setor)', sDepois);
  await rpc(resp1, 'excluir_trilha_manual', { p_id: t2.id });
  const fica = (await db.query(`select (select count(*) from public.trilhas_manuais where operacao_id=$1)::int t, (select count(*) from public.setores where operacao_id=$1)::int s,
    (select count(*) from public.participantes where operacao_id=$1)::int p, (select count(*) from public.grupos where operacao_id=$1)::int g`, [opT.id])).rows[0];
  chk(fica.t === 1 && fica.s === 1 && fica.p === 1 && fica.g === 1, 'excluir uma trilha apaga só ela', fica);
  chk((await db.query(`select count(*)::int n from public.diario where operacao_id = $1 and tipo = 'trilha_excluida'`, [opT.id])).rows[0].n === 1, 'exclusão registrada no diário');
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opT.id });
  chk((await como(resp1, `select count(*)::int n from public.trilhas_manuais where operacao_id = $1`, [opT.id])).rows[0].n === 1, 'encerrada: as trilhas continuam visíveis');
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: t1.id, p_dados: JSON.stringify({ nome: 'Depois' }) })) || ''), 'encerrada: não edita trilha');
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'salvar_trilha_manual', { p_operacao: opT.id, p_id: null, p_dados: JSON.stringify({
    client_id: 'bc1d2b8e-4f1a-4c3e-9b2a-1a2b3c4d5e6f', nome: 'Nova', estado: 'planejada', pontos }) })) || ''), 'encerrada: não cria trilha');
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'excluir_trilha_manual', { p_id: t1.id })) || ''), 'encerrada: não exclui trilha');
  await rpc(resp1, 'excluir_operacao', { p_operacao: opT.id });
  chk((await db.query(`select count(*)::int n from public.trilhas_manuais where operacao_id = $1`, [opT.id])).rows[0].n === 0, 'excluir a operação apaga as trilhas dela');
}

console.log('Nomes no painel e CPF opcional (migração 029)');
{
  const opN = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP NOMES', p_retencao_horas: 0, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  const u1 = await usuario(null, true), u2 = await usuario(null, true), u3 = await usuario(null, true);
  const semCpf = await rpc(u1, 'ingressar', { p_token: opN.token_civil, p_nome: 'Civil Sem Documento', p_tipo: 'civil', p_cpf: null, p_telefone: tel });
  chk(semCpf.participante_id && semCpf.tipo === 'civil', 'civil entra sem CPF', semCpf);
  chk(/cpf_invalido/.test(await erroDe(rpc(u2, 'ingressar', { p_token: opN.token_civil, p_nome: 'Civil CPF Errado', p_tipo: 'civil', p_cpf: '12345678900', p_telefone: tel }))), 'CPF informado e inválido: recusado');
  chk(/telefone_invalido/.test(await erroDe(rpc(u2, 'ingressar', { p_token: opN.token_civil, p_nome: 'Civil Sem Celular', p_tipo: 'civil', p_cpf: null, p_telefone: null }))), 'civil sem celular: continua recusado');
  const comCpf = await rpc(u3, 'ingressar', { p_token: opN.token_civil, p_nome: 'Civil Com CPF', p_tipo: 'civil', p_cpf: cpf, p_telefone: tel });
  chk((await db.query(`select cpf from public.participantes where id = $1`, [comCpf.participante_id])).rows[0].cpf === cpf, 'CPF válido continua gravado');
  const r1 = await rpc(resp1, 'renomear_participante', { p_participante: semCpf.participante_id, p_nome: '  Voluntário   da  Ponte ' });
  chk(r1.nome_painel === 'Voluntário da Ponte' && r1.nome === 'Civil Sem Documento', 'responsável dá nome de exibição; nome original preservado', r1);
  await rpc(u1, 'ingressar', { p_token: opN.token_civil, p_nome: 'Civil Sem Documento', p_tipo: 'civil', p_cpf: null, p_telefone: tel });
  chk((await db.query(`select nome_painel from public.participantes where id = $1`, [semCpf.participante_id])).rows[0].nome_painel === 'Voluntário da Ponte', 'novo ingresso da pessoa não apaga o nome dado pelo responsável');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'renomear_participante', { p_participante: semCpf.participante_id, p_nome: 'Outro' }))), 'responsável de outra operação não renomeia');
  chk(/sem_permissao/.test(await erroDe(rpc(u3, 'renomear_participante', { p_participante: semCpf.participante_id, p_nome: 'Outro' }))), 'participante não renomeia ninguém');
  chk(/nome_invalido/.test(await erroDe(rpc(resp1, 'renomear_participante', { p_participante: semCpf.participante_id, p_nome: 'X' }))), 'nome com 1 letra: recusado');
  chk(/permission denied/.test(await erroDe(como(u1, `update public.participantes set nome_painel = 'Hack' where id = $1`, [semCpf.participante_id]))), 'gravação direta na tabela: recusada');
  const r2 = await rpc(resp1, 'renomear_participante', { p_participante: semCpf.participante_id, p_nome: '' });
  chk(r2.nome_painel === null, 'nome vazio volta ao nome original');
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opN.id });
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'renomear_participante', { p_participante: semCpf.participante_id, p_nome: 'Depois' }))), 'operação encerrada: só leitura');
}

console.log('Percursos de equipes e drones; trajeto desenhado como destino (migração 030)');
{
  const opR = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP TRAJETOS', p_retencao_horas: 0, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  const uA = await usuario(null, true), uB = await usuario(null, true), uX = await usuario(null, true);
  const pa = await rpc(uA, 'ingressar', { p_token: opR.token_militar, p_nome: 'Sd Alfa', p_tipo: 'militar', p_cpf: null, p_telefone: null });
  const pb = await rpc(uB, 'ingressar', { p_token: opR.token_militar, p_nome: 'Sd Bravo', p_tipo: 'militar', p_cpf: null, p_telefone: null });
  const gR = await rpc(resp1, 'salvar_grupo', { p_operacao: opR.id, p_id: null, p_dados: JSON.stringify({ nome: 'Equipe R' }) });
  await rpc(resp1, 'definir_membro', { p_grupo: gR.id, p_participante: pa.participante_id, p_papel: 'responsavel' });
  await rpc(resp1, 'definir_membro', { p_grupo: gR.id, p_participante: pb.participante_id, p_papel: 'membro' });
  const linha = [[-23.4401, -51.2501], [-23.4405, -51.2490], [-23.4399, -51.2480], [-23.4420, -51.2470]];
  // trilha de drone importada
  const td = await rpc(resp1, 'salvar_trilha_manual', { p_operacao: opR.id, p_id: null, p_dados: JSON.stringify({
    client_id: '11111111-2222-4333-8444-555555555555', nome: 'Voo drone 1', estado: 'percorrida', pontos: linha, meio: 'drone', cor: '#ff00aa', origem: 'importada', arquivo: 'voo1.kmz' }) });
  chk(td.meio === 'drone' && td.cor === '#ff00aa' && td.origem === 'importada' && td.arquivo === 'voo1.kmz', 'trilha registra meio (drone), cor, origem e arquivo', td);
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'salvar_trilha_manual', { p_operacao: opR.id, p_id: td.id, p_dados: JSON.stringify({ meio: 'foguete' }) }))), 'meio desconhecido: recusado');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'salvar_trilha_manual', { p_operacao: opR.id, p_id: td.id, p_dados: JSON.stringify({ cor: 'vermelho' }) }))), 'cor fora do formato #rrggbb: recusada');
  const td2 = await rpc(resp1, 'salvar_trilha_manual', { p_operacao: opR.id, p_id: td.id, p_dados: JSON.stringify({ cor: '', nome: 'Voo drone 1 (setor norte)' }) });
  chk(td2.cor === null && td2.meio === 'drone' && td2.origem === 'importada', 'edição: cor volta ao padrão; meio e origem mantidos', td2);
  const dia = (await db.query(`select detalhe from public.diario where operacao_id = $1 and tipo = 'trilha_percorrida'`, [opR.id])).rows;
  chk(dia.length === 1 && /drone/.test(dia[0].detalhe), 'diário registra o percurso do drone', dia);
  const tm = await rpc(resp1, 'salvar_trilha_manual', { p_operacao: opR.id, p_id: null, p_dados: JSON.stringify({ client_id: '21111111-2222-4333-8444-555555555555', nome: 'Antiga', estado: 'planejada', pontos: linha }) });
  chk(tm.meio === 'equipe' && tm.origem === 'desenho' && tm.cor === null, 'sem informar: equipe, desenhada, cor padrão');
  // trajeto para uma pessoa
  const d1 = await rpc(resp1, 'definir_destino_trajeto', { p_participante: pa.participante_id, p_nome: 'Siga a margem', p_trajeto: JSON.stringify(linha), p_modo: 'trilha' });
  chk(d1.lat === -23.442 && d1.lng === -51.247 && Array.isArray(d1.trajeto) && d1.trajeto.length === 4 && d1.modo === 'trilha', 'destino com trajeto: fim da linha é o destino', d1);
  const meu = await rpc(uA, 'meu_destino', { p_participante: pa.participante_id });
  chk(meu.id === d1.id && JSON.stringify(meu.trajeto) === JSON.stringify(linha), 'participante recebe o trajeto (meu_destino)', meu);
  const mapa = await rpc(uA, 'mapa_do_participante', { p_participante: pa.participante_id });
  chk(mapa.destino && mapa.destino.trajeto && mapa.destino.trajeto.length === 4, 'participante recebe o trajeto (mapa_do_participante)');
  chk(/trajeto_invalido/.test(await erroDe(rpc(resp1, 'definir_destino_trajeto', { p_participante: pa.participante_id, p_nome: 'X', p_trajeto: JSON.stringify([[-23.44, -51.25]]) }))), 'trajeto com 1 ponto: recusado');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'definir_destino_trajeto', { p_participante: pa.participante_id, p_nome: 'X', p_trajeto: JSON.stringify(linha) }))), 'responsável de outra operação não envia trajeto');
  chk(/sem_permissao/.test(await erroDe(rpc(uB, 'definir_destino_trajeto', { p_participante: pa.participante_id, p_nome: 'X', p_trajeto: JSON.stringify(linha) }))), 'participante não envia trajeto');
  const dSimples = await rpc(resp1, 'definir_destino', { p_participante: pa.participante_id, p_nome: 'Ponto', p_lat: -23.44, p_lng: -51.25 });
  chk(dSimples.trajeto === null && (await rpc(uA, 'meu_destino', { p_participante: pa.participante_id })).trajeto === null, 'destino comum continua sem trajeto (substitui o anterior)');
  // trajeto para um grupo
  const rg = await rpc(resp1, 'enviar_trajeto_grupo', { p_grupo: gR.id, p_nome: 'Varredura margem', p_trajeto: JSON.stringify(linha), p_publico: 'todos', p_modo: 'a_pe' });
  chk(rg.destinatarios === 2 && rg.missao.trajeto.length === 4 && rg.missao.lat === -23.442, 'grupo: missão com trajeto, os 2 membros recebem', rg);
  const db2 = await rpc(uB, 'meu_destino', { p_participante: pb.participante_id });
  chk(db2.trajeto && db2.trajeto.length === 4 && db2.missao && db2.missao.grupo === 'Equipe R', 'membro do grupo recebe o trajeto e a missão');
  chk(/permission denied/.test(await erroDe(como(resp1, `update public.destinos set trajeto = null where id = $1`, [db2.id]))), 'gravação direta no destino: recusada');
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opR.id });
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'definir_destino_trajeto', { p_participante: pa.participante_id, p_nome: 'X', p_trajeto: JSON.stringify(linha) }))), 'operação encerrada: recusado');
}

console.log('Vítima encontrada com detalhes e resultado no encerramento (migração 031)');
{
  const opV2 = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP VITIMA DETALHE', p_retencao_horas: 0, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  const uE2 = await usuario(null, true);
  const pE2 = await rpc(uE2, 'ingressar', { p_token: opV2.token_militar, p_nome: 'Sd Achou', p_tipo: 'militar', p_cpf: null, p_telefone: null });
  const fic = await rpc(resp1, 'salvar_vitima', { p_operacao: opV2.id, p_id: null, p_dados: JSON.stringify({ nome: 'Seu Antônio' }) });
  const r1 = await rpc(resp1, 'registrar_vitima_encontrada', { p_operacao: opV2.id, p_dados: JSON.stringify({
    condicao: 'viva', lat: -23.44, lng: -51.25, encontrou: pE2.participante_id, vitima_id: fic.id,
    local_descricao: 'Margem esquerda do córrego, sob a ponte', observacoes: 'Hipotermia leve; levado pelo SAMU ao HU' }) });
  chk(r1.registro.vitima_id === fic.id && r1.registro.condicao === 'viva' && r1.registro.local_descricao === 'Margem esquerda do córrego, sob a ponte'
    && /HU/.test(r1.registro.observacoes) && /Sd Achou/.test(r1.registro.registrado_por_nome), 'registra ficha, condição, local, estado e quem encontrou', r1.registro);
  const alerta = (await db.query(`select titulo from public.alertas where operacao_id = $1 and tipo = 'vitima_localizada'`, [opV2.id])).rows;
  chk(alerta.length === 1, 'dispara o alerta de vítima localizada (como a 025)');
  const di = (await db.query(`select titulo, detalhe from public.diario where operacao_id = $1 and tipo = 'vitima_localizada'`, [opV2.id])).rows;
  chk(di.length === 1 && /Seu Antônio/.test(di[0].titulo) && /sob a ponte/.test(di[0].detalhe) && /SAMU/.test(di[0].detalhe), 'diário (e relatório) com a vítima, o local e o estado', di);
  const r2 = await rpc(resp1, 'registrar_vitima_encontrada', { p_operacao: opV2.id, p_dados: JSON.stringify({
    condicao: 'obito', vitima_nome: 'Criança não identificada', encontrada_por: 'Morador da chácara', local_descricao: 'Poço' }) });
  chk(r2.vitima && r2.vitima.nome === 'Criança não identificada' && r2.registro.vitima_id === r2.vitima.id && r2.registro.encontrada_por_texto === 'Morador da chácara'
    && r2.registro.lat === null, 'cria a ficha só com o nome; quem encontrou fora do sistema; sem GPS', r2.registro);
  chk(/encontrada por Morador/.test(r2.registro.registrado_por_nome), 'nome de quem encontrou aparece no registro');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'registrar_vitima_encontrada', { p_operacao: opV2.id, p_dados: JSON.stringify({ condicao: 'talvez' }) }))), 'condição inválida: recusada');
  chk(/vitima_nao_encontrada/.test(await erroDe(rpc(resp1, 'registrar_vitima_encontrada', { p_operacao: opV2.id, p_dados: JSON.stringify({ condicao: 'viva', vitima_id: v.id }) }))), 'ficha de outra operação: recusada');
  chk(/posicao_invalida/.test(await erroDe(rpc(resp1, 'registrar_vitima_encontrada', { p_operacao: opV2.id, p_dados: JSON.stringify({ condicao: 'viva', lat: -23.4 }) }))), 'só latitude, sem longitude: recusado');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'registrar_vitima_encontrada', { p_operacao: opV2.id, p_dados: JSON.stringify({ condicao: 'viva' }) }))), 'responsável de outra operação não registra');
  chk(/sem_permissao/.test(await erroDe(rpc(uE2, 'registrar_vitima_encontrada', { p_operacao: opV2.id, p_dados: JSON.stringify({ condicao: 'viva' }) }))), 'participante não usa a função do painel');
  chk((await como(uE2, `select count(*)::int n from public.vitima_localizacoes where operacao_id = $1`, [opV2.id])).rows[0].n === 0, 'participante não lê a condição nem os detalhes');
  // encerramento: resultado registrado e operação encerrada
  await rpc(resp1, 'definir_resultado', { p_operacao: opV2.id, p_resultado: 'localizada_viva', p_texto: 'Localizado sob a ponte.' });
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opV2.id });
  const opF = (await db.query(`select status, resultado, resultado_texto from public.operacoes where id = $1`, [opV2.id])).rows[0];
  chk(opF.status === 'encerrada' && opF.resultado === 'localizada_viva' && opF.resultado_texto === 'Localizado sob a ponte.', 'encerramento com o resultado registrado', opF);
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'registrar_vitima_encontrada', { p_operacao: opV2.id, p_dados: JSON.stringify({ condicao: 'viva' }) }))), 'operação encerrada: não registra mais');
}

console.log('Dados só saem ao excluir a operação (migração 027)');
const contOp = async () => (await db.query(`select (select count(*) from public.vitimas where operacao_id=$1)::int v, (select count(*) from public.grupos where operacao_id=$1)::int g,
  (select count(*) from public.missoes where operacao_id=$1)::int m, (select count(*) from public.alertas where operacao_id=$1)::int a,
  (select count(*) from public.participantes where operacao_id=$1)::int p, (select count(*) from public.posicoes where operacao_id=$1)::int pos,
  (select count(*) from public.mensagens where operacao_id=$1)::int msg, (select count(*) from public.vitima_localizacoes where operacao_id=$1)::int vl`, [op.id])).rows[0];
const antes = await contOp();
const encOp = await rpc(resp1, 'encerrar_operacao', { p_operacao: op.id });
chk(encOp.status === 'encerrada' && encOp.expira_em === null && !encOp.dados_apagados_em, 'encerrar não marca prazo para apagar', encOp);
chk(JSON.stringify(await contOp()) === JSON.stringify(antes) && antes.p > 0 && antes.pos > 0 && antes.v > 0, 'encerrar mantém participantes, trilhas, mensagens, fichas, grupos, deslocamentos e alertas', antes);
chk(/apagar_dados_desativado/.test(await erroDe(rpc(resp1, 'apagar_dados_operacao', { p_operacao: op.id })) || ''), '"apagar dados agora" desativado');
await db.query(`update public.operacoes set expira_em = now() - interval '1 day' where id = $1`, [op.id]);
const purga = (await db.query(`select public.purgar_expiradas() r`)).rows[0].r;
chk(purga.operacoes_apagadas === 0 && JSON.stringify(await contOp()) === JSON.stringify(antes), 'limpeza diária não apaga dados de operação, nem com prazo vencido', purga);
chk((await db.query(`select dados_apagados_em from public.operacoes where id = $1`, [op.id])).rows[0].dados_apagados_em === null, 'a operação não fica marcada como apagada');
const relDepois = await rpc(resp1, 'relatorio_operacao', { p_operacao: op.id });
chk(relDepois.participantes.length > 0 && relDepois.diario.length > 10 && relDepois.operacao.resultado === 'localizada_obito', 'encerrada: o relatório sai completo (participantes, resultado e diário)');
chk(/permission denied/.test(await erroDe(como(resp1, `select public.purgar_expiradas()`)) || ''), 'a limpeza diária só roda no servidor');
const excOp = await rpc(resp1, 'excluir_operacao', { p_operacao: op.id });
chk(excOp.operacao === 'OP TESTE' && (await db.query(`select count(*)::int n from public.operacoes where id = $1`, [op.id])).rows[0].n === 0, 'excluir a operação: aí sim tudo sai', excOp);
const depoisExc = await contOp();
chk(depoisExc.v === 0 && depoisExc.p === 0 && depoisExc.pos === 0 && depoisExc.msg === 0 && depoisExc.vl === 0, 'excluída: participantes, trilhas, mensagens, fichas e registros apagados', depoisExc);
chk((await db.query(`select count(*)::int n from public.arquivos_pendentes where bucket = 'vitimas'`)).rows[0].n === 1, 'a foto da vítima entrou na fila de remoção do Storage (bucket vitimas)');
const pend = await rpc(resp1, 'meus_arquivos_pendentes_v2', {});
chk(pend.some((x) => x.bucket === 'vitimas'), 'meus_arquivos_pendentes_v2 informa o bucket', pend);
const v2 = await rpc(resp1, 'salvar_vitima', { p_operacao: antiga.id, p_id: null, p_dados: JSON.stringify({ nome: 'Não identificada' }) });
const exc = await rpc(resp1, 'excluir_operacao', { p_operacao: antiga.id });
chk(exc.vitimas === 1 && v2.nome === 'Não identificada', 'excluir operação informa as fichas apagadas', exc);

console.log('Administrador exclui sem restrição (migração 020)');
const excAdm = await rpc(resp1, 'excluir_operacao', { p_operacao: opComAtividade.id });
chk(excAdm.operacao === 'OP COM ATIVIDADE', 'administrador exclui operação de outro responsável, com relatório', excAdm);
chk((await db.query(`select count(*)::int n from public.operacoes where id = $1`, [opComAtividade.id])).rows[0].n === 0, 'a operação excluída pelo administrador sai do banco');
chk((await db.query(`select (select count(*) from public.diario where operacao_id = $1)::int d, (select count(*) from public.relatorios where operacao_id = $1)::int r`, [opComAtividade.id])).rows[0]
  .d === 0 && (await db.query(`select count(*)::int r from public.relatorios where caminho = $1`, [pdfAtividade])).rows[0].r === 0, 'o diário e os relatórios da operação excluída são apagados');
const filaPdf = (await db.query(`select bucket, excluido_por from public.arquivos_pendentes where caminho = $1`, [pdfAtividade])).rows[0];
chk(filaPdf && filaPdf.bucket === 'relatorios' && filaPdf.excluido_por === null, 'o PDF do relatório entra na fila de limpeza do Storage', filaPdf);

console.log('Controle de tempo: horários combinados, atrasos e falhas de comunicação (migração 032)');
{
  const opK = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP PRAZOS', p_retencao_horas: 0, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  await db.query(`update public.operacoes set criada_em = now() - interval '3 hours' where id = $1`, [opK.id]);
  const uK1 = await usuario(null, true), uK2 = await usuario(null, true);
  const k1 = await rpc(uK1, 'ingressar', { p_token: opK.token_militar, p_nome: 'Cabo Kilo', p_tipo: 'militar', p_cpf: cpf, p_telefone: tel });
  const k2 = await rpc(uK2, 'ingressar', { p_token: opK.token_civil, p_nome: 'Lima Civil', p_tipo: 'civil', p_cpf: cpf, p_telefone: tel });
  const gK = await rpc(resp1, 'salvar_grupo', { p_operacao: opK.id, p_id: null, p_dados: JSON.stringify({ nome: 'Equipe K' }) });
  await rpc(resp1, 'definir_membro', { p_grupo: gK.id, p_participante: k1.participante_id, p_papel: 'responsavel' });
  await rpc(resp1, 'definir_membro', { p_grupo: gK.id, p_participante: k2.participante_id, p_papel: 'membro' });
  const baseK = await rpc(resp1, 'salvar_ponto', { p_operacao: opK.id, p_id: null, p_dados: JSON.stringify({ categoria: 'BASE', titulo: 'Base K', lat: -23.3, lng: -51.1, raio_m: 100 }) });
  let nk = 900;
  const andarK = (u, pid, lat, lng, t) => rpc(u, 'enviar_posicoes_lote', { p_participante: pid, p_gps: 'ok', p_pontos: JSON.stringify([pt(nk++, lat, lng, t)]) });
  await andarK(uK1, k1.participante_id, -23.3, -51.1);
  await andarK(uK2, k2.participante_id, -23.3001, -51.1);
  const envK = await rpc(resp1, 'enviar_destino_grupo', { p_grupo: gK.id, p_nome: 'Setor Rio', p_lat: -23.35, p_lng: -51.1, p_publico: 'todos', p_modo: 'a_pe',
    p_setor: null, p_ponto: null, p_base: baseK.id, p_raio_base_m: null, p_prazo_min: 15 });
  const mk = envK.missao;
  const col = (await db.query(`select tolerancia_min, sem_sinal_min, inicio_combinado_em from public.missoes where id = $1`, [mk.id])).rows[0];
  chk(col.tolerancia_min === 10 && col.sem_sinal_min === 10 && col.inicio_combinado_em === null, 'missão nova: tolerância 10 min, sem comunicação após 10 min, sem horários', col);
  const ini = new Date(Date.now() + 10 * 60e3).toISOString(), ret = new Date(Date.now() + 90 * 60e3).toISOString();
  const dp = await rpc(resp1, 'definir_prazos_missao', { p_missao: mk.id, p_dados: JSON.stringify({ inicio_combinado_em: ini, retorno_combinado_em: ret, tolerancia_min: 5, sem_sinal_min: 8, combinado_texto: '  Rádio canal 3 a cada 30 min ' }) });
  chk(Date.parse(dp.inicio_combinado_em) === Date.parse(ini) && Date.parse(dp.retorno_combinado_em) === Date.parse(ret) && dp.tolerancia_min === 5 && dp.sem_sinal_min === 8
    && dp.combinado_texto === 'Rádio canal 3 a cada 30 min' && dp.prazos_definidos_por_nome === 'Sgt Um', 'responsável registra horário combinado de início e de retorno, tolerância e o combinado', dp);
  const dd = (await db.query(`select titulo, detalhe as texto from public.diario where operacao_id = $1 and tipo = 'prazos_definidos'`, [opK.id])).rows;
  chk(dd.length === 1 && /Equipe K/.test(dd[0].titulo) && /iniciar até/.test(dd[0].texto) && /retornar até/.test(dd[0].texto), 'prazos registrados no diário', dd);
  const so = await rpc(resp1, 'definir_prazos_missao', { p_missao: mk.id, p_dados: JSON.stringify({ tolerancia_min: 7 }) });
  chk(so.tolerancia_min === 7 && Date.parse(so.inicio_combinado_em) === Date.parse(ini) && so.combinado_texto === 'Rádio canal 3 a cada 30 min', 'só as chaves enviadas mudam');
  chk(/horario_combinado_invalido/.test(await erroDe(rpc(resp1, 'definir_prazos_missao', { p_missao: mk.id, p_dados: JSON.stringify({ retorno_combinado_em: new Date(Date.now() + 5 * 60e3).toISOString() }) }))), 'retorno antes do início: recusado');
  chk(/horario_combinado_invalido/.test(await erroDe(rpc(resp1, 'definir_prazos_missao', { p_missao: mk.id, p_dados: JSON.stringify({ inicio_combinado_em: 'ontem' }) }))), 'horário ilegível: recusado');
  chk(/horario_combinado_invalido/.test(await erroDe(rpc(resp1, 'definir_prazos_missao', { p_missao: mk.id, p_dados: JSON.stringify({ inicio_combinado_em: new Date(Date.now() + 5 * 86400e3).toISOString(), retorno_combinado_em: '' }) }))), 'horário a mais de 2 dias: recusado');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'definir_prazos_missao', { p_missao: mk.id, p_dados: JSON.stringify({ sem_sinal_min: 1 }) }))), 'sem comunicação < 3 min: recusado');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'definir_prazos_missao', { p_missao: mk.id, p_dados: '{}' }))), 'responsável de outra operação não define prazos');
  chk(/sem_permissao/.test(await erroDe(rpc(uK1, 'definir_prazos_missao', { p_missao: mk.id, p_dados: '{}' }))), 'participante não define prazos');
  chk(/permission denied/.test(await erroDe(como(resp1, `update public.missoes set tolerancia_min = 0 where id = $1`, [mk.id]))), 'gravação direta na missão: recusada');
  chk(/permission denied/.test(await erroDe(como(null, `select public.definir_prazos_missao($1, '{}')`, [mk.id], 'anon'))), 'anon não chama a função');

  const tipos = async () => (await db.query(`select tipo from public.alertas where operacao_id = $1 order by id`, [opK.id])).rows.map((r) => r.tipo);
  chk((await rpc(resp1, 'verificar_prazos', { p_operacao: opK.id })) === 0 && (await tipos()).length === 0, 'dentro dos horários e com contato recente: nenhum alerta');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'verificar_prazos', { p_operacao: opK.id }))), 'outra operação não verifica estes prazos');
  chk(/sem_permissao/.test(await erroDe(rpc(resp1, 'verificar_prazos', {}))), 'verificar_prazos sem operação: só o agendador');

  // início combinado vencido (passou da tolerância) e ninguém saiu
  await db.query(`update public.missoes set inicio_combinado_em = now() - interval '20 minutes' where id = $1`, [mk.id]);
  chk((await rpc(resp1, 'verificar_retornos', { p_operacao: opK.id })) === 1, 'o agendador existente (verificar_retornos) também verifica os prazos combinados');
  const aIni = (await db.query(`select nivel, titulo, texto from public.alertas where operacao_id = $1 and tipo = 'inicio_atrasado'`, [opK.id])).rows;
  chk(aIni.length === 1 && aIni[0].nivel === 'critico' && /INÍCIO ATRASADO/.test(aIni[0].titulo) && /Rádio canal 3/.test(aIni[0].texto), 'alerta crítico de início atrasado, com o combinado', aIni);
  chk((await db.query(`select verificar_retornos() n`)).rows[0].n === 0, 'pg_cron não repete o mesmo alerta');
  await db.query(`update public.missoes set inicio_combinado_em = now() - interval '2 minutes' where id = $1`, [mk.id]);
  await rpc(resp1, 'definir_prazos_missao', { p_missao: mk.id, p_dados: JSON.stringify({ inicio_combinado_em: new Date(Date.now() - 30 * 60e3).toISOString() }) });
  chk((await rpc(resp1, 'verificar_prazos', { p_operacao: opK.id })) === 1, 'novo horário combinado vencido: novo alerta (um por horário)');

  // o grupo sai: início detectado, não há mais atraso de início
  await andarK(uK1, k1.participante_id, -23.31, -51.1);
  await andarK(uK2, k2.participante_id, -23.31, -51.1);
  const iniciou = (await db.query(`select count(*) filter (where iniciou_em is not null)::int n from public.missao_membros where missao_id = $1`, [mk.id])).rows[0].n;
  chk(iniciou === 2, 'deslocamento iniciado pela trilha', iniciou);

  // falha de comunicação: um membro some (sem internet)
  await db.query(`update public.participantes set ultimo_contato_em = now() - interval '12 minutes', ultima_posicao_em = now() - interval '12 minutes' where id = $1`, [k2.participante_id]);
  chk((await rpc(resp1, 'verificar_prazos', { p_operacao: opK.id })) === 1, 'membro sem contato além do limite: alerta');
  const aSem = (await db.query(`select nivel, titulo, texto, participante_id, lat from public.alertas where operacao_id = $1 and tipo = 'sem_comunicacao'`, [opK.id])).rows;
  chk(aSem.length === 1 && aSem[0].nivel === 'critico' && /SEM COMUNICAÇÃO — Lima Civil/.test(aSem[0].titulo) && aSem[0].participante_id === k2.participante_id
    && aSem[0].lat !== null && /sem internet/.test(aSem[0].texto) && /Última posição conhecida às/.test(aSem[0].texto), 'alerta crítico de falta de comunicação com a última posição conhecida', aSem);
  chk((await rpc(resp1, 'verificar_prazos', { p_operacao: opK.id })) === 0, 'mesmo episódio sem contato: não repete');
  // volta o sinal: o celular envia as posições gravadas sem internet
  const lot = await rpc(uK2, 'enviar_posicoes_lote', { p_participante: k2.participante_id, p_gps: 'ok', p_pontos: JSON.stringify([
    pt(nk++, -23.32, -51.1, Date.now() - 9 * 60e3), pt(nk++, -23.33, -51.1, Date.now() - 5 * 60e3), pt(nk++, -23.34, -51.1)]) });
  chk(lot.confirmados.length === 3, 'posições gravadas sem internet são aceitas depois', lot);
  chk((await rpc(resp1, 'verificar_prazos', { p_operacao: opK.id })) === 1, 'contato de volta: aviso de comunicação restabelecida');
  const aOk = (await db.query(`select nivel, texto from public.alertas where operacao_id = $1 and tipo = 'comunicacao_restabelecida'`, [opK.id])).rows;
  chk(aOk.length === 1 && aOk[0].nivel === 'info' && /cerca de 1[0-9] min sem contato/.test(aOk[0].texto) && /2 posição\(ões\) gravada\(s\) sem internet/.test(aOk[0].texto),
    'informa o tempo sem contato e quantas posições chegaram atrasadas', aOk);
  chk((await rpc(resp1, 'verificar_prazos', { p_operacao: opK.id })) === 0, 'restabelecida: não repete');
  const diaK = (await db.query(`select tipo, categoria from public.diario where operacao_id = $1 and tipo in ('alerta_sem_comunicacao', 'alerta_inicio_atrasado', 'alerta_comunicacao_restabelecida')`, [opK.id])).rows;
  chk(diaK.some((d) => d.tipo === 'alerta_sem_comunicacao' && d.categoria === 'alerta') && diaK.some((d) => d.tipo === 'alerta_inicio_atrasado' && d.categoria === 'alerta'),
    'atrasos e falhas de comunicação entram no diário como alerta', diaK);

  // retorno combinado vencido com gente fora da base
  await db.query(`update public.missoes set retorno_combinado_em = now() - interval '10 minutes' where id = $1`, [mk.id]);
  chk((await rpc(resp1, 'verificar_prazos', { p_operacao: opK.id })) === 1, 'retorno combinado vencido: alerta');
  const aRet = (await db.query(`select nivel, texto from public.alertas where operacao_id = $1 and tipo = 'prazo_atrasado'`, [opK.id])).rows;
  chk(aRet.length === 1 && aRet[0].nivel === 'critico' && /2 de 2 pessoa/.test(aRet[0].texto) && /Cabo Kilo \(último contato há/.test(aRet[0].texto), 'lista quem não voltou e há quanto tempo foi o último contato', aRet);
  chk((await como(uK1, `select count(*)::int n from public.alertas`)).rows[0].n === 0, 'participante não lê os alertas');
  chk((await como(resp2, `select count(*)::int n from public.alertas where operacao_id = $1`, [opK.id])).rows[0].n === 0, 'outra operação não lê os alertas');
  // todos voltam à base: missão concluída, sem novos alertas
  await rpc(uK1, 'finalizar_busca', { p_missao: mk.id });
  await andarK(uK1, k1.participante_id, -23.3, -51.1); await andarK(uK1, k1.participante_id, -23.3001, -51.1);
  await andarK(uK2, k2.participante_id, -23.3, -51.1); await andarK(uK2, k2.participante_id, -23.3001, -51.1);
  const stK = (await db.query(`select status from public.missoes where id = $1`, [mk.id])).rows[0].status;
  chk(/missao_encerrada/.test(await erroDe(rpc(resp1, 'definir_prazos_missao', { p_missao: mk.id, p_dados: '{}' })) || '') && stK === 'na_base', 'missão concluída: prazos não mudam mais', stK);
  await db.query(`update public.participantes set ultimo_contato_em = now() - interval '1 hour' where id = $1`, [k1.participante_id]);
  const antesN = (await tipos()).length;
  await rpc(resp1, 'verificar_prazos', { p_operacao: opK.id });
  chk((await tipos()).length === antesN, 'missão na base: não gera alertas de comunicação', stK);
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opK.id });
  chk((await db.query(`select verificar_retornos() n`)).rows[0].n === 0, 'operação encerrada: o agendador ignora');
}

// ---------- Migração 033: cenário por vítima (POA, versões imutáveis) e registro manual de busca (POD) ----------
console.log('\nCenário de busca (POA) e registro manual da busca (POD) — migração 033');
{
  const pubB = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`)).rows.map((r) => r.tablename);
  chk(['busca_cenarios', 'busca_cenario_setores', 'busca_registros'].every((x) => pubB.includes(x)), 'cenários e registros de busca publicados no Realtime', pubB);

  const opB = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP CENARIO', p_retencao_horas: 24, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  const vAna = await rpc(resp1, 'salvar_vitima', { p_operacao: opB.id, p_id: null, p_dados: JSON.stringify({ nome: 'Ana' }) });
  const vBeto = await rpc(resp1, 'salvar_vitima', { p_operacao: opB.id, p_id: null, p_dados: JSON.stringify({ nome: 'Beto' }) });
  const mkSetor = (nome, lat) => rpc(resp1, 'salvar_setor', { p_operacao: opB.id, p_id: null, p_dados: JSON.stringify({ nome, forma: 'circulo', centro_lat: lat, centro_lng: -49.2, raio_m: 300 }) });
  const sN = await mkSetor('Norte', -25.40), sS = await mkSetor('Sul', -25.42), sL = await mkSetor('Leste', -25.44);
  const dados = (itens, just, extra) => JSON.stringify(Object.assign({ justificativa: just == null ? '' : just, setores: itens }, extra || {}));
  const it = (s, poa, j) => ({ setor_id: s.id, poa, justificativa: j || '' });
  const q = async (uid, sql, params) => (await como(uid, sql, params)).rows;

  // --- cenário: rascunho ---
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'cenario_salvar_rascunho', { p_vitima: vAna.id, p_dados: dados([it(sN, 0.5)]) }))), 'responsável de outra operação não cria cenário');
  chk(/vitima_nao_encontrada/.test(await erroDe(rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: '00000000-0000-0000-0000-000000000000', p_dados: dados([]) }))), 'vítima inexistente: recusada');
  chk(/cenario_poa_acima_de_100/.test(await erroDe(rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vAna.id, p_dados: dados([it(sN, 0.7), it(sS, 0.4)]) }))), 'soma dos POA acima de 100%: recusada');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vAna.id, p_dados: dados([it(sN, 1.2)]) }))), 'POA fora de 0 a 1: recusado');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vAna.id, p_dados: dados([it(sN, 0.3), it(sN, 0.2)]) }))), 'mesmo setor duas vezes: recusado');
  chk(/setor_nao_encontrado/.test(await erroDe(rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vAna.id, p_dados: dados([it(setor, 0.3)]) }))), 'setor de outra operação: recusado');
  chk((await db.query(`select count(*)::int n from public.busca_cenarios where vitima_id = $1`, [vAna.id])).rows[0].n === 0, 'pedido recusado não deixa rascunho pela metade');

  const r1 = await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vAna.id, p_dados: dados([it(sN, 0.5, 'última vez vista ao norte'), it(sS, 0.3)], 'Trilha do norte é a mais provável') });
  chk(r1.cenario.numero === 1 && r1.cenario.estado === 'rascunho' && r1.setores.length === 2 && r1.cenario.base_numero === null, 'rascunho vira a versão 1 com os POA por setor', r1);
  chk(Math.abs(r1.setores.reduce((a, s) => a + Number(s.poa), 0) - 0.8) < 1e-9 && r1.setores.find((s) => s.setor_nome === 'Norte').justificativa === 'última vez vista ao norte', 'guarda POA e justificativa por setor (os 20% restantes ficam fora dos setores)');
  const r1b = await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vAna.id, p_dados: dados([it(sN, 0.4), it(sS, 0.3), it(sL, 0.2)], 'Revisado', { atualizado_em: r1.cenario.atualizado_em }) });
  chk(r1b.cenario.id === r1.cenario.id && r1b.cenario.numero === 1 && r1b.setores.length === 3, 'salvar de novo edita o mesmo rascunho (continua a versão 1)', r1b);
  chk(/cenario_versao_desatualizada/.test(await erroDe(rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vAna.id, p_dados: dados([it(sN, 0.1)], 'x', { atualizado_em: r1.cenario.atualizado_em }) }))), 'rascunho mudou por outro responsável: recusa gravar por cima');
  chk((await q(anA, `select count(*)::int n from public.busca_cenarios`))[0].n === 0 && (await q(anA, `select count(*)::int n from public.busca_registros`))[0].n === 0, 'participante não lê cenários nem registros');
  chk((await q(resp2, `select count(*)::int n from public.busca_cenarios`))[0].n === 0, 'responsável de outra operação não lê os cenários');
  chk((await q(resp1, `select count(*)::int n from public.busca_cenarios where vitima_id = $1`, [vAna.id]))[0].n === 1, 'responsável da operação lê o cenário');
  chk(/permission denied/i.test(await erroDe(como(resp1, `update public.busca_cenarios set justificativa = 'x' where id = $1`, [r1.cenario.id]))), 'sem escrita direta nas tabelas (só pelas funções)');

  // --- aprovar ---
  chk(/cenario_sem_justificativa/.test(await erroDe(rpc(resp1, 'cenario_aprovar', { p_cenario: (await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vAna.id, p_dados: dados([it(sN, 0.4), it(sS, 0.3), it(sL, 0.2)], 'curta') })).cenario.id }))), 'aprovar sem justificativa de verdade (mín. 10 caracteres): recusado');
  const rasc = await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vAna.id, p_dados: dados([it(sN, 0.4, 'trilha'), it(sS, 0.3), it(sL, 0.2)], 'Última posição ao norte; cão de trilha indicou o norte') });
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'cenario_aprovar', { p_cenario: rasc.cenario.id }))), 'outro responsável não aprova');
  const ap1 = await rpc(resp1, 'cenario_aprovar', { p_cenario: rasc.cenario.id });
  chk(ap1.cenario.estado === 'aprovada' && ap1.cenario.aprovada_por_nome === 'Sgt Um' && ap1.cenario.aprovada_em, 'versão aprovada: guarda quem e quando', ap1.cenario);
  const dia1 = (await db.query(`select titulo, detalhe, categoria from public.diario where operacao_id = $1 and tipo = 'cenario_aprovado'`, [opB.id])).rows;
  chk(dia1.length === 1 && /Ana \(versão 1\)/.test(dia1[0].titulo) && /Norte: 40%/.test(dia1[0].detalhe) && /cão de trilha/.test(dia1[0].detalhe), 'aprovação entra no diário com POA e justificativa', dia1);

  // --- versão aprovada não muda ---
  chk(/cenario_imutavel_aprovado/.test(await erroDe(rpc(resp1, 'cenario_aprovar', { p_cenario: ap1.cenario.id }))), 'aprovar de novo a mesma versão: recusado');
  chk(/cenario_imutavel_aprovado/.test(await erroDe(rpc(resp1, 'cenario_descartar_rascunho', { p_cenario: ap1.cenario.id }))), 'versão aprovada não pode ser descartada');
  chk(/cenario_imutavel_aprovado/.test(await erroDe(db.query(`update public.busca_cenarios set justificativa = 'adulterada' where id = $1`, [ap1.cenario.id]))), 'gatilho: nem o banco altera a versão aprovada');
  chk(/cenario_imutavel_aprovado/.test(await erroDe(db.query(`update public.busca_cenarios set estado = 'rascunho', aprovada_em = null where id = $1`, [ap1.cenario.id]))), 'gatilho: aprovada não volta a rascunho');
  chk(/cenario_imutavel_aprovado/.test(await erroDe(db.query(`delete from public.busca_cenarios where id = $1`, [ap1.cenario.id]))), 'gatilho: versão aprovada não é apagada');
  chk(/cenario_imutavel_aprovado/.test(await erroDe(db.query(`update public.busca_cenario_setores set poa = 0.9 where cenario_id = $1`, [ap1.cenario.id]))), 'gatilho: POA da versão aprovada não muda');
  chk(/cenario_imutavel_aprovado/.test(await erroDe(db.query(`delete from public.busca_cenario_setores where cenario_id = $1`, [ap1.cenario.id]))), 'gatilho: setores da versão aprovada não somem');
  chk(/cenario_imutavel_aprovado/.test(await erroDe(db.query(`insert into public.busca_cenario_setores (cenario_id, operacao_id, setor_id, setor_nome, poa) values ($1, $2, $3, 'X', 0.1)`, [ap1.cenario.id, opB.id, sL.id]))), 'gatilho: não entra setor novo na versão aprovada');

  // --- nova versão: o histórico fica ---
  const r2 = await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vAna.id, p_dados: dados([it(sN, 0.1), it(sS, 0.6)], 'Buscas no norte sem vestígios; deslocando a probabilidade para o sul') });
  chk(r2.cenario.numero === 2 && r2.cenario.base_numero === 1 && r2.cenario.estado === 'rascunho', 'depois de aprovada, salvar cria a versão 2 (parte da 1)', r2.cenario);
  const ap2 = await rpc(resp1, 'cenario_aprovar', { p_cenario: r2.cenario.id });
  const hist = (await q(resp1, `select numero, estado, justificativa from public.busca_cenarios where vitima_id = $1 order by numero`, [vAna.id]));
  chk(hist.length === 2 && hist.every((h) => h.estado === 'aprovada') && /cão de trilha/.test(hist[0].justificativa) && /sul/.test(hist[1].justificativa), 'histórico guarda as duas versões aprovadas, a primeira intacta', hist);
  const p1 = (await q(resp1, `select s.setor_nome, s.poa from public.busca_cenario_setores s join public.busca_cenarios c on c.id = s.cenario_id where c.id = $1 order by 1`, [ap1.cenario.id]));
  chk(p1.length === 3 && Number(p1.find((x) => x.setor_nome === 'Norte').poa) === 0.4, 'POA da versão 1 continua os mesmos depois da versão 2', p1);
  const rb = await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vBeto.id, p_dados: dados([it(sL, 0.7)], 'Beto saiu pelo leste') });
  chk(rb.cenario.numero === 1, 'cada vítima tem o seu próprio cenário (Beto começa na versão 1)', rb.cenario);
  const rbDesc = await rpc(resp1, 'cenario_descartar_rascunho', { p_cenario: rb.cenario.id });
  chk((await db.query(`select count(*)::int n from public.busca_cenarios where vitima_id = $1`, [vBeto.id])).rows[0].n === 0, 'rascunho pode ser descartado');
  const rb2 = await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vBeto.id, p_dados: dados([it(sL, 0.7)], 'Beto saiu pelo leste (rascunho aberto ao encerrar)') });

  // --- registro manual da busca (POD) ---
  const reg = (extra) => rpc(resp1, 'busca_registrar', { p_operacao: opB.id, p_dados: JSON.stringify(Object.assign({ setor_id: sN.id, pod: 0.6, base_estimativa: 'Varredura em linha, 5 m entre buscadores, mata média', equipe: 'Equipe Alfa' }, extra || {})) });
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'busca_registrar', { p_operacao: opB.id, p_dados: JSON.stringify({ setor_id: sN.id, pod: 0.5, base_estimativa: 'qualquer coisa' }) }))), 'outro responsável não registra busca');
  chk(/busca_pod_invalido/.test(await erroDe(reg({ pod: 1.5 }))) && /busca_pod_invalido/.test(await erroDe(reg({ pod: -0.1 }))), 'POD fora de 0 a 100%: recusado');
  chk(/busca_sem_base_estimativa/.test(await erroDe(reg({ base_estimativa: '' }))), 'sem dizer em que o POD se baseia: recusado');
  chk(/setor_nao_encontrado/.test(await erroDe(reg({ setor_id: setor.id }))), 'setor de outra operação: recusado');
  chk(/vitima_nao_encontrada/.test(await erroDe(reg({ vitima_id: v.id }))), 'vítima de outra operação: recusada');
  chk(/dados_invalidos/.test(await erroDe(reg({ inicio: '2026-01-02T10:00:00Z', fim: '2026-01-02T09:00:00Z' }))), 'fim antes do início: recusado');
  const b1 = await reg({ inicio: '2026-01-02T08:00:00Z', fim: '2026-01-02T10:00:00Z', condicoes: 'Chuva fraca, visibilidade média' });
  chk(Number(b1.pod) === 0.6 && b1.setor_nome === 'Norte' && b1.equipe === 'Equipe Alfa' && b1.vitima_id === null && b1.registrado_por_nome === 'Sgt Um' && !b1.anulado_em, 'registro guarda POD, setor, equipe, base e quem registrou (vale para todas as vítimas)', b1);
  const b2 = await reg({ pod: 0.35, vitima_id: vAna.id, equipe: '' });
  chk(b2.vitima_id === vAna.id, 'registro pode valer só para uma vítima', b2);
  chk(/busca_registrada/.test((await db.query(`select string_agg(tipo, ',') t from public.diario where operacao_id = $1`, [opB.id])).rows[0].t), 'registro entra no diário');
  chk(/busca_registro_imutavel/.test(await erroDe(db.query(`update public.busca_registros set pod = 0.99 where id = $1`, [b1.id]))), 'gatilho: o POD registrado não é editado');
  chk(/busca_registro_imutavel/.test(await erroDe(db.query(`delete from public.busca_registros where id = $1`, [b1.id]))), 'gatilho: registro não é apagado');
  chk(/busca_anulacao_sem_motivo/.test(await erroDe(rpc(resp1, 'busca_anular', { p_registro: b1.id, p_motivo: ' ' }))), 'anular exige motivo');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'busca_anular', { p_registro: b1.id, p_motivo: 'teste de permissão' }))), 'outro responsável não anula');
  const an = await rpc(resp1, 'busca_anular', { p_registro: b1.id, p_motivo: 'Setor errado no lançamento' });
  chk(an.anulado_em && an.anulado_motivo === 'Setor errado no lançamento' && an.anulado_por_nome === 'Sgt Um' && Number(an.pod) === 0.6, 'anulado: fica no histórico com motivo e quem anulou', an);
  chk(/busca_registro_ja_anulado/.test(await erroDe(rpc(resp1, 'busca_anular', { p_registro: b1.id, p_motivo: 'de novo' }))), 'anular duas vezes: recusado');
  chk(/busca_registro_imutavel/.test(await erroDe(db.query(`update public.busca_registros set anulado_em = null, anulado_motivo = null where id = $1`, [b1.id]))), 'gatilho: anulação não se desfaz');
  chk(/busca_registro_inexistente/.test(await erroDe(rpc(resp1, 'busca_anular', { p_registro: '00000000-0000-0000-0000-000000000000', p_motivo: 'não existe' }))), 'registro inexistente: recusado');
  chk(/busca_anulada/.test((await db.query(`select string_agg(tipo, ',') t from public.diario where operacao_id = $1`, [opB.id])).rows[0].t), 'anulação entra no diário');

  // --- exclusões em cascata não esbarram na proteção ---
  await rpc(resp1, 'excluir_setor', { p_id: sL.id });
  const orf = (await db.query(`select setor_id, setor_nome, poa from public.busca_cenario_setores s join public.busca_cenarios c on c.id = s.cenario_id where c.id = $1 and s.setor_nome = 'Leste'`, [ap1.cenario.id])).rows;
  chk(orf.length === 1 && orf[0].setor_id === null && Number(orf[0].poa) === 0.2, 'setor excluído: a versão aprovada guarda o nome e o POA (sem o vínculo)', orf);

  // --- operação encerrada: somente leitura ---
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opB.id });
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'cenario_aprovar', { p_cenario: rb2.cenario.id }))), 'operação encerrada: não aprova cenário');
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vAna.id, p_dados: dados([it(sN, 0.2)], 'depois de encerrar') }))), 'operação encerrada: não cria versão');
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'cenario_descartar_rascunho', { p_cenario: rb2.cenario.id }))), 'operação encerrada: não descarta rascunho');
  chk(/operacao_encerrada/.test(await erroDe(reg())), 'operação encerrada: não registra busca');
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'busca_anular', { p_registro: b2.id, p_motivo: 'depois de encerrar' }))), 'operação encerrada: não anula registro');
  chk((await q(resp1, `select count(*)::int n from public.busca_cenarios where operacao_id = $1`, [opB.id]))[0].n === 3 && (await q(resp1, `select count(*)::int n from public.busca_registros where operacao_id = $1`, [opB.id]))[0].n === 2, 'operação encerrada: continua aberta para consulta');

  // excluir a operação leva tudo junto (inclusive versões aprovadas)
  await db.query(`select set_config('gbs.excluindo_operacao', $1, false)`, [opB.id]);
  await db.query(`delete from public.operacoes where id = $1`, [opB.id]);
  await db.query(`select set_config('gbs.excluindo_operacao', '', false)`);
  chk((await db.query(`select (select count(*) from public.busca_cenarios where operacao_id = $1) + (select count(*) from public.busca_cenario_setores where operacao_id = $1) + (select count(*) from public.busca_registros where operacao_id = $1) as n`, [opB.id])).rows[0].n == 0, 'excluir a operação apaga cenários e registros (cascata passa pela proteção)');
}

// ---------- Migração 034: POA/POD conforme o guia (geometria, hipóteses, idempotência, POD planejada/não estimada) ----------
console.log('\nPOA e POD conforme o guia — migração 034');
{
  const opG = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP GUIA', p_retencao_horas: 24, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  const vA = await rpc(resp1, 'salvar_vitima', { p_operacao: opG.id, p_id: null, p_dados: JSON.stringify({ nome: 'Clara' }) });
  const vB = await rpc(resp1, 'salvar_vitima', { p_operacao: opG.id, p_id: null, p_dados: JSON.stringify({ nome: 'Davi' }) });
  const d = (m) => m / 111194.93;
  const circ = (nome, lat, r) => rpc(resp1, 'salvar_setor', { p_operacao: opG.id, p_id: null, p_dados: JSON.stringify({ nome, forma: 'circulo', centro_lat: lat, centro_lng: -49.2, raio_m: r }) });
  const sA = await circ('Alfa', -25.40, 300), sB = await circ('Bravo', -25.40 + d(400), 300), sC = await circ('Charlie', -25.40 + d(700), 300), sD = await circ('Delta', -25.40 + d(1500), 300);
  const ponto = await rpc(resp1, 'salvar_ponto', { p_operacao: opG.id, p_id: null, p_dados: JSON.stringify({ categoria: 'ULTIMA_LOCALIZACAO', titulo: 'Última vez vista', lat: -25.401, lng: -49.2 }) });
  const relato = await rpc(resp1, 'salvar_ponto', { p_operacao: opG.id, p_id: null, p_dados: JSON.stringify({ categoria: 'VESTIGIO', titulo: 'Pegada', lat: -25.402, lng: -49.2 }) });
  const dados = (itens, extra) => JSON.stringify(Object.assign({ justificativa: 'Hipótese principal: seguiu a trilha do rio', setores: itens }, extra || {}));
  const it = (s, poa) => ({ setor_id: s.id, poa, justificativa: '' });
  const q = async (uid, sql, params) => (await como(uid, sql, params)).rows;

  console.log('  geometria e sobreposição');
  const fr = (await db.query(`select public.busca_sobreposicao_fracao(public.busca_poligono('circulo', -25.40, -49.2, 300, null), public.busca_poligono('circulo', $1, -49.2, 300, null)) f`, [-25.40 + d(400)])).rows[0].f;
  chk(Math.abs(fr - 0.22033898305084745) < 1e-9, 'o banco mede a sobreposição como o app (22% de dois círculos a 400 m)', fr);
  const frQuad = (await db.query(`select public.busca_sobreposicao_fracao(public.busca_poligono('circulo', -25.40, -49.2, 300, null), $1::jsonb) f`,
    [JSON.stringify([[-25.40179864315756, -49.199100678421225], [-25.40179864315756, -49.1955033921061], [-25.39820135684244, -49.1955033921061], [-25.39820135684244, -49.199100678421225]])])).rows[0].f;
  chk(Math.abs(frQuad - 0.5088888888888888) < 1e-9, 'o banco mede círculo × polígono como o app (50,9%)', frQuad);
  chk((await db.query(`select public.busca_sobreposicao_fracao(public.busca_poligono('circulo', -25.40, -49.2, 300, null), public.busca_poligono('circulo', -25.40, -49.2, 100, null)) f`)).rows[0].f === 1, 'setor dentro de outro: 100%');
  const area = (await db.query(`select public.busca_area_m2('circulo', -25.4, -49.2, 100, null) a, public.busca_area_m2('poligono', null, null, null, $1::jsonb) b`,
    [JSON.stringify([[-25.40179864315756, -49.199100678421225], [-25.40179864315756, -49.1955033921061], [-25.39820135684244, -49.1955033921061], [-25.39820135684244, -49.199100678421225]])])).rows[0];
  chk(Math.abs(area.a - Math.PI * 1e4) < 1e-6 && area.b > 140000 && area.b < 175000, 'área em m² (círculo e polígono)', area);

  console.log('  cenário: hipóteses, ponto confiável, evidências e geometria na versão');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vA.id, p_dados: dados([it(sA, 0.5)], { confianca: 'certeza' }) }))), 'confiança fora de baixa/média/alta: recusada');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vA.id, p_dados: dados([it(sA, 0.5)], { origem_poa: 'modelo_validado' }) }))), 'origem "modelo validado" recusada: ainda não há catálogo de modelos');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vA.id, p_dados: dados([it(sA, 0.5)], { ponto_confiavel_id: setor.id }) }))), 'ponto confiável que não é desta operação: recusado');
  const r1 = await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vA.id, p_dados: dados([it(sA, 0.4), it(sB, 0.3)], {
    horario_referencia: '2026-10-20T08:00:00Z', hipoteses: 'Permaneceu perto da trilha', limitacoes: 'Sem testemunha do último avistamento', confianca: 'media',
    origem_poa: 'consenso_documentado', ponto_confiavel_id: ponto.id,
    evidencias: [{ ponto_id: relato.id, confirmada: false }, { descricao: 'Relato do vizinho (não confirmado)', confirmada: false }] }) });
  chk(r1.cenario.hipoteses === 'Permaneceu perto da trilha' && r1.cenario.limitacoes && r1.cenario.confianca === 'media' && r1.cenario.origem_poa === 'consenso_documentado' && new Date(r1.cenario.horario_referencia).toISOString() === '2026-10-20T08:00:00.000Z', 'versão guarda horário de referência, hipóteses, limitações, confiança e origem do POA', r1.cenario);
  chk(r1.cenario.ponto_confiavel_id === ponto.id && r1.cenario.ponto_confiavel.titulo === 'Última vez vista' && r1.cenario.ponto_confiavel.lat === -25.401, 'último ponto confiável: referência e cópia dos dados');
  chk(r1.evidencias.length === 2 && r1.evidencias.some((e) => /VESTIGIO — Pegada/.test(e.descricao) && e.confirmada === false && e.ponto_id === relato.id), 'evidências com situação de confirmação (a do ponto leva categoria e título)', r1.evidencias);
  const gA = r1.setores.find((s) => s.setor_nome === 'Alfa');
  chk(gA.forma === 'circulo' && gA.raio_m === 300 && gA.centro_lat === -25.40 && Math.abs(gA.area_m2 - Math.PI * 9e4) < 1e-6, 'geometria e área do setor copiadas para a versão', gA);
  const r1b = await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vA.id, p_dados: dados([it(sA, 0.4), it(sB, 0.3)], { atualizado_em: r1.cenario.atualizado_em, evidencias: [{ descricao: 'Nova pista', confirmada: true }] }) });
  chk(r1b.evidencias.length === 1 && r1b.evidencias[0].confirmada === true && r1b.cenario.ponto_confiavel_id === null, 'salvar de novo substitui as evidências do rascunho');

  console.log('  aprovação: sobreposição, revisão esperada e idempotência');
  chk(/cenario_setores_sobrepostos/.test(await erroDe(rpc(resp1, 'cenario_aprovar', { p_cenario: r1.cenario.id }))), 'aprovar com setores sobrepostos (Alfa × Bravo): recusado; o rascunho pode existir');
  const r2 = await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vA.id, p_dados: dados([it(sA, 0.4), it(sC, 0.3), { setor_id: sB.id, poa: 0, justificativa: 'já vistoriado' }], { atualizado_em: r1b.cenario.atualizado_em, hipoteses: 'H', evidencias: [{ ponto_id: relato.id, confirmada: true }] }) });
  chk(/cenario_versao_desatualizada/.test(await erroDe(rpc(resp1, 'cenario_aprovar', { p_cenario: r2.cenario.id, p_revisao: r1b.cenario.atualizado_em }))), 'revisão esperada diferente da vigente: aprovação recusada');
  const ap = await rpc(resp1, 'cenario_aprovar', { p_cenario: r2.cenario.id, p_revisao: r2.cenario.atualizado_em, p_chave: 'chave-1' });
  chk(ap.cenario.estado === 'aprovada' && ap.cenario.aprovacao_chave === 'chave-1' && !ap.repetida, 'setores com POA zero não contam na sobreposição; aprovada com a revisão certa', ap.cenario);
  const antes = (await db.query(`select count(*)::int n from public.diario where operacao_id = $1 and tipo = 'cenario_aprovado'`, [opG.id])).rows[0].n;
  const again = await rpc(resp1, 'cenario_aprovar', { p_cenario: r2.cenario.id, p_chave: 'chave-1' });
  const depois = (await db.query(`select count(*)::int n from public.diario where operacao_id = $1 and tipo = 'cenario_aprovado'`, [opG.id])).rows[0].n;
  chk(again.repetida === true && again.cenario.id === ap.cenario.id && antes === 1 && depois === 1, 'mesma chave de idempotência repetida: mesmo resultado, sem duplicar o diário');
  chk(/cenario_imutavel_aprovado/.test(await erroDe(rpc(resp1, 'cenario_aprovar', { p_cenario: r2.cenario.id, p_chave: 'outra' }))), 'outra chave para versão já aprovada: recusada');

  console.log('  a versão aprovada não depende do setor nem do ponto');
  await rpc(resp1, 'salvar_setor', { p_operacao: opG.id, p_id: sA.id, p_dados: JSON.stringify({ nome: 'Alfa editado', forma: 'circulo', centro_lat: -25.5, centro_lng: -49.0, raio_m: 50 }) });
  await rpc(resp1, 'excluir_setor', { p_id: sC.id });
  await rpc(resp1, 'excluir_ponto', { p_id: relato.id }).catch(() => db.query(`delete from public.pontos_interesse where id = $1`, [relato.id]));
  const hist = (await db.query(`select setor_nome, setor_id, raio_m, centro_lat, area_m2 from public.busca_cenario_setores where cenario_id = $1 order by setor_nome`, [ap.cenario.id])).rows;
  chk(hist.find((h) => h.setor_nome === 'Alfa').raio_m === 300 && hist.find((h) => h.setor_nome === 'Alfa').centro_lat === -25.40, 'setor editado depois: a geometria da versão aprovada continua a original', hist);
  chk(hist.find((h) => h.setor_nome === 'Charlie').setor_id === null && hist.find((h) => h.setor_nome === 'Charlie').raio_m === 300, 'setor excluído: a versão guarda nome, POA e geometria');
  const ev = (await db.query(`select descricao, ponto_id, confirmada from public.busca_cenario_evidencias where cenario_id = $1`, [ap.cenario.id])).rows;
  chk(ev.length === 1 && ev[0].ponto_id === null && /Pegada/.test(ev[0].descricao) && ev[0].confirmada === true, 'ponto excluído: a evidência da versão aprovada continua legível', ev);
  chk(/cenario_imutavel_aprovado/.test(await erroDe(db.query(`update public.busca_cenario_evidencias set confirmada = false where cenario_id = $1`, [ap.cenario.id]))) && /cenario_imutavel_aprovado/.test(await erroDe(db.query(`delete from public.busca_cenario_evidencias where cenario_id = $1`, [ap.cenario.id]))), 'evidências de versão aprovada não mudam nem somem');
  chk(/cenario_imutavel_aprovado/.test(await erroDe(db.query(`update public.busca_cenarios set hipoteses = 'trocada' where id = $1`, [ap.cenario.id]))), 'hipóteses da versão aprovada não mudam');
  chk((await q(resp2, `select count(*)::int n from public.busca_cenario_evidencias`))[0].n === 0 && (await q(anA, `select count(*)::int n from public.busca_cenario_evidencias`))[0].n === 0, 'evidências só para os responsáveis da operação');

  console.log('  registro de busca: planejada, não estimada, parcial, método e idempotência');
  const reg = (extra) => rpc(resp1, 'busca_registrar', { p_operacao: opG.id, p_dados: JSON.stringify(Object.assign({ setor_id: sA.id, pod: 0.5, base_estimativa: 'Varredura em linha, 5 m entre buscadores' }, extra || {})) });
  chk(/busca_planejada_sem_pod/.test(await erroDe(reg({ finalidade: 'planejada', pod: null }))), 'busca planejada exige POD prevista');
  chk(/busca_cobertura_invalida/.test(await erroDe(reg({ alcance: 'parcial' }))) && /busca_cobertura_invalida/.test(await erroDe(reg({ alcance: 'parcial', cobertura_fracao: 1.2 }))) && /busca_cobertura_invalida/.test(await erroDe(reg({ cobertura_fracao: 0.4 }))), 'busca parcial exige a fração coberta (entre 0 e 1) e só ela');
  chk(/dados_invalidos/.test(await erroDe(reg({ origem_pod: 'modelo_validado' }))), 'POD por modelo validado recusado: não há catálogo de modelos');
  chk(/dados_invalidos/.test(await erroDe(reg({ missao_id: '00000000-0000-0000-0000-000000000000' }))), 'deslocamento (missão) inexistente: recusado');
  const bn = await reg({ pod: null, base_estimativa: 'Equipe sem GPS e sem observador treinado; não há base para estimar' });
  chk(bn.pod === null && bn.finalidade === 'pos_execucao', 'POD não estimada: registrada como nula (não vira zero)', bn);
  const bp = await reg({ finalidade: 'planejada', pod: 0.7 });
  chk(bp.finalidade === 'planejada' && Number(bp.pod) === 0.7, 'POD planejada registrada separada da pós-execução');
  const bc = await reg({ alcance: 'parcial', cobertura_fracao: 0.4, pod: 0.8, metodo: 'A pé, em linha', observadores: 6, impedimentos: 'Córrego cheio', areas_nao_observadas: 'Grota ao sul', origem_pod: 'consenso_documentado', condicoes: 'Visibilidade ruim' });
  chk(bc.alcance === 'parcial' && Number(bc.cobertura_fracao) === 0.4 && bc.metodo === 'A pé, em linha' && bc.observadores === 6 && bc.impedimentos === 'Córrego cheio' && bc.areas_nao_observadas === 'Grota ao sul' && bc.origem_pod === 'consenso_documentado', 'busca parcial com método, observadores, impedimentos e áreas não observadas', bc);
  const k1 = await reg({ chave_cliente: 'envio-1', pod: 0.3 });
  const k2 = await reg({ chave_cliente: 'envio-1', pod: 0.3 });
  chk(k1.id === k2.id && (await db.query(`select count(*)::int n from public.busca_registros where chave_cliente = 'envio-1'`)).rows[0].n === 1, 'reenviar o mesmo registro (mesma chave) não duplica');
  chk(/busca_chave_reutilizada/.test(await erroDe(reg({ chave_cliente: 'envio-1', pod: 0.9 }))), 'mesma chave com outro conteúdo: recusada');
  const tipos = (await db.query(`select tipo, titulo from public.diario where operacao_id = $1 and tipo like 'busca%'`, [opG.id])).rows;
  chk(tipos.some((x) => x.tipo === 'busca_planejada' && /Busca planejada em/.test(x.titulo)) && tipos.some((x) => /POD não estimada/.test(x.titulo)) && tipos.some((x) => /em 40% do setor/.test(x.titulo)), 'diário distingue planejada, não estimada e busca em parte do setor', tipos);
  chk(/busca_registro_imutavel/.test(await erroDe(db.query(`update public.busca_registros set cobertura_fracao = 0.9 where id = $1`, [bc.id]))), 'registro continua sem edição (nem nos campos novos)');

  console.log('  vítima localizada encerra o cenário dela');
  const rbDavi = await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vB.id, p_dados: dados([it(sD, 0.6)]) });
  await rpc(resp1, 'registrar_vitima_encontrada', { p_operacao: opG.id, p_dados: JSON.stringify({ condicao: 'viva', vitima_id: vB.id, local_descricao: 'Margem do rio' }) });
  chk(/cenario_vitima_localizada/.test(await erroDe(rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vB.id, p_dados: dados([it(sD, 0.5)]) }))), 'vítima localizada: não cria nem altera versões');
  chk(/cenario_vitima_localizada/.test(await erroDe(rpc(resp1, 'cenario_aprovar', { p_cenario: rbDavi.cenario.id }))), 'vítima localizada: o rascunho que sobrou não pode ser aprovado');
  const r3 = await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vA.id, p_dados: dados([it(sD, 0.5)], { atualizado_em: null }) });
  chk(r3.cenario.numero === 2 && r3.cenario.base_numero === 1, 'as outras vítimas seguem com os cenários (Clara: nova versão 2)', r3.cenario);

  console.log('  operação encerrada: somente leitura');
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opG.id });
  chk(/operacao_encerrada/.test(await erroDe(reg())) && /operacao_encerrada/.test(await erroDe(rpc(resp1, 'cenario_aprovar', { p_cenario: r3.cenario.id }))), 'encerrada: sem registrar busca nem aprovar');
  chk((await q(resp1, `select count(*)::int n from public.busca_cenario_evidencias where operacao_id = $1`, [opG.id]))[0].n >= 1, 'encerrada: evidências continuam legíveis');
  await db.query(`select set_config('gbs.excluindo_operacao', $1, false)`, [opG.id]);
  await db.query(`delete from public.operacoes where id = $1`, [opG.id]);
  await db.query(`select set_config('gbs.excluindo_operacao', '', false)`);
  chk((await db.query(`select (select count(*) from public.busca_cenario_evidencias where operacao_id = $1) + (select count(*) from public.busca_cenarios where operacao_id = $1) as n`, [opG.id])).rows[0].n == 0, 'excluir a operação apaga tudo (cascata passa pela proteção)');
}

// ---------- Migração 035: pedidos de ajuda com fluxo completo ----------
console.log('\nPedidos de ajuda: estados, prioridade, histórico e escalação — migração 035');
{
  const opH = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP AJUDA', p_retencao_horas: 24, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  const uBeto = await usuario(null, true), uAna = await usuario(null, true);
  const beto = await rpc(uBeto, 'ingressar', { p_token: opH.token_civil, p_nome: 'Beto', p_tipo: 'civil', p_cpf: cpf, p_telefone: tel });
  const ana = await rpc(uAna, 'ingressar', { p_token: opH.token_militar, p_nome: 'Cb Ana', p_tipo: 'militar', p_cpf: cpf, p_telefone: tel });
  const gH = await rpc(resp1, 'salvar_grupo', { p_operacao: opH.id, p_id: null, p_dados: JSON.stringify({ nome: 'Resgate' }) });
  const opOutra = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP OUTRA AJUDA', p_retencao_horas: 24, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  const gOutra = await rpc(resp1, 'salvar_grupo', { p_operacao: opOutra.id, p_id: null, p_dados: JSON.stringify({ nome: 'Grupo de outra operação' }) });
  const q = async (uid, sql, params) => (await como(uid, sql, params)).rows;

  console.log('  criação do pedido');
  await rpc(uBeto, 'participante_enviar_mensagem', { p_participante: beto.participante_id, p_categoria: 'AJUDA', p_texto: 'Torci o pé', p_lat: -22.9, p_lng: -43.2 });
  let ped = (await db.query(`select * from public.pedidos_ajuda where operacao_id = $1`, [opH.id])).rows;
  chk(ped.length === 1 && ped[0].estado === 'recebido' && ped[0].origem === 'botao' && ped[0].prioridade === 'alta' && ped[0].participante_nome === 'Beto' && ped[0].lat === -22.9 && /Torci o pé/.test(ped[0].texto), 'botão "Preciso de ajuda" cria o pedido: recebido, prioridade alta, com localização', ped[0]);
  const P1 = ped[0].id;
  chk((await db.query(`select tipo from public.pedido_ajuda_eventos where pedido_id = $1`, [P1])).rows.map((r) => r.tipo).join() === 'recebido', 'o histórico começa com "recebido"');
  // resposta "preciso de ajuda" a um comando
  const cmd = await rpc(resp1, 'enviar_mensagem', { p_participante: ana.participante_id, p_tipo: 'CONFIRME', p_texto: 'Tudo bem?' });
  await rpc(uAna, 'confirmar_mensagem', { p_mensagem: cmd.id, p_resposta: 'PRECISO_AJUDA' });
  ped = (await db.query(`select * from public.pedidos_ajuda where operacao_id = $1 order by recebido_em`, [opH.id])).rows;
  chk(ped.length === 2 && ped[1].origem === 'resposta' && ped[1].participante_nome === 'Cb Ana' && ped[1].estado === 'recebido', 'resposta "PRECISO DE AJUDA" a um comando também cria um pedido', ped[1]);
  const P2 = ped[1].id;
  await rpc(uAna, 'confirmar_mensagem', { p_mensagem: cmd.id, p_resposta: 'PRECISO_AJUDA' });
  chk((await db.query(`select count(*)::int n from public.pedidos_ajuda where operacao_id = $1`, [opH.id])).rows[0].n === 2, 'repetir a resposta não duplica o pedido');

  console.log('  permissões');
  chk((await q(uBeto, `select count(*)::int n from public.pedidos_ajuda`))[0].n === 0, 'participante não lê pedidos nem histórico');
  chk((await q(resp2, `select count(*)::int n from public.pedidos_ajuda where operacao_id = $1`, [opH.id]))[0].n === 0, 'responsável de outra operação não lê');
  chk((await q(resp1, `select count(*)::int n from public.pedidos_ajuda where operacao_id = $1`, [opH.id]))[0].n === 2, 'responsável da operação lê os pedidos');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'pedido_ajuda_assumir', { p_pedido: P1 }))) && /sem_permissao/.test(await erroDe(rpc(uBeto, 'pedido_ajuda_resolver', { p_pedido: P1, p_resolucao: 'atendido', p_texto: 'forjado pelo próprio' }))), 'quem não é responsável da operação (outra operação ou participante) não altera o pedido');
  chk(/permission denied/i.test(await erroDe(como(resp1, `update public.pedidos_ajuda set estado = 'resolvido' where id = $1`, [P1]))), 'sem escrita direta: só pelas funções');
  chk(/pedido_inexistente/.test(await erroDe(rpc(resp1, 'pedido_ajuda_assumir', { p_pedido: '00000000-0000-0000-0000-000000000000' }))), 'pedido inexistente: recusado');

  console.log('  "ciente" não resolve');
  await db.query(`update public.mensagens set lida_em = now(), lida_por_nome = 'Sgt Um' where operacao_id = $1`, [opH.id]);
  chk((await db.query(`select estado from public.pedidos_ajuda where id = $1`, [P1])).rows[0].estado === 'recebido', 'mensagem lida/ciente não muda o estado do pedido (continua "recebido")');

  console.log('  fluxo: assumir, prioridade, equipe, atendimento, resolução');
  const a1 = await rpc(resp1, 'pedido_ajuda_assumir', { p_pedido: P1 });
  chk(a1.estado === 'assumido' && a1.assumido_por_nome === 'Sgt Um' && a1.assumido_em, 'assumir: estado "assumido" por quem assumiu', a1);
  const a2 = await rpc(resp2, 'pedido_ajuda_assumir', { p_pedido: P1 }).catch((e) => e.message);
  chk(/sem_permissao/.test(String(a2)), 'outro responsável de fora não assume');
  chk(/pedido_prioridade_invalida/.test(await erroDe(rpc(resp1, 'pedido_ajuda_prioridade', { p_pedido: P1, p_prioridade: 'urgentissima' }))), 'prioridade inválida: recusada');
  const pr1 = await rpc(resp1, 'pedido_ajuda_prioridade', { p_pedido: P1, p_prioridade: 'critica' });
  chk(pr1.prioridade === 'critica', 'subir a prioridade não exige justificativa');
  chk(/pedido_justificativa_obrigatoria/.test(await erroDe(rpc(resp1, 'pedido_ajuda_prioridade', { p_pedido: P1, p_prioridade: 'baixa' }))), 'baixar a prioridade exige justificativa');
  const pr2 = await rpc(resp1, 'pedido_ajuda_prioridade', { p_pedido: P1, p_prioridade: 'media', p_justificativa: 'Só torceu o pé, caminha com apoio' });
  chk(pr2.prioridade === 'media', 'baixar com justificativa funciona');
  chk(/pedido_equipe_invalida/.test(await erroDe(rpc(resp1, 'pedido_ajuda_enviar_equipe', { p_pedido: P1, p_grupo: gOutra.id }))), 'equipe de outra operação: recusada');
  const eq = await rpc(resp1, 'pedido_ajuda_enviar_equipe', { p_pedido: P1, p_grupo: gH.id, p_nota: 'Saindo da base' });
  chk(eq.estado === 'equipe_enviada' && eq.equipe_nome === 'Resgate' && eq.equipe_enviada_em, 'enviar equipe: estado "equipe_enviada" com a equipe e a hora', eq);
  const at = await rpc(resp1, 'pedido_ajuda_iniciar_atendimento', { p_pedido: P1, p_nota: 'Equipe chegou' });
  chk(at.estado === 'em_atendimento' && at.atendimento_iniciado_em, 'iniciar atendimento: "em_atendimento"');
  await rpc(resp1, 'pedido_ajuda_nota', { p_pedido: P1, p_texto: 'Imobilizado; aguardando maca' });
  chk(/pedido_resolucao_invalida/.test(await erroDe(rpc(resp1, 'pedido_ajuda_resolver', { p_pedido: P1, p_resolucao: 'resolvido', p_texto: 'texto qualquer' }))), 'tipo de resolução inválido: recusado');
  chk(/pedido_resolucao_sem_texto/.test(await erroDe(rpc(resp1, 'pedido_ajuda_resolver', { p_pedido: P1, p_resolucao: 'atendido', p_texto: 'ok' }))), 'resolver exige justificativa (mín. 5 caracteres)');
  chk((await db.query(`select estado from public.pedidos_ajuda where id = $1`, [P1])).rows[0].estado === 'em_atendimento', 'resolução recusada não muda o estado');
  const rs = await rpc(resp1, 'pedido_ajuda_resolver', { p_pedido: P1, p_resolucao: 'atendido', p_texto: 'Levado à base e entregue ao SAMU' });
  chk(rs.estado === 'resolvido' && rs.resolucao === 'atendido' && rs.resolvido_por_nome === 'Sgt Um' && rs.resolvido_em, 'resolvido: guarda tipo, justificativa, quem e quando', rs);
  chk(/pedido_ja_resolvido/.test(await erroDe(rpc(resp1, 'pedido_ajuda_assumir', { p_pedido: P1 }))) && /pedido_ja_resolvido/.test(await erroDe(rpc(resp1, 'pedido_ajuda_resolver', { p_pedido: P1, p_resolucao: 'outro', p_texto: 'de novo, de novo' }))), 'pedido resolvido não é alterado nem resolvido de novo');
  chk(/pedido_nao_resolvido/.test(await erroDe(rpc(resp1, 'pedido_ajuda_reabrir', { p_pedido: P2, p_motivo: 'não está resolvido' }))), 'só se reabre pedido resolvido');
  const reab = await rpc(resp1, 'pedido_ajuda_reabrir', { p_pedido: P1, p_motivo: 'Dor voltou, precisa de novo atendimento' });
  chk(reab.estado === 'assumido' && reab.resolvido_em === null && reab.resolucao === null, 'reabrir volta para "assumido" e limpa a resolução atual');
  const hist = (await db.query(`select tipo, por_nome, detalhe, dados from public.pedido_ajuda_eventos where pedido_id = $1 order by id`, [P1])).rows;
  chk(hist.map((h) => h.tipo).join() === 'recebido,assumido,prioridade,prioridade,equipe_enviada,em_atendimento,nota,resolvido,reaberto', 'histórico completo, na ordem, sem apagar nada', hist.map((h) => h.tipo));
  chk(hist.find((h) => h.tipo === 'reaberto').dados.resolucao_anterior.resolucao === 'atendido' && /SAMU/.test(hist.find((h) => h.tipo === 'reaberto').dados.resolucao_anterior.texto), 'reabrir preserva a resolução anterior no histórico');
  chk(hist.find((h) => h.tipo === 'prioridade' && /baixa|media/.test(h.detalhe)).dados.justificativa === 'Só torceu o pé, caminha com apoio', 'a justificativa de baixar a prioridade fica no histórico');
  chk(/pedido_historico_imutavel/.test(await erroDe(db.query(`update public.pedido_ajuda_eventos set detalhe = 'forjado' where pedido_id = $1`, [P1]))) && /pedido_historico_imutavel/.test(await erroDe(db.query(`delete from public.pedido_ajuda_eventos where pedido_id = $1`, [P1]))), 'gatilho: o histórico não é editado nem apagado');
  chk((await db.query(`select count(*)::int n from public.diario where operacao_id = $1 and tipo like 'pedido_ajuda_%'`, [opH.id])).rows[0].n >= 9, 'cada passo entra no diário');

  console.log('  escalação e tempo sem atendimento');
  await db.query(`update public.pedidos_ajuda set estado_em = now() - interval '10 minutes' where id = $1`, [P2]);
  chk((await rpc(resp1, 'verificar_pedidos_ajuda', { p_operacao: opH.id })) === 1, 'pedido recebido há 10 min (prioridade alta: prazo de 3 min) sem ninguém assumir: escala');
  const alE = (await db.query(`select tipo, nivel, titulo, texto, participante_id from public.alertas where operacao_id = $1 and tipo = 'ajuda_sem_atendimento'`, [opH.id])).rows;
  chk(alE.length === 1 && alE[0].nivel === 'critico' && /SEM ATENDIMENTO — Cb Ana/.test(alE[0].titulo) && /Ninguém assumiu/.test(alE[0].texto) && alE[0].participante_id === ana.participante_id, 'alerta crítico com o tempo sem atendimento e o nome', alE);
  chk((await rpc(resp1, 'verificar_pedidos_ajuda', { p_operacao: opH.id })) === 0, 'o mesmo prazo não repete o alerta');
  chk((await db.query(`select escalonamentos from public.pedidos_ajuda where id = $1`, [P2])).rows[0].escalonamentos === 1, 'o pedido conta as escalações');
  await db.query(`update public.pedidos_ajuda set estado_em = now() - interval '20 minutes' where id = $1`, [P2]);
  chk((await rpc(resp1, 'verificar_pedidos_ajuda', { p_operacao: opH.id })) === 1, 'passou outro prazo: escala de novo (nunca "esquece")');
  chk((await db.query(`select count(*)::int n from public.pedido_ajuda_eventos where pedido_id = $1 and tipo = 'escalado'`, [P2])).rows[0].n === 2, 'cada escalação fica no histórico');
  await rpc(resp1, 'pedido_ajuda_assumir', { p_pedido: P2 });
  await db.query(`update public.pedidos_ajuda set estado_em = now() - interval '5 minutes' where id = $1`, [P2]);
  chk((await rpc(resp1, 'verificar_pedidos_ajuda', { p_operacao: opH.id })) === 0, 'assumido há 5 min (prazo de 9 min sem equipe): ainda não escala');
  await db.query(`update public.pedidos_ajuda set estado_em = now() - interval '10 minutes' where id = $1`, [P2]);
  chk((await rpc(resp1, 'verificar_pedidos_ajuda', { p_operacao: opH.id })) === 1 && /PARADO — Cb Ana/.test((await db.query(`select titulo from public.alertas where chave like $1 || '%' order by id desc limit 1`, ['ajuda:' + P2])).rows[0].titulo), 'assumido mas sem equipe enviada além do prazo: escala como "parado"');
  await rpc(resp1, 'pedido_ajuda_iniciar_atendimento', { p_pedido: P2 });
  await db.query(`update public.pedidos_ajuda set estado_em = now() - interval '2 hours' where id = $1`, [P2]);
  chk((await rpc(resp1, 'verificar_pedidos_ajuda', { p_operacao: opH.id })) === 0, 'em atendimento não escala');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'verificar_pedidos_ajuda', { p_operacao: opH.id }))), 'só responsável da operação (ou o agendador) verifica');
  chk((await db.query(`select public.verificar_pedidos_ajuda() n`)).rows[0].n === 0, 'o agendador (sem usuário) também pode verificar');

  console.log('  o participante vê só o estado do próprio pedido');
  const mp = await rpc(uBeto, 'meu_pedido_ajuda', { p_participante: beto.participante_id });
  chk(mp.estado === 'assumido' && mp.assumido === true && !('assumido_por_nome' in mp) && !('resolucao_texto' in mp), 'participante vê o estado, sem nomes de quem atende nem anotações', mp);
  chk(/participante_invalido/.test(await erroDe(rpc(uBeto, 'meu_pedido_ajuda', { p_participante: ana.participante_id }))), 'participante não consulta o pedido de outro');

  console.log('  pedidos anteriores ao fluxo (carga inicial) e reexecução');
  const msgVelha = await db.query(`insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto, direcao, categoria, criada_em)
    values ($1, $2, $3, 'Beto', 'PARTICIPANTE', 'socorro antigo', 'entrada', 'AJUDA', now() - interval '3 days') returning id`, [opH.id, beto.participante_id, uBeto]);
  await db.query(`delete from public.pedidos_ajuda where mensagem_id = $1`, [msgVelha.rows[0].id]);
  await db.exec(ler('supabase/migracoes/035_pedidos_ajuda.sql'));
  const legado = (await db.query(`select estado, resolucao, resolucao_texto from public.pedidos_ajuda where mensagem_id = $1`, [msgVelha.rows[0].id])).rows;
  chk(legado.length === 1 && legado[0].estado === 'resolvido' && /anterior ao fluxo/.test(legado[0].resolucao_texto), 'pedido antigo (mais de 24 h) entra resolvido, marcado como registro anterior ao fluxo', legado);
  chk((await db.query(`select count(*)::int n from public.pedidos_ajuda where mensagem_id = $1`, [msgVelha.rows[0].id])).rows[0].n === 1, 'reexecutar a migração não duplica');

  console.log('  operação encerrada: somente leitura');
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opH.id });
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'pedido_ajuda_assumir', { p_pedido: P2 }))) && /operacao_encerrada/.test(await erroDe(rpc(resp1, 'pedido_ajuda_resolver', { p_pedido: P2, p_resolucao: 'outro', p_texto: 'depois de encerrar' }))), 'encerrada: pedidos não mudam');
  chk((await q(resp1, `select count(*)::int n from public.pedido_ajuda_eventos where operacao_id = $1`, [opH.id]))[0].n > 10, 'encerrada: o histórico continua legível');
  chk((await rpc(resp1, 'verificar_pedidos_ajuda', { p_operacao: opH.id })) === 0, 'encerrada: não escala');
  const pubA = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`)).rows.map((r) => r.tablename);
  chk(pubA.includes('pedidos_ajuda') && pubA.includes('pedido_ajuda_eventos'), 'pedidos e histórico publicados no Realtime');
}

// ---------- Migração 036: recursos e disponibilidade das equipes ----------
console.log('\nRecursos e disponibilidade das equipes — migração 036');
{
  const opR = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP RECURSOS', p_retencao_horas: 24, p_dados: JSON.stringify({ tipo: 'aquatica' }) });
  const gR = await rpc(resp1, 'salvar_grupo', { p_operacao: opR.id, p_id: null, p_dados: JSON.stringify({ nome: 'Aquático' }) });
  const uCiv = await usuario(null, true);
  const q = async (uid, sql, params) => (await como(uid, sql, params)).rows;
  const def = await db.query(`select disponibilidade, disponibilidade_obs, capacidades, disponivel_em from public.grupos where id = $1`, [gR.id]);
  chk(def.rows[0].disponibilidade === 'disponivel' && def.rows[0].capacidades === '' && def.rows[0].disponivel_em === null, 'grupo novo: disponível, sem capacidades nem recursos');

  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'salvar_recursos_grupo', { p_grupo: gR.id, p_dados: JSON.stringify({ disponibilidade: 'indisponivel' }) }))) && /sem_permissao/.test(await erroDe(rpc(uCiv, 'salvar_recursos_grupo', { p_grupo: gR.id, p_dados: JSON.stringify({}) }))), 'quem não é responsável da operação não altera recursos');
  chk(/grupo_inexistente/.test(await erroDe(rpc(resp1, 'salvar_recursos_grupo', { p_grupo: '00000000-0000-0000-0000-000000000000', p_dados: '{}' }))), 'grupo inexistente: recusado');
  const ruim = (r) => rpc(resp1, 'salvar_recursos_grupo', { p_grupo: gR.id, p_dados: JSON.stringify(r) });
  chk(/dados_invalidos/.test(await erroDe(ruim({ disponibilidade: 'dormindo' }))) && /dados_invalidos/.test(await erroDe(ruim({ recursos: [{ tipo: 'foguete' }] }))) && /dados_invalidos/.test(await erroDe(ruim({ recursos: [{ tipo: 'drone', quantidade: 0 }] })))
    && /dados_invalidos/.test(await erroDe(ruim({ recursos: [{ tipo: 'drone', quantidade: 100 }] }))) && /dados_invalidos/.test(await erroDe(ruim({ recursos: [{ tipo: 'drone', situacao: 'quebrado' }] }))) && /dados_invalidos/.test(await erroDe(ruim({ recursos: 'tudo' }))), 'disponibilidade, tipo, quantidade e situação inválidos: recusados');
  chk(/dados_invalidos/.test(await erroDe(ruim({ recursos: Array.from({ length: 31 }, () => ({ tipo: 'outro' })) }))), 'mais de 30 recursos: recusado');
  chk((await db.query(`select count(*)::int n from public.grupo_recursos where grupo_id = $1`, [gR.id])).rows[0].n === 0, 'pedido recusado não grava nada pela metade');

  const r1 = await rpc(resp1, 'salvar_recursos_grupo', { p_grupo: gR.id, p_dados: JSON.stringify({
    disponibilidade: 'em_descanso', disponibilidade_obs: 'Turno de 12 h terminado', disponivel_em: '2026-10-28T20:00:00Z', capacidades: 'Mergulho autônomo; resgate aquático',
    recursos: [
      { tipo: 'embarcacao', identificacao: 'Bote ABT-3', quantidade: 1, situacao: 'operacional' },
      { tipo: 'viatura', identificacao: 'VTR ABT-12', quantidade: 2 },
      { tipo: 'drone', identificacao: 'Mavic 3T', situacao: 'limitado', observacao: 'Bateria reserva única' },
      { tipo: 'cao_busca', identificacao: 'Thor', quantidade: 1 },
      { tipo: 'comunicacao', identificacao: 'HT UHF', quantidade: 6 },
      { tipo: 'primeiros_socorros', identificacao: 'Mochila APH', quantidade: 1 },
    ] }) });
  chk(r1.grupo.disponibilidade === 'em_descanso' && r1.grupo.capacidades === 'Mergulho autônomo; resgate aquático' && r1.grupo.recursos_atualizado_por_nome === 'Sgt Um' && r1.recursos.length === 6, 'salva disponibilidade, capacidades e os seis tipos de recurso', r1.grupo);
  const rec = (await q(resp1, `select tipo, identificacao, quantidade, situacao, observacao from public.grupo_recursos where grupo_id = $1 order by tipo`, [gR.id]));
  chk(rec.find((x) => x.tipo === 'viatura').quantidade === 2 && rec.find((x) => x.tipo === 'drone').situacao === 'limitado' && rec.find((x) => x.tipo === 'drone').observacao === 'Bateria reserva única' && rec.find((x) => x.tipo === 'embarcacao').situacao === 'operacional', 'quantidade, situação e observação por recurso', rec);
  chk((await q(resp2, `select count(*)::int n from public.grupo_recursos`))[0].n === 0 && (await q(uCiv, `select count(*)::int n from public.grupo_recursos`))[0].n === 0, 'recursos só para os responsáveis da operação');
  chk(/permission denied/i.test(await erroDe(como(resp1, `delete from public.grupo_recursos where grupo_id = $1`, [gR.id]))), 'sem escrita direta nos recursos');
  const dia = (await db.query(`select titulo, detalhe from public.diario where operacao_id = $1 and tipo = 'equipe_recursos'`, [opR.id])).rows;
  chk(dia.length === 1 && /Equipe Aquático: disponibilidade em descanso/.test(dia[0].titulo) && /Bote ABT-3/.test(dia[0].detalhe) && /viatura ×2 \(VTR ABT-12\)/.test(dia[0].detalhe) && /Mergulho/.test(dia[0].detalhe) && /Volta a ficar disponível: 28\/10 17:00/.test(dia[0].detalhe), 'mudança entra no diário com recursos, capacidades e hora de retorno', dia);

  // só as chaves enviadas mudam; "recursos" substitui a lista inteira
  const r2 = await rpc(resp1, 'salvar_recursos_grupo', { p_grupo: gR.id, p_dados: JSON.stringify({ disponibilidade: 'disponivel', disponivel_em: null }) });
  chk(r2.grupo.disponibilidade === 'disponivel' && r2.grupo.capacidades === 'Mergulho autônomo; resgate aquático' && r2.recursos.length === 6 && r2.grupo.disponivel_em === null, 'sem "recursos" na chamada, a lista continua; as capacidades também');
  const r3 = await rpc(resp1, 'salvar_recursos_grupo', { p_grupo: gR.id, p_dados: JSON.stringify({ recursos: [{ tipo: 'viatura', identificacao: 'VTR nova' }] }) });
  chk(r3.recursos.length === 1 && r3.recursos[0].identificacao === 'VTR nova' && r3.grupo.disponibilidade === 'disponivel', 'com "recursos", a lista é substituída');
  const r4 = await rpc(resp1, 'salvar_recursos_grupo', { p_grupo: gR.id, p_dados: JSON.stringify({ recursos: [] }) });
  chk(r4.recursos.length === 0, 'lista vazia limpa os recursos');
  const dia2 = (await db.query(`select titulo from public.diario where operacao_id = $1 and tipo = 'equipe_recursos' order by id`, [opR.id])).rows.map((x) => x.titulo);
  chk(dia2.length === 4 && /recursos atualizados/.test(dia2[2]) && /disponibilidade disponível/.test(dia2[1]), 'o diário distingue mudança de disponibilidade de mudança de recursos', dia2);

  console.log('  excluir equipe e operação encerrada');
  await rpc(resp1, 'salvar_recursos_grupo', { p_grupo: gR.id, p_dados: JSON.stringify({ recursos: [{ tipo: 'drone' }] }) });
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opR.id });
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'salvar_recursos_grupo', { p_grupo: gR.id, p_dados: JSON.stringify({ disponibilidade: 'indisponivel' }) }))), 'operação encerrada: recursos e disponibilidade não mudam');
  chk((await q(resp1, `select count(*)::int n from public.grupo_recursos where grupo_id = $1`, [gR.id]))[0].n === 1, 'encerrada: continua legível');
  const opR2 = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP RECURSOS 2', p_retencao_horas: 24, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  const gR2 = await rpc(resp1, 'salvar_grupo', { p_operacao: opR2.id, p_id: null, p_dados: JSON.stringify({ nome: 'Terrestre' }) });
  await rpc(resp1, 'salvar_recursos_grupo', { p_grupo: gR2.id, p_dados: JSON.stringify({ recursos: [{ tipo: 'cao_busca', identificacao: 'Rex' }] }) });
  await rpc(resp1, 'excluir_grupo', { p_id: gR2.id });
  chk((await db.query(`select count(*)::int n from public.grupo_recursos where grupo_id = $1`, [gR2.id])).rows[0].n === 0, 'excluir a equipe apaga os recursos dela');
  const pubR = (await db.query(`select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'grupo_recursos'`)).rows;
  chk(pubR.length === 1, 'recursos publicados no Realtime');
}

// ---------- Migração 037: briefing da operação e passagem de comando ----------
console.log('\nBriefing e passagem de comando — migração 037');
{
  const resp3 = await usuario('r3@cbm', false), resp4 = await usuario('r4@cbm', false), resp5 = await usuario('r5@cbm', false);
  await db.query(`insert into public.responsaveis (user_id, nome) values ($1, 'Cap Três'), ($2, 'Ten Quatro'), ($3, 'Sd Cinco')`, [resp3, resp4, resp5]);
  await db.query(`update public.responsaveis set ativo = false where user_id = $1`, [resp5]);
  const q = async (uid, sql, params) => (await como(uid, sql, params)).rows;
  const opB = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP BRIEFING', p_retencao_horas: 24, p_dados: JSON.stringify({ tipo: 'terrestre', descricao: 'Busca de idoso com demência desaparecido na mata' }) });
  await db.query(`insert into public.operacao_responsaveis (operacao_id, user_id) values ($1, $2), ($1, $3), ($1, $4)`, [opB.id, resp2, resp3, resp5]);
  const uBeto = await usuario(null, true);

  console.log('  comando inicial');
  const c0 = (await db.query(`select comando_user_id, comando_nome, comando_desde, criada_em from public.operacoes where id = $1`, [opB.id])).rows[0];
  chk(c0.comando_user_id === resp1 && c0.comando_nome === 'Sgt Um' && +c0.comando_desde === +c0.criada_em, 'operação nova: o comando começa com quem criou');
  chk((await db.query(`select count(*)::int n from public.operacoes where comando_user_id is null`)).rows[0].n === 0, 'operações que já existiam também ficaram com um comandante (o criador)');

  // dados para o briefing: vítima, último local visto, risco, equipe sem comunicação, cenário aprovado, pedido de ajuda, decisão
  const vit = await rpc(resp1, 'salvar_vitima', { p_operacao: opB.id, p_id: null, p_dados: JSON.stringify({ nome: 'Seu Antônio', idade: 78, caracteristicas: 'Usa bengala', roupas: 'Camisa xadrez', perfil: ['idoso', 'demencia'] }) });
  const vit2 = await rpc(resp1, 'salvar_vitima', { p_operacao: opB.id, p_id: null, p_dados: JSON.stringify({ nome: 'Dona Maria' }) });
  const setB = await rpc(resp1, 'salvar_setor', { p_operacao: opB.id, p_id: null, p_dados: JSON.stringify({ nome: 'Mata Norte', forma: 'circulo', centro_lat: -25.4, centro_lng: -49.2, raio_m: 300 }) });
  await rpc(resp1, 'salvar_setor', { p_operacao: opB.id, p_id: null, p_dados: JSON.stringify({ nome: 'Rio Sul', forma: 'circulo', centro_lat: -25.45, centro_lng: -49.2, raio_m: 300 }) });
  await rpc(resp1, 'salvar_ponto', { p_operacao: opB.id, p_id: null, p_dados: JSON.stringify({ categoria: 'ULTIMA_LOCALIZACAO', titulo: 'Casa do filho', lat: -25.401, lng: -49.2, descricao: 'Saiu às 14h' }) });
  await rpc(resp1, 'salvar_ponto', { p_operacao: opB.id, p_id: null, p_dados: JSON.stringify({ categoria: 'RISCO', titulo: 'Barranco instável', lat: -25.402, lng: -49.2, descricao: 'Queda de 8 m' }) });
  const gB = await rpc(resp1, 'salvar_grupo', { p_operacao: opB.id, p_id: null, p_dados: JSON.stringify({ nome: 'Alfa' }) });
  await rpc(resp1, 'salvar_recursos_grupo', { p_grupo: gB.id, p_dados: JSON.stringify({ disponibilidade: 'em_descanso', capacidades: 'Busca em mata', recursos: [{ tipo: 'drone', identificacao: 'Mavic' }, { tipo: 'primeiros_socorros', identificacao: 'Mochila' }] }) });
  const rasc = await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vit.id, p_dados: JSON.stringify({ justificativa: 'Perto da casa do filho, trilha conhecida', hipoteses: 'Seguiu a trilha da mata', limitacoes: 'Sem testemunha', confianca: 'media',
    setores: [{ setor_id: setB.id, poa: 0.7, justificativa: '' }] }) });
  await rpc(resp1, 'cenario_aprovar', { p_cenario: rasc.cenario.id });
  const beto = await rpc(uBeto, 'ingressar', { p_token: opB.token_civil, p_nome: 'Beto', p_tipo: 'civil', p_cpf: cpf, p_telefone: tel });
  await rpc(uBeto, 'participante_enviar_mensagem', { p_participante: beto.participante_id, p_categoria: 'AJUDA', p_texto: 'Machuquei a perna' });
  await rpc(resp1, 'decisao_criar', { p_operacao: opB.id, p_dados: JSON.stringify({ texto: 'Pedir apoio aéreo ao CBMPR?', responsavel: 'Cmt Geral', prazo: '2026-10-28T22:00:00Z' }) });

  console.log('  o briefing é montado com o que já existe');
  chk(/sem_permissao/.test(await erroDe(rpc(resp4, 'briefing_operacao_dados', { p_operacao: opB.id }))) && /sem_permissao/.test(await erroDe(rpc(uBeto, 'briefing_operacao_dados', { p_operacao: opB.id }))), 'só os responsáveis da operação leem o briefing');
  const b = await rpc(resp1, 'briefing_operacao_dados', { p_operacao: opB.id });
  chk(b.operacao.codigo === 'OP BRIEFING' && b.comando.nome === 'Sgt Um' && b.objetivo.texto === '' && /idoso com demência/.test(b.objetivo.sugerido), 'objetivo: sugerido pela descrição da operação (sem digitar de novo) e comando atual', b.objetivo);
  chk(b.vitimas.length === 2 && b.vitimas[0].nome === 'Seu Antônio' && b.vitimas[0].perfil.includes('demencia') && b.vitimas[0].idade === 78, 'vítimas vêm da ficha');
  chk(b.ultimo_local_visto.length === 1 && b.ultimo_local_visto[0].titulo === 'Casa do filho' && b.ultimo_local_visto[0].lat === -25.401, 'último local visto vem dos pontos de interesse');
  chk(b.hipoteses.length === 1 && b.hipoteses[0].vitima === 'Seu Antônio' && b.hipoteses[0].hipoteses === 'Seguiu a trilha da mata' && b.hipoteses[0].setores[0].nome === 'Mata Norte' && Number(b.hipoteses[0].setores[0].poa) === 0.7, 'hipóteses vêm do cenário aprovado (versão, hipóteses, limitações e setores com POA)', b.hipoteses);
  chk(b.riscos.pontos.length === 1 && b.riscos.pontos[0].titulo === 'Barranco instável' && b.riscos.pedidos_ajuda_abertos === 1, 'riscos: pontos de risco e pedidos de ajuda abertos');
  const alfa = b.equipes.find((e) => e.nome === 'Alfa');
  chk(alfa.disponibilidade_efetiva === 'em_descanso' && alfa.capacidades === 'Busca em mata' && alfa.recursos.length === 2 && alfa.sem_comunicacao === true && alfa.sem_primeiros_socorros === false, 'equipes: disponibilidade, recursos e alerta de "sem equipamento de comunicação"', alfa);
  chk(b.tarefas.setores.total === 2 && b.tarefas.setores.pendente === 2 && b.tarefas.setores.pendentes.length === 2 && b.tarefas.deslocamentos.length === 0, 'tarefas: setores por situação e deslocamentos ativos');
  chk(b.comunicacoes.dados.ultimas.length === 1 && /Machuquei a perna/.test(b.comunicacoes.dados.ultimas[0].texto) && b.comunicacoes.dados.ultimas[0].de === 'Beto', 'comunicações: últimas mensagens recebidas do campo');
  chk(b.decisoes_pendentes.length === 1 && b.decisoes_pendentes[0].texto === 'Pedir apoio aéreo ao CBMPR?' && b.decisoes_pendentes[0].responsavel === 'Cmt Geral', 'decisões pendentes escritas pelo comando');
  const auto = b.decisoes_automaticas.map((x) => x.texto);
  chk(auto.some((x) => /Pedido de ajuda de Beto \(recebido, prioridade alta\)/.test(x)) && auto.some((x) => /Vítima Dona Maria sem cenário/.test(x)) && !auto.some((x) => /Seu Antônio sem cenário/.test(x)), 'decisões que o sistema vê esperando: pedido de ajuda aberto, vítima sem cenário aprovado', auto);

  console.log('  textos do comando e decisões');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'salvar_briefing', { p_operacao: opB.id, p_dados: JSON.stringify({ objetivo: 'x'.repeat(1001) }) }))) && /sem_permissao/.test(await erroDe(rpc(resp4, 'salvar_briefing', { p_operacao: opB.id, p_dados: '{}' }))), 'texto acima de 1000 caracteres e quem não é responsável: recusados');
  await rpc(resp1, 'salvar_briefing', { p_operacao: opB.id, p_dados: JSON.stringify({ objetivo: 'Localizar o Sr. Antônio com vida', comunicacoes: 'Canal 3 UHF; QG 41 99999-0000' }) });
  await rpc(resp2, 'salvar_briefing', { p_operacao: opB.id, p_dados: JSON.stringify({ riscos: 'Chuva forte prevista às 18h' }) });
  const b2 = await rpc(resp1, 'briefing_operacao_dados', { p_operacao: opB.id });
  chk(b2.objetivo.texto === 'Localizar o Sr. Antônio com vida' && b2.comunicacoes.texto === 'Canal 3 UHF; QG 41 99999-0000' && b2.riscos.texto === 'Chuva forte prevista às 18h', 'só as chaves enviadas mudam; qualquer responsável da operação edita');
  chk(/decisao_texto_invalido/.test(await erroDe(rpc(resp1, 'decisao_criar', { p_operacao: opB.id, p_dados: JSON.stringify({ texto: 'oi' }) }))), 'decisão com texto curto: recusada');
  const dec = b2.decisoes_pendentes[0];
  chk(/decisao_sem_texto/.test(await erroDe(rpc(resp1, 'decisao_resolver', { p_decisao: dec.id, p_estado: 'decidida', p_texto: '' }))), 'decidir exige o texto da decisão');
  const dd = await rpc(resp2, 'decisao_resolver', { p_decisao: dec.id, p_estado: 'decidida', p_texto: 'Apoio aéreo solicitado às 16h10' });
  chk(dd.estado === 'decidida' && dd.decidida_por_nome === 'Sgt Dois', 'decisão tomada: guarda a decisão, quem e quando');
  chk(/decisao_ja_resolvida/.test(await erroDe(rpc(resp1, 'decisao_resolver', { p_decisao: dec.id, p_estado: 'cancelada', p_texto: 'x' }))), 'decisão já resolvida não muda');
  chk((await rpc(resp1, 'briefing_operacao_dados', { p_operacao: opB.id })).decisoes_pendentes.length === 0, 'decidida sai da lista de pendentes');
  const dec2 = await rpc(resp1, 'decisao_criar', { p_operacao: opB.id, p_dados: JSON.stringify({ texto: 'Trocar o turno das 18h?' }) });
  await rpc(resp1, 'decisao_resolver', { p_decisao: dec2.id, p_estado: 'cancelada', p_texto: 'Não será necessário' });
  chk((await db.query(`select count(*)::int n from public.diario where operacao_id = $1 and tipo in ('decisao_pendente', 'decisao_decidida', 'decisao_cancelada', 'briefing_atualizado')`, [opB.id])).rows[0].n === 6, 'briefing e decisões entram no diário');

  console.log('  passagem de comando: foto, aceite e horário');
  chk(/passagem_so_do_comandante/.test(await erroDe(rpc(resp2, 'passagem_iniciar', { p_operacao: opB.id, p_para: resp3 }))), 'só quem está no comando passa o comando');
  chk(/passagem_destino_invalido/.test(await erroDe(rpc(resp1, 'passagem_iniciar', { p_operacao: opB.id, p_para: resp1 }))) && /passagem_destino_invalido/.test(await erroDe(rpc(resp1, 'passagem_iniciar', { p_operacao: opB.id, p_para: resp4 })))
    && /passagem_destino_invalido/.test(await erroDe(rpc(resp1, 'passagem_iniciar', { p_operacao: opB.id, p_para: resp5 }))), 'destino inválido: a própria pessoa, quem não é da operação e responsável suspenso');
  const p1 = await rpc(resp1, 'passagem_iniciar', { p_operacao: opB.id, p_para: resp2, p_nota: 'Vou para o QG; atenção à chuva às 18h' });
  chk(p1.estado === 'pendente' && p1.para_nome === 'Sgt Dois' && p1.de_nome === 'Sgt Um' && p1.respondida_em === null && p1.resumo.vitimas.length === 2 && p1.resumo.hipoteses[0].hipoteses === 'Seguiu a trilha da mata' && p1.resumo.objetivo.texto === 'Localizar o Sr. Antônio com vida', 'passagem pendente guarda a foto do briefing (objetivo, vítimas, hipóteses…) e a nota', { e: p1.estado, para: p1.para_nome });
  chk((await db.query(`select comando_nome from public.operacoes where id = $1`, [opB.id])).rows[0].comando_nome === 'Sgt Um', 'o comando NÃO muda enquanto não houver aceite');
  chk(/passagem_pendente_existente/.test(await erroDe(rpc(resp1, 'passagem_iniciar', { p_operacao: opB.id, p_para: resp3 }))), 'só uma passagem pendente por vez');
  chk(/sem_permissao/.test(await erroDe(rpc(resp3, 'passagem_responder', { p_passagem: p1.id, p_aceitar: true }))) && /sem_permissao/.test(await erroDe(rpc(resp1, 'passagem_responder', { p_passagem: p1.id, p_aceitar: true }))), 'só quem recebe responde (nem o outro responsável, nem quem passou)');
  // a situação muda depois da foto
  await rpc(resp1, 'salvar_vitima', { p_operacao: opB.id, p_id: vit2.id, p_dados: JSON.stringify({ nome: 'Dona Maria Silva' }) });
  const ac = await rpc(resp2, 'passagem_responder', { p_passagem: p1.id, p_aceitar: true, p_nota: 'Recebido' });
  chk(ac.estado === 'aceita' && ac.respondida_em && ac.resposta_nota === 'Recebido', 'aceite: guarda o estado, a hora e a nota');
  const cmd = (await db.query(`select comando_user_id, comando_nome, comando_desde from public.operacoes where id = $1`, [opB.id])).rows[0];
  chk(cmd.comando_user_id === resp2 && cmd.comando_nome === 'Sgt Dois' && +cmd.comando_desde === +new Date(ac.respondida_em), 'no aceite o comando passa para quem recebeu, com a hora do aceite', cmd);
  chk((await q(resp1, `select resumo from public.passagens_comando where id = $1`, [p1.id]))[0].resumo.vitimas.map((x) => x.nome).includes('Dona Maria'), 'a foto guardada continua a de quando o comando foi passado (não muda com o que mudou depois)');
  chk(/passagem_nao_pendente/.test(await erroDe(rpc(resp2, 'passagem_responder', { p_passagem: p1.id, p_aceitar: false, p_nota: 'mudei de ideia' }))), 'passagem já respondida não se responde de novo');
  chk(/passagem_imutavel/.test(await erroDe(db.query(`update public.passagens_comando set resumo = '{}'::jsonb where id = $1`, [p1.id]))) && /passagem_imutavel/.test(await erroDe(db.query(`update public.passagens_comando set estado = 'recusada' where id = $1`, [p1.id])))
    && /passagem_imutavel/.test(await erroDe(db.query(`delete from public.passagens_comando where id = $1`, [p1.id]))), 'gatilho: foto, quem passou/recebeu e resposta não mudam nem se apagam');
  const diaC = (await db.query(`select titulo, nivel from public.diario where operacao_id = $1 and tipo = 'comando_assumido'`, [opB.id])).rows;
  chk(diaC.length === 1 && /Sgt Um passou o comando a Sgt Dois/.test(diaC[0].titulo) && diaC[0].nivel === 'critico', 'o aceite entra no diário como evento de destaque', diaC);

  console.log('  recusa e cancelamento');
  const p2 = await rpc(resp2, 'passagem_iniciar', { p_operacao: opB.id, p_para: resp3 });
  chk(/passagem_recusa_sem_motivo/.test(await erroDe(rpc(resp3, 'passagem_responder', { p_passagem: p2.id, p_aceitar: false, p_nota: '' }))), 'recusar exige motivo');
  const rf = await rpc(resp3, 'passagem_responder', { p_passagem: p2.id, p_aceitar: false, p_nota: 'Estou de saída, passe a outro' });
  chk(rf.estado === 'recusada' && (await db.query(`select comando_nome from public.operacoes where id = $1`, [opB.id])).rows[0].comando_nome === 'Sgt Dois', 'recusada: o comando continua com quem já estava');
  const p3 = await rpc(resp2, 'passagem_iniciar', { p_operacao: opB.id, p_para: resp3 });
  chk(/sem_permissao/.test(await erroDe(rpc(resp3, 'passagem_cancelar', { p_passagem: p3.id }))), 'quem recebe não cancela a passagem de outro');
  const cn = await rpc(resp2, 'passagem_cancelar', { p_passagem: p3.id });
  chk(cn.estado === 'cancelada' && /passagem_nao_pendente/.test(await erroDe(rpc(resp2, 'passagem_cancelar', { p_passagem: p3.id }))), 'quem passou cancela enquanto está pendente');

  console.log('  comandante ausente: assumir com motivo');
  const p4 = await rpc(resp2, 'passagem_iniciar', { p_operacao: opB.id, p_para: resp3 });
  chk(/comando_ja_seu/.test(await erroDe(rpc(resp2, 'comando_assumir', { p_operacao: opB.id, p_motivo: 'já estou no comando' }))), 'quem já comanda não precisa assumir');
  chk(/comando_motivo_obrigatorio/.test(await erroDe(rpc(resp3, 'comando_assumir', { p_operacao: opB.id, p_motivo: 'curto' }))), 'assumir exige motivo (mín. 10 caracteres)');
  chk(/sem_permissao/.test(await erroDe(rpc(resp4, 'comando_assumir', { p_operacao: opB.id, p_motivo: 'não sou da operação, mas quero' }))), 'só responsável da operação assume');
  const as = await rpc(resp1, 'comando_assumir', { p_operacao: opB.id, p_motivo: 'Dr Dois sem rádio há 40 minutos; assumindo para manter a busca' });
  chk(as.tipo === 'assuncao' && as.estado === 'assumida' && as.de_nome === 'Sgt Dois' && as.para_nome === 'Sgt Um' && /sem rádio/.test(as.motivo) && as.resumo.operacao.codigo === 'OP BRIEFING', 'assumir: registra de quem, para quem, o motivo e a foto do briefing', as);
  chk((await db.query(`select estado from public.passagens_comando where id = $1`, [p4.id])).rows[0].estado === 'cancelada' && (await db.query(`select comando_nome from public.operacoes where id = $1`, [opB.id])).rows[0].comando_nome === 'Sgt Um', 'a passagem pendente é cancelada e o comando muda');
  const diaA = (await db.query(`select titulo, nivel, detalhe from public.diario where operacao_id = $1 and tipo = 'comando_assumido_sem_aceite'`, [opB.id])).rows;
  chk(diaA.length === 1 && diaA[0].nivel === 'critico' && /sem aceite/.test(diaA[0].titulo) && /Dr Dois sem rádio/.test(diaA[0].detalhe), 'assumir sem aceite fica no diário em destaque, com o motivo');
  const hist = (await q(resp1, `select tipo, estado from public.passagens_comando where operacao_id = $1 order by criada_em, id`, [opB.id]));
  chk(hist.map((h) => h.estado).join() === 'aceita,recusada,cancelada,cancelada,assumida', 'histórico completo das passagens', hist);
  chk((await q(uBeto, `select count(*)::int n from public.passagens_comando`))[0].n === 0 && (await q(resp4, `select count(*)::int n from public.decisoes_pendentes`))[0].n === 0 && (await q(resp4, `select count(*)::int n from public.briefing_operacao`))[0].n === 0, 'participante e responsável de fora não leem passagens, decisões nem briefing');
  chk(/permission denied/i.test(await erroDe(como(resp1, `update public.operacoes set comando_nome = 'forjado' where id = $1`, [opB.id]))), 'o comando não muda por escrita direta');

  console.log('  operação encerrada: somente leitura');
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opB.id });
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'passagem_iniciar', { p_operacao: opB.id, p_para: resp2 }))) && /operacao_encerrada/.test(await erroDe(rpc(resp1, 'salvar_briefing', { p_operacao: opB.id, p_dados: '{"objetivo":"x"}' })))
    && /operacao_encerrada/.test(await erroDe(rpc(resp2, 'comando_assumir', { p_operacao: opB.id, p_motivo: 'depois de encerrar a operação' }))), 'encerrada: sem passagem, briefing nem assumir comando');
  chk((await rpc(resp1, 'briefing_operacao_dados', { p_operacao: opB.id })).operacao.status === 'encerrada', 'encerrada: o briefing continua legível');
  const pubB = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`)).rows.map((r) => r.tablename);
  chk(['briefing_operacao', 'decisoes_pendentes', 'passagens_comando'].every((x) => pubB.includes(x)), 'briefing, decisões e passagens publicados no Realtime');
}

// ---------- Migração 038: "Fora da área" guardado, soma exata de 100%, origem de cada valor ----------
console.log('\nPOA: Fora da área e origem dos valores — migração 038');
{
  const opF = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP FORA', p_retencao_horas: 24, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  const vE = await rpc(resp1, 'salvar_vitima', { p_operacao: opF.id, p_id: null, p_dados: JSON.stringify({ nome: 'Eva' }) });
  const d = (m) => m / 111194.93;
  const circ = (nome, lat) => rpc(resp1, 'salvar_setor', { p_operacao: opF.id, p_id: null, p_dados: JSON.stringify({ nome, forma: 'circulo', centro_lat: lat, centro_lng: -49.2, raio_m: 200 }) });
  const sA = await circ('Alfa', -25.40), sB = await circ('Bravo', -25.40 + d(2000)), sC = await circ('Charlie', -25.40 + d(4000));
  const it = (s, poa, extra) => Object.assign({ setor_id: s.id, poa, justificativa: '' }, extra || {});
  const dados = (itens, extra) => JSON.stringify(Object.assign({ justificativa: 'Seguiu a trilha do rio ao norte', setores: itens }, extra || {}));
  const salvar = (itens, extra, uid) => rpc(uid || resp1, 'cenario_salvar_rascunho', { p_vitima: vE.id, p_dados: dados(itens, extra) });

  console.log('  soma exata de 100% com "Fora da área"');
  const r0 = await salvar([it(sA, 0.5), it(sB, 0.3)], { __sem_fora: true });
  chk(r0.cenario.poa_fora === null, 'rascunho sem "Fora da área": o campo fica nulo (não é completado pelo servidor)', r0.cenario.poa_fora);
  chk(/cenario_fora_obrigatorio/.test(await erroDe(rpc(resp1, 'cenario_aprovar', { p_cenario: r0.cenario.id }))), 'publicar sem informar "Fora da área": recusado no servidor');
  const r1 = await salvar([it(sA, 0.5), it(sB, 0.2)], { poa_fora: 0.2 });
  chk(Number(r1.cenario.poa_fora) === 0.2, 'o servidor guarda "Fora da área" (0,2)');
  chk(/cenario_soma_diferente_de_100/.test(await erroDe(rpc(resp1, 'cenario_aprovar', { p_cenario: r1.cenario.id }))), '50 + 20 + 20 = 90%: publicar recusado (soma diferente de 100%)');
  chk(/cenario_poa_acima_de_100/.test(await erroDe(salvar([it(sA, 0.5), it(sB, 0.4)], { poa_fora: 0.2 }))), 'setores + fora acima de 100%: nem rascunho');
  chk(/dados_invalidos/.test(await erroDe(salvar([it(sA, 0.5)], { poa_fora: 1.5 }))) && /dados_invalidos/.test(await erroDe(salvar([it(sA, 0.5)], { poa_fora: -0.1 }))), '"Fora da área" fora de 0 a 1: recusado');
  const r2 = await salvar([it(sA, 0.5), it(sB, 0.3)], { poa_fora: 0.2 });
  chk(/sem_permissao/.test(await erroDe(salvar([it(sA, 0.5)], { poa_fora: 0.5 }, resp2))), 'outro responsável não grava');
  const ap = await rpc(resp1, 'cenario_aprovar', { p_cenario: r2.cenario.id });
  chk(ap.cenario.estado === 'aprovada' && Number(ap.cenario.poa_fora) === 0.2, '50 + 30 + 20 = 100%: publicada, com "Fora da área" guardado');
  const diario = (await db.query(`select detalhe from public.diario where operacao_id = $1 and tipo = 'cenario_aprovado'`, [opF.id])).rows;
  chk(diario.length === 1 && /fora dos setores: 20%/.test(diario[0].detalhe), 'o diário usa o "fora" guardado (20%)', diario);
  chk(/cenario_imutavel_aprovado/.test(await erroDe(db.query(`update public.busca_cenarios set poa_fora = 0.1 where id = $1`, [ap.cenario.id]))), 'versão publicada: "Fora da área" não muda');

  console.log('  tolerância só do arredondamento de uma casa');
  const t1 = await salvar([it(sA, 0.3333), it(sB, 0.3333)], { poa_fora: 0.3334 });
  const apT = await rpc(resp1, 'cenario_aprovar', { p_cenario: t1.cenario.id });
  chk(apT.cenario.numero === 2, '33,33 + 33,33 + 33,34 = 100%: publica (versão 2)');
  const t2 = await salvar([it(sA, 0.333), it(sB, 0.333)], { poa_fora: 0.333 });
  chk(/cenario_soma_diferente_de_100/.test(await erroDe(rpc(resp1, 'cenario_aprovar', { p_cenario: t2.cenario.id }))), '33,3 × 3 = 99,9%: recusado (a tolerância não cobre 0,1 ponto)');

  console.log('  origem de cada valor');
  chk(/dados_invalidos/.test(await erroDe(salvar([it(sA, 0.5, { origem: 'chute' })], { poa_fora: 0.5 }))) && /dados_invalidos/.test(await erroDe(salvar([it(sA, 0.5)], { poa_fora: 0.5, poa_fora_origem: 'x' }))), 'origem desconhecida: recusada');
  chk(/dados_invalidos/.test(await erroDe(salvar([it(sA, 0.5, { origem: 'calculo' })], { poa_fora: 0.5 }))), 'o cliente não pode declarar origem "calculo" (só o cálculo pós-busca)');
  const o1 = await salvar([it(sA, 0.6, { origem: 'ia' }), it(sB, 0.1), it(sC, 0.1, { origem: 'ia' })], { poa_fora: 0.2, poa_fora_origem: 'ia', ia_modelo: 'modelo-x' });
  const itens = (await db.query(`select setor_nome, origem, ia_revisado_por_nome from public.busca_cenario_setores where cenario_id = $1 order by setor_nome`, [o1.cenario.id])).rows;
  chk(itens.find((x) => x.setor_nome === 'Alfa').origem === 'ia' && itens.find((x) => x.setor_nome === 'Alfa').ia_revisado_por_nome === 'Sgt Um' && itens.find((x) => x.setor_nome === 'Bravo').origem === 'manual' && itens.find((x) => x.setor_nome === 'Bravo').ia_revisado_por_nome === null,
    'valor de IA guarda quem o revisou; valor manual não', itens);
  await rpc(resp1, 'cenario_aprovar', { p_cenario: o1.cenario.id });
  const dIa = (await db.query(`select detalhe from public.diario where operacao_id = $1 and tipo = 'cenario_aprovado' order by id desc limit 1`, [opF.id])).rows[0].detalhe;
  chk(/sugeridos por IA \(modelo-x\) e revisados por Sgt Um/.test(dIa), 'o diário registra "sugerido por IA, revisado por <nome>"', dIa);

  console.log('  a ordem das versões e a proteção');
  const vigente = (await db.query(`select max(numero) n from public.busca_cenarios where vitima_id = $1 and estado = 'aprovada'`, [vE.id])).rows[0].n;
  chk(vigente === 3, 'três versões publicadas (1, 2, 3)', vigente);
  const rr = await salvar([it(sA, 0.4)], { poa_fora: 0.6 });
  chk(/dados_invalidos/.test(await erroDe(db.query(`update public.busca_cenarios set numero = 9 where id = $1`, [rr.cenario.id]))), 'o número da versão não muda por fora da função de publicação');
  chk(rr.cenario.base_numero === 3, 'o rascunho guarda a versão vigente de que partiu (3)', rr.cenario.base_numero);
  const aprFim = await rpc(resp1, 'cenario_aprovar', { p_cenario: rr.cenario.id });
  chk(aprFim.cenario.numero === 4, 'publicar o rascunho mantém a numeração em ordem (4)');
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opF.id });
  chk(/operacao_encerrada/.test(await erroDe(salvar([it(sA, 0.4)], { poa_fora: 0.6 }))), 'encerrada: sem novo rascunho');
}

// ---------- Migração 039: missão de busca (POD por missão) e cálculo pós-busca por versão ----------
console.log('\nMissão de busca e cálculo pós-busca — migração 039');
{
  const opM = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP MISSAO BUSCA', p_retencao_horas: 24, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  const outraOp = await rpc(resp1, 'criar_operacao', { p_codigo: 'OUTRA OP', p_retencao_horas: 24, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  const vit = (n) => rpc(resp1, 'salvar_vitima', { p_operacao: opM.id, p_id: null, p_dados: JSON.stringify({ nome: n }) });
  const vEva = await vit('Eva'), vFred = await vit('Fred'), vGil = await vit('Gil');
  const d = (m) => m / 111194.93;
  const circ = (op, nome, lat) => rpc(resp1, 'salvar_setor', { p_operacao: op, p_id: null, p_dados: JSON.stringify({ nome, forma: 'circulo', centro_lat: lat, centro_lng: -49.2, raio_m: 200 }) });
  const sA = await circ(opM.id, 'Alfa', -25.40), sB = await circ(opM.id, 'Bravo', -25.40 + d(2000)), sC = await circ(opM.id, 'Charlie', -25.40 + d(4000));
  const sOutro = await circ(outraOp.id, 'Outro', -25.40);
  const gM = await rpc(resp1, 'salvar_grupo', { p_operacao: opM.id, p_id: null, p_dados: JSON.stringify({ nome: 'Equipe A' }) });
  const publicar = async (vitima, itens, fora) => {
    const r = await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vitima.id, p_dados: JSON.stringify({ justificativa: 'Seguiu a trilha do rio ao norte', poa_fora: fora, setores: itens.map(([s, poa]) => ({ setor_id: s.id, poa, justificativa: '' })) }) });
    return (await rpc(resp1, 'cenario_aprovar', { p_cenario: r.cenario.id })).cenario;
  };
  const eva1 = await publicar(vEva, [[sA, 0.5], [sB, 0.3]], 0.2);
  await publicar(vFred, [[sA, 0.2], [sB, 0.2]], 0.6);
  await publicar(vGil, [[sA, 1]], 0);
  const versoes = async (vitima) => (await db.query(`select numero, estado, origem_poa, poa_fora, base_numero, missao_id from public.busca_cenarios where vitima_id = $1 order by numero`, [vitima.id])).rows;
  const poas = async (cen) => Object.fromEntries((await db.query(`select setor_nome, poa, origem from public.busca_cenario_setores where cenario_id = $1`, [cen]) ).rows.map((r) => [r.setor_nome, Number(r.poa)]));
  const criar = (extra, uid) => rpc(uid || resp1, 'busca_missao_criar', { p_operacao: opM.id, p_dados: JSON.stringify(Object.assign({ setor_id: sA.id, vitima_id: vEva.id, grupo_id: gM.id, equipe: 'Equipe A', metodo: 'A pé, em linha', area_fracao: 1 }, extra || {})) });

  console.log('  criar a missão');
  chk(/busca_missao_equipe_obrigatoria/.test(await erroDe(criar({ grupo_id: null, equipe: '' }))), 'sem equipe: recusado');
  chk(/busca_missao_metodo_obrigatorio/.test(await erroDe(criar({ metodo: '' }))), 'sem método: recusado');
  chk(/busca_pod_sem_base/.test(await erroDe(criar({ pod: 0.6 }))), 'POD informada sem dizer em que se baseia: recusado');
  chk(/dados_invalidos/.test(await erroDe(criar({ pod: 1.2, pod_base: 'varredura em linha' }))) && /busca_cobertura_invalida/.test(await erroDe(criar({ area_fracao: 0 }))) && /busca_cobertura_invalida/.test(await erroDe(criar({ area_fracao: 1.5 }))), 'POD fora de 0 a 1 e área fora de 0 a 100%: recusados');
  chk(/sem_permissao/.test(await erroDe(criar({}, resp2))), 'outro responsável não cria missão');
  chk(/setor_nao_encontrado/.test(await erroDe(criar({ setor_id: sOutro.id }))), 'setor de outra operação: recusado');
  const m1r = await criar({ pod: 0.6, pod_base: 'Varredura em linha, 5 m entre buscadores', chave_cliente: 'k1' });
  const m1 = m1r.missao;
  chk(m1.estado === 'planejada' && Number(m1.pod_planejada) === 0.6 && m1.setor_nome === 'Alfa' && m1.calculo_estado === 'nao_aplicavel' && m1r.repetida === false, 'missão planejada com equipe, método, área e POD estimada');
  chk((await criar({ pod: 0.6, pod_base: 'Varredura em linha, 5 m entre buscadores', chave_cliente: 'k1' })).repetida === true, 'reenviar a mesma missão (mesma chave) não duplica');
  chk(/busca_chave_reutilizada/.test(await erroDe(criar({ pod: 0.7, pod_base: 'Varredura em linha, 5 m entre buscadores', chave_cliente: 'k1' }))), 'mesma chave com outro conteúdo: recusada');
  const m2 = (await criar({ setor_id: sB.id })).missao;
  chk(m2.pod_planejada === null, '"POD não estimada" fica nula, nunca zero', m2.pod_planejada);
  chk((await db.query(`select count(*)::int n from public.diario where operacao_id = $1 and tipo = 'busca_missao_criada'`, [opM.id])).rows[0].n === 2, 'a criação entra no diário');
  chk(/permission denied/.test(await erroDe(como(resp1, `insert into public.busca_missoes (operacao_id, setor_nome, equipe, metodo, criada_por_nome) values ($1, 'X', 'Y', 'Z', 'W')`, [opM.id]))), 'escrita direta na tabela é recusada');
  chk((await como(resp2, `select id from public.busca_missoes`)).rows.length === 0, 'outro responsável (sem acesso à operação) não lê as missões');

  console.log('  resultado negativo: r = p × (1 − q), Z = Σr, p\' = r/Z');
  chk(/busca_missao_resultado_invalido/.test(await erroDe(rpc(resp1, 'busca_missao_resultado', { p_missao: m1.id, p_dados: JSON.stringify({ resultado: 'talvez' }) }))), 'resultado inválido: recusado');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'busca_missao_resultado', { p_missao: m1.id, p_dados: JSON.stringify({ resultado: 'nao_localizado' }) }))), 'outro responsável não registra o resultado');
  const r1 = await rpc(resp1, 'busca_missao_resultado', { p_missao: m1.id, p_dados: JSON.stringify({ resultado: 'nao_localizado', observacao: 'Mata fechada' }) });
  chk(r1.missao.estado === 'concluida' && r1.missao.calculo_estado === 'aplicado' && Number(r1.missao.cobertura_real_fracao) === 1, 'negativa: concluída, cobertura = área atribuída, cálculo aplicado');
  const vEvaDepois = await versoes(vEva);
  chk(vEvaDepois.length === 2 && vEvaDepois[1].origem_poa === 'calculo_pos_busca' && vEvaDepois[1].estado === 'aprovada' && vEvaDepois[1].base_numero === 1 && vEvaDepois[1].missao_id === m1.id, 'gerou a versão 2 aprovada (origem: cálculo pós-busca), a partir da 1');
  const p2 = await poas((await db.query(`select id from public.busca_cenarios where vitima_id = $1 and numero = 2`, [vEva.id])).rows[0].id);
  const esperado = { Alfa: 0.2 / 0.7, Bravo: 0.3 / 0.7 };
  chk(Math.abs(p2.Alfa - esperado.Alfa) < 1e-6 && Math.abs(p2.Bravo - esperado.Bravo) < 1e-6, 'Alfa 28,57% e Bravo 42,86%: 0,5×0,4÷0,7 e 0,3÷0,7', p2);
  chk(Math.abs(Number(vEvaDepois[1].poa_fora) - 0.2 / 0.7) < 1e-6 && Math.abs(p2.Alfa + p2.Bravo + Number(vEvaDepois[1].poa_fora) - 1) < 1e-9, '"Fora da área" 28,57% e a soma fecha em exatamente 100%');
  const eva1Itens = await poas(eva1.id);
  chk(eva1Itens.Alfa === 0.5 && eva1Itens.Bravo === 0.3 && (await versoes(vEva))[0].estado === 'aprovada' && Number((await versoes(vEva))[0].poa_fora) === 0.2, 'a versão 1 continua intacta');
  const ef = (await db.query(`select poa_setor_antes, poa_setor_depois, q, pos, z from public.busca_missao_efeitos where missao_id = $1`, [m1.id])).rows;
  chk(ef.length === 1 && Number(ef[0].pos) === 0.3 && Number(ef[0].q) === 0.6 && Math.abs(Number(ef[0].z) - 0.7) < 1e-6, 'POS da missão = POA do setor × POD = 50% × 60% = 30% ("chance de localizar nesta busca")', ef);
  chk((await db.query(`select count(*)::int n from public.busca_cenario_setores where cenario_id = (select id from public.busca_cenarios where vitima_id = $1 and numero = 2) and origem = 'calculo'`, [vEva.id])).rows[0].n === 2, 'os valores da versão calculada têm origem "calculo"');
  chk((await db.query(`select count(*)::int n from public.diario where operacao_id = $1 and tipo = 'cenario_pos_busca'`, [opM.id])).rows[0].n === 1, 'a atualização entra no diário');
  chk(/busca_missao_nao_planejada/.test(await erroDe(rpc(resp1, 'busca_missao_resultado', { p_missao: m1.id, p_dados: JSON.stringify({ resultado: 'nao_localizado' }) }))), 'o resultado entra uma vez só');
  chk(/busca_missao_imutavel/.test(await erroDe(db.query(`update public.busca_missoes set equipe = 'Outra' where id = $1`, [m1.id]))) && /busca_missao_imutavel/.test(await erroDe(db.query(`delete from public.busca_missoes where id = $1`, [m1.id]))), 'missão concluída não muda nem some');
  chk(/busca_missao_imutavel/.test(await erroDe(db.query(`update public.busca_missao_efeitos set pos = 0`))), 'o efeito calculado não muda');

  console.log('  POD desconhecido: pendência, sem recalcular');
  const antes = (await versoes(vEva)).length;
  const r2 = await rpc(resp1, 'busca_missao_resultado', { p_missao: m2.id, p_dados: JSON.stringify({ resultado: 'nao_localizado' }) });
  chk(r2.missao.calculo_estado === 'pendente_pod' && r2.missao.pod_final === null && (await versoes(vEva)).length === antes, 'POD não estimada: não recalcula e fica "pendente de POD" (não vira zero)');
  chk(/busca_pod_sem_base/.test(await erroDe(rpc(resp1, 'busca_missao_definir_pod', { p_missao: m2.id, p_pod: 0.5, p_base: '' }))) && /dados_invalidos/.test(await erroDe(rpc(resp1, 'busca_missao_definir_pod', { p_missao: m2.id, p_pod: 2, p_base: 'Estimativa da equipe' }))), 'informar o POD exige a base e valor entre 0 e 1');
  chk(/busca_missao_pod_nao_pendente/.test(await erroDe(rpc(resp1, 'busca_missao_definir_pod', { p_missao: m1.id, p_pod: 0.5, p_base: 'Estimativa da equipe' }))), 'missão sem pendência não aceita POD novo');
  const dp = await rpc(resp1, 'busca_missao_definir_pod', { p_missao: m2.id, p_pod: 0.5, p_base: 'Estimativa da equipe', p_origem: 'ia' });
  chk(dp.missao.calculo_estado === 'aplicado' && dp.missao.pod_final_origem === 'ia' && dp.missao.pod_final_revisor === 'Sgt Um', 'POD informado depois: recalcula; origem "ia" guarda quem revisou');
  const v3 = (await versoes(vEva))[2];
  const p3 = await poas((await db.query(`select id from public.busca_cenarios where vitima_id = $1 and numero = 3`, [vEva.id])).rows[0].id);
  const rA = (0.2 / 0.7), rB = (0.3 / 0.7) * 0.5, rF = 0.2 / 0.7, Z = rA + rB + rF;
  chk(v3 && v3.base_numero === 2 && Math.abs(p3.Alfa - rA / Z) < 1e-6 && Math.abs(p3.Bravo - rB / Z) < 1e-6 && Math.abs(Number(v3.poa_fora) - rF / Z) < 1e-6, 'versão 3 parte da versão vigente (2): as missões se aplicam em sequência, sem somar PODs', p3);
  chk(/busca_missao_pod_nao_pendente/.test(await erroDe(rpc(resp1, 'busca_missao_definir_pod', { p_missao: m2.id, p_pod: 0.9, p_base: 'Outra estimativa' }))), 'o POD informado depois não se troca');

  console.log('  casos que não recalculam');
  const nVer = (await versoes(vEva)).length;
  const mC = (await criar({ setor_id: sC.id, pod: 0.8, pod_base: 'Estimativa da equipe' })).missao;
  const rC = await rpc(resp1, 'busca_missao_resultado', { p_missao: mC.id, p_dados: JSON.stringify({ resultado: 'nao_localizado' }) });
  chk(rC.missao.calculo_estado === 'nao_aplicavel' && (await versoes(vEva)).length === nVer, 'setor que não está no cenário (POA zero): nada a atualizar');
  const mL = (await criar({ pod: 0.5, pod_base: 'Estimativa da equipe' })).missao;
  const rL = await rpc(resp1, 'busca_missao_resultado', { p_missao: mL.id, p_dados: JSON.stringify({ resultado: 'localizado' }) });
  chk(rL.missao.calculo_estado === 'nao_aplicavel' && (await versoes(vEva)).length === nVer, 'localizado: não recalcula o POA');
  const mN = (await criar({ pod: 0.5, pod_base: 'Estimativa da equipe' })).missao;
  const rN = await rpc(resp1, 'busca_missao_resultado', { p_missao: mN.id, p_dados: JSON.stringify({ resultado: 'nao_concluido' }) });
  chk(rN.missao.calculo_estado === 'nao_aplicavel' && rN.missao.cobertura_real_fracao === null && (await versoes(vEva)).length === nVer, 'não concluído sem cobertura informada: não recalcula');
  const mN2 = (await criar({ pod: 0.5, pod_base: 'Estimativa da equipe' })).missao;
  const rN2 = await rpc(resp1, 'busca_missao_resultado', { p_missao: mN2.id, p_dados: JSON.stringify({ resultado: 'nao_concluido', cobertura: 0.4 }) });
  chk(rN2.missao.calculo_estado === 'aplicado' && Number(rN2.efeitos[0].q) === 0.2, 'não concluído com cobertura real (40%): recalcula com q = POD × cobertura = 20%', rN2.efeitos);
  chk(/busca_cobertura_invalida/.test(await erroDe(rpc(resp1, 'busca_missao_resultado', { p_missao: (await criar({})).missao.id, p_dados: JSON.stringify({ resultado: 'nao_localizado', cobertura: 1.5 }) }))), 'cobertura real fora de 0 a 100%: recusada');

  console.log('  várias vítimas e inconsistência');
  const mT = (await criar({ setor_id: sB.id, vitima_id: null, pod: 0.5, pod_base: 'Estimativa da equipe' })).missao;
  const rT = await rpc(resp1, 'busca_missao_resultado', { p_missao: mT.id, p_dados: JSON.stringify({ resultado: 'nao_localizado' }) });
  chk(rT.efeitos.length === 2 && rT.efeitos.every((e) => e.vitima_id !== vGil.id), 'missão para todas as vítimas atualiza cada uma que tem o setor no cenário (Gil não tem Bravo: intacto)');
  chk((await versoes(vGil)).length === 1, 'a vítima sem o setor não ganha versão');
  const mZ = (await criar({ vitima_id: vGil.id, pod: 1, pod_base: 'Cobertura total confirmada' })).missao;
  const rZ = await rpc(resp1, 'busca_missao_resultado', { p_missao: mZ.id, p_dados: JSON.stringify({ resultado: 'nao_localizado' }) });
  chk(rZ.missao.estado === 'concluida' && rZ.missao.calculo_estado === 'inconsistente' && /Z = Σ r = 0/.test(rZ.missao.calculo_detalhe), 'Z = 0 (tudo no setor e POD 100%): resultado registrado, cálculo INCONSISTENTE com o motivo');
  chk((await versoes(vGil)).length === 1 && Number((await versoes(vGil))[0].poa_fora) === 0, 'na inconsistência a versão anterior não é alterada');

  console.log('  rascunho em aberto e ordem das versões');
  const rascEva = await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vEva.id, p_dados: JSON.stringify({ justificativa: 'Revisão do comando após as buscas', poa_fora: 0.5, setores: [{ setor_id: sA.id, poa: 0.3 }, { setor_id: sB.id, poa: 0.2 }] }) });
  const baseRasc = rascEva.cenario.base_numero;
  const mR = (await criar({ pod: 0.3, pod_base: 'Estimativa da equipe' })).missao;
  await rpc(resp1, 'busca_missao_resultado', { p_missao: mR.id, p_dados: JSON.stringify({ resultado: 'nao_localizado' }) });
  chk(/cenario_base_desatualizada/.test(await erroDe(rpc(resp1, 'cenario_aprovar', { p_cenario: rascEva.cenario.id }))), 'rascunho de antes de uma busca negativa: publicar é recusado (a vigente mudou)');
  const rasc2 = await rpc(resp1, 'cenario_salvar_rascunho', { p_vitima: vEva.id, p_dados: JSON.stringify({ justificativa: 'Revisão do comando após as buscas', poa_fora: 0.5, setores: [{ setor_id: sA.id, poa: 0.3 }, { setor_id: sB.id, poa: 0.2 }] }) });
  const maxAprov = (await db.query(`select max(numero) n from public.busca_cenarios where vitima_id = $1 and estado = 'aprovada'`, [vEva.id])).rows[0].n;
  chk(rasc2.cenario.base_numero === maxAprov && baseRasc < maxAprov, 'salvar o rascunho de novo atualiza a base para a versão vigente', [baseRasc, maxAprov]);
  const apFinal = await rpc(resp1, 'cenario_aprovar', { p_cenario: rasc2.cenario.id });
  chk(apFinal.cenario.numero === maxAprov + 1, 'o rascunho publicado fica depois da versão calculada (numeração em ordem)', apFinal.cenario.numero);

  console.log('  cancelar, encerrada e Realtime');
  const mK = (await criar({})).missao;
  chk(/busca_missao_cancelamento_sem_motivo/.test(await erroDe(rpc(resp1, 'busca_missao_cancelar', { p_missao: mK.id, p_motivo: '' }))), 'cancelar exige o motivo');
  const kc = await rpc(resp1, 'busca_missao_cancelar', { p_missao: mK.id, p_motivo: 'Equipe remanejada' });
  chk(kc.missao.estado === 'cancelada' && /busca_missao_nao_planejada/.test(await erroDe(rpc(resp1, 'busca_missao_resultado', { p_missao: mK.id, p_dados: JSON.stringify({ resultado: 'nao_localizado' }) }))), 'cancelada fica no histórico e não recebe resultado');
  chk(/busca_missao_nao_planejada/.test(await erroDe(rpc(resp1, 'busca_missao_cancelar', { p_missao: m1.id, p_motivo: 'Tarde demais' }))), 'missão concluída não se cancela');
  const mE = (await criar({})).missao;
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opM.id });
  chk(/operacao_encerrada/.test(await erroDe(criar({}))) && /operacao_encerrada/.test(await erroDe(rpc(resp1, 'busca_missao_resultado', { p_missao: mE.id, p_dados: JSON.stringify({ resultado: 'nao_localizado' }) }))) && /operacao_encerrada/.test(await erroDe(rpc(resp1, 'busca_missao_cancelar', { p_missao: mE.id, p_motivo: 'Encerrada a operação' }))), 'encerrada: sem criar, concluir nem cancelar missão');
  const pubM = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`)).rows.map((r) => r.tablename);
  chk(['busca_missoes', 'busca_missao_efeitos'].every((x) => pubM.includes(x)), 'missões e efeitos publicados no Realtime');
}

console.log('Proveniência, incerteza, binômio, drone e água (migração 042)');
{
  const opR = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP 042', p_retencao_horas: 0, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  const uR = await usuario(null, true), uFora = await usuario(null, true);
  const pR = await rpc(uR, 'ingressar', { p_token: opR.token_civil, p_nome: 'Relatora', p_tipo: 'civil', p_cpf: null, p_telefone: tel });
  const rel = await rpc(uR, 'participante_enviar_mensagem', { p_participante: pR.participante_id, p_categoria: 'OBJETO', p_texto: 'mochila azul', p_lat: -22.9, p_lng: -43.2, p_precisao: 8, p_posicao_em: new Date(Date.now() - 600e3).toISOString() });

  console.log('  revisão de relatos');
  chk(/justificativa_obrigatoria/.test(await erroDe(rpc(resp1, 'revisar_relato', { p_mensagem: rel.id, p_estado: 'confirmado', p_nota: '' }))), 'confirmar sem dizer como foi verificado: recusado');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'revisar_relato', { p_mensagem: rel.id, p_estado: 'em_analise', p_nota: '' }))), 'responsável de fora da operação não revisa');
  chk(/sem_permissao/.test(await erroDe(rpc(uR, 'revisar_relato', { p_mensagem: rel.id, p_estado: 'em_analise', p_nota: '' }))), 'participante não revisa o próprio relato');
  chk(/data_invalida/.test(await erroDe(rpc(resp1, 'revisar_relato', { p_mensagem: rel.id, p_estado: 'em_analise', p_nota: '', p_fato_em: new Date(Date.now() + 3600e3).toISOString() }))), 'momento do fato no futuro: recusado');
  const v1 = await rpc(resp1, 'revisar_relato', { p_mensagem: rel.id, p_estado: 'em_analise', p_nota: '', p_fato_em: new Date(Date.now() - 3 * 3600e3).toISOString(), p_fato_origem: 'estimado' });
  const v2 = await rpc(resp1, 'revisar_relato', { p_mensagem: rel.id, p_estado: 'confirmado', p_nota: 'Equipe Alfa foi ao local e recolheu a mochila' });
  chk(v1.versao === 1 && v1.fato_origem === 'estimado' && v2.versao === 2 && v2.estado === 'confirmado', 'cada revisão é uma versão nova, com a origem da hora do fato', [v1.versao, v1.fato_origem, v2.versao]);
  chk((await db.query(`select count(*)::int n from public.relato_revisoes where mensagem_id = $1`, [rel.id])).rows[0].n === 2, 'as versões anteriores continuam guardadas');
  const dRel = (await db.query(`select titulo, detalhe from public.diario where operacao_id = $1 and tipo = 'relato_revisado' order by registrado_em`, [opR.id])).rows;
  chk(dRel.length === 2 && /confirmado/.test(dRel[1].titulo) && /Equipe Alfa/.test(dRel[1].detalhe), 'revisão registrada no diário', dRel);
  chk((await como(uR, `select count(*)::int n from public.relato_revisoes`)).rows[0].n === 0, 'participante não lê a revisão interna');
  chk((await como(uR, `select count(*)::int n from public.mensagens where id = $1`, [rel.id])).rows[0].n === 1, 'participante continua lendo a própria mensagem');
  chk((await como(resp1, `select count(*)::int n from public.relato_revisoes where mensagem_id = $1`, [rel.id])).rows[0].n === 2, 'responsável da operação lê as revisões');
  chk(/permission denied|row-level/.test(await erroDe(como(resp1, `insert into public.relato_revisoes (operacao_id, mensagem_id, versao, estado, revisado_por_nome) values ($1, $2, 9, 'confirmado', 'x')`, [opR.id, rel.id]))), 'revisão só pela função');
  const saida = await rpc(resp1, 'enviar_mensagem', { p_participante: pR.participante_id, p_tipo: 'PERSONALIZADA', p_texto: 'ok' }).catch(() => null);
  if (saida && saida.id) chk(/relato_nao_encontrado/.test(await erroDe(rpc(resp1, 'revisar_relato', { p_mensagem: saida.id, p_estado: 'em_analise', p_nota: '' }))), 'mensagem enviada pelo painel não é relato');

  console.log('  idade estimada da vítima');
  const vt = await rpc(resp1, 'salvar_vitima', { p_operacao: opR.id, p_id: null, p_dados: JSON.stringify({ nome: 'Pessoa', idade: 70, idade_qualidade: 'estimada' }) });
  chk(vt.idade === 70 && vt.idade_qualidade === 'estimada', 'idade marcada como estimada', vt);
  const vt2 = await rpc(resp1, 'salvar_vitima', { p_operacao: opR.id, p_id: vt.id, p_dados: JSON.stringify({ idade: null }) });
  chk(vt2.idade === null && vt2.idade_qualidade === null, 'sem idade: "não informada" (nada de zero nem de qualidade)', vt2);
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'salvar_vitima', { p_operacao: opR.id, p_id: vt.id, p_dados: JSON.stringify({ idade: 30, idade_qualidade: 'chutada' }) }))), 'qualidade fora da lista: recusada');

  console.log('  binômio');
  const setorR = await rpc(resp1, 'salvar_setor', { p_operacao: opR.id, p_id: null, p_dados: JSON.stringify({ nome: 'S1', forma: 'circulo', centro_lat: -22.9, centro_lng: -43.2, raio_m: 300 }) });
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'salvar_binomio_sessao', { p_operacao: opR.id, p_id: null, p_dados: JSON.stringify({ cao_nome: '' }) }))), 'sessão sem o nome do cão: recusada');
  const ses = await rpc(resp1, 'salvar_binomio_sessao', { p_operacao: opR.id, p_id: null, p_dados: JSON.stringify({ cao_nome: 'Thor', setor_id: setorR.id, condutor_participante_id: pR.participante_id, artigo_odor: 'camiseta', artigo_origem: 'quarto da pessoa', artigo_manipulacao: 'lacrada pela família', condicoes: 'vento fraco de leste' }) });
  chk(ses.estado === 'planejada' && ses.cao_gps === 'sem_dispositivo' && ses.setor_id === setorR.id, 'sessão criada ligada ao setor, GPS do cão sem dispositivo', ses);
  chk(/sessao_nao_iniciada/.test(await erroDe(rpc(resp1, 'registrar_binomio_evento', { p_sessao: ses.id, p_dados: JSON.stringify({ tipo: 'indicacao' }) }))), 'indicação só com a sessão iniciada');
  chk(/transicao_invalida/.test(await erroDe(rpc(resp1, 'binomio_controle', { p_sessao: ses.id, p_acao: 'pausar' }))), 'não pausa o que não começou');
  const s1 = await rpc(resp1, 'binomio_controle', { p_sessao: ses.id, p_acao: 'iniciar' });
  const s2 = await rpc(resp1, 'binomio_controle', { p_sessao: ses.id, p_acao: 'pausar' });
  const s3 = await rpc(resp1, 'binomio_controle', { p_sessao: ses.id, p_acao: 'retomar' });
  chk(s1.estado === 'em_andamento' && s1.iniciada_em && s2.estado === 'pausada' && s3.estado === 'em_andamento' && s3.pausas.length === 1 && s3.pausas[0].de && s3.pausas[0].ate, 'iniciar, pausar e retomar com a pausa guardada (início e fim)', s3.pausas);
  const i1 = await rpc(resp1, 'registrar_binomio_evento', { p_sessao: ses.id, p_dados: JSON.stringify({ tipo: 'indicacao', lat: -22.901, lng: -43.201, descricao: 'mudança de comportamento na trilha' }) });
  const i2 = await rpc(resp1, 'registrar_binomio_evento', { p_sessao: ses.id, p_dados: JSON.stringify({ tipo: 'indicacao' }) });
  chk(i1.codigo === 'I1' && i1.estado === 'em_analise' && i2.codigo === 'I2', 'indicações numeradas e sempre "em análise"', [i1.codigo, i1.estado, i2.codigo]);
  chk(/indicacao_obrigatoria/.test(await erroDe(rpc(resp1, 'registrar_binomio_evento', { p_sessao: ses.id, p_dados: JSON.stringify({ tipo: 'confirmacao', metodo: 'equipe' }) }))), 'confirmação precisa apontar a indicação');
  chk(/metodo_obrigatorio/.test(await erroDe(rpc(resp1, 'registrar_binomio_evento', { p_sessao: ses.id, p_dados: JSON.stringify({ tipo: 'confirmacao', relacionado_a: i1.id }) }))), 'confirmação precisa do método independente');
  const c1 = await rpc(resp1, 'registrar_binomio_evento', { p_sessao: ses.id, p_dados: JSON.stringify({ tipo: 'confirmacao', relacionado_a: i1.id, metodo: 'busca visual' }) });
  chk(c1.codigo === 'C1' && c1.estado === 'pendente' && c1.lat === -22.901, 'confirmação C1 pendente, no local da indicação', c1);
  chk(/justificativa_obrigatoria/.test(await erroDe(rpc(resp1, 'revisar_binomio_evento', { p_evento: c1.id, p_estado: 'confirmada', p_nota: '' }))), 'confirmar exige justificativa');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'revisar_binomio_evento', { p_evento: i1.id, p_estado: 'pendente', p_nota: '' }))), 'indicação não fica "pendente" (isso é da confirmação)');
  const rc = await rpc(resp1, 'revisar_binomio_evento', { p_evento: c1.id, p_estado: 'descartada', p_nota: 'nada encontrado no ponto' });
  chk(rc.estado === 'descartada' && rc.revisado_por_nome === 'Sgt Um', 'confirmação descartada com justificativa');
  const fim = await rpc(resp1, 'binomio_controle', { p_sessao: ses.id, p_acao: 'finalizar' });
  chk(fim.estado === 'finalizada' && fim.finalizada_em, 'sessão finalizada');
  chk(/sessao_nao_iniciada/.test(await erroDe(rpc(resp1, 'registrar_binomio_evento', { p_sessao: ses.id, p_dados: JSON.stringify({ tipo: 'indicacao' }) }))), 'sessão finalizada não recebe indicação nova');
  const c2 = await rpc(resp1, 'registrar_binomio_evento', { p_sessao: ses.id, p_dados: JSON.stringify({ tipo: 'confirmacao', relacionado_a: i2.id, metodo: 'drone' }) });
  chk(c2.codigo === 'C2', 'confirmação continua possível depois do fim da sessão');
  const tiposDiario = (await db.query(`select tipo from public.diario where operacao_id = $1 and tipo like 'binomio%'`, [opR.id])).rows.map((r) => r.tipo);
  chk(['binomio_sessao', 'binomio_iniciar', 'binomio_pausar', 'binomio_retomar', 'binomio_indicacao', 'binomio_confirmacao', 'binomio_revisao', 'binomio_finalizar'].every((t) => tiposDiario.includes(t)), 'sessão e eventos no diário', tiposDiario);
  chk((await como(uR, `select count(*)::int n from public.binomio_eventos`)).rows[0].n === 0 && (await como(resp2, `select count(*)::int n from public.binomio_sessoes`)).rows[0].n === 0, 'binômio só para os responsáveis da operação');

  console.log('  drone e água');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'salvar_observacao_campo', { p_operacao: opR.id, p_id: null, p_dados: JSON.stringify({ modalidade: 'drone', tipo: 'indicacao_aquatica', titulo: 'x' }) }))), 'tipo e modalidade precisam combinar');
  const plano = await rpc(resp1, 'salvar_observacao_campo', { p_operacao: opR.id, p_id: null, p_dados: JSON.stringify({ modalidade: 'drone', tipo: 'plano_voo', titulo: 'Voo S1', fonte: 'piloto Sgt Dois', geometria: { tipo: 'linha', pts: [[-22.9, -43.2], [-22.91, -43.21]] }, dados: { altitude_m: 60 } }) });
  chk(plano.estado === 'planejado' && plano.geometria.tipo === 'linha', 'plano de voo começa "planejado" (plano não prova voo)', plano.estado);
  const foco = await rpc(resp1, 'salvar_observacao_campo', { p_operacao: opR.id, p_id: null, p_dados: JSON.stringify({ modalidade: 'drone', tipo: 'foco_termico', titulo: 'Foco 1', geometria: { tipo: 'ponto', pts: [[-22.905, -43.205]] } }) });
  chk(foco.estado === 'a_verificar', 'foco térmico começa "a verificar" (térmico não é vítima)');
  const agua = await rpc(resp1, 'salvar_observacao_campo', { p_operacao: opR.id, p_id: null, p_dados: JSON.stringify({ modalidade: 'aquatica', tipo: 'indicacao_aquatica', titulo: 'Margem esquerda', dados: { corrente: 'desconhecida', vento: 'informar fonte', area_origem: 'curva do rio' } }) });
  chk(agua.estado === 'a_verificar' && agua.dados.corrente === 'desconhecida', 'indicação aquática com corrente desconhecida aceita');
  chk(/area_invalida/.test(await erroDe(rpc(resp1, 'salvar_observacao_campo', { p_operacao: opR.id, p_id: null, p_dados: JSON.stringify({ modalidade: 'drone', tipo: 'area_observada', titulo: 'Área', geometria: { tipo: 'area', pts: [[-22.9, -43.2], [-22.91, -43.2]] } }) }))), 'área com menos de 3 pontos: recusada');
  chk(/justificativa_obrigatoria/.test(await erroDe(rpc(resp1, 'revisar_observacao_campo', { p_id: foco.id, p_estado: 'verificado', p_nota: '' }))), 'verificar foco exige justificativa');
  const fv = await rpc(resp1, 'revisar_observacao_campo', { p_id: foco.id, p_estado: 'descartado', p_nota: 'era um animal' });
  chk(fv.estado === 'descartado' && fv.nota === 'era um animal', 'foco descartado com justificativa');
  chk((await como(uR, `select count(*)::int n from public.observacoes_campo`)).rows[0].n === 0, 'observações só para os responsáveis');

  console.log('  encerrada e Realtime');
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opR.id });
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'revisar_relato', { p_mensagem: rel.id, p_estado: 'em_analise', p_nota: '' })))
    && /operacao_encerrada/.test(await erroDe(rpc(resp1, 'salvar_observacao_campo', { p_operacao: opR.id, p_id: null, p_dados: JSON.stringify({ modalidade: 'drone', tipo: 'plano_voo', titulo: 'x' }) })))
    && /operacao_encerrada/.test(await erroDe(rpc(resp1, 'salvar_binomio_sessao', { p_operacao: opR.id, p_id: null, p_dados: JSON.stringify({ cao_nome: 'Rex' }) }))), 'encerrada: somente leitura');
  const pub42 = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`)).rows.map((r) => r.tablename);
  chk(['relato_revisoes', 'binomio_sessoes', 'binomio_eventos', 'observacoes_campo'].every((x) => pub42.includes(x)), 'tabelas novas no Realtime');
  const exc42 = await rpc(resp1, 'excluir_operacao', { p_operacao: opR.id });
  chk(exc42.operacao === 'OP 042' && (await db.query(`select (select count(*) from public.relato_revisoes where operacao_id = $1) + (select count(*) from public.binomio_eventos where operacao_id = $1) + (select count(*) from public.observacoes_campo where operacao_id = $1) n`, [opR.id])).rows[0].n == 0, 'excluir a operação apaga revisões, binômio e observações');
}

console.log('Qualidade dos dados dos estudos (migração 043)');
{
  const q0 = await rpc(resp1, 'estudo_qualidade', {});
  chk(q0.unidade === 'operacao' && typeof q0.elegiveis === 'number' && q0.ausentes && q0.fichas, 'devolve a unidade de análise, os denominadores e os ausentes', q0);
  const nova = (codigo, dados) => rpc(resp1, 'criar_operacao', { p_codigo: codigo, p_retencao_horas: 0, p_dados: JSON.stringify(Object.assign({ tipo: 'aquatica' }, dados)) });
  const opA = await nova('OP Q A', { local_lat: -10.0, local_lng: -50.0 });
  const opB = await nova('OP Q B', { local_lat: -10.003, local_lng: -50.002 });
  const opC = await nova('OP Q C', {});
  const opD = await nova('OP Q D', { local_lat: -12.0, local_lng: -52.0 });
  const agora = new Date(Date.now() + 1000).toISOString();
  await rpc(resp1, 'responsavel_registrar_vitima', { p_operacao: opA.id, p_condicao: 'viva', p_lat: -10.01, p_lng: -50.0, p_precisao: 5, p_posicao_em: agora });
  await rpc(resp1, 'responsavel_registrar_vitima', { p_operacao: opC.id, p_condicao: 'viva', p_lat: -11.0, p_lng: -51.0, p_precisao: 5, p_posicao_em: agora });
  await rpc(resp1, 'responsavel_registrar_vitima', { p_operacao: opD.id, p_condicao: 'obito' });
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opB.id });
  const q1 = await rpc(resp1, 'estudo_qualidade', {});
  const d = (k) => q1[k] - q0[k], da = (k) => q1.ausentes[k] - q0.ausentes[k];
  chk(d('operacoes') === 4, 'conta as operações novas', d('operacoes'));
  chk(d('com_localizacao') === 2 && d('validos_distancia') === 1 && d('validos_tempo') === 2, 'válidos: distância só com ULV e posição; tempo com início e hora', [d('com_localizacao'), d('validos_distancia'), d('validos_tempo')]);
  chk(da('ulv') === 1 && da('posicao_localizacao') === 1, 'ausentes contados à parte (sem ULV; localização sem posição) — não viram zero', q1.ausentes);
  chk(d('nao_localizados') === 1, 'encerrada sem localização: não localizado (censurado)', d('nao_localizados'));
  chk(d('elegiveis') === 4, 'elegíveis: encerradas e as com localização', d('elegiveis'));
  chk(d('possiveis_duplicatas') === 2, 'mesmo tipo, ULV a menos de 1 km e início a menos de 48 h: possível duplicata (as duas)', d('possiveis_duplicatas'));
  chk(/sem_permissao/.test(await erroDe(rpc(await usuario(null, true), 'estudo_qualidade', {}))), 'participante não vê a qualidade dos estudos');
  chk(/permission denied/.test(await erroDe(como(null, `select public.estudo_qualidade()`, [], 'anon'))), 'anônimo não vê');
  for (const o of [opA, opB, opC, opD]) await rpc(resp1, 'excluir_operacao', { p_operacao: o.id });
}

console.log('Cadastro rápido de vítima e convite por e-mail (migração 044)');
{
  const opQ = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP 044', p_retencao_horas: 0, p_dados: JSON.stringify({ tipo: 'terrestre' }) });
  console.log('  cadastro rápido');
  const vr = await rpc(resp1, 'salvar_vitima', { p_operacao: opQ.id, p_id: null, p_dados: JSON.stringify({ nome: 'Não identificada', idade: 60, idade_qualidade: 'estimada', sexo: 'F', roupas: 'jaqueta vermelha', cadastro_rapido: true }) });
  chk(vr.cadastro_rapido === true && vr.idade === 60 && vr.idade_qualidade === 'estimada' && vr.sexo === 'F', 'ficha rápida: só o essencial, marcada como cadastro rápido', vr);
  const vc = await rpc(resp1, 'salvar_vitima', { p_operacao: opQ.id, p_id: vr.id, p_dados: JSON.stringify({ nome: 'Maria da Silva', caracteristicas: 'cabelo grisalho', cadastro_rapido: false }) });
  chk(vc.cadastro_rapido === false && vc.nome === 'Maria da Silva', 'completar a ficha tira a marca de cadastro rápido', vc);
  const vn = await rpc(resp1, 'salvar_vitima', { p_operacao: opQ.id, p_id: null, p_dados: JSON.stringify({ nome: 'Completa' }) });
  chk(vn.cadastro_rapido === false, 'ficha comum não é cadastro rápido');
  const vq = await rpc(resp1, 'salvar_vitima', { p_operacao: opQ.id, p_id: vr.id, p_dados: JSON.stringify({ roupas: 'camisa azul' }) });
  chk(vq.cadastro_rapido === false, 'editar sem mandar a marca não a muda');
  const enc = await rpc(resp1, 'registrar_vitima_encontrada', { p_operacao: opQ.id, p_dados: JSON.stringify({ condicao: 'viva', lat: -22.9, lng: -43.2, vitima_nome: 'Só o nome' }) });
  chk(enc.vitima && enc.vitima.cadastro_rapido === true, 'vítima criada só com o nome em "encontrada" nasce como cadastro rápido', enc.vitima);

  console.log('  convite por e-mail');
  chk(/email_convite_invalido/.test(await erroDe(rpc(resp1, 'criar_convite_participante', { p_operacao: opQ.id, p_nome: 'Ana', p_email: 'ana@@x' }))), 'e-mail inválido: recusado');
  chk(/nome_convite_invalido/.test(await erroDe(rpc(resp1, 'criar_convite_participante', { p_operacao: opQ.id, p_nome: 'A', p_email: 'ana@x.com' }))), 'nome curto demais: recusado');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'criar_convite_participante', { p_operacao: opQ.id, p_nome: 'Ana', p_email: 'ana@x.com' }))), 'responsável de fora da operação não convida');
  const cv = await rpc(resp1, 'criar_convite_participante', { p_operacao: opQ.id, p_nome: 'Ana Souza', p_email: ' Ana@Exemplo.com ' });
  chk(cv.email === 'ana@exemplo.com' && /^[0-9a-f]{24}$/.test(cv.codigo) && cv.envios === 0 && !cv.enviado_em, 'convite criado com e-mail minúsculo e código aleatório', cv);
  const cv2 = await rpc(resp1, 'criar_convite_participante', { p_operacao: opQ.id, p_nome: 'Ana S.', p_email: 'ana@exemplo.com' });
  chk(cv2.id === cv.id && cv2.codigo === cv.codigo && cv2.nome === 'Ana S.', 'mesmo e-mail: reaproveita o convite (não duplica)');
  const dados = await rpc(resp1, 'convite_dados_envio', { p_convite: cv.id });
  chk(dados.email === 'ana@exemplo.com' && dados.token_civil === opQ.token_civil && dados.operacao === 'OP 044' && dados.envios === 0, 'dados para o servidor enviar (e-mail, token do civil)');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'convite_dados_envio', { p_convite: cv.id }))), 'quem não é da operação não pega os dados do envio');
  const e1 = await rpc(resp1, 'convite_registrar_envio', { p_convite: cv.id, p_erro: 'provedor fora do ar' });
  chk(e1.envio_erro === 'provedor fora do ar' && e1.envios === 0, 'falha de envio guardada, sem contar envio');
  const e2 = await rpc(resp1, 'convite_registrar_envio', { p_convite: cv.id });
  chk(e2.envios === 1 && e2.enviado_em && e2.envio_erro === null, 'envio registrado');
  for (let i = 0; i < 4; i++) await rpc(resp1, 'convite_registrar_envio', { p_convite: cv.id });
  chk(/convite_envios_limite/.test(await erroDe(rpc(resp1, 'convite_dados_envio', { p_convite: cv.id }))), 'limite de 5 envios por convite');
  const uC = await usuario(null, true);
  chk((await rpc(uC, 'convite_ler', { p_codigo: cv.codigo })).nome === 'Ana S.', 'a página do participante lê só o nome do convite');
  chk((await como(null, `select (public.convite_ler($1))->>'nome' as nome`, [cv.codigo], 'anon')).rows[0].nome === 'Ana S.', 'a página lê o nome do convite mesmo antes de entrar (sem sessão)');
  chk(/permission denied/.test(await erroDe(como(null, `select public.convite_dados_envio($1)`, [cv.id], 'anon'))), 'sem sessão não pega os dados do envio');
  chk((await rpc(uC, 'convite_ler', { p_codigo: 'zzzz' })) === null && (await rpc(uC, 'convite_ler', { p_codigo: '0'.repeat(24) })) === null, 'código inválido ou desconhecido: nulo');
  chk(JSON.stringify(await rpc(uC, 'convite_ler', { p_codigo: cv.codigo })).indexOf('exemplo.com') < 0, 'o e-mail não sai pelo código do convite');
  const pC = await rpc(uC, 'ingressar', { p_token: opQ.token_civil, p_nome: 'Ana Souza', p_tipo: 'civil', p_cpf: null, p_telefone: tel });
  const uOutro = await usuario(null, true);
  chk(/sem_permissao/.test(await erroDe(rpc(uOutro, 'convite_aceitar', { p_codigo: cv.codigo, p_participante: pC.participante_id }))), 'só o próprio participante aceita o convite');
  await rpc(uC, 'convite_aceitar', { p_codigo: cv.codigo, p_participante: pC.participante_id });
  const aceito = (await como(resp1, `select aceito_em, participante_id from public.convites_participante where id = $1`, [cv.id])).rows[0];
  chk(aceito.aceito_em && aceito.participante_id === pC.participante_id, 'convite aceito fica ligado ao participante');
  chk((await como(uC, `select count(*)::int n from public.convites_participante`)).rows[0].n === 0 && (await como(resp2, `select count(*)::int n from public.convites_participante`)).rows[0].n === 0, 'só os responsáveis da operação leem os convites');
  chk(/permission denied|row-level/.test(await erroDe(como(resp1, `insert into public.convites_participante (operacao_id, nome, email, criado_por_nome) values ($1, 'X Y', 'x@y.com', 'x')`, [opQ.id]))), 'convite só pelas funções');
  const dq = (await db.query(`select tipo from public.diario where operacao_id = $1 and tipo like 'convite%'`, [opQ.id])).rows.map((r) => r.tipo);
  chk(['convite_criado', 'convite_enviado', 'convite_aceito'].every((t) => dq.includes(t)), 'convite no diário', dq);
  const cx = await rpc(resp1, 'criar_convite_participante', { p_operacao: opQ.id, p_nome: 'Bia Lima', p_email: 'bia@exemplo.com' });
  await rpc(resp1, 'cancelar_convite_participante', { p_convite: cx.id });
  chk((await rpc(uC, 'convite_ler', { p_codigo: cx.codigo })) === null, 'convite cancelado deixa de valer');
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opQ.id });
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'criar_convite_participante', { p_operacao: opQ.id, p_nome: 'Caio', p_email: 'caio@exemplo.com' }))), 'encerrada: não cria convite');
  await db.query(`update public.operacoes set dados_apagados_em = now() where id = $1`, [opQ.id]);
  chk((await db.query(`select count(*)::int n from public.convites_participante where operacao_id = $1`, [opQ.id])).rows[0].n === 0, 'fim da retenção apaga os e-mails dos convidados');
  const pub44 = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`)).rows.map((r) => r.tablename);
  chk(pub44.includes('convites_participante'), 'convites no Realtime');
  await rpc(resp1, 'excluir_operacao', { p_operacao: opQ.id });
}

console.log('Painel de comando SCI (migração 045)');
{
  const opS = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP SCI', p_retencao_horas: 0, p_dados: JSON.stringify({ tipo: 'aquatica' }) });
  const J = (o) => JSON.stringify(o);
  const ev = async () => (await db.query(`select * from public.sci_eventos where operacao_id = $1 order by registrado_em, ocorrido_em`, [opS.id])).rows;
  console.log('  funções, total e marcos');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'sci_salvar_estado', { p_operacao: opS.id, p_dados: J({ funcoes: { chefe: { nome: 'X' } } }) }))), 'função desconhecida: recusada');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'sci_salvar_estado', { p_operacao: opS.id, p_dados: J({ situacao: 'x' }) }))), 'responsável de fora não altera');
  const e1 = await rpc(resp1, 'sci_salvar_estado', { p_operacao: opS.id, p_dados: J({ funcoes: { ci: { nome: 'Asp Of BM Gaffo' }, seguranca: { nome: 'Sgt Dinardi' }, ligacao: { acumula_ci: true } }, total_vitimas: 14 }) });
  chk(e1.funcoes.ci.nome === 'Asp Of BM Gaffo' && e1.funcoes.ligacao.acumula_ci === true && e1.total_vitimas === 14 && e1.total_confirmado === false, 'funções e total gravados (total começa NÃO CONFIRMADO)', e1);
  let lt = await ev();
  chk(lt.some((x) => /Comandante do Incidente: Asp Of BM Gaffo/.test(x.texto)) && lt.some((x) => /Oficial de Ligação: acumulada pelo CI/.test(x.texto)) && lt.some((x) => /Total de vítimas: 14 \(NÃO CONFIRMADO\)/.test(x.texto) && x.nao_confirmada), 'mudanças de função e de total entram na linha do tempo', lt.map((x) => x.texto));
  await rpc(resp1, 'sci_salvar_estado', { p_operacao: opS.id, p_dados: J({ total_confirmado: true }) });
  const desp = new Date(Date.now() - 3 * 3600e3).toISOString();
  chk(/sci_marco_invalido/.test(await erroDe(rpc(resp1, 'sci_marcar', { p_operacao: opS.id, p_marco: 'chegada_x' }))), 'marco desconhecido: recusado');
  chk(/data_invalida/.test(await erroDe(rpc(resp1, 'sci_marcar', { p_operacao: opS.id, p_marco: 'despacho', p_em: new Date(Date.now() + 3600e3).toISOString() }))), 'marco no futuro: recusado');
  const m1 = await rpc(resp1, 'sci_marcar', { p_operacao: opS.id, p_marco: 'despacho', p_em: desp });
  const m2 = await rpc(resp1, 'sci_marcar', { p_operacao: opS.id, p_marco: 'pc' });
  chk(new Date(m1.marcos.despacho).getTime() === new Date(desp).getTime() && m2.marcos.pc, 'marcos com a hora informada ou "agora"');
  await rpc(resp1, 'sci_marcar', { p_operacao: opS.id, p_marco: 'despacho', p_em: new Date(Date.now() - 2.9 * 3600e3).toISOString() });
  const m4 = await rpc(resp1, 'sci_marcar', { p_operacao: opS.id, p_marco: 'pc', p_apagar: true });
  lt = await ev();
  chk(lt.some((x) => /Despacho da equipe — corrigido de/.test(x.texto)) && lt.some((x) => /marco "Posto de Comando instalado" retirado/.test(x.texto)) && !m4.marcos.pc, 'corrigir e retirar marco ficam registrados', lt.map((x) => x.texto));

  console.log('  vítimas');
  const v1 = await rpc(resp1, 'sci_salvar_vitima', { p_operacao: opS.id, p_id: null, p_dados: J({ sexo: 'F', local: 'na água, margem oposta' }) });
  const v2 = await rpc(resp1, 'sci_salvar_vitima', { p_operacao: opS.id, p_id: null, p_dados: J({ sexo: 'M' }) });
  chk(v1.numero === 1 && v2.numero === 2 && v1.fase === 'localizada' && v1.localizada_em, 'vítimas numeradas na ordem (V-01, V-02), começam localizadas');
  chk(/numero_em_uso/.test(await erroDe(rpc(resp1, 'sci_salvar_vitima', { p_operacao: opS.id, p_id: null, p_dados: J({ numero: 2 }) }))), 'número repetido: recusado');
  const v1b = await rpc(resp1, 'sci_salvar_vitima', { p_operacao: opS.id, p_id: v1.id, p_dados: J({ fase: 'removida' }) });
  const v1c = await rpc(resp1, 'sci_salvar_vitima', { p_operacao: opS.id, p_id: v1.id, p_dados: J({ triagem: 'amarelo' }) });
  const v1d = await rpc(resp1, 'sci_salvar_vitima', { p_operacao: opS.id, p_id: v1.id, p_dados: J({ fase: 'transportada', destino: 'Hospital – SAMU' }) });
  chk(v1b.removida_em && v1c.triada_em && v1d.transportada_em && v1d.destino === 'Hospital – SAMU', 'cada passo guarda o horário (ACV, triagem, transporte)');
  const v1e = await rpc(resp1, 'sci_salvar_vitima', { p_operacao: opS.id, p_id: v1.id, p_dados: J({ fase: 'removida' }) });
  chk(v1e.transportada_em === null && v1e.removida_em, 'voltar uma fase (correção) tira o horário da fase desfeita');
  await rpc(resp1, 'sci_salvar_vitima', { p_operacao: opS.id, p_id: v2.id, p_dados: J({ triagem: 'cinza' }) });
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'sci_salvar_vitima', { p_operacao: opS.id, p_id: v2.id, p_dados: J({ triagem: 'azul' }) }))), 'triagem fora das cores: recusada');
  lt = await ev();
  const textos = lt.map((x) => x.texto).join(' | ');
  chk(/V-01 localizada — na água, margem oposta \(feminino\)/.test(textos) && /V-01 removida para a ACV/.test(textos) && /V-01 triada AMARELO/.test(textos)
    && /V-01 transportada — Hospital – SAMU/.test(textos) && /V-01 voltou para "removidas para a ACV" \(correção\)/.test(textos), 'cada movimento da vítima entra sozinho na linha do tempo', textos);
  chk(lt.some((x) => /V-02 — óbito/.test(x.texto) && x.categoria === 'seguranca'), 'óbito (cinza) registrado como segurança');
  chk(/justificativa_obrigatoria/.test(await erroDe(rpc(resp1, 'sci_excluir_vitima', { p_id: v2.id, p_motivo: '' }))), 'retirar vítima do quadro exige motivo');

  console.log('  linha do tempo');
  const ex = await rpc(resp1, 'sci_registrar_evento', { p_operacao: opS.id, p_dados: J({ categoria: 'informacao', texto: 'Relatório de danos do lado ilhado (Defesa Civil)', nao_confirmada: true, em: new Date(Date.now() - 600e3).toISOString() }) });
  chk(ex.nao_confirmada && ex.origem === 'manual', 'registro manual "NÃO CONFIRMADA"');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'sci_registrar_evento', { p_operacao: opS.id, p_dados: J({ categoria: 'fofoca', texto: 'x' }) }))), 'categoria desconhecida: recusada');
  const ec = await rpc(resp1, 'sci_confirmar_evento', { p_id: ex.id });
  chk(!ec.nao_confirmada && ec.confirmada_por_nome === 'Sgt Um', 'confirmação pela equipe');
  const ek = await rpc(resp1, 'sci_corrigir_evento', { p_id: ex.id, p_dados: J({ texto: 'Resgatados 11 ilhados (5 masculinos, 6 femininos)', motivo: 'eram 9 na primeira contagem' }) });
  chk(ek.historico.length === 1 && ek.historico[0].texto === 'Relatório de danos do lado ilhado (Defesa Civil)' && ek.corrigido_em && /eram 9/.test(ek.historico[0].motivo), 'correção guarda o texto anterior e o motivo', ek.historico);
  chk(/justificativa_obrigatoria/.test(await erroDe(rpc(resp1, 'sci_anular_evento', { p_id: ex.id, p_motivo: '' }))), 'anular exige motivo');
  const ea = await rpc(resp1, 'sci_anular_evento', { p_id: ex.id, p_motivo: 'lançado em duplicidade' });
  chk(ea.anulado_em && ea.anulado_motivo === 'lançado em duplicidade' && (await db.query(`select count(*)::int n from public.sci_eventos where id = $1`, [ex.id])).rows[0].n === 1, 'anulado continua guardado, com o motivo');
  const dia = (await db.query(`select tipo, titulo, nivel from public.diario where operacao_id = $1 and tipo like 'sci_%'`, [opS.id])).rows;
  chk(dia.filter((d) => d.tipo === 'sci_evento').length === lt.length + 1 && ['sci_correcao', 'sci_confirmacao', 'sci_anulacao'].every((t) => dia.some((d) => d.tipo === t)), 'tudo também no diário (relatório final), com correção, confirmação e anulação', dia.length);
  chk(dia.some((d) => d.nivel === 'critico' && /Segurança/.test(d.titulo)), 'eventos de segurança em destaque no diário');

  console.log('  instalações, equipes, órgãos, recursos, canais, nível do rio');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: null, p_tipo: 'instalacao', p_dados: J({ tipo: 'pc' }) }))), 'item sem nome: recusado');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: null, p_tipo: 'orgao', p_dados: J({ nome: 'SAMU', situacao: 'talvez' }) }))), 'situação fora da lista: recusada');
  chk(/posicao_invalida/.test(await erroDe(rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: null, p_tipo: 'instalacao', p_dados: J({ nome: 'PC', lat: -23.38 }) }))), 'latitude sem longitude: recusada');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: null, p_tipo: 'foguete', p_dados: J({ nome: 'x' }) }))), 'tipo de item desconhecido: recusado');
  const pc = await rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: null, p_tipo: 'instalacao', p_dados: J({ nome: 'Posto de Comando', tipo: 'pc', responsavel: 'Asp Of BM Gaffo', lat: -23.384543, lng: -51.077683, estado: 'ativa', lixo: 'x' }) });
  chk(pc.dados.lat === -23.384543 && !('lixo' in pc.dados), 'instalação com coordenadas; chaves desconhecidas descartadas', pc.dados);
  const zpa = await rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: null, p_tipo: 'instalacao', p_dados: J({ nome: 'ZPA', tipo: 'zpa', estado: 'ativa' }) });
  await rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: zpa.id, p_tipo: 'instalacao', p_dados: J({ nome: 'ZPA', tipo: 'zpa', estado: 'desativada', motivo: 'aeronave do SAMU indisponível por condições meteorológicas' }) });
  const og = await rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: null, p_tipo: 'orgao', p_dados: J({ nome: 'SAMU', situacao: 'acionado' }) });
  await rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: og.id, p_tipo: 'orgao', p_dados: J({ nome: 'SAMU', situacao: 'no_local', pessoas: 5, detalhe: 'Médico + 4 integrantes' }) });
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: og.id, p_tipo: 'orgao', p_dados: J({ nome: 'SAMU', pessoas: -1 }) }))), 'efetivo negativo: recusado');
  await rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: null, p_tipo: 'equipe', p_dados: J({ nome: 'Bote', orgao: 'CBMPR', efetivo: 4, missao: 'Resgate das vítimas ilhadas por bote', chefe: 'Sgt Gustavo', status: 'em_operacao' }) });
  await rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: null, p_tipo: 'recurso', p_dados: J({ nome: 'Aeronave do SAMU', tipo: 'aeronave', orgao: 'SAMU', qtd: 1, status: 'indisponivel', nota: 'condições meteorológicas' }) });
  await rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: null, p_tipo: 'canal', p_dados: J({ nome: 'Zello via Starlink', funcao: 'Ligação PC ↔ GGI', usuarios: 'PC, GGI' }) });
  await rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: null, p_tipo: 'leitura_rio', p_dados: J({ em: new Date().toISOString(), ponto: 'Ponto de transposição', nivel: 'Muito alto', vazao: 'Correnteza fortíssima', tendencia: 'subindo', fonte: 'Equipe de resgate' }) });
  lt = await ev();
  const t2 = lt.map((x) => x.texto).join(' | ');
  chk(/Posto de Comando estabelecida? — responsável: Asp Of BM Gaffo|Posto de Comando estabelecida — responsável/.test(t2) || /Posto de Comando estabelecid/.test(t2), 'instalação ativada na linha do tempo', t2);
  chk(/ZPA desativada — aeronave do SAMU indisponível/.test(t2) && /SAMU acionado/.test(t2) && /SAMU no local \(5 pessoas\)/.test(t2) && /Equipe Bote em operação/.test(t2) && /Aeronave do SAMU indisponível/.test(t2), 'órgão, equipe, recurso e desativação contam a história sozinhos', t2);
  chk(lt.some((x) => /Nível do rio \(Ponto de transposição\): Muito alto, Correnteza fortíssima — SUBINDO/.test(x.texto) && x.categoria === 'seguranca'), 'leitura do rio subindo entra como segurança');

  console.log('  imagens do local');
  const cam = opS.id + '/aaaaaaaa-1111-4111-8111-' + '1'.repeat(12) + '.jpg';
  chk(/imagem_nao_enviada/.test(await erroDe(rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: null, p_tipo: 'imagem', p_dados: J({ caminho: cam, legenda: 'Cena' }) }))), 'imagem só depois de enviada ao Storage');
  chk(/row-level security/.test(await erroDe(como(resp2, `insert into storage.objects (bucket_id, name) values ('sci', $1)`, [cam]))), 'responsável de fora não envia imagem');
  await como(resp1, `insert into storage.objects (bucket_id, name) values ('sci', $1)`, [cam]);
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: null, p_tipo: 'imagem', p_dados: J({ caminho: 'outra/' + cam }) }))), 'caminho fora da pasta da operação: recusado');
  const im = await rpc(resp1, 'sci_salvar_item', { p_operacao: opS.id, p_id: null, p_tipo: 'imagem', p_dados: J({ caminho: cam, legenda: 'Cena: ponte destruída' }) });
  chk((await como(resp1, `select count(*)::int n from storage.objects where bucket_id = 'sci' and name = $1`, [cam])).rows[0].n === 1, 'responsável vê a imagem');
  chk((await como(resp2, `select count(*)::int n from storage.objects where bucket_id = 'sci' and name = $1`, [cam])).rows[0].n === 0, 'responsável de fora não vê');
  await rpc(resp1, 'sci_excluir_item', { p_id: im.id });
  chk((await db.query(`select bucket from public.arquivos_pendentes where caminho = $1`, [cam])).rows[0].bucket === 'sci', 'imagem excluída entra na fila de remoção do Storage');

  console.log('  acesso');
  const uP = await usuario(null, true);
  await rpc(uP, 'ingressar', { p_token: opS.token_civil, p_nome: 'Civil SCI', p_tipo: 'civil', p_cpf: null, p_telefone: tel });
  chk(['sci_estado', 'sci_vitimas', 'sci_eventos', 'sci_itens'].every(() => true) && (await como(uP, `select (select count(*) from public.sci_vitimas) + (select count(*) from public.sci_eventos) + (select count(*) from public.sci_itens) + (select count(*) from public.sci_estado) n`)).rows[0].n == 0, 'participante não lê nada do SCI');
  chk((await como(resp2, `select count(*)::int n from public.sci_vitimas`)).rows[0].n === 0, 'responsável de outra operação não lê');
  chk((await como(resp1, `select count(*)::int n from public.sci_vitimas where operacao_id = $1`, [opS.id])).rows[0].n === 2, 'responsável da operação lê o quadro');
  chk(/permission denied|row-level/.test(await erroDe(como(resp1, `insert into public.sci_eventos (operacao_id, ocorrido_em, categoria, texto, registrado_por_nome) values ($1, now(), 'decisao', 'x', 'x')`, [opS.id]))), 'escrita só pelas funções');
  const pubS = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`)).rows.map((r) => r.tablename);
  chk(['sci_estado', 'sci_vitimas', 'sci_eventos', 'sci_itens'].every((x) => pubS.includes(x)), 'tabelas do SCI no Realtime');

  console.log('  modo teste e zerar');
  chk(/sci_ja_iniciado/.test(await erroDe(rpc(resp1, 'sci_modo_teste', { p_operacao: opS.id, p_ligar: true }))), 'modo teste só com o quadro vazio');
  const opT = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP SCI TESTE', p_retencao_horas: 0, p_dados: JSON.stringify({ tipo: 'aquatica' }) });
  await rpc(resp1, 'sci_salvar_item', { p_operacao: opT.id, p_id: null, p_tipo: 'equipe', p_dados: J({ nome: 'Bote', efetivo: 4 }) });
  const diarioAntes = (await db.query(`select count(*)::int n from public.diario where operacao_id = $1`, [opT.id])).rows[0].n;
  await rpc(resp1, 'sci_modo_teste', { p_operacao: opT.id, p_ligar: false });
  chk((await rpc(resp1, 'sci_modo_teste', { p_operacao: opT.id, p_ligar: true })).teste === true, 'liga o modo teste com o quadro vazio (equipes preparadas não contam)');
  await rpc(resp1, 'sci_salvar_vitima', { p_operacao: opT.id, p_id: null, p_dados: J({ sexo: 'M', triagem: 'vermelho', fase: 'removida' }) });
  await rpc(resp1, 'sci_marcar', { p_operacao: opT.id, p_marco: 'acionamento' });
  await rpc(resp1, 'sci_salvar_estado', { p_operacao: opT.id, p_dados: J({ total_vitimas: 3 }) });
  chk((await db.query(`select count(*)::int n from public.diario where operacao_id = $1`, [opT.id])).rows[0].n === diarioAntes, 'no modo teste nada vai para o diário');
  const z = await rpc(resp1, 'sci_modo_teste', { p_operacao: opT.id, p_ligar: false });
  const estT = (await db.query(`select * from public.sci_estado where operacao_id = $1`, [opT.id])).rows[0];
  chk(z.vitimas === 1 && z.eventos >= 3 && estT.teste === false && JSON.stringify(estT.marcos) === '{}' && estT.total_vitimas === null
    && (await db.query(`select count(*)::int n from public.sci_itens where operacao_id = $1`, [opT.id])).rows[0].n === 1, 'zerar: vítimas, linha do tempo, marcos e total de teste apagados; equipes preparadas ficam', [z, estT]);

  console.log('  encerrada, retenção e exclusão');
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opS.id });
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'sci_salvar_vitima', { p_operacao: opS.id, p_id: null, p_dados: J({}) })))
    && /operacao_encerrada/.test(await erroDe(rpc(resp1, 'sci_marcar', { p_operacao: opS.id, p_marco: 'termino' }))), 'encerrada: somente leitura');
  await db.query(`update public.operacoes set dados_apagados_em = now() where id = $1`, [opS.id]);
  chk((await db.query(`select count(*)::int n from public.sci_vitimas where operacao_id = $1`, [opS.id])).rows[0].n === 0
    && (await db.query(`select count(*)::int n from public.sci_eventos where operacao_id = $1`, [opS.id])).rows[0].n > 0, 'fim da retenção apaga o quadro de vítimas (dados pessoais); a linha do tempo fica');
  await rpc(resp1, 'excluir_operacao', { p_operacao: opS.id });
  await rpc(resp1, 'excluir_operacao', { p_operacao: opT.id });
  chk((await db.query(`select (select count(*) from public.sci_eventos where operacao_id in ($1, $2)) + (select count(*) from public.sci_itens where operacao_id in ($1, $2)) + (select count(*) from public.sci_estado where operacao_id in ($1, $2)) n`, [opS.id, opT.id])).rows[0].n == 0, 'excluir a operação apaga o SCI');
}

console.log('SCI integrado ao app (migração 046)');
{
  const J = (o) => JSON.stringify(o);
  const opI = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP SCI INT', p_retencao_horas: 0, p_dados: J({ tipo: 'terrestre', local_lat: -25.43, local_lng: -49.27 }) });
  const fM = await rpc(resp1, 'salvar_vitima', { p_operacao: opI.id, p_id: null, p_dados: J({ nome: 'Maria Souza', idade: 70, idade_qualidade: 'estimada', sexo: 'F' }) });
  const fJ = await rpc(resp1, 'salvar_vitima', { p_operacao: opI.id, p_id: null, p_dados: J({ nome: 'João Lima', sexo: 'M' }) });
  // João já estava no quadro (lançado pelo SCI, ligado à ficha) antes de ser encontrado
  const sJ = await rpc(resp1, 'sci_salvar_vitima', { p_operacao: opI.id, p_id: null, p_dados: J({ vitima_id: fJ.id, nome: 'João Lima' }) });
  const uE = await usuario(null, true);
  const pE = await rpc(uE, 'ingressar', { p_token: opI.token_militar, p_nome: 'Sd Achou', p_tipo: 'militar', p_cpf: cpf, p_telefone: tel });
  const rM = await rpc(resp1, 'registrar_vitima_encontrada', { p_operacao: opI.id, p_dados: J({ condicao: 'viva', vitima_id: fM.id, lat: -25.431, lng: -49.271, local_descricao: 'margem do córrego', encontrou: pE.participante_id }) });
  const qM = (await db.query(`select * from public.sci_vitimas where localizacao_id = $1`, [rM.registro.id])).rows[0];
  chk(qM && qM.vitima_id === fM.id && qM.nome === 'Maria Souza' && qM.idade === 70 && qM.idade_estimada && qM.sexo === 'F' && qM.fase === 'localizada' && qM.local === 'margem do córrego' && qM.triagem === null,
    '"Vítima encontrada" entra sozinha no quadro do SCI, com os dados da ficha e o local', qM);
  const rJ = await rpc(resp1, 'registrar_vitima_encontrada', { p_operacao: opI.id, p_dados: J({ condicao: 'obito', vitima_id: fJ.id }) });
  const qJ = (await db.query(`select * from public.sci_vitimas where operacao_id = $1 and vitima_id = $2`, [opI.id, fJ.id])).rows;
  chk(qJ.length === 1 && qJ[0].id === sJ.id && qJ[0].localizacao_id === rJ.registro.id && qJ[0].triagem === 'cinza', 'vítima que já estava no quadro é completada (não duplica); óbito entra como cinza', qJ);
  const rX = await rpc(resp1, 'responsavel_registrar_vitima', { p_operacao: opI.id, p_condicao: 'viva' });
  const qX = (await db.query(`select * from public.sci_vitimas where localizacao_id = $1`, [rX.registro.id])).rows[0];
  chk(qX && qX.numero === 3 && qX.vitima_id === null && qX.nome === '', 'vítima encontrada sem ficha também entra (número seguinte)', qX);
  const evI = (await db.query(`select texto, categoria from public.sci_eventos where operacao_id = $1 and ref like 'localizacao:%' order by ocorrido_em`, [opI.id])).rows;
  chk(evI.length === 3 && /V-02 localizada — Maria Souza \(com vida\)/.test(evI.map((e) => e.texto).join('|')) && evI.some((e) => e.categoria === 'seguranca' && /óbito/.test(e.texto)), 'linha do tempo do SCI registra a localização', evI);
  chk((await db.query(`select count(*)::int n from public.diario where operacao_id = $1 and tipo = 'sci_evento' and detalhe like '%Vítima encontrada%'`, [opI.id])).rows[0].n === 0, 'sem duplicar no diário (a vítima localizada já está lá)');

  console.log('  contexto do app para o SCI');
  const g = await rpc(resp1, 'salvar_grupo', { p_operacao: opI.id, p_id: null, p_dados: J({ nome: 'Alfa', cor: '#e11d48' }) });
  await rpc(resp1, 'definir_membro', { p_grupo: g.id, p_participante: pE.participante_id, p_papel: 'responsavel' });
  const base = await rpc(resp1, 'salvar_ponto', { p_operacao: opI.id, p_id: null, p_dados: J({ categoria: 'BASE', titulo: 'Base Barigui', lat: -25.432, lng: -49.272 }) });
  await rpc(resp1, 'salvar_setor', { p_operacao: opI.id, p_id: null, p_dados: J({ nome: 'S1', forma: 'circulo', centro_lat: -25.43, centro_lng: -49.27, raio_m: 300 }) });
  await rpc(resp1, 'salvar_briefing', { p_operacao: opI.id, p_dados: J({ objetivo: 'Localizar as 2 vítimas', riscos: 'Correnteza', comunicacoes: 'VHF canal 3' }) });
  await rpc(resp1, 'decisao_criar', { p_operacao: opI.id, p_dados: J({ texto: 'Pedir apoio aéreo?', responsavel: 'CI' }) });
  await rpc(resp1, 'sci_registrar_evento', { p_operacao: opI.id, p_dados: J({ categoria: 'decisao', texto: 'Teste SCI' }) });
  const cx = await rpc(resp1, 'sci_contexto', { p_operacao: opI.id });
  chk(cx.comando.nome === 'Sgt Um' && cx.briefing.objetivo === 'Localizar as 2 vítimas' && cx.briefing.comunicacoes === 'VHF canal 3', 'comando atual e briefing', [cx.comando, cx.briefing]);
  chk(cx.fichas.length === 2 && cx.localizacoes.length === 3 && cx.localizacoes.some((l) => l.vitima_id === fM.id && l.condicao === 'viva'), 'fichas e localizações');
  const eq = cx.equipes.find((e) => e.nome === 'Alfa');
  chk(eq && eq.membros === 1 && eq.militares === 1 && eq.responsavel === 'Sd Achou' && eq.disponibilidade === 'disponivel' && Array.isArray(eq.recursos), 'equipe do app com membros, responsável, disponibilidade e recursos', eq);
  chk(cx.participantes.militares === 1 && cx.participantes.total === 1 && cx.participantes.responsaveis >= 1, 'participantes rastreados por tipo', cx.participantes);
  chk(cx.pontos.some((p) => p.id === base.id && p.categoria === 'BASE') && cx.setores.some((s) => s.nome === 'S1' && s.forma === 'circulo' && s.raio_m === 300), 'pontos do mapa e setores com a geometria');
  chk(cx.decisoes.length === 1 && cx.alertas.some((a) => a.tipo === 'vitima_localizada'), 'decisões pendentes e alertas críticos sem ciente', cx.alertas.map((a) => a.tipo));
  chk(cx.diario.length > 3 && cx.diario.every((d) => !/^sci_/.test(d.tipo)) && cx.diario.some((d) => d.tipo === 'vitima_localizada'), 'diário do app sem repetir os eventos do SCI');
  chk(cx.verificacao.indicacoes_em_analise === 0 && cx.verificacao.focos_a_verificar === 0, 'verificação (cão e drone)');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'sci_contexto', { p_operacao: opI.id }))) && /sem_permissao/.test(await erroDe(rpc(uE, 'sci_contexto', { p_operacao: opI.id }))), 'contexto só para os responsáveis da operação');
  const inst = await rpc(resp1, 'sci_salvar_item', { p_operacao: opI.id, p_id: null, p_tipo: 'instalacao', p_dados: J({ nome: 'Posto de Comando', tipo: 'pc', ponto_id: base.id }) });
  chk(inst.dados.ponto_id === base.id, 'instalação ligada a um ponto do mapa');
  await rpc(resp1, 'encerrar_operacao', { p_operacao: opI.id });
  await rpc(resp1, 'excluir_operacao', { p_operacao: opI.id });
}

console.log('Convites por categoria e WhatsApp; tipos de ponto (migração 047)');
{
  const J = (o) => JSON.stringify(o);
  const opC = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP 047', p_retencao_horas: 0, p_dados: J({ tipo: 'terrestre' }) });
  const cw = await rpc(resp1, 'criar_convite', { p_operacao: opC.id, p_dados: J({ nome: 'Sd Pereira', tipo: 'militar', canal: 'whatsapp', telefone: '(41) 99876-5432' }) });
  chk(cw.telefone === '5541998765432' && cw.tipo === 'militar' && cw.canal === 'whatsapp' && cw.email === null, 'convite por WhatsApp para bombeiro, telefone com 55 + DDD', cw);
  chk(/telefone_convite_invalido/.test(await erroDe(rpc(resp1, 'criar_convite', { p_operacao: opC.id, p_dados: J({ nome: 'X Y', canal: 'whatsapp', telefone: '123' }) }))), 'telefone curto: recusado');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'criar_convite', { p_operacao: opC.id, p_dados: J({ nome: 'X Y', tipo: 'chefe', canal: 'email', email: 'x@y.com' }) }))), 'categoria desconhecida: recusada');
  const cw2 = await rpc(resp1, 'criar_convite', { p_operacao: opC.id, p_dados: J({ nome: 'Sd Pereira Jr', tipo: 'militar', canal: 'whatsapp', telefone: '5541998765432' }) });
  chk(cw2.id === cw.id && cw2.nome === 'Sd Pereira Jr', 'mesmo telefone e categoria: reaproveita');
  const cr = await rpc(resp1, 'criar_convite', { p_operacao: opC.id, p_dados: J({ nome: 'Ten Ramos', tipo: 'responsavel', canal: 'email', email: 'ramos@cbm.pr.gov.br' }) });
  const de = await rpc(resp1, 'convite_dados_envio', { p_convite: cr.id });
  chk(de.tipo === 'responsavel' && de.operacao_id === opC.id && de.token_militar === opC.token_militar, 'dados do envio trazem a categoria e o que o link precisa');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'convite_dados_envio', { p_convite: cw.id }))), 'convite de WhatsApp não é enviado pelo servidor');
  const antigo = await rpc(resp1, 'criar_convite_participante', { p_operacao: opC.id, p_nome: 'Ana Civil', p_email: 'ana@x.com' });
  chk(antigo.tipo === 'civil' && antigo.canal === 'email', 'função antiga continua criando convite civil por e-mail');
  chk((await db.query(`select titulo from public.diario where operacao_id = $1 and tipo = 'convite_criado'`, [opC.id])).rows.some((r) => /WhatsApp \(bombeiro\): Sd Pereira/.test(r.titulo)), 'convite no diário com canal e categoria');

  console.log('  tipos de ponto');
  chk(/sem_permissao/.test(await erroDe(rpc(await usuario(null, true), 'salvar_tipo_ponto', { p_id: null, p_dados: J({ nome: 'Hospital', icone: '🏥', cor: '#ff0000' }) }))), 'participante não cria tipo');
  const tH = await rpc(resp1, 'salvar_tipo_ponto', { p_id: null, p_dados: J({ nome: 'Hospital de campanha', icone: '🏥', cor: '#E11D48' }) });
  chk(tH.icone === '🏥' && tH.cor === '#e11d48' && tH.ativo, 'tipo criado com ícone e cor', tH);
  chk(/tipo_ponto_existente/.test(await erroDe(rpc(resp2, 'salvar_tipo_ponto', { p_id: null, p_dados: J({ nome: 'hospital de campanha', icone: 'H', cor: '#000000' }) }))), 'nome repetido: recusado');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'salvar_tipo_ponto', { p_id: null, p_dados: J({ nome: 'Barco', icone: '', cor: '#000000' }) }))), 'sem ícone: recusado');
  chk((await como(resp2, `select count(*)::int n from public.tipos_ponto where id = $1`, [tH.id])).rows[0].n === 1, 'outros responsáveis usam o tipo (vale para todas as operações)');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'salvar_tipo_ponto', { p_id: tH.id, p_dados: J({ icone: 'X' }) }))), 'editar: só quem criou ou administrador');
  const pt = await rpc(resp1, 'salvar_ponto', { p_operacao: opC.id, p_id: null, p_dados: J({ tipo_id: tH.id, titulo: 'Hospital Norte', lat: -25.4, lng: -49.2 }) });
  chk(pt.categoria === 'OUTRO' && pt.tipo_id === tH.id && pt.icone === '🏥' && pt.cor === '#e11d48', 'ponto do tipo: categoria sem regra, com ícone e cor do tipo', pt);
  await rpc(resp1, 'salvar_tipo_ponto', { p_id: tH.id, p_dados: J({ icone: '⛑', cor: '#0ea5e9' }) });
  const pt2 = (await db.query(`select icone, cor from public.pontos_interesse where id = $1`, [pt.id])).rows[0];
  chk(pt2.icone === '⛑' && pt2.cor === '#0ea5e9', 'mudar o tipo atualiza os pontos das operações ativas');
  const rel047 = await rpc(resp1, 'relatorio_operacao', { p_operacao: opC.id });
  const prel = rel047.pontos.find((x) => x.titulo === 'Hospital Norte');
  chk(prel && prel.tipo_nome === 'Hospital de campanha' && prel.icone === '⛑' && prel.cor === '#0ea5e9' && rel047.operacao && 'ipo' in rel047.operacao, 'relatório traz o nome, o ícone e a cor do tipo (e mantém o IPO)', prel);
  const pt3 = await rpc(resp1, 'salvar_ponto', { p_operacao: opC.id, p_id: pt.id, p_dados: J({ categoria: 'RISCO', raio_m: 50 }) });
  chk(pt3.categoria === 'RISCO' && pt3.tipo_id === null && pt3.icone === null, 'voltar para uma categoria fixa tira o tipo');
  chk(/tipo_ponto_inexistente/.test(await erroDe(rpc(resp1, 'salvar_ponto', { p_operacao: opC.id, p_id: null, p_dados: J({ tipo_id: '00000000-0000-4000-8000-000000000000', titulo: 'X', lat: -25.4, lng: -49.2 }) }))), 'tipo desconhecido: recusado');
  await rpc(resp1, 'salvar_tipo_ponto', { p_id: tH.id, p_dados: J({ ativo: false }) });
  chk(/tipo_ponto_inexistente/.test(await erroDe(rpc(resp1, 'salvar_ponto', { p_operacao: opC.id, p_id: null, p_dados: J({ tipo_id: tH.id, titulo: 'Y', lat: -25.4, lng: -49.2 }) }))), 'tipo desativado não serve para ponto novo');
  await rpc(resp1, 'excluir_operacao', { p_operacao: opC.id });
}

console.log('Dashboard em outra janela e por link público; várias vítimas (migração 048)');
{
  const J = (o) => JSON.stringify(o);
  const opD = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP 048', p_retencao_horas: 0, p_dados: J({ tipo: 'terrestre', local_lat: -25.43, local_lng: -49.27, acionado_em: new Date(Date.now() - 3 * 3600e3).toISOString() }) });
  const uD = await usuario(null, true), uD2 = await usuario(null, true);
  const pD = await rpc(uD, 'ingressar', { p_token: opD.token_militar, p_nome: 'Sd Dados', p_tipo: 'militar', p_cpf: null, p_telefone: null });
  const pD2 = await rpc(uD2, 'ingressar', { p_token: opD.token_civil, p_nome: 'Carla Civil', p_tipo: 'civil', p_cpf: null, p_telefone: '41999990000' });
  const gD = await rpc(resp1, 'salvar_grupo', { p_operacao: opD.id, p_id: null, p_dados: J({ nome: 'Alfa', cor: '#22c55e' }) });
  await rpc(resp1, 'definir_membro', { p_grupo: gD.id, p_participante: pD.participante_id, p_papel: 'membro' });
  // 10 min de trilha, um ponto a cada 10 s (fica um a cada 30 s)
  const t0 = Date.now() - 20 * 60e3;
  await db.query(`update public.operacoes set criada_em = now() - interval '1 hour' where id = $1`, [opD.id]);
  const pts = Array.from({ length: 60 }, (_, i) => ({ id: '00000000-0000-4000-8048-' + String(i).padStart(12, '0'), lat: -25.43 + i * 0.0001, lng: -49.27, prec: 8, t: t0 + i * 10e3 }));
  const lt = await rpc(uD, 'enviar_posicoes_lote', { p_participante: pD.participante_id, p_gps: 'ok', p_pontos: J(pts) });
  await rpc(resp1, 'salvar_setor', { p_operacao: opD.id, p_id: null, p_dados: J({ nome: 'S1', forma: 'circulo', centro_lat: -25.43, centro_lng: -49.27, raio_m: 300 }) });
  // três vítimas: duas fichas (uma localizada) e uma localização sem ficha
  const f1 = await rpc(resp1, 'salvar_vitima', { p_operacao: opD.id, p_id: null, p_dados: J({ nome: 'Ana Vítima', idade: 70, perfil: ['idoso'] }) });
  const f2 = await rpc(resp1, 'salvar_vitima', { p_operacao: opD.id, p_id: null, p_dados: J({ nome: 'Bruno Vítima', idade: 9, perfil: ['crianca'] }) });
  await rpc(resp1, 'registrar_vitima_encontrada', { p_operacao: opD.id, p_dados: J({ condicao: 'viva', lat: -25.44, lng: -49.27, vitima_id: f2.id }) });
  await rpc(resp1, 'registrar_vitima_encontrada', { p_operacao: opD.id, p_dados: J({ condicao: 'obito', lat: -25.45, lng: -49.27 }) });
  const est = await rpc(resp1, 'estudo_operacao', { p_operacao: opD.id });
  chk(est.vitimas_total === 3 && est.vitimas_localizadas === 2 && est.fichas === 2, 'estudo: três vítimas (duas fichas e uma sem ficha), duas localizadas', { t: est.vitimas_total, l: est.vitimas_localizadas });
  const v1 = est.vitimas.find((x) => x.vitima_id === f1.id), v2 = est.vitimas.find((x) => x.vitima_id === f2.id), v3 = est.vitimas.find((x) => x.sem_ficha);
  chk(v1 && !v1.localizada && v1.rotulo === 'V-01' && v1.nome === null && v1.idade === 70 && v1.perfil[0] === 'idoso', 'ficha sem localização: V-01, não localizada, com idade e perfil (sem nome)', v1);
  chk(v2 && v2.localizada && v2.condicao === 'viva' && v2.distancia_km > 1 && v2.distancia_km < 1.2 && v2.minutos_ate >= 170, 'cada vítima com a própria condição, distância do ULV e tempo', v2);
  chk(v3 && v3.condicao === 'obito' && v3.rotulo === 'V-03' && v3.distancia_km > 2, 'localização sem ficha vira uma vítima própria', v3);
  chk(est.localizacao && est.localizacao.condicao === 'viva', 'compatibilidade: "localizacao" continua sendo a primeira');
  const dd = await rpc(resp1, 'dashboard_operacao_dados', { p_operacao: opD.id });
  const pdd = dd.participantes.find((x) => x.id === pD.participante_id);
  chk(dd.publico === false && pdd && pdd.nome === 'Sd Dados' && pdd.grupo && pdd.grupo.nome === 'Alfa', 'janela do dashboard: participantes com nome e grupo', pdd && { n: pdd.nome, g: pdd.grupo });
  chk(pdd.pontos.length >= 19 && pdd.pontos.length <= 21 && pdd.pontos[0].length === 4, 'trilha resumida: um ponto a cada 30 s', pdd.pontos.length);
  chk(dd.setores.length === 1 && dd.estudo.vitimas_total === 3 && dd.ocorrencias.VESTIGIO === 0, 'janela do dashboard: setores, estudo e ocorrências');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'dashboard_operacao_dados', { p_operacao: opD.id }))), 'responsável de outra operação não lê os dados do dashboard');
  chk(/permission denied/.test(await erroDe(como(uD, `select public.dashboard_dados($1, false)`, [opD.id]))), 'função interna não é chamável direto');
  // link público
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'dashboard_publico_gerar', { p_operacao: opD.id }))), 'só responsável da operação cria o link público');
  const lk = await rpc(resp1, 'dashboard_publico_gerar', { p_operacao: opD.id });
  chk(/^[0-9a-f]{48}$/.test(lk.token), 'link público: token de 48 caracteres');
  const pub = await rpc(null, 'dashboard_publico', { p_token: lk.token });
  chk(pub.publico === true && pub.operacao.codigo === 'OP 048' && pub.participantes.length === 3, 'sem login, o link mostra o dashboard (bombeiro, civil e o responsável que registrou a vítima)');
  chk(pub.participantes.every((x) => /^(Bombeiro|Civil|Responsável) \d+$/.test(x.nome)) && !JSON.stringify(pub).includes('Sd Dados') && !JSON.stringify(pub).includes('Carla'), 'link público: sem nomes de participantes', pub.participantes.map((x) => x.nome));
  chk(!JSON.stringify(pub).includes('Ana Vítima') && pub.estudo.vitimas.every((x) => x.nome === null), 'link público: sem nomes de vítimas');
  chk(!JSON.stringify(pub).includes('41999990000') && !('token_civil' in pub.operacao), 'link público: sem telefone nem tokens');
  const lk2 = await rpc(resp1, 'dashboard_publico_gerar', { p_operacao: opD.id });
  chk(/link_publico_invalido/.test(await erroDe(rpc(null, 'dashboard_publico', { p_token: lk.token }))) && (await rpc(null, 'dashboard_publico', { p_token: lk2.token })).publico, 'trocar o link invalida o anterior');
  chk(/link_publico_invalido/.test(await erroDe(rpc(null, 'dashboard_publico', { p_token: 'x' }))), 'token mal formado: recusado');
  await rpc(resp1, 'dashboard_publico_desligar', { p_operacao: opD.id });
  chk(/link_publico_invalido/.test(await erroDe(rpc(null, 'dashboard_publico', { p_token: lk2.token }))), 'desligar o link: deixa de funcionar');
  const dlog = (await db.query(`select titulo from public.diario where operacao_id = $1 and tipo = 'dashboard_publico' order by id`, [opD.id])).rows.map((r) => r.titulo);
  chk(dlog.length === 3 && /criado/.test(dlog[0]) && /trocado/.test(dlog[1]) && /desligado/.test(dlog[2]), 'criar, trocar e desligar o link entram no diário', dlog);
  chk(/permission denied/.test(await erroDe(como(null, `update public.operacoes set dashboard_token = repeat('a', 48) where id = $1`, [opD.id], 'anon'))), 'sem login não grava nada');
  // estudo geral: cada vítima localizada é um caso
  const eg = await rpc(resp1, 'estudo_geral', {});
  chk(eg.localizacoes.vitimas_localizadas >= eg.localizacoes.operacoes_com_localizacao + 1, 'estudo geral conta cada vítima localizada (não só a 1ª da operação)', eg.localizacoes);
  await rpc(resp1, 'excluir_operacao', { p_operacao: opD.id });
}

console.log('Relatório diário e da passagem de comando (migração 049)');
{
  const J = (o) => JSON.stringify(o);
  const opR = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP 049', p_retencao_horas: 0, p_dados: J({ tipo: 'terrestre', acionado_em: new Date(Date.now() - 50 * 3600e3).toISOString() }) });
  const ontem = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const r1 = await rpc(resp1, 'relatorio_diario_reservar', { p_operacao: opR.id, p_dia: ontem });
  chk(r1.ok === true, 'reserva o relatório diário de ontem');
  const caminho = opR.id + '/' + '11111111-2222-4333-8444-555555555555.pdf';
  await db.query(`insert into storage.objects (bucket_id, name) values ('relatorios', $1)`, [caminho]);
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'registrar_documento', { p_operacao: opR.id, p_caminho: caminho, p_paginas: 3, p_bytes: 1000, p_sha256: null, p_tipo: 'diario', p_referencia: 'ontem' }))), 'diário sem a data: recusado');
  const doc = await rpc(resp1, 'registrar_documento', { p_operacao: opR.id, p_caminho: caminho, p_paginas: 3, p_bytes: 1000, p_sha256: null, p_tipo: 'diario', p_referencia: ontem });
  chk(doc.tipo === 'diario' && doc.referencia === ontem, 'registra o relatório diário com o dia');
  const r2 = await rpc(resp1, 'relatorio_diario_reservar', { p_operacao: opR.id, p_dia: ontem });
  chk(r2.ok === false && r2.motivo === 'ja_existe', 'dia com relatório: não gera de novo', r2);
  const caminho2 = opR.id + '/' + '11111111-2222-4333-8444-555555555556.pdf';
  await db.query(`insert into storage.objects (bucket_id, name) values ('relatorios', $1)`, [caminho2]);
  const dup = await rpc(resp1, 'registrar_documento', { p_operacao: opR.id, p_caminho: caminho2, p_paginas: 3, p_bytes: 1000, p_sha256: null, p_tipo: 'diario', p_referencia: ontem });
  chk(dup.id === doc.id, 'diário repetido do mesmo dia: devolve o que já existe (um por dia)');
  const anteontem = new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10);
  await rpc(resp1, 'relatorio_diario_reservar', { p_operacao: opR.id, p_dia: anteontem });
  await db.query(`update public.relatorio_diario_reservas set reservado_por = $1 where operacao_id = $2`, [resp2, opR.id]);
  const r3 = await rpc(resp1, 'relatorio_diario_reservar', { p_operacao: opR.id, p_dia: anteontem });
  chk(r3.ok === false && r3.motivo === 'outro_gerando', 'outro responsável gerando agora: este espera', r3);
  await db.query(`update public.relatorio_diario_reservas set reservado_em = now() - interval '20 minutes' where operacao_id = $1`, [opR.id]);
  chk((await rpc(resp1, 'relatorio_diario_reservar', { p_operacao: opR.id, p_dia: anteontem })).ok === true, 'reserva antiga (mais de 15 min) expira');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'relatorio_diario_reservar', { p_operacao: opR.id, p_dia: anteontem }))), 'responsável de outra operação não reserva');
  chk(/permission denied/.test(await erroDe(como(resp1, `select * from public.relatorio_diario_reservas`))), 'tabela de reservas não é lida direto');
  // passagem de comando
  const caminho3 = opR.id + '/' + '11111111-2222-4333-8444-555555555557.pdf';
  await db.query(`insert into storage.objects (bucket_id, name) values ('relatorios', $1)`, [caminho3]);
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'registrar_documento', { p_operacao: opR.id, p_caminho: caminho3, p_paginas: 2, p_bytes: 900, p_sha256: null, p_tipo: 'passagem', p_referencia: '00000000-0000-4000-8000-000000000000' }))), 'passagem que não é da operação: recusada');
  const pas = (await db.query(`insert into public.passagens_comando (operacao_id, para_nome, resumo) values ($1, 'Ten Dois', '{}'::jsonb) returning id`, [opR.id])).rows[0];
  const dp = await rpc(resp1, 'registrar_documento', { p_operacao: opR.id, p_caminho: caminho3, p_paginas: 2, p_bytes: 900, p_sha256: null, p_tipo: 'passagem', p_referencia: pas.id });
  chk(dp.tipo === 'passagem' && dp.referencia === pas.id, 'registra o relatório da passagem de comando');
  const dl = (await db.query(`select titulo from public.diario where operacao_id = $1 and tipo like 'relatorio_%' order by id`, [opR.id])).rows.map((r) => r.titulo);
  chk(dl.some((t) => /Relatório diário de \d\d\/\d\d\/\d{4} gerado/.test(t)) && dl.some((t) => /passagem de comando/.test(t)), 'os relatórios entram no diário', dl);
  const antigo = (await db.query(`select tipo from public.relatorios where operacao_id <> $1 limit 1`, [opR.id])).rows;
  chk(antigo.every((x) => x.tipo === 'final'), 'relatórios antigos ficam como "final"');
  await rpc(resp1, 'excluir_operacao', { p_operacao: opR.id }).catch(() => null);
}

console.log('Ícones de grupos e das categorias fixas de ponto (migração 050)');
{
  const J = (o) => JSON.stringify(o);
  const opI = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP 050', p_retencao_horas: 0, p_dados: J({ tipo: 'terrestre' }) });
  const g = await rpc(resp1, 'salvar_grupo', { p_operacao: opI.id, p_id: null, p_dados: J({ nome: 'Canil', cor: '#7c3aed', icone: '🐕‍🦺' }) });
  chk(g.icone === '🐕‍🦺' && g.cor === '#7c3aed', 'grupo criado com ícone');
  const g2 = await rpc(resp1, 'salvar_grupo', { p_operacao: opI.id, p_id: g.id, p_dados: J({ nome: 'Canil 1' }) });
  chk(g2.icone === '🐕‍🦺' && g2.nome === 'Canil 1', 'editar sem mandar o ícone mantém o ícone');
  const g3 = await rpc(resp1, 'salvar_grupo', { p_operacao: opI.id, p_id: g.id, p_dados: J({ icone: '' }) });
  chk(g3.icone === null, 'ícone vazio tira o ícone');
  chk(/icone_invalido/.test(await erroDe(rpc(resp1, 'salvar_grupo', { p_operacao: opI.id, p_id: g.id, p_dados: J({ icone: 'ABCDEFGHIJ' }) }))), 'ícone com mais de 8 caracteres: recusado');
  const e1 = await rpc(resp2, 'salvar_estilo_categoria', { p_categoria: 'BASE', p_icone: '⛺', p_cor: '#0EA5E9' });
  chk(e1.icone === '⛺' && e1.cor === '#0ea5e9' && e1.atualizado_por_nome === 'Sgt Dois', 'qualquer responsável escolhe o ícone e a cor de uma categoria fixa');
  chk((await como(resp1, `select icone from public.categorias_ponto_estilo where categoria = 'BASE'`)).rows[0].icone === '⛺', 'outros responsáveis leem a aparência');
  chk((await como(anA, `select count(*)::int n from public.categorias_ponto_estilo`)).rows[0].n === 0, 'participante não lê');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'salvar_estilo_categoria', { p_categoria: 'XYZ', p_icone: 'X', p_cor: null }))), 'categoria inexistente: recusada');
  chk(/icone_invalido/.test(await erroDe(rpc(resp1, 'salvar_estilo_categoria', { p_categoria: 'BASE', p_icone: 'X', p_cor: 'azul' }))), 'cor inválida: recusada');
  chk(/sem_permissao/.test(await erroDe(rpc(anA, 'salvar_estilo_categoria', { p_categoria: 'BASE', p_icone: 'X', p_cor: null }))), 'participante não muda');
  await rpc(resp1, 'salvar_estilo_categoria', { p_categoria: 'BASE', p_icone: null, p_cor: null });
  chk((await db.query(`select count(*)::int n from public.categorias_ponto_estilo where categoria = 'BASE'`)).rows[0].n === 0, 'sem ícone e sem cor: volta ao padrão');
  await rpc(resp1, 'excluir_operacao', { p_operacao: opI.id }).catch(() => null);
}

console.log('Aplicativo Android: passagem do navegador para o app e aparelho com segredo (migração 051)');
{
  const J = (o) => JSON.stringify(o);
  const opA = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP 051', p_retencao_horas: 0, p_dados: J({ tipo: 'terrestre' }) });
  const nav = await usuario(null, true), app = await usuario(null, true), app2 = await usuario(null, true), outro = await usuario(null, true);
  const p = await rpc(nav, 'ingressar', { p_token: opA.token_civil, p_nome: 'Duda', p_tipo: 'civil', p_cpf: '52998224725', p_telefone: '21998765432' });
  const q = await rpc(outro, 'ingressar', { p_token: opA.token_civil, p_nome: 'Edu', p_tipo: 'civil', p_cpf: null, p_telefone: '21998765433' });
  const pid = p.participante_id;
  await rpc(nav, 'enviar_posicoes_lote', { p_participante: pid, p_gps: 'ok', p_pontos: J([pt(5101, -22.9, -43.2)]) });

  chk(/participante_invalido/.test(await erroDe(rpc(outro, 'app_vinculo_criar', { p_participante: pid }))), 'código: só o dono da participação pede');
  const v1 = await rpc(nav, 'app_vinculo_criar', { p_participante: pid });
  chk(/^[0-9a-f]{32}$/.test(v1.codigo) && new Date(v1.expira_em) > new Date(), 'código de 32 caracteres com validade', v1);
  const guardado = (await db.query(`select codigo_hash from public.app_vinculos where participante_id = $1`, [pid])).rows;
  chk(guardado.length === 1 && guardado[0].codigo_hash !== v1.codigo && guardado[0].codigo_hash.length === 64, 'o banco guarda só o resumo do código');
  chk(/permission denied/.test(await erroDe(como(nav, `select * from public.app_vinculos`))), 'ninguém lê a tabela de códigos direto');
  chk(/vinculo_app_recusado/.test(await erroDe(rpc(app, 'app_vinculo_resgatar', { p_codigo: 'f'.repeat(32) }))), 'código inexistente: recusado');
  chk(/vinculo_app_recusado/.test(await erroDe(rpc(app, 'app_vinculo_resgatar', { p_codigo: 'x' }))), 'código malformado: recusado');
  chk(/sessao_app_ocupada/.test(await erroDe(rpc(outro, 'app_vinculo_resgatar', { p_codigo: v1.codigo }))), 'sessão que já participa da operação não resgata (sem misturar dois participantes)');

  const r = await rpc(app, 'app_vinculo_resgatar', { p_codigo: v1.codigo.toUpperCase() });
  chk(r.participante_id === pid && r.nome === 'Duda' && r.telefone === '21998765432' && r.operacao === 'OP 051', 'app resgata: mesma participação, com nome e celular', r);
  chk((await db.query(`select user_id from public.participantes where id = $1`, [pid])).rows[0].user_id === app, 'a participação passa para a sessão do aplicativo');
  chk(/vinculo_app_recusado/.test(await erroDe(rpc(app2, 'app_vinculo_resgatar', { p_codigo: v1.codigo }))), 'código já usado: recusado (uso único)');
  const svNav = await rpc(nav, 'sinal_vida', { p_participante: pid, p_rastreando: true, p_gps: 'ok' });
  chk(svNav.status === 'inexistente', 'o navegador perde o acesso (sinal_vida responde inexistente)', svNav);
  chk(/participante_invalido/.test(await erroDe(rpc(nav, 'enviar_posicoes_lote', { p_participante: pid, p_gps: 'ok', p_pontos: J([pt(5102, -22.9, -43.2)]) }))), 'o navegador não envia mais pontos');
  const re = await rpc(app, 'ingressar', { p_token: opA.token_civil, p_nome: 'Duda', p_tipo: 'civil', p_cpf: null, p_telefone: '21998765432' });
  chk(re.participante_id === pid, 'no app, ingressar volta para a mesma participação (sem cadastro novo)');
  chk((await db.query(`select count(*)::int n from public.posicoes where participante_id = $1`, [pid])).rows[0].n === 1, 'a trilha já enviada continua da mesma participação');

  chk(/participante_invalido/.test(await erroDe(rpc(nav, 'app_dispositivo_registrar', { p_participante: pid, p_modelo: 'X' }))), 'aparelho: só o dono registra');
  const d1 = await rpc(app, 'app_dispositivo_registrar', { p_participante: pid, p_modelo: 'Moto G' });
  chk(d1.dispositivo_id && /^[0-9a-f]{64}$/.test(d1.segredo), 'aparelho registrado com segredo de 64 caracteres');
  chk((await db.query(`select segredo_hash from public.app_dispositivos where id = $1`, [d1.dispositivo_id])).rows[0].segredo_hash !== d1.segredo, 'o banco guarda só o resumo do segredo');
  const envia = (d, s, ids, role) => como(null, `select public.app_enviar_posicoes($1, $2, $3::jsonb, 'ok') r`, [d, s, J(ids.map((i) => pt(i, -22.9 + i * 1e-6, -43.2)))], role || 'anon').then((x) => x.rows[0].r);
  const e1 = await envia(d1.dispositivo_id, d1.segredo, [5110, 5111]);
  chk(e1.confirmados.length === 2 && e1.inseridos === 2 && e1.status === 'ativa', 'serviço do app envia sem sessão (só a chave pública) e recebe a confirmação por ponto', e1);
  const e2 = await envia(d1.dispositivo_id, d1.segredo, [5111]);
  chk(e2.confirmados.length === 1 && e2.inseridos === 0, 'reenvio pelo app não duplica');
  chk((await db.query(`select ultimo_contato_em is not null and rastreando as ok from public.participantes where id = $1`, [pid])).rows[0].ok, 'envio pelo app atualiza o último contato do participante');
  chk(/aparelho_app_invalido/.test(await erroDe(envia(d1.dispositivo_id, 'a'.repeat(64), [5112]))), 'segredo errado: recusado');
  chk(/aparelho_app_invalido/.test(await erroDe(envia(d1.dispositivo_id, 'curto', [5112]))), 'segredo malformado: recusado');
  const sv = (await como(null, `select public.app_sinal_vida($1, $2, 'fraco') r`, [d1.dispositivo_id, d1.segredo], 'anon')).rows[0].r;
  chk(sv.status === 'ativa' && sv.gps_intervalo_s === 15, 'sinal de vida pelo app', sv);
  chk((await db.query(`select gps_estado from public.participantes where id = $1`, [pid])).rows[0].gps_estado === 'fraco', 'sinal pelo app grava o estado do GPS');
  chk(/permission denied/.test(await erroDe(como(null, `select public.app_dono_do_dispositivo($1, $2)`, [d1.dispositivo_id, d1.segredo], 'anon'))), 'função interna não é chamável de fora');
  chk((await como(null, `select auth.uid() u`, [], 'anon')).rows[0].u === null, 'a identidade usada pelo serviço não sobra para a próxima chamada');

  const d2 = await rpc(app, 'app_dispositivo_registrar', { p_participante: pid, p_modelo: 'Moto G (reinstalado)' });
  chk(/aparelho_app_invalido/.test(await erroDe(envia(d1.dispositivo_id, d1.segredo, [5113]))), 'registrar de novo revoga o aparelho anterior');
  chk((await envia(d2.dispositivo_id, d2.segredo, [5113])).inseridos === 1, 'o aparelho novo envia');

  const v2 = await rpc(app, 'app_vinculo_criar', { p_participante: pid });
  await rpc(app2, 'app_vinculo_resgatar', { p_codigo: v2.codigo });
  chk(/aparelho_app_invalido/.test(await erroDe(envia(d2.dispositivo_id, d2.segredo, [5114]))), 'passar a participação para outro aparelho revoga o segredo do anterior');
  const d3 = await rpc(app2, 'app_dispositivo_registrar', { p_participante: pid, p_modelo: 'Outro' });

  const v3 = await rpc(app2, 'app_vinculo_criar', { p_participante: pid });
  await db.query(`update public.app_vinculos set expira_em = now() - interval '1 minute' where codigo_hash = public.app_resumo($1)`, [v3.codigo]);
  chk(/vinculo_app_recusado/.test(await erroDe(rpc(app, 'app_vinculo_resgatar', { p_codigo: v3.codigo }))), 'código vencido (30 min): recusado');

  await rpc(resp1, 'liberar_participante', { p_participante: pid }).catch(async () => {
    await db.query(`update public.participantes set liberado_em = now() where id = $1`, [pid]);
  });
  chk(/participante_liberado/.test(await erroDe(envia(d3.dispositivo_id, d3.segredo, [5115]))), 'participante liberado: o app recebe o código e para');
  chk(/participante_liberado/.test(await erroDe(rpc(app2, 'app_vinculo_criar', { p_participante: pid }))), 'participante liberado não gera código');
  const svQ = await rpc(outro, 'sinal_vida', { p_participante: q.participante_id, p_rastreando: true, p_gps: 'ok' });
  chk(svQ.status === 'ativa', 'os outros participantes não são afetados');
  await rpc(resp1, 'excluir_operacao', { p_operacao: opA.id }).catch(() => null);
}

console.log('Relatório do comando (migração 052)');
{
  const J = (o) => JSON.stringify(o);
  const opC = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP 052', p_retencao_horas: 0, p_dados: J({ tipo: 'terrestre' }) });
  await db.query(`insert into public.responsaveis (user_id, nome) values ($1, 'Sgt Três') on conflict do nothing`, [resp3]);
  await db.query(`insert into public.operacao_responsaveis (operacao_id, user_id) values ($1, $2), ($1, $3)`, [opC.id, resp2, resp3]);
  const pc1 = await rpc(resp1, 'passagem_iniciar', { p_operacao: opC.id, p_para: resp2, p_nota: '' });
  await rpc(resp2, 'passagem_responder', { p_passagem: pc1.id, p_aceitar: true, p_nota: '' });
  const pc2 = await rpc(resp2, 'passagem_iniciar', { p_operacao: opC.id, p_para: resp3, p_nota: '' });
  await rpc(resp3, 'passagem_responder', { p_passagem: pc2.id, p_aceitar: true, p_nota: '' });
  const pc3 = await rpc(resp3, 'passagem_iniciar', { p_operacao: opC.id, p_para: resp1, p_nota: '' });
  const u52 = (n) => '5a5a5a5a-0000-4000-8000-' + String(n).padStart(12, '0');
  const caminho = (n) => opC.id + '/' + u52(n) + '.pdf';
  for (const n of [1, 2, 3, 4, 5, 6]) await como(resp1, `insert into storage.objects (bucket_id, name) values ('relatorios', $1)`, [caminho(n)]);
  const cmd0 = await rpc(resp1, 'registrar_documento', { p_operacao: opC.id, p_caminho: caminho(1), p_paginas: 4, p_bytes: 900, p_sha256: null, p_tipo: 'comando', p_referencia: 'inicio' });
  chk(cmd0.tipo === 'comando' && cmd0.referencia === 'inicio', 'comando desde o início da operação: registrado');
  const repete = await rpc(resp1, 'registrar_documento', { p_operacao: opC.id, p_caminho: caminho(2), p_paginas: 4, p_bytes: 900, p_sha256: null, p_tipo: 'comando', p_referencia: 'inicio' });
  chk(repete.id === cmd0.id, 'o mesmo comando repetido devolve o que já foi guardado (não duplica)');
  const cmd1 = await rpc(resp2, 'registrar_documento', { p_operacao: opC.id, p_caminho: caminho(3), p_paginas: 5, p_bytes: 900, p_sha256: null, p_tipo: 'comando', p_referencia: pc1.id });
  chk(cmd1.tipo === 'comando' && cmd1.referencia === pc1.id, 'comando iniciado por uma passagem aceita: registrado');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'registrar_documento', { p_operacao: opC.id, p_caminho: caminho(4), p_paginas: 1, p_bytes: 1, p_sha256: null, p_tipo: 'comando', p_referencia: pc3.id }))), 'passagem ainda pendente não inicia um comando');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'registrar_documento', { p_operacao: opC.id, p_caminho: caminho(5), p_paginas: 1, p_bytes: 1, p_sha256: null, p_tipo: 'comando', p_referencia: 'ontem' }))), 'referência de comando inválida: recusada');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'registrar_documento', { p_operacao: opC.id, p_caminho: caminho(6), p_paginas: 1, p_bytes: 1, p_sha256: null, p_tipo: 'comando', p_referencia: u52(99) }))), 'passagem de outra ou inexistente: recusada');
  chk(/permission denied|row-level|relatorios_tipo_ok|check/.test(await erroDe(como(resp1, `insert into public.relatorios (operacao_id, caminho, paginas, bytes, sha256, gerado_por, gerado_por_nome, tipo, referencia) values ($1, $2, 1, 1, null, $3, 'Sgt Um', 'comando', 'x')`, [opC.id, caminho(7), resp1]))), 'o banco também recusa comando com referência inválida');
  const lista = (await como(resp1, `select tipo, referencia from public.relatorios where operacao_id = $1 and tipo = 'comando' order by referencia`, [opC.id])).rows;
  chk(lista.length === 2, 'dois comandos guardados para a operação', lista);
  chk((await como(resp2, `select count(*)::int n from public.relatorios where operacao_id = $1`, [opC.id])).rows[0].n === 2, 'responsável da operação lê os relatórios de comando');
  chk((await como(await usuario('r6@cbm', false), `select count(*)::int n from public.relatorios where operacao_id = $1`, [opC.id])).rows[0].n === 0, 'responsável de fora da operação não lê');
  await rpc(resp1, 'excluir_operacao', { p_operacao: opC.id }).catch(() => null);
}

console.log('Convite de responsável com acesso (migração 053)');
{
  const J = (o) => JSON.stringify(o);
  const op53 = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP 053', p_retencao_horas: 0, p_dados: J({ tipo: 'terrestre' }) });
  const d = await rpc(resp1, 'responsavel_convite_checar', { p_operacao: op53.id });
  chk(d.codigo === 'OP 053' && d.quem === resp1 && d.convidado_por === 'Sgt Um', 'checar: quem convida (responsável da operação) recebe o código e o próprio nome');
  chk(/sem_permissao/.test(await erroDe(rpc(resp2, 'responsavel_convite_checar', { p_operacao: op53.id }))), 'checar: responsável de fora da operação é recusado');
  const sit = (await como(null, 'select public.servidor_situacao_email($1) d', ['r1@cbm'], 'service_role')).rows[0].d;
  chk(sit && sit.responsavel === true && sit.ativo === true, 'situação do e-mail: responsável ativo (só o servidor consulta)', sit);
  const nenhum = (await como(null, 'select public.servidor_situacao_email($1) d', ['ninguem@cbm'], 'service_role')).rows[0].d;
  chk(nenhum === null, 'situação do e-mail: sem login devolve vazio', nenhum);
  chk(/permission denied/.test(await erroDe(como(resp1, 'select public.servidor_situacao_email($1)', ['r1@cbm']))), 'responsável comum não consulta a situação de e-mails');
  chk(/permission denied/.test(await erroDe(como(resp1, 'select public.servidor_vincular_responsavel($1, $2, $3)', [op53.id, resp3, resp1]))), 'responsável comum não inclui ninguém pela função do servidor');
  const v1 = (await como(null, 'select public.servidor_vincular_responsavel($1, $2, $3) v', [op53.id, resp3, resp1], 'service_role')).rows[0].v;
  chk(v1 === true, 'servidor inclui um responsável ativo na operação', v1);
  const v2 = (await como(null, 'select public.servidor_vincular_responsavel($1, $2, $3) v', [op53.id, resp3, resp1], 'service_role')).rows[0].v;
  chk(v2 === false, 'incluir de novo quem já está na operação não duplica (devolve false)', v2);
  chk(/responsavel_nao_encontrado/.test(await erroDe(como(null, 'select public.servidor_vincular_responsavel($1, $2, $3)', [op53.id, anA, resp1], 'service_role'))), 'não inclui quem não é responsável (login de participante)');
  const quem = (await como(resp3, 'select count(*)::int n from public.operacao_responsaveis where operacao_id = $1 and user_id = $2', [op53.id, resp3])).rows[0].n;
  chk(quem === 1, 'o responsável incluído passa a constar na equipe da operação');
  const diarioInc = (await como(resp1, `select count(*)::int n from public.diario where operacao_id = $1 and tipo = 'responsavel_adicionado'`, [op53.id])).rows[0].n;
  chk(diarioInc >= 1, 'a inclusão fica registrada no diário');
  await como(null, 'select public.servidor_desvincular_responsavel($1, $2)', [op53.id, resp3], 'service_role');
  const depois = (await como(resp1, 'select count(*)::int n from public.operacao_responsaveis where operacao_id = $1 and user_id = $2', [op53.id, resp3])).rows[0].n;
  chk(depois === 0, 'desfazer a inclusão (e-mail que não saiu) tira a pessoa da operação');
  const op53b = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP 053B', p_retencao_horas: 0, p_dados: J({ tipo: 'terrestre' }) });
  await rpc(resp1, 'encerrar_operacao', { p_operacao: op53b.id });
  chk(/operacao_encerrada/.test(await erroDe(rpc(resp1, 'responsavel_convite_checar', { p_operacao: op53b.id }))), 'operação encerrada: não se convida mais ninguém');
}

console.log('Relatório para imprensa (migração 054)');
{
  const J = (o) => JSON.stringify(o);
  const op54 = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP 054', p_retencao_horas: 0, p_dados: J({ tipo: 'terrestre' }) });
  const u54 = (n) => '54545454-0000-4000-8000-' + String(n).padStart(12, '0');
  const cam54 = (n) => op54.id + '/' + u54(n) + '.pdf';
  for (const n of [1, 2, 3]) await como(resp1, `insert into storage.objects (bucket_id, name) values ('relatorios', $1)`, [cam54(n)]);
  const im1 = await rpc(resp1, 'registrar_documento', { p_operacao: op54.id, p_caminho: cam54(1), p_paginas: 2, p_bytes: 500, p_sha256: null, p_tipo: 'imprensa', p_referencia: null });
  chk(im1.tipo === 'imprensa' && im1.referencia === null, 'relatório para imprensa: registrado sem referência');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'registrar_documento', { p_operacao: op54.id, p_caminho: cam54(2), p_paginas: 1, p_bytes: 1, p_sha256: null, p_tipo: 'imprensa', p_referencia: 'hoje' }))), 'relatório para imprensa com referência: recusado');
  const im2 = await rpc(resp1, 'registrar_documento', { p_operacao: op54.id, p_caminho: cam54(2), p_paginas: 2, p_bytes: 500, p_sha256: null, p_tipo: 'imprensa', p_referencia: null });
  chk(im2.id !== im1.id, 'cada geração para imprensa é um documento próprio (não reaproveita o anterior)');
  chk(/dados_invalidos/.test(await erroDe(rpc(resp1, 'registrar_documento', { p_operacao: op54.id, p_caminho: cam54(3), p_paginas: 1, p_bytes: 1, p_sha256: null, p_tipo: 'outro', p_referencia: null }))), 'tipo desconhecido continua recusado');
  const lista = (await como(resp1, `select count(*)::int n from public.relatorios where operacao_id = $1 and tipo = 'imprensa'`, [op54.id])).rows[0].n;
  chk(lista === 2, 'os dois relatórios para imprensa ficam guardados', lista);
  const diarioImp = (await como(resp1, `select count(*)::int n from public.diario where operacao_id = $1 and titulo = 'Relatório para imprensa gerado'`, [op54.id])).rows[0].n;
  chk(diarioImp === 2, 'cada geração entra no diário com o título próprio', diarioImp);
  await rpc(resp1, 'excluir_operacao', { p_operacao: op54.id }).catch(() => null);
}

console.log('\nMigrações 007–054 (PostgreSQL real): ' + ok + ' OK, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
