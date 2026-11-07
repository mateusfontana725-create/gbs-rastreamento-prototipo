-- =====================================================================
-- 069 · Código de acesso à operação, pedidos de acesso, tipos SARP e BREC e link público do painel do comando
--       (migração idempotente; exige a 068 (descansos), a 066 (áreas sem trilha) e a 061 (áreas proibidas))
--
--  1. Código de acesso: cada operação ativa ganha, sozinha, um código de 6 caracteres (sem letras e números
--     parecidos: 0/O, 1/I). Quem já tem o aplicativo digita o código e pede para entrar. O link e o QR Code
--     continuam entrando direto, como antes; o código é o caminho COM aprovação. O responsável pode trocar o
--     código (o anterior para de valer) ou desligá-lo. Quem erra o código muitas vezes é barrado por 10 minutos.
--  2. Pedidos de acesso (pedidos_acesso): o pedido guarda nome, CPF (opcional) e celular. O responsável da
--     operação aceita (como civil ou como militar) ou recusa. Aceito, o aparelho recebe o link da operação e
--     termina a entrada pelo caminho de sempre (ingressar). Escrita só por RPC; leitura só dos responsáveis.
--  3. Tipos de operação: SARP (aeronave remotamente pilotada) e BREC (busca e resgate em estruturas colapsadas).
--  4. Link público do painel do comando (comando_token): quem abre NÃO precisa de login e só enxerga: mapa,
--     pessoas, trilhas, setores, pontos, grupos e áreas. Nunca sai CPF, celular, mensagens, fotos, diário,
--     vítimas, descrição, endereço nem o nome de quem registrou. Os nomes das pessoas só saem se o responsável
--     marcar. Ligar, trocar e desligar ficam no diário.
-- =====================================================================

-- 1. Código de acesso ---------------------------------------------------------------------------------------
alter table public.operacoes add column if not exists codigo_acesso text;
alter table public.operacoes add column if not exists codigo_acesso_ativo boolean not null default true;
do $$
begin
  alter table public.operacoes add constraint operacoes_codigo_acesso_ok
    check (codigo_acesso is null or codigo_acesso ~ '^[A-HJ-NP-Z2-9]{6}$');
exception when duplicate_object then null;
end;
$$;
create unique index if not exists operacoes_codigo_acesso_uk on public.operacoes (codigo_acesso) where codigo_acesso is not null;

create or replace function public.gerar_codigo_acesso()
returns text
language plpgsql volatile set search_path = public
as $$
declare
  v_alfabeto constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_cod text;
  v_i integer;
begin
  loop
    v_cod := '';
    for v_i in 1 .. 6 loop
      v_cod := v_cod || substr(v_alfabeto, 1 + floor(random() * length(v_alfabeto))::integer, 1);
    end loop;
    exit when not exists (select 1 from public.operacoes where codigo_acesso = v_cod);
  end loop;
  return v_cod;
end;
$$;

create or replace function public.operacoes_codigo_acesso_novo()
returns trigger
language plpgsql set search_path = public
as $$
begin
  if new.codigo_acesso is null and new.status = 'ativa' then
    new.codigo_acesso := public.gerar_codigo_acesso();
  end if;
  return new;
end;
$$;
drop trigger if exists operacoes_codigo_acesso_novo on public.operacoes;
create trigger operacoes_codigo_acesso_novo before insert on public.operacoes
  for each row execute function public.operacoes_codigo_acesso_novo();

-- operações ativas que já existiam (as encerradas não são tocadas)
update public.operacoes set codigo_acesso = public.gerar_codigo_acesso() where status = 'ativa' and codigo_acesso is null;

revoke execute on function public.gerar_codigo_acesso(), public.operacoes_codigo_acesso_novo() from public, anon, authenticated;

