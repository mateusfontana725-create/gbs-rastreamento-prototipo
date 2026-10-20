-- =====================================================================
-- 33. Dados da operação só saem ao EXCLUIR a operação (migração 027 — idempotente; exige a 026)
--
--  Antes, encerrar (com "apagar ao encerrar") e a limpeza diária (prazo de retenção vencido)
--  apagavam participantes, trilhas, mensagens, fotos, setores, pontos, grupos e fichas.
--  Agora a operação encerrada fica guardada inteira para consulta e análise (o painel abre só
--  para visualização, migração 026). Os dados saem apenas quando alguém com permissão
--  EXCLUI a operação (excluir_operacao), como já era.
--    encerrar_operacao     não apaga nada e não marca prazo (expira_em fica vazio).
--    purgar_expiradas      não apaga dados de operação; continua encerrando operações esquecidas
--                          abertas há mais de 30 dias e removendo contas anônimas sem participação.
--    apagar_dados_operacao desativada (responde "apagar_dados_desativado").
--  Operações que ainda aguardavam o prazo deixam de ter prazo. O que já foi apagado antes não volta.
--  A coluna retencao_horas continua no banco (operações antigas e o relatório), mas não apaga mais nada.
-- =====================================================================
create or replace function public.encerrar_operacao(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;

  update public.operacoes
     set status = 'encerrada',
         encerrada_em = now(),
         expira_em = null
   where id = p_operacao and status = 'ativa'
  returning * into v_op;

  if not found then
    select * into v_op from public.operacoes where id = p_operacao;
    return row_to_json(v_op);
  end if;

  update public.participantes set rastreando = false where operacao_id = p_operacao;
  return row_to_json(v_op);
end;
$$;

create or replace function public.apagar_dados_operacao(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  raise exception 'apagar_dados_desativado';
end;
$$;

create or replace function public.purgar_expiradas()
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_encerradas integer := 0;
  v_anonimos integer := 0;
begin
  -- Salvaguarda: operações esquecidas abertas por mais de 30 dias são encerradas (nada é apagado).
  with x as (
    update public.operacoes
       set status = 'encerrada', encerrada_em = now(), expira_em = null
     where status = 'ativa' and criada_em < now() - interval '30 days'
    returning id
  )
  select count(*) into v_encerradas from x;

  -- Contas anônimas antigas que não participam de nenhuma operação guardada.
  begin
    with velhos as (
      delete from auth.users u
       where u.is_anonymous
         and u.created_at < now() - interval '7 days'
         and not exists (select 1 from public.participantes p where p.user_id = u.id)
      returning 1
    )
    select count(*) into v_anonimos from velhos;
  exception when others then
    v_anonimos := -1;   -- sem permissão no esquema auth: ignore
  end;

  return json_build_object('operacoes_encerradas', v_encerradas, 'operacoes_apagadas', 0, 'contas_anonimas_removidas', v_anonimos);
end;
$$;

revoke execute on function public.encerrar_operacao(uuid), public.apagar_dados_operacao(uuid) from public, anon;
grant execute on function public.encerrar_operacao(uuid), public.apagar_dados_operacao(uuid) to authenticated;
revoke execute on function public.purgar_expiradas() from public, anon, authenticated;

-- Operações encerradas que aguardavam o prazo: deixam de ter prazo (ficam guardadas).
update public.operacoes set expira_em = null where expira_em is not null and dados_apagados_em is null;

notify pgrst, 'reload schema';
