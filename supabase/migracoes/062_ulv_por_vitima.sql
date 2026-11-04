-- =====================================================================
-- 062 · Último local visto (ULV) por vítima (migração idempotente; exige a 007 (vitimas) e a 026 (operação encerrada))
--
-- O ULV é o último local em que a pessoa foi vista. Fica na ficha da vítima, não no local da operação
-- (que é só a referência do cadastro). A distância por vítima (estudo_vitimas) passa a medir a partir do ULV dela.
-- Gravação só pela RPC definir_ulv_vitima (responsável da operação, operação ativa).
-- =====================================================================

alter table public.vitimas add column if not exists ulv_lat double precision;
alter table public.vitimas add column if not exists ulv_lng double precision;
alter table public.vitimas add column if not exists ulv_descricao text;   -- anulável: salvar_vitima insere a linha com v.* (sem este campo)
alter table public.vitimas add column if not exists ulv_em timestamptz;
alter table public.vitimas add column if not exists ulv_por_nome text;

alter table public.vitimas drop constraint if exists vitimas_ulv_ok;
alter table public.vitimas add constraint vitimas_ulv_ok check (
  (ulv_lat is null) = (ulv_lng is null)
  and (ulv_lat is null or (ulv_lat between -90 and 90 and ulv_lng between -180 and 180))
  and (ulv_descricao is null or char_length(ulv_descricao) <= 300));

-- Cadastra (lat/lng informados) ou tira (lat/lng nulos) o último local visto da vítima.
create or replace function public.definir_ulv_vitima(p_vitima uuid, p_lat double precision, p_lng double precision, p_descricao text default '')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v public.vitimas%rowtype;
  v_op public.operacoes%rowtype;
begin
  if v_nome_resp is null then
    raise exception 'sem_permissao';
  end if;
  select * into v from public.vitimas where id = p_vitima for update;
  if not found then
    raise exception 'vitima_nao_encontrada';
  end if;
  if not public.dono_operacao(v.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = v.operacao_id;
  if v_op.status <> 'ativa' or v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  if (p_lat is null) <> (p_lng is null) then
    raise exception 'posicao_invalida';
  end if;
  if p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0)) then
    raise exception 'posicao_invalida';
  end if;
  if char_length(coalesce(p_descricao, '')) > 300 then
    raise exception 'dados_invalidos';
  end if;
  update public.vitimas
     set ulv_lat = p_lat,
         ulv_lng = p_lng,
         ulv_descricao = case when p_lat is null then '' else btrim(coalesce(p_descricao, '')) end,
         ulv_em = case when p_lat is null then null else now() end,
         ulv_por_nome = case when p_lat is null then null else v_nome_resp end,
         atualizado_em = now(), atualizado_por_nome = v_nome_resp
   where id = p_vitima
  returning * into v;
  return row_to_json(v);
end;
$$;
revoke execute on function public.definir_ulv_vitima(uuid, double precision, double precision, text) from public, anon;
grant execute on function public.definir_ulv_vitima(uuid, double precision, double precision, text) to authenticated;

-- Estudo da operação: a distância de cada vítima passa a ser medida a partir do ULV dela.
create or replace function public.estudo_vitimas(p_operacao uuid, p_nomes boolean)
returns json
language sql stable security definer set search_path = public
as $$
  with op as (select * from public.operacoes where id = p_operacao),
  fichas as (
    select t.id, t.nome, t.idade, t.sexo, t.perfil, t.criado_em, t.ulv_lat, t.ulv_lng, row_number() over (order by t.criado_em, t.id) as n
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
    select f.n as ordem, f.id as vitima_id, l.id as localizacao_id, f.nome, f.idade, f.sexo, f.perfil, f.ulv_lat, f.ulv_lng, l.condicao, l.lat, l.lng, l.em
      from fichas f left join locs l on l.vitima_id = f.id
    union all
    select (select count(*) from fichas) + row_number() over (order by l.em, l.id), null, l.id, null, null, null, '{}'::text[], null::double precision, null::double precision, l.condicao, l.lat, l.lng, l.em
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
      'ulv', case when x.ulv_lat is null then null else json_build_object('lat', x.ulv_lat, 'lng', x.ulv_lng) end,
      'distancia_km', case when x.lat is null or x.ulv_lat is null then null
                           else round(public.distancia_km(x.ulv_lat, x.ulv_lng, x.lat, x.lng)::numeric, 2) end,
      'sci', (select json_build_object('numero', s.numero, 'fase', s.fase, 'triagem', s.triagem)
                from public.sci_vitimas s where s.operacao_id = p_operacao and x.vitima_id is not null and s.vitima_id = x.vitima_id
               order by s.numero limit 1)
    ) order by x.ordem), '[]'::json)
    from linhas x cross join op o;
$$;