-- Troca o código (o anterior para de valer) e/ou liga ou desliga a entrada por código. p_ativo nulo = não muda.
create or replace function public.definir_codigo_acesso(p_operacao uuid, p_trocar boolean default false, p_ativo boolean default null)
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
  if v_op.status <> 'ativa' or v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  if coalesce(p_trocar, false) or v_op.codigo_acesso is null then
    update public.operacoes set codigo_acesso = public.gerar_codigo_acesso() where id = p_operacao;
    perform public.diario_auto(p_operacao, now(), 'operacao', 'codigo_acesso', 'Código de acesso da operação trocado',
      'O código anterior deixou de valer.', 'codigo_acesso:' || p_operacao || ':' || extract(epoch from clock_timestamp())::bigint, 'info', null, null, null, v_nome);
  end if;
  if p_ativo is not null and p_ativo <> v_op.codigo_acesso_ativo then
    update public.operacoes set codigo_acesso_ativo = p_ativo where id = p_operacao;
    perform public.diario_auto(p_operacao, now(), 'operacao', 'codigo_acesso',
      case when p_ativo then 'Entrada por código ligada' else 'Entrada por código desligada' end, '',
      'codigo_acesso_ativo:' || p_operacao || ':' || extract(epoch from clock_timestamp())::bigint, 'info', null, null, null, v_nome);
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  return json_build_object('codigo_acesso', v_op.codigo_acesso, 'codigo_acesso_ativo', v_op.codigo_acesso_ativo);
end;
$$;

-- 2. Pedidos de acesso --------------------------------------------------------------------------------------
create table if not exists public.pedidos_acesso (
  id               uuid primary key default gen_random_uuid(),
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  nome             text not null check (char_length(nome) between 2 and 40),
  cpf              text,
  telefone         text,
  status           text not null default 'pendente' check (status in ('pendente', 'aceito', 'recusado', 'cancelado')),
  tipo_concedido   text check (tipo_concedido in ('civil', 'militar')),
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  decidido_em      timestamptz,
  decidido_por     uuid references auth.users(id) on delete set null,
  decidido_por_nome text,
  unique (operacao_id, user_id)
);
create index if not exists pedidos_acesso_operacao_idx on public.pedidos_acesso (operacao_id, status);

alter table public.pedidos_acesso enable row level security;
drop policy if exists pedidos_acesso_ler on public.pedidos_acesso;
create policy pedidos_acesso_ler on public.pedidos_acesso for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.pedidos_acesso from anon;
revoke insert, update, delete, truncate on public.pedidos_acesso from authenticated;
grant select on public.pedidos_acesso to authenticated;

-- Tentativas de código errado (barra quem fica adivinhando)
create table if not exists public.tentativas_codigo_acesso (
  id       bigint generated always as identity primary key,
  user_id  uuid not null,
  em       timestamptz not null default now()
);
create index if not exists tentativas_codigo_acesso_idx on public.tentativas_codigo_acesso (user_id, em desc);
alter table public.tentativas_codigo_acesso enable row level security;
revoke all on public.tentativas_codigo_acesso from anon, authenticated;

