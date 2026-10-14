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
  if exists (select 1 from public.diario where operacao_id = p_operacao
              and tipo not in ('operacao_criada', 'acionamento', 'responsavel_adicionado', 'ficha_vitima', 'grupo_criado', 'setor_criado',
                               'operacao_encerrada', 'operacao_reaberta', 'dados_apagados'))
     or exists (select 1 from public.relatorios where operacao_id = p_operacao) then
    raise exception 'operacao_com_registros';
  end if;
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
