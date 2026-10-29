-- =====================================================================
-- 52. SCI integrado ao restante do app (migração 046 — idempotente; exige a 031, a 035, a 036, a 037, a 042 e a 045)
--
--  O painel de comando passa a usar o que o app já registra, em vez de pedir de novo:
--   - "Vítima encontrada" (do campo ou do painel, vitima_localizacoes) entra sozinha no quadro de vítimas do SCI,
--     ligada à ficha (nome, idade e sexo vêm da ficha), com a hora e o local do registro; óbito já entra como CINZA.
--     O gatilho nunca impede o registro da vítima encontrada (se o SCI falhar, só avisa no log).
--   - sci_contexto(op): o que o SCI mostra do app numa chamada só — comando atual (passagem de comando), briefing
--     (objetivo, riscos, comunicações), fichas de vítima e localizações, equipes (grupos com membros, responsável,
--     disponibilidade, deslocamento ativo e recursos), participantes rastreados, pontos de interesse (base, risco…),
--     setores (com a geometria), alertas críticos sem ciente, pedidos de ajuda abertos, decisões pendentes,
--     verificação (cão e drone) e o diário (linha do tempo única).
--   - Instalações podem apontar para um ponto de interesse do mapa (ponto_id): as coordenadas vêm do ponto.
-- =====================================================================
alter table public.sci_vitimas add column if not exists localizacao_id uuid references public.vitima_localizacoes(id) on delete set null;
create unique index if not exists sci_vitimas_localizacao_uk on public.sci_vitimas (localizacao_id) where localizacao_id is not null;

