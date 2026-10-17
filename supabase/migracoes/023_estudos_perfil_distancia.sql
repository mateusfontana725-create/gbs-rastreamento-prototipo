-- =====================================================================
-- 29. Perfil da vítima e estudos (migração 023 — idempotente; exige a 021 e a 011)
--
--  Ficha de vítima ganha o perfil (idoso, criança, adolescente, demência, autismo, deficiência intelectual,
--  transtorno mental, outro). Distância = do ULV (ponto do cadastro) à primeira localização da vítima.
--  estudo_operacao (painel da operação) e estudo_geral (painel inicial) devolvem só agregados e não
--  trazem nomes nem dados de participantes. Grupos com menos de 5 casos são ocultados.
-- =====================================================================
alter table public.vitimas add column if not exists perfil text[] not null default '{}' check (perfil <@ array['idoso', 'crianca', 'adolescente', 'demencia', 'autismo', 'deficiencia_intelectual', 'transtorno_mental', 'outro']::text[]);

create or replace function public.salvar_vitima(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v public.vitimas%rowtype;
  v_op public.operacoes%rowtype;
  v_idade numeric;
begin
  if v_nome_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;

  if p_id is null then
    v.id := gen_random_uuid();
    v.operacao_id := p_operacao;
    v.criado_por := auth.uid();
    v.criado_por_nome := v_nome_resp;
    v.criado_em := now();
    v.caracteristicas := '';
    v.roupas := '';
    v.observacoes := '';
    v.perfil := '{}';
  else
    select * into v from public.vitimas where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'vitima_nao_encontrada';
    end if;
  end if;

  if p_dados ? 'nome' then v.nome := btrim(regexp_replace(coalesce(p_dados->>'nome', ''), '\s+', ' ', 'g')); end if;
  if p_dados ? 'caracteristicas' then v.caracteristicas := btrim(coalesce(p_dados->>'caracteristicas', '')); end if;
  if p_dados ? 'roupas' then v.roupas := btrim(coalesce(p_dados->>'roupas', '')); end if;
  if p_dados ? 'observacoes' then v.observacoes := btrim(coalesce(p_dados->>'observacoes', '')); end if;
  if p_dados ? 'nascimento' then v.nascimento := nullif(btrim(coalesce(p_dados->>'nascimento', '')), ''); end if;
  if p_dados ? 'sexo' then v.sexo := nullif(btrim(coalesce(p_dados->>'sexo', '')), ''); end if;
  if p_dados ? 'perfil' then
    if jsonb_typeof(p_dados->'perfil') <> 'array' then
      raise exception 'dados_invalidos';
    end if;
    v.perfil := array(select jsonb_array_elements_text(p_dados->'perfil'));
  end if;
  if p_dados ? 'origem' then v.origem := nullif(btrim(regexp_replace(coalesce(p_dados->>'origem', ''), '\s+', ' ', 'g')), ''); end if;
  if p_dados ? 'idade' then
    if coalesce(jsonb_typeof(p_dados->'idade'), 'null') = 'null' then
      v.idade := null;
    elsif jsonb_typeof(p_dados->'idade') = 'number' then
      v_idade := (p_dados->>'idade')::numeric;
      if v_idade <> trunc(v_idade) or v_idade not between 0 and 130 then
        raise exception 'dados_invalidos';
      end if;
      v.idade := v_idade::smallint;
    else
      raise exception 'dados_invalidos';
    end if;
  end if;

  if v.nome is null or char_length(v.nome) not between 1 and 80 then
    raise exception 'nome_vitima_invalido';
  end if;
  if char_length(v.caracteristicas) > 1000 or char_length(v.roupas) > 1000 or char_length(v.observacoes) > 2000 then
    raise exception 'dados_invalidos';
  end if;
  if (v.sexo is not null and v.sexo not in ('M', 'F')) or char_length(coalesce(v.nascimento, '')) > 20 or char_length(coalesce(v.origem, '')) > 120 then
    raise exception 'dados_invalidos';
  end if;

  if not (v.perfil <@ array['idoso', 'crianca', 'adolescente', 'demencia', 'autismo', 'deficiencia_intelectual', 'transtorno_mental', 'outro']::text[]) then
    raise exception 'dados_invalidos';
  end if;
  v.atualizado_em := now();
  v.atualizado_por_nome := v_nome_resp;
  if p_id is null then
    insert into public.vitimas select v.*;
  else
    update public.vitimas set nome = v.nome, idade = v.idade, caracteristicas = v.caracteristicas, roupas = v.roupas,
           observacoes = v.observacoes, perfil = v.perfil, nascimento = v.nascimento, sexo = v.sexo, origem = v.origem, atualizado_em = v.atualizado_em, atualizado_por_nome = v.atualizado_por_nome
     where id = v.id;
  end if;
  return row_to_json(v);
end;
$$;

-- Distância em km entre dois pontos (fórmula de Haversine; raio médio da Terra)
create or replace function public.distancia_km(a_lat double precision, a_lng double precision, b_lat double precision, b_lng double precision)
returns double precision
language sql immutable
as $$
  select 2 * 6371.0088 * asin(least(1, sqrt(
    power(sin(radians(b_lat - a_lat) / 2), 2) + cos(radians(a_lat)) * cos(radians(b_lat)) * power(sin(radians(b_lng - a_lng) / 2), 2))));
$$;

-- Estudo de uma operação: ULV (ponto do cadastro), primeira localização da vítima, perfis das fichas.
-- Não devolve nomes, documentos nem nenhum dado de participante.
create or replace function public.estudo_operacao(p_operacao uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
  v_loc record;
begin
  if public.nome_responsavel_atual() is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  select v.condicao, v.lat, v.lng, coalesce(v.posicao_em, v.registrado_em) as em into v_loc
    from public.vitima_localizacoes v
   where v.operacao_id = p_operacao and v.lat is not null
   order by coalesce(v.posicao_em, v.registrado_em) limit 1;
  return json_build_object(
    'codigo', v_op.codigo, 'tipo', v_op.tipo, 'acionado_em', v_op.acionado_em, 'encerrada_em', v_op.encerrada_em,
    'ulv', case when v_op.local_lat is null then null else json_build_object('lat', v_op.local_lat, 'lng', v_op.local_lng) end,
    'localizacoes', (select count(*) from public.vitima_localizacoes v where v.operacao_id = p_operacao),
    'localizacao', case when v_loc.em is null then null else json_build_object(
        'condicao', v_loc.condicao,
        'em', v_loc.em,
        'minutos_ate', case when v_op.acionado_em is null then null else round(extract(epoch from v_loc.em - v_op.acionado_em) / 60) end,
        'distancia_km', case when v_op.local_lat is null then null
                             else round(public.distancia_km(v_op.local_lat, v_op.local_lng, v_loc.lat, v_loc.lng)::numeric, 2) end) end,
    'fichas', (select count(*) from public.vitimas t where t.operacao_id = p_operacao),
    'perfis', coalesce((select json_object_agg(x.perfil, x.n) from (
        select unnest(t.perfil) as perfil, count(*) as n from public.vitimas t where t.operacao_id = p_operacao group by 1) x), '{}'::json),
    'setores', (select count(*) from public.setores s where s.operacao_id = p_operacao),
    'registros_diario', (select count(*) from public.diario d where d.operacao_id = p_operacao)
  );
end;
$$;

-- Estudo geral: as operações que o responsável vê (administrador: todas). Só agregados.
-- Grupos com menos de 5 casos são ocultados (k = 5): ninguém é identificável pelos números.
create or replace function public.estudo_geral()
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
    primeira as (
      select distinct on (v.operacao_id) v.operacao_id, v.condicao, v.lat, v.lng, coalesce(v.posicao_em, v.registrado_em) as em
        from public.vitima_localizacoes v
       where v.operacao_id = any(v_ops) and v.lat is not null
       order by v.operacao_id, coalesce(v.posicao_em, v.registrado_em)
    ),
    casos as (
      select o.id as operacao_id, o.tipo, p.condicao,
             case when o.local_lat is null then null else public.distancia_km(o.local_lat, o.local_lng, p.lat, p.lng) end as km,
             case when o.acionado_em is null then null else extract(epoch from p.em - o.acionado_em) / 60 end as minutos
        from ops o join primeira p on p.operacao_id = o.id
    ),
    fichas as (
      select t.operacao_id, unnest(t.perfil) as perfil from public.vitimas t where t.operacao_id = any(v_ops)
    ),
    faixas as (
      select b.ordem, b.rotulo, count(c.operacao_id) as n
        from (values (1, 'até 1 km', 0::double precision, 1::double precision), (2, '1 a 2 km', 1, 2), (3, '2 a 5 km', 2, 5),
                     (4, '5 a 10 km', 5, 10), (5, 'mais de 10 km', 10, 1e9)) b(ordem, rotulo, de, ate)
        left join casos c on c.km >= b.de and c.km < b.ate
       group by b.ordem, b.rotulo
    )
    select json_build_object(
      'gerado_em', now(),
      'k_minimo', 5,
      'operacoes', json_build_object(
        'total', (select count(*) from ops),
        'abertas', (select count(*) from ops where encerrada_em is null),
        'encerradas', (select count(*) from ops where encerrada_em is not null),
        'por_tipo', coalesce((select json_object_agg(x.t, x.n) from (select coalesce(tipo, 'sem_tipo') as t, count(*) as n from ops group by 1) x), '{}'::json),
        'por_mes', coalesce((select json_agg(json_build_object('mes', x.mes, 'n', x.n) order by x.mes) from (
          select to_char(coalesce(acionado_em, criada_em), 'YYYY-MM') as mes, count(*) as n from ops
           where coalesce(acionado_em, criada_em) >= now() - interval '12 months' group by 1) x), '[]'::json)),
      'localizacoes', json_build_object(
        'operacoes_com_localizacao', (select count(*) from casos),
        'por_condicao', coalesce((select json_object_agg(x.condicao, case when x.n >= 5 then x.n end) from (
          select condicao, count(*) as n from casos group by 1) x), '{}'::json),
        'minutos_ate_mediana', (select case when count(minutos) >= 5 then round((percentile_cont(0.5) within group (order by minutos))::numeric) end from casos)),
      'distancia_km', json_build_object(
        'casos', (select case when count(km) >= 5 then count(km) end from casos),
        'p25', (select case when count(km) >= 5 then round((percentile_cont(0.25) within group (order by km))::numeric, 2) end from casos),
        'mediana', (select case when count(km) >= 5 then round((percentile_cont(0.5) within group (order by km))::numeric, 2) end from casos),
        'p75', (select case when count(km) >= 5 then round((percentile_cont(0.75) within group (order by km))::numeric, 2) end from casos),
        'media', (select case when count(km) >= 5 then round(avg(km)::numeric, 2) end from casos),
        'faixas', coalesce((select json_agg(json_build_object('faixa', f.rotulo, 'n', case when f.n >= 5 then f.n end) order by f.ordem) from faixas f), '[]'::json)),
      'perfis', coalesce((select json_agg(json_build_object(
          'perfil', p.perfil,
          'fichas', case when p.fichas >= 5 then p.fichas end,
          'operacoes_com_localizacao', case when p.casos >= 5 then p.casos end,
          'mediana_km', p.mediana_km) order by p.perfil) from (
        select pf.perfil,
               (select count(*) from fichas f where f.perfil = pf.perfil) as fichas,
               (select count(distinct f.operacao_id) from fichas f join casos c on c.operacao_id = f.operacao_id where f.perfil = pf.perfil) as casos,
               (select case when count(c.km) >= 5 then round((percentile_cont(0.5) within group (order by c.km))::numeric, 2) end
                  from fichas f join casos c on c.operacao_id = f.operacao_id where f.perfil = pf.perfil and c.km is not null) as mediana_km
          from (values ('idoso'), ('crianca'), ('adolescente'), ('demencia'), ('autismo'), ('deficiencia_intelectual'), ('transtorno_mental'), ('outro')) pf(perfil)
        ) p), '[]'::json)
    )
  );
end;
$$;

revoke execute on function public.estudo_operacao(uuid) from public, anon;
grant execute on function public.estudo_operacao(uuid) to authenticated;
revoke execute on function public.estudo_geral() from public, anon;
grant execute on function public.estudo_geral() to authenticated;

notify pgrst, 'reload schema';
