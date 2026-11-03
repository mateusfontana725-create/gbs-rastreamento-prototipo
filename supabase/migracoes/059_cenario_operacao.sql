-- =====================================================================
-- 059 — Cenário da OPERAÇÃO (estimativa geral, sem vítima): POA/POD em desastre.
--
--  Em desastre não há nomes nem número de vítimas, mas a equipe precisa de uma base: "no setor tal, probabilidade tal
--  de achar pessoas". Essa estimativa é um cenário da operação inteira: busca_cenarios.vitima_id nulo.
--  As regras são as mesmas do cenário de vítima: soma exata de 100% com "Fora da área", setores sem sobreposição,
--  versão aprovada imutável, numeração própria, diário. A busca negativa atualiza a estimativa da operação quando a
--  missão não é de uma vítima específica.
--
--  O que muda na estrutura (sem apagar nada):
--   • busca_cenarios.vitima_id e busca_missao_efeitos.vitima_id deixam de ser obrigatórios (nulo = operação inteira).
--   • índices novos: numeração, um único rascunho e chave de aprovação da estimativa da operação.
--   • o proteger passa a comparar vitima_id com "is distinct from" (nulo também é mudança).
--  Funções: cenario_salvar_rascunho e cenario_aprovar continuam com a mesma assinatura; o núcleo é compartilhado.
--  Novas: cenario_geral_salvar_rascunho(p_operacao, p_dados). Os cenários de vítima não mudam de comportamento.
-- =====================================================================

alter table public.busca_cenarios alter column vitima_id drop not null;
alter table public.busca_missao_efeitos alter column vitima_id drop not null;

create unique index if not exists busca_cenarios_geral_numero on public.busca_cenarios (operacao_id, numero) where vitima_id is null;
create unique index if not exists busca_cenarios_geral_rascunho on public.busca_cenarios (operacao_id) where vitima_id is null and estado = 'rascunho';
create unique index if not exists busca_cenarios_geral_chave on public.busca_cenarios (operacao_id, aprovacao_chave) where vitima_id is null and aprovacao_chave is not null;

-- proteção: nulo também conta como mudança de vítima (a estimativa da operação não vira de uma vítima, nem o contrário)
create or replace function public.busca_cenarios_proteger()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_estado text;
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'busca_cenarios' then
    if tg_op in ('UPDATE', 'DELETE') and old.estado = 'aprovada' then
      raise exception 'cenario_imutavel_aprovado';
    end if;
    if tg_op = 'UPDATE' and (new.operacao_id <> old.operacao_id or new.vitima_id is distinct from old.vitima_id
       or (new.numero <> old.numero and not (current_setting('gbs.renumerar', true) = 'on' and old.estado = 'rascunho' and new.estado = 'aprovada'))) then
      raise exception 'dados_invalidos';
    end if;
  else
    if current_setting('gbs.gerando_versao', true) = 'on' and tg_op = 'INSERT' then
      return new;
    end if;
    select estado into v_estado from public.busca_cenarios where id = coalesce(new.cenario_id, old.cenario_id);
    if v_estado = 'aprovada' then
      raise exception 'cenario_imutavel_aprovado';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke execute on function public.busca_cenarios_proteger() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Cenário: salvar o rascunho (núcleo). p_vitima nulo = estimativa da operação inteira.
