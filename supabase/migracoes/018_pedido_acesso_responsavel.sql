-- =====================================================================
-- 25. PEDIDO DE ACESSO AO PAINEL (migração 018 — idempotente; exige a 017)
--
--  Quem não tem acesso pode pedir o cadastro na tela de login. O pedido
--  fica pendente até um administrador aprovar ou recusar. Só a aprovação
--  cria a linha em responsaveis (acesso ao painel).
--  A conta de login é criada pela função de servidor /api/responsaveis
--  (ação "solicitar"), com a chave secreta. Nenhum acesso direto da tabela.
-- =====================================================================
create table if not exists public.solicitacoes_responsavel (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null unique references auth.users(id) on delete cascade,
  nome         text not null check (char_length(nome) between 2 and 60),
  email        text not null,
  status       text not null default 'pendente' check (status in ('pendente', 'aprovada', 'recusada')),
  criado_em    timestamptz not null default now(),
  decidido_em  timestamptz,
  decidido_por uuid references auth.users(id) on delete set null
);
create index if not exists solicitacoes_responsavel_status_idx on public.solicitacoes_responsavel (status, criado_em);
alter table public.solicitacoes_responsavel enable row level security;
revoke all on public.solicitacoes_responsavel from anon, authenticated;

-- Usada SOMENTE pela função de servidor (chave secreta).
create or replace function public.servidor_criar_solicitacao(p_user uuid, p_nome text, p_email text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.solicitacoes_responsavel (user_id, nome, email)
  values (p_user, btrim(p_nome), lower(btrim(p_email)));
end;
$$;

-- Estado de acesso de quem está logado (pendente, recusada, desativado, ativo ou sem pedido).
create or replace function public.meu_status_acesso()
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_status text;
begin
  if auth.uid() is null then
    return json_build_object('status', 'sem_sessao');
  end if;
  if exists (select 1 from public.responsaveis where user_id = auth.uid()) then
    select case when ativo then 'ativo' else 'desativado' end into v_status
      from public.responsaveis where user_id = auth.uid();
  else
    select status into v_status from public.solicitacoes_responsavel where user_id = auth.uid();
    v_status := coalesce(v_status, 'sem_pedido');
  end if;
  return json_build_object('status', v_status);
end;
$$;

-- Pedidos aguardando decisão (só administradores).
create or replace function public.admin_listar_solicitacoes()
returns json
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.eh_admin() then
    raise exception 'sem_permissao';
  end if;
  return coalesce((
    select json_agg(x order by x.criado_em)
      from (select s.id, s.nome, s.email, s.criado_em
              from public.solicitacoes_responsavel s
             where s.status = 'pendente') x
  ), '[]'::json);
end;
$$;

-- Aprova (vira responsável comum, sem administrador) ou recusa um pedido.
-- Pedido recusado pode ser aprovado depois; pedido já aprovado não muda.
create or replace function public.admin_decidir_solicitacao(p_id uuid, p_aprovar boolean)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  s public.solicitacoes_responsavel%rowtype;
begin
  if not public.eh_admin() then
    raise exception 'sem_permissao';
  end if;
  select * into s from public.solicitacoes_responsavel where id = p_id for update;
  if not found then
    raise exception 'solicitacao_nao_encontrada';
  end if;
  if s.status = 'aprovada' then
    raise exception 'solicitacao_ja_decidida';
  end if;
  if p_aprovar then
    insert into public.responsaveis (user_id, nome) values (s.user_id, s.nome)
    on conflict (user_id) do nothing;
  end if;
  update public.solicitacoes_responsavel
     set status = case when p_aprovar then 'aprovada' else 'recusada' end,
         decidido_em = now(),
         decidido_por = auth.uid()
   where id = p_id;
  return public.admin_listar_solicitacoes();
end;
$$;

revoke execute on function public.servidor_criar_solicitacao(uuid, text, text) from public, anon, authenticated;
grant execute on function public.servidor_criar_solicitacao(uuid, text, text) to service_role;
revoke execute on function public.meu_status_acesso(), public.admin_listar_solicitacoes(), public.admin_decidir_solicitacao(uuid, boolean) from public, anon;
grant execute on function public.meu_status_acesso(), public.admin_listar_solicitacoes(), public.admin_decidir_solicitacao(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
