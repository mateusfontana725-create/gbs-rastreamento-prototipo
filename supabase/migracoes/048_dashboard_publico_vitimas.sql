-- =====================================================================
-- 048 — Dashboard em outra janela e por link público (só visualização); várias vítimas por ocorrência.
--
--  1. dashboard_operacao_dados(operação): tudo o que o dashboard da operação precisa (participantes com a
--     trilha resumida, grupos, setores, ocorrências e o estudo das vítimas), lido do banco. A janela própria
--     do dashboard (dashboard.html?op=) passa a usar isto e mostra os mesmos números do painel.
--  2. Link público: operacoes.dashboard_token (48 caracteres). dashboard_publico_gerar / _desligar (responsável
--     da operação); dashboard_publico(token) para quem abre o link SEM login: só leitura, sem nomes de pessoas
--     ("Bombeiro 1", "Civil 2"…), sem textos de mensagens, sem fotos. Não existe nenhuma função de escrita
--     acessível pelo link.
--  3. Várias vítimas: estudo_operacao devolve "vitimas" (uma linha por ficha e por localização sem ficha), cada
--     uma com a própria localização, condição, tempo e distância do ULV e a situação no SCI. estudo_geral passa a
--     contar cada vítima localizada como um caso (antes, só a primeira localização de cada operação).
-- =====================================================================

alter table public.operacoes add column if not exists dashboard_token text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'operacoes_dashboard_token_ok') then
    alter table public.operacoes add constraint operacoes_dashboard_token_ok
      check (dashboard_token is null or dashboard_token ~ '^[0-9a-f]{48}$');
  end if;
end $$;
create unique index if not exists operacoes_dashboard_token_uk on public.operacoes (dashboard_token) where dashboard_token is not null;

-- ---------------------------------------------------------------------
-- Vítimas da operação, uma por linha: cada ficha (com a 1ª localização ligada a ela) e cada localização
-- sem ficha ("vítima sem ficha"). p_nomes = false: sem nome (estudos e dashboards não levam nomes).
-- ---------------------------------------------------------------------
create or replace function public.estudo_vitimas(p_operacao uuid, p_nomes boolean)
returns json
language sql stable security definer set search_path = public
as $$
  with op as (select * from public.operacoes where id = p_operacao),
  fichas as (
    select t.id, t.nome, t.idade, t.sexo, t.perfil, t.criado_em, row_number() over (order by t.criado_em, t.id) as n
      from public.vitimas t where t.operacao_id = p_operacao
  ),
  locs as (
    select distinct on (coalesce(v.vitima_id::text, v.id::text))
           v.id, v.vitima_id, v.condicao, v.lat, v.lng, coalesce(v.posicao_em, v.registrado_em) as em
      from public.vitima_localizacoes v
     where v.operacao_id = p_operacao
     order by coalesce(v.vitima_id::text, v.id::text), (v.lat is null), coalesce(v.posicao_em, v.registrado_em)
  ),
  linhas as (
    select f.n as ordem, f.id as vitima_id, l.id as localizacao_id, f.nome, f.idade, f.sexo, f.perfil, l.condicao, l.lat, l.lng, l.em
      from fichas f left join locs l on l.vitima_id = f.id
    union all
    select (select count(*) from fichas) + row_number() over (order by l.em, l.id), null, l.id, null, null, null, '{}'::text[], l.condicao, l.lat, l.lng, l.em
      from locs l where l.vitima_id is null or not exists (select 1 from fichas f where f.id = l.vitima_id)
  )
  select coalesce(json_agg(json_build_object(
      'rotulo', 'V-' || lpad(x.ordem::text, 2, '0'),
      'vitima_id', x.vitima_id,
      'localizacao_id', x.localizacao_id,
      'nome', case when p_nomes then x.nome end,
      'sem_ficha', x.vitima_id is null,
      'idade', x.idade, 'sexo', x.sexo, 'perfil', to_json(x.perfil),
      'localizada', x.localizacao_id is not null,
      'condicao', x.condicao,
      'em', x.em,
      'minutos_ate', case when x.em is null or o.acionado_em is null then null else round(extract(epoch from x.em - o.acionado_em) / 60) end,
      'distancia_km', case when x.lat is null or o.local_lat is null then null
                           else round(public.distancia_km(o.local_lat, o.local_lng, x.lat, x.lng)::numeric, 2) end,
      'sci', (select json_build_object('numero', s.numero, 'fase', s.fase, 'triagem', s.triagem)
                from public.sci_vitimas s where s.operacao_id = p_operacao and x.vitima_id is not null and s.vitima_id = x.vitima_id
               order by s.numero limit 1)
    ) order by x.ordem), '[]'::json)
    from linhas x cross join op o;
