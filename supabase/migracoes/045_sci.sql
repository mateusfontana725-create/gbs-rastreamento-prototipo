-- =====================================================================
-- 51. Painel de comando SCI (Sistema de Comando em Incidentes)
--     (migração 045 — idempotente; exige a 012, a 026 e a 042)
--
--  Fonte única do Posto de Comando, atualizada em tempo real para quem acompanha de longe:
--   - sci_estado (uma linha por operação): funções SCI e responsáveis (CI, Segurança, Ligação, Informação Pública,
--     Operações, Planejamento, Logística, Adm./Finanças), marcos da linha do tempo (acionamento, despacho,
--     chegada, PC, comunicações, SCI, relatório de danos, identificação, localização, resgate, consolidação,
--     término), situação, objetivos, riscos, relatório de danos (com fonte e confirmação), acompanhamento
--     remoto, total de vítimas informado (e se está confirmado) e logística (água, alimentação, combustível, energia);
--   - sci_vitimas: quadro de vítimas numeradas (V-01…) — localizada → removida para a ACV → transportada,
--     com triagem (verde, amarelo, vermelho, cinza = óbito), nome, idade, sexo, destino e o horário de cada passo;
--   - sci_eventos: linha do tempo com hora, categoria, "NÃO CONFIRMADA", correções (o texto anterior fica guardado)
--     e anulação com motivo. Cada evento também entra no diário da operação (e assim no relatório final);
--   - sci_itens: instalações (PC, Área de Espera, ACV, ZPA, Abrigo, GGI…), equipes e missões, órgãos envolvidos,
--     recursos e pedidos, canais de comunicação, leituras do nível do rio e imagens do local (bucket privado "sci").
--  Leitura só pelos responsáveis da operação; escrita só pelas funções; operação encerrada: somente leitura.
--  Modo teste: antes da ocorrência dá para testar o quadro com vítimas e registros de teste (não vão para o diário);
--  ao sair do modo teste, as vítimas, a linha do tempo, os marcos e o total de teste são apagados ("zerar").
-- =====================================================================

/* ---------- Tabelas ---------- */
create table if not exists public.sci_estado (
  operacao_id         uuid primary key references public.operacoes(id) on delete cascade,
  funcoes             jsonb not null default '{}'::jsonb check (jsonb_typeof(funcoes) = 'object'),
  marcos              jsonb not null default '{}'::jsonb check (jsonb_typeof(marcos) = 'object'),
  situacao            text not null default '' check (char_length(situacao) <= 4000),
  situacao_em         timestamptz,
  objetivos           text not null default '' check (char_length(objetivos) <= 4000),
  riscos              text not null default '' check (char_length(riscos) <= 4000),
  danos               text not null default '' check (char_length(danos) <= 8000),
  danos_em            timestamptz,
  danos_fonte         text not null default '' check (char_length(danos_fonte) <= 200),
  danos_confirmado    boolean not null default false,
  acompanhamento      text not null default '' check (char_length(acompanhamento) <= 300),
  total_vitimas       integer check (total_vitimas between 0 and 100000),
  total_confirmado    boolean not null default false,
  logistica           jsonb not null default '{}'::jsonb check (jsonb_typeof(logistica) = 'object'),
  teste               boolean not null default false,
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text
);

create table if not exists public.sci_vitimas (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  numero              integer not null check (numero between 1 and 9999),
  nome                text not null default '' check (char_length(nome) <= 80),
  idade               smallint check (idade between 0 and 130),
  idade_estimada      boolean not null default false,
  sexo                text check (sexo is null or sexo in ('M', 'F')),
  triagem             text check (triagem is null or triagem in ('verde', 'amarelo', 'vermelho', 'cinza')),
  fase                text not null default 'localizada' check (fase in ('localizada', 'removida', 'transportada')),
  local               text not null default '' check (char_length(local) <= 200),
  destino             text not null default '' check (char_length(destino) <= 200),
  observacoes         text not null default '' check (char_length(observacoes) <= 1000),
  vitima_id           uuid references public.vitimas(id) on delete set null,
  localizada_em       timestamptz not null default now(),
  removida_em         timestamptz,
  triada_em           timestamptz,
  transportada_em     timestamptz,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text,
  unique (operacao_id, numero)
);
create index if not exists sci_vitimas_operacao_idx on public.sci_vitimas (operacao_id);

create table if not exists public.sci_eventos (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  ocorrido_em         timestamptz not null,
  categoria           text not null check (categoria in ('decisao', 'seguranca', 'resgate', 'informacao', 'recurso', 'comunicacao')),
  texto               text not null check (char_length(btrim(texto)) between 1 and 1000),
  nao_confirmada      boolean not null default false,
  confirmada_em       timestamptz,
  confirmada_por_nome text,
  origem              text not null default 'manual' check (origem in ('manual', 'automatico')),
  ref                 text,
  historico           jsonb not null default '[]'::jsonb check (jsonb_typeof(historico) = 'array'),
  corrigido_em        timestamptz,
  anulado_em          timestamptz,
  anulado_por_nome    text,
  anulado_motivo      text check (anulado_motivo is null or char_length(anulado_motivo) <= 300),
  registrado_por_nome text not null,
  registrado_em       timestamptz not null default now()
);
create index if not exists sci_eventos_operacao_idx on public.sci_eventos (operacao_id, ocorrido_em);

create table if not exists public.sci_itens (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  tipo                text not null check (tipo in ('instalacao', 'equipe', 'orgao', 'recurso', 'canal', 'leitura_rio', 'imagem')),
  dados               jsonb not null default '{}'::jsonb check (jsonb_typeof(dados) = 'object' and length(dados::text) <= 20000),
  ordem               integer not null default 0,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text
);
create index if not exists sci_itens_operacao_idx on public.sci_itens (operacao_id, tipo);

do $$
declare
  t text;
begin
  foreach t in array array['sci_estado', 'sci_vitimas', 'sci_eventos', 'sci_itens'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_ler', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.dono_operacao(operacao_id))', t || '_ler', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop trigger if exists %I on public.%I', t || '_encerrada', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.bloquear_escrita_encerrada()', t || '_encerrada', t);
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

