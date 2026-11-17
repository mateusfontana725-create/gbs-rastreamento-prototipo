-- =====================================================================
-- 083_ipo_diario.sql — IPO (Diário): trilhas de cada dia para o relatório (só acréscimos; idempotente)
--
--  O IPO passa a ser preenchido dia a dia junto com o diário (operacoes.ipo: desdobramentos, efetivo e "dias", com
--  procedimentos, recursos, órgãos de apoio e a situação ao fim de cada dia; nada muda no banco para isso).
--  relatorio_trilhas_dias(p_operacao, p_ini, p_fim, p_fuso): para o relatório do IPO (Diário) de um dia ou de um período,
--  devolve, por pessoa e por dia (no fuso do aparelho), a primeira e a última posição, quantas foram, os quilômetros
--  andados e a trilha resumida (até 150 pontos). Segue as mesmas regras do mapa: sem os trechos apagados com a borracha
--  (trilhas_ocultas), sem os pontos dentro da base na linha e só pontos com precisão até 100 m.
-- =====================================================================

create or replace function public.relatorio_trilhas_dias(p_operacao uuid, p_ini date, p_fim date, p_fuso text default null)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_fuso text := 'America/Sao_Paulo';
begin
  if public.nome_responsavel_atual() is null or p_operacao is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if p_ini is null or p_fim is null or p_fim < p_ini or p_fim - p_ini > 400 then
    raise exception 'dados_invalidos';
  end if;
  if p_fuso is not null and exists (select 1 from pg_timezone_names where name = p_fuso) then
    v_fuso := p_fuso;
  end if;
  return coalesce((
    with base as (
      select po.participante_id, po.lat, po.lng, po.registrado_em, coalesce(po.na_base, false) as na_base,
             (po.registrado_em at time zone v_fuso)::date as dia
        from public.posicoes po
       where po.operacao_id = p_operacao
         and po.registrado_em >= (p_ini::timestamp at time zone v_fuso)
         and po.registrado_em < ((p_fim + 1)::timestamp at time zone v_fuso)
         and (po.precisao is null or po.precisao <= 100)
         and not exists (select 1 from public.trilhas_ocultas h, jsonb_array_elements(h.intervalos) e
                          where h.participante_id = po.participante_id
                            and po.registrado_em between (e ->> 'de')::timestamptz and (e ->> 'ate')::timestamptz)
    ),
    resumo as (
      select participante_id, dia, min(registrado_em) as primeiro, max(registrado_em) as ultimo, count(*) as n
        from base group by participante_id, dia
    ),
    linha as (
      select b.participante_id, b.dia, b.lat, b.lng, b.registrado_em,
             row_number() over w as rn, count(*) over (partition by b.participante_id, b.dia) as total,
             lag(b.lat) over w as lat0, lag(b.lng) over w as lng0
        from base b
       where not b.na_base
      window w as (partition by b.participante_id, b.dia order by b.registrado_em)
    ),
    trilha as (
      select l.participante_id, l.dia,
             coalesce(sum(x.km) filter (where x.km < 1.5), 0) as km,
             json_agg(json_build_array(round(l.lat::numeric, 6), round(l.lng::numeric, 6)) order by l.registrado_em)
               filter (where l.rn = 1 or l.rn = l.total or l.rn % greatest(1, ceil(l.total / 150.0)::int) = 0) as pontos
        from linha l
        cross join lateral (select case when l.lat0 is null then null else public.distancia_km(l.lat0, l.lng0, l.lat, l.lng) end as km) x
       group by l.participante_id, l.dia
    )
    select json_agg(json_build_object(
             'participante_id', r.participante_id, 'nome', pa.nome, 'tipo', pa.tipo,
             'dia', to_char(r.dia, 'YYYY-MM-DD'), 'primeiro', r.primeiro, 'ultimo', r.ultimo, 'n', r.n,
             'km', round(coalesce(t.km, 0)::numeric, 2), 'pontos', coalesce(t.pontos, '[]'::json))
             order by r.dia, pa.nome)
      from resumo r
      join public.participantes pa on pa.id = r.participante_id
      left join trilha t on t.participante_id = r.participante_id and t.dia = r.dia
  ), '[]'::json);
end;
$$;
revoke execute on function public.relatorio_trilhas_dias(uuid, date, date, text) from public, anon;
grant execute on function public.relatorio_trilhas_dias(uuid, date, date, text) to authenticated;

notify pgrst, 'reload schema';
