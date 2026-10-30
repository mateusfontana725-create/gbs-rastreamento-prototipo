-- =====================================================================
-- 53. Convites por categoria (civil, bombeiro, responsável) por e-mail ou WhatsApp, e tipos de ponto
--     criados pelos usuários (migração 047 — idempotente; exige a 003 e a 044)
--
--  1) Convite: escolhe a categoria (civil → link dos civis; militar → link dos bombeiros; responsável → painel
--     da operação, que pede login) e o canal (e-mail, enviado pelo servidor; WhatsApp, aberto no aparelho do
--     responsável com a mensagem pronta, sem salvar o contato). O WhatsApp usa o telefone (com DDD).
--  2) Tipos de ponto: além das categorias fixas (que têm regras: risco com raio de alerta, base, vítima…),
--     os responsáveis criam tipos com nome, ícone (emoji ou letras) e cor, usados em todas as operações.
--     O ponto de um tipo criado fica na categoria "OUTRO" (sem regra) e guarda o ícone e a cor do tipo.
-- =====================================================================

/* ---------- 1. Convites por categoria e canal ---------- */
alter table public.convites_participante add column if not exists tipo text not null default 'civil';
alter table public.convites_participante add column if not exists canal text not null default 'email';
alter table public.convites_participante add column if not exists telefone text;
alter table public.convites_participante alter column email drop not null;
do $$
begin
  alter table public.convites_participante add constraint convites_participante_categoria_ok check (
    tipo in ('civil', 'militar', 'responsavel') and canal in ('email', 'whatsapp')
    and (telefone is null or telefone ~ '^[0-9]{10,13}$')
    and ((canal = 'email' and email is not null) or (canal = 'whatsapp' and telefone is not null)));
exception when duplicate_object then null;
end;
$$;
create unique index if not exists convites_participante_telefone_uk on public.convites_participante (operacao_id, telefone, tipo) where telefone is not null;

