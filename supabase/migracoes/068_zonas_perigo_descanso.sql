-- =====================================================================
-- 068 · Segurança e acompanhamento: alertas de zona (risco e proibida) e descanso na base
--       (migração idempotente; exige a 066 (enviar_posicoes_lote com base), a 061 (áreas proibidas) e a 010 (alertas))
--
--  1. Alertas de zona: cada ponto recebido (ao vivo OU de uma trilha gravada sem internet, que chega depois) é
--     conferido contra os pontos de RISCO (dentro do raio) e as áreas proibidas (dentro ou a até 25 m).
--     Gera o alerta zona_perigo / zona_proibida para os responsáveis (crítico, com alarme e "Ciente"; trilha
--     atrasada sobre área de risco entra como informativo). Um alerta por pessoa, zona e janela de 30 min:
--     reenviar os mesmos pontos não repete. Vale mesmo com a gravação da trilha desligada para a pessoa.
--  2. Descanso: dentro do raio de uma BASE a pessoa passa a descansar (tabela descansos): abre no primeiro
--     ponto dentro da base e fecha no primeiro ponto fora. Os pontos dentro da base continuam sem gravar na
--     trilha (migração 066); só a abertura e o fechamento do descanso são registrados.
-- =====================================================================

alter table public.alertas drop constraint if exists alertas_tipo_check;
alter table public.alertas add constraint alertas_tipo_check
  check (tipo in ('deslocamento_iniciado', 'chegou_setor', 'busca_finalizada', 'chegou_base', 'retorno_atrasado',
                  'vitima_localizada', 'permanencia_setor',
                  'inicio_atrasado', 'prazo_atrasado', 'sem_comunicacao', 'comunicacao_restabelecida',
                  'ajuda_sem_atendimento', 'zona_perigo', 'zona_proibida'));

-- Distância de um ponto a um polígono [[lat, lng], …] em metros (0 = dentro). Plano local; bom para até alguns km.
create or replace function public.distancia_ao_poligono_m(p_lat double precision, p_lng double precision, p_pontos jsonb)
returns double precision
language plpgsql immutable
as $$
declare
  n integer;
  i integer;
  j integer;
  kx double precision := 111320 * cos(radians(p_lat));
  ky constant double precision := 111320;
  dentro boolean := false;
  menor double precision := 1e18;
  x1 double precision; y1 double precision; x2 double precision; y2 double precision;
  dx double precision; dy double precision; l2 double precision; t double precision; d double precision;
begin
  if p_pontos is null or jsonb_typeof(p_pontos) <> 'array' then
    return null;
  end if;
  n := jsonb_array_length(p_pontos);
  if n < 3 then
    return null;
  end if;
  j := n - 1;
  for i in 0 .. n - 1 loop
    x1 := ((p_pontos -> j ->> 1)::double precision - p_lng) * kx;
    y1 := ((p_pontos -> j ->> 0)::double precision - p_lat) * ky;
    x2 := ((p_pontos -> i ->> 1)::double precision - p_lng) * kx;
    y2 := ((p_pontos -> i ->> 0)::double precision - p_lat) * ky;
    -- raio do ponto (a origem) para a direita: conta os cruzamentos com a aresta
    if ((y2 > 0) <> (y1 > 0)) and (0 < (x1 - x2) * (0 - y2) / (y1 - y2) + x2) then
      dentro := not dentro;
    end if;
    dx := x2 - x1; dy := y2 - y1; l2 := dx * dx + dy * dy;
    if l2 = 0 then
      d := sqrt(x1 * x1 + y1 * y1);
    else
      t := greatest(0, least(1, -(x1 * dx + y1 * dy) / l2));
      d := sqrt((x1 + t * dx) ^ 2 + (y1 + t * dy) ^ 2);
    end if;
    if d < menor then menor := d; end if;
    j := i;
  end loop;
  return case when dentro then 0 else menor end;
end;
$$;

-- Descansos: períodos em que a pessoa esteve dentro do raio de uma base. fim nulo = descansando agora.
-- Escrita só pelo servidor (enviar_posicoes_lote); os responsáveis da operação leem.
create table if not exists public.descansos (
  id               bigint generated always as identity primary key,
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  base_id          uuid references public.pontos_interesse(id) on delete set null,
  inicio           timestamptz not null,
  fim              timestamptz,
  criado_em        timestamptz not null default now(),
  constraint descansos_periodo_ok check (fim is null or fim >= inicio)
);
create unique index if not exists descansos_aberto_unico on public.descansos (participante_id) where fim is null;
create index if not exists descansos_operacao_idx on public.descansos (operacao_id, participante_id, inicio);

