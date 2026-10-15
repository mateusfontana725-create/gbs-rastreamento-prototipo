-- =====================================================================
-- 24. EXCLUIR RESPONSÁVEL (migração 017 — idempotente; exige a 008 e a 016)
--
--  Até aqui o administrador só podia DESATIVAR um responsável. Agora ele pode
--  excluí-lo, com estas regras:
--    - não pode excluir a si mesmo;
--    - não pode excluir quem já tem histórico no sistema: operação criada,
--      mensagem enviada ou localização de vítima registrada. Apagar essas pessoas
--      apagaria junto registros oficiais da operação. Nesses casos, desative o acesso.
--  A função só remove a linha em responsaveis. O login (auth.users) é apagado
--  pela função de servidor /api/responsaveis (ação "excluir"), que usa a chave secreta.
-- =====================================================================
create or replace function public.admin_excluir_responsavel(p_user uuid)
returns json
language plpgsql security definer set search_path = public
as $$
begin
  if not public.eh_admin() then
    raise exception 'sem_permissao';
  end if;
  if p_user = auth.uid() then
    raise exception 'nao_pode_alterar_a_si';
  end if;
  if not exists (select 1 from public.responsaveis where user_id = p_user) then
    raise exception 'responsavel_nao_encontrado';
  end if;
  if exists (select 1 from public.operacoes where responsavel_id = p_user)
     or exists (select 1 from public.mensagens where remetente_id = p_user)
     or exists (select 1 from public.vitima_localizacoes where registrado_por = p_user) then
    raise exception 'responsavel_com_registros';
  end if;
  delete from public.responsaveis where user_id = p_user;
  return public.admin_listar_responsaveis();
end;
$$;

revoke execute on function public.admin_excluir_responsavel(uuid) from public, anon;
grant execute on function public.admin_excluir_responsavel(uuid) to authenticated;

notify pgrst, 'reload schema';
