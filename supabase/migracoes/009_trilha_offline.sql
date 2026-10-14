-- =====================================================================
-- 16. TRILHA GPS COM SUPORTE OFFLINE (confirmação por ponto)
--     (migração 009 — idempotente; exige a 008)
--
--  operacoes.gps_intervalo_s  intervalo MÁXIMO sem ponto na trilha (padrão 15 s):
--                             parado, o celular confirma a posição nesse ritmo;
--                             andando ou em veículo os pontos continuam mais
--                             frequentes (filtro de gps.js).
--  operacoes.gps_lacuna_s     intervalo entre dois pontos seguidos acima do qual
--                             o painel desenha o trecho como FALHA (tracejado,
--                             com início e fim marcados). Padrão 60 s.
--
--  enviar_posicoes_lote: mesma gravação de enviar_posicoes (idempotente pelo
--  id gerado no celular), mas devolve QUAIS pontos o servidor confirmou
--  (inseridos agora ou já gravados antes) e quais recusou, com o motivo. O
--  celular só marca um ponto como enviado depois dessa confirmação.
--  enviar_posicoes continua igual (páginas antigas abertas seguem funcionando).
--
--  apos_posicoes: gancho chamado depois de gravar posições (usado pela
--  migração 010 para os alertas dos deslocamentos de grupo).
-- =====================================================================

alter table public.operacoes add column if not exists gps_intervalo_s integer not null default 15;
alter table public.operacoes add column if not exists gps_lacuna_s integer not null default 60;
alter table public.operacoes drop constraint if exists operacoes_gps_check;
alter table public.operacoes add constraint operacoes_gps_check check (
  gps_intervalo_s between 5 and 300 and gps_lacuna_s between 30 and 3600 and gps_lacuna_s > gps_intervalo_s);

-- Gancho depois de gravar posições. Criado vazio só se ainda não existir
-- (a migração 010 o substitui; rodar esta migração de novo não o desfaz).
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'apos_posicoes') then
    execute $f$
      create function public.apos_posicoes(p_participante uuid)
      returns void
      language plpgsql security definer set search_path = public
      as $b$ begin return; end; $b$
    $f$;
  end if;
end;
$$;
revoke execute on function public.apos_posicoes(uuid) from public, anon, authenticated;

-- Configuração do GPS da operação (painel → Dados da operação).
create or replace function public.configurar_gps_operacao(p_operacao uuid, p_intervalo_s integer, p_lacuna_s integer)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_op public.operacoes%rowtype;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if p_intervalo_s is null or p_intervalo_s not between 5 and 300
     or p_lacuna_s is null or p_lacuna_s not between 30 and 3600 or p_lacuna_s <= p_intervalo_s then
    raise exception 'gps_config_invalida';
  end if;
  update public.operacoes
     set gps_intervalo_s = p_intervalo_s, gps_lacuna_s = p_lacuna_s, atualizado_em = now(), atualizado_por_nome = v_nome
   where id = p_operacao
  returning * into v_op;
  return row_to_json(v_op);
end;
$$;