alter table public.descansos enable row level security;
drop policy if exists descansos_ler on public.descansos;
create policy descansos_ler on public.descansos for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.descansos from anon;
revoke insert, update, delete, truncate on public.descansos from authenticated;
grant select on public.descansos to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.descansos';
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

-- Alerta de zona (chamado por enviar_posicoes_lote). p_dist: metros até o ponto de risco ou até a área (0 = dentro).
create or replace function public.alertar_zona_participante(p_participante uuid, p_tipo text, p_zona uuid, p_nome text,
                                                            p_dist double precision, p_raio double precision,
                                                            p_lat double precision, p_lng double precision,
                                                            p_t timestamptz, p_chave text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_grupo text;
  v_atrasado boolean := now() - p_t > interval '3 minutes';   -- trilha gravada sem internet, recebida depois
  v_titulo text;
  v_texto text;
begin
  select * into v_part from public.participantes where id = p_participante;
  if not found then
    return;
  end if;
  select g.nome into v_grupo
    from public.grupo_membros gm join public.grupos g on g.id = gm.grupo_id
   where gm.participante_id = v_part.id order by lower(g.nome) limit 1;
  if p_tipo = 'proibida' then
    v_titulo := v_part.nome || case when p_dist <= 0 then ' ENTROU em área proibida: ' else ' passou perto de área proibida: ' end || p_nome;
    v_texto := case when p_dist <= 0 then 'Dentro da área proibida' else 'A cerca de ' || round(p_dist)::int || ' m da área proibida' end || ' "' || p_nome || '"';
  else
    v_titulo := v_part.nome || ' em área de risco: ' || p_nome;
    v_texto := 'A ' || round(p_dist)::int || ' m do ponto de risco "' || p_nome || '" (raio de ' || round(p_raio)::int || ' m)';
  end if;
  v_texto := v_texto || case when v_grupo is not null then ' · grupo ' || v_grupo else '' end || '.';
  if v_atrasado then
    v_texto := v_texto || ' Trilha gravada sem internet e recebida agora: a passagem foi em outro horário (ver "pela trilha GPS").';
  end if;
  perform public.criar_alerta(v_part.operacao_id,
    case when p_tipo = 'proibida' then 'zona_proibida' else 'zona_perigo' end,
    case when p_tipo = 'risco' and v_atrasado then 'info' else 'critico' end,
    v_titulo, v_texto, p_chave, null, null, v_part.id, p_lat, p_lng, p_t);
end;
$$;
revoke execute on function public.alertar_zona_participante(uuid, text, uuid, text, double precision, double precision, double precision, double precision, timestamptz, text) from public, anon, authenticated;

-- Diário: os alertas de zona entram como alerta.
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
                    when 'zona_perigo' then 'alerta' when 'zona_proibida' then 'alerta'
                    else 'deslocamento' end,
      'alerta_' || new.tipo, new.titulo, new.texto, 'alerta:' || new.id, new.nivel, new.lat, new.lng, new.id::text, 'Sistema');
  elsif new.nivel = 'critico' and old.reconhecido_em is null and new.reconhecido_em is not null then
    perform public.diario_auto(new.operacao_id, new.reconhecido_em, 'alerta', 'alerta_ciente',
      'Ciente do alerta: ' || new.titulo, '', 'alerta_ciente:' || new.id, 'info', null, null, new.id::text, new.reconhecido_por_nome);
  end if;
  return new;
end;
$function$;

