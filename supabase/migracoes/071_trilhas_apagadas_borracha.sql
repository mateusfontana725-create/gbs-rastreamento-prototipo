-- =====================================================================
-- 071 · Apagar trechos da trilha de GPS de um participante (borracha), sem apagar posições
--       (migração idempotente; exige a 066 (trilhas), a 068 (descansos) e a 069 (link público))
--
--  1. trilhas_ocultas: por participante, os intervalos de horário (de, ate) que o responsável apagou do mapa com a
--     borracha. As posições continuam guardadas no banco (nada é apagado): o painel só não desenha, nem conta na
--     distância e na fadiga, os pontos desses intervalos. Quem ainda está na busca continua aparecendo: os pontos
--     novos, fora dos intervalos, são desenhados normalmente. Dá para restaurar (lista vazia).
--  2. salvar_trilha_oculta(participante, intervalos): troca a lista inteira (só responsáveis da operação, operação
--     ativa). O que foi apagado ou restaurado entra no diário.
--  3. trilhas_da_equipe (mapa do participante) e comando_publico (link público) deixam de entregar os pontos apagados.
-- =====================================================================

create table if not exists public.trilhas_ocultas (
  participante_id     uuid primary key references public.participantes(id) on delete cascade,
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  intervalos          jsonb not null default '[]'::jsonb,
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text
);
create index if not exists trilhas_ocultas_operacao_idx on public.trilhas_ocultas (operacao_id);

alter table public.trilhas_ocultas enable row level security;
drop policy if exists trilhas_ocultas_ler on public.trilhas_ocultas;
create policy trilhas_ocultas_ler on public.trilhas_ocultas for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.trilhas_ocultas from anon;
revoke insert, update, delete, truncate on public.trilhas_ocultas from authenticated;
grant select on public.trilhas_ocultas to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.trilhas_ocultas';
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

