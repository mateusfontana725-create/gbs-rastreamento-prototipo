-- =====================================================================
-- 40. POA/POD conforme o guia de implantação (migração 034 — idempotente; exige a 033, a 011, a 031 e a 003)
--
--  Cenário (POA), por versão:
--    • geometria de cada setor GUARDADA na versão (forma, centro/raio ou pontos, área em m²): editar ou
--      excluir o setor depois não muda a versão aprovada;
--    • horário de referência, hipóteses, limitações, confiança (julgamento qualitativo, não estatístico),
--      origem do POA, último ponto confiável (com cópia dos dados) e evidências (com situação de confirmação);
--    • aprovar exige que os setores com POA não se sobreponham (mais de 2% do menor): senão a mesma área
--      seria contada duas vezes (cenario_setores_sobrepostos). Rascunho pode ter sobreposição;
--    • aprovar confere a revisão esperada (atualizado_em do rascunho que o responsável viu) e aceita chave de
--      idempotência: repetir a mesma aprovação devolve o mesmo resultado, sem duplicar;
--    • vítima já localizada: o cenário dela está encerrado (cenario_vitima_localizada); as demais seguem.
--  (rode a 033 antes da 034; não rode a 033 sozinha depois: ela recria a versão antiga de cenario_aprovar)
--  Registro de busca (POD):
--    • finalidade: 'pos_execucao' (o que ocorreu) ou 'planejada' (previsão; nunca altera o POA);
--    • POD pode ficar NÃO ESTIMADA (nulo): a busca é registrada, mas não reduz o POA. Nulo nunca vira zero;
--    • origem do POD, método, observadores, impedimentos, áreas não observadas, vínculo com o deslocamento (missão);
--    • busca em parte do setor: informa a fração coberta (a conta assume distribuição uniforme no setor);
--    • chave do cliente: reenviar o mesmo registro não duplica; mesma chave com outro conteúdo é recusada.
-- =====================================================================
alter table public.busca_cenarios add column if not exists horario_referencia timestamptz;
alter table public.busca_cenarios add column if not exists hipoteses text not null default '';
alter table public.busca_cenarios add column if not exists limitacoes text not null default '';
alter table public.busca_cenarios add column if not exists confianca text;
alter table public.busca_cenarios add column if not exists origem_poa text not null default 'julgamento_comando';
alter table public.busca_cenarios add column if not exists ponto_confiavel_id uuid references public.pontos_interesse(id) on delete set null;
alter table public.busca_cenarios add column if not exists ponto_confiavel jsonb;
alter table public.busca_cenarios add column if not exists aprovacao_chave text;
do $$
begin
  alter table public.busca_cenarios add constraint busca_cenarios_guia_ok check (
    char_length(hipoteses) <= 2000 and char_length(limitacoes) <= 1000
    and (confianca is null or confianca in ('baixa', 'media', 'alta'))
    and origem_poa in ('julgamento_comando', 'consenso_documentado', 'modelo_validado'));
exception when duplicate_object then null;
end;
$$;
create unique index if not exists busca_cenarios_chave_unica on public.busca_cenarios (vitima_id, aprovacao_chave) where aprovacao_chave is not null;

-- geometria do setor na versão (cópia: a versão antiga continua íntegra se o setor mudar)
alter table public.busca_cenario_setores add column if not exists forma text;
alter table public.busca_cenario_setores add column if not exists centro_lat double precision;
alter table public.busca_cenario_setores add column if not exists centro_lng double precision;
alter table public.busca_cenario_setores add column if not exists raio_m double precision;
alter table public.busca_cenario_setores add column if not exists pontos jsonb;
alter table public.busca_cenario_setores add column if not exists area_m2 double precision;

create table if not exists public.busca_cenario_evidencias (
  id          uuid primary key default gen_random_uuid(),
  cenario_id  uuid not null references public.busca_cenarios(id) on delete cascade,
  operacao_id uuid not null references public.operacoes(id) on delete cascade,
  ponto_id    uuid references public.pontos_interesse(id) on delete set null,
  descricao   text not null check (char_length(btrim(descricao)) between 1 and 300),
  confirmada  boolean not null default false
);
create index if not exists busca_cenario_evidencias_cenario_idx on public.busca_cenario_evidencias (cenario_id);
alter table public.busca_cenario_evidencias enable row level security;
drop policy if exists busca_cenario_evidencias_ler on public.busca_cenario_evidencias;
create policy busca_cenario_evidencias_ler on public.busca_cenario_evidencias for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.busca_cenario_evidencias from anon;
revoke insert, update, delete, truncate on public.busca_cenario_evidencias from authenticated;
grant select on public.busca_cenario_evidencias to authenticated;
drop trigger if exists busca_cenario_evidencias_encerrada on public.busca_cenario_evidencias;
create trigger busca_cenario_evidencias_encerrada before insert or update or delete on public.busca_cenario_evidencias
  for each row execute function public.bloquear_escrita_encerrada();