$$;

-- Estudo de uma operação (dados), sem conferir permissão: usado por estudo_operacao e pelos dashboards.
create or replace function public.estudo_operacao_dados(p_operacao uuid, p_nomes boolean)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
  v_loc record;
  v_vit json;
begin
  select * into v_op from public.operacoes where id = p_operacao;
  select v.condicao, v.lat, v.lng, coalesce(v.posicao_em, v.registrado_em) as em into v_loc
    from public.vitima_localizacoes v
   where v.operacao_id = p_operacao and v.lat is not null
   order by coalesce(v.posicao_em, v.registrado_em) limit 1;
  v_vit := public.estudo_vitimas(p_operacao, p_nomes);
  return json_build_object(
    'codigo', v_op.codigo, 'tipo', v_op.tipo, 'acionado_em', v_op.acionado_em, 'encerrada_em', v_op.encerrada_em,
    'ulv', case when v_op.local_lat is null then null else json_build_object('lat', v_op.local_lat, 'lng', v_op.local_lng) end,
    'localizacoes', (select count(*) from public.vitima_localizacoes v where v.operacao_id = p_operacao),
    -- primeira localização da operação (compatibilidade com telas antigas)
    'localizacao', case when v_loc.em is null then null else json_build_object(
        'condicao', v_loc.condicao,
        'em', v_loc.em,
        'minutos_ate', case when v_op.acionado_em is null then null else round(extract(epoch from v_loc.em - v_op.acionado_em) / 60) end,
        'distancia_km', case when v_op.local_lat is null then null
                             else round(public.distancia_km(v_op.local_lat, v_op.local_lng, v_loc.lat, v_loc.lng)::numeric, 2) end) end,
    'vitimas', v_vit,
    'vitimas_total', json_array_length(v_vit),
    'vitimas_localizadas', (select count(*) from json_array_elements(v_vit) e where (e->>'localizada')::boolean),
    'fichas', (select count(*) from public.vitimas t where t.operacao_id = p_operacao),
    'perfis', coalesce((select json_object_agg(x.perfil, x.n) from (
        select unnest(t.perfil) as perfil, count(*) as n from public.vitimas t where t.operacao_id = p_operacao group by 1) x), '{}'::json),
    'setores', (select count(*) from public.setores s where s.operacao_id = p_operacao),
    'registros_diario', (select count(*) from public.diario d where d.operacao_id = p_operacao)
  );
end;
$$;