-- Vale o que já valia para a vítima: "Fora da área", POA por setor, justificativa, hipóteses, pontos de referência.
-- ---------------------------------------------------------------------
create or replace function public.cenario_salvar_rascunho_nucleo(p_operacao uuid, p_vitima uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
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
  v_fora numeric;
  v_fora_origem text;
  v_ia_modelo text;
  v_orig_it text;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_vitima is not null then
    if not exists (select 1 from public.vitimas where id = p_vitima and operacao_id = p_operacao) then
      raise exception 'vitima_nao_encontrada';
    end if;
    if exists (select 1 from public.vitima_localizacoes where vitima_id = p_vitima) then
      raise exception 'cenario_vitima_localizada';
    end if;
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
    v_fora := nullif(p_dados->>'poa_fora', '')::numeric;
  exception when others then
    raise exception 'dados_invalidos';
  end;
  v_fora_origem := coalesce(nullif(p_dados->>'poa_fora_origem', ''), 'manual');
  v_ia_modelo := left(nullif(btrim(coalesce(p_dados->>'ia_modelo', '')), ''), 60);
  if (v_fora is not null and (v_fora < 0 or v_fora > 1)) or v_fora_origem not in ('manual', 'ia') then
    raise exception 'dados_invalidos';
  end if;
  if v_hr is not null and v_hr > now() + interval '10 minutes' then
    raise exception 'dados_invalidos';
  end if;
  if v_ponto_id is not null then
    select * into v_ponto from public.pontos_interesse where id = v_ponto_id and operacao_id = p_operacao;
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
    v_orig_it := coalesce(nullif(v_it->>'origem', ''), 'manual');
    if v_poa is null or v_poa < 0 or v_poa > 1 or v_setor_id = any(v_vistos) or v_orig_it not in ('manual', 'ia') then
      raise exception 'dados_invalidos';
    end if;
    if not exists (select 1 from public.setores where id = v_setor_id and operacao_id = p_operacao) then
      raise exception 'setor_nao_encontrado';
    end if;
    v_vistos := v_vistos || v_setor_id;
    v_soma := v_soma + v_poa;
  end loop;
  if v_soma > 1.000001 or (v_fora is not null and v_soma + v_fora > 1.000001) then
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
      if not exists (select 1 from public.pontos_interesse where id = (v_it->>'ponto_id')::uuid and operacao_id = p_operacao) then
        raise exception 'dados_invalidos';
      end if;
    elsif char_length(btrim(coalesce(v_it->>'descricao', ''))) < 1 then
      raise exception 'dados_invalidos';
    end if;
  end loop;

  perform pg_advisory_xact_lock(hashtext(case when p_vitima is null then 'cenario_geral:' || p_operacao::text else 'cenario:' || p_vitima::text end));
  select * into v_cen from public.busca_cenarios
   where operacao_id = p_operacao and vitima_id is not distinct from p_vitima and estado = 'rascunho' for update;
  if found then
    if v_esperado is not null and v_esperado <> v_cen.atualizado_em then
      raise exception 'cenario_versao_desatualizada';
    end if;
    update public.busca_cenarios
       set justificativa = v_just, hipoteses = v_hip, limitacoes = v_lim, confianca = v_conf, origem_poa = v_origem,
           horario_referencia = coalesce(v_hr, horario_referencia, now()),
           ponto_confiavel_id = v_ponto_id, ponto_confiavel = v_ponto_json,
           poa_fora = v_fora, poa_fora_origem = v_fora_origem, ia_modelo = v_ia_modelo,
           base_numero = (select max(numero) from public.busca_cenarios
                           where operacao_id = p_operacao and vitima_id is not distinct from p_vitima and estado = 'aprovada'),   -- salvar de novo confirma a base vigente
           atualizado_em = now(), atualizado_por_nome = v_nome
     where id = v_cen.id
     returning * into v_cen;
    delete from public.busca_cenario_setores where cenario_id = v_cen.id;
    delete from public.busca_cenario_evidencias where cenario_id = v_cen.id;
  else
    select max(numero) into v_base from public.busca_cenarios
     where operacao_id = p_operacao and vitima_id is not distinct from p_vitima and estado = 'aprovada';
    insert into public.busca_cenarios (operacao_id, vitima_id, numero, base_numero, justificativa, hipoteses, limitacoes, confianca, origem_poa,
                                       horario_referencia, ponto_confiavel_id, ponto_confiavel, poa_fora, poa_fora_origem, ia_modelo, criado_por, criado_por_nome, atualizado_por_nome)
    values (p_operacao, p_vitima,
            coalesce((select max(numero) from public.busca_cenarios where operacao_id = p_operacao and vitima_id is not distinct from p_vitima), 0) + 1,
            v_base, v_just, v_hip, v_lim, v_conf, v_origem, coalesce(v_hr, now()), v_ponto_id, v_ponto_json, v_fora, v_fora_origem, v_ia_modelo, auth.uid(), v_nome, v_nome)
    returning * into v_cen;
  end if;

  for v_it in select * from jsonb_array_elements(v_itens) loop
    select * into v_setor from public.setores where id = (v_it->>'setor_id')::uuid;
    insert into public.busca_cenario_setores (cenario_id, operacao_id, setor_id, setor_nome, poa, justificativa,
                                              forma, centro_lat, centro_lng, raio_m, pontos, area_m2, origem, ia_revisado_por_nome)
    values (v_cen.id, p_operacao, v_setor.id, v_setor.nome, (v_it->>'poa')::numeric,
            left(btrim(coalesce(v_it->>'justificativa', '')), 500),
            v_setor.forma, v_setor.centro_lat, v_setor.centro_lng, v_setor.raio_m, v_setor.pontos,
            public.busca_area_m2(v_setor.forma, v_setor.centro_lat, v_setor.centro_lng, v_setor.raio_m, v_setor.pontos),
            coalesce(nullif(v_it->>'origem', ''), 'manual'),
            case when coalesce(nullif(v_it->>'origem', ''), 'manual') = 'ia' then v_nome end);
  end loop;
  for v_it in select * from jsonb_array_elements(v_evid) loop
    if nullif(v_it->>'ponto_id', '') is not null then
      select * into v_ponto from public.pontos_interesse where id = (v_it->>'ponto_id')::uuid;
      v_desc := coalesce(nullif(btrim(v_it->>'descricao'), ''), v_ponto.categoria || ' — ' || v_ponto.titulo);
      insert into public.busca_cenario_evidencias (cenario_id, operacao_id, ponto_id, descricao, confirmada)
      values (v_cen.id, p_operacao, v_ponto.id, left(v_desc, 300), coalesce((v_it->>'confirmada')::boolean, false));
    else
      insert into public.busca_cenario_evidencias (cenario_id, operacao_id, ponto_id, descricao, confirmada)
      values (v_cen.id, p_operacao, null, left(btrim(v_it->>'descricao'), 300), coalesce((v_it->>'confirmada')::boolean, false));
    end if;
  end loop;

  return json_build_object('cenario', row_to_json(v_cen),
    'setores', coalesce((select json_agg(row_to_json(s) order by s.setor_nome) from public.busca_cenario_setores s where s.cenario_id = v_cen.id), '[]'::json),
    'evidencias', coalesce((select json_agg(row_to_json(e) order by e.descricao) from public.busca_cenario_evidencias e where e.cenario_id = v_cen.id), '[]'::json));
end;
$$;

-- entradas públicas: de vítima (como antes) e da operação inteira
create or replace function public.cenario_salvar_rascunho(p_vitima uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_operacao uuid;
begin
  select operacao_id into v_operacao from public.vitimas where id = p_vitima;
  if v_operacao is null then
    raise exception 'vitima_nao_encontrada';
  end if;
  return public.cenario_salvar_rascunho_nucleo(v_operacao, p_vitima, p_dados);
end;
$$;

create or replace function public.cenario_geral_salvar_rascunho(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
begin
  return public.cenario_salvar_rascunho_nucleo(p_operacao, null, p_dados);
end;
$$;

-- ---------------------------------------------------------------------
-- Cenário: aprovar (publicar). Vale para vítima e para a operação inteira (vitima_id nulo).
-- ---------------------------------------------------------------------
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
  v_max integer;
  v_numero integer;
  v_ia text;
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
  if v_cen.vitima_id is not null and exists (select 1 from public.vitima_localizacoes where vitima_id = v_cen.vitima_id) then
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
  -- a soma, com "Fora da área", precisa dar exatamente 100% (tolerância de 0,05 ponto: o arredondamento de uma casa)
  if v_cen.poa_fora is null then
    raise exception 'cenario_fora_obrigatorio';
  end if;
  if abs(v_soma + v_cen.poa_fora - 1) > 0.0005 then
    raise exception 'cenario_soma_diferente_de_100';
  end if;
  -- a versão vigente (desta vítima, ou da operação) mudou depois deste rascunho: revise antes de publicar
  select max(numero) into v_max from public.busca_cenarios
   where operacao_id = v_cen.operacao_id and vitima_id is not distinct from v_cen.vitima_id and estado = 'aprovada';
  if v_max is not null and v_cen.base_numero is distinct from v_max then
    raise exception 'cenario_base_desatualizada';
  end if;
  v_numero := v_cen.numero;
  if v_max is not null and v_numero <= v_max then
    v_numero := (select max(numero) from public.busca_cenarios
                  where operacao_id = v_cen.operacao_id and vitima_id is not distinct from v_cen.vitima_id) + 1;
  end if;
  perform set_config('gbs.renumerar', 'on', true);

  update public.busca_cenarios
     set numero = v_numero, estado = 'aprovada', aprovada_em = now(), aprovada_por = auth.uid(), aprovada_por_nome = v_nome,
         aprovacao_chave = p_chave, horario_referencia = coalesce(horario_referencia, now()),
         atualizado_em = now(), atualizado_por_nome = v_nome
   where id = v_cen.id
   returning * into v_cen;
  perform set_config('gbs.renumerar', 'off', true);

  if v_cen.vitima_id is not null then
    select * into v_vit from public.vitimas where id = v_cen.vitima_id;
  end if;
  if v_cen.poa_fora_origem = 'ia' or exists (select 1 from public.busca_cenario_setores where cenario_id = v_cen.id and origem = 'ia') then
    v_ia := 'Valores sugeridos por IA' || coalesce(' (' || v_cen.ia_modelo || ')', '') || ' e revisados por ' || v_nome || '.';
  end if;
  select string_agg(s.setor_nome || ': ' || trim_scale(round(s.poa * 100, 1))::text || '%', ' · ' order by s.poa desc, s.setor_nome)
    into v_detalhe from public.busca_cenario_setores s where s.cenario_id = v_cen.id;
  perform public.diario_auto(v_cen.operacao_id, v_cen.aprovada_em, case when v_cen.vitima_id is null then 'operacao' else 'pessoa' end, 'cenario_aprovado',
    case when v_cen.vitima_id is null then 'Estimativa geral de POA aprovada' else 'Cenário de busca aprovado: ' || v_vit.nome end || ' (versão ' || v_cen.numero || ')',
    'POA por setor — ' || coalesce(v_detalhe, '') || ' · fora dos setores: ' || trim_scale(round(v_cen.poa_fora * 100, 1))::text || '%. Justificativa: ' || v_cen.justificativa ||
      case when v_cen.hipoteses <> '' then ' Hipóteses: ' || v_cen.hipoteses else '' end ||
      case when v_cen.limitacoes <> '' then ' Limitações: ' || v_cen.limitacoes else '' end ||
      case when v_ia is not null then ' ' || v_ia else '' end,
    'cenario:' || v_cen.id, 'info', null, null, v_cen.id::text, v_nome);

  return json_build_object('cenario', row_to_json(v_cen),
    'setores', coalesce((select json_agg(row_to_json(s) order by s.setor_nome) from public.busca_cenario_setores s where s.cenario_id = v_cen.id), '[]'::json),
    'evidencias', coalesce((select json_agg(row_to_json(e) order by e.descricao) from public.busca_cenario_evidencias e where e.cenario_id = v_cen.id), '[]'::json));
end;
$$;

revoke execute on function public.cenario_salvar_rascunho_nucleo(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.cenario_salvar_rascunho(uuid, jsonb), public.cenario_geral_salvar_rascunho(uuid, jsonb), public.cenario_aprovar(uuid, timestamptz, text) from public, anon;
grant execute on function public.cenario_salvar_rascunho(uuid, jsonb), public.cenario_geral_salvar_rascunho(uuid, jsonb), public.cenario_aprovar(uuid, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------
-- Busca negativa: a missão atualiza a versão vigente de cada vítima afetada e, quando a missão não é de uma vítima
-- específica, também a estimativa da operação (vitima_id nulo). Mesma conta de sempre (r = p × (1 − q), p' = r ÷ Σr).
-- ---------------------------------------------------------------------
create or replace function public.busca_missao_aplicar(p_missao uuid, p_nome text)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  m public.busca_missoes%rowtype;
  v_vit record;
  v_vig public.busca_cenarios%rowtype;
  v_novo public.busca_cenarios%rowtype;
  v_q numeric;
  v_soma numeric;
  v_fora numeric;
  v_z numeric;
  v_antes numeric;
  v_depois numeric;
  v_n integer := 0;
  v_num integer;
  v_p jsonb;
  v_fora_novo numeric;
  v_diff numeric;
  v_maior text;
  v_detalhe text;
begin
  select * into m from public.busca_missoes where id = p_missao;
  if m.setor_id is null or m.pod_final is null or m.cobertura_real_fracao is null then
    raise exception 'busca_calculo_inconsistente';
  end if;
  v_q := round(m.pod_final * m.cobertura_real_fracao, 6);
  for v_vit in
    select v.id, v.nome, v.criado_em from public.vitimas v
     where v.operacao_id = m.operacao_id and (m.vitima_id is null or v.id = m.vitima_id)
       and not exists (select 1 from public.vitima_localizacoes l where l.vitima_id = v.id)
    union all
    -- a estimativa da operação (vitima_id nulo) só recebe as buscas que não são de uma vítima específica
    select null::uuid, 'Estimativa geral da operação'::text, '-infinity'::timestamptz
     where m.vitima_id is null
    order by criado_em, id
  loop
    select * into v_vig from public.busca_cenarios
     where operacao_id = m.operacao_id and vitima_id is not distinct from v_vit.id and estado = 'aprovada'
     order by numero desc limit 1;
    if not found or not exists (select 1 from public.busca_cenario_setores where cenario_id = v_vig.id and setor_id = m.setor_id) then
      continue;   -- sem versão vigente, ou o setor não está no cenário (POA zero): não há o que atualizar
    end if;
    select coalesce(sum(poa), 0) into v_soma from public.busca_cenario_setores where cenario_id = v_vig.id;
    v_fora := coalesce(v_vig.poa_fora, 1 - v_soma);
    if v_fora < 0 or v_soma + v_fora < 0.999 or v_soma + v_fora > 1.001 then
      raise exception 'busca_calculo_inconsistente';
    end if;
    -- Z = Σ r_k, com q = 0 em tudo o que não foi pesquisado (inclusive "Fora da área")
    select coalesce(sum(s.poa * (1 - case when s.setor_id = m.setor_id then v_q else 0 end)), 0) + v_fora into v_z
      from public.busca_cenario_setores s where s.cenario_id = v_vig.id;
    if v_z is null or v_z <= 0 then
      raise exception 'busca_calculo_inconsistente';
    end if;
    select poa into v_antes from public.busca_cenario_setores where cenario_id = v_vig.id and setor_id = m.setor_id;

    -- novos valores (chave = linha da versão vigente), arredondados em 6 casas; o resíduo fecha a soma em exatamente 1
    select jsonb_object_agg(s.id::text, round(s.poa * (1 - case when s.setor_id = m.setor_id then v_q else 0 end) / v_z, 6)) into v_p
      from public.busca_cenario_setores s where s.cenario_id = v_vig.id;
    v_fora_novo := round(v_fora / v_z, 6);
    v_diff := 1 - v_fora_novo - (select sum(value::numeric) from jsonb_each_text(v_p));
    if v_diff <> 0 then
      select s.id::text into v_maior from public.busca_cenario_setores s where s.cenario_id = v_vig.id
       order by (v_p->>(s.id::text))::numeric desc, s.setor_nome limit 1;
      if (v_p->>v_maior)::numeric >= v_fora_novo then
        v_p := jsonb_set(v_p, array[v_maior], to_jsonb((v_p->>v_maior)::numeric + v_diff));
      else
        v_fora_novo := v_fora_novo + v_diff;
      end if;
    end if;
    select (v_p->>(s.id::text))::numeric into v_depois from public.busca_cenario_setores s where s.cenario_id = v_vig.id and s.setor_id = m.setor_id;

    v_num := (select max(numero) from public.busca_cenarios
               where operacao_id = m.operacao_id and vitima_id is not distinct from v_vit.id) + 1;
    insert into public.busca_cenarios (operacao_id, vitima_id, numero, estado, base_numero, justificativa, hipoteses, limitacoes, confianca, origem_poa,
                                       horario_referencia, ponto_confiavel_id, ponto_confiavel, poa_fora, poa_fora_origem, missao_id,
                                       criado_por, criado_por_nome, atualizado_por_nome, aprovada_em, aprovada_por, aprovada_por_nome)
    values (m.operacao_id, v_vit.id, v_num, 'aprovada', v_vig.numero,
            left('Atualização por busca negativa: setor ' || m.setor_nome || ', equipe ' || m.equipe || ' (' || m.metodo || '), POD '
                 || trim_scale(round(m.pod_final * 100, 1))::text || '% em ' || trim_scale(round(m.cobertura_real_fracao * 100, 1))::text
                 || '% do setor. r = POA × (1 − q); novo POA = r ÷ Σr, a partir da versão ' || v_vig.numero || '.', 2000),
            v_vig.hipoteses, v_vig.limitacoes, v_vig.confianca, 'calculo_pos_busca',
            coalesce(m.fim_real, m.resultado_em, now()), v_vig.ponto_confiavel_id, v_vig.ponto_confiavel, v_fora_novo, 'calculo', m.id,
            auth.uid(), p_nome, p_nome, now(), auth.uid(), p_nome)
    returning * into v_novo;

    perform set_config('gbs.gerando_versao', 'on', true);
    insert into public.busca_cenario_setores (cenario_id, operacao_id, setor_id, setor_nome, poa, justificativa, forma, centro_lat, centro_lng, raio_m, pontos, area_m2, origem)
    select v_novo.id, s.operacao_id, s.setor_id, s.setor_nome, (v_p->>(s.id::text))::numeric,
           case when s.setor_id = m.setor_id then 'Busca negativa: POD ' || trim_scale(round(m.pod_final * 100, 1))::text || '% em ' || trim_scale(round(m.cobertura_real_fracao * 100, 1))::text || '% do setor'
                else 'Redistribuição proporcional pela busca negativa' end,
           s.forma, s.centro_lat, s.centro_lng, s.raio_m, s.pontos, s.area_m2, 'calculo'
      from public.busca_cenario_setores s where s.cenario_id = v_vig.id;
    insert into public.busca_cenario_evidencias (cenario_id, operacao_id, ponto_id, descricao, confirmada)
    select v_novo.id, e.operacao_id, e.ponto_id, e.descricao, e.confirmada from public.busca_cenario_evidencias e where e.cenario_id = v_vig.id;
    perform set_config('gbs.gerando_versao', 'off', true);

    insert into public.busca_missao_efeitos (missao_id, operacao_id, vitima_id, cenario_antes_id, cenario_depois_id, poa_setor_antes, poa_setor_depois, q, pos, z)
    values (m.id, m.operacao_id, v_vit.id, v_vig.id, v_novo.id, v_antes, v_depois, v_q, round(v_antes * v_q, 6), round(v_z, 6));

    select string_agg(s.setor_nome || ': ' || trim_scale(round(s.poa * 100, 1))::text || '%', ' · ' order by s.poa desc, s.setor_nome) into v_detalhe
      from public.busca_cenario_setores s where s.cenario_id = v_novo.id;
    perform public.diario_auto(m.operacao_id, now(), case when v_vit.id is null then 'operacao' else 'pessoa' end, 'cenario_pos_busca',
      'POA atualizado após busca negativa: ' || v_vit.nome || ' (versão ' || v_num || ')',
      'Missão no setor ' || m.setor_nome || ' (' || m.equipe || '): POS ' || trim_scale(round(v_antes * v_q * 100, 1))::text || '% (POA ' || trim_scale(round(v_antes * 100, 1))::text
        || '% × POD ' || trim_scale(round(v_q * 100, 1))::text || '%). Novo POA — ' || coalesce(v_detalhe, '') || ' · fora da área: ' || trim_scale(round(v_fora_novo * 100, 1))::text || '%.',
      'poa-pos:' || m.id || ':' || coalesce(v_vit.id::text, 'geral'), 'info', null, null, v_novo.id::text, p_nome);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Tenta o cálculo e devolve (estado, detalhe). Falha = nada muda e o motivo fica na missão.
create or replace function public.busca_missao_calcular(p_missao uuid, p_nome text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  begin
    v_n := public.busca_missao_aplicar(p_missao, p_nome);
  exception when others then
    return json_build_object('estado', 'inconsistente',
      'detalhe', case when sqlerrm like '%busca_calculo_inconsistente%'
                      then 'Inconsistência: Z = Σ r = 0 ou valores inválidos na versão vigente. Nada foi alterado.' else 'Não foi possível calcular: ' || left(sqlerrm, 200) || '. Nada foi alterado.' end);
  end;
  if v_n > 0 then
    return json_build_object('estado', 'aplicado', 'detalhe', 'Nova versão em ' || v_n || ' cenário(s) de POA (de vítima e/ou da operação).');
  end if;
  return json_build_object('estado', 'nao_aplicavel', 'detalhe', 'Nenhum cenário vigente (de vítima ou da operação) inclui este setor: o POA não mudou.');
end;
$$;

notify pgrst, 'reload schema';
