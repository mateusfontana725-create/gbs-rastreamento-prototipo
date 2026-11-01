-- =====================================================================
-- 057 — SCI que cresce com a ocorrência (organograma expansível), materiais e aquisições.
--
--  O que muda
--   - sci_estado.estrutura: { inicio, ponto, ativas: { "<id>": { desde, nome, user_id } } }. A operação começa só com o
--     Comandante do Incidente (com Operações); cada função do SCI é ativada quando precisa e o que não está ativado
--     fica com o CI. Catálogo (o mesmo de public/js/sci-org.js): staff (seg, lig, inf), seções (ops, plan, log, adm) e
--     unidades (ops.espera, ops.acv, plan.*, log.serv/log.apoio e as unidades de cada setor, adm.*).
--   - sci_salvar_estrutura(operacao, dados): ponto de partida (pequena, média, grande: só ativa o que falta) e mudanças
--     [{ id, ativa?, nome?, user_id? }]. Unidade só com o pai ativo; desativar leva as unidades abaixo; Operações não
--     desativa. user_id liga a função à conta de um responsável da operação ("minha função" no Comando). Cada mudança
--     vai para a linha do tempo do SCI como decisão do Comando (e para o diário).
--   - sci_estado.funcoes (usado no resumo, imprensa, relatórios e na IA do SCI) acompanha a estrutura: as duas formas de
--     editar ficam iguais (o gatilho espelha funcoes → estrutura quando só funcoes muda).
--   - sci_itens ganha "material" (total, em uso, onde está, situação) e "aquisicao" (item, fornecedor, valor, situação).
-- =====================================================================

-- 1. Estrutura no estado do SCI --------------------------------------------------------------------------------
alter table public.sci_estado add column if not exists estrutura jsonb not null default '{}'::jsonb;
alter table public.sci_estado drop constraint if exists sci_estado_estrutura_check;
alter table public.sci_estado add constraint sci_estado_estrutura_check check (jsonb_typeof(estrutura) = 'object' and length(estrutura::text) <= 30000);

-- Catálogo: id → { nome, titulo, pai, funcao (chave em sci_estado.funcoes), fixa }. null = id desconhecido.
create or replace function public.sci_estrutura_funcao(p_id text)
returns jsonb
language sql immutable set search_path = public
as $$
  select jsonb_build_object('nome', x.nome, 'titulo', x.titulo, 'pai', x.pai, 'funcao', x.funcao, 'fixa', x.fixa)
    from (values
      ('seg', 'Oficial de Segurança', 'Oficial', null, 'seguranca', false),
      ('lig', 'Oficial de Ligação', 'Oficial', null, 'ligacao', false),
      ('inf', 'Oficial de Informação Pública', 'Oficial', null, 'informacao_publica', false),
      ('ops', 'Operações', 'Chefe da Seção', null, 'operacoes', true),
      ('ops.espera', 'Área de Espera', 'Encarregado', 'ops', null, false),
      ('ops.acv', 'ACV – Área de Concentração de Vítimas', 'Encarregado', 'ops', null, false),
      ('plan', 'Planejamento', 'Chefe da Seção', null, 'planejamento', false),
      ('plan.rec', 'Unidade de Recursos', 'Líder', 'plan', null, false),
      ('plan.sit', 'Unidade de Situação', 'Líder', 'plan', null, false),
      ('plan.doc', 'Unidade de Documentação', 'Líder', 'plan', null, false),
      ('plan.desm', 'Unidade de Desmobilização', 'Líder', 'plan', null, false),
      ('plan.ma', 'Unidade de Meio Ambiente', 'Líder', 'plan', null, false),
      ('plan.esp', 'Especialistas', 'Líder', 'plan', null, false),
      ('log', 'Logística', 'Chefe da Seção', null, 'logistica', false),
      ('log.serv', 'Setor de Serviços', 'Coordenador', 'log', null, false),
      ('log.com', 'Unidade de Comunicações', 'Líder', 'log.serv', null, false),
      ('log.med', 'Unidade Médica', 'Líder', 'log.serv', null, false),
      ('log.ali', 'Unidade de Alimentação', 'Líder', 'log.serv', null, false),
      ('log.apoio', 'Setor de Apoio', 'Coordenador', 'log', null, false),
      ('log.sup', 'Unidade de Suprimentos', 'Líder', 'log.apoio', null, false),
      ('log.inst', 'Unidade de Instalações', 'Líder', 'log.apoio', null, false),
      ('log.ter', 'Unidade de Suporte Terrestre', 'Líder', 'log.apoio', null, false),
      ('adm', 'Administração e Finanças', 'Chefe da Seção', null, 'adm_financas', false),
      ('adm.tempo', 'Unidade de Tempo', 'Líder', 'adm', null, false),
      ('adm.prov', 'Unidade de Provedoria', 'Líder', 'adm', null, false),
      ('adm.cus', 'Unidade de Custos', 'Líder', 'adm', null, false)
    ) as x(id, nome, titulo, pai, funcao, fixa)
   where x.id = p_id;
