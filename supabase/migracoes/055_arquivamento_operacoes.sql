-- =====================================================================
-- 055 — Arquivamento de operações encerradas (economia de espaço no banco).
--
--  O que muda
--   - Operação encerrada pode ser ARQUIVADA: todas as linhas dela (participantes, posições, trilhas, mensagens,
--     fotos, setores, pontos, grupos, diário, SCI, buscas...) vão para um arquivo JSON compactado (gzip) no Storage,
--     bucket privado "arquivos" (<operacao_id>/<uuid>.json.gz), e saem do banco.
--   - Ficam no banco: a operação (com arquivada_em), a equipe de responsáveis, os relatórios, as vítimas e as
--     localizações de vítima (pequenas e usadas nas estatísticas gerais) e a linha nova em operacao_arquivos
--     (caminho, SHA-256, contagens, resumo da lista e os números prontos dos dashboards).
--   - Fotos, imagens do SCI, fichas de vítima e relatórios continuam no Storage, nas mesmas pastas.
--
--  Como é feito (api/arquivar.js, com a chave secreta)
--   1. servidor_arquivo_preparar: confere a operação, conta as linhas de cada tabela e lê o relatório, o SCI e o
--      briefing pelas mesmas funções do painel (como um responsável ativo da operação).
--   2. servidor_arquivo_tabela: exporta cada tabela em páginas.
--   3. O servidor monta o JSON, compacta, envia ao Storage, BAIXA DE VOLTA e confere SHA-256 e contagens.
--   4. servidor_arquivo_confirmar: numa transação só, reconta cada tabela (tem de bater com o arquivo), guarda os
--      números dos dashboards, apaga as linhas e confere que nada sobrou e que nenhum arquivo do Storage foi para a
--      fila de exclusão. Qualquer divergência desfaz tudo (nada é apagado).
--
--  As tabelas vêm do catálogo (toda tabela com operacao_id, e as ligadas só ao participante): uma tabela nova entra
--  no arquivo sozinha. Durante o arquivamento a marca gbs.arquivando_operacao deixa os gatilhos passarem (travas de
--  operação encerrada, diário e fila de arquivos), como gbs.excluindo_operacao faz na exclusão.
-- =====================================================================

-- 1. Marca na operação e registro do arquivo ---------------------------------------------------------------------
alter table public.operacoes add column if not exists arquivada_em timestamptz;

create table if not exists public.operacao_arquivos (
  operacao_id   uuid primary key references public.operacoes(id) on delete cascade,
  caminho       text not null,
  bytes         bigint not null check (bytes > 0),
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  versao        integer not null default 1,
  contagens     jsonb not null,
  resumo        jsonb not null default '{}'::jsonb,
  instantaneos  jsonb not null default '{}'::jsonb,
  arquivada_em  timestamptz not null default now()
);
alter table public.operacao_arquivos enable row level security;
drop policy if exists operacao_arquivos_ler on public.operacao_arquivos;
create policy operacao_arquivos_ler on public.operacao_arquivos for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.operacao_arquivos from anon;
revoke insert, update, delete, truncate on public.operacao_arquivos from authenticated;
grant select on public.operacao_arquivos to authenticated;

-- Localizações de vítima ficam no banco (estatísticas gerais); o vínculo com participante e mensagem pode ficar vazio
-- depois do arquivamento (o registro completo está no arquivo).
alter table public.vitima_localizacoes alter column participante_id drop not null;
alter table public.vitima_localizacoes alter column mensagem_id drop not null;

create or replace function public.operacao_arquivada(p_operacao uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.operacoes where id = p_operacao and arquivada_em is not null);
$$;

