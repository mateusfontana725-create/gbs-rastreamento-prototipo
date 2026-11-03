-- =====================================================================
-- 060 — Arquivamento de operação com cenário de POA aprovado.
--
--  Problema: o gatilho busca_cenarios_proteger (migração 059) recusa apagar cenário aprovado. Ele não tinha a marca
--  gbs.arquivando_operacao, que os outros gatilhos de exclusão já respeitam. Por isso, ao arquivar (api/arquivar.js →
--  servidor_arquivo_confirmar), a operação com POA aprovado falhava com cenario_imutavel_aprovado: o envio era desfeito
--  e a operação continuava ocupando o banco inteiro.
--
--  Correção: durante o arquivamento a marca deixa a exclusão passar, igual aos demais gatilhos. Fora dele, nada muda:
--  cenário aprovado continua imutável e não é apagado por ninguém.
--
--  SÓ ACRÉSCIMO DE CONDIÇÃO: a função é substituída; a regra de imutabilidade fora do arquivamento permanece.
-- =====================================================================

create or replace function public.busca_cenarios_proteger()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_estado text;
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- arquivamento de operação encerrada (migração 055): a exclusão é a própria cópia no arquivo
  if coalesce(current_setting('gbs.arquivando_operacao', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'busca_cenarios' then
    if tg_op in ('UPDATE', 'DELETE') and old.estado = 'aprovada' then
      raise exception 'cenario_imutavel_aprovado';
    end if;
    if tg_op = 'UPDATE' and (new.operacao_id <> old.operacao_id or new.vitima_id is distinct from old.vitima_id
       or (new.numero <> old.numero and not (current_setting('gbs.renumerar', true) = 'on' and old.estado = 'rascunho' and new.estado = 'aprovada'))) then
      raise exception 'dados_invalidos';
    end if;
  else
    if current_setting('gbs.gerando_versao', true) = 'on' and tg_op = 'INSERT' then
      return new;
    end if;
    select estado into v_estado from public.busca_cenarios where id = coalesce(new.cenario_id, old.cenario_id);
    if v_estado = 'aprovada' then
      raise exception 'cenario_imutavel_aprovado';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke execute on function public.busca_cenarios_proteger() from public, anon, authenticated;

notify pgrst, 'reload schema';