/* ---------- Rótulos ---------- */
create or replace function public.sci_rotulo_marco(p text)
returns text language sql immutable set search_path = public as $$
  select case p
    when 'acionamento' then 'Acionamento'
    when 'despacho' then 'Despacho da equipe'
    when 'chegada' then 'Chegada ao local e assunção do Comando'
    when 'pc' then 'Posto de Comando instalado'
    when 'comunicacoes' then 'Comunicações estabelecidas'
    when 'sci' then 'SCI montado'
    when 'danos' then 'Relatório primário de danos ao PC'
    when 'identificacao' then 'Início da identificação de vítimas'
    when 'localizacao' then 'Início da localização de vítimas'
    when 'resgate' then 'Início da operação de resgate'
    when 'consolidacao' then 'Consolidação dos dados ao GGI'
    when 'termino' then 'Término e hot debriefing'
    else null end;
$$;

create or replace function public.sci_rotulo_funcao(p text)
returns text language sql immutable set search_path = public as $$
  select case p
    when 'ci' then 'Comandante do Incidente' when 'seguranca' then 'Oficial de Segurança' when 'ligacao' then 'Oficial de Ligação'
    when 'informacao_publica' then 'Informação Pública' when 'operacoes' then 'Chefe de Operações' when 'planejamento' then 'Planejamento'
    when 'logistica' then 'Logística' when 'adm_financas' then 'Adm./Finanças' else null end;
$$;

create or replace function public.sci_rotulo_triagem(p text)
returns text language sql immutable set search_path = public as $$
  select case p when 'verde' then 'VERDE' when 'amarelo' then 'AMARELO' when 'vermelho' then 'VERMELHO' when 'cinza' then 'CINZA (óbito)' else '' end;
$$;

create or replace function public.sci_vnum(p integer)
returns text language sql immutable set search_path = public as $$
  select 'V-' || lpad(p::text, 2, '0');
$$;

/* ---------- Linha do tempo: inclusão e espelho no diário ---------- */
-- Evento na linha do tempo (também no diário da operação). Uso interno das funções do SCI.
create or replace function public.sci_evento_interno(p_operacao uuid, p_em timestamptz, p_categoria text, p_texto text,
                                                     p_nao_confirmada boolean default false, p_origem text default 'automatico',
                                                     p_ref text default null)
returns public.sci_eventos
language plpgsql security definer set search_path = public
as $$
declare
  e public.sci_eventos%rowtype;
  v_teste boolean;
begin
  select teste into v_teste from public.sci_estado where operacao_id = p_operacao;
  insert into public.sci_eventos (operacao_id, ocorrido_em, categoria, texto, nao_confirmada, origem, ref, registrado_por_nome)
  values (p_operacao, coalesce(p_em, now()), p_categoria, left(btrim(p_texto), 1000), coalesce(p_nao_confirmada, false), p_origem, p_ref,
          coalesce(public.nome_responsavel_atual(), 'Sistema'))
  returning * into e;
  if coalesce(v_teste, false) then
    return e;
  end if;
  perform public.diario_auto(p_operacao, e.ocorrido_em,
    case e.categoria when 'seguranca' then 'alerta' when 'resgate' then 'encontro' when 'recurso' then 'chegada'
                     when 'informacao' then 'observacao' else 'operacao' end,
    'sci_evento',
    'SCI · ' || case e.categoria when 'decisao' then 'Decisão do Comando' when 'seguranca' then 'Segurança' when 'resgate' then 'Resgate'
                                 when 'informacao' then 'Informação' when 'recurso' then 'Recurso' else 'Comunicação' end
      || case when e.nao_confirmada then ' (NÃO CONFIRMADA)' else '' end,
    e.texto, 'sci:' || e.id, case when e.categoria = 'seguranca' then 'critico' else 'info' end, null, null, e.id::text, e.registrado_por_nome);
  return e;
end;
$$;

