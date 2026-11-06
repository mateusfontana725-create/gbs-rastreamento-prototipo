-- =====================================================================
-- 065 · Mapa do participante: setores e pontos públicos ou privados, áreas proibidas e trilhas da equipe
-- (migração idempotente; exige a 003 (setores, pontos), a 061 (areas_proibidas) e as missões (010))
--
-- Público: todos os participantes da operação veem. Privado: só responsáveis e quem recebeu (setor atribuído
-- ao participante ou à missão dele; ponto enviado como destino). Vazio = privado; para ENCONTRO, RISCO e BASE
-- vazio = público (o que já valia). Áreas proibidas: todos os participantes veem.
-- =====================================================================

alter table public.setores add column if not exists visibilidade text;
alter table public.setores drop constraint if exists setores_visibilidade_ok;
alter table public.setores add constraint setores_visibilidade_ok check (visibilidade is null or visibilidade in ('publico', 'privado'));
alter table public.pontos_interesse add column if not exists visibilidade text;
alter table public.pontos_interesse drop constraint if exists pontos_interesse_visibilidade_ok;
alter table public.pontos_interesse add constraint pontos_interesse_visibilidade_ok check (visibilidade is null or visibilidade in ('publico', 'privado'));

create or replace function public.salvar_setor(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_s public.setores%rowtype;
  v_op public.operacoes%rowtype;
  v_part uuid;
begin
  if v_nome_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);

  if p_id is null then
    v_s.id := gen_random_uuid();
    v_s.operacao_id := p_operacao;
    v_s.criado_por := auth.uid();
    v_s.criado_por_nome := v_nome_resp;
    v_s.criado_em := now();
    v_s.status := 'pendente';
    v_s.cor := '#3b82f6';
    v_s.equipe := '';
    v_s.observacoes := '';
  else
    select * into v_s from public.setores where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'setor_nao_encontrado';
    end if;
  end if;

  if p_dados ? 'nome' then v_s.nome := btrim(coalesce(p_dados->>'nome', '')); end if;
  if p_dados ? 'status' then v_s.status := p_dados->>'status'; end if;
  if p_dados ? 'cor' then v_s.cor := p_dados->>'cor'; end if;
  if p_dados ? 'visibilidade' then
    if coalesce(p_dados->>'visibilidade', '') not in ('publico', 'privado') then raise exception 'dados_invalidos'; end if;
    v_s.visibilidade := p_dados->>'visibilidade';
  end if;
  if p_dados ? 'equipe' then v_s.equipe := left(btrim(coalesce(p_dados->>'equipe', '')), 60); end if;
  if p_dados ? 'observacoes' then v_s.observacoes := left(btrim(coalesce(p_dados->>'observacoes', '')), 500); end if;
  if p_dados ? 'participante_id' then
    v_part := nullif(p_dados->>'participante_id', '')::uuid;
    if v_part is not null and not exists (select 1 from public.participantes where id = v_part and operacao_id = p_operacao) then
      raise exception 'participante_invalido';
    end if;
    v_s.participante_id := v_part;
  end if;
  if p_dados ? 'forma' then
    v_s.forma := p_dados->>'forma';
    if v_s.forma = 'circulo' then
      v_s.centro_lat := (p_dados->>'centro_lat')::double precision;
      v_s.centro_lng := (p_dados->>'centro_lng')::double precision;
      v_s.raio_m := (p_dados->>'raio_m')::double precision;
      v_s.pontos := null;
    elsif v_s.forma = 'poligono' then
      if not public.vertices_validos(p_dados->'pontos') then
        raise exception 'area_invalida';
      end if;
      v_s.pontos := p_dados->'pontos';
      v_s.centro_lat := null;
      v_s.centro_lng := null;
      v_s.raio_m := null;
    else
      raise exception 'area_invalida';
    end if;
  end if;

  if v_s.nome is null or char_length(v_s.nome) not between 1 and 60 then
    raise exception 'nome_invalido';
  end if;
  if v_s.status not in ('pendente', 'andamento', 'concluido') or v_s.cor !~ '^#[0-9a-fA-F]{6}$' then
    raise exception 'dados_invalidos';
  end if;
  if v_s.forma is null
     or (v_s.forma = 'circulo' and (v_s.centro_lat is null or v_s.centro_lng is null or v_s.raio_m is null
         or v_s.raio_m not between 5 and 50000 or v_s.centro_lat not between -90 and 90 or v_s.centro_lng not between -180 and 180)) then
    raise exception 'area_invalida';
  end if;

  v_s.atualizado_em := now();
  v_s.atualizado_por_nome := v_nome_resp;
  if p_id is null then
    insert into public.setores select v_s.*;
  else
    update public.setores set visibilidade = v_s.visibilidade, nome = v_s.nome, forma = v_s.forma, centro_lat = v_s.centro_lat, centro_lng = v_s.centro_lng,
           raio_m = v_s.raio_m, pontos = v_s.pontos, cor = v_s.cor, status = v_s.status, participante_id = v_s.participante_id,
           equipe = v_s.equipe, observacoes = v_s.observacoes, atualizado_em = v_s.atualizado_em,
           atualizado_por_nome = v_s.atualizado_por_nome
     where id = v_s.id;
  end if;
  return row_to_json(v_s);
