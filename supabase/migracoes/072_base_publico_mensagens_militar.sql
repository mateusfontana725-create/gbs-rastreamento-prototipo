-- =====================================================================
-- 072 · Trilha gravada também na base, link público em partes, mensagem para vários, exclusão de pontos em lote
--       e funções extras para o participante militar
--       (migração idempotente; exige a 066 (trilhas e base), a 067 (mensagem ao grupo), a 068 (zonas e descanso),
--       a 069 (link público) e a 070 (opacidade dos setores))
--
--  0. Cria a tabela categorias_ponto_estilo (050) se ela não existir: o link público a lê (erro 42P01 sem ela).
--  1. enviar_posicoes_lote grava a trilha SEMPRE, também dentro do raio de uma BASE (o ponto fica marcado na_base
--     e o mapa não desenha esse trecho). Antes os pontos da base eram descartados, e a gravação dependia de a base
--     ser reconhecida no momento do envio. Só a gravação desligada para a pessoa continua sem guardar.
--  2. comando_publico_posicoes(token, depois_de, limite): as posições do link público em partes (no máximo 5000
--     por vez, pela ordem do id). Em operações grandes a carga de uma vez só passava do tempo-limite do servidor
--     para visitantes e o link mostrava "sem conexão".
--  3. enviar_mensagem_varios(operação, tipo, texto, grupos): a mesma mensagem para TODOS os participantes de campo
--     da operação (grupos nulo) ou para os integrantes dos grupos escolhidos (cada pessoa recebe uma só vez).
--     Envio em massa pedido pelo responsável não esbarra no limite de 60 mensagens por minuto.
--  4. excluir_pontos(lista): exclui vários pontos de interesse de uma vez (mesma regra de excluir_ponto).
--  5. Participante MILITAR: operacoes.permissoes_militar (definir_permissoes_militar, no painel) liga ou desliga:
--       setores        criar, ajustar e excluir os setores que ele mesmo criou;
--       situacao_setor marcar setores como em andamento ou concluídos;
--       pontos         marcar pontos de interesse (e excluir os que ele mesmo marcou);
--       ver_setores    ver todos os setores da operação (não só os atribuídos e os públicos).
--     Padrão: tudo ligado. O link de civil continua simples (nada disso vale para civis).
--     Funções: participante_salvar_setor, participante_excluir_setor, participante_salvar_ponto,
--     participante_excluir_ponto; mapa_do_participante devolve as permissões e marca o que é dele.
-- =====================================================================

-- 0. Tabela das categorias de ponto (migração 050), que o link público lê --------------------------------
-- Instalações em que a 050 não foi aplicada davam erro 42P01 ao abrir o link público. Aqui ela é criada
-- (idempotente, mesmas regras da 050: só leitura pelos responsáveis; escrita pela função da 050).
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

-- 1. Trilha gravada também dentro da base ----------------------------------------------------------------
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
      -- Dentro do raio de uma BASE (padrão 50 m) o ponto é marcado na_base (gravado, mas fora do desenho da trilha).
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
      -- Migração 072: a trilha é gravada SEMPRE (também dentro do raio da base, marcada na_base, que o mapa não
      -- desenha). Assim a gravação não depende de a base ser reconhecida na hora: pontos que chegam depois (sem
      -- internet) ou uma base criada/movida depois continuam com o caminho inteiro guardado. Só a gravação
      -- desligada para a pessoa (definir_gravacao_trilha) deixa de guardar.
      v_gravar := v_part.gravar_trilha;
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

revoke execute on function public.enviar_posicoes_lote(uuid, jsonb, text) from public, anon;
grant execute on function public.enviar_posicoes_lote(uuid, jsonb, text) to authenticated;

-- 2. Link público: posições em partes --------------------------------------------------------------------
create or replace function public.comando_publico_posicoes(p_token text, p_depois_de bigint default 0, p_limite integer default 5000)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op uuid;
  v_lim integer := least(greatest(coalesce(p_limite, 5000), 1), 5000);
  v_pos jsonb;
  v_n integer;
  v_ult bigint;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then
    raise exception 'link_publico_comando_invalido';
  end if;
  select id into v_op from public.operacoes where comando_token = p_token;
  if not found then
    raise exception 'link_publico_comando_invalido';
  end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.id), '[]'::jsonb), count(*), max(q.id)
    into v_pos, v_n, v_ult
    from (select id, operacao_id, participante_id, lat, lng, precisao, registrado_em, recebido_em, na_base
            from public.posicoes where operacao_id = v_op and id > coalesce(p_depois_de, 0)
           order by id limit v_lim) q;
  return json_build_object('posicoes', v_pos, 'ultimo', coalesce(v_ult, p_depois_de), 'fim', v_n < v_lim);
