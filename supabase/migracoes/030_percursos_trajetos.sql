-- =====================================================================
-- 36. Percursos (equipes e drones) e trajeto desenhado como destino (migração 030 — idempotente;
--     exige a 010 e a 028)
--
--  1) Trilhas desenhadas/importadas registram o MEIO do percurso (equipe a pé, drone, viatura,
--     embarcação, aeronave, cão de busca, outro), uma COR própria (opcional) e a ORIGEM
--     (desenhada no mapa ou importada de arquivo, com o nome do arquivo).
--  2) Um destino pode levar um TRAJETO desenhado (linha [[lat, lng], …]): o participante segue a
--     linha como foi desenhada, em vez da rota calculada por caminhos. O destino é o fim da linha.
--     definir_destino_trajeto (uma pessoa) e enviar_trajeto_grupo (grupo, com o mesmo controle de
--     missão e retorno da 010) gravam numa transação só. meu_destino e mapa_do_participante passam
--     a devolver o trajeto. Só responsáveis da operação; encerrada: recusado (como os destinos).
-- =====================================================================
alter table public.trilhas_manuais add column if not exists meio text not null default 'equipe';
alter table public.trilhas_manuais add column if not exists cor text;
alter table public.trilhas_manuais add column if not exists origem text not null default 'desenho';
alter table public.trilhas_manuais add column if not exists arquivo text;
do $$
begin
  alter table public.trilhas_manuais add constraint trilhas_manuais_meio_ok
    check (meio in ('equipe', 'drone', 'viatura', 'embarcacao', 'aeronave', 'cao', 'outro'));
exception when duplicate_object then null;
end;
$$;
do $$
begin
  alter table public.trilhas_manuais add constraint trilhas_manuais_cor_ok check (cor is null or cor ~ '^#[0-9a-fA-F]{6}$');
exception when duplicate_object then null;
end;
$$;
do $$
begin
  alter table public.trilhas_manuais add constraint trilhas_manuais_origem_ok
    check (origem in ('desenho', 'importada') and (arquivo is null or char_length(arquivo) <= 120));
exception when duplicate_object then null;
end;
$$;

