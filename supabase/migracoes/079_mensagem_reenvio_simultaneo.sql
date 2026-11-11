-- Migração 079: mensagens do participante enviadas duas vezes ao mesmo tempo não dão mais erro.
-- Quando a internet volta, o celular pode reenviar a mesma mensagem (ou aviso de vítima) por dois caminhos juntos.
-- Os dois pedidos passavam pela checagem "já foi gravada?" antes de qualquer um gravar, e o segundo batia na trava
-- de duplicidade (mensagens_cliente_unico) com "Erro inesperado: duplicate key value...".
-- Agora os pedidos com o mesmo client_id esperam um ao outro: o segundo encontra a mensagem e a devolve.
-- Mesmas assinaturas; o app também evita o envio em dobro do lado do aparelho.

create or replace function public.participante_enviar_mensagem(
  p_participante uuid, p_categoria text, p_texto text,
  p_lat double precision default null, p_lng double precision default null,
  p_precisao real default null, p_posicao_em timestamptz default null, p_client_id uuid default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_texto text := btrim(coalesce(p_texto, ''));
  v_cat text := coalesce(p_categoria, 'MENSAGEM');
  v_msg public.mensagens%rowtype;
  v_recentes integer;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found or v_part.tipo = 'responsavel' then
    raise exception 'participante_invalido';
  end if;
  if v_part.liberado_em is not null then
    raise exception 'participante_liberado';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  -- AJUDA = botão "Preciso de ajuda" da página do participante (alarme no painel)
  if v_cat not in ('MENSAGEM', 'OBJETO', 'VESTIGIO', 'PISTA', 'OBSTACULO', 'OUTRO', 'AJUDA') then
    raise exception 'tipo_invalido';
  end if;
  if v_texto = '' then
    raise exception 'texto_obrigatorio';
  end if;
  if char_length(v_texto) > 1000 then
    raise exception 'texto_longo';
  end if;
  -- Localização: só a que o aparelho informou; nunca é inventada.
  if (p_lat is null) <> (p_lng is null)
     or (p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0))) then
    raise exception 'posicao_invalida';
  end if;

  if p_client_id is not null then
    -- Dois envios da mesma mensagem ao mesmo tempo (a internet voltou): um espera o outro e devolve a gravada.
    perform pg_advisory_xact_lock(hashtextextended('mensagem:' || v_part.id || ':' || p_client_id, 0));
    select * into v_msg from public.mensagens where participante_id = v_part.id and client_id = p_client_id;
    if found then
      return row_to_json(v_msg);   -- reenvio: já estava gravada
    end if;
  end if;

  select count(*) into v_recentes from public.mensagens
   where participante_id = v_part.id and direcao = 'entrada' and criada_em > now() - interval '1 minute';
  if v_recentes >= 20 then
    raise exception 'muitas_mensagens';
  end if;

  insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto,
                                direcao, categoria, lat, lng, precisao, posicao_em, client_id, entregue_em)
  values (v_part.operacao_id, v_part.id, auth.uid(), v_part.nome, 'PARTICIPANTE', v_texto,
          'entrada', v_cat, p_lat, p_lng,
          case when p_precisao between 0 and 100000 then p_precisao end,
          case when p_lat is not null then least(coalesce(p_posicao_em, now()), now()) end,
          p_client_id, now())
  returning * into v_msg;

  update public.participantes set ultimo_contato_em = now() where id = v_part.id;
  return row_to_json(v_msg);
end;
$$;

create or replace function public.participante_registrar_vitima(
  p_participante uuid, p_condicao text,
  p_lat double precision default null, p_lng double precision default null,
  p_precisao real default null, p_posicao_em timestamptz default null, p_client_id uuid default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_msg public.mensagens%rowtype;
  v_reg public.vitima_localizacoes%rowtype;
  v_recentes integer;
  v_prec real := case when p_precisao between 0 and 100000 then p_precisao end;
  v_pos_em timestamptz := case when p_lat is not null then least(coalesce(p_posicao_em, now()), now()) end;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found or v_part.tipo = 'responsavel' then
    raise exception 'participante_invalido';
  end if;
  if v_part.liberado_em is not null then
    raise exception 'participante_liberado';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_condicao is null or p_condicao not in ('viva', 'obito') then
    raise exception 'dados_invalidos';
  end if;
  -- Localização: só a que o aparelho informou; nunca é inventada.
  if (p_lat is null) <> (p_lng is null)
     or (p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0))) then
    raise exception 'posicao_invalida';
  end if;

  if p_client_id is not null then
    -- Dois envios da mesma mensagem ao mesmo tempo (a internet voltou): um espera o outro e devolve a gravada.
    perform pg_advisory_xact_lock(hashtextextended('mensagem:' || v_part.id || ':' || p_client_id, 0));
    select * into v_msg from public.mensagens where participante_id = v_part.id and client_id = p_client_id;
    if found then
      if v_msg.categoria <> 'VITIMA' then
        raise exception 'dados_invalidos';
      end if;
      return row_to_json(v_msg);   -- reenvio: já estava gravado
    end if;
  end if;

  select count(*) into v_recentes from public.mensagens
   where participante_id = v_part.id and direcao = 'entrada' and criada_em > now() - interval '1 minute';
  if v_recentes >= 20 then
    raise exception 'muitas_mensagens';
  end if;

  insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto,
                                direcao, categoria, lat, lng, precisao, posicao_em, client_id, entregue_em)
  values (v_part.operacao_id, v_part.id, auth.uid(), v_part.nome, 'PARTICIPANTE', 'Localizada, ver protocolo',
          'entrada', 'VITIMA', p_lat, p_lng, v_prec, v_pos_em, p_client_id, now())
  returning * into v_msg;

  insert into public.vitima_localizacoes (operacao_id, participante_id, mensagem_id, condicao, lat, lng, precisao,
                                          posicao_em, registrado_em, registrado_por, registrado_por_nome, registrado_por_tipo)
  values (v_part.operacao_id, v_part.id, v_msg.id, p_condicao, p_lat, p_lng, v_prec,
          v_pos_em, v_msg.criada_em, auth.uid(), v_part.nome, v_part.tipo)
  returning * into v_reg;

  -- Alerta crítico aos responsáveis (texto neutro; a condição fica só na tabela protegida)
  perform public.criar_alerta(v_part.operacao_id, 'vitima_localizada', 'critico',
    'VÍTIMA LOCALIZADA',
    'Registrado por ' || v_part.nome || ' (' || v_part.tipo || ')' ||
      case when p_lat is null then ' · sem localização do GPS' else '' end || '. Veja a condição no painel.',
    'vitima:' || v_reg.id, null, null, v_part.id, p_lat, p_lng, v_pos_em);

  update public.participantes set ultimo_contato_em = now() where id = v_part.id;
  return row_to_json(v_msg);
end;
$$;
revoke execute on function public.participante_enviar_mensagem(uuid, text, text, double precision, double precision, real, timestamptz, uuid)
  from public, anon;
grant execute on function public.participante_enviar_mensagem(uuid, text, text, double precision, double precision, real, timestamptz, uuid)
  to authenticated;
revoke execute on function public.participante_registrar_vitima(uuid, text, double precision, double precision, real, timestamptz, uuid)
  from public, anon;
grant execute on function public.participante_registrar_vitima(uuid, text, double precision, double precision, real, timestamptz, uuid)
  to authenticated;

notify pgrst, 'reload schema';