-- Estudo de uma operação: ULV, vítimas (cada uma com a própria localização), perfis das fichas.
create or replace function public.estudo_operacao(p_operacao uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
begin
  if public.nome_responsavel_atual() is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  return public.estudo_operacao_dados(p_operacao, false);   -- sem nomes (como sempre)
end;
$$;

-- ---------------------------------------------------------------------
-- Dados do dashboard da operação (sem conferir permissão). p_publico: sem nomes, sem textos.
-- Trilhas: um ponto a cada 30 s por pessoa (precisão até 150 m, como no painel), o bastante para km, horas e cobertura.
-- ---------------------------------------------------------------------
create or replace function public.dashboard_dados(p_operacao uuid, p_publico boolean)
returns json
language sql stable security definer set search_path = public
as $$
  with op as (select * from public.operacoes where id = p_operacao),
  pessoas as (
    select pa.*, row_number() over (partition by pa.tipo order by pa.criado_em, pa.id) as n_tipo
      from public.participantes pa where pa.operacao_id = p_operacao
  ),
  pts as (
    select distinct on (po.participante_id, floor(extract(epoch from po.registrado_em) / 30))
           po.participante_id, po.lat, po.lng, po.precisao, po.registrado_em
      from public.posicoes po
     where po.operacao_id = p_operacao and (po.precisao is null or po.precisao <= 150)
     order by po.participante_id, floor(extract(epoch from po.registrado_em) / 30), po.registrado_em
  )
  select json_build_object(
    'publico', p_publico,
    'gerado_em', now(),
    'operacao', (select json_build_object('id', o.id, 'codigo', o.codigo, 'tipo', o.tipo, 'status', o.status, 'acionado_em', o.acionado_em,
                   'criada_em', o.criada_em, 'encerrada_em', o.encerrada_em, 'local_lat', o.local_lat, 'local_lng', o.local_lng,
                   'gps_lacuna_s', o.gps_lacuna_s) from op o),
    'participantes', coalesce((select json_agg(json_build_object(
        'id', p.id,
        'nome', case when p_publico then case p.tipo when 'militar' then 'Bombeiro ' when 'civil' then 'Civil ' else 'Responsável ' end || p.n_tipo
                     else p.nome end,
        'tipo', p.tipo,
        'removido', p.removido,
        'grupo', case when p.tipo = 'responsavel' then null else (
                   select json_build_object('id', g.id, 'nome', g.nome, 'cor', g.cor)
                     from public.grupo_membros gm join public.grupos g on g.id = gm.grupo_id
                    where gm.participante_id = p.id order by lower(g.nome) limit 1) end,
        'pontos', coalesce((select json_agg(json_build_array(round(t.lat::numeric, 6), round(t.lng::numeric, 6), t.precisao,
                                                             floor(extract(epoch from t.registrado_em) * 1000)) order by t.registrado_em)
                              from pts t where t.participante_id = p.id), '[]'::json)
      ) order by p.tipo, p.n_tipo) from pessoas p), '[]'::json),
    'setores', coalesce((select json_agg(json_build_object('id', s.id, 'nome', s.nome, 'forma', s.forma, 'centro_lat', s.centro_lat,
                   'centro_lng', s.centro_lng, 'raio_m', s.raio_m, 'pontos', s.pontos, 'status', s.status) order by s.criado_em)
                   from public.setores s where s.operacao_id = p_operacao), '[]'::json),
    'ocorrencias', json_build_object(
      'ajuda', (select count(*) from public.mensagens m where m.operacao_id = p_operacao and (m.categoria = 'AJUDA' or m.resposta = 'PRECISO_AJUDA')),
      'PISTA', (select count(*) from public.mensagens m where m.operacao_id = p_operacao and m.direcao = 'entrada' and m.categoria = 'PISTA'),
      'VESTIGIO', (select count(*) from public.mensagens m where m.operacao_id = p_operacao and m.direcao = 'entrada' and m.categoria = 'VESTIGIO'),
      'OBJETO', (select count(*) from public.mensagens m where m.operacao_id = p_operacao and m.direcao = 'entrada' and m.categoria = 'OBJETO'),
      'OBSTACULO', (select count(*) from public.mensagens m where m.operacao_id = p_operacao and m.direcao = 'entrada' and m.categoria = 'OBSTACULO'),
      'ordens', (select count(*) from public.mensagens m where m.operacao_id = p_operacao and m.direcao <> 'entrada'),
      'fotos', (select count(*) from public.fotos f where f.operacao_id = p_operacao),
      'pontos', (select count(*) from public.pontos_interesse pi where pi.operacao_id = p_operacao),
      'retornosAtrasados', (select count(*) from public.alertas a where a.operacao_id = p_operacao and a.tipo = 'retorno_atrasado')),
    -- relatos de campo (para a lista ao tocar numa ocorrência); no link público, sem texto nem autor
    'relatos', coalesce((select json_agg(json_build_object('id', m.id, 'categoria', case when m.resposta = 'PRECISO_AJUDA' then 'AJUDA' else m.categoria end,
                   'criada_em', m.criada_em, 'direcao', m.direcao,
                   'texto', case when p_publico then null else m.texto end,
                   'autor', case when p_publico then null else m.remetente_nome end) order by m.criada_em desc)
                   from public.mensagens m where m.operacao_id = p_operacao
                    and (m.categoria in ('AJUDA', 'PISTA', 'VESTIGIO', 'OBJETO', 'OBSTACULO') or m.resposta = 'PRECISO_AJUDA' or m.direcao <> 'entrada')), '[]'::json),
    'estudo', public.estudo_operacao_dados(p_operacao, false)
  );
$$;

-- Janela própria do dashboard (responsável da operação, com login)
create or replace function public.dashboard_operacao_dados(p_operacao uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
begin
  if public.nome_responsavel_atual() is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  return public.dashboard_dados(p_operacao, false);
end;
$$;

-- Link público (sem login): só leitura
create or replace function public.dashboard_publico(p_token text)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then
    raise exception 'link_publico_invalido';
  end if;
  select id into v_op from public.operacoes where dashboard_token = p_token;
  if v_op is null then
    raise exception 'link_publico_invalido';
  end if;
  return public.dashboard_dados(v_op, true);
end;
$$;

-- Gera (ou troca) o link público. Trocar invalida o anterior.
create or replace function public.dashboard_publico_gerar(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_token text := left(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 48);
  v_tinha boolean;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select dashboard_token is not null into v_tinha from public.operacoes where id = p_operacao;
  update public.operacoes set dashboard_token = v_token where id = p_operacao;
  perform public.diario_auto(p_operacao, now(), 'operacao', 'dashboard_publico',
    case when v_tinha then 'Link público do dashboard trocado (o anterior deixou de funcionar)' else 'Link público do dashboard criado' end,
    'Somente visualização, sem nomes.', 'dashboard_publico:' || v_token, 'info', null, null, null, v_nome);
  return json_build_object('token', v_token);
end;
$$;

create or replace function public.dashboard_publico_desligar(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if exists (select 1 from public.operacoes where id = p_operacao and dashboard_token is not null) then
    update public.operacoes set dashboard_token = null where id = p_operacao;
    perform public.diario_auto(p_operacao, now(), 'operacao', 'dashboard_publico',
      'Link público do dashboard desligado', '', 'dashboard_publico:off:' || extract(epoch from now())::bigint, 'info', null, null, null, v_nome);
  end if;
  return json_build_object('token', null);
end;
$$;

-- ---------------------------------------------------------------------
-- Estudo geral: cada vítima localizada é um caso (antes: só a 1ª localização de cada operação)
-- ---------------------------------------------------------------------
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
    -- uma linha por vítima: a 1ª localização (com posição) de cada ficha, e cada localização sem ficha
    primeira as (
      select distinct on (v.operacao_id, coalesce(v.vitima_id::text, v.id::text))
             v.operacao_id, v.vitima_id, v.condicao, v.lat, v.lng, coalesce(v.posicao_em, v.registrado_em) as em
        from public.vitima_localizacoes v
       where v.operacao_id = any(v_ops) and v.lat is not null
       order by v.operacao_id, coalesce(v.vitima_id::text, v.id::text), coalesce(v.posicao_em, v.registrado_em)
    ),
    casos as (
      select o.id as operacao_id, p.vitima_id, o.tipo, p.condicao,
             case when o.local_lat is null then null else public.distancia_km(o.local_lat, o.local_lng, p.lat, p.lng) end as km,
             case when o.acionado_em is null then null else extract(epoch from p.em - o.acionado_em) / 60 end as minutos
        from ops o join primeira p on p.operacao_id = o.id
    ),
    fichas as (
      select t.id, t.operacao_id, unnest(t.perfil) as perfil from public.vitimas t where t.operacao_id = any(v_ops)
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
        'operacoes_com_localizacao', (select count(distinct operacao_id) from casos),
        'vitimas_localizadas', (select count(*) from casos),
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
        -- cada ficha com o perfil conta a própria localização (a da vítima, não a da operação)
        select pf.perfil,
               (select count(*) from fichas f where f.perfil = pf.perfil) as fichas,
               (select count(*) from fichas f join casos c on c.vitima_id = f.id where f.perfil = pf.perfil) as casos,
               (select case when count(c.km) >= 5 then round((percentile_cont(0.5) within group (order by c.km))::numeric, 2) end
                  from fichas f join casos c on c.vitima_id = f.id where f.perfil = pf.perfil and c.km is not null) as mediana_km
          from (values ('idoso'), ('crianca'), ('adolescente'), ('demencia'), ('autismo'), ('deficiencia_intelectual'), ('transtorno_mental'), ('outro')) pf(perfil)
        ) p), '[]'::json)
    )
  );
end;
$$;

revoke execute on function public.estudo_vitimas(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.estudo_operacao_dados(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.dashboard_dados(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.dashboard_operacao_dados(uuid) from public, anon;
grant execute on function public.dashboard_operacao_dados(uuid) to authenticated;
revoke execute on function public.dashboard_publico(text) from public;
grant execute on function public.dashboard_publico(text) to anon, authenticated;
revoke execute on function public.dashboard_publico_gerar(uuid) from public, anon;
grant execute on function public.dashboard_publico_gerar(uuid) to authenticated;
revoke execute on function public.dashboard_publico_desligar(uuid) from public, anon;
grant execute on function public.dashboard_publico_desligar(uuid) to authenticated;

notify pgrst, 'reload schema';