create or replace function public.salvar_trilha_manual(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_t public.trilhas_manuais%rowtype;
  v_op public.operacoes%rowtype;
  v_ref uuid;
  v_quando timestamptz;
  v_cliente uuid;
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
    begin
      v_cliente := nullif(p_dados->>'client_id', '')::uuid;
    exception when others then
      raise exception 'dados_invalidos';
    end;
    if v_cliente is null then
      raise exception 'dados_invalidos';
    end if;
    -- mesmo envio repetido (rede instável, clique duplo): devolve a trilha já gravada
    select * into v_t from public.trilhas_manuais where operacao_id = p_operacao and client_id = v_cliente;
    if found then
      return row_to_json(v_t);
    end if;
    v_t.id := gen_random_uuid();
    v_t.operacao_id := p_operacao;
    v_t.client_id := v_cliente;
    v_t.criado_por := auth.uid();
    v_t.criado_por_nome := v_nome_resp;
    v_t.criado_em := now();
    v_t.equipe := '';
    v_t.observacoes := '';
    v_t.meio := 'equipe';
    v_t.origem := case when p_dados->>'origem' = 'importada' then 'importada' else 'desenho' end;
    v_t.arquivo := nullif(left(btrim(coalesce(p_dados->>'arquivo', '')), 120), '');
    if not (p_dados ? 'estado') or not (p_dados ? 'pontos') or not (p_dados ? 'nome') then
      raise exception 'dados_invalidos';
    end if;
  else
    select * into v_t from public.trilhas_manuais where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'trilha_nao_encontrada';
    end if;
  end if;

  if p_dados ? 'nome' then v_t.nome := btrim(regexp_replace(coalesce(p_dados->>'nome', ''), '\s+', ' ', 'g')); end if;
  if p_dados ? 'equipe' then v_t.equipe := left(btrim(coalesce(p_dados->>'equipe', '')), 60); end if;
  if p_dados ? 'observacoes' then v_t.observacoes := left(btrim(coalesce(p_dados->>'observacoes', '')), 1000); end if;
  if p_dados ? 'meio' then
    if coalesce(p_dados->>'meio', '') not in ('equipe', 'drone', 'viatura', 'embarcacao', 'aeronave', 'cao', 'outro') then
      raise exception 'dados_invalidos';
    end if;
    v_t.meio := p_dados->>'meio';
  end if;
  if p_dados ? 'cor' then
    v_t.cor := nullif(p_dados->>'cor', '');
    if v_t.cor is not null and v_t.cor !~ '^#[0-9a-fA-F]{6}$' then
      raise exception 'dados_invalidos';
    end if;
  end if;
  if p_dados ? 'participante_id' then
    v_ref := nullif(p_dados->>'participante_id', '')::uuid;
    if v_ref is not null and not exists (select 1 from public.participantes where id = v_ref and operacao_id = p_operacao) then
      raise exception 'responsavel_trajeto_invalido';
    end if;
    v_t.participante_id := v_ref;
  end if;
  if p_dados ? 'grupo_id' then
    v_ref := nullif(p_dados->>'grupo_id', '')::uuid;
    if v_ref is not null and not exists (select 1 from public.grupos where id = v_ref and operacao_id = p_operacao) then
      raise exception 'grupo_invalido';
    end if;
    v_t.grupo_id := v_ref;
  end if;
  if p_dados ? 'pontos' then
    if not public.linha_valida(p_dados->'pontos') then
      raise exception 'trilha_invalida';
    end if;
    v_t.pontos := p_dados->'pontos';
  end if;
  if p_dados ? 'estado' then
    if p_dados->>'estado' not in ('planejada', 'percorrida') then
      raise exception 'dados_invalidos';
    end if;
    v_t.estado := p_dados->>'estado';
  end if;
  -- Percorrida: o horário vem do usuário (ou agora). Planejada: sem horário de percurso.
  if v_t.estado = 'percorrida' then
    if p_dados ? 'percorrida_em' and nullif(p_dados->>'percorrida_em', '') is not null then
      begin
        v_quando := (p_dados->>'percorrida_em')::timestamptz;
      exception when others then
        raise exception 'data_invalida';
      end;
      if v_quando > now() + interval '2 minutes'
         or v_quando < coalesce(least(v_op.acionado_em, v_op.criada_em), v_op.criada_em) - interval '7 days' then
        raise exception 'data_invalida';
      end if;
      v_t.percorrida_em := least(v_quando, now());
      v_t.percorrida_por_nome := v_nome_resp;
    elsif v_t.percorrida_em is null then
      v_t.percorrida_em := now();
      v_t.percorrida_por_nome := v_nome_resp;
    end if;
  else
    v_t.percorrida_em := null;
    v_t.percorrida_por_nome := null;
  end if;

  if v_t.nome is null or char_length(v_t.nome) not between 1 and 80 then
    raise exception 'nome_trilha_invalido';
  end if;
  if v_t.pontos is null or not public.linha_valida(v_t.pontos) then
    raise exception 'trilha_invalida';
  end if;
  v_t.comprimento_m := round(public.comprimento_linha_m(v_t.pontos)::numeric, 1);
  v_t.atualizado_em := now();
  v_t.atualizado_por_nome := v_nome_resp;

  begin
    if p_id is null then
      insert into public.trilhas_manuais select v_t.*;
    else
      update public.trilhas_manuais
         set nome = v_t.nome, estado = v_t.estado, pontos = v_t.pontos, comprimento_m = v_t.comprimento_m,
             participante_id = v_t.participante_id, grupo_id = v_t.grupo_id, equipe = v_t.equipe, meio = v_t.meio, cor = v_t.cor,
             observacoes = v_t.observacoes, percorrida_em = v_t.percorrida_em, percorrida_por_nome = v_t.percorrida_por_nome,
             atualizado_em = v_t.atualizado_em, atualizado_por_nome = v_t.atualizado_por_nome
       where id = v_t.id;
    end if;
  exception when unique_violation then
    -- nome repetido; ou o mesmo client_id gravado por outra chamada simultânea
    if p_id is null and exists (select 1 from public.trilhas_manuais where operacao_id = p_operacao and client_id = v_t.client_id) then
      select * into v_t from public.trilhas_manuais where operacao_id = p_operacao and client_id = v_t.client_id;
      return row_to_json(v_t);
    end if;
    raise exception 'nome_repetido';
  end;
  return row_to_json(v_t);
end;
$$;

create or replace function public.diario_de_trilha_manual()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_det text;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.operacoes where id = old.operacao_id and dados_apagados_em is null) then
      perform public.diario_auto(old.operacao_id, now(), 'deslocamento', 'trilha_excluida',
        'Trilha desenhada excluída: ' || old.nome, '', 'trilha_excluida:' || old.id, 'info', null, null, old.id::text, null);
    end if;
    return old;
  end if;
  if new.estado = 'percorrida' and (tg_op = 'INSERT' or old.estado is distinct from 'percorrida') then
    v_det := concat_ws(' · ', case new.meio when 'drone' then 'drone' when 'viatura' then 'viatura' when 'embarcacao' then 'embarcação'
                                            when 'aeronave' then 'aeronave' when 'cao' then 'cão de busca' when 'outro' then null else 'equipe' end,
                       round(new.comprimento_m)::bigint || ' m', nullif(new.equipe, ''),
                       (select 'Grupo ' || nome from public.grupos where id = new.grupo_id),
                       (select nome from public.participantes where id = new.participante_id), nullif(new.observacoes, ''));
    perform public.diario_auto(new.operacao_id, new.percorrida_em, 'deslocamento', 'trilha_percorrida',
      'Trajeto percorrido (desenhado): ' || new.nome, v_det,
      'trilha_percorrida:' || new.id || ':' || extract(epoch from new.percorrida_em)::bigint, 'info',
      (new.pontos->0->>0)::double precision, (new.pontos->0->>1)::double precision, new.id::text, new.percorrida_por_nome);
  end if;
  return new;