-- O aparelho pede para entrar com o código. Código errado volta como { ok: false, erro } (e não como exceção: a
-- exceção desfaria o registro da tentativa). Devolve o pedido (pendente, ou aceito se a pessoa já participa).
create or replace function public.solicitar_acesso_operacao(p_codigo text, p_nome text, p_cpf text default null, p_telefone text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_cod text := upper(regexp_replace(coalesce(p_codigo, ''), '[^A-Za-z0-9]', '', 'g'));
  v_op public.operacoes%rowtype;
  v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  v_cpf text := public.cpf_normalizado(p_cpf);
  v_tel text := public.telefone_normalizado(p_telefone);
  v_part public.participantes%rowtype;
  v_ped public.pedidos_acesso%rowtype;
  v_pendentes integer;
begin
  if v_uid is null then
    raise exception 'nao_autenticado';
  end if;
  delete from public.tentativas_codigo_acesso where em < now() - interval '1 day';
  if (select count(*) from public.tentativas_codigo_acesso where user_id = v_uid and em > now() - interval '10 minutes') >= 8 then
    raise exception 'codigo_muitas_tentativas';
  end if;
  select * into v_op from public.operacoes where codigo_acesso = v_cod and v_cod ~ '^[A-HJ-NP-Z2-9]{6}$';
  if not found or not v_op.codigo_acesso_ativo then
    insert into public.tentativas_codigo_acesso (user_id) values (v_uid);
    return json_build_object('ok', false, 'erro', 'codigo_acesso_invalido');
  end if;
  if v_op.status <> 'ativa' or v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  if char_length(v_nome) < 2 or char_length(v_nome) > 40 then
    raise exception 'nome_invalido';
  end if;
  if coalesce(btrim(p_cpf), '') <> '' and v_cpf is null then
    raise exception 'cpf_invalido';
  end if;
  if v_tel is null then
    raise exception 'telefone_invalido';
  end if;

  select * into v_part from public.participantes where operacao_id = v_op.id and user_id = v_uid;
  if found and (v_part.removido or v_part.tipo = 'responsavel') then
    raise exception 'participante_removido';
  end if;

  select * into v_ped from public.pedidos_acesso where operacao_id = v_op.id and user_id = v_uid for update;
  if found and v_ped.status = 'recusado' then
    raise exception 'acesso_recusado';
  end if;
  if not found then
    select count(*) into v_pendentes from public.pedidos_acesso where operacao_id = v_op.id and status = 'pendente';
    if v_pendentes >= 100 then
      raise exception 'limite_pedidos';
    end if;
    insert into public.pedidos_acesso (operacao_id, user_id, nome, cpf, telefone, status, tipo_concedido)
    values (v_op.id, v_uid, v_nome, v_cpf, v_tel,
            case when v_part.id is not null then 'aceito' else 'pendente' end,
            case when v_part.id is not null then (case when v_part.tipo = 'militar' then 'militar' else 'civil' end) end)
    returning * into v_ped;
  elsif v_ped.status in ('pendente', 'cancelado') or v_part.id is not null then
    update public.pedidos_acesso
       set nome = v_nome, cpf = coalesce(v_cpf, cpf), telefone = v_tel, atualizado_em = now(),
           status = case when v_part.id is not null then 'aceito' else 'pendente' end,
           tipo_concedido = case when v_part.id is not null then (case when v_part.tipo = 'militar' then 'militar' else 'civil' end) else tipo_concedido end,
           criado_em = case when v_ped.status = 'cancelado' then now() else criado_em end
     where id = v_ped.id returning * into v_ped;
  end if;
  return json_build_object('ok', true, 'pedido', v_ped.id, 'status', v_ped.status, 'operacao', v_op.codigo);
end;
$$;

-- O aparelho consulta o próprio pedido. Aceito e operação ativa: devolve o link da operação (do tipo concedido).
create or replace function public.consultar_pedido_acesso(p_pedido uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_ped public.pedidos_acesso%rowtype;
  v_op public.operacoes%rowtype;
begin
  select * into v_ped from public.pedidos_acesso where id = p_pedido and user_id = auth.uid();
  if not found then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = v_ped.operacao_id;
  if v_op.status <> 'ativa' or v_op.dados_apagados_em is not null then
    return json_build_object('status', 'encerrada', 'operacao', v_op.codigo);
  end if;
  return json_build_object(
    'status', v_ped.status,
    'operacao', v_op.codigo,
    'tipo', v_ped.tipo_concedido,
    'decidido_por_nome', v_ped.decidido_por_nome,
    'token', case when v_ped.status = 'aceito' then (case when v_ped.tipo_concedido = 'militar' then v_op.token_militar else v_op.token_civil end) end);
end;
$$;

create or replace function public.cancelar_pedido_acesso(p_pedido uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.pedidos_acesso set status = 'cancelado', atualizado_em = now()
   where id = p_pedido and user_id = auth.uid() and status = 'pendente';
  if not found and not exists (select 1 from public.pedidos_acesso where id = p_pedido and user_id = auth.uid()) then
    raise exception 'sem_permissao';
  end if;
end;
$$;

-- O responsável aceita (civil ou militar) ou recusa. Aceito não volta atrás (a pessoa já recebeu o link: para tirá-la,
-- remova o participante). Recusado pode ser aceito depois.
create or replace function public.decidir_pedido_acesso(p_pedido uuid, p_aceitar boolean, p_tipo text default 'civil')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_ped public.pedidos_acesso%rowtype;
  v_op public.operacoes%rowtype;
  v_tipo text := coalesce(nullif(btrim(p_tipo), ''), 'civil');
begin
  if p_aceitar is null or v_tipo not in ('civil', 'militar') then
    raise exception 'dados_invalidos';
  end if;
  select * into v_ped from public.pedidos_acesso where id = p_pedido for update;
  if not found or v_nome is null or not public.dono_operacao(v_ped.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = v_ped.operacao_id;
  if v_op.status <> 'ativa' or v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  if v_ped.status = 'aceito' then
    raise exception 'pedido_ja_aceito';
  end if;
  if v_ped.status = 'cancelado' then
    raise exception 'pedido_cancelado';
  end if;
  update public.pedidos_acesso
     set status = case when p_aceitar then 'aceito' else 'recusado' end,
         tipo_concedido = case when p_aceitar then v_tipo end,
         decidido_em = now(), decidido_por = auth.uid(), decidido_por_nome = v_nome, atualizado_em = now()
   where id = v_ped.id returning * into v_ped;
  perform public.diario_auto(v_op.id, now(), 'operacao', 'pedido_acesso',
    case when p_aceitar then 'Acesso aceito: ' || v_ped.nome || ' (' || v_tipo || ')' else 'Acesso recusado: ' || v_ped.nome end,
    'Pedido feito com o código da operação.', 'pedido_acesso:' || v_ped.id || ':' || v_ped.status, 'info', null, null, null, v_nome);
  return json_build_object('id', v_ped.id, 'status', v_ped.status, 'tipo_concedido', v_ped.tipo_concedido);
end;
$$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.pedidos_acesso';
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

revoke execute on function public.definir_codigo_acesso(uuid, boolean, boolean), public.decidir_pedido_acesso(uuid, boolean, text) from public, anon;
grant execute on function public.definir_codigo_acesso(uuid, boolean, boolean), public.decidir_pedido_acesso(uuid, boolean, text) to authenticated;
revoke execute on function public.solicitar_acesso_operacao(text, text, text, text), public.consultar_pedido_acesso(uuid), public.cancelar_pedido_acesso(uuid) from public, anon;
grant execute on function public.solicitar_acesso_operacao(text, text, text, text), public.consultar_pedido_acesso(uuid), public.cancelar_pedido_acesso(uuid) to authenticated;

-- 3. Tipos de operação: SARP e BREC ---------------------------------------------------------------------------
alter table public.operacoes drop constraint if exists operacoes_tipo_check;
alter table public.operacoes add constraint operacoes_tipo_check check (
  (tipo is null and tipo_outro is null)
  or (tipo in ('aquatica', 'terrestre', 'aerea', 'sarp', 'brec') and tipo_outro is null)
  or (tipo = 'outras' and char_length(btrim(coalesce(tipo_outro, ''))) between 1 and 60));

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
    if v.tipo is not null and v.tipo not in ('aquatica', 'terrestre', 'aerea', 'sarp', 'brec', 'outras') then
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
revoke execute on function public.aplicar_cadastro_operacao(public.operacoes, jsonb) from public, anon, authenticated;

-- 4. Link público do painel do comando ------------------------------------------------------------------------
alter table public.operacoes add column if not exists comando_token text;
alter table public.operacoes add column if not exists comando_publico_nomes boolean not null default false;
do $$
begin
  alter table public.operacoes add constraint operacoes_comando_token_ok
    check (comando_token is null or comando_token ~ '^[0-9a-f]{48}$');
exception when duplicate_object then null;
end;
$$;
create unique index if not exists operacoes_comando_token_uk on public.operacoes (comando_token) where comando_token is not null;

-- Liga, troca (o anterior para de funcionar) ou muda a opção de mostrar nomes. p_trocar = false e já ligado: só a opção.
create or replace function public.comando_publico_gerar(p_operacao uuid, p_nomes boolean default null, p_trocar boolean default true)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_op public.operacoes%rowtype;
  v_token text := left(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 48);
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao for update;
  if v_op.status <> 'ativa' or v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  if v_op.comando_token is not null and not coalesce(p_trocar, true) then
    v_token := v_op.comando_token;
  end if;
  update public.operacoes
     set comando_token = v_token, comando_publico_nomes = coalesce(p_nomes, comando_publico_nomes)
   where id = p_operacao;
  if v_op.comando_token is distinct from v_token then
    perform public.diario_auto(p_operacao, now(), 'operacao', 'comando_publico',
      case when v_op.comando_token is not null then 'Link público do painel trocado (o anterior deixou de funcionar)' else 'Link público do painel do comando criado' end,
      'Somente visualização' || case when coalesce(p_nomes, v_op.comando_publico_nomes) then ', com os nomes das pessoas.' else ', sem os nomes das pessoas.' end,
      'comando_publico:' || v_token, 'info', null, null, null, v_nome);
  elsif p_nomes is not null and p_nomes is distinct from v_op.comando_publico_nomes then
    perform public.diario_auto(p_operacao, now(), 'operacao', 'comando_publico',
      case when p_nomes then 'Link público do painel: nomes das pessoas ligados' else 'Link público do painel: nomes das pessoas escondidos' end, '',
      'comando_publico:nomes:' || p_operacao || ':' || extract(epoch from clock_timestamp())::bigint, 'info', null, null, null, v_nome);
  end if;
  return json_build_object('token', v_token, 'nomes', (select comando_publico_nomes from public.operacoes where id = p_operacao));
end;
$$;

create or replace function public.comando_publico_desligar(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
begin
  if v_nome is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if exists (select 1 from public.operacoes where id = p_operacao and comando_token is not null) then
    update public.operacoes set comando_token = null where id = p_operacao;
    perform public.diario_auto(p_operacao, now(), 'operacao', 'comando_publico', 'Link público do painel do comando desligado', '',
      'comando_publico:off:' || p_operacao || ':' || extract(epoch from clock_timestamp())::bigint, 'info', null, null, null, v_nome);
  end if;
  return json_build_object('token', null);
end;
$$;

-- Leitura pública (sem login). Devolve as linhas no formato do arquivo da operação (js/arquivo-local.js), só com o
-- que o painel precisa para desenhar o mapa. p_desde: último id de posição já recebido (só vêm as novas).
create or replace function public.comando_publico(p_token text, p_desde bigint default null)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
  v_nomes boolean;
  v_fora constant text[] := array['user_id', 'cpf', 'telefone', 'saida_motivo', 'criado_por', 'criado_por_nome', 'atualizado_por',
                                  'atualizado_por_nome', 'removido_por_nome', 'reincluido_por_nome', 'adicionado_por_nome',
                                  'decidido_por', 'decidido_por_nome', 'enviado_por', 'enviado_por_nome', 'encerrado_por_nome'];
  v_part jsonb;
  v_pos jsonb;
  v_ate bigint;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then
    raise exception 'link_publico_comando_invalido';
  end if;
  select * into v_op from public.operacoes where comando_token = p_token;
  if not found then
    raise exception 'link_publico_comando_invalido';
  end if;
  v_nomes := v_op.comando_publico_nomes;

  select coalesce(jsonb_agg(
           (to_jsonb(p) - v_fora) ||
           case when v_nomes then '{}'::jsonb
                else jsonb_build_object('nome', case when p.tipo = 'responsavel' then 'Responsável ' else 'Participante ' end || p.n, 'nome_painel', null) end
           order by p.criado_em), '[]'::jsonb)
    into v_part
    from (select x.*, row_number() over (partition by (x.tipo = 'responsavel') order by x.criado_em, x.id) as n
            from public.participantes x where x.operacao_id = v_op.id) p;

  if p_desde is null then
    select coalesce(jsonb_agg(to_jsonb(q) order by q.id), '[]'::jsonb) into v_pos
      from (select id, operacao_id, participante_id, lat, lng, precisao, registrado_em, recebido_em, na_base
              from public.posicoes where operacao_id = v_op.id order by id desc limit 60000) q;
  else
    select coalesce(jsonb_agg(to_jsonb(q) order by q.id), '[]'::jsonb) into v_pos
      from (select id, operacao_id, participante_id, lat, lng, precisao, registrado_em, recebido_em, na_base
              from public.posicoes where operacao_id = v_op.id and id > p_desde order by id limit 60000) q;
  end if;
  select max(id) into v_ate from public.posicoes where operacao_id = v_op.id;

  return json_build_object(
    'formato', 'gbs-arquivo-operacao',
    'publico', true,
    'agora', now(),
    'nomes', v_nomes,
    'posicoes_ate', coalesce(v_ate, 0),
    'incremental', p_desde is not null,
    'operacao', jsonb_build_object(
      'id', v_op.id, 'codigo', v_op.codigo, 'status', v_op.status, 'tipo', v_op.tipo, 'tipo_outro', v_op.tipo_outro,
      'acionado_em', v_op.acionado_em, 'criada_em', v_op.criada_em, 'encerrada_em', v_op.encerrada_em,
      'local_lat', v_op.local_lat, 'local_lng', v_op.local_lng),
    'tabelas', jsonb_build_object(
      'participantes', v_part,
      'posicoes', v_pos,
      'setores', coalesce((select jsonb_agg(to_jsonb(x) - v_fora order by x.criado_em) from public.setores x where x.operacao_id = v_op.id), '[]'::jsonb),
      'pontos_interesse', coalesce((select jsonb_agg(to_jsonb(x) - v_fora order by x.criado_em) from public.pontos_interesse x
                                     where x.operacao_id = v_op.id and x.categoria <> 'VITIMA_ENCONTRADA'), '[]'::jsonb),
      'destinos', coalesce((select jsonb_agg(to_jsonb(x) - v_fora) from public.destinos x where x.operacao_id = v_op.id and x.encerrado_em is null), '[]'::jsonb),
      'trilhas_manuais', coalesce((select jsonb_agg(to_jsonb(x) - v_fora order by x.criado_em) from public.trilhas_manuais x where x.operacao_id = v_op.id), '[]'::jsonb),
      'areas_proibidas', coalesce((select jsonb_agg(to_jsonb(x) - v_fora order by x.criado_em) from public.areas_proibidas x where x.operacao_id = v_op.id), '[]'::jsonb),
      'areas_sem_trilha', coalesce((select jsonb_agg(to_jsonb(x) - v_fora order by x.criado_em) from public.areas_sem_trilha x where x.operacao_id = v_op.id), '[]'::jsonb),
      'grupos', coalesce((select jsonb_agg(to_jsonb(x) - v_fora order by x.nome) from public.grupos x where x.operacao_id = v_op.id), '[]'::jsonb),
      'grupo_membros', coalesce((select jsonb_agg(to_jsonb(x) - v_fora) from public.grupo_membros x where x.operacao_id = v_op.id), '[]'::jsonb),
      'descansos', coalesce((select jsonb_agg(to_jsonb(x) - v_fora order by x.inicio) from public.descansos x where x.operacao_id = v_op.id), '[]'::jsonb),
      'setor_permanencias', coalesce((select jsonb_agg(to_jsonb(x) - v_fora) from public.setor_permanencias x where x.operacao_id = v_op.id and x.saiu_em is null), '[]'::jsonb),
      'tipos_ponto', coalesce((select jsonb_agg(to_jsonb(x) - v_fora) from public.tipos_ponto x), '[]'::jsonb),
      'categorias_ponto_estilo', coalesce((select jsonb_agg(to_jsonb(x) - v_fora) from public.categorias_ponto_estilo x), '[]'::jsonb)));
end;
$$;

revoke execute on function public.comando_publico_gerar(uuid, boolean, boolean), public.comando_publico_desligar(uuid) from public, anon;
grant execute on function public.comando_publico_gerar(uuid, boolean, boolean), public.comando_publico_desligar(uuid) to authenticated;
revoke execute on function public.comando_publico(text, bigint) from public;
grant execute on function public.comando_publico(text, bigint) to anon, authenticated;

notify pgrst, 'reload schema';
