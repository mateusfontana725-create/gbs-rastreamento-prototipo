// Teste do banco (schema.sql e migrações 007–014) num PostgreSQL REAL rodando no Node (PGlite),
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
for (const m of ['007_cadastro_operacao_vitimas', '008_grupos', '009_trilha_offline', '010_missoes_alertas', '011_vitima_localizada', '012_diario_relatorio', '013_permanencia_setor', '014_fotos_localizacao', '015_grupos_no_mapa_civil', '016_admin_todas_operacoes']) {
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
const antiga = await rpc(resp1, 'criar_operacao', { p_codigo: 'OP ANTIGA', p_retencao_horas: 0 });
chk(antiga.tipo === null && antiga.descricao === '', 'chamada antiga (só nome) continua funcionando e a operação fica válida');
chk(/tipo_operacao_invalido/.test(await erroDe(rpc(resp1, 'criar_operacao', { p_codigo: 'X Y', p_retencao_horas: 0, p_dados: '{}' }))), 'painel novo sem tipo: recusado');
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
const pdfCam = op.id + '/44444444-4444-4444-8444-444444444444.pdf';
chk(/arquivo_nao_enviado/.test(await erroDe(rpc(resp1, 'registrar_relatorio', { p_operacao: op.id, p_caminho: pdfCam, p_paginas: 12, p_bytes: 1000, p_sha256: 'a'.repeat(64) }))), 'registrar relatório sem o PDF no Storage: recusado');
chk(/row-level security/.test(await erroDe(como(anA, `insert into storage.objects (bucket_id, name) values ('relatorios', $1)`, [pdfCam]))), 'participante não envia PDF ao bucket relatorios');
await como(resp1, `insert into storage.objects (bucket_id, name) values ('relatorios', $1)`, [pdfCam]);
const rr = await rpc(resp1, 'registrar_relatorio', { p_operacao: op.id, p_caminho: pdfCam, p_paginas: 12, p_bytes: 1000, p_sha256: 'a'.repeat(64) });
chk(rr.gerado_por_nome === 'Sgt Um' && (await tipos()).includes('relatorio_gerado'), 'relatório registrado e lançado no diário');
chk((await como(anA, `select count(*)::int n from storage.objects where bucket_id = 'relatorios'`)).rows[0].n === 0, 'participante não vê o PDF');
chk(/permission denied|row-level/.test(await erroDe(como(resp1, `delete from storage.objects where bucket_id = 'relatorios'`).then((r) => { if (!r.affectedRows) throw new Error('row-level: nada apagado'); }))), 'PDF do relatório não pode ser apagado pelo app');
chk(/relatorio_nao_apaga/.test(await erroDe(db.query(`delete from public.relatorios where id = $1`, [rr.id]))), 'registro do relatório não pode ser apagado');
chk(/operacao_com_registros/.test(await erroDe(rpc(resp1, 'excluir_operacao', { p_operacao: op.id }))), 'operação com atividade não pode ser excluída');

console.log('Retenção e exclusão');
await rpc(resp1, 'encerrar_operacao', { p_operacao: op.id });
await rpc(resp1, 'apagar_dados_operacao', { p_operacao: op.id });
const cont = (await db.query(`select (select count(*) from public.vitimas where operacao_id=$1)::int v, (select count(*) from public.grupos where operacao_id=$1)::int g,
  (select count(*) from public.missoes where operacao_id=$1)::int m, (select count(*) from public.alertas where operacao_id=$1)::int a,
  (select count(*) from public.arquivos_pendentes where bucket='vitimas')::int f, (select codigo from public.operacoes where id=$1) c, (select tipo from public.operacoes where id=$1) t`, [op.id])).rows[0];
chk(cont.v === 0 && cont.g === 0 && cont.m === 0 && cont.a === 0, 'dados apagados: fichas, grupos, deslocamentos e alertas apagados', cont);
chk((await db.query(`select count(*)::int n from public.vitima_localizacoes where operacao_id = $1`, [op.id])).rows[0].n === 0, 'dados apagados: registros de vítima localizada apagados');
const diarioDepois = (await db.query(`select count(*)::int n, bool_or(tipo = 'dados_apagados') apagados, bool_or(tipo = 'observacao') obs from public.diario where operacao_id = $1`, [op.id])).rows[0];
chk(diarioDepois.n > 10 && diarioDepois.apagados && diarioDepois.obs, 'dados apagados: o diário continua (com o registro da retenção)', diarioDepois);
chk((await db.query(`select count(*)::int n from public.relatorios where operacao_id = $1`, [op.id])).rows[0].n === 1, 'dados apagados: o relatório continua');
const relDepois = await rpc(resp1, 'relatorio_operacao', { p_operacao: op.id });
chk(relDepois.participantes.length === 0 && relDepois.diario.length > 10 && relDepois.operacao.resultado === 'localizada_obito', 'depois da retenção o relatório ainda sai com cadastro, resultado e diário');
chk(cont.f === 1,'a foto da vítima entrou na fila de remoção do Storage (bucket vitimas)');
chk(cont.c === 'OP TESTE' && cont.t === 'outras', 'o cadastro da operação continua (como o nome já continuava)');
const pend = await rpc(resp1, 'meus_arquivos_pendentes_v2', {});
chk(pend.length === 1 && pend[0].bucket === 'vitimas', 'meus_arquivos_pendentes_v2 informa o bucket', pend);
const v2 = await rpc(resp1, 'salvar_vitima', { p_operacao: antiga.id, p_id: null, p_dados: JSON.stringify({ nome: 'Não identificada' }) });
const exc = await rpc(resp1, 'excluir_operacao', { p_operacao: antiga.id });
chk(exc.vitimas === 1 && v2.nome === 'Não identificada', 'excluir operação informa as fichas apagadas', exc);

console.log('\nMigrações 007–016 (PostgreSQL real): ' + ok + ' OK, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