end;
$$;

create or replace function public.salvar_ponto(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_p public.pontos_interesse%rowtype;
  v_op public.operacoes%rowtype;
  v_ref uuid;
  v_msg public.mensagens%rowtype;
  v_tipo public.tipos_ponto%rowtype;
begin
  if v_nome_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);

  if p_id is null then
    v_p.id := gen_random_uuid();
    v_p.operacao_id := p_operacao;
    v_p.criado_por := auth.uid();
    v_p.criado_por_nome := v_nome_resp;
    v_p.criado_em := now();
    v_p.descricao := '';
    -- ponto criado a partir de um relato: guarda quem relatou
    if p_dados ? 'mensagem_id' and nullif(p_dados->>'mensagem_id', '') is not null then
      select * into v_msg from public.mensagens
       where id = (p_dados->>'mensagem_id')::uuid and operacao_id = p_operacao and direcao = 'entrada';
      if not found then
        raise exception 'dados_invalidos';
      end if;
      v_p.mensagem_id := v_msg.id;
      v_p.relatado_por_nome := v_msg.remetente_nome;
    end if;
  else
    select * into v_p from public.pontos_interesse where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'ponto_nao_encontrado';
    end if;
  end if;

  if p_dados ? 'categoria' then v_p.categoria := p_dados->>'categoria'; end if;
  -- tipo criado pelos usuários: a categoria fica "OUTRO" (sem regra especial) e o ícone e a cor vêm do tipo
  if p_dados ? 'tipo_id' then
    if nullif(p_dados->>'tipo_id', '') is null then
      v_p.tipo_id := null; v_p.icone := null; v_p.cor := null;
    else
      begin
        select * into v_tipo from public.tipos_ponto where id = (p_dados->>'tipo_id')::uuid and ativo;
      exception when others then
        raise exception 'dados_invalidos';
      end;
      if v_tipo.id is null then
        raise exception 'tipo_ponto_inexistente';
      end if;
      v_p.tipo_id := v_tipo.id; v_p.icone := v_tipo.icone; v_p.cor := v_tipo.cor; v_p.categoria := 'OUTRO';
    end if;
  elsif p_dados ? 'categoria' and v_p.categoria <> 'OUTRO' then
    v_p.tipo_id := null; v_p.icone := null; v_p.cor := null;
  end if;
  if p_dados ? 'visibilidade' then
    if coalesce(p_dados->>'visibilidade', '') not in ('publico', 'privado') then raise exception 'dados_invalidos'; end if;
    v_p.visibilidade := p_dados->>'visibilidade';
  end if;
  if p_dados ? 'titulo' then v_p.titulo := btrim(coalesce(p_dados->>'titulo', '')); end if;
  if p_dados ? 'descricao' then v_p.descricao := left(btrim(coalesce(p_dados->>'descricao', '')), 1000); end if;
  if p_dados ? 'lat' then v_p.lat := (p_dados->>'lat')::double precision; end if;
  if p_dados ? 'lng' then v_p.lng := (p_dados->>'lng')::double precision; end if;
  if p_dados ? 'raio_m' then v_p.raio_m := nullif(p_dados->>'raio_m', '')::double precision; end if;
  if p_dados ? 'foto_id' then
    v_ref := nullif(p_dados->>'foto_id', '')::uuid;
    if v_ref is not null and not exists (select 1 from public.fotos where id = v_ref and operacao_id = p_operacao) then
      raise exception 'dados_invalidos';
    end if;
    v_p.foto_id := v_ref;
  end if;

  if v_p.categoria is null or v_p.categoria not in ('ULTIMA_LOCALIZACAO', 'POSSIVEL_LOCALIZACAO', 'VESTIGIO',
                                                      'RISCO', 'ENCONTRO', 'VITIMA_ENCONTRADA', 'OUTRO', 'BASE') then
    raise exception 'dados_invalidos';
  end if;
  if v_p.titulo is null or char_length(v_p.titulo) not between 1 and 80 then
    raise exception 'nome_invalido';
  end if;
  if v_p.lat is null or v_p.lng is null or v_p.lat not between -90 and 90 or v_p.lng not between -180 and 180
     or (v_p.lat = 0 and v_p.lng = 0) then
    raise exception 'posicao_invalida';
  end if;

  if v_p.raio_m is not null and v_p.raio_m not between 10 and 5000 then
    raise exception 'dados_invalidos';
  end if;
  v_p.atualizado_em := now();
  v_p.atualizado_por_nome := v_nome_resp;
  if p_id is null then
    insert into public.pontos_interesse select v_p.*;
  else
    update public.pontos_interesse set visibilidade = v_p.visibilidade, categoria = v_p.categoria, titulo = v_p.titulo, descricao = v_p.descricao,
           lat = v_p.lat, lng = v_p.lng, foto_id = v_p.foto_id, raio_m = v_p.raio_m, tipo_id = v_p.tipo_id, icone = v_p.icone, cor = v_p.cor,
           atualizado_em = v_p.atualizado_em,
           atualizado_por_nome = v_p.atualizado_por_nome
     where id = v_p.id;
  end if;
  return row_to_json(v_p);
