-- =====================================================================
-- 067 · Grupos: uma pessoa em um grupo só e mensagem para o grupo inteiro
--       (migração idempotente; exige a 008 (grupos) e a 003 (mensagens))
--
--  1. Gatilho em grupo_membros: quem já está em um grupo da operação não entra em outro ao mesmo tempo
--     (erro participante_em_outro_grupo). Vale para o painel (definir_membro) e para o link do grupo
--     (ingressar: quem já está em outro grupo segue na operação, sem entrar neste). Mudar o papel no mesmo
--     grupo continua valendo. Quem já estava em mais de um grupo antes desta migração não é mexido (nada é
--     apagado): basta tirar das sobras pelo painel.
--  2. enviar_mensagem_grupo: a mesma mensagem ou orientação (RETORNE, ATENÇÃO, MUDE A ROTA, PARE, CONFIRME ou
--     texto livre) vai de uma vez para todos os integrantes de campo do grupo (uma mensagem por pessoa, cada
--     uma com a própria entrega/confirmação), usando as regras de enviar_mensagem.
-- =====================================================================

create or replace function public.grupo_membros_um_grupo()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if exists (select 1 from public.grupo_membros
              where participante_id = new.participante_id and grupo_id <> new.grupo_id) then
    raise exception 'participante_em_outro_grupo';
  end if;
  return new;
end;
$$;
revoke execute on function public.grupo_membros_um_grupo() from public, anon, authenticated;
drop trigger if exists grupo_membros_um_grupo_ins on public.grupo_membros;
create trigger grupo_membros_um_grupo_ins before insert on public.grupo_membros
  for each row execute function public.grupo_membros_um_grupo();

-- Entrada pelo link: quem já está em outro grupo não entra neste.
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
revoke execute on function public.ingressar(text, text, text, text, text) from public, anon;
grant execute on function public.ingressar(text, text, text, text, text) to authenticated;

-- A mesma mensagem para todos os integrantes de campo do grupo. Devolve { total, enviadas, falhas, mensagens: [...] }.
create or replace function public.enviar_mensagem_grupo(p_grupo uuid, p_tipo text, p_texto text default '')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_g public.grupos%rowtype;
  v_texto text := btrim(coalesce(p_texto, ''));
  v_m record;
  v_msgs jsonb := '[]'::jsonb;
  v_total integer := 0;
  v_ok integer := 0;
  v_erro text;
begin
  select * into v_g from public.grupos where id = p_grupo;
  if not found or public.nome_responsavel_atual() is null or not public.dono_operacao(v_g.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if (select status from public.operacoes where id = v_g.operacao_id) <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_tipo is null or p_tipo not in ('RETORNE', 'ATENCAO', 'MUDE_ROTA', 'PARE', 'CONFIRME', 'PERSONALIZADA') then
    raise exception 'tipo_invalido';
  end if;
  if char_length(v_texto) > 500 then
    raise exception 'texto_longo';
  end if;
  if p_tipo = 'PERSONALIZADA' and v_texto = '' then
    raise exception 'texto_obrigatorio';
  end if;

  for v_m in
    select p.id
      from public.grupo_membros gm join public.participantes p on p.id = gm.participante_id
     where gm.grupo_id = p_grupo and not p.removido and p.liberado_em is null
       and p.tipo <> 'responsavel' and p.user_id <> auth.uid()
     order by p.nome, p.id
  loop
    v_total := v_total + 1;
    begin
      v_msgs := v_msgs || jsonb_build_array(public.enviar_mensagem(v_m.id, p_tipo, v_texto)::jsonb);
      v_ok := v_ok + 1;
    exception when others then
      v_erro := sqlerrm;   -- ex.: muitas_mensagens (limite de 60 por minuto na operação): o resto segue sem enviar
    end;
  end loop;

  if v_total = 0 then
    raise exception 'grupo_sem_integrantes';
  end if;
  if v_ok = 0 then
    raise exception '%', coalesce(v_erro, 'dados_invalidos');
  end if;
  return json_build_object('total', v_total, 'enviadas', v_ok, 'falhas', v_total - v_ok, 'mensagens', v_msgs);
end;
$$;
revoke execute on function public.enviar_mensagem_grupo(uuid, text, text) from public, anon;
grant execute on function public.enviar_mensagem_grupo(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
