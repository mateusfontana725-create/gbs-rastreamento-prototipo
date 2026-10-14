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
