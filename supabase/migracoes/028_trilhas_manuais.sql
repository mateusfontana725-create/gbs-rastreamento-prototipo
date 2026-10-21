-- =====================================================================
-- 34. Trilhas desenhadas à mão no mapa (migração 028 — idempotente; exige a 003, 008, 012 e 026)
--
--  Linha (sequência ordenada de pontos) desenhada pelo responsável para registrar um
--  caminho: PLANEJADO (previsto para uma equipe) ou PERCORRIDO (informado como já feito).
--  É diferente do setor de busca (área) e do rastro do GPS (gravado pelo celular):
--  desenhar ou salvar nunca marca a trilha como percorrida — quem decide é o usuário.
--  Também não muda a situação de nenhum setor.
--
--  Leitura direta: só responsáveis da operação (RLS). Toda gravação passa por funções que
--  conferem a permissão (como setores e pontos). Operação encerrada: somente leitura
--  (gatilho da migração 026). Excluir a trilha apaga só a trilha.
--  Repetir o envio não duplica: o app gera um client_id ao começar o desenho.
-- =====================================================================

-- Confere uma linha [[lat, lng], …] com 2 a 2000 pontos.
create or replace function public.linha_valida(p jsonb)
returns boolean
language plpgsql immutable
as $$
declare
  v jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) < 2 or jsonb_array_length(p) > 2000 then
    return false;
  end if;
  for v in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) <> 2
       or jsonb_typeof(v->0) <> 'number' or jsonb_typeof(v->1) <> 'number'
       or (v->>0)::double precision not between -90 and 90
       or (v->>1)::double precision not between -180 and 180 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create table if not exists public.trilhas_manuais (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  client_id           uuid not null,                       -- gerado pelo app: repetir o envio não duplica
  nome                text not null check (char_length(btrim(nome)) between 1 and 80),
  estado              text not null check (estado in ('planejada', 'percorrida')),
  pontos              jsonb not null check (public.linha_valida(pontos)),   -- [[lat, lng], …] na ordem marcada
  comprimento_m       double precision not null default 0 check (comprimento_m >= 0),
  participante_id     uuid references public.participantes(id) on delete set null,
  grupo_id            uuid references public.grupos(id) on delete set null,
  equipe              text not null default '' check (char_length(equipe) <= 60),
  observacoes         text not null default '' check (char_length(observacoes) <= 1000),
  percorrida_em       timestamptz,                         -- informado pelo usuário ao marcar como percorrida
  percorrida_por_nome text,
  criado_por          uuid references auth.users(id) on delete set null,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text,
  constraint trilhas_manuais_cliente_unico unique (operacao_id, client_id),
  constraint trilhas_manuais_percorrida_ok check ((estado = 'percorrida') = (percorrida_em is not null))
);
create index if not exists trilhas_manuais_operacao_idx on public.trilhas_manuais (operacao_id);
-- Nome único dentro da operação (sem diferenciar maiúsculas): cada trilha se identifica pelo nome.
create unique index if not exists trilhas_manuais_nome_unico on public.trilhas_manuais (operacao_id, lower(btrim(nome)));

alter table public.trilhas_manuais enable row level security;
drop policy if exists trilhas_manuais_ler on public.trilhas_manuais;
create policy trilhas_manuais_ler on public.trilhas_manuais for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.trilhas_manuais from anon;
revoke insert, update, delete, truncate on public.trilhas_manuais from authenticated;
grant select on public.trilhas_manuais to authenticated;

-- Comprimento da linha em metros (soma dos trechos).
create or replace function public.comprimento_linha_m(p jsonb)
returns double precision
language sql stable
as $$
  select coalesce(sum(public.distancia_m((a.v->>0)::double precision, (a.v->>1)::double precision,
                                         (b.v->>0)::double precision, (b.v->>1)::double precision)), 0)
    from jsonb_array_elements(p) with ordinality a(v, i)
    join jsonb_array_elements(p) with ordinality b(v, i) on b.i = a.i + 1;
$$;

