-- =====================================================================
-- 38. Controle de tempo das atividades dos grupos (migração 032 — idempotente; exige a 010 e a 012)
--
--  Cada deslocamento de grupo (missão) pode ter, além do prazo de retorno após a busca (010):
--    inicio_combinado_em   horário combinado para o grupo INICIAR o deslocamento;
--    retorno_combinado_em  horário combinado para o grupo estar de VOLTA (na base ou concluído);
--    tolerancia_min        folga antes de alertar (padrão 10 min);
--    sem_sinal_min         minutos sem nenhum contato do celular de um membro para alertar uma
--                          possível falha de comunicação (padrão 10 min; vale para toda missão ativa);
--    combinado_texto       o que foi combinado (ex.: "contato por rádio a cada 30 min, canal 3").
--  definir_prazos_missao grava e ajusta (registra no diário). verificar_prazos (chamada junto com
--  verificar_retornos, pelo pg_cron a cada minuto e pelo painel aberto) gera os alertas:
--    inicio_atrasado         ninguém iniciou o deslocamento até o horário combinado + tolerância;
--    prazo_atrasado          horário combinado de retorno + tolerância passou e há quem não voltou;
--    sem_comunicacao         um membro está sem nenhum contato com o servidor há mais de sem_sinal_min
--                            (sem internet, bateria, celular desligado). O celular guarda as posições
--                            e envia quando o sinal volta;
--    comunicacao_restabelecida  o membro voltou a se comunicar: quanto tempo ficou sem, e quantas
--                            posições gravadas sem internet chegaram depois (com o período).
--  Os alertas são verificados pelo relógio do servidor, não dependem do celular estar online.
-- =====================================================================
alter table public.missoes add column if not exists inicio_combinado_em timestamptz;
alter table public.missoes add column if not exists retorno_combinado_em timestamptz;
alter table public.missoes add column if not exists tolerancia_min integer not null default 10;
alter table public.missoes add column if not exists sem_sinal_min integer not null default 10;
alter table public.missoes add column if not exists combinado_texto text;
alter table public.missoes add column if not exists prazos_definidos_por_nome text;
alter table public.missoes add column if not exists prazos_definidos_em timestamptz;
do $$
begin
  alter table public.missoes add constraint missoes_prazos_ok check (
    tolerancia_min between 0 and 240 and sem_sinal_min between 3 and 240
    and (combinado_texto is null or char_length(combinado_texto) <= 500)
    and (inicio_combinado_em is null or retorno_combinado_em is null or retorno_combinado_em > inicio_combinado_em));
exception when duplicate_object then null;
end;
$$;

alter table public.alertas drop constraint if exists alertas_tipo_check;
alter table public.alertas add constraint alertas_tipo_check
  check (tipo in ('deslocamento_iniciado', 'chegou_setor', 'busca_finalizada', 'chegou_base', 'retorno_atrasado',
                  'vitima_localizada', 'permanencia_setor',
                  'inicio_atrasado', 'prazo_atrasado', 'sem_comunicacao', 'comunicacao_restabelecida'));

