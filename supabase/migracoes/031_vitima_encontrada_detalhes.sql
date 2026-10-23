-- =====================================================================
-- 37. Vítima encontrada com detalhes e resultado no encerramento (migração 031 — idempotente;
--     exige a 011, a 012 e a 025)
--
--  O registro de "vítima encontrada" passa a guardar, além da condição e do local:
--    vitima_id            a ficha da vítima (vitimas) a que o registro se refere — escolhida ou criada
--                         na hora só com o nome, quando ainda não há ficha;
--    encontrada_por_texto quem encontrou, quando não é participante da operação (morador, PM, SAMU…);
--    local_descricao      onde foi encontrada, em palavras (margem do rio, fundo de vale…);
--    observacoes          estado da vítima e encaminhamento (lesões, SAMU, hospital…).
--  registrar_vitima_encontrada(p_operacao, p_dados) faz tudo numa transação, com as mesmas regras e o
--  mesmo alerta, diário e mensagem neutra da 025 (que continua valendo). O painel usa o mesmo formulário
--  no botão "Vítima encontrada" e no encerramento da operação. O diário (e por ele o relatório) leva
--  os detalhes. Leitura só pelos responsáveis (RLS da 011). Operação encerrada: recusado.
-- =====================================================================
alter table public.vitima_localizacoes add column if not exists vitima_id uuid references public.vitimas(id) on delete set null;
alter table public.vitima_localizacoes add column if not exists encontrada_por_texto text;
alter table public.vitima_localizacoes add column if not exists local_descricao text;
alter table public.vitima_localizacoes add column if not exists observacoes text;
do $$
begin
  alter table public.vitima_localizacoes add constraint vitima_localizacoes_detalhes_ok check (
    (encontrada_por_texto is null or char_length(encontrada_por_texto) <= 120)
    and (local_descricao is null or char_length(local_descricao) <= 500)
    and (observacoes is null or char_length(observacoes) <= 1000));
exception when duplicate_object then null;
end;
$$;