-- Cria (p_id nulo) ou altera uma trilha. Na alteração, só os campos enviados mudam.
-- p_dados: nome, estado, pontos, participante_id, grupo_id, equipe, observacoes, percorrida_em, client_id (criação).
create or replace function public.salvar_trilha_manual(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_t public.trilhas_manuais%rowtype;
  v_op public.operacoes%rowtype;
  v_ref uuid;
  v_quando timestamptz;
  v_cliente uuid;
begin
  if v_nome_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);

  if p_id is null then
    begin
      v_cliente := nullif(p_dados->>'client_id', '')::uuid;
    exception when others then
      raise exception 'dados_invalidos';
    end;
    if v_cliente is null then
      raise exception 'dados_invalidos';
    end if;
    -- mesmo envio repetido (rede instável, clique duplo): devolve a trilha já gravada
    select * into v_t from public.trilhas_manuais where operacao_id = p_operacao and client_id = v_cliente;
    if found then
      return row_to_json(v_t);
    end if;
    v_t.id := gen_random_uuid();
    v_t.operacao_id := p_operacao;
    v_t.client_id := v_cliente;
    v_t.criado_por := auth.uid();
    v_t.criado_por_nome := v_nome_resp;
    v_t.criado_em := now();
    v_t.equipe := '';
    v_t.observacoes := '';
    if not (p_dados ? 'estado') or not (p_dados ? 'pontos') or not (p_dados ? 'nome') then
      raise exception 'dados_invalidos';
    end if;
  else
    select * into v_t from public.trilhas_manuais where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'trilha_nao_encontrada';
    end if;
  end if;

  if p_dados ? 'nome' then v_t.nome := btrim(regexp_replace(coalesce(p_dados->>'nome', ''), '\s+', ' ', 'g')); end if;
  if p_dados ? 'equipe' then v_t.equipe := left(btrim(coalesce(p_dados->>'equipe', '')), 60); end if;
  if p_dados ? 'observacoes' then v_t.observacoes := left(btrim(coalesce(p_dados->>'observacoes', '')), 1000); end if;
  if p_dados ? 'participante_id' then
    v_ref := nullif(p_dados->>'participante_id', '')::uuid;
    if v_ref is not null and not exists (select 1 from public.participantes where id = v_ref and operacao_id = p_operacao) then
      raise exception 'responsavel_trajeto_invalido';
    end if;
    v_t.participante_id := v_ref;
  end if;
  if p_dados ? 'grupo_id' then
    v_ref := nullif(p_dados->>'grupo_id', '')::uuid;
    if v_ref is not null and not exists (select 1 from public.grupos where id = v_ref and operacao_id = p_operacao) then
      raise exception 'grupo_invalido';
    end if;
    v_t.grupo_id := v_ref;
  end if;
  if p_dados ? 'pontos' then
    if not public.linha_valida(p_dados->'pontos') then
      raise exception 'trilha_invalida';
    end if;
    v_t.pontos := p_dados->'pontos';
  end if;
  if p_dados ? 'estado' then
    if p_dados->>'estado' not in ('planejada', 'percorrida') then
      raise exception 'dados_invalidos';
    end if;
    v_t.estado := p_dados->>'estado';
  end if;
  -- Percorrida: o horário vem do usuário (ou agora). Planejada: sem horário de percurso.
  if v_t.estado = 'percorrida' then
    if p_dados ? 'percorrida_em' and nullif(p_dados->>'percorrida_em', '') is not null then
      begin
        v_quando := (p_dados->>'percorrida_em')::timestamptz;
      exception when others then
        raise exception 'data_invalida';
      end;
      if v_quando > now() + interval '2 minutes'
         or v_quando < coalesce(least(v_op.acionado_em, v_op.criada_em), v_op.criada_em) - interval '7 days' then
        raise exception 'data_invalida';
      end if;
      v_t.percorrida_em := least(v_quando, now());
      v_t.percorrida_por_nome := v_nome_resp;
    elsif v_t.percorrida_em is null then
      v_t.percorrida_em := now();
      v_t.percorrida_por_nome := v_nome_resp;
    end if;
  else
    v_t.percorrida_em := null;
    v_t.percorrida_por_nome := null;
  end if;

  if v_t.nome is null or char_length(v_t.nome) not between 1 and 80 then
    raise exception 'nome_trilha_invalido';
  end if;
  if v_t.pontos is null or not public.linha_valida(v_t.pontos) then
    raise exception 'trilha_invalida';
  end if;
  v_t.comprimento_m := round(public.comprimento_linha_m(v_t.pontos)::numeric, 1);
  v_t.atualizado_em := now();
  v_t.atualizado_por_nome := v_nome_resp;

  begin
    if p_id is null then
      insert into public.trilhas_manuais select v_t.*;
    else
      update public.trilhas_manuais
         set nome = v_t.nome, estado = v_t.estado, pontos = v_t.pontos, comprimento_m = v_t.comprimento_m,
             participante_id = v_t.participante_id, grupo_id = v_t.grupo_id, equipe = v_t.equipe,
             observacoes = v_t.observacoes, percorrida_em = v_t.percorrida_em, percorrida_por_nome = v_t.percorrida_por_nome,
             atualizado_em = v_t.atualizado_em, atualizado_por_nome = v_t.atualizado_por_nome
       where id = v_t.id;
    end if;
  exception when unique_violation then
    -- nome repetido; ou o mesmo client_id gravado por outra chamada simultânea
    if p_id is null and exists (select 1 from public.trilhas_manuais where operacao_id = p_operacao and client_id = v_t.client_id) then
      select * into v_t from public.trilhas_manuais where operacao_id = p_operacao and client_id = v_t.client_id;
      return row_to_json(v_t);
    end if;
    raise exception 'nome_repetido';
  end;
  return row_to_json(v_t);
