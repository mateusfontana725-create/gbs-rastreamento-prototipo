-- =====================================================================
-- 15. GRUPOS DENTRO DA OPERAÇÃO
--     (migração 008 — idempotente; exige a 007)
--
--  grupos          grupos com nome livre (ex.: Polícia Civil, Bombeiros), com cor
--  grupo_convites  o link (token) de cada grupo — separado dos dados do grupo
--                  para que um membro, que lê o grupo, NÃO leia o link
--  grupo_membros   quem está em cada grupo e com que papel (responsável/membro)
--
--  Quem vê o quê (RLS):
--   * responsáveis da operação: todos os grupos, membros e links da operação;
--   * participante: SOMENTE os grupos aos quais pertence e a própria linha de
--     membro (com o papel). Nunca lê os links nem os outros membros.
--  O navegador não grava nessas tabelas: tudo passa pelas funções abaixo.
--
--  Link do grupo: entra na operação E no grupo, sempre como "membro". O papel
--  de responsável do grupo só é dado pelo painel. Pelo link de um grupo, a
--  pessoa entra como civil, a não ser que o grupo permita militares.
--  "Gerar novo link" troca o token: o link anterior deixa de funcionar na hora.
--  Uma pessoa pode estar em mais de um grupo.
-- =====================================================================

-- Chave composta: garante que grupo e pessoa de um vínculo são da MESMA operação.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'participantes_id_operacao_key') then
    alter table public.participantes add constraint participantes_id_operacao_key unique (id, operacao_id);
  end if;
end;
$$;

create table if not exists public.grupos (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  nome                text not null check (char_length(btrim(nome)) between 1 and 60),
  cor                 text not null default '#f59e0b' check (cor ~ '^#[0-9a-fA-F]{6}$'),
  permite_militar     boolean not null default false,
  criado_por          uuid references auth.users(id) on delete set null,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text,
  constraint grupos_id_operacao_key unique (id, operacao_id)
);
create unique index if not exists grupos_nome_unico on public.grupos (operacao_id, lower(nome));

create table if not exists public.grupo_convites (
  grupo_id         uuid primary key references public.grupos(id) on delete cascade,
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  token            text not null unique check (char_length(token) = 64),
  criado_em        timestamptz not null default now(),
  criado_por_nome  text
);

create table if not exists public.grupo_membros (
  grupo_id             uuid not null,
  participante_id      uuid not null,
  operacao_id          uuid not null,
  papel                text not null default 'membro' check (papel in ('responsavel', 'membro')),
  origem               text not null default 'painel' check (origem in ('painel', 'link')),
  adicionado_por_nome  text,
  criado_em            timestamptz not null default now(),
  atualizado_em        timestamptz not null default now(),
  primary key (grupo_id, participante_id),
  constraint grupo_membros_grupo_fk foreign key (grupo_id, operacao_id)
    references public.grupos(id, operacao_id) on delete cascade,
  constraint grupo_membros_participante_fk foreign key (participante_id, operacao_id)
    references public.participantes(id, operacao_id) on delete cascade
);
create index if not exists grupo_membros_participante_idx on public.grupo_membros (participante_id);
create index if not exists grupo_membros_operacao_idx on public.grupo_membros (operacao_id);

-- A pessoa logada é participante ATIVO deste grupo? (security definer: evita a
-- recursão de uma política de grupo_membros consultando a própria tabela)
create or replace function public.eh_membro_grupo(p_grupo uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.grupo_membros m
      join public.participantes p on p.id = m.participante_id
     where m.grupo_id = p_grupo and p.user_id = auth.uid() and not p.removido and p.liberado_em is null);
$$;

alter table public.grupos enable row level security;
alter table public.grupo_convites enable row level security;
alter table public.grupo_membros enable row level security;

drop policy if exists grupos_ler on public.grupos;
create policy grupos_ler on public.grupos
  for select to authenticated using (public.dono_operacao(operacao_id) or public.eh_membro_grupo(id));

drop policy if exists grupo_convites_ler on public.grupo_convites;
create policy grupo_convites_ler on public.grupo_convites
  for select to authenticated using (public.dono_operacao(operacao_id));

drop policy if exists grupo_membros_ler on public.grupo_membros;
create policy grupo_membros_ler on public.grupo_membros
  for select to authenticated using (public.dono_operacao(operacao_id) or public.eh_meu_participante(participante_id));

revoke all on public.grupos, public.grupo_convites, public.grupo_membros from anon;
revoke insert, update, delete, truncate on public.grupos, public.grupo_convites, public.grupo_membros from authenticated;
grant select on public.grupos, public.grupo_convites, public.grupo_membros to authenticated;

