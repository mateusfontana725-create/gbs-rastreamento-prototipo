-- =====================================================================
-- 20. ALERTA DE TEMPO DE PERMANÊNCIA EM SETOR
--     (migração 013 — idempotente; exige a 012)
--
--  Quando uma pessoa (ou um grupo) fica no mesmo setor mais tempo do que o
--  limite da operação (padrão 60 min; 0 = desligado), o responsável recebe um
--  alerta para avaliar a troca da equipe.
--
--  O tempo é calculado no SERVIDOR pela trilha GPS (posicoes), pelo horário
--  do GPS, a cada lote de posições recebido (gancho apos_posicoes):
--    entrada  2 pontos seguidos dentro do setor; começa no 1º deles
--    saída    3 pontos seguidos fora; termina no 1º deles
--    volta    reentrar até 5 min depois de sair continua a MESMA permanência
--             (o GPS oscila na borda: isso não zera o tempo)
--    pontos com precisão pior que 150 m são ignorados
--  Um alerta por limite atingido (1×, 2×, 3× o limite…), nunca a cada ponto.
--  Membros do mesmo grupo no mesmo setor geram UM alerta do grupo.
--
--  setor_permanencias  cada passagem de uma pessoa por um setor (entrada,
--                      saída, último limite avisado). Leitura: responsáveis.
--  setor_presenca      estado do contador de pontos dentro/fora (uso interno)
--  permanencia_cursor  último ponto já avaliado de cada pessoa (uso interno)
-- =====================================================================

alter table public.operacoes add column if not exists permanencia_limite_min integer not null default 60;
alter table public.operacoes drop constraint if exists operacoes_permanencia_limite_check;
alter table public.operacoes add constraint operacoes_permanencia_limite_check
  check (permanencia_limite_min = 0 or permanencia_limite_min between 10 and 720);

alter table public.alertas drop constraint if exists alertas_tipo_check;
alter table public.alertas add constraint alertas_tipo_check
  check (tipo in ('deslocamento_iniciado', 'chegou_setor', 'busca_finalizada', 'chegou_base', 'retorno_atrasado',
                  'vitima_localizada', 'permanencia_setor'));

create table if not exists public.setor_permanencias (
  id               uuid primary key default gen_random_uuid(),
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  setor_id         uuid not null references public.setores(id) on delete cascade,
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  entrou_em        timestamptz not null,       -- horário do GPS do 1º ponto dentro
  ultimo_dentro_em timestamptz not null,       -- último ponto dentro
  saiu_em          timestamptz,                -- 1º ponto fora (null = ainda no setor)
  entrada_lat      double precision,
  entrada_lng      double precision,
  avisado_min      integer not null default 0  -- maior limite (em minutos) já avisado nesta permanência
);
create unique index if not exists setor_permanencias_aberta on public.setor_permanencias (participante_id, setor_id) where saiu_em is null;
create index if not exists setor_permanencias_operacao_idx on public.setor_permanencias (operacao_id, saiu_em);
create index if not exists setor_permanencias_setor_idx on public.setor_permanencias (setor_id, participante_id, saiu_em desc);

create table if not exists public.setor_presenca (
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  setor_id         uuid not null references public.setores(id) on delete cascade,
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  dentro_seq       smallint not null default 0,
  fora_seq         smallint not null default 0,
  cand_em          timestamptz,                -- 1º ponto da sequência dentro
  cand_lat         double precision,
  cand_lng         double precision,
  cand_fora_em     timestamptz,                -- 1º ponto da sequência fora
  primary key (participante_id, setor_id)
);

create table if not exists public.permanencia_cursor (
  participante_id  uuid primary key references public.participantes(id) on delete cascade,
  ultimo_pos_id    bigint not null default 0
);

alter table public.setor_permanencias enable row level security;
alter table public.setor_presenca enable row level security;       -- sem políticas: ninguém lê pelo navegador
alter table public.permanencia_cursor enable row level security;   -- idem
drop policy if exists setor_permanencias_ler on public.setor_permanencias;
create policy setor_permanencias_ler on public.setor_permanencias
  for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.setor_permanencias, public.setor_presenca, public.permanencia_cursor from anon;
revoke all on public.setor_presenca, public.permanencia_cursor from authenticated;
revoke insert, update, delete, truncate on public.setor_permanencias from authenticated;
grant select on public.setor_permanencias to authenticated;

-- "1 h 05 min", "45 min"
create or replace function public.texto_duracao(p_min integer)
returns text language sql immutable set search_path = public as $$
  select case when p_min < 60 then p_min || ' min'
              when p_min % 60 = 0 then (p_min / 60) || ' h'
              else (p_min / 60) || ' h ' || lpad((p_min % 60)::text, 2, '0') || ' min' end;
$$;