-- Versão anterior, agora chamando o gancho apos_posicoes (o resto não mudou).
create or replace function public.enviar_posicoes(p_participante uuid, p_pontos jsonb, p_gps text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
  v_inseridos integer := 0;
  v_ult record;
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

  with numericos as (
    select case when jsonb_typeof(e) = 'object'
                 and coalesce(e ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (e ->> 'id')::uuid end as client_id,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'lat') = 'number' then (e -> 'lat')::numeric end as lat,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'lng') = 'number' then (e -> 'lng')::numeric end as lng,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'prec') = 'number' then (e -> 'prec')::numeric end as prec,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 't') = 'number' then (e -> 't')::numeric end as t
      from jsonb_array_elements(p_pontos) as e
  ), validos as (
    select client_id,
           case when lat between -90 and 90 then lat::double precision end as lat,
           case when lng between -180 and 180 then lng::double precision end as lng,
           case when prec between 0 and 100000 then prec::real end as prec,
           case when t between 946684800000 and 4102444800000
                then to_timestamp((t / 1000)::double precision) end as registrado_em
      from numericos
  ), dentro_do_periodo as (
    select * from validos
     where client_id is not null
       and lat is not null and lng is not null
       and not (lat = 0 and lng = 0)
       and registrado_em between v_op.criada_em - interval '10 minutes' and now() + interval '2 minutes'
  ), inseridos as (
    insert into public.posicoes (operacao_id, participante_id, client_id, lat, lng, precisao, registrado_em)
    select v_op.id, v_part.id, client_id, lat, lng, prec, registrado_em from dentro_do_periodo
    on conflict (participante_id, client_id) do nothing
    returning 1
  )
  select count(*) into v_inseridos from inseridos;

  select lat, lng, precisao, registrado_em into v_ult
    from public.posicoes
   where participante_id = v_part.id
   order by registrado_em desc
   limit 1;

  update public.participantes
     set ultimo_contato_em = now(),
         rastreando = true,
         gps_estado = case when p_gps in ('ok', 'fraco', 'sem_sinal', 'negado', 'indisponivel') then p_gps
                           when v_inseridos > 0 then 'ok'
                           else gps_estado end,
         ultima_lat = coalesce(v_ult.lat, ultima_lat),
         ultima_lng = coalesce(v_ult.lng, ultima_lng),
         ultima_precisao = case when v_ult.registrado_em is not null then v_ult.precisao else ultima_precisao end,
         ultima_posicao_em = coalesce(v_ult.registrado_em, ultima_posicao_em)
   where id = v_part.id;

  if v_inseridos > 0 then
    begin
      perform public.apos_posicoes(v_part.id);
    exception when others then
      raise warning 'apos_posicoes: %', sqlerrm;   -- nunca impede a gravação das posições
    end;
  end if;

  return json_build_object('status', 'ativa', 'recebidos', jsonb_array_length(p_pontos), 'inseridos', v_inseridos);
end;
$$;

-- Lote com confirmação por ponto. Formato de cada ponto, como em enviar_posicoes:
--   {"id": "<uuid gerado no celular>", "lat": -15.79, "lng": -47.88, "prec": 8.5, "t": <epoch ms>}
-- Resposta: { status, confirmados: [ids gravados no servidor], recusados: [{id, motivo}],
--             inseridos, gps_intervalo_s, gps_lacuna_s }
--   motivo: 'invalido' (dados malformados) ou 'fora_do_periodo' (horário antes
--   da operação ou no futuro). Reenviar um ponto já gravado o confirma de novo.
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
    insert into public.posicoes (operacao_id, participante_id, client_id, lat, lng, precisao, registrado_em)
    select v_op.id, v_part.id, u.cid, u.la, u.ln, u.pr, u.t
      from unnest(v_ids, v_lats, v_lngs, v_precs, v_ts) as u(cid, la, ln, pr, t)
    on conflict (participante_id, client_id) do nothing;
    get diagnostics v_inseridos = row_count;

    -- Confirmados: os que EXISTEM no servidor agora (inseridos neste envio ou antes).
    select coalesce(json_agg(p.client_id), '[]'::json) into v_confirmados
      from public.posicoes p
     where p.participante_id = v_part.id and p.client_id = any (v_ids);
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
                           when v_inseridos > 0 then 'ok'
                           else gps_estado end,
         ultima_lat = coalesce(v_ult.lat, ultima_lat),
         ultima_lng = coalesce(v_ult.lng, ultima_lng),
         ultima_precisao = case when v_ult.registrado_em is not null then v_ult.precisao else ultima_precisao end,
         ultima_posicao_em = coalesce(v_ult.registrado_em, ultima_posicao_em)
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
    'gps_lacuna_s', v_op.gps_lacuna_s
  );
end;
$$;

-- Sinal de vida: igual ao anterior, informando também o intervalo de GPS da operação.
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
                           'gps_intervalo_s', v_op.gps_intervalo_s);
end;
$$;

revoke execute on function public.configurar_gps_operacao(uuid, integer, integer),
  public.enviar_posicoes(uuid, jsonb, text), public.enviar_posicoes_lote(uuid, jsonb, text),
  public.sinal_vida(uuid, boolean, text) from public, anon;
grant execute on function public.configurar_gps_operacao(uuid, integer, integer),
  public.enviar_posicoes(uuid, jsonb, text), public.enviar_posicoes_lote(uuid, jsonb, text),
  public.sinal_vida(uuid, boolean, text) to authenticated;

notify pgrst, 'reload schema';
