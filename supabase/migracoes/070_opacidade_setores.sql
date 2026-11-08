-- =====================================================================
-- 070 · Opacidade do preenchimento dos setores, editável
--       (migração idempotente; exige a 003 (setores) e a 065 (mapa do participante))
--
--  1. setores.opacidade: fração do preenchimento (0,1 a 0,9), gravada com o setor como a cor. Nula = a padrão da
--     situação (pendente, em andamento ou concluído), como antes. Vale para todos os aparelhos da operação.
--  2. salvar_setor aceita o campo "opacidade" em p_dados (nulo volta à padrão). A função é a mesma de antes,
--     com esse campo a mais.
-- =====================================================================

alter table public.setores add column if not exists opacidade double precision;
do $$
begin
  alter table public.setores add constraint setores_opacidade_ok check (opacidade is null or opacidade between 0.1 and 0.9);
exception when duplicate_object then null;
end;
$$;

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
  -- opacidade do preenchimento (0,1 a 0,9); nula = a padrão da situação do setor
  if p_dados ? 'opacidade' then
    v_s.opacidade := nullif(p_dados->>'opacidade', '')::double precision;
    if v_s.opacidade is not null and v_s.opacidade not between 0.1 and 0.9 then
      raise exception 'dados_invalidos';
    end if;
  end if;
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
           raio_m = v_s.raio_m, pontos = v_s.pontos, cor = v_s.cor, opacidade = v_s.opacidade, status = v_s.status, participante_id = v_s.participante_id,
           equipe = v_s.equipe, observacoes = v_s.observacoes, atualizado_em = v_s.atualizado_em,
           atualizado_por_nome = v_s.atualizado_por_nome
     where id = v_s.id;
  end if;
  return row_to_json(v_s);
end;
$$;

notify pgrst, 'reload schema';
