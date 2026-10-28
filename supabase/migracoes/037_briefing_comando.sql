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

notify pgrst, 'reload schema';
