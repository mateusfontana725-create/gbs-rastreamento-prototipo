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

notify pgrst, 'reload schema';