drop trigger if exists busca_cenario_evidencias_proteger on public.busca_cenario_evidencias;
create trigger busca_cenario_evidencias_proteger before insert or update or delete on public.busca_cenario_evidencias
  for each row execute function public.busca_cenarios_proteger();

-- registros de busca
alter table public.busca_registros alter column pod drop not null;
alter table public.busca_registros add column if not exists finalidade text not null default 'pos_execucao';
alter table public.busca_registros add column if not exists origem_pod text not null default 'julgamento_comando';
alter table public.busca_registros add column if not exists metodo text;
alter table public.busca_registros add column if not exists missao_id uuid references public.missoes(id) on delete set null;
alter table public.busca_registros add column if not exists alcance text not null default 'setor_inteiro';
alter table public.busca_registros add column if not exists cobertura_fracao numeric(5, 4);
alter table public.busca_registros add column if not exists observadores smallint;
alter table public.busca_registros add column if not exists impedimentos text not null default '';
alter table public.busca_registros add column if not exists areas_nao_observadas text not null default '';
alter table public.busca_registros add column if not exists chave_cliente text;
do $$
begin
  alter table public.busca_registros add constraint busca_registros_guia_ok check (
    finalidade in ('pos_execucao', 'planejada')
    and origem_pod in ('julgamento_comando', 'consenso_documentado', 'modelo_validado')
    and (metodo is null or char_length(metodo) <= 60)
    and alcance in ('setor_inteiro', 'parcial')
    and ((alcance = 'parcial') = (cobertura_fracao is not null))
    and (cobertura_fracao is null or (cobertura_fracao > 0 and cobertura_fracao < 1))
    and (observadores is null or observadores between 1 and 500)
    and char_length(impedimentos) <= 500 and char_length(areas_nao_observadas) <= 500
    and (finalidade = 'pos_execucao' or pod is not null));
exception when duplicate_object then null;
end;
$$;
create unique index if not exists busca_registros_chave_unica on public.busca_registros (operacao_id, chave_cliente) where chave_cliente is not null;

-- Tempo real das evidências
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.busca_cenario_evidencias;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Geometria: polígono do setor (círculo vira 48 lados), área e sobreposição.
-- A sobreposição é medida por amostragem (grade 30 × 30 sobre o menor setor): fração do menor setor que
-- também está dentro do outro. O mesmo cálculo existe em js/pod.js (conferido pelos testes).
-- ---------------------------------------------------------------------
create or replace function public.busca_poligono(p_forma text, p_clat double precision, p_clng double precision, p_raio double precision, p_pontos jsonb)
returns jsonb
language plpgsql immutable set search_path = public
as $$
declare
  v_r constant double precision := 6371008.8;
  v_out jsonb := '[]'::jsonb;
  i integer;
  a double precision;
begin
  if p_forma = 'circulo' then
    for i in 0..47 loop
      a := 2 * pi() * i / 48;
      v_out := v_out || jsonb_build_array(jsonb_build_array(
        p_clat + degrees(p_raio * sin(a) / v_r),
        p_clng + degrees(p_raio * cos(a) / (v_r * cos(radians(p_clat))))));
    end loop;
    return v_out;
  end if;
  return coalesce(p_pontos, '[]'::jsonb);
end;
$$;

create or replace function public.busca_area_m2(p_forma text, p_clat double precision, p_clng double precision, p_raio double precision, p_pontos jsonb)
returns double precision
language plpgsql immutable set search_path = public
as $$
declare
  v_r constant double precision := 6371008.8;
  v_poli jsonb;
  n integer;
  i integer;
  j integer;
  la0 double precision;
  ln0 double precision;
  k double precision;
  xi double precision; yi double precision; xj double precision; yj double precision;
  s double precision := 0;
begin
  if p_forma = 'circulo' then
    return pi() * p_raio * p_raio;
  end if;
  v_poli := public.busca_poligono(p_forma, p_clat, p_clng, p_raio, p_pontos);
  n := jsonb_array_length(v_poli);
  if n < 3 then return 0; end if;
  la0 := (v_poli->0->>0)::double precision;
  ln0 := (v_poli->0->>1)::double precision;
  k := cos(radians(la0));
  j := n - 1;
  for i in 0..n - 1 loop
    xi := radians((v_poli->i->>1)::double precision - ln0) * v_r * k;
    yi := radians((v_poli->i->>0)::double precision - la0) * v_r;
    xj := radians((v_poli->j->>1)::double precision - ln0) * v_r * k;
    yj := radians((v_poli->j->>0)::double precision - la0) * v_r;
    s := s + (xj + xi) * (yj - yi);
    j := i;
  end loop;
  return abs(s / 2);
