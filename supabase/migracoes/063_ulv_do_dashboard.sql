-- =====================================================================
-- 063 · ULV da operação vem das vítimas (migração idempotente; exige a 062)
--
-- O estudo da operação mostra o ULV da primeira vítima que tem um (e a distância a partir dele).
-- Antes usava o local da operação, que não é o último local visto.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.estudo_operacao_dados(p_operacao uuid, p_nomes boolean)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_op public.operacoes%rowtype;
  v_loc record;
  v_vit json;
  v_ulv_lat double precision;
  v_ulv_lng double precision;
begin
  -- arquivamento (migração 055): números guardados quando a operação foi arquivada
  if public.operacao_arquivada(p_operacao) then
    return (select (case when p_nomes then a.instantaneos->'estudo_nomes' else a.instantaneos->'estudo' end)::json
              from public.operacao_arquivos a where a.operacao_id = p_operacao);
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  select v.condicao, v.lat, v.lng, coalesce(v.posicao_em, v.registrado_em) as em into v_loc
    from public.vitima_localizacoes v
   where v.operacao_id = p_operacao and v.lat is not null
   order by coalesce(v.posicao_em, v.registrado_em) limit 1;
  v_vit := public.estudo_vitimas(p_operacao, p_nomes);
  -- ULV da operação: o primeiro ULV cadastrado entre as vítimas (o ULV é da vítima, não do local da operação)
  select v.ulv_lat, v.ulv_lng into v_ulv_lat, v_ulv_lng from public.vitimas v
   where v.operacao_id = p_operacao and v.ulv_lat is not null order by v.criado_em, v.id limit 1;
  return json_build_object(
    'codigo', v_op.codigo, 'tipo', v_op.tipo, 'acionado_em', v_op.acionado_em, 'encerrada_em', v_op.encerrada_em,
    'ulv', case when v_ulv_lat is null then null else json_build_object('lat', v_ulv_lat, 'lng', v_ulv_lng) end,
    'localizacoes', (select count(*) from public.vitima_localizacoes v where v.operacao_id = p_operacao),
    -- primeira localização da operação (compatibilidade com telas antigas)
    'localizacao', case when v_loc.em is null then null else json_build_object(
        'condicao', v_loc.condicao,
        'em', v_loc.em,
        'minutos_ate', case when v_op.acionado_em is null then null else round(extract(epoch from v_loc.em - v_op.acionado_em) / 60) end,
        'distancia_km', case when v_ulv_lat is null then null
                             else round(public.distancia_km(v_ulv_lat, v_ulv_lng, v_loc.lat, v_loc.lng)::numeric, 2) end) end,
    'vitimas', v_vit,
    'vitimas_total', json_array_length(v_vit),
    'vitimas_localizadas', (select count(*) from json_array_elements(v_vit) e where (e->>'localizada')::boolean),
    'fichas', (select count(*) from public.vitimas t where t.operacao_id = p_operacao),
    'perfis', coalesce((select json_object_agg(x.perfil, x.n) from (
        select unnest(t.perfil) as perfil, count(*) as n from public.vitimas t where t.operacao_id = p_operacao group by 1) x), '{}'::json),
    'setores', (select count(*) from public.setores s where s.operacao_id = p_operacao),
    'registros_diario', (select count(*) from public.diario d where d.operacao_id = p_operacao)
  );
end;
$function$;