end;
$$;

-- O participante vê: setores públicos e os dele (atribuídos a ele ou à missão dele), pontos públicos e os que
-- recebeu (como destino), as áreas proibidas da operação, a equipe e o destino ativo.
-- Visibilidade vazia = privado (setor) ou, para ENCONTRO, RISCO e BASE, público (como já era).
create or replace function public.mapa_do_participante(p_participante uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found then
    raise exception 'participante_invalido';
  end if;
  if v_part.liberado_em is not null then
    raise exception 'participante_liberado';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  return json_build_object(
    'equipe', public.equipe_no_mapa(p_participante),
    'setores', coalesce((
      select json_agg(json_build_object('id', s.id, 'nome', s.nome, 'forma', s.forma, 'centro_lat', s.centro_lat,
                                        'centro_lng', s.centro_lng, 'raio_m', s.raio_m, 'pontos', s.pontos,
                                        'cor', s.cor, 'status', s.status,
                                        'publico', coalesce(s.visibilidade, 'privado') = 'publico',
                                        'meu', (coalesce(s.participante_id = v_part.id, false) or exists (
                                          select 1 from public.missoes m join public.missao_membros mm on mm.missao_id = m.id
                                           where m.setor_id = s.id and mm.participante_id = v_part.id and m.status <> 'encerrada'))
                                       ) order by s.criado_em)
        from public.setores s
       where s.operacao_id = v_part.operacao_id
         and (coalesce(s.visibilidade, 'privado') = 'publico'
              or s.participante_id = v_part.id
              or exists (select 1 from public.missoes m join public.missao_membros mm on mm.missao_id = m.id
                          where m.setor_id = s.id and mm.participante_id = v_part.id and m.status <> 'encerrada'))), '[]'::json),
    'pontos', coalesce((
      select json_agg(json_build_object('id', p.id, 'categoria', p.categoria, 'titulo', p.titulo, 'descricao', p.descricao,
                                        'lat', p.lat, 'lng', p.lng, 'raio_m', p.raio_m,
                                        'publico', coalesce(p.visibilidade, case when p.categoria in ('ENCONTRO', 'RISCO', 'BASE') then 'publico' else 'privado' end) = 'publico')
                      order by p.criado_em)
        from public.pontos_interesse p
       where p.operacao_id = v_part.operacao_id
         and (coalesce(p.visibilidade, case when p.categoria in ('ENCONTRO', 'RISCO', 'BASE') then 'publico' else 'privado' end) = 'publico'
              or exists (select 1 from public.destinos d where d.ponto_id = p.id and d.participante_id = v_part.id))), '[]'::json),
    'areas_proibidas', coalesce((
      select json_agg(json_build_object('id', a.id, 'nome', a.nome, 'motivo', a.motivo, 'pontos', a.pontos) order by a.criado_em)
        from public.areas_proibidas a where a.operacao_id = v_part.operacao_id), '[]'::json),
    'destino', (
      select json_build_object('id', d.id, 'nome', d.nome, 'lat', d.lat, 'lng', d.lng, 'criado_em', d.criado_em, 'modo', d.modo, 'trajeto', d.trajeto)
        from public.destinos d where d.participante_id = v_part.id and d.encerrado_em is null
       order by d.criado_em desc limit 1)
  );
end;
$$;

-- Trilhas dos outros participantes (sem nome): por onde a equipe já passou. Últimas 4 horas, até ~150 pontos por trilha.
create or replace function public.trilhas_da_equipe(p_participante uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found then
    raise exception 'participante_invalido';
  end if;
  if v_part.liberado_em is not null then
    raise exception 'participante_liberado';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  return coalesce((
    select json_agg(json_build_object('tipo', t.tipo, 'pontos', t.pontos) order by t.criado_em)
      from (
        select o.criado_em, o.tipo, (
          select json_agg(json_build_array(y.lat, y.lng) order by y.registrado_em)
            from (
              select x.lat, x.lng, x.registrado_em, x.rn, x.cnt
                from (
                  select q.lat, q.lng, q.registrado_em, row_number() over (order by q.registrado_em) as rn, count(*) over () as cnt
                    from public.posicoes q
                   where q.participante_id = o.id and q.registrado_em > now() - interval '4 hours'
                     and (q.precisao is null or q.precisao <= 100)
                ) x
               where x.rn % greatest(1, ceil(x.cnt / 150.0)::int) = 0 or x.rn = x.cnt
            ) y) as pontos
          from public.participantes o
         where o.operacao_id = v_part.operacao_id and o.id <> v_part.id and o.tipo in ('civil', 'militar')
           and not o.removido and o.liberado_em is null
      ) t
     where t.pontos is not null and json_array_length(t.pontos) >= 2), '[]'::json);
end;
$$;
revoke execute on function public.trilhas_da_equipe(uuid) from public, anon;
grant execute on function public.trilhas_da_equipe(uuid) to authenticated;