end;
$$;

-- Excluir: quem criou a trilha, quem criou a operação ou um administrador (como setores e pontos).
create or replace function public.excluir_trilha_manual(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.trilhas_manuais%rowtype;
begin
  select * into v from public.trilhas_manuais where id = p_id;
  if not found or not public.pode_excluir_registro(v.operacao_id, v.criado_por) then
    raise exception 'sem_permissao';
  end if;
  delete from public.trilhas_manuais where id = p_id;
end;
$$;

revoke execute on function public.salvar_trilha_manual(uuid, uuid, jsonb), public.excluir_trilha_manual(uuid) from public, anon;
grant execute on function public.salvar_trilha_manual(uuid, uuid, jsonb), public.excluir_trilha_manual(uuid) to authenticated;

-- Operação encerrada: somente leitura (mesmo gatilho dos setores e pontos, migração 026).
drop trigger if exists trilhas_manuais_encerrada on public.trilhas_manuais;
create trigger trilhas_manuais_encerrada before insert or update or delete on public.trilhas_manuais
  for each row execute function public.bloquear_escrita_encerrada();

-- Diário: entra quando um trajeto é informado como PERCORRIDO e quando uma trilha é excluída.
-- (Trilha só planejada não é um fato da busca; não entra no diário.)
create or replace function public.diario_de_trilha_manual()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_det text;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.operacoes where id = old.operacao_id and dados_apagados_em is null) then
      perform public.diario_auto(old.operacao_id, now(), 'deslocamento', 'trilha_excluida',
        'Trilha desenhada excluída: ' || old.nome, '', 'trilha_excluida:' || old.id, 'info', null, null, old.id::text, null);
    end if;
    return old;
  end if;
  if new.estado = 'percorrida' and (tg_op = 'INSERT' or old.estado is distinct from 'percorrida') then
    v_det := concat_ws(' · ', round(new.comprimento_m)::bigint || ' m', nullif(new.equipe, ''),
                       (select 'Grupo ' || nome from public.grupos where id = new.grupo_id),
                       (select nome from public.participantes where id = new.participante_id), nullif(new.observacoes, ''));
    perform public.diario_auto(new.operacao_id, new.percorrida_em, 'deslocamento', 'trilha_percorrida',
      'Trajeto percorrido (desenhado): ' || new.nome, v_det,
      'trilha_percorrida:' || new.id || ':' || extract(epoch from new.percorrida_em)::bigint, 'info',
      (new.pontos->0->>0)::double precision, (new.pontos->0->>1)::double precision, new.id::text, new.percorrida_por_nome);
  end if;
  return new;
end;
$$;
revoke execute on function public.diario_de_trilha_manual() from public, anon, authenticated;
drop trigger if exists trilhas_manuais_diario on public.trilhas_manuais;
create trigger trilhas_manuais_diario after insert or update of estado or delete on public.trilhas_manuais
  for each row execute function public.diario_de_trilha_manual();

-- Dados da operação apagados (retenção antiga): as trilhas desenhadas saem junto com setores e pontos.
create or replace function public.apagar_trilhas_manuais_da_operacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.trilhas_manuais where operacao_id = new.id;
  end if;
  return new;
end;
$$;
revoke execute on function public.apagar_trilhas_manuais_da_operacao() from public, anon, authenticated;
drop trigger if exists operacoes_apagar_trilhas_manuais on public.operacoes;
create trigger operacoes_apagar_trilhas_manuais after update of dados_apagados_em on public.operacoes
  for each row execute function public.apagar_trilhas_manuais_da_operacao();

-- Tempo real: trilhas no painel da operação; operações no mapa do dashboard
-- (cada responsável só recebe as mudanças das operações que pode ler — RLS).
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['trilhas_manuais', 'operacoes'] loop
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
