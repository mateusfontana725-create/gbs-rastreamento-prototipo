-- =====================================================================
-- 057 — SCI novo: Posto de Comando (Modo SCI do painel).
--
--  SÓ ACRÉSCIMOS. O banco é o mesmo da main e da testes: nada do que existe é alterado (nem as tabelas e funções do
--  SCI antigo, sci_*, que as outras versões ainda usam). Tudo aqui tem o prefixo sci2_.
--
--  O que entra
--   - sci2_estado (uma linha por operação): SCI estabelecido (quando e por quem), comando inicial (modalidade,
--     instituições, PC e base ligados a pontos do mapa, canais), organograma ({ ativas: { id: { desde, nome, user_id } },
--     equipes: { grupo_id: tipo } }) e o boletim do CI. O Comandante do Incidente NÃO fica aqui: é o comando atual da
--     operação (operacoes.comando_nome, o mesmo do Briefing e da passagem de comando).
--   - sci2_informacoes: informações iniciais e de terceiros, com fonte e hora; nascem NÃO CONFIRMADAS.
--   - sci2_periodos: períodos operacionais com início, fim e objetivos (com estado de cada um).
--   - sci2_vitimas: o caminho da vítima até a entrega: plotada (vítima encontrada no mapa) → em remoção (equipe
--     bloqueada) → check-in na ACV → entregue (destino). Liga à vítima encontrada do app e à ficha, sem gatilho em
--     tabela existente: o painel mostra as encontradas ainda sem número e o comando as traz para o quadro.
--   - Escrita só por RPC SECURITY DEFINER (sci2_*). Cada decisão vai para o diário da operação (diario_auto, que já existe).
--   - Leitura: responsáveis da operação (dono_operacao). Operação encerrada: só leitura (bloquear_escrita_encerrada, que
--     já existe e deixa o arquivamento passar). As tabelas novas entram no arquivo da operação sozinhas (migração 055).
-- =====================================================================

-- 1. Tabelas ------------------------------------------------------------------------------------------------------
create table if not exists public.sci2_estado (
  operacao_id           uuid primary key references public.operacoes(id) on delete cascade,
  estabelecido_em       timestamptz,
  estabelecido_por_nome text,
  comando               jsonb not null default '{}'::jsonb check (jsonb_typeof(comando) = 'object' and length(comando::text) <= 8000),
  organograma           jsonb not null default '{}'::jsonb check (jsonb_typeof(organograma) = 'object' and length(organograma::text) <= 30000),
  boletim               text not null default '' check (char_length(boletim) <= 4000),
  boletim_em            timestamptz,
  boletim_por_nome      text,
  atualizado_em         timestamptz not null default now(),
  atualizado_por_nome   text
);

create table if not exists public.sci2_informacoes (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  texto               text not null check (char_length(btrim(texto)) between 1 and 1000),
  fonte               text not null default '' check (char_length(fonte) <= 200),
  recebida_em         timestamptz not null default now(),
  confirmada_em       timestamptz,
  confirmada_por_nome text,
  descartada_em       timestamptz,
  descartada_motivo   text check (descartada_motivo is null or char_length(descartada_motivo) <= 300),
  registrada_por_nome text not null,
  registrada_em       timestamptz not null default now()
);
create index if not exists sci2_informacoes_op_idx on public.sci2_informacoes (operacao_id, recebida_em);

create table if not exists public.sci2_periodos (
  id              uuid primary key default gen_random_uuid(),
  operacao_id     uuid not null references public.operacoes(id) on delete cascade,
  numero          integer not null check (numero between 1 and 999),
  inicio          timestamptz not null,
  fim             timestamptz not null,
  objetivos       jsonb not null default '[]'::jsonb check (jsonb_typeof(objetivos) = 'array' and length(objetivos::text) <= 12000),
  criado_por_nome text not null,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now(),
  check (fim > inicio),
  unique (operacao_id, numero)
);

