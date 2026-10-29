-- =====================================================================
-- 49. Qualidade dos dados dos estudos (denominadores)
--     (migração 043 — idempotente; exige a 023 e a 042)
--
--  Ao lado dos números do dashboard, diz SOBRE O QUE eles foram calculados:
--   - unidade de análise: a operação (um caso = a primeira localização de vítima com posição);
--   - casos elegíveis (operações encerradas + abertas com localização), válidos para distância
--     (ULV e posição da localização) e para tempo (início e hora da localização, sem tempo negativo);
--   - ausentes: falta ULV, falta posição da localização, falta hora de início — NUNCA viram zero;
--   - não localizados: operações encerradas sem localização (censuradas: ficam fora das medianas);
--   - abertas sem localização (ainda em andamento);
--   - possíveis duplicatas: duas operações do mesmo tipo com ULV a menos de 1 km e início a menos de 48 h;
--   - fichas: idade não informada, idade estimada, sem perfil.
--  Só contagens de operações e de fichas; fichas com menos de 5 casos ficam ocultas (k = 5).
-- =====================================================================
create or replace function public.estudo_qualidade()
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_ops uuid[];
begin
  if public.nome_responsavel_atual() is null then
    raise exception 'sem_permissao';
  end if;
  select coalesce(array_agg(o.id), '{}'::uuid[]) into v_ops from public.operacoes o where public.dono_operacao(o.id);
  return (
    with ops as (
      select o.id, o.tipo, o.acionado_em, o.criada_em, o.encerrada_em, o.local_lat, o.local_lng
        from public.operacoes o where o.id = any(v_ops)
    ),
    loc as (
      select v.operacao_id,
             bool_or(v.lat is not null) as com_posicao,
             min(coalesce(v.posicao_em, v.registrado_em)) filter (where v.lat is not null) as em
        from public.vitima_localizacoes v where v.operacao_id = any(v_ops) group by v.operacao_id
    ),
    base as (
      select o.*, l.operacao_id is not null as tem_localizacao, coalesce(l.com_posicao, false) as com_posicao, l.em
        from ops o left join loc l on l.operacao_id = o.id
    ),
    dup as (
      select distinct x.id from ops x join ops y on y.id <> x.id
       where x.local_lat is not null and y.local_lat is not null and coalesce(x.tipo, '') = coalesce(y.tipo, '')
         and abs(extract(epoch from coalesce(x.acionado_em, x.criada_em) - coalesce(y.acionado_em, y.criada_em))) <= 48 * 3600
         and public.distancia_km(x.local_lat, x.local_lng, y.local_lat, y.local_lng) < 1
    ),
    fichas as (
      select t.idade, t.idade_qualidade, t.perfil from public.vitimas t where t.operacao_id = any(v_ops)
    )
    select json_build_object(
      'gerado_em', now(),
      'k_minimo', 5,
      'unidade', 'operacao',
      'operacoes', (select count(*) from ops),
      'elegiveis', (select count(*) from base where encerrada_em is not null or tem_localizacao),
      'com_localizacao', (select count(*) from base where com_posicao),
      'validos_distancia', (select count(*) from base where com_posicao and local_lat is not null),
      'validos_tempo', (select count(*) from base where com_posicao and acionado_em is not null and em >= acionado_em),
      'ausentes', json_build_object(
        'ulv', (select count(*) from base where com_posicao and local_lat is null),
        'posicao_localizacao', (select count(*) from base where tem_localizacao and not com_posicao),
        'inicio', (select count(*) from base where com_posicao and acionado_em is null)),
      'tempo_negativo', (select count(*) from base where com_posicao and acionado_em is not null and em < acionado_em),
      'nao_localizados', (select count(*) from base where encerrada_em is not null and not tem_localizacao),
      'abertas_sem_localizacao', (select count(*) from base where encerrada_em is null and not tem_localizacao),
      'possiveis_duplicatas', (select count(*) from dup),
      'fichas', json_build_object(
        'total', (select case when count(*) >= 5 then count(*) end from fichas),
        'idade_nao_informada', (select case when count(*) >= 5 then count(*) end from fichas where idade is null),
        'idade_estimada', (select case when count(*) >= 5 then count(*) end from fichas where idade is not null and idade_qualidade = 'estimada'),
        'sem_perfil', (select case when count(*) >= 5 then count(*) end from fichas where cardinality(perfil) = 0))
    )
  );
end;
$$;

revoke execute on function public.estudo_qualidade() from public, anon;
grant execute on function public.estudo_qualidade() to authenticated;

notify pgrst, 'reload schema';
