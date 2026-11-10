-- =====================================================================
-- 073 · Link de MILITAR só registra militar; a tela inicial não oferece "civil" nele
--       (migração idempotente; exige a 069 (links e tipos) e a 072)
--
--  1. info_operacao: o link de militares devolve tipos_permitidos = ['militar'] (antes incluía 'civil', e a
--     tela inicial mostrava a escolha). Link de civis e de grupos seguem como antes.
--  2. ingressar: quem entra pelo link de militares é sempre militar, mesmo que a tela envie outro tipo.
--     Link de civis: civil. Link de grupo que permite militar: continua escolhendo, como antes.
-- =====================================================================

create or replace function public.info_operacao(p_token text)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
  v_tipo text;
  v_grupo text;
  v_perm boolean;
  v_opid uuid;
  v_so_militar boolean := false;
begin
  if p_token is null or char_length(p_token) <> 64 then
    return null;
  end if;
  select * into v_op from public.operacoes where token_civil = p_token;
  if found then
    v_tipo := 'civil';
  else
    select * into v_op from public.operacoes where token_militar = p_token;
    if found then
      v_tipo := 'militar';
      v_so_militar := true;
    else
      select g.nome, g.permite_militar, g.operacao_id into v_grupo, v_perm, v_opid
        from public.grupo_convites c join public.grupos g on g.id = c.grupo_id
       where c.token = p_token;
      if v_opid is null then
        return null;
      end if;
      select * into v_op from public.operacoes where id = v_opid;
      v_tipo := case when v_perm then 'militar' else 'civil' end;
    end if;
  end if;
  return json_build_object(
    'operacao', v_op.codigo,
    'ativa', v_op.status = 'ativa',
    'tipos_permitidos', case when v_so_militar then json_build_array('militar')
                             when v_tipo = 'militar' then json_build_array('militar', 'civil') else json_build_array('civil') end,
    'grupo', v_grupo
  );
end;
$$;

create or replace function public.ingressar(p_token text, p_nome text, p_tipo text default 'civil',
                                            p_cpf text default null, p_telefone text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_op public.operacoes%rowtype;
  v_link text;
  v_tipo text;
  v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  v_part public.participantes%rowtype;
  v_total integer;
  v_cpf text := public.cpf_normalizado(p_cpf);
  v_tel text := public.telefone_normalizado(p_telefone);
  v_grupo_id uuid;
  v_grupo_nome text;
  v_perm boolean;
  v_opid uuid;
  v_so_militar boolean := false;
begin
  if v_uid is null then
    raise exception 'nao_autenticado';
  end if;
  if p_token is null or char_length(p_token) <> 64 then
    raise exception 'link_invalido';
  end if;

  select * into v_op from public.operacoes where token_civil = p_token;
  if found then
    v_link := 'civil';
  else
    select * into v_op from public.operacoes where token_militar = p_token;
    if found then
      v_link := 'militar';
      v_so_militar := true;
    else
      select g.id, g.nome, g.permite_militar, g.operacao_id into v_grupo_id, v_grupo_nome, v_perm, v_opid
        from public.grupo_convites c join public.grupos g on g.id = c.grupo_id
       where c.token = p_token;
      if v_grupo_id is null then
        raise exception 'link_invalido';
      end if;
      select * into v_op from public.operacoes where id = v_opid;
      v_link := case when v_perm then 'militar' else 'civil' end;
    end if;
  end if;

  if v_op.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if char_length(v_nome) < 2 or char_length(v_nome) > 40 then
    raise exception 'nome_invalido';
  end if;

  -- O tipo é decidido pelo servidor: o link de civis nunca concede "militar".
  if v_so_militar or (v_link = 'militar' and p_tipo = 'militar') then
    v_tipo := 'militar';
  else
    v_tipo := 'civil';
  end if;

  -- CPF: opcional para todos (se informado, precisa ser válido). Celular: obrigatório para civis.
  if coalesce(btrim(p_cpf), '') <> '' and v_cpf is null then
    raise exception 'cpf_invalido';
  end if;
  if coalesce(btrim(p_telefone), '') <> '' and v_tel is null then
    raise exception 'telefone_invalido';
  end if;
  if v_tipo = 'civil' and v_tel is null then
    raise exception 'telefone_invalido';
  end if;

  select * into v_part from public.participantes where operacao_id = v_op.id and user_id = v_uid;
  if found then
    if v_part.liberado_em is not null then
      raise exception 'participante_liberado';
    end if;
    if v_part.removido or v_part.tipo = 'responsavel' then
      raise exception 'participante_removido';
    end if;
    update public.participantes
       set nome = v_nome, tipo = v_tipo,
           cpf = coalesce(v_cpf, cpf), telefone = coalesce(v_tel, telefone)
     where id = v_part.id returning * into v_part;
  else
    select count(*) into v_total from public.participantes where operacao_id = v_op.id;
    if v_total >= 300 then
      raise exception 'limite_participantes';
    end if;
    insert into public.participantes (operacao_id, user_id, nome, tipo, cpf, telefone)
    values (v_op.id, v_uid, v_nome, v_tipo, v_cpf, v_tel)
    returning * into v_part;
  end if;

  if v_grupo_id is not null then
    if exists (select 1 from public.grupo_membros where participante_id = v_part.id and grupo_id <> v_grupo_id) then
      -- a pessoa só pode estar em um grupo: já está em outro, então não entra neste (a participação segue normal)
      select g.nome into v_grupo_nome
        from public.grupo_membros gm join public.grupos g on g.id = gm.grupo_id
       where gm.participante_id = v_part.id
       order by gm.criado_em limit 1;
    else
      insert into public.grupo_membros (grupo_id, participante_id, operacao_id, papel, origem, adicionado_por_nome)
      values (v_grupo_id, v_part.id, v_op.id, 'membro', 'link', 'link do grupo')
      on conflict (grupo_id, participante_id) do nothing;
    end if;
  end if;

  return json_build_object(
    'participante_id', v_part.id,
    'nome', v_part.nome,
    'tipo', v_part.tipo,
    'operacao', v_op.codigo,
    'operacao_id', v_op.id,
    'saida_solicitada_em', v_part.saida_solicitada_em,
    'grupo', v_grupo_nome
  );
end;
$$;

notify pgrst, 'reload schema';
