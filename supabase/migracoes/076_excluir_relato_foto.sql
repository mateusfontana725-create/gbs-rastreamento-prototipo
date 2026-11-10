-- Migração 076: o responsável da operação (administrador, criador ou responsável adicionado) apaga o que os participantes enviaram:
--   · excluir_relato: um relato ou mensagem do participante para os responsáveis (direção "entrada": objeto, vestígio, pista, obstáculo,
--     vítima, ajuda ou mensagem com localização). Por padrão apaga também os pontos de interesse criados a partir dele
--     (pontos_interesse.mensagem_id). O pedido de ajuda continua registrado (pedidos_ajuda guarda o texto e some só o vínculo).
--   · excluir_foto: uma foto (o arquivo vai para a fila de exclusão do Storage pelo gatilho que já existe).
-- Pontos de interesse e setores já são excluídos por qualquer responsável da operação desde a migração 074.
-- Operação encerrada: não exclui (como as outras exclusões).

create or replace function public.excluir_relato(p_id uuid, p_com_ponto boolean default true)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v public.mensagens%rowtype;
  v_pontos integer := 0;
begin
  select * into v from public.mensagens where id = p_id;
  if not found or v.direcao <> 'entrada' or not public.dono_operacao(v.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if (select status from public.operacoes where id = v.operacao_id) <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if coalesce(p_com_ponto, true) then
    delete from public.pontos_interesse where mensagem_id = p_id;
    get diagnostics v_pontos = row_count;
  end if;
  delete from public.mensagens where id = p_id;
  return json_build_object('pontos_excluidos', v_pontos);
end;
$$;
revoke execute on function public.excluir_relato(uuid, boolean) from public, anon;
grant execute on function public.excluir_relato(uuid, boolean) to authenticated;

create or replace function public.excluir_foto(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.fotos%rowtype;
begin
  select * into v from public.fotos where id = p_id;
  if not found or not public.dono_operacao(v.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if (select status from public.operacoes where id = v.operacao_id) <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  delete from public.fotos where id = p_id;
end;
$$;
revoke execute on function public.excluir_foto(uuid) from public, anon;
grant execute on function public.excluir_foto(uuid) to authenticated;
