-- =====================================================================
-- 081_relatorio_resumido_ipo.sql — relatório resumido e IPO completo (só acréscimos; idempotente)
--
--  1. relatorios.tipo aceita 'resumido' (o relatório curto: mapa geral com setores, pessoas e fotos, números e o IPO).
--     Sem referência, como o final e o da imprensa. registrar_documento registra "Relatório resumido gerado" no diário.
--  2. O IPO (operacoes.ipo) passa a guardar também o efetivo e os desdobramentos de cada dia, os recursos, os órgãos de
--     apoio e os procedimentos. O limite do tamanho sobe de 30 mil para 200 mil caracteres (uma operação de vários dias
--     com um parágrafo por dia passava do limite antigo). Continua sendo um objeto JSON; nada mais muda.
-- =====================================================================

alter table public.relatorios drop constraint if exists relatorios_tipo_ok;
alter table public.relatorios add constraint relatorios_tipo_ok check (
  tipo in ('final', 'diario', 'passagem', 'comando', 'imprensa', 'resumido')
  and (tipo <> 'diario' or referencia ~ '^\d{4}-\d{2}-\d{2}$')
  and (tipo <> 'passagem' or referencia ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  and (tipo <> 'comando' or referencia = 'inicio' or referencia ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  and (tipo not in ('final', 'imprensa', 'resumido') or referencia is null));

CREATE OR REPLACE FUNCTION public.registrar_documento(p_operacao uuid, p_caminho text, p_paginas integer, p_bytes bigint, p_sha256 text, p_tipo text, p_referencia text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_nome text := public.nome_responsavel_atual();
  v public.relatorios%rowtype;
  v_titulo text;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if p_tipo is null or p_tipo not in ('final', 'diario', 'passagem', 'comando', 'imprensa', 'resumido')
     or (p_tipo = 'diario' and (p_referencia is null or p_referencia !~ '^\d{4}-\d{2}-\d{2}$'))
     or (p_tipo = 'passagem' and not public.operacao_arquivada(p_operacao) and not exists (select 1 from public.passagens_comando pc where pc.operacao_id = p_operacao and pc.id::text = p_referencia))
     or (p_tipo = 'comando' and p_referencia is distinct from 'inicio' and not public.operacao_arquivada(p_operacao)
         and not exists (select 1 from public.passagens_comando pc where pc.operacao_id = p_operacao and pc.id::text = p_referencia
                         and pc.estado in ('aceita', 'assumida')))
     or (p_tipo in ('final', 'imprensa', 'resumido') and p_referencia is not null) then
    raise exception 'dados_invalidos';
  end if;
  if p_caminho is null or p_caminho !~ ('^' || p_operacao::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$') then
    raise exception 'dados_invalidos';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'relatorios' and name = p_caminho) then
    raise exception 'arquivo_nao_enviado';
  end if;
  if p_tipo = 'diario' then
    select * into v from public.relatorios where operacao_id = p_operacao and tipo = 'diario' and referencia = p_referencia;
    if found then
      return row_to_json(v);
    end if;
  end if;
  if p_tipo = 'comando' then
    select * into v from public.relatorios where operacao_id = p_operacao and tipo = 'comando' and referencia = p_referencia;
    if found then
      return row_to_json(v);
    end if;
  end if;
  insert into public.relatorios (operacao_id, caminho, paginas, bytes, sha256, gerado_por, gerado_por_nome, tipo, referencia)
  values (p_operacao, p_caminho, p_paginas, p_bytes, lower(p_sha256), auth.uid(), v_nome, p_tipo, p_referencia)
  on conflict (caminho) do nothing
  returning * into v;
  if not found then
    select * into v from public.relatorios where caminho = p_caminho;
    return row_to_json(v);
  end if;
  if p_tipo = 'diario' then
    delete from public.relatorio_diario_reservas where operacao_id = p_operacao and dia = p_referencia::date;
  end if;
  v_titulo := case p_tipo
    when 'diario' then 'Relatório diário de ' || to_char(p_referencia::date, 'DD/MM/YYYY') || ' gerado'
    when 'passagem' then 'Relatório da passagem de comando gerado'
    when 'comando' then 'Relatório do comando gerado'
    when 'imprensa' then 'Relatório para imprensa gerado'
    when 'resumido' then 'Relatório resumido gerado'
    else 'Relatório final gerado' end;
  perform public.diario_auto(p_operacao, v.gerado_em, 'documento', case p_tipo when 'final' then 'relatorio_gerado' else 'relatorio_' || p_tipo end, v_titulo,
    coalesce(p_paginas || ' página(s)', ''), 'relatorio:' || v.id, 'info', null, null, v.id::text, v_nome);
  return row_to_json(v);
end;
$function$;

revoke execute on function public.registrar_documento(uuid, text, integer, bigint, text, text, text) from public, anon;
grant execute on function public.registrar_documento(uuid, text, integer, bigint, text, text, text) to authenticated;

create or replace function public.ipo_validar(p_ipo jsonb)
returns jsonb
language plpgsql immutable set search_path = public
as $$
begin
  p_ipo := coalesce(p_ipo, '{}'::jsonb);
  if jsonb_typeof(p_ipo) <> 'object' or length(p_ipo::text) > 200000 then
    raise exception 'dados_invalidos';
  end if;
  return p_ipo;
end;
$$;

create or replace function public.salvar_ipo_operacao(p_operacao uuid, p_ipo jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_op public.operacoes%rowtype;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao for update;
  if not found then
    raise exception 'sem_permissao';
  end if;
  p_ipo := public.ipo_validar(p_ipo);
  update public.operacoes
     set ipo = p_ipo, atualizado_em = now(), atualizado_por_nome = v_nome
   where id = p_operacao
  returning * into v_op;
  return json_build_object('id', v_op.id, 'ipo', v_op.ipo, 'atualizado_em', v_op.atualizado_em);
end;
$$;
revoke execute on function public.salvar_ipo_operacao(uuid, jsonb) from public, anon;
grant execute on function public.salvar_ipo_operacao(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