-- Relatórios de passagem e de comando gerados depois do arquivamento: as passagens estão no arquivo
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
  if p_tipo is null or p_tipo not in ('final', 'diario', 'passagem', 'comando', 'imprensa')
     or (p_tipo = 'diario' and (p_referencia is null or p_referencia !~ '^\d{4}-\d{2}-\d{2}$'))
     or (p_tipo = 'passagem' and not public.operacao_arquivada(p_operacao) and not exists (select 1 from public.passagens_comando pc where pc.operacao_id = p_operacao and pc.id::text = p_referencia))
     or (p_tipo = 'comando' and p_referencia is distinct from 'inicio' and not public.operacao_arquivada(p_operacao)
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
$function$;

-- Excluir operação arquivada: os arquivos do Storage saem pela pasta da operação (inclusive o próprio arquivo)
CREATE OR REPLACE FUNCTION public.excluir_operacao(p_operacao uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_codigo text;
  v_fotos integer;
  v_participantes integer;
  v_vitimas integer;
begin
  if not (public.eh_criador(p_operacao) or (public.eh_admin() and public.dono_operacao(p_operacao))) then
    raise exception 'sem_permissao';
  end if;
  select codigo into v_codigo from public.operacoes where id = p_operacao for update;
  if v_codigo is null then
    raise exception 'sem_permissao';
  end if;
  insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
  select caminho, 'relatorios', p_operacao, null from public.relatorios where operacao_id = p_operacao
  on conflict (caminho) do nothing;
  select count(*) into v_fotos from public.fotos where operacao_id = p_operacao;
  select count(*) into v_participantes from public.participantes where operacao_id = p_operacao and tipo <> 'responsavel';
  select count(*) into v_vitimas from public.vitimas where operacao_id = p_operacao;

  -- operação arquivada (migração 055): as linhas de fotos e do SCI estão no arquivo; os arquivos saem pela pasta da operação
  if public.operacao_arquivada(p_operacao) then
    insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
    select o.name, o.bucket_id, p_operacao, null from storage.objects o
     where o.bucket_id in ('fotos', 'sci', 'arquivos') and o.name like p_operacao::text || '/%'
    on conflict (caminho) do nothing;
  end if;
  perform set_config('gbs.excluindo_operacao', p_operacao::text, true);
  delete from public.operacoes where id = p_operacao;   -- apaga em cascata tudo o que é da operação
  perform set_config('gbs.excluindo_operacao', '', true);

  return json_build_object('operacao', v_codigo, 'fotos', v_fotos, 'participantes', v_participantes, 'vitimas', v_vitimas);
end;
$function$;

-- 7. Permissões --------------------------------------------------------------------------------------------------
revoke execute on function public.operacao_arquivada(uuid), public.arquivo_tabelas(), public.arquivo_filtro(text),
  public.dashboard_dados_vivo(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.pode_ler_arquivo_operacao(text), public.arquivo_pode_arquivar(uuid) from public, anon;
grant execute on function public.pode_ler_arquivo_operacao(text), public.arquivo_pode_arquivar(uuid) to authenticated;
revoke execute on function public.servidor_arquivo_candidatas(integer, integer), public.servidor_arquivo_preparar(uuid),
  public.servidor_arquivo_tabela(uuid, text, integer, integer),
  public.servidor_arquivo_confirmar(uuid, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.servidor_arquivo_candidatas(integer, integer), public.servidor_arquivo_preparar(uuid),
  public.servidor_arquivo_tabela(uuid, text, integer, integer),
  public.servidor_arquivo_confirmar(uuid, text, bigint, text, jsonb) to service_role;

-- =====================================================================
-- 056 — Mensagens dos bombeiros no aplicativo Android com a tela apagada.
--
--  O serviço do aplicativo (o mesmo que envia a localização, sem a página aberta) busca a cada sinal de vida as
--  mensagens ainda não confirmadas e mostra a notificação do Android (som e vibração, como um aplicativo de
--  mensagens). Autoriza pelo segredo do aparelho (migração 051), como app_enviar_posicoes e app_sinal_vida.
--
--   app_mensagens_pendentes(dispositivo, segredo) → [{ id, tipo, texto, remetente_nome, criada_em }]
--     - só mensagens dos bombeiros para este participante (direcao 'saida'), não confirmadas, das últimas 12 h;
--     - marca como entregues (entregue_em) as que ainda não tinham chegado ao aparelho, como marcar_entregues.
-- =====================================================================

create or replace function public.app_mensagens_pendentes(p_dispositivo uuid, p_segredo text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part uuid;
  v_lista json;
begin
  perform public.app_dono_do_dispositivo(p_dispositivo, p_segredo);
  select participante_id into v_part from public.app_dispositivos where id = p_dispositivo;
  select coalesce(json_agg(json_build_object('id', x.id, 'tipo', x.tipo, 'texto', x.texto, 'remetente_nome', x.remetente_nome,
                                             'criada_em', x.criada_em) order by x.criada_em), '[]'::json)
    into v_lista
    from (select m.id, m.tipo, m.texto, m.remetente_nome, m.criada_em
            from public.mensagens m
           where m.participante_id = v_part and m.direcao = 'saida' and m.confirmada_em is null
             and m.criada_em > now() - interval '12 hours'
           order by m.criada_em desc
           limit 20) x;
  -- chegou ao aparelho: o painel mostra "entregue" (operação encerrada recusa a escrita; a lista vai do mesmo jeito)
  begin
    update public.mensagens m
       set entregue_em = now()
     where m.participante_id = v_part and m.direcao = 'saida' and m.entregue_em is null
       and m.criada_em > now() - interval '12 hours';
  exception when others then null;
  end;
  return v_lista;
end;
$$;