-- Prazos combinados de um deslocamento. p_dados: inicio_combinado_em, retorno_combinado_em ('' limpa),
-- tolerancia_min, sem_sinal_min, combinado_texto. Só as chaves enviadas mudam.
create or replace function public.definir_prazos_missao(p_missao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_m public.missoes%rowtype;
  v_op public.operacoes%rowtype;
  v_det text;
begin
  select * into v_m from public.missoes where id = p_missao for update;
  if not found or v_nome is null or not public.dono_operacao(v_m.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = v_m.operacao_id;
  if v_op.status <> 'ativa' or v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  if v_m.status in ('encerrada', 'na_base') then
    raise exception 'missao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  begin
    if p_dados ? 'inicio_combinado_em' then v_m.inicio_combinado_em := nullif(p_dados->>'inicio_combinado_em', '')::timestamptz; end if;
    if p_dados ? 'retorno_combinado_em' then v_m.retorno_combinado_em := nullif(p_dados->>'retorno_combinado_em', '')::timestamptz; end if;
    if p_dados ? 'tolerancia_min' then v_m.tolerancia_min := (p_dados->>'tolerancia_min')::integer; end if;
    if p_dados ? 'sem_sinal_min' then v_m.sem_sinal_min := (p_dados->>'sem_sinal_min')::integer; end if;
  exception when others then
    raise exception 'horario_combinado_invalido';
  end;
  if p_dados ? 'combinado_texto' then v_m.combinado_texto := nullif(left(btrim(coalesce(p_dados->>'combinado_texto', '')), 500), ''); end if;
  if v_m.tolerancia_min is null or v_m.tolerancia_min not between 0 and 240
     or v_m.sem_sinal_min is null or v_m.sem_sinal_min not between 3 and 240 then
    raise exception 'dados_invalidos';
  end if;
  -- horários plausíveis: depois do acionamento (com folga) e até 2 dias à frente
  if (v_m.inicio_combinado_em is not null and (v_m.inicio_combinado_em < coalesce(v_op.acionado_em, v_op.criada_em) - interval '1 day'
                                                or v_m.inicio_combinado_em > now() + interval '2 days'))
     or (v_m.retorno_combinado_em is not null and (v_m.retorno_combinado_em < coalesce(v_op.acionado_em, v_op.criada_em) - interval '1 day'
                                                or v_m.retorno_combinado_em > now() + interval '2 days'))
     or (v_m.inicio_combinado_em is not null and v_m.retorno_combinado_em is not null and v_m.retorno_combinado_em <= v_m.inicio_combinado_em) then
    raise exception 'horario_combinado_invalido';
  end if;
  update public.missoes
     set inicio_combinado_em = v_m.inicio_combinado_em, retorno_combinado_em = v_m.retorno_combinado_em,
         tolerancia_min = v_m.tolerancia_min, sem_sinal_min = v_m.sem_sinal_min, combinado_texto = v_m.combinado_texto,
         prazos_definidos_por_nome = v_nome, prazos_definidos_em = now()
   where id = v_m.id
  returning * into v_m;
  v_det := concat_ws(' · ',
    case when v_m.inicio_combinado_em is not null then 'iniciar até ' || to_char(v_m.inicio_combinado_em at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') end,
    case when v_m.retorno_combinado_em is not null then 'retornar até ' || to_char(v_m.retorno_combinado_em at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') end,
    'tolerância ' || v_m.tolerancia_min || ' min', 'sem comunicação após ' || v_m.sem_sinal_min || ' min', v_m.combinado_texto);
  perform public.diario_auto(v_m.operacao_id, now(), 'deslocamento', 'prazos_definidos', 'Prazos combinados — ' || v_m.grupo_nome || ' → ' || v_m.nome,
    v_det, 'prazos:' || v_m.id || ':' || floor(extract(epoch from now()))::bigint, 'info', null, null, v_m.id::text, v_nome);
  return row_to_json(v_m);
end;
$$;
revoke execute on function public.definir_prazos_missao(uuid, jsonb) from public, anon;
grant execute on function public.definir_prazos_missao(uuid, jsonb) to authenticated;

-- Verificação por tempo (servidor). Devolve quantos alertas novos foram criados.
create or replace function public.verificar_prazos(p_operacao uuid default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_m public.missoes%rowtype;
  r record;
  v_qtd integer := 0;
  v_lista text;
  v_faltam integer;
  v_total integer;
  v_limite timestamptz;
  v_tarde integer;
  v_ini timestamptz;
  v_fim timestamptz;
  v_min integer;
begin
  if p_operacao is null then
    if auth.uid() is not null then
      raise exception 'sem_permissao';
    end if;
  elsif not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;

  for v_m in
    select m.* from public.missoes m join public.operacoes o on o.id = m.operacao_id
     where m.status not in ('encerrada', 'na_base') and o.status = 'ativa' and o.dados_apagados_em is null
       and (p_operacao is null or m.operacao_id = p_operacao)
  loop
    -- 1) início combinado: ninguém começou o deslocamento
    if v_m.inicio_combinado_em is not null and now() > v_m.inicio_combinado_em + make_interval(mins => v_m.tolerancia_min)
       and not exists (select 1 from public.missao_membros mb where mb.missao_id = v_m.id and mb.iniciou_em is not null) then
      if public.criar_alerta(v_m.operacao_id, 'inicio_atrasado', 'critico', 'INÍCIO ATRASADO — ' || v_m.grupo_nome,
           'O horário combinado para iniciar o deslocamento até ' || v_m.nome || ' era ' ||
           to_char(v_m.inicio_combinado_em at time zone 'America/Sao_Paulo', 'HH24:MI') || ' (tolerância ' || v_m.tolerancia_min ||
           ' min) e ninguém do grupo começou.' || coalesce(' Combinado: ' || v_m.combinado_texto, ''),
           v_m.id || ':inicio_atrasado:' || floor(extract(epoch from v_m.inicio_combinado_em))::bigint, v_m.id, v_m.grupo_id) then
        v_qtd := v_qtd + 1;
      end if;
    end if;

    -- 2) retorno combinado: quem ainda não voltou (com base: não chegou à base; sem base: missão aberta)
    if v_m.retorno_combinado_em is not null and now() > v_m.retorno_combinado_em + make_interval(mins => v_m.tolerancia_min) then
      select count(*) filter (where v_m.base_lat is null or mb.chegou_base_em is null), count(*),
             string_agg(case when v_m.base_lat is null or mb.chegou_base_em is null then
                          p.nome || case when p.ultimo_contato_em is null then ' (sem contato)'
                                         else ' (último contato há ' || greatest(0, floor(extract(epoch from now() - p.ultimo_contato_em) / 60))::integer || ' min)' end
                        end, ', ' order by p.nome)
        into v_faltam, v_total, v_lista
        from public.missao_membros mb join public.participantes p on p.id = mb.participante_id
       where mb.missao_id = v_m.id and not p.removido and p.liberado_em is null;
      if coalesce(v_faltam, 0) > 0 and public.criar_alerta(v_m.operacao_id, 'prazo_atrasado', 'critico', 'RETORNO ATRASADO — ' || v_m.grupo_nome,
           'O horário combinado para o retorno de ' || v_m.nome || ' era ' ||
           to_char(v_m.retorno_combinado_em at time zone 'America/Sao_Paulo', 'HH24:MI') || ' (tolerância ' || v_m.tolerancia_min || ' min). ' ||
           v_faltam || ' de ' || v_total || ' pessoa(s) não voltaram: ' || coalesce(v_lista, '—') || '.' || coalesce(' Combinado: ' || v_m.combinado_texto, ''),
           v_m.id || ':prazo_atrasado:' || floor(extract(epoch from v_m.retorno_combinado_em))::bigint, v_m.id, v_m.grupo_id) then
        v_qtd := v_qtd + 1;
      end if;
    end if;

    -- 3) comunicação de cada membro (pelo horário em que o SERVIDOR recebeu o último contato)
    for r in
      select p.id, p.nome, p.ultimo_contato_em, p.ultima_lat, p.ultima_lng, p.ultima_posicao_em, mb.chegou_base_em
        from public.missao_membros mb join public.participantes p on p.id = mb.participante_id
       where mb.missao_id = v_m.id and not p.removido and p.liberado_em is null
    loop
      v_limite := now() - make_interval(mins => v_m.sem_sinal_min);
      if r.ultimo_contato_em is not null and r.ultimo_contato_em < v_limite and r.chegou_base_em is null then
        if public.criar_alerta(v_m.operacao_id, 'sem_comunicacao', 'critico', 'SEM COMUNICAÇÃO — ' || r.nome,
             r.nome || ' (' || v_m.grupo_nome || ') está sem contato com o servidor desde ' ||
             to_char(r.ultimo_contato_em at time zone 'America/Sao_Paulo', 'HH24:MI') ||
             ' (mais de ' || v_m.sem_sinal_min || ' min). Pode estar sem internet, sem bateria ou com o celular desligado. ' ||
             'Última posição conhecida' || coalesce(' às ' || to_char(r.ultima_posicao_em at time zone 'America/Sao_Paulo', 'HH24:MI'), ': nenhuma') ||
             '. As posições gravadas sem internet chegam quando o sinal voltar.',
             v_m.id || ':' || r.id || ':sem_comunicacao:' || floor(extract(epoch from r.ultimo_contato_em))::bigint,
             v_m.id, v_m.grupo_id, r.id, r.ultima_lat, r.ultima_lng, r.ultima_posicao_em) then
          v_qtd := v_qtd + 1;
        end if;
      end if;
    end loop;
  end loop;

  -- 4) comunicação restabelecida: episódios abertos cujo membro voltou a se comunicar
  for r in
    select a.*, p.nome as p_nome, p.ultimo_contato_em,
           to_timestamp(nullif(split_part(a.chave, ':sem_comunicacao:', 2), '')::bigint) as contato_antes
      from public.alertas a
      join public.participantes p on p.id = a.participante_id
      join public.operacoes o on o.id = a.operacao_id
     where a.tipo = 'sem_comunicacao' and (p_operacao is null or a.operacao_id = p_operacao)
       and o.status = 'ativa' and o.dados_apagados_em is null
       and p.ultimo_contato_em > a.criado_em
       and not exists (select 1 from public.alertas b where b.chave = a.chave || ':restabelecida')
  loop
    -- posições que o celular gravou sem internet e enviou depois (recebidas > 60 s após o GPS)
    select count(*), min(x.registrado_em), max(x.registrado_em) into v_tarde, v_ini, v_fim
      from public.posicoes x
     where x.participante_id = r.participante_id and x.recebido_em >= coalesce(r.contato_antes, r.criado_em)
       and x.recebido_em - x.registrado_em > interval '60 seconds';
    v_min := greatest(1, floor(extract(epoch from r.ultimo_contato_em - coalesce(r.contato_antes, r.criado_em)) / 60))::integer;
    if public.criar_alerta(r.operacao_id, 'comunicacao_restabelecida', 'info', 'Comunicação restabelecida — ' || r.p_nome,
         r.p_nome || ' voltou a se comunicar às ' || to_char(r.ultimo_contato_em at time zone 'America/Sao_Paulo', 'HH24:MI') ||
         ' depois de cerca de ' || v_min || ' min sem contato.' ||
         case when coalesce(v_tarde, 0) > 0
              then ' ' || v_tarde || ' posição(ões) gravada(s) sem internet chegaram depois (de ' ||
                   to_char(v_ini at time zone 'America/Sao_Paulo', 'HH24:MI') || ' a ' || to_char(v_fim at time zone 'America/Sao_Paulo', 'HH24:MI') || ').'
              else ' Nenhuma posição gravada sem internet chegou depois.' end,
         r.chave || ':restabelecida', r.missao_id, r.grupo_id, r.participante_id) then
      v_qtd := v_qtd + 1;
    end if;
  end loop;
  return v_qtd;
end;
$$;
revoke execute on function public.verificar_prazos(uuid) from public, anon;
grant execute on function public.verificar_prazos(uuid) to authenticated, service_role;

create or replace function public.verificar_retornos(p_operacao uuid default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_m public.missoes%rowtype;
  v_faltam integer;
  v_total integer;
  v_lista text;
  v_lat double precision;
  v_lng double precision;
  v_pos timestamptz;
  v_pid uuid;
  v_qtd integer := 0;
begin
  if p_operacao is null then
    if auth.uid() is not null then
      raise exception 'sem_permissao';
    end if;
  elsif not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;

  for v_m in
    select m.* from public.missoes m join public.operacoes o on o.id = m.operacao_id
     where m.status in ('busca_finalizada', 'retorno_atrasado') and m.base_lat is not null and o.status = 'ativa'
       and (p_operacao is null or m.operacao_id = p_operacao)
     order by m.prazo_retorno_em
  loop
    if public.concluir_retorno_se_todos(v_m.id) then
      continue;
    end if;
    if v_m.prazo_retorno_em is null or now() < v_m.prazo_retorno_em then
      continue;
    end if;
    select count(*) filter (where mb.chegou_base_em is null), count(*),
           string_agg(case when mb.chegou_base_em is null then
                        p.nome || case when p.ultima_posicao_em is null then ' (sem posição)'
                                       else ' (última posição há ' || greatest(0, floor(extract(epoch from now() - p.ultima_posicao_em) / 60))::integer || ' min)' end
                      end, ', ' order by p.nome)
      into v_faltam, v_total, v_lista
      from public.missao_membros mb join public.participantes p on p.id = mb.participante_id
     where mb.missao_id = v_m.id and not p.removido and p.liberado_em is null;
    if coalesce(v_faltam, 0) = 0 then
      continue;
    end if;
    select p.id, p.ultima_lat, p.ultima_lng, p.ultima_posicao_em into v_pid, v_lat, v_lng, v_pos
      from public.missao_membros mb join public.participantes p on p.id = mb.participante_id
     where mb.missao_id = v_m.id and mb.chegou_base_em is null and not p.removido and p.liberado_em is null
     order by p.ultima_posicao_em nulls last limit 1;
    if public.criar_alerta(v_m.operacao_id, 'retorno_atrasado', 'critico',
         'EQUIPE PODE ESTAR PERDIDA — ' || v_m.grupo_nome,
         'O prazo de retorno à base' || coalesce(' ' || v_m.base_nome, '') || ' (' || v_m.prazo_retorno_min || ' min após finalizar a busca em ' ||
           v_m.nome || ') terminou e ' || v_faltam || ' de ' || v_total || ' pessoa(s) não chegaram. Faltam: ' || coalesce(v_lista, '—') || '.',
         v_m.id || ':retorno_atrasado:' || floor(extract(epoch from v_m.prazo_retorno_em))::bigint,
         v_m.id, v_m.grupo_id, v_pid, v_lat, v_lng, v_pos) then
      v_qtd := v_qtd + 1;
    end if;
    update public.missoes set status = 'retorno_atrasado' where id = v_m.id and status = 'busca_finalizada';
  end loop;
  -- prazos combinados e falhas de comunicação (migração 032), no mesmo agendamento
  v_qtd := v_qtd + public.verificar_prazos(p_operacao);
  return v_qtd;
end;
$$;

create or replace function public.diario_de_alerta()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.tipo = 'vitima_localizada' then
      return new;
    end if;
    -- sem comunicação: o horário do registro é o da detecção (a posição guardada é a última conhecida)
    perform public.diario_auto(new.operacao_id, case when new.tipo = 'sem_comunicacao' then new.criado_em else coalesce(new.posicao_em, new.criado_em) end,
      case new.tipo when 'chegou_setor' then 'chegada' when 'chegou_base' then 'chegada'
                    when 'retorno_atrasado' then 'alerta' when 'permanencia_setor' then 'alerta'
                    when 'inicio_atrasado' then 'alerta' when 'prazo_atrasado' then 'alerta' when 'sem_comunicacao' then 'alerta'
                    else 'deslocamento' end,
      'alerta_' || new.tipo, new.titulo, new.texto, 'alerta:' || new.id, new.nivel, new.lat, new.lng, new.id::text, 'Sistema');
  elsif new.nivel = 'critico' and old.reconhecido_em is null and new.reconhecido_em is not null then
    perform public.diario_auto(new.operacao_id, new.reconhecido_em, 'alerta', 'alerta_ciente',
      'Ciente do alerta: ' || new.titulo, '', 'alerta_ciente:' || new.id, 'info', null, null, new.id::text, new.reconhecido_por_nome);
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';