-- p_dados: nome, tipo (civil | militar | responsavel), canal (email | whatsapp), email ou telefone (com DDD).
-- O mesmo e-mail (ou telefone) e a mesma categoria na operação reaproveitam o convite.
create or replace function public.criar_convite(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_resp text := public.nome_responsavel_atual();
  v_status text;
  v_nome text := btrim(regexp_replace(coalesce(p_dados->>'nome', ''), '\s+', ' ', 'g'));
  v_tipo text := coalesce(nullif(p_dados->>'tipo', ''), 'civil');
  v_canal text := coalesce(nullif(p_dados->>'canal', ''), 'email');
  v_email text := lower(btrim(coalesce(p_dados->>'email', '')));
  v_tel text := regexp_replace(coalesce(p_dados->>'telefone', ''), '[^0-9]', '', 'g');
  c public.convites_participante%rowtype;
begin
  if v_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if v_tipo not in ('civil', 'militar', 'responsavel') or v_canal not in ('email', 'whatsapp') then
    raise exception 'dados_invalidos';
  end if;
  if char_length(v_nome) not between 2 and 40 then
    raise exception 'nome_convite_invalido';
  end if;
  if v_canal = 'email' then
    if char_length(v_email) > 200 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
      raise exception 'email_convite_invalido';
    end if;
    v_tel := null;
    select * into c from public.convites_participante where operacao_id = p_operacao and email = v_email for update;
  else
    if char_length(v_tel) in (10, 11) then v_tel := '55' || v_tel; end if;   -- DDD + número: Brasil
    if v_tel !~ '^[0-9]{12,13}$' then
      raise exception 'telefone_convite_invalido';
    end if;
    v_email := null;
    select * into c from public.convites_participante where operacao_id = p_operacao and telefone = v_tel and tipo = v_tipo for update;
  end if;
  if found then
    update public.convites_participante set nome = v_nome, tipo = v_tipo, canal = v_canal where id = c.id returning * into c;
    return row_to_json(c);
  end if;
  if (select count(*) from public.convites_participante where operacao_id = p_operacao) >= 200 then
    raise exception 'convites_limite';
  end if;
  insert into public.convites_participante (operacao_id, nome, email, telefone, tipo, canal, criado_por_nome)
  values (p_operacao, v_nome, v_email, v_tel, v_tipo, v_canal, v_resp) returning * into c;
  perform public.diario_auto(p_operacao, now(), 'pessoa', 'convite_criado',
    'Convite ' || case v_canal when 'email' then 'por e-mail' else 'por WhatsApp' end || ' (' ||
      case v_tipo when 'civil' then 'civil' when 'militar' then 'bombeiro' else 'responsável' end || '): ' || v_nome, '',
    'convite:' || c.id, 'info', null, null, c.id::text, v_resp);
  return row_to_json(c);
end;
$$;

-- Dados do envio pelo servidor (e-mail): agora com a categoria e o que o link de cada uma precisa.
create or replace function public.convite_dados_envio(p_convite uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  c public.convites_participante%rowtype;
  o public.operacoes%rowtype;
begin
  select * into c from public.convites_participante where id = p_convite;
  if not found or not public.dono_operacao(c.operacao_id) or public.nome_responsavel_atual() is null then
    raise exception 'sem_permissao';
  end if;
  select * into o from public.operacoes where id = c.operacao_id;
  if o.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if c.envios >= 5 then
    raise exception 'convite_envios_limite';
  end if;
  if c.canal <> 'email' or c.email is null then
    raise exception 'dados_invalidos';
  end if;
  return json_build_object('id', c.id, 'nome', c.nome, 'email', c.email, 'codigo', c.codigo, 'operacao', o.codigo, 'operacao_id', o.id,
                           'tipo', c.tipo, 'token_civil', o.token_civil, 'token_militar', o.token_militar,
                           'envios', c.envios, 'responsavel', public.nome_responsavel_atual());
end;
$$;

/* ---------- 2. Tipos de ponto ---------- */
create table if not exists public.tipos_ponto (
  id               uuid primary key default gen_random_uuid(),
  nome             text not null check (char_length(btrim(nome)) between 2 and 40),
  icone            text not null check (char_length(icone) between 1 and 8),
  cor              text not null check (cor ~ '^#[0-9a-fA-F]{6}$'),
  ativo            boolean not null default true,
  criado_por       uuid references auth.users(id) on delete set null,
  criado_por_nome  text not null,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now()
);
create unique index if not exists tipos_ponto_nome_uk on public.tipos_ponto (lower(btrim(nome))) where ativo;
alter table public.tipos_ponto enable row level security;
drop policy if exists tipos_ponto_ler on public.tipos_ponto;
create policy tipos_ponto_ler on public.tipos_ponto for select to authenticated using (public.nome_responsavel_atual() is not null);
revoke all on public.tipos_ponto from anon;
revoke insert, update, delete, truncate on public.tipos_ponto from authenticated;
grant select on public.tipos_ponto to authenticated;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'tipos_ponto') then
    execute 'alter publication supabase_realtime add table public.tipos_ponto';
  end if;
end;
$$;

alter table public.pontos_interesse add column if not exists tipo_id uuid references public.tipos_ponto(id) on delete set null;
alter table public.pontos_interesse add column if not exists icone text;
alter table public.pontos_interesse add column if not exists cor text;
do $$
begin
  alter table public.pontos_interesse add constraint pontos_interesse_tipo_ok check (
    (icone is null or char_length(icone) between 1 and 8) and (cor is null or cor ~ '^#[0-9a-fA-F]{6}$'));
exception when duplicate_object then null;
end;
$$;

-- Cria ou edita um tipo (qualquer responsável cria; editar e desativar: quem criou ou administrador).
-- p_dados: nome, icone (emoji ou até 3 letras), cor (#rrggbb), ativo
create or replace function public.salvar_tipo_ponto(p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.nome_responsavel_atual();
  t public.tipos_ponto%rowtype;
begin
  if v_nome is null then
    raise exception 'sem_permissao';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if p_id is null then
    t.id := gen_random_uuid(); t.ativo := true; t.criado_por := auth.uid(); t.criado_por_nome := v_nome; t.criado_em := now();
  else
    select * into t from public.tipos_ponto where id = p_id for update;
    if not found then
      raise exception 'tipo_ponto_inexistente';
    end if;
    if t.criado_por is distinct from auth.uid() and not public.eh_admin() then
      raise exception 'sem_permissao';
    end if;
  end if;
  if p_dados ? 'nome' then t.nome := btrim(regexp_replace(coalesce(p_dados->>'nome', ''), '\s+', ' ', 'g')); end if;
  if p_dados ? 'icone' then t.icone := btrim(coalesce(p_dados->>'icone', '')); end if;
  if p_dados ? 'cor' then t.cor := lower(btrim(coalesce(p_dados->>'cor', ''))); end if;
  if p_dados ? 'ativo' then t.ativo := coalesce((p_dados->>'ativo')::boolean, true); end if;
  if t.nome is null or char_length(t.nome) not between 2 and 40 then
    raise exception 'nome_invalido';
  end if;
  if t.icone is null or char_length(t.icone) not between 1 and 8 or t.cor is null or t.cor !~ '^#[0-9a-f]{6}$' then
    raise exception 'dados_invalidos';
  end if;
  if t.ativo and exists (select 1 from public.tipos_ponto x where x.ativo and x.id <> t.id and lower(btrim(x.nome)) = lower(t.nome)) then
    raise exception 'tipo_ponto_existente';
  end if;
  t.atualizado_em := now();
  if p_id is null then
    insert into public.tipos_ponto select t.*;
  else
    update public.tipos_ponto set nome = t.nome, icone = t.icone, cor = t.cor, ativo = t.ativo, atualizado_em = t.atualizado_em where id = t.id;
    -- pontos já marcados com este tipo passam a mostrar o novo ícone e a nova cor
    update public.pontos_interesse p set icone = t.icone, cor = t.cor
      from public.operacoes o where p.tipo_id = t.id and o.id = p.operacao_id and o.status = 'ativa';
  end if;
  return row_to_json(t);
end;
$$;

-- Ponto com tipo criado pelos usuários (tipo_id → ícone e cor)
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
  v_tipo public.tipos_ponto%rowtype;
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
  -- tipo criado pelos usuários: a categoria fica "OUTRO" (sem regra especial) e o ícone e a cor vêm do tipo
  if p_dados ? 'tipo_id' then
    if nullif(p_dados->>'tipo_id', '') is null then
      v_p.tipo_id := null; v_p.icone := null; v_p.cor := null;
    else
      begin
        select * into v_tipo from public.tipos_ponto where id = (p_dados->>'tipo_id')::uuid and ativo;
      exception when others then
        raise exception 'dados_invalidos';
      end;
      if v_tipo.id is null then
        raise exception 'tipo_ponto_inexistente';
      end if;
      v_p.tipo_id := v_tipo.id; v_p.icone := v_tipo.icone; v_p.cor := v_tipo.cor; v_p.categoria := 'OUTRO';
    end if;
  elsif p_dados ? 'categoria' and v_p.categoria <> 'OUTRO' then
    v_p.tipo_id := null; v_p.icone := null; v_p.cor := null;
  end if;
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
           lat = v_p.lat, lng = v_p.lng, foto_id = v_p.foto_id, raio_m = v_p.raio_m, tipo_id = v_p.tipo_id, icone = v_p.icone, cor = v_p.cor,
           atualizado_em = v_p.atualizado_em,
           atualizado_por_nome = v_p.atualizado_por_nome
     where id = v_p.id;
  end if;
  return row_to_json(v_p);
end;
$$;

revoke execute on function public.criar_convite(uuid, jsonb) from public, anon;
grant execute on function public.criar_convite(uuid, jsonb) to authenticated;
revoke execute on function public.salvar_tipo_ponto(uuid, jsonb) from public, anon;
grant execute on function public.salvar_tipo_ponto(uuid, jsonb) to authenticated;

-- Relatório: pontos com o nome, o ícone e a cor do tipo criado pelos usuários
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
                                        'criado_em', pi.criado_em, 'criado_por_nome', pi.criado_por_nome,
                                        'tipo_nome', tp.nome, 'icone', pi.icone, 'cor', pi.cor) order by pi.criado_em)
        from public.pontos_interesse pi left join public.tipos_ponto tp on tp.id = pi.tipo_id
       where pi.operacao_id = p_operacao), '[]'::json),
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

notify pgrst, 'reload schema';