-- ---------------------------------------------------------------------
-- Alerta de uma permanência que passou do limite (uso interno)
-- ---------------------------------------------------------------------
create or replace function public.alertar_permanencia(p_perm uuid, p_ate timestamptz, p_lat double precision, p_lng double precision)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v public.setor_permanencias%rowtype;
  v_op public.operacoes%rowtype;
  v_s public.setores%rowtype;
  v_p public.participantes%rowtype;
  v_g public.grupos%rowtype;
  v_min integer;
  v_limiar integer;
  v_lista text;
begin
  select * into v from public.setor_permanencias where id = p_perm for update;
  if not found or v.saiu_em is not null then
    return false;
  end if;
  select * into v_op from public.operacoes where id = v.operacao_id;
  if v_op.status <> 'ativa' or coalesce(v_op.permanencia_limite_min, 0) = 0 then
    return false;
  end if;
  v_min := floor(extract(epoch from (p_ate - v.entrou_em)) / 60)::integer;
  v_limiar := (v_min / v_op.permanencia_limite_min) * v_op.permanencia_limite_min;   -- maior múltiplo do limite já atingido
  if v_limiar < v_op.permanencia_limite_min or v_limiar <= v.avisado_min then
    return false;
  end if;
  -- marca antes de avisar: um aviso por limite, mesmo com reenvio de pontos
  update public.setor_permanencias set avisado_min = v_limiar where id = v.id;

  select * into v_s from public.setores where id = v.setor_id;
  select * into v_p from public.participantes where id = v.participante_id;
  select g.* into v_g from public.grupo_membros gm join public.grupos g on g.id = gm.grupo_id
   where gm.participante_id = v.participante_id order by g.nome limit 1;

  if v_g.id is not null then
    -- grupo: um alerta só por limite, mesmo que vários membros cruzem o limite
    if exists (select 1 from public.alertas a
                where a.operacao_id = v.operacao_id and a.tipo = 'permanencia_setor' and a.grupo_id = v_g.id
                  and a.chave like 'permanencia:g:' || v_g.id || ':' || v.setor_id || ':' || v_limiar || ':%'
                  and a.criado_em > now() - make_interval(mins => v_op.permanencia_limite_min)) then
      return false;
    end if;
    select string_agg(p.nome || ' (' || public.texto_duracao(floor(extract(epoch from (greatest(p_ate, sp.ultimo_dentro_em) - sp.entrou_em)) / 60)::integer) || ')',
                      ', ' order by sp.entrou_em)
      into v_lista
      from public.setor_permanencias sp
      join public.grupo_membros gm on gm.participante_id = sp.participante_id and gm.grupo_id = v_g.id
      join public.participantes p on p.id = sp.participante_id
     where sp.setor_id = v.setor_id and sp.saiu_em is null and not p.removido and p.liberado_em is null;
    perform public.criar_alerta(v.operacao_id, 'permanencia_setor', 'info',
      'Permanência no setor ' || v_s.nome || ' — ' || v_g.nome || ' há ' || public.texto_duracao(v_limiar),
      'No setor há: ' || coalesce(v_lista, v_p.nome) || ' (pela trilha GPS). Avalie a troca da equipe. Limite da operação: ' ||
        public.texto_duracao(v_op.permanencia_limite_min) || '.',
      'permanencia:g:' || v_g.id || ':' || v.setor_id || ':' || v_limiar || ':' || v.id,
      null, v_g.id, v.participante_id, p_lat, p_lng, p_ate);
  else
    perform public.criar_alerta(v.operacao_id, 'permanencia_setor', 'info',
      'Permanência no setor ' || v_s.nome || ' — ' || v_p.nome || ' há ' || public.texto_duracao(v_limiar),
      v_p.nome || ' (' || case v_p.tipo when 'militar' then 'militar' else 'civil' end || ') está no setor há ' ||
        public.texto_duracao(v_min) || ' (pela trilha GPS). Avalie a troca. Limite da operação: ' ||
        public.texto_duracao(v_op.permanencia_limite_min) || '.',
      'permanencia:p:' || v.id || ':' || v_limiar,
      null, null, v.participante_id, p_lat, p_lng, p_ate);
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------
-- Avaliação pela trilha GPS (chamada depois de gravar posições)
-- ---------------------------------------------------------------------
create or replace function public.avaliar_permanencia(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
  v_cursor bigint;
  v_max bigint;
  v_setores public.setores[];
  v_s public.setores;
  e public.setor_presenca%rowtype;
  v_perm public.setor_permanencias%rowtype;
  v_dentro boolean;
  v_ult record;
  pt record;
begin
  select * into v_part from public.participantes where id = p_participante;
  if not found or v_part.tipo = 'responsavel' then
    return;
  end if;
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  if v_op.status <> 'ativa' then
    return;
  end if;
  select array_agg(s order by s.criado_em) into v_setores from public.setores s where s.operacao_id = v_op.id;

  -- cursor: na primeira vez, olha só as últimas 12 h da trilha
  insert into public.permanencia_cursor (participante_id, ultimo_pos_id)
  values (p_participante, coalesce((select min(id) - 1 from public.posicoes
                                     where participante_id = p_participante and registrado_em > now() - interval '12 hours'), 0))
  on conflict (participante_id) do nothing;
  select ultimo_pos_id into v_cursor from public.permanencia_cursor where participante_id = p_participante for update;
  select max(id) into v_max from public.posicoes where participante_id = p_participante and id > v_cursor;
  if v_max is null then
    return;
  end if;
  update public.permanencia_cursor set ultimo_pos_id = v_max where participante_id = p_participante;
  if v_setores is null then
    return;
  end if;

  foreach v_s in array v_setores loop
    select * into e from public.setor_presenca where participante_id = p_participante and setor_id = v_s.id;
    if not found then
      e.participante_id := p_participante; e.setor_id := v_s.id; e.operacao_id := v_op.id;
      e.dentro_seq := 0; e.fora_seq := 0;
    end if;
    select * into v_perm from public.setor_permanencias
     where participante_id = p_participante and setor_id = v_s.id and saiu_em is null;
    v_ult := null;

    for pt in
      select id, lat, lng, precisao, registrado_em from public.posicoes
       where participante_id = p_participante and id > v_cursor and id <= v_max
         and (precisao is null or precisao <= 150)
       order by registrado_em, id
    loop
      -- pontos atrasados, anteriores ao que já foi avaliado, não reabrem nada
      if v_perm.id is not null and pt.registrado_em < v_perm.ultimo_dentro_em then
        continue;
      end if;
      v_dentro := public.ponto_no_setor(v_s, pt.lat, pt.lng);
      if v_dentro then
        e.fora_seq := 0; e.cand_fora_em := null;
        if v_perm.id is not null then
          v_perm.ultimo_dentro_em := greatest(v_perm.ultimo_dentro_em, pt.registrado_em);
          v_ult := pt;
        else
          e.dentro_seq := least(e.dentro_seq + 1, 2);
          if e.dentro_seq = 1 then
            e.cand_em := pt.registrado_em; e.cand_lat := pt.lat; e.cand_lng := pt.lng;
          end if;
          if e.dentro_seq >= 2 then
            -- voltou logo depois de sair (oscilação na borda): continua a mesma permanência
            select * into v_perm from public.setor_permanencias
             where participante_id = p_participante and setor_id = v_s.id and saiu_em is not null
               and saiu_em >= e.cand_em - interval '5 minutes'
             order by saiu_em desc limit 1;
            if found then
              update public.setor_permanencias set saiu_em = null, ultimo_dentro_em = pt.registrado_em
               where id = v_perm.id returning * into v_perm;
            else
              insert into public.setor_permanencias (operacao_id, setor_id, participante_id, entrou_em, ultimo_dentro_em, entrada_lat, entrada_lng)
              values (v_op.id, v_s.id, p_participante, e.cand_em, pt.registrado_em, e.cand_lat, e.cand_lng)
              returning * into v_perm;
            end if;
            e.dentro_seq := 0; e.cand_em := null;
            v_ult := pt;
          end if;
        end if;
      else
        e.dentro_seq := 0; e.cand_em := null;
        if v_perm.id is not null then
          e.fora_seq := least(e.fora_seq + 1, 3);
          if e.fora_seq = 1 then
            e.cand_fora_em := pt.registrado_em;
          end if;
          if e.fora_seq >= 3 then
            update public.setor_permanencias set saiu_em = e.cand_fora_em, ultimo_dentro_em = v_perm.ultimo_dentro_em
             where id = v_perm.id;
            v_perm := null;
            v_ult := null;
            e.fora_seq := 0; e.cand_fora_em := null;
          end if;
        end if;
      end if;
    end loop;

    if v_perm.id is not null then
      update public.setor_permanencias set ultimo_dentro_em = v_perm.ultimo_dentro_em
       where id = v_perm.id and ultimo_dentro_em < v_perm.ultimo_dentro_em;
      -- passou do limite? (pelo horário do GPS do último ponto dentro)
      perform public.alertar_permanencia(v_perm.id, v_perm.ultimo_dentro_em,
                                         coalesce(v_ult.lat, v_part.ultima_lat), coalesce(v_ult.lng, v_part.ultima_lng));
    end if;

    insert into public.setor_presenca (participante_id, setor_id, operacao_id, dentro_seq, fora_seq, cand_em, cand_lat, cand_lng, cand_fora_em)
    values (e.participante_id, e.setor_id, e.operacao_id, e.dentro_seq, e.fora_seq, e.cand_em, e.cand_lat, e.cand_lng, e.cand_fora_em)
    on conflict (participante_id, setor_id) do update
      set dentro_seq = excluded.dentro_seq, fora_seq = excluded.fora_seq, cand_em = excluded.cand_em,
          cand_lat = excluded.cand_lat, cand_lng = excluded.cand_lng, cand_fora_em = excluded.cand_fora_em
      where (setor_presenca.dentro_seq, setor_presenca.fora_seq, setor_presenca.cand_em, setor_presenca.cand_fora_em)
            is distinct from (excluded.dentro_seq, excluded.fora_seq, excluded.cand_em, excluded.cand_fora_em);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Gancho apos_posicoes: deslocamentos (010) + permanência (013)
-- A versão da 010 vira apos_posicoes_missoes; apos_posicoes chama as duas.
-- (Idempotente: se o schema.sql recriar a versão da 010, ela é renomeada de novo.)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'apos_posicoes'
                and pg_get_function_identity_arguments(p.oid) = 'p_participante uuid'
                and p.prosrc not like '%avaliar_permanencia%') then
    drop function if exists public.apos_posicoes_missoes(uuid);
    alter function public.apos_posicoes(uuid) rename to apos_posicoes_missoes;
  end if;
