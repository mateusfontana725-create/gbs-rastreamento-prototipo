-- =====================================================================
-- 051 — Aplicativo Android do participante.
--
--  Passagem do navegador para o aplicativo, sem novo cadastro:
--   app_vinculo_criar(participante): a página do navegador (dona da participação) pede um código de uso único,
--     válido por 30 min. Só o resumo (sha256) do código fica no banco.
--   app_vinculo_resgatar(código): o aplicativo, com a sessão anônima dele, resgata o código. A participação passa
--     para a sessão do aplicativo (mesmo participante, mesma trilha, mesmas mensagens). A página do navegador perde o
--     acesso e mostra que o registro seguiu pelo aplicativo.
--
--  Aparelho com segredo próprio (o serviço de GPS do aplicativo envia mesmo com a tela apagada, sem a sessão do navegador):
--   app_dispositivo_registrar(participante, modelo): devolve { dispositivo_id, segredo } UMA vez; guarda só o resumo.
--     Registrar de novo revoga o aparelho anterior da mesma participação.
--   app_enviar_posicoes(dispositivo, segredo, pontos, gps) e app_sinal_vida(dispositivo, segredo, gps): conferem o segredo
--     e fazem exatamente o que enviar_posicoes_lote e sinal_vida fazem para o dono da participação (mesmas regras:
--     operação encerrada, participante removido ou liberado, horário dos pontos, sem duplicar).
-- =====================================================================

create table if not exists public.app_vinculos (
  codigo_hash      text primary key,
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  criado_por       uuid not null,
  criado_em        timestamptz not null default now(),
  expira_em        timestamptz not null,
  usado_em         timestamptz
);
create index if not exists app_vinculos_participante_idx on public.app_vinculos (participante_id);
alter table public.app_vinculos enable row level security;
revoke all on public.app_vinculos from anon, authenticated;

create table if not exists public.app_dispositivos (
  id               uuid primary key default gen_random_uuid(),
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  segredo_hash     text not null,
  modelo           text not null default '' check (char_length(modelo) <= 80),
  criado_em        timestamptz not null default now(),
  ultimo_uso_em    timestamptz,
  revogado_em      timestamptz
);
create index if not exists app_dispositivos_participante_idx on public.app_dispositivos (participante_id);
alter table public.app_dispositivos enable row level security;
revoke all on public.app_dispositivos from anon, authenticated;

create or replace function public.app_resumo(p_texto text)
returns text
language sql immutable
as $$
  select encode(sha256(convert_to(coalesce(p_texto, ''), 'UTF8')), 'hex');
$$;
revoke execute on function public.app_resumo(text) from public, anon, authenticated;

-- Participação ativa deste usuário (dono), ou erro com o código de sempre.
create or replace function public.app_participacao_ativa(p_participante uuid)
returns public.participantes
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
begin
  if auth.uid() is null then
    raise exception 'nao_autenticado';
  end if;
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
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  if v_op.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  return v_part;
end;
$$;
revoke execute on function public.app_participacao_ativa(uuid) from public, anon, authenticated;

