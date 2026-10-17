-- =====================================================================
-- 27. Administrador exclui qualquer operação, sem restrição (migração 020 — idempotente; exige a 012 e a 016)
--
--  Antes, a exclusão era recusada com atividade no diário ou relatório (operacao_com_registros),
--  inclusive para o administrador. Agora o administrador exclui qualquer operação da equipe,
--  com diário e relatórios. Criador e responsável adicionado sem ser administrador continuam
--  com a regra antiga: só operação sem atividade.
--  Os PDFs dos relatórios entram na fila de limpeza do Storage (arquivos_pendentes, bucket
--  "relatorios") sem vínculo com quem excluiu, para a limpeza diária apagar o arquivo.
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
  if not public.eh_admin()
     and (exists (select 1 from public.diario where operacao_id = p_operacao
                   and tipo not in ('operacao_criada', 'acionamento', 'responsavel_adicionado', 'ficha_vitima', 'grupo_criado', 'setor_criado',
                                    'operacao_encerrada', 'operacao_reaberta', 'dados_apagados'))
          or exists (select 1 from public.relatorios where operacao_id = p_operacao)) then
    raise exception 'operacao_com_registros';
  end if;
  insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
  select caminho, 'relatorios', p_operacao, null from public.relatorios where operacao_id = p_operacao
  on conflict (caminho) do nothing;
  select count(*) into v_fotos from public.fotos where operacao_id = p_operacao;
  select count(*) into v_participantes from public.participantes where operacao_id = p_operacao and tipo <> 'responsavel';
  select count(*) into v_vitimas from public.vitimas where operacao_id = p_operacao;

  perform set_config('gbs.excluindo_operacao', p_operacao::text, true);
  delete from public.operacoes where id = p_operacao;   -- apaga em cascata tudo o que é da operação, inclusive diário e relatórios
  perform set_config('gbs.excluindo_operacao', '', true);

  return json_build_object('operacao', v_codigo, 'fotos', v_fotos, 'participantes', v_participantes, 'vitimas', v_vitimas);
end;
$$;
