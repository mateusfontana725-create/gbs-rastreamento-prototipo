-- =====================================================================
-- 47. Excluir operação: quem criou apaga tudo, mesmo com atividade
--     (migração 041 — idempotente; exige a 012, a 020 e a 027)
--
--  Antes, o criador que não é administrador só conseguia excluir operação sem atividade
--  no diário e sem relatório ("operacao_com_registros"). Como quase toda operação real tem
--  algum registro, a exclusão era recusada. Agora quem criou a operação (ou um administrador)
--  apaga a operação e tudo o que é dela: participantes, trilhas, mensagens, fotos, fichas,
--  grupos, deslocamentos, diário e relatórios. Os arquivos (fotos e PDFs) entram na fila de
--  remoção do Storage. Os demais responsáveis da operação continuam sem poder excluir.
-- =====================================================================
create or replace function public.excluir_operacao(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_codigo text;
  v_fotos integer;
  v_participantes integer;
  v_vitimas integer;
begin
  if not (public.eh_criador(p_operacao) or (public.eh_admin() and public.dono_operacao(p_operacao))) then
    raise exception 'sem_permissao';
  end if;
  select codigo into v_codigo from public.operacoes where id = p_operacao for update;
  if v_codigo is null then
    raise exception 'sem_permissao';
  end if;
  insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
  select caminho, 'relatorios', p_operacao, null from public.relatorios where operacao_id = p_operacao
  on conflict (caminho) do nothing;
  select count(*) into v_fotos from public.fotos where operacao_id = p_operacao;
  select count(*) into v_participantes from public.participantes where operacao_id = p_operacao and tipo <> 'responsavel';
  select count(*) into v_vitimas from public.vitimas where operacao_id = p_operacao;

  perform set_config('gbs.excluindo_operacao', p_operacao::text, true);
  delete from public.operacoes where id = p_operacao;   -- apaga em cascata tudo o que é da operação
  perform set_config('gbs.excluindo_operacao', '', true);

  return json_build_object('operacao', v_codigo, 'fotos', v_fotos, 'participantes', v_participantes, 'vitimas', v_vitimas);
end;
$$;

notify pgrst, 'reload schema';