create or replace function public.app_vinculo_criar(p_participante uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype := public.app_participacao_ativa(p_participante);
  v_codigo text := substr(public.gerar_token(), 1, 32);
  v_expira timestamptz := now() + interval '30 minutes';
begin
  delete from public.app_vinculos where participante_id = v_part.id and (usado_em is not null or expira_em < now());
  if (select count(*) from public.app_vinculos where participante_id = v_part.id) >= 10 then
    raise exception 'vinculos_app_limite';
  end if;
  insert into public.app_vinculos (codigo_hash, participante_id, criado_por, expira_em)
  values (public.app_resumo(v_codigo), v_part.id, auth.uid(), v_expira);
  return json_build_object('codigo', v_codigo, 'expira_em', v_expira);
end;
$$;

create or replace function public.app_vinculo_resgatar(p_codigo text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_vinc public.app_vinculos%rowtype;
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
  v_grupo text;
begin
  if auth.uid() is null then
    raise exception 'nao_autenticado';
  end if;
  if p_codigo is null or lower(p_codigo) !~ '^[0-9a-f]{32}$' then
    raise exception 'vinculo_app_recusado';
  end if;
  select * into v_vinc from public.app_vinculos where codigo_hash = public.app_resumo(lower(p_codigo)) for update;
  if not found or v_vinc.usado_em is not null or v_vinc.expira_em < now() then
    raise exception 'vinculo_app_recusado';
  end if;
  select * into v_part from public.participantes where id = v_vinc.participante_id for update;
  if v_part.liberado_em is not null then
    raise exception 'participante_liberado';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
  end if;
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  if v_op.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if v_part.user_id <> auth.uid() and exists (select 1 from public.participantes where operacao_id = v_part.operacao_id and user_id = auth.uid()) then
    raise exception 'sessao_app_ocupada';
  end if;

  update public.app_vinculos set usado_em = now() where codigo_hash = v_vinc.codigo_hash;
  delete from public.app_vinculos where participante_id = v_part.id and codigo_hash <> v_vinc.codigo_hash;
  update public.app_dispositivos set revogado_em = now() where participante_id = v_part.id and revogado_em is null;
  update public.participantes set user_id = auth.uid() where id = v_part.id returning * into v_part;

  select g.nome into v_grupo
    from public.grupo_membros gm join public.grupos g on g.id = gm.grupo_id
   where gm.participante_id = v_part.id
   order by gm.criado_em
   limit 1;
  return json_build_object(
    'participante_id', v_part.id,
    'nome', v_part.nome,
    'tipo', v_part.tipo,
    'cpf', coalesce(v_part.cpf, ''),
    'telefone', coalesce(v_part.telefone, ''),
    'operacao', v_op.codigo,
    'operacao_id', v_op.id,
    'grupo', v_grupo,
    'saida_solicitada_em', v_part.saida_solicitada_em
  );
end;
$$;

create or replace function public.app_dispositivo_registrar(p_participante uuid, p_modelo text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype := public.app_participacao_ativa(p_participante);
  v_segredo text := public.gerar_token();
  v_id uuid;
begin
  update public.app_dispositivos set revogado_em = now() where participante_id = v_part.id and revogado_em is null;
  insert into public.app_dispositivos (participante_id, operacao_id, segredo_hash, modelo)
  values (v_part.id, v_part.operacao_id, public.app_resumo(v_segredo), left(btrim(coalesce(p_modelo, '')), 80))
  returning id into v_id;
  return json_build_object('dispositivo_id', v_id, 'segredo', v_segredo);
end;
$$;

-- Confere o aparelho e devolve o dono atual da participação (o serviço do aplicativo age como ele).
create or replace function public.app_dono_do_dispositivo(p_dispositivo uuid, p_segredo text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_disp public.app_dispositivos%rowtype;
  v_user uuid;
begin
  if p_dispositivo is null or p_segredo is null or p_segredo !~ '^[0-9a-f]{64}$' then
    raise exception 'aparelho_app_invalido';
  end if;
  select * into v_disp from public.app_dispositivos where id = p_dispositivo;
  if not found or v_disp.revogado_em is not null or v_disp.segredo_hash <> public.app_resumo(p_segredo) then
    raise exception 'aparelho_app_invalido';
  end if;
  select user_id into v_user from public.participantes where id = v_disp.participante_id;
  update public.app_dispositivos set ultimo_uso_em = now() where id = v_disp.id;
  -- Só nesta transação: enviar_posicoes_lote e sinal_vida conferem o dono por auth.uid().
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  return v_user;
end;
$$;
revoke execute on function public.app_dono_do_dispositivo(uuid, text) from public, anon, authenticated;

create or replace function public.app_enviar_posicoes(p_dispositivo uuid, p_segredo text, p_pontos jsonb, p_gps text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part uuid;
begin
  perform public.app_dono_do_dispositivo(p_dispositivo, p_segredo);
  select participante_id into v_part from public.app_dispositivos where id = p_dispositivo;
  return public.enviar_posicoes_lote(v_part, p_pontos, p_gps);
end;
$$;

create or replace function public.app_sinal_vida(p_dispositivo uuid, p_segredo text, p_gps text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part uuid;
begin
  perform public.app_dono_do_dispositivo(p_dispositivo, p_segredo);
  select participante_id into v_part from public.app_dispositivos where id = p_dispositivo;
  return public.sinal_vida(v_part, true, p_gps);
end;
$$;

revoke execute on function public.app_vinculo_criar(uuid) from public, anon;
grant execute on function public.app_vinculo_criar(uuid) to authenticated;
revoke execute on function public.app_vinculo_resgatar(text) from public, anon;
grant execute on function public.app_vinculo_resgatar(text) to authenticated;
revoke execute on function public.app_dispositivo_registrar(uuid, text) from public, anon;
grant execute on function public.app_dispositivo_registrar(uuid, text) to authenticated;
-- O serviço do aplicativo chama sem sessão (só com a chave pública): quem autoriza é o segredo do aparelho.
revoke execute on function public.app_enviar_posicoes(uuid, text, jsonb, text) from public;
grant execute on function public.app_enviar_posicoes(uuid, text, jsonb, text) to anon, authenticated;
revoke execute on function public.app_sinal_vida(uuid, text, text) from public;
grant execute on function public.app_sinal_vida(uuid, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