end;
$$;
revoke execute on function public.comando_publico_posicoes(text, bigint, integer) from public;
grant execute on function public.comando_publico_posicoes(text, bigint, integer) to anon, authenticated;

-- 3. Mensagem para vários (todos ou grupos) ----------------------------------------------------------------
-- enviar_mensagem: igual à de antes, mas o limite de 60 por minuto não vale dentro de um envio em massa feito
-- pelo responsável (enviar_mensagem_varios / enviar_mensagem_grupo marcam a transação).
create or replace function public.enviar_mensagem(p_participante uuid, p_tipo text, p_texto text default '')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_nome text;
  v_texto text := btrim(coalesce(p_texto, ''));
  v_msg public.mensagens%rowtype;
  v_recentes integer;
begin
  select * into v_part from public.participantes where id = p_participante;
  if not found or not public.dono_operacao(v_part.operacao_id) or v_part.user_id = auth.uid() then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
  end if;
  if p_tipo is null or p_tipo not in ('RETORNE', 'ATENCAO', 'MUDE_ROTA', 'PARE', 'CONFIRME', 'PERSONALIZADA') then
    raise exception 'tipo_invalido';
  end if;
  if char_length(v_texto) > 500 then
    raise exception 'texto_longo';
  end if;
  if p_tipo = 'PERSONALIZADA' and v_texto = '' then
    raise exception 'texto_obrigatorio';
  end if;

  -- proteção contra envio em massa acidental (não vale para o envio a vários, que já é um pedido só)
  if coalesce(current_setting('gbs.envio_em_massa', true), '') = '' then
    select count(*) into v_recentes from public.mensagens
     where operacao_id = v_part.operacao_id and direcao = 'saida' and criada_em > now() - interval '1 minute';
    if v_recentes >= 60 then
      raise exception 'muitas_mensagens';
    end if;
  end if;

  select nome into v_nome from public.responsaveis where user_id = auth.uid();

  insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto)
  values (v_part.operacao_id, v_part.id, auth.uid(), v_nome, p_tipo, v_texto)
  returning * into v_msg;

  return row_to_json(v_msg);
end;
$$;

