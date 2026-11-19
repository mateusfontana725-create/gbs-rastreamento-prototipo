-- =====================================================================
-- 085_trilhas_dias_trechos.sql — trilhas de cada dia em TRECHOS (só troca uma função; idempotente)
--
--  relatorio_trilhas_dias (migração 083) devolvia a trilha do dia de cada pessoa como uma linha só: o relatório ligava os
--  dois lados de uma falha de GPS (o celular ficou sem enviar e voltou em outro lugar) com uma reta riscando o mapa. Agora
--  devolve também "segmentos": a trilha dividida com a MESMA regra do painel — um trecho novo quando passam mais de
--  operacoes.gps_lacuna_s segundos entre dois pontos (falha) ou quando o salto é impossível a pé/de carro (mais de 70 m/s).
--  Cada trecho vem resumido (até 60 pontos) e os quilômetros só somam dentro dos trechos. "pontos" continua igual (as
--  versões antigas da página usam).
-- =====================================================================

create or replace function public.relatorio_trilhas_dias(p_operacao uuid, p_ini date, p_fim date, p_fuso text default null)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_fuso text := 'America/Sao_Paulo';
  v_lacuna double precision;
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
  select coalesce(gps_lacuna_s, 60) into v_lacuna from public.operacoes where id = p_operacao;
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
             lag(b.lat) over w as lat0, lag(b.lng) over w as lng0, lag(b.registrado_em) over w as t0
        from base b
       where not b.na_base
      window w as (partition by b.participante_id, b.dia order by b.registrado_em)
    ),
    marcado as (
      select l.*, x.km,
             case when l.t0 is null then 1
                  when extract(epoch from l.registrado_em - l.t0) > v_lacuna then 1
                  when x.km * 1000 > 50 and x.km * 1000 / greatest(extract(epoch from l.registrado_em - l.t0), 0.5) > 70 then 1
                  else 0 end as novo
        from linha l
        cross join lateral (select case when l.lat0 is null then null else public.distancia_km(l.lat0, l.lng0, l.lat, l.lng) end as km) x
    ),
    trecho as (
      select m.*, sum(m.novo) over (partition by m.participante_id, m.dia order by m.registrado_em) as seg from marcado m
    ),
    numerado as (
      select t.*, row_number() over (partition by t.participante_id, t.dia, t.seg order by t.registrado_em) as rs,
             count(*) over (partition by t.participante_id, t.dia, t.seg) as ts
        from trecho t
    ),
    por_trecho as (
      select participante_id, dia, seg,
             coalesce(sum(km) filter (where novo = 0 and km < 1.5), 0) as km,
             json_agg(json_build_array(round(lat::numeric, 6), round(lng::numeric, 6)) order by registrado_em)
               filter (where rs = 1 or rs = ts or rs % greatest(1, ceil(ts / 60.0)::int) = 0) as pts,
             count(*) as n
        from numerado group by participante_id, dia, seg
    ),
    trechos as (
      select participante_id, dia, sum(km) as km, json_agg(pts order by seg) filter (where n >= 2) as segmentos
        from por_trecho group by participante_id, dia
    ),
    pontos as (
      select l.participante_id, l.dia,
             json_agg(json_build_array(round(l.lat::numeric, 6), round(l.lng::numeric, 6)) order by l.registrado_em)
               filter (where l.rn = 1 or l.rn = l.total or l.rn % greatest(1, ceil(l.total / 150.0)::int) = 0) as pontos
        from linha l group by l.participante_id, l.dia
    )
    select json_agg(json_build_object(
             'participante_id', r.participante_id, 'nome', pa.nome, 'tipo', pa.tipo,
             'dia', to_char(r.dia, 'YYYY-MM-DD'), 'primeiro', r.primeiro, 'ultimo', r.ultimo, 'n', r.n,
             'km', round(coalesce(t.km, 0)::numeric, 2), 'pontos', coalesce(p.pontos, '[]'::json),
             'segmentos', coalesce(t.segmentos, '[]'::json))
             order by r.dia, pa.nome)
      from resumo r
      join public.participantes pa on pa.id = r.participante_id
      left join trechos t on t.participante_id = r.participante_id and t.dia = r.dia
      left join pontos p on p.participante_id = r.participante_id and p.dia = r.dia
  ), '[]'::json);
end;
$$;
revoke execute on function public.relatorio_trilhas_dias(uuid, date, date, text) from public, anon;
grant execute on function public.relatorio_trilhas_dias(uuid, date, date, text) to authenticated;

notify pgrst, 'reload schema';