-- Confere permissão e operação ativa. Devolve o nome do responsável.
create or replace function public.sci_conferir(p_operacao uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  v_status text;
begin
  if v_nome is null or p_operacao is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  insert into public.sci_estado (operacao_id) values (p_operacao) on conflict (operacao_id) do nothing;
  return v_nome;
end;
$$;

/* ---------- Estado (funções, situação, danos, total, logística) ---------- */
create or replace function public.sci_salvar_estado(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.sci_conferir(p_operacao);
  s public.sci_estado%rowtype;
  v_ant public.sci_estado%rowtype;
  k text;
  v jsonb;
  v_txt text;
begin
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  select * into s from public.sci_estado where operacao_id = p_operacao for update;
  v_ant := s;
  -- funções: { chave: { nome, acumula_ci } } — só as chaves conhecidas; nome vazio = [PENDENTE]
  if p_dados ? 'funcoes' then
    if jsonb_typeof(p_dados->'funcoes') <> 'object' then
      raise exception 'dados_invalidos';
    end if;
    for k, v in select * from jsonb_each(p_dados->'funcoes') loop
      if public.sci_rotulo_funcao(k) is null or jsonb_typeof(v) <> 'object' then
        raise exception 'dados_invalidos';
      end if;
      v_txt := left(btrim(regexp_replace(coalesce(v->>'nome', ''), '\s+', ' ', 'g')), 80);
      s.funcoes := s.funcoes || jsonb_build_object(k, jsonb_build_object('nome', v_txt, 'acumula_ci', coalesce((v->>'acumula_ci')::boolean, false) and k <> 'ci'));
      if coalesce(v_ant.funcoes->k->>'nome', '') is distinct from v_txt
         or coalesce((v_ant.funcoes->k->>'acumula_ci')::boolean, false) is distinct from (coalesce((v->>'acumula_ci')::boolean, false) and k <> 'ci') then
        perform public.sci_evento_interno(p_operacao, now(), 'decisao',
          public.sci_rotulo_funcao(k) || ': ' || case when coalesce((v->>'acumula_ci')::boolean, false) and k <> 'ci' then 'acumulada pelo CI'
                                                       when v_txt = '' then '[PENDENTE]' else v_txt end, false, 'automatico', 'funcao:' || k);
      end if;
    end loop;
  end if;
  if p_dados ? 'situacao' then
    s.situacao := left(btrim(coalesce(p_dados->>'situacao', '')), 4000);
    if s.situacao is distinct from v_ant.situacao then s.situacao_em := now(); end if;
  end if;
  if p_dados ? 'objetivos' then s.objetivos := left(btrim(coalesce(p_dados->>'objetivos', '')), 4000); end if;
  if p_dados ? 'riscos' then s.riscos := left(btrim(coalesce(p_dados->>'riscos', '')), 4000); end if;
  if p_dados ? 'acompanhamento' then s.acompanhamento := left(btrim(coalesce(p_dados->>'acompanhamento', '')), 300); end if;
  if p_dados ? 'danos_fonte' then s.danos_fonte := left(btrim(coalesce(p_dados->>'danos_fonte', '')), 200); end if;
  if p_dados ? 'danos_confirmado' then s.danos_confirmado := coalesce((p_dados->>'danos_confirmado')::boolean, false); end if;
  if p_dados ? 'danos' then
    s.danos := left(btrim(coalesce(p_dados->>'danos', '')), 8000);
    if s.danos is distinct from v_ant.danos and s.danos <> '' then
      begin
        s.danos_em := coalesce(nullif(p_dados->>'danos_em', '')::timestamptz, now());
      exception when others then
        raise exception 'data_invalida';
      end;
      perform public.sci_evento_interno(p_operacao, s.danos_em, 'informacao',
        'Relatório de danos' || case when s.danos_fonte <> '' then ' (' || s.danos_fonte || ')' else '' end || ': ' || left(s.danos, 600),
        not s.danos_confirmado, 'automatico', 'danos');
    end if;
  end if;
  if p_dados ? 'total_vitimas' then
    if coalesce(jsonb_typeof(p_dados->'total_vitimas'), 'null') = 'null' then
      s.total_vitimas := null;
    elsif jsonb_typeof(p_dados->'total_vitimas') = 'number' and (p_dados->>'total_vitimas')::numeric between 0 and 100000
          and (p_dados->>'total_vitimas')::numeric = trunc((p_dados->>'total_vitimas')::numeric) then
      s.total_vitimas := (p_dados->>'total_vitimas')::integer;
    else
      raise exception 'dados_invalidos';
    end if;
  end if;
  if p_dados ? 'total_confirmado' then s.total_confirmado := coalesce((p_dados->>'total_confirmado')::boolean, false); end if;
  if s.total_vitimas is null then s.total_confirmado := false; end if;
  if s.total_vitimas is distinct from v_ant.total_vitimas or s.total_confirmado is distinct from v_ant.total_confirmado then
    perform public.sci_evento_interno(p_operacao, now(), 'informacao',
      'Total de vítimas: ' || coalesce(s.total_vitimas::text, '[PENDENTE]') || case when s.total_vitimas is not null and not s.total_confirmado then ' (NÃO CONFIRMADO)' else '' end,
      s.total_vitimas is not null and not s.total_confirmado, 'automatico', 'total');
  end if;
  if p_dados ? 'logistica' then
    if jsonb_typeof(p_dados->'logistica') <> 'object' then
      raise exception 'dados_invalidos';
    end if;
    for k, v in select * from jsonb_each(p_dados->'logistica') loop
      if k not in ('agua', 'alimentacao', 'combustivel', 'energia') then
        raise exception 'dados_invalidos';
      end if;
      s.logistica := s.logistica || jsonb_build_object(k, left(btrim(coalesce(v #>> '{}', '')), 300));
    end loop;
  end if;
  update public.sci_estado set funcoes = s.funcoes, situacao = s.situacao, situacao_em = s.situacao_em, objetivos = s.objetivos, riscos = s.riscos,
         acompanhamento = s.acompanhamento, danos = s.danos, danos_em = s.danos_em, danos_fonte = s.danos_fonte, danos_confirmado = s.danos_confirmado,
         total_vitimas = s.total_vitimas, total_confirmado = s.total_confirmado, logistica = s.logistica,
         atualizado_em = now(), atualizado_por_nome = v_nome
   where operacao_id = p_operacao returning * into s;
  return row_to_json(s);
end;
$$;

/* ---------- Marcos da linha do tempo ---------- */
-- p_em nulo = agora. p_apagar = desfaz o marco (fica registrado como correção).
create or replace function public.sci_marcar(p_operacao uuid, p_marco text, p_em timestamptz default null, p_apagar boolean default false)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.sci_conferir(p_operacao);
  s public.sci_estado%rowtype;
  v_rot text := public.sci_rotulo_marco(p_marco);
  v_ant timestamptz;
  v_em timestamptz := coalesce(p_em, now());
begin
  if v_rot is null then
    raise exception 'sci_marco_invalido';
  end if;
  if v_em > now() + interval '5 minutes' or v_em < now() - interval '30 days' then
    raise exception 'data_invalida';
  end if;
  select * into s from public.sci_estado where operacao_id = p_operacao for update;
  v_ant := nullif(s.marcos->>p_marco, '')::timestamptz;
  if coalesce(p_apagar, false) then
    if v_ant is null then
      return row_to_json(s);
    end if;
    s.marcos := s.marcos - p_marco;
    perform public.sci_evento_interno(p_operacao, now(), 'decisao', 'Corrigido: marco "' || v_rot || '" retirado (estava ' ||
      to_char(v_ant at time zone 'America/Sao_Paulo', 'DD/MM HH24"h"MI') || ')', false, 'automatico', 'marco:' || p_marco);
  else
    s.marcos := s.marcos || jsonb_build_object(p_marco, v_em);
    perform public.sci_evento_interno(p_operacao, v_em, 'decisao',
      case when v_ant is null then v_rot
           else v_rot || ' — corrigido de ' || to_char(v_ant at time zone 'America/Sao_Paulo', 'DD/MM HH24"h"MI') end,
      false, 'automatico', 'marco:' || p_marco);
  end if;
  update public.sci_estado set marcos = s.marcos, atualizado_em = now(), atualizado_por_nome = v_nome
   where operacao_id = p_operacao returning * into s;
  return row_to_json(s);
end;
$$;

/* ---------- Vítimas ---------- */
-- p_dados: numero (opcional na criação: o próximo livre), nome, idade, idade_estimada, sexo, triagem, fase, local, destino,
--          observacoes, vitima_id (ficha), em (hora do fato: localização na criação, ou da mudança de fase/triagem).
create or replace function public.sci_salvar_vitima(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.sci_conferir(p_operacao);
  v public.sci_vitimas%rowtype;
  v_ant public.sci_vitimas%rowtype;
  v_novo boolean := p_id is null;
  v_em timestamptz;
  v_idade numeric;
  v_ordem text[] := array['localizada', 'removida', 'transportada'];
begin
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  begin
    v_em := coalesce(nullif(p_dados->>'em', '')::timestamptz, now());
  exception when others then
    raise exception 'data_invalida';
  end;
  if v_em > now() + interval '5 minutes' then
    raise exception 'data_invalida';
  end if;
  if v_novo then
    v.id := gen_random_uuid();
    v.operacao_id := p_operacao;
    v.nome := ''; v.local := ''; v.destino := ''; v.observacoes := ''; v.idade_estimada := false;
    v.fase := 'localizada';
    v.localizada_em := v_em;
    v.criado_por_nome := v_nome;
    v.criado_em := now();
    if p_dados ? 'numero' and nullif(p_dados->>'numero', '') is not null then
      begin
        v.numero := (p_dados->>'numero')::integer;
      exception when others then
        raise exception 'dados_invalidos';
      end;
    else
      v.numero := coalesce((select max(numero) from public.sci_vitimas where operacao_id = p_operacao), 0) + 1;
    end if;
  else
    select * into v from public.sci_vitimas where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'sci_vitima_inexistente';
    end if;
    if p_dados ? 'numero' and nullif(p_dados->>'numero', '') is not null then
      begin
        v.numero := (p_dados->>'numero')::integer;
      exception when others then
        raise exception 'dados_invalidos';
      end;
    end if;
  end if;
  v_ant := v;
  if v.numero is null or v.numero not between 1 and 9999 then
    raise exception 'dados_invalidos';
  end if;
  if exists (select 1 from public.sci_vitimas where operacao_id = p_operacao and numero = v.numero and id <> v.id) then
    raise exception 'numero_em_uso';
  end if;
  if p_dados ? 'nome' then v.nome := left(btrim(regexp_replace(coalesce(p_dados->>'nome', ''), '\s+', ' ', 'g')), 80); end if;
  if p_dados ? 'local' then v.local := left(btrim(coalesce(p_dados->>'local', '')), 200); end if;
  if p_dados ? 'destino' then v.destino := left(btrim(coalesce(p_dados->>'destino', '')), 200); end if;
  if p_dados ? 'observacoes' then v.observacoes := left(btrim(coalesce(p_dados->>'observacoes', '')), 1000); end if;
  if p_dados ? 'idade_estimada' then v.idade_estimada := coalesce((p_dados->>'idade_estimada')::boolean, false); end if;
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
  if v.idade is null then v.idade_estimada := false; end if;
  if p_dados ? 'sexo' then v.sexo := nullif(btrim(coalesce(p_dados->>'sexo', '')), ''); end if;
  if p_dados ? 'triagem' then v.triagem := nullif(btrim(coalesce(p_dados->>'triagem', '')), ''); end if;
  if p_dados ? 'fase' then v.fase := coalesce(nullif(p_dados->>'fase', ''), v.fase); end if;
  if p_dados ? 'vitima_id' then
    begin
      v.vitima_id := nullif(p_dados->>'vitima_id', '')::uuid;
    exception when others then
      raise exception 'dados_invalidos';
    end;
    if v.vitima_id is not null and not exists (select 1 from public.vitimas where id = v.vitima_id and operacao_id = p_operacao) then
      raise exception 'vitima_nao_encontrada';
    end if;
  end if;
  if (v.sexo is not null and v.sexo not in ('M', 'F')) or (v.triagem is not null and v.triagem not in ('verde', 'amarelo', 'vermelho', 'cinza'))
     or v.fase not in ('localizada', 'removida', 'transportada') then
    raise exception 'dados_invalidos';
  end if;
  -- horários de cada passo (voltar uma fase é correção: o horário da fase desfeita é apagado)
  if v.fase <> v_ant.fase or v_novo then
    if array_position(v_ordem, v.fase) >= 2 and v.removida_em is null then v.removida_em := v_em; end if;
    if array_position(v_ordem, v.fase) >= 3 and v.transportada_em is null then v.transportada_em := v_em; end if;
    if array_position(v_ordem, v.fase) < 3 then v.transportada_em := null; end if;
    if array_position(v_ordem, v.fase) < 2 then v.removida_em := null; end if;
  end if;
  if v.triagem is distinct from v_ant.triagem then
    v.triada_em := case when v.triagem is null then null else v_em end;
  end if;
  v.atualizado_em := now();
  v.atualizado_por_nome := v_nome;
  if v_novo then
    insert into public.sci_vitimas select v.*;
    perform public.sci_evento_interno(p_operacao, v.localizada_em, 'resgate',
      public.sci_vnum(v.numero) || ' localizada' || case when v.local <> '' then ' — ' || v.local else '' end ||
      case when v.sexo is not null then ' (' || case v.sexo when 'M' then 'masculino' else 'feminino' end || ')' else '' end,
      false, 'automatico', 'vitima:' || v.id);
    if v.fase <> 'localizada' then
      perform public.sci_evento_interno(p_operacao, v_em, 'resgate', public.sci_vnum(v.numero) ||
        case v.fase when 'removida' then ' removida para a ACV' else ' transportada' || case when v.destino <> '' then ' — ' || v.destino else '' end end,
        false, 'automatico', 'vitima:' || v.id);
    end if;
  else
    update public.sci_vitimas set numero = v.numero, nome = v.nome, idade = v.idade, idade_estimada = v.idade_estimada, sexo = v.sexo,
           triagem = v.triagem, fase = v.fase, local = v.local, destino = v.destino, observacoes = v.observacoes, vitima_id = v.vitima_id,
           removida_em = v.removida_em, triada_em = v.triada_em, transportada_em = v.transportada_em,
           atualizado_em = v.atualizado_em, atualizado_por_nome = v.atualizado_por_nome
     where id = v.id;
    if v.fase <> v_ant.fase then
      perform public.sci_evento_interno(p_operacao, v_em, 'resgate', public.sci_vnum(v.numero) ||
        case when array_position(v_ordem, v.fase) < array_position(v_ordem, v_ant.fase) then ' voltou para "' ||
               case v.fase when 'localizada' then 'localizadas' else 'removidas para a ACV' end || '" (correção)'
             when v.fase = 'removida' then ' removida para a ACV'
             else ' transportada' || case when v.destino <> '' then ' — ' || v.destino else '' end end,
        false, 'automatico', 'vitima:' || v.id);
    end if;
  end if;
  if v.triagem is distinct from v_ant.triagem and v.triagem is not null then
    perform public.sci_evento_interno(p_operacao, v_em, case when v.triagem = 'cinza' then 'seguranca' else 'resgate' end,
      public.sci_vnum(v.numero) || case when v.triagem = 'cinza' then ' — óbito (triagem CINZA)' else ' triada ' || public.sci_rotulo_triagem(v.triagem) end,
      false, 'automatico', 'vitima:' || v.id);
  end if;
  return row_to_json(v);
end;
$$;

create or replace function public.sci_excluir_vitima(p_id uuid, p_motivo text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v public.sci_vitimas%rowtype;
  v_nome text;
begin
  select * into v from public.sci_vitimas where id = p_id;
  if not found then
    raise exception 'sci_vitima_inexistente';
  end if;
  v_nome := public.sci_conferir(v.operacao_id);
  if char_length(btrim(coalesce(p_motivo, ''))) < 3 then
    raise exception 'justificativa_obrigatoria';
  end if;
  delete from public.sci_vitimas where id = v.id;
  perform public.sci_evento_interno(v.operacao_id, now(), 'informacao', public.sci_vnum(v.numero) || ' retirada do quadro: ' || left(btrim(p_motivo), 300),
    false, 'automatico', 'vitima:' || v.id);
  return json_build_object('id', v.id, 'excluida', true);
end;
$$;

-- Modo teste (antes da ocorrência). Ligar: só com o quadro ainda vazio (sem vítimas nem registros).
-- Desligar = zerar: apaga as vítimas, a linha do tempo, os marcos e o total de teste. Funções, instalações, equipes,
-- órgãos e recursos preparados ficam. Nada do modo teste foi para o diário.
create or replace function public.sci_modo_teste(p_operacao uuid, p_ligar boolean)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.sci_conferir(p_operacao);
  s public.sci_estado%rowtype;
  v_v integer := 0;
  v_e integer := 0;
begin
  select * into s from public.sci_estado where operacao_id = p_operacao for update;
  if coalesce(p_ligar, false) then
    if s.teste then
      return json_build_object('teste', true);
    end if;
    if exists (select 1 from public.sci_vitimas where operacao_id = p_operacao) or exists (select 1 from public.sci_eventos where operacao_id = p_operacao)
       or s.marcos <> '{}'::jsonb then
      raise exception 'sci_ja_iniciado';
    end if;
    update public.sci_estado set teste = true, atualizado_em = now(), atualizado_por_nome = v_nome where operacao_id = p_operacao;
    return json_build_object('teste', true);
  end if;
  if not s.teste then
    return json_build_object('teste', false);
  end if;
  delete from public.sci_vitimas where operacao_id = p_operacao;
  get diagnostics v_v = row_count;
  delete from public.sci_eventos where operacao_id = p_operacao;
  get diagnostics v_e = row_count;
  update public.sci_estado set teste = false, marcos = '{}'::jsonb, total_vitimas = null, total_confirmado = false,
         atualizado_em = now(), atualizado_por_nome = v_nome
   where operacao_id = p_operacao;
  perform public.diario_auto(p_operacao, now(), 'operacao', 'sci_zerado', 'SCI pronto: dados de teste zerados',
    v_v || ' vítima(s) e ' || v_e || ' registro(s) de teste apagados', 'sci_zerado:' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
    'info', null, null, null, v_nome);
  return json_build_object('teste', false, 'vitimas', v_v, 'eventos', v_e);
end;
$$;

/* ---------- Eventos (registro manual, correção, confirmação, anulação) ---------- */
create or replace function public.sci_registrar_evento(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.sci_conferir(p_operacao);
  v_em timestamptz;
  e public.sci_eventos%rowtype;
begin
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' or coalesce(p_dados->>'categoria', '') not in ('decisao', 'seguranca', 'resgate', 'informacao', 'recurso', 'comunicacao')
     or char_length(btrim(coalesce(p_dados->>'texto', ''))) not between 1 and 1000 then
    raise exception 'dados_invalidos';
  end if;
  begin
    v_em := coalesce(nullif(p_dados->>'em', '')::timestamptz, now());
  exception when others then
    raise exception 'data_invalida';
  end;
  if v_em > now() + interval '5 minutes' or v_em < now() - interval '30 days' then
    raise exception 'data_invalida';
  end if;
  e := public.sci_evento_interno(p_operacao, v_em, p_dados->>'categoria', p_dados->>'texto',
                                 coalesce((p_dados->>'nao_confirmada')::boolean, false), 'manual', null);
  return row_to_json(e);
end;
$$;

-- Correção: o texto e a hora anteriores ficam no histórico do evento e a correção entra no diário.
create or replace function public.sci_corrigir_evento(p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  e public.sci_eventos%rowtype;
  v_nome text;
  v_em timestamptz;
  v_txt text;
  v_cat text;
begin
  select * into e from public.sci_eventos where id = p_id for update;
  if not found then
    raise exception 'sci_registro_inexistente';
  end if;
  v_nome := public.sci_conferir(e.operacao_id);
  p_dados := coalesce(p_dados, '{}'::jsonb);
  begin
    v_em := coalesce(nullif(p_dados->>'em', '')::timestamptz, e.ocorrido_em);
  exception when others then
    raise exception 'data_invalida';
  end;
  if v_em > now() + interval '5 minutes' then
    raise exception 'data_invalida';
  end if;
  v_txt := coalesce(nullif(btrim(coalesce(p_dados->>'texto', '')), ''), e.texto);
  v_cat := coalesce(nullif(p_dados->>'categoria', ''), e.categoria);
  if char_length(v_txt) > 1000 or v_cat not in ('decisao', 'seguranca', 'resgate', 'informacao', 'recurso', 'comunicacao') then
    raise exception 'dados_invalidos';
  end if;
  if v_txt = e.texto and v_em = e.ocorrido_em and v_cat = e.categoria then
    return row_to_json(e);
  end if;
  update public.sci_eventos
     set historico = historico || jsonb_build_array(jsonb_build_object('em', now(), 'por', v_nome, 'texto', e.texto, 'ocorrido_em', e.ocorrido_em, 'categoria', e.categoria,
                                                                       'motivo', left(btrim(coalesce(p_dados->>'motivo', '')), 300))),
         texto = v_txt, ocorrido_em = v_em, categoria = v_cat, corrigido_em = now()
   where id = e.id returning * into e;
  perform public.diario_auto(e.operacao_id, now(), 'observacao', 'sci_correcao', 'SCI · Correção de registro',
    'Agora: ' || to_char(e.ocorrido_em at time zone 'America/Sao_Paulo', 'DD/MM HH24"h"MI') || ' ' || e.texto ||
    ' · Antes: ' || to_char((e.historico->-1->>'ocorrido_em')::timestamptz at time zone 'America/Sao_Paulo', 'DD/MM HH24"h"MI') || ' ' || (e.historico->-1->>'texto') ||
    case when coalesce(p_dados->>'motivo', '') <> '' then ' · Motivo: ' || left(btrim(p_dados->>'motivo'), 300) else '' end,
    'sci_corr:' || e.id || ':' || jsonb_array_length(e.historico), 'info', null, null, e.id::text, v_nome);
  return row_to_json(e);
end;
$$;

create or replace function public.sci_confirmar_evento(p_id uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  e public.sci_eventos%rowtype;
  v_nome text;
begin
  select * into e from public.sci_eventos where id = p_id for update;
  if not found then
    raise exception 'sci_registro_inexistente';
  end if;
  v_nome := public.sci_conferir(e.operacao_id);
  if not e.nao_confirmada then
    return row_to_json(e);
  end if;
  update public.sci_eventos set nao_confirmada = false, confirmada_em = now(), confirmada_por_nome = v_nome where id = e.id returning * into e;
  perform public.diario_auto(e.operacao_id, now(), 'observacao', 'sci_confirmacao', 'SCI · Informação confirmada pela equipe', e.texto,
    'sci_conf:' || e.id, 'info', null, null, e.id::text, v_nome);
  return row_to_json(e);
end;
$$;

create or replace function public.sci_anular_evento(p_id uuid, p_motivo text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  e public.sci_eventos%rowtype;
  v_nome text;
begin
  select * into e from public.sci_eventos where id = p_id for update;
  if not found then
    raise exception 'sci_registro_inexistente';
  end if;
  v_nome := public.sci_conferir(e.operacao_id);
  if char_length(btrim(coalesce(p_motivo, ''))) < 3 then
    raise exception 'justificativa_obrigatoria';
  end if;
  if e.anulado_em is not null then
    return row_to_json(e);
  end if;
  update public.sci_eventos set anulado_em = now(), anulado_por_nome = v_nome, anulado_motivo = left(btrim(p_motivo), 300) where id = e.id returning * into e;
  perform public.diario_auto(e.operacao_id, now(), 'observacao', 'sci_anulacao', 'SCI · Registro anulado', e.texto || ' · Motivo: ' || e.anulado_motivo,
    'sci_anul:' || e.id, 'info', null, null, e.id::text, v_nome);
  return row_to_json(e);
end;
$$;

/* ---------- Itens: instalações, equipes, órgãos, recursos, canais, nível do rio, imagens ---------- */
-- Limpa e valida os dados de cada tipo: só as chaves conhecidas, textos aparados, números e horas conferidos.
create or replace function public.sci_limpar_item(p_tipo text, p_dados jsonb)
returns jsonb
language plpgsql stable set search_path = public
as $$
declare
  v_txt text[];
  v_int text[] := '{}';
  v_num text[] := '{}';
  v_ts text[] := '{}';
  v_enum jsonb := '{}'::jsonb;
  v_obrig text;
  r jsonb := '{}'::jsonb;
  k text;
  v jsonb;
  t text;
begin
  if p_dados is null or jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  if p_tipo = 'instalacao' then
    v_txt := array['nome', 'responsavel', 'local', 'motivo', 'nota']; v_num := array['lat', 'lng']; v_ts := array['ativada_em', 'desativada_em'];
    v_enum := '{"tipo": ["pc", "area_espera", "acv", "zpa", "abrigo", "ggi", "outra"], "estado": ["ativa", "planejada", "desativada"]}';
    v_obrig := 'nome';
  elsif p_tipo = 'equipe' then
    v_txt := array['nome', 'orgao', 'missao', 'funcao', 'setor', 'chefe', 'meios', 'notas', 'setor_id', 'grupo_id']; v_int := array['efetivo'];
    v_enum := '{"status": ["designada", "em_deslocamento", "em_operacao", "disponivel", "desmobilizada"]}';
    v_obrig := 'nome';
  elsif p_tipo = 'orgao' then
    v_txt := array['nome', 'detalhe', 'missao', 'nota']; v_int := array['pessoas', 'viaturas']; v_ts := array['acionado_em', 'chegada_em'];
    v_enum := '{"situacao": ["acionado", "a_caminho", "no_local", "desmobilizado"]}';
    v_obrig := 'nome';
  elsif p_tipo = 'recurso' then
    v_txt := array['nome', 'orgao', 'local', 'nota']; v_int := array['qtd']; v_ts := array['solicitado_em', 'chegada_em'];
    v_enum := '{"tipo": ["viatura", "embarcacao", "aeronave", "equipamento", "outro"], "status": ["solicitado", "a_caminho", "no_local", "em_uso", "indisponivel", "desmobilizado"]}';
    v_obrig := 'nome';
  elsif p_tipo = 'canal' then
    v_txt := array['nome', 'funcao', 'usuarios'];
    v_obrig := 'nome';
  elsif p_tipo = 'leitura_rio' then
    v_txt := array['ponto', 'nivel', 'vazao', 'fonte']; v_ts := array['em'];
    v_enum := '{"tendencia": ["subindo", "estavel", "descendo", "a_confirmar"]}';
    v_obrig := 'em';
  elsif p_tipo = 'imagem' then
    v_txt := array['caminho', 'legenda'];
    v_obrig := 'caminho';
  else
    raise exception 'dados_invalidos';
  end if;
  for k, v in select * from jsonb_each(p_dados) loop
    if coalesce(jsonb_typeof(v), 'null') = 'null' then
      continue;
    elsif k = any(v_txt) then
      t := btrim(regexp_replace(v #>> '{}', '\s+', ' ', 'g'));
      if k in ('notas', 'nota', 'detalhe', 'missao', 'motivo') then t := left(btrim(v #>> '{}'), 1000); else t := left(t, 200); end if;
      if t <> '' then r := r || jsonb_build_object(k, t); end if;
    elsif k = any(v_int) then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 100000 or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) then
        raise exception 'dados_invalidos';
      end if;
      r := r || jsonb_build_object(k, (v #>> '{}')::integer);
    elsif k = any(v_num) then
      if jsonb_typeof(v) <> 'number' or (k = 'lat' and abs((v #>> '{}')::numeric) > 90) or (k = 'lng' and abs((v #>> '{}')::numeric) > 180) then
        raise exception 'posicao_invalida';
      end if;
      r := r || jsonb_build_object(k, v);
    elsif k = any(v_ts) then
      begin
        r := r || jsonb_build_object(k, (v #>> '{}')::timestamptz);
      exception when others then
        raise exception 'data_invalida';
      end;
    elsif v_enum ? k then
      if not ((v_enum->k) ? (v #>> '{}')) then
        raise exception 'dados_invalidos';
      end if;
      r := r || jsonb_build_object(k, v #>> '{}');
    end if;
  end loop;
  if (r ? 'lat') <> (r ? 'lng') then
    raise exception 'posicao_invalida';
  end if;
  if not (r ? v_obrig) then
    raise exception 'dados_invalidos';
  end if;
  return r;
end;
$$;

create or replace function public.sci_salvar_item(p_operacao uuid, p_id uuid, p_tipo text, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.sci_conferir(p_operacao);
  i public.sci_itens%rowtype;
  v_ant jsonb;
  d jsonb;
  v_rot text;
begin
  if p_id is null then
    i.id := gen_random_uuid();
    i.operacao_id := p_operacao;
    i.tipo := p_tipo;
    i.ordem := coalesce((select max(ordem) from public.sci_itens where operacao_id = p_operacao and tipo = p_tipo), 0) + 1;
    i.criado_por_nome := v_nome;
    i.criado_em := now();
    v_ant := '{}'::jsonb;
  else
    select * into i from public.sci_itens where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'sci_item_inexistente';
    end if;
    v_ant := i.dados;
  end if;
  d := public.sci_limpar_item(i.tipo, p_dados);
  if i.tipo = 'imagem' then
    if d->>'caminho' !~ ('^' || p_operacao::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$')
       or (p_id is not null and d->>'caminho' is distinct from v_ant->>'caminho') then
      raise exception 'dados_invalidos';
    end if;
    if not exists (select 1 from storage.objects where bucket_id = 'sci' and name = d->>'caminho') then
      raise exception 'imagem_nao_enviada';
    end if;
  end if;
  if i.tipo = 'leitura_rio' and (d->>'em')::timestamptz > now() + interval '5 minutes' then
    raise exception 'data_invalida';
  end if;
  i.dados := d;
  i.atualizado_em := now();
  i.atualizado_por_nome := v_nome;
  if p_id is null then
    insert into public.sci_itens select i.*;
  else
    update public.sci_itens set dados = i.dados, atualizado_em = i.atualizado_em, atualizado_por_nome = i.atualizado_por_nome where id = i.id;
  end if;
  -- mudanças que contam a história da ocorrência entram sozinhas na linha do tempo
  if i.tipo = 'orgao' and d->>'situacao' is distinct from v_ant->>'situacao' and d->>'situacao' in ('acionado', 'no_local', 'desmobilizado') then
    perform public.sci_evento_interno(p_operacao, coalesce(case d->>'situacao' when 'no_local' then (d->>'chegada_em')::timestamptz
                                                                                 when 'acionado' then (d->>'acionado_em')::timestamptz end, now()), 'recurso',
      (d->>'nome') || case d->>'situacao' when 'no_local' then ' no local' || coalesce(' (' || (d->>'pessoas') || ' pessoas)', '')
                                          when 'acionado' then ' acionado' else ' desmobilizado' end
      || coalesce(' — ' || nullif(d->>'missao', ''), ''), false, 'automatico', 'item:' || i.id);
  elsif i.tipo = 'recurso' and d->>'status' is distinct from v_ant->>'status' and d->>'status' in ('solicitado', 'no_local', 'indisponivel', 'desmobilizado') then
    perform public.sci_evento_interno(p_operacao, coalesce(case when d->>'status' = 'no_local' then (d->>'chegada_em')::timestamptz
                                                                when d->>'status' = 'solicitado' then (d->>'solicitado_em')::timestamptz end, now()), 'recurso',
      (d->>'nome') || case d->>'status' when 'solicitado' then ' solicitado' when 'no_local' then ' chegou ao local'
                                        when 'indisponivel' then ' indisponível' else ' desmobilizado' end
      || coalesce(' — ' || nullif(d->>'nota', ''), ''), false, 'automatico', 'item:' || i.id);
  elsif i.tipo = 'instalacao' and coalesce(d->>'estado', 'ativa') is distinct from coalesce(v_ant->>'estado', case when p_id is null then '' else 'ativa' end) then
    v_rot := case d->>'tipo' when 'pc' then 'Posto de Comando' when 'area_espera' then 'Área de Espera' when 'acv' then 'Área de Concentração de Vítimas'
                             when 'zpa' then 'ZPA' when 'abrigo' then 'Abrigo' when 'ggi' then 'GGI' else 'Instalação' end;
    perform public.sci_evento_interno(p_operacao, now(), 'decisao',
      v_rot || case when v_rot <> d->>'nome' then ' (' || (d->>'nome') || ')' else '' end ||
      case coalesce(d->>'estado', 'ativa') when 'ativa' then ' estabelecida' when 'planejada' then ' planejada' else ' desativada' end ||
      coalesce(' — responsável: ' || nullif(d->>'responsavel', ''), '') || coalesce(' — ' || nullif(d->>'motivo', ''), ''),
      false, 'automatico', 'item:' || i.id);
  elsif i.tipo = 'equipe' and d->>'status' is distinct from v_ant->>'status' and d->>'status' in ('em_operacao', 'desmobilizada') then
    perform public.sci_evento_interno(p_operacao, now(), 'decisao',
      'Equipe ' || (d->>'nome') || case d->>'status' when 'em_operacao' then ' em operação' else ' desmobilizada' end || coalesce(' — ' || nullif(d->>'missao', ''), ''),
      false, 'automatico', 'item:' || i.id);
  elsif i.tipo = 'leitura_rio' and p_id is null then
    perform public.sci_evento_interno(p_operacao, (d->>'em')::timestamptz, 'seguranca',
      'Nível do rio' || coalesce(' (' || nullif(d->>'ponto', '') || ')', '') || ': ' || coalesce(nullif(d->>'nivel', ''), '—') ||
      coalesce(', ' || nullif(d->>'vazao', ''), '') || case d->>'tendencia' when 'subindo' then ' — SUBINDO' when 'estavel' then ' — estável'
                                                         when 'descendo' then ' — descendo' else '' end || coalesce(' · fonte: ' || nullif(d->>'fonte', ''), ''),
      false, 'automatico', 'item:' || i.id);
  end if;
  return row_to_json(i);
end;
$$;

create or replace function public.sci_excluir_item(p_id uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  i public.sci_itens%rowtype;
begin
  select * into i from public.sci_itens where id = p_id;
  if not found then
    raise exception 'sci_item_inexistente';
  end if;
  perform public.sci_conferir(i.operacao_id);
  delete from public.sci_itens where id = i.id;
  return json_build_object('id', i.id, 'excluido', true);
end;
$$;

/* ---------- Imagens do local (bucket privado "sci") ---------- */
-- Caminho: <operação>/<uuid>.jpg. Apagar o registro (ou a operação) põe o arquivo na fila de remoção.
create or replace function public.sci_fila_apagar_imagem()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if old.tipo = 'imagem' and old.dados->>'caminho' is not null then
    insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
    values (old.dados->>'caminho', 'sci', old.operacao_id, auth.uid())
    on conflict (caminho) do nothing;
  end if;
  return old;
end;
$$;
drop trigger if exists sci_itens_apagar_imagem on public.sci_itens;
create trigger sci_itens_apagar_imagem after delete on public.sci_itens
  for each row execute function public.sci_fila_apagar_imagem();

create or replace function public.sci_operacao_do_caminho(p_nome text)
returns uuid
language plpgsql immutable set search_path = public
as $$
begin
  if coalesce(p_nome, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$' then
    return null;
  end if;
  return split_part(p_nome, '/', 1)::uuid;
end;
$$;

create or replace function public.pode_enviar_imagem_sci(p_nome text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.sci_operacao_do_caminho(p_nome) is not null and public.dono_operacao(public.sci_operacao_do_caminho(p_nome))
     and exists (select 1 from public.operacoes o where o.id = public.sci_operacao_do_caminho(p_nome) and o.status = 'ativa' and o.dados_apagados_em is null);
$$;

create or replace function public.pode_ver_imagem_sci(p_nome text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select (public.sci_operacao_do_caminho(p_nome) is not null and public.dono_operacao(public.sci_operacao_do_caminho(p_nome)))
      or exists (select 1 from public.arquivos_pendentes a where a.caminho = p_nome and a.bucket = 'sci' and a.excluido_por = auth.uid());
$$;

create or replace function public.pode_apagar_imagem_sci(p_nome text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.arquivos_pendentes a where a.caminho = p_nome and a.bucket = 'sci'
                  and (a.excluido_por = auth.uid() or (a.operacao_id is not null and public.dono_operacao(a.operacao_id))));
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sci', 'sci', false, 10485760, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists gbs_sci_enviar on storage.objects;
create policy gbs_sci_enviar on storage.objects
  for insert to authenticated
  with check (bucket_id = 'sci' and public.pode_enviar_imagem_sci(name));
drop policy if exists gbs_sci_ver on storage.objects;
create policy gbs_sci_ver on storage.objects
  for select to authenticated
  using (bucket_id = 'sci' and public.pode_ver_imagem_sci(name));
drop policy if exists gbs_sci_apagar on storage.objects;
create policy gbs_sci_apagar on storage.objects
  for delete to authenticated
  using (bucket_id = 'sci' and public.pode_apagar_imagem_sci(name));

/* ---------- Retenção: dados pessoais do quadro de vítimas saem com os demais ---------- */
create or replace function public.apagar_sci_da_operacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.sci_vitimas where operacao_id = new.id;
    delete from public.sci_itens where operacao_id = new.id and tipo = 'imagem';
  end if;
  return new;
end;
$$;
drop trigger if exists operacoes_apagar_sci on public.operacoes;
create trigger operacoes_apagar_sci after update of dados_apagados_em on public.operacoes
  for each row execute function public.apagar_sci_da_operacao();

/* ---------- Permissões ---------- */
revoke execute on function public.sci_evento_interno(uuid, timestamptz, text, text, boolean, text, text) from public, anon, authenticated;
revoke execute on function public.sci_conferir(uuid) from public, anon, authenticated;
revoke execute on function public.sci_limpar_item(text, jsonb) from public, anon, authenticated;
revoke execute on function public.sci_operacao_do_caminho(text) from public, anon;
revoke execute on function public.sci_rotulo_marco(text) from public, anon, authenticated;
revoke execute on function public.sci_rotulo_funcao(text) from public, anon, authenticated;
revoke execute on function public.sci_rotulo_triagem(text) from public, anon, authenticated;
revoke execute on function public.sci_vnum(integer) from public, anon, authenticated;
do $$
declare
  f text;
begin
  foreach f in array array['sci_salvar_estado(uuid, jsonb)', 'sci_marcar(uuid, text, timestamptz, boolean)', 'sci_salvar_vitima(uuid, uuid, jsonb)',
                           'sci_excluir_vitima(uuid, text)', 'sci_modo_teste(uuid, boolean)', 'sci_registrar_evento(uuid, jsonb)',
                           'sci_corrigir_evento(uuid, jsonb)', 'sci_confirmar_evento(uuid)', 'sci_anular_evento(uuid, text)',
                           'sci_salvar_item(uuid, uuid, text, jsonb)', 'sci_excluir_item(uuid)',
                           'pode_enviar_imagem_sci(text)', 'pode_ver_imagem_sci(text)', 'pode_apagar_imagem_sci(text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