end;
$$;

alter table public.destinos add column if not exists trajeto jsonb;
alter table public.missoes add column if not exists trajeto jsonb;
do $$
begin
  alter table public.destinos add constraint destinos_trajeto_ok check (trajeto is null or public.linha_valida(trajeto));
exception when duplicate_object then null;
end;
$$;
do $$
begin
  alter table public.missoes add constraint missoes_trajeto_ok check (trajeto is null or public.linha_valida(trajeto));
exception when duplicate_object then null;
end;
$$;

-- Trajeto desenhado para UMA pessoa. Usa definir_destino (mesmas regras) e grava a linha no destino.
create or replace function public.definir_destino_trajeto(p_participante uuid, p_nome text, p_trajeto jsonb,
                                                          p_modo text default 'a_pe')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_fim jsonb;
  v_r json;
  v_d public.destinos%rowtype;
begin
  if not public.linha_valida(p_trajeto) then
    raise exception 'trajeto_invalido';
  end if;
  v_fim := p_trajeto -> (jsonb_array_length(p_trajeto) - 1);
  v_r := public.definir_destino(p_participante, p_nome, (v_fim->>0)::double precision, (v_fim->>1)::double precision, null, p_modo);
  update public.destinos set trajeto = p_trajeto where id = (v_r->>'id')::uuid returning * into v_d;
  return row_to_json(v_d);
end;
$$;

