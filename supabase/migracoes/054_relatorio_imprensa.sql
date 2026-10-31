-- =====================================================================
-- 054 — Relatório para imprensa: dados reduzidos (sem nomes, documentos, fotos, trilhas nem posições).
--
--  relatorios.tipo passa a aceitar 'imprensa' (sem referência: cada geração é um documento guardado).
--  registrar_documento aceita 'imprensa' e registra no diário "Relatório para imprensa gerado".
-- =====================================================================

alter table public.relatorios drop constraint if exists relatorios_tipo_ok;
alter table public.relatorios add constraint relatorios_tipo_ok check (
  tipo in ('final', 'diario', 'passagem', 'comando', 'imprensa')
  and (tipo <> 'diario' or referencia ~ '^\d{4}-\d{2}-\d{2}$')
  and (tipo <> 'passagem' or referencia ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  and (tipo <> 'comando' or referencia = 'inicio' or referencia ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  and (tipo not in ('final', 'imprensa') or referencia is null));

create or replace function public.registrar_documento(p_operacao uuid, p_caminho text, p_paginas integer, p_bytes bigint, p_sha256 text,
                                                     p_tipo text, p_referencia text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v public.relatorios%rowtype;
  v_titulo text;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if p_tipo is null or p_tipo not in ('final', 'diario', 'passagem', 'comando', 'imprensa')
     or (p_tipo = 'diario' and (p_referencia is null or p_referencia !~ '^\d{4}-\d{2}-\d{2}$'))
     or (p_tipo = 'passagem' and not exists (select 1 from public.passagens_comando pc where pc.operacao_id = p_operacao and pc.id::text = p_referencia))
     or (p_tipo = 'comando' and p_referencia is distinct from 'inicio'
         and not exists (select 1 from public.passagens_comando pc where pc.operacao_id = p_operacao and pc.id::text = p_referencia
                         and pc.estado in ('aceita', 'assumida')))
     or (p_tipo in ('final', 'imprensa') and p_referencia is not null) then
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
    else 'Relatório final gerado' end;
  perform public.diario_auto(p_operacao, v.gerado_em, 'documento', case p_tipo when 'final' then 'relatorio_gerado' else 'relatorio_' || p_tipo end, v_titulo,
    coalesce(p_paginas || ' página(s)', ''), 'relatorio:' || v.id, 'info', null, null, v.id::text, v_nome);
  return row_to_json(v);
end;
$$;

revoke execute on function public.registrar_documento(uuid, text, integer, bigint, text, text, text) from public, anon;
grant execute on function public.registrar_documento(uuid, text, integer, bigint, text, text, text) to authenticated;

notify pgrst, 'reload schema';
