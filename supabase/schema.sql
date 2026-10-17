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
  if tg_op = 'DELETE' and coalesce(current_setting('gbs.excluindo_operacao', true), '') = old.operacao_id::text then
    return old;
  end if;
  raise exception 'relatorio_nao_apaga';
end;
$$;
drop trigger if exists relatorios_proteger on public.relatorios;
create trigger relatorios_proteger before update or delete on public.relatorios
  for each row execute function public.relatorios_proteger();

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
-- Exclusão da operação: só sem atividade registrada (criada por engano).
-- Com atividade, a operação e o diário ficam; os dados pessoais saem pela retenção.
-- Administrador: exclui qualquer operação da equipe, com diário e relatórios (migração 020).
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
  if not public.eh_admin()
     and (exists (select 1 from public.diario where operacao_id = p_operacao
                   and tipo not in ('operacao_criada', 'acionamento', 'responsavel_adicionado', 'ficha_vitima', 'grupo_criado', 'setor_criado',
                                    'operacao_encerrada', 'operacao_reaberta', 'dados_apagados'))
          or exists (select 1 from public.relatorios where operacao_id = p_operacao)) then
    raise exception 'operacao_com_registros';
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

notify pgrst, 'reload schema';
