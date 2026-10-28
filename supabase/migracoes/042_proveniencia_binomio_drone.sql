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

notify pgrst, 'reload schema';