-- Lote de posições: zonas de perigo e descanso na base (além da regra da base da migração 066).
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
  -- zonas de perigo e áreas proibidas (alerta aos responsáveis) e descanso na base
  v_nz integer := 0;
  v_z_tipo text[] := '{}';
  v_z_id uuid[] := '{}';
  v_z_nome text[] := '{}';
  v_z_lat double precision[] := '{}';
  v_z_lng double precision[] := '{}';
  v_z_raio double precision[] := '{}';
  v_z_pontos jsonb[] := '{}';
  v_z_minla double precision[] := '{}';
  v_z_maxla double precision[] := '{}';
  v_z_minln double precision[] := '{}';
  v_z_maxln double precision[] := '{}';
  z record;
  k integer;
  v_la0 double precision; v_la1 double precision; v_ln0 double precision; v_ln1 double precision;
  v_dist double precision;
  v_hit boolean;
  v_chave text;
  v_chaves text[] := '{}';
  v_base_id uuid;
  v_descansando boolean := false;
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
    v_descansando := exists (select 1 from public.descansos d where d.participante_id = v_part.id and d.fim is null);
    -- Zonas da operação, preparadas uma vez por lote (o prefiltro por caixa evita contas à toa nos pontos longe)
    for z in
      select 'risco'::text as tipo, b.id, b.titulo as nome, b.lat, b.lng, coalesce(b.raio_m, 100) as raio, null::jsonb as pontos
        from public.pontos_interesse b where b.operacao_id = v_op.id and b.categoria = 'RISCO'
      union all
      select 'proibida'::text, a.id, a.nome, null::double precision, null::double precision, null::double precision, a.pontos
        from public.areas_proibidas a where a.operacao_id = v_op.id
    loop
      v_la0 := null; v_la1 := null; v_ln0 := null; v_ln1 := null;
      if z.tipo = 'proibida' then
        select min((e ->> 0)::double precision), max((e ->> 0)::double precision),
               min((e ->> 1)::double precision), max((e ->> 1)::double precision)
          into v_la0, v_la1, v_ln0, v_ln1 from jsonb_array_elements(z.pontos) e;
      end if;
      v_nz := v_nz + 1;
      v_z_tipo := array_append(v_z_tipo, z.tipo);
      v_z_id := array_append(v_z_id, z.id);
      v_z_nome := array_append(v_z_nome, z.nome);
      v_z_lat := array_append(v_z_lat, z.lat);
      v_z_lng := array_append(v_z_lng, z.lng);
      v_z_raio := array_append(v_z_raio, z.raio);
      v_z_pontos := array_append(v_z_pontos, z.pontos);
      v_z_minla := array_append(v_z_minla, v_la0);
      v_z_maxla := array_append(v_z_maxla, v_la1);
      v_z_minln := array_append(v_z_minln, v_ln0);
      v_z_maxln := array_append(v_z_maxln, v_ln1);
    end loop;
    for r in select u.cid, u.la, u.ln, u.pr, u.t
               from unnest(v_ids, v_lats, v_lngs, v_precs, v_ts) with ordinality as u(cid, la, ln, pr, t, ord)
              order by u.t, u.ord loop
      -- Dentro do raio de uma BASE (padrão 50 m) a trilha não é gravada: só o ponto de ENTRADA fica guardado
      -- (marcado na_base), para a chegada à base continuar sendo detectada pelas missões. Gravação desligada
      -- para esta pessoa (definir_gravacao_trilha): nenhum ponto vai para a trilha.
      select b.id into v_base_id from public.pontos_interesse b
       where b.operacao_id = v_op.id and b.categoria = 'BASE'
         and public.distancia_m(b.lat, b.lng, r.la, r.ln) <= coalesce(b.raio_m, 50)
       order by public.distancia_m(b.lat, b.lng, r.la, r.ln) limit 1;
      v_na_base := v_base_id is not null;

      -- Descanso: abre no primeiro ponto dentro da base e fecha no primeiro ponto fora dela.
      if v_na_base and not v_descansando then
        insert into public.descansos (operacao_id, participante_id, base_id, inicio)
        values (v_op.id, v_part.id, v_base_id, r.t)
        on conflict (participante_id) where fim is null do nothing;
        v_descansando := true;
      elsif not v_na_base and v_descansando then
        update public.descansos set fim = greatest(inicio, r.t) where participante_id = v_part.id and fim is null;
        v_descansando := false;
      end if;

      -- Zonas de perigo / áreas proibidas: vale para pontos ao vivo e de trilhas gravadas sem internet
      -- (um alerta por pessoa, zona e janela de 30 min; reenviar não repete).
      for k in 1 .. v_nz loop
        v_hit := false;
        if v_z_tipo[k] = 'risco' then
          v_dist := public.distancia_m(v_z_lat[k], v_z_lng[k], r.la, r.ln);
          v_hit := v_dist <= v_z_raio[k];
        elsif r.la between v_z_minla[k] - 0.0005 and v_z_maxla[k] + 0.0005
              and r.ln between v_z_minln[k] - 0.0007 and v_z_maxln[k] + 0.0007 then
          v_dist := public.distancia_ao_poligono_m(r.la, r.ln, v_z_pontos[k]);
          v_hit := v_dist is not null and v_dist <= 25;
        end if;
        if v_hit then
          v_chave := 'zona:' || v_z_tipo[k] || ':' || v_z_id[k] || ':' || v_part.id || ':' || floor(extract(epoch from r.t) / 1800)::bigint;
          if not (v_chave = any (v_chaves)) then
            v_chaves := array_append(v_chaves, v_chave);
            perform public.alertar_zona_participante(v_part.id, v_z_tipo[k], v_z_id[k], v_z_nome[k], v_dist, v_z_raio[k], r.la, r.ln, r.t, v_chave);
          end if;
        end if;
      end loop;
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

revoke execute on function public.enviar_posicoes_lote(uuid, jsonb, text) from public, anon;
grant execute on function public.enviar_posicoes_lote(uuid, jsonb, text) to authenticated;

notify pgrst, 'reload schema';