-- 2. Bucket privado do arquivo: só os responsáveis da operação leem; só o servidor grava -------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('arquivos', 'arquivos', false, 52428800, array['application/gzip'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.pode_ler_arquivo_operacao(p_nome text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  if coalesce(p_nome, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.gz$' then
    return false;
  end if;
  return public.dono_operacao(split_part(p_nome, '/', 1)::uuid);
end;
$$;
drop policy if exists gbs_arquivos_ler on storage.objects;
create policy gbs_arquivos_ler on storage.objects
  for select to authenticated
  using (bucket_id = 'arquivos' and public.pode_ler_arquivo_operacao(name));

-- 3. Tabelas do arquivo, descobertas pelo catálogo ---------------------------------------------------------------
--  coluna: operacao_id, ou a coluna que liga ao participante (tabelas sem operacao_id).
--  apagar: false para as que também ficam no banco (vítimas e localizações de vítima).
--  ordem: chave primária (exportação em páginas estáveis).
create or replace function public.arquivo_tabelas()
returns table (tabela text, coluna text, apagar boolean, ordem text)
language sql stable security definer set search_path = public, pg_catalog
as $$
  with tabs as (
    select c.oid, c.relname::text as tabela, 'operacao_id'::text as coluna
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'operacao_id' and not a.attisdropped)
       and c.relname not in ('operacao_responsaveis', 'relatorios', 'arquivos_pendentes', 'operacao_arquivos')
    union all
    select c.oid, c.relname::text, a.attname::text
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
     where n.nspname = 'public' and k.contype = 'f' and k.confrelid = 'public.participantes'::regclass
       and array_length(k.conkey, 1) = 1
       and not exists (select 1 from pg_attribute x where x.attrelid = c.oid and x.attname = 'operacao_id' and not x.attisdropped)
  )
  select t.tabela, t.coluna, t.tabela not in ('vitimas', 'vitima_localizacoes'),
         coalesce((select string_agg(quote_ident(a.attname), ', ' order by k.ord)
                     from pg_index i
                     cross join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
                     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                    where i.indrelid = t.oid and i.indisprimary), 'ctid')
    from tabs t
   order by 1;
$$;

-- Filtro das linhas da operação numa tabela do arquivo ($1 = id da operação)
create or replace function public.arquivo_filtro(p_coluna text)
returns text
language sql immutable
as $$
  select case when p_coluna = 'operacao_id' then 'operacao_id = $1'
              else format('%I in (select id from public.participantes where operacao_id = $1)', p_coluna) end;
$$;

-- 4. Quem pode pedir o arquivamento pelo painel: quem criou a operação, ou administrador da equipe dela ---------
create or replace function public.arquivo_pode_arquivar(p_operacao uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
begin
  if not (public.eh_criador(p_operacao) or (public.eh_admin() and public.dono_operacao(p_operacao))) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if v_op.status <> 'encerrada' then
    raise exception 'operacao_ativa';
  end if;
  if v_op.arquivada_em is not null then
    raise exception 'operacao_ja_arquivada';
  end if;
  return json_build_object('ok', true, 'codigo', v_op.codigo);
end;
$$;

-- 5. Funções do servidor (chave secreta) -------------------------------------------------------------------------
-- Operações encerradas há pelo menos p_dias, ainda não arquivadas (as mais antigas primeiro)
create or replace function public.servidor_arquivo_candidatas(p_dias integer, p_limite integer)
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select id from public.operacoes
   where status = 'encerrada' and arquivada_em is null and encerrada_em is not null
     and encerrada_em <= now() - make_interval(days => greatest(coalesce(p_dias, 7), 0))
   order by encerrada_em
   limit greatest(coalesce(p_limite, 5), 1);
$$;

-- Prepara: confere, conta as linhas de cada tabela e lê relatório, SCI e briefing (como um responsável ativo)
create or replace function public.servidor_arquivo_preparar(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
  v_resp uuid;
  v_rel json;
  v_sci json;
  v_brief json;
  v_lista jsonb := '[]'::jsonb;
  v_n bigint;
  t record;
begin
  select * into v_op from public.operacoes where id = p_operacao;
  if not found then
    raise exception 'operacao_nao_encontrada';
  end if;
  if v_op.status <> 'encerrada' then
    raise exception 'operacao_ativa';
  end if;
  if v_op.arquivada_em is not null then
    raise exception 'operacao_ja_arquivada';
  end if;
  for t in select * from public.arquivo_tabelas() loop
    execute format('select count(*) from public.%I where ', t.tabela) || public.arquivo_filtro(t.coluna) into v_n using p_operacao;
    v_lista := v_lista || jsonb_build_object('tabela', t.tabela, 'total', v_n, 'apagar', t.apagar);
  end loop;
  -- leituras completas pelas mesmas funções do painel, como um responsável ativo da operação (criador primeiro)
  select r.user_id into v_resp
    from public.responsaveis r
   where r.ativo and (r.user_id = v_op.responsavel_id
                      or r.user_id in (select m.user_id from public.operacao_responsaveis m where m.operacao_id = p_operacao))
   order by (r.user_id = v_op.responsavel_id) desc
   limit 1;
  if v_resp is null then
    raise exception 'sem_responsavel_ativo';
  end if;
  perform set_config('request.jwt.claim.sub', v_resp::text, true);
  v_rel := public.relatorio_operacao(p_operacao);
  begin
    v_sci := public.sci_contexto(p_operacao);
  exception when others then
    v_sci := null;
  end;
  begin
    v_brief := public.briefing_operacao_dados(p_operacao);
  exception when others then
    v_brief := null;
  end;
  perform set_config('request.jwt.claim.sub', '', true);
  return json_build_object(
    'operacao', row_to_json(v_op),
    'tabelas', v_lista,
    'leituras', json_build_object('relatorio_operacao', v_rel, 'sci_contexto', v_sci, 'briefing_operacao_dados', v_brief),
    'storage', coalesce((select json_agg(json_build_object('bucket', o.bucket_id, 'caminho', o.name) order by o.bucket_id, o.name)
                           from storage.objects o
                          where o.bucket_id in ('fotos', 'sci', 'vitimas', 'relatorios') and o.name like p_operacao::text || '/%'), '[]'::json));
end;
$$;

-- Exporta uma página de uma tabela do arquivo (ordenada pela chave primária)
create or replace function public.servidor_arquivo_tabela(p_operacao uuid, p_tabela text, p_inicio integer, p_limite integer)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  t record;
  v json;
begin
  select * into t from public.arquivo_tabelas() a where a.tabela = p_tabela;
  if not found then
    raise exception 'dados_invalidos';
  end if;
  execute format('select coalesce(json_agg(to_jsonb(x)), ''[]''::json) from (select * from public.%I where %s order by %s offset $2 limit $3) x',
                 t.tabela, public.arquivo_filtro(t.coluna), t.ordem)
    into v
    using p_operacao, greatest(coalesce(p_inicio, 0), 0), least(greatest(coalesce(p_limite, 1000), 1), 20000);
  return v;
end;
$$;

-- Confirma (transação única): reconta, guarda os números dos dashboards, apaga e confere
create or replace function public.servidor_arquivo_confirmar(p_operacao uuid, p_caminho text, p_bytes bigint, p_sha256 text, p_contagens jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
  t record;
  v_n bigint;
  v_esp text;
  v_pend bigint;
  v_inst jsonb := '{}'::jsonb;
  v_res jsonb;
  v_apagadas jsonb := '{}'::jsonb;
begin
  select * into v_op from public.operacoes where id = p_operacao for update;
  if not found then
    raise exception 'operacao_nao_encontrada';
  end if;
  if v_op.status <> 'encerrada' then
    raise exception 'operacao_ativa';
  end if;
  if v_op.arquivada_em is not null then
    raise exception 'operacao_ja_arquivada';
  end if;
  if coalesce(p_caminho, '') !~ ('^' || p_operacao::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.gz$')
     or coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' or coalesce(p_bytes, 0) <= 0
     or jsonb_typeof(p_contagens) is distinct from 'object' then
    raise exception 'dados_invalidos';
  end if;
  -- o arquivo está no Storage (com o tamanho conferido pelo servidor, quando o Storage informa)
  if not exists (select 1 from storage.objects o
                  where o.bucket_id = 'arquivos' and o.name = p_caminho
                    and coalesce((to_jsonb(o)->'metadata'->>'size')::bigint, p_bytes) = p_bytes) then
    raise exception 'arquivamento_sem_arquivo';
  end if;
  -- cada tabela do arquivo tem exatamente as linhas que estão no banco agora
  for t in select * from public.arquivo_tabelas() loop
    execute format('select count(*) from public.%I where ', t.tabela) || public.arquivo_filtro(t.coluna) into v_n using p_operacao;
    v_esp := p_contagens->>t.tabela;
    if v_esp is null or v_esp !~ '^\d+$' or v_esp::bigint <> v_n then
      raise exception 'arquivo_divergente' using detail = t.tabela || ': arquivo ' || coalesce(v_esp, 'sem contagem') || ', banco ' || v_n;
    end if;
  end loop;
  -- números do dashboard e da lista, calculados antes de apagar, pelas mesmas funções do painel
  v_inst := jsonb_build_object(
    'dashboard', public.dashboard_dados_vivo(p_operacao, false)::jsonb,
    'dashboard_publico', public.dashboard_dados_vivo(p_operacao, true)::jsonb);
  begin
    v_inst := v_inst || jsonb_build_object(
      'estudo_nomes', public.estudo_operacao_dados(p_operacao, true)::jsonb,
      'estudo', public.estudo_operacao_dados(p_operacao, false)::jsonb);
  exception when others then
    null;   -- banco sem os estudos: o dashboard da operação mostra só os números gerais
  end;
  v_res := jsonb_build_object(
    'participantes', (select count(*) from public.participantes where operacao_id = p_operacao and tipo <> 'responsavel' and not removido),
    'posicoes', coalesce((p_contagens->>'posicoes')::bigint, 0),
    'mensagens', coalesce((p_contagens->>'mensagens')::bigint, 0),
    'fotos', coalesce((p_contagens->>'fotos')::bigint, 0),
    'setores', coalesce((p_contagens->>'setores')::bigint, 0));
  insert into public.operacao_arquivos (operacao_id, caminho, bytes, sha256, contagens, resumo, instantaneos)
  values (p_operacao, p_caminho, p_bytes, lower(p_sha256), p_contagens, v_res, v_inst);

  select count(*) into v_pend from public.arquivos_pendentes where operacao_id = p_operacao;
  perform set_config('gbs.arquivando_operacao', p_operacao::text, true);
  update public.vitima_localizacoes set participante_id = null, mensagem_id = null where operacao_id = p_operacao;
  -- primeiro as tabelas ligadas só ao participante, depois as demais
  for t in select * from public.arquivo_tabelas() a where a.apagar order by (a.coluna <> 'operacao_id') desc, a.tabela loop
    execute format('delete from public.%I where ', t.tabela) || public.arquivo_filtro(t.coluna) using p_operacao;
    -- linhas que saíram desta tabela (direto ou em cascata): as contagens conferidas acima
    v_apagadas := v_apagadas || jsonb_build_object(t.tabela, (p_contagens->>t.tabela)::bigint);
  end loop;
  -- conferência final: nada sobrou e nenhum arquivo do Storage foi para a fila de exclusão
  for t in select * from public.arquivo_tabelas() a where a.apagar loop
    execute format('select count(*) from public.%I where ', t.tabela) || public.arquivo_filtro(t.coluna) into v_n using p_operacao;
    if v_n <> 0 then
      raise exception 'arquivo_incompleto' using detail = t.tabela;
    end if;
  end loop;
  if (select count(*) from public.arquivos_pendentes where operacao_id = p_operacao) <> v_pend then
    raise exception 'arquivo_apagaria_arquivos';
  end if;
  update public.operacoes set arquivada_em = now() where id = p_operacao;
  perform set_config('gbs.arquivando_operacao', '', true);
  return json_build_object('operacao_id', p_operacao, 'arquivada_em', now(), 'apagadas', v_apagadas);
end;
$$;

-- 6. Funções existentes que passam a conhecer a operação arquivada -----------------------------------------------
-- Gatilhos das tabelas do arquivo e da operação: deixam passar durante o arquivamento (marca gbs.arquivando_operacao)
CREATE OR REPLACE FUNCTION public.apagar_areas_da_operacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.destinos where operacao_id = new.id;
    delete from public.pontos_interesse where operacao_id = new.id;
    delete from public.setores where operacao_id = new.id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.apagar_convites_da_operacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.convites_participante where operacao_id = new.id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.apagar_grupos_da_operacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.grupos where operacao_id = new.id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.apagar_missoes_da_operacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.alertas where operacao_id = new.id;
    delete from public.missoes where operacao_id = new.id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.apagar_sci_da_operacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.sci_vitimas where operacao_id = new.id;
    delete from public.sci_itens where operacao_id = new.id and tipo = 'imagem';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.apagar_trilhas_manuais_da_operacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.trilhas_manuais where operacao_id = new.id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.apagar_vitimas_da_operacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.vitimas where operacao_id = new.id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.bloquear_escrita_encerrada()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_op uuid;
  v_status text;
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- dentro de outro gatilho ou de exclusão em cascata (retenção, excluir operação, ON DELETE SET NULL)
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then v_op := old.operacao_id; else v_op := new.operacao_id; end if;
  -- diário: só as anotações manuais (os eventos automáticos continuam, ex.: resultado, dados apagados)
  if tg_table_name = 'diario' then
    if new.origem <> 'manual' then
      return new;
    end if;
  end if;
  select status into v_status from public.operacoes where id = v_op;
  if v_status is null or v_status = 'ativa' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'operacao_encerrada';
end;
$function$;

CREATE OR REPLACE FUNCTION public.busca_cenarios_proteger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_estado text;
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'busca_cenarios' then
    if tg_op in ('UPDATE', 'DELETE') and old.estado = 'aprovada' then
      raise exception 'cenario_imutavel_aprovado';
    end if;
    if tg_op = 'UPDATE' and (new.operacao_id <> old.operacao_id or new.vitima_id <> old.vitima_id
       or (new.numero <> old.numero and not (current_setting('gbs.renumerar', true) = 'on' and old.estado = 'rascunho' and new.estado = 'aprovada'))) then
      raise exception 'dados_invalidos';
    end if;
  else
    if current_setting('gbs.gerando_versao', true) = 'on' and tg_op = 'INSERT' then
      return new;
    end if;
    select estado into v_estado from public.busca_cenarios where id = coalesce(new.cenario_id, old.cenario_id);
    if v_estado = 'aprovada' then
      raise exception 'cenario_imutavel_aprovado';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.busca_missoes_proteger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'busca_missao_efeitos' then
    raise exception 'busca_missao_imutavel';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'busca_missao_imutavel';
  end if;
  if old.estado <> 'planejada' and (
       -- depois de concluída/cancelada só o preenchimento do POD pendente e o cálculo podem mudar
       (to_jsonb(new) - array['pod_final', 'pod_final_base', 'pod_final_origem', 'pod_final_revisor', 'calculo_estado', 'calculo_detalhe', 'calculo_em'])
       is distinct from (to_jsonb(old) - array['pod_final', 'pod_final_base', 'pod_final_origem', 'pod_final_revisor', 'calculo_estado', 'calculo_detalhe', 'calculo_em'])
       or (old.estado = 'cancelada')
       or (old.calculo_estado not in ('pendente_pod') and (new.pod_final is distinct from old.pod_final))) then
    raise exception 'busca_missao_imutavel';
  end if;
  if (new.setor_nome, new.vitima_id, new.equipe, new.metodo, new.area_atribuida_fracao, new.area_texto, new.pod_planejada, new.pod_planejada_base,
      new.pod_planejada_origem, new.criada_em, new.criada_por_nome)
     is distinct from
     (old.setor_nome, old.vitima_id, old.equipe, old.metodo, old.area_atribuida_fracao, old.area_texto, old.pod_planejada, old.pod_planejada_base,
      old.pod_planejada_origem, old.criada_em, old.criada_por_nome) then
    raise exception 'busca_missao_imutavel';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.busca_registros_proteger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'busca_registro_imutavel';
  end if;
  if old.anulado_em is not null
     or (to_jsonb(new) - array['anulado_em', 'anulado_por_nome', 'anulado_motivo'])
        is distinct from (to_jsonb(old) - array['anulado_em', 'anulado_por_nome', 'anulado_motivo']) then
    raise exception 'busca_registro_imutavel';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.criar_pedido_ajuda_de_mensagem()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_origem text;
  v_nome text;
  v_id uuid;
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if new.direcao = 'entrada' and new.categoria = 'AJUDA' then v_origem := 'botao'; end if;
  elsif new.resposta = 'PRECISO_AJUDA' and old.resposta is distinct from 'PRECISO_AJUDA' then
    v_origem := 'resposta';
  end if;
  if v_origem is null then
    return new;
  end if;
  select nome into v_nome from public.participantes where id = new.participante_id;
  insert into public.pedidos_ajuda (operacao_id, participante_id, participante_nome, mensagem_id, origem, texto, lat, lng, precisao, posicao_em)
  values (new.operacao_id, new.participante_id, coalesce(v_nome, new.remetente_nome, 'Participante'), new.id, v_origem,
          case when v_origem = 'resposta' then 'Respondeu "preciso de ajuda" ao comando: ' || coalesce(new.texto, '') else coalesce(new.texto, '') end,
          new.lat, new.lng, new.precisao, new.posicao_em)
  on conflict (mensagem_id) do nothing
  returning id into v_id;
  if v_id is not null then
    perform public.pedido_ajuda_evento(v_id, 'recebido', 'Sistema',
      case v_origem when 'botao' then 'Pelo botão "Preciso de ajuda"' else 'Resposta "preciso de ajuda" a um comando' end ||
        case when new.lat is null then ' (sem localização).' else ' (com localização).' end);
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.diario_de_alerta()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if new.tipo = 'vitima_localizada' then
      return new;
    end if;
    -- sem comunicação: o horário do registro é o da detecção (a posição guardada é a última conhecida)
    perform public.diario_auto(new.operacao_id, case when new.tipo = 'sem_comunicacao' then new.criado_em else coalesce(new.posicao_em, new.criado_em) end,
      case new.tipo when 'chegou_setor' then 'chegada' when 'chegou_base' then 'chegada'
                    when 'retorno_atrasado' then 'alerta' when 'permanencia_setor' then 'alerta'
                    when 'inicio_atrasado' then 'alerta' when 'prazo_atrasado' then 'alerta' when 'sem_comunicacao' then 'alerta'
                    when 'ajuda_sem_atendimento' then 'alerta'
                    else 'deslocamento' end,
      'alerta_' || new.tipo, new.titulo, new.texto, 'alerta:' || new.id, new.nivel, new.lat, new.lng, new.id::text, 'Sistema');
  elsif new.nivel = 'critico' and old.reconhecido_em is null and new.reconhecido_em is not null then
    perform public.diario_auto(new.operacao_id, new.reconhecido_em, 'alerta', 'alerta_ciente',
      'Ciente do alerta: ' || new.titulo, '', 'alerta_ciente:' || new.id, 'info', null, null, new.id::text, new.reconhecido_por_nome);
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.diario_de_ficha_vitima()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  perform public.diario_auto(new.operacao_id, new.criado_em, 'operacao', 'ficha_vitima', 'Ficha da vítima cadastrada: ' || new.nome, '',
    'ficha_vitima:' || new.id, 'info', null, null, new.id::text, new.criado_por_nome);
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.diario_de_grupo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  perform public.diario_auto(new.operacao_id, new.criado_em, 'pessoa', 'grupo_criado', 'Grupo criado: ' || new.nome, '',
    'grupo_criado:' || new.id, 'info', null, null, new.id::text, new.criado_por_nome);
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.diario_de_mensagem()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if new.direcao <> 'entrada' or new.categoria is null or new.categoria in ('MENSAGEM', 'VITIMA') then
    return new;
  end if;
  perform public.diario_auto(new.operacao_id, coalesce(new.posicao_em, new.criada_em),
    case when new.categoria = 'AJUDA' then 'alerta' else 'encontro' end, 'relato_' || lower(new.categoria),
    public.diario_rotulo_relato(new.categoria) || ' — ' || new.remetente_nome, new.texto,
    'relato:' || new.id, case when new.categoria = 'AJUDA' then 'critico' else 'info' end,
    new.lat, new.lng, new.id::text, new.remetente_nome);
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.diario_de_missao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  perform public.diario_auto(new.operacao_id, new.enviada_em, 'deslocamento', 'missao_enviada',
    'Deslocamento enviado ao grupo ' || new.grupo_nome || ': ' || new.nome,
    concat_ws(' · ', 'Setor: ' || new.setor_nome, 'Base: ' || new.base_nome, 'Prazo de retorno: ' || new.prazo_retorno_min || ' min'),
    'missao_enviada:' || new.id, 'info', new.lat, new.lng, new.id::text, new.enviado_por_nome);
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.diario_de_operacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_nome text := coalesce(public.nome_responsavel_atual(),
                          (select nome from public.responsaveis where user_id = new.responsavel_id));
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    perform public.diario_auto(new.id, new.criada_em, 'operacao', 'operacao_criada',
      'Operação criada: ' || new.codigo, '', 'operacao_criada:' || new.id, 'info', null, null, new.id::text, v_nome);
  end if;
  if new.acionado_em is not null and (tg_op = 'INSERT' or old.acionado_em is distinct from new.acionado_em) then
    perform public.diario_auto(new.id, new.acionado_em, 'operacao', 'acionamento', 'Acionamento da operação',
      coalesce(nullif(new.local_endereco, ''), ''), 'acionamento:' || new.id, 'info', new.local_lat, new.local_lng, new.id::text, v_nome);
  end if;
  if tg_op = 'UPDATE' then
    if old.status = 'ativa' and new.status = 'encerrada' then
      perform public.diario_auto(new.id, coalesce(new.encerrada_em, now()), 'operacao', 'operacao_encerrada',
        'Operação encerrada', '', 'operacao_encerrada:' || new.id || ':' || extract(epoch from coalesce(new.encerrada_em, now()))::bigint,
        'info', null, null, new.id::text, v_nome);
    elsif old.status = 'encerrada' and new.status = 'ativa' then
      perform public.diario_auto(new.id, now(), 'operacao', 'operacao_reaberta', 'Operação reaberta', '',
        'operacao_reaberta:' || new.id || ':' || extract(epoch from now())::bigint, 'info', null, null, new.id::text, v_nome);
    end if;
    if old.dados_apagados_em is null and new.dados_apagados_em is not null then
      perform public.diario_auto(new.id, new.dados_apagados_em, 'operacao', 'dados_apagados',
        'Dados operacionais apagados (retenção)',
        'Participantes, trilhas, mensagens e fotos foram apagados conforme a retenção. O diário e os relatórios continuam.',
        'dados_apagados:' || new.id, 'info', null, null, new.id::text, coalesce(v_nome, 'Sistema'));
    end if;
    if new.resultado is not null and (old.resultado is distinct from new.resultado or old.resultado_texto is distinct from new.resultado_texto) then
      perform public.diario_auto(new.id, coalesce(new.resultado_em, now()), 'operacao', 'resultado',
        'Resultado registrado: ' || case new.resultado
          when 'localizada_viva' then 'vítima localizada com vida'
          when 'localizada_obito' then 'vítima localizada em óbito'
          when 'nao_localizada' then 'vítima não localizada'
          else 'outro' end,
        new.resultado_texto, 'resultado:' || new.id || ':' || extract(epoch from coalesce(new.resultado_em, now()))::bigint,
        'info', null, null, new.id::text, new.resultado_por_nome);
    end if;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.diario_de_participacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_nome text;
  v_tipo text;
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select nome, tipo into v_nome, v_tipo from public.participantes where id = new.participante_id;
  perform public.diario_auto(new.operacao_id, new.em, 'pessoa', 'pessoa_' || new.evento,
    coalesce(v_nome, 'Participante') || case new.evento when 'removido' then ' foi removido da operação'
                                                      when 'liberado' then ': saída liberada'
                                                      else ' foi reincluído na operação' end,
    '', 'participacao:' || new.id, 'info', null, null, new.participante_id::text, new.por_nome);
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.diario_de_participante()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if new.tipo = 'responsavel' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    perform public.diario_auto(new.operacao_id, new.criado_em, 'pessoa', 'pessoa_entrou',
      new.nome || ' entrou na operação (' || public.diario_rotulo_tipo(new.tipo) || ')', '',
      'pessoa_entrou:' || new.id, 'info', null, null, new.id::text, new.nome);
  elsif new.saida_solicitada_em is not null and old.saida_solicitada_em is distinct from new.saida_solicitada_em then
    perform public.diario_auto(new.operacao_id, new.saida_solicitada_em, 'pessoa', 'saida_solicitada',
      new.nome || ' pediu para sair', coalesce(new.saida_motivo, ''),
      'saida_solicitada:' || new.id || ':' || extract(epoch from new.saida_solicitada_em)::bigint, 'info', null, null, new.id::text, new.nome);
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.diario_de_ponto()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  perform public.diario_auto(new.operacao_id, new.criado_em,
    case when new.categoria in ('VESTIGIO', 'VITIMA_ENCONTRADA', 'POSSIVEL_LOCALIZACAO', 'ULTIMA_LOCALIZACAO') then 'encontro' else 'operacao' end,
    'ponto_' || lower(new.categoria), public.diario_rotulo_ponto(new.categoria) || ': ' || new.titulo,
    concat_ws(' · ', nullif(new.descricao, ''), 'Relatado por ' || new.relatado_por_nome),
    'ponto:' || new.id, 'info', new.lat, new.lng, new.id::text, new.criado_por_nome);
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.diario_de_setor()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_resp text;
  v_det text;
  v_op public.operacoes%rowtype;
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    select * into v_op from public.operacoes where id = old.operacao_id;
    -- retenção (dados apagados) ou exclusão da operação: não é uma ação sobre o setor
    if not found or v_op.dados_apagados_em is not null then
      return old;
    end if;
    perform public.diario_auto(old.operacao_id, now(), 'setor', 'setor_excluido', 'Setor excluído: ' || old.nome, '',
      'setor_excluido:' || old.id, 'info', null, null, old.id::text, null);
    return old;
  end if;
  select nome into v_resp from public.participantes where id = new.participante_id;
  v_det := concat_ws(' · ', nullif('Equipe: ' || nullif(new.equipe, ''), 'Equipe: '), nullif('Responsável no setor: ' || v_resp, 'Responsável no setor: '));
  if tg_op = 'INSERT' then
    perform public.diario_auto(new.operacao_id, new.criado_em, 'setor', 'setor_criado', 'Setor criado: ' || new.nome, v_det,
      'setor_criado:' || new.id, 'info', null, null, new.id::text, new.criado_por_nome);
  end if;
  if (tg_op = 'INSERT' and new.status <> 'pendente') or (tg_op = 'UPDATE' and old.status is distinct from new.status) then
    perform public.diario_auto(new.operacao_id, now(), 'setor',
      case when new.status = 'andamento' and (tg_op = 'INSERT' or old.status = 'pendente') then 'setor_iniciado'
           when new.status = 'concluido' then 'setor_concluido'
           else 'setor_reaberto' end,
      case when new.status = 'andamento' and (tg_op = 'INSERT' or old.status = 'pendente') then 'Início da varredura do setor ' || new.nome
           when new.status = 'concluido' then 'Fim da varredura do setor ' || new.nome
           when new.status = 'andamento' then 'Setor ' || new.nome || ' reaberto (em andamento)'
           else 'Setor ' || new.nome || ' voltou para pendente' end,
      v_det, 'setor_status:' || new.id || ':' || new.status || ':' || txid_current() || ':' || extract(epoch from clock_timestamp())::bigint,
      'info', null, null, new.id::text, coalesce(new.atualizado_por_nome, new.criado_por_nome));
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.diario_de_trilha_manual()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_det text;
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from public.operacoes where id = old.operacao_id and dados_apagados_em is null) then
      perform public.diario_auto(old.operacao_id, now(), 'deslocamento', 'trilha_excluida',
        'Trilha desenhada excluída: ' || old.nome, '', 'trilha_excluida:' || old.id, 'info', null, null, old.id::text, null);
    end if;
    return old;
  end if;
  if new.estado = 'percorrida' and (tg_op = 'INSERT' or old.estado is distinct from 'percorrida') then
    v_det := concat_ws(' · ', case new.meio when 'drone' then 'drone' when 'viatura' then 'viatura' when 'embarcacao' then 'embarcação'
                                            when 'aeronave' then 'aeronave' when 'cao' then 'cão de busca' when 'outro' then null else 'equipe' end,
                       round(new.comprimento_m)::bigint || ' m', nullif(new.equipe, ''),
                       (select 'Grupo ' || nome from public.grupos where id = new.grupo_id),
                       (select nome from public.participantes where id = new.participante_id), nullif(new.observacoes, ''));
    perform public.diario_auto(new.operacao_id, new.percorrida_em, 'deslocamento', 'trilha_percorrida',
      'Trajeto percorrido (desenhado): ' || new.nome, v_det,
      'trilha_percorrida:' || new.id || ':' || extract(epoch from new.percorrida_em)::bigint, 'info',
      (new.pontos->0->>0)::double precision, (new.pontos->0->>1)::double precision, new.id::text, new.percorrida_por_nome);
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.diario_de_vitima_localizada()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_vit text;
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select nome into v_vit from public.vitimas where id = new.vitima_id;
  perform public.diario_auto(new.operacao_id, coalesce(new.posicao_em, new.registrado_em), 'encontro', 'vitima_localizada',
    'Vítima localizada — ' || case new.condicao when 'viva' then 'VIVA' else 'MORTA' end || coalesce(': ' || v_vit, ''),
    concat_ws(' · ',
      'Registrado por ' || new.registrado_por_nome || ' (' || public.diario_rotulo_tipo(new.registrado_por_tipo) || ')',
      case when new.encontrada_por_texto is not null and position('encontrada por' in new.registrado_por_nome) = 0
           then 'encontrada por ' || new.encontrada_por_texto end,
      case when new.local_descricao is not null then 'local: ' || new.local_descricao end,
      case when new.lat is null then 'sem localização do GPS' end,
      case when new.observacoes is not null then 'estado/encaminhamento: ' || new.observacoes end),
    'vitima_localizada:' || new.id, 'critico', new.lat, new.lng, new.id::text, new.registrado_por_nome);
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.diario_proteger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if coalesce(current_setting('gbs.excluindo_operacao', true), '') = old.operacao_id::text then
      return old;
    end if;
    raise exception 'diario_nao_apaga';
  end if;
  if old.origem <> 'manual' or new.origem <> 'manual' then
    raise exception 'diario_evento_automatico';
  end if;
  if coalesce(current_setting('gbs.editando_diario', true), '') <> old.id::text
     or new.operacao_id <> old.operacao_id or new.categoria <> old.categoria or new.tipo <> old.tipo
     or new.registrado_em <> old.registrado_em or new.autor_nome <> old.autor_nome then
    raise exception 'diario_somente_funcao';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.diario_versoes_proteger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' and coalesce(current_setting('gbs.excluindo_operacao', true), '') = old.operacao_id::text then
    return old;
  end if;
  raise exception 'diario_nao_apaga';
end;
$function$;

CREATE OR REPLACE FUNCTION public.fila_apagar_arquivo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
  values (old.caminho, 'fotos', old.operacao_id, auth.uid())
  on conflict (caminho) do nothing;
  return old;
end;
$function$;

CREATE OR REPLACE FUNCTION public.fila_apagar_foto_vitima()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if old.foto_caminho is not null then
      insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
      values (old.foto_caminho, 'vitimas', old.operacao_id, auth.uid())
      on conflict (caminho) do nothing;
    end if;
    return old;
  end if;
  if old.foto_caminho is not null and old.foto_caminho is distinct from new.foto_caminho then
    insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
    values (old.foto_caminho, 'vitimas', old.operacao_id, auth.uid())
    on conflict (caminho) do nothing;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.foto_definir_setor()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_s public.setores%rowtype;
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and new.lat is not distinct from old.lat and new.lng is not distinct from old.lng then
    return new;
  end if;
  new.setor_id := null;
  new.setor_nome := null;
  if new.lat is not null and new.lng is not null then
    select s.* into v_s from public.setores s
     where s.operacao_id = new.operacao_id and public.ponto_no_setor(s, new.lat, new.lng)
     order by s.criado_em
     limit 1;
    if found then
      new.setor_id := v_s.id;
      new.setor_nome := v_s.nome;
    end if;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.operacoes_cadastro_encerrada()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if pg_trigger_depth() > 1 or old.status = 'ativa' or new.status = 'ativa' then
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'encerrada_em', 'expira_em', 'dados_apagados_em', 'resultado', 'resultado_texto',
                             'resultado_em', 'resultado_por_nome', 'atualizado_em', 'atualizado_por_nome'])
     is distinct from
     (to_jsonb(old) - array['status', 'encerrada_em', 'expira_em', 'dados_apagados_em', 'resultado', 'resultado_texto',
                             'resultado_em', 'resultado_por_nome', 'atualizado_em', 'atualizado_por_nome']) then
    raise exception 'operacao_encerrada';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.operacoes_comando_inicial()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if new.comando_user_id is null and new.comando_nome is null then
    new.comando_user_id := new.responsavel_id;
    new.comando_nome := (select nome from public.responsaveis where user_id = new.responsavel_id);
    new.comando_desde := coalesce(new.criada_em, now());
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.passagens_comando_proteger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'passagem_imutavel';
  end if;
  if old.estado <> 'pendente'
     or (to_jsonb(new) - array['estado', 'respondida_em', 'resposta_nota'])
        is distinct from (to_jsonb(old) - array['estado', 'respondida_em', 'resposta_nota']) then
    raise exception 'passagem_imutavel';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.pedido_ajuda_eventos_proteger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'pedido_historico_imutavel';
end;
$function$;

CREATE OR REPLACE FUNCTION public.sci_fila_apagar_imagem()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if old.tipo = 'imagem' and old.dados->>'caminho' is not null then
    insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
    values (old.dados->>'caminho', 'sci', old.operacao_id, auth.uid())
    on conflict (caminho) do nothing;
  end if;
  return old;
end;
$function$;

CREATE OR REPLACE FUNCTION public.sci_gatilho_localizacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): as linhas da operação saem de uma vez, sem travas, sem diário e sem enfileirar arquivos
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  begin
    perform public.sci_vincular_localizacao(new.id);
  exception when others then
    raise warning 'SCI: não foi possível ligar a vítima encontrada % ao quadro: %', new.id, sqlerrm;   -- nunca impede o registro
  end;
  return new;
end;
$function$;

-- Diário: nada entra durante o arquivamento nem depois (o diário da operação arquivada está no arquivo)
CREATE OR REPLACE FUNCTION public.diario_auto(p_operacao uuid, p_ocorrido timestamp with time zone, p_categoria text, p_tipo text, p_titulo text, p_detalhe text, p_chave text, p_nivel text DEFAULT 'info'::text, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_ref text DEFAULT NULL::text, p_autor_nome text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- arquivamento (migração 055): diário congelado no arquivo
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' or public.operacao_arquivada(p_operacao) then
    return;
  end if;
  if p_operacao is null or not exists (select 1 from public.operacoes where id = p_operacao) then
    return;
  end if;
  insert into public.diario (operacao_id, ocorrido_em, origem, categoria, tipo, nivel, titulo, detalhe,
                             lat, lng, ref_id, autor_id, autor_nome, chave)
  values (p_operacao, coalesce(p_ocorrido, now()), 'auto', p_categoria, p_tipo, coalesce(p_nivel, 'info'),
          left(coalesce(nullif(btrim(p_titulo), ''), p_tipo), 200), left(coalesce(p_detalhe, ''), 4000),
          case when p_lng is not null then p_lat end, case when p_lat is not null then p_lng end,
          p_ref, auth.uid(),
          coalesce(nullif(btrim(p_autor_nome), ''), public.nome_responsavel_atual(), 'Sistema'),
          p_chave)
  on conflict (chave) do nothing;
end;
$function$;

-- Relatório, SCI e briefing completos: para operação arquivada vêm do arquivo (o servidor recusa, o painel lê de lá)
CREATE OR REPLACE FUNCTION public.relatorio_operacao(p_operacao uuid)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_op public.operacoes%rowtype;
begin
  -- arquivamento (migração 055): os dados desta operação estão no arquivo (o painel lê de lá)
  if public.operacao_arquivada(p_operacao) then
    raise exception 'operacao_arquivada';
  end if;
  if public.nome_responsavel_atual() is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  return json_build_object(
    'gerado_em', now(),
    'gerado_por_nome', public.nome_responsavel_atual(),
    'operacao', json_build_object(
      'id', v_op.id, 'codigo', v_op.codigo, 'status', v_op.status, 'tipo', v_op.tipo, 'tipo_outro', v_op.tipo_outro,
      'acionado_em', v_op.acionado_em, 'local_endereco', v_op.local_endereco, 'local_lat', v_op.local_lat, 'local_lng', v_op.local_lng,
      'descricao', v_op.descricao, 'criada_em', v_op.criada_em, 'encerrada_em', v_op.encerrada_em,
      'dados_apagados_em', v_op.dados_apagados_em, 'retencao_horas', v_op.retencao_horas,
      'ipo', v_op.ipo,
      'resultado', v_op.resultado, 'resultado_texto', v_op.resultado_texto, 'resultado_em', v_op.resultado_em,
      'resultado_por_nome', v_op.resultado_por_nome,
      'criador_nome', (select nome from public.responsaveis where user_id = v_op.responsavel_id)),
    'responsaveis', coalesce((
      select json_agg(json_build_object('nome', r.nome, 'criador', x.criador, 'desde', x.desde) order by x.criador desc, x.desde)
        from (select v_op.responsavel_id as user_id, true as criador, v_op.criada_em as desde
              union all
              select m.user_id, false, m.criado_em from public.operacao_responsaveis m
               where m.operacao_id = p_operacao and m.user_id <> v_op.responsavel_id) x
        join public.responsaveis r on r.user_id = x.user_id), '[]'::json),
    'vitimas', coalesce((
      select json_agg(json_build_object('id', t.id, 'nome', t.nome, 'idade', t.idade, 'caracteristicas', t.caracteristicas,
                                        'roupas', t.roupas, 'observacoes', t.observacoes, 'foto_caminho', t.foto_caminho,
                                        'nascimento', t.nascimento, 'sexo', t.sexo, 'origem', t.origem) order by t.criado_em)
        from public.vitimas t where t.operacao_id = p_operacao), '[]'::json),
    'participantes', coalesce((
      select json_agg(json_build_object('id', p.id, 'nome', p.nome, 'tipo', p.tipo,
               'cpf', public.mascarar_cpf(p.cpf), 'telefone', public.mascarar_telefone(p.telefone),
               'entrou_em', p.criado_em, 'liberado_em', p.liberado_em, 'removido', p.removido, 'removido_em', p.removido_em,
               'grupos', (select coalesce(json_agg(json_build_object('grupo', g.nome, 'papel', gm.papel) order by g.nome), '[]'::json)
                            from public.grupo_membros gm join public.grupos g on g.id = gm.grupo_id
                           where gm.participante_id = p.id)) order by p.tipo, p.nome)
        from public.participantes p where p.operacao_id = p_operacao and p.tipo <> 'responsavel'), '[]'::json),
    'grupos', coalesce((
      select json_agg(json_build_object('id', g.id, 'nome', g.nome, 'cor', g.cor,
               'membros', (select count(*) from public.grupo_membros gm where gm.grupo_id = g.id)) order by g.nome)
        from public.grupos g where g.operacao_id = p_operacao), '[]'::json),
    'setores', coalesce((
      select json_agg(json_build_object('id', s.id, 'nome', s.nome, 'forma', s.forma, 'centro_lat', s.centro_lat, 'centro_lng', s.centro_lng,
               'raio_m', s.raio_m, 'pontos', s.pontos, 'cor', s.cor, 'status', s.status, 'equipe', s.equipe, 'observacoes', s.observacoes,
               'responsavel_nome', (select nome from public.participantes where id = s.participante_id),
               'inicio_em', (select min(d.ocorrido_em) from public.diario d where d.operacao_id = p_operacao and d.ref_id = s.id::text and d.tipo = 'setor_iniciado'),
               'fim_em', (select max(d.ocorrido_em) from public.diario d where d.operacao_id = p_operacao and d.ref_id = s.id::text and d.tipo = 'setor_concluido'),
               'missoes', (select coalesce(json_agg(json_build_object('grupo', m.grupo_nome, 'enviada_em', m.enviada_em, 'iniciada_em', m.iniciada_em,
                                  'chegou_setor_em', m.chegou_setor_em, 'busca_finalizada_em', m.busca_finalizada_em, 'chegou_base_em', m.chegou_base_em)
                                  order by m.enviada_em), '[]'::json)
                             from public.missoes m where m.setor_id = s.id)) order by s.nome)
        from public.setores s where s.operacao_id = p_operacao), '[]'::json),
    'pontos', coalesce((
      select json_agg(json_build_object('categoria', pi.categoria, 'titulo', pi.titulo, 'descricao', pi.descricao, 'lat', pi.lat, 'lng', pi.lng,
                                        'criado_em', pi.criado_em, 'criado_por_nome', pi.criado_por_nome,
                                        'tipo_nome', tp.nome, 'icone', pi.icone, 'cor', pi.cor) order by pi.criado_em)
        from public.pontos_interesse pi left join public.tipos_ponto tp on tp.id = pi.tipo_id
       where pi.operacao_id = p_operacao), '[]'::json),
    'fotos', coalesce((
      select json_agg(json_build_object('id', f.id, 'caminho', f.caminho, 'lat', f.lat, 'lng', f.lng, 'autor_nome', f.autor_nome,
                                        'autor_tipo', f.autor_tipo, 'capturada_em', coalesce(f.capturada_em, f.registrada_em),
                                        'legenda', f.legenda, 'largura', f.largura, 'altura', f.altura) order by coalesce(f.capturada_em, f.registrada_em))
        from public.fotos f where f.operacao_id = p_operacao), '[]'::json),
    -- Trilhas resumidas (no máximo ~400 pontos por pessoa) para o mapa do relatório
    'trilhas', coalesce((
      select json_agg(json_build_object('participante_id', t.participante_id, 'tipo', t.tipo, 'pontos', t.pontos))
        from (select q.participante_id, max(q.tipo) as tipo, json_agg(json_build_array(round(q.lat::numeric, 6), round(q.lng::numeric, 6)) order by q.registrado_em) as pontos
                from (select po.participante_id, pa.tipo, po.lat, po.lng, po.registrado_em,
                             row_number() over (partition by po.participante_id order by po.registrado_em) as n,
                             count(*) over (partition by po.participante_id) as total
                        from public.posicoes po join public.participantes pa on pa.id = po.participante_id
                       where po.operacao_id = p_operacao and (po.precisao is null or po.precisao <= 100)) q
               where q.n % greatest(1, ceil(q.total / 400.0)::int) = 0 or q.n = 1 or q.n = q.total
               group by q.participante_id) t), '[]'::json),
    'diario', coalesce((
      select json_agg(json_build_object('id', d.id, 'ocorrido_em', d.ocorrido_em, 'origem', d.origem, 'categoria', d.categoria,
               'tipo', d.tipo, 'nivel', d.nivel, 'titulo', d.titulo, 'detalhe', d.detalhe, 'autor_nome', d.autor_nome,
               'lat', d.lat, 'lng', d.lng, 'ref_id', d.ref_id, 'versao', d.versao, 'editado_em', d.editado_em, 'editado_por_nome', d.editado_por_nome)
               order by d.ocorrido_em, d.id)
        from public.diario d where d.operacao_id = p_operacao), '[]'::json),
    'relatorios_anteriores', coalesce((
      select json_agg(json_build_object('gerado_em', r.gerado_em, 'gerado_por_nome', r.gerado_por_nome) order by r.gerado_em)
        from public.relatorios r where r.operacao_id = p_operacao), '[]'::json)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.sci_contexto(p_operacao uuid)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  o public.operacoes%rowtype;
begin
  -- arquivamento (migração 055): os dados desta operação estão no arquivo (o painel lê de lá)
  if public.operacao_arquivada(p_operacao) then
    raise exception 'operacao_arquivada';
  end if;
  if public.nome_responsavel_atual() is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into o from public.operacoes where id = p_operacao;
  return json_build_object(
    'gerado_em', now(),
    'comando', json_build_object('nome', o.comando_nome, 'desde', o.comando_desde,
       'passagem_pendente', (select p.para_nome from public.passagens_comando p where p.operacao_id = p_operacao and p.estado = 'pendente' order by p.criada_em desc limit 1)),
    'briefing', (select json_build_object('objetivo', b.objetivo, 'riscos', b.riscos, 'comunicacoes', b.comunicacoes, 'atualizado_em', b.atualizado_em)
                   from public.briefing_operacao b where b.operacao_id = p_operacao),
    'fichas', coalesce((select json_agg(json_build_object('id', v.id, 'nome', v.nome, 'idade', v.idade, 'idade_qualidade', v.idade_qualidade, 'sexo', v.sexo,
                 'perfil', v.perfil, 'cadastro_rapido', v.cadastro_rapido, 'roupas', left(v.roupas, 120)) order by v.criado_em)
                 from public.vitimas v where v.operacao_id = p_operacao), '[]'::json),
    'localizacoes', coalesce((select json_agg(json_build_object('id', l.id, 'vitima_id', l.vitima_id, 'condicao', l.condicao, 'lat', l.lat, 'lng', l.lng, 'precisao', l.precisao,
                 'em', coalesce(l.posicao_em, l.registrado_em), 'local_descricao', l.local_descricao, 'observacoes', l.observacoes,
                 'registrado_por_nome', l.registrado_por_nome, 'encontrada_por_texto', l.encontrada_por_texto) order by l.registrado_em)
                 from public.vitima_localizacoes l where l.operacao_id = p_operacao), '[]'::json),
    'equipes', coalesce((select json_agg(json_build_object(
                 'id', g.id, 'nome', g.nome, 'cor', g.cor, 'disponibilidade', g.disponibilidade, 'disponibilidade_obs', g.disponibilidade_obs, 'capacidades', g.capacidades,
                 'membros', (select count(*) from public.grupo_membros m join public.participantes p on p.id = m.participante_id where m.grupo_id = g.id and not p.removido),
                 'militares', (select count(*) from public.grupo_membros m join public.participantes p on p.id = m.participante_id where m.grupo_id = g.id and not p.removido and p.tipo = 'militar'),
                 'em_campo', (select count(*) from public.grupo_membros m join public.participantes p on p.id = m.participante_id
                               where m.grupo_id = g.id and not p.removido and p.ultimo_contato_em > now() - interval '10 minutes'),
                 'responsavel', (select coalesce(p.nome_painel, p.nome) from public.grupo_membros m join public.participantes p on p.id = m.participante_id
                                  where m.grupo_id = g.id and m.papel = 'responsavel' and not p.removido order by m.criado_em limit 1),
                 'missao', (select json_build_object('nome', x.nome, 'status', x.status, 'setor_nome', x.setor_nome, 'enviada_em', x.enviada_em,
                                                     'chegou_setor_em', x.chegou_setor_em, 'busca_finalizada_em', x.busca_finalizada_em)
                              from public.missoes x where x.grupo_id = g.id and x.status not in ('na_base', 'encerrada') order by x.enviada_em desc limit 1),
                 'recursos', coalesce((select json_agg(json_build_object('tipo', r.tipo, 'identificacao', r.identificacao, 'quantidade', r.quantidade, 'situacao', r.situacao) order by r.criado_em)
                              from public.grupo_recursos r where r.grupo_id = g.id), '[]'::json)) order by g.nome)
                 from public.grupos g where g.operacao_id = p_operacao), '[]'::json),
    'participantes', (select json_build_object('total', count(*) filter (where p.tipo <> 'responsavel'),
                 'militares', count(*) filter (where p.tipo = 'militar'), 'civis', count(*) filter (where p.tipo = 'civil'),
                 'responsaveis', count(*) filter (where p.tipo = 'responsavel'),
                 'em_campo', count(*) filter (where p.tipo <> 'responsavel' and p.ultimo_contato_em > now() - interval '10 minutes'),
                 'primeiro_militar_em', min(p.criado_em) filter (where p.tipo in ('militar', 'responsavel')))
                 from public.participantes p where p.operacao_id = p_operacao and not p.removido),
    'pontos', coalesce((select json_agg(json_build_object('id', p.id, 'categoria', p.categoria, 'titulo', p.titulo, 'lat', p.lat, 'lng', p.lng) order by p.criado_em)
                 from public.pontos_interesse p where p.operacao_id = p_operacao), '[]'::json),
    'setores', coalesce((select json_agg(json_build_object('id', s.id, 'nome', s.nome, 'status', s.status, 'cor', s.cor, 'equipe', s.equipe, 'forma', s.forma,
                 'centro_lat', s.centro_lat, 'centro_lng', s.centro_lng, 'raio_m', s.raio_m, 'pontos', s.pontos) order by s.nome)
                 from public.setores s where s.operacao_id = p_operacao), '[]'::json),
    'alertas', coalesce((select json_agg(json_build_object('tipo', a.tipo, 'titulo', a.titulo, 'texto', a.texto, 'criado_em', a.criado_em) order by a.criado_em desc)
                 from (select * from public.alertas a where a.operacao_id = p_operacao and a.nivel = 'critico' and a.reconhecido_em is null order by a.criado_em desc limit 30) a), '[]'::json),
    'pedidos_ajuda', coalesce((select json_agg(json_build_object('participante_nome', a.participante_nome, 'estado', a.estado, 'prioridade', a.prioridade,
                 'recebido_em', a.recebido_em, 'equipe_nome', a.equipe_nome) order by a.recebido_em)
                 from public.pedidos_ajuda a where a.operacao_id = p_operacao and a.estado <> 'resolvido'), '[]'::json),
    'decisoes', coalesce((select json_agg(json_build_object('texto', d.texto, 'responsavel_nome', d.responsavel_nome, 'prazo', d.prazo) order by d.criado_em)
                 from public.decisoes_pendentes d where d.operacao_id = p_operacao and d.estado = 'pendente'), '[]'::json),
    'verificacao', json_build_object(
       'indicacoes_em_analise', (select count(*) from public.binomio_eventos e where e.operacao_id = p_operacao and e.tipo = 'indicacao' and e.estado = 'em_analise'),
       'focos_a_verificar', (select count(*) from public.observacoes_campo x where x.operacao_id = p_operacao and x.tipo = 'foco_termico' and x.estado = 'a_verificar')),
    'diario', coalesce((select json_agg(json_build_object('id', d.id, 'ocorrido_em', d.ocorrido_em, 'categoria', d.categoria, 'tipo', d.tipo, 'nivel', d.nivel,
                 'titulo', d.titulo, 'detalhe', left(d.detalhe, 500), 'autor_nome', d.autor_nome, 'origem', d.origem) order by d.ocorrido_em desc)
                 from (select * from public.diario d where d.operacao_id = p_operacao and d.tipo not like 'sci\_%' order by d.ocorrido_em desc limit 400) d), '[]'::json)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.briefing_operacao_dados(p_operacao uuid)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_op public.operacoes%rowtype;
  v_b public.briefing_operacao%rowtype;
  v_vitimas json;
  v_ultimo json;
  v_hip json;
  v_pontos_risco json;
  v_equipes json;
  v_missoes json;
  v_setores json;
  v_com json;
  v_dec json;
  v_auto json;
  v_n_pedidos integer;
  v_n_alertas integer;
begin
  -- arquivamento (migração 055): os dados desta operação estão no arquivo (o painel lê de lá)
  if public.operacao_arquivada(p_operacao) then
    raise exception 'operacao_arquivada';
  end if;
  if public.nome_responsavel_atual() is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  select * into v_b from public.briefing_operacao where operacao_id = p_operacao;

  select coalesce(json_agg(json_build_object('id', v.id, 'nome', v.nome, 'idade', v.idade, 'perfil', v.perfil,
           'caracteristicas', left(v.caracteristicas, 300), 'roupas', left(v.roupas, 200),
           'localizada', (select json_build_object('condicao', l.condicao, 'em', l.registrado_em) from public.vitima_localizacoes l where l.vitima_id = v.id order by l.registrado_em desc limit 1))
           order by v.criado_em), '[]'::json)
    into v_vitimas from public.vitimas v where v.operacao_id = p_operacao;

  select coalesce(json_agg(json_build_object('titulo', p.titulo, 'categoria', p.categoria, 'descricao', left(p.descricao, 300), 'lat', p.lat, 'lng', p.lng, 'em', p.criado_em)
           order by p.criado_em desc), '[]'::json)
    into v_ultimo from public.pontos_interesse p where p.operacao_id = p_operacao and p.categoria in ('ULTIMA_LOCALIZACAO', 'POSSIVEL_LOCALIZACAO');

  -- hipóteses: a versão APROVADA mais recente do cenário de cada vítima (POA) e se há rascunho esperando
  select coalesce(json_agg(json_build_object(
           'vitima', v.nome, 'versao', c.numero, 'aprovada_em', c.aprovada_em, 'horario_referencia', c.horario_referencia,
           'hipoteses', c.hipoteses, 'limitacoes', c.limitacoes, 'confianca', c.confianca, 'justificativa', left(c.justificativa, 400),
           'ponto_confiavel', c.ponto_confiavel,
           'setores', (select coalesce(json_agg(json_build_object('nome', s.setor_nome, 'poa', s.poa) order by s.poa desc), '[]'::json)
                         from (select * from public.busca_cenario_setores x where x.cenario_id = c.id and x.poa > 0 order by x.poa desc limit 5) s),
           'rascunho_aberto', exists (select 1 from public.busca_cenarios r where r.vitima_id = v.id and r.estado = 'rascunho'))
           order by v.criado_em), '[]'::json)
    into v_hip
    from public.vitimas v
    join lateral (select * from public.busca_cenarios x where x.vitima_id = v.id and x.estado = 'aprovada' order by x.numero desc limit 1) c on true
   where v.operacao_id = p_operacao;

  select coalesce(json_agg(json_build_object('titulo', p.titulo, 'descricao', left(p.descricao, 300), 'lat', p.lat, 'lng', p.lng) order by p.criado_em desc), '[]'::json)
    into v_pontos_risco from public.pontos_interesse p where p.operacao_id = p_operacao and p.categoria = 'RISCO';
  select count(*) into v_n_pedidos from public.pedidos_ajuda where operacao_id = p_operacao and estado <> 'resolvido';
  select count(*) into v_n_alertas from public.alertas where operacao_id = p_operacao and nivel = 'critico' and reconhecido_em is null;

  select coalesce(json_agg(json_build_object(
           'id', g.id, 'nome', g.nome, 'disponibilidade', g.disponibilidade, 'disponibilidade_obs', g.disponibilidade_obs, 'disponivel_em', g.disponivel_em,
           'disponibilidade_efetiva', case when exists (select 1 from public.missoes m where m.grupo_id = g.id and m.status in ('enviada', 'em_deslocamento', 'no_setor', 'busca_finalizada', 'retorno_atrasado'))
                                           then 'em_missao' else g.disponibilidade end,
           'capacidades', g.capacidades,
           'recursos', (select coalesce(json_agg(json_build_object('tipo', r.tipo, 'identificacao', r.identificacao, 'quantidade', r.quantidade, 'situacao', r.situacao) order by r.tipo, r.identificacao), '[]'::json)
                          from public.grupo_recursos r where r.grupo_id = g.id),
           'sem_comunicacao', not exists (select 1 from public.grupo_recursos r where r.grupo_id = g.id and r.tipo = 'comunicacao' and r.situacao <> 'indisponivel'),
           'sem_primeiros_socorros', not exists (select 1 from public.grupo_recursos r where r.grupo_id = g.id and r.tipo = 'primeiros_socorros' and r.situacao <> 'indisponivel'),
           'membros', (select count(*) from public.grupo_membros gm join public.participantes p on p.id = gm.participante_id where gm.grupo_id = g.id and not p.removido and p.liberado_em is null),
           'conectados', (select count(*) from public.grupo_membros gm join public.participantes p on p.id = gm.participante_id
                           where gm.grupo_id = g.id and not p.removido and p.liberado_em is null and p.ultimo_contato_em > now() - interval '2 minutes'))
           order by g.nome), '[]'::json)
    into v_equipes from public.grupos g where g.operacao_id = p_operacao;

  select coalesce(json_agg(json_build_object('grupo', m.grupo_nome, 'nome', m.nome, 'setor', m.setor_nome, 'status', m.status, 'enviada_em', m.enviada_em,
           'prazo_retorno_em', m.prazo_retorno_em) order by m.enviada_em desc), '[]'::json)
    into v_missoes from public.missoes m where m.operacao_id = p_operacao and m.status not in ('na_base', 'encerrada');

  select json_build_object('pendente', count(*) filter (where status = 'pendente'), 'andamento', count(*) filter (where status = 'andamento'),
                           'concluido', count(*) filter (where status = 'concluido'), 'total', count(*),
                           'pendentes', coalesce(json_agg(nome order by nome) filter (where status <> 'concluido'), '[]'::json))
    into v_setores from public.setores where operacao_id = p_operacao;

  select json_build_object(
           'mensagens_sem_confirmacao', (select count(*) from public.mensagens m where m.operacao_id = p_operacao and m.direcao <> 'entrada' and m.confirmada_em is null),
           'ultimas', (select coalesce(json_agg(x), '[]'::json) from (
                         select json_build_object('de', p.nome, 'texto', left(m.texto, 160), 'categoria', m.categoria, 'em', m.criada_em) as x
                           from public.mensagens m join public.participantes p on p.id = m.participante_id
                          where m.operacao_id = p_operacao and m.direcao = 'entrada' and (m.texto <> '' or m.categoria is not null)
                          order by m.criada_em desc limit 5) u),
           'sem_comunicacao', (select coalesce(json_agg(a.titulo order by a.id), '[]'::json) from public.alertas a
                                where a.operacao_id = p_operacao and a.tipo = 'sem_comunicacao' and a.reconhecido_em is null))
    into v_com;

  select coalesce(json_agg(json_build_object('id', d.id, 'texto', d.texto, 'responsavel', d.responsavel_nome, 'prazo', d.prazo, 'criado_em', d.criado_em, 'criado_por', d.criado_por_nome)
           order by d.prazo nulls last, d.criado_em), '[]'::json)
    into v_dec from public.decisoes_pendentes d where d.operacao_id = p_operacao and d.estado = 'pendente';

  -- decisões que o próprio sistema vê esperando alguém
  select coalesce(json_agg(json_build_object('texto', t.texto, 'ref', t.ref) order by t.ordem), '[]'::json) into v_auto from (
    select 1 as ordem, 'Pedido de ajuda de ' || p.participante_nome || ' (' || p.estado || ', prioridade ' || p.prioridade || ') ainda sem resolução' as texto, 'pedido:' || p.id as ref
      from public.pedidos_ajuda p where p.operacao_id = p_operacao and p.estado <> 'resolvido'
    union all
    select 2, 'Alerta crítico sem ciente: ' || a.titulo, 'alerta:' || a.id
      from public.alertas a where a.operacao_id = p_operacao and a.nivel = 'critico' and a.reconhecido_em is null
    union all
    select 3, 'Cenário de ' || v.nome || ': rascunho da versão ' || c.numero || ' aguardando aprovação', 'cenario:' || c.id
      from public.busca_cenarios c join public.vitimas v on v.id = c.vitima_id where c.operacao_id = p_operacao and c.estado = 'rascunho'
    union all
    select 4, 'Vítima ' || v.nome || ' sem cenário (POA) aprovado', 'vitima:' || v.id
      from public.vitimas v where v.operacao_id = p_operacao
       and not exists (select 1 from public.busca_cenarios c where c.vitima_id = v.id and c.estado = 'aprovada')
       and not exists (select 1 from public.vitima_localizacoes l where l.vitima_id = v.id)
    union all
    select 5, 'Equipe ' || m.grupo_nome || ' com retorno atrasado', 'missao:' || m.id
      from public.missoes m where m.operacao_id = p_operacao and m.status = 'retorno_atrasado'
  ) t;

  return json_build_object(
    'gerado_em', now(),
    'operacao', json_build_object('id', v_op.id, 'codigo', v_op.codigo, 'status', v_op.status, 'tipo', v_op.tipo, 'acionado_em', v_op.acionado_em,
                                  'local', v_op.local_endereco, 'lat', v_op.local_lat, 'lng', v_op.local_lng, 'criada_em', v_op.criada_em),
    'comando', json_build_object('user_id', v_op.comando_user_id, 'nome', v_op.comando_nome, 'desde', v_op.comando_desde),
    'objetivo', json_build_object('texto', coalesce(v_b.objetivo, ''),
                                  'sugerido', nullif(btrim(coalesce(nullif(v_op.descricao, ''), v_op.ipo->>'natureza', '')), '')),
    'vitimas', v_vitimas,
    'ultimo_local_visto', v_ultimo,
    'hipoteses', v_hip,
    'riscos', json_build_object('texto', coalesce(v_b.riscos, ''), 'pontos', v_pontos_risco, 'pedidos_ajuda_abertos', v_n_pedidos, 'alertas_criticos_sem_ciente', v_n_alertas),
    'equipes', v_equipes,
    'tarefas', json_build_object('deslocamentos', v_missoes, 'setores', v_setores),
    'comunicacoes', json_build_object('texto', coalesce(v_b.comunicacoes, ''), 'dados', v_com),
    'observacoes', coalesce(v_b.observacoes, ''),
    'decisoes_pendentes', v_dec,
    'decisoes_automaticas', v_auto);
end;
$function$;

-- Dashboard da operação (janela própria e link público) e estudos: números guardados no arquivamento
CREATE OR REPLACE FUNCTION public.dashboard_dados_vivo(p_operacao uuid, p_publico boolean)
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with op as (select * from public.operacoes where id = p_operacao),
  pessoas as (
    select pa.*, row_number() over (partition by pa.tipo order by pa.criado_em, pa.id) as n_tipo
      from public.participantes pa where pa.operacao_id = p_operacao
  ),
  pts as (
    select distinct on (po.participante_id, floor(extract(epoch from po.registrado_em) / 30))
           po.participante_id, po.lat, po.lng, po.precisao, po.registrado_em
      from public.posicoes po
     where po.operacao_id = p_operacao and (po.precisao is null or po.precisao <= 150)
     order by po.participante_id, floor(extract(epoch from po.registrado_em) / 30), po.registrado_em
  )
  select json_build_object(
    'publico', p_publico,
    'gerado_em', now(),
    'operacao', (select json_build_object('id', o.id, 'codigo', o.codigo, 'tipo', o.tipo, 'status', o.status, 'acionado_em', o.acionado_em,
                   'criada_em', o.criada_em, 'encerrada_em', o.encerrada_em, 'local_lat', o.local_lat, 'local_lng', o.local_lng,
                   'gps_lacuna_s', o.gps_lacuna_s) from op o),
    'participantes', coalesce((select json_agg(json_build_object(
        'id', p.id,
        'nome', case when p_publico then case p.tipo when 'militar' then 'Bombeiro ' when 'civil' then 'Civil ' else 'Responsável ' end || p.n_tipo
                     else p.nome end,
        'tipo', p.tipo,
        'removido', p.removido,
        'grupo', case when p.tipo = 'responsavel' then null else (
                   select json_build_object('id', g.id, 'nome', g.nome, 'cor', g.cor)
                     from public.grupo_membros gm join public.grupos g on g.id = gm.grupo_id
                    where gm.participante_id = p.id order by lower(g.nome) limit 1) end,
        'pontos', coalesce((select json_agg(json_build_array(round(t.lat::numeric, 6), round(t.lng::numeric, 6), t.precisao,
                                                             floor(extract(epoch from t.registrado_em) * 1000)) order by t.registrado_em)
                              from pts t where t.participante_id = p.id), '[]'::json)
      ) order by p.tipo, p.n_tipo) from pessoas p), '[]'::json),
    'setores', coalesce((select json_agg(json_build_object('id', s.id, 'nome', s.nome, 'forma', s.forma, 'centro_lat', s.centro_lat,
                   'centro_lng', s.centro_lng, 'raio_m', s.raio_m, 'pontos', s.pontos, 'status', s.status) order by s.criado_em)
                   from public.setores s where s.operacao_id = p_operacao), '[]'::json),
    'ocorrencias', json_build_object(
      'ajuda', (select count(*) from public.mensagens m where m.operacao_id = p_operacao and (m.categoria = 'AJUDA' or m.resposta = 'PRECISO_AJUDA')),
      'PISTA', (select count(*) from public.mensagens m where m.operacao_id = p_operacao and m.direcao = 'entrada' and m.categoria = 'PISTA'),
      'VESTIGIO', (select count(*) from public.mensagens m where m.operacao_id = p_operacao and m.direcao = 'entrada' and m.categoria = 'VESTIGIO'),
      'OBJETO', (select count(*) from public.mensagens m where m.operacao_id = p_operacao and m.direcao = 'entrada' and m.categoria = 'OBJETO'),
      'OBSTACULO', (select count(*) from public.mensagens m where m.operacao_id = p_operacao and m.direcao = 'entrada' and m.categoria = 'OBSTACULO'),
      'ordens', (select count(*) from public.mensagens m where m.operacao_id = p_operacao and m.direcao <> 'entrada'),
      'fotos', (select count(*) from public.fotos f where f.operacao_id = p_operacao),
      'pontos', (select count(*) from public.pontos_interesse pi where pi.operacao_id = p_operacao),
      'retornosAtrasados', (select count(*) from public.alertas a where a.operacao_id = p_operacao and a.tipo = 'retorno_atrasado')),
    -- relatos de campo (para a lista ao tocar numa ocorrência); no link público, sem texto nem autor
    'relatos', coalesce((select json_agg(json_build_object('id', m.id, 'categoria', case when m.resposta = 'PRECISO_AJUDA' then 'AJUDA' else m.categoria end,
                   'criada_em', m.criada_em, 'direcao', m.direcao,
                   'texto', case when p_publico then null else m.texto end,
                   'autor', case when p_publico then null else m.remetente_nome end) order by m.criada_em desc)
                   from public.mensagens m where m.operacao_id = p_operacao
                    and (m.categoria in ('AJUDA', 'PISTA', 'VESTIGIO', 'OBJETO', 'OBSTACULO') or m.resposta = 'PRECISO_AJUDA' or m.direcao <> 'entrada')), '[]'::json),
    'estudo', public.estudo_operacao_dados(p_operacao, false)
  );
$function$;

create or replace function public.dashboard_dados(p_operacao uuid, p_publico boolean)
returns json
language plpgsql stable security definer set search_path = public
as $$
begin
  if public.operacao_arquivada(p_operacao) then
    return (select (case when p_publico then a.instantaneos->'dashboard_publico' else a.instantaneos->'dashboard' end)::json
              from public.operacao_arquivos a where a.operacao_id = p_operacao);
  end if;
  return public.dashboard_dados_vivo(p_operacao, p_publico);
end;
$$;

CREATE OR REPLACE FUNCTION public.estudo_operacao_dados(p_operacao uuid, p_nomes boolean)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_op public.operacoes%rowtype;
  v_loc record;
  v_vit json;
begin
  -- arquivamento (migração 055): números guardados quando a operação foi arquivada
  if public.operacao_arquivada(p_operacao) then
    return (select (case when p_nomes then a.instantaneos->'estudo_nomes' else a.instantaneos->'estudo' end)::json
              from public.operacao_arquivos a where a.operacao_id = p_operacao);
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  select v.condicao, v.lat, v.lng, coalesce(v.posicao_em, v.registrado_em) as em into v_loc
    from public.vitima_localizacoes v
   where v.operacao_id = p_operacao and v.lat is not null
   order by coalesce(v.posicao_em, v.registrado_em) limit 1;
  v_vit := public.estudo_vitimas(p_operacao, p_nomes);
  return json_build_object(
    'codigo', v_op.codigo, 'tipo', v_op.tipo, 'acionado_em', v_op.acionado_em, 'encerrada_em', v_op.encerrada_em,
    'ulv', case when v_op.local_lat is null then null else json_build_object('lat', v_op.local_lat, 'lng', v_op.local_lng) end,
    'localizacoes', (select count(*) from public.vitima_localizacoes v where v.operacao_id = p_operacao),
    -- primeira localização da operação (compatibilidade com telas antigas)
    'localizacao', case when v_loc.em is null then null else json_build_object(
        'condicao', v_loc.condicao,
        'em', v_loc.em,
        'minutos_ate', case when v_op.acionado_em is null then null else round(extract(epoch from v_loc.em - v_op.acionado_em) / 60) end,
        'distancia_km', case when v_op.local_lat is null then null
                             else round(public.distancia_km(v_op.local_lat, v_op.local_lng, v_loc.lat, v_loc.lng)::numeric, 2) end) end,
    'vitimas', v_vit,
    'vitimas_total', json_array_length(v_vit),
    'vitimas_localizadas', (select count(*) from json_array_elements(v_vit) e where (e->>'localizada')::boolean),
    'fichas', (select count(*) from public.vitimas t where t.operacao_id = p_operacao),
    'perfis', coalesce((select json_object_agg(x.perfil, x.n) from (
        select unnest(t.perfil) as perfil, count(*) as n from public.vitimas t where t.operacao_id = p_operacao group by 1) x), '{}'::json),
    'setores', (select count(*) from public.setores s where s.operacao_id = p_operacao),
    'registros_diario', (select count(*) from public.diario d where d.operacao_id = p_operacao)
  );
end;
$function$;

-- Relatórios de passagem e de comando gerados depois do arquivamento: as passagens estão no arquivo
CREATE OR REPLACE FUNCTION public.registrar_documento(p_operacao uuid, p_caminho text, p_paginas integer, p_bytes bigint, p_sha256 text, p_tipo text, p_referencia text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_nome text := public.nome_responsavel_atual();
  v public.relatorios%rowtype;
  v_titulo text;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if p_tipo is null or p_tipo not in ('final', 'diario', 'passagem', 'comando', 'imprensa')
     or (p_tipo = 'diario' and (p_referencia is null or p_referencia !~ '^\d{4}-\d{2}-\d{2}$'))
     or (p_tipo = 'passagem' and not public.operacao_arquivada(p_operacao) and not exists (select 1 from public.passagens_comando pc where pc.operacao_id = p_operacao and pc.id::text = p_referencia))
     or (p_tipo = 'comando' and p_referencia is distinct from 'inicio' and not public.operacao_arquivada(p_operacao)
         and not exists (select 1 from public.passagens_comando pc where pc.operacao_id = p_operacao and pc.id::text = p_referencia
                         and pc.estado in ('aceita', 'assumida')))
     or (p_tipo in ('final', 'imprensa') and p_referencia is not null) then
    raise exception 'dados_invalidos';
  end if;
  if p_caminho is null or p_caminho !~ ('^' || p_operacao::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$') then
    raise exception 'dados_invalidos';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'relatorios' and name = p_caminho) then
    raise exception 'arquivo_nao_enviado';
  end if;
  if p_tipo = 'diario' then
    select * into v from public.relatorios where operacao_id = p_operacao and tipo = 'diario' and referencia = p_referencia;
    if found then
      return row_to_json(v);
    end if;
  end if;
  if p_tipo = 'comando' then
    select * into v from public.relatorios where operacao_id = p_operacao and tipo = 'comando' and referencia = p_referencia;
    if found then
      return row_to_json(v);
    end if;
  end if;
  insert into public.relatorios (operacao_id, caminho, paginas, bytes, sha256, gerado_por, gerado_por_nome, tipo, referencia)
  values (p_operacao, p_caminho, p_paginas, p_bytes, lower(p_sha256), auth.uid(), v_nome, p_tipo, p_referencia)
  on conflict (caminho) do nothing
  returning * into v;
  if not found then
    select * into v from public.relatorios where caminho = p_caminho;
    return row_to_json(v);
  end if;
  if p_tipo = 'diario' then
    delete from public.relatorio_diario_reservas where operacao_id = p_operacao and dia = p_referencia::date;
  end if;
  v_titulo := case p_tipo
    when 'diario' then 'Relatório diário de ' || to_char(p_referencia::date, 'DD/MM/YYYY') || ' gerado'
    when 'passagem' then 'Relatório da passagem de comando gerado'
    when 'comando' then 'Relatório do comando gerado'
    when 'imprensa' then 'Relatório para imprensa gerado'
    else 'Relatório final gerado' end;
  perform public.diario_auto(p_operacao, v.gerado_em, 'documento', case p_tipo when 'final' then 'relatorio_gerado' else 'relatorio_' || p_tipo end, v_titulo,
    coalesce(p_paginas || ' página(s)', ''), 'relatorio:' || v.id, 'info', null, null, v.id::text, v_nome);
  return row_to_json(v);
end;
$function$;

-- Excluir operação arquivada: os arquivos do Storage saem pela pasta da operação (inclusive o próprio arquivo)
CREATE OR REPLACE FUNCTION public.excluir_operacao(p_operacao uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_codigo text;
  v_fotos integer;
  v_participantes integer;
  v_vitimas integer;
begin
  if not (public.eh_criador(p_operacao) or (public.eh_admin() and public.dono_operacao(p_operacao))) then
    raise exception 'sem_permissao';
  end if;
  select codigo into v_codigo from public.operacoes where id = p_operacao for update;
  if v_codigo is null then
    raise exception 'sem_permissao';
  end if;
  insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
  select caminho, 'relatorios', p_operacao, null from public.relatorios where operacao_id = p_operacao
  on conflict (caminho) do nothing;
  select count(*) into v_fotos from public.fotos where operacao_id = p_operacao;
  select count(*) into v_participantes from public.participantes where operacao_id = p_operacao and tipo <> 'responsavel';
  select count(*) into v_vitimas from public.vitimas where operacao_id = p_operacao;

  -- operação arquivada (migração 055): as linhas de fotos e do SCI estão no arquivo; os arquivos saem pela pasta da operação
  if public.operacao_arquivada(p_operacao) then
    insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
    select o.name, o.bucket_id, p_operacao, null from storage.objects o
     where o.bucket_id in ('fotos', 'sci', 'arquivos') and o.name like p_operacao::text || '/%'
    on conflict (caminho) do nothing;
  end if;
  perform set_config('gbs.excluindo_operacao', p_operacao::text, true);
  delete from public.operacoes where id = p_operacao;   -- apaga em cascata tudo o que é da operação
  perform set_config('gbs.excluindo_operacao', '', true);

  return json_build_object('operacao', v_codigo, 'fotos', v_fotos, 'participantes', v_participantes, 'vitimas', v_vitimas);
end;
$function$;

-- 7. Permissões --------------------------------------------------------------------------------------------------
revoke execute on function public.operacao_arquivada(uuid), public.arquivo_tabelas(), public.arquivo_filtro(text),
  public.dashboard_dados_vivo(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.pode_ler_arquivo_operacao(text), public.arquivo_pode_arquivar(uuid) from public, anon;
grant execute on function public.pode_ler_arquivo_operacao(text), public.arquivo_pode_arquivar(uuid) to authenticated;
revoke execute on function public.servidor_arquivo_candidatas(integer, integer), public.servidor_arquivo_preparar(uuid),
  public.servidor_arquivo_tabela(uuid, text, integer, integer),
  public.servidor_arquivo_confirmar(uuid, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.servidor_arquivo_candidatas(integer, integer), public.servidor_arquivo_preparar(uuid),
  public.servidor_arquivo_tabela(uuid, text, integer, integer),
  public.servidor_arquivo_confirmar(uuid, text, bigint, text, jsonb) to service_role;

notify pgrst, 'reload schema';