$$;

-- Pontos de partida (os mesmos de sci-org.js), em ordem de pai para filho.
create or replace function public.sci_estrutura_ponto(p_ponto text)
returns text[]
language sql immutable set search_path = public
as $$
  select case p_ponto
    when 'pequena' then array[]::text[]
    when 'media' then array['seg', 'ops.espera', 'ops.acv', 'plan', 'plan.rec', 'plan.sit', 'log', 'log.apoio', 'log.sup']
    when 'grande' then array['seg', 'lig', 'inf', 'ops.espera', 'ops.acv', 'plan', 'plan.rec', 'plan.sit', 'plan.doc', 'plan.desm',
                             'log', 'log.serv', 'log.com', 'log.med', 'log.ali', 'log.apoio', 'log.sup', 'log.inst', 'log.ter',
                             'adm', 'adm.tempo', 'adm.prov', 'adm.cus']
    else null end;
$$;

-- Ativa na estrutura? (Operações é sempre ativa.)
create or replace function public.sci_estrutura_ativa(p_estrutura jsonb, p_id text)
returns boolean
language sql immutable set search_path = public
as $$
  select coalesce((public.sci_estrutura_funcao(p_id)->>'fixa')::boolean, false) or coalesce(p_estrutura->'ativas' ? p_id, false);
$$;

-- Unidades abaixo de um id (setores e as unidades dos setores).
create or replace function public.sci_estrutura_descendentes(p_id text)
returns text[]
language sql immutable set search_path = public
as $$
  with recursive arvore(id) as (
    select c from unnest(array['seg', 'lig', 'inf', 'ops', 'ops.espera', 'ops.acv', 'plan', 'plan.rec', 'plan.sit', 'plan.doc', 'plan.desm', 'plan.ma',
                               'plan.esp', 'log', 'log.serv', 'log.com', 'log.med', 'log.ali', 'log.apoio', 'log.sup', 'log.inst', 'log.ter',
                               'adm', 'adm.tempo', 'adm.prov', 'adm.cus']) c
     where public.sci_estrutura_funcao(c)->>'pai' = p_id
    union all
    select c from arvore a, unnest(array['log.com', 'log.med', 'log.ali', 'log.sup', 'log.inst', 'log.ter']) c
     where public.sci_estrutura_funcao(c)->>'pai' = a.id
  )
  select coalesce(array_agg(id), array[]::text[]) from arvore;
$$;

-- funcoes (formato antigo) a partir da estrutura: staff e seções; não ativada = acumulada pelo CI.
create or replace function public.sci_funcoes_da_estrutura(p_funcoes jsonb, p_estrutura jsonb)
returns jsonb
language plpgsql immutable set search_path = public
as $$
declare
  r jsonb := coalesce(p_funcoes, '{}'::jsonb);
  k text;
  f jsonb;
  v_nome text;
