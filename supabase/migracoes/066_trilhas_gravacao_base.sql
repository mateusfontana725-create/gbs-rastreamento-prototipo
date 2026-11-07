-- =====================================================================
-- 066 · Trilhas: gravação por participante, raio da base sem gravação e áreas para ocultar trilhas
--       (migração idempotente; exige a 009 (trilha com confirmação), a 010 (BASE e missões) e a 061 (padrão das áreas))
--
--  1. participantes.gravar_trilha: o responsável desliga a gravação da trilha de UMA pessoa
--     (definir_gravacao_trilha). Os pontos continuam sendo confirmados ao aparelho (saem da fila dele) e a
--     posição atual segue aparecendo; só não entram na trilha (posicoes). O sinal de vida e o envio de pontos
--     devolvem gravar_trilha ao aparelho.
--  2. Raio da BASE (pontos_interesse.raio_m, padrão 50 m): dentro dele a trilha não é gravada. Fica guardado só o
--     ponto de ENTRADA (posicoes.na_base = true), para a chegada à base continuar sendo detectada pelas missões;
--     os demais pontos dentro do raio são confirmados ao aparelho e descartados. O painel não desenha os pontos
--     na_base na linha da trilha.
--  3. areas_sem_trilha: círculos (raio editável, padrão 50 m) em que o painel não desenha as trilhas. Só afeta o
--     desenho; nada é apagado. Escrita só por RPC; encerrada: só leitura.
-- =====================================================================

alter table public.participantes add column if not exists gravar_trilha boolean not null default true;
alter table public.posicoes add column if not exists na_base boolean not null default false;

