-- =====================================================================
-- 058 — Localização do responsável sem gravar a trilha.
--
--  SÓ ACRÉSCIMOS: uma função nova. Nada que existe é alterado.
--
--  O responsável agora tem a localização sempre ligada (aparece no mapa para a equipe), e a gravação da trilha é
--  opcional e manual. Esta função atualiza só a ÚLTIMA posição do responsável (participantes.ultima_*), sem gravar
--  pontos na tabela de trilha (posicoes). A trilha continua sendo gravada por enviar_posicoes_lote.
--
--  Autorização igual à do sinal_vida: só o próprio responsável (user_id = auth.uid(), tipo 'responsavel'), operação ativa,
--  registro não removido nem liberado. Uma leitura mais antiga que a última já gravada não a substitui.
-- =====================================================================

create or replace function public.responsavel_posicao_atual(p_participante uuid, p_lat double precision, p_lng double precision,
  p_precisao double precision default null, p_registrado_em timestamptz default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
  v_quando timestamptz;
begin
  select * into v_part from public.participantes
   where id = p_participante and user_id = auth.uid() and tipo = 'responsavel';
  if not found then
    return json_build_object('status', 'inexistente');
  end if;
  if v_part.liberado_em is not null then
    return json_build_object('status', 'liberado');
  end if;
  if v_part.removido then
    return json_build_object('status', 'removido');
  end if;
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  if v_op.status <> 'ativa' then
    return json_build_object('status', 'encerrada');
  end if;
  if p_lat is null or p_lng is null or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180
     or (p_lat = 0 and p_lng = 0) or (p_precisao is not null and p_precisao < 0) then
    raise exception 'dados_invalidos';
  end if;
  -- a hora da leitura nunca fica no futuro (relógio do aparelho adiantado)
  v_quando := least(coalesce(p_registrado_em, now()), now());

  update public.participantes
     set ultimo_contato_em = now(),
         rastreando = true,
         ultima_lat = case when v_part.ultima_posicao_em is null or v_quando >= v_part.ultima_posicao_em then p_lat else ultima_lat end,
         ultima_lng = case when v_part.ultima_posicao_em is null or v_quando >= v_part.ultima_posicao_em then p_lng else ultima_lng end,
         ultima_precisao = case when v_part.ultima_posicao_em is null or v_quando >= v_part.ultima_posicao_em then p_precisao else ultima_precisao end,
         ultima_posicao_em = case when v_part.ultima_posicao_em is null or v_quando >= v_part.ultima_posicao_em then v_quando else ultima_posicao_em end
   where id = v_part.id;

  return json_build_object('status', 'ativa', 'agora', now(), 'gps_intervalo_s', v_op.gps_intervalo_s);
end;
$$;

revoke execute on function public.responsavel_posicao_atual(uuid, double precision, double precision, double precision, timestamptz) from public, anon;
grant execute on function public.responsavel_posicao_atual(uuid, double precision, double precision, double precision, timestamptz) to authenticated;

notify pgrst, 'reload schema';
