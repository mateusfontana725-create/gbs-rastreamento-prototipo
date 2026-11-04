-- =====================================================================
-- 061 · Áreas proibidas (migração idempotente; exige linha_valida (028), dono_operacao e o arquivamento (055))
--
-- Polígonos desenhados no mapa do painel para marcar áreas que a equipe NÃO deve entrar
-- (risco, propriedade sem permissão, área interditada etc.). Não são setores de busca:
-- não entram em POA, POD, missões nem na contagem de cobertura.
--
-- Escrita só por RPC (salvar_area_proibida, excluir_area_proibida). Encerrada: só leitura.
-- Ao excluir a operação, as áreas saem junto. O arquivamento (055) pega a tabela pelo catálogo.
-- =====================================================================

create table if not exists public.areas_proibidas (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  nome                text not null check (char_length(btrim(nome)) between 1 and 80),
  pontos              jsonb not null check (public.linha_valida(pontos)),   -- [[lat, lng], …] (vértices do polígono)
  motivo              text not null default '' check (char_length(motivo) <= 500),
  criado_por          uuid references auth.users(id) on delete set null,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text,
  constraint areas_proibidas_vertices check (jsonb_array_length(pontos) >= 3)
);
create index if not exists areas_proibidas_operacao_idx on public.areas_proibidas (operacao_id);

alter table public.areas_proibidas enable row level security;
drop policy if exists areas_proibidas_ler on public.areas_proibidas;
create policy areas_proibidas_ler on public.areas_proibidas for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.areas_proibidas from anon;
revoke insert, update, delete, truncate on public.areas_proibidas from authenticated;
grant select on public.areas_proibidas to authenticated;

-- Cria (p_id nulo) ou altera uma área. Na alteração, só os campos enviados mudam.
-- p_dados: nome, pontos, motivo.
create or replace function public.salvar_area_proibida(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_a public.areas_proibidas%rowtype;
  v_op public.operacoes%rowtype;
begin
  if v_nome_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if p_dados is null or jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if not found or v_op.dados_apagados_em is not null then
    raise exception 'sem_permissao';
  end if;

  if p_id is null then
    insert into public.areas_proibidas (operacao_id, nome, pontos, motivo, criado_por, criado_por_nome, atualizado_por_nome)
    values (p_operacao,
            btrim(coalesce(p_dados->>'nome', '')),
            coalesce(p_dados->'pontos', 'null'::jsonb),
            btrim(coalesce(p_dados->>'motivo', '')),
            auth.uid(), v_nome_resp, v_nome_resp)
    returning * into v_a;
  else
    select * into v_a from public.areas_proibidas where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'sem_permissao';
    end if;
    update public.areas_proibidas
       set nome = case when p_dados ? 'nome' then btrim(coalesce(p_dados->>'nome', '')) else nome end,
           pontos = case when p_dados ? 'pontos' then p_dados->'pontos' else pontos end,
           motivo = case when p_dados ? 'motivo' then btrim(coalesce(p_dados->>'motivo', '')) else motivo end,
           atualizado_em = now(), atualizado_por_nome = v_nome_resp
     where id = p_id
    returning * into v_a;
  end if;
  return row_to_json(v_a);
end;
$$;

-- Excluir: quem desenhou, quem criou a operação ou um administrador.
create or replace function public.excluir_area_proibida(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.areas_proibidas%rowtype;
begin
  select * into v from public.areas_proibidas where id = p_id;
  if not found or not public.pode_excluir_registro(v.operacao_id, v.criado_por) then
    raise exception 'sem_permissao';
  end if;
  delete from public.areas_proibidas where id = p_id;
end;
$$;

revoke execute on function public.salvar_area_proibida(uuid, uuid, jsonb), public.excluir_area_proibida(uuid) from public, anon;
grant execute on function public.salvar_area_proibida(uuid, uuid, jsonb), public.excluir_area_proibida(uuid) to authenticated;

-- Encerrada: só leitura (mesmo gatilho das trilhas à mão). Arquivamento passa pelo gatilho sem travas.
drop trigger if exists areas_proibidas_encerrada on public.areas_proibidas;
create trigger areas_proibidas_encerrada before insert or update or delete on public.areas_proibidas
  for each row execute function public.bloquear_escrita_encerrada();

-- Excluir a operação apaga as áreas (como as trilhas à mão).
create or replace function public.apagar_areas_proibidas_da_operacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return new;
  end if;
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.areas_proibidas where operacao_id = new.id;
  end if;
  return new;
end;
$$;
revoke execute on function public.apagar_areas_proibidas_da_operacao() from public, anon, authenticated;
drop trigger if exists operacoes_apagar_areas_proibidas on public.operacoes;
create trigger operacoes_apagar_areas_proibidas after update of dados_apagados_em on public.operacoes
  for each row execute function public.apagar_areas_proibidas_da_operacao();

-- Tempo real: o painel de outros responsáveis atualiza a área na hora.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.areas_proibidas';
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;