-- Liga ou desliga a gravação da trilha de um participante (só responsáveis da operação; operação ativa).
create or replace function public.definir_gravacao_trilha(p_participante uuid, p_gravar boolean)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
begin
  if p_gravar is null then
    raise exception 'dados_invalidos';
  end if;
  select * into v_part from public.participantes where id = p_participante;
  if not found or public.nome_responsavel_atual() is null or not public.dono_operacao(v_part.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  if v_op.status <> 'ativa' or v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  update public.participantes set gravar_trilha = p_gravar where id = v_part.id;
  return json_build_object('id', v_part.id, 'gravar_trilha', p_gravar);
end;
$$;
revoke execute on function public.definir_gravacao_trilha(uuid, boolean) from public, anon;
grant execute on function public.definir_gravacao_trilha(uuid, boolean) to authenticated;

-- Áreas em que o painel oculta as trilhas (só o desenho).
create table if not exists public.areas_sem_trilha (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  nome                text not null default '' check (char_length(nome) <= 80),
  lat                 double precision not null check (lat between -90 and 90),
  lng                 double precision not null check (lng between -180 and 180),
  raio_m              double precision not null default 50 check (raio_m between 5 and 5000),
  ativa               boolean not null default true,
  criado_por          uuid references auth.users(id) on delete set null,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text
);
create index if not exists areas_sem_trilha_operacao_idx on public.areas_sem_trilha (operacao_id);

alter table public.areas_sem_trilha enable row level security;
drop policy if exists areas_sem_trilha_ler on public.areas_sem_trilha;
create policy areas_sem_trilha_ler on public.areas_sem_trilha for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.areas_sem_trilha from anon;
revoke insert, update, delete, truncate on public.areas_sem_trilha from authenticated;
grant select on public.areas_sem_trilha to authenticated;

-- Cria (p_id nulo) ou altera. p_dados: nome, lat, lng, raio_m, ativa. Na alteração, só os campos enviados mudam.
create or replace function public.salvar_area_sem_trilha(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_a public.areas_sem_trilha%rowtype;
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
    insert into public.areas_sem_trilha (operacao_id, nome, lat, lng, raio_m, ativa, criado_por, criado_por_nome, atualizado_por_nome)
    values (p_operacao, btrim(coalesce(p_dados->>'nome', '')),
            (p_dados->>'lat')::double precision, (p_dados->>'lng')::double precision,
            coalesce(nullif(p_dados->>'raio_m', '')::double precision, 50),
            coalesce((p_dados->>'ativa')::boolean, true),
            auth.uid(), v_nome_resp, v_nome_resp)
    returning * into v_a;
  else
    select * into v_a from public.areas_sem_trilha where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'sem_permissao';
    end if;
    update public.areas_sem_trilha
       set nome = case when p_dados ? 'nome' then btrim(coalesce(p_dados->>'nome', '')) else nome end,
           lat = case when p_dados ? 'lat' then (p_dados->>'lat')::double precision else lat end,
           lng = case when p_dados ? 'lng' then (p_dados->>'lng')::double precision else lng end,
           raio_m = case when p_dados ? 'raio_m' then (p_dados->>'raio_m')::double precision else raio_m end,
           ativa = case when p_dados ? 'ativa' then (p_dados->>'ativa')::boolean else ativa end,
           atualizado_em = now(), atualizado_por_nome = v_nome_resp
     where id = p_id
    returning * into v_a;
  end if;
  return row_to_json(v_a);
end;
$$;

create or replace function public.excluir_area_sem_trilha(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.areas_sem_trilha%rowtype;
begin
  select * into v from public.areas_sem_trilha where id = p_id;
  if not found or not public.pode_excluir_registro(v.operacao_id, v.criado_por) then
    raise exception 'sem_permissao';
  end if;
  delete from public.areas_sem_trilha where id = p_id;
end;
$$;

revoke execute on function public.salvar_area_sem_trilha(uuid, uuid, jsonb), public.excluir_area_sem_trilha(uuid) from public, anon;
grant execute on function public.salvar_area_sem_trilha(uuid, uuid, jsonb), public.excluir_area_sem_trilha(uuid) to authenticated;

drop trigger if exists areas_sem_trilha_encerrada on public.areas_sem_trilha;
create trigger areas_sem_trilha_encerrada before insert or update or delete on public.areas_sem_trilha
  for each row execute function public.bloquear_escrita_encerrada();

create or replace function public.apagar_areas_sem_trilha_da_operacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return new;
  end if;
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.areas_sem_trilha where operacao_id = new.id;
  end if;
  return new;
end;
$$;
revoke execute on function public.apagar_areas_sem_trilha_da_operacao() from public, anon, authenticated;
drop trigger if exists operacoes_apagar_areas_sem_trilha on public.operacoes;
create trigger operacoes_apagar_areas_sem_trilha after update of dados_apagados_em on public.operacoes
  for each row execute function public.apagar_areas_sem_trilha_da_operacao();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.areas_sem_trilha';
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

-- Lote de posições: a trilha só é gravada fora do raio da base e com a gravação da pessoa ligada.
create or replace function public.enviar_posicoes_lote(p_participante uuid, p_pontos jsonb, p_gps text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
  v_inseridos integer := 0;
  v_ult record;
  v_ids uuid[];
  v_lats double precision[];
  v_lngs double precision[];
  v_precs real[];
  v_ts timestamptz[];
  v_recusados jsonb;
  v_confirmados json := '[]'::json;
  v_descartados uuid[] := '{}';
  v_flag_ult boolean;
  v_na_base boolean;
  v_gravar boolean;
  v_n integer;
  v_lote_lat double precision;
  v_lote_lng double precision;
  v_lote_prec real;
  v_lote_t timestamptz;
  r record;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found then
    raise exception 'participante_invalido';
  end if;
  if v_part.liberado_em is not null then
    raise exception 'participante_liberado';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
  end if;
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  if v_op.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_pontos is null or jsonb_typeof(p_pontos) <> 'array' or jsonb_array_length(p_pontos) > 500 then
    raise exception 'lote_invalido';
  end if;

  -- Classifica cada ponto (conversões protegidas por CASE: um ponto malformado
  -- não derruba o lote).
  with numericos as (
    select case when jsonb_typeof(e) = 'object' then left(e ->> 'id', 64) end as id_txt,
           case when jsonb_typeof(e) = 'object'
                 and coalesce(e ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (e ->> 'id')::uuid end as client_id,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'lat') = 'number' then (e -> 'lat')::numeric end as lat,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'lng') = 'number' then (e -> 'lng')::numeric end as lng,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'prec') = 'number' then (e -> 'prec')::numeric end as prec,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 't') = 'number' then (e -> 't')::numeric end as t
      from jsonb_array_elements(p_pontos) as e
  ), validos as (
    select id_txt, client_id,
           case when lat between -90 and 90 then lat::double precision end as lat,
           case when lng between -180 and 180 then lng::double precision end as lng,
           case when prec between 0 and 100000 then prec::real end as prec,
           case when t between 946684800000 and 4102444800000
                then to_timestamp((t / 1000)::double precision) end as registrado_em
      from numericos
  ), classificados as (
    select *,
           case when client_id is null or lat is null or lng is null or (lat = 0 and lng = 0) or registrado_em is null then 'invalido'
                when registrado_em not between v_op.criada_em - interval '10 minutes' and now() + interval '2 minutes' then 'fora_do_periodo'
           end as motivo
      from validos
  )
  select array_agg(client_id order by registrado_em) filter (where motivo is null),
         array_agg(lat order by registrado_em) filter (where motivo is null),
         array_agg(lng order by registrado_em) filter (where motivo is null),
         array_agg(prec order by registrado_em) filter (where motivo is null),
         array_agg(registrado_em order by registrado_em) filter (where motivo is null),
         coalesce(jsonb_agg(jsonb_build_object('id', id_txt, 'motivo', motivo)) filter (where motivo is not null), '[]'::jsonb)
    into v_ids, v_lats, v_lngs, v_precs, v_ts, v_recusados
    from classificados;

  if v_ids is not null then
    -- Último ponto do lote (para a posição atual, mesmo que ele não vá para a trilha).
    v_lote_lat := v_lats[cardinality(v_lats)];
    v_lote_lng := v_lngs[cardinality(v_lngs)];
    v_lote_prec := v_precs[cardinality(v_precs)];
    v_lote_t := v_ts[cardinality(v_ts)];
    v_flag_ult := coalesce((select p.na_base from public.posicoes p where p.participante_id = v_part.id
                             order by p.registrado_em desc, p.id desc limit 1), false);
    for r in select u.cid, u.la, u.ln, u.pr, u.t
               from unnest(v_ids, v_lats, v_lngs, v_precs, v_ts) with ordinality as u(cid, la, ln, pr, t, ord)
              order by u.t, u.ord loop
      -- Dentro do raio de uma BASE (padrão 50 m) a trilha não é gravada: só o ponto de ENTRADA fica guardado
      -- (marcado na_base), para a chegada à base continuar sendo detectada pelas missões. Gravação desligada
      -- para esta pessoa (definir_gravacao_trilha): nenhum ponto vai para a trilha.
      v_na_base := exists (select 1 from public.pontos_interesse b
                            where b.operacao_id = v_op.id and b.categoria = 'BASE'
                              and public.distancia_m(b.lat, b.lng, r.la, r.ln) <= coalesce(b.raio_m, 50));
      if not v_part.gravar_trilha then
        v_gravar := false;
      elsif v_na_base then
        v_gravar := not v_flag_ult
          or exists (select 1 from public.missao_membros mb join public.missoes m on m.id = mb.missao_id
                      where mb.participante_id = v_part.id and mb.chegou_base_em is null
                        and m.base_lat is not null and m.status not in ('encerrada', 'na_base')
                        and public.distancia_m(m.base_lat, m.base_lng, r.la, r.ln) <= m.raio_base_m);
      else
        v_gravar := true;
      end if;
      if v_gravar then
        insert into public.posicoes (operacao_id, participante_id, client_id, lat, lng, precisao, registrado_em, na_base)
        values (v_op.id, v_part.id, r.cid, r.la, r.ln, r.pr, r.t, v_na_base)
        on conflict (participante_id, client_id) do nothing;
        get diagnostics v_n = row_count;
        v_inseridos := v_inseridos + v_n;
        if v_n > 0 then v_flag_ult := v_na_base; end if;
      else
        v_descartados := v_descartados || r.cid;
      end if;
    end loop;

    -- Confirmados: os que EXISTEM no servidor agora (inseridos neste envio ou antes) e os que não vão para a
    -- trilha (o aparelho pode apagá-los da fila: reenviar não adiantaria).
    select coalesce(json_agg(x.cid), '[]'::json) into v_confirmados
      from (select p.client_id as cid from public.posicoes p
             where p.participante_id = v_part.id and p.client_id = any (v_ids)
            union
            select d from unnest(v_descartados) as d) x;
  end if;

  select lat, lng, precisao, registrado_em into v_ult
    from public.posicoes
   where participante_id = v_part.id
   order by registrado_em desc
   limit 1;

  update public.participantes
     set ultimo_contato_em = now(),
         rastreando = true,
         gps_estado = case when p_gps in ('ok', 'fraco', 'sem_sinal', 'negado', 'indisponivel') then p_gps
                           when v_inseridos > 0 or cardinality(v_descartados) > 0 then 'ok'
                           else gps_estado end,
         ultima_lat = case when v_lote_t is not null and (v_ult.registrado_em is null or v_lote_t > v_ult.registrado_em) then v_lote_lat
                           else coalesce(v_ult.lat, ultima_lat) end,
         ultima_lng = case when v_lote_t is not null and (v_ult.registrado_em is null or v_lote_t > v_ult.registrado_em) then v_lote_lng
                           else coalesce(v_ult.lng, ultima_lng) end,
         ultima_precisao = case when v_lote_t is not null and (v_ult.registrado_em is null or v_lote_t > v_ult.registrado_em) then v_lote_prec
                                when v_ult.registrado_em is not null then v_ult.precisao else ultima_precisao end,
         ultima_posicao_em = case when v_lote_t is not null and (v_ult.registrado_em is null or v_lote_t > v_ult.registrado_em) then v_lote_t
                                  else coalesce(v_ult.registrado_em, ultima_posicao_em) end
   where id = v_part.id;

  if v_inseridos > 0 then
    begin
      perform public.apos_posicoes(v_part.id);
    exception when others then
      raise warning 'apos_posicoes: %', sqlerrm;   -- nunca impede a gravação das posições
    end;
  end if;

  return json_build_object(
    'status', 'ativa',
    'recebidos', jsonb_array_length(p_pontos),
    'inseridos', v_inseridos,
    'confirmados', v_confirmados,
    'recusados', v_recusados,
    'gps_intervalo_s', v_op.gps_intervalo_s,
    'gps_lacuna_s', v_op.gps_lacuna_s,
    'gravar_trilha', v_part.gravar_trilha
  );
end;
$$;

-- Sinal de vida: também informa se a gravação da trilha está ligada.
create or replace function public.sinal_vida(p_participante uuid, p_rastreando boolean, p_gps text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found then
    return json_build_object('status', 'inexistente');
  end if;
  if v_part.liberado_em is not null then
    return json_build_object('status', 'liberado');
  end if;
  if v_part.removido then
    return json_build_object('status', 'removido');
  end if;
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  if v_op.status <> 'ativa' then
    return json_build_object('status', 'encerrada');
  end if;

  update public.participantes
     set ultimo_contato_em = now(),
         rastreando = coalesce(p_rastreando, rastreando),
         gps_estado = case when p_gps in ('aguardando', 'ok', 'fraco', 'sem_sinal', 'negado', 'indisponivel') then p_gps
                           else gps_estado end
   where id = v_part.id;

  return json_build_object('status', 'ativa', 'agora', now(), 'saida_solicitada_em', v_part.saida_solicitada_em,
                           'gps_intervalo_s', v_op.gps_intervalo_s,
                           'gravar_trilha', v_part.gravar_trilha);
end;
$$;
revoke execute on function public.enviar_posicoes_lote(uuid, jsonb, text), public.sinal_vida(uuid, boolean, text) from public, anon;
grant execute on function public.enviar_posicoes_lote(uuid, jsonb, text), public.sinal_vida(uuid, boolean, text) to authenticated;

-- Trilhas dos outros participantes: sem os pontos de entrada na base (na_base).
create or replace function public.trilhas_da_equipe(p_participante uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found then
    raise exception 'participante_invalido';
  end if;
  if v_part.liberado_em is not null then
    raise exception 'participante_liberado';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  return coalesce((
    select json_agg(json_build_object('tipo', t.tipo, 'pontos', t.pontos) order by t.criado_em)
      from (
        select o.criado_em, o.tipo, (
          select json_agg(json_build_array(y.lat, y.lng) order by y.registrado_em)
            from (
              select x.lat, x.lng, x.registrado_em, x.rn, x.cnt
                from (
                  select q.lat, q.lng, q.registrado_em, row_number() over (order by q.registrado_em) as rn, count(*) over () as cnt
                    from public.posicoes q
                   where q.participante_id = o.id and q.registrado_em > now() - interval '4 hours'
                     and (q.precisao is null or q.precisao <= 100)
                     and not q.na_base
                ) x
               where x.rn % greatest(1, ceil(x.cnt / 150.0)::int) = 0 or x.rn = x.cnt
            ) y) as pontos
          from public.participantes o
         where o.operacao_id = v_part.operacao_id and o.id <> v_part.id and o.tipo in ('civil', 'militar')
           and not o.removido and o.liberado_em is null
      ) t
     where t.pontos is not null and json_array_length(t.pontos) >= 2), '[]'::json);
end;
$$;
revoke execute on function public.trilhas_da_equipe(uuid) from public, anon;
grant execute on function public.trilhas_da_equipe(uuid) to authenticated;

-- Aplicativo Android fechado de vez (arrastado da lista de recentes): avisa que o registro parou, sem encerrar a participação.
create or replace function public.app_parar_rastreio(p_dispositivo uuid, p_segredo text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part uuid;
begin
  perform public.app_dono_do_dispositivo(p_dispositivo, p_segredo);
  select participante_id into v_part from public.app_dispositivos where id = p_dispositivo;
  return public.sinal_vida(v_part, false, null);
end;
$$;
revoke execute on function public.app_parar_rastreio(uuid, text) from public;
grant execute on function public.app_parar_rastreio(uuid, text) to anon, authenticated;

notify pgrst, 'reload schema';
