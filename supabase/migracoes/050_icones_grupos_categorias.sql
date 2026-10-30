-- =====================================================================
-- 050 — Ícones livres: grupos com ícone e categorias fixas de ponto com ícone e cor escolhidos.
--
--  grupos.icone: opcional (1 a 8 caracteres: emoji, letra ou sigla); salvar_grupo aceita "icone" (vazio tira).
--  categorias_ponto_estilo: ícone e cor de cada categoria fixa (Última localização, Risco, Base…), para todas as
--  operações. As regras de cada categoria (alarme de risco, raio da base, vítima) não mudam, só a aparência.
--  salvar_estilo_categoria(categoria, icone, cor): qualquer responsável; icone e cor nulos = volta ao padrão.
-- =====================================================================

alter table public.grupos add column if not exists icone text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'grupos_icone_ok') then
    alter table public.grupos add constraint grupos_icone_ok check (icone is null or char_length(icone) between 1 and 8);
  end if;
end $$;

-- salvar_grupo: igual à 036, com o ícone
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
    v.disponibilidade := 'disponivel';
    v.disponibilidade_obs := '';
    v.capacidades := '';
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
  if p_dados ? 'icone' then v.icone := nullif(btrim(coalesce(p_dados->>'icone', '')), ''); end if;
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
  if v.icone is not null and char_length(v.icone) > 8 then
    raise exception 'icone_invalido';
  end if;

  v.atualizado_em := now();
  v.atualizado_por_nome := v_nome_resp;
  begin
    if p_id is null then
      insert into public.grupos select v.*;
      insert into public.grupo_convites (grupo_id, operacao_id, token, criado_por_nome)
      values (v.id, v.operacao_id, public.gerar_token(), v_nome_resp);
    else
      update public.grupos set nome = v.nome, cor = v.cor, icone = v.icone, permite_militar = v.permite_militar,
             atualizado_em = v.atualizado_em, atualizado_por_nome = v.atualizado_por_nome
       where id = v.id;
    end if;
  exception when unique_violation then
    raise exception 'grupo_existente';
  end;
  return row_to_json(v);
end;
$$;

-- ---------------------------------------------------------------------
-- Aparência das categorias fixas de ponto
-- ---------------------------------------------------------------------
create table if not exists public.categorias_ponto_estilo (
  categoria        text primary key check (categoria in ('ULTIMA_LOCALIZACAO', 'POSSIVEL_LOCALIZACAO', 'VESTIGIO', 'RISCO', 'ENCONTRO',
                                                         'VITIMA_ENCONTRADA', 'BASE', 'OUTRO')),
  icone            text check (icone is null or char_length(icone) between 1 and 8),
  cor              text check (cor is null or cor ~ '^#[0-9a-f]{6}$'),
  atualizado_por_nome text not null,
  atualizado_em    timestamptz not null default now()
);
alter table public.categorias_ponto_estilo enable row level security;
drop policy if exists categorias_ponto_estilo_ler on public.categorias_ponto_estilo;
create policy categorias_ponto_estilo_ler on public.categorias_ponto_estilo for select to authenticated using (public.nome_responsavel_atual() is not null);
revoke all on public.categorias_ponto_estilo from anon;
revoke insert, update, delete, truncate on public.categorias_ponto_estilo from authenticated;
grant select on public.categorias_ponto_estilo to authenticated;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'categorias_ponto_estilo') then
    execute 'alter publication supabase_realtime add table public.categorias_ponto_estilo';
  end if;
end $$;

create or replace function public.salvar_estilo_categoria(p_categoria text, p_icone text, p_cor text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_icone text := nullif(btrim(coalesce(p_icone, '')), '');
  v_cor text := nullif(lower(btrim(coalesce(p_cor, ''))), '');
  v public.categorias_ponto_estilo%rowtype;
begin
  if v_nome is null then
    raise exception 'sem_permissao';
  end if;
  if p_categoria is null or p_categoria not in ('ULTIMA_LOCALIZACAO', 'POSSIVEL_LOCALIZACAO', 'VESTIGIO', 'RISCO', 'ENCONTRO', 'VITIMA_ENCONTRADA', 'BASE', 'OUTRO') then
    raise exception 'dados_invalidos';
  end if;
  if (v_icone is not null and char_length(v_icone) > 8) or (v_cor is not null and v_cor !~ '^#[0-9a-f]{6}$') then
    raise exception 'icone_invalido';
  end if;
  if v_icone is null and v_cor is null then
    delete from public.categorias_ponto_estilo where categoria = p_categoria;   -- volta ao padrão do aplicativo
    return json_build_object('categoria', p_categoria, 'icone', null, 'cor', null);
  end if;
  insert into public.categorias_ponto_estilo (categoria, icone, cor, atualizado_por_nome, atualizado_em)
  values (p_categoria, v_icone, v_cor, v_nome, now())
  on conflict (categoria) do update set icone = excluded.icone, cor = excluded.cor,
    atualizado_por_nome = excluded.atualizado_por_nome, atualizado_em = excluded.atualizado_em
  returning * into v;
  return row_to_json(v);
end;
$$;

revoke execute on function public.salvar_estilo_categoria(text, text, text) from public, anon;
grant execute on function public.salvar_estilo_categoria(text, text, text) to authenticated;

notify pgrst, 'reload schema';