end;
$$;

create or replace function public.busca_ponto_no_poligono(x double precision, y double precision, xs double precision[], ys double precision[])
returns boolean
language plpgsql immutable set search_path = public
as $$
declare
  n integer := coalesce(array_length(xs, 1), 0);
  i integer;
  j integer;
  dentro boolean := false;
begin
  j := n;
  for i in 1..n loop
    if ((ys[i] > y) <> (ys[j] > y)) and (x < (xs[j] - xs[i]) * (y - ys[i]) / (ys[j] - ys[i]) + xs[i]) then
      dentro := not dentro;
    end if;
    j := i;
  end loop;
  return dentro;
end;
$$;

create or replace function public.busca_sobreposicao_fracao(p_a jsonb, p_b jsonb)
returns double precision
language plpgsql immutable set search_path = public
as $$
declare
  v_r constant double precision := 6371008.8;
  na integer := coalesce(jsonb_array_length(p_a), 0);
  nb integer := coalesce(jsonb_array_length(p_b), 0);
  la0 double precision;
  ln0 double precision;
  k double precision;
  ax double precision[] := '{}'; ay double precision[] := '{}';
  qx double precision[] := '{}'; qy double precision[] := '{}';
  sx double precision[]; sy double precision[]; lx double precision[]; ly double precision[];
  area_a double precision := 0; area_b double precision := 0;
  i integer; j integer;
  minx double precision; maxx double precision; miny double precision; maxy double precision;
  px double precision; py double precision;
  cnt_s integer := 0; cnt_b integer := 0;
  gi integer; gj integer;
begin
  if na < 3 or nb < 3 then return 0; end if;
  la0 := (p_a->0->>0)::double precision;
  ln0 := (p_a->0->>1)::double precision;
  k := cos(radians(la0));
  for i in 0..na - 1 loop
    ax := ax || (radians((p_a->i->>1)::double precision - ln0) * v_r * k);
    ay := ay || (radians((p_a->i->>0)::double precision - la0) * v_r);
  end loop;
  for i in 0..nb - 1 loop
    qx := qx || (radians((p_b->i->>1)::double precision - ln0) * v_r * k);
    qy := qy || (radians((p_b->i->>0)::double precision - la0) * v_r);
  end loop;
  j := na;
  for i in 1..na loop area_a := area_a + (ax[j] + ax[i]) * (ay[j] - ay[i]); j := i; end loop;
  j := nb;
  for i in 1..nb loop area_b := area_b + (qx[j] + qx[i]) * (qy[j] - qy[i]); j := i; end loop;
  if abs(area_a) <= abs(area_b) then
    sx := ax; sy := ay; lx := qx; ly := qy;
  else
    sx := qx; sy := qy; lx := ax; ly := ay;
  end if;
  minx := (select min(v) from unnest(sx) v); maxx := (select max(v) from unnest(sx) v);
  miny := (select min(v) from unnest(sy) v); maxy := (select max(v) from unnest(sy) v);
  for gi in 0..29 loop
    px := minx + (gi + 0.5) * (maxx - minx) / 30;
    for gj in 0..29 loop
      py := miny + (gj + 0.5) * (maxy - miny) / 30;
      if public.busca_ponto_no_poligono(px, py, sx, sy) then
        cnt_s := cnt_s + 1;
        if public.busca_ponto_no_poligono(px, py, lx, ly) then cnt_b := cnt_b + 1; end if;
      end if;
    end loop;
  end loop;
  if cnt_s = 0 then return 0; end if;
  return cnt_b::double precision / cnt_s;
end;
$$;

-- Primeiro par de setores com POA > 0 que se sobrepõem (mais de 2% do menor), ou nulo
create or replace function public.busca_cenario_sobreposicao(p_cenario uuid)
returns text
language plpgsql stable set search_path = public
as $$
declare
  a record;
  b record;
begin
  for a in select * from public.busca_cenario_setores where cenario_id = p_cenario and poa > 0 and forma is not null order by setor_nome loop
    for b in select * from public.busca_cenario_setores where cenario_id = p_cenario and poa > 0 and forma is not null and setor_nome > a.setor_nome order by setor_nome loop
      if public.busca_sobreposicao_fracao(
           public.busca_poligono(a.forma, a.centro_lat, a.centro_lng, a.raio_m, a.pontos),
           public.busca_poligono(b.forma, b.centro_lat, b.centro_lng, b.raio_m, b.pontos)) > 0.02 then
        return a.setor_nome || ' × ' || b.setor_nome;
      end if;
    end loop;
  end loop;
  return null;