-- p_intervalos: [{ "de": "2026-11-08T10:00:00Z", "ate": "2026-11-08T10:05:00Z" }, …] (no máximo 300). [] restaura tudo.
create or replace function public.salvar_trilha_oculta(p_participante uuid, p_intervalos jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
  v_novos jsonb := '[]'::jsonb;
  v_antes integer;
  e jsonb;
  v_de timestamptz;
  v_ate timestamptz;
begin
  select * into v_part from public.participantes where id = p_participante;
  if not found or v_nome is null or not public.dono_operacao(v_part.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  if v_op.status <> 'ativa' or v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  if p_intervalos is null or jsonb_typeof(p_intervalos) <> 'array' or jsonb_array_length(p_intervalos) > 300 then
    raise exception 'dados_invalidos';
  end if;
  for e in select x from jsonb_array_elements(p_intervalos) x loop
    if jsonb_typeof(e) <> 'object' then
      raise exception 'dados_invalidos';
    end if;
    begin
      v_de := (e ->> 'de')::timestamptz;
      v_ate := (e ->> 'ate')::timestamptz;
    exception when others then
      raise exception 'dados_invalidos';
    end;
    if v_de is null or v_ate is null or v_de > v_ate then
      raise exception 'dados_invalidos';
    end if;
    v_novos := v_novos || jsonb_build_object('de', v_de, 'ate', v_ate);
  end loop;

  select coalesce(jsonb_array_length(intervalos), 0) into v_antes from public.trilhas_ocultas where participante_id = v_part.id;
  insert into public.trilhas_ocultas (participante_id, operacao_id, intervalos, atualizado_em, atualizado_por_nome)
  values (v_part.id, v_part.operacao_id, v_novos, now(), v_nome)
  on conflict (participante_id) do update
    set intervalos = excluded.intervalos, atualizado_em = now(), atualizado_por_nome = v_nome;

  perform public.diario_auto(v_part.operacao_id, now(), 'operacao', 'trilha_apagada',
    case when jsonb_array_length(v_novos) = 0 then 'Trilha de ' || coalesce(v_part.nome_painel, v_part.nome) || ': trechos apagados restaurados'
         else 'Trilha de ' || coalesce(v_part.nome_painel, v_part.nome) || ': trechos apagados do mapa (' || jsonb_array_length(v_novos) || ')' end,
    'Os pontos continuam guardados no banco; só deixam de aparecer na trilha.',
    'trilha_apagada:' || v_part.id || ':' || (extract(epoch from clock_timestamp()) * 1000000)::bigint,
    'info', null, null, null, v_nome);
  return json_build_object('participante_id', v_part.id, 'intervalos', v_novos);
end;
$$;
revoke execute on function public.salvar_trilha_oculta(uuid, jsonb) from public, anon;
grant execute on function public.salvar_trilha_oculta(uuid, jsonb) to authenticated;

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
                     and not exists (select 1 from public.trilhas_ocultas h, jsonb_array_elements(h.intervalos) e
                                      where h.participante_id = q.participante_id
                                        and q.registrado_em between (e ->> 'de')::timestamptz and (e ->> 'ate')::timestamptz)
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

create or replace function public.comando_publico(p_token text, p_desde bigint default null)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
  v_nomes boolean;
  v_fora constant text[] := array['user_id', 'cpf', 'telefone', 'saida_motivo', 'criado_por', 'criado_por_nome', 'atualizado_por',
                                  'atualizado_por_nome', 'removido_por_nome', 'reincluido_por_nome', 'adicionado_por_nome',
                                  'decidido_por', 'decidido_por_nome', 'enviado_por', 'enviado_por_nome', 'encerrado_por_nome'];
  v_part jsonb;
  v_pos jsonb;
  v_ate bigint;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then
    raise exception 'link_publico_comando_invalido';
  end if;
  select * into v_op from public.operacoes where comando_token = p_token;
  if not found then
    raise exception 'link_publico_comando_invalido';
  end if;
  v_nomes := v_op.comando_publico_nomes;

  select coalesce(jsonb_agg(
           (to_jsonb(p) - v_fora) ||
           case when v_nomes then '{}'::jsonb
                else jsonb_build_object('nome', case when p.tipo = 'responsavel' then 'Responsável ' else 'Participante ' end || p.n, 'nome_painel', null) end
           order by p.criado_em), '[]'::jsonb)
    into v_part
    from (select x.*, row_number() over (partition by (x.tipo = 'responsavel') order by x.criado_em, x.id) as n
            from public.participantes x where x.operacao_id = v_op.id) p;

  if p_desde is null then
    select coalesce(jsonb_agg(to_jsonb(q) order by q.id), '[]'::jsonb) into v_pos
      from (select id, operacao_id, participante_id, lat, lng, precisao, registrado_em, recebido_em, na_base
              from public.posicoes where operacao_id = v_op.id order by id desc limit 60000) q;
  else
    select coalesce(jsonb_agg(to_jsonb(q) order by q.id), '[]'::jsonb) into v_pos
      from (select id, operacao_id, participante_id, lat, lng, precisao, registrado_em, recebido_em, na_base
              from public.posicoes where operacao_id = v_op.id and id > p_desde order by id limit 60000) q;
  end if;
  select max(id) into v_ate from public.posicoes where operacao_id = v_op.id;

  return json_build_object(
    'formato', 'gbs-arquivo-operacao',
    'publico', true,
    'agora', now(),
    'nomes', v_nomes,
    'posicoes_ate', coalesce(v_ate, 0),
    'incremental', p_desde is not null,
    'operacao', jsonb_build_object(
      'id', v_op.id, 'codigo', v_op.codigo, 'status', v_op.status, 'tipo', v_op.tipo, 'tipo_outro', v_op.tipo_outro,
      'acionado_em', v_op.acionado_em, 'criada_em', v_op.criada_em, 'encerrada_em', v_op.encerrada_em,
      'local_lat', v_op.local_lat, 'local_lng', v_op.local_lng),
    'tabelas', jsonb_build_object(
      'participantes', v_part,
      'posicoes', v_pos,
      'setores', coalesce((select jsonb_agg(to_jsonb(x) - v_fora order by x.criado_em) from public.setores x where x.operacao_id = v_op.id), '[]'::jsonb),
      'pontos_interesse', coalesce((select jsonb_agg(to_jsonb(x) - v_fora order by x.criado_em) from public.pontos_interesse x
                                     where x.operacao_id = v_op.id and x.categoria <> 'VITIMA_ENCONTRADA'), '[]'::jsonb),
      'destinos', coalesce((select jsonb_agg(to_jsonb(x) - v_fora) from public.destinos x where x.operacao_id = v_op.id and x.encerrado_em is null), '[]'::jsonb),
      'trilhas_manuais', coalesce((select jsonb_agg(to_jsonb(x) - v_fora order by x.criado_em) from public.trilhas_manuais x where x.operacao_id = v_op.id), '[]'::jsonb),
      'areas_proibidas', coalesce((select jsonb_agg(to_jsonb(x) - v_fora order by x.criado_em) from public.areas_proibidas x where x.operacao_id = v_op.id), '[]'::jsonb),
      'areas_sem_trilha', coalesce((select jsonb_agg(to_jsonb(x) - v_fora order by x.criado_em) from public.areas_sem_trilha x where x.operacao_id = v_op.id), '[]'::jsonb),
      'grupos', coalesce((select jsonb_agg(to_jsonb(x) - v_fora order by x.nome) from public.grupos x where x.operacao_id = v_op.id), '[]'::jsonb),
      'grupo_membros', coalesce((select jsonb_agg(to_jsonb(x) - v_fora) from public.grupo_membros x where x.operacao_id = v_op.id), '[]'::jsonb),
      'descansos', coalesce((select jsonb_agg(to_jsonb(x) - v_fora order by x.inicio) from public.descansos x where x.operacao_id = v_op.id), '[]'::jsonb),
      'trilhas_ocultas', coalesce((select jsonb_agg(to_jsonb(x) - v_fora) from public.trilhas_ocultas x where x.operacao_id = v_op.id), '[]'::jsonb),
      'setor_permanencias', coalesce((select jsonb_agg(to_jsonb(x) - v_fora) from public.setor_permanencias x where x.operacao_id = v_op.id and x.saiu_em is null), '[]'::jsonb),
      'tipos_ponto', coalesce((select jsonb_agg(to_jsonb(x) - v_fora) from public.tipos_ponto x), '[]'::jsonb),
      'categorias_ponto_estilo', coalesce((select jsonb_agg(to_jsonb(x) - v_fora) from public.categorias_ponto_estilo x), '[]'::jsonb)));
end;
$$;


notify pgrst, 'reload schema';
