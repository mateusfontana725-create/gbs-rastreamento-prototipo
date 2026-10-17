-- =====================================================================
-- 27. IPO no cadastro (migração 021 — idempotente; exige a 019)
--
--  O IPO passa a ser o próprio cadastro da operação: os campos ficam em operacoes.ipo
--  (criar_operacao e atualizar_operacao gravam), e o que já existe no cadastro não se repete
--  (localidade = endereço, início das operações = acionamento, contexto = descrição).
--  As vítimas do IPO são as fichas de vítima: ganham nascimento, sexo e origem.
--  Procedimentos, recursos e desdobramentos viram registros do diário (diario_registrar_ipo).
-- =====================================================================
alter table public.vitimas add column if not exists nascimento text check (nascimento is null or char_length(nascimento) <= 20);
alter table public.vitimas add column if not exists sexo text check (sexo is null or sexo in ('M', 'F'));
alter table public.vitimas add column if not exists origem text check (origem is null or char_length(origem) <= 120);

create or replace function public.ipo_validar(p_ipo jsonb)
returns jsonb
language plpgsql immutable set search_path = public
as $$
begin
  p_ipo := coalesce(p_ipo, '{}'::jsonb);
  if jsonb_typeof(p_ipo) <> 'object' or length(p_ipo::text) > 30000 then
    raise exception 'dados_invalidos';
  end if;
  return p_ipo;
end;
$$;

revoke execute on function public.ipo_validar(jsonb) from public, anon, authenticated;

