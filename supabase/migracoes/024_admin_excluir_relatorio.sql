-- =====================================================================
-- 30. Administrador exclui relatório (migração 024 — idempotente; exige a 012 e a 020)
--
--  O relatório pode ser apagado só por administrador, para não acumular versões.
--  O PDF sai do Storage pela fila de limpeza (arquivos_pendentes, bucket "relatorios") e a
--  exclusão fica registrada no diário.
-- =====================================================================
create or replace function public.relatorios_proteger()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' and (coalesce(current_setting('gbs.excluindo_operacao', true), '') = old.operacao_id::text
                           or coalesce(current_setting('gbs.excluindo_relatorio', true), '') = old.id::text) then
    return old;
  end if;
  raise exception 'relatorio_nao_apaga';
end;
$$;

-- Administrador exclui um relatório gerado (o PDF sai do Storage pela limpeza diária).
-- Fica registrado no diário: quem excluiu e de qual relatório.
create or replace function public.excluir_relatorio(p_relatorio uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v public.relatorios%rowtype;
  v_nome text := public.nome_responsavel_atual();
begin
  if v_nome is null or not public.eh_admin() then
    raise exception 'sem_permissao';
  end if;
  select * into v from public.relatorios where id = p_relatorio for update;
  if not found then
    raise exception 'relatorio_nao_encontrado';
  end if;
  insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
  values (v.caminho, 'relatorios', v.operacao_id, null)
  on conflict (caminho) do nothing;
  perform set_config('gbs.excluindo_relatorio', v.id::text, true);
  delete from public.relatorios where id = v.id;
  perform set_config('gbs.excluindo_relatorio', '', true);
  perform public.diario_auto(v.operacao_id, now(), 'operacao', 'relatorio_excluido', 'Relatório excluído',
    'Relatório de ' || to_char(v.gerado_em, 'DD/MM/YYYY HH24:MI') || ' (gerado por ' || v.gerado_por_nome || ')',
    'relatorio_excluido:' || v.id::text, 'info', null, null, v.id::text, v_nome);
  return json_build_object('id', v.id, 'operacao_id', v.operacao_id);
end;
$$;

revoke execute on function public.excluir_relatorio(uuid) from public, anon;
grant execute on function public.excluir_relatorio(uuid) to authenticated;

notify pgrst, 'reload schema';