-- ---------------------------------------------------------------------
-- Funções do painel (responsáveis da operação)
-- ---------------------------------------------------------------------

-- Cria (p_id nulo) ou altera um grupo: nome, cor, permite_militar.
create or replace function public.salvar_grupo(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v public.grupos%rowtype;
  v_op public.operacoes%rowtype;
begin
  if v_nome_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;

  if p_id is null then
    v.id := gen_random_uuid();
    v.operacao_id := p_operacao;
    v.cor := '#f59e0b';
    v.permite_militar := false;
    v.criado_por := auth.uid();
    v.criado_por_nome := v_nome_resp;
    v.criado_em := now();
  else
    select * into v from public.grupos where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'grupo_nao_encontrado';
    end if;
  end if;

  if p_dados ? 'nome' then v.nome := btrim(regexp_replace(coalesce(p_dados->>'nome', ''), '\s+', ' ', 'g')); end if;
  if p_dados ? 'cor' then v.cor := p_dados->>'cor'; end if;
  if p_dados ? 'permite_militar' then
    if jsonb_typeof(p_dados->'permite_militar') <> 'boolean' then
      raise exception 'dados_invalidos';
    end if;
    v.permite_militar := (p_dados->>'permite_militar')::boolean;
  end if;
  if v.nome is null or char_length(v.nome) not between 1 and 60 then
    raise exception 'nome_grupo_invalido';
  end if;
  if v.cor is null or v.cor !~ '^#[0-9a-fA-F]{6}$' then
    raise exception 'dados_invalidos';
  end if;

  v.atualizado_em := now();
  v.atualizado_por_nome := v_nome_resp;
  begin
    if p_id is null then
      insert into public.grupos select v.*;
      insert into public.grupo_convites (grupo_id, operacao_id, token, criado_por_nome)
      values (v.id, v.operacao_id, public.gerar_token(), v_nome_resp);
    else
      update public.grupos set nome = v.nome, cor = v.cor, permite_militar = v.permite_militar,
             atualizado_em = v.atualizado_em, atualizado_por_nome = v.atualizado_por_nome
       where id = v.id;
    end if;
  exception when unique_violation then
    raise exception 'grupo_existente';
  end;
  return row_to_json(v);
end;
$$;

-- Excluir o grupo: quem o criou, quem criou a operação ou um administrador.
-- Os vínculos e o link são apagados junto; as pessoas continuam na operação.
create or replace function public.excluir_grupo(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.grupos%rowtype;
begin
  select * into v from public.grupos where id = p_id;
  if not found or not public.pode_excluir_registro(v.operacao_id, v.criado_por) then
    raise exception 'sem_permissao';
  end if;
  delete from public.grupos where id = p_id;
end;
$$;

-- Coloca uma pessoa no grupo (ou muda o papel dela). Só pelo painel.
create or replace function public.definir_membro(p_grupo uuid, p_participante uuid, p_papel text default 'membro')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_g public.grupos%rowtype;
  v_m public.grupo_membros%rowtype;
begin
  select * into v_g from public.grupos where id = p_grupo;
  if not found or v_nome_resp is null or not public.dono_operacao(v_g.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if exists (select 1 from public.operacoes where id = v_g.operacao_id and dados_apagados_em is not null) then
    raise exception 'operacao_encerrada';
  end if;
  if coalesce(p_papel, '') not in ('responsavel', 'membro') then
    raise exception 'dados_invalidos';
  end if;
  if not exists (select 1 from public.participantes where id = p_participante and operacao_id = v_g.operacao_id) then
    raise exception 'participante_invalido';
  end if;
  insert into public.grupo_membros (grupo_id, participante_id, operacao_id, papel, origem, adicionado_por_nome)
  values (v_g.id, p_participante, v_g.operacao_id, p_papel, 'painel', v_nome_resp)
  on conflict (grupo_id, participante_id) do update
     set papel = excluded.papel, atualizado_em = now()
  returning * into v_m;
  return row_to_json(v_m);
end;
$$;

create or replace function public.remover_membro(p_grupo uuid, p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_op uuid;
begin
  select operacao_id into v_op from public.grupos where id = p_grupo;
  if v_op is null or public.nome_responsavel_atual() is null or not public.dono_operacao(v_op) then
    raise exception 'sem_permissao';
  end if;
  delete from public.grupo_membros where grupo_id = p_grupo and participante_id = p_participante;
end;
$$;

-- Link (token) do grupo: só responsáveis da operação.
create or replace function public.link_do_grupo(p_grupo uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_g public.grupos%rowtype;
  v_token text;
begin
  select * into v_g from public.grupos where id = p_grupo;
  if not found or not public.dono_operacao(v_g.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select token into v_token from public.grupo_convites where grupo_id = p_grupo;
  if v_token is null then
    insert into public.grupo_convites (grupo_id, operacao_id, token, criado_por_nome)
    values (v_g.id, v_g.operacao_id, public.gerar_token(), public.nome_responsavel_atual())
    returning token into v_token;
  end if;
  return json_build_object('grupo_id', v_g.id, 'token', v_token, 'permite_militar', v_g.permite_militar);
end;
$$;

-- Troca o link do grupo: o anterior deixa de funcionar na hora.
create or replace function public.gerar_novo_link_grupo(p_grupo uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_g public.grupos%rowtype;
  v_nome text := public.nome_responsavel_atual();
  v_token text := public.gerar_token();
begin
  select * into v_g from public.grupos where id = p_grupo;
  if not found or v_nome is null or not public.dono_operacao(v_g.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  insert into public.grupo_convites (grupo_id, operacao_id, token, criado_por_nome)
  values (v_g.id, v_g.operacao_id, v_token, v_nome)
  on conflict (grupo_id) do update set token = excluded.token, criado_em = now(), criado_por_nome = excluded.criado_por_nome;
  return json_build_object('grupo_id', v_g.id, 'token', v_token, 'permite_militar', v_g.permite_militar);
end;
$$;

-- ---------------------------------------------------------------------
-- Funções do participante
-- ---------------------------------------------------------------------

-- Grupos do próprio participante (nome, cor e o papel dele). Nada sobre os outros membros.
create or replace function public.meus_grupos(p_participante uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found then
    raise exception 'participante_invalido';
  end if;
  return coalesce((
    select json_agg(json_build_object('id', g.id, 'nome', g.nome, 'cor', g.cor, 'papel', m.papel) order by g.nome)
      from public.grupo_membros m join public.grupos g on g.id = m.grupo_id
     where m.participante_id = v_part.id), '[]'::json);
end;
$$;

-- Tela inicial: aceita também o link de um grupo (mostra o nome do grupo).
create or replace function public.info_operacao(p_token text)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
  v_tipo text;
  v_grupo text;
  v_perm boolean;
  v_opid uuid;
begin
  if p_token is null or char_length(p_token) <> 64 then
    return null;
  end if;
  select * into v_op from public.operacoes where token_civil = p_token;
  if found then
    v_tipo := 'civil';
  else
    select * into v_op from public.operacoes where token_militar = p_token;
    if found then
      v_tipo := 'militar';
    else
      select g.nome, g.permite_militar, g.operacao_id into v_grupo, v_perm, v_opid
        from public.grupo_convites c join public.grupos g on g.id = c.grupo_id
       where c.token = p_token;
      if v_opid is null then
        return null;
      end if;
      select * into v_op from public.operacoes where id = v_opid;
      v_tipo := case when v_perm then 'militar' else 'civil' end;
    end if;
  end if;
  return json_build_object(
    'operacao', v_op.codigo,
    'ativa', v_op.status = 'ativa',
    'tipos_permitidos', case when v_tipo = 'militar' then json_build_array('militar', 'civil') else json_build_array('civil') end,
    'grupo', v_grupo
  );
end;
$$;

-- Ingresso: igual ao anterior, aceitando também o link de um grupo. Pelo link
-- do grupo a pessoa entra na operação e no grupo (papel "membro").
create or replace function public.ingressar(p_token text, p_nome text, p_tipo text default 'civil',
                                            p_cpf text default null, p_telefone text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_op public.operacoes%rowtype;
  v_link text;
  v_tipo text;
  v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  v_part public.participantes%rowtype;
  v_total integer;
  v_cpf text := public.cpf_normalizado(p_cpf);
  v_tel text := public.telefone_normalizado(p_telefone);
  v_grupo_id uuid;
  v_grupo_nome text;
  v_perm boolean;
  v_opid uuid;
begin
  if v_uid is null then
    raise exception 'nao_autenticado';
  end if;
  if p_token is null or char_length(p_token) <> 64 then
    raise exception 'link_invalido';
  end if;

  select * into v_op from public.operacoes where token_civil = p_token;
  if found then
    v_link := 'civil';
  else
    select * into v_op from public.operacoes where token_militar = p_token;
    if found then
      v_link := 'militar';
    else
      select g.id, g.nome, g.permite_militar, g.operacao_id into v_grupo_id, v_grupo_nome, v_perm, v_opid
        from public.grupo_convites c join public.grupos g on g.id = c.grupo_id
       where c.token = p_token;
      if v_grupo_id is null then
        raise exception 'link_invalido';
      end if;
      select * into v_op from public.operacoes where id = v_opid;
      v_link := case when v_perm then 'militar' else 'civil' end;
    end if;
  end if;

  if v_op.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if char_length(v_nome) < 2 or char_length(v_nome) > 40 then
    raise exception 'nome_invalido';
  end if;

  -- O tipo é decidido pelo servidor: o link de civis nunca concede "militar".
  if v_link = 'militar' and p_tipo = 'militar' then
    v_tipo := 'militar';
  else
    v_tipo := 'civil';
  end if;

  -- CPF e celular: obrigatórios para civis; opcionais para militares (se informados, válidos).
  if coalesce(btrim(p_cpf), '') <> '' and v_cpf is null then
    raise exception 'cpf_invalido';
  end if;
  if coalesce(btrim(p_telefone), '') <> '' and v_tel is null then
    raise exception 'telefone_invalido';
  end if;
  if v_tipo = 'civil' and v_cpf is null then
    raise exception 'cpf_invalido';
  end if;
  if v_tipo = 'civil' and v_tel is null then
    raise exception 'telefone_invalido';
  end if;

  select * into v_part from public.participantes where operacao_id = v_op.id and user_id = v_uid;
  if found then
    if v_part.liberado_em is not null then
      raise exception 'participante_liberado';
    end if;
    if v_part.removido or v_part.tipo = 'responsavel' then
      raise exception 'participante_removido';
    end if;
    update public.participantes
       set nome = v_nome, tipo = v_tipo,
           cpf = coalesce(v_cpf, cpf), telefone = coalesce(v_tel, telefone)
     where id = v_part.id returning * into v_part;
  else
    select count(*) into v_total from public.participantes where operacao_id = v_op.id;
    if v_total >= 300 then
      raise exception 'limite_participantes';
    end if;
    insert into public.participantes (operacao_id, user_id, nome, tipo, cpf, telefone)
    values (v_op.id, v_uid, v_nome, v_tipo, v_cpf, v_tel)
    returning * into v_part;
  end if;

  if v_grupo_id is not null then
    insert into public.grupo_membros (grupo_id, participante_id, operacao_id, papel, origem, adicionado_por_nome)
    values (v_grupo_id, v_part.id, v_op.id, 'membro', 'link', 'link do grupo')
    on conflict (grupo_id, participante_id) do nothing;
  end if;

  return json_build_object(
    'participante_id', v_part.id,
    'nome', v_part.nome,
    'tipo', v_part.tipo,
    'operacao', v_op.codigo,
    'operacao_id', v_op.id,
    'saida_solicitada_em', v_part.saida_solicitada_em,
    'grupo', v_grupo_nome
  );
end;
$$;

-- Retenção: dados apagados → grupos, links e vínculos apagados.
create or replace function public.apagar_grupos_da_operacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.grupos where operacao_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists operacoes_apagar_grupos on public.operacoes;
create trigger operacoes_apagar_grupos after update of dados_apagados_em on public.operacoes
  for each row execute function public.apagar_grupos_da_operacao();

revoke execute on function public.apagar_grupos_da_operacao() from public, anon, authenticated;
revoke execute on function
  public.eh_membro_grupo(uuid), public.salvar_grupo(uuid, uuid, jsonb), public.excluir_grupo(uuid),
  public.definir_membro(uuid, uuid, text), public.remover_membro(uuid, uuid), public.link_do_grupo(uuid),
  public.gerar_novo_link_grupo(uuid), public.meus_grupos(uuid), public.info_operacao(text),
  public.ingressar(text, text, text, text, text)
  from public, anon;
grant execute on function
  public.eh_membro_grupo(uuid), public.salvar_grupo(uuid, uuid, jsonb), public.excluir_grupo(uuid),
  public.definir_membro(uuid, uuid, text), public.remover_membro(uuid, uuid), public.link_do_grupo(uuid),
  public.gerar_novo_link_grupo(uuid), public.meus_grupos(uuid), public.info_operacao(text),
  public.ingressar(text, text, text, text, text)
  to authenticated;
-- A tela inicial do participante mostra o nome da operação (e do grupo) antes do login anônimo.
grant execute on function public.info_operacao(text) to anon;

-- Tempo real para os painéis (o RLS continua valendo para quem assina).
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['grupos', 'grupo_membros'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end;
$$;

notify pgrst, 'reload schema';