create or replace function public.enviar_mensagem_varios(p_operacao uuid, p_tipo text, p_texto text default '', p_grupos uuid[] default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_texto text := btrim(coalesce(p_texto, ''));
  v_m record;
  v_msgs jsonb := '[]'::jsonb;
  v_total integer := 0;
  v_ok integer := 0;
  v_erro text;
  v_envios integer;
begin
  if public.nome_responsavel_atual() is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if (select status from public.operacoes where id = p_operacao) is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_tipo is null or p_tipo not in ('RETORNE', 'ATENCAO', 'MUDE_ROTA', 'PARE', 'CONFIRME', 'PERSONALIZADA') then
    raise exception 'tipo_invalido';
  end if;
  if char_length(v_texto) > 500 then
    raise exception 'texto_longo';
  end if;
  if p_tipo = 'PERSONALIZADA' and v_texto = '' then
    raise exception 'texto_obrigatorio';
  end if;
  if p_grupos is not null and (cardinality(p_grupos) = 0 or exists (
       select 1 from unnest(p_grupos) g where not exists (select 1 from public.grupos x where x.id = g and x.operacao_id = p_operacao))) then
    raise exception 'grupo_invalido';
  end if;
  -- no máximo 6 envios a vários por minuto na operação (cada um já vira uma mensagem por pessoa)
  select count(distinct date_trunc('second', criada_em)) into v_envios from public.mensagens
   where operacao_id = p_operacao and direcao = 'saida' and remetente_id = auth.uid() and criada_em > now() - interval '1 minute';
  if v_envios >= 6 then
    raise exception 'muitas_mensagens';
  end if;

  perform set_config('gbs.envio_em_massa', '1', true);
  for v_m in
    select p.id
      from public.participantes p
     where p.operacao_id = p_operacao and not p.removido and p.liberado_em is null
       and p.tipo <> 'responsavel' and p.user_id <> auth.uid()
       and (p_grupos is null or exists (select 1 from public.grupo_membros gm where gm.participante_id = p.id and gm.grupo_id = any (p_grupos)))
     order by p.nome, p.id
  loop
    v_total := v_total + 1;
    begin
      v_msgs := v_msgs || jsonb_build_array(public.enviar_mensagem(v_m.id, p_tipo, v_texto)::jsonb);
      v_ok := v_ok + 1;
    exception when others then
      v_erro := sqlerrm;
    end;
  end loop;
  perform set_config('gbs.envio_em_massa', '', true);

  if v_total = 0 then
    raise exception 'sem_destinatarios';
  end if;
  if v_ok = 0 then
    raise exception '%', coalesce(v_erro, 'dados_invalidos');
  end if;
  return json_build_object('total', v_total, 'enviadas', v_ok, 'falhas', v_total - v_ok, 'mensagens', v_msgs);
end;
$$;
revoke execute on function public.enviar_mensagem_varios(uuid, text, text, uuid[]) from public, anon;
grant execute on function public.enviar_mensagem_varios(uuid, text, text, uuid[]) to authenticated;

-- 4. Excluir vários pontos de interesse --------------------------------------------------------------------
create or replace function public.excluir_pontos(p_ids uuid[])
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v public.pontos_interesse%rowtype;
  v_ok integer := 0;
  v_negados integer := 0;
begin
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 2000 then
    raise exception 'dados_invalidos';
  end if;
  for v in select * from public.pontos_interesse where id = any (p_ids) loop
    if public.pode_excluir_registro(v.operacao_id, v.criado_por) then
      delete from public.pontos_interesse where id = v.id;
      v_ok := v_ok + 1;
    else
      v_negados := v_negados + 1;
    end if;
  end loop;
  if v_ok = 0 and v_negados > 0 then
    raise exception 'sem_permissao';
  end if;
  return json_build_object('excluidos', v_ok, 'sem_permissao', v_negados);
end;
$$;
revoke execute on function public.excluir_pontos(uuid[]) from public, anon;
grant execute on function public.excluir_pontos(uuid[]) to authenticated;

-- 5. Participante militar: funções extras configuráveis ---------------------------------------------------
alter table public.operacoes add column if not exists permissoes_militar jsonb not null
  default '{"setores": true, "situacao_setor": true, "pontos": true, "ver_setores": true}'::jsonb;

create or replace function public.permissao_militar(p_operacao uuid, p_chave text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select (o.permissoes_militar ->> p_chave)::boolean from public.operacoes o where o.id = p_operacao), false);
$$;
revoke execute on function public.permissao_militar(uuid, text) from public, anon;
grant execute on function public.permissao_militar(uuid, text) to authenticated;

