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

notify pgrst, 'reload schema';
