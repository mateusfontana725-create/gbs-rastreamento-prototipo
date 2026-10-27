-- =====================================================================
-- 42. Recursos e disponibilidade das equipes (migração 036 — idempotente; exige a 008, a 012 e a 026)
--
--  Cada equipe (grupo) passa a ter:
--    • disponibilidade informada pelo comando: disponivel, em_descanso ou indisponivel (com observação e,
--      se souber, a hora em que volta a ficar disponível). "Em missão" não é digitado: o painel deduz do
--      deslocamento ativo (missões), para nunca ficar desatualizado;
--    • capacidades (texto livre: mergulho, APH avançado, busca em altura…);
--    • recursos (grupo_recursos): embarcação, viatura, drone, cão de busca, equipamento de comunicação,
--      primeiros socorros ou outro, cada um com identificação, quantidade e situação
--      (operacional, limitado, indisponivel).
--  salvar_recursos_grupo grava tudo de uma vez (substitui a lista de recursos) e registra no diário.
--  Leitura dos recursos só pelos responsáveis da operação; escrita só pela função. Encerrada: somente leitura.
-- =====================================================================
alter table public.grupos add column if not exists disponibilidade text not null default 'disponivel';
alter table public.grupos add column if not exists disponibilidade_obs text not null default '';
alter table public.grupos add column if not exists disponivel_em timestamptz;
alter table public.grupos add column if not exists capacidades text not null default '';
alter table public.grupos add column if not exists recursos_atualizado_em timestamptz;
alter table public.grupos add column if not exists recursos_atualizado_por_nome text;
do $$
begin
  alter table public.grupos add constraint grupos_disponibilidade_ok check (
    disponibilidade in ('disponivel', 'em_descanso', 'indisponivel')
    and char_length(disponibilidade_obs) <= 200 and char_length(capacidades) <= 300);
exception when duplicate_object then null;
end;
$$;

create table if not exists public.grupo_recursos (
  id             uuid primary key default gen_random_uuid(),
  grupo_id       uuid not null references public.grupos(id) on delete cascade,
  operacao_id    uuid not null references public.operacoes(id) on delete cascade,
  tipo           text not null check (tipo in ('embarcacao', 'viatura', 'drone', 'cao_busca', 'comunicacao', 'primeiros_socorros', 'outro')),
  identificacao  text not null default '' check (char_length(identificacao) <= 60),
  quantidade     integer not null default 1 check (quantidade between 1 and 99),
  situacao       text not null default 'operacional' check (situacao in ('operacional', 'limitado', 'indisponivel')),
  observacao     text not null default '' check (char_length(observacao) <= 200),
  criado_em      timestamptz not null default now()
);
create index if not exists grupo_recursos_grupo_idx on public.grupo_recursos (grupo_id);
create index if not exists grupo_recursos_operacao_idx on public.grupo_recursos (operacao_id);

alter table public.grupo_recursos enable row level security;
drop policy if exists grupo_recursos_ler on public.grupo_recursos;
create policy grupo_recursos_ler on public.grupo_recursos for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.grupo_recursos from anon;
revoke insert, update, delete, truncate on public.grupo_recursos from authenticated;
grant select on public.grupo_recursos to authenticated;

drop trigger if exists grupo_recursos_encerrada on public.grupo_recursos;
create trigger grupo_recursos_encerrada before insert or update or delete on public.grupo_recursos
  for each row execute function public.bloquear_escrita_encerrada();

-- salvar_grupo copia uma linha inteira (select v.*): as colunas novas precisam de valor inicial, senão entram nulas.
-- (mesma função da migração 008, só com os valores iniciais de disponibilidade e capacidades)
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

-- Rótulos para o diário (uso interno)
create or replace function public.recurso_rotulo(p_tipo text)
returns text
language sql immutable
as $$
  select case p_tipo when 'embarcacao' then 'embarcação' when 'viatura' then 'viatura' when 'drone' then 'drone'
                     when 'cao_busca' then 'cão de busca' when 'comunicacao' then 'equipamento de comunicação'
                     when 'primeiros_socorros' then 'primeiros socorros' else 'outro recurso' end;
$$;