-- Trajeto desenhado para um GRUPO (missão da 010: chegada, finalização e retorno à base).
create or replace function public.enviar_trajeto_grupo(p_grupo uuid, p_nome text, p_trajeto jsonb,
                                                       p_publico text default 'todos', p_modo text default 'a_pe',
                                                       p_setor uuid default null, p_base uuid default null,
                                                       p_raio_base_m double precision default null, p_prazo_min integer default 30)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_fim jsonb;
  v_r json;
  v_mid uuid;
begin
  if not public.linha_valida(p_trajeto) then
    raise exception 'trajeto_invalido';
  end if;
  v_fim := p_trajeto -> (jsonb_array_length(p_trajeto) - 1);
  v_r := public.enviar_destino_grupo(p_grupo, p_nome, (v_fim->>0)::double precision, (v_fim->>1)::double precision,
                                     p_publico, p_modo, p_setor, null, p_base, p_raio_base_m, p_prazo_min);
  v_mid := (v_r->'missao'->>'id')::uuid;
  update public.missoes set trajeto = p_trajeto where id = v_mid;
  update public.destinos set trajeto = p_trajeto where missao_id = v_mid and encerrado_em is null;
  return json_build_object('missao', (select row_to_json(m) from public.missoes m where m.id = v_mid),
                           'destinatarios', (v_r->>'destinatarios')::integer, 'acompanhados', (v_r->>'acompanhados')::integer);
end;
$$;

revoke execute on function public.definir_destino_trajeto(uuid, text, jsonb, text),
  public.enviar_trajeto_grupo(uuid, text, jsonb, text, text, uuid, uuid, double precision, integer) from public, anon;
grant execute on function public.definir_destino_trajeto(uuid, text, jsonb, text),
  public.enviar_trajeto_grupo(uuid, text, jsonb, text, text, uuid, uuid, double precision, integer) to authenticated;

-- O participante recebe o trajeto junto com o destino.
create or replace function public.meu_destino(p_participante uuid)
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
  return (
    select json_build_object('id', d.id, 'nome', d.nome, 'lat', d.lat, 'lng', d.lng,
                             'criado_em', d.criado_em, 'recebido_em', d.recebido_em, 'modo', d.modo, 'trajeto', d.trajeto,
                             'missao', (select json_build_object(
                                          'id', m.id, 'grupo', m.grupo_nome, 'setor', m.setor_nome, 'status', m.status,
                                          'volta_base', m.busca_finalizada_em is not null,
                                          'pode_finalizar', m.busca_finalizada_em is null and m.status not in ('encerrada', 'na_base')
                                            and exists (select 1 from public.grupo_membros gm
                                                         where gm.grupo_id = m.grupo_id and gm.participante_id = v_part.id
                                                           and gm.papel = 'responsavel'))
                                          from public.missoes m where m.id = d.missao_id))
      from public.destinos d
     where d.participante_id = v_part.id and d.encerrado_em is null
     order by d.criado_em desc limit 1);
end;
$$;

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
                                        'cor', s.cor, 'status', s.status) order by s.criado_em)
        from public.setores s where s.operacao_id = v_part.operacao_id and s.participante_id = v_part.id), '[]'::json),
    'pontos', coalesce((
      select json_agg(json_build_object('id', p.id, 'categoria', p.categoria, 'titulo', p.titulo,
                                        'lat', p.lat, 'lng', p.lng, 'raio_m', p.raio_m) order by p.criado_em)
        from public.pontos_interesse p
       where p.operacao_id = v_part.operacao_id and p.categoria in ('ENCONTRO', 'RISCO', 'BASE')), '[]'::json),
    'destino', (
      select json_build_object('id', d.id, 'nome', d.nome, 'lat', d.lat, 'lng', d.lng, 'criado_em', d.criado_em, 'modo', d.modo, 'trajeto', d.trajeto)
        from public.destinos d where d.participante_id = v_part.id and d.encerrado_em is null
       order by d.criado_em desc limit 1)
  );
end;
$$;

notify pgrst, 'reload schema';
