-- =====================================================================
-- 23. ADMINISTRADOR VÊ TODAS AS OPERAÇÕES (migração 016 — idempotente; exige a 008)
--
--  Antes, um responsável só enxergava as operações que criou ou das quais foi
--  adicionado. Agora o ADMINISTRADOR (responsaveis.admin e ativo) acessa todas as
--  operações. A regra fica na função dono_operacao, que já é usada pelas políticas
--  de leitura e pelas funções do painel: nada mais precisa mudar nelas.
--  Demais responsáveis continuam como antes (criador ou responsável adicionado).
-- =====================================================================
create or replace function public.dono_operacao(p_operacao uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  -- Administrador: qualquer operação existente. Demais responsáveis: criador ou responsável adicionado.
  select public.eh_responsavel() and exists (select 1 from public.operacoes o where o.id = p_operacao) and (
    public.eh_admin()
    or exists (
      select 1
        from public.operacoes o
       where o.id = p_operacao
         and (o.responsavel_id = auth.uid()
              or exists (select 1 from public.operacao_responsaveis m
                          where m.operacao_id = o.id and m.user_id = auth.uid()))
    )
  );
$$;

notify pgrst, 'reload schema';
