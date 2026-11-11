-- Migração 078: o militar cria e mexe em setores e pontos sem internet (página do participante guarda a ação no aparelho e
-- envia quando a internet volta). Para o reenvio não duplicar nada:
--   · participante_salvar_setor e participante_salvar_ponto aceitam "novo_id" em p_dados: o item nasce com o id criado no
--     aparelho; se já existe (reenvio), devolve o mesmo item sem criar outro. As ações seguintes feitas sem internet
--     (situação, edição, exclusão) já usam esse id.
--   · participante_excluir_setor e participante_excluir_ponto: excluir de novo algo que já saiu não é erro (o primeiro
--     envio chegou, mas a resposta se perdeu). Excluir o que é de outra pessoa continua recusado.
-- Mesmas assinaturas; sem esta migração o app também funciona (ajusta os ids na hora do envio).

create or replace function public.participante_salvar_setor(p_participante uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_s public.setores%rowtype;
  v_nome text;
  v_so_status boolean;
begin
  v_part := public.militar_em_campo(p_participante);
  v_nome := v_part.nome || ' (militar)';
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  v_so_status := p_id is not null and (select count(*) from jsonb_object_keys(p_dados)) = 1 and p_dados ? 'status';

  if p_id is null then
    if not public.permissao_militar(v_part.operacao_id, 'setores') then
      raise exception 'funcao_nao_liberada';
    end if;
    -- id criado no aparelho (ação feita sem internet): o reenvio devolve o mesmo setor, sem duplicar
    if p_dados ? 'novo_id' then
      begin
        v_s.id := (p_dados->>'novo_id')::uuid;
      exception when others then
        raise exception 'dados_invalidos';
      end;
      select * into v_s from public.setores where id = (p_dados->>'novo_id')::uuid;
      if found then
        if v_s.criado_por is distinct from auth.uid() or v_s.operacao_id <> v_part.operacao_id then
          raise exception 'funcao_nao_liberada';
        end if;
        return row_to_json(v_s);
      end if;
      v_s.id := (p_dados->>'novo_id')::uuid;
    else
      v_s.id := gen_random_uuid();
    end if;
    v_s.operacao_id := v_part.operacao_id;
    v_s.criado_por := auth.uid();
    v_s.criado_por_nome := v_nome;
    v_s.criado_em := now();
    v_s.status := 'pendente';
    v_s.cor := '#f59e0b';
    v_s.equipe := '';
    v_s.observacoes := '';
    v_s.visibilidade := 'privado';
  else
    select * into v_s from public.setores where id = p_id and operacao_id = v_part.operacao_id for update;
    if not found then
      raise exception 'setor_nao_encontrado';
    end if;
    if v_so_status then
      if not public.permissao_militar(v_part.operacao_id, 'situacao_setor') or not public.setor_visivel_militar(v_part, v_s) then
        raise exception 'funcao_nao_liberada';
      end if;
    elsif not public.permissao_militar(v_part.operacao_id, 'setores') or v_s.criado_por is distinct from auth.uid() then
      raise exception 'funcao_nao_liberada';
    end if;
  end if;

  p_dados := p_dados - 'novo_id';
  if p_dados ? 'nome' then v_s.nome := btrim(coalesce(p_dados->>'nome', '')); end if;
  if p_dados ? 'status' then v_s.status := p_dados->>'status'; end if;
  if p_dados ? 'cor' then v_s.cor := p_dados->>'cor'; end if;
  if p_dados ? 'observacoes' then v_s.observacoes := left(btrim(coalesce(p_dados->>'observacoes', '')), 500); end if;
  if p_dados ? 'forma' then
    v_s.forma := p_dados->>'forma';
    if v_s.forma = 'circulo' then
      if jsonb_typeof(p_dados->'centro_lat') <> 'number' or jsonb_typeof(p_dados->'centro_lng') <> 'number' or jsonb_typeof(p_dados->'raio_m') <> 'number' then
        raise exception 'area_invalida';
      end if;
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
  v_s.atualizado_por_nome := v_nome;
  if p_id is null then
    insert into public.setores select v_s.*;
  else
    update public.setores set nome = v_s.nome, forma = v_s.forma, centro_lat = v_s.centro_lat, centro_lng = v_s.centro_lng,
           raio_m = v_s.raio_m, pontos = v_s.pontos, cor = v_s.cor, status = v_s.status, observacoes = v_s.observacoes,
           atualizado_em = v_s.atualizado_em, atualizado_por_nome = v_s.atualizado_por_nome
     where id = v_s.id;
  end if;
  return row_to_json(v_s);
end;
$$;
revoke execute on function public.participante_salvar_setor(uuid, uuid, jsonb) from public, anon;
grant execute on function public.participante_salvar_setor(uuid, uuid, jsonb) to authenticated;

create or replace function public.participante_excluir_setor(p_participante uuid, p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
begin
  v_part := public.militar_em_campo(p_participante);
  if not public.permissao_militar(v_part.operacao_id, 'setores') then
    raise exception 'funcao_nao_liberada';
  end if;
  delete from public.setores where id = p_id and operacao_id = v_part.operacao_id and criado_por = auth.uid();
  if not found and exists (select 1 from public.setores where id = p_id) then
    raise exception 'funcao_nao_liberada';   -- existe, mas não é dele (ou é de outra operação)
  end if;   -- já não existe (exclusão repetida, feita sem internet): nada a fazer
end;
$$;
revoke execute on function public.participante_excluir_setor(uuid, uuid) from public, anon;
grant execute on function public.participante_excluir_setor(uuid, uuid) to authenticated;

create or replace function public.participante_salvar_ponto(p_participante uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_p public.pontos_interesse%rowtype;
begin
  v_part := public.militar_em_campo(p_participante);
  if not public.permissao_militar(v_part.operacao_id, 'pontos') then
    raise exception 'funcao_nao_liberada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados->'lat') <> 'number' or jsonb_typeof(p_dados->'lng') <> 'number' then
    raise exception 'posicao_invalida';
  end if;
  if p_dados ? 'novo_id' then
    begin
      v_p.id := (p_dados->>'novo_id')::uuid;
    exception when others then
      raise exception 'dados_invalidos';
    end;
    select * into v_p from public.pontos_interesse where id = (p_dados->>'novo_id')::uuid;
    if found then
      if v_p.criado_por is distinct from auth.uid() or v_p.operacao_id <> v_part.operacao_id then
        raise exception 'funcao_nao_liberada';
      end if;
      return row_to_json(v_p);
    end if;
    v_p.id := (p_dados->>'novo_id')::uuid;
  else
    v_p.id := gen_random_uuid();
  end if;
  v_p.operacao_id := v_part.operacao_id;
  v_p.categoria := coalesce(p_dados->>'categoria', 'OUTRO');
  if v_p.categoria not in ('POSSIVEL_LOCALIZACAO', 'VESTIGIO', 'RISCO', 'ENCONTRO', 'BASE', 'OUTRO') then
    raise exception 'dados_invalidos';
  end if;
  v_p.titulo := btrim(coalesce(p_dados->>'titulo', ''));
  if char_length(v_p.titulo) not between 1 and 80 then
    raise exception 'nome_invalido';
  end if;
  v_p.descricao := left(btrim(coalesce(p_dados->>'descricao', '')), 1000);
  v_p.lat := (p_dados->>'lat')::double precision;
  v_p.lng := (p_dados->>'lng')::double precision;
  if v_p.lat not between -90 and 90 or v_p.lng not between -180 and 180 or (v_p.lat = 0 and v_p.lng = 0) then
    raise exception 'posicao_invalida';
  end if;
  v_p.visibilidade := 'publico';
  v_p.criado_por := auth.uid();
  v_p.criado_por_nome := v_part.nome || ' (militar)';
  v_p.criado_em := now();
  v_p.atualizado_em := now();
  v_p.atualizado_por_nome := v_p.criado_por_nome;
  insert into public.pontos_interesse select v_p.*;
  return row_to_json(v_p);
end;
$$;
revoke execute on function public.participante_salvar_ponto(uuid, jsonb) from public, anon;
grant execute on function public.participante_salvar_ponto(uuid, jsonb) to authenticated;

create or replace function public.participante_excluir_ponto(p_participante uuid, p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
begin
  v_part := public.militar_em_campo(p_participante);
  if not public.permissao_militar(v_part.operacao_id, 'pontos') then
    raise exception 'funcao_nao_liberada';
  end if;
  delete from public.pontos_interesse where id = p_id and operacao_id = v_part.operacao_id and criado_por = auth.uid();
  if not found and exists (select 1 from public.pontos_interesse where id = p_id) then
    raise exception 'funcao_nao_liberada';   -- existe, mas não é dele (ou é de outra operação)
  end if;   -- já não existe (exclusão repetida, feita sem internet): nada a fazer
end;
$$;
revoke execute on function public.participante_excluir_ponto(uuid, uuid) from public, anon;
grant execute on function public.participante_excluir_ponto(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