-- Liga uma "vítima encontrada" ao quadro do SCI (cria a vítima no quadro ou completa a da mesma ficha).
create or replace function public.sci_vincular_localizacao(p_loc uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  l public.vitima_localizacoes%rowtype;
  f public.vitimas%rowtype;
  v public.sci_vitimas%rowtype;
  v_em timestamptz;
begin
  select * into l from public.vitima_localizacoes where id = p_loc;
  if not found then
    return null;
  end if;
  select * into v from public.sci_vitimas where localizacao_id = l.id;
  if found then
    return v.id;
  end if;
  v_em := coalesce(l.posicao_em, l.registrado_em);
  if l.vitima_id is not null then
    select * into f from public.vitimas where id = l.vitima_id;
    select * into v from public.sci_vitimas where operacao_id = l.operacao_id and vitima_id = l.vitima_id and localizacao_id is null order by numero limit 1 for update;
  end if;
  insert into public.sci_estado (operacao_id) values (l.operacao_id) on conflict (operacao_id) do nothing;
  if v.id is not null then
    update public.sci_vitimas
       set localizacao_id = l.id, localizada_em = least(localizada_em, v_em),
           triagem = case when l.condicao = 'obito' and triagem is null then 'cinza' else triagem end,
           local = case when local = '' then coalesce(left(l.local_descricao, 200), '') else local end,
           atualizado_em = now(), atualizado_por_nome = l.registrado_por_nome
     where id = v.id returning * into v;
  else
    insert into public.sci_vitimas (operacao_id, numero, nome, idade, idade_estimada, sexo, triagem, fase, local, vitima_id, localizacao_id,
                                    localizada_em, criado_por_nome, atualizado_por_nome)
    values (l.operacao_id, coalesce((select max(numero) from public.sci_vitimas where operacao_id = l.operacao_id), 0) + 1,
            coalesce(left(f.nome, 80), ''), f.idade, coalesce(f.idade_qualidade = 'estimada', false), f.sexo,
            case when l.condicao = 'obito' then 'cinza' end, 'localizada', coalesce(left(l.local_descricao, 200), ''), f.id, l.id,
            v_em, l.registrado_por_nome, l.registrado_por_nome)
    returning * into v;
  end if;
  -- só na linha do tempo do SCI (o diário já tem a "vítima localizada")
  insert into public.sci_eventos (operacao_id, ocorrido_em, categoria, texto, origem, ref, registrado_por_nome)
  values (l.operacao_id, v_em, case when l.condicao = 'obito' then 'seguranca' else 'resgate' end,
          public.sci_vnum(v.numero) || ' localizada' || case when v.nome <> '' then ' — ' || v.nome else '' end ||
          case when l.condicao = 'obito' then ' (óbito)' else ' (com vida)' end || ' · registro "Vítima encontrada" de ' || l.registrado_por_nome,
          'automatico', 'localizacao:' || l.id, l.registrado_por_nome);
  return v.id;
end;
$$;

create or replace function public.sci_gatilho_localizacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  begin
    perform public.sci_vincular_localizacao(new.id);
  exception when others then
    raise warning 'SCI: não foi possível ligar a vítima encontrada % ao quadro: %', new.id, sqlerrm;   -- nunca impede o registro
  end;
  return new;
end;
$$;
drop trigger if exists vitima_localizacoes_sci on public.vitima_localizacoes;
create trigger vitima_localizacoes_sci after insert on public.vitima_localizacoes
  for each row execute function public.sci_gatilho_localizacao();

-- Vítimas já encontradas nas operações em andamento entram no quadro
do $$
declare
  r record;
begin
  for r in select l.id from public.vitima_localizacoes l join public.operacoes o on o.id = l.operacao_id
            where o.status = 'ativa' and o.dados_apagados_em is null
              and not exists (select 1 from public.sci_vitimas s where s.localizacao_id = l.id)
            order by l.registrado_em loop
    perform public.sci_vincular_localizacao(r.id);
  end loop;
end;
$$;

-- O que o SCI mostra do restante do app, numa chamada só (só responsáveis da operação).
create or replace function public.sci_contexto(p_operacao uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  o public.operacoes%rowtype;
begin
  if public.nome_responsavel_atual() is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into o from public.operacoes where id = p_operacao;
  return json_build_object(
    'gerado_em', now(),
    'comando', json_build_object('nome', o.comando_nome, 'desde', o.comando_desde,
       'passagem_pendente', (select p.para_nome from public.passagens_comando p where p.operacao_id = p_operacao and p.estado = 'pendente' order by p.criada_em desc limit 1)),
    'briefing', (select json_build_object('objetivo', b.objetivo, 'riscos', b.riscos, 'comunicacoes', b.comunicacoes, 'atualizado_em', b.atualizado_em)
                   from public.briefing_operacao b where b.operacao_id = p_operacao),
    'fichas', coalesce((select json_agg(json_build_object('id', v.id, 'nome', v.nome, 'idade', v.idade, 'idade_qualidade', v.idade_qualidade, 'sexo', v.sexo,
                 'perfil', v.perfil, 'cadastro_rapido', v.cadastro_rapido, 'roupas', left(v.roupas, 120)) order by v.criado_em)
                 from public.vitimas v where v.operacao_id = p_operacao), '[]'::json),
    'localizacoes', coalesce((select json_agg(json_build_object('id', l.id, 'vitima_id', l.vitima_id, 'condicao', l.condicao, 'lat', l.lat, 'lng', l.lng, 'precisao', l.precisao,
                 'em', coalesce(l.posicao_em, l.registrado_em), 'local_descricao', l.local_descricao, 'observacoes', l.observacoes,
                 'registrado_por_nome', l.registrado_por_nome, 'encontrada_por_texto', l.encontrada_por_texto) order by l.registrado_em)
                 from public.vitima_localizacoes l where l.operacao_id = p_operacao), '[]'::json),
    'equipes', coalesce((select json_agg(json_build_object(
                 'id', g.id, 'nome', g.nome, 'cor', g.cor, 'disponibilidade', g.disponibilidade, 'disponibilidade_obs', g.disponibilidade_obs, 'capacidades', g.capacidades,
                 'membros', (select count(*) from public.grupo_membros m join public.participantes p on p.id = m.participante_id where m.grupo_id = g.id and not p.removido),
                 'militares', (select count(*) from public.grupo_membros m join public.participantes p on p.id = m.participante_id where m.grupo_id = g.id and not p.removido and p.tipo = 'militar'),
                 'em_campo', (select count(*) from public.grupo_membros m join public.participantes p on p.id = m.participante_id
                               where m.grupo_id = g.id and not p.removido and p.ultimo_contato_em > now() - interval '10 minutes'),
                 'responsavel', (select coalesce(p.nome_painel, p.nome) from public.grupo_membros m join public.participantes p on p.id = m.participante_id
                                  where m.grupo_id = g.id and m.papel = 'responsavel' and not p.removido order by m.criado_em limit 1),
                 'missao', (select json_build_object('nome', x.nome, 'status', x.status, 'setor_nome', x.setor_nome, 'enviada_em', x.enviada_em,
                                                     'chegou_setor_em', x.chegou_setor_em, 'busca_finalizada_em', x.busca_finalizada_em)
                              from public.missoes x where x.grupo_id = g.id and x.status not in ('na_base', 'encerrada') order by x.enviada_em desc limit 1),
                 'recursos', coalesce((select json_agg(json_build_object('tipo', r.tipo, 'identificacao', r.identificacao, 'quantidade', r.quantidade, 'situacao', r.situacao) order by r.criado_em)
                              from public.grupo_recursos r where r.grupo_id = g.id), '[]'::json)) order by g.nome)
                 from public.grupos g where g.operacao_id = p_operacao), '[]'::json),
    'participantes', (select json_build_object('total', count(*) filter (where p.tipo <> 'responsavel'),
                 'militares', count(*) filter (where p.tipo = 'militar'), 'civis', count(*) filter (where p.tipo = 'civil'),
                 'responsaveis', count(*) filter (where p.tipo = 'responsavel'),
                 'em_campo', count(*) filter (where p.tipo <> 'responsavel' and p.ultimo_contato_em > now() - interval '10 minutes'),
                 'primeiro_militar_em', min(p.criado_em) filter (where p.tipo in ('militar', 'responsavel')))
                 from public.participantes p where p.operacao_id = p_operacao and not p.removido),
    'pontos', coalesce((select json_agg(json_build_object('id', p.id, 'categoria', p.categoria, 'titulo', p.titulo, 'lat', p.lat, 'lng', p.lng) order by p.criado_em)
                 from public.pontos_interesse p where p.operacao_id = p_operacao), '[]'::json),
    'setores', coalesce((select json_agg(json_build_object('id', s.id, 'nome', s.nome, 'status', s.status, 'cor', s.cor, 'equipe', s.equipe, 'forma', s.forma,
                 'centro_lat', s.centro_lat, 'centro_lng', s.centro_lng, 'raio_m', s.raio_m, 'pontos', s.pontos) order by s.nome)
                 from public.setores s where s.operacao_id = p_operacao), '[]'::json),
    'alertas', coalesce((select json_agg(json_build_object('tipo', a.tipo, 'titulo', a.titulo, 'texto', a.texto, 'criado_em', a.criado_em) order by a.criado_em desc)
                 from (select * from public.alertas a where a.operacao_id = p_operacao and a.nivel = 'critico' and a.reconhecido_em is null order by a.criado_em desc limit 30) a), '[]'::json),
    'pedidos_ajuda', coalesce((select json_agg(json_build_object('participante_nome', a.participante_nome, 'estado', a.estado, 'prioridade', a.prioridade,
                 'recebido_em', a.recebido_em, 'equipe_nome', a.equipe_nome) order by a.recebido_em)
                 from public.pedidos_ajuda a where a.operacao_id = p_operacao and a.estado <> 'resolvido'), '[]'::json),
    'decisoes', coalesce((select json_agg(json_build_object('texto', d.texto, 'responsavel_nome', d.responsavel_nome, 'prazo', d.prazo) order by d.criado_em)
                 from public.decisoes_pendentes d where d.operacao_id = p_operacao and d.estado = 'pendente'), '[]'::json),
    'verificacao', json_build_object(
       'indicacoes_em_analise', (select count(*) from public.binomio_eventos e where e.operacao_id = p_operacao and e.tipo = 'indicacao' and e.estado = 'em_analise'),
       'focos_a_verificar', (select count(*) from public.observacoes_campo x where x.operacao_id = p_operacao and x.tipo = 'foco_termico' and x.estado = 'a_verificar')),
    'diario', coalesce((select json_agg(json_build_object('id', d.id, 'ocorrido_em', d.ocorrido_em, 'categoria', d.categoria, 'tipo', d.tipo, 'nivel', d.nivel,
                 'titulo', d.titulo, 'detalhe', left(d.detalhe, 500), 'autor_nome', d.autor_nome, 'origem', d.origem) order by d.ocorrido_em desc)
                 from (select * from public.diario d where d.operacao_id = p_operacao and d.tipo not like 'sci\_%' order by d.ocorrido_em desc limit 400) d), '[]'::json)
  );
end;
$$;

-- Instalação ligada a um ponto do mapa (ponto_id)
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
      r := r || jsonb_build_object(k, v);
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
  if not (r ? v_obrig) then
    raise exception 'dados_invalidos';
  end if;
  return r;
end;
$$;

revoke execute on function public.sci_vincular_localizacao(uuid) from public, anon, authenticated;
revoke execute on function public.sci_contexto(uuid) from public, anon;
grant execute on function public.sci_contexto(uuid) to authenticated;

notify pgrst, 'reload schema';
