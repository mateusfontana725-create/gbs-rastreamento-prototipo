-- =====================================================================
-- 35. Nomes no painel e CPF opcional (migração 029 — idempotente; exige a 008 e a 026)
--
--  1) CPF passa a ser OPCIONAL também para civis no ingresso (se informado, continua sendo
--     conferido). O celular segue obrigatório para civis.
--  2) O responsável pode dar um NOME DE EXIBIÇÃO ao participante (ex.: "Sd. Costa – drone"),
--     guardado em participantes.nome_painel. O nome que a pessoa digitou (nome) não muda e
--     um novo ingresso da pessoa não apaga o nome dado pelo responsável. Nome vazio volta
--     ao nome original. Só responsáveis da operação; operação encerrada: só leitura.
-- =====================================================================
alter table public.participantes add column if not exists nome_painel text;
do $$
begin
  alter table public.participantes add constraint participantes_nome_painel_ok
    check (nome_painel is null or char_length(nome_painel) between 2 and 40);
exception when duplicate_object then
  null;
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
  if v_link = 'militar' and p_tipo = 'militar' then
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
    insert into public.grupo_membros (grupo_id, participante_id, operacao_id, papel, origem, adicionado_por_nome)
    values (v_grupo_id, v_part.id, v_op.id, 'membro', 'link', 'link do grupo')
    on conflict (grupo_id, participante_id) do nothing;
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

create or replace function public.renomear_participante(p_participante uuid, p_nome text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
  v_nome text := nullif(btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')), '');
begin
  select * into v_part from public.participantes where id = p_participante;
  if not found or public.nome_responsavel_atual() is null or not public.dono_operacao(v_part.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  if v_op.status <> 'ativa' or v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  if v_nome is not null and char_length(v_nome) not between 2 and 40 then
    raise exception 'nome_invalido';
  end if;
  -- igual ao nome original: não guarda apelido
  if v_nome = v_part.nome then
    v_nome := null;
  end if;
  update public.participantes set nome_painel = v_nome where id = v_part.id returning * into v_part;
  return json_build_object('id', v_part.id, 'nome', v_part.nome, 'nome_painel', v_part.nome_painel);
end;
$$;
revoke execute on function public.renomear_participante(uuid, text) from public, anon;
grant execute on function public.renomear_participante(uuid, text) to authenticated;

notify pgrst, 'reload schema';
