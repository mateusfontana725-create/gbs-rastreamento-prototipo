-- =====================================================================
-- 32. Operação encerrada: somente leitura (migração 026 — idempotente; exige a 012)
--
--  Depois de encerrada, a operação continua aberta para consulta pelos responsáveis e
--  administradores (mapa, trilhas, setores, pontos, mensagens, ficha, diário, dashboard),
--  mas nada do que foi registrado pode ser alterado. O servidor garante, não só a tela:
--  gatilhos recusam com "operacao_encerrada" a escrita feita DIRETAMENTE (por uma função
--  chamada pelo app) em setores, pontos, grupos e membros, fichas de vítima, destinos,
--  equipe de responsáveis, remoção/liberação/reinclusão de participantes, anotações manuais
--  do diário e o cadastro da operação.
--  Continuam permitidos: o resultado da operação e o relatório final, a reabertura, apagar os
--  dados pela retenção e excluir a operação. O que esses processos fazem por dentro (gatilhos e
--  exclusões em cascata, pg_trigger_depth() > 1) também passa.
-- =====================================================================
create or replace function public.bloquear_escrita_encerrada()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_op uuid;
  v_status text;
begin
  -- dentro de outro gatilho ou de exclusão em cascata (retenção, excluir operação, ON DELETE SET NULL)
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then v_op := old.operacao_id; else v_op := new.operacao_id; end if;
  -- diário: só as anotações manuais (os eventos automáticos continuam, ex.: resultado, dados apagados)
  if tg_table_name = 'diario' then
    if new.origem <> 'manual' then
      return new;
    end if;
  end if;
  select status into v_status from public.operacoes where id = v_op;
  if v_status is null or v_status = 'ativa' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'operacao_encerrada';
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['setores', 'pontos_interesse', 'grupos', 'grupo_membros', 'vitimas', 'destinos',
                           'operacao_responsaveis', 'participacao_eventos'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_encerrada', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.bloquear_escrita_encerrada()',
                   t || '_encerrada', t);
  end loop;
end;
$$;
drop trigger if exists diario_encerrada on public.diario;
create trigger diario_encerrada before insert or update on public.diario
  for each row execute function public.bloquear_escrita_encerrada();

-- Cadastro da operação encerrada não muda (nome, tipo, acionamento, local, descrição, IPO, GPS, retenção).
-- Resultado, encerramento/reabertura, prazo e apagamento dos dados seguem permitidos.
create or replace function public.operacoes_cadastro_encerrada()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 or old.status = 'ativa' or new.status = 'ativa' then
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'encerrada_em', 'expira_em', 'dados_apagados_em', 'resultado', 'resultado_texto',
                             'resultado_em', 'resultado_por_nome', 'atualizado_em', 'atualizado_por_nome'])
     is distinct from
     (to_jsonb(old) - array['status', 'encerrada_em', 'expira_em', 'dados_apagados_em', 'resultado', 'resultado_texto',
                             'resultado_em', 'resultado_por_nome', 'atualizado_em', 'atualizado_por_nome']) then
    raise exception 'operacao_encerrada';
  end if;
  return new;
end;
$$;
drop trigger if exists operacoes_cadastro_encerrada on public.operacoes;
create trigger operacoes_cadastro_encerrada before update on public.operacoes
  for each row execute function public.operacoes_cadastro_encerrada();

revoke execute on function public.bloquear_escrita_encerrada() from public, anon, authenticated;
revoke execute on function public.operacoes_cadastro_encerrada() from public, anon, authenticated;

notify pgrst, 'reload schema';
