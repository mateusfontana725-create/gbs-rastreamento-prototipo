-- =====================================================================
-- 44. POA: "Fora da área" guardado e soma exata de 100%, origem de cada valor e versão sempre em dia
--     (migração 038 — idempotente; exige a 033 e a 034)
--
--  • A versão passa a GUARDAR a probabilidade "Fora da área" (poa_fora). Publicar (cenario_aprovar) exige que
--    setores + fora = 100% (tolerância de 0,05 ponto, o arredondamento de uma casa) — conferido AQUI, no
--    servidor, e não só na tela (cenario_fora_obrigatorio, cenario_soma_diferente_de_100).
--    Versões já aprovadas continuam como estão (poa_fora nulo = "fora" implícito = o que sobra); nada é reescrito.
--  • Origem de cada valor: 'manual', 'ia' (sugerido por IA e mantido pelo responsável, que o revisou ao salvar) ou
--    'calculo' (atualização pós-busca, 039). A publicação registra no diário "sugerido por IA, revisado por <nome>".
--  • Se a versão vigente mudou depois do rascunho (ex.: busca negativa aplicada), publicar o rascunho é recusado
--    (cenario_base_desatualizada): salve o rascunho de novo depois de revisá-lo. O número do rascunho é ajustado
--    na publicação, para a ordem das versões nunca voltar atrás.
-- =====================================================================
alter table public.busca_cenarios add column if not exists poa_fora numeric(7, 6);
alter table public.busca_cenarios add column if not exists poa_fora_origem text not null default 'manual';
alter table public.busca_cenarios add column if not exists ia_modelo text;
alter table public.busca_cenario_setores add column if not exists origem text not null default 'manual';
alter table public.busca_cenario_setores add column if not exists ia_revisado_por_nome text;
do $$
begin
  alter table public.busca_cenarios add constraint busca_cenarios_fora_ok check (
    (poa_fora is null or (poa_fora >= 0 and poa_fora <= 1)) and poa_fora_origem in ('manual', 'ia') and (ia_modelo is null or char_length(ia_modelo) <= 60));
exception when duplicate_object then null;
end;
$$;
do $$
begin
  alter table public.busca_cenario_setores add constraint busca_cenario_setores_origem_ok check (origem in ('manual', 'ia', 'calculo'));
exception when duplicate_object then null;
end;
$$;

