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
for (const m of ['007_cadastro_operacao_vitimas', '008_grupos', '009_trilha_offline', '010_missoes_alertas', '011_vitima_localizada', '012_diario_relatorio', '013_permanencia_setor', '014_fotos_localizacao', '015_grupos_no_mapa_civil', '016_admin_todas_operacoes', '017_excluir_responsavel', '018_pedido_acesso_responsavel', '019_ipo_operacao', '020_admin_excluir_sem_restricao', '021_ipo_no_cadastro', '022_cadastro_inicial', '023_estudos_perfil_distancia', '024_admin_excluir_relatorio', '025_responsavel_registra_vitima', '026_operacao_encerrada_somente_leitura', '027_dados_so_saem_ao_excluir', '028_trilhas_manuais', '029_nomes_painel_cpf_opcional', '030_percursos_trajetos', '031_vitima_encontrada_detalhes', '032_controle_tempo_missoes', '033_cenario_busca_pod_poa']) {
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
chk(/operacao_com_registros/.test(await erroDe(rpc(resp2, 'excluir_operacao', { p_operacao: opComAtividade.id }))), 'criador que não é administrador NÃO exclui operação com relatório');
chk((await db.query(`select count(*)::int n from public.operacoes where id = $1`, [opComAtividade.id])).rows[0].n === 1, 'operação recusada continua no banco');

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

console.log('\nMigrações 007–033 (PostgreSQL real): ' + ok + ' OK, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