create table if not exists public.sci2_vitimas (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  numero              integer not null check (numero between 1 and 9999),
  localizacao_id      uuid unique references public.vitima_localizacoes(id) on delete set null,
  vitima_id           uuid references public.vitimas(id) on delete set null,
  condicao            text not null default 'desconhecida' check (condicao in ('viva', 'obito', 'desconhecida')),
  fase                text not null default 'plotada' check (fase in ('plotada', 'remocao', 'acv', 'entregue')),
  equipe_grupo_id     uuid references public.grupos(id) on delete set null,
  equipe_nome         text check (equipe_nome is null or char_length(equipe_nome) <= 60),
  remocao_em          timestamptz,
  acv_em              timestamptz,
  entregue_em         timestamptz,
  destino             text not null default '' check (char_length(destino) <= 200),
  observacao          text not null default '' check (char_length(observacao) <= 1000),
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text,
  unique (operacao_id, numero)
);

-- 2. Segurança: leitura pelos responsáveis da operação; escrita só pelas funções -------------------------------------
do $$
declare t text;
begin
  foreach t in array array['sci2_estado', 'sci2_informacoes', 'sci2_periodos', 'sci2_vitimas'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_ler', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.dono_operacao(operacao_id))', t || '_ler', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    -- operação encerrada: só leitura (a mesma trava das outras tabelas da operação)
    execute format('drop trigger if exists %I on public.%I', t || '_encerrada', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.bloquear_escrita_encerrada()', t || '_encerrada', t);
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 3. Apoio --------------------------------------------------------------------------------------------------------
-- Confere responsável da operação e operação ativa; cria a linha do estado. Devolve o nome de quem está mexendo.
create or replace function public.sci2_conferir(p_operacao uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_status text;
begin
  if v_nome is null or p_operacao is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  insert into public.sci2_estado (operacao_id) values (p_operacao) on conflict (operacao_id) do nothing;
  return v_nome;
end;
$$;
revoke execute on function public.sci2_conferir(uuid) from public, anon, authenticated;

-- Registro no diário da operação (aparece na linha do tempo do SCI, no diário e no relatório)
create or replace function public.sci2_diario(p_operacao uuid, p_titulo text, p_detalhe text, p_autor text, p_nivel text default 'info')
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform public.diario_auto(p_operacao, now(), case when p_nivel = 'critico' then 'alerta' else 'operacao' end, 'sci2',
    left('SCI · ' || p_titulo, 200), left(coalesce(p_detalhe, ''), 4000), 'sci2:' || gen_random_uuid(), p_nivel, null, null, null, p_autor);
end;
$$;
revoke execute on function public.sci2_diario(uuid, text, text, text, text) from public, anon, authenticated;

-- Catálogo do organograma (o mesmo de public/js/sci-dados.js): id → { nome, titulo, pai, fixa }
create or replace function public.sci2_funcao(p_id text)
returns jsonb
language sql immutable set search_path = public
as $$
  select jsonb_build_object('nome', x.nome, 'titulo', x.titulo, 'pai', x.pai, 'fixa', x.fixa)
    from (values
      ('seg', 'Oficial de Segurança', 'Oficial', null, false),
      ('lig', 'Oficial de Ligação', 'Oficial', null, false),
      ('inf', 'Oficial de Informação Pública', 'Oficial', null, false),
      ('ops', 'Seção de Operações', 'Chefe', null, true),
      ('ops.espera', 'Área de Espera', 'Encarregado', 'ops', false),
      ('ops.acv', 'ACV – Área de Concentração de Vítimas', 'Encarregado', 'ops', false),
      ('plan', 'Seção de Planejamento', 'Chefe', null, false),
      ('plan.rec', 'Unidade de Recursos', 'Líder', 'plan', false),
      ('plan.sit', 'Unidade de Situação', 'Líder', 'plan', false),
      ('plan.doc', 'Unidade de Documentação', 'Líder', 'plan', false),
      ('plan.desm', 'Unidade de Desmobilização', 'Líder', 'plan', false),
      ('plan.ma', 'Unidade de Meio Ambiente', 'Líder', 'plan', false),
      ('plan.esp', 'Especialistas', 'Líder', 'plan', false),
      ('log', 'Seção de Logística', 'Chefe', null, false),
      ('log.serv', 'Setor de Serviços', 'Coordenador', 'log', false),
      ('log.com', 'Unidade de Comunicações', 'Líder', 'log.serv', false),
      ('log.med', 'Unidade Médica', 'Líder', 'log.serv', false),
      ('log.ali', 'Unidade de Alimentação', 'Líder', 'log.serv', false),
      ('log.apoio', 'Setor de Apoio', 'Coordenador', 'log', false),
      ('log.sup', 'Unidade de Suprimentos', 'Líder', 'log.apoio', false),
      ('log.inst', 'Unidade de Instalações', 'Líder', 'log.apoio', false),
      ('log.ter', 'Unidade de Suporte Terrestre', 'Líder', 'log.apoio', false),
      ('adm', 'Seção de Administração e Finanças', 'Chefe', null, false),
      ('adm.tempo', 'Unidade de Tempo', 'Líder', 'adm', false),
      ('adm.prov', 'Unidade de Provedoria', 'Líder', 'adm', false),
      ('adm.cus', 'Unidade de Custos', 'Líder', 'adm', false)
    ) as x(id, nome, titulo, pai, fixa)
   where x.id = p_id;
$$;

-- 4. Estado: estabelecer o SCI, comando inicial e boletim do CI ------------------------------------------------------
-- p_dados: { estabelecer?: true, comando?: { modalidade, instituicoes[], pc_ponto_id, pc_texto, base_ponto_id, base_texto,
--            canal_comando, canal_tatico } (só as chaves enviadas mudam), boletim?: texto }
create or replace function public.sci2_salvar_estado(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.sci2_conferir(p_operacao);
  s public.sci2_estado%rowtype;
  c jsonb;
  k text;
  v jsonb;
  v_lista jsonb;
  v_txt text;
  v_mudou text[] := array[]::text[];
begin
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  select * into s from public.sci2_estado where operacao_id = p_operacao for update;
  c := s.comando;
  if p_dados ? 'comando' then
    if jsonb_typeof(p_dados->'comando') <> 'object' then
      raise exception 'dados_invalidos';
    end if;
    for k, v in select * from jsonb_each(p_dados->'comando') loop
      if k = 'modalidade' then
        if coalesce(v #>> '{}', '') not in ('unico', 'unificado') then raise exception 'dados_invalidos'; end if;
        c := c || jsonb_build_object(k, v #>> '{}');
      elsif k = 'instituicoes' then
        if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 15 then raise exception 'dados_invalidos'; end if;
        select coalesce(jsonb_agg(distinct left(btrim(x), 60)), '[]'::jsonb) into v_lista
          from jsonb_array_elements_text(v) x where btrim(x) <> '';
        c := c || jsonb_build_object(k, v_lista);
      elsif k in ('pc_ponto_id', 'base_ponto_id') then
        if coalesce(jsonb_typeof(v), 'null') = 'null' or v #>> '{}' = '' then
          c := c - k;
        else
          begin
            if not exists (select 1 from public.pontos_interesse p where p.id = (v #>> '{}')::uuid and p.operacao_id = p_operacao) then
              raise exception 'ponto_invalido';
            end if;
          exception when invalid_text_representation then
            raise exception 'dados_invalidos';
          end;
          c := c || jsonb_build_object(k, v #>> '{}');
        end if;
      elsif k in ('pc_texto', 'base_texto', 'canal_comando', 'canal_tatico') then
        v_txt := left(btrim(regexp_replace(coalesce(v #>> '{}', ''), '\s+', ' ', 'g')), case when k like 'canal%' then 80 else 200 end);
        if v_txt = '' then c := c - k; else c := c || jsonb_build_object(k, v_txt); end if;
      else
        raise exception 'dados_invalidos';
      end if;
    end loop;
    if c is distinct from s.comando then v_mudou := v_mudou || 'comando inicial'::text; end if;
  end if;
  if p_dados ? 'boletim' then
    v_txt := left(btrim(coalesce(p_dados->>'boletim', '')), 4000);
    if v_txt is distinct from s.boletim then
      s.boletim := v_txt; s.boletim_em := now(); s.boletim_por_nome := v_nome;
      if v_txt <> '' then perform public.sci2_diario(p_operacao, 'Boletim do CI', v_txt, v_nome); end if;
    end if;
  end if;
  if coalesce((p_dados->>'estabelecer')::boolean, false) and s.estabelecido_em is null then
    s.estabelecido_em := now(); s.estabelecido_por_nome := v_nome;
    perform public.sci2_diario(p_operacao, 'SCI estabelecido',
      concat_ws(' · ', case c->>'modalidade' when 'unificado' then 'Comando unificado' when 'unico' then 'Comando único' end,
        case when jsonb_array_length(coalesce(c->'instituicoes', '[]'::jsonb)) > 0
             then 'Instituições: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(c->'instituicoes') x) end,
        case when c ? 'pc_texto' then 'PC: ' || (c->>'pc_texto') end), v_nome);
  elsif cardinality(v_mudou) > 0 and s.estabelecido_em is not null then
    perform public.sci2_diario(p_operacao, 'Comando inicial atualizado',
      concat_ws(' · ', case c->>'modalidade' when 'unificado' then 'Comando unificado' when 'unico' then 'Comando único' end,
        case when c ? 'pc_texto' then 'PC: ' || (c->>'pc_texto') end,
        case when c ? 'canal_comando' then 'Canal de comando: ' || (c->>'canal_comando') end), v_nome);
  end if;
  update public.sci2_estado
     set comando = c, boletim = s.boletim, boletim_em = s.boletim_em, boletim_por_nome = s.boletim_por_nome,
         estabelecido_em = s.estabelecido_em, estabelecido_por_nome = s.estabelecido_por_nome,
         atualizado_em = now(), atualizado_por_nome = v_nome
   where operacao_id = p_operacao
  returning * into s;
  return row_to_json(s);
end;
$$;

-- 5. Organograma: ativar, desativar, designar e tipo das equipes ------------------------------------------------------
-- p_mudancas: [{ id, ativa?, nome?, user_id? } | { equipe: grupo_id, tipo: ei|ft|ru|setor|grupo|null }]
create or replace function public.sci2_organograma(p_operacao uuid, p_mudancas jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_resp text := public.sci2_conferir(p_operacao);
  s public.sci2_estado%rowtype;
  o jsonb;
  a jsonb;
  eq jsonb;
  m jsonb;
  f jsonb;
  v_id text;
  v_nome text;
  v_ant text;
  v_user uuid;
  v_desc text[];
  v_grupo text;
begin
  if p_mudancas is null or jsonb_typeof(p_mudancas) <> 'array' or jsonb_array_length(p_mudancas) > 60 then
    raise exception 'dados_invalidos';
  end if;
  select * into s from public.sci2_estado where operacao_id = p_operacao for update;
  o := s.organograma;
  a := coalesce(o->'ativas', '{}'::jsonb);
  eq := coalesce(o->'equipes', '{}'::jsonb);
  for m in select * from jsonb_array_elements(p_mudancas) loop
    if jsonb_typeof(m) <> 'object' then raise exception 'dados_invalidos'; end if;
    -- tipo da equipe (grupo do app) no organograma: Equipe de Intervenção, Força-Tarefa, Recurso Único, Setor, Grupo
    if m ? 'equipe' then
      select nome into v_grupo from public.grupos where id::text = m->>'equipe' and operacao_id = p_operacao;
      if v_grupo is null then raise exception 'dados_invalidos'; end if;
      if coalesce(jsonb_typeof(m->'tipo'), 'null') = 'null' then
        eq := eq - (m->>'equipe');
      elsif m->>'tipo' in ('ei', 'ft', 'ru', 'setor', 'grupo') then
        eq := eq || jsonb_build_object(m->>'equipe', m->>'tipo');
      else
        raise exception 'dados_invalidos';
      end if;
      continue;
    end if;
    v_id := m->>'id';
    f := public.sci2_funcao(v_id);
    if f is null then raise exception 'funcao_sci_invalida'; end if;
    if m ? 'ativa' then
      if jsonb_typeof(m->'ativa') <> 'boolean' then raise exception 'dados_invalidos'; end if;
      if (m->>'ativa')::boolean then
        if not (a ? v_id) and not (f->>'fixa')::boolean then
          if f->>'pai' is not null and not (a ? (f->>'pai')) and not coalesce((public.sci2_funcao(f->>'pai')->>'fixa')::boolean, false) then
            raise exception 'funcao_sci_sem_pai';
          end if;
          a := a || jsonb_build_object(v_id, jsonb_build_object('desde', now()));
          perform public.sci2_diario(p_operacao, 'Ativada: ' || (f->>'nome'), null, v_resp);
        end if;
      else
        if (f->>'fixa')::boolean then raise exception 'dados_invalidos'; end if;   -- Operações não desativa: sem chefe, fica com o CI
        if a ? v_id then
          -- a função e as unidades abaixo dela (setores e as unidades dos setores) voltam ao CI
          select coalesce(array_agg(k), array[]::text[]) into v_desc
            from jsonb_object_keys(a) k
           where public.sci2_funcao(k)->>'pai' = v_id or public.sci2_funcao(public.sci2_funcao(k)->>'pai')->>'pai' = v_id;
          a := (a - v_id) - v_desc;
          perform public.sci2_diario(p_operacao, 'Desativada: ' || (f->>'nome') || case when cardinality(v_desc) > 0 then ' (e suas unidades)' else '' end,
            'A função volta ao Comandante do Incidente.', v_resp);
        end if;
      end if;
    end if;
    if m ? 'nome' or m ? 'user_id' then
      if not (a ? v_id) then
        if (f->>'fixa')::boolean then a := a || jsonb_build_object(v_id, jsonb_build_object('desde', now()));
        else raise exception 'funcao_sci_invalida'; end if;   -- só se designa quem responde por função ativa
      end if;
    end if;
    if m ? 'nome' then
      v_nome := left(btrim(regexp_replace(coalesce(m->>'nome', ''), '\s+', ' ', 'g')), 80);
      v_ant := coalesce(a->v_id->>'nome', '');
      if v_nome is distinct from v_ant then
        a := jsonb_set(a, array[v_id, 'nome'], to_jsonb(v_nome));
        perform public.sci2_diario(p_operacao, (f->>'nome') || ': ' ||
          case when v_nome = '' then 'sem responsável' when v_ant = '' then (f->>'titulo') || ' ' || v_nome else v_ant || ' substituído por ' || v_nome end, null, v_resp);
      end if;
    end if;
    if m ? 'user_id' then
      if coalesce(jsonb_typeof(m->'user_id'), 'null') = 'null' or m->>'user_id' = '' then
        a := jsonb_set(a, array[v_id], (a->v_id) - 'user_id');
      else
        begin
          v_user := (m->>'user_id')::uuid;
        exception when invalid_text_representation then
          raise exception 'dados_invalidos';
        end;
        if not exists (select 1 from public.operacoes x where x.id = p_operacao and x.responsavel_id = v_user)
           and not exists (select 1 from public.operacao_responsaveis r where r.operacao_id = p_operacao and r.user_id = v_user) then
          raise exception 'responsavel_fora_da_operacao';
        end if;
        a := jsonb_set(a, array[v_id, 'user_id'], to_jsonb(v_user::text));
      end if;
    end if;
  end loop;
  update public.sci2_estado
     set organograma = o || jsonb_build_object('ativas', a, 'equipes', eq), atualizado_em = now(), atualizado_por_nome = v_resp
   where operacao_id = p_operacao
  returning * into s;
  return row_to_json(s);
end;
$$;

-- 6. Informações iniciais e de terceiros -----------------------------------------------------------------------------
-- p_dados: { texto, fonte, recebida_em } (nova) | { confirmar: true } | { descartar: motivo }
create or replace function public.sci2_informacao(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.sci2_conferir(p_operacao);
  i public.sci2_informacoes%rowtype;
  v_em timestamptz;
begin
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then raise exception 'dados_invalidos'; end if;
  if p_id is null then
    if char_length(btrim(coalesce(p_dados->>'texto', ''))) not between 1 and 1000 then raise exception 'texto_obrigatorio'; end if;
    begin
      v_em := coalesce(nullif(p_dados->>'recebida_em', '')::timestamptz, now());
    exception when others then
      raise exception 'data_invalida';
    end;
    if v_em > now() + interval '5 minutes' then raise exception 'data_invalida'; end if;
    insert into public.sci2_informacoes (operacao_id, texto, fonte, recebida_em, registrada_por_nome)
    values (p_operacao, btrim(p_dados->>'texto'), left(btrim(coalesce(p_dados->>'fonte', '')), 200), v_em, v_nome)
    returning * into i;
    perform public.sci2_diario(p_operacao, 'Informação recebida (NÃO CONFIRMADA)', i.texto || case when i.fonte <> '' then ' — fonte: ' || i.fonte else '' end, v_nome);
    return row_to_json(i);
  end if;
  select * into i from public.sci2_informacoes where id = p_id and operacao_id = p_operacao for update;
  if not found then raise exception 'dados_invalidos'; end if;
  if coalesce((p_dados->>'confirmar')::boolean, false) and i.confirmada_em is null and i.descartada_em is null then
    update public.sci2_informacoes set confirmada_em = now(), confirmada_por_nome = v_nome where id = p_id returning * into i;
    perform public.sci2_diario(p_operacao, 'Informação confirmada', i.texto, v_nome);
  elsif p_dados ? 'descartar' and i.descartada_em is null then
    if char_length(btrim(coalesce(p_dados->>'descartar', ''))) < 3 then raise exception 'motivo_obrigatorio'; end if;
    update public.sci2_informacoes set descartada_em = now(), descartada_motivo = left(btrim(p_dados->>'descartar'), 300) where id = p_id returning * into i;
    perform public.sci2_diario(p_operacao, 'Informação descartada', i.texto || ' — motivo: ' || i.descartada_motivo, v_nome);
  end if;
  return row_to_json(i);
end;
$$;

-- 7. Períodos operacionais ------------------------------------------------------------------------------------------
-- p_dados: { inicio, fim, objetivos: [{ texto, estado: pendente|em_curso|cumprido }] }
create or replace function public.sci2_periodo(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.sci2_conferir(p_operacao);
  p public.sci2_periodos%rowtype;
  v_ini timestamptz;
  v_fim timestamptz;
  v_obj jsonb := '[]'::jsonb;
  x jsonb;
  v_novo boolean := p_id is null;
begin
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then raise exception 'dados_invalidos'; end if;
  if not v_novo then
    select * into p from public.sci2_periodos where id = p_id and operacao_id = p_operacao for update;
    if not found then raise exception 'dados_invalidos'; end if;
  end if;
  begin
    v_ini := coalesce(nullif(p_dados->>'inicio', '')::timestamptz, p.inicio);
    v_fim := coalesce(nullif(p_dados->>'fim', '')::timestamptz, p.fim);
  exception when others then
    raise exception 'data_invalida';
  end;
  if v_ini is null or v_fim is null or v_fim <= v_ini or v_fim - v_ini > interval '72 hours' then
    raise exception 'periodo_invalido';
  end if;
  if p_dados ? 'objetivos' then
    if jsonb_typeof(p_dados->'objetivos') <> 'array' or jsonb_array_length(p_dados->'objetivos') > 20 then raise exception 'dados_invalidos'; end if;
    for x in select * from jsonb_array_elements(p_dados->'objetivos') loop
      if jsonb_typeof(x) <> 'object' or char_length(btrim(coalesce(x->>'texto', ''))) not between 1 and 300
         or coalesce(x->>'estado', 'pendente') not in ('pendente', 'em_curso', 'cumprido') then
        raise exception 'dados_invalidos';
      end if;
      v_obj := v_obj || jsonb_build_array(jsonb_build_object('texto', btrim(x->>'texto'), 'estado', coalesce(x->>'estado', 'pendente')));
    end loop;
  else
    v_obj := coalesce(p.objetivos, '[]'::jsonb);
  end if;
  if v_novo then
    insert into public.sci2_periodos (operacao_id, numero, inicio, fim, objetivos, criado_por_nome)
    values (p_operacao, coalesce((select max(numero) from public.sci2_periodos where operacao_id = p_operacao), 0) + 1, v_ini, v_fim, v_obj, v_nome)
    returning * into p;
    perform public.sci2_diario(p_operacao, 'Período operacional ' || p.numero || ' definido',
      to_char(p.inicio at time zone 'America/Sao_Paulo', 'DD/MM HH24"h"MI') || ' → ' || to_char(p.fim at time zone 'America/Sao_Paulo', 'DD/MM HH24"h"MI')
        || case when jsonb_array_length(v_obj) > 0 then ' · objetivos: ' || (select string_agg(o->>'texto', '; ') from jsonb_array_elements(v_obj) o) else '' end, v_nome);
  else
    update public.sci2_periodos set inicio = v_ini, fim = v_fim, objetivos = v_obj, atualizado_em = now() where id = p_id returning * into p;
  end if;
  return row_to_json(p);
end;
$$;

-- 8. Vítimas: plotada → em remoção (equipe bloqueada) → ACV → entregue ------------------------------------------------
-- p_dados: { localizacao_id?, vitima_id?, condicao?, fase?, equipe_grupo_id?, destino?, observacao?, liberar?: true }
create or replace function public.sci2_vitima(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.sci2_conferir(p_operacao);
  v public.sci2_vitimas%rowtype;
  v_ant public.sci2_vitimas%rowtype;
  v_loc public.vitima_localizacoes%rowtype;
  v_fase text;
  v_grupo text;
  v_rot text;
  v_ordem jsonb := '{"plotada": 1, "remocao": 2, "acv": 3, "entregue": 4}';
begin
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then raise exception 'dados_invalidos'; end if;
  if p_id is null then
    v.operacao_id := p_operacao;
    v.numero := coalesce((select max(numero) from public.sci2_vitimas where operacao_id = p_operacao), 0) + 1;
    v.fase := 'plotada';
    v.condicao := 'desconhecida';
    v.destino := '';
    v.observacao := '';
    v.criado_por_nome := v_nome;
    if coalesce(p_dados->>'localizacao_id', '') <> '' then
      begin
        select * into v_loc from public.vitima_localizacoes where id = (p_dados->>'localizacao_id')::uuid and operacao_id = p_operacao;
      exception when invalid_text_representation then
        raise exception 'dados_invalidos';
      end;
      if v_loc.id is null then raise exception 'dados_invalidos'; end if;
      if exists (select 1 from public.sci2_vitimas where localizacao_id = v_loc.id) then raise exception 'localizacao_ja_no_quadro'; end if;
      v.localizacao_id := v_loc.id;
      v.vitima_id := v_loc.vitima_id;
      v.condicao := v_loc.condicao;
    end if;
  else
    select * into v from public.sci2_vitimas where id = p_id and operacao_id = p_operacao for update;
    if not found then raise exception 'dados_invalidos'; end if;
  end if;
  v_ant := v;
  v_rot := 'V-' || lpad(v.numero::text, 2, '0');

  if coalesce(p_dados->>'vitima_id', '') <> '' then
    if not exists (select 1 from public.vitimas where id::text = p_dados->>'vitima_id' and operacao_id = p_operacao) then raise exception 'dados_invalidos'; end if;
    v.vitima_id := (p_dados->>'vitima_id')::uuid;
  end if;
  if p_dados ? 'condicao' then
    if p_dados->>'condicao' not in ('viva', 'obito', 'desconhecida') then raise exception 'dados_invalidos'; end if;
    v.condicao := p_dados->>'condicao';
  end if;
  if p_dados ? 'destino' then v.destino := left(btrim(coalesce(p_dados->>'destino', '')), 200); end if;
  if p_dados ? 'observacao' then v.observacao := left(btrim(coalesce(p_dados->>'observacao', '')), 1000); end if;

  -- liberar o bloqueio: a remoção não aconteceu; a vítima volta a aguardar equipe
  if coalesce((p_dados->>'liberar')::boolean, false) then
    if v.fase <> 'remocao' then raise exception 'vitima_sci_fase_invalida'; end if;
    v.fase := 'plotada'; v.equipe_grupo_id := null; v.equipe_nome := null; v.remocao_em := null;
    perform public.sci2_diario(p_operacao, v_rot || ': bloqueio liberado', 'Equipe ' || coalesce(v_ant.equipe_nome, '?') || ' liberada; a vítima volta a aguardar equipe.', v_nome);
  end if;

  if p_dados ? 'fase' then
    v_fase := p_dados->>'fase';
    if not (v_ordem ? coalesce(v_fase, '')) then raise exception 'dados_invalidos'; end if;
    -- só para frente (voltar é "liberar o bloqueio"); pular etapas é permitido (ex.: chegou na ACV sem plotagem)
    if (v_ordem->>v_fase)::int < (v_ordem->>v.fase)::int then raise exception 'vitima_sci_fase_invalida'; end if;
    if v_fase = 'remocao' and v.fase <> 'remocao' then
      if coalesce(p_dados->>'equipe_grupo_id', '') = '' then raise exception 'vitima_sci_sem_equipe'; end if;
      select nome into v_grupo from public.grupos where id::text = p_dados->>'equipe_grupo_id' and operacao_id = p_operacao;
      if v_grupo is null then raise exception 'dados_invalidos'; end if;
      v.equipe_grupo_id := (p_dados->>'equipe_grupo_id')::uuid; v.equipe_nome := v_grupo; v.remocao_em := now();
      perform public.sci2_diario(p_operacao, v_rot || ' em remoção', 'Equipe ' || v_grupo || ' designada (bloqueada para esta vítima).', v_nome);
    elsif v_fase = 'remocao' and coalesce(p_dados->>'equipe_grupo_id', '') <> '' and p_dados->>'equipe_grupo_id' is distinct from v.equipe_grupo_id::text then
      raise exception 'vitima_sci_bloqueada';   -- trocar a equipe exige liberar o bloqueio antes
    end if;
    if v_fase in ('acv', 'entregue') and v.acv_em is null then
      v.acv_em := now();
      perform public.sci2_diario(p_operacao, v_rot || ' check-in na ACV',
        case when v.equipe_nome is not null then 'Removida pela equipe ' || v.equipe_nome || '.' else 'Chegou à ACV sem remoção registrada.' end, v_nome);
    end if;
    if v_fase = 'entregue' and v.entregue_em is null then
      if v.destino = '' then raise exception 'vitima_sci_sem_destino'; end if;
      v.entregue_em := now();
      perform public.sci2_diario(p_operacao, v_rot || ' entregue', 'Destino: ' || v.destino, v_nome);
    end if;
    v.fase := v_fase;
  elsif coalesce(p_dados->>'equipe_grupo_id', '') <> '' and v.fase = 'remocao' and p_dados->>'equipe_grupo_id' is distinct from v.equipe_grupo_id::text then
    raise exception 'vitima_sci_bloqueada';
  end if;

  if p_id is null then
    insert into public.sci2_vitimas (operacao_id, numero, localizacao_id, vitima_id, condicao, fase, equipe_grupo_id, equipe_nome,
                                     remocao_em, acv_em, entregue_em, destino, observacao, criado_por_nome)
    values (v.operacao_id, v.numero, v.localizacao_id, v.vitima_id, v.condicao, v.fase, v.equipe_grupo_id, v.equipe_nome,
            v.remocao_em, v.acv_em, v.entregue_em, v.destino, v.observacao, v.criado_por_nome)
    returning * into v;
    if v.fase = 'plotada' then
      perform public.sci2_diario(p_operacao, v_rot || ' no quadro de vítimas',
        case when v.localizacao_id is not null then 'Vítima encontrada no mapa, aguardando equipe.' else 'Registrada sem plotagem no mapa.' end, v_nome);
    end if;
  else
    update public.sci2_vitimas
       set vitima_id = v.vitima_id, condicao = v.condicao, fase = v.fase, equipe_grupo_id = v.equipe_grupo_id, equipe_nome = v.equipe_nome,
           remocao_em = v.remocao_em, acv_em = v.acv_em, entregue_em = v.entregue_em, destino = v.destino, observacao = v.observacao,
           atualizado_em = now(), atualizado_por_nome = v_nome
     where id = p_id
    returning * into v;
  end if;
  return row_to_json(v);
end;
$$;

revoke execute on function public.sci2_salvar_estado(uuid, jsonb), public.sci2_organograma(uuid, jsonb), public.sci2_informacao(uuid, uuid, jsonb),
  public.sci2_periodo(uuid, uuid, jsonb), public.sci2_vitima(uuid, uuid, jsonb) from public, anon;
grant execute on function public.sci2_salvar_estado(uuid, jsonb), public.sci2_organograma(uuid, jsonb), public.sci2_informacao(uuid, uuid, jsonb),
  public.sci2_periodo(uuid, uuid, jsonb), public.sci2_vitima(uuid, uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