-- p_dados: disponibilidade ('disponivel' | 'em_descanso' | 'indisponivel'), disponibilidade_obs, disponivel_em (hora ou nulo),
--          capacidades, recursos [{ tipo, identificacao, quantidade, situacao, observacao }] (até 30). Só as chaves enviadas mudam
--          (se "recursos" vier, a lista inteira é substituída).
create or replace function public.salvar_recursos_grupo(p_grupo uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_g public.grupos%rowtype;
  v_status text;
  v_disp text;
  v_obs text;
  v_cap text;
  v_volta timestamptz;
  v_rec jsonb;
  v_it jsonb;
  v_tipo text;
  v_qtd integer;
  v_sit text;
  v_resumo text;
  v_mudou_disp boolean;
begin
  select * into v_g from public.grupos where id = p_grupo for update;
  if not found then
    raise exception 'grupo_inexistente';
  end if;
  if v_nome is null or not public.dono_operacao(v_g.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_g.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  v_disp := coalesce(nullif(p_dados->>'disponibilidade', ''), v_g.disponibilidade);
  if v_disp not in ('disponivel', 'em_descanso', 'indisponivel') then
    raise exception 'dados_invalidos';
  end if;
  v_obs := case when p_dados ? 'disponibilidade_obs' then left(btrim(coalesce(p_dados->>'disponibilidade_obs', '')), 200) else v_g.disponibilidade_obs end;
  v_cap := case when p_dados ? 'capacidades' then left(btrim(coalesce(p_dados->>'capacidades', '')), 300) else v_g.capacidades end;
  begin
    v_volta := case when p_dados ? 'disponivel_em' then nullif(p_dados->>'disponivel_em', '')::timestamptz else v_g.disponivel_em end;
  exception when others then
    raise exception 'dados_invalidos';
  end;
  v_rec := p_dados->'recursos';
  if v_rec is not null and (jsonb_typeof(v_rec) <> 'array' or jsonb_array_length(v_rec) > 30) then
    raise exception 'dados_invalidos';
  end if;
  -- valida a lista inteira antes de gravar
  if v_rec is not null then
    for v_it in select * from jsonb_array_elements(v_rec) loop
      if jsonb_typeof(v_it) <> 'object' then
        raise exception 'dados_invalidos';
      end if;
      begin
        v_qtd := coalesce(nullif(v_it->>'quantidade', '')::integer, 1);
      exception when others then
        raise exception 'dados_invalidos';
      end;
      if coalesce(v_it->>'tipo', '') not in ('embarcacao', 'viatura', 'drone', 'cao_busca', 'comunicacao', 'primeiros_socorros', 'outro')
         or v_qtd not between 1 and 99
         or coalesce(nullif(v_it->>'situacao', ''), 'operacional') not in ('operacional', 'limitado', 'indisponivel') then
        raise exception 'dados_invalidos';
      end if;
    end loop;
  end if;

  v_mudou_disp := v_disp is distinct from v_g.disponibilidade or v_obs is distinct from v_g.disponibilidade_obs;
  update public.grupos
     set disponibilidade = v_disp, disponibilidade_obs = v_obs, disponivel_em = v_volta, capacidades = v_cap,
         recursos_atualizado_em = now(), recursos_atualizado_por_nome = v_nome
   where id = p_grupo
   returning * into v_g;

  if v_rec is not null then
    delete from public.grupo_recursos where grupo_id = p_grupo;
    for v_it in select * from jsonb_array_elements(v_rec) loop
      insert into public.grupo_recursos (grupo_id, operacao_id, tipo, identificacao, quantidade, situacao, observacao)
      values (p_grupo, v_g.operacao_id, v_it->>'tipo', left(btrim(coalesce(v_it->>'identificacao', '')), 60),
              coalesce(nullif(v_it->>'quantidade', '')::integer, 1), coalesce(nullif(v_it->>'situacao', ''), 'operacional'),
              left(btrim(coalesce(v_it->>'observacao', '')), 200));
    end loop;
    select string_agg(public.recurso_rotulo(r.tipo) || case when r.quantidade > 1 then ' ×' || r.quantidade else '' end ||
                      case when r.identificacao <> '' then ' (' || r.identificacao || ')' else '' end ||
                      case when r.situacao <> 'operacional' then ' — ' || r.situacao else '' end, '; ' order by r.tipo, r.identificacao)
      into v_resumo from public.grupo_recursos r where r.grupo_id = p_grupo;
  end if;

  perform public.diario_auto(v_g.operacao_id, now(), 'pessoa', 'equipe_recursos',
    'Equipe ' || v_g.nome || ': ' || case when v_mudou_disp then 'disponibilidade ' ||
      case v_disp when 'disponivel' then 'disponível' when 'em_descanso' then 'em descanso' else 'INDISPONÍVEL' end else 'recursos atualizados' end,
    coalesce('Recursos: ' || nullif(v_resumo, ''), case when v_rec is not null then 'Recursos: nenhum registrado' end, '') ||
      case when v_obs <> '' then '. Observação: ' || v_obs else '' end ||
      case when v_cap <> '' then '. Capacidades: ' || v_cap else '' end ||
      case when v_volta is not null and v_disp <> 'disponivel' then '. Volta a ficar disponível: ' || to_char(v_volta at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') else '' end,
    'equipe_recursos:' || p_grupo || ':' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint, 'info', null, null, p_grupo::text, v_nome);

  return json_build_object('grupo', row_to_json(v_g),
    'recursos', coalesce((select json_agg(row_to_json(r) order by r.tipo, r.identificacao) from public.grupo_recursos r where r.grupo_id = p_grupo), '[]'::json));
end;
$$;

revoke execute on function public.recurso_rotulo(text) from public, anon, authenticated;
revoke execute on function public.salvar_recursos_grupo(uuid, jsonb) from public, anon;
grant execute on function public.salvar_recursos_grupo(uuid, jsonb) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.grupo_recursos;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

notify pgrst, 'reload schema';