begin
  foreach k in array array['seg', 'lig', 'inf', 'ops', 'plan', 'log', 'adm'] loop
    f := public.sci_estrutura_funcao(k);
    v_nome := coalesce(p_estrutura->'ativas'->k->>'nome', '');
    r := r || jsonb_build_object(f->>'funcao', jsonb_build_object('nome', case when public.sci_estrutura_ativa(p_estrutura, k) then v_nome else '' end,
      'acumula_ci', not public.sci_estrutura_ativa(p_estrutura, k) or (k = 'ops' and v_nome = '')));
  end loop;
  return r;
end;
$$;

-- 2. Salvar a estrutura ------------------------------------------------------------------------------------------
create or replace function public.sci_salvar_estrutura(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_resp text := public.sci_conferir(p_operacao);
  s public.sci_estado%rowtype;
  e jsonb;
  a jsonb;
  m jsonb;
  f jsonb;
  v_id text;
  v_ids text[];
  v_desc text[];
  v_nome text;
  v_ant text;
  v_user uuid;
  v_ponto text;
  v_qtd integer := 0;
  v_ativadas text[] := array[]::text[];
begin
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' or (p_dados ? 'mudancas' and jsonb_typeof(p_dados->'mudancas') <> 'array')
     or jsonb_array_length(coalesce(p_dados->'mudancas', '[]'::jsonb)) > 60 then
    raise exception 'dados_invalidos';
  end if;
  select * into s from public.sci_estado where operacao_id = p_operacao for update;
  e := coalesce(s.estrutura, '{}'::jsonb);
  a := coalesce(e->'ativas', '{}'::jsonb);

  -- ponto de partida: ativa o que falta (o que já está ativo fica como está)
  if p_dados ? 'ponto' then
    v_ponto := p_dados->>'ponto';
    v_ids := public.sci_estrutura_ponto(v_ponto);
    if v_ids is null then
      raise exception 'dados_invalidos';
    end if;
    foreach v_id in array v_ids loop
      if not public.sci_estrutura_ativa(jsonb_build_object('ativas', a), v_id) then
        a := a || jsonb_build_object(v_id, jsonb_build_object('desde', now()));
        v_ativadas := v_ativadas || (public.sci_estrutura_funcao(v_id)->>'nome');
      end if;
    end loop;
    e := e || jsonb_build_object('ponto', v_ponto);
    perform public.sci_evento_interno(p_operacao, now(), 'decisao',
      'Estrutura do SCI: ponto de partida ' || case v_ponto when 'pequena' then 'Pequena' when 'media' then 'Média' else 'Grande' end
        || case when cardinality(v_ativadas) > 0 then ' — ativadas: ' || array_to_string(v_ativadas, ', ') else ' (só o CI, com Operações)' end,
      false, 'automatico', 'estrutura:ponto');
  end if;

  for m in select * from jsonb_array_elements(coalesce(p_dados->'mudancas', '[]'::jsonb)) loop
    if jsonb_typeof(m) <> 'object' then
      raise exception 'dados_invalidos';
    end if;
    v_id := m->>'id';
    f := public.sci_estrutura_funcao(v_id);
    if f is null then
      raise exception 'funcao_sci_invalida';
    end if;

    if m ? 'ativa' then
      if jsonb_typeof(m->'ativa') <> 'boolean' then
        raise exception 'dados_invalidos';
      end if;
      if (m->>'ativa')::boolean then
        if not public.sci_estrutura_ativa(jsonb_build_object('ativas', a), v_id) then
          if f->>'pai' is not null and not public.sci_estrutura_ativa(jsonb_build_object('ativas', a), f->>'pai') then
            raise exception 'funcao_sci_sem_pai';
          end if;
          a := a || jsonb_build_object(v_id, jsonb_build_object('desde', now()));
          perform public.sci_evento_interno(p_operacao, now(), 'decisao', 'Ativada: ' || (f->>'nome'), false, 'automatico', 'estrutura:' || v_id);
        end if;
      else
        if (f->>'fixa')::boolean then
          raise exception 'dados_invalidos';   -- Operações não desativa (sem chefe, fica com o CI)
        end if;
        if a ? v_id then
          v_desc := array(select d from unnest(public.sci_estrutura_descendentes(v_id)) d where a ? d);
          a := a - v_id;
          if cardinality(v_desc) > 0 then a := a - v_desc; end if;
          perform public.sci_evento_interno(p_operacao, now(), 'decisao',
            'Desativada: ' || (f->>'nome') || case when cardinality(v_desc) > 0 then ' (e suas unidades)' else '' end || ' — volta ao CI',
            false, 'automatico', 'estrutura:' || v_id);
        end if;
      end if;
    end if;

    if m ? 'nome' or m ? 'user_id' then
      if not public.sci_estrutura_ativa(jsonb_build_object('ativas', a), v_id) then
        raise exception 'funcao_sci_invalida';   -- só se designa quem responde por uma função ativa
      end if;
      if not (a ? v_id) then
        a := a || jsonb_build_object(v_id, jsonb_build_object('desde', now()));   -- Operações (fixa) ganha a entrada ao designar
      end if;
    end if;
    if m ? 'nome' then
      v_nome := left(btrim(regexp_replace(coalesce(m->>'nome', ''), '\s+', ' ', 'g')), 80);
      v_ant := coalesce(a->v_id->>'nome', '');
      if v_nome is distinct from v_ant then
        a := jsonb_set(a, array[v_id, 'nome'], to_jsonb(v_nome));
        perform public.sci_evento_interno(p_operacao, now(), 'decisao',
          (f->>'titulo') || ' — ' || (f->>'nome') || ': '
            || case when v_nome = '' then 'sem responsável ([PENDENTE])' when v_ant = '' then 'designado ' || v_nome else v_ant || ' substituído por ' || v_nome end,
          false, 'automatico', 'estrutura:' || v_id);
      end if;
    end if;
    if m ? 'user_id' then
      if coalesce(jsonb_typeof(m->'user_id'), 'null') = 'null' or m->>'user_id' = '' then
        a := jsonb_set(a, array[v_id], (a->v_id) - 'user_id');
      else
        begin
          v_user := (m->>'user_id')::uuid;
        exception when others then
          raise exception 'dados_invalidos';
        end;
        if not exists (select 1 from public.operacoes o where o.id = p_operacao and o.responsavel_id = v_user)
           and not exists (select 1 from public.operacao_responsaveis r where r.operacao_id = p_operacao and r.user_id = v_user) then
          raise exception 'responsavel_fora_da_operacao';
        end if;
        a := jsonb_set(a, array[v_id, 'user_id'], to_jsonb(v_user::text));
      end if;
    end if;
    v_qtd := v_qtd + 1;
  end loop;

  e := e || jsonb_build_object('ativas', a, 'inicio', coalesce(e->'inicio', to_jsonb(now())));
  update public.sci_estado
     set estrutura = e, funcoes = public.sci_funcoes_da_estrutura(funcoes, e),
         atualizado_em = now(), atualizado_por_nome = v_resp
   where operacao_id = p_operacao
  returning * into s;
  return row_to_json(s);
end;
$$;

revoke execute on function public.sci_salvar_estrutura(uuid, jsonb) from public, anon;
grant execute on function public.sci_salvar_estrutura(uuid, jsonb) to authenticated;

-- 3. funcoes editadas pelo jeito antigo (Funções SCI, IA do SCI) → estrutura ------------------------------------------
create or replace function public.sci_estado_espelhar_funcoes()
returns trigger
language plpgsql set search_path = public
as $$
declare
  e jsonb := coalesce(new.estrutura, '{}'::jsonb);
  a jsonb := coalesce(new.estrutura->'ativas', '{}'::jsonb);
  k text;
  v_chave text;
  v_nova jsonb;
  v_velha jsonb;
  v_desc text[];
begin
  if new.funcoes is not distinct from old.funcoes or new.estrutura is distinct from old.estrutura then
    return new;
  end if;
  foreach k in array array['seg', 'lig', 'inf', 'ops', 'plan', 'log', 'adm'] loop
    v_chave := public.sci_estrutura_funcao(k)->>'funcao';
    v_nova := new.funcoes->v_chave;
    v_velha := old.funcoes->v_chave;
    continue when v_nova is null or v_nova is not distinct from v_velha;
    if coalesce((v_nova->>'acumula_ci')::boolean, false) then
      if k = 'ops' then
        if a ? k then a := jsonb_set(a, array[k, 'nome'], '""'::jsonb); end if;
      elsif a ? k then
        v_desc := array(select d from unnest(public.sci_estrutura_descendentes(k)) d where a ? d);
        a := a - k;
        if cardinality(v_desc) > 0 then a := a - v_desc; end if;
      end if;
    else
      a := a || jsonb_build_object(k, coalesce(a->k, jsonb_build_object('desde', now())) || jsonb_build_object('nome', coalesce(v_nova->>'nome', '')));
    end if;
  end loop;
  new.estrutura := e || jsonb_build_object('ativas', a, 'inicio', coalesce(e->'inicio', to_jsonb(now())));
  return new;
end;
$$;
drop trigger if exists sci_estado_espelhar_funcoes on public.sci_estado;
create trigger sci_estado_espelhar_funcoes before update on public.sci_estado
  for each row execute function public.sci_estado_espelhar_funcoes();

-- 4. Materiais e aquisições ------------------------------------------------------------------------------------------
alter table public.sci_itens drop constraint if exists sci_itens_tipo_check;
alter table public.sci_itens add constraint sci_itens_tipo_check
  check (tipo in ('instalacao', 'equipe', 'orgao', 'recurso', 'canal', 'leitura_rio', 'imagem', 'material', 'aquisicao'));

create or replace function public.sci_limpar_item(p_tipo text, p_dados jsonb)
returns jsonb
language plpgsql stable set search_path = public
as $$
declare
  v_txt text[];
  v_int text[] := '{}';
  v_num text[] := '{}';
  v_ts text[] := '{}';
  v_enum jsonb := '{}'::jsonb;
  v_obrig text;
  r jsonb := '{}'::jsonb;
  k text;
  v jsonb;
  t text;
begin
  if p_dados is null or jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  if p_tipo = 'instalacao' then
    v_txt := array['nome', 'responsavel', 'local', 'motivo', 'nota', 'ponto_id']; v_num := array['lat', 'lng']; v_ts := array['ativada_em', 'desativada_em'];
    v_enum := '{"tipo": ["pc", "area_espera", "acv", "zpa", "abrigo", "ggi", "outra"], "estado": ["ativa", "planejada", "desativada"]}';
    v_obrig := 'nome';
  elsif p_tipo = 'equipe' then
    v_txt := array['nome', 'orgao', 'missao', 'funcao', 'setor', 'chefe', 'meios', 'notas', 'setor_id', 'grupo_id']; v_int := array['efetivo'];
    v_enum := '{"status": ["designada", "em_deslocamento", "em_operacao", "disponivel", "desmobilizada"]}';
    v_obrig := 'nome';
  elsif p_tipo = 'orgao' then
    v_txt := array['nome', 'detalhe', 'missao', 'nota']; v_int := array['pessoas', 'viaturas']; v_ts := array['acionado_em', 'chegada_em'];
    v_enum := '{"situacao": ["acionado", "a_caminho", "no_local", "desmobilizado"]}';
    v_obrig := 'nome';
  elsif p_tipo = 'recurso' then
    v_txt := array['nome', 'orgao', 'local', 'nota']; v_int := array['qtd']; v_ts := array['solicitado_em', 'chegada_em'];
    v_enum := '{"tipo": ["viatura", "embarcacao", "aeronave", "equipamento", "outro"], "status": ["solicitado", "a_caminho", "no_local", "em_uso", "indisponivel", "desmobilizado"]}';
    v_obrig := 'nome';
  elsif p_tipo = 'canal' then
    v_txt := array['nome', 'funcao', 'usuarios'];
    v_obrig := 'nome';
  elsif p_tipo = 'leitura_rio' then
    v_txt := array['ponto', 'nivel', 'vazao', 'fonte']; v_ts := array['em'];
    v_enum := '{"tendencia": ["subindo", "estavel", "descendo", "a_confirmar"]}';
    v_obrig := 'em';
  elsif p_tipo = 'imagem' then
    v_txt := array['caminho', 'legenda'];
    v_obrig := 'caminho';
  elsif p_tipo = 'material' then
    -- relação de materiais da Logística: total, em uso (o disponível é a diferença), onde está e situação
    v_txt := array['nome', 'categoria', 'local', 'nota']; v_int := array['total', 'em_uso'];
    v_enum := '{"situacao": ["ok", "atencao", "em_falta"]}';
    v_obrig := 'nome';
  elsif p_tipo = 'aquisicao' then
    -- aquisições e contratos emergenciais (Adm. e Finanças): valor em reais
    v_txt := array['item', 'fornecedor', 'solicitante', 'numero', 'nota']; v_num := array['valor']; v_ts := array['pedido_em'];
    v_enum := '{"status": ["em_cotacao", "confirmado", "cedido", "entregue", "cancelado"]}';
    v_obrig := 'item';
  else
    raise exception 'dados_invalidos';
  end if;
  for k, v in select * from jsonb_each(p_dados) loop
    if coalesce(jsonb_typeof(v), 'null') = 'null' then
      continue;
    elsif k = any(v_txt) then
      t := btrim(regexp_replace(v #>> '{}', '\s+', ' ', 'g'));
      if k in ('notas', 'nota', 'detalhe', 'missao', 'motivo') then t := left(btrim(v #>> '{}'), 1000); else t := left(t, 200); end if;
      if t <> '' then r := r || jsonb_build_object(k, t); end if;
    elsif k = any(v_int) then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 100000 or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) then
        raise exception 'dados_invalidos';
      end if;
      r := r || jsonb_build_object(k, (v #>> '{}')::integer);
    elsif k = any(v_num) then
      if jsonb_typeof(v) <> 'number' or (k = 'lat' and abs((v #>> '{}')::numeric) > 90) or (k = 'lng' and abs((v #>> '{}')::numeric) > 180) then
        raise exception 'posicao_invalida';
      end if;
      if k = 'valor' and ((v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 1000000000) then
        raise exception 'dados_invalidos';
      end if;
      r := r || jsonb_build_object(k, case when k = 'valor' then to_jsonb(round((v #>> '{}')::numeric, 2)) else v end);
    elsif k = any(v_ts) then
      begin
        r := r || jsonb_build_object(k, (v #>> '{}')::timestamptz);
      exception when others then
        raise exception 'data_invalida';
      end;
    elsif v_enum ? k then
      if not ((v_enum->k) ? (v #>> '{}')) then
        raise exception 'dados_invalidos';
      end if;
      r := r || jsonb_build_object(k, v #>> '{}');
    end if;
  end loop;
  if (r ? 'lat') <> (r ? 'lng') then
    raise exception 'posicao_invalida';
  end if;
  if p_tipo = 'material' and r ? 'total' and r ? 'em_uso' and (r->>'em_uso')::integer > (r->>'total')::integer then
    raise exception 'material_em_uso_maior';
  end if;
  if not (r ? v_obrig) then
    raise exception 'dados_invalidos';
  end if;
  return r;
end;
$$;

notify pgrst, 'reload schema';
