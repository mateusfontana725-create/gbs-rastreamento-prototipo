-- =====================================================================
-- 053 — Convite de responsável com acesso: o servidor cria o login e a senha provisória (api/convidar-responsavel.js).
--
--  responsavel_convite_checar(operação): quem está convidando e os dados da operação. Só responsável da operação,
--    com a operação ativa. Devolve também o id de quem convida (para registrar quem incluiu).
--  servidor_situacao_email(e-mail): se o e-mail já tem login e se é responsável ativo. Só o servidor (chave secreta).
--  servidor_vincular_responsavel(operação, usuário, quem inclui): inclui um responsável ativo na operação.
--    Devolve true se incluiu agora, false se já estava. Só o servidor.
--  servidor_desvincular_responsavel(operação, usuário): desfaz essa inclusão quando o e-mail não sai. Só o servidor.
--
--  Quem convida continua limitado pelas regras da operação (dono_operacao). A criação do login e a senha provisória
--  ficam no servidor: a senha nunca passa pelo navegador e vai só no e-mail.
-- =====================================================================

create or replace function public.responsavel_convite_checar(p_operacao uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if v_op.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  return json_build_object('operacao_id', v_op.id, 'codigo', v_op.codigo,
    'convidado_por', public.nome_responsavel_atual(), 'quem', auth.uid());
end;
$$;

create or replace function public.servidor_situacao_email(p_email text)
returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object('user_id', u.id, 'responsavel', r.user_id is not null, 'ativo', coalesce(r.ativo, false))
    from auth.users u
    left join public.responsaveis r on r.user_id = u.id
   where lower(u.email) = lower(btrim(coalesce(p_email, '')))
   limit 1;
$$;

create or replace function public.servidor_vincular_responsavel(p_operacao uuid, p_user uuid, p_por uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_linhas integer := 0;
begin
  if exists (select 1 from public.operacoes where id = p_operacao and responsavel_id = p_user) then
    return false;
  end if;
  if not exists (select 1 from public.responsaveis where user_id = p_user and ativo) then
    raise exception 'responsavel_nao_encontrado';
  end if;
  insert into public.operacao_responsaveis (operacao_id, user_id, adicionado_por)
  values (p_operacao, p_user, p_por)
  on conflict do nothing;
  get diagnostics v_linhas = row_count;
  return v_linhas > 0;
end;
$$;

create or replace function public.servidor_desvincular_responsavel(p_operacao uuid, p_user uuid)
returns void
language sql security definer set search_path = public
as $$
  delete from public.operacao_responsaveis where operacao_id = p_operacao and user_id = p_user;
$$;

revoke execute on function public.responsavel_convite_checar(uuid) from public, anon;
grant execute on function public.responsavel_convite_checar(uuid) to authenticated;
revoke execute on function public.servidor_situacao_email(text), public.servidor_vincular_responsavel(uuid, uuid, uuid),
  public.servidor_desvincular_responsavel(uuid, uuid) from public, anon, authenticated;
grant execute on function public.servidor_situacao_email(text), public.servidor_vincular_responsavel(uuid, uuid, uuid),
  public.servidor_desvincular_responsavel(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
