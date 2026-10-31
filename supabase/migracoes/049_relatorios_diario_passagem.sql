-- =====================================================================
-- 049 — Relatório diário da operação (gerado e guardado sozinho) e relatório da passagem de comando.
--
--  relatorios.tipo: 'final' (como antes), 'diario' (um por dia da operação; referencia = 'AAAA-MM-DD') ou
--  'passagem' (referencia = id da passagem de comando). Os PDFs continuam no bucket privado "relatorios".
--  relatorio_diario_reservar(operação, dia): o painel aberto pede a vez antes de gerar o diário de um dia; com dois
--  responsáveis de painel aberto, só um gera (a reserva vale 15 min). Dia já com relatório: não reserva.
--  registrar_documento(...): grava o PDF de qualquer tipo (registrar_relatorio continua para o final).
-- =====================================================================

alter table public.relatorios add column if not exists tipo text not null default 'final';
alter table public.relatorios add column if not exists referencia text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'relatorios_tipo_ok') then
    alter table public.relatorios add constraint relatorios_tipo_ok check (
      tipo in ('final', 'diario', 'passagem')
      and (tipo <> 'diario' or referencia ~ '^\d{4}-\d{2}-\d{2}$')
      and (tipo <> 'passagem' or referencia ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      and (tipo <> 'final' or referencia is null));
  end if;
end $$;
create unique index if not exists relatorios_diario_uk on public.relatorios (operacao_id, referencia) where tipo = 'diario';

create table if not exists public.relatorio_diario_reservas (
  operacao_id     uuid not null references public.operacoes(id) on delete cascade,
  dia             date not null,
  reservado_por   uuid,
  reservado_em    timestamptz not null default now(),
  primary key (operacao_id, dia)
);
alter table public.relatorio_diario_reservas enable row level security;
revoke all on public.relatorio_diario_reservas from anon, authenticated;

-- Pede a vez para gerar o relatório diário de um dia já terminado (ou de hoje, perto da meia-noite).
-- Devolve { ok: true } quando este painel deve gerar; { ok: false, motivo } quando não.
create or replace function public.relatorio_diario_reservar(p_operacao uuid, p_dia date)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_op public.operacoes%rowtype;
  v_res public.relatorio_diario_reservas%rowtype;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if p_dia is null or p_dia > current_date + 1 or p_dia < (coalesce(v_op.acionado_em, v_op.criada_em))::date - 1 then
    raise exception 'dados_invalidos';
  end if;
  if exists (select 1 from public.relatorios where operacao_id = p_operacao and tipo = 'diario' and referencia = to_char(p_dia, 'YYYY-MM-DD')) then
    return json_build_object('ok', false, 'motivo', 'ja_existe');
  end if;
  select * into v_res from public.relatorio_diario_reservas where operacao_id = p_operacao and dia = p_dia for update;
  if found and v_res.reservado_em > now() - interval '15 minutes' and v_res.reservado_por is distinct from auth.uid() then
    return json_build_object('ok', false, 'motivo', 'outro_gerando');
  end if;
  insert into public.relatorio_diario_reservas (operacao_id, dia, reservado_por, reservado_em)
  values (p_operacao, p_dia, auth.uid(), now())
  on conflict (operacao_id, dia) do update set reservado_por = excluded.reservado_por, reservado_em = excluded.reservado_em;
  return json_build_object('ok', true);
end;
$$;

-- Registra um PDF já enviado ao bucket (qualquer tipo). Diário repetido no mesmo dia: devolve o que já existe.
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
  if p_tipo is null or p_tipo not in ('final', 'diario', 'passagem')
     or (p_tipo = 'diario' and (p_referencia is null or p_referencia !~ '^\d{4}-\d{2}-\d{2}$'))
     or (p_tipo = 'passagem' and not exists (select 1 from public.passagens_comando pc where pc.operacao_id = p_operacao and pc.id::text = p_referencia))
     or (p_tipo = 'final' and p_referencia is not null) then
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
    else 'Relatório final gerado' end;
  perform public.diario_auto(p_operacao, v.gerado_em, 'documento', case p_tipo when 'final' then 'relatorio_gerado' else 'relatorio_' || p_tipo end, v_titulo,
    coalesce(p_paginas || ' página(s)', ''), 'relatorio:' || v.id, 'info', null, null, v.id::text, v_nome);
  return row_to_json(v);
end;
$$;

revoke execute on function public.relatorio_diario_reservar(uuid, date) from public, anon;
grant execute on function public.relatorio_diario_reservar(uuid, date) to authenticated;
revoke execute on function public.registrar_documento(uuid, text, integer, bigint, text, text, text) from public, anon;
grant execute on function public.registrar_documento(uuid, text, integer, bigint, text, text, text) to authenticated;

notify pgrst, 'reload schema';