end;
$$;
revoke execute on function public.busca_poligono(text, double precision, double precision, double precision, jsonb),
  public.busca_area_m2(text, double precision, double precision, double precision, jsonb),
  public.busca_ponto_no_poligono(double precision, double precision, double precision[], double precision[]),
  public.busca_sobreposicao_fracao(jsonb, jsonb), public.busca_cenario_sobreposicao(uuid) from public, anon;

-- ---------------------------------------------------------------------
-- Cenário: salvar o rascunho (agora com a geometria, as hipóteses e as evidências)
--   p_dados: justificativa, setores [{ setor_id, poa (0 a 1), justificativa }], atualizado_em (revisão esperada),
--            horario_referencia, hipoteses, limitacoes, confianca ('baixa'|'media'|'alta'), origem_poa,
--            ponto_confiavel_id, evidencias [{ ponto_id, descricao, confirmada }]
-- ---------------------------------------------------------------------
create or replace function public.cenario_salvar_rascunho(p_vitima uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_vit public.vitimas%rowtype;
  v_cen public.busca_cenarios%rowtype;
  v_status text;
  v_just text;
  v_itens jsonb;
  v_evid jsonb;
  v_it jsonb;
  v_setor public.setores%rowtype;
  v_ponto public.pontos_interesse%rowtype;
  v_setor_id uuid;
  v_poa numeric;
  v_soma numeric := 0;
  v_vistos uuid[] := '{}';
  v_base integer;
  v_esperado timestamptz;
  v_hr timestamptz;
  v_hip text;
  v_lim text;
  v_conf text;
  v_origem text;
  v_ponto_id uuid;
  v_ponto_json jsonb;
  v_desc text;
begin
  select * into v_vit from public.vitimas where id = p_vitima;
  if not found then
    raise exception 'vitima_nao_encontrada';
  end if;
  if v_nome is null or not public.dono_operacao(v_vit.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_vit.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if exists (select 1 from public.vitima_localizacoes where vitima_id = p_vitima) then
    raise exception 'cenario_vitima_localizada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  v_itens := coalesce(p_dados->'setores', '[]'::jsonb);
  v_evid := coalesce(p_dados->'evidencias', '[]'::jsonb);
  if jsonb_typeof(v_itens) <> 'array' or jsonb_typeof(v_evid) <> 'array' then
    raise exception 'dados_invalidos';
  end if;
  if jsonb_array_length(v_evid) > 30 then
    raise exception 'dados_invalidos';
  end if;
  v_just := left(btrim(coalesce(p_dados->>'justificativa', '')), 2000);
  v_hip := left(btrim(coalesce(p_dados->>'hipoteses', '')), 2000);
  v_lim := left(btrim(coalesce(p_dados->>'limitacoes', '')), 1000);
  v_conf := nullif(p_dados->>'confianca', '');
  v_origem := coalesce(nullif(p_dados->>'origem_poa', ''), 'julgamento_comando');
  if (v_conf is not null and v_conf not in ('baixa', 'media', 'alta')) or v_origem not in ('julgamento_comando', 'consenso_documentado') then
    raise exception 'dados_invalidos';
  end if;
  begin
    v_esperado := nullif(p_dados->>'atualizado_em', '')::timestamptz;
    v_hr := nullif(p_dados->>'horario_referencia', '')::timestamptz;
    v_ponto_id := nullif(p_dados->>'ponto_confiavel_id', '')::uuid;
  exception when others then
    raise exception 'dados_invalidos';
  end;
  if v_hr is not null and v_hr > now() + interval '10 minutes' then
    raise exception 'dados_invalidos';
  end if;
  if v_ponto_id is not null then
    select * into v_ponto from public.pontos_interesse where id = v_ponto_id and operacao_id = v_vit.operacao_id;
    if not found then
      raise exception 'dados_invalidos';
    end if;
    v_ponto_json := jsonb_build_object('titulo', v_ponto.titulo, 'categoria', v_ponto.categoria, 'lat', v_ponto.lat, 'lng', v_ponto.lng);
  end if;

  -- valida os setores antes de gravar qualquer coisa
  for v_it in select * from jsonb_array_elements(v_itens) loop
    begin
      v_setor_id := (v_it->>'setor_id')::uuid;
      v_poa := (v_it->>'poa')::numeric;
    exception when others then
      raise exception 'dados_invalidos';
    end;
    if v_poa is null or v_poa < 0 or v_poa > 1 or v_setor_id = any(v_vistos) then
      raise exception 'dados_invalidos';
    end if;
    if not exists (select 1 from public.setores where id = v_setor_id and operacao_id = v_vit.operacao_id) then
      raise exception 'setor_nao_encontrado';
    end if;
    v_vistos := v_vistos || v_setor_id;
    v_soma := v_soma + v_poa;
  end loop;
  if v_soma > 1.000001 then
    raise exception 'cenario_poa_acima_de_100';
  end if;
  for v_it in select * from jsonb_array_elements(v_evid) loop
    if jsonb_typeof(v_it) <> 'object' then
      raise exception 'dados_invalidos';
    end if;
    if nullif(v_it->>'ponto_id', '') is not null then
      begin
        perform (v_it->>'ponto_id')::uuid;
      exception when others then
        raise exception 'dados_invalidos';
      end;
      if not exists (select 1 from public.pontos_interesse where id = (v_it->>'ponto_id')::uuid and operacao_id = v_vit.operacao_id) then
        raise exception 'dados_invalidos';
      end if;
    elsif char_length(btrim(coalesce(v_it->>'descricao', ''))) < 1 then
      raise exception 'dados_invalidos';
    end if;
  end loop;

  perform pg_advisory_xact_lock(hashtext('cenario:' || p_vitima::text));
  select * into v_cen from public.busca_cenarios where vitima_id = p_vitima and estado = 'rascunho' for update;
  if found then
    if v_esperado is not null and v_esperado <> v_cen.atualizado_em then
      raise exception 'cenario_versao_desatualizada';
    end if;
    update public.busca_cenarios
       set justificativa = v_just, hipoteses = v_hip, limitacoes = v_lim, confianca = v_conf, origem_poa = v_origem,
           horario_referencia = coalesce(v_hr, horario_referencia, now()),
           ponto_confiavel_id = v_ponto_id, ponto_confiavel = v_ponto_json,
           atualizado_em = now(), atualizado_por_nome = v_nome
     where id = v_cen.id
     returning * into v_cen;
    delete from public.busca_cenario_setores where cenario_id = v_cen.id;
    delete from public.busca_cenario_evidencias where cenario_id = v_cen.id;
  else
    select max(numero) into v_base from public.busca_cenarios where vitima_id = p_vitima and estado = 'aprovada';
    insert into public.busca_cenarios (operacao_id, vitima_id, numero, base_numero, justificativa, hipoteses, limitacoes, confianca, origem_poa,
                                       horario_referencia, ponto_confiavel_id, ponto_confiavel, criado_por, criado_por_nome, atualizado_por_nome)
    values (v_vit.operacao_id, p_vitima,
            coalesce((select max(numero) from public.busca_cenarios where vitima_id = p_vitima), 0) + 1,
            v_base, v_just, v_hip, v_lim, v_conf, v_origem, coalesce(v_hr, now()), v_ponto_id, v_ponto_json, auth.uid(), v_nome, v_nome)
    returning * into v_cen;
  end if;

  for v_it in select * from jsonb_array_elements(v_itens) loop
    select * into v_setor from public.setores where id = (v_it->>'setor_id')::uuid;
    insert into public.busca_cenario_setores (cenario_id, operacao_id, setor_id, setor_nome, poa, justificativa,
                                              forma, centro_lat, centro_lng, raio_m, pontos, area_m2)
    values (v_cen.id, v_vit.operacao_id, v_setor.id, v_setor.nome, (v_it->>'poa')::numeric,
            left(btrim(coalesce(v_it->>'justificativa', '')), 500),
            v_setor.forma, v_setor.centro_lat, v_setor.centro_lng, v_setor.raio_m, v_setor.pontos,
            public.busca_area_m2(v_setor.forma, v_setor.centro_lat, v_setor.centro_lng, v_setor.raio_m, v_setor.pontos));
  end loop;
  for v_it in select * from jsonb_array_elements(v_evid) loop
    if nullif(v_it->>'ponto_id', '') is not null then
      select * into v_ponto from public.pontos_interesse where id = (v_it->>'ponto_id')::uuid;
      v_desc := coalesce(nullif(btrim(v_it->>'descricao'), ''), v_ponto.categoria || ' — ' || v_ponto.titulo);
      insert into public.busca_cenario_evidencias (cenario_id, operacao_id, ponto_id, descricao, confirmada)
      values (v_cen.id, v_vit.operacao_id, v_ponto.id, left(v_desc, 300), coalesce((v_it->>'confirmada')::boolean, false));
    else
      insert into public.busca_cenario_evidencias (cenario_id, operacao_id, ponto_id, descricao, confirmada)
      values (v_cen.id, v_vit.operacao_id, null, left(btrim(v_it->>'descricao'), 300), coalesce((v_it->>'confirmada')::boolean, false));
    end if;
  end loop;

  return json_build_object('cenario', row_to_json(v_cen),
    'setores', coalesce((select json_agg(row_to_json(s) order by s.setor_nome) from public.busca_cenario_setores s where s.cenario_id = v_cen.id), '[]'::json),
    'evidencias', coalesce((select json_agg(row_to_json(e) order by e.descricao) from public.busca_cenario_evidencias e where e.cenario_id = v_cen.id), '[]'::json));
end;
$$;

-- ---------------------------------------------------------------------
-- Cenário: aprovar. p_revisao = atualizado_em do rascunho que o responsável viu; p_chave = chave de
-- idempotência (a mesma chave repetida devolve a mesma aprovação).
-- ---------------------------------------------------------------------
drop function if exists public.cenario_aprovar(uuid);
create or replace function public.cenario_aprovar(p_cenario uuid, p_revisao timestamptz default null, p_chave text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_cen public.busca_cenarios%rowtype;
  v_vit public.vitimas%rowtype;
  v_status text;
  v_soma numeric;
  v_detalhe text;
  v_par text;
begin
  select * into v_cen from public.busca_cenarios where id = p_cenario for update;
  if not found then
    raise exception 'cenario_versao_inexistente';
  end if;
  if v_nome is null or not public.dono_operacao(v_cen.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if v_cen.estado = 'aprovada' then
    -- repetição da mesma aprovação (mesma chave): devolve o resultado sem duplicar nada
    if p_chave is not null and v_cen.aprovacao_chave = p_chave then
      return json_build_object('cenario', row_to_json(v_cen), 'repetida', true,
        'setores', coalesce((select json_agg(row_to_json(s) order by s.setor_nome) from public.busca_cenario_setores s where s.cenario_id = v_cen.id), '[]'::json),
        'evidencias', coalesce((select json_agg(row_to_json(e) order by e.descricao) from public.busca_cenario_evidencias e where e.cenario_id = v_cen.id), '[]'::json));
    end if;
    raise exception 'cenario_imutavel_aprovado';
  end if;
  select status into v_status from public.operacoes where id = v_cen.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if exists (select 1 from public.vitima_localizacoes where vitima_id = v_cen.vitima_id) then
    raise exception 'cenario_vitima_localizada';
  end if;
  if p_revisao is not null and p_revisao <> v_cen.atualizado_em then
    raise exception 'cenario_versao_desatualizada';
  end if;
  if char_length(btrim(v_cen.justificativa)) < 10 then
    raise exception 'cenario_sem_justificativa';
  end if;
  select coalesce(sum(poa), 0) into v_soma from public.busca_cenario_setores where cenario_id = v_cen.id;
  if v_soma <= 0 then
    raise exception 'cenario_sem_setores';
  end if;
  v_par := public.busca_cenario_sobreposicao(v_cen.id);
  if v_par is not null then
    raise exception 'cenario_setores_sobrepostos';
  end if;

  update public.busca_cenarios
     set estado = 'aprovada', aprovada_em = now(), aprovada_por = auth.uid(), aprovada_por_nome = v_nome,
         aprovacao_chave = p_chave, horario_referencia = coalesce(horario_referencia, now()),
         atualizado_em = now(), atualizado_por_nome = v_nome
   where id = v_cen.id
   returning * into v_cen;

  select * into v_vit from public.vitimas where id = v_cen.vitima_id;
  select string_agg(s.setor_nome || ': ' || trim_scale(round(s.poa * 100, 1))::text || '%', ' · ' order by s.poa desc, s.setor_nome)
    into v_detalhe from public.busca_cenario_setores s where s.cenario_id = v_cen.id;
  perform public.diario_auto(v_cen.operacao_id, v_cen.aprovada_em, 'pessoa', 'cenario_aprovado',
    'Cenário de busca aprovado: ' || v_vit.nome || ' (versão ' || v_cen.numero || ')',
    'POA por setor — ' || coalesce(v_detalhe, '') || ' · fora dos setores: ' || trim_scale(round((1 - v_soma) * 100, 1))::text || '%. Justificativa: ' || v_cen.justificativa ||
      case when v_cen.hipoteses <> '' then ' Hipóteses: ' || v_cen.hipoteses else '' end ||
      case when v_cen.limitacoes <> '' then ' Limitações: ' || v_cen.limitacoes else '' end,
    'cenario:' || v_cen.id, 'info', null, null, v_cen.id::text, v_nome);

  return json_build_object('cenario', row_to_json(v_cen),
    'setores', coalesce((select json_agg(row_to_json(s) order by s.setor_nome) from public.busca_cenario_setores s where s.cenario_id = v_cen.id), '[]'::json),
    'evidencias', coalesce((select json_agg(row_to_json(e) order by e.descricao) from public.busca_cenario_evidencias e where e.cenario_id = v_cen.id), '[]'::json));
end;
$$;

-- ---------------------------------------------------------------------
-- Registro de busca (POD), versão do guia
--   p_dados: setor_id, finalidade ('pos_execucao' | 'planejada'), pod (0 a 1; nulo = NÃO ESTIMADA),
--            base_estimativa (em que se baseia, ou por que não foi estimada), origem_pod, metodo, missao_id,
--            alcance ('setor_inteiro' | 'parcial'), cobertura_fracao (0 a 1, só no parcial), observadores,
--            impedimentos, areas_nao_observadas, condicoes, equipe, grupo_id, vitima_id, inicio, fim, chave_cliente
-- ---------------------------------------------------------------------
create or replace function public.busca_registrar(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_status text;
  v_setor public.setores%rowtype;
  v_grupo public.grupos%rowtype;
  v_vit public.vitimas%rowtype;
  v_reg public.busca_registros%rowtype;
  v_setor_id uuid;
  v_grupo_id uuid;
  v_vit_id uuid;
  v_missao_id uuid;
  v_pod numeric;
  v_ini timestamptz;
  v_fim timestamptz;
  v_base text;
  v_cond text;
  v_equipe text;
  v_final text;
  v_origem text;
  v_metodo text;
  v_alcance text;
  v_cob numeric;
  v_obs smallint;
  v_imp text;
  v_nao_obs text;
  v_chave text;
  v_rotulo text;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  begin
    v_setor_id := (p_dados->>'setor_id')::uuid;
    v_pod := nullif(p_dados->>'pod', '')::numeric;
    v_grupo_id := nullif(p_dados->>'grupo_id', '')::uuid;
    v_vit_id := nullif(p_dados->>'vitima_id', '')::uuid;
    v_missao_id := nullif(p_dados->>'missao_id', '')::uuid;
    v_ini := nullif(p_dados->>'inicio', '')::timestamptz;
    v_fim := nullif(p_dados->>'fim', '')::timestamptz;
    v_cob := nullif(p_dados->>'cobertura_fracao', '')::numeric;
    v_obs := nullif(p_dados->>'observadores', '')::smallint;
  exception when others then
    raise exception 'dados_invalidos';
  end;
  v_final := coalesce(nullif(p_dados->>'finalidade', ''), 'pos_execucao');
  v_origem := coalesce(nullif(p_dados->>'origem_pod', ''), 'julgamento_comando');
  v_alcance := coalesce(nullif(p_dados->>'alcance', ''), 'setor_inteiro');
  v_chave := nullif(left(btrim(coalesce(p_dados->>'chave_cliente', '')), 80), '');
  -- não há catálogo de modelos de detecção validados: só julgamento do comando ou consenso documentado
  if v_final not in ('pos_execucao', 'planejada') or v_origem not in ('julgamento_comando', 'consenso_documentado')
     or v_alcance not in ('setor_inteiro', 'parcial') or (v_obs is not null and v_obs not between 1 and 500) then
    raise exception 'dados_invalidos';
  end if;
  if v_pod is not null and (v_pod < 0 or v_pod > 1) then
    raise exception 'busca_pod_invalido';
  end if;
  if v_final = 'planejada' and v_pod is null then
    raise exception 'busca_planejada_sem_pod';
  end if;
  if (v_alcance = 'parcial') <> (v_cob is not null) or (v_cob is not null and not (v_cob > 0 and v_cob < 1)) then
    raise exception 'busca_cobertura_invalida';
  end if;
  if v_ini is not null and v_fim is not null and v_fim < v_ini then
    raise exception 'dados_invalidos';
  end if;
  v_base := btrim(coalesce(p_dados->>'base_estimativa', ''));
  if char_length(v_base) < 5 then
    raise exception 'busca_sem_base_estimativa';
  end if;
  v_cond := left(btrim(coalesce(p_dados->>'condicoes', '')), 500);
  v_equipe := left(btrim(coalesce(p_dados->>'equipe', '')), 60);
  v_metodo := nullif(left(btrim(coalesce(p_dados->>'metodo', '')), 60), '');
  v_imp := left(btrim(coalesce(p_dados->>'impedimentos', '')), 500);
  v_nao_obs := left(btrim(coalesce(p_dados->>'areas_nao_observadas', '')), 500);

  -- repetição do mesmo envio (mesma chave): devolve o registro já gravado
  if v_chave is not null then
    select * into v_reg from public.busca_registros where operacao_id = p_operacao and chave_cliente = v_chave;
    if found then
      if v_reg.setor_id is distinct from v_setor_id or v_reg.pod is distinct from round(v_pod, 4) or v_reg.finalidade <> v_final then
        raise exception 'busca_chave_reutilizada';
      end if;
      return row_to_json(v_reg);
    end if;
  end if;

  select * into v_setor from public.setores where id = v_setor_id and operacao_id = p_operacao;
  if not found then
    raise exception 'setor_nao_encontrado';
  end if;
  if v_grupo_id is not null then
    select * into v_grupo from public.grupos where id = v_grupo_id and operacao_id = p_operacao;
    if not found then
      raise exception 'dados_invalidos';
    end if;
    if v_equipe = '' then v_equipe := left(v_grupo.nome, 60); end if;
  end if;
  if v_missao_id is not null and not exists (select 1 from public.missoes where id = v_missao_id and operacao_id = p_operacao) then
    raise exception 'dados_invalidos';
  end if;
  if v_vit_id is not null then
    select * into v_vit from public.vitimas where id = v_vit_id and operacao_id = p_operacao;
    if not found then
      raise exception 'vitima_nao_encontrada';
    end if;
  end if;

  insert into public.busca_registros (operacao_id, setor_id, setor_nome, vitima_id, grupo_id, equipe, inicio, fim,
                                      pod, base_estimativa, condicoes, registrado_por, registrado_por_nome,
                                      finalidade, origem_pod, metodo, missao_id, alcance, cobertura_fracao, observadores,
                                      impedimentos, areas_nao_observadas, chave_cliente)
  values (p_operacao, v_setor.id, v_setor.nome, v_vit.id, v_grupo.id, v_equipe, v_ini, v_fim,
          round(v_pod, 4), v_base, v_cond, auth.uid(), v_nome,
          v_final, v_origem, v_metodo, v_missao_id, v_alcance, round(v_cob, 4), v_obs, v_imp, v_nao_obs, v_chave)
  returning * into v_reg;

  v_rotulo := case when v_final = 'planejada' then 'Busca planejada' else 'Busca registrada' end;
  perform public.diario_auto(p_operacao, v_reg.registrado_em, 'setor', case when v_final = 'planejada' then 'busca_planejada' else 'busca_registrada' end,
    v_rotulo || ' em ' || v_setor.nome || ': ' ||
      case when v_reg.pod is null then 'POD não estimada' else 'POD ' || trim_scale(round(v_reg.pod * 100, 1))::text || '%' end ||
      case when v_alcance = 'parcial' then ' (em ' || trim_scale(round(v_reg.cobertura_fracao * 100, 1))::text || '% do setor)' else '' end,
    coalesce(nullif(v_equipe, ''), 'Equipe não informada') ||
      case when v_metodo is not null then ' · método: ' || v_metodo else '' end ||
      case when v_vit.id is not null then ' · vale para ' || v_vit.nome else ' · vale para todas as vítimas' end ||
      '. ' || case when v_reg.pod is null then 'Por que não foi estimada: ' else 'Base da estimativa: ' end || v_base ||
      case when v_cond <> '' then '. Condições: ' || v_cond else '' end ||
      case when v_imp <> '' then '. Impedimentos: ' || v_imp else '' end ||
      case when v_nao_obs <> '' then '. Áreas não observadas: ' || v_nao_obs else '' end,
    'busca:' || v_reg.id, 'info', null, null, v_reg.id::text, v_nome);

  return row_to_json(v_reg);
end;
$$;

-- anulação: o texto do diário passa a tratar POD não estimada
create or replace function public.busca_anular(p_registro uuid, p_motivo text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_reg public.busca_registros%rowtype;
  v_status text;
  v_motivo text := left(btrim(coalesce(p_motivo, '')), 500);
begin
  select * into v_reg from public.busca_registros where id = p_registro for update;
  if not found then
    raise exception 'busca_registro_inexistente';
  end if;
  if v_nome is null or not public.dono_operacao(v_reg.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_reg.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if v_reg.anulado_em is not null then
    raise exception 'busca_registro_ja_anulado';
  end if;
  if char_length(v_motivo) < 3 then
    raise exception 'busca_anulacao_sem_motivo';
  end if;
  update public.busca_registros
     set anulado_em = now(), anulado_por_nome = v_nome, anulado_motivo = v_motivo
   where id = v_reg.id
   returning * into v_reg;
  perform public.diario_auto(v_reg.operacao_id, v_reg.anulado_em, 'setor', 'busca_anulada',
    'Registro de busca anulado em ' || v_reg.setor_nome || ' (' ||
      case when v_reg.pod is null then 'POD não estimada' else 'POD ' || trim_scale(round(v_reg.pod * 100, 1))::text || '%' end || ')',
    'Motivo: ' || v_motivo, 'busca_anulada:' || v_reg.id, 'info', null, null, v_reg.id::text, v_nome);
  return row_to_json(v_reg);
end;
$$;

revoke execute on function public.cenario_salvar_rascunho(uuid, jsonb), public.cenario_aprovar(uuid, timestamptz, text),
  public.busca_registrar(uuid, jsonb), public.busca_anular(uuid, text) from public, anon;
grant execute on function public.cenario_salvar_rascunho(uuid, jsonb), public.cenario_aprovar(uuid, timestamptz, text),
  public.busca_registrar(uuid, jsonb), public.busca_anular(uuid, text) to authenticated;

notify pgrst, 'reload schema';