-- Proteção das versões: a 033 com dois desvios controlados, usados só por funções desta base
--   gbs.renumerar      → publicar um rascunho pode mudar o NÚMERO dele (só rascunho → aprovada)
--   gbs.gerando_versao → o cálculo pós-busca (039) grava a nova versão já aprovada com as linhas de setor
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
    if tg_op = 'UPDATE' and (new.operacao_id <> old.operacao_id or new.vitima_id <> old.vitima_id
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
-- Cenário: salvar o rascunho. Novidades em relação à 034:
--   p_dados.poa_fora (0 a 1), poa_fora_origem ('manual'|'ia'), ia_modelo; cada setor aceita origem ('manual'|'ia').
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
  v_fora numeric;
  v_fora_origem text;
  v_ia_modelo text;
  v_orig_it text;
  v_max integer;
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
    v_orig_it := coalesce(nullif(v_it->>'origem', ''), 'manual');
    if v_poa is null or v_poa < 0 or v_poa > 1 or v_setor_id = any(v_vistos) or v_orig_it not in ('manual', 'ia') then
      raise exception 'dados_invalidos';
    end if;
    if not exists (select 1 from public.setores where id = v_setor_id and operacao_id = v_vit.operacao_id) then
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
           poa_fora = v_fora, poa_fora_origem = v_fora_origem, ia_modelo = v_ia_modelo,
           base_numero = (select max(numero) from public.busca_cenarios where vitima_id = p_vitima and estado = 'aprovada'),   -- salvar de novo confirma a base vigente
           atualizado_em = now(), atualizado_por_nome = v_nome
     where id = v_cen.id
     returning * into v_cen;
    delete from public.busca_cenario_setores where cenario_id = v_cen.id;
    delete from public.busca_cenario_evidencias where cenario_id = v_cen.id;
  else
    select max(numero) into v_base from public.busca_cenarios where vitima_id = p_vitima and estado = 'aprovada';
    insert into public.busca_cenarios (operacao_id, vitima_id, numero, base_numero, justificativa, hipoteses, limitacoes, confianca, origem_poa,
                                       horario_referencia, ponto_confiavel_id, ponto_confiavel, poa_fora, poa_fora_origem, ia_modelo, criado_por, criado_por_nome, atualizado_por_nome)
    values (v_vit.operacao_id, p_vitima,
            coalesce((select max(numero) from public.busca_cenarios where vitima_id = p_vitima), 0) + 1,
            v_base, v_just, v_hip, v_lim, v_conf, v_origem, coalesce(v_hr, now()), v_ponto_id, v_ponto_json, v_fora, v_fora_origem, v_ia_modelo, auth.uid(), v_nome, v_nome)
    returning * into v_cen;
  end if;

  for v_it in select * from jsonb_array_elements(v_itens) loop
    select * into v_setor from public.setores where id = (v_it->>'setor_id')::uuid;
    insert into public.busca_cenario_setores (cenario_id, operacao_id, setor_id, setor_nome, poa, justificativa,
                                              forma, centro_lat, centro_lng, raio_m, pontos, area_m2, origem, ia_revisado_por_nome)
    values (v_cen.id, v_vit.operacao_id, v_setor.id, v_setor.nome, (v_it->>'poa')::numeric,
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
-- Cenário: aprovar (publicar). Novidades: soma exata de 100% com "Fora da área", base em dia, número ajustado.
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
  -- a soma, com "Fora da área", precisa dar exatamente 100% (tolerância de 0,05 ponto: o arredondamento de uma casa)
  if v_cen.poa_fora is null then
    raise exception 'cenario_fora_obrigatorio';
  end if;
  if abs(v_soma + v_cen.poa_fora - 1) > 0.0005 then
    raise exception 'cenario_soma_diferente_de_100';
  end if;
  -- a versão vigente mudou depois deste rascunho (ex.: busca negativa aplicada): revise antes de publicar
  select max(numero) into v_max from public.busca_cenarios where vitima_id = v_cen.vitima_id and estado = 'aprovada';
  if v_max is not null and v_cen.base_numero is distinct from v_max then
    raise exception 'cenario_base_desatualizada';
  end if;
  v_numero := v_cen.numero;
  if v_max is not null and v_numero <= v_max then
    v_numero := (select max(numero) from public.busca_cenarios where vitima_id = v_cen.vitima_id) + 1;
  end if;
  perform set_config('gbs.renumerar', 'on', true);

  update public.busca_cenarios
     set numero = v_numero, estado = 'aprovada', aprovada_em = now(), aprovada_por = auth.uid(), aprovada_por_nome = v_nome,
         aprovacao_chave = p_chave, horario_referencia = coalesce(horario_referencia, now()),
         atualizado_em = now(), atualizado_por_nome = v_nome
   where id = v_cen.id
   returning * into v_cen;
  perform set_config('gbs.renumerar', 'off', true);

  select * into v_vit from public.vitimas where id = v_cen.vitima_id;
  if v_cen.poa_fora_origem = 'ia' or exists (select 1 from public.busca_cenario_setores where cenario_id = v_cen.id and origem = 'ia') then
    v_ia := 'Valores sugeridos por IA' || coalesce(' (' || v_cen.ia_modelo || ')', '') || ' e revisados por ' || v_nome || '.';
  end if;
  select string_agg(s.setor_nome || ': ' || trim_scale(round(s.poa * 100, 1))::text || '%', ' · ' order by s.poa desc, s.setor_nome)
    into v_detalhe from public.busca_cenario_setores s where s.cenario_id = v_cen.id;
  perform public.diario_auto(v_cen.operacao_id, v_cen.aprovada_em, 'pessoa', 'cenario_aprovado',
    'Cenário de busca aprovado: ' || v_vit.nome || ' (versão ' || v_cen.numero || ')',
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


revoke execute on function public.cenario_salvar_rascunho(uuid, jsonb), public.cenario_aprovar(uuid, timestamptz, text) from public, anon;
grant execute on function public.cenario_salvar_rascunho(uuid, jsonb), public.cenario_aprovar(uuid, timestamptz, text) to authenticated;
notify pgrst, 'reload schema';
