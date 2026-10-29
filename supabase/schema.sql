-- =====================================================================
--  RASTREAMENTO SAR — esquema do banco de dados (Supabase / PostgreSQL)
-- ---------------------------------------------------------------------
--  Execute este arquivo INTEIRO no "SQL Editor" do Supabase.
--  Pode ser executado novamente para atualizar funções e políticas.
--
--  Modelo de segurança (resumo):
--   * Militares responsáveis entram com e-mail e senha (Supabase Auth) e
--     só têm acesso ao painel se estiverem cadastrados na tabela
--     "responsaveis" (lista de autorização mantida pelo administrador).
--   * Participantes (civis e militares de campo) recebem uma sessão
--     anônima do Supabase Auth. Eles só conseguem ingressar numa operação
--     apresentando o token secreto do link de convite.
--   * O TIPO (civil/militar) é decidido no servidor a partir do token:
--     o link de civis só permite "civil"; o link de militares permite
--     "militar" ou "civil".
--   * Nenhuma tabela aceita INSERT/UPDATE/DELETE direto do navegador.
--     Toda escrita passa por funções (RPC) que validam permissões e dados.
--   * RLS (Row Level Security) garante que:
--       - o responsável só lê as operações que ele criou;
--       - o participante só lê o próprio cadastro e as próprias mensagens;
--       - nenhum participante lê posições (nem as próprias, nem de outros).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABELAS
-- ---------------------------------------------------------------------

create table if not exists public.responsaveis (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  nome       text not null check (char_length(nome) between 2 and 60),
  criado_em  timestamptz not null default now()
);
-- admin: pode cadastrar e gerenciar responsáveis pelo painel.
-- ativo: false = acesso ao painel suspenso (o cadastro e o histórico continuam).
alter table public.responsaveis add column if not exists admin boolean not null default false;
alter table public.responsaveis add column if not exists ativo boolean not null default true;

-- Se ainda não houver administrador, o primeiro responsável cadastrado vira administrador
-- (vale para bancos que já existiam e para a primeira instalação, pelo gatilho abaixo).
create or replace function public.primeiro_responsavel_admin()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.responsaveis where admin and ativo) then
    new.admin := true;
    new.ativo := true;
  end if;
  return new;
end;
$$;
drop trigger if exists responsaveis_primeiro_admin on public.responsaveis;
create trigger responsaveis_primeiro_admin before insert on public.responsaveis
  for each row execute function public.primeiro_responsavel_admin();
revoke execute on function public.primeiro_responsavel_admin() from public;

update public.responsaveis set admin = true
 where user_id = (select user_id from public.responsaveis where ativo order by criado_em, user_id limit 1)
   and not exists (select 1 from public.responsaveis where admin and ativo);

create table if not exists public.operacoes (
  id                 uuid primary key default gen_random_uuid(),
  codigo             text not null check (char_length(codigo) between 2 and 80),
  responsavel_id     uuid not null references auth.users(id) on delete cascade,
  token_civil        text not null unique,
  token_militar      text not null unique,
  status             text not null default 'ativa' check (status in ('ativa', 'encerrada')),
  retencao_horas     integer not null default 0 check (retencao_horas between 0 and 2160),
  criada_em          timestamptz not null default now(),
  encerrada_em       timestamptz,
  expira_em          timestamptz,
  dados_apagados_em  timestamptz
);
create index if not exists operacoes_responsavel_idx on public.operacoes (responsavel_id, criada_em desc);

create table if not exists public.participantes (
  id                 uuid primary key default gen_random_uuid(),
  operacao_id        uuid not null references public.operacoes(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  nome               text not null check (char_length(nome) between 2 and 40),
  tipo               text not null check (tipo in ('civil', 'militar', 'responsavel')),
  removido           boolean not null default false,
  rastreando         boolean not null default false,
  gps_estado         text not null default 'aguardando'
                     check (gps_estado in ('aguardando', 'ok', 'fraco', 'sem_sinal', 'negado', 'indisponivel')),
  ultima_lat         double precision,
  ultima_lng         double precision,
  ultima_precisao    real,
  ultima_posicao_em  timestamptz,
  ultimo_contato_em  timestamptz,
  criado_em          timestamptz not null default now(),
  unique (operacao_id, user_id)
);
-- Dados de identificação (visíveis só aos responsáveis da operação; apagados com ela)
-- e pedido de encerramento feito pelo participante.
alter table public.participantes add column if not exists cpf text;
alter table public.participantes add column if not exists telefone text;
alter table public.participantes add column if not exists saida_solicitada_em timestamptz;
alter table public.participantes add column if not exists saida_motivo text;
alter table public.participantes add column if not exists liberado_em timestamptz;

-- Atualização de bancos criados pela versão anterior: aceita o tipo "responsavel"
-- (presença e posição do responsável no mapa, visível só para os responsáveis).
alter table public.participantes drop constraint if exists participantes_tipo_check;
alter table public.participantes add constraint participantes_tipo_check
  check (tipo in ('civil', 'militar', 'responsavel'));
create index if not exists participantes_operacao_idx on public.participantes (operacao_id);
create index if not exists participantes_user_idx on public.participantes (user_id);

create table if not exists public.posicoes (
  id               bigint generated always as identity primary key,
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  client_id        uuid not null,          -- gerado no celular; evita pontos duplicados
  lat              double precision not null check (lat between -90 and 90),
  lng              double precision not null check (lng between -180 and 180),
  precisao         real check (precisao >= 0),
  registrado_em    timestamptz not null,   -- horário em que o GPS obteve a posição
  recebido_em      timestamptz not null default now(),
  unique (participante_id, client_id)
);
create index if not exists posicoes_operacao_idx on public.posicoes (operacao_id, id);
create index if not exists posicoes_participante_idx on public.posicoes (participante_id, registrado_em desc);

create table if not exists public.mensagens (
  id               uuid primary key default gen_random_uuid(),
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  remetente_id     uuid not null references auth.users(id) on delete cascade,
  remetente_nome   text not null,
  tipo             text not null check (tipo in ('RETORNE', 'ATENCAO', 'MUDE_ROTA', 'PARE', 'CONFIRME', 'PERSONALIZADA')),
  texto            text not null default '' check (char_length(texto) <= 500),
  criada_em        timestamptz not null default now(),
  entregue_em      timestamptz,   -- o aparelho do participante recebeu
  confirmada_em    timestamptz,   -- o participante tocou em confirmar
  resposta         text check (resposta in ('CIENTE', 'ESTOU_BEM', 'PRECISO_AJUDA'))
);
create index if not exists mensagens_participante_idx on public.mensagens (participante_id, criada_em desc);

-- Mensagens nos dois sentidos:
--   direcao 'saida'   = do responsável para o participante (comandos e mensagens livres)
--   direcao 'entrada' = do participante para os responsáveis (mensagens e relatos de campo)
alter table public.mensagens add column if not exists direcao text not null default 'saida';
alter table public.mensagens add column if not exists categoria text;
alter table public.mensagens add column if not exists lat double precision;
alter table public.mensagens add column if not exists lng double precision;
alter table public.mensagens add column if not exists precisao real;
alter table public.mensagens add column if not exists posicao_em timestamptz;
alter table public.mensagens add column if not exists lida_em timestamptz;
alter table public.mensagens add column if not exists lida_por_nome text;
alter table public.mensagens add column if not exists client_id uuid;
alter table public.mensagens drop constraint if exists mensagens_direcao_check;
alter table public.mensagens add constraint mensagens_direcao_check check (direcao in ('saida', 'entrada'));
alter table public.mensagens drop constraint if exists mensagens_categoria_check;
alter table public.mensagens add constraint mensagens_categoria_check
  check (categoria is null or categoria in ('MENSAGEM', 'OBJETO', 'VESTIGIO', 'PISTA', 'OBSTACULO', 'OUTRO', 'AJUDA'));
alter table public.mensagens drop constraint if exists mensagens_tipo_check;
alter table public.mensagens add constraint mensagens_tipo_check
  check (tipo in ('RETORNE', 'ATENCAO', 'MUDE_ROTA', 'PARE', 'CONFIRME', 'PERSONALIZADA', 'PARTICIPANTE'));
alter table public.mensagens drop constraint if exists mensagens_texto_check;
alter table public.mensagens add constraint mensagens_texto_check check (char_length(texto) <= 1000);
create unique index if not exists mensagens_cliente_unico on public.mensagens (participante_id, client_id) where client_id is not null;
create index if not exists mensagens_entrada_idx on public.mensagens (operacao_id, direcao, lida_em);

-- Fotografias georreferenciadas. O arquivo fica no Storage (bucket privado "fotos"),
-- no caminho <operacao_id>/<participante_id>/<client_id>.jpg. A foto é um registro
-- de uma posição: não altera a trilha.
create table if not exists public.fotos (
  id               uuid primary key default gen_random_uuid(),
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  autor_nome       text not null,
  autor_tipo       text not null,
  client_id        uuid not null,
  caminho          text not null unique,
  lat              double precision check (lat between -90 and 90),
  lng              double precision check (lng between -180 and 180),
  precisao         real check (precisao >= 0),
  posicao_em       timestamptz,
  origem_posicao   text not null check (origem_posicao in ('gps', 'exif', 'nenhuma')),
  capturada_em     timestamptz,
  registrada_em    timestamptz not null default now(),
  legenda          text not null default '' check (char_length(legenda) <= 300),
  bytes            integer,
  largura          integer,
  altura           integer,
  unique (participante_id, client_id),
  check ((lat is null) = (lng is null))
);
create index if not exists fotos_operacao_idx on public.fotos (operacao_id, registrada_em);

-- Arquivos do Storage que precisam ser apagados (fotos de operações excluídas ou
-- com retenção vencida). O painel apaga na hora; o que falhar é apagado pela
-- limpeza diária. Assim nenhum arquivo fica esquecido.
create table if not exists public.arquivos_pendentes (
  caminho       text primary key,
  bucket        text not null default 'fotos',
  operacao_id   uuid,
  excluido_por  uuid,
  criado_em     timestamptz not null default now(),
  tentativas    integer not null default 0,
  ultimo_erro   text
);
create index if not exists mensagens_operacao_idx on public.mensagens (operacao_id, criada_em);

-- Responsáveis adicionais de cada operação (além de quem a criou).
-- Todos veem o mesmo painel e podem enviar orientações; precisam continuar
-- cadastrados em "responsaveis" para ter acesso.
create table if not exists public.operacao_responsaveis (
  operacao_id     uuid not null references public.operacoes(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  adicionado_por  uuid references auth.users(id) on delete set null,
  criado_em       timestamptz not null default now(),
  primary key (operacao_id, user_id)
);
create index if not exists operacao_responsaveis_user_idx on public.operacao_responsaveis (user_id);

-- ---------------------------------------------------------------------
-- 2. FUNÇÕES AUXILIARES DE AUTORIZAÇÃO
-- ---------------------------------------------------------------------

create or replace function public.eh_responsavel()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.responsaveis where user_id = auth.uid() and ativo);
$$;

create or replace function public.eh_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.responsaveis where user_id = auth.uid() and ativo and admin);
$$;

create or replace function public.dono_operacao(p_operacao uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  -- Criador ou responsável adicionado à operação, e ainda autorizado em "responsaveis".
  select public.eh_responsavel() and exists (
    select 1
      from public.operacoes o
     where o.id = p_operacao
       and (o.responsavel_id = auth.uid()
            or exists (select 1 from public.operacao_responsaveis m
                        where m.operacao_id = o.id and m.user_id = auth.uid()))
  );
$$;

create or replace function public.eh_criador(p_operacao uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.eh_responsavel() and exists (
    select 1 from public.operacoes where id = p_operacao and responsavel_id = auth.uid()
  );
$$;

create or replace function public.eh_meu_participante(p_participante uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.participantes
     where id = p_participante and user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY (somente leitura pelo navegador)
-- ---------------------------------------------------------------------

alter table public.responsaveis  enable row level security;
alter table public.operacoes     enable row level security;
alter table public.participantes enable row level security;
alter table public.posicoes      enable row level security;
alter table public.mensagens     enable row level security;
alter table public.operacao_responsaveis enable row level security;
alter table public.fotos enable row level security;
alter table public.arquivos_pendentes enable row level security;   -- sem políticas: ninguém lê pelo navegador

drop policy if exists responsaveis_ler_proprio on public.responsaveis;
create policy responsaveis_ler_proprio on public.responsaveis
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists operacoes_ler_dono on public.operacoes;
create policy operacoes_ler_dono on public.operacoes
  for select to authenticated
  using (public.dono_operacao(id));

drop policy if exists participantes_ler on public.participantes;
create policy participantes_ler on public.participantes
  for select to authenticated
  using (user_id = auth.uid() or public.dono_operacao(operacao_id));

drop policy if exists posicoes_ler_dono on public.posicoes;
create policy posicoes_ler_dono on public.posicoes
  for select to authenticated
  using (public.dono_operacao(operacao_id));

drop policy if exists mensagens_ler on public.mensagens;
create policy mensagens_ler on public.mensagens
  for select to authenticated
  using (public.dono_operacao(operacao_id) or public.eh_meu_participante(participante_id));

drop policy if exists fotos_ler on public.fotos;
create policy fotos_ler on public.fotos
  for select to authenticated
  using (public.dono_operacao(operacao_id) or public.eh_meu_participante(participante_id));

drop policy if exists operacao_responsaveis_ler on public.operacao_responsaveis;
create policy operacao_responsaveis_ler on public.operacao_responsaveis
  for select to authenticated
  using (public.dono_operacao(operacao_id));

-- Defesa em profundidade: o navegador nunca escreve direto nas tabelas.
revoke all on public.responsaveis, public.operacoes, public.participantes, public.posicoes, public.mensagens, public.operacao_responsaveis, public.fotos, public.arquivos_pendentes from anon;
revoke insert, update, delete, truncate on public.responsaveis, public.operacoes, public.participantes, public.posicoes, public.mensagens, public.operacao_responsaveis, public.fotos from authenticated;
revoke all on public.arquivos_pendentes from authenticated;
grant select on public.responsaveis, public.operacoes, public.participantes, public.posicoes, public.mensagens, public.operacao_responsaveis, public.fotos to authenticated;

-- ---------------------------------------------------------------------
-- 4. FUNÇÕES (RPC) — RESPONSÁVEL MILITAR
-- ---------------------------------------------------------------------

create or replace function public.gerar_token()
returns text
language sql volatile
as $$
  -- 2 UUIDs aleatórios = 244 bits de entropia
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
$$;

create or replace function public.criar_operacao(p_codigo text, p_retencao_horas integer default 0)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_codigo text := btrim(regexp_replace(coalesce(p_codigo, ''), '\s+', ' ', 'g'));
  v_op public.operacoes%rowtype;
begin
  if not public.eh_responsavel() then
    raise exception 'sem_permissao';
  end if;
  if char_length(v_codigo) < 2 or char_length(v_codigo) > 80 then
    raise exception 'codigo_invalido';
  end if;
  if p_retencao_horas is null or p_retencao_horas not in (0, 24, 72, 168, 720) then
    raise exception 'retencao_invalida';
  end if;

  insert into public.operacoes (codigo, responsavel_id, token_civil, token_militar, retencao_horas)
  values (v_codigo, auth.uid(), public.gerar_token(), public.gerar_token(), p_retencao_horas)
  returning * into v_op;

  return row_to_json(v_op);
end;
$$;

create or replace function public.encerrar_operacao(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;

  update public.operacoes
     set status = 'encerrada',
         encerrada_em = now(),
         expira_em = now() + make_interval(hours => retencao_horas)
   where id = p_operacao and status = 'ativa'
  returning * into v_op;

  if not found then
    select * into v_op from public.operacoes where id = p_operacao;
    return row_to_json(v_op);
  end if;

  update public.participantes set rastreando = false where operacao_id = p_operacao;

  if v_op.retencao_horas = 0 then
    delete from public.participantes where operacao_id = p_operacao;  -- apaga posições e mensagens em cascata
    update public.operacoes set dados_apagados_em = now() where id = p_operacao returning * into v_op;
  end if;

  return row_to_json(v_op);
end;
$$;

create or replace function public.apagar_dados_operacao(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if v_op.status <> 'encerrada' then
    raise exception 'operacao_ativa';
  end if;

  delete from public.participantes where operacao_id = p_operacao;
  update public.operacoes set dados_apagados_em = now(), expira_em = coalesce(least(expira_em, now()), now())
   where id = p_operacao returning * into v_op;

  return row_to_json(v_op);
end;
$$;

create or replace function public.remover_participante(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_op uuid;
begin
  select operacao_id into v_op from public.participantes where id = p_participante and tipo <> 'responsavel';
  if v_op is null or not public.dono_operacao(v_op) then
    raise exception 'sem_permissao';
  end if;
  update public.participantes set removido = true, rastreando = false where id = p_participante;
end;
$$;

create or replace function public.enviar_mensagem(p_participante uuid, p_tipo text, p_texto text default '')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_nome text;
  v_texto text := btrim(coalesce(p_texto, ''));
  v_msg public.mensagens%rowtype;
  v_recentes integer;
begin
  select * into v_part from public.participantes where id = p_participante;
  if not found or not public.dono_operacao(v_part.operacao_id) or v_part.user_id = auth.uid() then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
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

  -- proteção contra envio em massa acidental
  select count(*) into v_recentes from public.mensagens
   where operacao_id = v_part.operacao_id and direcao = 'saida' and criada_em > now() - interval '1 minute';
  if v_recentes >= 60 then
    raise exception 'muitas_mensagens';
  end if;

  select nome into v_nome from public.responsaveis where user_id = auth.uid();

  insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto)
  values (v_part.operacao_id, v_part.id, auth.uid(), v_nome, p_tipo, v_texto)
  returning * into v_msg;

  return row_to_json(v_msg);
end;
$$;

-- ---------------------------------------------------------------------
-- 4a. ADMINISTRAÇÃO DOS RESPONSÁVEIS (tela "Responsáveis" do painel)
--     A criação do login (e-mail e senha) é feita pela função de servidor
--     /api/responsaveis, que usa a chave secreta; o resto é feito aqui.
-- ---------------------------------------------------------------------

create or replace function public.admin_listar_responsaveis()
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v json;
begin
  if not public.eh_admin() then
    raise exception 'sem_permissao';
  end if;
  select coalesce(json_agg(x order by x.ativo desc, x.nome), '[]'::json) into v
    from (
      select r.user_id, r.nome, u.email, r.admin, r.ativo, r.criado_em,
             u.last_sign_in_at as ultimo_acesso,
             r.user_id = auth.uid() as eu
        from public.responsaveis r
        join auth.users u on u.id = r.user_id
    ) x;
  return v;
end;
$$;

-- Altera nome, administrador e ativo. Protege contra ficar sem administrador.
create or replace function public.admin_alterar_responsavel(p_user uuid, p_nome text default null,
                                                            p_admin boolean default null, p_ativo boolean default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := nullif(btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')), '');
begin
  if not public.eh_admin() then
    raise exception 'sem_permissao';
  end if;
  if not exists (select 1 from public.responsaveis where user_id = p_user) then
    raise exception 'responsavel_nao_encontrado';
  end if;
  if p_user = auth.uid() and (p_admin = false or p_ativo = false) then
    raise exception 'nao_pode_alterar_a_si';
  end if;
  if v_nome is not null and (char_length(v_nome) < 2 or char_length(v_nome) > 60) then
    raise exception 'nome_invalido';
  end if;
  update public.responsaveis
     set nome = coalesce(v_nome, nome),
         admin = coalesce(p_admin, admin),
         ativo = coalesce(p_ativo, ativo)
   where user_id = p_user;
  if not exists (select 1 from public.responsaveis where admin and ativo) then
    raise exception 'ultimo_admin';
  end if;
  return public.admin_listar_responsaveis();
end;
$$;

-- Usadas SOMENTE pela função de servidor (chave secreta), nunca pelo navegador.
create or replace function public.servidor_usuario_por_email(p_email text)
returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object('user_id', u.id, 'responsavel', r.user_id is not null)
    from auth.users u
    left join public.responsaveis r on r.user_id = u.id
   where lower(u.email) = lower(btrim(coalesce(p_email, '')))
   limit 1;
$$;

create or replace function public.servidor_salvar_responsavel(p_user uuid, p_nome text, p_admin boolean default false)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
begin
  if char_length(v_nome) < 2 or char_length(v_nome) > 60 then
    raise exception 'nome_invalido';
  end if;
  insert into public.responsaveis (user_id, nome, admin, ativo)
  values (p_user, v_nome, coalesce(p_admin, false), true)
  on conflict (user_id) do update set nome = excluded.nome, admin = excluded.admin, ativo = true;
end;
$$;

create or replace function public.servidor_eh_responsavel(p_user uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.responsaveis where user_id = p_user);
$$;

-- ---------------------------------------------------------------------
-- 4b. EQUIPE DE RESPONSÁVEIS E PRESENÇA DO COMANDO NO MAPA
-- ---------------------------------------------------------------------

-- Lista os responsáveis da operação (criador primeiro).
create or replace function public.listar_responsaveis(p_operacao uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_lista json;
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select coalesce(json_agg(x order by x.criador desc, x.nome), '[]'::json) into v_lista
    from (
      select o.responsavel_id as user_id, r.nome, u.email, true as criador
        from public.operacoes o
        join public.responsaveis r on r.user_id = o.responsavel_id
        join auth.users u on u.id = o.responsavel_id
       where o.id = p_operacao
      union all
      select m.user_id, r.nome, u.email, false
        from public.operacao_responsaveis m
        join public.operacoes o on o.id = m.operacao_id
        join public.responsaveis r on r.user_id = m.user_id
        join auth.users u on u.id = m.user_id
       where m.operacao_id = p_operacao and m.user_id <> o.responsavel_id
    ) x;
  return v_lista;
end;
$$;

-- Qualquer responsável da operação pode adicionar outro responsável cadastrado, pelo e-mail.
create or replace function public.adicionar_responsavel(p_operacao uuid, p_email text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid;
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select u.id into v_uid
    from auth.users u
    join public.responsaveis r on r.user_id = u.id and r.ativo
   where lower(u.email) = lower(btrim(coalesce(p_email, '')))
   limit 1;
  if v_uid is null then
    raise exception 'responsavel_nao_encontrado';
  end if;
  if not exists (select 1 from public.operacoes where id = p_operacao and responsavel_id = v_uid) then
    insert into public.operacao_responsaveis (operacao_id, user_id, adicionado_por)
    values (p_operacao, v_uid, auth.uid())
    on conflict do nothing;
  end if;
  return public.listar_responsaveis(p_operacao);
end;
$$;

-- Só quem criou a operação remove responsáveis (e não pode remover a si mesmo).
create or replace function public.remover_responsavel(p_operacao uuid, p_user uuid)
returns json
language plpgsql security definer set search_path = public
as $$
begin
  if not public.eh_criador(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if p_user = auth.uid() then
    raise exception 'sem_permissao';
  end if;
  delete from public.operacao_responsaveis where operacao_id = p_operacao and user_id = p_user;
  delete from public.participantes where operacao_id = p_operacao and user_id = p_user and tipo = 'responsavel';
  return public.listar_responsaveis(p_operacao);
end;
$$;

-- Registra o responsável no mapa da operação (presença). A posição só é
-- enviada quando ele liga "Minha posição" (usa enviar_posicoes/sinal_vida).
-- Civis e militares de campo nunca veem estes registros.
create or replace function public.entrar_como_responsavel(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
  v_nome text;
  v_part public.participantes%rowtype;
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  select left(nome, 40) into v_nome from public.responsaveis where user_id = auth.uid();

  insert into public.participantes (operacao_id, user_id, nome, tipo, ultimo_contato_em)
  values (p_operacao, auth.uid(), v_nome, 'responsavel', now())
  on conflict (operacao_id, user_id) do update
     set nome = excluded.nome, tipo = 'responsavel', removido = false, ultimo_contato_em = now()
  returning * into v_part;

  return row_to_json(v_part);
end;
$$;

-- ---------------------------------------------------------------------
-- 4c. VALIDAÇÃO DE CPF E TELEFONE
-- ---------------------------------------------------------------------

-- Devolve só os 11 dígitos do CPF se ele for válido (dígitos verificadores), ou nulo.
create or replace function public.cpf_normalizado(p_cpf text)
returns text
language plpgsql immutable
as $$
declare
  d text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g');
  soma integer;
  dv integer;
  i integer;
begin
  if char_length(d) <> 11 or d ~ '^(\d)\1{10}$' then
    return null;
  end if;
  for k in 1..2 loop
    soma := 0;
    for i in 1..(8 + k) loop
      soma := soma + substr(d, i, 1)::integer * (10 + k - i);
    end loop;
    dv := (soma * 10) % 11;
    if dv = 10 then dv := 0; end if;
    if dv <> substr(d, 9 + k, 1)::integer then
      return null;
    end if;
  end loop;
  return d;
end;
$$;

-- Celular brasileiro: DDD + número (10 ou 11 dígitos), aceitando +55 na frente.
create or replace function public.telefone_normalizado(p_tel text)
returns text
language sql immutable
as $$
  select case
    when d ~ '^55[1-9][0-9]9?[0-9]{8}$' and char_length(d) in (12, 13) then substr(d, 3)
    when d ~ '^[1-9][0-9]9?[0-9]{8}$' and char_length(d) in (10, 11) then d
    else null end
  from (select regexp_replace(coalesce(p_tel, ''), '\D', '', 'g') as d) x;
$$;

-- ---------------------------------------------------------------------
-- 4d. ENCERRAMENTO DA PARTICIPAÇÃO: o participante pede, o responsável libera
-- ---------------------------------------------------------------------

-- O participante não interrompe o rastreamento sozinho: ele pede ao responsável.
create or replace function public.solicitar_saida(p_participante uuid, p_motivo text default '')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found or v_part.tipo = 'responsavel' then
    raise exception 'participante_invalido';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  update public.participantes
     set saida_solicitada_em = coalesce(saida_solicitada_em, now()),
         saida_motivo = left(btrim(coalesce(p_motivo, '')), 200),
         ultimo_contato_em = now()
   where id = v_part.id
  returning * into v_part;
  return json_build_object('saida_solicitada_em', v_part.saida_solicitada_em);
end;
$$;

-- O responsável libera a saída: o celular para de enviar e mostra "participação encerrada".
create or replace function public.liberar_participante(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_op uuid;
begin
  select operacao_id into v_op from public.participantes where id = p_participante and tipo <> 'responsavel';
  if v_op is null or not public.dono_operacao(v_op) then
    raise exception 'sem_permissao';
  end if;
  update public.participantes
     set liberado_em = coalesce(liberado_em, now()), removido = true, rastreando = false
   where id = p_participante;
end;
$$;

-- O responsável pede para o participante continuar (desfaz o pedido de saída).
create or replace function public.recusar_saida(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_op uuid;
begin
  select operacao_id into v_op from public.participantes where id = p_participante and tipo <> 'responsavel';
  if v_op is null or not public.dono_operacao(v_op) then
    raise exception 'sem_permissao';
  end if;
  update public.participantes set saida_solicitada_em = null, saida_motivo = null where id = p_participante;
end;
$$;

-- ---------------------------------------------------------------------
-- 4e. MENSAGENS E RELATOS ENVIADOS PELOS PARTICIPANTES
-- ---------------------------------------------------------------------

-- O participante escreve aos responsáveis (mensagem livre ou relato de campo:
-- objeto, vestígio, possível pista, obstáculo, outro) ou pedido de ajuda, com localização opcional.
-- client_id torna o reenvio (após falta de internet) seguro: não duplica.
create or replace function public.participante_enviar_mensagem(
  p_participante uuid, p_categoria text, p_texto text,
  p_lat double precision default null, p_lng double precision default null,
  p_precisao real default null, p_posicao_em timestamptz default null, p_client_id uuid default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_texto text := btrim(coalesce(p_texto, ''));
  v_cat text := coalesce(p_categoria, 'MENSAGEM');
  v_msg public.mensagens%rowtype;
  v_recentes integer;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found or v_part.tipo = 'responsavel' then
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
  -- AJUDA = botão "Preciso de ajuda" da página do participante (alarme no painel)
  if v_cat not in ('MENSAGEM', 'OBJETO', 'VESTIGIO', 'PISTA', 'OBSTACULO', 'OUTRO', 'AJUDA') then
    raise exception 'tipo_invalido';
  end if;
  if v_texto = '' then
    raise exception 'texto_obrigatorio';
  end if;
  if char_length(v_texto) > 1000 then
    raise exception 'texto_longo';
  end if;
  -- Localização: só a que o aparelho informou; nunca é inventada.
  if (p_lat is null) <> (p_lng is null)
     or (p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0))) then
    raise exception 'posicao_invalida';
  end if;

  if p_client_id is not null then
    select * into v_msg from public.mensagens where participante_id = v_part.id and client_id = p_client_id;
    if found then
      return row_to_json(v_msg);   -- reenvio: já estava gravada
    end if;
  end if;

  select count(*) into v_recentes from public.mensagens
   where participante_id = v_part.id and direcao = 'entrada' and criada_em > now() - interval '1 minute';
  if v_recentes >= 20 then
    raise exception 'muitas_mensagens';
  end if;

  insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto,
                                direcao, categoria, lat, lng, precisao, posicao_em, client_id, entregue_em)
  values (v_part.operacao_id, v_part.id, auth.uid(), v_part.nome, 'PARTICIPANTE', v_texto,
          'entrada', v_cat, p_lat, p_lng,
          case when p_precisao between 0 and 100000 then p_precisao end,
          case when p_lat is not null then least(coalesce(p_posicao_em, now()), now()) end,
          p_client_id, now())
  returning * into v_msg;

  update public.participantes set ultimo_contato_em = now() where id = v_part.id;
  return row_to_json(v_msg);
end;
$$;

-- Os responsáveis marcam como lidas as mensagens recebidas (o participante vê "lida por …").
create or replace function public.marcar_lidas(p_ids uuid[])
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text;
  v_qtd integer;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_ids) > 500 then
    raise exception 'lote_invalido';
  end if;
  select nome into v_nome from public.responsaveis where user_id = auth.uid() and ativo;
  if v_nome is null then
    raise exception 'sem_permissao';
  end if;
  update public.mensagens m
     set lida_em = now(), lida_por_nome = v_nome
   where m.id = any (p_ids)
     and m.direcao = 'entrada'
     and m.lida_em is null
     and public.dono_operacao(m.operacao_id);
  get diagnostics v_qtd = row_count;
  return v_qtd;
end;
$$;

-- ---------------------------------------------------------------------
-- 4f. FOTOGRAFIAS GEORREFERENCIADAS
-- ---------------------------------------------------------------------

-- Caminho válido: <operacao_id>/<participante_id>/<client_id>.jpg  → {operacao, participante, client}
create or replace function public.caminho_foto_partes(p_nome text)
returns uuid[]
language plpgsql immutable
as $$
begin
  if coalesce(p_nome, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$' then
    return null;
  end if;
  return array[split_part(p_nome, '/', 1)::uuid, split_part(p_nome, '/', 2)::uuid,
               replace(split_part(p_nome, '/', 3), '.jpg', '')::uuid];
end;
$$;

-- Regras do Storage (bucket "fotos"):
--   enviar: só o próprio participante, na pasta dele, com a operação ativa;
--   ver: responsáveis da operação ou o próprio autor;
--   apagar: só arquivos cujo registro já foi excluído (fila arquivos_pendentes).
create or replace function public.pode_enviar_foto(p_nome text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v uuid[] := public.caminho_foto_partes(p_nome);
begin
  if v is null then
    return false;
  end if;
  return exists (
    select 1 from public.participantes p
      join public.operacoes o on o.id = p.operacao_id
     where p.id = v[2] and p.operacao_id = v[1] and p.user_id = auth.uid()
       and not p.removido and p.liberado_em is null and o.status = 'ativa');
end;
$$;

create or replace function public.pode_ver_foto(p_nome text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v uuid[] := public.caminho_foto_partes(p_nome);
begin
  if v is null then
    return false;
  end if;
  return public.dono_operacao(v[1])
      or exists (select 1 from public.participantes where id = v[2] and operacao_id = v[1] and user_id = auth.uid())
      -- quem excluiu a operação precisa "ver" o arquivo para conseguir apagá-lo do Storage
      or exists (select 1 from public.arquivos_pendentes a where a.caminho = p_nome and a.excluido_por = auth.uid());
end;
$$;

create or replace function public.pode_apagar_foto(p_nome text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  return exists (
    select 1 from public.arquivos_pendentes a
     where a.caminho = p_nome and a.bucket = 'fotos'
       and (a.excluido_por = auth.uid() or (a.operacao_id is not null and public.dono_operacao(a.operacao_id))));
end;
$$;

-- Depois de enviar o arquivo ao Storage, o aparelho registra a foto.
create or replace function public.registrar_foto(
  p_participante uuid, p_client_id uuid, p_origem text,
  p_lat double precision default null, p_lng double precision default null, p_precisao real default null,
  p_posicao_em timestamptz default null, p_capturada_em timestamptz default null, p_legenda text default '',
  p_bytes integer default null, p_largura integer default null, p_altura integer default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_caminho text;
  v_foto public.fotos%rowtype;
  v_captura timestamptz := p_capturada_em;
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
  if p_client_id is null then
    raise exception 'foto_invalida';
  end if;

  select * into v_foto from public.fotos where participante_id = v_part.id and client_id = p_client_id;
  if found then
    return row_to_json(v_foto);   -- reenvio: já estava registrada
  end if;

  v_caminho := v_part.operacao_id || '/' || v_part.id || '/' || p_client_id || '.jpg';
  if not exists (select 1 from storage.objects where bucket_id = 'fotos' and name = v_caminho) then
    raise exception 'foto_nao_enviada';
  end if;

  if p_origem is null or p_origem not in ('gps', 'exif', 'nenhuma') then
    raise exception 'foto_invalida';
  end if;
  if p_origem = 'nenhuma' and (p_lat is not null or p_lng is not null) then
    raise exception 'posicao_invalida';
  end if;
  if p_origem <> 'nenhuma' and (p_lat is null or p_lng is null or p_lat not between -90 and 90
       or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0)) then
    raise exception 'posicao_invalida';
  end if;
  if v_captura is not null and (v_captura > now() + interval '2 minutes' or v_captura < '2000-01-01') then
    v_captura := null;
  end if;

  insert into public.fotos (operacao_id, participante_id, autor_nome, autor_tipo, client_id, caminho,
                            lat, lng, precisao, posicao_em, origem_posicao, capturada_em, legenda,
                            bytes, largura, altura)
  values (v_part.operacao_id, v_part.id, v_part.nome, v_part.tipo, p_client_id, v_caminho,
          p_lat, p_lng, case when p_precisao between 0 and 100000 then p_precisao end,
          case when p_lat is not null then least(coalesce(p_posicao_em, now()), now()) end,
          p_origem, v_captura, left(btrim(coalesce(p_legenda, '')), 300),
          case when p_bytes between 0 and 20000000 then p_bytes end,
          case when p_largura between 1 and 20000 then p_largura end,
          case when p_altura between 1 and 20000 then p_altura end)
  returning * into v_foto;

  update public.participantes set ultimo_contato_em = now() where id = v_part.id;
  return row_to_json(v_foto);
end;
$$;

-- Toda foto excluída (por exclusão da operação, retenção vencida etc.) entra na
-- fila de arquivos a apagar do Storage.
create or replace function public.fila_apagar_arquivo()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
  values (old.caminho, 'fotos', old.operacao_id, auth.uid())
  on conflict (caminho) do nothing;
  return old;
end;
$$;
drop trigger if exists fotos_apagar_arquivo on public.fotos;
create trigger fotos_apagar_arquivo after delete on public.fotos
  for each row execute function public.fila_apagar_arquivo();

-- Arquivos que este responsável deve apagar do Storage (após excluir dados).
create or replace function public.meus_arquivos_pendentes()
returns json
language sql stable security definer set search_path = public
as $$
  select coalesce(json_agg(caminho), '[]'::json)
    from (select caminho from public.arquivos_pendentes
           where excluido_por = auth.uid() order by criado_em limit 1000) x;
$$;

-- Tira da fila os arquivos que de fato já não existem no Storage.
create or replace function public.confirmar_arquivos_removidos(p_caminhos text[])
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_qtd integer;
begin
  delete from public.arquivos_pendentes a
   where a.caminho = any (coalesce(p_caminhos, '{}'))
     and a.excluido_por = auth.uid()
     and not exists (select 1 from storage.objects o where o.bucket_id = a.bucket and o.name = a.caminho);
  get diagnostics v_qtd = row_count;
  return v_qtd;
end;
$$;

-- Usadas só pela limpeza diária (chave secreta).
create or replace function public.servidor_arquivos_pendentes(p_limite integer default 500)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v json;
begin
  -- primeiro, tira da fila o que já não existe
  delete from public.arquivos_pendentes a
   where not exists (select 1 from storage.objects o where o.bucket_id = a.bucket and o.name = a.caminho);
  with x as (
    update public.arquivos_pendentes set tentativas = tentativas + 1
     where caminho in (select caminho from public.arquivos_pendentes order by criado_em limit greatest(1, least(p_limite, 1000)))
    returning caminho, bucket
  )
  select coalesce(json_agg(json_build_object('caminho', caminho, 'bucket', bucket)), '[]'::json) into v from x;
  return v;
end;
$$;

create or replace function public.servidor_arquivos_conferir(p_erro text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_removidos integer;
  v_restantes integer;
begin
  delete from public.arquivos_pendentes a
   where not exists (select 1 from storage.objects o where o.bucket_id = a.bucket and o.name = a.caminho);
  get diagnostics v_removidos = row_count;
  if p_erro is not null then
    update public.arquivos_pendentes set ultimo_erro = left(p_erro, 300);
  end if;
  select count(*) into v_restantes from public.arquivos_pendentes;
  return json_build_object('removidos_da_fila', v_removidos, 'restantes', v_restantes);
end;
$$;

-- ---------------------------------------------------------------------
-- 4g. EXCLUSÃO DEFINITIVA DE UMA OPERAÇÃO
-- ---------------------------------------------------------------------
-- Quem pode: quem criou a operação, ou um administrador que faça parte dela.
-- Tudo acontece numa transação: participantes, posições, mensagens, relatos,
-- fotos (registros), equipe e tokens dos links são apagados juntos. Os arquivos
-- das fotos entram na fila arquivos_pendentes e são apagados do Storage pelo
-- painel logo em seguida (ou pela limpeza diária, se algo falhar).
create or replace function public.excluir_operacao(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_codigo text;
  v_fotos integer;
  v_participantes integer;
begin
  if not (public.eh_criador(p_operacao) or (public.eh_admin() and public.dono_operacao(p_operacao))) then
    raise exception 'sem_permissao';
  end if;
  select codigo into v_codigo from public.operacoes where id = p_operacao for update;
  if v_codigo is null then
    raise exception 'sem_permissao';
  end if;
  select count(*) into v_fotos from public.fotos where operacao_id = p_operacao;
  select count(*) into v_participantes from public.participantes where operacao_id = p_operacao and tipo <> 'responsavel';

  delete from public.operacoes where id = p_operacao;   -- apaga em cascata tudo o que é da operação

  return json_build_object('operacao', v_codigo, 'fotos', v_fotos, 'participantes', v_participantes);
end;
$$;

-- ---------------------------------------------------------------------
-- 5. FUNÇÕES (RPC) — PARTICIPANTE (civil ou militar de campo)
-- ---------------------------------------------------------------------

-- Informações mínimas para a tela inicial (antes do ingresso).
create or replace function public.info_operacao(p_token text)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
  v_tipo text;
begin
  if p_token is null or char_length(p_token) <> 64 then
    return null;
  end if;
  select * into v_op from public.operacoes where token_civil = p_token;
  if found then
    v_tipo := 'civil';
  else
    select * into v_op from public.operacoes where token_militar = p_token;
    if not found then
      return null;
    end if;
    v_tipo := 'militar';
  end if;
  return json_build_object(
    'operacao', v_op.codigo,
    'ativa', v_op.status = 'ativa',
    'tipos_permitidos', case when v_tipo = 'militar' then json_build_array('militar', 'civil') else json_build_array('civil') end
  );
end;
$$;

-- Versão anterior (sem CPF e telefone) é substituída.
drop function if exists public.ingressar(text, text, text);

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
    if not found then
      raise exception 'link_invalido';
    end if;
    v_link := 'militar';
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

  -- CPF e celular: obrigatórios para civis; opcionais para militares (se informados, válidos).
  if coalesce(btrim(p_cpf), '') <> '' and v_cpf is null then
    raise exception 'cpf_invalido';
  end if;
  if coalesce(btrim(p_telefone), '') <> '' and v_tel is null then
    raise exception 'telefone_invalido';
  end if;
  if v_tipo = 'civil' and v_cpf is null then
    raise exception 'cpf_invalido';
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

  return json_build_object(
    'participante_id', v_part.id,
    'nome', v_part.nome,
    'tipo', v_part.tipo,
    'operacao', v_op.codigo,
    'operacao_id', v_op.id,
    'saida_solicitada_em', v_part.saida_solicitada_em
  );
end;
$$;

-- Recebe um lote de posições. Formato de cada ponto:
--   {"id": "<uuid gerado no celular>", "lat": -15.79, "lng": -47.88, "prec": 8.5, "t": <epoch ms>}
-- Pontos inválidos são descartados; pontos repetidos (mesmo id) são ignorados.
create or replace function public.enviar_posicoes(p_participante uuid, p_pontos jsonb, p_gps text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
  v_inseridos integer := 0;
  v_ult record;
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
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  if v_op.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_pontos is null or jsonb_typeof(p_pontos) <> 'array' or jsonb_array_length(p_pontos) > 500 then
    raise exception 'lote_invalido';
  end if;

  -- Cada conversão é protegida por CASE: o PostgreSQL não garante a ordem
  -- entre WHERE e SELECT, e um único ponto malformado não pode derrubar o lote.
  with numericos as (
    select case when jsonb_typeof(e) = 'object'
                 and coalesce(e ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (e ->> 'id')::uuid end as client_id,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'lat') = 'number' then (e -> 'lat')::numeric end as lat,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'lng') = 'number' then (e -> 'lng')::numeric end as lng,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'prec') = 'number' then (e -> 'prec')::numeric end as prec,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 't') = 'number' then (e -> 't')::numeric end as t
      from jsonb_array_elements(p_pontos) as e
  ), validos as (
    select client_id,
           case when lat between -90 and 90 then lat::double precision end as lat,
           case when lng between -180 and 180 then lng::double precision end as lng,
           case when prec between 0 and 100000 then prec::real end as prec,
           case when t between 946684800000 and 4102444800000            -- entre 2000 e 2100
                then to_timestamp((t / 1000)::double precision) end as registrado_em
      from numericos
  ), dentro_do_periodo as (
    select * from validos
     where client_id is not null
       and lat is not null and lng is not null
       and not (lat = 0 and lng = 0)
       and registrado_em between v_op.criada_em - interval '10 minutes' and now() + interval '2 minutes'
  ), inseridos as (
    insert into public.posicoes (operacao_id, participante_id, client_id, lat, lng, precisao, registrado_em)
    select v_op.id, v_part.id, client_id, lat, lng, prec, registrado_em from dentro_do_periodo
    on conflict (participante_id, client_id) do nothing
    returning 1
  )
  select count(*) into v_inseridos from inseridos;

  select lat, lng, precisao, registrado_em into v_ult
    from public.posicoes
   where participante_id = v_part.id
   order by registrado_em desc
   limit 1;

  update public.participantes
     set ultimo_contato_em = now(),
         rastreando = true,
         gps_estado = case when p_gps in ('ok', 'fraco', 'sem_sinal', 'negado', 'indisponivel') then p_gps
                           when v_inseridos > 0 then 'ok'
                           else gps_estado end,
         ultima_lat = coalesce(v_ult.lat, ultima_lat),
         ultima_lng = coalesce(v_ult.lng, ultima_lng),
         ultima_precisao = case when v_ult.registrado_em is not null then v_ult.precisao else ultima_precisao end,
         ultima_posicao_em = coalesce(v_ult.registrado_em, ultima_posicao_em)
   where id = v_part.id;

  return json_build_object('status', 'ativa', 'recebidos', jsonb_array_length(p_pontos), 'inseridos', v_inseridos);
end;
$$;

-- Sinal de vida periódico: mantém o estado de conexão/GPS e informa se a operação continua ativa.
create or replace function public.sinal_vida(p_participante uuid, p_rastreando boolean, p_gps text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found then
    return json_build_object('status', 'inexistente');
  end if;
  if v_part.liberado_em is not null then
    return json_build_object('status', 'liberado');
  end if;
  if v_part.removido then
    return json_build_object('status', 'removido');
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    return json_build_object('status', 'encerrada');
  end if;

  update public.participantes
     set ultimo_contato_em = now(),
         rastreando = coalesce(p_rastreando, rastreando),
         gps_estado = case when p_gps in ('aguardando', 'ok', 'fraco', 'sem_sinal', 'negado', 'indisponivel') then p_gps
                           else gps_estado end
   where id = v_part.id;

  return json_build_object('status', 'ativa', 'agora', now(), 'saida_solicitada_em', v_part.saida_solicitada_em);
end;
$$;

create or replace function public.marcar_entregues(p_ids uuid[])
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_qtd integer;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_ids) > 200 then
    raise exception 'lote_invalido';
  end if;
  update public.mensagens m
     set entregue_em = now()
    from public.participantes p
   where m.id = any (p_ids)
     and m.participante_id = p.id
     and p.user_id = auth.uid()
     and m.direcao = 'saida'
     and m.entregue_em is null;
  get diagnostics v_qtd = row_count;
  return v_qtd;
end;
$$;

create or replace function public.confirmar_mensagem(p_mensagem uuid, p_resposta text default 'CIENTE')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_resp text := case when p_resposta in ('CIENTE', 'ESTOU_BEM', 'PRECISO_AJUDA') then p_resposta else 'CIENTE' end;
  v_msg public.mensagens%rowtype;
begin
  update public.mensagens m
     set confirmada_em = coalesce(m.confirmada_em, now()),
         entregue_em   = coalesce(m.entregue_em, now()),
         resposta      = coalesce(m.resposta, v_resp)
    from public.participantes p
   where m.id = p_mensagem
     and m.participante_id = p.id
     and p.user_id = auth.uid()
     and m.direcao = 'saida'
  returning m.* into v_msg;
  if not found then
    raise exception 'sem_permissao';
  end if;
  return row_to_json(v_msg);
end;
$$;

-- Mapa do participante: a última posição dos MILITARES e dos RESPONSÁVEIS da mesma
-- operação (os responsáveis só enquanto compartilham "Minha posição"). Nunca mostra
-- outros civis, nomes, CPF, telefone nem trilhas. Posições com mais de 15 min não
-- são enviadas; a idade vai junto para a página não apresentar posição antiga como atual.
create or replace function public.equipe_no_mapa(p_participante uuid)
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
    select json_agg(json_build_object(
             'id', p.id,
             'tipo', p.tipo,
             'lat', p.ultima_lat,
             'lng', p.ultima_lng,
             'precisao', p.ultima_precisao,
             'idade_s', greatest(0, floor(extract(epoch from now() - p.ultima_posicao_em)))::integer))
      from public.participantes p
     where p.operacao_id = v_part.operacao_id
       and p.id <> v_part.id
       and p.tipo in ('militar', 'responsavel')
       and not p.removido
       and p.liberado_em is null
       and p.ultima_lat is not null and p.ultima_lng is not null
       and p.ultima_posicao_em > now() - interval '15 minutes'
       and (p.tipo <> 'responsavel' or p.rastreando)
  ), '[]'::json);
end;
$$;

-- Hora do servidor (para sincronizar relógios e calcular "há X segundos").
create or replace function public.agora()
returns timestamptz
language sql stable
as $$ select now(); $$;

-- ---------------------------------------------------------------------
-- 6. LIMPEZA AUTOMÁTICA (retenção) — chamada só pelo servidor
-- ---------------------------------------------------------------------
create or replace function public.purgar_expiradas()
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_encerradas integer := 0;
  v_apagadas integer := 0;
  v_anonimos integer := 0;
begin
  -- Salvaguarda: operações esquecidas abertas por mais de 30 dias são encerradas.
  with x as (
    update public.operacoes
       set status = 'encerrada', encerrada_em = now(), expira_em = now() + make_interval(hours => retencao_horas)
     where status = 'ativa' and criada_em < now() - interval '30 days'
    returning id
  )
  select count(*) into v_encerradas from x;

  -- Apaga participantes, posições e mensagens de operações com retenção vencida.
  with alvo as (
    update public.operacoes
       set dados_apagados_em = now()
     where status = 'encerrada' and dados_apagados_em is null and expira_em <= now()
    returning id
  ), del as (
    delete from public.participantes where operacao_id in (select id from alvo) returning 1
  )
  select (select count(*) from alvo) into v_apagadas from (select count(*) from del) d;

  -- Remove contas anônimas antigas que não participam mais de nenhuma operação.
  begin
    with velhos as (
      delete from auth.users u
       where u.is_anonymous
         and u.created_at < now() - interval '7 days'
         and not exists (select 1 from public.participantes p where p.user_id = u.id)
      returning 1
    )
    select count(*) into v_anonimos from velhos;
  exception when others then
    v_anonimos := -1;   -- sem permissão no esquema auth: ignore
  end;

  return json_build_object('operacoes_encerradas', v_encerradas, 'operacoes_apagadas', v_apagadas, 'contas_anonimas_removidas', v_anonimos);
end;
$$;

-- ---------------------------------------------------------------------
-- 7. PERMISSÕES DE EXECUÇÃO
-- ---------------------------------------------------------------------
revoke execute on function
  public.participante_enviar_mensagem(uuid, text, text, double precision, double precision, real, timestamptz, uuid),
  public.marcar_lidas(uuid[]), public.caminho_foto_partes(text), public.pode_enviar_foto(text), public.pode_ver_foto(text),
  public.pode_apagar_foto(text),
  public.registrar_foto(uuid, uuid, text, double precision, double precision, real, timestamptz, timestamptz, text, integer, integer, integer),
  public.meus_arquivos_pendentes(), public.confirmar_arquivos_removidos(text[]), public.excluir_operacao(uuid),
  public.servidor_arquivos_pendentes(integer), public.servidor_arquivos_conferir(text), public.fila_apagar_arquivo(),
  public.eh_admin(), public.admin_listar_responsaveis(), public.admin_alterar_responsavel(uuid, text, boolean, boolean),
  public.servidor_usuario_por_email(text), public.servidor_salvar_responsavel(uuid, text, boolean),
  public.servidor_eh_responsavel(uuid),
  public.eh_responsavel(), public.dono_operacao(uuid), public.eh_meu_participante(uuid), public.gerar_token(),
  public.criar_operacao(text, integer), public.encerrar_operacao(uuid), public.apagar_dados_operacao(uuid),
  public.remover_participante(uuid), public.enviar_mensagem(uuid, text, text), public.info_operacao(text),
  public.ingressar(text, text, text, text, text), public.enviar_posicoes(uuid, jsonb, text), public.sinal_vida(uuid, boolean, text),
  public.marcar_entregues(uuid[]), public.confirmar_mensagem(uuid, text), public.agora(), public.purgar_expiradas(),
  public.solicitar_saida(uuid, text), public.liberar_participante(uuid), public.recusar_saida(uuid),
  public.eh_criador(uuid), public.listar_responsaveis(uuid), public.adicionar_responsavel(uuid, text),
  public.remover_responsavel(uuid, uuid), public.entrar_como_responsavel(uuid)
from public, anon;

grant execute on function
  public.participante_enviar_mensagem(uuid, text, text, double precision, double precision, real, timestamptz, uuid),
  public.marcar_lidas(uuid[]), public.caminho_foto_partes(text), public.pode_enviar_foto(text), public.pode_ver_foto(text),
  public.pode_apagar_foto(text),
  public.registrar_foto(uuid, uuid, text, double precision, double precision, real, timestamptz, timestamptz, text, integer, integer, integer),
  public.meus_arquivos_pendentes(), public.confirmar_arquivos_removidos(text[]), public.excluir_operacao(uuid),
  public.eh_admin(), public.admin_listar_responsaveis(), public.admin_alterar_responsavel(uuid, text, boolean, boolean),
  public.eh_responsavel(), public.dono_operacao(uuid), public.eh_meu_participante(uuid),
  public.criar_operacao(text, integer), public.encerrar_operacao(uuid), public.apagar_dados_operacao(uuid),
  public.remover_participante(uuid), public.enviar_mensagem(uuid, text, text), public.info_operacao(text),
  public.ingressar(text, text, text, text, text), public.enviar_posicoes(uuid, jsonb, text), public.sinal_vida(uuid, boolean, text),
  public.marcar_entregues(uuid[]), public.confirmar_mensagem(uuid, text), public.agora(),
  public.solicitar_saida(uuid, text), public.liberar_participante(uuid), public.recusar_saida(uuid),
  public.eh_criador(uuid), public.listar_responsaveis(uuid), public.adicionar_responsavel(uuid, text),
  public.remover_responsavel(uuid, uuid), public.entrar_como_responsavel(uuid)
to authenticated;

-- A tela inicial do participante mostra o nome da operação antes do login anônimo.
grant execute on function public.info_operacao(text) to anon;
revoke execute on function public.equipe_no_mapa(uuid) from public, anon;
grant execute on function public.equipe_no_mapa(uuid) to authenticated;

-- Só o servidor (chave secreta, função /api/limpeza) executa a limpeza.
revoke execute on function public.purgar_expiradas() from authenticated;
grant execute on function public.purgar_expiradas() to service_role;

-- Funções do servidor (cadastro de login pelo painel): só a chave secreta executa.
revoke execute on function public.servidor_usuario_por_email(text), public.servidor_salvar_responsavel(uuid, text, boolean),
  public.servidor_eh_responsavel(uuid) from authenticated;
grant execute on function public.servidor_usuario_por_email(text), public.servidor_salvar_responsavel(uuid, text, boolean),
  public.servidor_eh_responsavel(uuid) to service_role;
revoke execute on function public.servidor_arquivos_pendentes(integer), public.servidor_arquivos_conferir(text) from authenticated;
grant execute on function public.servidor_arquivos_pendentes(integer), public.servidor_arquivos_conferir(text) to service_role;

-- ---------------------------------------------------------------------
-- 8. TEMPO REAL (Supabase Realtime — postgres_changes respeita o RLS)
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['participantes', 'posicoes', 'mensagens', 'fotos'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;  -- já estava publicada
      end;
    end loop;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 9. STORAGE: bucket PRIVADO "fotos" e suas regras de acesso
--    (imagens só por links assinados e temporários; nunca públicas)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', false, 10485760, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists gbs_fotos_enviar on storage.objects;
create policy gbs_fotos_enviar on storage.objects
  for insert to authenticated
  with check (bucket_id = 'fotos' and public.pode_enviar_foto(name));

drop policy if exists gbs_fotos_ver on storage.objects;
create policy gbs_fotos_ver on storage.objects
  for select to authenticated
  using (bucket_id = 'fotos' and public.pode_ver_foto(name));

drop policy if exists gbs_fotos_apagar on storage.objects;
create policy gbs_fotos_apagar on storage.objects
  for delete to authenticated
  using (bucket_id = 'fotos' and public.pode_apagar_foto(name));

-- =====================================================================
-- DEPOIS DE EXECUTAR ESTE ARQUIVO (somente na PRIMEIRA instalação):
--   O primeiro responsável é criado pelo Supabase; ele vira ADMINISTRADOR e
--   cadastra os demais pela tela "Responsáveis" do painel.
--   1. Crie o usuário em Authentication > Users > Add user (marque Auto Confirm).
--   2. Autorize-o (troque o e-mail e o nome):
--
--      insert into public.responsaveis (user_id, nome)
--      select id, 'Sgt BM Fulano' from auth.users where email = 'fulano@cbm.exemplo.gov.br';
-- =====================================================================

-- =====================================================================
-- 10. SETORES DE BUSCA, PONTOS DE INTERESSE E NAVEGAÇÃO
--     (migração 003 — pode ser executada sozinha num banco já instalado,
--      ou junto com o schema.sql completo; é idempotente)
--
--  setores           áreas de busca (círculo por raio ou polígono) de uma operação
--  pontos_interesse  locais marcados pelos responsáveis (última localização, risco…)
--  destinos          "navegue até aqui" enviado a um participante (1 ativo por vez)
--
--  Leitura direta: só responsáveis da operação (RLS). Toda gravação passa por
--  funções que conferem a permissão. O participante só recebe, pela função
--  mapa_do_participante, o que é dele: os setores atribuídos a ele, pontos de
--  encontro e áreas de risco, e o destino ativo.
-- =====================================================================

create table if not exists public.setores (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  nome                text not null check (char_length(btrim(nome)) between 1 and 60),
  forma               text not null check (forma in ('circulo', 'poligono')),
  centro_lat          double precision check (centro_lat between -90 and 90),
  centro_lng          double precision check (centro_lng between -180 and 180),
  raio_m              double precision,
  pontos              jsonb,
  cor                 text not null default '#3b82f6' check (cor ~ '^#[0-9a-fA-F]{6}$'),
  status              text not null default 'pendente' check (status in ('pendente', 'andamento', 'concluido')),
  participante_id     uuid references public.participantes(id) on delete set null,
  equipe              text not null default '' check (char_length(equipe) <= 60),
  observacoes         text not null default '' check (char_length(observacoes) <= 500),
  criado_por          uuid references auth.users(id) on delete set null,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text,
  constraint setores_forma_ok check (
    (forma = 'circulo' and centro_lat is not null and centro_lng is not null and raio_m between 5 and 50000 and pontos is null)
    or (forma = 'poligono' and pontos is not null and jsonb_typeof(pontos) = 'array' and centro_lat is null and raio_m is null))
);
create index if not exists setores_operacao_idx on public.setores (operacao_id);

create table if not exists public.pontos_interesse (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  categoria           text not null check (categoria in ('ULTIMA_LOCALIZACAO', 'POSSIVEL_LOCALIZACAO', 'VESTIGIO',
                                                         'RISCO', 'ENCONTRO', 'VITIMA_ENCONTRADA', 'OUTRO')),
  titulo              text not null check (char_length(btrim(titulo)) between 1 and 80),
  descricao           text not null default '' check (char_length(descricao) <= 1000),
  lat                 double precision not null check (lat between -90 and 90),
  lng                 double precision not null check (lng between -180 and 180),
  foto_id             uuid references public.fotos(id) on delete set null,
  mensagem_id         uuid references public.mensagens(id) on delete set null,
  relatado_por_nome   text,
  criado_por          uuid references auth.users(id) on delete set null,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text
);
create index if not exists pontos_interesse_operacao_idx on public.pontos_interesse (operacao_id);

create table if not exists public.destinos (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  participante_id     uuid not null references public.participantes(id) on delete cascade,
  nome                text not null check (char_length(btrim(nome)) between 1 and 80),
  lat                 double precision not null check (lat between -90 and 90),
  lng                 double precision not null check (lng between -180 and 180),
  ponto_id            uuid references public.pontos_interesse(id) on delete set null,
  enviado_por         uuid references auth.users(id) on delete set null,
  enviado_por_nome    text not null,
  criado_em           timestamptz not null default now(),
  encerrado_em        timestamptz,
  encerrado_por       text
);
create index if not exists destinos_operacao_idx on public.destinos (operacao_id);
create unique index if not exists destinos_um_ativo on public.destinos (participante_id) where encerrado_em is null;

alter table public.setores enable row level security;
alter table public.pontos_interesse enable row level security;
alter table public.destinos enable row level security;

drop policy if exists setores_ler on public.setores;
create policy setores_ler on public.setores for select to authenticated using (public.dono_operacao(operacao_id));
drop policy if exists pontos_interesse_ler on public.pontos_interesse;
create policy pontos_interesse_ler on public.pontos_interesse for select to authenticated using (public.dono_operacao(operacao_id));
drop policy if exists destinos_ler on public.destinos;
create policy destinos_ler on public.destinos for select to authenticated using (public.dono_operacao(operacao_id));

revoke all on public.setores, public.pontos_interesse, public.destinos from anon;
revoke insert, update, delete, truncate on public.setores, public.pontos_interesse, public.destinos from authenticated;
grant select on public.setores, public.pontos_interesse, public.destinos to authenticated;

-- Quem pode editar/excluir: qualquer responsável da operação edita; excluir é de
-- quem criou o registro, de quem criou a operação ou de um administrador da equipe.
create or replace function public.pode_excluir_registro(p_operacao uuid, p_criado_por uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.dono_operacao(p_operacao)
     and (p_criado_por = auth.uid() or public.eh_criador(p_operacao) or public.eh_admin());
$$;

create or replace function public.nome_responsavel_atual()
returns text
language sql stable security definer set search_path = public
as $$ select nome from public.responsaveis where user_id = auth.uid() and ativo; $$;

-- Confere uma lista de vértices [[lat, lng], …] (3 a 300 pontos).
create or replace function public.vertices_validos(p jsonb)
returns boolean
language plpgsql immutable
as $$
declare
  v jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) < 3 or jsonb_array_length(p) > 300 then
    return false;
  end if;
  for v in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) <> 2
       or jsonb_typeof(v->0) <> 'number' or jsonb_typeof(v->1) <> 'number'
       or (v->>0)::double precision not between -90 and 90
       or (v->>1)::double precision not between -180 and 180 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- Cria (p_id nulo) ou altera um setor. Na alteração, só os campos enviados mudam.
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
    update public.setores set nome = v_s.nome, forma = v_s.forma, centro_lat = v_s.centro_lat, centro_lng = v_s.centro_lng,
           raio_m = v_s.raio_m, pontos = v_s.pontos, cor = v_s.cor, status = v_s.status, participante_id = v_s.participante_id,
           equipe = v_s.equipe, observacoes = v_s.observacoes, atualizado_em = v_s.atualizado_em,
           atualizado_por_nome = v_s.atualizado_por_nome
     where id = v_s.id;
  end if;
  return row_to_json(v_s);
end;
$$;

create or replace function public.excluir_setor(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.setores%rowtype;
begin
  select * into v from public.setores where id = p_id;
  if not found or not public.pode_excluir_registro(v.operacao_id, v.criado_por) then
    raise exception 'sem_permissao';
  end if;
  delete from public.setores where id = p_id;
end;
$$;

-- Cria ou altera um ponto de interesse.
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
  if p_dados ? 'titulo' then v_p.titulo := btrim(coalesce(p_dados->>'titulo', '')); end if;
  if p_dados ? 'descricao' then v_p.descricao := left(btrim(coalesce(p_dados->>'descricao', '')), 1000); end if;
  if p_dados ? 'lat' then v_p.lat := (p_dados->>'lat')::double precision; end if;
  if p_dados ? 'lng' then v_p.lng := (p_dados->>'lng')::double precision; end if;
  if p_dados ? 'foto_id' then
    v_ref := nullif(p_dados->>'foto_id', '')::uuid;
    if v_ref is not null and not exists (select 1 from public.fotos where id = v_ref and operacao_id = p_operacao) then
      raise exception 'dados_invalidos';
    end if;
    v_p.foto_id := v_ref;
  end if;

  if v_p.categoria is null or v_p.categoria not in ('ULTIMA_LOCALIZACAO', 'POSSIVEL_LOCALIZACAO', 'VESTIGIO',
                                                      'RISCO', 'ENCONTRO', 'VITIMA_ENCONTRADA', 'OUTRO') then
    raise exception 'dados_invalidos';
  end if;
  if v_p.titulo is null or char_length(v_p.titulo) not between 1 and 80 then
    raise exception 'nome_invalido';
  end if;
  if v_p.lat is null or v_p.lng is null or v_p.lat not between -90 and 90 or v_p.lng not between -180 and 180
     or (v_p.lat = 0 and v_p.lng = 0) then
    raise exception 'posicao_invalida';
  end if;

  v_p.atualizado_em := now();
  v_p.atualizado_por_nome := v_nome_resp;
  if p_id is null then
    insert into public.pontos_interesse select v_p.*;
  else
    update public.pontos_interesse set categoria = v_p.categoria, titulo = v_p.titulo, descricao = v_p.descricao,
           lat = v_p.lat, lng = v_p.lng, foto_id = v_p.foto_id, atualizado_em = v_p.atualizado_em,
           atualizado_por_nome = v_p.atualizado_por_nome
     where id = v_p.id;
  end if;
  return row_to_json(v_p);
end;
$$;

create or replace function public.excluir_ponto(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.pontos_interesse%rowtype;
begin
  select * into v from public.pontos_interesse where id = p_id;
  if not found or not public.pode_excluir_registro(v.operacao_id, v.criado_por) then
    raise exception 'sem_permissao';
  end if;
  delete from public.pontos_interesse where id = p_id;
end;
$$;

-- Envia um destino ("navegue até aqui") a um participante. Substitui o anterior.
create or replace function public.definir_destino(p_participante uuid, p_nome text, p_lat double precision,
                                                  p_lng double precision, p_ponto uuid default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_part public.participantes%rowtype;
  v_status text;
  v_d public.destinos%rowtype;
begin
  select * into v_part from public.participantes where id = p_participante;
  if not found or v_nome_resp is null or not public.dono_operacao(v_part.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if v_part.removido or v_part.liberado_em is not null then
    raise exception 'participante_removido';
  end if;
  if v_part.user_id = auth.uid() then
    raise exception 'nao_pode_alterar_a_si';
  end if;
  if p_nome is null or char_length(btrim(p_nome)) not between 1 and 80 then
    raise exception 'nome_invalido';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0) then
    raise exception 'posicao_invalida';
  end if;
  if p_ponto is not null and not exists (select 1 from public.pontos_interesse where id = p_ponto and operacao_id = v_part.operacao_id) then
    raise exception 'dados_invalidos';
  end if;

  update public.destinos set encerrado_em = now(), encerrado_por = 'substituído por novo destino'
   where participante_id = v_part.id and encerrado_em is null;
  insert into public.destinos (operacao_id, participante_id, nome, lat, lng, ponto_id, enviado_por, enviado_por_nome)
  values (v_part.operacao_id, v_part.id, btrim(p_nome), p_lat, p_lng, p_ponto, auth.uid(), v_nome_resp)
  returning * into v_d;
  return row_to_json(v_d);
end;
$$;

-- Encerra a navegação: pelo responsável (painel) ou pelo próprio participante.
create or replace function public.encerrar_destino(p_destino uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.destinos%rowtype;
  v_quem text;
begin
  select * into v from public.destinos where id = p_destino;
  if not found then
    raise exception 'sem_permissao';
  end if;
  if public.dono_operacao(v.operacao_id) then
    v_quem := coalesce(public.nome_responsavel_atual(), 'responsável');
  elsif exists (select 1 from public.participantes where id = v.participante_id and user_id = auth.uid()) then
    v_quem := 'participante';
  else
    raise exception 'sem_permissao';
  end if;
  update public.destinos set encerrado_em = coalesce(encerrado_em, now()), encerrado_por = coalesce(encerrado_por, v_quem)
   where id = p_destino;
end;
$$;

-- Tudo o que o mapa do participante pode mostrar, numa chamada só:
--   equipe   última posição de militares e responsáveis (sem nomes), como equipe_no_mapa
--   setores  só os setores atribuídos a ESTE participante
--   pontos   só pontos de encontro e áreas de risco (nunca dados sobre a vítima)
--   destino  o destino ativo enviado a ele
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
                                        'lat', p.lat, 'lng', p.lng) order by p.criado_em)
        from public.pontos_interesse p
       where p.operacao_id = v_part.operacao_id and p.categoria in ('ENCONTRO', 'RISCO')), '[]'::json),
    'destino', (
      select json_build_object('id', d.id, 'nome', d.nome, 'lat', d.lat, 'lng', d.lng, 'criado_em', d.criado_em)
        from public.destinos d where d.participante_id = v_part.id and d.encerrado_em is null
       order by d.criado_em desc limit 1)
  );
end;
$$;

revoke execute on function public.pode_excluir_registro(uuid, uuid), public.nome_responsavel_atual(), public.vertices_validos(jsonb),
  public.salvar_setor(uuid, uuid, jsonb), public.excluir_setor(uuid), public.salvar_ponto(uuid, uuid, jsonb),
  public.excluir_ponto(uuid), public.definir_destino(uuid, text, double precision, double precision, uuid),
  public.encerrar_destino(uuid), public.mapa_do_participante(uuid)
  from public, anon;
grant execute on function public.pode_excluir_registro(uuid, uuid), public.nome_responsavel_atual(), public.vertices_validos(jsonb),
  public.salvar_setor(uuid, uuid, jsonb), public.excluir_setor(uuid), public.salvar_ponto(uuid, uuid, jsonb),
  public.excluir_ponto(uuid), public.definir_destino(uuid, text, double precision, double precision, uuid),
  public.encerrar_destino(uuid), public.mapa_do_participante(uuid)
  to authenticated;

-- Quando os dados de uma operação são apagados (retenção vencida, "Apagar dados
-- agora" ou encerramento com "apagar ao encerrar"), setores, pontos e destinos
-- dela também são apagados. Excluir a operação apaga tudo em cascata.
create or replace function public.apagar_areas_da_operacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.destinos where operacao_id = new.id;
    delete from public.pontos_interesse where operacao_id = new.id;
    delete from public.setores where operacao_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists operacoes_apagar_areas on public.operacoes;
create trigger operacoes_apagar_areas after update of dados_apagados_em on public.operacoes
  for each row execute function public.apagar_areas_da_operacao();
revoke execute on function public.apagar_areas_da_operacao() from public, anon, authenticated;

-- Tempo real para os painéis (mudanças aparecem sem recarregar).
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['setores', 'pontos_interesse', 'destinos'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end;
$$;

-- =====================================================================
-- 11. DESTINO RECEBIDO PELO PARTICIPANTE E REINCLUSÃO DE PARTICIPANTES
--     (migração 004 — idempotente; pode ser executada sozinha num banco que
--      já tem a migração 003, ou junto com o schema.sql completo)
--
--  Destinos
--   * O participante passa a LER o próprio destino (política RLS restrita a
--     participante_id do próprio usuário). Isso permite o Supabase Realtime
--     entregar o destino na hora (postgres_changes respeita o RLS). Nenhuma
--     outra política foi afrouxada: ele não lê destinos de outras pessoas.
--   * destinos.recebido_em: o celular confirma que recebeu e mostrou o destino
--     (função confirmar_destino). O painel mostra "Recebido no celular às…".
--
--  Remoção e reinclusão
--   * Remover / liberar NÃO apaga o cadastro nem a trilha: só desvincula
--     (removido = true). Fica registrado quem removeu e quando.
--   * reincluir_participante: só um responsável da operação, com a operação
--     ativa. Reativa o MESMO registro (sem duplicar), limpa a saída liberada e
--     o pedido de saída. O celular percebe sozinho e oferece "Voltar para a busca".
--   * participacao_eventos: histórico de remoções, liberações e reinclusões.
-- =====================================================================

alter table public.participantes add column if not exists removido_em timestamptz;
alter table public.participantes add column if not exists removido_por_nome text;
alter table public.participantes add column if not exists reincluido_em timestamptz;
alter table public.participantes add column if not exists reincluido_por_nome text;

alter table public.destinos add column if not exists recebido_em timestamptz;

create table if not exists public.participacao_eventos (
  id               bigint generated always as identity primary key,
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  evento           text not null check (evento in ('removido', 'liberado', 'reincluido')),
  por              uuid references auth.users(id) on delete set null,
  por_nome         text,
  em               timestamptz not null default now()
);
create index if not exists participacao_eventos_part_idx on public.participacao_eventos (participante_id, em);

alter table public.participacao_eventos enable row level security;
drop policy if exists participacao_eventos_ler on public.participacao_eventos;
create policy participacao_eventos_ler on public.participacao_eventos
  for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.participacao_eventos from anon;
revoke insert, update, delete, truncate on public.participacao_eventos from authenticated;
grant select on public.participacao_eventos to authenticated;

-- O participante lê SOMENTE o próprio destino (para o tempo real e para a recuperação).
drop policy if exists destinos_ler_participante on public.destinos;
create policy destinos_ler_participante on public.destinos
  for select to authenticated using (public.eh_meu_participante(participante_id));

-- Remover: desvincula sem apagar. Encerra o destino ativo dele.
create or replace function public.remover_participante(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_nome text := coalesce(public.nome_responsavel_atual(), 'responsável');
begin
  select * into v_part from public.participantes where id = p_participante and tipo <> 'responsavel';
  if not found or not public.dono_operacao(v_part.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if v_part.removido then
    return;   -- já removido: nada a fazer
  end if;
  update public.participantes
     set removido = true, rastreando = false, removido_em = now(), removido_por_nome = v_nome
   where id = p_participante;
  update public.destinos set encerrado_em = now(), encerrado_por = 'participante removido'
   where participante_id = p_participante and encerrado_em is null;
  insert into public.participacao_eventos (operacao_id, participante_id, evento, por, por_nome)
  values (v_part.operacao_id, v_part.id, 'removido', auth.uid(), v_nome);
end;
$$;

-- Liberar a saída: igual à remoção, mas registra que foi a pedido do participante.
create or replace function public.liberar_participante(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_nome text := coalesce(public.nome_responsavel_atual(), 'responsável');
begin
  select * into v_part from public.participantes where id = p_participante and tipo <> 'responsavel';
  if not found or not public.dono_operacao(v_part.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if v_part.liberado_em is not null then
    return;
  end if;
  update public.participantes
     set liberado_em = now(), removido = true, rastreando = false,
         removido_em = coalesce(removido_em, now()), removido_por_nome = v_nome
   where id = p_participante;
  update public.destinos set encerrado_em = now(), encerrado_por = 'saída liberada'
   where participante_id = p_participante and encerrado_em is null;
  insert into public.participacao_eventos (operacao_id, participante_id, evento, por, por_nome)
  values (v_part.operacao_id, v_part.id, 'liberado', auth.uid(), v_nome);
end;
$$;

-- Reincluir: só responsável da operação, operação ativa. Reativa o mesmo registro.
create or replace function public.reincluir_participante(p_participante uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_nome text := public.nome_responsavel_atual();
begin
  select * into v_part from public.participantes where id = p_participante and tipo <> 'responsavel';
  if not found or v_nome is null or not public.dono_operacao(v_part.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if not v_part.removido then
    raise exception 'participante_ativo';
  end if;
  update public.participantes
     set removido = false, liberado_em = null, rastreando = false,
         saida_solicitada_em = null, saida_motivo = null,
         reincluido_em = now(), reincluido_por_nome = v_nome
   where id = p_participante
  returning * into v_part;
  insert into public.participacao_eventos (operacao_id, participante_id, evento, por, por_nome)
  values (v_part.operacao_id, v_part.id, 'reincluido', auth.uid(), v_nome);
  return row_to_json(v_part);
end;
$$;

-- O celular confirma que recebeu (e mostrou) o destino. Só o próprio participante.
create or replace function public.confirmar_destino(p_destino uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v public.destinos%rowtype;
begin
  update public.destinos d
     set recebido_em = coalesce(d.recebido_em, now())
    from public.participantes p
   where d.id = p_destino
     and d.participante_id = p.id
     and p.user_id = auth.uid()
     and not p.removido
  returning d.* into v;
  if not found then
    raise exception 'sem_permissao';
  end if;
  return json_build_object('id', v.id, 'recebido_em', v.recebido_em, 'encerrado_em', v.encerrado_em);
end;
$$;

-- Destino ativo do próprio participante (recuperação depois de recarregar ou
-- reconectar; não depende do mapa). Mesmas verificações de mapa_do_participante.
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
                             'criado_em', d.criado_em, 'recebido_em', d.recebido_em)
      from public.destinos d
     where d.participante_id = v_part.id and d.encerrado_em is null
     order by d.criado_em desc limit 1);
end;
$$;

revoke execute on function public.reincluir_participante(uuid), public.confirmar_destino(uuid), public.meu_destino(uuid)
  from public, anon;
grant execute on function public.reincluir_participante(uuid), public.confirmar_destino(uuid), public.meu_destino(uuid)
  to authenticated;
-- remover_participante e liberar_participante mantêm as permissões que já tinham
-- (create or replace não altera os GRANTs); reforçado aqui por segurança:
revoke execute on function public.remover_participante(uuid), public.liberar_participante(uuid) from public, anon;
grant execute on function public.remover_participante(uuid), public.liberar_participante(uuid) to authenticated;

-- Tempo real: destinos já estão publicados (migração 003). Garante de novo.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.destinos';
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

-- Faz o PostgREST reconhecer as funções novas imediatamente.
notify pgrst, 'reload schema';

-- =====================================================================
-- 12. MODO DE DESLOCAMENTO DO DESTINO (rota a pé, por trilha ou de carro)
--     (migração 005 — idempotente; exige a 003 e a 004)
--
--  destinos.modo: como o participante deve ir até o destino. O celular usa esse
--  modo para pedir a rota por caminhos reais (/api/rota) e o participante pode
--  trocar na tela. Nada é apagado; destinos antigos ficam como 'a_pe'.
-- =====================================================================

alter table public.destinos add column if not exists modo text not null default 'a_pe';
alter table public.destinos drop constraint if exists destinos_modo_check;
alter table public.destinos add constraint destinos_modo_check check (modo in ('a_pe', 'trilha', 'carro'));

-- A função ganha o parâmetro p_modo (opcional). A versão de 5 parâmetros é
-- substituída; chamadas antigas continuam funcionando (p_modo = 'a_pe').
drop function if exists public.definir_destino(uuid, text, double precision, double precision, uuid);

create or replace function public.definir_destino(p_participante uuid, p_nome text, p_lat double precision,
                                                  p_lng double precision, p_ponto uuid default null,
                                                  p_modo text default 'a_pe')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_part public.participantes%rowtype;
  v_status text;
  v_d public.destinos%rowtype;
begin
  select * into v_part from public.participantes where id = p_participante;
  if not found or v_nome_resp is null or not public.dono_operacao(v_part.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if v_part.removido or v_part.liberado_em is not null then
    raise exception 'participante_removido';
  end if;
  if v_part.user_id = auth.uid() then
    raise exception 'nao_pode_alterar_a_si';
  end if;
  if p_nome is null or char_length(btrim(p_nome)) not between 1 and 80 then
    raise exception 'nome_invalido';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0) then
    raise exception 'posicao_invalida';
  end if;
  if coalesce(p_modo, 'a_pe') not in ('a_pe', 'trilha', 'carro') then
    raise exception 'dados_invalidos';
  end if;
  if p_ponto is not null and not exists (select 1 from public.pontos_interesse where id = p_ponto and operacao_id = v_part.operacao_id) then
    raise exception 'dados_invalidos';
  end if;

  update public.destinos set encerrado_em = now(), encerrado_por = 'substituído por novo destino'
   where participante_id = v_part.id and encerrado_em is null;
  insert into public.destinos (operacao_id, participante_id, nome, lat, lng, ponto_id, enviado_por, enviado_por_nome, modo)
  values (v_part.operacao_id, v_part.id, btrim(p_nome), p_lat, p_lng, p_ponto, auth.uid(), v_nome_resp, coalesce(p_modo, 'a_pe'))
  returning * into v_d;
  return row_to_json(v_d);
end;
$$;

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
                             'criado_em', d.criado_em, 'recebido_em', d.recebido_em, 'modo', d.modo)
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
                                        'lat', p.lat, 'lng', p.lng) order by p.criado_em)
        from public.pontos_interesse p
       where p.operacao_id = v_part.operacao_id and p.categoria in ('ENCONTRO', 'RISCO')), '[]'::json),
    'destino', (
      select json_build_object('id', d.id, 'nome', d.nome, 'lat', d.lat, 'lng', d.lng, 'criado_em', d.criado_em, 'modo', d.modo)
        from public.destinos d where d.participante_id = v_part.id and d.encerrado_em is null
       order by d.criado_em desc limit 1)
  );
end;
$$;

revoke execute on function public.definir_destino(uuid, text, double precision, double precision, uuid, text),
  public.meu_destino(uuid), public.mapa_do_participante(uuid) from public, anon;
grant execute on function public.definir_destino(uuid, text, double precision, double precision, uuid, text),
  public.meu_destino(uuid), public.mapa_do_participante(uuid) to authenticated;

notify pgrst, 'reload schema';

-- =====================================================================
-- 13. RAIO DE ALERTA DOS PONTOS (alarme de proximidade, como no AlpineQuest)
--     (migração 006 — idempotente; exige a 005)
--
--  pontos_interesse.raio_m (opcional, 10 m a 5 km): em áreas de risco, quem
--  entra no círculo recebe um alerta no celular e o painel é avisado.
--  Sem valor, vale o padrão do aplicativo (100 m). Nada é apagado.
-- =====================================================================

alter table public.pontos_interesse add column if not exists raio_m double precision;
alter table public.pontos_interesse drop constraint if exists pontos_interesse_raio_check;
alter table public.pontos_interesse add constraint pontos_interesse_raio_check check (raio_m is null or raio_m between 10 and 5000);

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
                                                      'RISCO', 'ENCONTRO', 'VITIMA_ENCONTRADA', 'OUTRO') then
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
    update public.pontos_interesse set categoria = v_p.categoria, titulo = v_p.titulo, descricao = v_p.descricao,
           lat = v_p.lat, lng = v_p.lng, foto_id = v_p.foto_id, raio_m = v_p.raio_m, atualizado_em = v_p.atualizado_em,
           atualizado_por_nome = v_p.atualizado_por_nome
     where id = v_p.id;
  end if;
  return row_to_json(v_p);
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
       where p.operacao_id = v_part.operacao_id and p.categoria in ('ENCONTRO', 'RISCO')), '[]'::json),
    'destino', (
      select json_build_object('id', d.id, 'nome', d.nome, 'lat', d.lat, 'lng', d.lng, 'criado_em', d.criado_em, 'modo', d.modo)
        from public.destinos d where d.participante_id = v_part.id and d.encerrado_em is null
       order by d.criado_em desc limit 1)
  );
end;
$$;

notify pgrst, 'reload schema';

-- =====================================================================
-- 14. CADASTRO COMPLETO DA OPERAÇÃO E FICHA DA VÍTIMA
--     (migração 007 — idempotente; exige a 006)
--
--  operacoes: tipo (aquática, terrestre, aérea ou outras + texto livre),
--    data e hora do acionamento, local (endereço e ponto no mapa) e
--    descrição. Todas as colunas novas são OPCIONAIS: as operações antigas,
--    que só têm o nome (codigo), continuam válidas e podem ser completadas
--    depois. O nome continua na coluna "codigo" (nada foi renomeado).
--    O participante continua vendo só o nome (info_operacao não muda).
--
--  vitimas: ficha da vítima (foto, nome, idade, características físicas,
--    roupas e observações), várias por operação. Leitura SOMENTE pelos
--    responsáveis da operação (RLS); civis e militares de campo nunca leem.
--    A foto fica no bucket PRIVADO "vitimas", no caminho
--    <operacao_id>/<vitima_id>/<uuid>.jpg (links assinados e temporários).
--
--  Retenção: quando os dados da operação são apagados, as fichas (e as
--  fotos, pela fila arquivos_pendentes) também são. Os campos do cadastro
--  da operação continuam, como o nome já continuava.
-- =====================================================================

alter table public.operacoes add column if not exists tipo text;
alter table public.operacoes add column if not exists tipo_outro text;
alter table public.operacoes add column if not exists acionado_em timestamptz;
alter table public.operacoes add column if not exists local_endereco text;
alter table public.operacoes add column if not exists local_lat double precision;
alter table public.operacoes add column if not exists local_lng double precision;
alter table public.operacoes add column if not exists descricao text not null default '';
alter table public.operacoes add column if not exists atualizado_em timestamptz;
alter table public.operacoes add column if not exists atualizado_por_nome text;

alter table public.operacoes drop constraint if exists operacoes_tipo_check;
alter table public.operacoes add constraint operacoes_tipo_check check (
  (tipo is null and tipo_outro is null)
  or (tipo in ('aquatica', 'terrestre', 'aerea') and tipo_outro is null)
  or (tipo = 'outras' and char_length(btrim(coalesce(tipo_outro, ''))) between 1 and 60));
alter table public.operacoes drop constraint if exists operacoes_local_check;
alter table public.operacoes add constraint operacoes_local_check check (
  (local_lat is null) = (local_lng is null)
  and (local_lat is null or (local_lat between -90 and 90 and local_lng between -180 and 180)));
alter table public.operacoes drop constraint if exists operacoes_textos_check;
alter table public.operacoes add constraint operacoes_textos_check check (
  char_length(coalesce(local_endereco, '')) <= 300 and char_length(descricao) <= 2000);

-- Aplica (e valida) os campos do cadastro enviados em p_dados sobre a operação.
-- Só os campos presentes em p_dados mudam. Uso interno das funções abaixo.
create or replace function public.aplicar_cadastro_operacao(p_op public.operacoes, p_dados jsonb)
returns public.operacoes
language plpgsql
set search_path = public
as $$
declare
  v public.operacoes := p_op;
  v_txt text;
begin
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;

  if p_dados ? 'codigo' then
    v.codigo := btrim(regexp_replace(coalesce(p_dados->>'codigo', ''), '\s+', ' ', 'g'));
    if char_length(v.codigo) < 2 or char_length(v.codigo) > 80 then
      raise exception 'codigo_invalido';
    end if;
  end if;

  if p_dados ? 'tipo' or p_dados ? 'tipo_outro' then
    if p_dados ? 'tipo' then
      v.tipo := nullif(btrim(coalesce(p_dados->>'tipo', '')), '');
    end if;
    if v.tipo is not null and v.tipo not in ('aquatica', 'terrestre', 'aerea', 'outras') then
      raise exception 'tipo_operacao_invalido';
    end if;
    if v.tipo = 'outras' then
      if p_dados ? 'tipo_outro' then
        v.tipo_outro := btrim(regexp_replace(coalesce(p_dados->>'tipo_outro', ''), '\s+', ' ', 'g'));
      end if;
      if char_length(coalesce(v.tipo_outro, '')) not between 1 and 60 then
        raise exception 'tipo_operacao_invalido';
      end if;
    else
      v.tipo_outro := null;
    end if;
  end if;

  if p_dados ? 'acionado_em' then
    v_txt := nullif(btrim(coalesce(p_dados->>'acionado_em', '')), '');
    if v_txt is null then
      v.acionado_em := null;
    else
      begin
        v.acionado_em := v_txt::timestamptz;
      exception when others then
        raise exception 'acionamento_invalido';
      end;
      if v.acionado_em > now() + interval '5 minutes' or v.acionado_em < '2000-01-01'::timestamptz then
        raise exception 'acionamento_invalido';
      end if;
    end if;
  end if;

  if p_dados ? 'local_endereco' then
    v.local_endereco := nullif(btrim(regexp_replace(coalesce(p_dados->>'local_endereco', ''), '\s+', ' ', 'g')), '');
    if char_length(coalesce(v.local_endereco, '')) > 300 then
      raise exception 'dados_invalidos';
    end if;
  end if;

  if p_dados ? 'local_lat' or p_dados ? 'local_lng' then
    if jsonb_typeof(p_dados->'local_lat') = 'number' and jsonb_typeof(p_dados->'local_lng') = 'number' then
      v.local_lat := (p_dados->>'local_lat')::double precision;
      v.local_lng := (p_dados->>'local_lng')::double precision;
      if v.local_lat not between -90 and 90 or v.local_lng not between -180 and 180 or (v.local_lat = 0 and v.local_lng = 0) then
        raise exception 'posicao_invalida';
      end if;
    elsif coalesce(jsonb_typeof(p_dados->'local_lat'), 'null') = 'null' and coalesce(jsonb_typeof(p_dados->'local_lng'), 'null') = 'null' then
      v.local_lat := null;
      v.local_lng := null;
    else
      raise exception 'posicao_invalida';
    end if;
  end if;

  if p_dados ? 'descricao' then
    v.descricao := btrim(coalesce(p_dados->>'descricao', ''));
    if char_length(v.descricao) > 2000 then
      raise exception 'dados_invalidos';
    end if;
  end if;
  return v;
end;
$$;

-- Criação: a versão de 2 parâmetros é substituída. Chamadas antigas (sem
-- p_dados) continuam funcionando e criam a operação só com o nome. Com
-- p_dados (painel novo), tipo e data/hora do acionamento são obrigatórios.
drop function if exists public.criar_operacao(text, integer);

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
  end if;
  -- cadastro inicial: o tipo fica para depois, e o início das operações é automático (a hora da criação)
  v_op.acionado_em := coalesce(v_op.acionado_em, now());

  insert into public.operacoes (codigo, responsavel_id, token_civil, token_militar, retencao_horas,
                                tipo, tipo_outro, acionado_em, local_endereco, local_lat, local_lng, descricao, ipo)
  values (v_op.codigo, auth.uid(), public.gerar_token(), public.gerar_token(), p_retencao_horas,
          v_op.tipo, v_op.tipo_outro, v_op.acionado_em, v_op.local_endereco, v_op.local_lat, v_op.local_lng,
          coalesce(v_op.descricao, ''), v_ipo)
  returning * into v_op;

  return row_to_json(v_op);
end;
$$;

-- Edição do cadastro (nome, tipo, acionamento, local, descrição): qualquer
-- responsável da operação. Só os campos enviados mudam.
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

-- ---------------------------------------------------------------------
-- Ficha da vítima
-- ---------------------------------------------------------------------
create table if not exists public.vitimas (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  nome                text not null check (char_length(btrim(nome)) between 1 and 80),
  idade               smallint check (idade between 0 and 130),
  caracteristicas     text not null default '' check (char_length(caracteristicas) <= 1000),
  roupas              text not null default '' check (char_length(roupas) <= 1000),
  observacoes         text not null default '' check (char_length(observacoes) <= 2000),
  foto_caminho        text unique,
  foto_atualizada_em  timestamptz,
  criado_por          uuid references auth.users(id) on delete set null,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text,
  nascimento          text check (nascimento is null or char_length(nascimento) <= 20),
  sexo                text check (sexo is null or sexo in ('M', 'F')),
  origem              text check (origem is null or char_length(origem) <= 120),
  perfil              text[] not null default '{}' check (perfil <@ array['idoso', 'crianca', 'adolescente', 'demencia', 'autismo', 'deficiencia_intelectual', 'transtorno_mental', 'outro']::text[])
);
create index if not exists vitimas_operacao_idx on public.vitimas (operacao_id, criado_em);

alter table public.vitimas enable row level security;
drop policy if exists vitimas_ler on public.vitimas;
create policy vitimas_ler on public.vitimas
  for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.vitimas from anon;
revoke insert, update, delete, truncate on public.vitimas from authenticated;
grant select on public.vitimas to authenticated;

-- Cria (p_id nulo) ou altera uma ficha. Na alteração, só os campos enviados mudam.
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
    v.perfil := '{}';
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
  if p_dados ? 'perfil' then
    if jsonb_typeof(p_dados->'perfil') <> 'array' then
      raise exception 'dados_invalidos';
    end if;
    v.perfil := array(select jsonb_array_elements_text(p_dados->'perfil'));
  end if;
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

  if not (v.perfil <@ array['idoso', 'crianca', 'adolescente', 'demencia', 'autismo', 'deficiencia_intelectual', 'transtorno_mental', 'outro']::text[]) then
    raise exception 'dados_invalidos';
  end if;
  v.atualizado_em := now();
  v.atualizado_por_nome := v_nome_resp;
  if p_id is null then
    insert into public.vitimas select v.*;
  else
    update public.vitimas set nome = v.nome, idade = v.idade, caracteristicas = v.caracteristicas, roupas = v.roupas,
           observacoes = v.observacoes, perfil = v.perfil, nascimento = v.nascimento, sexo = v.sexo, origem = v.origem, atualizado_em = v.atualizado_em, atualizado_por_nome = v.atualizado_por_nome
     where id = v.id;
  end if;
  return row_to_json(v);
end;
$$;

-- Excluir: quem criou a ficha, quem criou a operação ou um administrador da equipe.
create or replace function public.excluir_vitima(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.vitimas%rowtype;
begin
  select * into v from public.vitimas where id = p_id;
  if not found or not public.pode_excluir_registro(v.operacao_id, v.criado_por) then
    raise exception 'sem_permissao';
  end if;
  delete from public.vitimas where id = p_id;   -- a foto entra na fila de arquivos a apagar (gatilho)
end;
$$;

-- Caminho válido da foto: <operacao_id>/<vitima_id>/<uuid>.jpg  → {operacao, vitima, arquivo}
create or replace function public.caminho_vitima_partes(p_nome text)
returns uuid[]
language plpgsql immutable
as $$
begin
  if coalesce(p_nome, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$' then
    return null;
  end if;
  return array[split_part(p_nome, '/', 1)::uuid, split_part(p_nome, '/', 2)::uuid,
               replace(split_part(p_nome, '/', 3), '.jpg', '')::uuid];
end;
$$;

-- Depois de enviar o arquivo ao Storage, o painel registra a foto na ficha.
-- p_caminho nulo tira a foto (o arquivo vai para a fila de remoção).
create or replace function public.definir_foto_vitima(p_vitima uuid, p_caminho text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v public.vitimas%rowtype;
  v_partes uuid[];
begin
  select * into v from public.vitimas where id = p_vitima for update;
  if not found or v_nome_resp is null or not public.dono_operacao(v.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if exists (select 1 from public.operacoes where id = v.operacao_id and dados_apagados_em is not null) then
    raise exception 'operacao_encerrada';
  end if;
  if p_caminho is not null then
    v_partes := public.caminho_vitima_partes(p_caminho);
    if v_partes is null or v_partes[1] <> v.operacao_id or v_partes[2] <> v.id then
      raise exception 'dados_invalidos';
    end if;
    if not exists (select 1 from storage.objects where bucket_id = 'vitimas' and name = p_caminho) then
      raise exception 'foto_nao_enviada';
    end if;
  end if;
  update public.vitimas
     set foto_caminho = p_caminho,
         foto_atualizada_em = case when p_caminho is null then null else now() end,
         atualizado_em = now(), atualizado_por_nome = v_nome_resp
   where id = v.id
  returning * into v;
  return row_to_json(v);
end;
$$;

-- Foto trocada ou ficha excluída: o arquivo antigo entra na fila de remoção do Storage.
create or replace function public.fila_apagar_foto_vitima()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.foto_caminho is not null then
      insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
      values (old.foto_caminho, 'vitimas', old.operacao_id, auth.uid())
      on conflict (caminho) do nothing;
    end if;
    return old;
  end if;
  if old.foto_caminho is not null and old.foto_caminho is distinct from new.foto_caminho then
    insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
    values (old.foto_caminho, 'vitimas', old.operacao_id, auth.uid())
    on conflict (caminho) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists vitimas_apagar_foto on public.vitimas;
create trigger vitimas_apagar_foto after delete or update of foto_caminho on public.vitimas
  for each row execute function public.fila_apagar_foto_vitima();

-- Regras do Storage (bucket "vitimas"):
--   enviar: só responsáveis da operação, na pasta de uma ficha existente;
--   ver: só responsáveis da operação (ou quem excluiu e precisa apagar o arquivo);
--   apagar: só arquivos cujo registro já saiu (fila arquivos_pendentes).
create or replace function public.pode_enviar_foto_vitima(p_nome text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v uuid[] := public.caminho_vitima_partes(p_nome);
begin
  if v is null then
    return false;
  end if;
  return public.dono_operacao(v[1]) and exists (
    select 1 from public.vitimas t join public.operacoes o on o.id = t.operacao_id
     where t.id = v[2] and t.operacao_id = v[1] and o.dados_apagados_em is null);
end;
$$;

create or replace function public.pode_ver_foto_vitima(p_nome text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v uuid[] := public.caminho_vitima_partes(p_nome);
begin
  if v is null then
    return false;
  end if;
  return public.dono_operacao(v[1])
      or exists (select 1 from public.arquivos_pendentes a where a.caminho = p_nome and a.bucket = 'vitimas' and a.excluido_por = auth.uid());
end;
$$;

create or replace function public.pode_apagar_foto_vitima(p_nome text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  return exists (
    select 1 from public.arquivos_pendentes a
     where a.caminho = p_nome and a.bucket = 'vitimas'
       and (a.excluido_por = auth.uid() or (a.operacao_id is not null and public.dono_operacao(a.operacao_id))));
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vitimas', 'vitimas', false, 10485760, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists gbs_vitimas_enviar on storage.objects;
create policy gbs_vitimas_enviar on storage.objects
  for insert to authenticated
  with check (bucket_id = 'vitimas' and public.pode_enviar_foto_vitima(name));

drop policy if exists gbs_vitimas_ver on storage.objects;
create policy gbs_vitimas_ver on storage.objects
  for select to authenticated
  using (bucket_id = 'vitimas' and public.pode_ver_foto_vitima(name));

drop policy if exists gbs_vitimas_apagar on storage.objects;
create policy gbs_vitimas_apagar on storage.objects
  for delete to authenticated
  using (bucket_id = 'vitimas' and public.pode_apagar_foto_vitima(name));

-- Arquivos a apagar deste responsável, com o bucket (fotos de campo ou fotos de vítimas).
create or replace function public.meus_arquivos_pendentes_v2()
returns json
language sql stable security definer set search_path = public
as $$
  select coalesce(json_agg(json_build_object('caminho', caminho, 'bucket', bucket)), '[]'::json)
    from (select caminho, bucket from public.arquivos_pendentes
           where excluido_por = auth.uid() order by criado_em limit 1000) x;
$$;

-- Retenção: dados apagados → fichas apagadas (as fotos entram na fila).
create or replace function public.apagar_vitimas_da_operacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.vitimas where operacao_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists operacoes_apagar_vitimas on public.operacoes;
create trigger operacoes_apagar_vitimas after update of dados_apagados_em on public.operacoes
  for each row execute function public.apagar_vitimas_da_operacao();

-- Exclusão definitiva: informa também quantas fichas de vítima foram apagadas.
create or replace function public.excluir_operacao(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_codigo text;
  v_fotos integer;
  v_participantes integer;
  v_vitimas integer;
begin
  if not (public.eh_criador(p_operacao) or (public.eh_admin() and public.dono_operacao(p_operacao))) then
    raise exception 'sem_permissao';
  end if;
  select codigo into v_codigo from public.operacoes where id = p_operacao for update;
  if v_codigo is null then
    raise exception 'sem_permissao';
  end if;
  select count(*) into v_fotos from public.fotos where operacao_id = p_operacao;
  select count(*) into v_participantes from public.participantes where operacao_id = p_operacao and tipo <> 'responsavel';
  select count(*) into v_vitimas from public.vitimas where operacao_id = p_operacao;

  delete from public.operacoes where id = p_operacao;   -- apaga em cascata tudo o que é da operação

  return json_build_object('operacao', v_codigo, 'fotos', v_fotos, 'participantes', v_participantes, 'vitimas', v_vitimas);
end;
$$;

revoke execute on function public.aplicar_cadastro_operacao(public.operacoes, jsonb) from public, anon, authenticated;
revoke execute on function public.apagar_vitimas_da_operacao(), public.fila_apagar_foto_vitima() from public, anon, authenticated;
revoke execute on function
  public.criar_operacao(text, integer, jsonb), public.atualizar_operacao(uuid, jsonb),
  public.salvar_vitima(uuid, uuid, jsonb), public.excluir_vitima(uuid), public.definir_foto_vitima(uuid, text),
  public.caminho_vitima_partes(text), public.pode_enviar_foto_vitima(text), public.pode_ver_foto_vitima(text),
  public.pode_apagar_foto_vitima(text), public.meus_arquivos_pendentes_v2(), public.excluir_operacao(uuid)
  from public, anon;
grant execute on function
  public.criar_operacao(text, integer, jsonb), public.atualizar_operacao(uuid, jsonb),
  public.salvar_vitima(uuid, uuid, jsonb), public.excluir_vitima(uuid), public.definir_foto_vitima(uuid, text),
  public.caminho_vitima_partes(text), public.pode_enviar_foto_vitima(text), public.pode_ver_foto_vitima(text),
  public.pode_apagar_foto_vitima(text), public.meus_arquivos_pendentes_v2(), public.excluir_operacao(uuid)
  to authenticated;

-- Tempo real: fichas aparecem para os outros responsáveis sem recarregar.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.vitimas';
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- =====================================================================
-- 15. GRUPOS DENTRO DA OPERAÇÃO
--     (migração 008 — idempotente; exige a 007)
--
--  grupos          grupos com nome livre (ex.: Polícia Civil, Bombeiros), com cor
--  grupo_convites  o link (token) de cada grupo — separado dos dados do grupo
--                  para que um membro, que lê o grupo, NÃO leia o link
--  grupo_membros   quem está em cada grupo e com que papel (responsável/membro)
--
--  Quem vê o quê (RLS):
--   * responsáveis da operação: todos os grupos, membros e links da operação;
--   * participante: SOMENTE os grupos aos quais pertence e a própria linha de
--     membro (com o papel). Nunca lê os links nem os outros membros.
--  O navegador não grava nessas tabelas: tudo passa pelas funções abaixo.
--
--  Link do grupo: entra na operação E no grupo, sempre como "membro". O papel
--  de responsável do grupo só é dado pelo painel. Pelo link de um grupo, a
--  pessoa entra como civil, a não ser que o grupo permita militares.
--  "Gerar novo link" troca o token: o link anterior deixa de funcionar na hora.
--  Uma pessoa pode estar em mais de um grupo.
-- =====================================================================

-- Chave composta: garante que grupo e pessoa de um vínculo são da MESMA operação.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'participantes_id_operacao_key') then
    alter table public.participantes add constraint participantes_id_operacao_key unique (id, operacao_id);
  end if;
end;
$$;

create table if not exists public.grupos (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  nome                text not null check (char_length(btrim(nome)) between 1 and 60),
  cor                 text not null default '#f59e0b' check (cor ~ '^#[0-9a-fA-F]{6}$'),
  permite_militar     boolean not null default false,
  criado_por          uuid references auth.users(id) on delete set null,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text,
  constraint grupos_id_operacao_key unique (id, operacao_id)
);
create unique index if not exists grupos_nome_unico on public.grupos (operacao_id, lower(nome));

create table if not exists public.grupo_convites (
  grupo_id         uuid primary key references public.grupos(id) on delete cascade,
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  token            text not null unique check (char_length(token) = 64),
  criado_em        timestamptz not null default now(),
  criado_por_nome  text
);

create table if not exists public.grupo_membros (
  grupo_id             uuid not null,
  participante_id      uuid not null,
  operacao_id          uuid not null,
  papel                text not null default 'membro' check (papel in ('responsavel', 'membro')),
  origem               text not null default 'painel' check (origem in ('painel', 'link')),
  adicionado_por_nome  text,
  criado_em            timestamptz not null default now(),
  atualizado_em        timestamptz not null default now(),
  primary key (grupo_id, participante_id),
  constraint grupo_membros_grupo_fk foreign key (grupo_id, operacao_id)
    references public.grupos(id, operacao_id) on delete cascade,
  constraint grupo_membros_participante_fk foreign key (participante_id, operacao_id)
    references public.participantes(id, operacao_id) on delete cascade
);
create index if not exists grupo_membros_participante_idx on public.grupo_membros (participante_id);
create index if not exists grupo_membros_operacao_idx on public.grupo_membros (operacao_id);

-- A pessoa logada é participante ATIVO deste grupo? (security definer: evita a
-- recursão de uma política de grupo_membros consultando a própria tabela)
create or replace function public.eh_membro_grupo(p_grupo uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.grupo_membros m
      join public.participantes p on p.id = m.participante_id
     where m.grupo_id = p_grupo and p.user_id = auth.uid() and not p.removido and p.liberado_em is null);
$$;

alter table public.grupos enable row level security;
alter table public.grupo_convites enable row level security;
alter table public.grupo_membros enable row level security;

drop policy if exists grupos_ler on public.grupos;
create policy grupos_ler on public.grupos
  for select to authenticated using (public.dono_operacao(operacao_id) or public.eh_membro_grupo(id));

drop policy if exists grupo_convites_ler on public.grupo_convites;
create policy grupo_convites_ler on public.grupo_convites
  for select to authenticated using (public.dono_operacao(operacao_id));

drop policy if exists grupo_membros_ler on public.grupo_membros;
create policy grupo_membros_ler on public.grupo_membros
  for select to authenticated using (public.dono_operacao(operacao_id) or public.eh_meu_participante(participante_id));

revoke all on public.grupos, public.grupo_convites, public.grupo_membros from anon;
revoke insert, update, delete, truncate on public.grupos, public.grupo_convites, public.grupo_membros from authenticated;
grant select on public.grupos, public.grupo_convites, public.grupo_membros to authenticated;

-- ---------------------------------------------------------------------
-- Funções do painel (responsáveis da operação)
-- ---------------------------------------------------------------------

-- Cria (p_id nulo) ou altera um grupo: nome, cor, permite_militar.
create or replace function public.salvar_grupo(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v public.grupos%rowtype;
  v_op public.operacoes%rowtype;
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
    v.cor := '#f59e0b';
    v.permite_militar := false;
    v.criado_por := auth.uid();
    v.criado_por_nome := v_nome_resp;
    v.criado_em := now();
  else
    select * into v from public.grupos where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'grupo_nao_encontrado';
    end if;
  end if;

  if p_dados ? 'nome' then v.nome := btrim(regexp_replace(coalesce(p_dados->>'nome', ''), '\s+', ' ', 'g')); end if;
  if p_dados ? 'cor' then v.cor := p_dados->>'cor'; end if;
  if p_dados ? 'permite_militar' then
    if jsonb_typeof(p_dados->'permite_militar') <> 'boolean' then
      raise exception 'dados_invalidos';
    end if;
    v.permite_militar := (p_dados->>'permite_militar')::boolean;
  end if;
  if v.nome is null or char_length(v.nome) not between 1 and 60 then
    raise exception 'nome_grupo_invalido';
  end if;
  if v.cor is null or v.cor !~ '^#[0-9a-fA-F]{6}$' then
    raise exception 'dados_invalidos';
  end if;

  v.atualizado_em := now();
  v.atualizado_por_nome := v_nome_resp;
  begin
    if p_id is null then
      insert into public.grupos select v.*;
      insert into public.grupo_convites (grupo_id, operacao_id, token, criado_por_nome)
      values (v.id, v.operacao_id, public.gerar_token(), v_nome_resp);
    else
      update public.grupos set nome = v.nome, cor = v.cor, permite_militar = v.permite_militar,
             atualizado_em = v.atualizado_em, atualizado_por_nome = v.atualizado_por_nome
       where id = v.id;
    end if;
  exception when unique_violation then
    raise exception 'grupo_existente';
  end;
  return row_to_json(v);
end;
$$;

-- Excluir o grupo: quem o criou, quem criou a operação ou um administrador.
-- Os vínculos e o link são apagados junto; as pessoas continuam na operação.
create or replace function public.excluir_grupo(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.grupos%rowtype;
begin
  select * into v from public.grupos where id = p_id;
  if not found or not public.pode_excluir_registro(v.operacao_id, v.criado_por) then
    raise exception 'sem_permissao';
  end if;
  delete from public.grupos where id = p_id;
end;
$$;

-- Coloca uma pessoa no grupo (ou muda o papel dela). Só pelo painel.
create or replace function public.definir_membro(p_grupo uuid, p_participante uuid, p_papel text default 'membro')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_g public.grupos%rowtype;
  v_m public.grupo_membros%rowtype;
begin
  select * into v_g from public.grupos where id = p_grupo;
  if not found or v_nome_resp is null or not public.dono_operacao(v_g.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if exists (select 1 from public.operacoes where id = v_g.operacao_id and dados_apagados_em is not null) then
    raise exception 'operacao_encerrada';
  end if;
  if coalesce(p_papel, '') not in ('responsavel', 'membro') then
    raise exception 'dados_invalidos';
  end if;
  if not exists (select 1 from public.participantes where id = p_participante and operacao_id = v_g.operacao_id) then
    raise exception 'participante_invalido';
  end if;
  insert into public.grupo_membros (grupo_id, participante_id, operacao_id, papel, origem, adicionado_por_nome)
  values (v_g.id, p_participante, v_g.operacao_id, p_papel, 'painel', v_nome_resp)
  on conflict (grupo_id, participante_id) do update
     set papel = excluded.papel, atualizado_em = now()
  returning * into v_m;
  return row_to_json(v_m);
end;
$$;

create or replace function public.remover_membro(p_grupo uuid, p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_op uuid;
begin
  select operacao_id into v_op from public.grupos where id = p_grupo;
  if v_op is null or public.nome_responsavel_atual() is null or not public.dono_operacao(v_op) then
    raise exception 'sem_permissao';
  end if;
  delete from public.grupo_membros where grupo_id = p_grupo and participante_id = p_participante;
end;
$$;

-- Link (token) do grupo: só responsáveis da operação.
create or replace function public.link_do_grupo(p_grupo uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_g public.grupos%rowtype;
  v_token text;
begin
  select * into v_g from public.grupos where id = p_grupo;
  if not found or not public.dono_operacao(v_g.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select token into v_token from public.grupo_convites where grupo_id = p_grupo;
  if v_token is null then
    insert into public.grupo_convites (grupo_id, operacao_id, token, criado_por_nome)
    values (v_g.id, v_g.operacao_id, public.gerar_token(), public.nome_responsavel_atual())
    returning token into v_token;
  end if;
  return json_build_object('grupo_id', v_g.id, 'token', v_token, 'permite_militar', v_g.permite_militar);
end;
$$;

-- Troca o link do grupo: o anterior deixa de funcionar na hora.
create or replace function public.gerar_novo_link_grupo(p_grupo uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_g public.grupos%rowtype;
  v_nome text := public.nome_responsavel_atual();
  v_token text := public.gerar_token();
begin
  select * into v_g from public.grupos where id = p_grupo;
  if not found or v_nome is null or not public.dono_operacao(v_g.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  insert into public.grupo_convites (grupo_id, operacao_id, token, criado_por_nome)
  values (v_g.id, v_g.operacao_id, v_token, v_nome)
  on conflict (grupo_id) do update set token = excluded.token, criado_em = now(), criado_por_nome = excluded.criado_por_nome;
  return json_build_object('grupo_id', v_g.id, 'token', v_token, 'permite_militar', v_g.permite_militar);
end;
$$;

-- ---------------------------------------------------------------------
-- Funções do participante
-- ---------------------------------------------------------------------

-- Grupos do próprio participante (nome, cor e o papel dele). Nada sobre os outros membros.
create or replace function public.meus_grupos(p_participante uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found then
    raise exception 'participante_invalido';
  end if;
  return coalesce((
    select json_agg(json_build_object('id', g.id, 'nome', g.nome, 'cor', g.cor, 'papel', m.papel) order by g.nome)
      from public.grupo_membros m join public.grupos g on g.id = m.grupo_id
     where m.participante_id = v_part.id), '[]'::json);
end;
$$;

-- Tela inicial: aceita também o link de um grupo (mostra o nome do grupo).
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
    'tipos_permitidos', case when v_tipo = 'militar' then json_build_array('militar', 'civil') else json_build_array('civil') end,
    'grupo', v_grupo
  );
end;
$$;

-- Ingresso: igual ao anterior, aceitando também o link de um grupo. Pelo link
-- do grupo a pessoa entra na operação e no grupo (papel "membro").
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

  -- CPF e celular: obrigatórios para civis; opcionais para militares (se informados, válidos).
  if coalesce(btrim(p_cpf), '') <> '' and v_cpf is null then
    raise exception 'cpf_invalido';
  end if;
  if coalesce(btrim(p_telefone), '') <> '' and v_tel is null then
    raise exception 'telefone_invalido';
  end if;
  if v_tipo = 'civil' and v_cpf is null then
    raise exception 'cpf_invalido';
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

-- Retenção: dados apagados → grupos, links e vínculos apagados.
create or replace function public.apagar_grupos_da_operacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.grupos where operacao_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists operacoes_apagar_grupos on public.operacoes;
create trigger operacoes_apagar_grupos after update of dados_apagados_em on public.operacoes
  for each row execute function public.apagar_grupos_da_operacao();

revoke execute on function public.apagar_grupos_da_operacao() from public, anon, authenticated;
revoke execute on function
  public.eh_membro_grupo(uuid), public.salvar_grupo(uuid, uuid, jsonb), public.excluir_grupo(uuid),
  public.definir_membro(uuid, uuid, text), public.remover_membro(uuid, uuid), public.link_do_grupo(uuid),
  public.gerar_novo_link_grupo(uuid), public.meus_grupos(uuid), public.info_operacao(text),
  public.ingressar(text, text, text, text, text)
  from public, anon;
grant execute on function
  public.eh_membro_grupo(uuid), public.salvar_grupo(uuid, uuid, jsonb), public.excluir_grupo(uuid),
  public.definir_membro(uuid, uuid, text), public.remover_membro(uuid, uuid), public.link_do_grupo(uuid),
  public.gerar_novo_link_grupo(uuid), public.meus_grupos(uuid), public.info_operacao(text),
  public.ingressar(text, text, text, text, text)
  to authenticated;
-- A tela inicial do participante mostra o nome da operação (e do grupo) antes do login anônimo.
grant execute on function public.info_operacao(text) to anon;

-- Tempo real para os painéis (o RLS continua valendo para quem assina).
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['grupos', 'grupo_membros'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- =====================================================================
-- 16. TRILHA GPS COM SUPORTE OFFLINE (confirmação por ponto)
--     (migração 009 — idempotente; exige a 008)
--
--  operacoes.gps_intervalo_s  intervalo MÁXIMO sem ponto na trilha (padrão 15 s):
--                             parado, o celular confirma a posição nesse ritmo;
--                             andando ou em veículo os pontos continuam mais
--                             frequentes (filtro de gps.js).
--  operacoes.gps_lacuna_s     intervalo entre dois pontos seguidos acima do qual
--                             o painel desenha o trecho como FALHA (tracejado,
--                             com início e fim marcados). Padrão 60 s.
--
--  enviar_posicoes_lote: mesma gravação de enviar_posicoes (idempotente pelo
--  id gerado no celular), mas devolve QUAIS pontos o servidor confirmou
--  (inseridos agora ou já gravados antes) e quais recusou, com o motivo. O
--  celular só marca um ponto como enviado depois dessa confirmação.
--  enviar_posicoes continua igual (páginas antigas abertas seguem funcionando).
--
--  apos_posicoes: gancho chamado depois de gravar posições (usado pela
--  migração 010 para os alertas dos deslocamentos de grupo).
-- =====================================================================

alter table public.operacoes add column if not exists gps_intervalo_s integer not null default 15;
alter table public.operacoes add column if not exists gps_lacuna_s integer not null default 60;
alter table public.operacoes drop constraint if exists operacoes_gps_check;
alter table public.operacoes add constraint operacoes_gps_check check (
  gps_intervalo_s between 5 and 300 and gps_lacuna_s between 30 and 3600 and gps_lacuna_s > gps_intervalo_s);

-- Gancho depois de gravar posições. Criado vazio só se ainda não existir
-- (a migração 010 o substitui; rodar esta migração de novo não o desfaz).
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'apos_posicoes') then
    execute $f$
      create function public.apos_posicoes(p_participante uuid)
      returns void
      language plpgsql security definer set search_path = public
      as $b$ begin return; end; $b$
    $f$;
  end if;
end;
$$;
revoke execute on function public.apos_posicoes(uuid) from public, anon, authenticated;

-- Configuração do GPS da operação (painel → Dados da operação).
create or replace function public.configurar_gps_operacao(p_operacao uuid, p_intervalo_s integer, p_lacuna_s integer)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_op public.operacoes%rowtype;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if p_intervalo_s is null or p_intervalo_s not between 5 and 300
     or p_lacuna_s is null or p_lacuna_s not between 30 and 3600 or p_lacuna_s <= p_intervalo_s then
    raise exception 'gps_config_invalida';
  end if;
  update public.operacoes
     set gps_intervalo_s = p_intervalo_s, gps_lacuna_s = p_lacuna_s, atualizado_em = now(), atualizado_por_nome = v_nome
   where id = p_operacao
  returning * into v_op;
  return row_to_json(v_op);
end;
$$;

-- Versão anterior, agora chamando o gancho apos_posicoes (o resto não mudou).
create or replace function public.enviar_posicoes(p_participante uuid, p_pontos jsonb, p_gps text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
  v_inseridos integer := 0;
  v_ult record;
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
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  if v_op.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_pontos is null or jsonb_typeof(p_pontos) <> 'array' or jsonb_array_length(p_pontos) > 500 then
    raise exception 'lote_invalido';
  end if;

  with numericos as (
    select case when jsonb_typeof(e) = 'object'
                 and coalesce(e ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (e ->> 'id')::uuid end as client_id,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'lat') = 'number' then (e -> 'lat')::numeric end as lat,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'lng') = 'number' then (e -> 'lng')::numeric end as lng,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'prec') = 'number' then (e -> 'prec')::numeric end as prec,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 't') = 'number' then (e -> 't')::numeric end as t
      from jsonb_array_elements(p_pontos) as e
  ), validos as (
    select client_id,
           case when lat between -90 and 90 then lat::double precision end as lat,
           case when lng between -180 and 180 then lng::double precision end as lng,
           case when prec between 0 and 100000 then prec::real end as prec,
           case when t between 946684800000 and 4102444800000
                then to_timestamp((t / 1000)::double precision) end as registrado_em
      from numericos
  ), dentro_do_periodo as (
    select * from validos
     where client_id is not null
       and lat is not null and lng is not null
       and not (lat = 0 and lng = 0)
       and registrado_em between v_op.criada_em - interval '10 minutes' and now() + interval '2 minutes'
  ), inseridos as (
    insert into public.posicoes (operacao_id, participante_id, client_id, lat, lng, precisao, registrado_em)
    select v_op.id, v_part.id, client_id, lat, lng, prec, registrado_em from dentro_do_periodo
    on conflict (participante_id, client_id) do nothing
    returning 1
  )
  select count(*) into v_inseridos from inseridos;

  select lat, lng, precisao, registrado_em into v_ult
    from public.posicoes
   where participante_id = v_part.id
   order by registrado_em desc
   limit 1;

  update public.participantes
     set ultimo_contato_em = now(),
         rastreando = true,
         gps_estado = case when p_gps in ('ok', 'fraco', 'sem_sinal', 'negado', 'indisponivel') then p_gps
                           when v_inseridos > 0 then 'ok'
                           else gps_estado end,
         ultima_lat = coalesce(v_ult.lat, ultima_lat),
         ultima_lng = coalesce(v_ult.lng, ultima_lng),
         ultima_precisao = case when v_ult.registrado_em is not null then v_ult.precisao else ultima_precisao end,
         ultima_posicao_em = coalesce(v_ult.registrado_em, ultima_posicao_em)
   where id = v_part.id;

  if v_inseridos > 0 then
    begin
      perform public.apos_posicoes(v_part.id);
    exception when others then
      raise warning 'apos_posicoes: %', sqlerrm;   -- nunca impede a gravação das posições
    end;
  end if;

  return json_build_object('status', 'ativa', 'recebidos', jsonb_array_length(p_pontos), 'inseridos', v_inseridos);
end;
$$;

-- Lote com confirmação por ponto. Formato de cada ponto, como em enviar_posicoes:
--   {"id": "<uuid gerado no celular>", "lat": -15.79, "lng": -47.88, "prec": 8.5, "t": <epoch ms>}
-- Resposta: { status, confirmados: [ids gravados no servidor], recusados: [{id, motivo}],
--             inseridos, gps_intervalo_s, gps_lacuna_s }
--   motivo: 'invalido' (dados malformados) ou 'fora_do_periodo' (horário antes
--   da operação ou no futuro). Reenviar um ponto já gravado o confirma de novo.
create or replace function public.enviar_posicoes_lote(p_participante uuid, p_pontos jsonb, p_gps text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
  v_inseridos integer := 0;
  v_ult record;
  v_ids uuid[];
  v_lats double precision[];
  v_lngs double precision[];
  v_precs real[];
  v_ts timestamptz[];
  v_recusados jsonb;
  v_confirmados json := '[]'::json;
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
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  if v_op.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_pontos is null or jsonb_typeof(p_pontos) <> 'array' or jsonb_array_length(p_pontos) > 500 then
    raise exception 'lote_invalido';
  end if;

  -- Classifica cada ponto (conversões protegidas por CASE: um ponto malformado
  -- não derruba o lote).
  with numericos as (
    select case when jsonb_typeof(e) = 'object' then left(e ->> 'id', 64) end as id_txt,
           case when jsonb_typeof(e) = 'object'
                 and coalesce(e ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (e ->> 'id')::uuid end as client_id,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'lat') = 'number' then (e -> 'lat')::numeric end as lat,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'lng') = 'number' then (e -> 'lng')::numeric end as lng,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'prec') = 'number' then (e -> 'prec')::numeric end as prec,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 't') = 'number' then (e -> 't')::numeric end as t
      from jsonb_array_elements(p_pontos) as e
  ), validos as (
    select id_txt, client_id,
           case when lat between -90 and 90 then lat::double precision end as lat,
           case when lng between -180 and 180 then lng::double precision end as lng,
           case when prec between 0 and 100000 then prec::real end as prec,
           case when t between 946684800000 and 4102444800000
                then to_timestamp((t / 1000)::double precision) end as registrado_em
      from numericos
  ), classificados as (
    select *,
           case when client_id is null or lat is null or lng is null or (lat = 0 and lng = 0) or registrado_em is null then 'invalido'
                when registrado_em not between v_op.criada_em - interval '10 minutes' and now() + interval '2 minutes' then 'fora_do_periodo'
           end as motivo
      from validos
  )
  select array_agg(client_id order by registrado_em) filter (where motivo is null),
         array_agg(lat order by registrado_em) filter (where motivo is null),
         array_agg(lng order by registrado_em) filter (where motivo is null),
         array_agg(prec order by registrado_em) filter (where motivo is null),
         array_agg(registrado_em order by registrado_em) filter (where motivo is null),
         coalesce(jsonb_agg(jsonb_build_object('id', id_txt, 'motivo', motivo)) filter (where motivo is not null), '[]'::jsonb)
    into v_ids, v_lats, v_lngs, v_precs, v_ts, v_recusados
    from classificados;

  if v_ids is not null then
    insert into public.posicoes (operacao_id, participante_id, client_id, lat, lng, precisao, registrado_em)
    select v_op.id, v_part.id, u.cid, u.la, u.ln, u.pr, u.t
      from unnest(v_ids, v_lats, v_lngs, v_precs, v_ts) as u(cid, la, ln, pr, t)
    on conflict (participante_id, client_id) do nothing;
    get diagnostics v_inseridos = row_count;

    -- Confirmados: os que EXISTEM no servidor agora (inseridos neste envio ou antes).
    select coalesce(json_agg(p.client_id), '[]'::json) into v_confirmados
      from public.posicoes p
     where p.participante_id = v_part.id and p.client_id = any (v_ids);
  end if;

  select lat, lng, precisao, registrado_em into v_ult
    from public.posicoes
   where participante_id = v_part.id
   order by registrado_em desc
   limit 1;

  update public.participantes
     set ultimo_contato_em = now(),
         rastreando = true,
         gps_estado = case when p_gps in ('ok', 'fraco', 'sem_sinal', 'negado', 'indisponivel') then p_gps
                           when v_inseridos > 0 then 'ok'
                           else gps_estado end,
         ultima_lat = coalesce(v_ult.lat, ultima_lat),
         ultima_lng = coalesce(v_ult.lng, ultima_lng),
         ultima_precisao = case when v_ult.registrado_em is not null then v_ult.precisao else ultima_precisao end,
         ultima_posicao_em = coalesce(v_ult.registrado_em, ultima_posicao_em)
   where id = v_part.id;

  if v_inseridos > 0 then
    begin
      perform public.apos_posicoes(v_part.id);
    exception when others then
      raise warning 'apos_posicoes: %', sqlerrm;   -- nunca impede a gravação das posições
    end;
  end if;

  return json_build_object(
    'status', 'ativa',
    'recebidos', jsonb_array_length(p_pontos),
    'inseridos', v_inseridos,
    'confirmados', v_confirmados,
    'recusados', v_recusados,
    'gps_intervalo_s', v_op.gps_intervalo_s,
    'gps_lacuna_s', v_op.gps_lacuna_s
  );
end;
$$;

-- Sinal de vida: igual ao anterior, informando também o intervalo de GPS da operação.
create or replace function public.sinal_vida(p_participante uuid, p_rastreando boolean, p_gps text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found then
    return json_build_object('status', 'inexistente');
  end if;
  if v_part.liberado_em is not null then
    return json_build_object('status', 'liberado');
  end if;
  if v_part.removido then
    return json_build_object('status', 'removido');
  end if;
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  if v_op.status <> 'ativa' then
    return json_build_object('status', 'encerrada');
  end if;

  update public.participantes
     set ultimo_contato_em = now(),
         rastreando = coalesce(p_rastreando, rastreando),
         gps_estado = case when p_gps in ('aguardando', 'ok', 'fraco', 'sem_sinal', 'negado', 'indisponivel') then p_gps
                           else gps_estado end
   where id = v_part.id;

  return json_build_object('status', 'ativa', 'agora', now(), 'saida_solicitada_em', v_part.saida_solicitada_em,
                           'gps_intervalo_s', v_op.gps_intervalo_s);
end;
$$;

revoke execute on function public.configurar_gps_operacao(uuid, integer, integer),
  public.enviar_posicoes(uuid, jsonb, text), public.enviar_posicoes_lote(uuid, jsonb, text),
  public.sinal_vida(uuid, boolean, text) from public, anon;
grant execute on function public.configurar_gps_operacao(uuid, integer, integer),
  public.enviar_posicoes(uuid, jsonb, text), public.enviar_posicoes_lote(uuid, jsonb, text),
  public.sinal_vida(uuid, boolean, text) to authenticated;

notify pgrst, 'reload schema';

-- =====================================================================
-- 17. DESTINO PARA GRUPOS, ALERTAS AUTOMÁTICOS E CONTROLE DE RETORNO
--     (migração 010 — idempotente; exige a 009)
--
--  BASE (pontos_interesse.categoria): base da operação; raio_m = raio de
--    chegada (padrão 100 m). Aparece também no mapa do participante.
--
--  missoes          destino enviado a um GRUPO (setor ou ponto), com o público
--                   (só o responsável do grupo ou todos os membros), a base, o
--                   raio da base e o prazo de retorno.
--  missao_membros   quem é acompanhado em cada missão (todos os membros ativos
--                   de campo do grupo) e quando iniciou, chegou ao setor e
--                   voltou à base. Cada destinatário recebe uma linha comum em
--                   "destinos" (com missao_id): o celular não muda nada para
--                   receber o destino (tempo real, rota, "Você chegou").
--  alertas          alertas para os responsáveis da operação (tempo real).
--                   chave única: cada evento gera UM alerta, mesmo com reenvio
--                   de pontos ou duas verificações ao mesmo tempo.
--
--  Eventos (calculados no SERVIDOR pela trilha GPS — posicoes —, pela hora do
--  GPS; pontos com precisão pior que 150 m não contam):
--    início do deslocamento  1º ponto a ≥ 100 m da posição no envio (ou fora
--                            do raio da base, para quem estava na base)
--    chegada ao setor        2 pontos seguidos dentro do setor (círculo ou
--                            polígono); destino sem setor: a até 30 m do ponto
--    finalização da busca    ação do responsável do grupo (celular) ou de um
--                            responsável da operação (painel)
--    chegada à base          ponto a até raio_base_m da base com precisão
--                            ≤ raio_base_m; a missão fica "na base" quando
--                            TODOS os acompanhados ativos chegam
--    retorno atrasado        prazo vencido sem todos na base: alerta CRÍTICO
--                            ("a equipe pode estar perdida"). Verificado por
--                            tempo (pg_cron, a cada minuto) — funciona mesmo com
--                            o celular sem sinal e sem nenhum painel aberto.
--                            Sem pg_cron, o painel aberto faz a verificação.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Base: categoria nova de ponto de interesse
-- ---------------------------------------------------------------------
alter table public.pontos_interesse drop constraint if exists pontos_interesse_categoria_check;
alter table public.pontos_interesse add constraint pontos_interesse_categoria_check check (
  categoria in ('ULTIMA_LOCALIZACAO', 'POSSIVEL_LOCALIZACAO', 'VESTIGIO', 'RISCO', 'ENCONTRO', 'VITIMA_ENCONTRADA', 'OUTRO', 'BASE'));

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
    update public.pontos_interesse set categoria = v_p.categoria, titulo = v_p.titulo, descricao = v_p.descricao,
           lat = v_p.lat, lng = v_p.lng, foto_id = v_p.foto_id, raio_m = v_p.raio_m, atualizado_em = v_p.atualizado_em,
           atualizado_por_nome = v_p.atualizado_por_nome
     where id = v_p.id;
  end if;
  return row_to_json(v_p);
end;
$$;

-- ---------------------------------------------------------------------
-- Geometria (sem PostGIS): mesmas contas de gps.js / militar.js
-- ---------------------------------------------------------------------
create or replace function public.distancia_m(lat1 double precision, lng1 double precision,
                                              lat2 double precision, lng2 double precision)
returns double precision
language sql immutable
as $$
  select 2 * 6371000 * asin(least(1, sqrt(
           power(sin(radians(lat2 - lat1) / 2), 2) +
           cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))));
$$;

-- Ponto dentro do setor: círculo (distância ao centro ≤ raio) ou polígono
-- (cruzamento de raio sobre os vértices [[lat, lng], …]).
create or replace function public.ponto_no_setor(p_setor public.setores, p_lat double precision, p_lng double precision)
returns boolean
language plpgsql immutable
as $$
declare
  n integer;
  j integer;
  yi double precision; xi double precision;
  yj double precision; xj double precision;
  dentro boolean := false;
begin
  if p_setor.forma = 'circulo' then
    return public.distancia_m(p_setor.centro_lat, p_setor.centro_lng, p_lat, p_lng) <= p_setor.raio_m;
  end if;
  n := coalesce(jsonb_array_length(p_setor.pontos), 0);
  if n < 3 then
    return false;
  end if;
  j := n - 1;
  for i in 0 .. n - 1 loop
    yi := (p_setor.pontos->i->>0)::double precision; xi := (p_setor.pontos->i->>1)::double precision;
    yj := (p_setor.pontos->j->>0)::double precision; xj := (p_setor.pontos->j->>1)::double precision;
    if (yi > p_lat) <> (yj > p_lat) then
      if p_lng < (xj - xi) * (p_lat - yi) / (yj - yi) + xi then
        dentro := not dentro;
      end if;
    end if;
    j := i;
  end loop;
  return dentro;
end;
$$;

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.missoes (
  id                         uuid primary key default gen_random_uuid(),
  operacao_id                uuid not null references public.operacoes(id) on delete cascade,
  grupo_id                   uuid references public.grupos(id) on delete set null,
  grupo_nome                 text not null,
  setor_id                   uuid references public.setores(id) on delete set null,
  setor_nome                 text,
  ponto_id                   uuid references public.pontos_interesse(id) on delete set null,
  nome                       text not null check (char_length(btrim(nome)) between 1 and 80),
  lat                        double precision not null check (lat between -90 and 90),
  lng                        double precision not null check (lng between -180 and 180),
  modo                       text not null default 'a_pe' check (modo in ('a_pe', 'trilha', 'carro')),
  publico                    text not null check (publico in ('responsavel', 'todos')),
  base_id                    uuid references public.pontos_interesse(id) on delete set null,
  base_nome                  text,
  base_lat                   double precision,
  base_lng                   double precision,
  raio_base_m                double precision check (raio_base_m is null or raio_base_m between 10 and 5000),
  prazo_retorno_min          integer not null default 30 check (prazo_retorno_min between 5 and 720),
  status                     text not null default 'enviada'
                             check (status in ('enviada', 'em_deslocamento', 'no_setor', 'busca_finalizada',
                                               'retorno_atrasado', 'na_base', 'encerrada')),
  enviada_em                 timestamptz not null default now(),
  enviado_por                uuid references auth.users(id) on delete set null,
  enviado_por_nome           text not null,
  iniciada_em                timestamptz,
  chegou_setor_em            timestamptz,
  busca_finalizada_em        timestamptz,
  busca_finalizada_por_nome  text,
  prazo_retorno_em           timestamptz,
  chegou_base_em             timestamptz,
  encerrada_em               timestamptz,
  encerrada_por_nome         text,
  check ((base_lat is null) = (base_lng is null) and (base_lat is null) = (raio_base_m is null))
);
create index if not exists missoes_operacao_idx on public.missoes (operacao_id, enviada_em desc);
create index if not exists missoes_ativas_idx on public.missoes (status) where status in ('busca_finalizada', 'retorno_atrasado');

create table if not exists public.missao_membros (
  missao_id        uuid not null references public.missoes(id) on delete cascade,
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  recebe_destino   boolean not null,
  destino_id       uuid references public.destinos(id) on delete set null,
  inicio_lat       double precision,
  inicio_lng       double precision,
  inicio_na_base   boolean not null default false,
  ultimo_pos_id    bigint not null default 0,
  dentro_seq       smallint not null default 0,
  iniciou_em       timestamptz,
  chegou_setor_em  timestamptz,
  chegou_base_em   timestamptz,
  primary key (missao_id, participante_id)
);
create index if not exists missao_membros_participante_idx on public.missao_membros (participante_id);

alter table public.destinos add column if not exists missao_id uuid references public.missoes(id) on delete set null;

create table if not exists public.alertas (
  id                    bigint generated always as identity primary key,
  operacao_id           uuid not null references public.operacoes(id) on delete cascade,
  tipo                  text not null check (tipo in ('deslocamento_iniciado', 'chegou_setor', 'busca_finalizada',
                                                      'chegou_base', 'retorno_atrasado')),
  nivel                 text not null default 'info' check (nivel in ('info', 'critico')),
  titulo                text not null,
  texto                 text not null default '',
  missao_id             uuid references public.missoes(id) on delete cascade,
  grupo_id              uuid references public.grupos(id) on delete set null,
  participante_id       uuid references public.participantes(id) on delete set null,
  lat                   double precision,
  lng                   double precision,
  posicao_em            timestamptz,
  chave                 text not null unique,
  criado_em             timestamptz not null default now(),
  reconhecido_em        timestamptz,
  reconhecido_por_nome  text
);
create index if not exists alertas_operacao_idx on public.alertas (operacao_id, criado_em);

alter table public.missoes enable row level security;
alter table public.missao_membros enable row level security;
alter table public.alertas enable row level security;
drop policy if exists missoes_ler on public.missoes;
create policy missoes_ler on public.missoes for select to authenticated using (public.dono_operacao(operacao_id));
drop policy if exists missao_membros_ler on public.missao_membros;
create policy missao_membros_ler on public.missao_membros for select to authenticated using (public.dono_operacao(operacao_id));
drop policy if exists alertas_ler on public.alertas;
create policy alertas_ler on public.alertas for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.missoes, public.missao_membros, public.alertas from anon;
revoke insert, update, delete, truncate on public.missoes, public.missao_membros, public.alertas from authenticated;
grant select on public.missoes, public.missao_membros, public.alertas to authenticated;

-- Registra um alerta (uma vez por chave). Devolve true se o alerta é novo. Uso interno.
create or replace function public.criar_alerta(p_operacao uuid, p_tipo text, p_nivel text, p_titulo text, p_texto text, p_chave text,
                                               p_missao uuid default null, p_grupo uuid default null, p_participante uuid default null,
                                               p_lat double precision default null, p_lng double precision default null,
                                               p_posicao_em timestamptz default null)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_qtd integer;
begin
  insert into public.alertas (operacao_id, tipo, nivel, titulo, texto, chave, missao_id, grupo_id, participante_id, lat, lng, posicao_em)
  values (p_operacao, p_tipo, p_nivel, left(p_titulo, 200), left(coalesce(p_texto, ''), 2000), p_chave,
          p_missao, p_grupo, p_participante, p_lat, p_lng, p_posicao_em)
  on conflict (chave) do nothing;
  get diagnostics v_qtd = row_count;
  return v_qtd > 0;
end;
$$;

-- ---------------------------------------------------------------------
-- Envio do destino a um grupo (painel)
-- ---------------------------------------------------------------------
-- p_publico: 'todos' (todos os membros de campo ativos) ou 'responsavel'
-- (só os membros com papel de responsável do grupo). Em ambos os casos TODOS
-- os membros de campo ativos são acompanhados (início, chegada, retorno).
-- Uma nova missão do mesmo grupo substitui a anterior. Tudo numa transação.
create or replace function public.enviar_destino_grupo(p_grupo uuid, p_nome text, p_lat double precision, p_lng double precision,
                                                       p_publico text default 'todos', p_modo text default 'a_pe',
                                                       p_setor uuid default null, p_ponto uuid default null,
                                                       p_base uuid default null, p_raio_base_m double precision default null,
                                                       p_prazo_min integer default 30)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_g public.grupos%rowtype;
  v_op public.operacoes%rowtype;
  v_m public.missoes%rowtype;
  v_base public.pontos_interesse%rowtype;
  v_setor_nome text;
  v_raio double precision;
  v_recebe boolean;
  v_dest_id uuid;
  v_rec integer := 0;
  v_acomp integer := 0;
  r record;
begin
  select * into v_g from public.grupos where id = p_grupo;
  if not found or v_nome_resp is null or not public.dono_operacao(v_g.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = v_g.operacao_id;
  if v_op.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_nome is null or char_length(btrim(p_nome)) not between 1 and 80 then
    raise exception 'nome_invalido';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0) then
    raise exception 'posicao_invalida';
  end if;
  if coalesce(p_modo, 'a_pe') not in ('a_pe', 'trilha', 'carro') or coalesce(p_publico, '') not in ('responsavel', 'todos')
     or p_prazo_min is null or p_prazo_min not between 5 and 720 then
    raise exception 'dados_invalidos';
  end if;
  if p_setor is not null then
    select nome into v_setor_nome from public.setores where id = p_setor and operacao_id = v_op.id;
    if v_setor_nome is null then
      raise exception 'setor_nao_encontrado';
    end if;
  end if;
  if p_ponto is not null and not exists (select 1 from public.pontos_interesse where id = p_ponto and operacao_id = v_op.id) then
    raise exception 'dados_invalidos';
  end if;
  if p_base is not null then
    select * into v_base from public.pontos_interesse where id = p_base and operacao_id = v_op.id and categoria = 'BASE';
    if not found then
      raise exception 'base_invalida';
    end if;
    v_raio := coalesce(p_raio_base_m, v_base.raio_m, 100);
    if v_raio not between 10 and 5000 then
      raise exception 'dados_invalidos';
    end if;
  end if;

  if not exists (select 1 from public.grupo_membros gm join public.participantes p on p.id = gm.participante_id
                  where gm.grupo_id = v_g.id and not p.removido and p.liberado_em is null and p.tipo <> 'responsavel') then
    raise exception 'grupo_vazio';
  end if;
  if p_publico = 'responsavel' and not exists (
       select 1 from public.grupo_membros gm join public.participantes p on p.id = gm.participante_id
        where gm.grupo_id = v_g.id and gm.papel = 'responsavel' and not p.removido and p.liberado_em is null and p.tipo <> 'responsavel') then
    raise exception 'grupo_sem_responsavel';
  end if;

  -- missão anterior do mesmo grupo ainda ativa: substituída
  update public.destinos set encerrado_em = now(), encerrado_por = 'substituído por nova missão do grupo'
   where encerrado_em is null
     and missao_id in (select id from public.missoes where grupo_id = v_g.id and status not in ('encerrada', 'na_base'));
  update public.missoes set status = 'encerrada', encerrada_em = now(), encerrada_por_nome = 'substituída por nova missão'
   where grupo_id = v_g.id and status not in ('encerrada', 'na_base');

  insert into public.missoes (operacao_id, grupo_id, grupo_nome, setor_id, setor_nome, ponto_id, nome, lat, lng, modo, publico,
                              base_id, base_nome, base_lat, base_lng, raio_base_m, prazo_retorno_min, enviado_por, enviado_por_nome)
  values (v_op.id, v_g.id, v_g.nome, p_setor, v_setor_nome, p_ponto, btrim(p_nome), p_lat, p_lng, coalesce(p_modo, 'a_pe'), p_publico,
          v_base.id, v_base.titulo, v_base.lat, v_base.lng, case when v_base.id is not null then v_raio end, p_prazo_min,
          auth.uid(), v_nome_resp)
  returning * into v_m;

  for r in
    select p.*, gm.papel
      from public.grupo_membros gm join public.participantes p on p.id = gm.participante_id
     where gm.grupo_id = v_g.id and not p.removido and p.liberado_em is null and p.tipo <> 'responsavel'
  loop
    v_recebe := p_publico = 'todos' or r.papel = 'responsavel';
    v_dest_id := null;
    if v_recebe then
      update public.destinos set encerrado_em = now(), encerrado_por = 'substituído por novo destino'
       where participante_id = r.id and encerrado_em is null;
      insert into public.destinos (operacao_id, participante_id, nome, lat, lng, ponto_id, enviado_por, enviado_por_nome, modo, missao_id)
      values (v_op.id, r.id, btrim(p_nome), p_lat, p_lng, p_ponto, auth.uid(), v_nome_resp, coalesce(p_modo, 'a_pe'), v_m.id)
      returning id into v_dest_id;
      v_rec := v_rec + 1;
    end if;
    insert into public.missao_membros (missao_id, participante_id, operacao_id, recebe_destino, destino_id,
                                       inicio_lat, inicio_lng, inicio_na_base, ultimo_pos_id)
    values (v_m.id, r.id, v_op.id, v_recebe, v_dest_id, r.ultima_lat, r.ultima_lng,
            v_base.id is not null and r.ultima_lat is not null
              and public.distancia_m(v_base.lat, v_base.lng, r.ultima_lat, r.ultima_lng) <= v_raio,
            coalesce((select max(id) from public.posicoes where participante_id = r.id), 0));
    v_acomp := v_acomp + 1;
  end loop;

  return json_build_object('missao', row_to_json(v_m), 'destinatarios', v_rec, 'acompanhados', v_acomp);
end;
$$;

-- ---------------------------------------------------------------------
-- Avaliação pela trilha GPS (chamada depois de gravar posições)
-- ---------------------------------------------------------------------
create or replace function public.apos_posicoes(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  mm public.missao_membros%rowtype;
  v_m public.missoes%rowtype;
  v_s public.setores%rowtype;
  v_tem_setor boolean;
  v_dentro boolean;
  v_nome text;
  v_max bigint;
  v_ini_lat double precision; v_ini_lng double precision; v_ini_t timestamptz;
  v_set_lat double precision; v_set_lng double precision;
  pt record;
begin
  select nome into v_nome from public.participantes where id = p_participante;
  for mm in
    select mb.* from public.missao_membros mb join public.missoes ms on ms.id = mb.missao_id
     where mb.participante_id = p_participante
       and ms.status in ('enviada', 'em_deslocamento', 'no_setor', 'busca_finalizada', 'retorno_atrasado')
  loop
    select * into v_m from public.missoes where id = mm.missao_id for update;
    -- outra transação pode ter avançado o cursor: relê a linha travada
    select * into mm from public.missao_membros where missao_id = mm.missao_id and participante_id = p_participante for update;
    v_tem_setor := false;
    if v_m.setor_id is not null then
      select * into v_s from public.setores where id = v_m.setor_id;
      v_tem_setor := found;
    end if;
    select max(id) into v_max from public.posicoes where participante_id = p_participante and id > mm.ultimo_pos_id;
    if v_max is null then
      continue;
    end if;
    v_ini_t := null; v_set_lat := null;

    for pt in
      select id, lat, lng, precisao, registrado_em from public.posicoes
       where participante_id = p_participante and id > mm.ultimo_pos_id and id <= v_max
         and registrado_em >= v_m.enviada_em and (precisao is null or precisao <= 150)
       order by registrado_em, id
    loop
      -- início do deslocamento
      if mm.iniciou_em is null then
        if mm.inicio_lat is null then
          mm.inicio_lat := pt.lat;
          mm.inicio_lng := pt.lng;
        elsif public.distancia_m(mm.inicio_lat, mm.inicio_lng, pt.lat, pt.lng) >= greatest(100, 2 * coalesce(pt.precisao, 0))
              or (mm.inicio_na_base and v_m.base_lat is not null
                  and public.distancia_m(v_m.base_lat, v_m.base_lng, pt.lat, pt.lng) > v_m.raio_base_m + greatest(25, coalesce(pt.precisao, 0))) then
          mm.iniciou_em := pt.registrado_em;
          v_ini_t := pt.registrado_em; v_ini_lat := pt.lat; v_ini_lng := pt.lng;
        end if;
      end if;
      -- chegada ao setor (antes da finalização da busca)
      if mm.chegou_setor_em is null and v_m.busca_finalizada_em is null then
        if v_tem_setor then
          v_dentro := public.ponto_no_setor(v_s, pt.lat, pt.lng);
        else
          v_dentro := public.distancia_m(v_m.lat, v_m.lng, pt.lat, pt.lng) <= greatest(30, coalesce(pt.precisao, 0));
        end if;
        mm.dentro_seq := case when v_dentro then mm.dentro_seq + 1 else 0 end;
        if mm.dentro_seq >= 2 then
          mm.chegou_setor_em := pt.registrado_em;
          v_set_lat := pt.lat; v_set_lng := pt.lng;
          if mm.iniciou_em is null then
            mm.iniciou_em := pt.registrado_em;
            v_ini_t := pt.registrado_em; v_ini_lat := pt.lat; v_ini_lng := pt.lng;
          end if;
        end if;
      end if;
      -- chegada à base (depois da finalização da busca)
      if mm.chegou_base_em is null and v_m.busca_finalizada_em is not null and v_m.base_lat is not null
         and pt.registrado_em >= v_m.busca_finalizada_em
         and public.distancia_m(v_m.base_lat, v_m.base_lng, pt.lat, pt.lng) <= v_m.raio_base_m
         and coalesce(pt.precisao, 0) <= v_m.raio_base_m then
        mm.chegou_base_em := pt.registrado_em;
      end if;
    end loop;

    update public.missao_membros
       set inicio_lat = mm.inicio_lat, inicio_lng = mm.inicio_lng, ultimo_pos_id = v_max, dentro_seq = mm.dentro_seq,
           iniciou_em = mm.iniciou_em, chegou_setor_em = mm.chegou_setor_em, chegou_base_em = mm.chegou_base_em
     where missao_id = mm.missao_id and participante_id = p_participante;

    -- eventos da missão (o primeiro membro dispara; cada evento gera um alerta só)
    if mm.iniciou_em is not null and v_m.iniciada_em is null then
      update public.missoes
         set iniciada_em = mm.iniciou_em,
             status = case when status = 'enviada' then 'em_deslocamento' else status end
       where id = v_m.id returning * into v_m;
      perform public.criar_alerta(v_m.operacao_id, 'deslocamento_iniciado', 'info',
        'Deslocamento iniciado — ' || v_m.grupo_nome,
        coalesce(v_nome, 'Um membro') || ' começou o deslocamento até ' || v_m.nome || '.',
        v_m.id || ':deslocamento_iniciado', v_m.id, v_m.grupo_id, p_participante, v_ini_lat, v_ini_lng, mm.iniciou_em);
    end if;
    if mm.chegou_setor_em is not null and v_m.chegou_setor_em is null then
      update public.missoes
         set chegou_setor_em = mm.chegou_setor_em,
             status = case when status in ('enviada', 'em_deslocamento') then 'no_setor' else status end
       where id = v_m.id returning * into v_m;
      perform public.criar_alerta(v_m.operacao_id, 'chegou_setor', 'info',
        'Chegada ao setor — ' || v_m.grupo_nome,
        coalesce(v_nome, 'Um membro') || ' chegou a ' || v_m.nome || '.',
        v_m.id || ':chegou_setor', v_m.id, v_m.grupo_id, p_participante, v_set_lat, v_set_lng, mm.chegou_setor_em);
    end if;
    if mm.chegou_base_em is not null then
      perform public.concluir_retorno_se_todos(v_m.id);
    end if;
  end loop;
end;
$$;

-- Todos os acompanhados ATIVOS da missão voltaram à base? Então "na base".
create or replace function public.concluir_retorno_se_todos(p_missao uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_m public.missoes%rowtype;
  v_total integer;
  v_atrasada boolean;
begin
  select * into v_m from public.missoes where id = p_missao for update;
  if not found or v_m.status not in ('busca_finalizada', 'retorno_atrasado') or v_m.base_lat is null then
    return false;
  end if;
  if exists (select 1 from public.missao_membros mb join public.participantes p on p.id = mb.participante_id
              where mb.missao_id = v_m.id and mb.chegou_base_em is null and not p.removido and p.liberado_em is null) then
    return false;
  end if;
  select count(*) into v_total from public.missao_membros mb join public.participantes p on p.id = mb.participante_id
   where mb.missao_id = v_m.id and not p.removido and p.liberado_em is null;
  v_atrasada := v_m.status = 'retorno_atrasado';
  update public.missoes
     set status = 'na_base',
         chegou_base_em = coalesce((select max(chegou_base_em) from public.missao_membros where missao_id = v_m.id), now())
   where id = v_m.id returning * into v_m;
  update public.destinos set encerrado_em = now(), encerrado_por = 'equipe chegou à base'
   where missao_id = v_m.id and encerrado_em is null;
  perform public.criar_alerta(v_m.operacao_id, 'chegou_base', 'info',
    'Equipe na base — ' || v_m.grupo_nome,
    case when v_total > 0 then 'Todos os ' || v_total || ' acompanhado(s) voltaram à base' else 'A equipe voltou à base' end ||
      coalesce(' ' || v_m.base_nome, '') || '.' ||
      case when v_atrasada then ' Chegaram depois do prazo de retorno (o alerta de atraso pode ser encerrado).' else '' end,
    v_m.id || ':chegou_base', v_m.id, v_m.grupo_id, null, v_m.base_lat, v_m.base_lng, v_m.chegou_base_em);
  return true;
end;
$$;

-- ---------------------------------------------------------------------
-- Finalização da busca, prazo de retorno e encerramento
-- ---------------------------------------------------------------------
-- Quem pode: um responsável da operação (painel) ou o responsável do grupo
-- da missão (celular). Com base definida, todos os acompanhados recebem o
-- destino "Volte para a base" e começa a contar o prazo de retorno.
create or replace function public.finalizar_busca(p_missao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_m public.missoes%rowtype;
  v_quem text;
  v_part public.participantes%rowtype;
  r record;
begin
  select * into v_m from public.missoes where id = p_missao for update;
  if not found then
    raise exception 'sem_permissao';
  end if;
  if public.dono_operacao(v_m.operacao_id) then
    v_quem := coalesce(public.nome_responsavel_atual(), 'responsável');
  else
    select p.* into v_part
      from public.participantes p join public.grupo_membros gm on gm.participante_id = p.id
     where gm.grupo_id = v_m.grupo_id and gm.papel = 'responsavel' and p.user_id = auth.uid()
       and not p.removido and p.liberado_em is null
     limit 1;
    if not found then
      raise exception 'sem_permissao';
    end if;
    v_quem := v_part.nome || ' (responsável do grupo)';
  end if;
  if v_m.status in ('encerrada', 'na_base') then
    raise exception 'missao_encerrada';
  end if;
  if v_m.busca_finalizada_em is not null then
    return row_to_json(v_m);   -- já finalizada (toque repetido ou dois aparelhos)
  end if;
  if not exists (select 1 from public.operacoes where id = v_m.operacao_id and status = 'ativa') then
    raise exception 'operacao_encerrada';
  end if;

  update public.missoes
     set busca_finalizada_em = now(), busca_finalizada_por_nome = v_quem,
         prazo_retorno_em = case when base_lat is not null then now() + make_interval(mins => prazo_retorno_min) end,
         status = case when base_lat is not null then 'busca_finalizada' else 'encerrada' end,
         encerrada_em = case when base_lat is null then now() end,
         encerrada_por_nome = case when base_lat is null then v_quem end
   where id = v_m.id returning * into v_m;

  perform public.criar_alerta(v_m.operacao_id, 'busca_finalizada', 'info',
    'Busca finalizada — ' || v_m.grupo_nome,
    'Busca em ' || v_m.nome || ' finalizada por ' || v_quem || '.' ||
      case when v_m.base_lat is not null
           then ' Prazo para voltar à base' || coalesce(' ' || v_m.base_nome, '') || ': ' || v_m.prazo_retorno_min || ' min.'
           else ' Sem base definida: não há controle de retorno.' end,
    v_m.id || ':busca_finalizada', v_m.id, v_m.grupo_id, v_part.id, null, null, v_m.busca_finalizada_em);

  update public.destinos set encerrado_em = now(), encerrado_por = 'busca no setor finalizada'
   where missao_id = v_m.id and encerrado_em is null;
  if v_m.base_lat is not null then
    for r in
      select p.* from public.missao_membros mb join public.participantes p on p.id = mb.participante_id
       where mb.missao_id = v_m.id and not p.removido and p.liberado_em is null and p.tipo <> 'responsavel'
    loop
      update public.destinos set encerrado_em = now(), encerrado_por = 'substituído por novo destino'
       where participante_id = r.id and encerrado_em is null;
      insert into public.destinos (operacao_id, participante_id, nome, lat, lng, ponto_id, enviado_por, enviado_por_nome, modo, missao_id)
      values (v_m.operacao_id, r.id, left('Volte para a base' || coalesce(': ' || v_m.base_nome, ''), 80),
              v_m.base_lat, v_m.base_lng, v_m.base_id, auth.uid(), left(v_quem, 80), v_m.modo, v_m.id);
    end loop;
  end if;
  return row_to_json(v_m);
end;
$$;

-- Mais tempo para o retorno (o alerta de atraso volta a valer para o novo prazo).
create or replace function public.prorrogar_retorno(p_missao uuid, p_min integer)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_m public.missoes%rowtype;
begin
  select * into v_m from public.missoes where id = p_missao for update;
  if not found or public.nome_responsavel_atual() is null or not public.dono_operacao(v_m.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if v_m.status not in ('busca_finalizada', 'retorno_atrasado') then
    raise exception 'missao_encerrada';
  end if;
  if p_min is null or p_min not between 5 and 240 then
    raise exception 'dados_invalidos';
  end if;
  update public.missoes
     set prazo_retorno_em = greatest(prazo_retorno_em, now()) + make_interval(mins => p_min),
         status = 'busca_finalizada'
   where id = v_m.id returning * into v_m;
  return row_to_json(v_m);
end;
$$;

create or replace function public.encerrar_missao(p_missao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_m public.missoes%rowtype;
begin
  select * into v_m from public.missoes where id = p_missao for update;
  if not found or v_nome is null or not public.dono_operacao(v_m.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if v_m.status in ('encerrada', 'na_base') then
    return row_to_json(v_m);
  end if;
  update public.missoes set status = 'encerrada', encerrada_em = now(), encerrada_por_nome = v_nome
   where id = v_m.id returning * into v_m;
  update public.destinos set encerrado_em = now(), encerrado_por = coalesce(v_nome, 'responsável')
   where missao_id = v_m.id and encerrado_em is null;
  return row_to_json(v_m);
end;
$$;

-- Verificação por TEMPO do prazo de retorno. Sem parâmetro: todas as operações
-- (só o agendador pg_cron / chave secreta). Com p_operacao: só aquela, por um
-- responsável dela (o painel chama enquanto está aberto, como reserva).
-- Devolve quantos alertas de atraso foram gerados agora.
create or replace function public.verificar_retornos(p_operacao uuid default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_m public.missoes%rowtype;
  v_faltam integer;
  v_total integer;
  v_lista text;
  v_lat double precision;
  v_lng double precision;
  v_pos timestamptz;
  v_pid uuid;
  v_qtd integer := 0;
begin
  if p_operacao is null then
    if auth.uid() is not null then
      raise exception 'sem_permissao';
    end if;
  elsif not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;

  for v_m in
    select m.* from public.missoes m join public.operacoes o on o.id = m.operacao_id
     where m.status in ('busca_finalizada', 'retorno_atrasado') and m.base_lat is not null and o.status = 'ativa'
       and (p_operacao is null or m.operacao_id = p_operacao)
     order by m.prazo_retorno_em
  loop
    if public.concluir_retorno_se_todos(v_m.id) then
      continue;
    end if;
    if v_m.prazo_retorno_em is null or now() < v_m.prazo_retorno_em then
      continue;
    end if;
    select count(*) filter (where mb.chegou_base_em is null), count(*),
           string_agg(case when mb.chegou_base_em is null then
                        p.nome || case when p.ultima_posicao_em is null then ' (sem posição)'
                                       else ' (última posição há ' || greatest(0, floor(extract(epoch from now() - p.ultima_posicao_em) / 60))::integer || ' min)' end
                      end, ', ' order by p.nome)
      into v_faltam, v_total, v_lista
      from public.missao_membros mb join public.participantes p on p.id = mb.participante_id
     where mb.missao_id = v_m.id and not p.removido and p.liberado_em is null;
    if coalesce(v_faltam, 0) = 0 then
      continue;
    end if;
    select p.id, p.ultima_lat, p.ultima_lng, p.ultima_posicao_em into v_pid, v_lat, v_lng, v_pos
      from public.missao_membros mb join public.participantes p on p.id = mb.participante_id
     where mb.missao_id = v_m.id and mb.chegou_base_em is null and not p.removido and p.liberado_em is null
     order by p.ultima_posicao_em nulls last limit 1;
    if public.criar_alerta(v_m.operacao_id, 'retorno_atrasado', 'critico',
         'EQUIPE PODE ESTAR PERDIDA — ' || v_m.grupo_nome,
         'O prazo de retorno à base' || coalesce(' ' || v_m.base_nome, '') || ' (' || v_m.prazo_retorno_min || ' min após finalizar a busca em ' ||
           v_m.nome || ') terminou e ' || v_faltam || ' de ' || v_total || ' pessoa(s) não chegaram. Faltam: ' || coalesce(v_lista, '—') || '.',
         v_m.id || ':retorno_atrasado:' || floor(extract(epoch from v_m.prazo_retorno_em))::bigint,
         v_m.id, v_m.grupo_id, v_pid, v_lat, v_lng, v_pos) then
      v_qtd := v_qtd + 1;
    end if;
    update public.missoes set status = 'retorno_atrasado' where id = v_m.id and status = 'busca_finalizada';
  end loop;
  return v_qtd;
end;
$$;

create or replace function public.reconhecer_alerta(p_alerta bigint)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v public.alertas%rowtype;
begin
  select * into v from public.alertas where id = p_alerta;
  if not found or v_nome is null or not public.dono_operacao(v.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  update public.alertas set reconhecido_em = coalesce(reconhecido_em, now()), reconhecido_por_nome = coalesce(reconhecido_por_nome, v_nome)
   where id = p_alerta returning * into v;
  return row_to_json(v);
end;
$$;

-- ---------------------------------------------------------------------
-- Celular: destino com os dados da missão; base no mapa
-- ---------------------------------------------------------------------
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
                             'criado_em', d.criado_em, 'recebido_em', d.recebido_em, 'modo', d.modo,
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
      select json_build_object('id', d.id, 'nome', d.nome, 'lat', d.lat, 'lng', d.lng, 'criado_em', d.criado_em, 'modo', d.modo)
        from public.destinos d where d.participante_id = v_part.id and d.encerrado_em is null
       order by d.criado_em desc limit 1)
  );
end;
$$;

-- Retenção: dados apagados → missões e alertas apagados (os destinos já são).
create or replace function public.apagar_missoes_da_operacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.alertas where operacao_id = new.id;
    delete from public.missoes where operacao_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists operacoes_apagar_missoes on public.operacoes;
create trigger operacoes_apagar_missoes after update of dados_apagados_em on public.operacoes
  for each row execute function public.apagar_missoes_da_operacao();

-- Permissões
revoke execute on function public.apos_posicoes(uuid), public.concluir_retorno_se_todos(uuid),
  public.criar_alerta(uuid, text, text, text, text, text, uuid, uuid, uuid, double precision, double precision, timestamptz),
  public.apagar_missoes_da_operacao() from public, anon, authenticated;
revoke execute on function public.distancia_m(double precision, double precision, double precision, double precision),
  public.ponto_no_setor(public.setores, double precision, double precision),
  public.salvar_ponto(uuid, uuid, jsonb),
  public.enviar_destino_grupo(uuid, text, double precision, double precision, text, text, uuid, uuid, uuid, double precision, integer),
  public.finalizar_busca(uuid), public.prorrogar_retorno(uuid, integer), public.encerrar_missao(uuid),
  public.verificar_retornos(uuid), public.reconhecer_alerta(bigint), public.meu_destino(uuid), public.mapa_do_participante(uuid)
  from public, anon;
grant execute on function public.distancia_m(double precision, double precision, double precision, double precision),
  public.ponto_no_setor(public.setores, double precision, double precision),
  public.salvar_ponto(uuid, uuid, jsonb),
  public.enviar_destino_grupo(uuid, text, double precision, double precision, text, text, uuid, uuid, uuid, double precision, integer),
  public.finalizar_busca(uuid), public.prorrogar_retorno(uuid, integer), public.encerrar_missao(uuid),
  public.verificar_retornos(uuid), public.reconhecer_alerta(bigint), public.meu_destino(uuid), public.mapa_do_participante(uuid)
  to authenticated;
grant execute on function public.verificar_retornos(uuid) to service_role;

-- Tempo real: missões, situação dos membros e alertas chegam na hora ao painel.
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['missoes', 'missao_membros', 'alertas'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end;
$$;

-- Agendamento (pg_cron): verifica os prazos de retorno a cada minuto.
-- Ative a extensão em Database → Extensions → pg_cron e rode esta migração
-- de novo. Sem pg_cron o resto funciona; o atraso é verificado só pelo painel aberto.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('gbs-verificar-retornos');
    exception when others then
      null;   -- ainda não estava agendado
    end;
    perform cron.schedule('gbs-verificar-retornos', '* * * * *', 'select public.verificar_retornos()');
  else
    raise notice 'pg_cron não está ativo: o alerta de retorno atrasado depende de um painel aberto. Ative pg_cron e rode esta migração de novo.';
  end if;
exception when others then
  raise notice 'Não foi possível agendar a verificação de retornos: %', sqlerrm;
end;
$$;

notify pgrst, 'reload schema';

-- =====================================================================
-- 18. "ENCONTREI A VÍTIMA" (migração 011 — idempotente; exige a 010)
--
--  O participante de campo informa que encontrou a vítima e a condição
--  (viva ou óbito). A CONDIÇÃO É SENSÍVEL: só os responsáveis da operação
--  podem vê-la. A separação é feita no SERVIDOR:
--
--  vitima_localizacoes  ÚNICA tabela que guarda a condição. RLS: leitura só
--                       por dono_operacao() (criador ou responsável da
--                       operação). Participantes — inclusive quem registrou —
--                       não leem nenhuma linha, nem pelo Realtime.
--  mensagens            recebe uma linha NEUTRA (categoria VITIMA, texto fixo
--                       "Localizada, ver protocolo"), que o participante lê
--                       na própria conversa. Nunca contém a condição.
--  alertas              alerta CRÍTICO para os responsáveis, também neutro
--                       (o painel busca a condição em vitima_localizacoes).
--
--  Escrita só pela função participante_registrar_vitima (sem texto livre, para
--  ninguém escrever a condição numa mensagem que o participante consegue ler).
--  A condição vai no corpo da chamada (POST), nunca na URL.
-- =====================================================================

-- Categoria nova de relato e tipo novo de alerta
alter table public.mensagens drop constraint if exists mensagens_categoria_check;
alter table public.mensagens add constraint mensagens_categoria_check
  check (categoria is null or categoria in ('MENSAGEM', 'OBJETO', 'VESTIGIO', 'PISTA', 'OBSTACULO', 'OUTRO', 'AJUDA', 'VITIMA'));

alter table public.alertas drop constraint if exists alertas_tipo_check;
alter table public.alertas add constraint alertas_tipo_check
  check (tipo in ('deslocamento_iniciado', 'chegou_setor', 'busca_finalizada', 'chegou_base', 'retorno_atrasado', 'vitima_localizada'));

-- ---------------------------------------------------------------------
-- Registro da vítima localizada (condição só para os responsáveis)
-- ---------------------------------------------------------------------
create table if not exists public.vitima_localizacoes (
  id                   uuid primary key default gen_random_uuid(),
  operacao_id          uuid not null references public.operacoes(id) on delete cascade,
  participante_id      uuid not null references public.participantes(id) on delete cascade,
  mensagem_id          uuid not null unique references public.mensagens(id) on delete cascade,
  condicao             text not null check (condicao in ('viva', 'obito')),
  lat                  double precision check (lat between -90 and 90),
  lng                  double precision check (lng between -180 and 180),
  precisao             real check (precisao >= 0),
  posicao_em           timestamptz,             -- horário do GPS
  registrado_em        timestamptz not null default now(),   -- horário do servidor
  registrado_por       uuid not null references auth.users(id) on delete cascade,
  registrado_por_nome  text not null,
  registrado_por_tipo  text not null,
  check ((lat is null) = (lng is null))
);
create index if not exists vitima_localizacoes_operacao_idx on public.vitima_localizacoes (operacao_id, registrado_em);

alter table public.vitima_localizacoes enable row level security;
drop policy if exists vitima_localizacoes_ler on public.vitima_localizacoes;
create policy vitima_localizacoes_ler on public.vitima_localizacoes
  for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.vitima_localizacoes from anon;
revoke insert, update, delete, truncate on public.vitima_localizacoes from authenticated;
grant select on public.vitima_localizacoes to authenticated;

-- O participante registra. Devolve SÓ a mensagem neutra (sem a condição).
-- client_id torna o reenvio (após falta de internet) seguro: não duplica.
create or replace function public.participante_registrar_vitima(
  p_participante uuid, p_condicao text,
  p_lat double precision default null, p_lng double precision default null,
  p_precisao real default null, p_posicao_em timestamptz default null, p_client_id uuid default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_msg public.mensagens%rowtype;
  v_reg public.vitima_localizacoes%rowtype;
  v_recentes integer;
  v_prec real := case when p_precisao between 0 and 100000 then p_precisao end;
  v_pos_em timestamptz := case when p_lat is not null then least(coalesce(p_posicao_em, now()), now()) end;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found or v_part.tipo = 'responsavel' then
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
  if p_condicao is null or p_condicao not in ('viva', 'obito') then
    raise exception 'dados_invalidos';
  end if;
  -- Localização: só a que o aparelho informou; nunca é inventada.
  if (p_lat is null) <> (p_lng is null)
     or (p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0))) then
    raise exception 'posicao_invalida';
  end if;

  if p_client_id is not null then
    select * into v_msg from public.mensagens where participante_id = v_part.id and client_id = p_client_id;
    if found then
      if v_msg.categoria <> 'VITIMA' then
        raise exception 'dados_invalidos';
      end if;
      return row_to_json(v_msg);   -- reenvio: já estava gravado
    end if;
  end if;

  select count(*) into v_recentes from public.mensagens
   where participante_id = v_part.id and direcao = 'entrada' and criada_em > now() - interval '1 minute';
  if v_recentes >= 20 then
    raise exception 'muitas_mensagens';
  end if;

  insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto,
                                direcao, categoria, lat, lng, precisao, posicao_em, client_id, entregue_em)
  values (v_part.operacao_id, v_part.id, auth.uid(), v_part.nome, 'PARTICIPANTE', 'Localizada, ver protocolo',
          'entrada', 'VITIMA', p_lat, p_lng, v_prec, v_pos_em, p_client_id, now())
  returning * into v_msg;

  insert into public.vitima_localizacoes (operacao_id, participante_id, mensagem_id, condicao, lat, lng, precisao,
                                          posicao_em, registrado_em, registrado_por, registrado_por_nome, registrado_por_tipo)
  values (v_part.operacao_id, v_part.id, v_msg.id, p_condicao, p_lat, p_lng, v_prec,
          v_pos_em, v_msg.criada_em, auth.uid(), v_part.nome, v_part.tipo)
  returning * into v_reg;

  -- Alerta crítico aos responsáveis (texto neutro; a condição fica só na tabela protegida)
  perform public.criar_alerta(v_part.operacao_id, 'vitima_localizada', 'critico',
    'VÍTIMA LOCALIZADA',
    'Registrado por ' || v_part.nome || ' (' || v_part.tipo || ')' ||
      case when p_lat is null then ' · sem localização do GPS' else '' end || '. Veja a condição no painel.',
    'vitima:' || v_reg.id, null, null, v_part.id, p_lat, p_lng, v_pos_em);

  update public.participantes set ultimo_contato_em = now() where id = v_part.id;
  return row_to_json(v_msg);
end;
$$;

revoke execute on function public.participante_registrar_vitima(uuid, text, double precision, double precision, real, timestamptz, uuid)
  from public, anon;
grant execute on function public.participante_registrar_vitima(uuid, text, double precision, double precision, real, timestamptz, uuid)
  to authenticated;

-- Tempo real: o painel recebe o registro na hora (o Realtime respeita a RLS:
-- celulares de campo não recebem estas linhas).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.vitima_localizacoes';
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- =====================================================================
-- 19. DIÁRIO DA OPERAÇÃO E RELATÓRIO FINAL
--     (migração 012 — idempotente; exige a 011)
--
--  diario            registro cronológico da operação. Duas origens:
--                     auto    gravado pelo PRÓPRIO BANCO (gatilhos nas tabelas
--                             de setores, deslocamentos, alertas, relatos,
--                             vítima localizada, pontos, pessoas…). Não pode
--                             ser editado nem apagado.
--                     manual  observação livre de um responsável, com data e
--                             hora. Qualquer responsável da operação edita;
--                             ninguém exclui. Cada edição guarda a versão
--                             anterior em diario_versoes.
--  relatorios        relatórios finais gerados (PDF no bucket privado
--                    "relatorios"). Sem exclusão pelo app.
--  operacoes.resultado  desfecho da operação (lista fixa + texto livre).
--
--  O diário e os relatórios NÃO são apagados pela retenção (dados apagados)
--  nem pelo app: são o documento da operação. A operação só pode ser excluída
--  enquanto não tiver nenhuma atividade registrada (criada por engano).
--
--  Leitura: só os responsáveis da operação (RLS). Participantes de campo
--  não leem nada disso. Escrita: só pelas funções abaixo.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Resultado da operação
-- ---------------------------------------------------------------------
alter table public.operacoes add column if not exists resultado text;
alter table public.operacoes add column if not exists resultado_texto text not null default '';
alter table public.operacoes add column if not exists resultado_em timestamptz;
alter table public.operacoes add column if not exists resultado_por_nome text;
alter table public.operacoes drop constraint if exists operacoes_resultado_check;
alter table public.operacoes add constraint operacoes_resultado_check check (
  resultado is null or resultado in ('localizada_viva', 'localizada_obito', 'nao_localizada', 'outro'));
alter table public.operacoes drop constraint if exists operacoes_resultado_texto_check;
alter table public.operacoes add constraint operacoes_resultado_texto_check check (char_length(resultado_texto) <= 4000);

-- ---------------------------------------------------------------------
-- Diário
-- ---------------------------------------------------------------------
create table if not exists public.diario (
  id                bigint generated always as identity primary key,
  operacao_id       uuid not null references public.operacoes(id) on delete cascade,
  ocorrido_em       timestamptz not null,               -- quando aconteceu
  registrado_em     timestamptz not null default now(), -- quando entrou no diário
  origem            text not null check (origem in ('auto', 'manual')),
  categoria         text not null check (categoria in ('operacao', 'setor', 'deslocamento', 'chegada', 'encontro',
                                                       'alerta', 'pessoa', 'observacao', 'documento')),
  tipo              text not null,
  nivel             text not null default 'info' check (nivel in ('info', 'critico')),
  titulo            text not null check (char_length(titulo) between 1 and 200),
  detalhe           text not null default '' check (char_length(detalhe) <= 4000),
  lat               double precision check (lat between -90 and 90),
  lng               double precision check (lng between -180 and 180),
  ref_id            text,                                -- id na tabela de origem (sem FK: a origem pode ser apagada pela retenção)
  autor_id          uuid,                                -- sem FK: o registro sobrevive à conta
  autor_nome        text not null default 'Sistema',
  chave             text unique,                         -- evita duplicar (gatilho + preenchimento inicial)
  versao            integer not null default 1,
  editado_em        timestamptz,
  editado_por_nome  text,
  check ((lat is null) = (lng is null)),
  check (origem = 'manual' or (versao = 1 and editado_em is null))
);
create index if not exists diario_operacao_idx on public.diario (operacao_id, ocorrido_em, id);

create table if not exists public.diario_versoes (
  id                bigint generated always as identity primary key,
  diario_id         bigint not null references public.diario(id) on delete cascade,
  operacao_id       uuid not null references public.operacoes(id) on delete cascade,
  versao            integer not null,
  ocorrido_em       timestamptz not null,
  detalhe           text not null,
  autor_nome        text not null,                       -- quem escreveu ESTA versão
  escrita_em        timestamptz not null,
  substituida_em    timestamptz not null default now(),
  substituida_por_nome text not null,
  unique (diario_id, versao)
);
create index if not exists diario_versoes_operacao_idx on public.diario_versoes (operacao_id);

-- Relatórios finais gerados
create table if not exists public.relatorios (
  id            uuid primary key default gen_random_uuid(),
  operacao_id   uuid not null references public.operacoes(id) on delete cascade,
  caminho       text not null unique,
  paginas       integer check (paginas between 1 and 5000),
  bytes         bigint check (bytes > 0),
  sha256        text check (sha256 ~ '^[0-9a-f]{64}$'),
  gerado_em     timestamptz not null default now(),
  gerado_por    uuid,
  gerado_por_nome text not null
);
create index if not exists relatorios_operacao_idx on public.relatorios (operacao_id, gerado_em desc);

alter table public.diario enable row level security;
alter table public.diario_versoes enable row level security;
alter table public.relatorios enable row level security;
drop policy if exists diario_ler on public.diario;
create policy diario_ler on public.diario for select to authenticated using (public.dono_operacao(operacao_id));
drop policy if exists diario_versoes_ler on public.diario_versoes;
create policy diario_versoes_ler on public.diario_versoes for select to authenticated using (public.dono_operacao(operacao_id));
drop policy if exists relatorios_ler on public.relatorios;
create policy relatorios_ler on public.relatorios for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.diario, public.diario_versoes, public.relatorios from anon;
revoke insert, update, delete, truncate on public.diario, public.diario_versoes, public.relatorios from authenticated;
grant select on public.diario, public.diario_versoes, public.relatorios to authenticated;

-- Defesa em profundidade: eventos automáticos nunca mudam; nada do diário é
-- apagado, a não ser junto com uma operação excluída (sem atividade).
create or replace function public.diario_proteger()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('gbs.excluindo_operacao', true), '') = old.operacao_id::text then
      return old;
    end if;
    raise exception 'diario_nao_apaga';
  end if;
  if old.origem <> 'manual' or new.origem <> 'manual' then
    raise exception 'diario_evento_automatico';
  end if;
  if coalesce(current_setting('gbs.editando_diario', true), '') <> old.id::text
     or new.operacao_id <> old.operacao_id or new.categoria <> old.categoria or new.tipo <> old.tipo
     or new.registrado_em <> old.registrado_em or new.autor_nome <> old.autor_nome then
    raise exception 'diario_somente_funcao';
  end if;
  return new;
end;
$$;
drop trigger if exists diario_proteger on public.diario;
create trigger diario_proteger before update or delete on public.diario
  for each row execute function public.diario_proteger();

create or replace function public.diario_versoes_proteger()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('gbs.excluindo_operacao', true), '') = old.operacao_id::text then
    return old;
  end if;
  raise exception 'diario_nao_apaga';
end;
$$;
drop trigger if exists diario_versoes_proteger on public.diario_versoes;
create trigger diario_versoes_proteger before update or delete on public.diario_versoes
  for each row execute function public.diario_versoes_proteger();

create or replace function public.relatorios_proteger()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' and (coalesce(current_setting('gbs.excluindo_operacao', true), '') = old.operacao_id::text
                           or coalesce(current_setting('gbs.excluindo_relatorio', true), '') = old.id::text) then
    return old;
  end if;
  raise exception 'relatorio_nao_apaga';
end;
$$;
drop trigger if exists relatorios_proteger on public.relatorios;
create trigger relatorios_proteger before update or delete on public.relatorios
  for each row execute function public.relatorios_proteger();

-- Administrador exclui um relatório gerado (o PDF sai do Storage pela limpeza diária).
-- Fica registrado no diário: quem excluiu e de qual relatório.
create or replace function public.excluir_relatorio(p_relatorio uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v public.relatorios%rowtype;
  v_nome text := public.nome_responsavel_atual();
begin
  if v_nome is null or not public.eh_admin() then
    raise exception 'sem_permissao';
  end if;
  select * into v from public.relatorios where id = p_relatorio for update;
  if not found then
    raise exception 'relatorio_nao_encontrado';
  end if;
  insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
  values (v.caminho, 'relatorios', v.operacao_id, null)
  on conflict (caminho) do nothing;
  perform set_config('gbs.excluindo_relatorio', v.id::text, true);
  delete from public.relatorios where id = v.id;
  perform set_config('gbs.excluindo_relatorio', '', true);
  perform public.diario_auto(v.operacao_id, now(), 'operacao', 'relatorio_excluido', 'Relatório excluído',
    'Relatório de ' || to_char(v.gerado_em, 'DD/MM/YYYY HH24:MI') || ' (gerado por ' || v.gerado_por_nome || ')',
    'relatorio_excluido:' || v.id::text, 'info', null, null, v.id::text, v_nome);
  return json_build_object('id', v.id, 'operacao_id', v.operacao_id);
end;
$$;

revoke execute on function public.excluir_relatorio(uuid) from public, anon;
grant execute on function public.excluir_relatorio(uuid) to authenticated;

-- Grava um evento automático (uma vez por chave). Uso interno.
create or replace function public.diario_auto(p_operacao uuid, p_ocorrido timestamptz, p_categoria text, p_tipo text,
                                              p_titulo text, p_detalhe text, p_chave text,
                                              p_nivel text default 'info', p_lat double precision default null,
                                              p_lng double precision default null, p_ref text default null,
                                              p_autor_nome text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_operacao is null or not exists (select 1 from public.operacoes where id = p_operacao) then
    return;
  end if;
  insert into public.diario (operacao_id, ocorrido_em, origem, categoria, tipo, nivel, titulo, detalhe,
                             lat, lng, ref_id, autor_id, autor_nome, chave)
  values (p_operacao, coalesce(p_ocorrido, now()), 'auto', p_categoria, p_tipo, coalesce(p_nivel, 'info'),
          left(coalesce(nullif(btrim(p_titulo), ''), p_tipo), 200), left(coalesce(p_detalhe, ''), 4000),
          case when p_lng is not null then p_lat end, case when p_lat is not null then p_lng end,
          p_ref, auth.uid(),
          coalesce(nullif(btrim(p_autor_nome), ''), public.nome_responsavel_atual(), 'Sistema'),
          p_chave)
  on conflict (chave) do nothing;
end;
$$;

create or replace function public.diario_rotulo_tipo(p_tipo text)
returns text language sql immutable set search_path = public as $$
  select case p_tipo when 'civil' then 'civil' when 'militar' then 'militar' when 'responsavel' then 'responsável' else coalesce(p_tipo, '') end;
$$;

create or replace function public.diario_rotulo_ponto(p_cat text)
returns text language sql immutable set search_path = public as $$
  select case p_cat
    when 'ULTIMA_LOCALIZACAO' then 'Última localização conhecida'
    when 'POSSIVEL_LOCALIZACAO' then 'Possível localização'
    when 'VESTIGIO' then 'Vestígio'
    when 'RISCO' then 'Área de risco'
    when 'ENCONTRO' then 'Ponto de encontro'
    when 'VITIMA_ENCONTRADA' then 'Vítima encontrada'
    when 'BASE' then 'Base da operação'
    else 'Ponto de interesse' end;
$$;

create or replace function public.diario_rotulo_relato(p_cat text)
returns text language sql immutable set search_path = public as $$
  select case p_cat
    when 'PISTA' then 'Possível pista'
    when 'OBJETO' then 'Objeto encontrado'
    when 'VESTIGIO' then 'Vestígio'
    when 'OBSTACULO' then 'Obstáculo'
    when 'AJUDA' then 'Pedido de ajuda'
    else 'Relato' end;
$$;

-- ---------------------------------------------------------------------
-- Gatilhos: cada módulo alimenta o diário
-- ---------------------------------------------------------------------

-- Operação: criação, acionamento, encerramento, reabertura, dados apagados, resultado
create or replace function public.diario_de_operacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := coalesce(public.nome_responsavel_atual(),
                          (select nome from public.responsaveis where user_id = new.responsavel_id));
begin
  if tg_op = 'INSERT' then
    perform public.diario_auto(new.id, new.criada_em, 'operacao', 'operacao_criada',
      'Operação criada: ' || new.codigo, '', 'operacao_criada:' || new.id, 'info', null, null, new.id::text, v_nome);
  end if;
  if new.acionado_em is not null and (tg_op = 'INSERT' or old.acionado_em is distinct from new.acionado_em) then
    perform public.diario_auto(new.id, new.acionado_em, 'operacao', 'acionamento', 'Acionamento da operação',
      coalesce(nullif(new.local_endereco, ''), ''), 'acionamento:' || new.id, 'info', new.local_lat, new.local_lng, new.id::text, v_nome);
  end if;
  if tg_op = 'UPDATE' then
    if old.status = 'ativa' and new.status = 'encerrada' then
      perform public.diario_auto(new.id, coalesce(new.encerrada_em, now()), 'operacao', 'operacao_encerrada',
        'Operação encerrada', '', 'operacao_encerrada:' || new.id || ':' || extract(epoch from coalesce(new.encerrada_em, now()))::bigint,
        'info', null, null, new.id::text, v_nome);
    elsif old.status = 'encerrada' and new.status = 'ativa' then
      perform public.diario_auto(new.id, now(), 'operacao', 'operacao_reaberta', 'Operação reaberta', '',
        'operacao_reaberta:' || new.id || ':' || extract(epoch from now())::bigint, 'info', null, null, new.id::text, v_nome);
    end if;
    if old.dados_apagados_em is null and new.dados_apagados_em is not null then
      perform public.diario_auto(new.id, new.dados_apagados_em, 'operacao', 'dados_apagados',
        'Dados operacionais apagados (retenção)',
        'Participantes, trilhas, mensagens e fotos foram apagados conforme a retenção. O diário e os relatórios continuam.',
        'dados_apagados:' || new.id, 'info', null, null, new.id::text, coalesce(v_nome, 'Sistema'));
    end if;
    if new.resultado is not null and (old.resultado is distinct from new.resultado or old.resultado_texto is distinct from new.resultado_texto) then
      perform public.diario_auto(new.id, coalesce(new.resultado_em, now()), 'operacao', 'resultado',
        'Resultado registrado: ' || case new.resultado
          when 'localizada_viva' then 'vítima localizada com vida'
          when 'localizada_obito' then 'vítima localizada em óbito'
          when 'nao_localizada' then 'vítima não localizada'
          else 'outro' end,
        new.resultado_texto, 'resultado:' || new.id || ':' || extract(epoch from coalesce(new.resultado_em, now()))::bigint,
        'info', null, null, new.id::text, new.resultado_por_nome);
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists operacoes_diario on public.operacoes;
create trigger operacoes_diario after insert or update on public.operacoes
  for each row execute function public.diario_de_operacao();

-- Responsáveis adicionados à operação
create or replace function public.diario_de_responsavel()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.diario_auto(new.operacao_id, new.criado_em, 'pessoa', 'responsavel_adicionado',
    'Responsável adicionado: ' || coalesce((select nome from public.responsaveis where user_id = new.user_id), 'responsável'),
    '', 'responsavel_adicionado:' || new.operacao_id || ':' || new.user_id, 'info', null, null, new.user_id::text, null);
  return new;
end;
$$;
drop trigger if exists operacao_responsaveis_diario on public.operacao_responsaveis;
create trigger operacao_responsaveis_diario after insert on public.operacao_responsaveis
  for each row execute function public.diario_de_responsavel();

-- Setores: criação, início (andamento), fim (concluído), reabertura, exclusão
create or replace function public.diario_de_setor()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_resp text;
  v_det text;
  v_op public.operacoes%rowtype;
begin
  if tg_op = 'DELETE' then
    select * into v_op from public.operacoes where id = old.operacao_id;
    -- retenção (dados apagados) ou exclusão da operação: não é uma ação sobre o setor
    if not found or v_op.dados_apagados_em is not null then
      return old;
    end if;
    perform public.diario_auto(old.operacao_id, now(), 'setor', 'setor_excluido', 'Setor excluído: ' || old.nome, '',
      'setor_excluido:' || old.id, 'info', null, null, old.id::text, null);
    return old;
  end if;
  select nome into v_resp from public.participantes where id = new.participante_id;
  v_det := concat_ws(' · ', nullif('Equipe: ' || nullif(new.equipe, ''), 'Equipe: '), nullif('Responsável no setor: ' || v_resp, 'Responsável no setor: '));
  if tg_op = 'INSERT' then
    perform public.diario_auto(new.operacao_id, new.criado_em, 'setor', 'setor_criado', 'Setor criado: ' || new.nome, v_det,
      'setor_criado:' || new.id, 'info', null, null, new.id::text, new.criado_por_nome);
  end if;
  if (tg_op = 'INSERT' and new.status <> 'pendente') or (tg_op = 'UPDATE' and old.status is distinct from new.status) then
    perform public.diario_auto(new.operacao_id, now(), 'setor',
      case when new.status = 'andamento' and (tg_op = 'INSERT' or old.status = 'pendente') then 'setor_iniciado'
           when new.status = 'concluido' then 'setor_concluido'
           else 'setor_reaberto' end,
      case when new.status = 'andamento' and (tg_op = 'INSERT' or old.status = 'pendente') then 'Início da varredura do setor ' || new.nome
           when new.status = 'concluido' then 'Fim da varredura do setor ' || new.nome
           when new.status = 'andamento' then 'Setor ' || new.nome || ' reaberto (em andamento)'
           else 'Setor ' || new.nome || ' voltou para pendente' end,
      v_det, 'setor_status:' || new.id || ':' || new.status || ':' || txid_current() || ':' || extract(epoch from clock_timestamp())::bigint,
      'info', null, null, new.id::text, coalesce(new.atualizado_por_nome, new.criado_por_nome));
  end if;
  return new;
end;
$$;
drop trigger if exists setores_diario on public.setores;
create trigger setores_diario after insert or update of status or delete on public.setores
  for each row execute function public.diario_de_setor();

-- Deslocamentos de grupos (missões): envio
create or replace function public.diario_de_missao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.diario_auto(new.operacao_id, new.enviada_em, 'deslocamento', 'missao_enviada',
    'Deslocamento enviado ao grupo ' || new.grupo_nome || ': ' || new.nome,
    concat_ws(' · ', 'Setor: ' || new.setor_nome, 'Base: ' || new.base_nome, 'Prazo de retorno: ' || new.prazo_retorno_min || ' min'),
    'missao_enviada:' || new.id, 'info', new.lat, new.lng, new.id::text, new.enviado_por_nome);
  return new;
end;
$$;
drop trigger if exists missoes_diario on public.missoes;
create trigger missoes_diario after insert on public.missoes
  for each row execute function public.diario_de_missao();

-- Alertas (início do deslocamento, chegadas, busca finalizada, atraso). A vítima
-- localizada entra pelo próprio registro (com a condição), não pelo alerta.
create or replace function public.diario_de_alerta()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.tipo = 'vitima_localizada' then
      return new;
    end if;
    perform public.diario_auto(new.operacao_id, coalesce(new.posicao_em, new.criado_em),
      case new.tipo when 'chegou_setor' then 'chegada' when 'chegou_base' then 'chegada'
                    when 'retorno_atrasado' then 'alerta' else 'deslocamento' end,
      'alerta_' || new.tipo, new.titulo, new.texto, 'alerta:' || new.id, new.nivel, new.lat, new.lng, new.id::text, 'Sistema');
  elsif new.nivel = 'critico' and old.reconhecido_em is null and new.reconhecido_em is not null then
    perform public.diario_auto(new.operacao_id, new.reconhecido_em, 'alerta', 'alerta_ciente',
      'Ciente do alerta: ' || new.titulo, '', 'alerta_ciente:' || new.id, 'info', null, null, new.id::text, new.reconhecido_por_nome);
  end if;
  return new;
end;
$$;
drop trigger if exists alertas_diario on public.alertas;
create trigger alertas_diario after insert or update of reconhecido_em on public.alertas
  for each row execute function public.diario_de_alerta();

-- Vítima localizada (com a condição: o diário é só dos responsáveis)
create or replace function public.diario_de_vitima_localizada()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.diario_auto(new.operacao_id, coalesce(new.posicao_em, new.registrado_em), 'encontro', 'vitima_localizada',
    'Vítima localizada — ' || case new.condicao when 'viva' then 'VIVA' else 'MORTA' end,
    'Registrado por ' || new.registrado_por_nome || ' (' || public.diario_rotulo_tipo(new.registrado_por_tipo) || ')' ||
      case when new.lat is null then ' · sem localização do GPS' else '' end,
    'vitima_localizada:' || new.id, 'critico', new.lat, new.lng, new.id::text, new.registrado_por_nome);
  return new;
end;
$$;
drop trigger if exists vitima_localizacoes_diario on public.vitima_localizacoes;
create trigger vitima_localizacoes_diario after insert on public.vitima_localizacoes
  for each row execute function public.diario_de_vitima_localizada();

-- Relatos de campo e pedidos de ajuda
create or replace function public.diario_de_mensagem()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.direcao <> 'entrada' or new.categoria is null or new.categoria in ('MENSAGEM', 'VITIMA') then
    return new;
  end if;
  perform public.diario_auto(new.operacao_id, coalesce(new.posicao_em, new.criada_em),
    case when new.categoria = 'AJUDA' then 'alerta' else 'encontro' end, 'relato_' || lower(new.categoria),
    public.diario_rotulo_relato(new.categoria) || ' — ' || new.remetente_nome, new.texto,
    'relato:' || new.id, case when new.categoria = 'AJUDA' then 'critico' else 'info' end,
    new.lat, new.lng, new.id::text, new.remetente_nome);
  return new;
end;
$$;
drop trigger if exists mensagens_diario on public.mensagens;
create trigger mensagens_diario after insert on public.mensagens
  for each row execute function public.diario_de_mensagem();

-- Pontos de interesse
create or replace function public.diario_de_ponto()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.diario_auto(new.operacao_id, new.criado_em,
    case when new.categoria in ('VESTIGIO', 'VITIMA_ENCONTRADA', 'POSSIVEL_LOCALIZACAO', 'ULTIMA_LOCALIZACAO') then 'encontro' else 'operacao' end,
    'ponto_' || lower(new.categoria), public.diario_rotulo_ponto(new.categoria) || ': ' || new.titulo,
    concat_ws(' · ', nullif(new.descricao, ''), 'Relatado por ' || new.relatado_por_nome),
    'ponto:' || new.id, 'info', new.lat, new.lng, new.id::text, new.criado_por_nome);
  return new;
end;
$$;
drop trigger if exists pontos_interesse_diario on public.pontos_interesse;
create trigger pontos_interesse_diario after insert on public.pontos_interesse
  for each row execute function public.diario_de_ponto();

-- Pessoas: entrada na operação e pedido de saída
create or replace function public.diario_de_participante()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.tipo = 'responsavel' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    perform public.diario_auto(new.operacao_id, new.criado_em, 'pessoa', 'pessoa_entrou',
      new.nome || ' entrou na operação (' || public.diario_rotulo_tipo(new.tipo) || ')', '',
      'pessoa_entrou:' || new.id, 'info', null, null, new.id::text, new.nome);
  elsif new.saida_solicitada_em is not null and old.saida_solicitada_em is distinct from new.saida_solicitada_em then
    perform public.diario_auto(new.operacao_id, new.saida_solicitada_em, 'pessoa', 'saida_solicitada',
      new.nome || ' pediu para sair', coalesce(new.saida_motivo, ''),
      'saida_solicitada:' || new.id || ':' || extract(epoch from new.saida_solicitada_em)::bigint, 'info', null, null, new.id::text, new.nome);
  end if;
  return new;
end;
$$;
drop trigger if exists participantes_diario on public.participantes;
create trigger participantes_diario after insert or update of saida_solicitada_em on public.participantes
  for each row execute function public.diario_de_participante();

-- Pessoas: removido, saída liberada, reincluído
create or replace function public.diario_de_participacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text;
  v_tipo text;
begin
  select nome, tipo into v_nome, v_tipo from public.participantes where id = new.participante_id;
  perform public.diario_auto(new.operacao_id, new.em, 'pessoa', 'pessoa_' || new.evento,
    coalesce(v_nome, 'Participante') || case new.evento when 'removido' then ' foi removido da operação'
                                                      when 'liberado' then ': saída liberada'
                                                      else ' foi reincluído na operação' end,
    '', 'participacao:' || new.id, 'info', null, null, new.participante_id::text, new.por_nome);
  return new;
end;
$$;
drop trigger if exists participacao_eventos_diario on public.participacao_eventos;
create trigger participacao_eventos_diario after insert on public.participacao_eventos
  for each row execute function public.diario_de_participacao();

-- Grupos e fichas de vítimas
create or replace function public.diario_de_grupo()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.diario_auto(new.operacao_id, new.criado_em, 'pessoa', 'grupo_criado', 'Grupo criado: ' || new.nome, '',
    'grupo_criado:' || new.id, 'info', null, null, new.id::text, new.criado_por_nome);
  return new;
end;
$$;
drop trigger if exists grupos_diario on public.grupos;
create trigger grupos_diario after insert on public.grupos
  for each row execute function public.diario_de_grupo();

create or replace function public.diario_de_ficha_vitima()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.diario_auto(new.operacao_id, new.criado_em, 'operacao', 'ficha_vitima', 'Ficha da vítima cadastrada: ' || new.nome, '',
    'ficha_vitima:' || new.id, 'info', null, null, new.id::text, new.criado_por_nome);
  return new;
end;
$$;
drop trigger if exists vitimas_diario on public.vitimas;
create trigger vitimas_diario after insert on public.vitimas
  for each row execute function public.diario_de_ficha_vitima();

-- ---------------------------------------------------------------------
-- Observações manuais (qualquer responsável da operação)
-- ---------------------------------------------------------------------
create or replace function public.diario_adicionar(p_operacao uuid, p_ocorrido_em timestamptz, p_texto text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_texto text := btrim(coalesce(p_texto, ''));
  v public.diario%rowtype;
  v_op public.operacoes%rowtype;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
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
  insert into public.diario (operacao_id, ocorrido_em, origem, categoria, tipo, titulo, detalhe, autor_id, autor_nome)
  values (p_operacao, least(p_ocorrido_em, now()), 'manual', 'observacao', 'observacao', 'Observação', v_texto, auth.uid(), v_nome)
  returning * into v;
  return row_to_json(v);
end;
$$;

create or replace function public.diario_editar(p_id bigint, p_ocorrido_em timestamptz, p_texto text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_texto text := btrim(coalesce(p_texto, ''));
  v public.diario%rowtype;
  v_op public.operacoes%rowtype;
begin
  select * into v from public.diario where id = p_id for update;
  if not found or v_nome is null or not public.dono_operacao(v.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if v.origem <> 'manual' then
    raise exception 'diario_evento_automatico';
  end if;
  select * into v_op from public.operacoes where id = v.operacao_id;
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
  if v_texto = v.detalhe and date_trunc('minute', p_ocorrido_em) = date_trunc('minute', v.ocorrido_em) then
    return row_to_json(v);   -- nada mudou
  end if;
  insert into public.diario_versoes (diario_id, operacao_id, versao, ocorrido_em, detalhe, autor_nome, escrita_em, substituida_por_nome)
  values (v.id, v.operacao_id, v.versao, v.ocorrido_em, v.detalhe,
          coalesce(v.editado_por_nome, v.autor_nome), coalesce(v.editado_em, v.registrado_em), v_nome);
  perform set_config('gbs.editando_diario', v.id::text, true);
  update public.diario
     set ocorrido_em = least(p_ocorrido_em, now()), detalhe = v_texto, versao = v.versao + 1,
         editado_em = now(), editado_por_nome = v_nome
   where id = v.id
  returning * into v;
  perform set_config('gbs.editando_diario', '', true);
  return row_to_json(v);
end;
$$;

-- ---------------------------------------------------------------------
-- Resultado da operação
-- ---------------------------------------------------------------------
create or replace function public.definir_resultado(p_operacao uuid, p_resultado text, p_texto text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_op public.operacoes%rowtype;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if p_resultado is null or p_resultado not in ('localizada_viva', 'localizada_obito', 'nao_localizada', 'outro') then
    raise exception 'dados_invalidos';
  end if;
  if char_length(coalesce(p_texto, '')) > 4000 then
    raise exception 'texto_longo';
  end if;
  if p_resultado = 'outro' and btrim(coalesce(p_texto, '')) = '' then
    raise exception 'texto_obrigatorio';
  end if;
  update public.operacoes
     set resultado = p_resultado, resultado_texto = btrim(coalesce(p_texto, '')), resultado_em = now(), resultado_por_nome = v_nome
   where id = p_operacao
  returning * into v_op;
  return json_build_object('resultado', v_op.resultado, 'resultado_texto', v_op.resultado_texto,
                           'resultado_em', v_op.resultado_em, 'resultado_por_nome', v_op.resultado_por_nome);
end;
$$;

-- ---------------------------------------------------------------------
-- Relatório final
-- ---------------------------------------------------------------------
-- Máscaras para o documento (o relatório circula: não leva CPF/telefone completos)
create or replace function public.mascarar_cpf(p text)
returns text language sql immutable set search_path = public as $$
  select case when p ~ '^\d{11}$' then '***.' || substr(p, 4, 3) || '.' || substr(p, 7, 3) || '-**' else null end;
$$;
create or replace function public.mascarar_telefone(p text)
returns text language sql immutable set search_path = public as $$
  select case when p ~ '^\d{10,11}$' then '(' || substr(p, 1, 2) || ') ****-' || right(p, 4) else null end;
$$;

-- Tudo o que o relatório precisa, numa chamada só. Só responsáveis da operação.
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
                                        'roupas', t.roupas, 'observacoes', t.observacoes, 'foto_caminho', t.foto_caminho) order by t.criado_em)
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
               'lat', d.lat, 'lng', d.lng, 'versao', d.versao, 'editado_em', d.editado_em, 'editado_por_nome', d.editado_por_nome)
               order by d.ocorrido_em, d.id)
        from public.diario d where d.operacao_id = p_operacao), '[]'::json),
    'relatorios_anteriores', coalesce((
      select json_agg(json_build_object('gerado_em', r.gerado_em, 'gerado_por_nome', r.gerado_por_nome) order by r.gerado_em)
        from public.relatorios r where r.operacao_id = p_operacao), '[]'::json)
  );
end;
$$;

-- Registra o PDF enviado ao bucket "relatorios" (<operacao_id>/<uuid>.pdf).
create or replace function public.registrar_relatorio(p_operacao uuid, p_caminho text, p_paginas integer, p_bytes bigint, p_sha256 text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v public.relatorios%rowtype;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if p_caminho is null or p_caminho !~ ('^' || p_operacao::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$') then
    raise exception 'dados_invalidos';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'relatorios' and name = p_caminho) then
    raise exception 'arquivo_nao_enviado';
  end if;
  insert into public.relatorios (operacao_id, caminho, paginas, bytes, sha256, gerado_por, gerado_por_nome)
  values (p_operacao, p_caminho, p_paginas, p_bytes, lower(p_sha256), auth.uid(), v_nome)
  on conflict (caminho) do nothing
  returning * into v;
  if not found then
    select * into v from public.relatorios where caminho = p_caminho;
    return row_to_json(v);
  end if;
  perform public.diario_auto(p_operacao, v.gerado_em, 'documento', 'relatorio_gerado', 'Relatório final gerado',
    coalesce(p_paginas || ' página(s)', ''), 'relatorio:' || v.id, 'info', null, null, v.id::text, v_nome);
  return row_to_json(v);
end;
$$;

-- Bucket privado dos relatórios: responsáveis da operação enviam e leem; NINGUÉM
-- apaga ou substitui pelo app (sem regra de delete/update).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('relatorios', 'relatorios', false, 52428800, array['application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.pode_enviar_relatorio(p_nome text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op uuid;
begin
  if p_nome is null or p_nome !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$' then
    return false;
  end if;
  v_op := split_part(p_nome, '/', 1)::uuid;
  return public.nome_responsavel_atual() is not null and public.dono_operacao(v_op);
end;
$$;

create or replace function public.pode_ver_relatorio(p_nome text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_nome is null or p_nome !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' then
    return false;
  end if;
  return public.dono_operacao(split_part(p_nome, '/', 1)::uuid);
end;
$$;

drop policy if exists gbs_relatorios_enviar on storage.objects;
create policy gbs_relatorios_enviar on storage.objects
  for insert to authenticated
  with check (bucket_id = 'relatorios' and public.pode_enviar_relatorio(name));
drop policy if exists gbs_relatorios_ver on storage.objects;
create policy gbs_relatorios_ver on storage.objects
  for select to authenticated
  using (bucket_id = 'relatorios' and public.pode_ver_relatorio(name));

-- ---------------------------------------------------------------------
-- Exclusão da operação: quem criou (ou um administrador) apaga a operação e TUDO o que é dela,
-- com ou sem atividade no diário e relatórios (migração 041; antes só o administrador podia).
-- ---------------------------------------------------------------------
create or replace function public.excluir_operacao(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_codigo text;
  v_fotos integer;
  v_participantes integer;
  v_vitimas integer;
begin
  if not (public.eh_criador(p_operacao) or (public.eh_admin() and public.dono_operacao(p_operacao))) then
    raise exception 'sem_permissao';
  end if;
  select codigo into v_codigo from public.operacoes where id = p_operacao for update;
  if v_codigo is null then
    raise exception 'sem_permissao';
  end if;
  insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
  select caminho, 'relatorios', p_operacao, null from public.relatorios where operacao_id = p_operacao
  on conflict (caminho) do nothing;
  select count(*) into v_fotos from public.fotos where operacao_id = p_operacao;
  select count(*) into v_participantes from public.participantes where operacao_id = p_operacao and tipo <> 'responsavel';
  select count(*) into v_vitimas from public.vitimas where operacao_id = p_operacao;

  perform set_config('gbs.excluindo_operacao', p_operacao::text, true);
  delete from public.operacoes where id = p_operacao;   -- apaga em cascata tudo o que é da operação
  perform set_config('gbs.excluindo_operacao', '', true);

  return json_build_object('operacao', v_codigo, 'fotos', v_fotos, 'participantes', v_participantes, 'vitimas', v_vitimas);
end;
$$;

-- ---------------------------------------------------------------------
-- Preenchimento inicial: operações que já existiam (com o que tem horário).
-- O início/fim de setores antigos não foi registrado na época.
-- ---------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select * from public.operacoes loop
    perform public.diario_auto(r.id, r.criada_em, 'operacao', 'operacao_criada', 'Operação criada: ' || r.codigo, '',
      'operacao_criada:' || r.id, 'info', null, null, r.id::text, (select nome from public.responsaveis where user_id = r.responsavel_id));
    if r.acionado_em is not null then
      perform public.diario_auto(r.id, r.acionado_em, 'operacao', 'acionamento', 'Acionamento da operação', coalesce(r.local_endereco, ''),
        'acionamento:' || r.id, 'info', r.local_lat, r.local_lng, r.id::text, null);
    end if;
    if r.encerrada_em is not null then
      perform public.diario_auto(r.id, r.encerrada_em, 'operacao', 'operacao_encerrada', 'Operação encerrada', '',
        'operacao_encerrada:' || r.id || ':' || extract(epoch from r.encerrada_em)::bigint, 'info', null, null, r.id::text, 'Sistema');
    end if;
    if r.dados_apagados_em is not null then
      perform public.diario_auto(r.id, r.dados_apagados_em, 'operacao', 'dados_apagados', 'Dados operacionais apagados (retenção)', '',
        'dados_apagados:' || r.id, 'info', null, null, r.id::text, 'Sistema');
    end if;
  end loop;
  for r in select * from public.operacao_responsaveis loop
    perform public.diario_auto(r.operacao_id, r.criado_em, 'pessoa', 'responsavel_adicionado',
      'Responsável adicionado: ' || coalesce((select nome from public.responsaveis where user_id = r.user_id), 'responsável'), '',
      'responsavel_adicionado:' || r.operacao_id || ':' || r.user_id, 'info', null, null, r.user_id::text, 'Sistema');
  end loop;
  for r in select * from public.setores loop
    perform public.diario_auto(r.operacao_id, r.criado_em, 'setor', 'setor_criado', 'Setor criado: ' || r.nome, '',
      'setor_criado:' || r.id, 'info', null, null, r.id::text, r.criado_por_nome);
  end loop;
  for r in select * from public.missoes loop
    perform public.diario_auto(r.operacao_id, r.enviada_em, 'deslocamento', 'missao_enviada',
      'Deslocamento enviado ao grupo ' || r.grupo_nome || ': ' || r.nome, '', 'missao_enviada:' || r.id, 'info', r.lat, r.lng, r.id::text, r.enviado_por_nome);
  end loop;
  for r in select * from public.alertas where tipo <> 'vitima_localizada' loop
    perform public.diario_auto(r.operacao_id, coalesce(r.posicao_em, r.criado_em),
      case r.tipo when 'chegou_setor' then 'chegada' when 'chegou_base' then 'chegada' when 'retorno_atrasado' then 'alerta' else 'deslocamento' end,
      'alerta_' || r.tipo, r.titulo, r.texto, 'alerta:' || r.id, r.nivel, r.lat, r.lng, r.id::text, 'Sistema');
  end loop;
  for r in select * from public.vitima_localizacoes loop
    perform public.diario_auto(r.operacao_id, coalesce(r.posicao_em, r.registrado_em), 'encontro', 'vitima_localizada',
      'Vítima localizada — ' || case r.condicao when 'viva' then 'VIVA' else 'MORTA' end,
      'Registrado por ' || r.registrado_por_nome, 'vitima_localizada:' || r.id, 'critico', r.lat, r.lng, r.id::text, r.registrado_por_nome);
  end loop;
  for r in select * from public.mensagens where direcao = 'entrada' and categoria is not null and categoria not in ('MENSAGEM', 'VITIMA') loop
    perform public.diario_auto(r.operacao_id, coalesce(r.posicao_em, r.criada_em),
      case when r.categoria = 'AJUDA' then 'alerta' else 'encontro' end, 'relato_' || lower(r.categoria),
      public.diario_rotulo_relato(r.categoria) || ' — ' || r.remetente_nome, r.texto, 'relato:' || r.id,
      case when r.categoria = 'AJUDA' then 'critico' else 'info' end, r.lat, r.lng, r.id::text, r.remetente_nome);
  end loop;
  for r in select * from public.pontos_interesse loop
    perform public.diario_auto(r.operacao_id, r.criado_em,
      case when r.categoria in ('VESTIGIO', 'VITIMA_ENCONTRADA', 'POSSIVEL_LOCALIZACAO', 'ULTIMA_LOCALIZACAO') then 'encontro' else 'operacao' end,
      'ponto_' || lower(r.categoria), public.diario_rotulo_ponto(r.categoria) || ': ' || r.titulo, coalesce(r.descricao, ''),
      'ponto:' || r.id, 'info', r.lat, r.lng, r.id::text, r.criado_por_nome);
  end loop;
  for r in select * from public.participantes where tipo <> 'responsavel' loop
    perform public.diario_auto(r.operacao_id, r.criado_em, 'pessoa', 'pessoa_entrou',
      r.nome || ' entrou na operação (' || public.diario_rotulo_tipo(r.tipo) || ')', '', 'pessoa_entrou:' || r.id, 'info', null, null, r.id::text, r.nome);
  end loop;
  for r in select e.*, p.nome from public.participacao_eventos e left join public.participantes p on p.id = e.participante_id loop
    perform public.diario_auto(r.operacao_id, r.em, 'pessoa', 'pessoa_' || r.evento,
      coalesce(r.nome, 'Participante') || case r.evento when 'removido' then ' foi removido da operação'
                                                      when 'liberado' then ': saída liberada' else ' foi reincluído na operação' end,
      '', 'participacao:' || r.id, 'info', null, null, r.participante_id::text, r.por_nome);
  end loop;
  for r in select * from public.grupos loop
    perform public.diario_auto(r.operacao_id, r.criado_em, 'pessoa', 'grupo_criado', 'Grupo criado: ' || r.nome, '',
      'grupo_criado:' || r.id, 'info', null, null, r.id::text, r.criado_por_nome);
  end loop;
  for r in select * from public.vitimas loop
    perform public.diario_auto(r.operacao_id, r.criado_em, 'operacao', 'ficha_vitima', 'Ficha da vítima cadastrada: ' || r.nome, '',
      'ficha_vitima:' || r.id, 'info', null, null, r.id::text, r.criado_por_nome);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------
revoke execute on function public.diario_auto(uuid, timestamptz, text, text, text, text, text, text, double precision, double precision, text, text),
  public.diario_proteger(), public.diario_versoes_proteger(), public.relatorios_proteger(),
  public.diario_de_operacao(), public.diario_de_responsavel(), public.diario_de_setor(), public.diario_de_missao(),
  public.diario_de_alerta(), public.diario_de_vitima_localizada(), public.diario_de_mensagem(), public.diario_de_ponto(),
  public.diario_de_participante(), public.diario_de_participacao(), public.diario_de_grupo(), public.diario_de_ficha_vitima()
  from public, anon, authenticated;
revoke execute on function public.diario_adicionar(uuid, timestamptz, text), public.diario_editar(bigint, timestamptz, text),
  public.definir_resultado(uuid, text, text), public.relatorio_operacao(uuid),
  public.registrar_relatorio(uuid, text, integer, bigint, text), public.pode_enviar_relatorio(text), public.pode_ver_relatorio(text),
  public.excluir_operacao(uuid), public.mascarar_cpf(text), public.mascarar_telefone(text)
  from public, anon;
grant execute on function public.diario_adicionar(uuid, timestamptz, text), public.diario_editar(bigint, timestamptz, text),
  public.definir_resultado(uuid, text, text), public.relatorio_operacao(uuid),
  public.registrar_relatorio(uuid, text, integer, bigint, text), public.pode_enviar_relatorio(text), public.pode_ver_relatorio(text),
  public.excluir_operacao(uuid), public.mascarar_cpf(text), public.mascarar_telefone(text)
  to authenticated;

-- Tempo real: o diário aparece na hora para os outros responsáveis.
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['diario', 'relatorios'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- =====================================================================
-- 20. ALERTA DE TEMPO DE PERMANÊNCIA EM SETOR
--     (migração 013 — idempotente; exige a 012)
--
--  Quando uma pessoa (ou um grupo) fica no mesmo setor mais tempo do que o
--  limite da operação (padrão 60 min; 0 = desligado), o responsável recebe um
--  alerta para avaliar a troca da equipe.
--
--  O tempo é calculado no SERVIDOR pela trilha GPS (posicoes), pelo horário
--  do GPS, a cada lote de posições recebido (gancho apos_posicoes):
--    entrada  2 pontos seguidos dentro do setor; começa no 1º deles
--    saída    3 pontos seguidos fora; termina no 1º deles
--    volta    reentrar até 5 min depois de sair continua a MESMA permanência
--             (o GPS oscila na borda: isso não zera o tempo)
--    pontos com precisão pior que 150 m são ignorados
--  Um alerta por limite atingido (1×, 2×, 3× o limite…), nunca a cada ponto.
--  Membros do mesmo grupo no mesmo setor geram UM alerta do grupo.
--
--  setor_permanencias  cada passagem de uma pessoa por um setor (entrada,
--                      saída, último limite avisado). Leitura: responsáveis.
--  setor_presenca      estado do contador de pontos dentro/fora (uso interno)
--  permanencia_cursor  último ponto já avaliado de cada pessoa (uso interno)
-- =====================================================================

alter table public.operacoes add column if not exists permanencia_limite_min integer not null default 60;
alter table public.operacoes drop constraint if exists operacoes_permanencia_limite_check;
alter table public.operacoes add constraint operacoes_permanencia_limite_check
  check (permanencia_limite_min = 0 or permanencia_limite_min between 10 and 720);

alter table public.alertas drop constraint if exists alertas_tipo_check;
alter table public.alertas add constraint alertas_tipo_check
  check (tipo in ('deslocamento_iniciado', 'chegou_setor', 'busca_finalizada', 'chegou_base', 'retorno_atrasado',
                  'vitima_localizada', 'permanencia_setor'));

create table if not exists public.setor_permanencias (
  id               uuid primary key default gen_random_uuid(),
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  setor_id         uuid not null references public.setores(id) on delete cascade,
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  entrou_em        timestamptz not null,       -- horário do GPS do 1º ponto dentro
  ultimo_dentro_em timestamptz not null,       -- último ponto dentro
  saiu_em          timestamptz,                -- 1º ponto fora (null = ainda no setor)
  entrada_lat      double precision,
  entrada_lng      double precision,
  avisado_min      integer not null default 0  -- maior limite (em minutos) já avisado nesta permanência
);
create unique index if not exists setor_permanencias_aberta on public.setor_permanencias (participante_id, setor_id) where saiu_em is null;
create index if not exists setor_permanencias_operacao_idx on public.setor_permanencias (operacao_id, saiu_em);
create index if not exists setor_permanencias_setor_idx on public.setor_permanencias (setor_id, participante_id, saiu_em desc);

create table if not exists public.setor_presenca (
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  setor_id         uuid not null references public.setores(id) on delete cascade,
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  dentro_seq       smallint not null default 0,
  fora_seq         smallint not null default 0,
  cand_em          timestamptz,                -- 1º ponto da sequência dentro
  cand_lat         double precision,
  cand_lng         double precision,
  cand_fora_em     timestamptz,                -- 1º ponto da sequência fora
  primary key (participante_id, setor_id)
);

create table if not exists public.permanencia_cursor (
  participante_id  uuid primary key references public.participantes(id) on delete cascade,
  ultimo_pos_id    bigint not null default 0
);

alter table public.setor_permanencias enable row level security;
alter table public.setor_presenca enable row level security;       -- sem políticas: ninguém lê pelo navegador
alter table public.permanencia_cursor enable row level security;   -- idem
drop policy if exists setor_permanencias_ler on public.setor_permanencias;
create policy setor_permanencias_ler on public.setor_permanencias
  for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.setor_permanencias, public.setor_presenca, public.permanencia_cursor from anon;
revoke all on public.setor_presenca, public.permanencia_cursor from authenticated;
revoke insert, update, delete, truncate on public.setor_permanencias from authenticated;
grant select on public.setor_permanencias to authenticated;

-- "1 h 05 min", "45 min"
create or replace function public.texto_duracao(p_min integer)
returns text language sql immutable set search_path = public as $$
  select case when p_min < 60 then p_min || ' min'
              when p_min % 60 = 0 then (p_min / 60) || ' h'
              else (p_min / 60) || ' h ' || lpad((p_min % 60)::text, 2, '0') || ' min' end;
$$;

-- ---------------------------------------------------------------------
-- Alerta de uma permanência que passou do limite (uso interno)
-- ---------------------------------------------------------------------
create or replace function public.alertar_permanencia(p_perm uuid, p_ate timestamptz, p_lat double precision, p_lng double precision)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v public.setor_permanencias%rowtype;
  v_op public.operacoes%rowtype;
  v_s public.setores%rowtype;
  v_p public.participantes%rowtype;
  v_g public.grupos%rowtype;
  v_min integer;
  v_limiar integer;
  v_lista text;
begin
  select * into v from public.setor_permanencias where id = p_perm for update;
  if not found or v.saiu_em is not null then
    return false;
  end if;
  select * into v_op from public.operacoes where id = v.operacao_id;
  if v_op.status <> 'ativa' or coalesce(v_op.permanencia_limite_min, 0) = 0 then
    return false;
  end if;
  v_min := floor(extract(epoch from (p_ate - v.entrou_em)) / 60)::integer;
  v_limiar := (v_min / v_op.permanencia_limite_min) * v_op.permanencia_limite_min;   -- maior múltiplo do limite já atingido
  if v_limiar < v_op.permanencia_limite_min or v_limiar <= v.avisado_min then
    return false;
  end if;
  -- marca antes de avisar: um aviso por limite, mesmo com reenvio de pontos
  update public.setor_permanencias set avisado_min = v_limiar where id = v.id;

  select * into v_s from public.setores where id = v.setor_id;
  select * into v_p from public.participantes where id = v.participante_id;
  select g.* into v_g from public.grupo_membros gm join public.grupos g on g.id = gm.grupo_id
   where gm.participante_id = v.participante_id order by g.nome limit 1;

  if v_g.id is not null then
    -- grupo: um alerta só por limite, mesmo que vários membros cruzem o limite
    if exists (select 1 from public.alertas a
                where a.operacao_id = v.operacao_id and a.tipo = 'permanencia_setor' and a.grupo_id = v_g.id
                  and a.chave like 'permanencia:g:' || v_g.id || ':' || v.setor_id || ':' || v_limiar || ':%'
                  and a.criado_em > now() - make_interval(mins => v_op.permanencia_limite_min)) then
      return false;
    end if;
    select string_agg(p.nome || ' (' || public.texto_duracao(floor(extract(epoch from (greatest(p_ate, sp.ultimo_dentro_em) - sp.entrou_em)) / 60)::integer) || ')',
                      ', ' order by sp.entrou_em)
      into v_lista
      from public.setor_permanencias sp
      join public.grupo_membros gm on gm.participante_id = sp.participante_id and gm.grupo_id = v_g.id
      join public.participantes p on p.id = sp.participante_id
     where sp.setor_id = v.setor_id and sp.saiu_em is null and not p.removido and p.liberado_em is null;
    perform public.criar_alerta(v.operacao_id, 'permanencia_setor', 'info',
      'Permanência no setor ' || v_s.nome || ' — ' || v_g.nome || ' há ' || public.texto_duracao(v_limiar),
      'No setor há: ' || coalesce(v_lista, v_p.nome) || ' (pela trilha GPS). Avalie a troca da equipe. Limite da operação: ' ||
        public.texto_duracao(v_op.permanencia_limite_min) || '.',
      'permanencia:g:' || v_g.id || ':' || v.setor_id || ':' || v_limiar || ':' || v.id,
      null, v_g.id, v.participante_id, p_lat, p_lng, p_ate);
  else
    perform public.criar_alerta(v.operacao_id, 'permanencia_setor', 'info',
      'Permanência no setor ' || v_s.nome || ' — ' || v_p.nome || ' há ' || public.texto_duracao(v_limiar),
      v_p.nome || ' (' || case v_p.tipo when 'militar' then 'militar' else 'civil' end || ') está no setor há ' ||
        public.texto_duracao(v_min) || ' (pela trilha GPS). Avalie a troca. Limite da operação: ' ||
        public.texto_duracao(v_op.permanencia_limite_min) || '.',
      'permanencia:p:' || v.id || ':' || v_limiar,
      null, null, v.participante_id, p_lat, p_lng, p_ate);
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------
-- Avaliação pela trilha GPS (chamada depois de gravar posições)
-- ---------------------------------------------------------------------
create or replace function public.avaliar_permanencia(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
  v_cursor bigint;
  v_max bigint;
  v_setores public.setores[];
  v_s public.setores;
  e public.setor_presenca%rowtype;
  v_perm public.setor_permanencias%rowtype;
  v_dentro boolean;
  v_ult record;
  pt record;
begin
  select * into v_part from public.participantes where id = p_participante;
  if not found or v_part.tipo = 'responsavel' then
    return;
  end if;
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  if v_op.status <> 'ativa' then
    return;
  end if;
  select array_agg(s order by s.criado_em) into v_setores from public.setores s where s.operacao_id = v_op.id;

  -- cursor: na primeira vez, olha só as últimas 12 h da trilha
  insert into public.permanencia_cursor (participante_id, ultimo_pos_id)
  values (p_participante, coalesce((select min(id) - 1 from public.posicoes
                                     where participante_id = p_participante and registrado_em > now() - interval '12 hours'), 0))
  on conflict (participante_id) do nothing;
  select ultimo_pos_id into v_cursor from public.permanencia_cursor where participante_id = p_participante for update;
  select max(id) into v_max from public.posicoes where participante_id = p_participante and id > v_cursor;
  if v_max is null then
    return;
  end if;
  update public.permanencia_cursor set ultimo_pos_id = v_max where participante_id = p_participante;
  if v_setores is null then
    return;
  end if;

  foreach v_s in array v_setores loop
    select * into e from public.setor_presenca where participante_id = p_participante and setor_id = v_s.id;
    if not found then
      e.participante_id := p_participante; e.setor_id := v_s.id; e.operacao_id := v_op.id;
      e.dentro_seq := 0; e.fora_seq := 0;
    end if;
    select * into v_perm from public.setor_permanencias
     where participante_id = p_participante and setor_id = v_s.id and saiu_em is null;
    v_ult := null;

    for pt in
      select id, lat, lng, precisao, registrado_em from public.posicoes
       where participante_id = p_participante and id > v_cursor and id <= v_max
         and (precisao is null or precisao <= 150)
       order by registrado_em, id
    loop
      -- pontos atrasados, anteriores ao que já foi avaliado, não reabrem nada
      if v_perm.id is not null and pt.registrado_em < v_perm.ultimo_dentro_em then
        continue;
      end if;
      v_dentro := public.ponto_no_setor(v_s, pt.lat, pt.lng);
      if v_dentro then
        e.fora_seq := 0; e.cand_fora_em := null;
        if v_perm.id is not null then
          v_perm.ultimo_dentro_em := greatest(v_perm.ultimo_dentro_em, pt.registrado_em);
          v_ult := pt;
        else
          e.dentro_seq := least(e.dentro_seq + 1, 2);
          if e.dentro_seq = 1 then
            e.cand_em := pt.registrado_em; e.cand_lat := pt.lat; e.cand_lng := pt.lng;
          end if;
          if e.dentro_seq >= 2 then
            -- voltou logo depois de sair (oscilação na borda): continua a mesma permanência
            select * into v_perm from public.setor_permanencias
             where participante_id = p_participante and setor_id = v_s.id and saiu_em is not null
               and saiu_em >= e.cand_em - interval '5 minutes'
             order by saiu_em desc limit 1;
            if found then
              update public.setor_permanencias set saiu_em = null, ultimo_dentro_em = pt.registrado_em
               where id = v_perm.id returning * into v_perm;
            else
              insert into public.setor_permanencias (operacao_id, setor_id, participante_id, entrou_em, ultimo_dentro_em, entrada_lat, entrada_lng)
              values (v_op.id, v_s.id, p_participante, e.cand_em, pt.registrado_em, e.cand_lat, e.cand_lng)
              returning * into v_perm;
            end if;
            e.dentro_seq := 0; e.cand_em := null;
            v_ult := pt;
          end if;
        end if;
      else
        e.dentro_seq := 0; e.cand_em := null;
        if v_perm.id is not null then
          e.fora_seq := least(e.fora_seq + 1, 3);
          if e.fora_seq = 1 then
            e.cand_fora_em := pt.registrado_em;
          end if;
          if e.fora_seq >= 3 then
            update public.setor_permanencias set saiu_em = e.cand_fora_em, ultimo_dentro_em = v_perm.ultimo_dentro_em
             where id = v_perm.id;
            v_perm := null;
            v_ult := null;
            e.fora_seq := 0; e.cand_fora_em := null;
          end if;
        end if;
      end if;
    end loop;

    if v_perm.id is not null then
      update public.setor_permanencias set ultimo_dentro_em = v_perm.ultimo_dentro_em
       where id = v_perm.id and ultimo_dentro_em < v_perm.ultimo_dentro_em;
      -- passou do limite? (pelo horário do GPS do último ponto dentro)
      perform public.alertar_permanencia(v_perm.id, v_perm.ultimo_dentro_em,
                                         coalesce(v_ult.lat, v_part.ultima_lat), coalesce(v_ult.lng, v_part.ultima_lng));
    end if;

    insert into public.setor_presenca (participante_id, setor_id, operacao_id, dentro_seq, fora_seq, cand_em, cand_lat, cand_lng, cand_fora_em)
    values (e.participante_id, e.setor_id, e.operacao_id, e.dentro_seq, e.fora_seq, e.cand_em, e.cand_lat, e.cand_lng, e.cand_fora_em)
    on conflict (participante_id, setor_id) do update
      set dentro_seq = excluded.dentro_seq, fora_seq = excluded.fora_seq, cand_em = excluded.cand_em,
          cand_lat = excluded.cand_lat, cand_lng = excluded.cand_lng, cand_fora_em = excluded.cand_fora_em
      where (setor_presenca.dentro_seq, setor_presenca.fora_seq, setor_presenca.cand_em, setor_presenca.cand_fora_em)
            is distinct from (excluded.dentro_seq, excluded.fora_seq, excluded.cand_em, excluded.cand_fora_em);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Gancho apos_posicoes: deslocamentos (010) + permanência (013)
-- A versão da 010 vira apos_posicoes_missoes; apos_posicoes chama as duas.
-- (Idempotente: se o schema.sql recriar a versão da 010, ela é renomeada de novo.)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'apos_posicoes'
                and pg_get_function_identity_arguments(p.oid) = 'p_participante uuid'
                and p.prosrc not like '%avaliar_permanencia%') then
    drop function if exists public.apos_posicoes_missoes(uuid);
    alter function public.apos_posicoes(uuid) rename to apos_posicoes_missoes;
  end if;
end;
$$;

create or replace function public.apos_posicoes(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  begin
    perform public.apos_posicoes_missoes(p_participante);
  exception when others then
    raise warning 'apos_posicoes (deslocamentos): %', sqlerrm;
  end;
  begin
    perform public.avaliar_permanencia(p_participante);
  exception when others then
    raise warning 'apos_posicoes (permanência): %', sqlerrm;   -- nunca impede a gravação das posições
  end;
end;
$$;

-- ---------------------------------------------------------------------
-- Configuração do limite (responsáveis da operação)
-- ---------------------------------------------------------------------
create or replace function public.configurar_permanencia(p_operacao uuid, p_limite_min integer)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_op public.operacoes%rowtype;
  v_antes integer;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if p_limite_min is null or not (p_limite_min = 0 or p_limite_min between 10 and 720) then
    raise exception 'permanencia_invalida';
  end if;
  select permanencia_limite_min into v_antes from public.operacoes where id = p_operacao for update;
  update public.operacoes set permanencia_limite_min = p_limite_min, atualizado_em = now(), atualizado_por_nome = v_nome
   where id = p_operacao returning * into v_op;
  if v_antes is distinct from p_limite_min then
    perform public.diario_auto(p_operacao, now(), 'operacao', 'permanencia_limite',
      case when p_limite_min = 0 then 'Alerta de permanência em setor desligado'
           else 'Limite de permanência em setor: ' || public.texto_duracao(p_limite_min) end,
      case when coalesce(v_antes, 0) = 0 then '' else 'Antes: ' || public.texto_duracao(v_antes) end,
      'permanencia_limite:' || p_operacao || ':' || p_limite_min || ':' || txid_current() || ':' || (extract(epoch from clock_timestamp()) * 1000)::bigint,
      'info', null, null, p_operacao::text, v_nome);
  end if;
  return row_to_json(v_op);
end;
$$;

-- Diário: o alerta de permanência entra como "Alerta" (os demais continuam como na 012)
create or replace function public.diario_de_alerta()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.tipo = 'vitima_localizada' then
      return new;
    end if;
    perform public.diario_auto(new.operacao_id, coalesce(new.posicao_em, new.criado_em),
      case new.tipo when 'chegou_setor' then 'chegada' when 'chegou_base' then 'chegada'
                    when 'retorno_atrasado' then 'alerta' when 'permanencia_setor' then 'alerta' else 'deslocamento' end,
      'alerta_' || new.tipo, new.titulo, new.texto, 'alerta:' || new.id, new.nivel, new.lat, new.lng, new.id::text, 'Sistema');
  elsif new.nivel = 'critico' and old.reconhecido_em is null and new.reconhecido_em is not null then
    perform public.diario_auto(new.operacao_id, new.reconhecido_em, 'alerta', 'alerta_ciente',
      'Ciente do alerta: ' || new.titulo, '', 'alerta_ciente:' || new.id, 'info', null, null, new.id::text, new.reconhecido_por_nome);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Permissões e tempo real
-- ---------------------------------------------------------------------
revoke execute on function public.alertar_permanencia(uuid, timestamptz, double precision, double precision),
  public.avaliar_permanencia(uuid), public.apos_posicoes(uuid), public.apos_posicoes_missoes(uuid)
  from public, anon, authenticated;
revoke execute on function public.configurar_permanencia(uuid, integer), public.texto_duracao(integer) from public, anon;
grant execute on function public.configurar_permanencia(uuid, integer), public.texto_duracao(integer) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.setor_permanencias';
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- =====================================================================
-- 21. FOTOS: SETOR, LOCALIZAÇÃO PENDENTE E ATUALIZAÇÃO PELO GPS
--     (migração 014 — idempotente; exige a 013)
--
--  Cada foto já guarda: horário da captura no aparelho (capturada_em),
--  latitude, longitude e precisão, horário da posição (posicao_em), operação
--  e quem tirou (participante). Esta migração acrescenta:
--
--  setor_id / setor_nome   setor onde a foto foi tirada (calculado no banco
--                          pela posição; o nome fica guardado mesmo se o
--                          setor for apagado depois)
--  origem_posicao          + 'pendente': foto tirada sem GPS; o local é
--                            completado depois
--                          + 'trilha': local tirado da trilha GPS da pessoa
--                            (ponto até 2 min antes/depois da captura)
--  local_atualizado_em     quando o local pendente foi completado
--
--  Local pendente é completado:
--    1) pelo celular, quando o GPS responder (atualizar_local_foto): só uma
--       leitura de até 2 min antes a 10 min depois da captura;
--    2) pelo servidor, pela trilha GPS (ao registrar a foto e a cada lote de
--       posições que chega).
--  Leitura: só quem tem acesso à operação (RLS da tabela fotos, sem mudança:
--  responsáveis da operação e o próprio autor).
-- =====================================================================

alter table public.fotos add column if not exists setor_id uuid references public.setores(id) on delete set null;
alter table public.fotos add column if not exists setor_nome text;
alter table public.fotos add column if not exists local_atualizado_em timestamptz;
alter table public.fotos drop constraint if exists fotos_origem_posicao_check;
alter table public.fotos add constraint fotos_origem_posicao_check
  check (origem_posicao in ('gps', 'exif', 'nenhuma', 'pendente', 'trilha'));
create index if not exists fotos_pendentes_idx on public.fotos (participante_id) where origem_posicao = 'pendente';

-- Setor da foto: calculado sempre que a posição muda (qualquer caminho de gravação)
create or replace function public.foto_definir_setor()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_s public.setores%rowtype;
begin
  if tg_op = 'UPDATE' and new.lat is not distinct from old.lat and new.lng is not distinct from old.lng then
    return new;
  end if;
  new.setor_id := null;
  new.setor_nome := null;
  if new.lat is not null and new.lng is not null then
    select s.* into v_s from public.setores s
     where s.operacao_id = new.operacao_id and public.ponto_no_setor(s, new.lat, new.lng)
     order by s.criado_em
     limit 1;
    if found then
      new.setor_id := v_s.id;
      new.setor_nome := v_s.nome;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists fotos_definir_setor on public.fotos;
create trigger fotos_definir_setor before insert or update of lat, lng on public.fotos
  for each row execute function public.foto_definir_setor();

-- Fotos que já existiam: preenche o setor
update public.fotos f set setor_id = s.id, setor_nome = s.nome
  from public.setores s
 where f.setor_id is null and f.lat is not null and s.operacao_id = f.operacao_id
   and public.ponto_no_setor(s, f.lat, f.lng)
   and s.id = (select s2.id from public.setores s2
                where s2.operacao_id = f.operacao_id and public.ponto_no_setor(s2, f.lat, f.lng)
                order by s2.criado_em limit 1);

-- Completa o local de uma foto pendente pela trilha GPS (ponto mais próximo da
-- captura, até 2 min antes ou depois, com precisão até 100 m). Uso interno.
create or replace function public.resolver_local_foto(p_foto uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v public.fotos%rowtype;
  pt record;
begin
  select * into v from public.fotos where id = p_foto for update;
  if not found or v.origem_posicao <> 'pendente' or v.capturada_em is null then
    return false;
  end if;
  select lat, lng, precisao, registrado_em into pt from public.posicoes
   where participante_id = v.participante_id
     and registrado_em between v.capturada_em - interval '2 minutes' and v.capturada_em + interval '2 minutes'
     and (precisao is null or precisao <= 100)
   order by abs(extract(epoch from (registrado_em - v.capturada_em))), precisao nulls last
   limit 1;
  if not found then
    return false;
  end if;
  update public.fotos
     set lat = pt.lat, lng = pt.lng, precisao = pt.precisao, posicao_em = pt.registrado_em,
         origem_posicao = 'trilha', local_atualizado_em = now()
   where id = v.id;
  return true;
end;
$$;

create or replace function public.resolver_fotos_pendentes(p_participante uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_qtd integer := 0;
  r record;
begin
  for r in select id from public.fotos where participante_id = p_participante and origem_posicao = 'pendente' loop
    if public.resolver_local_foto(r.id) then
      v_qtd := v_qtd + 1;
    end if;
  end loop;
  return v_qtd;
end;
$$;

-- ---------------------------------------------------------------------
-- Registro da foto: aceita "pendente" (foto da câmera sem GPS no momento)
-- ---------------------------------------------------------------------
create or replace function public.registrar_foto(
  p_participante uuid, p_client_id uuid, p_origem text,
  p_lat double precision default null, p_lng double precision default null, p_precisao real default null,
  p_posicao_em timestamptz default null, p_capturada_em timestamptz default null, p_legenda text default '',
  p_bytes integer default null, p_largura integer default null, p_altura integer default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_caminho text;
  v_foto public.fotos%rowtype;
  v_captura timestamptz := p_capturada_em;
  v_origem text := p_origem;
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
  if p_client_id is null then
    raise exception 'foto_invalida';
  end if;

  select * into v_foto from public.fotos where participante_id = v_part.id and client_id = p_client_id;
  if found then
    return row_to_json(v_foto);   -- reenvio: já estava registrada
  end if;

  v_caminho := v_part.operacao_id || '/' || v_part.id || '/' || p_client_id || '.jpg';
  if not exists (select 1 from storage.objects where bucket_id = 'fotos' and name = v_caminho) then
    raise exception 'foto_nao_enviada';
  end if;

  if v_origem is null or v_origem not in ('gps', 'exif', 'nenhuma', 'pendente') then
    raise exception 'foto_invalida';
  end if;
  if v_origem in ('nenhuma', 'pendente') and (p_lat is not null or p_lng is not null) then
    raise exception 'posicao_invalida';
  end if;
  if v_origem in ('gps', 'exif') and (p_lat is null or p_lng is null or p_lat not between -90 and 90
       or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0)) then
    raise exception 'posicao_invalida';
  end if;
  if v_captura is not null and (v_captura > now() + interval '2 minutes' or v_captura < '2000-01-01') then
    v_captura := null;
  end if;
  -- pendente precisa do horário da captura (é por ele que o local é completado)
  if v_origem = 'pendente' and v_captura is null then
    v_origem := 'nenhuma';
  end if;

  insert into public.fotos (operacao_id, participante_id, autor_nome, autor_tipo, client_id, caminho,
                            lat, lng, precisao, posicao_em, origem_posicao, capturada_em, legenda,
                            bytes, largura, altura)
  values (v_part.operacao_id, v_part.id, v_part.nome, v_part.tipo, p_client_id, v_caminho,
          p_lat, p_lng, case when p_precisao between 0 and 100000 then p_precisao end,
          case when p_lat is not null then least(coalesce(p_posicao_em, now()), now()) end,
          v_origem, v_captura, left(btrim(coalesce(p_legenda, '')), 300),
          case when p_bytes between 0 and 20000000 then p_bytes end,
          case when p_largura between 1 and 20000 then p_largura end,
          case when p_altura between 1 and 20000 then p_altura end)
  returning * into v_foto;

  -- pendente: a trilha GPS pode já ter um ponto do momento da foto
  if v_origem = 'pendente' and public.resolver_local_foto(v_foto.id) then
    select * into v_foto from public.fotos where id = v_foto.id;
  end if;

  update public.participantes set ultimo_contato_em = now() where id = v_part.id;
  return row_to_json(v_foto);
end;
$$;

-- O celular completa o local quando o GPS responder (ou desiste: p_lat nulo).
-- Só o autor, só foto pendente, só leitura de até 2 min antes a 10 min depois da captura.
create or replace function public.atualizar_local_foto(
  p_participante uuid, p_client_id uuid,
  p_lat double precision default null, p_lng double precision default null,
  p_precisao real default null, p_posicao_em timestamptz default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v public.fotos%rowtype;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found or v_part.removido then
    raise exception 'participante_invalido';
  end if;
  select * into v from public.fotos where participante_id = v_part.id and client_id = p_client_id for update;
  if not found then
    raise exception 'foto_nao_encontrada';
  end if;
  if v.origem_posicao <> 'pendente' then
    return row_to_json(v);   -- já resolvida (pela trilha ou por um envio anterior)
  end if;
  if p_lat is null and p_lng is null then
    update public.fotos set origem_posicao = 'nenhuma', local_atualizado_em = now() where id = v.id returning * into v;
    return row_to_json(v);
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180
     or (p_lat = 0 and p_lng = 0) or p_posicao_em is null then
    raise exception 'posicao_invalida';
  end if;
  if p_precisao is not null and (p_precisao < 0 or p_precisao > 500) then
    raise exception 'posicao_invalida';
  end if;
  if p_posicao_em < v.capturada_em - interval '2 minutes' or p_posicao_em > v.capturada_em + interval '10 minutes'
     or p_posicao_em > now() + interval '2 minutes' then
    raise exception 'local_fora_do_prazo';
  end if;
  update public.fotos
     set lat = p_lat, lng = p_lng, precisao = p_precisao, posicao_em = p_posicao_em,
         origem_posicao = 'gps', local_atualizado_em = now()
   where id = v.id
  returning * into v;
  return row_to_json(v);
end;
$$;

-- ---------------------------------------------------------------------
-- Gancho apos_posicoes: deslocamentos + permanência (013) + fotos pendentes
-- ---------------------------------------------------------------------
create or replace function public.apos_posicoes(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  begin
    perform public.apos_posicoes_missoes(p_participante);
  exception when others then
    raise warning 'apos_posicoes (deslocamentos): %', sqlerrm;
  end;
  begin
    perform public.avaliar_permanencia(p_participante);
  exception when others then
    raise warning 'apos_posicoes (permanência): %', sqlerrm;   -- nunca impede a gravação das posições
  end;
  begin
    perform public.resolver_fotos_pendentes(p_participante);
  exception when others then
    raise warning 'apos_posicoes (fotos pendentes): %', sqlerrm;
  end;
end;
$$;

revoke execute on function public.foto_definir_setor(), public.resolver_local_foto(uuid), public.resolver_fotos_pendentes(uuid),
  public.apos_posicoes(uuid) from public, anon, authenticated;
revoke execute on function public.atualizar_local_foto(uuid, uuid, double precision, double precision, real, timestamptz),
  public.registrar_foto(uuid, uuid, text, double precision, double precision, real, timestamptz, timestamptz, text, integer, integer, integer)
  from public, anon;
grant execute on function public.atualizar_local_foto(uuid, uuid, double precision, double precision, real, timestamptz),
  public.registrar_foto(uuid, uuid, text, double precision, double precision, real, timestamptz, timestamptz, text, integer, integer, integer)
  to authenticated;

notify pgrst, 'reload schema';

-- =====================================================================
-- 22. GRUPOS NO MAPA DO CIVIL (migração 015 — idempotente; exige a 008)
--
--  Antes, o mapa do participante mostrava só militares e responsáveis da
--  operação (nunca civis). Agora mostra também os INTEGRANTES DOS GRUPOS EM
--  COMUM com quem consulta: civis, militares ou responsáveis do mesmo grupo,
--  com a última posição, o nome e a cor do grupo. Não entram CPF, telefone,
--  trilha, nem grupos que a pessoa não compartilha.
--
--  Militares e responsáveis SEM grupo continuam visíveis, como antes.
--  Quem está num grupo só aparece para os membros desse grupo.
-- =====================================================================
create or replace function public.equipe_no_mapa(p_participante uuid)
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
    select json_agg(x order by x.idade_s)
      from (
        select p.id,
               p.tipo,
               p.ultima_lat as lat,
               p.ultima_lng as lng,
               p.ultima_precisao as precisao,
               greatest(0, floor(extract(epoch from now() - p.ultima_posicao_em)))::integer as idade_s,
               -- nome e grupo só para quem está no mesmo grupo que quem consulta
               case when g.grupo_id is not null then p.nome end as nome,
               g.grupo_id,
               g.grupo_nome,
               g.grupo_cor,
               g.grupo_papel
          from public.participantes p
          left join lateral (
            select gr.id as grupo_id, gr.nome as grupo_nome, gr.cor as grupo_cor, theirs.papel as grupo_papel
              from public.grupo_membros mine
              join public.grupo_membros theirs on theirs.grupo_id = mine.grupo_id and theirs.participante_id = p.id
              join public.grupos gr on gr.id = mine.grupo_id
             where mine.participante_id = v_part.id
             order by gr.nome
             limit 1
          ) g on true
         where p.operacao_id = v_part.operacao_id
           and p.id <> v_part.id
           and not p.removido
           and p.liberado_em is null
           and p.ultima_lat is not null and p.ultima_lng is not null
           and p.ultima_posicao_em > now() - interval '15 minutes'
           and (
             -- integrante de um grupo em comum: precisa estar compartilhando a posição
             (g.grupo_id is not null and p.rastreando)
             or (
               -- militar ou responsável SEM grupo: continua visível, como antes
               p.tipo in ('militar', 'responsavel')
               and (p.tipo <> 'responsavel' or p.rastreando)
               and not exists (select 1 from public.grupo_membros x where x.participante_id = p.id)
             )
           )
      ) x
  ), '[]'::json);
end;
$$;

revoke execute on function public.equipe_no_mapa(uuid) from public, anon;
grant execute on function public.equipe_no_mapa(uuid) to authenticated;

-- =====================================================================
-- 23. ADMINISTRADOR VÊ TODAS AS OPERAÇÕES (migração 016 — idempotente; exige a 008)
--
--  Antes, um responsável só enxergava as operações que criou ou das quais foi
--  adicionado. Agora o ADMINISTRADOR (responsaveis.admin e ativo) acessa todas as
--  operações. A regra fica na função dono_operacao, que já é usada pelas políticas
--  de leitura e pelas funções do painel: nada mais precisa mudar nelas.
--  Demais responsáveis continuam como antes (criador ou responsável adicionado).
-- =====================================================================
create or replace function public.dono_operacao(p_operacao uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  -- Administrador: qualquer operação existente. Demais responsáveis: criador ou responsável adicionado.
  select public.eh_responsavel() and exists (select 1 from public.operacoes o where o.id = p_operacao) and (
    public.eh_admin()
    or exists (
      select 1
        from public.operacoes o
       where o.id = p_operacao
         and (o.responsavel_id = auth.uid()
              or exists (select 1 from public.operacao_responsaveis m
                          where m.operacao_id = o.id and m.user_id = auth.uid()))
    )
  );
$$;


-- =====================================================================
-- 24. EXCLUIR RESPONSÁVEL (migração 017 — idempotente; exige a 008 e a 016)
--
--  Até aqui o administrador só podia DESATIVAR um responsável. Agora ele pode
--  excluí-lo, com estas regras:
--    - não pode excluir a si mesmo;
--    - não pode excluir quem já tem histórico no sistema: operação criada,
--      mensagem enviada ou localização de vítima registrada. Apagar essas pessoas
--      apagaria junto registros oficiais da operação. Nesses casos, desative o acesso.
--  A função só remove a linha em responsaveis. O login (auth.users) é apagado
--  pela função de servidor /api/responsaveis (ação "excluir"), que usa a chave secreta.
-- =====================================================================
create or replace function public.admin_excluir_responsavel(p_user uuid)
returns json
language plpgsql security definer set search_path = public
as $$
begin
  if not public.eh_admin() then
    raise exception 'sem_permissao';
  end if;
  if p_user = auth.uid() then
    raise exception 'nao_pode_alterar_a_si';
  end if;
  if not exists (select 1 from public.responsaveis where user_id = p_user) then
    raise exception 'responsavel_nao_encontrado';
  end if;
  if exists (select 1 from public.operacoes where responsavel_id = p_user)
     or exists (select 1 from public.mensagens where remetente_id = p_user)
     or exists (select 1 from public.vitima_localizacoes where registrado_por = p_user) then
    raise exception 'responsavel_com_registros';
  end if;
  delete from public.responsaveis where user_id = p_user;
  return public.admin_listar_responsaveis();
end;
$$;

revoke execute on function public.admin_excluir_responsavel(uuid) from public, anon;
grant execute on function public.admin_excluir_responsavel(uuid) to authenticated;

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

-- =====================================================================
-- 26. IPO: INFORME PADRÃO DE OCORRÊNCIA (migração 019 — idempotente; exige a 007 e a 012)
--
--  Os campos do IPO ficam numa coluna própria da operação (jsonb), gravada pela
--  função salvar_ipo_operacao, e saem no relatório final. O relatório (relatorio_operacao)
--  passa a devolver essa coluna.
-- =====================================================================
alter table public.operacoes add column if not exists ipo jsonb not null default '{}'::jsonb;

create or replace function public.salvar_ipo_operacao(p_operacao uuid, p_ipo jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_op public.operacoes%rowtype;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao for update;
  if not found then
    raise exception 'sem_permissao';
  end if;
  p_ipo := coalesce(p_ipo, '{}'::jsonb);
  if jsonb_typeof(p_ipo) <> 'object' or length(p_ipo::text) > 30000 then
    raise exception 'dados_invalidos';
  end if;
  update public.operacoes
     set ipo = p_ipo, atualizado_em = now(), atualizado_por_nome = v_nome
   where id = p_operacao
  returning * into v_op;
  return json_build_object('id', v_op.id, 'ipo', v_op.ipo, 'atualizado_em', v_op.atualizado_em);
end;
$$;

revoke execute on function public.salvar_ipo_operacao(uuid, jsonb) from public, anon;
grant execute on function public.salvar_ipo_operacao(uuid, jsonb) to authenticated;

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

-- Distância em km entre dois pontos (fórmula de Haversine; raio médio da Terra)
create or replace function public.distancia_km(a_lat double precision, a_lng double precision, b_lat double precision, b_lng double precision)
returns double precision
language sql immutable
as $$
  select 2 * 6371.0088 * asin(least(1, sqrt(
    power(sin(radians(b_lat - a_lat) / 2), 2) + cos(radians(a_lat)) * cos(radians(b_lat)) * power(sin(radians(b_lng - a_lng) / 2), 2))));
$$;

-- Estudo de uma operação: ULV (ponto do cadastro), primeira localização da vítima, perfis das fichas.
-- Não devolve nomes, documentos nem nenhum dado de participante.
create or replace function public.estudo_operacao(p_operacao uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
  v_loc record;
begin
  if public.nome_responsavel_atual() is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  select v.condicao, v.lat, v.lng, coalesce(v.posicao_em, v.registrado_em) as em into v_loc
    from public.vitima_localizacoes v
   where v.operacao_id = p_operacao and v.lat is not null
   order by coalesce(v.posicao_em, v.registrado_em) limit 1;
  return json_build_object(
    'codigo', v_op.codigo, 'tipo', v_op.tipo, 'acionado_em', v_op.acionado_em, 'encerrada_em', v_op.encerrada_em,
    'ulv', case when v_op.local_lat is null then null else json_build_object('lat', v_op.local_lat, 'lng', v_op.local_lng) end,
    'localizacoes', (select count(*) from public.vitima_localizacoes v where v.operacao_id = p_operacao),
    'localizacao', case when v_loc.em is null then null else json_build_object(
        'condicao', v_loc.condicao,
        'em', v_loc.em,
        'minutos_ate', case when v_op.acionado_em is null then null else round(extract(epoch from v_loc.em - v_op.acionado_em) / 60) end,
        'distancia_km', case when v_op.local_lat is null then null
                             else round(public.distancia_km(v_op.local_lat, v_op.local_lng, v_loc.lat, v_loc.lng)::numeric, 2) end) end,
    'fichas', (select count(*) from public.vitimas t where t.operacao_id = p_operacao),
    'perfis', coalesce((select json_object_agg(x.perfil, x.n) from (
        select unnest(t.perfil) as perfil, count(*) as n from public.vitimas t where t.operacao_id = p_operacao group by 1) x), '{}'::json),
    'setores', (select count(*) from public.setores s where s.operacao_id = p_operacao),
    'registros_diario', (select count(*) from public.diario d where d.operacao_id = p_operacao)
  );
end;
$$;

-- Estudo geral: as operações que o responsável vê (administrador: todas). Só agregados.
-- Grupos com menos de 5 casos são ocultados (k = 5): ninguém é identificável pelos números.
create or replace function public.estudo_geral()
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_ops uuid[];
begin
  if public.nome_responsavel_atual() is null then
    raise exception 'sem_permissao';
  end if;
  select coalesce(array_agg(o.id), '{}'::uuid[]) into v_ops from public.operacoes o where public.dono_operacao(o.id);
  return (
    with ops as (
      select o.id, o.tipo, o.acionado_em, o.criada_em, o.encerrada_em, o.local_lat, o.local_lng
        from public.operacoes o where o.id = any(v_ops)
    ),
    primeira as (
      select distinct on (v.operacao_id) v.operacao_id, v.condicao, v.lat, v.lng, coalesce(v.posicao_em, v.registrado_em) as em
        from public.vitima_localizacoes v
       where v.operacao_id = any(v_ops) and v.lat is not null
       order by v.operacao_id, coalesce(v.posicao_em, v.registrado_em)
    ),
    casos as (
      select o.id as operacao_id, o.tipo, p.condicao,
             case when o.local_lat is null then null else public.distancia_km(o.local_lat, o.local_lng, p.lat, p.lng) end as km,
             case when o.acionado_em is null then null else extract(epoch from p.em - o.acionado_em) / 60 end as minutos
        from ops o join primeira p on p.operacao_id = o.id
    ),
    fichas as (
      select t.operacao_id, unnest(t.perfil) as perfil from public.vitimas t where t.operacao_id = any(v_ops)
    ),
    faixas as (
      select b.ordem, b.rotulo, count(c.operacao_id) as n
        from (values (1, 'até 1 km', 0::double precision, 1::double precision), (2, '1 a 2 km', 1, 2), (3, '2 a 5 km', 2, 5),
                     (4, '5 a 10 km', 5, 10), (5, 'mais de 10 km', 10, 1e9)) b(ordem, rotulo, de, ate)
        left join casos c on c.km >= b.de and c.km < b.ate
       group by b.ordem, b.rotulo
    )
    select json_build_object(
      'gerado_em', now(),
      'k_minimo', 5,
      'operacoes', json_build_object(
        'total', (select count(*) from ops),
        'abertas', (select count(*) from ops where encerrada_em is null),
        'encerradas', (select count(*) from ops where encerrada_em is not null),
        'por_tipo', coalesce((select json_object_agg(x.t, x.n) from (select coalesce(tipo, 'sem_tipo') as t, count(*) as n from ops group by 1) x), '{}'::json),
        'por_mes', coalesce((select json_agg(json_build_object('mes', x.mes, 'n', x.n) order by x.mes) from (
          select to_char(coalesce(acionado_em, criada_em), 'YYYY-MM') as mes, count(*) as n from ops
           where coalesce(acionado_em, criada_em) >= now() - interval '12 months' group by 1) x), '[]'::json)),
      'localizacoes', json_build_object(
        'operacoes_com_localizacao', (select count(*) from casos),
        'por_condicao', coalesce((select json_object_agg(x.condicao, case when x.n >= 5 then x.n end) from (
          select condicao, count(*) as n from casos group by 1) x), '{}'::json),
        'minutos_ate_mediana', (select case when count(minutos) >= 5 then round((percentile_cont(0.5) within group (order by minutos))::numeric) end from casos)),
      'distancia_km', json_build_object(
        'casos', (select case when count(km) >= 5 then count(km) end from casos),
        'p25', (select case when count(km) >= 5 then round((percentile_cont(0.25) within group (order by km))::numeric, 2) end from casos),
        'mediana', (select case when count(km) >= 5 then round((percentile_cont(0.5) within group (order by km))::numeric, 2) end from casos),
        'p75', (select case when count(km) >= 5 then round((percentile_cont(0.75) within group (order by km))::numeric, 2) end from casos),
        'media', (select case when count(km) >= 5 then round(avg(km)::numeric, 2) end from casos),
        'faixas', coalesce((select json_agg(json_build_object('faixa', f.rotulo, 'n', case when f.n >= 5 then f.n end) order by f.ordem) from faixas f), '[]'::json)),
      'perfis', coalesce((select json_agg(json_build_object(
          'perfil', p.perfil,
          'fichas', case when p.fichas >= 5 then p.fichas end,
          'operacoes_com_localizacao', case when p.casos >= 5 then p.casos end,
          'mediana_km', p.mediana_km) order by p.perfil) from (
        select pf.perfil,
               (select count(*) from fichas f where f.perfil = pf.perfil) as fichas,
               (select count(distinct f.operacao_id) from fichas f join casos c on c.operacao_id = f.operacao_id where f.perfil = pf.perfil) as casos,
               (select case when count(c.km) >= 5 then round((percentile_cont(0.5) within group (order by c.km))::numeric, 2) end
                  from fichas f join casos c on c.operacao_id = f.operacao_id where f.perfil = pf.perfil and c.km is not null) as mediana_km
          from (values ('idoso'), ('crianca'), ('adolescente'), ('demencia'), ('autismo'), ('deficiencia_intelectual'), ('transtorno_mental'), ('outro')) pf(perfil)
        ) p), '[]'::json)
    )
  );
end;
$$;

revoke execute on function public.estudo_operacao(uuid) from public, anon;
grant execute on function public.estudo_operacao(uuid) to authenticated;
revoke execute on function public.estudo_geral() from public, anon;
grant execute on function public.estudo_geral() to authenticated;

-- =====================================================================
-- 31. Responsável registra "vítima encontrada" pelo painel (migração 025 — idempotente; exige a 011)
--
--  Até aqui só o participante de campo registrava (participante_registrar_vitima). O responsável
--  também recebe a notícia por rádio, telefone ou pessoalmente e precisa registrar no sistema.
--  Mesmo formato do registro de campo, para o alerta, o diário, o dashboard e o relatório
--  tratarem igual:
--    mensagens            linha NEUTRA (categoria VITIMA, "Localizada, ver protocolo") no
--                         registro do próprio responsável na operação (criado se faltar);
--    vitima_localizacoes  a condição (viva/óbito), lida só pelos responsáveis (RLS da 011);
--    alertas              alerta crítico "VÍTIMA LOCALIZADA" para os demais responsáveis.
--  Opcional: quem encontrou (participante da operação), que fica no nome do registro.
--  A localização vem do mapa, do GPS do aparelho ou da posição de quem encontrou; nunca é inventada.
-- =====================================================================
create or replace function public.responsavel_registrar_vitima(
  p_operacao uuid, p_condicao text,
  p_lat double precision default null, p_lng double precision default null,
  p_precisao real default null, p_posicao_em timestamptz default null,
  p_encontrou uuid default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
  v_part public.participantes%rowtype;
  v_enc public.participantes%rowtype;
  v_msg public.mensagens%rowtype;
  v_reg public.vitima_localizacoes%rowtype;
  v_nome_reg text;
  v_prec real := case when p_precisao between 0 and 100000 then p_precisao end;
  v_pos_em timestamptz := case when p_lat is not null then least(coalesce(p_posicao_em, now()), now()) end;
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_condicao is null or p_condicao not in ('viva', 'obito') then
    raise exception 'dados_invalidos';
  end if;
  if (p_lat is null) <> (p_lng is null)
     or (p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0))) then
    raise exception 'posicao_invalida';
  end if;
  if p_encontrou is not null then
    select * into v_enc from public.participantes where id = p_encontrou and operacao_id = p_operacao;
    if not found then
      raise exception 'participante_invalido';
    end if;
  end if;

  -- registro do responsável na operação (o mesmo que aparece no mapa como "R")
  perform public.entrar_como_responsavel(p_operacao);
  select * into v_part from public.participantes where operacao_id = p_operacao and user_id = auth.uid();

  v_nome_reg := v_part.nome || case when v_enc.id is not null and v_enc.id <> v_part.id then ' (encontrada por ' || v_enc.nome || ')' else '' end;

  insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto,
                                direcao, categoria, lat, lng, precisao, posicao_em, entregue_em, lida_em, lida_por_nome)
  values (p_operacao, v_part.id, auth.uid(), v_part.nome, 'PARTICIPANTE', 'Localizada, ver protocolo',
          'entrada', 'VITIMA', p_lat, p_lng, v_prec, v_pos_em, now(), now(), v_part.nome)
  returning * into v_msg;

  insert into public.vitima_localizacoes (operacao_id, participante_id, mensagem_id, condicao, lat, lng, precisao,
                                          posicao_em, registrado_em, registrado_por, registrado_por_nome, registrado_por_tipo)
  values (p_operacao, v_part.id, v_msg.id, p_condicao, p_lat, p_lng, v_prec,
          v_pos_em, v_msg.criada_em, auth.uid(), left(v_nome_reg, 120), 'responsavel')
  returning * into v_reg;

  perform public.criar_alerta(p_operacao, 'vitima_localizada', 'critico',
    'VÍTIMA LOCALIZADA',
    'Registrado por ' || v_nome_reg || ' (responsável)' ||
      case when p_lat is null then ' · sem localização' else '' end || '. Veja a condição no painel.',
    'vitima:' || v_reg.id, null, null, coalesce(v_enc.id, v_part.id), p_lat, p_lng, v_pos_em);

  return json_build_object('mensagem', row_to_json(v_msg), 'registro', row_to_json(v_reg));
end;
$$;

revoke execute on function public.responsavel_registrar_vitima(uuid, text, double precision, double precision, real, timestamptz, uuid)
  from public, anon;
grant execute on function public.responsavel_registrar_vitima(uuid, text, double precision, double precision, real, timestamptz, uuid)
  to authenticated;


-- =====================================================================
-- 32. Operação encerrada: somente leitura (migração 026 — idempotente; exige a 012)
--
--  Depois de encerrada, a operação continua aberta para consulta pelos responsáveis e
--  administradores (mapa, trilhas, setores, pontos, mensagens, ficha, diário, dashboard),
--  mas nada do que foi registrado pode ser alterado. O servidor garante, não só a tela:
--  gatilhos recusam com "operacao_encerrada" a escrita feita DIRETAMENTE (por uma função
--  chamada pelo app) em setores, pontos, grupos e membros, fichas de vítima, destinos,
--  equipe de responsáveis, remoção/liberação/reinclusão de participantes, anotações manuais
--  do diário e o cadastro da operação.
--  Continuam permitidos: o resultado da operação e o relatório final, a reabertura, apagar os
--  dados pela retenção e excluir a operação. O que esses processos fazem por dentro (gatilhos e
--  exclusões em cascata, pg_trigger_depth() > 1) também passa.
-- =====================================================================
create or replace function public.bloquear_escrita_encerrada()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_op uuid;
  v_status text;
begin
  -- dentro de outro gatilho ou de exclusão em cascata (retenção, excluir operação, ON DELETE SET NULL)
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then v_op := old.operacao_id; else v_op := new.operacao_id; end if;
  -- diário: só as anotações manuais (os eventos automáticos continuam, ex.: resultado, dados apagados)
  if tg_table_name = 'diario' then
    if new.origem <> 'manual' then
      return new;
    end if;
  end if;
  select status into v_status from public.operacoes where id = v_op;
  if v_status is null or v_status = 'ativa' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'operacao_encerrada';
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['setores', 'pontos_interesse', 'grupos', 'grupo_membros', 'vitimas', 'destinos',
                           'operacao_responsaveis', 'participacao_eventos'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_encerrada', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.bloquear_escrita_encerrada()',
                   t || '_encerrada', t);
  end loop;
end;
$$;
drop trigger if exists diario_encerrada on public.diario;
create trigger diario_encerrada before insert or update on public.diario
  for each row execute function public.bloquear_escrita_encerrada();

-- Cadastro da operação encerrada não muda (nome, tipo, acionamento, local, descrição, IPO, GPS, retenção).
-- Resultado, encerramento/reabertura, prazo e apagamento dos dados seguem permitidos.
create or replace function public.operacoes_cadastro_encerrada()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 or old.status = 'ativa' or new.status = 'ativa' then
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'encerrada_em', 'expira_em', 'dados_apagados_em', 'resultado', 'resultado_texto',
                             'resultado_em', 'resultado_por_nome', 'atualizado_em', 'atualizado_por_nome'])
     is distinct from
     (to_jsonb(old) - array['status', 'encerrada_em', 'expira_em', 'dados_apagados_em', 'resultado', 'resultado_texto',
                             'resultado_em', 'resultado_por_nome', 'atualizado_em', 'atualizado_por_nome']) then
    raise exception 'operacao_encerrada';
  end if;
  return new;
end;
$$;
drop trigger if exists operacoes_cadastro_encerrada on public.operacoes;
create trigger operacoes_cadastro_encerrada before update on public.operacoes
  for each row execute function public.operacoes_cadastro_encerrada();

revoke execute on function public.bloquear_escrita_encerrada() from public, anon, authenticated;
revoke execute on function public.operacoes_cadastro_encerrada() from public, anon, authenticated;


-- =====================================================================
-- 33. Dados da operação só saem ao EXCLUIR a operação (migração 027 — idempotente; exige a 026)
--
--  Antes, encerrar (com "apagar ao encerrar") e a limpeza diária (prazo de retenção vencido)
--  apagavam participantes, trilhas, mensagens, fotos, setores, pontos, grupos e fichas.
--  Agora a operação encerrada fica guardada inteira para consulta e análise (o painel abre só
--  para visualização, migração 026). Os dados saem apenas quando alguém com permissão
--  EXCLUI a operação (excluir_operacao), como já era.
--    encerrar_operacao     não apaga nada e não marca prazo (expira_em fica vazio).
--    purgar_expiradas      não apaga dados de operação; continua encerrando operações esquecidas
--                          abertas há mais de 30 dias e removendo contas anônimas sem participação.
--    apagar_dados_operacao desativada (responde "apagar_dados_desativado").
--  Operações que ainda aguardavam o prazo deixam de ter prazo. O que já foi apagado antes não volta.
--  A coluna retencao_horas continua no banco (operações antigas e o relatório), mas não apaga mais nada.
-- =====================================================================
create or replace function public.encerrar_operacao(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;

  update public.operacoes
     set status = 'encerrada',
         encerrada_em = now(),
         expira_em = null
   where id = p_operacao and status = 'ativa'
  returning * into v_op;

  if not found then
    select * into v_op from public.operacoes where id = p_operacao;
    return row_to_json(v_op);
  end if;

  update public.participantes set rastreando = false where operacao_id = p_operacao;
  return row_to_json(v_op);
end;
$$;

create or replace function public.apagar_dados_operacao(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  raise exception 'apagar_dados_desativado';
end;
$$;

create or replace function public.purgar_expiradas()
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_encerradas integer := 0;
  v_anonimos integer := 0;
begin
  -- Salvaguarda: operações esquecidas abertas por mais de 30 dias são encerradas (nada é apagado).
  with x as (
    update public.operacoes
       set status = 'encerrada', encerrada_em = now(), expira_em = null
     where status = 'ativa' and criada_em < now() - interval '30 days'
    returning id
  )
  select count(*) into v_encerradas from x;

  -- Contas anônimas antigas que não participam de nenhuma operação guardada.
  begin
    with velhos as (
      delete from auth.users u
       where u.is_anonymous
         and u.created_at < now() - interval '7 days'
         and not exists (select 1 from public.participantes p where p.user_id = u.id)
      returning 1
    )
    select count(*) into v_anonimos from velhos;
  exception when others then
    v_anonimos := -1;   -- sem permissão no esquema auth: ignore
  end;

  return json_build_object('operacoes_encerradas', v_encerradas, 'operacoes_apagadas', 0, 'contas_anonimas_removidas', v_anonimos);
end;
$$;

revoke execute on function public.encerrar_operacao(uuid), public.apagar_dados_operacao(uuid) from public, anon;
grant execute on function public.encerrar_operacao(uuid), public.apagar_dados_operacao(uuid) to authenticated;
revoke execute on function public.purgar_expiradas() from public, anon, authenticated;

-- Operações encerradas que aguardavam o prazo: deixam de ter prazo (ficam guardadas).
update public.operacoes set expira_em = null where expira_em is not null and dados_apagados_em is null;

-- =====================================================================
-- 34. Trilhas desenhadas à mão no mapa (migração 028 — idempotente; exige a 003, 008, 012 e 026)
--
--  Linha (sequência ordenada de pontos) desenhada pelo responsável para registrar um
--  caminho: PLANEJADO (previsto para uma equipe) ou PERCORRIDO (informado como já feito).
--  É diferente do setor de busca (área) e do rastro do GPS (gravado pelo celular):
--  desenhar ou salvar nunca marca a trilha como percorrida — quem decide é o usuário.
--  Também não muda a situação de nenhum setor.
--
--  Leitura direta: só responsáveis da operação (RLS). Toda gravação passa por funções que
--  conferem a permissão (como setores e pontos). Operação encerrada: somente leitura
--  (gatilho da migração 026). Excluir a trilha apaga só a trilha.
--  Repetir o envio não duplica: o app gera um client_id ao começar o desenho.
-- =====================================================================

-- Confere uma linha [[lat, lng], …] com 2 a 2000 pontos.
create or replace function public.linha_valida(p jsonb)
returns boolean
language plpgsql immutable
as $$
declare
  v jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) < 2 or jsonb_array_length(p) > 2000 then
    return false;
  end if;
  for v in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) <> 2
       or jsonb_typeof(v->0) <> 'number' or jsonb_typeof(v->1) <> 'number'
       or (v->>0)::double precision not between -90 and 90
       or (v->>1)::double precision not between -180 and 180 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create table if not exists public.trilhas_manuais (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  client_id           uuid not null,                       -- gerado pelo app: repetir o envio não duplica
  nome                text not null check (char_length(btrim(nome)) between 1 and 80),
  estado              text not null check (estado in ('planejada', 'percorrida')),
  pontos              jsonb not null check (public.linha_valida(pontos)),   -- [[lat, lng], …] na ordem marcada
  comprimento_m       double precision not null default 0 check (comprimento_m >= 0),
  participante_id     uuid references public.participantes(id) on delete set null,
  grupo_id            uuid references public.grupos(id) on delete set null,
  equipe              text not null default '' check (char_length(equipe) <= 60),
  observacoes         text not null default '' check (char_length(observacoes) <= 1000),
  percorrida_em       timestamptz,                         -- informado pelo usuário ao marcar como percorrida
  percorrida_por_nome text,
  criado_por          uuid references auth.users(id) on delete set null,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text,
  constraint trilhas_manuais_cliente_unico unique (operacao_id, client_id),
  constraint trilhas_manuais_percorrida_ok check ((estado = 'percorrida') = (percorrida_em is not null))
);
create index if not exists trilhas_manuais_operacao_idx on public.trilhas_manuais (operacao_id);
-- Nome único dentro da operação (sem diferenciar maiúsculas): cada trilha se identifica pelo nome.
create unique index if not exists trilhas_manuais_nome_unico on public.trilhas_manuais (operacao_id, lower(btrim(nome)));

alter table public.trilhas_manuais enable row level security;
drop policy if exists trilhas_manuais_ler on public.trilhas_manuais;
create policy trilhas_manuais_ler on public.trilhas_manuais for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.trilhas_manuais from anon;
revoke insert, update, delete, truncate on public.trilhas_manuais from authenticated;
grant select on public.trilhas_manuais to authenticated;

-- Comprimento da linha em metros (soma dos trechos).
create or replace function public.comprimento_linha_m(p jsonb)
returns double precision
language sql stable
as $$
  select coalesce(sum(public.distancia_m((a.v->>0)::double precision, (a.v->>1)::double precision,
                                         (b.v->>0)::double precision, (b.v->>1)::double precision)), 0)
    from jsonb_array_elements(p) with ordinality a(v, i)
    join jsonb_array_elements(p) with ordinality b(v, i) on b.i = a.i + 1;
$$;

-- Cria (p_id nulo) ou altera uma trilha. Na alteração, só os campos enviados mudam.
-- p_dados: nome, estado, pontos, participante_id, grupo_id, equipe, observacoes, percorrida_em, client_id (criação).
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
             participante_id = v_t.participante_id, grupo_id = v_t.grupo_id, equipe = v_t.equipe,
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

-- Excluir: quem criou a trilha, quem criou a operação ou um administrador (como setores e pontos).
create or replace function public.excluir_trilha_manual(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.trilhas_manuais%rowtype;
begin
  select * into v from public.trilhas_manuais where id = p_id;
  if not found or not public.pode_excluir_registro(v.operacao_id, v.criado_por) then
    raise exception 'sem_permissao';
  end if;
  delete from public.trilhas_manuais where id = p_id;
end;
$$;

revoke execute on function public.salvar_trilha_manual(uuid, uuid, jsonb), public.excluir_trilha_manual(uuid) from public, anon;
grant execute on function public.salvar_trilha_manual(uuid, uuid, jsonb), public.excluir_trilha_manual(uuid) to authenticated;

-- Operação encerrada: somente leitura (mesmo gatilho dos setores e pontos, migração 026).
drop trigger if exists trilhas_manuais_encerrada on public.trilhas_manuais;
create trigger trilhas_manuais_encerrada before insert or update or delete on public.trilhas_manuais
  for each row execute function public.bloquear_escrita_encerrada();

-- Diário: entra quando um trajeto é informado como PERCORRIDO e quando uma trilha é excluída.
-- (Trilha só planejada não é um fato da busca; não entra no diário.)
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
    v_det := concat_ws(' · ', round(new.comprimento_m)::bigint || ' m', nullif(new.equipe, ''),
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
revoke execute on function public.diario_de_trilha_manual() from public, anon, authenticated;
drop trigger if exists trilhas_manuais_diario on public.trilhas_manuais;
create trigger trilhas_manuais_diario after insert or update of estado or delete on public.trilhas_manuais
  for each row execute function public.diario_de_trilha_manual();

-- Dados da operação apagados (retenção antiga): as trilhas desenhadas saem junto com setores e pontos.
create or replace function public.apagar_trilhas_manuais_da_operacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.trilhas_manuais where operacao_id = new.id;
  end if;
  return new;
end;
$$;
revoke execute on function public.apagar_trilhas_manuais_da_operacao() from public, anon, authenticated;
drop trigger if exists operacoes_apagar_trilhas_manuais on public.operacoes;
create trigger operacoes_apagar_trilhas_manuais after update of dados_apagados_em on public.operacoes
  for each row execute function public.apagar_trilhas_manuais_da_operacao();

-- Tempo real: trilhas no painel da operação; operações no mapa do dashboard
-- (cada responsável só recebe as mudanças das operações que pode ler — RLS).
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['trilhas_manuais', 'operacoes'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end;
$$;

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

-- =====================================================================
-- 37. Vítima encontrada com detalhes e resultado no encerramento (migração 031 — idempotente;
--     exige a 011, a 012 e a 025)
--
--  O registro de "vítima encontrada" passa a guardar, além da condição e do local:
--    vitima_id            a ficha da vítima (vitimas) a que o registro se refere — escolhida ou criada
--                         na hora só com o nome, quando ainda não há ficha;
--    encontrada_por_texto quem encontrou, quando não é participante da operação (morador, PM, SAMU…);
--    local_descricao      onde foi encontrada, em palavras (margem do rio, fundo de vale…);
--    observacoes          estado da vítima e encaminhamento (lesões, SAMU, hospital…).
--  registrar_vitima_encontrada(p_operacao, p_dados) faz tudo numa transação, com as mesmas regras e o
--  mesmo alerta, diário e mensagem neutra da 025 (que continua valendo). O painel usa o mesmo formulário
--  no botão "Vítima encontrada" e no encerramento da operação. O diário (e por ele o relatório) leva
--  os detalhes. Leitura só pelos responsáveis (RLS da 011). Operação encerrada: recusado.
-- =====================================================================
alter table public.vitima_localizacoes add column if not exists vitima_id uuid references public.vitimas(id) on delete set null;
alter table public.vitima_localizacoes add column if not exists encontrada_por_texto text;
alter table public.vitima_localizacoes add column if not exists local_descricao text;
alter table public.vitima_localizacoes add column if not exists observacoes text;
do $$
begin
  alter table public.vitima_localizacoes add constraint vitima_localizacoes_detalhes_ok check (
    (encontrada_por_texto is null or char_length(encontrada_por_texto) <= 120)
    and (local_descricao is null or char_length(local_descricao) <= 500)
    and (observacoes is null or char_length(observacoes) <= 1000));
exception when duplicate_object then null;
end;
$$;

-- p_dados: condicao ('viva'|'obito'), lat, lng, precisao, posicao_em, encontrou (participante),
--          encontrada_por (texto), local_descricao, observacoes, vitima_id ou vitima_nome (cria a ficha).
create or replace function public.registrar_vitima_encontrada(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_status text;
  v_part public.participantes%rowtype;
  v_enc public.participantes%rowtype;
  v_vit public.vitimas%rowtype;
  v_msg public.mensagens%rowtype;
  v_reg public.vitima_localizacoes%rowtype;
  v_nome_reg text;
  v_condicao text;
  v_lat double precision;
  v_lng double precision;
  v_prec real;
  v_pos_em timestamptz;
  v_enc_txt text;
  v_local text;
  v_obs text;
  v_ref uuid;
  v_vnome text;
begin
  if v_nome_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  v_condicao := p_dados->>'condicao';
  if v_condicao is null or v_condicao not in ('viva', 'obito') then
    raise exception 'dados_invalidos';
  end if;
  begin
    v_lat := nullif(p_dados->>'lat', '')::double precision;
    v_lng := nullif(p_dados->>'lng', '')::double precision;
    v_prec := nullif(p_dados->>'precisao', '')::real;
    v_pos_em := nullif(p_dados->>'posicao_em', '')::timestamptz;
  exception when others then
    raise exception 'posicao_invalida';
  end;
  if (v_lat is null) <> (v_lng is null)
     or (v_lat is not null and (v_lat not between -90 and 90 or v_lng not between -180 and 180 or (v_lat = 0 and v_lng = 0))) then
    raise exception 'posicao_invalida';
  end if;
  v_prec := case when v_prec between 0 and 100000 then v_prec end;
  v_pos_em := case when v_lat is not null then least(coalesce(v_pos_em, now()), now()) end;
  v_enc_txt := nullif(left(btrim(coalesce(p_dados->>'encontrada_por', '')), 120), '');
  v_local := nullif(left(btrim(coalesce(p_dados->>'local_descricao', '')), 500), '');
  v_obs := nullif(left(btrim(coalesce(p_dados->>'observacoes', '')), 1000), '');

  if nullif(p_dados->>'encontrou', '') is not null then
    begin
      v_ref := (p_dados->>'encontrou')::uuid;
    exception when others then
      raise exception 'participante_invalido';
    end;
    select * into v_enc from public.participantes where id = v_ref and operacao_id = p_operacao;
    if not found then
      raise exception 'participante_invalido';
    end if;
  end if;

  -- ficha da vítima: escolhida ou criada agora só com o nome
  if nullif(p_dados->>'vitima_id', '') is not null then
    begin
      v_ref := (p_dados->>'vitima_id')::uuid;
    exception when others then
      raise exception 'vitima_nao_encontrada';
    end;
    select * into v_vit from public.vitimas where id = v_ref and operacao_id = p_operacao;
    if not found then
      raise exception 'vitima_nao_encontrada';
    end if;
  elsif btrim(coalesce(p_dados->>'vitima_nome', '')) <> '' then
    v_vnome := btrim(regexp_replace(p_dados->>'vitima_nome', '\s+', ' ', 'g'));
    if char_length(v_vnome) > 80 then
      raise exception 'nome_vitima_invalido';
    end if;
    insert into public.vitimas (operacao_id, nome, criado_por, criado_por_nome, atualizado_por_nome)
    values (p_operacao, v_vnome, auth.uid(), v_nome_resp, v_nome_resp)
    returning * into v_vit;
  end if;

  -- registro do responsável na operação (o mesmo da 025)
  perform public.entrar_como_responsavel(p_operacao);
  select * into v_part from public.participantes where operacao_id = p_operacao and user_id = auth.uid();

  v_nome_reg := v_part.nome ||
    case when v_enc.id is not null and v_enc.id <> v_part.id then ' (encontrada por ' || v_enc.nome || ')'
         when v_enc_txt is not null then ' (encontrada por ' || v_enc_txt || ')' else '' end;

  insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto,
                                direcao, categoria, lat, lng, precisao, posicao_em, entregue_em, lida_em, lida_por_nome)
  values (p_operacao, v_part.id, auth.uid(), v_part.nome, 'PARTICIPANTE', 'Localizada, ver protocolo',
          'entrada', 'VITIMA', v_lat, v_lng, v_prec, v_pos_em, now(), now(), v_part.nome)
  returning * into v_msg;

  insert into public.vitima_localizacoes (operacao_id, participante_id, mensagem_id, condicao, lat, lng, precisao,
                                          posicao_em, registrado_em, registrado_por, registrado_por_nome, registrado_por_tipo,
                                          vitima_id, encontrada_por_texto, local_descricao, observacoes)
  values (p_operacao, v_part.id, v_msg.id, v_condicao, v_lat, v_lng, v_prec,
          v_pos_em, v_msg.criada_em, auth.uid(), left(v_nome_reg, 120), 'responsavel',
          v_vit.id, case when v_enc.id is null then v_enc_txt end, v_local, v_obs)
  returning * into v_reg;

  perform public.criar_alerta(p_operacao, 'vitima_localizada', 'critico',
    'VÍTIMA LOCALIZADA',
    'Registrado por ' || v_nome_reg || ' (responsável)' ||
      case when v_lat is null then ' · sem localização' else '' end || '. Veja a condição no painel.',
    'vitima:' || v_reg.id, null, null, coalesce(v_enc.id, v_part.id), v_lat, v_lng, v_pos_em);

  return json_build_object('mensagem', row_to_json(v_msg), 'registro', row_to_json(v_reg),
                           'vitima', case when v_vit.id is not null then row_to_json(v_vit) end);
end;
$$;
revoke execute on function public.registrar_vitima_encontrada(uuid, jsonb) from public, anon;
grant execute on function public.registrar_vitima_encontrada(uuid, jsonb) to authenticated;

-- Diário (e o relatório, que é montado dele): leva a vítima, o local e o estado.
create or replace function public.diario_de_vitima_localizada()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_vit text;
begin
  select nome into v_vit from public.vitimas where id = new.vitima_id;
  perform public.diario_auto(new.operacao_id, coalesce(new.posicao_em, new.registrado_em), 'encontro', 'vitima_localizada',
    'Vítima localizada — ' || case new.condicao when 'viva' then 'VIVA' else 'MORTA' end || coalesce(': ' || v_vit, ''),
    concat_ws(' · ',
      'Registrado por ' || new.registrado_por_nome || ' (' || public.diario_rotulo_tipo(new.registrado_por_tipo) || ')',
      case when new.encontrada_por_texto is not null and position('encontrada por' in new.registrado_por_nome) = 0
           then 'encontrada por ' || new.encontrada_por_texto end,
      case when new.local_descricao is not null then 'local: ' || new.local_descricao end,
      case when new.lat is null then 'sem localização do GPS' end,
      case when new.observacoes is not null then 'estado/encaminhamento: ' || new.observacoes end),
    'vitima_localizada:' || new.id, 'critico', new.lat, new.lng, new.id::text, new.registrado_por_nome);
  return new;
end;
$$;

-- =====================================================================
-- 38. Controle de tempo das atividades dos grupos (migração 032 — idempotente; exige a 010 e a 012)
--
--  Cada deslocamento de grupo (missão) pode ter, além do prazo de retorno após a busca (010):
--    inicio_combinado_em   horário combinado para o grupo INICIAR o deslocamento;
--    retorno_combinado_em  horário combinado para o grupo estar de VOLTA (na base ou concluído);
--    tolerancia_min        folga antes de alertar (padrão 10 min);
--    sem_sinal_min         minutos sem nenhum contato do celular de um membro para alertar uma
--                          possível falha de comunicação (padrão 10 min; vale para toda missão ativa);
--    combinado_texto       o que foi combinado (ex.: "contato por rádio a cada 30 min, canal 3").
--  definir_prazos_missao grava e ajusta (registra no diário). verificar_prazos (chamada junto com
--  verificar_retornos, pelo pg_cron a cada minuto e pelo painel aberto) gera os alertas:
--    inicio_atrasado         ninguém iniciou o deslocamento até o horário combinado + tolerância;
--    prazo_atrasado          horário combinado de retorno + tolerância passou e há quem não voltou;
--    sem_comunicacao         um membro está sem nenhum contato com o servidor há mais de sem_sinal_min
--                            (sem internet, bateria, celular desligado). O celular guarda as posições
--                            e envia quando o sinal volta;
--    comunicacao_restabelecida  o membro voltou a se comunicar: quanto tempo ficou sem, e quantas
--                            posições gravadas sem internet chegaram depois (com o período).
--  Os alertas são verificados pelo relógio do servidor, não dependem do celular estar online.
-- =====================================================================
alter table public.missoes add column if not exists inicio_combinado_em timestamptz;
alter table public.missoes add column if not exists retorno_combinado_em timestamptz;
alter table public.missoes add column if not exists tolerancia_min integer not null default 10;
alter table public.missoes add column if not exists sem_sinal_min integer not null default 10;
alter table public.missoes add column if not exists combinado_texto text;
alter table public.missoes add column if not exists prazos_definidos_por_nome text;
alter table public.missoes add column if not exists prazos_definidos_em timestamptz;
do $$
begin
  alter table public.missoes add constraint missoes_prazos_ok check (
    tolerancia_min between 0 and 240 and sem_sinal_min between 3 and 240
    and (combinado_texto is null or char_length(combinado_texto) <= 500)
    and (inicio_combinado_em is null or retorno_combinado_em is null or retorno_combinado_em > inicio_combinado_em));
exception when duplicate_object then null;
end;
$$;

alter table public.alertas drop constraint if exists alertas_tipo_check;
alter table public.alertas add constraint alertas_tipo_check
  check (tipo in ('deslocamento_iniciado', 'chegou_setor', 'busca_finalizada', 'chegou_base', 'retorno_atrasado',
                  'vitima_localizada', 'permanencia_setor',
                  'inicio_atrasado', 'prazo_atrasado', 'sem_comunicacao', 'comunicacao_restabelecida'));

-- Prazos combinados de um deslocamento. p_dados: inicio_combinado_em, retorno_combinado_em ('' limpa),
-- tolerancia_min, sem_sinal_min, combinado_texto. Só as chaves enviadas mudam.
create or replace function public.definir_prazos_missao(p_missao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_m public.missoes%rowtype;
  v_op public.operacoes%rowtype;
  v_det text;
begin
  select * into v_m from public.missoes where id = p_missao for update;
  if not found or v_nome is null or not public.dono_operacao(v_m.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = v_m.operacao_id;
  if v_op.status <> 'ativa' or v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  if v_m.status in ('encerrada', 'na_base') then
    raise exception 'missao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  begin
    if p_dados ? 'inicio_combinado_em' then v_m.inicio_combinado_em := nullif(p_dados->>'inicio_combinado_em', '')::timestamptz; end if;
    if p_dados ? 'retorno_combinado_em' then v_m.retorno_combinado_em := nullif(p_dados->>'retorno_combinado_em', '')::timestamptz; end if;
    if p_dados ? 'tolerancia_min' then v_m.tolerancia_min := (p_dados->>'tolerancia_min')::integer; end if;
    if p_dados ? 'sem_sinal_min' then v_m.sem_sinal_min := (p_dados->>'sem_sinal_min')::integer; end if;
  exception when others then
    raise exception 'horario_combinado_invalido';
  end;
  if p_dados ? 'combinado_texto' then v_m.combinado_texto := nullif(left(btrim(coalesce(p_dados->>'combinado_texto', '')), 500), ''); end if;
  if v_m.tolerancia_min is null or v_m.tolerancia_min not between 0 and 240
     or v_m.sem_sinal_min is null or v_m.sem_sinal_min not between 3 and 240 then
    raise exception 'dados_invalidos';
  end if;
  -- horários plausíveis: depois do acionamento (com folga) e até 2 dias à frente
  if (v_m.inicio_combinado_em is not null and (v_m.inicio_combinado_em < coalesce(v_op.acionado_em, v_op.criada_em) - interval '1 day'
                                                or v_m.inicio_combinado_em > now() + interval '2 days'))
     or (v_m.retorno_combinado_em is not null and (v_m.retorno_combinado_em < coalesce(v_op.acionado_em, v_op.criada_em) - interval '1 day'
                                                or v_m.retorno_combinado_em > now() + interval '2 days'))
     or (v_m.inicio_combinado_em is not null and v_m.retorno_combinado_em is not null and v_m.retorno_combinado_em <= v_m.inicio_combinado_em) then
    raise exception 'horario_combinado_invalido';
  end if;
  update public.missoes
     set inicio_combinado_em = v_m.inicio_combinado_em, retorno_combinado_em = v_m.retorno_combinado_em,
         tolerancia_min = v_m.tolerancia_min, sem_sinal_min = v_m.sem_sinal_min, combinado_texto = v_m.combinado_texto,
         prazos_definidos_por_nome = v_nome, prazos_definidos_em = now()
   where id = v_m.id
  returning * into v_m;
  v_det := concat_ws(' · ',
    case when v_m.inicio_combinado_em is not null then 'iniciar até ' || to_char(v_m.inicio_combinado_em at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') end,
    case when v_m.retorno_combinado_em is not null then 'retornar até ' || to_char(v_m.retorno_combinado_em at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') end,
    'tolerância ' || v_m.tolerancia_min || ' min', 'sem comunicação após ' || v_m.sem_sinal_min || ' min', v_m.combinado_texto);
  perform public.diario_auto(v_m.operacao_id, now(), 'deslocamento', 'prazos_definidos', 'Prazos combinados — ' || v_m.grupo_nome || ' → ' || v_m.nome,
    v_det, 'prazos:' || v_m.id || ':' || floor(extract(epoch from now()))::bigint, 'info', null, null, v_m.id::text, v_nome);
  return row_to_json(v_m);
end;
$$;
revoke execute on function public.definir_prazos_missao(uuid, jsonb) from public, anon;
grant execute on function public.definir_prazos_missao(uuid, jsonb) to authenticated;

-- Verificação por tempo (servidor). Devolve quantos alertas novos foram criados.
create or replace function public.verificar_prazos(p_operacao uuid default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_m public.missoes%rowtype;
  r record;
  v_qtd integer := 0;
  v_lista text;
  v_faltam integer;
  v_total integer;
  v_limite timestamptz;
  v_tarde integer;
  v_ini timestamptz;
  v_fim timestamptz;
  v_min integer;
begin
  if p_operacao is null then
    if auth.uid() is not null then
      raise exception 'sem_permissao';
    end if;
  elsif not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;

  for v_m in
    select m.* from public.missoes m join public.operacoes o on o.id = m.operacao_id
     where m.status not in ('encerrada', 'na_base') and o.status = 'ativa' and o.dados_apagados_em is null
       and (p_operacao is null or m.operacao_id = p_operacao)
  loop
    -- 1) início combinado: ninguém começou o deslocamento
    if v_m.inicio_combinado_em is not null and now() > v_m.inicio_combinado_em + make_interval(mins => v_m.tolerancia_min)
       and not exists (select 1 from public.missao_membros mb where mb.missao_id = v_m.id and mb.iniciou_em is not null) then
      if public.criar_alerta(v_m.operacao_id, 'inicio_atrasado', 'critico', 'INÍCIO ATRASADO — ' || v_m.grupo_nome,
           'O horário combinado para iniciar o deslocamento até ' || v_m.nome || ' era ' ||
           to_char(v_m.inicio_combinado_em at time zone 'America/Sao_Paulo', 'HH24:MI') || ' (tolerância ' || v_m.tolerancia_min ||
           ' min) e ninguém do grupo começou.' || coalesce(' Combinado: ' || v_m.combinado_texto, ''),
           v_m.id || ':inicio_atrasado:' || floor(extract(epoch from v_m.inicio_combinado_em))::bigint, v_m.id, v_m.grupo_id) then
        v_qtd := v_qtd + 1;
      end if;
    end if;

    -- 2) retorno combinado: quem ainda não voltou (com base: não chegou à base; sem base: missão aberta)
    if v_m.retorno_combinado_em is not null and now() > v_m.retorno_combinado_em + make_interval(mins => v_m.tolerancia_min) then
      select count(*) filter (where v_m.base_lat is null or mb.chegou_base_em is null), count(*),
             string_agg(case when v_m.base_lat is null or mb.chegou_base_em is null then
                          p.nome || case when p.ultimo_contato_em is null then ' (sem contato)'
                                         else ' (último contato há ' || greatest(0, floor(extract(epoch from now() - p.ultimo_contato_em) / 60))::integer || ' min)' end
                        end, ', ' order by p.nome)
        into v_faltam, v_total, v_lista
        from public.missao_membros mb join public.participantes p on p.id = mb.participante_id
       where mb.missao_id = v_m.id and not p.removido and p.liberado_em is null;
      if coalesce(v_faltam, 0) > 0 and public.criar_alerta(v_m.operacao_id, 'prazo_atrasado', 'critico', 'RETORNO ATRASADO — ' || v_m.grupo_nome,
           'O horário combinado para o retorno de ' || v_m.nome || ' era ' ||
           to_char(v_m.retorno_combinado_em at time zone 'America/Sao_Paulo', 'HH24:MI') || ' (tolerância ' || v_m.tolerancia_min || ' min). ' ||
           v_faltam || ' de ' || v_total || ' pessoa(s) não voltaram: ' || coalesce(v_lista, '—') || '.' || coalesce(' Combinado: ' || v_m.combinado_texto, ''),
           v_m.id || ':prazo_atrasado:' || floor(extract(epoch from v_m.retorno_combinado_em))::bigint, v_m.id, v_m.grupo_id) then
        v_qtd := v_qtd + 1;
      end if;
    end if;

    -- 3) comunicação de cada membro (pelo horário em que o SERVIDOR recebeu o último contato)
    for r in
      select p.id, p.nome, p.ultimo_contato_em, p.ultima_lat, p.ultima_lng, p.ultima_posicao_em, mb.chegou_base_em
        from public.missao_membros mb join public.participantes p on p.id = mb.participante_id
       where mb.missao_id = v_m.id and not p.removido and p.liberado_em is null
    loop
      v_limite := now() - make_interval(mins => v_m.sem_sinal_min);
      if r.ultimo_contato_em is not null and r.ultimo_contato_em < v_limite and r.chegou_base_em is null then
        if public.criar_alerta(v_m.operacao_id, 'sem_comunicacao', 'critico', 'SEM COMUNICAÇÃO — ' || r.nome,
             r.nome || ' (' || v_m.grupo_nome || ') está sem contato com o servidor desde ' ||
             to_char(r.ultimo_contato_em at time zone 'America/Sao_Paulo', 'HH24:MI') ||
             ' (mais de ' || v_m.sem_sinal_min || ' min). Pode estar sem internet, sem bateria ou com o celular desligado. ' ||
             'Última posição conhecida' || coalesce(' às ' || to_char(r.ultima_posicao_em at time zone 'America/Sao_Paulo', 'HH24:MI'), ': nenhuma') ||
             '. As posições gravadas sem internet chegam quando o sinal voltar.',
             v_m.id || ':' || r.id || ':sem_comunicacao:' || floor(extract(epoch from r.ultimo_contato_em))::bigint,
             v_m.id, v_m.grupo_id, r.id, r.ultima_lat, r.ultima_lng, r.ultima_posicao_em) then
          v_qtd := v_qtd + 1;
        end if;
      end if;
    end loop;
  end loop;

  -- 4) comunicação restabelecida: episódios abertos cujo membro voltou a se comunicar
  for r in
    select a.*, p.nome as p_nome, p.ultimo_contato_em,
           to_timestamp(nullif(split_part(a.chave, ':sem_comunicacao:', 2), '')::bigint) as contato_antes
      from public.alertas a
      join public.participantes p on p.id = a.participante_id
      join public.operacoes o on o.id = a.operacao_id
     where a.tipo = 'sem_comunicacao' and (p_operacao is null or a.operacao_id = p_operacao)
       and o.status = 'ativa' and o.dados_apagados_em is null
       and p.ultimo_contato_em > a.criado_em
       and not exists (select 1 from public.alertas b where b.chave = a.chave || ':restabelecida')
  loop
    -- posições que o celular gravou sem internet e enviou depois (recebidas > 60 s após o GPS)
    select count(*), min(x.registrado_em), max(x.registrado_em) into v_tarde, v_ini, v_fim
      from public.posicoes x
     where x.participante_id = r.participante_id and x.recebido_em >= coalesce(r.contato_antes, r.criado_em)
       and x.recebido_em - x.registrado_em > interval '60 seconds';
    v_min := greatest(1, floor(extract(epoch from r.ultimo_contato_em - coalesce(r.contato_antes, r.criado_em)) / 60))::integer;
    if public.criar_alerta(r.operacao_id, 'comunicacao_restabelecida', 'info', 'Comunicação restabelecida — ' || r.p_nome,
         r.p_nome || ' voltou a se comunicar às ' || to_char(r.ultimo_contato_em at time zone 'America/Sao_Paulo', 'HH24:MI') ||
         ' depois de cerca de ' || v_min || ' min sem contato.' ||
         case when coalesce(v_tarde, 0) > 0
              then ' ' || v_tarde || ' posição(ões) gravada(s) sem internet chegaram depois (de ' ||
                   to_char(v_ini at time zone 'America/Sao_Paulo', 'HH24:MI') || ' a ' || to_char(v_fim at time zone 'America/Sao_Paulo', 'HH24:MI') || ').'
              else ' Nenhuma posição gravada sem internet chegou depois.' end,
         r.chave || ':restabelecida', r.missao_id, r.grupo_id, r.participante_id) then
      v_qtd := v_qtd + 1;
    end if;
  end loop;
  return v_qtd;
end;
$$;
revoke execute on function public.verificar_prazos(uuid) from public, anon;
grant execute on function public.verificar_prazos(uuid) to authenticated, service_role;

create or replace function public.verificar_retornos(p_operacao uuid default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_m public.missoes%rowtype;
  v_faltam integer;
  v_total integer;
  v_lista text;
  v_lat double precision;
  v_lng double precision;
  v_pos timestamptz;
  v_pid uuid;
  v_qtd integer := 0;
begin
  if p_operacao is null then
    if auth.uid() is not null then
      raise exception 'sem_permissao';
    end if;
  elsif not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;

  for v_m in
    select m.* from public.missoes m join public.operacoes o on o.id = m.operacao_id
     where m.status in ('busca_finalizada', 'retorno_atrasado') and m.base_lat is not null and o.status = 'ativa'
       and (p_operacao is null or m.operacao_id = p_operacao)
     order by m.prazo_retorno_em
  loop
    if public.concluir_retorno_se_todos(v_m.id) then
      continue;
    end if;
    if v_m.prazo_retorno_em is null or now() < v_m.prazo_retorno_em then
      continue;
    end if;
    select count(*) filter (where mb.chegou_base_em is null), count(*),
           string_agg(case when mb.chegou_base_em is null then
                        p.nome || case when p.ultima_posicao_em is null then ' (sem posição)'
                                       else ' (última posição há ' || greatest(0, floor(extract(epoch from now() - p.ultima_posicao_em) / 60))::integer || ' min)' end
                      end, ', ' order by p.nome)
      into v_faltam, v_total, v_lista
      from public.missao_membros mb join public.participantes p on p.id = mb.participante_id
     where mb.missao_id = v_m.id and not p.removido and p.liberado_em is null;
    if coalesce(v_faltam, 0) = 0 then
      continue;
    end if;
    select p.id, p.ultima_lat, p.ultima_lng, p.ultima_posicao_em into v_pid, v_lat, v_lng, v_pos
      from public.missao_membros mb join public.participantes p on p.id = mb.participante_id
     where mb.missao_id = v_m.id and mb.chegou_base_em is null and not p.removido and p.liberado_em is null
     order by p.ultima_posicao_em nulls last limit 1;
    if public.criar_alerta(v_m.operacao_id, 'retorno_atrasado', 'critico',
         'EQUIPE PODE ESTAR PERDIDA — ' || v_m.grupo_nome,
         'O prazo de retorno à base' || coalesce(' ' || v_m.base_nome, '') || ' (' || v_m.prazo_retorno_min || ' min após finalizar a busca em ' ||
           v_m.nome || ') terminou e ' || v_faltam || ' de ' || v_total || ' pessoa(s) não chegaram. Faltam: ' || coalesce(v_lista, '—') || '.',
         v_m.id || ':retorno_atrasado:' || floor(extract(epoch from v_m.prazo_retorno_em))::bigint,
         v_m.id, v_m.grupo_id, v_pid, v_lat, v_lng, v_pos) then
      v_qtd := v_qtd + 1;
    end if;
    update public.missoes set status = 'retorno_atrasado' where id = v_m.id and status = 'busca_finalizada';
  end loop;
  -- prazos combinados e falhas de comunicação (migração 032), no mesmo agendamento
  v_qtd := v_qtd + public.verificar_prazos(p_operacao);
  return v_qtd;
end;
$$;

create or replace function public.diario_de_alerta()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.tipo = 'vitima_localizada' then
      return new;
    end if;
    -- sem comunicação: o horário do registro é o da detecção (a posição guardada é a última conhecida)
    perform public.diario_auto(new.operacao_id, case when new.tipo = 'sem_comunicacao' then new.criado_em else coalesce(new.posicao_em, new.criado_em) end,
      case new.tipo when 'chegou_setor' then 'chegada' when 'chegou_base' then 'chegada'
                    when 'retorno_atrasado' then 'alerta' when 'permanencia_setor' then 'alerta'
                    when 'inicio_atrasado' then 'alerta' when 'prazo_atrasado' then 'alerta' when 'sem_comunicacao' then 'alerta'
                    else 'deslocamento' end,
      'alerta_' || new.tipo, new.titulo, new.texto, 'alerta:' || new.id, new.nivel, new.lat, new.lng, new.id::text, 'Sistema');
  elsif new.nivel = 'critico' and old.reconhecido_em is null and new.reconhecido_em is not null then
    perform public.diario_auto(new.operacao_id, new.reconhecido_em, 'alerta', 'alerta_ciente',
      'Ciente do alerta: ' || new.titulo, '', 'alerta_ciente:' || new.id, 'info', null, null, new.id::text, new.reconhecido_por_nome);
  end if;
  return new;
end;
$$;

-- =====================================================================
-- 39. Probabilidades de busca: cenário por vítima (POA) e registro manual da busca (POD)
--     (migração 033 — idempotente; exige a 003, a 007, a 008, a 012 e a 026)
--
--  POA = probabilidade de a pessoa estar em cada setor. É uma decisão do responsável, por vítima,
--  guardada como CENÁRIO em versões numeradas (busca_cenarios + busca_cenario_setores), cada uma
--  com a justificativa. Uma versão nasce como RASCUNHO (editável, uma por vítima) e vira
--  APROVADA por cenario_aprovar. Aprovada, nunca mais muda nem é apagada: para rever, cria-se
--  uma nova versão (o histórico fica). O servidor garante (gatilhos), não só a tela.
--
--  POD = probabilidade de a busca encontrar a pessoa, se ela estiver no setor. Vem SEMPRE do
--  registro manual da busca (busca_registros: quem buscou, onde, o POD estimado e em que se baseou),
--  nunca do GPS: o GPS mostra por onde a equipe passou, não o que ela observou. Os registros não
--  se editam nem se apagam; um erro se corrige ANULANDO o registro (com o motivo) e lançando outro.
--
--  Quem calcula POA atual, POS e POD acumulado é o painel (js/pod.js), a partir destes dados.
--  Leitura só pelos responsáveis da operação (RLS); escrita só pelas funções abaixo. Aprovações,
--  registros e anulações entram no diário. Operação encerrada: tudo somente leitura (gatilho da 026).
-- =====================================================================
create table if not exists public.busca_cenarios (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  vitima_id           uuid not null references public.vitimas(id) on delete cascade,
  numero              integer not null check (numero >= 1),
  estado              text not null default 'rascunho' check (estado in ('rascunho', 'aprovada')),
  base_numero         integer,                                 -- versão aprovada de que esta partiu
  justificativa       text not null default '' check (char_length(justificativa) <= 2000),
  criado_por          uuid references auth.users(id) on delete set null,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text,
  aprovada_em         timestamptz,
  aprovada_por        uuid references auth.users(id) on delete set null,
  aprovada_por_nome   text,
  unique (vitima_id, numero),
  constraint busca_cenarios_aprovacao_ok check ((estado = 'aprovada') = (aprovada_em is not null))
);
create index if not exists busca_cenarios_operacao_idx on public.busca_cenarios (operacao_id, vitima_id, numero);
create unique index if not exists busca_cenarios_um_rascunho on public.busca_cenarios (vitima_id) where estado = 'rascunho';

create table if not exists public.busca_cenario_setores (
  id            uuid primary key default gen_random_uuid(),
  cenario_id    uuid not null references public.busca_cenarios(id) on delete cascade,
  operacao_id   uuid not null references public.operacoes(id) on delete cascade,
  setor_id      uuid references public.setores(id) on delete set null,   -- setor excluído depois: fica só o nome
  setor_nome    text not null check (char_length(btrim(setor_nome)) between 1 and 60),
  poa           numeric(7, 6) not null check (poa >= 0 and poa <= 1),
  justificativa text not null default '' check (char_length(justificativa) <= 500)
);
create index if not exists busca_cenario_setores_cenario_idx on public.busca_cenario_setores (cenario_id);
create unique index if not exists busca_cenario_setores_unico on public.busca_cenario_setores (cenario_id, setor_id) where setor_id is not null;

create table if not exists public.busca_registros (
  id                 uuid primary key default gen_random_uuid(),
  operacao_id        uuid not null references public.operacoes(id) on delete cascade,
  setor_id           uuid references public.setores(id) on delete set null,
  setor_nome         text not null check (char_length(btrim(setor_nome)) between 1 and 60),
  vitima_id          uuid references public.vitimas(id) on delete cascade,   -- nulo: vale para todas as vítimas
  grupo_id           uuid references public.grupos(id) on delete set null,
  equipe             text not null default '' check (char_length(equipe) <= 60),
  inicio             timestamptz,
  fim                timestamptz,
  pod                numeric(5, 4) not null check (pod >= 0 and pod <= 1),
  base_estimativa    text not null check (char_length(btrim(base_estimativa)) between 5 and 1000),
  condicoes          text not null default '' check (char_length(condicoes) <= 500),
  registrado_em      timestamptz not null default now(),
  registrado_por     uuid references auth.users(id) on delete set null,
  registrado_por_nome text not null,
  anulado_em         timestamptz,
  anulado_por_nome   text,
  anulado_motivo     text check (anulado_motivo is null or char_length(anulado_motivo) between 3 and 500),
  constraint busca_registros_periodo_ok check (inicio is null or fim is null or fim >= inicio),
  constraint busca_registros_anulacao_ok check ((anulado_em is null) = (anulado_motivo is null))
);
create index if not exists busca_registros_operacao_idx on public.busca_registros (operacao_id, registrado_em);

alter table public.busca_cenarios enable row level security;
alter table public.busca_cenario_setores enable row level security;
alter table public.busca_registros enable row level security;
drop policy if exists busca_cenarios_ler on public.busca_cenarios;
create policy busca_cenarios_ler on public.busca_cenarios for select to authenticated using (public.dono_operacao(operacao_id));
drop policy if exists busca_cenario_setores_ler on public.busca_cenario_setores;
create policy busca_cenario_setores_ler on public.busca_cenario_setores for select to authenticated using (public.dono_operacao(operacao_id));
drop policy if exists busca_registros_ler on public.busca_registros;
create policy busca_registros_ler on public.busca_registros for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.busca_cenarios, public.busca_cenario_setores, public.busca_registros from anon;
revoke insert, update, delete, truncate on public.busca_cenarios, public.busca_cenario_setores, public.busca_registros from authenticated;
grant select on public.busca_cenarios, public.busca_cenario_setores, public.busca_registros to authenticated;

-- Operação encerrada: somente leitura (o mesmo gatilho da 026)
do $$
declare
  t text;
begin
  foreach t in array array['busca_cenarios', 'busca_cenario_setores', 'busca_registros'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_encerrada', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.bloquear_escrita_encerrada()',
                   t || '_encerrada', t);
  end loop;
end;
$$;

-- Versão aprovada é definitiva: nem ela nem as linhas de setor mudam ou somem. Passam apenas as
-- exclusões e ajustes em cascata (excluir a operação ou a vítima; setor excluído vira nome solto).
create or replace function public.busca_cenarios_proteger()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_estado text;
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'busca_cenarios' then
    if tg_op in ('UPDATE', 'DELETE') and old.estado = 'aprovada' then
      raise exception 'cenario_imutavel_aprovado';
    end if;
    if tg_op = 'UPDATE' and (new.operacao_id <> old.operacao_id or new.vitima_id <> old.vitima_id or new.numero <> old.numero) then
      raise exception 'dados_invalidos';
    end if;
  else
    select estado into v_estado from public.busca_cenarios where id = coalesce(new.cenario_id, old.cenario_id);
    if v_estado = 'aprovada' then
      raise exception 'cenario_imutavel_aprovado';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
drop trigger if exists busca_cenarios_proteger on public.busca_cenarios;
create trigger busca_cenarios_proteger before update or delete on public.busca_cenarios
  for each row execute function public.busca_cenarios_proteger();
drop trigger if exists busca_cenario_setores_proteger on public.busca_cenario_setores;
create trigger busca_cenario_setores_proteger before insert or update or delete on public.busca_cenario_setores
  for each row execute function public.busca_cenarios_proteger();

-- Registro de busca: só a anulação (com motivo) altera o registro; nada se apaga.
create or replace function public.busca_registros_proteger()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'busca_registro_imutavel';
  end if;
  if old.anulado_em is not null
     or (to_jsonb(new) - array['anulado_em', 'anulado_por_nome', 'anulado_motivo'])
        is distinct from (to_jsonb(old) - array['anulado_em', 'anulado_por_nome', 'anulado_motivo']) then
    raise exception 'busca_registro_imutavel';
  end if;
  return new;
end;
$$;
drop trigger if exists busca_registros_proteger on public.busca_registros;
create trigger busca_registros_proteger before update or delete on public.busca_registros
  for each row execute function public.busca_registros_proteger();

revoke execute on function public.busca_cenarios_proteger(), public.busca_registros_proteger() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Cenário: salvar o rascunho (cria a próxima versão se ainda não há rascunho)
--   p_dados: justificativa (texto), setores [{ setor_id, poa (0 a 1), justificativa }],
--            atualizado_em (opcional: o do rascunho que a tela abriu; se mudou, recusa)
--   A soma dos POA pode ser menor que 1: o resto é "fora dos setores desenhados".
-- ---------------------------------------------------------------------
create or replace function public.cenario_salvar_rascunho(p_vitima uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_vit public.vitimas%rowtype;
  v_cen public.busca_cenarios%rowtype;
  v_status text;
  v_just text;
  v_itens jsonb;
  v_it jsonb;
  v_setor public.setores%rowtype;
  v_setor_id uuid;
  v_poa numeric;
  v_soma numeric := 0;
  v_vistos uuid[] := '{}';
  v_base integer;
  v_esperado timestamptz;
begin
  select * into v_vit from public.vitimas where id = p_vitima;
  if not found then
    raise exception 'vitima_nao_encontrada';
  end if;
  if v_nome is null or not public.dono_operacao(v_vit.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_vit.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  v_itens := coalesce(p_dados->'setores', '[]'::jsonb);
  if jsonb_typeof(v_itens) <> 'array' or jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  v_just := left(btrim(coalesce(p_dados->>'justificativa', '')), 2000);
  begin
    v_esperado := nullif(p_dados->>'atualizado_em', '')::timestamptz;
  exception when others then
    raise exception 'dados_invalidos';
  end;

  -- valida os setores antes de gravar qualquer coisa
  for v_it in select * from jsonb_array_elements(v_itens) loop
    begin
      v_setor_id := (v_it->>'setor_id')::uuid;
      v_poa := (v_it->>'poa')::numeric;
    exception when others then
      raise exception 'dados_invalidos';
    end;
    if v_poa is null or v_poa < 0 or v_poa > 1 or v_setor_id = any(v_vistos) then
      raise exception 'dados_invalidos';
    end if;
    if not exists (select 1 from public.setores where id = v_setor_id and operacao_id = v_vit.operacao_id) then
      raise exception 'setor_nao_encontrado';
    end if;
    v_vistos := v_vistos || v_setor_id;
    v_soma := v_soma + v_poa;
  end loop;
  if v_soma > 1.000001 then
    raise exception 'cenario_poa_acima_de_100';
  end if;

  perform pg_advisory_xact_lock(hashtext('cenario:' || p_vitima::text));
  select * into v_cen from public.busca_cenarios where vitima_id = p_vitima and estado = 'rascunho' for update;
  if found then
    if v_esperado is not null and v_esperado <> v_cen.atualizado_em then
      raise exception 'cenario_versao_desatualizada';
    end if;
    update public.busca_cenarios
       set justificativa = v_just, atualizado_em = now(), atualizado_por_nome = v_nome
     where id = v_cen.id
     returning * into v_cen;
    delete from public.busca_cenario_setores where cenario_id = v_cen.id;
  else
    select max(numero) into v_base from public.busca_cenarios where vitima_id = p_vitima and estado = 'aprovada';
    insert into public.busca_cenarios (operacao_id, vitima_id, numero, base_numero, justificativa, criado_por, criado_por_nome, atualizado_por_nome)
    values (v_vit.operacao_id, p_vitima,
            coalesce((select max(numero) from public.busca_cenarios where vitima_id = p_vitima), 0) + 1,
            v_base, v_just, auth.uid(), v_nome, v_nome)
    returning * into v_cen;
  end if;

  for v_it in select * from jsonb_array_elements(v_itens) loop
    select * into v_setor from public.setores where id = (v_it->>'setor_id')::uuid;
    insert into public.busca_cenario_setores (cenario_id, operacao_id, setor_id, setor_nome, poa, justificativa)
    values (v_cen.id, v_vit.operacao_id, v_setor.id, v_setor.nome, (v_it->>'poa')::numeric,
            left(btrim(coalesce(v_it->>'justificativa', '')), 500));
  end loop;

  return json_build_object('cenario', row_to_json(v_cen),
    'setores', coalesce((select json_agg(row_to_json(s) order by s.setor_nome) from public.busca_cenario_setores s where s.cenario_id = v_cen.id), '[]'::json));
end;
$$;

-- ---------------------------------------------------------------------
-- Cenário: aprovar o rascunho. Exige justificativa (mín. 10 caracteres) e ao menos um setor com POA > 0.
-- Depois de aprovada, a versão não muda mais; para rever, salve um novo rascunho (próxima versão).
-- ---------------------------------------------------------------------
create or replace function public.cenario_aprovar(p_cenario uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_cen public.busca_cenarios%rowtype;
  v_vit public.vitimas%rowtype;
  v_status text;
  v_soma numeric;
  v_detalhe text;
begin
  select * into v_cen from public.busca_cenarios where id = p_cenario for update;
  if not found then
    raise exception 'cenario_versao_inexistente';
  end if;
  if v_nome is null or not public.dono_operacao(v_cen.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_cen.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if v_cen.estado = 'aprovada' then
    raise exception 'cenario_imutavel_aprovado';
  end if;
  if char_length(btrim(v_cen.justificativa)) < 10 then
    raise exception 'cenario_sem_justificativa';
  end if;
  select coalesce(sum(poa), 0) into v_soma from public.busca_cenario_setores where cenario_id = v_cen.id;
  if v_soma <= 0 then
    raise exception 'cenario_sem_setores';
  end if;

  update public.busca_cenarios
     set estado = 'aprovada', aprovada_em = now(), aprovada_por = auth.uid(), aprovada_por_nome = v_nome,
         atualizado_em = now(), atualizado_por_nome = v_nome
   where id = v_cen.id
   returning * into v_cen;

  select * into v_vit from public.vitimas where id = v_cen.vitima_id;
  select string_agg(s.setor_nome || ': ' || trim_scale(round(s.poa * 100, 1))::text || '%', ' · ' order by s.poa desc, s.setor_nome)
    into v_detalhe from public.busca_cenario_setores s where s.cenario_id = v_cen.id;
  perform public.diario_auto(v_cen.operacao_id, v_cen.aprovada_em, 'pessoa', 'cenario_aprovado',
    'Cenário de busca aprovado: ' || v_vit.nome || ' (versão ' || v_cen.numero || ')',
    'POA por setor — ' || coalesce(v_detalhe, '') || '. Justificativa: ' || v_cen.justificativa,
    'cenario:' || v_cen.id, 'info', null, null, v_cen.id::text, v_nome);

  return json_build_object('cenario', row_to_json(v_cen),
    'setores', coalesce((select json_agg(row_to_json(s) order by s.setor_nome) from public.busca_cenario_setores s where s.cenario_id = v_cen.id), '[]'::json));
end;
$$;

-- Descartar o rascunho (só rascunho; aprovada nunca se apaga)
create or replace function public.cenario_descartar_rascunho(p_cenario uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_cen public.busca_cenarios%rowtype;
  v_status text;
begin
  select * into v_cen from public.busca_cenarios where id = p_cenario for update;
  if not found then
    raise exception 'cenario_versao_inexistente';
  end if;
  if v_nome is null or not public.dono_operacao(v_cen.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_cen.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if v_cen.estado <> 'rascunho' then
    raise exception 'cenario_imutavel_aprovado';
  end if;
  delete from public.busca_cenarios where id = v_cen.id;
end;
$$;

-- ---------------------------------------------------------------------
-- Registro manual de busca (origem do POD)
--   p_dados: setor_id, pod (0 a 1), base_estimativa (em que o POD se baseia), condicoes,
--            equipe (texto), grupo_id, vitima_id (nulo: todas as vítimas), inicio, fim
-- ---------------------------------------------------------------------
create or replace function public.busca_registrar(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_status text;
  v_setor public.setores%rowtype;
  v_grupo public.grupos%rowtype;
  v_vit public.vitimas%rowtype;
  v_reg public.busca_registros%rowtype;
  v_setor_id uuid;
  v_grupo_id uuid;
  v_vit_id uuid;
  v_pod numeric;
  v_ini timestamptz;
  v_fim timestamptz;
  v_base text;
  v_cond text;
  v_equipe text;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  begin
    v_setor_id := (p_dados->>'setor_id')::uuid;
    v_pod := (p_dados->>'pod')::numeric;
    v_grupo_id := nullif(p_dados->>'grupo_id', '')::uuid;
    v_vit_id := nullif(p_dados->>'vitima_id', '')::uuid;
    v_ini := nullif(p_dados->>'inicio', '')::timestamptz;
    v_fim := nullif(p_dados->>'fim', '')::timestamptz;
  exception when others then
    raise exception 'dados_invalidos';
  end;
  if v_pod is null or v_pod < 0 or v_pod > 1 then
    raise exception 'busca_pod_invalido';
  end if;
  if v_ini is not null and v_fim is not null and v_fim < v_ini then
    raise exception 'dados_invalidos';
  end if;
  v_base := btrim(coalesce(p_dados->>'base_estimativa', ''));
  if char_length(v_base) < 5 then
    raise exception 'busca_sem_base_estimativa';
  end if;
  v_cond := left(btrim(coalesce(p_dados->>'condicoes', '')), 500);
  v_equipe := left(btrim(coalesce(p_dados->>'equipe', '')), 60);

  select * into v_setor from public.setores where id = v_setor_id and operacao_id = p_operacao;
  if not found then
    raise exception 'setor_nao_encontrado';
  end if;
  if v_grupo_id is not null then
    select * into v_grupo from public.grupos where id = v_grupo_id and operacao_id = p_operacao;
    if not found then
      raise exception 'dados_invalidos';
    end if;
    if v_equipe = '' then v_equipe := left(v_grupo.nome, 60); end if;
  end if;
  if v_vit_id is not null then
    select * into v_vit from public.vitimas where id = v_vit_id and operacao_id = p_operacao;
    if not found then
      raise exception 'vitima_nao_encontrada';
    end if;
  end if;

  insert into public.busca_registros (operacao_id, setor_id, setor_nome, vitima_id, grupo_id, equipe, inicio, fim,
                                      pod, base_estimativa, condicoes, registrado_por, registrado_por_nome)
  values (p_operacao, v_setor.id, v_setor.nome, v_vit.id, v_grupo.id, v_equipe, v_ini, v_fim,
          round(v_pod, 4), v_base, v_cond, auth.uid(), v_nome)
  returning * into v_reg;

  perform public.diario_auto(p_operacao, v_reg.registrado_em, 'setor', 'busca_registrada',
    'Busca registrada em ' || v_setor.nome || ': POD ' || trim_scale(round(v_reg.pod * 100, 1))::text || '%',
    coalesce(nullif(v_equipe, ''), 'Equipe não informada') ||
      case when v_vit.id is not null then ' · vale para ' || v_vit.nome else ' · vale para todas as vítimas' end ||
      '. Base da estimativa: ' || v_base || case when v_cond <> '' then '. Condições: ' || v_cond else '' end,
    'busca:' || v_reg.id, 'info', null, null, v_reg.id::text, v_nome);

  return row_to_json(v_reg);
end;
$$;

-- Anular um registro de busca (erro de lançamento): fica no histórico, mas deixa de contar
create or replace function public.busca_anular(p_registro uuid, p_motivo text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_reg public.busca_registros%rowtype;
  v_status text;
  v_motivo text := left(btrim(coalesce(p_motivo, '')), 500);
begin
  select * into v_reg from public.busca_registros where id = p_registro for update;
  if not found then
    raise exception 'busca_registro_inexistente';
  end if;
  if v_nome is null or not public.dono_operacao(v_reg.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_reg.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if v_reg.anulado_em is not null then
    raise exception 'busca_registro_ja_anulado';
  end if;
  if char_length(v_motivo) < 3 then
    raise exception 'busca_anulacao_sem_motivo';
  end if;
  update public.busca_registros
     set anulado_em = now(), anulado_por_nome = v_nome, anulado_motivo = v_motivo
   where id = v_reg.id
   returning * into v_reg;
  perform public.diario_auto(v_reg.operacao_id, v_reg.anulado_em, 'setor', 'busca_anulada',
    'Registro de busca anulado em ' || v_reg.setor_nome || ' (POD ' || trim_scale(round(v_reg.pod * 100, 1))::text || '%)',
    'Motivo: ' || v_motivo, 'busca_anulada:' || v_reg.id, 'info', null, null, v_reg.id::text, v_nome);
  return row_to_json(v_reg);
end;
$$;

revoke execute on function public.cenario_salvar_rascunho(uuid, jsonb), public.cenario_aprovar(uuid), public.cenario_descartar_rascunho(uuid),
  public.busca_registrar(uuid, jsonb), public.busca_anular(uuid, text) from public, anon;
grant execute on function public.cenario_salvar_rascunho(uuid, jsonb), public.cenario_aprovar(uuid), public.cenario_descartar_rascunho(uuid),
  public.busca_registrar(uuid, jsonb), public.busca_anular(uuid, text) to authenticated;

-- Tempo real: os responsáveis veem versões e registros dos colegas na hora (RLS filtra por operação)
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['busca_cenarios', 'busca_cenario_setores', 'busca_registros'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end;
$$;

-- =====================================================================
-- 40. POA/POD conforme o guia de implantação (migração 034 — idempotente; exige a 033, a 011, a 031 e a 003)
--
--  Cenário (POA), por versão:
--    • geometria de cada setor GUARDADA na versão (forma, centro/raio ou pontos, área em m²): editar ou
--      excluir o setor depois não muda a versão aprovada;
--    • horário de referência, hipóteses, limitações, confiança (julgamento qualitativo, não estatístico),
--      origem do POA, último ponto confiável (com cópia dos dados) e evidências (com situação de confirmação);
--    • aprovar exige que os setores com POA não se sobreponham (mais de 2% do menor): senão a mesma área
--      seria contada duas vezes (cenario_setores_sobrepostos). Rascunho pode ter sobreposição;
--    • aprovar confere a revisão esperada (atualizado_em do rascunho que o responsável viu) e aceita chave de
--      idempotência: repetir a mesma aprovação devolve o mesmo resultado, sem duplicar;
--    • vítima já localizada: o cenário dela está encerrado (cenario_vitima_localizada); as demais seguem.
--  (rode a 033 antes da 034; não rode a 033 sozinha depois: ela recria a versão antiga de cenario_aprovar)
--  Registro de busca (POD):
--    • finalidade: 'pos_execucao' (o que ocorreu) ou 'planejada' (previsão; nunca altera o POA);
--    • POD pode ficar NÃO ESTIMADA (nulo): a busca é registrada, mas não reduz o POA. Nulo nunca vira zero;
--    • origem do POD, método, observadores, impedimentos, áreas não observadas, vínculo com o deslocamento (missão);
--    • busca em parte do setor: informa a fração coberta (a conta assume distribuição uniforme no setor);
--    • chave do cliente: reenviar o mesmo registro não duplica; mesma chave com outro conteúdo é recusada.
-- =====================================================================
alter table public.busca_cenarios add column if not exists horario_referencia timestamptz;
alter table public.busca_cenarios add column if not exists hipoteses text not null default '';
alter table public.busca_cenarios add column if not exists limitacoes text not null default '';
alter table public.busca_cenarios add column if not exists confianca text;
alter table public.busca_cenarios add column if not exists origem_poa text not null default 'julgamento_comando';
alter table public.busca_cenarios add column if not exists ponto_confiavel_id uuid references public.pontos_interesse(id) on delete set null;
alter table public.busca_cenarios add column if not exists ponto_confiavel jsonb;
alter table public.busca_cenarios add column if not exists aprovacao_chave text;
do $$
begin
  alter table public.busca_cenarios add constraint busca_cenarios_guia_ok check (
    char_length(hipoteses) <= 2000 and char_length(limitacoes) <= 1000
    and (confianca is null or confianca in ('baixa', 'media', 'alta'))
    and origem_poa in ('julgamento_comando', 'consenso_documentado', 'modelo_validado'));
exception when duplicate_object then null;
end;
$$;
create unique index if not exists busca_cenarios_chave_unica on public.busca_cenarios (vitima_id, aprovacao_chave) where aprovacao_chave is not null;

-- geometria do setor na versão (cópia: a versão antiga continua íntegra se o setor mudar)
alter table public.busca_cenario_setores add column if not exists forma text;
alter table public.busca_cenario_setores add column if not exists centro_lat double precision;
alter table public.busca_cenario_setores add column if not exists centro_lng double precision;
alter table public.busca_cenario_setores add column if not exists raio_m double precision;
alter table public.busca_cenario_setores add column if not exists pontos jsonb;
alter table public.busca_cenario_setores add column if not exists area_m2 double precision;

create table if not exists public.busca_cenario_evidencias (
  id          uuid primary key default gen_random_uuid(),
  cenario_id  uuid not null references public.busca_cenarios(id) on delete cascade,
  operacao_id uuid not null references public.operacoes(id) on delete cascade,
  ponto_id    uuid references public.pontos_interesse(id) on delete set null,
  descricao   text not null check (char_length(btrim(descricao)) between 1 and 300),
  confirmada  boolean not null default false
);
create index if not exists busca_cenario_evidencias_cenario_idx on public.busca_cenario_evidencias (cenario_id);
alter table public.busca_cenario_evidencias enable row level security;
drop policy if exists busca_cenario_evidencias_ler on public.busca_cenario_evidencias;
create policy busca_cenario_evidencias_ler on public.busca_cenario_evidencias for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.busca_cenario_evidencias from anon;
revoke insert, update, delete, truncate on public.busca_cenario_evidencias from authenticated;
grant select on public.busca_cenario_evidencias to authenticated;
drop trigger if exists busca_cenario_evidencias_encerrada on public.busca_cenario_evidencias;
create trigger busca_cenario_evidencias_encerrada before insert or update or delete on public.busca_cenario_evidencias
  for each row execute function public.bloquear_escrita_encerrada();
drop trigger if exists busca_cenario_evidencias_proteger on public.busca_cenario_evidencias;
create trigger busca_cenario_evidencias_proteger before insert or update or delete on public.busca_cenario_evidencias
  for each row execute function public.busca_cenarios_proteger();

-- registros de busca
alter table public.busca_registros alter column pod drop not null;
alter table public.busca_registros add column if not exists finalidade text not null default 'pos_execucao';
alter table public.busca_registros add column if not exists origem_pod text not null default 'julgamento_comando';
alter table public.busca_registros add column if not exists metodo text;
alter table public.busca_registros add column if not exists missao_id uuid references public.missoes(id) on delete set null;
alter table public.busca_registros add column if not exists alcance text not null default 'setor_inteiro';
alter table public.busca_registros add column if not exists cobertura_fracao numeric(5, 4);
alter table public.busca_registros add column if not exists observadores smallint;
alter table public.busca_registros add column if not exists impedimentos text not null default '';
alter table public.busca_registros add column if not exists areas_nao_observadas text not null default '';
alter table public.busca_registros add column if not exists chave_cliente text;
do $$
begin
  alter table public.busca_registros add constraint busca_registros_guia_ok check (
    finalidade in ('pos_execucao', 'planejada')
    and origem_pod in ('julgamento_comando', 'consenso_documentado', 'modelo_validado')
    and (metodo is null or char_length(metodo) <= 60)
    and alcance in ('setor_inteiro', 'parcial')
    and ((alcance = 'parcial') = (cobertura_fracao is not null))
    and (cobertura_fracao is null or (cobertura_fracao > 0 and cobertura_fracao < 1))
    and (observadores is null or observadores between 1 and 500)
    and char_length(impedimentos) <= 500 and char_length(areas_nao_observadas) <= 500
    and (finalidade = 'pos_execucao' or pod is not null));
exception when duplicate_object then null;
end;
$$;
create unique index if not exists busca_registros_chave_unica on public.busca_registros (operacao_id, chave_cliente) where chave_cliente is not null;

-- Tempo real das evidências
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.busca_cenario_evidencias;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Geometria: polígono do setor (círculo vira 48 lados), área e sobreposição.
-- A sobreposição é medida por amostragem (grade 30 × 30 sobre o menor setor): fração do menor setor que
-- também está dentro do outro. O mesmo cálculo existe em js/pod.js (conferido pelos testes).
-- ---------------------------------------------------------------------
create or replace function public.busca_poligono(p_forma text, p_clat double precision, p_clng double precision, p_raio double precision, p_pontos jsonb)
returns jsonb
language plpgsql immutable set search_path = public
as $$
declare
  v_r constant double precision := 6371008.8;
  v_out jsonb := '[]'::jsonb;
  i integer;
  a double precision;
begin
  if p_forma = 'circulo' then
    for i in 0..47 loop
      a := 2 * pi() * i / 48;
      v_out := v_out || jsonb_build_array(jsonb_build_array(
        p_clat + degrees(p_raio * sin(a) / v_r),
        p_clng + degrees(p_raio * cos(a) / (v_r * cos(radians(p_clat))))));
    end loop;
    return v_out;
  end if;
  return coalesce(p_pontos, '[]'::jsonb);
end;
$$;

create or replace function public.busca_area_m2(p_forma text, p_clat double precision, p_clng double precision, p_raio double precision, p_pontos jsonb)
returns double precision
language plpgsql immutable set search_path = public
as $$
declare
  v_r constant double precision := 6371008.8;
  v_poli jsonb;
  n integer;
  i integer;
  j integer;
  la0 double precision;
  ln0 double precision;
  k double precision;
  xi double precision; yi double precision; xj double precision; yj double precision;
  s double precision := 0;
begin
  if p_forma = 'circulo' then
    return pi() * p_raio * p_raio;
  end if;
  v_poli := public.busca_poligono(p_forma, p_clat, p_clng, p_raio, p_pontos);
  n := jsonb_array_length(v_poli);
  if n < 3 then return 0; end if;
  la0 := (v_poli->0->>0)::double precision;
  ln0 := (v_poli->0->>1)::double precision;
  k := cos(radians(la0));
  j := n - 1;
  for i in 0..n - 1 loop
    xi := radians((v_poli->i->>1)::double precision - ln0) * v_r * k;
    yi := radians((v_poli->i->>0)::double precision - la0) * v_r;
    xj := radians((v_poli->j->>1)::double precision - ln0) * v_r * k;
    yj := radians((v_poli->j->>0)::double precision - la0) * v_r;
    s := s + (xj + xi) * (yj - yi);
    j := i;
  end loop;
  return abs(s / 2);
end;
$$;

create or replace function public.busca_ponto_no_poligono(x double precision, y double precision, xs double precision[], ys double precision[])
returns boolean
language plpgsql immutable set search_path = public
as $$
declare
  n integer := coalesce(array_length(xs, 1), 0);
  i integer;
  j integer;
  dentro boolean := false;
begin
  j := n;
  for i in 1..n loop
    if ((ys[i] > y) <> (ys[j] > y)) and (x < (xs[j] - xs[i]) * (y - ys[i]) / (ys[j] - ys[i]) + xs[i]) then
      dentro := not dentro;
    end if;
    j := i;
  end loop;
  return dentro;
end;
$$;

create or replace function public.busca_sobreposicao_fracao(p_a jsonb, p_b jsonb)
returns double precision
language plpgsql immutable set search_path = public
as $$
declare
  v_r constant double precision := 6371008.8;
  na integer := coalesce(jsonb_array_length(p_a), 0);
  nb integer := coalesce(jsonb_array_length(p_b), 0);
  la0 double precision;
  ln0 double precision;
  k double precision;
  ax double precision[] := '{}'; ay double precision[] := '{}';
  qx double precision[] := '{}'; qy double precision[] := '{}';
  sx double precision[]; sy double precision[]; lx double precision[]; ly double precision[];
  area_a double precision := 0; area_b double precision := 0;
  i integer; j integer;
  minx double precision; maxx double precision; miny double precision; maxy double precision;
  px double precision; py double precision;
  cnt_s integer := 0; cnt_b integer := 0;
  gi integer; gj integer;
begin
  if na < 3 or nb < 3 then return 0; end if;
  la0 := (p_a->0->>0)::double precision;
  ln0 := (p_a->0->>1)::double precision;
  k := cos(radians(la0));
  for i in 0..na - 1 loop
    ax := ax || (radians((p_a->i->>1)::double precision - ln0) * v_r * k);
    ay := ay || (radians((p_a->i->>0)::double precision - la0) * v_r);
  end loop;
  for i in 0..nb - 1 loop
    qx := qx || (radians((p_b->i->>1)::double precision - ln0) * v_r * k);
    qy := qy || (radians((p_b->i->>0)::double precision - la0) * v_r);
  end loop;
  j := na;
  for i in 1..na loop area_a := area_a + (ax[j] + ax[i]) * (ay[j] - ay[i]); j := i; end loop;
  j := nb;
  for i in 1..nb loop area_b := area_b + (qx[j] + qx[i]) * (qy[j] - qy[i]); j := i; end loop;
  if abs(area_a) <= abs(area_b) then
    sx := ax; sy := ay; lx := qx; ly := qy;
  else
    sx := qx; sy := qy; lx := ax; ly := ay;
  end if;
  minx := (select min(v) from unnest(sx) v); maxx := (select max(v) from unnest(sx) v);
  miny := (select min(v) from unnest(sy) v); maxy := (select max(v) from unnest(sy) v);
  for gi in 0..29 loop
    px := minx + (gi + 0.5) * (maxx - minx) / 30;
    for gj in 0..29 loop
      py := miny + (gj + 0.5) * (maxy - miny) / 30;
      if public.busca_ponto_no_poligono(px, py, sx, sy) then
        cnt_s := cnt_s + 1;
        if public.busca_ponto_no_poligono(px, py, lx, ly) then cnt_b := cnt_b + 1; end if;
      end if;
    end loop;
  end loop;
  if cnt_s = 0 then return 0; end if;
  return cnt_b::double precision / cnt_s;
end;
$$;

-- Primeiro par de setores com POA > 0 que se sobrepõem (mais de 2% do menor), ou nulo
create or replace function public.busca_cenario_sobreposicao(p_cenario uuid)
returns text
language plpgsql stable set search_path = public
as $$
declare
  a record;
  b record;
begin
  for a in select * from public.busca_cenario_setores where cenario_id = p_cenario and poa > 0 and forma is not null order by setor_nome loop
    for b in select * from public.busca_cenario_setores where cenario_id = p_cenario and poa > 0 and forma is not null and setor_nome > a.setor_nome order by setor_nome loop
      if public.busca_sobreposicao_fracao(
           public.busca_poligono(a.forma, a.centro_lat, a.centro_lng, a.raio_m, a.pontos),
           public.busca_poligono(b.forma, b.centro_lat, b.centro_lng, b.raio_m, b.pontos)) > 0.02 then
        return a.setor_nome || ' × ' || b.setor_nome;
      end if;
    end loop;
  end loop;
  return null;
end;
$$;
revoke execute on function public.busca_poligono(text, double precision, double precision, double precision, jsonb),
  public.busca_area_m2(text, double precision, double precision, double precision, jsonb),
  public.busca_ponto_no_poligono(double precision, double precision, double precision[], double precision[]),
  public.busca_sobreposicao_fracao(jsonb, jsonb), public.busca_cenario_sobreposicao(uuid) from public, anon;

-- ---------------------------------------------------------------------
-- Cenário: salvar o rascunho (agora com a geometria, as hipóteses e as evidências)
--   p_dados: justificativa, setores [{ setor_id, poa (0 a 1), justificativa }], atualizado_em (revisão esperada),
--            horario_referencia, hipoteses, limitacoes, confianca ('baixa'|'media'|'alta'), origem_poa,
--            ponto_confiavel_id, evidencias [{ ponto_id, descricao, confirmada }]
-- ---------------------------------------------------------------------
create or replace function public.cenario_salvar_rascunho(p_vitima uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_vit public.vitimas%rowtype;
  v_cen public.busca_cenarios%rowtype;
  v_status text;
  v_just text;
  v_itens jsonb;
  v_evid jsonb;
  v_it jsonb;
  v_setor public.setores%rowtype;
  v_ponto public.pontos_interesse%rowtype;
  v_setor_id uuid;
  v_poa numeric;
  v_soma numeric := 0;
  v_vistos uuid[] := '{}';
  v_base integer;
  v_esperado timestamptz;
  v_hr timestamptz;
  v_hip text;
  v_lim text;
  v_conf text;
  v_origem text;
  v_ponto_id uuid;
  v_ponto_json jsonb;
  v_desc text;
begin
  select * into v_vit from public.vitimas where id = p_vitima;
  if not found then
    raise exception 'vitima_nao_encontrada';
  end if;
  if v_nome is null or not public.dono_operacao(v_vit.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_vit.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if exists (select 1 from public.vitima_localizacoes where vitima_id = p_vitima) then
    raise exception 'cenario_vitima_localizada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  v_itens := coalesce(p_dados->'setores', '[]'::jsonb);
  v_evid := coalesce(p_dados->'evidencias', '[]'::jsonb);
  if jsonb_typeof(v_itens) <> 'array' or jsonb_typeof(v_evid) <> 'array' then
    raise exception 'dados_invalidos';
  end if;
  if jsonb_array_length(v_evid) > 30 then
    raise exception 'dados_invalidos';
  end if;
  v_just := left(btrim(coalesce(p_dados->>'justificativa', '')), 2000);
  v_hip := left(btrim(coalesce(p_dados->>'hipoteses', '')), 2000);
  v_lim := left(btrim(coalesce(p_dados->>'limitacoes', '')), 1000);
  v_conf := nullif(p_dados->>'confianca', '');
  v_origem := coalesce(nullif(p_dados->>'origem_poa', ''), 'julgamento_comando');
  if (v_conf is not null and v_conf not in ('baixa', 'media', 'alta')) or v_origem not in ('julgamento_comando', 'consenso_documentado') then
    raise exception 'dados_invalidos';
  end if;
  begin
    v_esperado := nullif(p_dados->>'atualizado_em', '')::timestamptz;
    v_hr := nullif(p_dados->>'horario_referencia', '')::timestamptz;
    v_ponto_id := nullif(p_dados->>'ponto_confiavel_id', '')::uuid;
  exception when others then
    raise exception 'dados_invalidos';
  end;
  if v_hr is not null and v_hr > now() + interval '10 minutes' then
    raise exception 'dados_invalidos';
  end if;
  if v_ponto_id is not null then
    select * into v_ponto from public.pontos_interesse where id = v_ponto_id and operacao_id = v_vit.operacao_id;
    if not found then
      raise exception 'dados_invalidos';
    end if;
    v_ponto_json := jsonb_build_object('titulo', v_ponto.titulo, 'categoria', v_ponto.categoria, 'lat', v_ponto.lat, 'lng', v_ponto.lng);
  end if;

  -- valida os setores antes de gravar qualquer coisa
  for v_it in select * from jsonb_array_elements(v_itens) loop
    begin
      v_setor_id := (v_it->>'setor_id')::uuid;
      v_poa := (v_it->>'poa')::numeric;
    exception when others then
      raise exception 'dados_invalidos';
    end;
    if v_poa is null or v_poa < 0 or v_poa > 1 or v_setor_id = any(v_vistos) then
      raise exception 'dados_invalidos';
    end if;
    if not exists (select 1 from public.setores where id = v_setor_id and operacao_id = v_vit.operacao_id) then
      raise exception 'setor_nao_encontrado';
    end if;
    v_vistos := v_vistos || v_setor_id;
    v_soma := v_soma + v_poa;
  end loop;
  if v_soma > 1.000001 then
    raise exception 'cenario_poa_acima_de_100';
  end if;
  for v_it in select * from jsonb_array_elements(v_evid) loop
    if jsonb_typeof(v_it) <> 'object' then
      raise exception 'dados_invalidos';
    end if;
    if nullif(v_it->>'ponto_id', '') is not null then
      begin
        perform (v_it->>'ponto_id')::uuid;
      exception when others then
        raise exception 'dados_invalidos';
      end;
      if not exists (select 1 from public.pontos_interesse where id = (v_it->>'ponto_id')::uuid and operacao_id = v_vit.operacao_id) then
        raise exception 'dados_invalidos';
      end if;
    elsif char_length(btrim(coalesce(v_it->>'descricao', ''))) < 1 then
      raise exception 'dados_invalidos';
    end if;
  end loop;

  perform pg_advisory_xact_lock(hashtext('cenario:' || p_vitima::text));
  select * into v_cen from public.busca_cenarios where vitima_id = p_vitima and estado = 'rascunho' for update;
  if found then
    if v_esperado is not null and v_esperado <> v_cen.atualizado_em then
      raise exception 'cenario_versao_desatualizada';
    end if;
    update public.busca_cenarios
       set justificativa = v_just, hipoteses = v_hip, limitacoes = v_lim, confianca = v_conf, origem_poa = v_origem,
           horario_referencia = coalesce(v_hr, horario_referencia, now()),
           ponto_confiavel_id = v_ponto_id, ponto_confiavel = v_ponto_json,
           atualizado_em = now(), atualizado_por_nome = v_nome
     where id = v_cen.id
     returning * into v_cen;
    delete from public.busca_cenario_setores where cenario_id = v_cen.id;
    delete from public.busca_cenario_evidencias where cenario_id = v_cen.id;
  else
    select max(numero) into v_base from public.busca_cenarios where vitima_id = p_vitima and estado = 'aprovada';
    insert into public.busca_cenarios (operacao_id, vitima_id, numero, base_numero, justificativa, hipoteses, limitacoes, confianca, origem_poa,
                                       horario_referencia, ponto_confiavel_id, ponto_confiavel, criado_por, criado_por_nome, atualizado_por_nome)
    values (v_vit.operacao_id, p_vitima,
            coalesce((select max(numero) from public.busca_cenarios where vitima_id = p_vitima), 0) + 1,
            v_base, v_just, v_hip, v_lim, v_conf, v_origem, coalesce(v_hr, now()), v_ponto_id, v_ponto_json, auth.uid(), v_nome, v_nome)
    returning * into v_cen;
  end if;

  for v_it in select * from jsonb_array_elements(v_itens) loop
    select * into v_setor from public.setores where id = (v_it->>'setor_id')::uuid;
    insert into public.busca_cenario_setores (cenario_id, operacao_id, setor_id, setor_nome, poa, justificativa,
                                              forma, centro_lat, centro_lng, raio_m, pontos, area_m2)
    values (v_cen.id, v_vit.operacao_id, v_setor.id, v_setor.nome, (v_it->>'poa')::numeric,
            left(btrim(coalesce(v_it->>'justificativa', '')), 500),
            v_setor.forma, v_setor.centro_lat, v_setor.centro_lng, v_setor.raio_m, v_setor.pontos,
            public.busca_area_m2(v_setor.forma, v_setor.centro_lat, v_setor.centro_lng, v_setor.raio_m, v_setor.pontos));
  end loop;
  for v_it in select * from jsonb_array_elements(v_evid) loop
    if nullif(v_it->>'ponto_id', '') is not null then
      select * into v_ponto from public.pontos_interesse where id = (v_it->>'ponto_id')::uuid;
      v_desc := coalesce(nullif(btrim(v_it->>'descricao'), ''), v_ponto.categoria || ' — ' || v_ponto.titulo);
      insert into public.busca_cenario_evidencias (cenario_id, operacao_id, ponto_id, descricao, confirmada)
      values (v_cen.id, v_vit.operacao_id, v_ponto.id, left(v_desc, 300), coalesce((v_it->>'confirmada')::boolean, false));
    else
      insert into public.busca_cenario_evidencias (cenario_id, operacao_id, ponto_id, descricao, confirmada)
      values (v_cen.id, v_vit.operacao_id, null, left(btrim(v_it->>'descricao'), 300), coalesce((v_it->>'confirmada')::boolean, false));
    end if;
  end loop;

  return json_build_object('cenario', row_to_json(v_cen),
    'setores', coalesce((select json_agg(row_to_json(s) order by s.setor_nome) from public.busca_cenario_setores s where s.cenario_id = v_cen.id), '[]'::json),
    'evidencias', coalesce((select json_agg(row_to_json(e) order by e.descricao) from public.busca_cenario_evidencias e where e.cenario_id = v_cen.id), '[]'::json));
end;
$$;

-- ---------------------------------------------------------------------
-- Cenário: aprovar. p_revisao = atualizado_em do rascunho que o responsável viu; p_chave = chave de
-- idempotência (a mesma chave repetida devolve a mesma aprovação).
-- ---------------------------------------------------------------------
drop function if exists public.cenario_aprovar(uuid);
create or replace function public.cenario_aprovar(p_cenario uuid, p_revisao timestamptz default null, p_chave text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_cen public.busca_cenarios%rowtype;
  v_vit public.vitimas%rowtype;
  v_status text;
  v_soma numeric;
  v_detalhe text;
  v_par text;
begin
  select * into v_cen from public.busca_cenarios where id = p_cenario for update;
  if not found then
    raise exception 'cenario_versao_inexistente';
  end if;
  if v_nome is null or not public.dono_operacao(v_cen.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if v_cen.estado = 'aprovada' then
    -- repetição da mesma aprovação (mesma chave): devolve o resultado sem duplicar nada
    if p_chave is not null and v_cen.aprovacao_chave = p_chave then
      return json_build_object('cenario', row_to_json(v_cen), 'repetida', true,
        'setores', coalesce((select json_agg(row_to_json(s) order by s.setor_nome) from public.busca_cenario_setores s where s.cenario_id = v_cen.id), '[]'::json),
        'evidencias', coalesce((select json_agg(row_to_json(e) order by e.descricao) from public.busca_cenario_evidencias e where e.cenario_id = v_cen.id), '[]'::json));
    end if;
    raise exception 'cenario_imutavel_aprovado';
  end if;
  select status into v_status from public.operacoes where id = v_cen.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if exists (select 1 from public.vitima_localizacoes where vitima_id = v_cen.vitima_id) then
    raise exception 'cenario_vitima_localizada';
  end if;
  if p_revisao is not null and p_revisao <> v_cen.atualizado_em then
    raise exception 'cenario_versao_desatualizada';
  end if;
  if char_length(btrim(v_cen.justificativa)) < 10 then
    raise exception 'cenario_sem_justificativa';
  end if;
  select coalesce(sum(poa), 0) into v_soma from public.busca_cenario_setores where cenario_id = v_cen.id;
  if v_soma <= 0 then
    raise exception 'cenario_sem_setores';
  end if;
  v_par := public.busca_cenario_sobreposicao(v_cen.id);
  if v_par is not null then
    raise exception 'cenario_setores_sobrepostos';
  end if;

  update public.busca_cenarios
     set estado = 'aprovada', aprovada_em = now(), aprovada_por = auth.uid(), aprovada_por_nome = v_nome,
         aprovacao_chave = p_chave, horario_referencia = coalesce(horario_referencia, now()),
         atualizado_em = now(), atualizado_por_nome = v_nome
   where id = v_cen.id
   returning * into v_cen;

  select * into v_vit from public.vitimas where id = v_cen.vitima_id;
  select string_agg(s.setor_nome || ': ' || trim_scale(round(s.poa * 100, 1))::text || '%', ' · ' order by s.poa desc, s.setor_nome)
    into v_detalhe from public.busca_cenario_setores s where s.cenario_id = v_cen.id;
  perform public.diario_auto(v_cen.operacao_id, v_cen.aprovada_em, 'pessoa', 'cenario_aprovado',
    'Cenário de busca aprovado: ' || v_vit.nome || ' (versão ' || v_cen.numero || ')',
    'POA por setor — ' || coalesce(v_detalhe, '') || ' · fora dos setores: ' || trim_scale(round((1 - v_soma) * 100, 1))::text || '%. Justificativa: ' || v_cen.justificativa ||
      case when v_cen.hipoteses <> '' then ' Hipóteses: ' || v_cen.hipoteses else '' end ||
      case when v_cen.limitacoes <> '' then ' Limitações: ' || v_cen.limitacoes else '' end,
    'cenario:' || v_cen.id, 'info', null, null, v_cen.id::text, v_nome);

  return json_build_object('cenario', row_to_json(v_cen),
    'setores', coalesce((select json_agg(row_to_json(s) order by s.setor_nome) from public.busca_cenario_setores s where s.cenario_id = v_cen.id), '[]'::json),
    'evidencias', coalesce((select json_agg(row_to_json(e) order by e.descricao) from public.busca_cenario_evidencias e where e.cenario_id = v_cen.id), '[]'::json));
end;
$$;

-- ---------------------------------------------------------------------
-- Registro de busca (POD), versão do guia
--   p_dados: setor_id, finalidade ('pos_execucao' | 'planejada'), pod (0 a 1; nulo = NÃO ESTIMADA),
--            base_estimativa (em que se baseia, ou por que não foi estimada), origem_pod, metodo, missao_id,
--            alcance ('setor_inteiro' | 'parcial'), cobertura_fracao (0 a 1, só no parcial), observadores,
--            impedimentos, areas_nao_observadas, condicoes, equipe, grupo_id, vitima_id, inicio, fim, chave_cliente
-- ---------------------------------------------------------------------
create or replace function public.busca_registrar(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_status text;
  v_setor public.setores%rowtype;
  v_grupo public.grupos%rowtype;
  v_vit public.vitimas%rowtype;
  v_reg public.busca_registros%rowtype;
  v_setor_id uuid;
  v_grupo_id uuid;
  v_vit_id uuid;
  v_missao_id uuid;
  v_pod numeric;
  v_ini timestamptz;
  v_fim timestamptz;
  v_base text;
  v_cond text;
  v_equipe text;
  v_final text;
  v_origem text;
  v_metodo text;
  v_alcance text;
  v_cob numeric;
  v_obs smallint;
  v_imp text;
  v_nao_obs text;
  v_chave text;
  v_rotulo text;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  begin
    v_setor_id := (p_dados->>'setor_id')::uuid;
    v_pod := nullif(p_dados->>'pod', '')::numeric;
    v_grupo_id := nullif(p_dados->>'grupo_id', '')::uuid;
    v_vit_id := nullif(p_dados->>'vitima_id', '')::uuid;
    v_missao_id := nullif(p_dados->>'missao_id', '')::uuid;
    v_ini := nullif(p_dados->>'inicio', '')::timestamptz;
    v_fim := nullif(p_dados->>'fim', '')::timestamptz;
    v_cob := nullif(p_dados->>'cobertura_fracao', '')::numeric;
    v_obs := nullif(p_dados->>'observadores', '')::smallint;
  exception when others then
    raise exception 'dados_invalidos';
  end;
  v_final := coalesce(nullif(p_dados->>'finalidade', ''), 'pos_execucao');
  v_origem := coalesce(nullif(p_dados->>'origem_pod', ''), 'julgamento_comando');
  v_alcance := coalesce(nullif(p_dados->>'alcance', ''), 'setor_inteiro');
  v_chave := nullif(left(btrim(coalesce(p_dados->>'chave_cliente', '')), 80), '');
  -- não há catálogo de modelos de detecção validados: só julgamento do comando ou consenso documentado
  if v_final not in ('pos_execucao', 'planejada') or v_origem not in ('julgamento_comando', 'consenso_documentado')
     or v_alcance not in ('setor_inteiro', 'parcial') or (v_obs is not null and v_obs not between 1 and 500) then
    raise exception 'dados_invalidos';
  end if;
  if v_pod is not null and (v_pod < 0 or v_pod > 1) then
    raise exception 'busca_pod_invalido';
  end if;
  if v_final = 'planejada' and v_pod is null then
    raise exception 'busca_planejada_sem_pod';
  end if;
  if (v_alcance = 'parcial') <> (v_cob is not null) or (v_cob is not null and not (v_cob > 0 and v_cob < 1)) then
    raise exception 'busca_cobertura_invalida';
  end if;
  if v_ini is not null and v_fim is not null and v_fim < v_ini then
    raise exception 'dados_invalidos';
  end if;
  v_base := btrim(coalesce(p_dados->>'base_estimativa', ''));
  if char_length(v_base) < 5 then
    raise exception 'busca_sem_base_estimativa';
  end if;
  v_cond := left(btrim(coalesce(p_dados->>'condicoes', '')), 500);
  v_equipe := left(btrim(coalesce(p_dados->>'equipe', '')), 60);
  v_metodo := nullif(left(btrim(coalesce(p_dados->>'metodo', '')), 60), '');
  v_imp := left(btrim(coalesce(p_dados->>'impedimentos', '')), 500);
  v_nao_obs := left(btrim(coalesce(p_dados->>'areas_nao_observadas', '')), 500);

  -- repetição do mesmo envio (mesma chave): devolve o registro já gravado
  if v_chave is not null then
    select * into v_reg from public.busca_registros where operacao_id = p_operacao and chave_cliente = v_chave;
    if found then
      if v_reg.setor_id is distinct from v_setor_id or v_reg.pod is distinct from round(v_pod, 4) or v_reg.finalidade <> v_final then
        raise exception 'busca_chave_reutilizada';
      end if;
      return row_to_json(v_reg);
    end if;
  end if;

  select * into v_setor from public.setores where id = v_setor_id and operacao_id = p_operacao;
  if not found then
    raise exception 'setor_nao_encontrado';
  end if;
  if v_grupo_id is not null then
    select * into v_grupo from public.grupos where id = v_grupo_id and operacao_id = p_operacao;
    if not found then
      raise exception 'dados_invalidos';
    end if;
    if v_equipe = '' then v_equipe := left(v_grupo.nome, 60); end if;
  end if;
  if v_missao_id is not null and not exists (select 1 from public.missoes where id = v_missao_id and operacao_id = p_operacao) then
    raise exception 'dados_invalidos';
  end if;
  if v_vit_id is not null then
    select * into v_vit from public.vitimas where id = v_vit_id and operacao_id = p_operacao;
    if not found then
      raise exception 'vitima_nao_encontrada';
    end if;
  end if;

  insert into public.busca_registros (operacao_id, setor_id, setor_nome, vitima_id, grupo_id, equipe, inicio, fim,
                                      pod, base_estimativa, condicoes, registrado_por, registrado_por_nome,
                                      finalidade, origem_pod, metodo, missao_id, alcance, cobertura_fracao, observadores,
                                      impedimentos, areas_nao_observadas, chave_cliente)
  values (p_operacao, v_setor.id, v_setor.nome, v_vit.id, v_grupo.id, v_equipe, v_ini, v_fim,
          round(v_pod, 4), v_base, v_cond, auth.uid(), v_nome,
          v_final, v_origem, v_metodo, v_missao_id, v_alcance, round(v_cob, 4), v_obs, v_imp, v_nao_obs, v_chave)
  returning * into v_reg;

  v_rotulo := case when v_final = 'planejada' then 'Busca planejada' else 'Busca registrada' end;
  perform public.diario_auto(p_operacao, v_reg.registrado_em, 'setor', case when v_final = 'planejada' then 'busca_planejada' else 'busca_registrada' end,
    v_rotulo || ' em ' || v_setor.nome || ': ' ||
      case when v_reg.pod is null then 'POD não estimada' else 'POD ' || trim_scale(round(v_reg.pod * 100, 1))::text || '%' end ||
      case when v_alcance = 'parcial' then ' (em ' || trim_scale(round(v_reg.cobertura_fracao * 100, 1))::text || '% do setor)' else '' end,
    coalesce(nullif(v_equipe, ''), 'Equipe não informada') ||
      case when v_metodo is not null then ' · método: ' || v_metodo else '' end ||
      case when v_vit.id is not null then ' · vale para ' || v_vit.nome else ' · vale para todas as vítimas' end ||
      '. ' || case when v_reg.pod is null then 'Por que não foi estimada: ' else 'Base da estimativa: ' end || v_base ||
      case when v_cond <> '' then '. Condições: ' || v_cond else '' end ||
      case when v_imp <> '' then '. Impedimentos: ' || v_imp else '' end ||
      case when v_nao_obs <> '' then '. Áreas não observadas: ' || v_nao_obs else '' end,
    'busca:' || v_reg.id, 'info', null, null, v_reg.id::text, v_nome);

  return row_to_json(v_reg);
end;
$$;

-- anulação: o texto do diário passa a tratar POD não estimada
create or replace function public.busca_anular(p_registro uuid, p_motivo text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_reg public.busca_registros%rowtype;
  v_status text;
  v_motivo text := left(btrim(coalesce(p_motivo, '')), 500);
begin
  select * into v_reg from public.busca_registros where id = p_registro for update;
  if not found then
    raise exception 'busca_registro_inexistente';
  end if;
  if v_nome is null or not public.dono_operacao(v_reg.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_reg.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if v_reg.anulado_em is not null then
    raise exception 'busca_registro_ja_anulado';
  end if;
  if char_length(v_motivo) < 3 then
    raise exception 'busca_anulacao_sem_motivo';
  end if;
  update public.busca_registros
     set anulado_em = now(), anulado_por_nome = v_nome, anulado_motivo = v_motivo
   where id = v_reg.id
   returning * into v_reg;
  perform public.diario_auto(v_reg.operacao_id, v_reg.anulado_em, 'setor', 'busca_anulada',
    'Registro de busca anulado em ' || v_reg.setor_nome || ' (' ||
      case when v_reg.pod is null then 'POD não estimada' else 'POD ' || trim_scale(round(v_reg.pod * 100, 1))::text || '%' end || ')',
    'Motivo: ' || v_motivo, 'busca_anulada:' || v_reg.id, 'info', null, null, v_reg.id::text, v_nome);
  return row_to_json(v_reg);
end;
$$;

revoke execute on function public.cenario_salvar_rascunho(uuid, jsonb), public.cenario_aprovar(uuid, timestamptz, text),
  public.busca_registrar(uuid, jsonb), public.busca_anular(uuid, text) from public, anon;
grant execute on function public.cenario_salvar_rascunho(uuid, jsonb), public.cenario_aprovar(uuid, timestamptz, text),
  public.busca_registrar(uuid, jsonb), public.busca_anular(uuid, text) to authenticated;

-- =====================================================================
-- 41. Pedidos de ajuda com fluxo completo (migração 035 — idempotente; exige a 010, a 012, a 026 e a 032)
--
--  Todo pedido de ajuda (botão "Preciso de ajuda" do participante ou resposta "PRECISO DE AJUDA" a um
--  comando) vira um PEDIDO (pedidos_ajuda) com estados: recebido → assumido → equipe_enviada →
--  em_atendimento → resolvido. "Lido" ou "ciente" (mensagens.lida_em, alertas.reconhecido_em) NÃO muda o
--  estado: só resolver resolve, e resolver exige tipo e justificativa. O estado é do servidor (vale para
--  todos os responsáveis; antes, "atendido" era só uma marca local no navegador de cada um).
--    • prioridade (crítica, alta, média, baixa); baixar a prioridade exige justificativa;
--    • assumir (e reassumir), enviar equipe (grupo), iniciar atendimento, anotar, resolver e reabrir;
--    • histórico (pedido_ajuda_eventos) só acrescenta; reabrir não apaga a resolução anterior;
--    • tempo sem atendimento e ESCALAÇÃO: sem ninguém assumir (ou parado em outro estado) além do prazo da
--      prioridade, gera alerta crítico (com alarme no painel) e novo alerta a cada novo prazo;
--    • o participante vê só o estado do próprio pedido (meu_pedido_ajuda).
--  Leitura só pelos responsáveis da operação (RLS); escrita só pelas funções abaixo. Passos entram no diário.
-- =====================================================================
create table if not exists public.pedidos_ajuda (
  id                      uuid primary key default gen_random_uuid(),
  operacao_id             uuid not null references public.operacoes(id) on delete cascade,
  participante_id         uuid references public.participantes(id) on delete set null,
  participante_nome       text not null,
  mensagem_id             uuid unique references public.mensagens(id) on delete set null,
  origem                  text not null check (origem in ('botao', 'resposta')),
  texto                   text not null default '' check (char_length(texto) <= 500),
  lat                     double precision,
  lng                     double precision,
  precisao                real,
  posicao_em              timestamptz,
  recebido_em             timestamptz not null default now(),
  prioridade              text not null default 'alta' check (prioridade in ('critica', 'alta', 'media', 'baixa')),
  estado                  text not null default 'recebido' check (estado in ('recebido', 'assumido', 'equipe_enviada', 'em_atendimento', 'resolvido')),
  estado_em               timestamptz not null default now(),
  assumido_por            uuid references auth.users(id) on delete set null,
  assumido_por_nome       text,
  assumido_em             timestamptz,
  equipe_grupo_id         uuid references public.grupos(id) on delete set null,
  equipe_nome             text,
  equipe_enviada_em       timestamptz,
  atendimento_iniciado_em timestamptz,
  resolvido_em            timestamptz,
  resolvido_por_nome      text,
  resolucao               text check (resolucao in ('atendido', 'sem_necessidade', 'falso_alarme', 'encaminhado', 'outro')),
  resolucao_texto         text check (resolucao_texto is null or char_length(resolucao_texto) <= 1000),
  escalonamentos          integer not null default 0,
  escalonado_em           timestamptz,
  atualizado_em           timestamptz not null default now(),
  constraint pedidos_ajuda_resolvido_ok check (
    (estado = 'resolvido') = (resolvido_em is not null) and (estado = 'resolvido') = (resolucao is not null))
);
create index if not exists pedidos_ajuda_operacao_idx on public.pedidos_ajuda (operacao_id, recebido_em desc);
create index if not exists pedidos_ajuda_abertos_idx on public.pedidos_ajuda (operacao_id) where estado <> 'resolvido';
create index if not exists pedidos_ajuda_participante_idx on public.pedidos_ajuda (participante_id, recebido_em desc);

create table if not exists public.pedido_ajuda_eventos (
  id          bigint generated always as identity primary key,
  pedido_id   uuid not null references public.pedidos_ajuda(id) on delete cascade,
  operacao_id uuid not null references public.operacoes(id) on delete cascade,
  em          timestamptz not null default now(),
  tipo        text not null check (tipo in ('recebido', 'assumido', 'prioridade', 'equipe_enviada', 'em_atendimento', 'resolvido', 'reaberto', 'escalado', 'nota')),
  por_nome    text not null default 'Sistema',
  detalhe     text not null default '' check (char_length(detalhe) <= 1500),
  dados       jsonb not null default '{}'::jsonb
);
create index if not exists pedido_ajuda_eventos_idx on public.pedido_ajuda_eventos (pedido_id, id);

alter table public.pedidos_ajuda enable row level security;
alter table public.pedido_ajuda_eventos enable row level security;
drop policy if exists pedidos_ajuda_ler on public.pedidos_ajuda;
create policy pedidos_ajuda_ler on public.pedidos_ajuda for select to authenticated using (public.dono_operacao(operacao_id));
drop policy if exists pedido_ajuda_eventos_ler on public.pedido_ajuda_eventos;
create policy pedido_ajuda_eventos_ler on public.pedido_ajuda_eventos for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.pedidos_ajuda, public.pedido_ajuda_eventos from anon;
revoke insert, update, delete, truncate on public.pedidos_ajuda, public.pedido_ajuda_eventos from authenticated;
grant select on public.pedidos_ajuda, public.pedido_ajuda_eventos to authenticated;

-- O histórico só acrescenta: nada se altera nem se apaga (só a exclusão em cascata da operação)
create or replace function public.pedido_ajuda_eventos_proteger()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'pedido_historico_imutavel';
end;
$$;
drop trigger if exists pedido_ajuda_eventos_proteger on public.pedido_ajuda_eventos;
create trigger pedido_ajuda_eventos_proteger before update or delete on public.pedido_ajuda_eventos
  for each row execute function public.pedido_ajuda_eventos_proteger();

-- Alertas: novo tipo para a escalação (e o diário o trata como alerta)
alter table public.alertas drop constraint if exists alertas_tipo_check;
alter table public.alertas add constraint alertas_tipo_check
  check (tipo in ('deslocamento_iniciado', 'chegou_setor', 'busca_finalizada', 'chegou_base', 'retorno_atrasado',
                  'vitima_localizada', 'permanencia_setor',
                  'inicio_atrasado', 'prazo_atrasado', 'sem_comunicacao', 'comunicacao_restabelecida',
                  'ajuda_sem_atendimento'));

create or replace function public.diario_de_alerta()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.tipo = 'vitima_localizada' then
      return new;
    end if;
    -- sem comunicação: o horário do registro é o da detecção (a posição guardada é a última conhecida)
    perform public.diario_auto(new.operacao_id, case when new.tipo = 'sem_comunicacao' then new.criado_em else coalesce(new.posicao_em, new.criado_em) end,
      case new.tipo when 'chegou_setor' then 'chegada' when 'chegou_base' then 'chegada'
                    when 'retorno_atrasado' then 'alerta' when 'permanencia_setor' then 'alerta'
                    when 'inicio_atrasado' then 'alerta' when 'prazo_atrasado' then 'alerta' when 'sem_comunicacao' then 'alerta'
                    when 'ajuda_sem_atendimento' then 'alerta'
                    else 'deslocamento' end,
      'alerta_' || new.tipo, new.titulo, new.texto, 'alerta:' || new.id, new.nivel, new.lat, new.lng, new.id::text, 'Sistema');
  elsif new.nivel = 'critico' and old.reconhecido_em is null and new.reconhecido_em is not null then
    perform public.diario_auto(new.operacao_id, new.reconhecido_em, 'alerta', 'alerta_ciente',
      'Ciente do alerta: ' || new.titulo, '', 'alerta_ciente:' || new.id, 'info', null, null, new.id::text, new.reconhecido_por_nome);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Rótulos e ordem dos estados (uso interno)
-- ---------------------------------------------------------------------
create or replace function public.pedido_ajuda_ordem(p_estado text)
returns integer
language sql immutable
as $$ select case p_estado when 'recebido' then 1 when 'assumido' then 2 when 'equipe_enviada' then 3 when 'em_atendimento' then 4 when 'resolvido' then 5 end; $$;

-- Registra um passo no histórico e no diário (uso interno)
create or replace function public.pedido_ajuda_evento(p_pedido uuid, p_tipo text, p_por text, p_detalhe text, p_dados jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_p public.pedidos_ajuda%rowtype;
  v_id bigint;
begin
  select * into v_p from public.pedidos_ajuda where id = p_pedido;
  if not found then return; end if;
  insert into public.pedido_ajuda_eventos (pedido_id, operacao_id, tipo, por_nome, detalhe, dados)
  values (p_pedido, v_p.operacao_id, p_tipo, coalesce(nullif(btrim(p_por), ''), 'Sistema'), left(coalesce(p_detalhe, ''), 1500), coalesce(p_dados, '{}'::jsonb))
  returning id into v_id;
  perform public.diario_auto(v_p.operacao_id, now(), 'alerta', 'pedido_ajuda_' || p_tipo,
    'Pedido de ajuda (' || v_p.participante_nome || '): ' ||
      case p_tipo when 'recebido' then 'recebido' when 'assumido' then 'assumido' when 'prioridade' then 'prioridade alterada'
                  when 'equipe_enviada' then 'equipe enviada' when 'em_atendimento' then 'atendimento iniciado' when 'resolvido' then 'resolvido'
                  when 'reaberto' then 'reaberto' when 'escalado' then 'ESCALADO' else 'anotação' end,
    coalesce(p_detalhe, ''), 'pedido:' || p_pedido || ':' || v_id, case when p_tipo = 'escalado' then 'critico' else 'info' end,
    v_p.lat, v_p.lng, p_pedido::text, coalesce(nullif(btrim(p_por), ''), 'Sistema'));
end;
$$;

-- Cria o pedido quando a mensagem de ajuda chega (botão do participante) ou quando a resposta
-- "PRECISO DE AJUDA" a um comando é registrada.
create or replace function public.criar_pedido_ajuda_de_mensagem()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_origem text;
  v_nome text;
  v_id uuid;
begin
  if tg_op = 'INSERT' then
    if new.direcao = 'entrada' and new.categoria = 'AJUDA' then v_origem := 'botao'; end if;
  elsif new.resposta = 'PRECISO_AJUDA' and old.resposta is distinct from 'PRECISO_AJUDA' then
    v_origem := 'resposta';
  end if;
  if v_origem is null then
    return new;
  end if;
  select nome into v_nome from public.participantes where id = new.participante_id;
  insert into public.pedidos_ajuda (operacao_id, participante_id, participante_nome, mensagem_id, origem, texto, lat, lng, precisao, posicao_em)
  values (new.operacao_id, new.participante_id, coalesce(v_nome, new.remetente_nome, 'Participante'), new.id, v_origem,
          case when v_origem = 'resposta' then 'Respondeu "preciso de ajuda" ao comando: ' || coalesce(new.texto, '') else coalesce(new.texto, '') end,
          new.lat, new.lng, new.precisao, new.posicao_em)
  on conflict (mensagem_id) do nothing
  returning id into v_id;
  if v_id is not null then
    perform public.pedido_ajuda_evento(v_id, 'recebido', 'Sistema',
      case v_origem when 'botao' then 'Pelo botão "Preciso de ajuda"' else 'Resposta "preciso de ajuda" a um comando' end ||
        case when new.lat is null then ' (sem localização).' else ' (com localização).' end);
  end if;
  return new;
end;
$$;
drop trigger if exists criar_pedido_ajuda_de_mensagem on public.mensagens;
create trigger criar_pedido_ajuda_de_mensagem after insert or update of resposta on public.mensagens
  for each row execute function public.criar_pedido_ajuda_de_mensagem();

-- (o gatilho de operação encerrada é recriado depois da carga inicial: a carga também cobre operações já encerradas)
drop trigger if exists pedidos_ajuda_encerrada on public.pedidos_ajuda;
drop trigger if exists pedido_ajuda_eventos_encerrada on public.pedido_ajuda_eventos;
-- Pedidos que já existiam (antes deste fluxo): em operação encerrada ou com mais de 24 h, entram como resolvidos
-- (registro anterior ao fluxo); os recentes de operação ativa entram como "recebido" para alguém assumir.
insert into public.pedidos_ajuda (operacao_id, participante_id, participante_nome, mensagem_id, origem, texto, lat, lng, precisao, posicao_em, recebido_em,
                                  estado, estado_em, resolvido_em, resolvido_por_nome, resolucao, resolucao_texto)
select m.operacao_id, m.participante_id, coalesce(p.nome, m.remetente_nome, 'Participante'), m.id,
       case when m.direcao = 'entrada' then 'botao' else 'resposta' end,
       case when m.direcao = 'entrada' then coalesce(m.texto, '') else 'Respondeu "preciso de ajuda" ao comando: ' || coalesce(m.texto, '') end,
       m.lat, m.lng, m.precisao, m.posicao_em, coalesce(m.criada_em, now()),
       case when o.status <> 'ativa' or m.criada_em < now() - interval '24 hours' then 'resolvido' else 'recebido' end,
       now(),
       case when o.status <> 'ativa' or m.criada_em < now() - interval '24 hours' then now() end,
       case when o.status <> 'ativa' or m.criada_em < now() - interval '24 hours' then 'Sistema' end,
       case when o.status <> 'ativa' or m.criada_em < now() - interval '24 hours' then 'outro' end,
       case when o.status <> 'ativa' or m.criada_em < now() - interval '24 hours' then 'Registro anterior ao fluxo de pedidos de ajuda: situação não registrada.' end
  from public.mensagens m
  join public.operacoes o on o.id = m.operacao_id
  left join public.participantes p on p.id = m.participante_id
 where ((m.direcao = 'entrada' and m.categoria = 'AJUDA') or m.resposta = 'PRECISO_AJUDA')
   and not exists (select 1 from public.pedidos_ajuda x where x.mensagem_id = m.id)
on conflict (mensagem_id) do nothing;

-- Operação encerrada: somente leitura (o mesmo gatilho da 026)
do $$
declare
  t text;
begin
  foreach t in array array['pedidos_ajuda', 'pedido_ajuda_eventos'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_encerrada', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.bloquear_escrita_encerrada()',
                   t || '_encerrada', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Ações dos responsáveis
-- ---------------------------------------------------------------------
create or replace function public.pedido_ajuda_para_alterar(p_pedido uuid)
returns public.pedidos_ajuda
language plpgsql security definer set search_path = public
as $$
declare
  v_p public.pedidos_ajuda%rowtype;
  v_status text;
begin
  select * into v_p from public.pedidos_ajuda where id = p_pedido for update;
  if not found then
    raise exception 'pedido_inexistente';
  end if;
  if public.nome_responsavel_atual() is null or not public.dono_operacao(v_p.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_p.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  return v_p;
end;
$$;

create or replace function public.pedido_ajuda_assumir(p_pedido uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_p public.pedidos_ajuda%rowtype;
  v_anterior text;
begin
  v_p := public.pedido_ajuda_para_alterar(p_pedido);
  if v_p.estado = 'resolvido' then raise exception 'pedido_ja_resolvido'; end if;
  v_anterior := v_p.assumido_por_nome;
  update public.pedidos_ajuda
     set assumido_por = auth.uid(), assumido_por_nome = v_nome, assumido_em = coalesce(assumido_em, now()),
         estado = case when estado = 'recebido' then 'assumido' else estado end,
         estado_em = case when estado = 'recebido' then now() else estado_em end,
         atualizado_em = now()
   where id = p_pedido returning * into v_p;
  perform public.pedido_ajuda_evento(p_pedido, 'assumido', v_nome,
    case when v_anterior is null then v_nome || ' assumiu o pedido.' else v_nome || ' assumiu o pedido (antes: ' || v_anterior || ').' end,
    jsonb_build_object('anterior', v_anterior));
  return row_to_json(v_p);
end;
$$;

create or replace function public.pedido_ajuda_prioridade(p_pedido uuid, p_prioridade text, p_justificativa text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_p public.pedidos_ajuda%rowtype;
  v_just text := left(btrim(coalesce(p_justificativa, '')), 500);
  v_novo integer;
  v_atual integer;
begin
  if p_prioridade is null or p_prioridade not in ('critica', 'alta', 'media', 'baixa') then
    raise exception 'pedido_prioridade_invalida';
  end if;
  v_p := public.pedido_ajuda_para_alterar(p_pedido);
  if v_p.estado = 'resolvido' then raise exception 'pedido_ja_resolvido'; end if;
  if v_p.prioridade = p_prioridade then
    return row_to_json(v_p);
  end if;
  -- baixar a prioridade precisa de justificativa (subir não)
  v_novo := case p_prioridade when 'critica' then 4 when 'alta' then 3 when 'media' then 2 else 1 end;
  v_atual := case v_p.prioridade when 'critica' then 4 when 'alta' then 3 when 'media' then 2 else 1 end;
  if v_novo < v_atual and char_length(v_just) < 5 then
    raise exception 'pedido_justificativa_obrigatoria';
  end if;
  update public.pedidos_ajuda set prioridade = p_prioridade, atualizado_em = now() where id = p_pedido returning * into v_p;
  perform public.pedido_ajuda_evento(p_pedido, 'prioridade', v_nome,
    'Prioridade: ' || p_prioridade || case when v_just <> '' then '. ' || v_just else '' end,
    jsonb_build_object('para', p_prioridade, 'justificativa', nullif(v_just, '')));
  return row_to_json(v_p);
end;
$$;

create or replace function public.pedido_ajuda_enviar_equipe(p_pedido uuid, p_grupo uuid, p_nota text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_p public.pedidos_ajuda%rowtype;
  v_g public.grupos%rowtype;
  v_nota text := left(btrim(coalesce(p_nota, '')), 500);
begin
  v_p := public.pedido_ajuda_para_alterar(p_pedido);
  if v_p.estado = 'resolvido' then raise exception 'pedido_ja_resolvido'; end if;
  select * into v_g from public.grupos where id = p_grupo and operacao_id = v_p.operacao_id;
  if not found then
    raise exception 'pedido_equipe_invalida';
  end if;
  update public.pedidos_ajuda
     set equipe_grupo_id = v_g.id, equipe_nome = v_g.nome, equipe_enviada_em = now(),
         assumido_por = coalesce(assumido_por, auth.uid()), assumido_por_nome = coalesce(assumido_por_nome, v_nome), assumido_em = coalesce(assumido_em, now()),
         estado = case when public.pedido_ajuda_ordem(estado) < 3 then 'equipe_enviada' else estado end,
         estado_em = case when public.pedido_ajuda_ordem(estado) < 3 then now() else estado_em end,
         atualizado_em = now()
   where id = p_pedido returning * into v_p;
  perform public.pedido_ajuda_evento(p_pedido, 'equipe_enviada', v_nome, 'Equipe ' || v_g.nome || ' enviada' || case when v_nota <> '' then '. ' || v_nota else '.' end,
    jsonb_build_object('grupo_id', v_g.id, 'equipe', v_g.nome));
  return row_to_json(v_p);
end;
$$;

create or replace function public.pedido_ajuda_iniciar_atendimento(p_pedido uuid, p_nota text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_p public.pedidos_ajuda%rowtype;
  v_nota text := left(btrim(coalesce(p_nota, '')), 500);
begin
  v_p := public.pedido_ajuda_para_alterar(p_pedido);
  if v_p.estado = 'resolvido' then raise exception 'pedido_ja_resolvido'; end if;
  if v_p.estado = 'em_atendimento' then
    return row_to_json(v_p);
  end if;
  update public.pedidos_ajuda
     set estado = 'em_atendimento', estado_em = now(), atendimento_iniciado_em = now(),
         assumido_por = coalesce(assumido_por, auth.uid()), assumido_por_nome = coalesce(assumido_por_nome, v_nome), assumido_em = coalesce(assumido_em, now()),
         atualizado_em = now()
   where id = p_pedido returning * into v_p;
  perform public.pedido_ajuda_evento(p_pedido, 'em_atendimento', v_nome, 'Atendimento iniciado' || case when v_nota <> '' then '. ' || v_nota else '.' end);
  return row_to_json(v_p);
end;
$$;

create or replace function public.pedido_ajuda_nota(p_pedido uuid, p_texto text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_p public.pedidos_ajuda%rowtype;
  v_texto text := left(btrim(coalesce(p_texto, '')), 1000);
begin
  v_p := public.pedido_ajuda_para_alterar(p_pedido);
  if char_length(v_texto) < 2 then
    raise exception 'dados_invalidos';
  end if;
  perform public.pedido_ajuda_evento(p_pedido, 'nota', v_nome, v_texto);
  update public.pedidos_ajuda set atualizado_em = now() where id = p_pedido returning * into v_p;
  return row_to_json(v_p);
end;
$$;

-- Resolver exige o tipo e a justificativa (mín. 5 caracteres). "Ciente" não resolve.
create or replace function public.pedido_ajuda_resolver(p_pedido uuid, p_resolucao text, p_texto text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_p public.pedidos_ajuda%rowtype;
  v_texto text := left(btrim(coalesce(p_texto, '')), 1000);
begin
  if p_resolucao is null or p_resolucao not in ('atendido', 'sem_necessidade', 'falso_alarme', 'encaminhado', 'outro') then
    raise exception 'pedido_resolucao_invalida';
  end if;
  v_p := public.pedido_ajuda_para_alterar(p_pedido);
  if v_p.estado = 'resolvido' then raise exception 'pedido_ja_resolvido'; end if;
  if char_length(v_texto) < 5 then
    raise exception 'pedido_resolucao_sem_texto';
  end if;
  update public.pedidos_ajuda
     set estado = 'resolvido', estado_em = now(), resolvido_em = now(), resolvido_por_nome = v_nome, resolucao = p_resolucao, resolucao_texto = v_texto,
         assumido_por = coalesce(assumido_por, auth.uid()), assumido_por_nome = coalesce(assumido_por_nome, v_nome), assumido_em = coalesce(assumido_em, now()),
         atualizado_em = now()
   where id = p_pedido returning * into v_p;
  perform public.pedido_ajuda_evento(p_pedido, 'resolvido', v_nome, 'Resolvido (' || p_resolucao || '): ' || v_texto,
    jsonb_build_object('resolucao', p_resolucao, 'texto', v_texto));
  return row_to_json(v_p);
end;
$$;

-- Reabrir: volta para "assumido" por quem reabre. A resolução anterior continua no histórico.
create or replace function public.pedido_ajuda_reabrir(p_pedido uuid, p_motivo text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_p public.pedidos_ajuda%rowtype;
  v_motivo text := left(btrim(coalesce(p_motivo, '')), 500);
  v_ant jsonb;
begin
  v_p := public.pedido_ajuda_para_alterar(p_pedido);
  if v_p.estado <> 'resolvido' then raise exception 'pedido_nao_resolvido'; end if;
  if char_length(v_motivo) < 5 then
    raise exception 'pedido_resolucao_sem_texto';
  end if;
  v_ant := jsonb_build_object('resolucao', v_p.resolucao, 'texto', v_p.resolucao_texto, 'por', v_p.resolvido_por_nome, 'em', v_p.resolvido_em);
  update public.pedidos_ajuda
     set estado = 'assumido', estado_em = now(), resolvido_em = null, resolvido_por_nome = null, resolucao = null, resolucao_texto = null,
         assumido_por = auth.uid(), assumido_por_nome = v_nome, atualizado_em = now(), escalonamentos = 0
   where id = p_pedido returning * into v_p;
  perform public.pedido_ajuda_evento(p_pedido, 'reaberto', v_nome, 'Reaberto: ' || v_motivo, jsonb_build_object('resolucao_anterior', v_ant));
  return row_to_json(v_p);
end;
$$;

-- ---------------------------------------------------------------------
-- Escalação: pedido sem atendimento além do prazo da prioridade gera alerta crítico (alarme no painel), de novo a cada novo prazo.
--   prazo base (min): crítica 2 · alta 3 · média 8 · baixa 15.  recebido = 1× o prazo; assumido = 3×; equipe enviada = 4×.
--   Em atendimento não escala. Chamada pelo agendador (pg_cron, a cada minuto) e pelo painel aberto.
-- ---------------------------------------------------------------------
create or replace function public.verificar_pedidos_ajuda(p_operacao uuid default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_p public.pedidos_ajuda%rowtype;
  v_base integer;
  v_fator integer;
  v_min double precision;
  v_nivel integer;
  v_qtd integer := 0;
  v_titulo text;
  v_texto text;
begin
  if p_operacao is null then
    if auth.uid() is not null then
      raise exception 'sem_permissao';
    end if;
  elsif not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  for v_p in
    select p.* from public.pedidos_ajuda p join public.operacoes o on o.id = p.operacao_id
     where p.estado in ('recebido', 'assumido', 'equipe_enviada') and o.status = 'ativa'
       and (p_operacao is null or p.operacao_id = p_operacao)
     order by p.recebido_em
  loop
    v_base := case v_p.prioridade when 'critica' then 2 when 'alta' then 3 when 'media' then 8 else 15 end;
    v_fator := case v_p.estado when 'recebido' then 1 when 'assumido' then 3 else 4 end;
    v_min := extract(epoch from now() - v_p.estado_em) / 60;
    v_nivel := floor(v_min / (v_base * v_fator));
    if v_nivel < 1 then continue; end if;
    v_titulo := case when v_p.estado = 'recebido' then 'PEDIDO DE AJUDA SEM ATENDIMENTO — ' else 'PEDIDO DE AJUDA PARADO — ' end || v_p.participante_nome;
    v_texto := 'Prioridade ' || v_p.prioridade || '. ' ||
      case v_p.estado when 'recebido' then 'Ninguém assumiu o pedido há ' when 'assumido' then 'Assumido por ' || coalesce(v_p.assumido_por_nome, '—') || ', sem equipe enviada há '
                      else 'Equipe ' || coalesce(v_p.equipe_nome, '—') || ' enviada, atendimento não iniciado há ' end ||
      floor(v_min)::integer || ' min (escalação ' || v_nivel || '). Abra "Pedidos de ajuda" para assumir ou resolver.';
    if public.criar_alerta(v_p.operacao_id, 'ajuda_sem_atendimento', 'critico', v_titulo, v_texto,
         'ajuda:' || v_p.id || ':' || v_p.estado || ':' || v_nivel, null, v_p.equipe_grupo_id, v_p.participante_id, v_p.lat, v_p.lng, v_p.posicao_em) then
      update public.pedidos_ajuda set escalonamentos = escalonamentos + 1, escalonado_em = now() where id = v_p.id;
      perform public.pedido_ajuda_evento(v_p.id, 'escalado', 'Sistema', v_texto, jsonb_build_object('nivel', v_nivel, 'estado', v_p.estado));
      v_qtd := v_qtd + 1;
    end if;
  end loop;
  return v_qtd;
end;
$$;

-- O participante vê só o estado do PRÓPRIO pedido mais recente (nada de nomes de outros ou do histórico)
create or replace function public.meu_pedido_ajuda(p_participante uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_p public.pedidos_ajuda%rowtype;
begin
  if not exists (select 1 from public.participantes where id = p_participante and user_id = auth.uid()) then
    raise exception 'participante_invalido';
  end if;
  select * into v_p from public.pedidos_ajuda where participante_id = p_participante order by recebido_em desc limit 1;
  if not found then
    return null;
  end if;
  return json_build_object('estado', v_p.estado, 'recebido_em', v_p.recebido_em, 'estado_em', v_p.estado_em,
                           'equipe', v_p.equipe_nome, 'assumido', v_p.assumido_por_nome is not null, 'resolvido_em', v_p.resolvido_em);
end;
$$;

revoke execute on function public.pedido_ajuda_ordem(text), public.pedido_ajuda_evento(uuid, text, text, text, jsonb),
  public.pedido_ajuda_para_alterar(uuid), public.criar_pedido_ajuda_de_mensagem(), public.pedido_ajuda_eventos_proteger() from public, anon, authenticated;
revoke execute on function public.pedido_ajuda_assumir(uuid), public.pedido_ajuda_prioridade(uuid, text, text), public.pedido_ajuda_enviar_equipe(uuid, uuid, text),
  public.pedido_ajuda_iniciar_atendimento(uuid, text), public.pedido_ajuda_nota(uuid, text), public.pedido_ajuda_resolver(uuid, text, text),
  public.pedido_ajuda_reabrir(uuid, text), public.verificar_pedidos_ajuda(uuid), public.meu_pedido_ajuda(uuid) from public, anon;
grant execute on function public.pedido_ajuda_assumir(uuid), public.pedido_ajuda_prioridade(uuid, text, text), public.pedido_ajuda_enviar_equipe(uuid, uuid, text),
  public.pedido_ajuda_iniciar_atendimento(uuid, text), public.pedido_ajuda_nota(uuid, text), public.pedido_ajuda_resolver(uuid, text, text),
  public.pedido_ajuda_reabrir(uuid, text), public.verificar_pedidos_ajuda(uuid), public.meu_pedido_ajuda(uuid) to authenticated;

-- Agendador: a cada minuto, como o dos retornos (se houver pg_cron)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('gbs-verificar-ajuda');
    exception when others then
      null;   -- ainda não estava agendado
    end;
    perform cron.schedule('gbs-verificar-ajuda', '* * * * *', 'select public.verificar_pedidos_ajuda()');
  end if;
exception when others then
  raise warning 'pg_cron: não foi possível agendar gbs-verificar-ajuda: %', sqlerrm;
end;
$$;

-- Tempo real: o painel recebe os pedidos e o histórico
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['pedidos_ajuda', 'pedido_ajuda_eventos'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end;
$$;

-- =====================================================================
-- 42. Recursos e disponibilidade das equipes (migração 036 — idempotente; exige a 008, a 012 e a 026)
--
--  Cada equipe (grupo) passa a ter:
--    • disponibilidade informada pelo comando: disponivel, em_descanso ou indisponivel (com observação e,
--      se souber, a hora em que volta a ficar disponível). "Em missão" não é digitado: o painel deduz do
--      deslocamento ativo (missões), para nunca ficar desatualizado;
--    • capacidades (texto livre: mergulho, APH avançado, busca em altura…);
--    • recursos (grupo_recursos): embarcação, viatura, drone, cão de busca, equipamento de comunicação,
--      primeiros socorros ou outro, cada um com identificação, quantidade e situação
--      (operacional, limitado, indisponivel).
--  salvar_recursos_grupo grava tudo de uma vez (substitui a lista de recursos) e registra no diário.
--  Leitura dos recursos só pelos responsáveis da operação; escrita só pela função. Encerrada: somente leitura.
-- =====================================================================
alter table public.grupos add column if not exists disponibilidade text not null default 'disponivel';
alter table public.grupos add column if not exists disponibilidade_obs text not null default '';
alter table public.grupos add column if not exists disponivel_em timestamptz;
alter table public.grupos add column if not exists capacidades text not null default '';
alter table public.grupos add column if not exists recursos_atualizado_em timestamptz;
alter table public.grupos add column if not exists recursos_atualizado_por_nome text;
do $$
begin
  alter table public.grupos add constraint grupos_disponibilidade_ok check (
    disponibilidade in ('disponivel', 'em_descanso', 'indisponivel')
    and char_length(disponibilidade_obs) <= 200 and char_length(capacidades) <= 300);
exception when duplicate_object then null;
end;
$$;

create table if not exists public.grupo_recursos (
  id             uuid primary key default gen_random_uuid(),
  grupo_id       uuid not null references public.grupos(id) on delete cascade,
  operacao_id    uuid not null references public.operacoes(id) on delete cascade,
  tipo           text not null check (tipo in ('embarcacao', 'viatura', 'drone', 'cao_busca', 'comunicacao', 'primeiros_socorros', 'outro')),
  identificacao  text not null default '' check (char_length(identificacao) <= 60),
  quantidade     integer not null default 1 check (quantidade between 1 and 99),
  situacao       text not null default 'operacional' check (situacao in ('operacional', 'limitado', 'indisponivel')),
  observacao     text not null default '' check (char_length(observacao) <= 200),
  criado_em      timestamptz not null default now()
);
create index if not exists grupo_recursos_grupo_idx on public.grupo_recursos (grupo_id);
create index if not exists grupo_recursos_operacao_idx on public.grupo_recursos (operacao_id);

alter table public.grupo_recursos enable row level security;
drop policy if exists grupo_recursos_ler on public.grupo_recursos;
create policy grupo_recursos_ler on public.grupo_recursos for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.grupo_recursos from anon;
revoke insert, update, delete, truncate on public.grupo_recursos from authenticated;
grant select on public.grupo_recursos to authenticated;

drop trigger if exists grupo_recursos_encerrada on public.grupo_recursos;
create trigger grupo_recursos_encerrada before insert or update or delete on public.grupo_recursos
  for each row execute function public.bloquear_escrita_encerrada();

-- salvar_grupo copia uma linha inteira (select v.*): as colunas novas precisam de valor inicial, senão entram nulas.
-- (mesma função da migração 008, só com os valores iniciais de disponibilidade e capacidades)
create or replace function public.salvar_grupo(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v public.grupos%rowtype;
  v_op public.operacoes%rowtype;
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
    v.cor := '#f59e0b';
    v.permite_militar := false;
    v.disponibilidade := 'disponivel';
    v.disponibilidade_obs := '';
    v.capacidades := '';
    v.criado_por := auth.uid();
    v.criado_por_nome := v_nome_resp;
    v.criado_em := now();
  else
    select * into v from public.grupos where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'grupo_nao_encontrado';
    end if;
  end if;

  if p_dados ? 'nome' then v.nome := btrim(regexp_replace(coalesce(p_dados->>'nome', ''), '\s+', ' ', 'g')); end if;
  if p_dados ? 'cor' then v.cor := p_dados->>'cor'; end if;
  if p_dados ? 'permite_militar' then
    if jsonb_typeof(p_dados->'permite_militar') <> 'boolean' then
      raise exception 'dados_invalidos';
    end if;
    v.permite_militar := (p_dados->>'permite_militar')::boolean;
  end if;
  if v.nome is null or char_length(v.nome) not between 1 and 60 then
    raise exception 'nome_grupo_invalido';
  end if;
  if v.cor is null or v.cor !~ '^#[0-9a-fA-F]{6}$' then
    raise exception 'dados_invalidos';
  end if;

  v.atualizado_em := now();
  v.atualizado_por_nome := v_nome_resp;
  begin
    if p_id is null then
      insert into public.grupos select v.*;
      insert into public.grupo_convites (grupo_id, operacao_id, token, criado_por_nome)
      values (v.id, v.operacao_id, public.gerar_token(), v_nome_resp);
    else
      update public.grupos set nome = v.nome, cor = v.cor, permite_militar = v.permite_militar,
             atualizado_em = v.atualizado_em, atualizado_por_nome = v.atualizado_por_nome
       where id = v.id;
    end if;
  exception when unique_violation then
    raise exception 'grupo_existente';
  end;
  return row_to_json(v);
end;
$$;

-- Rótulos para o diário (uso interno)
create or replace function public.recurso_rotulo(p_tipo text)
returns text
language sql immutable
as $$
  select case p_tipo when 'embarcacao' then 'embarcação' when 'viatura' then 'viatura' when 'drone' then 'drone'
                     when 'cao_busca' then 'cão de busca' when 'comunicacao' then 'equipamento de comunicação'
                     when 'primeiros_socorros' then 'primeiros socorros' else 'outro recurso' end;
$$;

-- p_dados: disponibilidade ('disponivel' | 'em_descanso' | 'indisponivel'), disponibilidade_obs, disponivel_em (hora ou nulo),
--          capacidades, recursos [{ tipo, identificacao, quantidade, situacao, observacao }] (até 30). Só as chaves enviadas mudam
--          (se "recursos" vier, a lista inteira é substituída).
create or replace function public.salvar_recursos_grupo(p_grupo uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_g public.grupos%rowtype;
  v_status text;
  v_disp text;
  v_obs text;
  v_cap text;
  v_volta timestamptz;
  v_rec jsonb;
  v_it jsonb;
  v_tipo text;
  v_qtd integer;
  v_sit text;
  v_resumo text;
  v_mudou_disp boolean;
begin
  select * into v_g from public.grupos where id = p_grupo for update;
  if not found then
    raise exception 'grupo_inexistente';
  end if;
  if v_nome is null or not public.dono_operacao(v_g.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_g.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  v_disp := coalesce(nullif(p_dados->>'disponibilidade', ''), v_g.disponibilidade);
  if v_disp not in ('disponivel', 'em_descanso', 'indisponivel') then
    raise exception 'dados_invalidos';
  end if;
  v_obs := case when p_dados ? 'disponibilidade_obs' then left(btrim(coalesce(p_dados->>'disponibilidade_obs', '')), 200) else v_g.disponibilidade_obs end;
  v_cap := case when p_dados ? 'capacidades' then left(btrim(coalesce(p_dados->>'capacidades', '')), 300) else v_g.capacidades end;
  begin
    v_volta := case when p_dados ? 'disponivel_em' then nullif(p_dados->>'disponivel_em', '')::timestamptz else v_g.disponivel_em end;
  exception when others then
    raise exception 'dados_invalidos';
  end;
  v_rec := p_dados->'recursos';
  if v_rec is not null and (jsonb_typeof(v_rec) <> 'array' or jsonb_array_length(v_rec) > 30) then
    raise exception 'dados_invalidos';
  end if;
  -- valida a lista inteira antes de gravar
  if v_rec is not null then
    for v_it in select * from jsonb_array_elements(v_rec) loop
      if jsonb_typeof(v_it) <> 'object' then
        raise exception 'dados_invalidos';
      end if;
      begin
        v_qtd := coalesce(nullif(v_it->>'quantidade', '')::integer, 1);
      exception when others then
        raise exception 'dados_invalidos';
      end;
      if coalesce(v_it->>'tipo', '') not in ('embarcacao', 'viatura', 'drone', 'cao_busca', 'comunicacao', 'primeiros_socorros', 'outro')
         or v_qtd not between 1 and 99
         or coalesce(nullif(v_it->>'situacao', ''), 'operacional') not in ('operacional', 'limitado', 'indisponivel') then
        raise exception 'dados_invalidos';
      end if;
    end loop;
  end if;

  v_mudou_disp := v_disp is distinct from v_g.disponibilidade or v_obs is distinct from v_g.disponibilidade_obs;
  update public.grupos
     set disponibilidade = v_disp, disponibilidade_obs = v_obs, disponivel_em = v_volta, capacidades = v_cap,
         recursos_atualizado_em = now(), recursos_atualizado_por_nome = v_nome
   where id = p_grupo
   returning * into v_g;

  if v_rec is not null then
    delete from public.grupo_recursos where grupo_id = p_grupo;
    for v_it in select * from jsonb_array_elements(v_rec) loop
      insert into public.grupo_recursos (grupo_id, operacao_id, tipo, identificacao, quantidade, situacao, observacao)
      values (p_grupo, v_g.operacao_id, v_it->>'tipo', left(btrim(coalesce(v_it->>'identificacao', '')), 60),
              coalesce(nullif(v_it->>'quantidade', '')::integer, 1), coalesce(nullif(v_it->>'situacao', ''), 'operacional'),
              left(btrim(coalesce(v_it->>'observacao', '')), 200));
    end loop;
    select string_agg(public.recurso_rotulo(r.tipo) || case when r.quantidade > 1 then ' ×' || r.quantidade else '' end ||
                      case when r.identificacao <> '' then ' (' || r.identificacao || ')' else '' end ||
                      case when r.situacao <> 'operacional' then ' — ' || r.situacao else '' end, '; ' order by r.tipo, r.identificacao)
      into v_resumo from public.grupo_recursos r where r.grupo_id = p_grupo;
  end if;

  perform public.diario_auto(v_g.operacao_id, now(), 'pessoa', 'equipe_recursos',
    'Equipe ' || v_g.nome || ': ' || case when v_mudou_disp then 'disponibilidade ' ||
      case v_disp when 'disponivel' then 'disponível' when 'em_descanso' then 'em descanso' else 'INDISPONÍVEL' end else 'recursos atualizados' end,
    coalesce('Recursos: ' || nullif(v_resumo, ''), case when v_rec is not null then 'Recursos: nenhum registrado' end, '') ||
      case when v_obs <> '' then '. Observação: ' || v_obs else '' end ||
      case when v_cap <> '' then '. Capacidades: ' || v_cap else '' end ||
      case when v_volta is not null and v_disp <> 'disponivel' then '. Volta a ficar disponível: ' || to_char(v_volta at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') else '' end,
    'equipe_recursos:' || p_grupo || ':' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint, 'info', null, null, p_grupo::text, v_nome);

  return json_build_object('grupo', row_to_json(v_g),
    'recursos', coalesce((select json_agg(row_to_json(r) order by r.tipo, r.identificacao) from public.grupo_recursos r where r.grupo_id = p_grupo), '[]'::json));
end;
$$;

revoke execute on function public.recurso_rotulo(text) from public, anon, authenticated;
revoke execute on function public.salvar_recursos_grupo(uuid, jsonb) from public, anon;
grant execute on function public.salvar_recursos_grupo(uuid, jsonb) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.grupo_recursos;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

-- =====================================================================
-- 43. Briefing da operação e passagem de comando (migração 037 — idempotente; exige a 007, a 008, a 012, a 026, a 033, a 035 e a 036)
--
--  BRIEFING: uma página curta, montada pelo SERVIDOR com o que já está cadastrado (briefing_operacao_dados), sem
--  redigitar: objetivo, vítimas e último local visto, hipóteses (cenário aprovado), riscos, equipes (disponibilidade e
--  recursos), tarefas (deslocamentos e setores), comunicações e decisões pendentes. O que não existe em outro lugar
--  fica em briefing_operacao (objetivo, riscos, comunicações e observações escritos pelo comando) e em
--  decisoes_pendentes (decisões a tomar, com responsável e prazo, e a decisão tomada).
--  COMANDO: operacoes.comando_* diz quem está no comando (começa no criador). A PASSAGEM de comando
--  (passagens_comando) guarda uma FOTO do briefing (resumo) no momento em que o comandante passa o comando; quem recebe
--  lê a foto e ACEITA (ou recusa com motivo): só no aceite o comando muda, com a hora do aceite. A foto, quem passou e
--  quem recebeu nunca mudam. Se o comandante não responde, outro responsável da operação pode ASSUMIR o comando com
--  motivo obrigatório (fica registrado e no diário, em destaque).
--  Leitura só pelos responsáveis da operação; escrita só pelas funções. Encerrada: somente leitura.
-- =====================================================================
-- Quem está no comando (começa no criador da operação)
alter table public.operacoes add column if not exists comando_user_id uuid references auth.users(id) on delete set null;
alter table public.operacoes add column if not exists comando_nome text;
alter table public.operacoes add column if not exists comando_desde timestamptz;

create or replace function public.operacoes_comando_inicial()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.comando_user_id is null and new.comando_nome is null then
    new.comando_user_id := new.responsavel_id;
    new.comando_nome := (select nome from public.responsaveis where user_id = new.responsavel_id);
    new.comando_desde := coalesce(new.criada_em, now());
  end if;
  return new;
end;
$$;
drop trigger if exists operacoes_comando_inicial on public.operacoes;
create trigger operacoes_comando_inicial before insert on public.operacoes
  for each row execute function public.operacoes_comando_inicial();

-- operações que já existiam: o comando é de quem criou (o cadastro de operação encerrada fica intacto: gatilho desligado só aqui)
alter table public.operacoes disable trigger operacoes_cadastro_encerrada;
update public.operacoes o
   set comando_user_id = o.responsavel_id,
       comando_nome = (select r.nome from public.responsaveis r where r.user_id = o.responsavel_id),
       comando_desde = o.criada_em
 where o.comando_user_id is null and o.comando_nome is null;
alter table public.operacoes enable trigger operacoes_cadastro_encerrada;

create table if not exists public.briefing_operacao (
  operacao_id         uuid primary key references public.operacoes(id) on delete cascade,
  objetivo            text not null default '' check (char_length(objetivo) <= 1000),
  riscos              text not null default '' check (char_length(riscos) <= 1000),
  comunicacoes        text not null default '' check (char_length(comunicacoes) <= 1000),
  observacoes         text not null default '' check (char_length(observacoes) <= 1000),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text
);

create table if not exists public.decisoes_pendentes (
  id                uuid primary key default gen_random_uuid(),
  operacao_id       uuid not null references public.operacoes(id) on delete cascade,
  texto             text not null check (char_length(btrim(texto)) between 3 and 300),
  responsavel_nome  text not null default '' check (char_length(responsavel_nome) <= 60),
  prazo             timestamptz,
  estado            text not null default 'pendente' check (estado in ('pendente', 'decidida', 'cancelada')),
  decisao           text not null default '' check (char_length(decisao) <= 500),
  criado_em         timestamptz not null default now(),
  criado_por_nome   text not null,
  decidida_em       timestamptz,
  decidida_por_nome text,
  constraint decisoes_pendentes_decidida_ok check ((estado = 'pendente') = (decidida_em is null))
);
create index if not exists decisoes_pendentes_operacao_idx on public.decisoes_pendentes (operacao_id, criado_em);

create table if not exists public.passagens_comando (
  id             uuid primary key default gen_random_uuid(),
  operacao_id    uuid not null references public.operacoes(id) on delete cascade,
  tipo           text not null default 'passagem' check (tipo in ('passagem', 'assuncao')),
  de_user_id     uuid references auth.users(id) on delete set null,
  de_nome        text,
  para_user_id   uuid references auth.users(id) on delete set null,
  para_nome      text not null,
  estado         text not null default 'pendente' check (estado in ('pendente', 'aceita', 'recusada', 'cancelada', 'assumida')),
  nota           text not null default '' check (char_length(nota) <= 1000),
  motivo         text not null default '' check (char_length(motivo) <= 500),
  resumo         jsonb not null,
  criada_em      timestamptz not null default now(),
  respondida_em  timestamptz,
  resposta_nota  text not null default '' check (char_length(resposta_nota) <= 500),
  constraint passagens_comando_resposta_ok check ((estado = 'pendente') = (respondida_em is null))
);
create index if not exists passagens_comando_operacao_idx on public.passagens_comando (operacao_id, criada_em desc);
create unique index if not exists passagens_comando_uma_pendente on public.passagens_comando (operacao_id) where estado = 'pendente';

alter table public.briefing_operacao enable row level security;
alter table public.decisoes_pendentes enable row level security;
alter table public.passagens_comando enable row level security;
drop policy if exists briefing_operacao_ler on public.briefing_operacao;
create policy briefing_operacao_ler on public.briefing_operacao for select to authenticated using (public.dono_operacao(operacao_id));
drop policy if exists decisoes_pendentes_ler on public.decisoes_pendentes;
create policy decisoes_pendentes_ler on public.decisoes_pendentes for select to authenticated using (public.dono_operacao(operacao_id));
drop policy if exists passagens_comando_ler on public.passagens_comando;
create policy passagens_comando_ler on public.passagens_comando for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.briefing_operacao, public.decisoes_pendentes, public.passagens_comando from anon;
revoke insert, update, delete, truncate on public.briefing_operacao, public.decisoes_pendentes, public.passagens_comando from authenticated;
grant select on public.briefing_operacao, public.decisoes_pendentes, public.passagens_comando to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['briefing_operacao', 'decisoes_pendentes', 'passagens_comando'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_encerrada', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.bloquear_escrita_encerrada()',
                   t || '_encerrada', t);
  end loop;
end;
$$;

-- Passagem: a foto (resumo), quem passou e quem recebeu nunca mudam; só a resposta (estado, hora, nota), uma vez.
create or replace function public.passagens_comando_proteger()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'passagem_imutavel';
  end if;
  if old.estado <> 'pendente'
     or (to_jsonb(new) - array['estado', 'respondida_em', 'resposta_nota'])
        is distinct from (to_jsonb(old) - array['estado', 'respondida_em', 'resposta_nota']) then
    raise exception 'passagem_imutavel';
  end if;
  return new;
end;
$$;
drop trigger if exists passagens_comando_proteger on public.passagens_comando;
create trigger passagens_comando_proteger before update or delete on public.passagens_comando
  for each row execute function public.passagens_comando_proteger();

-- ---------------------------------------------------------------------
-- O briefing, montado a partir do que já existe. Só responsáveis da operação.
-- ---------------------------------------------------------------------
create or replace function public.briefing_operacao_dados(p_operacao uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
  v_b public.briefing_operacao%rowtype;
  v_vitimas json;
  v_ultimo json;
  v_hip json;
  v_pontos_risco json;
  v_equipes json;
  v_missoes json;
  v_setores json;
  v_com json;
  v_dec json;
  v_auto json;
  v_n_pedidos integer;
  v_n_alertas integer;
begin
  if public.nome_responsavel_atual() is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  select * into v_b from public.briefing_operacao where operacao_id = p_operacao;

  select coalesce(json_agg(json_build_object('id', v.id, 'nome', v.nome, 'idade', v.idade, 'perfil', v.perfil,
           'caracteristicas', left(v.caracteristicas, 300), 'roupas', left(v.roupas, 200),
           'localizada', (select json_build_object('condicao', l.condicao, 'em', l.registrado_em) from public.vitima_localizacoes l where l.vitima_id = v.id order by l.registrado_em desc limit 1))
           order by v.criado_em), '[]'::json)
    into v_vitimas from public.vitimas v where v.operacao_id = p_operacao;

  select coalesce(json_agg(json_build_object('titulo', p.titulo, 'categoria', p.categoria, 'descricao', left(p.descricao, 300), 'lat', p.lat, 'lng', p.lng, 'em', p.criado_em)
           order by p.criado_em desc), '[]'::json)
    into v_ultimo from public.pontos_interesse p where p.operacao_id = p_operacao and p.categoria in ('ULTIMA_LOCALIZACAO', 'POSSIVEL_LOCALIZACAO');

  -- hipóteses: a versão APROVADA mais recente do cenário de cada vítima (POA) e se há rascunho esperando
  select coalesce(json_agg(json_build_object(
           'vitima', v.nome, 'versao', c.numero, 'aprovada_em', c.aprovada_em, 'horario_referencia', c.horario_referencia,
           'hipoteses', c.hipoteses, 'limitacoes', c.limitacoes, 'confianca', c.confianca, 'justificativa', left(c.justificativa, 400),
           'ponto_confiavel', c.ponto_confiavel,
           'setores', (select coalesce(json_agg(json_build_object('nome', s.setor_nome, 'poa', s.poa) order by s.poa desc), '[]'::json)
                         from (select * from public.busca_cenario_setores x where x.cenario_id = c.id and x.poa > 0 order by x.poa desc limit 5) s),
           'rascunho_aberto', exists (select 1 from public.busca_cenarios r where r.vitima_id = v.id and r.estado = 'rascunho'))
           order by v.criado_em), '[]'::json)
    into v_hip
    from public.vitimas v
    join lateral (select * from public.busca_cenarios x where x.vitima_id = v.id and x.estado = 'aprovada' order by x.numero desc limit 1) c on true
   where v.operacao_id = p_operacao;

  select coalesce(json_agg(json_build_object('titulo', p.titulo, 'descricao', left(p.descricao, 300), 'lat', p.lat, 'lng', p.lng) order by p.criado_em desc), '[]'::json)
    into v_pontos_risco from public.pontos_interesse p where p.operacao_id = p_operacao and p.categoria = 'RISCO';
  select count(*) into v_n_pedidos from public.pedidos_ajuda where operacao_id = p_operacao and estado <> 'resolvido';
  select count(*) into v_n_alertas from public.alertas where operacao_id = p_operacao and nivel = 'critico' and reconhecido_em is null;

  select coalesce(json_agg(json_build_object(
           'id', g.id, 'nome', g.nome, 'disponibilidade', g.disponibilidade, 'disponibilidade_obs', g.disponibilidade_obs, 'disponivel_em', g.disponivel_em,
           'disponibilidade_efetiva', case when exists (select 1 from public.missoes m where m.grupo_id = g.id and m.status in ('enviada', 'em_deslocamento', 'no_setor', 'busca_finalizada', 'retorno_atrasado'))
                                           then 'em_missao' else g.disponibilidade end,
           'capacidades', g.capacidades,
           'recursos', (select coalesce(json_agg(json_build_object('tipo', r.tipo, 'identificacao', r.identificacao, 'quantidade', r.quantidade, 'situacao', r.situacao) order by r.tipo, r.identificacao), '[]'::json)
                          from public.grupo_recursos r where r.grupo_id = g.id),
           'sem_comunicacao', not exists (select 1 from public.grupo_recursos r where r.grupo_id = g.id and r.tipo = 'comunicacao' and r.situacao <> 'indisponivel'),
           'sem_primeiros_socorros', not exists (select 1 from public.grupo_recursos r where r.grupo_id = g.id and r.tipo = 'primeiros_socorros' and r.situacao <> 'indisponivel'),
           'membros', (select count(*) from public.grupo_membros gm join public.participantes p on p.id = gm.participante_id where gm.grupo_id = g.id and not p.removido and p.liberado_em is null),
           'conectados', (select count(*) from public.grupo_membros gm join public.participantes p on p.id = gm.participante_id
                           where gm.grupo_id = g.id and not p.removido and p.liberado_em is null and p.ultimo_contato_em > now() - interval '2 minutes'))
           order by g.nome), '[]'::json)
    into v_equipes from public.grupos g where g.operacao_id = p_operacao;

  select coalesce(json_agg(json_build_object('grupo', m.grupo_nome, 'nome', m.nome, 'setor', m.setor_nome, 'status', m.status, 'enviada_em', m.enviada_em,
           'prazo_retorno_em', m.prazo_retorno_em) order by m.enviada_em desc), '[]'::json)
    into v_missoes from public.missoes m where m.operacao_id = p_operacao and m.status not in ('na_base', 'encerrada');

  select json_build_object('pendente', count(*) filter (where status = 'pendente'), 'andamento', count(*) filter (where status = 'andamento'),
                           'concluido', count(*) filter (where status = 'concluido'), 'total', count(*),
                           'pendentes', coalesce(json_agg(nome order by nome) filter (where status <> 'concluido'), '[]'::json))
    into v_setores from public.setores where operacao_id = p_operacao;

  select json_build_object(
           'mensagens_sem_confirmacao', (select count(*) from public.mensagens m where m.operacao_id = p_operacao and m.direcao <> 'entrada' and m.confirmada_em is null),
           'ultimas', (select coalesce(json_agg(x), '[]'::json) from (
                         select json_build_object('de', p.nome, 'texto', left(m.texto, 160), 'categoria', m.categoria, 'em', m.criada_em) as x
                           from public.mensagens m join public.participantes p on p.id = m.participante_id
                          where m.operacao_id = p_operacao and m.direcao = 'entrada' and (m.texto <> '' or m.categoria is not null)
                          order by m.criada_em desc limit 5) u),
           'sem_comunicacao', (select coalesce(json_agg(a.titulo order by a.id), '[]'::json) from public.alertas a
                                where a.operacao_id = p_operacao and a.tipo = 'sem_comunicacao' and a.reconhecido_em is null))
    into v_com;

  select coalesce(json_agg(json_build_object('id', d.id, 'texto', d.texto, 'responsavel', d.responsavel_nome, 'prazo', d.prazo, 'criado_em', d.criado_em, 'criado_por', d.criado_por_nome)
           order by d.prazo nulls last, d.criado_em), '[]'::json)
    into v_dec from public.decisoes_pendentes d where d.operacao_id = p_operacao and d.estado = 'pendente';

  -- decisões que o próprio sistema vê esperando alguém
  select coalesce(json_agg(json_build_object('texto', t.texto, 'ref', t.ref) order by t.ordem), '[]'::json) into v_auto from (
    select 1 as ordem, 'Pedido de ajuda de ' || p.participante_nome || ' (' || p.estado || ', prioridade ' || p.prioridade || ') ainda sem resolução' as texto, 'pedido:' || p.id as ref
      from public.pedidos_ajuda p where p.operacao_id = p_operacao and p.estado <> 'resolvido'
    union all
    select 2, 'Alerta crítico sem ciente: ' || a.titulo, 'alerta:' || a.id
      from public.alertas a where a.operacao_id = p_operacao and a.nivel = 'critico' and a.reconhecido_em is null
    union all
    select 3, 'Cenário de ' || v.nome || ': rascunho da versão ' || c.numero || ' aguardando aprovação', 'cenario:' || c.id
      from public.busca_cenarios c join public.vitimas v on v.id = c.vitima_id where c.operacao_id = p_operacao and c.estado = 'rascunho'
    union all
    select 4, 'Vítima ' || v.nome || ' sem cenário (POA) aprovado', 'vitima:' || v.id
      from public.vitimas v where v.operacao_id = p_operacao
       and not exists (select 1 from public.busca_cenarios c where c.vitima_id = v.id and c.estado = 'aprovada')
       and not exists (select 1 from public.vitima_localizacoes l where l.vitima_id = v.id)
    union all
    select 5, 'Equipe ' || m.grupo_nome || ' com retorno atrasado', 'missao:' || m.id
      from public.missoes m where m.operacao_id = p_operacao and m.status = 'retorno_atrasado'
  ) t;

  return json_build_object(
    'gerado_em', now(),
    'operacao', json_build_object('id', v_op.id, 'codigo', v_op.codigo, 'status', v_op.status, 'tipo', v_op.tipo, 'acionado_em', v_op.acionado_em,
                                  'local', v_op.local_endereco, 'lat', v_op.local_lat, 'lng', v_op.local_lng, 'criada_em', v_op.criada_em),
    'comando', json_build_object('user_id', v_op.comando_user_id, 'nome', v_op.comando_nome, 'desde', v_op.comando_desde),
    'objetivo', json_build_object('texto', coalesce(v_b.objetivo, ''),
                                  'sugerido', nullif(btrim(coalesce(nullif(v_op.descricao, ''), v_op.ipo->>'natureza', '')), '')),
    'vitimas', v_vitimas,
    'ultimo_local_visto', v_ultimo,
    'hipoteses', v_hip,
    'riscos', json_build_object('texto', coalesce(v_b.riscos, ''), 'pontos', v_pontos_risco, 'pedidos_ajuda_abertos', v_n_pedidos, 'alertas_criticos_sem_ciente', v_n_alertas),
    'equipes', v_equipes,
    'tarefas', json_build_object('deslocamentos', v_missoes, 'setores', v_setores),
    'comunicacoes', json_build_object('texto', coalesce(v_b.comunicacoes, ''), 'dados', v_com),
    'observacoes', coalesce(v_b.observacoes, ''),
    'decisoes_pendentes', v_dec,
    'decisoes_automaticas', v_auto);
end;
$$;

-- ---------------------------------------------------------------------
-- Escrita
-- ---------------------------------------------------------------------
create or replace function public.briefing_para_alterar(p_operacao uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_status text;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  return v_nome;
end;
$$;

-- p_dados: objetivo, riscos, comunicacoes, observacoes (só as chaves enviadas mudam; cada uma até 1000 caracteres)
create or replace function public.salvar_briefing(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.briefing_para_alterar(p_operacao);
  v_b public.briefing_operacao%rowtype;
  k text;
begin
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  foreach k in array array['objetivo', 'riscos', 'comunicacoes', 'observacoes'] loop
    if p_dados ? k and char_length(coalesce(p_dados->>k, '')) > 1000 then
      raise exception 'dados_invalidos';
    end if;
  end loop;
  insert into public.briefing_operacao (operacao_id, objetivo, riscos, comunicacoes, observacoes, atualizado_por_nome)
  values (p_operacao, left(btrim(coalesce(p_dados->>'objetivo', '')), 1000), left(btrim(coalesce(p_dados->>'riscos', '')), 1000),
          left(btrim(coalesce(p_dados->>'comunicacoes', '')), 1000), left(btrim(coalesce(p_dados->>'observacoes', '')), 1000), v_nome)
  on conflict (operacao_id) do update
     set objetivo = case when p_dados ? 'objetivo' then left(btrim(coalesce(p_dados->>'objetivo', '')), 1000) else public.briefing_operacao.objetivo end,
         riscos = case when p_dados ? 'riscos' then left(btrim(coalesce(p_dados->>'riscos', '')), 1000) else public.briefing_operacao.riscos end,
         comunicacoes = case when p_dados ? 'comunicacoes' then left(btrim(coalesce(p_dados->>'comunicacoes', '')), 1000) else public.briefing_operacao.comunicacoes end,
         observacoes = case when p_dados ? 'observacoes' then left(btrim(coalesce(p_dados->>'observacoes', '')), 1000) else public.briefing_operacao.observacoes end,
         atualizado_em = now(), atualizado_por_nome = v_nome
  returning * into v_b;
  perform public.diario_auto(p_operacao, now(), 'operacao', 'briefing_atualizado', 'Briefing atualizado',
    'Objetivo: ' || coalesce(nullif(v_b.objetivo, ''), '—'), 'briefing:' || p_operacao || ':' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
    'info', null, null, p_operacao::text, v_nome);
  return row_to_json(v_b);
end;
$$;

-- p_dados: texto (3 a 300), responsavel (quem decide), prazo (hora ou nulo)
create or replace function public.decisao_criar(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.briefing_para_alterar(p_operacao);
  v_d public.decisoes_pendentes%rowtype;
  v_texto text;
  v_prazo timestamptz;
begin
  p_dados := coalesce(p_dados, '{}'::jsonb);
  v_texto := btrim(coalesce(p_dados->>'texto', ''));
  if char_length(v_texto) not between 3 and 300 then
    raise exception 'decisao_texto_invalido';
  end if;
  begin
    v_prazo := nullif(p_dados->>'prazo', '')::timestamptz;
  exception when others then
    raise exception 'dados_invalidos';
  end;
  insert into public.decisoes_pendentes (operacao_id, texto, responsavel_nome, prazo, criado_por_nome)
  values (p_operacao, v_texto, left(btrim(coalesce(p_dados->>'responsavel', '')), 60), v_prazo, v_nome)
  returning * into v_d;
  perform public.diario_auto(p_operacao, now(), 'operacao', 'decisao_pendente', 'Decisão pendente: ' || v_texto,
    coalesce('Quem decide: ' || nullif(v_d.responsavel_nome, ''), '') || case when v_prazo is not null then ' · prazo ' || to_char(v_prazo at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') else '' end,
    'decisao:' || v_d.id, 'info', null, null, v_d.id::text, v_nome);
  return row_to_json(v_d);
end;
$$;

-- p_estado: 'decidida' (exige o texto da decisão) ou 'cancelada'
create or replace function public.decisao_resolver(p_decisao uuid, p_estado text, p_texto text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_d public.decisoes_pendentes%rowtype;
  v_nome text;
  v_texto text := left(btrim(coalesce(p_texto, '')), 500);
begin
  select * into v_d from public.decisoes_pendentes where id = p_decisao for update;
  if not found then
    raise exception 'decisao_inexistente';
  end if;
  v_nome := public.briefing_para_alterar(v_d.operacao_id);
  if p_estado not in ('decidida', 'cancelada') then
    raise exception 'dados_invalidos';
  end if;
  if v_d.estado <> 'pendente' then
    raise exception 'decisao_ja_resolvida';
  end if;
  if p_estado = 'decidida' and char_length(v_texto) < 3 then
    raise exception 'decisao_sem_texto';
  end if;
  update public.decisoes_pendentes
     set estado = p_estado, decisao = v_texto, decidida_em = now(), decidida_por_nome = v_nome
   where id = p_decisao returning * into v_d;
  perform public.diario_auto(v_d.operacao_id, now(), 'operacao', 'decisao_' || p_estado,
    case p_estado when 'decidida' then 'Decisão tomada: ' else 'Decisão cancelada: ' end || v_d.texto, v_texto, 'decisao_fim:' || v_d.id, 'info', null, null, v_d.id::text, v_nome);
  return row_to_json(v_d);
end;
$$;

-- Passa o comando: só quem está no comando (ou um administrador). A foto do briefing fica guardada; o comando só muda no aceite.
create or replace function public.passagem_iniciar(p_operacao uuid, p_para uuid, p_nota text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.briefing_para_alterar(p_operacao);
  v_op public.operacoes%rowtype;
  v_para text;
  v_pas public.passagens_comando%rowtype;
begin
  select * into v_op from public.operacoes where id = p_operacao;
  if v_op.comando_user_id is distinct from auth.uid() and not public.eh_admin() then
    raise exception 'passagem_so_do_comandante';
  end if;
  if p_para is null or p_para = auth.uid() then
    raise exception 'passagem_destino_invalido';
  end if;
  select r.nome into v_para from public.responsaveis r
   where r.user_id = p_para and r.ativo
     and (v_op.responsavel_id = p_para or exists (select 1 from public.operacao_responsaveis m where m.operacao_id = p_operacao and m.user_id = p_para));
  if v_para is null then
    raise exception 'passagem_destino_invalido';
  end if;
  if exists (select 1 from public.passagens_comando where operacao_id = p_operacao and estado = 'pendente') then
    raise exception 'passagem_pendente_existente';
  end if;
  insert into public.passagens_comando (operacao_id, tipo, de_user_id, de_nome, para_user_id, para_nome, nota, resumo)
  values (p_operacao, 'passagem', v_op.comando_user_id, coalesce(v_op.comando_nome, v_nome), p_para, v_para,
          left(btrim(coalesce(p_nota, '')), 1000), (public.briefing_operacao_dados(p_operacao))::jsonb)
  returning * into v_pas;
  perform public.diario_auto(p_operacao, v_pas.criada_em, 'operacao', 'passagem_comando_iniciada',
    'Passagem de comando iniciada: ' || coalesce(v_pas.de_nome, '—') || ' → ' || v_para,
    'Aguardando o aceite de ' || v_para || '.' || case when v_pas.nota <> '' then ' Nota: ' || v_pas.nota else '' end,
    'passagem:' || v_pas.id || ':iniciada', 'info', null, null, v_pas.id::text, v_nome);
  return row_to_json(v_pas);
end;
$$;

-- Quem recebe aceita (o comando muda, com a hora do aceite) ou recusa (com motivo)
create or replace function public.passagem_responder(p_passagem uuid, p_aceitar boolean, p_nota text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_pas public.passagens_comando%rowtype;
  v_status text;
  v_nota text := left(btrim(coalesce(p_nota, '')), 500);
begin
  select * into v_pas from public.passagens_comando where id = p_passagem for update;
  if not found then
    raise exception 'passagem_inexistente';
  end if;
  if v_nome is null or v_pas.para_user_id is distinct from auth.uid() or not public.dono_operacao(v_pas.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_pas.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if v_pas.estado <> 'pendente' then
    raise exception 'passagem_nao_pendente';
  end if;
  if p_aceitar is null then
    raise exception 'dados_invalidos';
  end if;
  if not p_aceitar and char_length(v_nota) < 3 then
    raise exception 'passagem_recusa_sem_motivo';
  end if;
  update public.passagens_comando
     set estado = case when p_aceitar then 'aceita' else 'recusada' end, respondida_em = now(), resposta_nota = v_nota
   where id = p_passagem returning * into v_pas;
  if p_aceitar then
    update public.operacoes set comando_user_id = auth.uid(), comando_nome = v_nome, comando_desde = v_pas.respondida_em where id = v_pas.operacao_id;
  end if;
  perform public.diario_auto(v_pas.operacao_id, v_pas.respondida_em, 'operacao', case when p_aceitar then 'comando_assumido' else 'passagem_comando_recusada' end,
    case when p_aceitar then 'COMANDO: ' || coalesce(v_pas.de_nome, '—') || ' passou o comando a ' || v_nome
         else 'Passagem de comando RECUSADA por ' || v_nome end,
    case when p_aceitar then 'Aceite às ' || to_char(v_pas.respondida_em at time zone 'America/Sao_Paulo', 'HH24:MI') || ' (foto do briefing da passagem guardada).'
         else 'Motivo: ' || v_nota end,
    'passagem:' || v_pas.id || ':resposta', case when p_aceitar then 'critico' else 'info' end, null, null, v_pas.id::text, v_nome);
  return row_to_json(v_pas);
end;
$$;

-- Quem passou (ou um administrador) cancela uma passagem que ainda não foi respondida
create or replace function public.passagem_cancelar(p_passagem uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_pas public.passagens_comando%rowtype;
  v_status text;
begin
  select * into v_pas from public.passagens_comando where id = p_passagem for update;
  if not found then
    raise exception 'passagem_inexistente';
  end if;
  if v_nome is null or not public.dono_operacao(v_pas.operacao_id) or (v_pas.de_user_id is distinct from auth.uid() and not public.eh_admin()) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_pas.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if v_pas.estado <> 'pendente' then
    raise exception 'passagem_nao_pendente';
  end if;
  update public.passagens_comando set estado = 'cancelada', respondida_em = now() where id = p_passagem returning * into v_pas;
  perform public.diario_auto(v_pas.operacao_id, v_pas.respondida_em, 'operacao', 'passagem_comando_cancelada',
    'Passagem de comando cancelada por ' || v_nome, 'Destino era ' || v_pas.para_nome || '.', 'passagem:' || v_pas.id || ':cancelada', 'info', null, null, v_pas.id::text, v_nome);
  return row_to_json(v_pas);
end;
$$;

-- Comandante ausente: outro responsável da operação assume, com motivo (mín. 10 caracteres). Fica registrado em destaque.
create or replace function public.comando_assumir(p_operacao uuid, p_motivo text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.briefing_para_alterar(p_operacao);
  v_op public.operacoes%rowtype;
  v_motivo text := left(btrim(coalesce(p_motivo, '')), 500);
  v_pas public.passagens_comando%rowtype;
begin
  select * into v_op from public.operacoes where id = p_operacao for update;
  if v_op.comando_user_id = auth.uid() then
    raise exception 'comando_ja_seu';
  end if;
  if char_length(v_motivo) < 10 then
    raise exception 'comando_motivo_obrigatorio';
  end if;
  update public.passagens_comando set estado = 'cancelada', respondida_em = now(), resposta_nota = 'Cancelada: comando assumido por ' || v_nome
   where operacao_id = p_operacao and estado = 'pendente';
  insert into public.passagens_comando (operacao_id, tipo, de_user_id, de_nome, para_user_id, para_nome, estado, motivo, resumo, respondida_em)
  values (p_operacao, 'assuncao', v_op.comando_user_id, v_op.comando_nome, auth.uid(), v_nome, 'assumida', v_motivo,
          (public.briefing_operacao_dados(p_operacao))::jsonb, now())
  returning * into v_pas;
  update public.operacoes set comando_user_id = auth.uid(), comando_nome = v_nome, comando_desde = v_pas.respondida_em where id = p_operacao;
  perform public.diario_auto(p_operacao, v_pas.respondida_em, 'operacao', 'comando_assumido_sem_aceite',
    'COMANDO ASSUMIDO por ' || v_nome || ' (sem aceite de quem estava no comando: ' || coalesce(v_pas.de_nome, '—') || ')',
    'Motivo: ' || v_motivo, 'passagem:' || v_pas.id || ':assuncao', 'critico', null, null, v_pas.id::text, v_nome);
  return row_to_json(v_pas);
end;
$$;

revoke execute on function public.operacoes_comando_inicial(), public.passagens_comando_proteger(), public.briefing_para_alterar(uuid) from public, anon, authenticated;
revoke execute on function public.briefing_operacao_dados(uuid), public.salvar_briefing(uuid, jsonb), public.decisao_criar(uuid, jsonb), public.decisao_resolver(uuid, text, text),
  public.passagem_iniciar(uuid, uuid, text), public.passagem_responder(uuid, boolean, text), public.passagem_cancelar(uuid), public.comando_assumir(uuid, text) from public, anon;
grant execute on function public.briefing_operacao_dados(uuid), public.salvar_briefing(uuid, jsonb), public.decisao_criar(uuid, jsonb), public.decisao_resolver(uuid, text, text),
  public.passagem_iniciar(uuid, uuid, text), public.passagem_responder(uuid, boolean, text), public.passagem_cancelar(uuid), public.comando_assumir(uuid, text) to authenticated;

do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['briefing_operacao', 'decisoes_pendentes', 'passagens_comando', 'operacoes'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end;
$$;

-- =====================================================================
-- 44. POA: "Fora da área" guardado e soma exata de 100%, origem de cada valor e versão sempre em dia
--     (migração 038 — idempotente; exige a 033 e a 034)
--
--  • A versão passa a GUARDAR a probabilidade "Fora da área" (poa_fora). Publicar (cenario_aprovar) exige que
--    setores + fora = 100% (tolerância de 0,05 ponto, o arredondamento de uma casa) — conferido AQUI, no
--    servidor, e não só na tela (cenario_fora_obrigatorio, cenario_soma_diferente_de_100).
--    Versões já aprovadas continuam como estão (poa_fora nulo = "fora" implícito = o que sobra); nada é reescrito.
--  • Origem de cada valor: 'manual', 'ia' (sugerido por IA e mantido pelo responsável, que o revisou ao salvar) ou
--    'calculo' (atualização pós-busca, 039). A publicação registra no diário "sugerido por IA, revisado por <nome>".
--  • Se a versão vigente mudou depois do rascunho (ex.: busca negativa aplicada), publicar o rascunho é recusado
--    (cenario_base_desatualizada): salve o rascunho de novo depois de revisá-lo. O número do rascunho é ajustado
--    na publicação, para a ordem das versões nunca voltar atrás.
-- =====================================================================
alter table public.busca_cenarios add column if not exists poa_fora numeric(7, 6);
alter table public.busca_cenarios add column if not exists poa_fora_origem text not null default 'manual';
alter table public.busca_cenarios add column if not exists ia_modelo text;
alter table public.busca_cenario_setores add column if not exists origem text not null default 'manual';
alter table public.busca_cenario_setores add column if not exists ia_revisado_por_nome text;
do $$
begin
  alter table public.busca_cenarios add constraint busca_cenarios_fora_ok check (
    (poa_fora is null or (poa_fora >= 0 and poa_fora <= 1)) and poa_fora_origem in ('manual', 'ia') and (ia_modelo is null or char_length(ia_modelo) <= 60));
exception when duplicate_object then null;
end;
$$;
do $$
begin
  alter table public.busca_cenario_setores add constraint busca_cenario_setores_origem_ok check (origem in ('manual', 'ia', 'calculo'));
exception when duplicate_object then null;
end;
$$;

-- Proteção das versões: a 033 com dois desvios controlados, usados só por funções desta base
--   gbs.renumerar      → publicar um rascunho pode mudar o NÚMERO dele (só rascunho → aprovada)
--   gbs.gerando_versao → o cálculo pós-busca (039) grava a nova versão já aprovada com as linhas de setor
create or replace function public.busca_cenarios_proteger()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_estado text;
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'busca_cenarios' then
    if tg_op in ('UPDATE', 'DELETE') and old.estado = 'aprovada' then
      raise exception 'cenario_imutavel_aprovado';
    end if;
    if tg_op = 'UPDATE' and (new.operacao_id <> old.operacao_id or new.vitima_id <> old.vitima_id
       or (new.numero <> old.numero and not (current_setting('gbs.renumerar', true) = 'on' and old.estado = 'rascunho' and new.estado = 'aprovada'))) then
      raise exception 'dados_invalidos';
    end if;
  else
    if current_setting('gbs.gerando_versao', true) = 'on' and tg_op = 'INSERT' then
      return new;
    end if;
    select estado into v_estado from public.busca_cenarios where id = coalesce(new.cenario_id, old.cenario_id);
    if v_estado = 'aprovada' then
      raise exception 'cenario_imutavel_aprovado';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke execute on function public.busca_cenarios_proteger() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Cenário: salvar o rascunho. Novidades em relação à 034:
--   p_dados.poa_fora (0 a 1), poa_fora_origem ('manual'|'ia'), ia_modelo; cada setor aceita origem ('manual'|'ia').
-- ---------------------------------------------------------------------
create or replace function public.cenario_salvar_rascunho(p_vitima uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_vit public.vitimas%rowtype;
  v_cen public.busca_cenarios%rowtype;
  v_status text;
  v_just text;
  v_itens jsonb;
  v_evid jsonb;
  v_it jsonb;
  v_setor public.setores%rowtype;
  v_ponto public.pontos_interesse%rowtype;
  v_setor_id uuid;
  v_poa numeric;
  v_soma numeric := 0;
  v_vistos uuid[] := '{}';
  v_base integer;
  v_esperado timestamptz;
  v_hr timestamptz;
  v_hip text;
  v_lim text;
  v_conf text;
  v_origem text;
  v_ponto_id uuid;
  v_ponto_json jsonb;
  v_desc text;
  v_fora numeric;
  v_fora_origem text;
  v_ia_modelo text;
  v_orig_it text;
  v_max integer;
begin
  select * into v_vit from public.vitimas where id = p_vitima;
  if not found then
    raise exception 'vitima_nao_encontrada';
  end if;
  if v_nome is null or not public.dono_operacao(v_vit.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_vit.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if exists (select 1 from public.vitima_localizacoes where vitima_id = p_vitima) then
    raise exception 'cenario_vitima_localizada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  v_itens := coalesce(p_dados->'setores', '[]'::jsonb);
  v_evid := coalesce(p_dados->'evidencias', '[]'::jsonb);
  if jsonb_typeof(v_itens) <> 'array' or jsonb_typeof(v_evid) <> 'array' then
    raise exception 'dados_invalidos';
  end if;
  if jsonb_array_length(v_evid) > 30 then
    raise exception 'dados_invalidos';
  end if;
  v_just := left(btrim(coalesce(p_dados->>'justificativa', '')), 2000);
  v_hip := left(btrim(coalesce(p_dados->>'hipoteses', '')), 2000);
  v_lim := left(btrim(coalesce(p_dados->>'limitacoes', '')), 1000);
  v_conf := nullif(p_dados->>'confianca', '');
  v_origem := coalesce(nullif(p_dados->>'origem_poa', ''), 'julgamento_comando');
  if (v_conf is not null and v_conf not in ('baixa', 'media', 'alta')) or v_origem not in ('julgamento_comando', 'consenso_documentado') then
    raise exception 'dados_invalidos';
  end if;
  begin
    v_esperado := nullif(p_dados->>'atualizado_em', '')::timestamptz;
    v_hr := nullif(p_dados->>'horario_referencia', '')::timestamptz;
    v_ponto_id := nullif(p_dados->>'ponto_confiavel_id', '')::uuid;
    v_fora := nullif(p_dados->>'poa_fora', '')::numeric;
  exception when others then
    raise exception 'dados_invalidos';
  end;
  v_fora_origem := coalesce(nullif(p_dados->>'poa_fora_origem', ''), 'manual');
  v_ia_modelo := left(nullif(btrim(coalesce(p_dados->>'ia_modelo', '')), ''), 60);
  if (v_fora is not null and (v_fora < 0 or v_fora > 1)) or v_fora_origem not in ('manual', 'ia') then
    raise exception 'dados_invalidos';
  end if;
  if v_hr is not null and v_hr > now() + interval '10 minutes' then
    raise exception 'dados_invalidos';
  end if;
  if v_ponto_id is not null then
    select * into v_ponto from public.pontos_interesse where id = v_ponto_id and operacao_id = v_vit.operacao_id;
    if not found then
      raise exception 'dados_invalidos';
    end if;
    v_ponto_json := jsonb_build_object('titulo', v_ponto.titulo, 'categoria', v_ponto.categoria, 'lat', v_ponto.lat, 'lng', v_ponto.lng);
  end if;

  -- valida os setores antes de gravar qualquer coisa
  for v_it in select * from jsonb_array_elements(v_itens) loop
    begin
      v_setor_id := (v_it->>'setor_id')::uuid;
      v_poa := (v_it->>'poa')::numeric;
    exception when others then
      raise exception 'dados_invalidos';
    end;
    v_orig_it := coalesce(nullif(v_it->>'origem', ''), 'manual');
    if v_poa is null or v_poa < 0 or v_poa > 1 or v_setor_id = any(v_vistos) or v_orig_it not in ('manual', 'ia') then
      raise exception 'dados_invalidos';
    end if;
    if not exists (select 1 from public.setores where id = v_setor_id and operacao_id = v_vit.operacao_id) then
      raise exception 'setor_nao_encontrado';
    end if;
    v_vistos := v_vistos || v_setor_id;
    v_soma := v_soma + v_poa;
  end loop;
  if v_soma > 1.000001 or (v_fora is not null and v_soma + v_fora > 1.000001) then
    raise exception 'cenario_poa_acima_de_100';
  end if;
  for v_it in select * from jsonb_array_elements(v_evid) loop
    if jsonb_typeof(v_it) <> 'object' then
      raise exception 'dados_invalidos';
    end if;
    if nullif(v_it->>'ponto_id', '') is not null then
      begin
        perform (v_it->>'ponto_id')::uuid;
      exception when others then
        raise exception 'dados_invalidos';
      end;
      if not exists (select 1 from public.pontos_interesse where id = (v_it->>'ponto_id')::uuid and operacao_id = v_vit.operacao_id) then
        raise exception 'dados_invalidos';
      end if;
    elsif char_length(btrim(coalesce(v_it->>'descricao', ''))) < 1 then
      raise exception 'dados_invalidos';
    end if;
  end loop;

  perform pg_advisory_xact_lock(hashtext('cenario:' || p_vitima::text));
  select * into v_cen from public.busca_cenarios where vitima_id = p_vitima and estado = 'rascunho' for update;
  if found then
    if v_esperado is not null and v_esperado <> v_cen.atualizado_em then
      raise exception 'cenario_versao_desatualizada';
    end if;
    update public.busca_cenarios
       set justificativa = v_just, hipoteses = v_hip, limitacoes = v_lim, confianca = v_conf, origem_poa = v_origem,
           horario_referencia = coalesce(v_hr, horario_referencia, now()),
           ponto_confiavel_id = v_ponto_id, ponto_confiavel = v_ponto_json,
           poa_fora = v_fora, poa_fora_origem = v_fora_origem, ia_modelo = v_ia_modelo,
           base_numero = (select max(numero) from public.busca_cenarios where vitima_id = p_vitima and estado = 'aprovada'),   -- salvar de novo confirma a base vigente
           atualizado_em = now(), atualizado_por_nome = v_nome
     where id = v_cen.id
     returning * into v_cen;
    delete from public.busca_cenario_setores where cenario_id = v_cen.id;
    delete from public.busca_cenario_evidencias where cenario_id = v_cen.id;
  else
    select max(numero) into v_base from public.busca_cenarios where vitima_id = p_vitima and estado = 'aprovada';
    insert into public.busca_cenarios (operacao_id, vitima_id, numero, base_numero, justificativa, hipoteses, limitacoes, confianca, origem_poa,
                                       horario_referencia, ponto_confiavel_id, ponto_confiavel, poa_fora, poa_fora_origem, ia_modelo, criado_por, criado_por_nome, atualizado_por_nome)
    values (v_vit.operacao_id, p_vitima,
            coalesce((select max(numero) from public.busca_cenarios where vitima_id = p_vitima), 0) + 1,
            v_base, v_just, v_hip, v_lim, v_conf, v_origem, coalesce(v_hr, now()), v_ponto_id, v_ponto_json, v_fora, v_fora_origem, v_ia_modelo, auth.uid(), v_nome, v_nome)
    returning * into v_cen;
  end if;

  for v_it in select * from jsonb_array_elements(v_itens) loop
    select * into v_setor from public.setores where id = (v_it->>'setor_id')::uuid;
    insert into public.busca_cenario_setores (cenario_id, operacao_id, setor_id, setor_nome, poa, justificativa,
                                              forma, centro_lat, centro_lng, raio_m, pontos, area_m2, origem, ia_revisado_por_nome)
    values (v_cen.id, v_vit.operacao_id, v_setor.id, v_setor.nome, (v_it->>'poa')::numeric,
            left(btrim(coalesce(v_it->>'justificativa', '')), 500),
            v_setor.forma, v_setor.centro_lat, v_setor.centro_lng, v_setor.raio_m, v_setor.pontos,
            public.busca_area_m2(v_setor.forma, v_setor.centro_lat, v_setor.centro_lng, v_setor.raio_m, v_setor.pontos),
            coalesce(nullif(v_it->>'origem', ''), 'manual'),
            case when coalesce(nullif(v_it->>'origem', ''), 'manual') = 'ia' then v_nome end);
  end loop;
  for v_it in select * from jsonb_array_elements(v_evid) loop
    if nullif(v_it->>'ponto_id', '') is not null then
      select * into v_ponto from public.pontos_interesse where id = (v_it->>'ponto_id')::uuid;
      v_desc := coalesce(nullif(btrim(v_it->>'descricao'), ''), v_ponto.categoria || ' — ' || v_ponto.titulo);
      insert into public.busca_cenario_evidencias (cenario_id, operacao_id, ponto_id, descricao, confirmada)
      values (v_cen.id, v_vit.operacao_id, v_ponto.id, left(v_desc, 300), coalesce((v_it->>'confirmada')::boolean, false));
    else
      insert into public.busca_cenario_evidencias (cenario_id, operacao_id, ponto_id, descricao, confirmada)
      values (v_cen.id, v_vit.operacao_id, null, left(btrim(v_it->>'descricao'), 300), coalesce((v_it->>'confirmada')::boolean, false));
    end if;
  end loop;

  return json_build_object('cenario', row_to_json(v_cen),
    'setores', coalesce((select json_agg(row_to_json(s) order by s.setor_nome) from public.busca_cenario_setores s where s.cenario_id = v_cen.id), '[]'::json),
    'evidencias', coalesce((select json_agg(row_to_json(e) order by e.descricao) from public.busca_cenario_evidencias e where e.cenario_id = v_cen.id), '[]'::json));
end;
$$;

-- ---------------------------------------------------------------------
-- Cenário: aprovar (publicar). Novidades: soma exata de 100% com "Fora da área", base em dia, número ajustado.
-- ---------------------------------------------------------------------
create or replace function public.cenario_aprovar(p_cenario uuid, p_revisao timestamptz default null, p_chave text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_cen public.busca_cenarios%rowtype;
  v_vit public.vitimas%rowtype;
  v_status text;
  v_soma numeric;
  v_detalhe text;
  v_par text;
  v_max integer;
  v_numero integer;
  v_ia text;
begin
  select * into v_cen from public.busca_cenarios where id = p_cenario for update;
  if not found then
    raise exception 'cenario_versao_inexistente';
  end if;
  if v_nome is null or not public.dono_operacao(v_cen.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if v_cen.estado = 'aprovada' then
    -- repetição da mesma aprovação (mesma chave): devolve o resultado sem duplicar nada
    if p_chave is not null and v_cen.aprovacao_chave = p_chave then
      return json_build_object('cenario', row_to_json(v_cen), 'repetida', true,
        'setores', coalesce((select json_agg(row_to_json(s) order by s.setor_nome) from public.busca_cenario_setores s where s.cenario_id = v_cen.id), '[]'::json),
        'evidencias', coalesce((select json_agg(row_to_json(e) order by e.descricao) from public.busca_cenario_evidencias e where e.cenario_id = v_cen.id), '[]'::json));
    end if;
    raise exception 'cenario_imutavel_aprovado';
  end if;
  select status into v_status from public.operacoes where id = v_cen.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if exists (select 1 from public.vitima_localizacoes where vitima_id = v_cen.vitima_id) then
    raise exception 'cenario_vitima_localizada';
  end if;
  if p_revisao is not null and p_revisao <> v_cen.atualizado_em then
    raise exception 'cenario_versao_desatualizada';
  end if;
  if char_length(btrim(v_cen.justificativa)) < 10 then
    raise exception 'cenario_sem_justificativa';
  end if;
  select coalesce(sum(poa), 0) into v_soma from public.busca_cenario_setores where cenario_id = v_cen.id;
  if v_soma <= 0 then
    raise exception 'cenario_sem_setores';
  end if;
  v_par := public.busca_cenario_sobreposicao(v_cen.id);
  if v_par is not null then
    raise exception 'cenario_setores_sobrepostos';
  end if;
  -- a soma, com "Fora da área", precisa dar exatamente 100% (tolerância de 0,05 ponto: o arredondamento de uma casa)
  if v_cen.poa_fora is null then
    raise exception 'cenario_fora_obrigatorio';
  end if;
  if abs(v_soma + v_cen.poa_fora - 1) > 0.0005 then
    raise exception 'cenario_soma_diferente_de_100';
  end if;
  -- a versão vigente mudou depois deste rascunho (ex.: busca negativa aplicada): revise antes de publicar
  select max(numero) into v_max from public.busca_cenarios where vitima_id = v_cen.vitima_id and estado = 'aprovada';
  if v_max is not null and v_cen.base_numero is distinct from v_max then
    raise exception 'cenario_base_desatualizada';
  end if;
  v_numero := v_cen.numero;
  if v_max is not null and v_numero <= v_max then
    v_numero := (select max(numero) from public.busca_cenarios where vitima_id = v_cen.vitima_id) + 1;
  end if;
  perform set_config('gbs.renumerar', 'on', true);

  update public.busca_cenarios
     set numero = v_numero, estado = 'aprovada', aprovada_em = now(), aprovada_por = auth.uid(), aprovada_por_nome = v_nome,
         aprovacao_chave = p_chave, horario_referencia = coalesce(horario_referencia, now()),
         atualizado_em = now(), atualizado_por_nome = v_nome
   where id = v_cen.id
   returning * into v_cen;
  perform set_config('gbs.renumerar', 'off', true);

  select * into v_vit from public.vitimas where id = v_cen.vitima_id;
  if v_cen.poa_fora_origem = 'ia' or exists (select 1 from public.busca_cenario_setores where cenario_id = v_cen.id and origem = 'ia') then
    v_ia := 'Valores sugeridos por IA' || coalesce(' (' || v_cen.ia_modelo || ')', '') || ' e revisados por ' || v_nome || '.';
  end if;
  select string_agg(s.setor_nome || ': ' || trim_scale(round(s.poa * 100, 1))::text || '%', ' · ' order by s.poa desc, s.setor_nome)
    into v_detalhe from public.busca_cenario_setores s where s.cenario_id = v_cen.id;
  perform public.diario_auto(v_cen.operacao_id, v_cen.aprovada_em, 'pessoa', 'cenario_aprovado',
    'Cenário de busca aprovado: ' || v_vit.nome || ' (versão ' || v_cen.numero || ')',
    'POA por setor — ' || coalesce(v_detalhe, '') || ' · fora dos setores: ' || trim_scale(round(v_cen.poa_fora * 100, 1))::text || '%. Justificativa: ' || v_cen.justificativa ||
      case when v_cen.hipoteses <> '' then ' Hipóteses: ' || v_cen.hipoteses else '' end ||
      case when v_cen.limitacoes <> '' then ' Limitações: ' || v_cen.limitacoes else '' end ||
      case when v_ia is not null then ' ' || v_ia else '' end,
    'cenario:' || v_cen.id, 'info', null, null, v_cen.id::text, v_nome);

  return json_build_object('cenario', row_to_json(v_cen),
    'setores', coalesce((select json_agg(row_to_json(s) order by s.setor_nome) from public.busca_cenario_setores s where s.cenario_id = v_cen.id), '[]'::json),
    'evidencias', coalesce((select json_agg(row_to_json(e) order by e.descricao) from public.busca_cenario_evidencias e where e.cenario_id = v_cen.id), '[]'::json));
end;
$$;


revoke execute on function public.cenario_salvar_rascunho(uuid, jsonb), public.cenario_aprovar(uuid, timestamptz, text) from public, anon;
grant execute on function public.cenario_salvar_rascunho(uuid, jsonb), public.cenario_aprovar(uuid, timestamptz, text) to authenticated;

-- =====================================================================
-- 45. Missão de busca (o POD pertence à missão) e cálculo pós-busca por versão
--     (migração 039 — idempotente; exige a 033, a 034, a 038, a 008, a 012 e a 026)
--
--  • MISSÃO DE BUSCA (busca_missoes): equipe, método, área atribuída (fração do setor), POD estimada (opcional:
--    nula = "POD não estimada", nunca zero) e, depois do retorno da equipe, o RESULTADO (localizado, não localizado ou
--    não concluído) com a execução real (cobertura real, horários) e o POD final. O POD não é mais lançado solto no setor.
--    Os registros antigos (busca_registros) continuam guardados, só que não alimentam mais o cálculo.
--  • CÁLCULO PÓS-BUSCA (só busca negativa): para o setor pesquisado q = POD × cobertura; para os demais, q = 0.
--        r_j = p_j × (1 − q_j) ;  Z = Σ r_k (incluindo "Fora da área") ;  p'_j = r_j / Z
--    Cada cálculo gera uma NOVA VERSÃO aprovada do cenário (origem 'calculo_pos_busca'); as anteriores não mudam.
--    POD desconhecido → NÃO recalcula: a missão fica "pendente de POD" até alguém informá-lo (uma vez).
--    Z = 0 ou valor inválido → "inconsistente": nada é alterado e o motivo fica na missão.
--    O app nunca soma PODs de missões diferentes: cada missão atualiza a versão vigente, em sequência.
--  • POS da missão = POA do setor (na versão vigente) × POD da missão ("chance de localizar nesta busca"). Fica guardado
--    por vítima em busca_missao_efeitos, com a versão antes e depois.
--  • Origem do POD: 'manual' ou 'ia' (sugerido por IA e revisado por quem salvou). O GPS nunca vira POD.
--  Escrita só por função do servidor (SECURITY DEFINER); leitura só dos responsáveis; operação encerrada: só leitura.
-- =====================================================================
create table if not exists public.busca_missoes (
  id                    uuid primary key default gen_random_uuid(),
  operacao_id           uuid not null references public.operacoes(id) on delete cascade,
  setor_id              uuid references public.setores(id) on delete set null,
  setor_nome            text not null check (char_length(btrim(setor_nome)) between 1 and 60),
  vitima_id             uuid references public.vitimas(id) on delete cascade,      -- nulo: vale para todas as vítimas com versão vigente
  grupo_id              uuid references public.grupos(id) on delete set null,
  equipe                text not null check (char_length(btrim(equipe)) between 1 and 60),
  metodo                text not null check (char_length(btrim(metodo)) between 1 and 60),
  area_atribuida_fracao numeric(5, 4) not null default 1 check (area_atribuida_fracao > 0 and area_atribuida_fracao <= 1),
  area_texto            text not null default '' check (char_length(area_texto) <= 200),
  pod_planejada         numeric(5, 4) check (pod_planejada is null or (pod_planejada >= 0 and pod_planejada <= 1)),
  pod_planejada_base    text not null default '' check (char_length(pod_planejada_base) <= 1000),
  pod_planejada_origem  text not null default 'manual' check (pod_planejada_origem in ('manual', 'ia')),
  pod_planejada_revisor text,
  estado                text not null default 'planejada' check (estado in ('planejada', 'concluida', 'cancelada')),
  chave_cliente         text,
  criada_em             timestamptz not null default now(),
  criada_por            uuid references auth.users(id) on delete set null,
  criada_por_nome       text not null,
  cancelada_em          timestamptz,
  cancelada_por_nome    text,
  cancelada_motivo      text check (cancelada_motivo is null or char_length(cancelada_motivo) between 3 and 500),
  -- resultado e execução real
  resultado             text check (resultado is null or resultado in ('localizado', 'nao_localizado', 'nao_concluido')),
  resultado_em          timestamptz,
  resultado_por         uuid references auth.users(id) on delete set null,
  resultado_por_nome    text,
  resultado_obs         text not null default '' check (char_length(resultado_obs) <= 1000),
  inicio_real           timestamptz,
  fim_real              timestamptz,
  cobertura_real_fracao numeric(5, 4) check (cobertura_real_fracao is null or (cobertura_real_fracao > 0 and cobertura_real_fracao <= 1)),
  pod_final             numeric(5, 4) check (pod_final is null or (pod_final >= 0 and pod_final <= 1)),
  pod_final_base        text not null default '' check (char_length(pod_final_base) <= 1000),
  pod_final_origem      text not null default 'manual' check (pod_final_origem in ('manual', 'ia')),
  pod_final_revisor     text,
  calculo_estado        text not null default 'nao_aplicavel' check (calculo_estado in ('nao_aplicavel', 'pendente_pod', 'aplicado', 'inconsistente')),
  calculo_detalhe       text not null default '' check (char_length(calculo_detalhe) <= 1000),
  calculo_em            timestamptz,
  constraint busca_missoes_estado_ok check (
    ((estado = 'concluida') = (resultado is not null))
    and ((estado = 'cancelada') = (cancelada_em is not null))
    and (inicio_real is null or fim_real is null or fim_real >= inicio_real))
);
create index if not exists busca_missoes_operacao_idx on public.busca_missoes (operacao_id, criada_em);
create unique index if not exists busca_missoes_chave_unica on public.busca_missoes (operacao_id, chave_cliente) where chave_cliente is not null;

create table if not exists public.busca_missao_efeitos (
  id                uuid primary key default gen_random_uuid(),
  missao_id         uuid not null references public.busca_missoes(id) on delete cascade,
  operacao_id       uuid not null references public.operacoes(id) on delete cascade,
  vitima_id         uuid not null references public.vitimas(id) on delete cascade,
  cenario_antes_id  uuid references public.busca_cenarios(id) on delete set null,
  cenario_depois_id uuid references public.busca_cenarios(id) on delete set null,
  poa_setor_antes   numeric(7, 6) not null,
  poa_setor_depois  numeric(7, 6) not null,
  q                 numeric(7, 6) not null,                 -- POD × cobertura usada no cálculo
  pos               numeric(7, 6) not null,                 -- POA do setor (antes) × q: chance de localizar nesta busca
  z                 numeric(8, 6) not null,
  criado_em         timestamptz not null default now()
);
create index if not exists busca_missao_efeitos_missao_idx on public.busca_missao_efeitos (missao_id);

-- a versão calculada sabe de que missão veio; "calculo" é uma origem válida para os valores dela
alter table public.busca_cenarios add column if not exists missao_id uuid references public.busca_missoes(id) on delete set null;
do $$
begin
  alter table public.busca_cenarios drop constraint if exists busca_cenarios_guia_ok;
  alter table public.busca_cenarios add constraint busca_cenarios_guia_ok check (
    char_length(hipoteses) <= 2000 and char_length(limitacoes) <= 1000
    and (confianca is null or confianca in ('baixa', 'media', 'alta'))
    and origem_poa in ('julgamento_comando', 'consenso_documentado', 'modelo_validado', 'calculo_pos_busca'));
  alter table public.busca_cenarios drop constraint if exists busca_cenarios_fora_ok;
  alter table public.busca_cenarios add constraint busca_cenarios_fora_ok check (
    (poa_fora is null or (poa_fora >= 0 and poa_fora <= 1)) and poa_fora_origem in ('manual', 'ia', 'calculo') and (ia_modelo is null or char_length(ia_modelo) <= 60));
end;
$$;

alter table public.busca_missoes enable row level security;
alter table public.busca_missao_efeitos enable row level security;
drop policy if exists busca_missoes_ler on public.busca_missoes;
create policy busca_missoes_ler on public.busca_missoes for select to authenticated using (public.dono_operacao(operacao_id));
drop policy if exists busca_missao_efeitos_ler on public.busca_missao_efeitos;
create policy busca_missao_efeitos_ler on public.busca_missao_efeitos for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.busca_missoes, public.busca_missao_efeitos from anon;
revoke insert, update, delete, truncate on public.busca_missoes, public.busca_missao_efeitos from authenticated;
grant select on public.busca_missoes, public.busca_missao_efeitos to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['busca_missoes', 'busca_missao_efeitos'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_encerrada', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.bloquear_escrita_encerrada()',
                   t || '_encerrada', t);
  end loop;
end;
$$;

-- Missão: o que foi planejado não muda; o resultado entra uma vez; o POD final só é preenchido enquanto estiver pendente.
-- Efeitos: nunca mudam nem somem (só em cascata). Passam as exclusões em cascata (operação, vítima, setor).
create or replace function public.busca_missoes_proteger()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'busca_missao_efeitos' then
    raise exception 'busca_missao_imutavel';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'busca_missao_imutavel';
  end if;
  if old.estado <> 'planejada' and (
       -- depois de concluída/cancelada só o preenchimento do POD pendente e o cálculo podem mudar
       (to_jsonb(new) - array['pod_final', 'pod_final_base', 'pod_final_origem', 'pod_final_revisor', 'calculo_estado', 'calculo_detalhe', 'calculo_em'])
       is distinct from (to_jsonb(old) - array['pod_final', 'pod_final_base', 'pod_final_origem', 'pod_final_revisor', 'calculo_estado', 'calculo_detalhe', 'calculo_em'])
       or (old.estado = 'cancelada')
       or (old.calculo_estado not in ('pendente_pod') and (new.pod_final is distinct from old.pod_final))) then
    raise exception 'busca_missao_imutavel';
  end if;
  if (new.setor_nome, new.vitima_id, new.equipe, new.metodo, new.area_atribuida_fracao, new.area_texto, new.pod_planejada, new.pod_planejada_base,
      new.pod_planejada_origem, new.criada_em, new.criada_por_nome)
     is distinct from
     (old.setor_nome, old.vitima_id, old.equipe, old.metodo, old.area_atribuida_fracao, old.area_texto, old.pod_planejada, old.pod_planejada_base,
      old.pod_planejada_origem, old.criada_em, old.criada_por_nome) then
    raise exception 'busca_missao_imutavel';
  end if;
  return new;
end;
$$;
drop trigger if exists busca_missoes_proteger on public.busca_missoes;
create trigger busca_missoes_proteger before update or delete on public.busca_missoes
  for each row execute function public.busca_missoes_proteger();
drop trigger if exists busca_missao_efeitos_proteger on public.busca_missao_efeitos;
create trigger busca_missao_efeitos_proteger before update or delete on public.busca_missao_efeitos
  for each row execute function public.busca_missoes_proteger();
revoke execute on function public.busca_missoes_proteger() from public, anon, authenticated;

-- Tempo real
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['busca_missoes', 'busca_missao_efeitos'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Cálculo pós-busca (interno). Para cada vítima alcançada pela missão: lê a versão vigente (a última aprovada),
-- aplica r_j = p_j × (1 − q_j), Z = Σ r_k, p'_j = r_j / Z e grava a NOVA versão aprovada. Qualquer valor inválido
-- ou Z = 0 levanta 'busca_calculo_inconsistente' e o chamador desfaz tudo (a versão anterior fica intacta).
-- Devolve quantas vítimas tiveram nova versão.
-- ---------------------------------------------------------------------
create or replace function public.busca_missao_aplicar(p_missao uuid, p_nome text)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  m public.busca_missoes%rowtype;
  v_vit record;
  v_vig public.busca_cenarios%rowtype;
  v_novo public.busca_cenarios%rowtype;
  v_q numeric;
  v_soma numeric;
  v_fora numeric;
  v_z numeric;
  v_antes numeric;
  v_depois numeric;
  v_n integer := 0;
  v_num integer;
  v_p jsonb;
  v_fora_novo numeric;
  v_diff numeric;
  v_maior text;
  v_detalhe text;
begin
  select * into m from public.busca_missoes where id = p_missao;
  if m.setor_id is null or m.pod_final is null or m.cobertura_real_fracao is null then
    raise exception 'busca_calculo_inconsistente';
  end if;
  v_q := round(m.pod_final * m.cobertura_real_fracao, 6);
  for v_vit in
    select v.id, v.nome from public.vitimas v
     where v.operacao_id = m.operacao_id and (m.vitima_id is null or v.id = m.vitima_id)
       and not exists (select 1 from public.vitima_localizacoes l where l.vitima_id = v.id)
     order by v.criado_em, v.id
  loop
    select * into v_vig from public.busca_cenarios where vitima_id = v_vit.id and estado = 'aprovada' order by numero desc limit 1;
    if not found or not exists (select 1 from public.busca_cenario_setores where cenario_id = v_vig.id and setor_id = m.setor_id) then
      continue;   -- sem versão vigente, ou o setor não está no cenário (POA zero): não há o que atualizar
    end if;
    select coalesce(sum(poa), 0) into v_soma from public.busca_cenario_setores where cenario_id = v_vig.id;
    v_fora := coalesce(v_vig.poa_fora, 1 - v_soma);
    if v_fora < 0 or v_soma + v_fora < 0.999 or v_soma + v_fora > 1.001 then
      raise exception 'busca_calculo_inconsistente';
    end if;
    -- Z = Σ r_k, com q = 0 em tudo o que não foi pesquisado (inclusive "Fora da área")
    select coalesce(sum(s.poa * (1 - case when s.setor_id = m.setor_id then v_q else 0 end)), 0) + v_fora into v_z
      from public.busca_cenario_setores s where s.cenario_id = v_vig.id;
    if v_z is null or v_z <= 0 then
      raise exception 'busca_calculo_inconsistente';
    end if;
    select poa into v_antes from public.busca_cenario_setores where cenario_id = v_vig.id and setor_id = m.setor_id;

    -- novos valores (chave = linha da versão vigente), arredondados em 6 casas; o resíduo fecha a soma em exatamente 1
    select jsonb_object_agg(s.id::text, round(s.poa * (1 - case when s.setor_id = m.setor_id then v_q else 0 end) / v_z, 6)) into v_p
      from public.busca_cenario_setores s where s.cenario_id = v_vig.id;
    v_fora_novo := round(v_fora / v_z, 6);
    v_diff := 1 - v_fora_novo - (select sum(value::numeric) from jsonb_each_text(v_p));
    if v_diff <> 0 then
      select s.id::text into v_maior from public.busca_cenario_setores s where s.cenario_id = v_vig.id
       order by (v_p->>(s.id::text))::numeric desc, s.setor_nome limit 1;
      if (v_p->>v_maior)::numeric >= v_fora_novo then
        v_p := jsonb_set(v_p, array[v_maior], to_jsonb((v_p->>v_maior)::numeric + v_diff));
      else
        v_fora_novo := v_fora_novo + v_diff;
      end if;
    end if;
    select (v_p->>(s.id::text))::numeric into v_depois from public.busca_cenario_setores s where s.cenario_id = v_vig.id and s.setor_id = m.setor_id;

    v_num := (select max(numero) from public.busca_cenarios where vitima_id = v_vit.id) + 1;
    insert into public.busca_cenarios (operacao_id, vitima_id, numero, estado, base_numero, justificativa, hipoteses, limitacoes, confianca, origem_poa,
                                       horario_referencia, ponto_confiavel_id, ponto_confiavel, poa_fora, poa_fora_origem, missao_id,
                                       criado_por, criado_por_nome, atualizado_por_nome, aprovada_em, aprovada_por, aprovada_por_nome)
    values (m.operacao_id, v_vit.id, v_num, 'aprovada', v_vig.numero,
            left('Atualização por busca negativa: setor ' || m.setor_nome || ', equipe ' || m.equipe || ' (' || m.metodo || '), POD '
                 || trim_scale(round(m.pod_final * 100, 1))::text || '% em ' || trim_scale(round(m.cobertura_real_fracao * 100, 1))::text
                 || '% do setor. r = POA × (1 − q); novo POA = r ÷ Σr, a partir da versão ' || v_vig.numero || '.', 2000),
            v_vig.hipoteses, v_vig.limitacoes, v_vig.confianca, 'calculo_pos_busca',
            coalesce(m.fim_real, m.resultado_em, now()), v_vig.ponto_confiavel_id, v_vig.ponto_confiavel, v_fora_novo, 'calculo', m.id,
            auth.uid(), p_nome, p_nome, now(), auth.uid(), p_nome)
    returning * into v_novo;

    perform set_config('gbs.gerando_versao', 'on', true);
    insert into public.busca_cenario_setores (cenario_id, operacao_id, setor_id, setor_nome, poa, justificativa, forma, centro_lat, centro_lng, raio_m, pontos, area_m2, origem)
    select v_novo.id, s.operacao_id, s.setor_id, s.setor_nome, (v_p->>(s.id::text))::numeric,
           case when s.setor_id = m.setor_id then 'Busca negativa: POD ' || trim_scale(round(m.pod_final * 100, 1))::text || '% em ' || trim_scale(round(m.cobertura_real_fracao * 100, 1))::text || '% do setor'
                else 'Redistribuição proporcional pela busca negativa' end,
           s.forma, s.centro_lat, s.centro_lng, s.raio_m, s.pontos, s.area_m2, 'calculo'
      from public.busca_cenario_setores s where s.cenario_id = v_vig.id;
    insert into public.busca_cenario_evidencias (cenario_id, operacao_id, ponto_id, descricao, confirmada)
    select v_novo.id, e.operacao_id, e.ponto_id, e.descricao, e.confirmada from public.busca_cenario_evidencias e where e.cenario_id = v_vig.id;
    perform set_config('gbs.gerando_versao', 'off', true);

    insert into public.busca_missao_efeitos (missao_id, operacao_id, vitima_id, cenario_antes_id, cenario_depois_id, poa_setor_antes, poa_setor_depois, q, pos, z)
    values (m.id, m.operacao_id, v_vit.id, v_vig.id, v_novo.id, v_antes, v_depois, v_q, round(v_antes * v_q, 6), round(v_z, 6));

    select string_agg(s.setor_nome || ': ' || trim_scale(round(s.poa * 100, 1))::text || '%', ' · ' order by s.poa desc, s.setor_nome) into v_detalhe
      from public.busca_cenario_setores s where s.cenario_id = v_novo.id;
    perform public.diario_auto(m.operacao_id, now(), 'pessoa', 'cenario_pos_busca',
      'POA atualizado após busca negativa: ' || v_vit.nome || ' (versão ' || v_num || ')',
      'Missão no setor ' || m.setor_nome || ' (' || m.equipe || '): POS ' || trim_scale(round(v_antes * v_q * 100, 1))::text || '% (POA ' || trim_scale(round(v_antes * 100, 1))::text
        || '% × POD ' || trim_scale(round(v_q * 100, 1))::text || '%). Novo POA — ' || coalesce(v_detalhe, '') || ' · fora da área: ' || trim_scale(round(v_fora_novo * 100, 1))::text || '%.',
      'poa-pos:' || m.id || ':' || v_vit.id, 'info', null, null, v_novo.id::text, p_nome);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Tenta o cálculo e devolve (estado, detalhe). Falha = nada muda e o motivo fica na missão.
create or replace function public.busca_missao_calcular(p_missao uuid, p_nome text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  begin
    v_n := public.busca_missao_aplicar(p_missao, p_nome);
  exception when others then
    return json_build_object('estado', 'inconsistente',
      'detalhe', case when sqlerrm like '%busca_calculo_inconsistente%'
                      then 'Inconsistência: Z = Σ r = 0 ou valores inválidos na versão vigente. Nada foi alterado.' else 'Não foi possível calcular: ' || left(sqlerrm, 200) || '. Nada foi alterado.' end);
  end;
  if v_n > 0 then
    return json_build_object('estado', 'aplicado', 'detalhe', 'Nova versão do cenário para ' || v_n || ' vítima(s).');
  end if;
  return json_build_object('estado', 'nao_aplicavel', 'detalhe', 'Nenhuma vítima com versão vigente que inclua este setor: o POA não mudou.');
end;
$$;

-- ---------------------------------------------------------------------
-- Criar a missão.
--   p_dados: setor_id, vitima_id (opcional), grupo_id (opcional), equipe, metodo, area_fracao (0 a 1; padrão 1), area_texto,
--            pod (0 a 1; vazio = NÃO ESTIMADA), pod_base (em que se baseia; obrigatório se há POD), pod_origem ('manual'|'ia'), chave_cliente
-- ---------------------------------------------------------------------
create or replace function public.busca_missao_criar(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_status text;
  v_setor public.setores%rowtype;
  v_setor_id uuid;
  v_vitima uuid;
  v_grupo uuid;
  v_equipe text;
  v_metodo text;
  v_area numeric;
  v_area_txt text;
  v_pod numeric;
  v_base text;
  v_origem text;
  v_chave text;
  v_ex public.busca_missoes%rowtype;
  m public.busca_missoes%rowtype;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  begin
    v_setor_id := (p_dados->>'setor_id')::uuid;
    v_vitima := nullif(p_dados->>'vitima_id', '')::uuid;
    v_grupo := nullif(p_dados->>'grupo_id', '')::uuid;
    v_area := coalesce(nullif(p_dados->>'area_fracao', '')::numeric, 1);
    v_pod := nullif(p_dados->>'pod', '')::numeric;
  exception when others then
    raise exception 'dados_invalidos';
  end;
  select * into v_setor from public.setores where id = v_setor_id and operacao_id = p_operacao;
  if not found then
    raise exception 'setor_nao_encontrado';
  end if;
  if v_vitima is not null and not exists (select 1 from public.vitimas where id = v_vitima and operacao_id = p_operacao) then
    raise exception 'dados_invalidos';
  end if;
  if v_vitima is not null and exists (select 1 from public.vitima_localizacoes where vitima_id = v_vitima) then
    raise exception 'cenario_vitima_localizada';
  end if;
  if v_grupo is not null and not exists (select 1 from public.grupos where id = v_grupo and operacao_id = p_operacao) then
    raise exception 'dados_invalidos';
  end if;
  v_equipe := left(btrim(coalesce(nullif(btrim(p_dados->>'equipe'), ''), (select nome from public.grupos where id = v_grupo), '')), 60);
  v_metodo := left(btrim(coalesce(p_dados->>'metodo', '')), 60);
  if v_equipe = '' then
    raise exception 'busca_missao_equipe_obrigatoria';
  end if;
  if v_metodo = '' then
    raise exception 'busca_missao_metodo_obrigatorio';
  end if;
  if v_area <= 0 or v_area > 1 then
    raise exception 'busca_cobertura_invalida';
  end if;
  v_area_txt := left(btrim(coalesce(p_dados->>'area_texto', '')), 200);
  v_base := left(btrim(coalesce(p_dados->>'pod_base', '')), 1000);
  v_origem := coalesce(nullif(p_dados->>'pod_origem', ''), 'manual');
  if v_origem not in ('manual', 'ia') or (v_pod is not null and (v_pod < 0 or v_pod > 1)) then
    raise exception 'dados_invalidos';
  end if;
  if v_pod is not null and char_length(v_base) < 5 then
    raise exception 'busca_pod_sem_base';
  end if;
  v_chave := left(nullif(btrim(coalesce(p_dados->>'chave_cliente', '')), ''), 80);
  if v_chave is not null then
    select * into v_ex from public.busca_missoes where operacao_id = p_operacao and chave_cliente = v_chave;
    if found then
      if v_ex.setor_id is distinct from v_setor_id or v_ex.metodo <> v_metodo or v_ex.equipe <> v_equipe or v_ex.pod_planejada is distinct from round(v_pod, 4) then
        raise exception 'busca_chave_reutilizada';
      end if;
      return json_build_object('missao', row_to_json(v_ex), 'repetida', true);
    end if;
  end if;

  insert into public.busca_missoes (operacao_id, setor_id, setor_nome, vitima_id, grupo_id, equipe, metodo, area_atribuida_fracao, area_texto,
                                    pod_planejada, pod_planejada_base, pod_planejada_origem, pod_planejada_revisor, chave_cliente, criada_por, criada_por_nome)
  values (p_operacao, v_setor.id, v_setor.nome, v_vitima, v_grupo, v_equipe, v_metodo, round(v_area, 4), v_area_txt,
          round(v_pod, 4), case when v_pod is null then '' else v_base end, v_origem, case when v_origem = 'ia' and v_pod is not null then v_nome end, v_chave, auth.uid(), v_nome)
  returning * into m;
  perform public.diario_auto(p_operacao, m.criada_em, 'setor', 'busca_missao_criada',
    'Missão de busca planejada: ' || m.setor_nome || ' (' || m.equipe || ')',
    'Método: ' || m.metodo || '. Área atribuída: ' || trim_scale(round(m.area_atribuida_fracao * 100, 1))::text || '% do setor' || case when m.area_texto <> '' then ' (' || m.area_texto || ')' else '' end
      || '. ' || case when m.pod_planejada is null then 'POD não estimada.' else 'POD estimada ' || trim_scale(round(m.pod_planejada * 100, 1))::text || '%'
        || case when m.pod_planejada_origem = 'ia' then ' (sugerido por IA, revisado por ' || v_nome || ')' else '' end || '.' end,
    'missao-busca:' || m.id, 'info', null, null, m.id::text, v_nome);
  return json_build_object('missao', row_to_json(m), 'repetida', false);
end;
$$;

-- ---------------------------------------------------------------------
-- Registrar o resultado, depois do retorno da equipe. Uma vez só (não se edita).
--   p_dados: resultado ('localizado'|'nao_localizado'|'nao_concluido'), cobertura (0 a 1: execução real; padrão = área atribuída
--            na busca negativa), inicio_real, fim_real, observacao, pod (POD final; vazio = o planejado), pod_base, pod_origem
--   Busca negativa com POD conhecido → recalcula e grava nova versão. POD desconhecido → fica pendente. Z = 0 → inconsistente.
-- ---------------------------------------------------------------------
create or replace function public.busca_missao_resultado(p_missao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  m public.busca_missoes%rowtype;
  v_status text;
  v_res text;
  v_cob numeric;
  v_ini timestamptz;
  v_fim timestamptz;
  v_pod numeric;
  v_base text;
  v_origem text;
  v_pod_final numeric;
  v_base_final text;
  v_origem_final text;
  v_revisor text;
  v_obs text;
  v_calc json;
  v_estado text;
  v_detalhe text;
begin
  select * into m from public.busca_missoes where id = p_missao for update;
  if not found then
    raise exception 'busca_missao_inexistente';
  end if;
  if v_nome is null or not public.dono_operacao(m.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = m.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if m.estado <> 'planejada' then
    raise exception 'busca_missao_nao_planejada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  v_res := p_dados->>'resultado';
  if v_res is null or v_res not in ('localizado', 'nao_localizado', 'nao_concluido') then
    raise exception 'busca_missao_resultado_invalido';
  end if;
  begin
    v_cob := nullif(p_dados->>'cobertura', '')::numeric;
    v_ini := nullif(p_dados->>'inicio_real', '')::timestamptz;
    v_fim := nullif(p_dados->>'fim_real', '')::timestamptz;
    v_pod := nullif(p_dados->>'pod', '')::numeric;
  exception when others then
    raise exception 'dados_invalidos';
  end;
  if (v_cob is not null and (v_cob <= 0 or v_cob > 1)) or (v_pod is not null and (v_pod < 0 or v_pod > 1)) then
    raise exception 'busca_cobertura_invalida';
  end if;
  if (v_ini is not null and v_fim is not null and v_fim < v_ini) or (v_fim is not null and v_fim > now() + interval '10 minutes')
     or (v_ini is not null and v_ini > now() + interval '10 minutes') then
    raise exception 'dados_invalidos';
  end if;
  v_obs := left(btrim(coalesce(p_dados->>'observacao', '')), 1000);
  v_base := left(btrim(coalesce(p_dados->>'pod_base', '')), 1000);
  v_origem := coalesce(nullif(p_dados->>'pod_origem', ''), 'manual');
  if v_origem not in ('manual', 'ia') then
    raise exception 'dados_invalidos';
  end if;
  if v_pod is not null and char_length(v_base) < 5 then
    raise exception 'busca_pod_sem_base';
  end if;
  -- negativa: a execução real (cobertura) é a informada, ou a atribuída
  if v_res = 'nao_localizado' then
    v_cob := coalesce(v_cob, m.area_atribuida_fracao);
  end if;
  -- POD final: o informado agora, senão o planejado; nunca zero por omissão
  v_pod_final := coalesce(v_pod, m.pod_planejada);
  v_base_final := case when v_pod is not null then v_base else m.pod_planejada_base end;
  v_origem_final := case when v_pod is not null then v_origem else m.pod_planejada_origem end;
  v_revisor := case when v_origem_final = 'ia' and v_pod_final is not null then v_nome end;

  if v_res = 'localizado' then
    v_estado := 'nao_aplicavel'; v_detalhe := 'Vítima localizada: registre o encontro em "Vítima encontrada". O POA não é recalculado.';
  elsif v_cob is null then
    v_estado := 'nao_aplicavel'; v_detalhe := 'Busca não concluída sem cobertura informada: não altera o POA.';
  elsif v_pod_final is null then
    v_estado := 'pendente_pod'; v_detalhe := 'POD não estimada: informe o POD desta missão para recalcular o POA.';
  end if;

  update public.busca_missoes
     set estado = 'concluida', resultado = v_res, resultado_em = now(), resultado_por = auth.uid(), resultado_por_nome = v_nome, resultado_obs = v_obs,
         inicio_real = v_ini, fim_real = v_fim, cobertura_real_fracao = round(v_cob, 4),
         pod_final = round(v_pod_final, 4), pod_final_base = coalesce(v_base_final, ''), pod_final_origem = v_origem_final, pod_final_revisor = v_revisor,
         calculo_estado = coalesce(v_estado, 'nao_aplicavel'), calculo_detalhe = coalesce(v_detalhe, ''), calculo_em = now()
   where id = m.id
   returning * into m;
  if v_estado is null then
    v_calc := public.busca_missao_calcular(m.id, v_nome);
    update public.busca_missoes set calculo_estado = v_calc->>'estado', calculo_detalhe = v_calc->>'detalhe', calculo_em = now() where id = m.id returning * into m;
  end if;
  perform public.diario_auto(m.operacao_id, m.resultado_em, 'setor', 'busca_missao_resultado',
    'Resultado da missão de busca: ' || m.setor_nome || ' (' || m.equipe || ') — ' || case m.resultado when 'localizado' then 'localizado' when 'nao_localizado' then 'não localizado' else 'não concluído' end,
    'Execução real: ' || coalesce(trim_scale(round(m.cobertura_real_fracao * 100, 1))::text || '% do setor', 'cobertura não informada')
      || '. ' || case when m.pod_final is null then 'POD não estimada.' else 'POD ' || trim_scale(round(m.pod_final * 100, 1))::text || '%'
        || case when m.pod_final_origem = 'ia' then ' (sugerido por IA, revisado por ' || v_nome || ')' else '' end || '.' end
      || ' ' || m.calculo_detalhe || case when m.resultado_obs <> '' then ' Obs.: ' || m.resultado_obs else '' end,
    'missao-busca-res:' || m.id, case when m.resultado = 'localizado' then 'critico' else 'info' end, null, null, m.id::text, v_nome);
  return json_build_object('missao', row_to_json(m),
    'efeitos', coalesce((select json_agg(row_to_json(e)) from public.busca_missao_efeitos e where e.missao_id = m.id), '[]'::json));
end;
$$;

-- ---------------------------------------------------------------------
-- Informar o POD que faltava (uma vez): recalcula. Só para missão concluída com POD pendente.
-- ---------------------------------------------------------------------
create or replace function public.busca_missao_definir_pod(p_missao uuid, p_pod numeric, p_base text, p_origem text default 'manual')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  m public.busca_missoes%rowtype;
  v_status text;
  v_calc json;
begin
  select * into m from public.busca_missoes where id = p_missao for update;
  if not found then
    raise exception 'busca_missao_inexistente';
  end if;
  if v_nome is null or not public.dono_operacao(m.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = m.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if m.estado <> 'concluida' or m.calculo_estado <> 'pendente_pod' then
    raise exception 'busca_missao_pod_nao_pendente';
  end if;
  if p_pod is null or p_pod < 0 or p_pod > 1 or coalesce(p_origem, 'manual') not in ('manual', 'ia') then
    raise exception 'dados_invalidos';
  end if;
  if char_length(btrim(coalesce(p_base, ''))) < 5 then
    raise exception 'busca_pod_sem_base';
  end if;
  update public.busca_missoes
     set pod_final = round(p_pod, 4), pod_final_base = left(btrim(p_base), 1000), pod_final_origem = coalesce(p_origem, 'manual'),
         pod_final_revisor = case when coalesce(p_origem, 'manual') = 'ia' then v_nome end
   where id = m.id returning * into m;
  v_calc := public.busca_missao_calcular(m.id, v_nome);
  update public.busca_missoes set calculo_estado = v_calc->>'estado', calculo_detalhe = v_calc->>'detalhe', calculo_em = now() where id = m.id returning * into m;
  perform public.diario_auto(m.operacao_id, now(), 'setor', 'busca_missao_pod',
    'POD informado na missão de busca: ' || m.setor_nome || ' (' || m.equipe || ')',
    'POD ' || trim_scale(round(m.pod_final * 100, 1))::text || '%' || case when m.pod_final_origem = 'ia' then ' (sugerido por IA, revisado por ' || v_nome || ')' else '' end || '. ' || m.calculo_detalhe,
    'missao-busca-pod:' || m.id, 'info', null, null, m.id::text, v_nome);
  return json_build_object('missao', row_to_json(m),
    'efeitos', coalesce((select json_agg(row_to_json(e)) from public.busca_missao_efeitos e where e.missao_id = m.id), '[]'::json));
end;
$$;

-- ---------------------------------------------------------------------
-- Cancelar uma missão que ainda não tem resultado (com o motivo). Fica no histórico.
-- ---------------------------------------------------------------------
create or replace function public.busca_missao_cancelar(p_missao uuid, p_motivo text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  m public.busca_missoes%rowtype;
  v_status text;
  v_motivo text := btrim(coalesce(p_motivo, ''));
begin
  select * into m from public.busca_missoes where id = p_missao for update;
  if not found then
    raise exception 'busca_missao_inexistente';
  end if;
  if v_nome is null or not public.dono_operacao(m.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = m.operacao_id;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if m.estado <> 'planejada' then
    raise exception 'busca_missao_nao_planejada';
  end if;
  if char_length(v_motivo) < 3 then
    raise exception 'busca_missao_cancelamento_sem_motivo';
  end if;
  update public.busca_missoes set estado = 'cancelada', cancelada_em = now(), cancelada_por_nome = v_nome, cancelada_motivo = left(v_motivo, 500)
   where id = m.id returning * into m;
  perform public.diario_auto(m.operacao_id, m.cancelada_em, 'setor', 'busca_missao_cancelada',
    'Missão de busca cancelada: ' || m.setor_nome || ' (' || m.equipe || ')', 'Motivo: ' || m.cancelada_motivo,
    'missao-busca-canc:' || m.id, 'info', null, null, m.id::text, v_nome);
  return json_build_object('missao', row_to_json(m));
end;
$$;

revoke execute on function public.busca_missao_aplicar(uuid, text), public.busca_missao_calcular(uuid, text) from public, anon, authenticated;
revoke execute on function public.busca_missao_criar(uuid, jsonb), public.busca_missao_resultado(uuid, jsonb),
  public.busca_missao_definir_pod(uuid, numeric, text, text), public.busca_missao_cancelar(uuid, text) from public, anon;
grant execute on function public.busca_missao_criar(uuid, jsonb), public.busca_missao_resultado(uuid, jsonb),
  public.busca_missao_definir_pod(uuid, numeric, text, text), public.busca_missao_cancelar(uuid, text) to authenticated;

-- =====================================================================
-- 46. Criar operação: aceita a retenção de 90 dias (2160 h) que o painel já envia
--     (migração 040 — idempotente; exige a 022 e a 027)
--
--  O painel passou a enviar 2160 h (dados guardados até a exclusão, migração 027), mas a função
--  criar_operacao ainda aceitava só 0, 24, 72, 168 e 720. Resultado: "Política de retenção inválida"
--  ao criar qualquer operação. Esta versão aceita 2160 também; o resto da função não muda.
-- =====================================================================
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
  if p_retencao_horas is null or p_retencao_horas not in (0, 24, 72, 168, 720, 2160) then
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
  end if;
  -- cadastro inicial: o tipo fica para depois, e o início das operações é automático (a hora da criação)
  v_op.acionado_em := coalesce(v_op.acionado_em, now());

  insert into public.operacoes (codigo, responsavel_id, token_civil, token_militar, retencao_horas,
                                tipo, tipo_outro, acionado_em, local_endereco, local_lat, local_lng, descricao, ipo)
  values (v_op.codigo, auth.uid(), public.gerar_token(), public.gerar_token(), p_retencao_horas,
          v_op.tipo, v_op.tipo_outro, v_op.acionado_em, v_op.local_endereco, v_op.local_lat, v_op.local_lng,
          coalesce(v_op.descricao, ''), v_ipo)
  returning * into v_op;

  return row_to_json(v_op);
end;
$$;

-- =====================================================================
-- 48. Proveniência e incerteza, binômio (cão e condutor), drone e água
--     (migração 042 — idempotente; exige a 007, a 012, a 026 e a 028)
--
--  1. Revisão de relatos (relato_revisoes): cada relato do campo (objeto, vestígio, pista…) ganha um estado de
--     revisão — pendente, em análise, confirmado, descartado, inconclusivo ou contestado — com justificativa,
--     o momento do fato (e de onde ele vem: GPS do aparelho, informado, estimado ou desconhecido), quem revisou e
--     quando. Cada revisão é uma VERSÃO nova (nada é sobrescrito). Fica numa tabela à parte: o participante que
--     relatou continua lendo a própria mensagem, mas nunca vê a revisão interna.
--     Três tempos de um relato: fato (fato_em ou a hora do GPS), recebimento (mensagens.criada_em) e
--     registro/revisão (relato_revisoes.revisado_em).
--  2. Incerteza: a idade da vítima pode ser marcada como estimada (vitimas.idade_qualidade). Idade vazia
--     continua sendo "não informada", nunca zero.
--  3. Binômio: sessão de busca com cão ligada a um setor (binomio_sessoes) com início, pausas, retomada e fim,
--     artigo de odor (origem e manipulação) e condições; eventos da sessão (binomio_eventos): INDICAÇÃO do cão
--     (sempre "em análise") e CONFIRMAÇÃO por método independente (ligada a uma indicação, começa "pendente").
--     Indicação não é confirmação. GPS do condutor = o participante escolhido; GPS do cão é série separada
--     (sem dispositivo, por enquanto).
--  4. Drone e água (observacoes_campo): plano de voo, telemetria importada, área observada, foco térmico e
--     indicação aquática (posição, possível área de origem, corrente, vento e condições), cada um com fonte,
--     estado e nota. Plano não prova voo; foco térmico não é vítima; corrente desconhecida é um valor válido.
--  Leitura só pelos responsáveis da operação; escrita só pelas funções; encerrada: somente leitura.
-- =====================================================================

/* ---------- 1. Revisão de relatos ---------- */
create table if not exists public.relato_revisoes (
  id                 uuid primary key default gen_random_uuid(),
  operacao_id        uuid not null references public.operacoes(id) on delete cascade,
  mensagem_id        uuid not null references public.mensagens(id) on delete cascade,
  versao             integer not null check (versao >= 1),
  estado             text not null check (estado in ('pendente', 'em_analise', 'confirmado', 'descartado', 'inconclusivo', 'contestado')),
  nota               text not null default '' check (char_length(nota) <= 500),
  fato_em            timestamptz,
  fato_origem        text check (fato_origem is null or fato_origem in ('gps', 'informado', 'estimado', 'desconhecido')),
  revisado_por       uuid references auth.users(id) on delete set null,
  revisado_por_nome  text not null,
  revisado_em        timestamptz not null default now(),
  unique (mensagem_id, versao)
);
create index if not exists relato_revisoes_operacao_idx on public.relato_revisoes (operacao_id);

alter table public.relato_revisoes enable row level security;
drop policy if exists relato_revisoes_ler on public.relato_revisoes;
create policy relato_revisoes_ler on public.relato_revisoes for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.relato_revisoes from anon;
revoke insert, update, delete, truncate on public.relato_revisoes from authenticated;
grant select on public.relato_revisoes to authenticated;
drop trigger if exists relato_revisoes_encerrada on public.relato_revisoes;
create trigger relato_revisoes_encerrada before insert or update or delete on public.relato_revisoes
  for each row execute function public.bloquear_escrita_encerrada();

create or replace function public.revisao_rotulo(p_estado text)
returns text
language sql immutable
as $$
  select case p_estado when 'pendente' then 'pendente' when 'em_analise' then 'em análise' when 'confirmado' then 'confirmado'
                       when 'descartado' then 'descartado' when 'inconclusivo' then 'inconclusivo' when 'contestado' then 'contestado'
                       else coalesce(p_estado, '') end;
$$;

-- Nova versão da revisão de um relato. Confirmar, descartar, contestar e "inconclusivo" exigem justificativa
-- (como foi verificado / por que não vale). p_fato_em: quando o fato aconteceu (opcional), com a origem da hora.
create or replace function public.revisar_relato(p_mensagem uuid, p_estado text, p_nota text, p_fato_em timestamptz default null, p_fato_origem text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_m public.mensagens%rowtype;
  v_op public.operacoes%rowtype;
  v_nota text := left(btrim(coalesce(p_nota, '')), 500);
  v_origem text := nullif(btrim(coalesce(p_fato_origem, '')), '');
  r public.relato_revisoes%rowtype;
begin
  select * into v_m from public.mensagens where id = p_mensagem;
  if not found or v_m.direcao <> 'entrada' or v_m.categoria is null then
    raise exception 'relato_nao_encontrado';
  end if;
  if v_nome is null or not public.dono_operacao(v_m.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = v_m.operacao_id;
  if v_op.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_estado is null or p_estado not in ('pendente', 'em_analise', 'confirmado', 'descartado', 'inconclusivo', 'contestado') then
    raise exception 'dados_invalidos';
  end if;
  if p_estado in ('confirmado', 'descartado', 'inconclusivo', 'contestado') and v_nota = '' then
    raise exception 'justificativa_obrigatoria';
  end if;
  if v_origem is not null and v_origem not in ('gps', 'informado', 'estimado', 'desconhecido') then
    raise exception 'dados_invalidos';
  end if;
  if p_fato_em is not null and (p_fato_em > now() + interval '5 minutes' or p_fato_em < v_op.criada_em - interval '30 days') then
    raise exception 'data_invalida';
  end if;

  perform 1 from public.mensagens where id = p_mensagem for update;   -- versões em ordem, mesmo com dois responsáveis
  r.id := gen_random_uuid();
  r.operacao_id := v_m.operacao_id;
  r.mensagem_id := p_mensagem;
  r.versao := coalesce((select max(versao) from public.relato_revisoes where mensagem_id = p_mensagem), 0) + 1;
  r.estado := p_estado;
  r.nota := v_nota;
  r.fato_em := p_fato_em;
  r.fato_origem := case when p_fato_em is null and v_origem is distinct from 'desconhecido' then null else coalesce(v_origem, 'informado') end;
  r.revisado_por := auth.uid();
  r.revisado_por_nome := v_nome;
  r.revisado_em := now();
  insert into public.relato_revisoes select r.*;

  perform public.diario_auto(v_m.operacao_id, now(), 'encontro', 'relato_revisado',
    'Relato de ' || v_m.remetente_nome || ' (' || lower(v_m.categoria) || '): ' || public.revisao_rotulo(p_estado),
    concat_ws(' · ', nullif(v_nota, ''), case when p_fato_em is not null then 'fato às ' || to_char(p_fato_em at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') ||
      case r.fato_origem when 'estimado' then ' (estimado)' when 'informado' then ' (informado)' else '' end end,
      'versão ' || r.versao),
    'relato_revisado:' || p_mensagem || ':' || r.versao, 'info', v_m.lat, v_m.lng, p_mensagem::text, v_nome);
  return row_to_json(r);
end;
$$;

revoke execute on function public.revisao_rotulo(text) from public, anon, authenticated;
revoke execute on function public.revisar_relato(uuid, text, text, timestamptz, text) from public, anon;
grant execute on function public.revisar_relato(uuid, text, text, timestamptz, text) to authenticated;

/* ---------- 2. Idade da vítima: informada ou estimada ---------- */
alter table public.vitimas add column if not exists idade_qualidade text;
do $$
begin
  alter table public.vitimas add constraint vitimas_idade_qualidade_ok check (idade_qualidade is null or idade_qualidade in ('informada', 'estimada'));
exception when duplicate_object then null;
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
    v.perfil := '{}';
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
  if p_dados ? 'perfil' then
    if jsonb_typeof(p_dados->'perfil') <> 'array' then
      raise exception 'dados_invalidos';
    end if;
    v.perfil := array(select jsonb_array_elements_text(p_dados->'perfil'));
  end if;
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
  if p_dados ? 'idade_qualidade' then v.idade_qualidade := nullif(btrim(coalesce(p_dados->>'idade_qualidade', '')), ''); end if;
  if v.idade is null then v.idade_qualidade := null; end if;   -- sem idade não há qualidade: é "não informada"

  if v.nome is null or char_length(v.nome) not between 1 and 80 then
    raise exception 'nome_vitima_invalido';
  end if;
  if char_length(v.caracteristicas) > 1000 or char_length(v.roupas) > 1000 or char_length(v.observacoes) > 2000 then
    raise exception 'dados_invalidos';
  end if;
  if (v.sexo is not null and v.sexo not in ('M', 'F')) or char_length(coalesce(v.nascimento, '')) > 20 or char_length(coalesce(v.origem, '')) > 120 then
    raise exception 'dados_invalidos';
  end if;
  if v.idade_qualidade is not null and v.idade_qualidade not in ('informada', 'estimada') then
    raise exception 'dados_invalidos';
  end if;

  if not (v.perfil <@ array['idoso', 'crianca', 'adolescente', 'demencia', 'autismo', 'deficiencia_intelectual', 'transtorno_mental', 'outro']::text[]) then
    raise exception 'dados_invalidos';
  end if;
  v.atualizado_em := now();
  v.atualizado_por_nome := v_nome_resp;
  if p_id is null then
    insert into public.vitimas select v.*;
  else
    update public.vitimas set nome = v.nome, idade = v.idade, idade_qualidade = v.idade_qualidade, caracteristicas = v.caracteristicas, roupas = v.roupas,
           observacoes = v.observacoes, perfil = v.perfil, nascimento = v.nascimento, sexo = v.sexo, origem = v.origem, atualizado_em = v.atualizado_em, atualizado_por_nome = v.atualizado_por_nome
     where id = v.id;
  end if;
  return row_to_json(v);
end;
$$;

/* ---------- 3. Binômio: sessão de busca com cão ---------- */
create table if not exists public.binomio_sessoes (
  id                        uuid primary key default gen_random_uuid(),
  operacao_id               uuid not null references public.operacoes(id) on delete cascade,
  setor_id                  uuid references public.setores(id) on delete set null,
  condutor_participante_id  uuid references public.participantes(id) on delete set null,
  condutor_nome             text not null default '' check (char_length(condutor_nome) <= 80),
  cao_nome                  text not null check (char_length(btrim(cao_nome)) between 1 and 60),
  cao_gps                   text not null default 'sem_dispositivo' check (cao_gps in ('sem_dispositivo', 'coleira_externa')),
  artigo_odor               text not null default '' check (char_length(artigo_odor) <= 200),
  artigo_origem             text not null default '' check (char_length(artigo_origem) <= 200),
  artigo_manipulacao        text not null default '' check (char_length(artigo_manipulacao) <= 200),
  condicoes                 text not null default '' check (char_length(condicoes) <= 500),
  estado                    text not null default 'planejada' check (estado in ('planejada', 'em_andamento', 'pausada', 'finalizada')),
  iniciada_em               timestamptz,
  finalizada_em             timestamptz,
  pausas                    jsonb not null default '[]'::jsonb,
  criado_por_nome           text not null,
  criado_em                 timestamptz not null default now(),
  atualizado_em             timestamptz not null default now(),
  atualizado_por_nome       text
);
create index if not exists binomio_sessoes_operacao_idx on public.binomio_sessoes (operacao_id);

create table if not exists public.binomio_eventos (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  sessao_id           uuid not null references public.binomio_sessoes(id) on delete cascade,
  tipo                text not null check (tipo in ('indicacao', 'confirmacao')),
  codigo              text not null,
  ocorrido_em         timestamptz not null,
  lat                 double precision check (lat between -90 and 90),
  lng                 double precision check (lng between -180 and 180),
  precisao            real,
  descricao           text not null default '' check (char_length(descricao) <= 500),
  metodo              text not null default '' check (char_length(metodo) <= 80),
  estado              text not null check (estado in ('em_analise', 'pendente', 'confirmada', 'descartada', 'inconclusiva')),
  relacionado_a       uuid references public.binomio_eventos(id) on delete set null,
  registrado_por_nome text not null,
  registrado_em       timestamptz not null default now(),
  revisao_nota        text not null default '' check (char_length(revisao_nota) <= 500),
  revisado_por_nome   text,
  revisado_em         timestamptz,
  check ((lat is null) = (lng is null))
);
create index if not exists binomio_eventos_sessao_idx on public.binomio_eventos (sessao_id);
create index if not exists binomio_eventos_operacao_idx on public.binomio_eventos (operacao_id);

/* ---------- 4. Drone e água: observações com origem ---------- */
create table if not exists public.observacoes_campo (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  modalidade          text not null check (modalidade in ('drone', 'aquatica')),
  tipo                text not null check (tipo in ('plano_voo', 'telemetria', 'area_observada', 'foco_termico', 'indicacao_aquatica')),
  titulo              text not null check (char_length(btrim(titulo)) between 1 and 80),
  estado              text not null check (estado in ('planejado', 'registrado', 'a_verificar', 'verificado', 'descartado', 'inconclusivo')),
  geometria           jsonb,
  dados               jsonb not null default '{}'::jsonb check (jsonb_typeof(dados) = 'object' and length(dados::text) <= 20000),
  fonte               text not null default '' check (char_length(fonte) <= 120),
  observado_em        timestamptz,
  nota                text not null default '' check (char_length(nota) <= 500),
  registrado_por_nome text not null,
  registrado_em       timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text
);
create index if not exists observacoes_campo_operacao_idx on public.observacoes_campo (operacao_id);

do $$
declare
  t text;
begin
  foreach t in array array['binomio_sessoes', 'binomio_eventos', 'observacoes_campo'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_ler', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.dono_operacao(operacao_id))', t || '_ler', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop trigger if exists %I on public.%I', t || '_encerrada', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.bloquear_escrita_encerrada()', t || '_encerrada', t);
  end loop;
end;
$$;

-- Validação de uma geometria: { tipo: 'ponto' | 'linha' | 'area', pts: [[lat, lng], …] } (até 5000 pontos)
create or replace function public.geometria_valida(p jsonb)
returns boolean
language plpgsql immutable set search_path = public
as $$
declare
  v_pt jsonb;
  v_n integer;
begin
  if p is null then return true; end if;
  if jsonb_typeof(p) <> 'object' or coalesce(p->>'tipo', '') not in ('ponto', 'linha', 'area') or jsonb_typeof(p->'pts') <> 'array' then
    return false;
  end if;
  v_n := jsonb_array_length(p->'pts');
  if v_n < 1 or v_n > 5000 or (p->>'tipo' = 'ponto' and v_n <> 1) or (p->>'tipo' = 'linha' and v_n < 2) or (p->>'tipo' = 'area' and v_n < 3) then
    return false;
  end if;
  for v_pt in select * from jsonb_array_elements(p->'pts') loop
    if jsonb_typeof(v_pt) <> 'array' or jsonb_array_length(v_pt) <> 2 or jsonb_typeof(v_pt->0) <> 'number' or jsonb_typeof(v_pt->1) <> 'number'
       or (v_pt->>0)::double precision not between -90 and 90 or (v_pt->>1)::double precision not between -180 and 180 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- Sessão do binômio: cria ou edita (cão, condutor, setor, artigo de odor e condições).
create or replace function public.salvar_binomio_sessao(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v public.binomio_sessoes%rowtype;
  v_op public.operacoes%rowtype;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if v_op.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  if p_id is null then
    v.id := gen_random_uuid();
    v.operacao_id := p_operacao;
    v.estado := 'planejada';
    v.pausas := '[]'::jsonb;
    v.cao_gps := 'sem_dispositivo';
    v.condutor_nome := ''; v.artigo_odor := ''; v.artigo_origem := ''; v.artigo_manipulacao := ''; v.condicoes := '';
    v.criado_por_nome := v_nome;
    v.criado_em := now();
  else
    select * into v from public.binomio_sessoes where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'sessao_nao_encontrada';
    end if;
  end if;
  if p_dados ? 'cao_nome' then v.cao_nome := btrim(regexp_replace(coalesce(p_dados->>'cao_nome', ''), '\s+', ' ', 'g')); end if;
  if p_dados ? 'cao_gps' then v.cao_gps := coalesce(nullif(p_dados->>'cao_gps', ''), 'sem_dispositivo'); end if;
  if p_dados ? 'condutor_nome' then v.condutor_nome := left(btrim(coalesce(p_dados->>'condutor_nome', '')), 80); end if;
  if p_dados ? 'artigo_odor' then v.artigo_odor := left(btrim(coalesce(p_dados->>'artigo_odor', '')), 200); end if;
  if p_dados ? 'artigo_origem' then v.artigo_origem := left(btrim(coalesce(p_dados->>'artigo_origem', '')), 200); end if;
  if p_dados ? 'artigo_manipulacao' then v.artigo_manipulacao := left(btrim(coalesce(p_dados->>'artigo_manipulacao', '')), 200); end if;
  if p_dados ? 'condicoes' then v.condicoes := left(btrim(coalesce(p_dados->>'condicoes', '')), 500); end if;
  begin
    if p_dados ? 'setor_id' then v.setor_id := nullif(p_dados->>'setor_id', '')::uuid; end if;
    if p_dados ? 'condutor_participante_id' then v.condutor_participante_id := nullif(p_dados->>'condutor_participante_id', '')::uuid; end if;
  exception when invalid_text_representation then
    raise exception 'dados_invalidos';
  end;
  if v.setor_id is not null and not exists (select 1 from public.setores where id = v.setor_id and operacao_id = p_operacao) then
    raise exception 'setor_nao_encontrado';
  end if;
  if v.condutor_participante_id is not null and not exists (select 1 from public.participantes where id = v.condutor_participante_id and operacao_id = p_operacao) then
    raise exception 'participante_invalido';
  end if;
  if v.cao_nome is null or char_length(v.cao_nome) not between 1 and 60 or v.cao_gps not in ('sem_dispositivo', 'coleira_externa') then
    raise exception 'dados_invalidos';
  end if;
  v.atualizado_em := now();
  v.atualizado_por_nome := v_nome;
  if p_id is null then
    insert into public.binomio_sessoes select v.*;
    perform public.diario_auto(p_operacao, now(), 'setor', 'binomio_sessao',
      'Binômio: sessão do cão ' || v.cao_nome || ' criada' || coalesce(' no setor ' || (select nome from public.setores where id = v.setor_id), ''),
      concat_ws(' · ', nullif('condutor: ' || coalesce(nullif(v.condutor_nome, ''), (select nome from public.participantes where id = v.condutor_participante_id), ''), 'condutor: '),
        nullif('artigo de odor: ' || v.artigo_odor, 'artigo de odor: ')),
      'binomio_sessao:' || v.id, 'info', null, null, v.id::text, v_nome);
  else
    update public.binomio_sessoes set setor_id = v.setor_id, condutor_participante_id = v.condutor_participante_id, condutor_nome = v.condutor_nome,
           cao_nome = v.cao_nome, cao_gps = v.cao_gps, artigo_odor = v.artigo_odor, artigo_origem = v.artigo_origem,
           artigo_manipulacao = v.artigo_manipulacao, condicoes = v.condicoes, atualizado_em = v.atualizado_em, atualizado_por_nome = v.atualizado_por_nome
     where id = v.id;
  end if;
  return row_to_json(v);
end;
$$;

-- Iniciar, pausar, retomar e finalizar a sessão (com a hora de cada passo e as pausas guardadas).
create or replace function public.binomio_controle(p_sessao uuid, p_acao text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v public.binomio_sessoes%rowtype;
  v_status text;
  v_n integer;
  v_titulo text;
begin
  select * into v from public.binomio_sessoes where id = p_sessao for update;
  if not found then
    raise exception 'sessao_nao_encontrada';
  end if;
  if v_nome is null or not public.dono_operacao(v.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  v_n := jsonb_array_length(v.pausas);
  if p_acao = 'iniciar' and v.estado = 'planejada' then
    v.estado := 'em_andamento'; v.iniciada_em := now(); v_titulo := 'iniciada';
  elsif p_acao = 'pausar' and v.estado = 'em_andamento' then
    v.estado := 'pausada'; v.pausas := v.pausas || jsonb_build_array(jsonb_build_object('de', now())); v_titulo := 'pausada';
  elsif p_acao = 'retomar' and v.estado = 'pausada' then
    v.estado := 'em_andamento';
    v.pausas := jsonb_set(v.pausas, array[(v_n - 1)::text, 'ate'], to_jsonb(now()));
    v_titulo := 'retomada';
  elsif p_acao = 'finalizar' and v.estado in ('em_andamento', 'pausada') then
    if v.estado = 'pausada' and v_n > 0 then
      v.pausas := jsonb_set(v.pausas, array[(v_n - 1)::text, 'ate'], to_jsonb(now()));
    end if;
    v.estado := 'finalizada'; v.finalizada_em := now(); v_titulo := 'finalizada';
  else
    raise exception 'transicao_invalida';
  end if;
  update public.binomio_sessoes set estado = v.estado, iniciada_em = v.iniciada_em, finalizada_em = v.finalizada_em, pausas = v.pausas,
         atualizado_em = now(), atualizado_por_nome = v_nome
   where id = v.id returning * into v;
  perform public.diario_auto(v.operacao_id, now(), 'setor', 'binomio_' || p_acao,
    'Binômio: sessão do cão ' || v.cao_nome || ' ' || v_titulo || coalesce(' (setor ' || (select nome from public.setores where id = v.setor_id) || ')', ''), '',
    'binomio_' || p_acao || ':' || v.id || ':' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint, 'info', null, null, v.id::text, v_nome);
  return row_to_json(v);
end;
$$;

-- Evento da sessão. Indicação: começa "em análise". Confirmação: ligada a uma indicação da mesma sessão,
-- com o método independente (equipe, busca visual, drone…), começa "pendente".
create or replace function public.registrar_binomio_evento(p_sessao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_s public.binomio_sessoes%rowtype;
  v_status text;
  e public.binomio_eventos%rowtype;
  v_ind public.binomio_eventos%rowtype;
begin
  select * into v_s from public.binomio_sessoes where id = p_sessao;
  if not found then
    raise exception 'sessao_nao_encontrada';
  end if;
  if v_nome is null or not public.dono_operacao(v_s.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_s.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' or coalesce(p_dados->>'tipo', '') not in ('indicacao', 'confirmacao') then
    raise exception 'dados_invalidos';
  end if;
  perform 1 from public.binomio_sessoes where id = p_sessao for update;   -- códigos I1, I2… sem repetir
  e.id := gen_random_uuid();
  e.operacao_id := v_s.operacao_id;
  e.sessao_id := p_sessao;
  e.tipo := p_dados->>'tipo';
  e.descricao := left(btrim(coalesce(p_dados->>'descricao', '')), 500);
  e.metodo := left(btrim(coalesce(p_dados->>'metodo', '')), 80);
  e.registrado_por_nome := v_nome;
  e.registrado_em := now();
  e.revisao_nota := '';
  begin
    e.ocorrido_em := coalesce(nullif(p_dados->>'ocorrido_em', '')::timestamptz, now());
    e.lat := nullif(p_dados->>'lat', '')::double precision;
    e.lng := nullif(p_dados->>'lng', '')::double precision;
    e.precisao := nullif(p_dados->>'precisao', '')::real;
    e.relacionado_a := nullif(p_dados->>'relacionado_a', '')::uuid;
  exception when others then
    raise exception 'dados_invalidos';
  end;
  if e.ocorrido_em > now() + interval '5 minutes' then
    raise exception 'data_invalida';
  end if;
  if (e.lat is null) <> (e.lng is null) or (e.lat is not null and (e.lat not between -90 and 90 or e.lng not between -180 and 180)) then
    raise exception 'posicao_invalida';
  end if;
  if e.tipo = 'indicacao' then
    if v_s.estado not in ('em_andamento', 'pausada') then
      raise exception 'sessao_nao_iniciada';
    end if;
    e.estado := 'em_analise';
    e.relacionado_a := null;
    e.codigo := 'I' || (select count(*) + 1 from public.binomio_eventos where sessao_id = p_sessao and tipo = 'indicacao');
  else
    select * into v_ind from public.binomio_eventos where id = e.relacionado_a and sessao_id = p_sessao and tipo = 'indicacao';
    if not found then
      raise exception 'indicacao_obrigatoria';
    end if;
    if e.metodo = '' then
      raise exception 'metodo_obrigatorio';
    end if;
    e.estado := 'pendente';
    e.codigo := 'C' || (select count(*) + 1 from public.binomio_eventos where sessao_id = p_sessao and tipo = 'confirmacao');
    if e.lat is null and v_ind.lat is not null then e.lat := v_ind.lat; e.lng := v_ind.lng; end if;
  end if;
  insert into public.binomio_eventos select e.*;
  perform public.diario_auto(v_s.operacao_id, e.ocorrido_em, 'encontro', 'binomio_' || e.tipo,
    'Binômio (' || v_s.cao_nome || '): ' || case e.tipo when 'indicacao' then 'indicação ' || e.codigo || ' — verificar'
      else 'confirmação ' || e.codigo || ' de ' || v_ind.codigo || ' por ' || e.metodo || ' — pendente' end,
    concat_ws(' · ', nullif(e.descricao, ''), 'indicação não é confirmação'),
    'binomio_evento:' || e.id, 'info', e.lat, e.lng, e.id::text, v_nome);
  return row_to_json(e);
end;
$$;

-- Resultado de um evento: confirmada, descartada ou inconclusiva (com justificativa); "em análise"/"pendente" voltam atrás.
create or replace function public.revisar_binomio_evento(p_evento uuid, p_estado text, p_nota text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  e public.binomio_eventos%rowtype;
  v_status text;
  v_nota text := left(btrim(coalesce(p_nota, '')), 500);
begin
  select * into e from public.binomio_eventos where id = p_evento for update;
  if not found then
    raise exception 'evento_nao_encontrado';
  end if;
  if v_nome is null or not public.dono_operacao(e.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = e.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_estado is null or p_estado not in ('em_analise', 'pendente', 'confirmada', 'descartada', 'inconclusiva')
     or (e.tipo = 'indicacao' and p_estado = 'pendente') or (e.tipo = 'confirmacao' and p_estado = 'em_analise') then
    raise exception 'dados_invalidos';
  end if;
  if p_estado in ('confirmada', 'descartada', 'inconclusiva') and v_nota = '' then
    raise exception 'justificativa_obrigatoria';
  end if;
  update public.binomio_eventos set estado = p_estado, revisao_nota = v_nota, revisado_por_nome = v_nome, revisado_em = now()
   where id = p_evento returning * into e;
  perform public.diario_auto(e.operacao_id, now(), 'encontro', 'binomio_revisao',
    'Binômio: ' || case e.tipo when 'indicacao' then 'indicação ' else 'confirmação ' end || e.codigo || ' ' ||
      case p_estado when 'em_analise' then 'em análise' when 'confirmada' then 'confirmada' when 'descartada' then 'descartada'
                    when 'inconclusiva' then 'inconclusiva' else 'pendente' end,
    v_nota, 'binomio_revisao:' || e.id || ':' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint, 'info', e.lat, e.lng, e.id::text, v_nome);
  return row_to_json(e);
end;
$$;

-- Observação de drone ou da água: cria ou edita. Estado inicial pelo tipo: plano → planejado;
-- telemetria e área observada → registrado; foco térmico e indicação aquática → a verificar.
create or replace function public.salvar_observacao_campo(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  o public.observacoes_campo%rowtype;
  v_status text;
  v_novo boolean := p_id is null;
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  if v_novo then
    o.id := gen_random_uuid();
    o.operacao_id := p_operacao;
    o.modalidade := p_dados->>'modalidade';
    o.tipo := p_dados->>'tipo';
    o.estado := case o.tipo when 'plano_voo' then 'planejado' when 'foco_termico' then 'a_verificar' when 'indicacao_aquatica' then 'a_verificar' else 'registrado' end;
    o.dados := '{}'::jsonb; o.fonte := ''; o.nota := '';
    o.registrado_por_nome := v_nome;
    o.registrado_em := now();
  else
    select * into o from public.observacoes_campo where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'observacao_nao_encontrada';
    end if;
  end if;
  if coalesce(o.modalidade, '') not in ('drone', 'aquatica')
     or coalesce(o.tipo, '') not in ('plano_voo', 'telemetria', 'area_observada', 'foco_termico', 'indicacao_aquatica')
     or (o.modalidade = 'aquatica') <> (o.tipo = 'indicacao_aquatica') then
    raise exception 'dados_invalidos';
  end if;
  if p_dados ? 'titulo' then o.titulo := btrim(regexp_replace(coalesce(p_dados->>'titulo', ''), '\s+', ' ', 'g')); end if;
  if p_dados ? 'fonte' then o.fonte := left(btrim(coalesce(p_dados->>'fonte', '')), 120); end if;
  if p_dados ? 'nota' then o.nota := left(btrim(coalesce(p_dados->>'nota', '')), 500); end if;
  if p_dados ? 'dados' then
    if jsonb_typeof(p_dados->'dados') <> 'object' or length((p_dados->'dados')::text) > 20000 then
      raise exception 'dados_invalidos';
    end if;
    o.dados := p_dados->'dados';
  end if;
  if p_dados ? 'geometria' then
    o.geometria := case when coalesce(jsonb_typeof(p_dados->'geometria'), 'null') = 'null' then null else p_dados->'geometria' end;
    if not public.geometria_valida(o.geometria) then
      raise exception 'area_invalida';
    end if;
  end if;
  begin
    if p_dados ? 'observado_em' then o.observado_em := nullif(p_dados->>'observado_em', '')::timestamptz; end if;
  exception when others then
    raise exception 'data_invalida';
  end;
  if o.observado_em is not null and o.observado_em > now() + interval '7 days' then
    raise exception 'data_invalida';
  end if;
  if o.titulo is null or char_length(o.titulo) not between 1 and 80 then
    raise exception 'dados_invalidos';
  end if;
  o.atualizado_em := now();
  o.atualizado_por_nome := v_nome;
  if v_novo then
    insert into public.observacoes_campo select o.*;
    perform public.diario_auto(p_operacao, coalesce(o.observado_em, now()), case when o.tipo in ('foco_termico', 'indicacao_aquatica') then 'encontro' else 'operacao' end,
      'obs_' || o.tipo,
      case o.tipo when 'plano_voo' then 'Drone: plano de voo — ' when 'telemetria' then 'Drone: telemetria importada — ' when 'area_observada' then 'Drone: área observada — '
                  when 'foco_termico' then 'Drone: foco térmico a verificar — ' else 'Água: indicação a verificar — ' end || o.titulo,
      concat_ws(' · ', nullif('fonte: ' || o.fonte, 'fonte: '), nullif(o.nota, '')),
      'obs_campo:' || o.id, 'info',
      case when o.geometria is not null then (o.geometria->'pts'->0->>0)::double precision end,
      case when o.geometria is not null then (o.geometria->'pts'->0->>1)::double precision end, o.id::text, v_nome);
  else
    update public.observacoes_campo set titulo = o.titulo, fonte = o.fonte, nota = o.nota, dados = o.dados, geometria = o.geometria,
           observado_em = o.observado_em, atualizado_em = o.atualizado_em, atualizado_por_nome = o.atualizado_por_nome
     where id = o.id;
  end if;
  return row_to_json(o);
end;
$$;

-- Estado de uma observação (verificado, descartado, inconclusivo exigem justificativa).
create or replace function public.revisar_observacao_campo(p_id uuid, p_estado text, p_nota text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  o public.observacoes_campo%rowtype;
  v_status text;
  v_nota text := left(btrim(coalesce(p_nota, '')), 500);
begin
  select * into o from public.observacoes_campo where id = p_id for update;
  if not found then
    raise exception 'observacao_nao_encontrada';
  end if;
  if v_nome is null or not public.dono_operacao(o.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = o.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_estado is null or p_estado not in ('planejado', 'registrado', 'a_verificar', 'verificado', 'descartado', 'inconclusivo') then
    raise exception 'dados_invalidos';
  end if;
  if p_estado in ('verificado', 'descartado', 'inconclusivo') and v_nota = '' then
    raise exception 'justificativa_obrigatoria';
  end if;
  update public.observacoes_campo set estado = p_estado, nota = case when v_nota <> '' then v_nota else nota end,
         atualizado_em = now(), atualizado_por_nome = v_nome
   where id = p_id returning * into o;
  perform public.diario_auto(o.operacao_id, now(), 'encontro', 'obs_revisao',
    case o.modalidade when 'drone' then 'Drone: ' else 'Água: ' end || o.titulo || ' — ' ||
      case p_estado when 'a_verificar' then 'a verificar' when 'verificado' then 'verificado' when 'descartado' then 'descartado'
                    when 'inconclusivo' then 'inconclusivo' when 'planejado' then 'planejado' else 'registrado' end,
    v_nota, 'obs_revisao:' || o.id || ':' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint, 'info', null, null, o.id::text, v_nome);
  return row_to_json(o);
end;
$$;

revoke execute on function public.geometria_valida(jsonb) from public, anon, authenticated;
do $$
declare
  f text;
begin
  foreach f in array array['salvar_binomio_sessao(uuid, uuid, jsonb)', 'binomio_controle(uuid, text)', 'registrar_binomio_evento(uuid, jsonb)',
                           'revisar_binomio_evento(uuid, text, text)', 'salvar_observacao_campo(uuid, uuid, jsonb)', 'revisar_observacao_campo(uuid, text, text)'] loop
    execute 'revoke execute on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end;
$$;

do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['relato_revisoes', 'binomio_sessoes', 'binomio_eventos', 'observacoes_campo'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end;
$$;


-- =====================================================================
-- 49. Qualidade dos dados dos estudos (denominadores)
--     (migração 043 — idempotente; exige a 023 e a 042)
--
--  Ao lado dos números do dashboard, diz SOBRE O QUE eles foram calculados:
--   - unidade de análise: a operação (um caso = a primeira localização de vítima com posição);
--   - casos elegíveis (operações encerradas + abertas com localização), válidos para distância
--     (ULV e posição da localização) e para tempo (início e hora da localização, sem tempo negativo);
--   - ausentes: falta ULV, falta posição da localização, falta hora de início — NUNCA viram zero;
--   - não localizados: operações encerradas sem localização (censuradas: ficam fora das medianas);
--   - abertas sem localização (ainda em andamento);
--   - possíveis duplicatas: duas operações do mesmo tipo com ULV a menos de 1 km e início a menos de 48 h;
--   - fichas: idade não informada, idade estimada, sem perfil.
--  Só contagens de operações e de fichas; fichas com menos de 5 casos ficam ocultas (k = 5).
-- =====================================================================
create or replace function public.estudo_qualidade()
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_ops uuid[];
begin
  if public.nome_responsavel_atual() is null then
    raise exception 'sem_permissao';
  end if;
  select coalesce(array_agg(o.id), '{}'::uuid[]) into v_ops from public.operacoes o where public.dono_operacao(o.id);
  return (
    with ops as (
      select o.id, o.tipo, o.acionado_em, o.criada_em, o.encerrada_em, o.local_lat, o.local_lng
        from public.operacoes o where o.id = any(v_ops)
    ),
    loc as (
      select v.operacao_id,
             bool_or(v.lat is not null) as com_posicao,
             min(coalesce(v.posicao_em, v.registrado_em)) filter (where v.lat is not null) as em
        from public.vitima_localizacoes v where v.operacao_id = any(v_ops) group by v.operacao_id
    ),
    base as (
      select o.*, l.operacao_id is not null as tem_localizacao, coalesce(l.com_posicao, false) as com_posicao, l.em
        from ops o left join loc l on l.operacao_id = o.id
    ),
    dup as (
      select distinct x.id from ops x join ops y on y.id <> x.id
       where x.local_lat is not null and y.local_lat is not null and coalesce(x.tipo, '') = coalesce(y.tipo, '')
         and abs(extract(epoch from coalesce(x.acionado_em, x.criada_em) - coalesce(y.acionado_em, y.criada_em))) <= 48 * 3600
         and public.distancia_km(x.local_lat, x.local_lng, y.local_lat, y.local_lng) < 1
    ),
    fichas as (
      select t.idade, t.idade_qualidade, t.perfil from public.vitimas t where t.operacao_id = any(v_ops)
    )
    select json_build_object(
      'gerado_em', now(),
      'k_minimo', 5,
      'unidade', 'operacao',
      'operacoes', (select count(*) from ops),
      'elegiveis', (select count(*) from base where encerrada_em is not null or tem_localizacao),
      'com_localizacao', (select count(*) from base where com_posicao),
      'validos_distancia', (select count(*) from base where com_posicao and local_lat is not null),
      'validos_tempo', (select count(*) from base where com_posicao and acionado_em is not null and em >= acionado_em),
      'ausentes', json_build_object(
        'ulv', (select count(*) from base where com_posicao and local_lat is null),
        'posicao_localizacao', (select count(*) from base where tem_localizacao and not com_posicao),
        'inicio', (select count(*) from base where com_posicao and acionado_em is null)),
      'tempo_negativo', (select count(*) from base where com_posicao and acionado_em is not null and em < acionado_em),
      'nao_localizados', (select count(*) from base where encerrada_em is not null and not tem_localizacao),
      'abertas_sem_localizacao', (select count(*) from base where encerrada_em is null and not tem_localizacao),
      'possiveis_duplicatas', (select count(*) from dup),
      'fichas', json_build_object(
        'total', (select case when count(*) >= 5 then count(*) end from fichas),
        'idade_nao_informada', (select case when count(*) >= 5 then count(*) end from fichas where idade is null),
        'idade_estimada', (select case when count(*) >= 5 then count(*) end from fichas where idade is not null and idade_qualidade = 'estimada'),
        'sem_perfil', (select case when count(*) >= 5 then count(*) end from fichas where cardinality(perfil) = 0))
    )
  );
end;
$$;

revoke execute on function public.estudo_qualidade() from public, anon;
grant execute on function public.estudo_qualidade() to authenticated;

-- =====================================================================
-- 50. Cadastro rápido de vítima e convite de participante por e-mail
--     (migração 044 — idempotente; exige a 007, a 031 e a 042)
--
--  1) Cadastro rápido: vitimas.cadastro_rapido marca a ficha criada só com os dados essenciais
--     (nome, idade aproximada, sexo, roupa/característica). O responsável completa depois no
--     formulário da ficha (salvar com o formulário completo tira a marca). A ficha criada em
--     "Vítima encontrada" só com o nome também nasce como cadastro rápido.
--  2) Convite por e-mail: o responsável cadastra nome e e-mail; o servidor (api/convidar.js) envia
--     o link do civil.html com um código do convite. O código só serve para preencher o nome e
--     marcar o convite como aceito; quem manda no acesso continua sendo o token do link.
--     O e-mail é dado pessoal: só os responsáveis da operação leem, e é apagado com a operação
--     (exclusão ou fim da retenção). Limites: 200 convites por operação, 5 envios por convite.
-- =====================================================================
alter table public.vitimas add column if not exists cadastro_rapido boolean not null default false;

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
    v.perfil := '{}';
    v.cadastro_rapido := false;
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
  if p_dados ? 'perfil' then
    if jsonb_typeof(p_dados->'perfil') <> 'array' then
      raise exception 'dados_invalidos';
    end if;
    v.perfil := array(select jsonb_array_elements_text(p_dados->'perfil'));
  end if;
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
  if p_dados ? 'cadastro_rapido' then v.cadastro_rapido := coalesce((p_dados->>'cadastro_rapido')::boolean, false); end if;
  if p_dados ? 'idade_qualidade' then v.idade_qualidade := nullif(btrim(coalesce(p_dados->>'idade_qualidade', '')), ''); end if;
  if v.idade is null then v.idade_qualidade := null; end if;   -- sem idade não há qualidade: é "não informada"

  if v.nome is null or char_length(v.nome) not between 1 and 80 then
    raise exception 'nome_vitima_invalido';
  end if;
  if char_length(v.caracteristicas) > 1000 or char_length(v.roupas) > 1000 or char_length(v.observacoes) > 2000 then
    raise exception 'dados_invalidos';
  end if;
  if (v.sexo is not null and v.sexo not in ('M', 'F')) or char_length(coalesce(v.nascimento, '')) > 20 or char_length(coalesce(v.origem, '')) > 120 then
    raise exception 'dados_invalidos';
  end if;
  if v.idade_qualidade is not null and v.idade_qualidade not in ('informada', 'estimada') then
    raise exception 'dados_invalidos';
  end if;

  if not (v.perfil <@ array['idoso', 'crianca', 'adolescente', 'demencia', 'autismo', 'deficiencia_intelectual', 'transtorno_mental', 'outro']::text[]) then
    raise exception 'dados_invalidos';
  end if;
  v.atualizado_em := now();
  v.atualizado_por_nome := v_nome_resp;
  if p_id is null then
    insert into public.vitimas select v.*;
  else
    update public.vitimas set nome = v.nome, idade = v.idade, idade_qualidade = v.idade_qualidade, cadastro_rapido = v.cadastro_rapido, caracteristicas = v.caracteristicas, roupas = v.roupas,
           observacoes = v.observacoes, perfil = v.perfil, nascimento = v.nascimento, sexo = v.sexo, origem = v.origem, atualizado_em = v.atualizado_em, atualizado_por_nome = v.atualizado_por_nome
     where id = v.id;
  end if;
  return row_to_json(v);
end;
$$;

create or replace function public.registrar_vitima_encontrada(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_status text;
  v_part public.participantes%rowtype;
  v_enc public.participantes%rowtype;
  v_vit public.vitimas%rowtype;
  v_msg public.mensagens%rowtype;
  v_reg public.vitima_localizacoes%rowtype;
  v_nome_reg text;
  v_condicao text;
  v_lat double precision;
  v_lng double precision;
  v_prec real;
  v_pos_em timestamptz;
  v_enc_txt text;
  v_local text;
  v_obs text;
  v_ref uuid;
  v_vnome text;
begin
  if v_nome_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  v_condicao := p_dados->>'condicao';
  if v_condicao is null or v_condicao not in ('viva', 'obito') then
    raise exception 'dados_invalidos';
  end if;
  begin
    v_lat := nullif(p_dados->>'lat', '')::double precision;
    v_lng := nullif(p_dados->>'lng', '')::double precision;
    v_prec := nullif(p_dados->>'precisao', '')::real;
    v_pos_em := nullif(p_dados->>'posicao_em', '')::timestamptz;
  exception when others then
    raise exception 'posicao_invalida';
  end;
  if (v_lat is null) <> (v_lng is null)
     or (v_lat is not null and (v_lat not between -90 and 90 or v_lng not between -180 and 180 or (v_lat = 0 and v_lng = 0))) then
    raise exception 'posicao_invalida';
  end if;
  v_prec := case when v_prec between 0 and 100000 then v_prec end;
  v_pos_em := case when v_lat is not null then least(coalesce(v_pos_em, now()), now()) end;
  v_enc_txt := nullif(left(btrim(coalesce(p_dados->>'encontrada_por', '')), 120), '');
  v_local := nullif(left(btrim(coalesce(p_dados->>'local_descricao', '')), 500), '');
  v_obs := nullif(left(btrim(coalesce(p_dados->>'observacoes', '')), 1000), '');

  if nullif(p_dados->>'encontrou', '') is not null then
    begin
      v_ref := (p_dados->>'encontrou')::uuid;
    exception when others then
      raise exception 'participante_invalido';
    end;
    select * into v_enc from public.participantes where id = v_ref and operacao_id = p_operacao;
    if not found then
      raise exception 'participante_invalido';
    end if;
  end if;

  -- ficha da vítima: escolhida ou criada agora só com o nome
  if nullif(p_dados->>'vitima_id', '') is not null then
    begin
      v_ref := (p_dados->>'vitima_id')::uuid;
    exception when others then
      raise exception 'vitima_nao_encontrada';
    end;
    select * into v_vit from public.vitimas where id = v_ref and operacao_id = p_operacao;
    if not found then
      raise exception 'vitima_nao_encontrada';
    end if;
  elsif btrim(coalesce(p_dados->>'vitima_nome', '')) <> '' then
    v_vnome := btrim(regexp_replace(p_dados->>'vitima_nome', '\s+', ' ', 'g'));
    if char_length(v_vnome) > 80 then
      raise exception 'nome_vitima_invalido';
    end if;
    insert into public.vitimas (operacao_id, nome, criado_por, criado_por_nome, atualizado_por_nome, cadastro_rapido)
    values (p_operacao, v_vnome, auth.uid(), v_nome_resp, v_nome_resp, true)
    returning * into v_vit;
  end if;

  -- registro do responsável na operação (o mesmo da 025)
  perform public.entrar_como_responsavel(p_operacao);
  select * into v_part from public.participantes where operacao_id = p_operacao and user_id = auth.uid();

  v_nome_reg := v_part.nome ||
    case when v_enc.id is not null and v_enc.id <> v_part.id then ' (encontrada por ' || v_enc.nome || ')'
         when v_enc_txt is not null then ' (encontrada por ' || v_enc_txt || ')' else '' end;

  insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto,
                                direcao, categoria, lat, lng, precisao, posicao_em, entregue_em, lida_em, lida_por_nome)
  values (p_operacao, v_part.id, auth.uid(), v_part.nome, 'PARTICIPANTE', 'Localizada, ver protocolo',
          'entrada', 'VITIMA', v_lat, v_lng, v_prec, v_pos_em, now(), now(), v_part.nome)
  returning * into v_msg;

  insert into public.vitima_localizacoes (operacao_id, participante_id, mensagem_id, condicao, lat, lng, precisao,
                                          posicao_em, registrado_em, registrado_por, registrado_por_nome, registrado_por_tipo,
                                          vitima_id, encontrada_por_texto, local_descricao, observacoes)
  values (p_operacao, v_part.id, v_msg.id, v_condicao, v_lat, v_lng, v_prec,
          v_pos_em, v_msg.criada_em, auth.uid(), left(v_nome_reg, 120), 'responsavel',
          v_vit.id, case when v_enc.id is null then v_enc_txt end, v_local, v_obs)
  returning * into v_reg;

  perform public.criar_alerta(p_operacao, 'vitima_localizada', 'critico',
    'VÍTIMA LOCALIZADA',
    'Registrado por ' || v_nome_reg || ' (responsável)' ||
      case when v_lat is null then ' · sem localização' else '' end || '. Veja a condição no painel.',
    'vitima:' || v_reg.id, null, null, coalesce(v_enc.id, v_part.id), v_lat, v_lng, v_pos_em);

  return json_build_object('mensagem', row_to_json(v_msg), 'registro', row_to_json(v_reg),
                           'vitima', case when v_vit.id is not null then row_to_json(v_vit) end);
end;
$$;

create table if not exists public.convites_participante (
  id                uuid primary key default gen_random_uuid(),
  operacao_id       uuid not null references public.operacoes(id) on delete cascade,
  nome              text not null check (char_length(btrim(nome)) between 2 and 40),
  email             text not null check (char_length(email) <= 200 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'),
  codigo            text not null unique default left(replace(gen_random_uuid()::text, '-', ''), 24),
  criado_por_nome   text not null,
  criado_em         timestamptz not null default now(),
  envios            integer not null default 0,
  enviado_em        timestamptz,
  envio_erro        text check (envio_erro is null or char_length(envio_erro) <= 200),
  aceito_em         timestamptz,
  participante_id   uuid references public.participantes(id) on delete set null,
  unique (operacao_id, email)
);
create index if not exists convites_participante_operacao_idx on public.convites_participante (operacao_id);

alter table public.convites_participante enable row level security;
drop policy if exists convites_participante_ler on public.convites_participante;
create policy convites_participante_ler on public.convites_participante for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.convites_participante from anon;
revoke insert, update, delete, truncate on public.convites_participante from authenticated;
grant select on public.convites_participante to authenticated;
drop trigger if exists convites_participante_encerrada on public.convites_participante;
create trigger convites_participante_encerrada before insert or update or delete on public.convites_participante
  for each row execute function public.bloquear_escrita_encerrada();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'convites_participante') then
    execute 'alter publication supabase_realtime add table public.convites_participante';
  end if;
end;
$$;

-- Fim da retenção: os e-mails dos convidados são apagados junto com os demais dados pessoais.
create or replace function public.apagar_convites_da_operacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.convites_participante where operacao_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists operacoes_apagar_convites on public.operacoes;
create trigger operacoes_apagar_convites after update of dados_apagados_em on public.operacoes
  for each row execute function public.apagar_convites_da_operacao();

-- Cria o convite (ou devolve o que já existe para o mesmo e-mail na operação, atualizando o nome).
create or replace function public.criar_convite_participante(p_operacao uuid, p_nome text, p_email text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_resp text := public.nome_responsavel_atual();
  v_status text;
  v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  v_email text := lower(btrim(coalesce(p_email, '')));
  c public.convites_participante%rowtype;
begin
  if v_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if char_length(v_nome) not between 2 and 40 then
    raise exception 'nome_convite_invalido';
  end if;
  if char_length(v_email) > 200 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
    raise exception 'email_convite_invalido';
  end if;
  select * into c from public.convites_participante where operacao_id = p_operacao and email = v_email for update;
  if found then
    update public.convites_participante set nome = v_nome where id = c.id returning * into c;
    return row_to_json(c);
  end if;
  if (select count(*) from public.convites_participante where operacao_id = p_operacao) >= 200 then
    raise exception 'convites_limite';
  end if;
  insert into public.convites_participante (operacao_id, nome, email, criado_por_nome)
  values (p_operacao, v_nome, v_email, v_resp) returning * into c;
  perform public.diario_auto(p_operacao, now(), 'pessoa', 'convite_criado', 'Convite por e-mail: ' || v_nome, '',
    'convite:' || c.id, 'info', null, null, c.id::text, v_resp);
  return row_to_json(c);
end;
$$;

-- Dados para o servidor enviar o e-mail (o servidor chama com o login do responsável). Confere o limite de envios.
create or replace function public.convite_dados_envio(p_convite uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  c public.convites_participante%rowtype;
  o public.operacoes%rowtype;
begin
  select * into c from public.convites_participante where id = p_convite;
  if not found or not public.dono_operacao(c.operacao_id) or public.nome_responsavel_atual() is null then
    raise exception 'sem_permissao';
  end if;
  select * into o from public.operacoes where id = c.operacao_id;
  if o.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if c.envios >= 5 then
    raise exception 'convite_envios_limite';
  end if;
  return json_build_object('id', c.id, 'nome', c.nome, 'email', c.email, 'codigo', c.codigo, 'operacao', o.codigo, 'token_civil', o.token_civil,
                           'envios', c.envios, 'responsavel', public.nome_responsavel_atual());
end;
$$;

-- Resultado do envio (p_erro nulo = enviado).
create or replace function public.convite_registrar_envio(p_convite uuid, p_erro text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  c public.convites_participante%rowtype;
begin
  select * into c from public.convites_participante where id = p_convite for update;
  if not found or not public.dono_operacao(c.operacao_id) or public.nome_responsavel_atual() is null then
    raise exception 'sem_permissao';
  end if;
  if p_erro is null then
    update public.convites_participante set envios = envios + 1, enviado_em = now(), envio_erro = null where id = c.id returning * into c;
    perform public.diario_auto(c.operacao_id, now(), 'pessoa', 'convite_enviado', 'Convite enviado por e-mail a ' || c.nome, 'envio ' || c.envios,
      'convite_envio:' || c.id || ':' || c.envios, 'info', null, null, c.id::text, public.nome_responsavel_atual());
  else
    update public.convites_participante set envio_erro = left(btrim(p_erro), 200) where id = c.id returning * into c;
  end if;
  return row_to_json(c);
end;
$$;

-- Revoga o convite (o link do e-mail deixa de pré-preencher o nome; o link da operação continua valendo).
create or replace function public.cancelar_convite_participante(p_convite uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  c public.convites_participante%rowtype;
begin
  select * into c from public.convites_participante where id = p_convite for update;
  if not found or not public.dono_operacao(c.operacao_id) or public.nome_responsavel_atual() is null then
    raise exception 'sem_permissao';
  end if;
  delete from public.convites_participante where id = c.id;
  return json_build_object('id', c.id, 'cancelado', true);
end;
$$;

-- Página do participante: o nome convidado (só o nome, nada mais). Código inválido: nulo.
create or replace function public.convite_ler(p_codigo text)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  c public.convites_participante%rowtype;
begin
  if p_codigo is null or p_codigo !~ '^[0-9a-f]{24}$' then
    return null;
  end if;
  select * into c from public.convites_participante where codigo = p_codigo;
  if not found then
    return null;
  end if;
  return json_build_object('nome', c.nome, 'aceito', c.aceito_em is not null);
end;
$$;

-- Depois de entrar na operação: liga o convite ao participante (só quem entrou, e uma vez).
create or replace function public.convite_aceitar(p_codigo text, p_participante uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  c public.convites_participante%rowtype;
  p public.participantes%rowtype;
begin
  if p_codigo is null or p_codigo !~ '^[0-9a-f]{24}$' then
    return null;
  end if;
  select * into c from public.convites_participante where codigo = p_codigo for update;
  if not found then
    return null;
  end if;
  select * into p from public.participantes where id = p_participante and operacao_id = c.operacao_id and user_id = auth.uid();
  if not found then
    raise exception 'sem_permissao';
  end if;
  if c.aceito_em is null then
    update public.convites_participante set aceito_em = now(), participante_id = p.id where id = c.id returning * into c;
    perform public.diario_auto(c.operacao_id, now(), 'pessoa', 'convite_aceito', c.nome || ' entrou pelo convite por e-mail', '',
      'convite_aceito:' || c.id, 'info', null, null, c.id::text, p.nome);
  end if;
  return json_build_object('aceito', true);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array['criar_convite_participante(uuid, text, text)', 'convite_dados_envio(uuid)', 'convite_registrar_envio(uuid, text)',
                           'cancelar_convite_participante(uuid)', 'convite_ler(text)', 'convite_aceitar(text, uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
