-- =====================================================================
-- 31. Responsável registra "vítima encontrada" pelo painel (migração 025 — idempotente; exige a 011)
--
--  Até aqui só o participante de campo registrava (participante_registrar_vitima). O responsável
--  também recebe a notícia por rádio, telefone ou pessoalmente e precisa registrar no sistema.
--  Mesmo formato do registro de campo, para o alerta, o diário, o dashboard e o relatório
--  tratarem igual:
--    mensagens            linha NEUTRA (categoria VITIMA, "Localizada, ver protocolo") no
--                         registro do próprio responsável na operação (criado se faltar);
--    vitima_localizacoes  a condição (viva/óbito), lida só pelos responsáveis (RLS da 011);
--    alertas              alerta crítico "VÍTIMA LOCALIZADA" para os demais responsáveis.
--  Opcional: quem encontrou (participante da operação), que fica no nome do registro.
--  A localização vem do mapa, do GPS do aparelho ou da posição de quem encontrou; nunca é inventada.
-- =====================================================================
create or replace function public.responsavel_registrar_vitima(
  p_operacao uuid, p_condicao text,
  p_lat double precision default null, p_lng double precision default null,
  p_precisao real default null, p_posicao_em timestamptz default null,
  p_encontrou uuid default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
  v_part public.participantes%rowtype;
  v_enc public.participantes%rowtype;
  v_msg public.mensagens%rowtype;
  v_reg public.vitima_localizacoes%rowtype;
  v_nome_reg text;
  v_prec real := case when p_precisao between 0 and 100000 then p_precisao end;
  v_pos_em timestamptz := case when p_lat is not null then least(coalesce(p_posicao_em, now()), now()) end;
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_condicao is null or p_condicao not in ('viva', 'obito') then
    raise exception 'dados_invalidos';
  end if;
  if (p_lat is null) <> (p_lng is null)
     or (p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0))) then
    raise exception 'posicao_invalida';
  end if;
  if p_encontrou is not null then
    select * into v_enc from public.participantes where id = p_encontrou and operacao_id = p_operacao;
    if not found then
      raise exception 'participante_invalido';
    end if;
  end if;

  -- registro do responsável na operação (o mesmo que aparece no mapa como "R")
  perform public.entrar_como_responsavel(p_operacao);
  select * into v_part from public.participantes where operacao_id = p_operacao and user_id = auth.uid();

  v_nome_reg := v_part.nome || case when v_enc.id is not null and v_enc.id <> v_part.id then ' (encontrada por ' || v_enc.nome || ')' else '' end;

  insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto,
                                direcao, categoria, lat, lng, precisao, posicao_em, entregue_em, lida_em, lida_por_nome)
  values (p_operacao, v_part.id, auth.uid(), v_part.nome, 'PARTICIPANTE', 'Localizada, ver protocolo',
          'entrada', 'VITIMA', p_lat, p_lng, v_prec, v_pos_em, now(), now(), v_part.nome)
  returning * into v_msg;

  insert into public.vitima_localizacoes (operacao_id, participante_id, mensagem_id, condicao, lat, lng, precisao,
                                          posicao_em, registrado_em, registrado_por, registrado_por_nome, registrado_por_tipo)
  values (p_operacao, v_part.id, v_msg.id, p_condicao, p_lat, p_lng, v_prec,
          v_pos_em, v_msg.criada_em, auth.uid(), left(v_nome_reg, 120), 'responsavel')
  returning * into v_reg;

  perform public.criar_alerta(p_operacao, 'vitima_localizada', 'critico',
    'VÍTIMA LOCALIZADA',
    'Registrado por ' || v_nome_reg || ' (responsável)' ||
      case when p_lat is null then ' · sem localização' else '' end || '. Veja a condição no painel.',
    'vitima:' || v_reg.id, null, null, coalesce(v_enc.id, v_part.id), p_lat, p_lng, v_pos_em);

  return json_build_object('mensagem', row_to_json(v_msg), 'registro', row_to_json(v_reg));
end;
$$;

revoke execute on function public.responsavel_registrar_vitima(uuid, text, double precision, double precision, real, timestamptz, uuid)
  from public, anon;
grant execute on function public.responsavel_registrar_vitima(uuid, text, double precision, double precision, real, timestamptz, uuid)
  to authenticated;

notify pgrst, 'reload schema';