end;
$$;

create or replace function public.apos_posicoes(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  begin
    perform public.apos_posicoes_missoes(p_participante);
  exception when others then
    raise warning 'apos_posicoes (deslocamentos): %', sqlerrm;
  end;
  begin
    perform public.avaliar_permanencia(p_participante);
  exception when others then
    raise warning 'apos_posicoes (permanência): %', sqlerrm;   -- nunca impede a gravação das posições
  end;
end;
$$;

-- ---------------------------------------------------------------------
-- Configuração do limite (responsáveis da operação)
-- ---------------------------------------------------------------------
create or replace function public.configurar_permanencia(p_operacao uuid, p_limite_min integer)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_op public.operacoes%rowtype;
  v_antes integer;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if p_limite_min is null or not (p_limite_min = 0 or p_limite_min between 10 and 720) then
    raise exception 'permanencia_invalida';
  end if;
  select permanencia_limite_min into v_antes from public.operacoes where id = p_operacao for update;
  update public.operacoes set permanencia_limite_min = p_limite_min, atualizado_em = now(), atualizado_por_nome = v_nome
   where id = p_operacao returning * into v_op;
  if v_antes is distinct from p_limite_min then
    perform public.diario_auto(p_operacao, now(), 'operacao', 'permanencia_limite',
      case when p_limite_min = 0 then 'Alerta de permanência em setor desligado'
           else 'Limite de permanência em setor: ' || public.texto_duracao(p_limite_min) end,
      case when coalesce(v_antes, 0) = 0 then '' else 'Antes: ' || public.texto_duracao(v_antes) end,
      'permanencia_limite:' || p_operacao || ':' || p_limite_min || ':' || txid_current() || ':' || (extract(epoch from clock_timestamp()) * 1000)::bigint,
      'info', null, null, p_operacao::text, v_nome);
  end if;
  return row_to_json(v_op);
end;
$$;

-- Diário: o alerta de permanência entra como "Alerta" (os demais continuam como na 012)
create or replace function public.diario_de_alerta()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.tipo = 'vitima_localizada' then
      return new;
    end if;
    perform public.diario_auto(new.operacao_id, coalesce(new.posicao_em, new.criado_em),
      case new.tipo when 'chegou_setor' then 'chegada' when 'chegou_base' then 'chegada'
                    when 'retorno_atrasado' then 'alerta' when 'permanencia_setor' then 'alerta' else 'deslocamento' end,
      'alerta_' || new.tipo, new.titulo, new.texto, 'alerta:' || new.id, new.nivel, new.lat, new.lng, new.id::text, 'Sistema');
  elsif new.nivel = 'critico' and old.reconhecido_em is null and new.reconhecido_em is not null then
    perform public.diario_auto(new.operacao_id, new.reconhecido_em, 'alerta', 'alerta_ciente',
      'Ciente do alerta: ' || new.titulo, '', 'alerta_ciente:' || new.id, 'info', null, null, new.id::text, new.reconhecido_por_nome);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Permissões e tempo real
-- ---------------------------------------------------------------------
revoke execute on function public.alertar_permanencia(uuid, timestamptz, double precision, double precision),
  public.avaliar_permanencia(uuid), public.apos_posicoes(uuid), public.apos_posicoes_missoes(uuid)
  from public, anon, authenticated;
revoke execute on function public.configurar_permanencia(uuid, integer), public.texto_duracao(integer) from public, anon;
grant execute on function public.configurar_permanencia(uuid, integer), public.texto_duracao(integer) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.setor_permanencias';
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

notify pgrst, 'reload schema';
