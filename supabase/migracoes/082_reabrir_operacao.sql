-- =====================================================================
-- 082_reabrir_operacao.sql — retomar uma operação encerrada (só acréscimos; idempotente)
--
--  reabrir_operacao(p_operacao, p_motivo): um responsável da operação volta a operação encerrada para "ativa"
--  (painel, participantes, setores e registros voltam a aceitar alterações). O motivo é obrigatório e fica no diário,
--  junto com o registro automático "Operação reaberta". O desfecho registrado continua (pode ser trocado ao encerrar de novo).
--  Não reabre operação ARQUIVADA (os dados estão no arquivo do Storage) nem a que teve os dados pessoais apagados pela
--  regra antiga de retenção. Os participantes voltam pelo mesmo link ou pelo código da operação.
--  operacoes.reaberta_em / reaberta_por_nome guardam a última reabertura; a salvaguarda que encerra operações esquecidas
--  abertas há mais de 30 dias (purgar_expiradas) passa a contar da reabertura.
-- =====================================================================

alter table public.operacoes add column if not exists reaberta_em timestamptz;
alter table public.operacoes add column if not exists reaberta_por_nome text;

create or replace function public.reabrir_operacao(p_operacao uuid, p_motivo text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_op public.operacoes%rowtype;
  v_motivo text := btrim(regexp_replace(coalesce(p_motivo, ''), '\s+', ' ', 'g'));
begin
  if v_nome is null or p_operacao is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao for update;
  if not found then
    raise exception 'sem_permissao';
  end if;
  if v_op.status = 'ativa' then
    return row_to_json(v_op);   -- já está ativa: nada a fazer (dois painéis reabrindo juntos)
  end if;
  if v_op.arquivada_em is not null then
    raise exception 'reabrir_arquivada';
  end if;
  if v_op.dados_apagados_em is not null then
    raise exception 'reabrir_dados_apagados';
  end if;
  if char_length(v_motivo) < 3 then
    raise exception 'motivo_obrigatorio';
  end if;
  update public.operacoes
     set status = 'ativa', encerrada_em = null, expira_em = null,
         reaberta_em = now(), reaberta_por_nome = v_nome, atualizado_em = now(), atualizado_por_nome = v_nome
   where id = p_operacao
  returning * into v_op;
  perform public.diario_auto(p_operacao, now(), 'operacao', 'operacao_reaberta_motivo', 'Motivo da reabertura',
    left(v_motivo, 500), 'operacao_reaberta_motivo:' || p_operacao || ':' || extract(epoch from now())::bigint, 'info', null, null, p_operacao::text, v_nome);
  return row_to_json(v_op);
end;
$$;
revoke execute on function public.reabrir_operacao(uuid, text) from public, anon;
grant execute on function public.reabrir_operacao(uuid, text) to authenticated;

create or replace function public.purgar_expiradas()
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_encerradas integer := 0;
  v_apagadas integer := 0;
  v_anonimos integer := 0;
begin
  -- Salvaguarda: operações esquecidas abertas por mais de 30 dias são encerradas.
  with x as (
    update public.operacoes
       set status = 'encerrada', encerrada_em = now(), expira_em = now() + make_interval(hours => retencao_horas)
     where status = 'ativa' and coalesce(reaberta_em, criada_em) < now() - interval '30 days'
    returning id
  )
  select count(*) into v_encerradas from x;

  -- Apaga participantes, posições e mensagens de operações com retenção vencida.
  with alvo as (
    update public.operacoes
       set dados_apagados_em = now()
     where status = 'encerrada' and dados_apagados_em is null and expira_em <= now()
    returning id
  ), del as (
    delete from public.participantes where operacao_id in (select id from alvo) returning 1
  )
  select (select count(*) from alvo) into v_apagadas from (select count(*) from del) d;

  -- Remove contas anônimas antigas que não participam mais de nenhuma operação.
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

  return json_build_object('operacoes_encerradas', v_encerradas, 'operacoes_apagadas', v_apagadas, 'contas_anonimas_removidas', v_anonimos);
end;
$$;
revoke execute on function public.purgar_expiradas() from public, anon, authenticated;

notify pgrst, 'reload schema';