create or replace function public.definir_permissoes_militar(p_operacao uuid, p_permissoes jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_novo jsonb := '{}'::jsonb;
  k text;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if p_permissoes is null or jsonb_typeof(p_permissoes) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  foreach k in array array['setores', 'situacao_setor', 'pontos', 'ver_setores'] loop
    if p_permissoes ? k and jsonb_typeof(p_permissoes -> k) <> 'boolean' then
      raise exception 'dados_invalidos';
    end if;
    v_novo := v_novo || jsonb_build_object(k, coalesce((p_permissoes ->> k)::boolean, false));
  end loop;
  update public.operacoes set permissoes_militar = v_novo where id = p_operacao;
  perform public.diario_auto(p_operacao, now(), 'operacao', 'permissoes_militar', 'Funções dos militares alteradas',
    concat_ws(', ',
      case when (v_novo ->> 'setores')::boolean then 'criar setores' end,
      case when (v_novo ->> 'situacao_setor')::boolean then 'situação dos setores' end,
      case when (v_novo ->> 'pontos')::boolean then 'marcar pontos' end,
      case when (v_novo ->> 'ver_setores')::boolean then 'ver todos os setores' end),
    'permissoes_militar:' || p_operacao || ':' || (extract(epoch from clock_timestamp()) * 1000000)::bigint, 'info', null, null, null, v_nome);
  return v_novo;
end;
$$;
revoke execute on function public.definir_permissoes_militar(uuid, jsonb) from public, anon;
grant execute on function public.definir_permissoes_militar(uuid, jsonb) to authenticated;

-- Confere quem chama: o próprio participante, MILITAR, na operação ativa.
create or replace function public.militar_em_campo(p_participante uuid)
returns public.participantes
language plpgsql stable security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
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
  if v_part.tipo <> 'militar' then
    raise exception 'so_militar';
  end if;
  if (select status from public.operacoes where id = v_part.operacao_id) <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  return v_part;
end;
$$;
revoke execute on function public.militar_em_campo(uuid) from public, anon;
grant execute on function public.militar_em_campo(uuid) to authenticated;

-- Setor visto pelo militar (atribuído a ele, da missão dele, público, criado por ele ou todos com ver_setores).
create or replace function public.setor_visivel_militar(p_part public.participantes, p_setor public.setores)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_setor.operacao_id = p_part.operacao_id and (
       public.permissao_militar(p_part.operacao_id, 'ver_setores')
    or coalesce(p_setor.visibilidade, 'privado') = 'publico'
    or p_setor.participante_id = p_part.id
    or p_setor.criado_por = p_part.user_id
    or exists (select 1 from public.missoes m join public.missao_membros mm on mm.missao_id = m.id
                where m.setor_id = p_setor.id and mm.participante_id = p_part.id and m.status <> 'encerrada'));
$$;
revoke execute on function public.setor_visivel_militar(public.participantes, public.setores) from public, anon;
grant execute on function public.setor_visivel_militar(public.participantes, public.setores) to authenticated;

-- Criar ou ajustar um setor (só os que ele criou) ou mudar a situação (permissão situacao_setor).
create or replace function public.participante_salvar_setor(p_participante uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_s public.setores%rowtype;
  v_nome text;
  v_so_status boolean;
begin
  v_part := public.militar_em_campo(p_participante);
  v_nome := v_part.nome || ' (militar)';
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  v_so_status := p_id is not null and (select count(*) from jsonb_object_keys(p_dados)) = 1 and p_dados ? 'status';

  if p_id is null then
    if not public.permissao_militar(v_part.operacao_id, 'setores') then
      raise exception 'funcao_nao_liberada';
    end if;
    v_s.id := gen_random_uuid();
    v_s.operacao_id := v_part.operacao_id;
    v_s.criado_por := auth.uid();
    v_s.criado_por_nome := v_nome;
    v_s.criado_em := now();
    v_s.status := 'pendente';
    v_s.cor := '#f59e0b';
    v_s.equipe := '';
    v_s.observacoes := '';
    v_s.visibilidade := 'privado';
  else
    select * into v_s from public.setores where id = p_id and operacao_id = v_part.operacao_id for update;
    if not found then
      raise exception 'setor_nao_encontrado';
    end if;
    if v_so_status then
      if not public.permissao_militar(v_part.operacao_id, 'situacao_setor') or not public.setor_visivel_militar(v_part, v_s) then
        raise exception 'funcao_nao_liberada';
      end if;
    elsif not public.permissao_militar(v_part.operacao_id, 'setores') or v_s.criado_por is distinct from auth.uid() then
      raise exception 'funcao_nao_liberada';
    end if;
  end if;

  if p_dados ? 'nome' then v_s.nome := btrim(coalesce(p_dados->>'nome', '')); end if;
  if p_dados ? 'status' then v_s.status := p_dados->>'status'; end if;
  if p_dados ? 'cor' then v_s.cor := p_dados->>'cor'; end if;
  if p_dados ? 'observacoes' then v_s.observacoes := left(btrim(coalesce(p_dados->>'observacoes', '')), 500); end if;
  if p_dados ? 'forma' then
    v_s.forma := p_dados->>'forma';
    if v_s.forma = 'circulo' then
      if jsonb_typeof(p_dados->'centro_lat') <> 'number' or jsonb_typeof(p_dados->'centro_lng') <> 'number' or jsonb_typeof(p_dados->'raio_m') <> 'number' then
        raise exception 'area_invalida';
      end if;
      v_s.centro_lat := (p_dados->>'centro_lat')::double precision;
      v_s.centro_lng := (p_dados->>'centro_lng')::double precision;
      v_s.raio_m := (p_dados->>'raio_m')::double precision;
      v_s.pontos := null;
    elsif v_s.forma = 'poligono' then
      if not public.vertices_validos(p_dados->'pontos') then
        raise exception 'area_invalida';
      end if;
      v_s.pontos := p_dados->'pontos';
      v_s.centro_lat := null;
      v_s.centro_lng := null;
      v_s.raio_m := null;
    else
      raise exception 'area_invalida';
    end if;
  end if;

  if v_s.nome is null or char_length(v_s.nome) not between 1 and 60 then
    raise exception 'nome_invalido';
  end if;
  if v_s.status not in ('pendente', 'andamento', 'concluido') or v_s.cor !~ '^#[0-9a-fA-F]{6}$' then
    raise exception 'dados_invalidos';
  end if;
  if v_s.forma is null
     or (v_s.forma = 'circulo' and (v_s.centro_lat is null or v_s.centro_lng is null or v_s.raio_m is null
         or v_s.raio_m not between 5 and 50000 or v_s.centro_lat not between -90 and 90 or v_s.centro_lng not between -180 and 180)) then
    raise exception 'area_invalida';
  end if;

  v_s.atualizado_em := now();
  v_s.atualizado_por_nome := v_nome;
  if p_id is null then
    insert into public.setores select v_s.*;
  else
    update public.setores set nome = v_s.nome, forma = v_s.forma, centro_lat = v_s.centro_lat, centro_lng = v_s.centro_lng,
           raio_m = v_s.raio_m, pontos = v_s.pontos, cor = v_s.cor, status = v_s.status, observacoes = v_s.observacoes,
           atualizado_em = v_s.atualizado_em, atualizado_por_nome = v_s.atualizado_por_nome
     where id = v_s.id;
  end if;
  return row_to_json(v_s);
end;
$$;
revoke execute on function public.participante_salvar_setor(uuid, uuid, jsonb) from public, anon;
grant execute on function public.participante_salvar_setor(uuid, uuid, jsonb) to authenticated;

create or replace function public.participante_excluir_setor(p_participante uuid, p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
begin
  v_part := public.militar_em_campo(p_participante);
  if not public.permissao_militar(v_part.operacao_id, 'setores') then
    raise exception 'funcao_nao_liberada';
  end if;
  delete from public.setores where id = p_id and operacao_id = v_part.operacao_id and criado_por = auth.uid();
  if not found then
    raise exception 'funcao_nao_liberada';
  end if;
end;
$$;
revoke execute on function public.participante_excluir_setor(uuid, uuid) from public, anon;
grant execute on function public.participante_excluir_setor(uuid, uuid) to authenticated;

-- Marcar um ponto de interesse (aparece para a equipe: visibilidade pública).
create or replace function public.participante_salvar_ponto(p_participante uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_p public.pontos_interesse%rowtype;
begin
  v_part := public.militar_em_campo(p_participante);
  if not public.permissao_militar(v_part.operacao_id, 'pontos') then
    raise exception 'funcao_nao_liberada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados->'lat') <> 'number' or jsonb_typeof(p_dados->'lng') <> 'number' then
    raise exception 'posicao_invalida';
  end if;
  v_p.id := gen_random_uuid();
  v_p.operacao_id := v_part.operacao_id;
  v_p.categoria := coalesce(p_dados->>'categoria', 'OUTRO');
  if v_p.categoria not in ('POSSIVEL_LOCALIZACAO', 'VESTIGIO', 'RISCO', 'ENCONTRO', 'BASE', 'OUTRO') then
    raise exception 'dados_invalidos';
  end if;
  v_p.titulo := btrim(coalesce(p_dados->>'titulo', ''));
  if char_length(v_p.titulo) not between 1 and 80 then
    raise exception 'nome_invalido';
  end if;
  v_p.descricao := left(btrim(coalesce(p_dados->>'descricao', '')), 1000);
  v_p.lat := (p_dados->>'lat')::double precision;
  v_p.lng := (p_dados->>'lng')::double precision;
  if v_p.lat not between -90 and 90 or v_p.lng not between -180 and 180 or (v_p.lat = 0 and v_p.lng = 0) then
    raise exception 'posicao_invalida';
  end if;
  v_p.visibilidade := 'publico';
  v_p.criado_por := auth.uid();
  v_p.criado_por_nome := v_part.nome || ' (militar)';
  v_p.criado_em := now();
  v_p.atualizado_em := now();
  v_p.atualizado_por_nome := v_p.criado_por_nome;
  insert into public.pontos_interesse select v_p.*;
  return row_to_json(v_p);
end;
$$;
revoke execute on function public.participante_salvar_ponto(uuid, jsonb) from public, anon;
grant execute on function public.participante_salvar_ponto(uuid, jsonb) to authenticated;

create or replace function public.participante_excluir_ponto(p_participante uuid, p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
begin
  v_part := public.militar_em_campo(p_participante);
  if not public.permissao_militar(v_part.operacao_id, 'pontos') then
    raise exception 'funcao_nao_liberada';
  end if;
  delete from public.pontos_interesse where id = p_id and operacao_id = v_part.operacao_id and criado_por = auth.uid();
  if not found then
    raise exception 'funcao_nao_liberada';
  end if;
end;
$$;
revoke execute on function public.participante_excluir_ponto(uuid, uuid) from public, anon;
grant execute on function public.participante_excluir_ponto(uuid, uuid) to authenticated;

-- Mapa do participante: o mesmo de antes, com as permissões (só para militares) e o que é dele ("meu_criado").
create or replace function public.mapa_do_participante(p_participante uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_perm jsonb := '{}'::jsonb;
  v_todos boolean := false;
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
  if v_part.tipo = 'militar' then
    select coalesce(permissoes_militar, '{}'::jsonb) into v_perm from public.operacoes where id = v_part.operacao_id;
    v_todos := coalesce((v_perm ->> 'ver_setores')::boolean, false);
  end if;
  return json_build_object(
    'permissoes', v_perm,
    'equipe', public.equipe_no_mapa(p_participante),
    'setores', coalesce((
      select json_agg(json_build_object('id', s.id, 'nome', s.nome, 'forma', s.forma, 'centro_lat', s.centro_lat,
                                        'centro_lng', s.centro_lng, 'raio_m', s.raio_m, 'pontos', s.pontos,
                                        'cor', s.cor, 'status', s.status,
                                        'publico', coalesce(s.visibilidade, 'privado') = 'publico',
                                        'meu_criado', s.criado_por = auth.uid(),
                                        'meu', (coalesce(s.participante_id = v_part.id, false) or exists (
                                          select 1 from public.missoes m join public.missao_membros mm on mm.missao_id = m.id
                                           where m.setor_id = s.id and mm.participante_id = v_part.id and m.status <> 'encerrada'))
                                       ) order by s.criado_em)
        from public.setores s
       where s.operacao_id = v_part.operacao_id
         and (v_todos
              or coalesce(s.visibilidade, 'privado') = 'publico'
              or s.participante_id = v_part.id
              or (v_part.tipo = 'militar' and s.criado_por = auth.uid())
              or exists (select 1 from public.missoes m join public.missao_membros mm on mm.missao_id = m.id
                          where m.setor_id = s.id and mm.participante_id = v_part.id and m.status <> 'encerrada'))), '[]'::json),
    'pontos', coalesce((
      select json_agg(json_build_object('id', p.id, 'categoria', p.categoria, 'titulo', p.titulo, 'descricao', p.descricao,
                                        'lat', p.lat, 'lng', p.lng, 'raio_m', p.raio_m,
                                        'meu_criado', p.criado_por = auth.uid(),
                                        'publico', coalesce(p.visibilidade, case when p.categoria in ('ENCONTRO', 'RISCO', 'BASE') then 'publico' else 'privado' end) = 'publico')
                      order by p.criado_em)
        from public.pontos_interesse p
       where p.operacao_id = v_part.operacao_id
         and (coalesce(p.visibilidade, case when p.categoria in ('ENCONTRO', 'RISCO', 'BASE') then 'publico' else 'privado' end) = 'publico'
              or exists (select 1 from public.destinos d where d.ponto_id = p.id and d.participante_id = v_part.id))), '[]'::json),
    'areas_proibidas', coalesce((
      select json_agg(json_build_object('id', a.id, 'nome', a.nome, 'motivo', a.motivo, 'pontos', a.pontos) order by a.criado_em)
        from public.areas_proibidas a where a.operacao_id = v_part.operacao_id), '[]'::json),
    'destino', (
      select json_build_object('id', d.id, 'nome', d.nome, 'lat', d.lat, 'lng', d.lng, 'criado_em', d.criado_em, 'modo', d.modo, 'trajeto', d.trajeto)
        from public.destinos d where d.participante_id = v_part.id and d.encerrado_em is null
       order by d.criado_em desc limit 1)
  );
end;
$$;
revoke execute on function public.mapa_do_participante(uuid) from public, anon;
grant execute on function public.mapa_do_participante(uuid) to authenticated;


notify pgrst, 'reload schema';
