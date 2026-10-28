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
notify pgrst, 'reload schema';
