-- =====================================================================
-- 064 · Ponto de interesse concluído (migração idempotente; exige a 003 (pontos_interesse) e a 026 (operação encerrada))
--
-- Dá baixa num ponto (ex.: vestígio checado, local vistoriado). Quem pode alterar a operação marca e reabre.
-- Gravação só pela RPC marcar_ponto_concluido.
-- =====================================================================

alter table public.pontos_interesse add column if not exists concluido_em timestamptz;
alter table public.pontos_interesse add column if not exists concluido_por_nome text;

create or replace function public.marcar_ponto_concluido(p_operacao uuid, p_id uuid, p_concluido boolean)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v public.pontos_interesse%rowtype;
  v_op public.operacoes%rowtype;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if v_op.status <> 'ativa' or v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  select * into v from public.pontos_interesse where id = p_id and operacao_id = p_operacao for update;
  if not found then
    raise exception 'ponto_nao_encontrado';
  end if;
  update public.pontos_interesse
     set concluido_em = case when coalesce(p_concluido, false) then now() else null end,
         concluido_por_nome = case when coalesce(p_concluido, false) then v_nome else null end,
         atualizado_em = now(), atualizado_por_nome = v_nome
   where id = p_id
  returning * into v;
  return row_to_json(v);
end;
$$;
revoke execute on function public.marcar_ponto_concluido(uuid, uuid, boolean) from public, anon;
grant execute on function public.marcar_ponto_concluido(uuid, uuid, boolean) to authenticated;