create or replace function public.criar_operacao(p_codigo text, p_retencao_horas integer default 0, p_dados jsonb default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
  v_ipo jsonb;
begin
  if not public.eh_responsavel() then
    raise exception 'sem_permissao';
  end if;
  if p_retencao_horas is null or p_retencao_horas not in (0, 24, 72, 168, 720) then
    raise exception 'retencao_invalida';
  end if;
  v_op.codigo := btrim(regexp_replace(coalesce(p_codigo, ''), '\s+', ' ', 'g'));
  if char_length(v_op.codigo) < 2 or char_length(v_op.codigo) > 80 then
    raise exception 'codigo_invalido';
  end if;
  v_op.descricao := '';
  v_ipo := public.ipo_validar(p_dados->'ipo');
  if p_dados is not null then
    v_op := public.aplicar_cadastro_operacao(v_op, p_dados - 'codigo');
    if v_op.tipo is null then
      raise exception 'tipo_operacao_invalido';
    end if;
    if v_op.acionado_em is null then
      raise exception 'acionamento_invalido';
    end if;
  end if;

  insert into public.operacoes (codigo, responsavel_id, token_civil, token_militar, retencao_horas,
                                tipo, tipo_outro, acionado_em, local_endereco, local_lat, local_lng, descricao, ipo)
  values (v_op.codigo, auth.uid(), public.gerar_token(), public.gerar_token(), p_retencao_horas,
          v_op.tipo, v_op.tipo_outro, v_op.acionado_em, v_op.local_endereco, v_op.local_lat, v_op.local_lng,
          coalesce(v_op.descricao, ''), v_ipo)
  returning * into v_op;

  return row_to_json(v_op);
end;
$$;

create or replace function public.atualizar_operacao(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_op public.operacoes%rowtype;
  v_ipo jsonb;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao for update;
  if not found then
    raise exception 'sem_permissao';
  end if;
  v_ipo := public.ipo_validar(coalesce(p_dados->'ipo', v_op.ipo));
  v_op := public.aplicar_cadastro_operacao(v_op, p_dados);
  update public.operacoes
     set ipo = v_ipo, codigo = v_op.codigo, tipo = v_op.tipo, tipo_outro = v_op.tipo_outro, acionado_em = v_op.acionado_em,
         local_endereco = v_op.local_endereco, local_lat = v_op.local_lat, local_lng = v_op.local_lng,
         descricao = coalesce(v_op.descricao, ''), atualizado_em = now(), atualizado_por_nome = v_nome
   where id = p_operacao
  returning * into v_op;
  return row_to_json(v_op);
end;
$$;

create or replace function public.salvar_vitima(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v public.vitimas%rowtype;
  v_op public.operacoes%rowtype;
  v_idade numeric;
begin
  if v_nome_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;

  if p_id is null then
    v.id := gen_random_uuid();
    v.operacao_id := p_operacao;
    v.criado_por := auth.uid();
    v.criado_por_nome := v_nome_resp;
    v.criado_em := now();
    v.caracteristicas := '';
    v.roupas := '';
    v.observacoes := '';
  else
    select * into v from public.vitimas where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'vitima_nao_encontrada';
    end if;
  end if;

  if p_dados ? 'nome' then v.nome := btrim(regexp_replace(coalesce(p_dados->>'nome', ''), '\s+', ' ', 'g')); end if;
  if p_dados ? 'caracteristicas' then v.caracteristicas := btrim(coalesce(p_dados->>'caracteristicas', '')); end if;
  if p_dados ? 'roupas' then v.roupas := btrim(coalesce(p_dados->>'roupas', '')); end if;
  if p_dados ? 'observacoes' then v.observacoes := btrim(coalesce(p_dados->>'observacoes', '')); end if;
  if p_dados ? 'nascimento' then v.nascimento := nullif(btrim(coalesce(p_dados->>'nascimento', '')), ''); end if;
  if p_dados ? 'sexo' then v.sexo := nullif(btrim(coalesce(p_dados->>'sexo', '')), ''); end if;
  if p_dados ? 'origem' then v.origem := nullif(btrim(regexp_replace(coalesce(p_dados->>'origem', ''), '\s+', ' ', 'g')), ''); end if;
  if p_dados ? 'idade' then
    if coalesce(jsonb_typeof(p_dados->'idade'), 'null') = 'null' then
      v.idade := null;
    elsif jsonb_typeof(p_dados->'idade') = 'number' then
      v_idade := (p_dados->>'idade')::numeric;
      if v_idade <> trunc(v_idade) or v_idade not between 0 and 130 then
        raise exception 'dados_invalidos';
      end if;
      v.idade := v_idade::smallint;
    else
      raise exception 'dados_invalidos';
    end if;
  end if;

  if v.nome is null or char_length(v.nome) not between 1 and 80 then
    raise exception 'nome_vitima_invalido';
  end if;
  if char_length(v.caracteristicas) > 1000 or char_length(v.roupas) > 1000 or char_length(v.observacoes) > 2000 then
    raise exception 'dados_invalidos';
  end if;
  if (v.sexo is not null and v.sexo not in ('M', 'F')) or char_length(coalesce(v.nascimento, '')) > 20 or char_length(coalesce(v.origem, '')) > 120 then
    raise exception 'dados_invalidos';
  end if;

  v.atualizado_em := now();
  v.atualizado_por_nome := v_nome_resp;
  if p_id is null then
    insert into public.vitimas select v.*;
  else
    update public.vitimas set nome = v.nome, idade = v.idade, caracteristicas = v.caracteristicas, roupas = v.roupas,
           observacoes = v.observacoes, nascimento = v.nascimento, sexo = v.sexo, origem = v.origem, atualizado_em = v.atualizado_em, atualizado_por_nome = v.atualizado_por_nome
     where id = v.id;
  end if;
  return row_to_json(v);
end;
$$;

-- Procedimentos, recursos e desdobramentos da operação entram no diário (categoria operação).
-- Procedimento: ref_id guarda a chave do procedimento (scuba, livre, rede, superficie, margens, aeronave).
create or replace function public.diario_registrar_ipo(p_operacao uuid, p_ocorrido_em timestamptz, p_tipo text, p_chave text, p_texto text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_texto text := btrim(coalesce(p_texto, ''));
  v_chave text := nullif(btrim(coalesce(p_chave, '')), '');
  v_titulo text;
  v public.diario%rowtype;
  v_op public.operacoes%rowtype;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if p_tipo = 'procedimento' then
    if v_chave not in ('scuba', 'livre', 'rede', 'superficie', 'margens', 'aeronave') then
      raise exception 'procedimento_invalido';
    end if;
    v_titulo := 'Procedimento de busca';
  elsif p_tipo = 'recurso' then
    v_chave := null;
    v_titulo := 'Recurso empregado';
  elsif p_tipo = 'desdobramento' then
    v_chave := null;
    v_titulo := 'Desdobramento';
  else
    raise exception 'tipo_invalido';
  end if;
  if v_texto = '' then
    raise exception 'texto_obrigatorio';
  end if;
  if char_length(v_texto) > 4000 then
    raise exception 'texto_longo';
  end if;
  if p_ocorrido_em is null or p_ocorrido_em > now() + interval '2 minutes'
     or p_ocorrido_em < coalesce(least(v_op.acionado_em, v_op.criada_em), v_op.criada_em) - interval '7 days' then
    raise exception 'data_invalida';
  end if;
  insert into public.diario (operacao_id, ocorrido_em, origem, categoria, tipo, titulo, detalhe, ref_id, autor_id, autor_nome)
  values (p_operacao, least(p_ocorrido_em, now()), 'manual', 'operacao', p_tipo, v_titulo, v_texto, v_chave, auth.uid(), v_nome)
  returning * into v;
  return row_to_json(v);
end;
$$;

revoke execute on function public.diario_registrar_ipo(uuid, timestamptz, text, text, text) from public, anon;
grant execute on function public.diario_registrar_ipo(uuid, timestamptz, text, text, text) to authenticated;

create or replace function public.relatorio_operacao(p_operacao uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
begin
  if public.nome_responsavel_atual() is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  return json_build_object(
    'gerado_em', now(),
    'gerado_por_nome', public.nome_responsavel_atual(),
    'operacao', json_build_object(
      'id', v_op.id, 'codigo', v_op.codigo, 'status', v_op.status, 'tipo', v_op.tipo, 'tipo_outro', v_op.tipo_outro,
      'acionado_em', v_op.acionado_em, 'local_endereco', v_op.local_endereco, 'local_lat', v_op.local_lat, 'local_lng', v_op.local_lng,
      'descricao', v_op.descricao, 'criada_em', v_op.criada_em, 'encerrada_em', v_op.encerrada_em,
      'dados_apagados_em', v_op.dados_apagados_em, 'retencao_horas', v_op.retencao_horas,
      'ipo', v_op.ipo,
      'resultado', v_op.resultado, 'resultado_texto', v_op.resultado_texto, 'resultado_em', v_op.resultado_em,
      'resultado_por_nome', v_op.resultado_por_nome,
      'criador_nome', (select nome from public.responsaveis where user_id = v_op.responsavel_id)),
    'responsaveis', coalesce((
      select json_agg(json_build_object('nome', r.nome, 'criador', x.criador, 'desde', x.desde) order by x.criador desc, x.desde)
        from (select v_op.responsavel_id as user_id, true as criador, v_op.criada_em as desde
              union all
              select m.user_id, false, m.criado_em from public.operacao_responsaveis m
               where m.operacao_id = p_operacao and m.user_id <> v_op.responsavel_id) x
        join public.responsaveis r on r.user_id = x.user_id), '[]'::json),
    'vitimas', coalesce((
      select json_agg(json_build_object('id', t.id, 'nome', t.nome, 'idade', t.idade, 'caracteristicas', t.caracteristicas,
                                        'roupas', t.roupas, 'observacoes', t.observacoes, 'foto_caminho', t.foto_caminho,
                                        'nascimento', t.nascimento, 'sexo', t.sexo, 'origem', t.origem) order by t.criado_em)
        from public.vitimas t where t.operacao_id = p_operacao), '[]'::json),
    'participantes', coalesce((
      select json_agg(json_build_object('id', p.id, 'nome', p.nome, 'tipo', p.tipo,
               'cpf', public.mascarar_cpf(p.cpf), 'telefone', public.mascarar_telefone(p.telefone),
               'entrou_em', p.criado_em, 'liberado_em', p.liberado_em, 'removido', p.removido, 'removido_em', p.removido_em,
               'grupos', (select coalesce(json_agg(json_build_object('grupo', g.nome, 'papel', gm.papel) order by g.nome), '[]'::json)
                            from public.grupo_membros gm join public.grupos g on g.id = gm.grupo_id
                           where gm.participante_id = p.id)) order by p.tipo, p.nome)
        from public.participantes p where p.operacao_id = p_operacao and p.tipo <> 'responsavel'), '[]'::json),
    'grupos', coalesce((
      select json_agg(json_build_object('id', g.id, 'nome', g.nome, 'cor', g.cor,
               'membros', (select count(*) from public.grupo_membros gm where gm.grupo_id = g.id)) order by g.nome)
        from public.grupos g where g.operacao_id = p_operacao), '[]'::json),
    'setores', coalesce((
      select json_agg(json_build_object('id', s.id, 'nome', s.nome, 'forma', s.forma, 'centro_lat', s.centro_lat, 'centro_lng', s.centro_lng,
               'raio_m', s.raio_m, 'pontos', s.pontos, 'cor', s.cor, 'status', s.status, 'equipe', s.equipe, 'observacoes', s.observacoes,
               'responsavel_nome', (select nome from public.participantes where id = s.participante_id),
               'inicio_em', (select min(d.ocorrido_em) from public.diario d where d.operacao_id = p_operacao and d.ref_id = s.id::text and d.tipo = 'setor_iniciado'),
               'fim_em', (select max(d.ocorrido_em) from public.diario d where d.operacao_id = p_operacao and d.ref_id = s.id::text and d.tipo = 'setor_concluido'),
               'missoes', (select coalesce(json_agg(json_build_object('grupo', m.grupo_nome, 'enviada_em', m.enviada_em, 'iniciada_em', m.iniciada_em,
                                  'chegou_setor_em', m.chegou_setor_em, 'busca_finalizada_em', m.busca_finalizada_em, 'chegou_base_em', m.chegou_base_em)
                                  order by m.enviada_em), '[]'::json)
                             from public.missoes m where m.setor_id = s.id)) order by s.nome)
        from public.setores s where s.operacao_id = p_operacao), '[]'::json),
    'pontos', coalesce((
      select json_agg(json_build_object('categoria', pi.categoria, 'titulo', pi.titulo, 'descricao', pi.descricao, 'lat', pi.lat, 'lng', pi.lng,
                                        'criado_em', pi.criado_em, 'criado_por_nome', pi.criado_por_nome) order by pi.criado_em)
        from public.pontos_interesse pi where pi.operacao_id = p_operacao), '[]'::json),
    'fotos', coalesce((
      select json_agg(json_build_object('id', f.id, 'caminho', f.caminho, 'lat', f.lat, 'lng', f.lng, 'autor_nome', f.autor_nome,
                                        'autor_tipo', f.autor_tipo, 'capturada_em', coalesce(f.capturada_em, f.registrada_em),
                                        'legenda', f.legenda, 'largura', f.largura, 'altura', f.altura) order by coalesce(f.capturada_em, f.registrada_em))
        from public.fotos f where f.operacao_id = p_operacao), '[]'::json),
    -- Trilhas resumidas (no máximo ~400 pontos por pessoa) para o mapa do relatório
    'trilhas', coalesce((
      select json_agg(json_build_object('participante_id', t.participante_id, 'tipo', t.tipo, 'pontos', t.pontos))
        from (select q.participante_id, max(q.tipo) as tipo, json_agg(json_build_array(round(q.lat::numeric, 6), round(q.lng::numeric, 6)) order by q.registrado_em) as pontos
                from (select po.participante_id, pa.tipo, po.lat, po.lng, po.registrado_em,
                             row_number() over (partition by po.participante_id order by po.registrado_em) as n,
                             count(*) over (partition by po.participante_id) as total
                        from public.posicoes po join public.participantes pa on pa.id = po.participante_id
                       where po.operacao_id = p_operacao and (po.precisao is null or po.precisao <= 100)) q
               where q.n % greatest(1, ceil(q.total / 400.0)::int) = 0 or q.n = 1 or q.n = q.total
               group by q.participante_id) t), '[]'::json),
    'diario', coalesce((
      select json_agg(json_build_object('id', d.id, 'ocorrido_em', d.ocorrido_em, 'origem', d.origem, 'categoria', d.categoria,
               'tipo', d.tipo, 'nivel', d.nivel, 'titulo', d.titulo, 'detalhe', d.detalhe, 'autor_nome', d.autor_nome,
               'lat', d.lat, 'lng', d.lng, 'ref_id', d.ref_id, 'versao', d.versao, 'editado_em', d.editado_em, 'editado_por_nome', d.editado_por_nome)
               order by d.ocorrido_em, d.id)
        from public.diario d where d.operacao_id = p_operacao), '[]'::json),
    'relatorios_anteriores', coalesce((
      select json_agg(json_build_object('gerado_em', r.gerado_em, 'gerado_por_nome', r.gerado_por_nome) order by r.gerado_em)
        from public.relatorios r where r.operacao_id = p_operacao), '[]'::json)
  );
end;
$$;

notify pgrst, 'reload schema';
