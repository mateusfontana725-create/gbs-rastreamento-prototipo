-- =====================================================================
-- 084_tirar_do_mapa.sql — tirar a localização de uma pessoa do mapa (só acréscimos; idempotente)
--
--  Quem entra na operação de longe (para acompanhar ou testar) deixava um ponto distante no mapa. O responsável pode
--  TIRAR A PESSOA DO MAPA: a localização, a trilha e o agrupamento dela somem do painel, do link público e do mapa dos
--  colegas. NADA é apagado: as posições continuam guardadas (relatórios e arquivo) e o responsável pode MOSTRAR de novo.
--  A pessoa volta sozinha ao mapa quando ENTRA DE NOVO na operação (ingressar). Responsáveis também podem ser tirados.
--
--    participantes.fora_do_mapa_em / fora_do_mapa_por_nome   quando e por quem (nulo = aparece no mapa)
--    tirar_do_mapa(p_participante, p_fora)                   p_fora = true tira, false mostra de novo (registra no diário)
--
--  Ajusta (sem reescrever) ingressar, comando_publico, comando_publico_posicoes e trilhas_da_equipe.
-- =====================================================================

alter table public.participantes add column if not exists fora_do_mapa_em timestamptz;
alter table public.participantes add column if not exists fora_do_mapa_por_nome text;

create or replace function public.tirar_do_mapa(p_participante uuid, p_fora boolean default true)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_part public.participantes%rowtype;
  v_status text;
  v_estava boolean;
begin
  select * into v_part from public.participantes where id = p_participante for update;
  if not found or v_nome is null or not public.dono_operacao(v_part.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  v_estava := v_part.fora_do_mapa_em is not null;
  if coalesce(p_fora, true) = v_estava then
    return row_to_json(v_part);   -- já estava assim: nada a fazer
  end if;
  update public.participantes
     set fora_do_mapa_em = case when coalesce(p_fora, true) then now() else null end,
         fora_do_mapa_por_nome = case when coalesce(p_fora, true) then v_nome else null end
   where id = p_participante
  returning * into v_part;
  perform public.diario_auto(v_part.operacao_id, now(), 'pessoa',
    case when coalesce(p_fora, true) then 'pessoa_fora_do_mapa' else 'pessoa_no_mapa' end,
    case when coalesce(p_fora, true) then 'Localização retirada do mapa' else 'Localização de volta ao mapa' end,
    v_part.nome, case when coalesce(p_fora, true) then 'fora_do_mapa:' else 'no_mapa:' end || v_part.id || ':' || (extract(epoch from clock_timestamp()) * 1000)::bigint, 'info', null, null, v_part.id::text, v_nome);
  return row_to_json(v_part);
end;
$$;
revoke execute on function public.tirar_do_mapa(uuid, boolean) from public, anon;
grant execute on function public.tirar_do_mapa(uuid, boolean) to authenticated;

-- Ajustes nas funções existentes, trocando só o trecho necessário (a falha é alta: se o texto não for achado, a migração
-- para). Já ajustada = pula.
do $$
declare
  r record;
  v_def text;
begin
  for r in select * from (values
    ('public.ingressar(text,text,text,text,text)',
     'telefone = coalesce(v_tel, telefone)',
     'telefone = coalesce(v_tel, telefone), fora_do_mapa_em = null, fora_do_mapa_por_nome = null'),
    ('public.trilhas_da_equipe(uuid)',
     'o.id <> v_part.id and o.tipo in (''civil'', ''militar'')',
     'o.id <> v_part.id and o.fora_do_mapa_em is null and o.tipo in (''civil'', ''militar'')'),
    ('public.comando_publico(text,bigint)',
     'from public.participantes x where x.operacao_id = v_op.id) p;',
     E'from public.participantes x where x.operacao_id = v_op.id) p\n   where p.fora_do_mapa_em is null;'),
    ('public.comando_publico(text,bigint)',
     'from public.posicoes where operacao_id = v_op.id',
     'from public.posicoes where operacao_id = v_op.id and participante_id not in (select h.id from public.participantes h where h.operacao_id = v_op.id and h.fora_do_mapa_em is not null)'),
    ('public.comando_publico_posicoes(text,bigint,integer)',
     'from public.posicoes where operacao_id = v_op and id > coalesce(p_depois_de, 0)',
     'from public.posicoes where operacao_id = v_op and participante_id not in (select h.id from public.participantes h where h.operacao_id = v_op and h.fora_do_mapa_em is not null) and id > coalesce(p_depois_de, 0)')
  ) as t(funcao, antigo, novo)
  loop
    v_def := pg_get_functiondef(r.funcao::regprocedure);
    if position(r.novo in v_def) > 0 then
      continue;   -- já ajustada
    end if;
    if position(r.antigo in v_def) = 0 then
      raise exception 'migração 084: trecho não encontrado em % (%)', r.funcao, r.antigo;
    end if;
    execute replace(v_def, r.antigo, r.novo);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