-- p_dados: condicao ('viva'|'obito'), lat, lng, precisao, posicao_em, encontrou (participante),
--          encontrada_por (texto), local_descricao, observacoes, vitima_id ou vitima_nome (cria a ficha).
create or replace function public.registrar_vitima_encontrada(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_status text;
  v_part public.participantes%rowtype;
  v_enc public.participantes%rowtype;
  v_vit public.vitimas%rowtype;
  v_msg public.mensagens%rowtype;
  v_reg public.vitima_localizacoes%rowtype;
  v_nome_reg text;
  v_condicao text;
  v_lat double precision;
  v_lng double precision;
  v_prec real;
  v_pos_em timestamptz;
  v_enc_txt text;
  v_local text;
  v_obs text;
  v_ref uuid;
  v_vnome text;
begin
  if v_nome_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  v_condicao := p_dados->>'condicao';
  if v_condicao is null or v_condicao not in ('viva', 'obito') then
    raise exception 'dados_invalidos';
  end if;
  begin
    v_lat := nullif(p_dados->>'lat', '')::double precision;
    v_lng := nullif(p_dados->>'lng', '')::double precision;
    v_prec := nullif(p_dados->>'precisao', '')::real;
    v_pos_em := nullif(p_dados->>'posicao_em', '')::timestamptz;
  exception when others then
    raise exception 'posicao_invalida';
  end;
  if (v_lat is null) <> (v_lng is null)
     or (v_lat is not null and (v_lat not between -90 and 90 or v_lng not between -180 and 180 or (v_lat = 0 and v_lng = 0))) then
    raise exception 'posicao_invalida';
  end if;
  v_prec := case when v_prec between 0 and 100000 then v_prec end;
  v_pos_em := case when v_lat is not null then least(coalesce(v_pos_em, now()), now()) end;
  v_enc_txt := nullif(left(btrim(coalesce(p_dados->>'encontrada_por', '')), 120), '');
  v_local := nullif(left(btrim(coalesce(p_dados->>'local_descricao', '')), 500), '');
  v_obs := nullif(left(btrim(coalesce(p_dados->>'observacoes', '')), 1000), '');

  if nullif(p_dados->>'encontrou', '') is not null then
    begin
      v_ref := (p_dados->>'encontrou')::uuid;
    exception when others then
      raise exception 'participante_invalido';
    end;
    select * into v_enc from public.participantes where id = v_ref and operacao_id = p_operacao;
    if not found then
      raise exception 'participante_invalido';
    end if;
  end if;

  -- ficha da vítima: escolhida ou criada agora só com o nome
  if nullif(p_dados->>'vitima_id', '') is not null then
    begin
      v_ref := (p_dados->>'vitima_id')::uuid;
    exception when others then
      raise exception 'vitima_nao_encontrada';
    end;
    select * into v_vit from public.vitimas where id = v_ref and operacao_id = p_operacao;
    if not found then
      raise exception 'vitima_nao_encontrada';
    end if;
  elsif btrim(coalesce(p_dados->>'vitima_nome', '')) <> '' then
    v_vnome := btrim(regexp_replace(p_dados->>'vitima_nome', '\s+', ' ', 'g'));
    if char_length(v_vnome) > 80 then
      raise exception 'nome_vitima_invalido';
    end if;
    insert into public.vitimas (operacao_id, nome, criado_por, criado_por_nome, atualizado_por_nome)
    values (p_operacao, v_vnome, auth.uid(), v_nome_resp, v_nome_resp)
    returning * into v_vit;
  end if;

  -- registro do responsável na operação (o mesmo da 025)
  perform public.entrar_como_responsavel(p_operacao);
  select * into v_part from public.participantes where operacao_id = p_operacao and user_id = auth.uid();

  v_nome_reg := v_part.nome ||
    case when v_enc.id is not null and v_enc.id <> v_part.id then ' (encontrada por ' || v_enc.nome || ')'
         when v_enc_txt is not null then ' (encontrada por ' || v_enc_txt || ')' else '' end;

  insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto,
                                direcao, categoria, lat, lng, precisao, posicao_em, entregue_em, lida_em, lida_por_nome)
  values (p_operacao, v_part.id, auth.uid(), v_part.nome, 'PARTICIPANTE', 'Localizada, ver protocolo',
          'entrada', 'VITIMA', v_lat, v_lng, v_prec, v_pos_em, now(), now(), v_part.nome)
  returning * into v_msg;

  insert into public.vitima_localizacoes (operacao_id, participante_id, mensagem_id, condicao, lat, lng, precisao,
                                          posicao_em, registrado_em, registrado_por, registrado_por_nome, registrado_por_tipo,
                                          vitima_id, encontrada_por_texto, local_descricao, observacoes)
  values (p_operacao, v_part.id, v_msg.id, v_condicao, v_lat, v_lng, v_prec,
          v_pos_em, v_msg.criada_em, auth.uid(), left(v_nome_reg, 120), 'responsavel',
          v_vit.id, case when v_enc.id is null then v_enc_txt end, v_local, v_obs)
  returning * into v_reg;

  perform public.criar_alerta(p_operacao, 'vitima_localizada', 'critico',
    'VÍTIMA LOCALIZADA',
    'Registrado por ' || v_nome_reg || ' (responsável)' ||
      case when v_lat is null then ' · sem localização' else '' end || '. Veja a condição no painel.',
    'vitima:' || v_reg.id, null, null, coalesce(v_enc.id, v_part.id), v_lat, v_lng, v_pos_em);

  return json_build_object('mensagem', row_to_json(v_msg), 'registro', row_to_json(v_reg),
                           'vitima', case when v_vit.id is not null then row_to_json(v_vit) end);
end;
$$;
revoke execute on function public.registrar_vitima_encontrada(uuid, jsonb) from public, anon;
grant execute on function public.registrar_vitima_encontrada(uuid, jsonb) to authenticated;

-- Diário (e o relatório, que é montado dele): leva a vítima, o local e o estado.
create or replace function public.diario_de_vitima_localizada()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_vit text;
begin
  select nome into v_vit from public.vitimas where id = new.vitima_id;
  perform public.diario_auto(new.operacao_id, coalesce(new.posicao_em, new.registrado_em), 'encontro', 'vitima_localizada',
    'Vítima localizada — ' || case new.condicao when 'viva' then 'VIVA' else 'MORTA' end || coalesce(': ' || v_vit, ''),
    concat_ws(' · ',
      'Registrado por ' || new.registrado_por_nome || ' (' || public.diario_rotulo_tipo(new.registrado_por_tipo) || ')',
      case when new.encontrada_por_texto is not null and position('encontrada por' in new.registrado_por_nome) = 0
           then 'encontrada por ' || new.encontrada_por_texto end,
      case when new.local_descricao is not null then 'local: ' || new.local_descricao end,
      case when new.lat is null then 'sem localização do GPS' end,
      case when new.observacoes is not null then 'estado/encaminhamento: ' || new.observacoes end),
    'vitima_localizada:' || new.id, 'critico', new.lat, new.lng, new.id::text, new.registrado_por_nome);
  return new;
end;
$$;

notify pgrst, 'reload schema';
