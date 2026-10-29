-- =====================================================================
-- 50. Cadastro rápido de vítima e convite de participante por e-mail
--     (migração 044 — idempotente; exige a 007, a 031 e a 042)
--
--  1) Cadastro rápido: vitimas.cadastro_rapido marca a ficha criada só com os dados essenciais
--     (nome, idade aproximada, sexo, roupa/característica). O responsável completa depois no
--     formulário da ficha (salvar com o formulário completo tira a marca). A ficha criada em
--     "Vítima encontrada" só com o nome também nasce como cadastro rápido.
--  2) Convite por e-mail: o responsável cadastra nome e e-mail; o servidor (api/convidar.js) envia
--     o link do civil.html com um código do convite. O código só serve para preencher o nome e
--     marcar o convite como aceito; quem manda no acesso continua sendo o token do link.
--     O e-mail é dado pessoal: só os responsáveis da operação leem, e é apagado com a operação
--     (exclusão ou fim da retenção). Limites: 200 convites por operação, 5 envios por convite.
-- =====================================================================
alter table public.vitimas add column if not exists cadastro_rapido boolean not null default false;

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
    v.cadastro_rapido := false;
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
  if p_dados ? 'cadastro_rapido' then v.cadastro_rapido := coalesce((p_dados->>'cadastro_rapido')::boolean, false); end if;
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
    update public.vitimas set nome = v.nome, idade = v.idade, idade_qualidade = v.idade_qualidade, cadastro_rapido = v.cadastro_rapido, caracteristicas = v.caracteristicas, roupas = v.roupas,
           observacoes = v.observacoes, perfil = v.perfil, nascimento = v.nascimento, sexo = v.sexo, origem = v.origem, atualizado_em = v.atualizado_em, atualizado_por_nome = v.atualizado_por_nome
     where id = v.id;
  end if;
  return row_to_json(v);
end;
$$;

create or replace function public.registrar_vitima_encontrada(p_operacao uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_status text;
  v_part public.participantes%rowtype;
  v_enc public.participantes%rowtype;
  v_vit public.vitimas%rowtype;
  v_msg public.mensagens%rowtype;
  v_reg public.vitima_localizacoes%rowtype;
  v_nome_reg text;
  v_condicao text;
  v_lat double precision;
  v_lng double precision;
  v_prec real;
  v_pos_em timestamptz;
  v_enc_txt text;
  v_local text;
  v_obs text;
  v_ref uuid;
  v_vnome text;
begin
  if v_nome_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  v_condicao := p_dados->>'condicao';
  if v_condicao is null or v_condicao not in ('viva', 'obito') then
    raise exception 'dados_invalidos';
  end if;
  begin
    v_lat := nullif(p_dados->>'lat', '')::double precision;
    v_lng := nullif(p_dados->>'lng', '')::double precision;
    v_prec := nullif(p_dados->>'precisao', '')::real;
    v_pos_em := nullif(p_dados->>'posicao_em', '')::timestamptz;
  exception when others then
    raise exception 'posicao_invalida';
  end;
  if (v_lat is null) <> (v_lng is null)
     or (v_lat is not null and (v_lat not between -90 and 90 or v_lng not between -180 and 180 or (v_lat = 0 and v_lng = 0))) then
    raise exception 'posicao_invalida';
  end if;
  v_prec := case when v_prec between 0 and 100000 then v_prec end;
  v_pos_em := case when v_lat is not null then least(coalesce(v_pos_em, now()), now()) end;
  v_enc_txt := nullif(left(btrim(coalesce(p_dados->>'encontrada_por', '')), 120), '');
  v_local := nullif(left(btrim(coalesce(p_dados->>'local_descricao', '')), 500), '');
  v_obs := nullif(left(btrim(coalesce(p_dados->>'observacoes', '')), 1000), '');

  if nullif(p_dados->>'encontrou', '') is not null then
    begin
      v_ref := (p_dados->>'encontrou')::uuid;
    exception when others then
      raise exception 'participante_invalido';
    end;
    select * into v_enc from public.participantes where id = v_ref and operacao_id = p_operacao;
    if not found then
      raise exception 'participante_invalido';
    end if;
  end if;

  -- ficha da vítima: escolhida ou criada agora só com o nome
  if nullif(p_dados->>'vitima_id', '') is not null then
    begin
      v_ref := (p_dados->>'vitima_id')::uuid;
    exception when others then
      raise exception 'vitima_nao_encontrada';
    end;
    select * into v_vit from public.vitimas where id = v_ref and operacao_id = p_operacao;
    if not found then
      raise exception 'vitima_nao_encontrada';
    end if;
  elsif btrim(coalesce(p_dados->>'vitima_nome', '')) <> '' then
    v_vnome := btrim(regexp_replace(p_dados->>'vitima_nome', '\s+', ' ', 'g'));
    if char_length(v_vnome) > 80 then
      raise exception 'nome_vitima_invalido';
    end if;
    insert into public.vitimas (operacao_id, nome, criado_por, criado_por_nome, atualizado_por_nome, cadastro_rapido)
    values (p_operacao, v_vnome, auth.uid(), v_nome_resp, v_nome_resp, true)
    returning * into v_vit;
  end if;

  -- registro do responsável na operação (o mesmo da 025)
  perform public.entrar_como_responsavel(p_operacao);
  select * into v_part from public.participantes where operacao_id = p_operacao and user_id = auth.uid();

  v_nome_reg := v_part.nome ||
    case when v_enc.id is not null and v_enc.id <> v_part.id then ' (encontrada por ' || v_enc.nome || ')'
         when v_enc_txt is not null then ' (encontrada por ' || v_enc_txt || ')' else '' end;

  insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto,
                                direcao, categoria, lat, lng, precisao, posicao_em, entregue_em, lida_em, lida_por_nome)
  values (p_operacao, v_part.id, auth.uid(), v_part.nome, 'PARTICIPANTE', 'Localizada, ver protocolo',
          'entrada', 'VITIMA', v_lat, v_lng, v_prec, v_pos_em, now(), now(), v_part.nome)
  returning * into v_msg;

  insert into public.vitima_localizacoes (operacao_id, participante_id, mensagem_id, condicao, lat, lng, precisao,
                                          posicao_em, registrado_em, registrado_por, registrado_por_nome, registrado_por_tipo,
                                          vitima_id, encontrada_por_texto, local_descricao, observacoes)
  values (p_operacao, v_part.id, v_msg.id, v_condicao, v_lat, v_lng, v_prec,
          v_pos_em, v_msg.criada_em, auth.uid(), left(v_nome_reg, 120), 'responsavel',
          v_vit.id, case when v_enc.id is null then v_enc_txt end, v_local, v_obs)
  returning * into v_reg;

  perform public.criar_alerta(p_operacao, 'vitima_localizada', 'critico',
    'VÍTIMA LOCALIZADA',
    'Registrado por ' || v_nome_reg || ' (responsável)' ||
      case when v_lat is null then ' · sem localização' else '' end || '. Veja a condição no painel.',
    'vitima:' || v_reg.id, null, null, coalesce(v_enc.id, v_part.id), v_lat, v_lng, v_pos_em);

  return json_build_object('mensagem', row_to_json(v_msg), 'registro', row_to_json(v_reg),
                           'vitima', case when v_vit.id is not null then row_to_json(v_vit) end);
end;
$$;

create table if not exists public.convites_participante (
  id                uuid primary key default gen_random_uuid(),
  operacao_id       uuid not null references public.operacoes(id) on delete cascade,
  nome              text not null check (char_length(btrim(nome)) between 2 and 40),
  email             text not null check (char_length(email) <= 200 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'),
  codigo            text not null unique default left(replace(gen_random_uuid()::text, '-', ''), 24),
  criado_por_nome   text not null,
  criado_em         timestamptz not null default now(),
  envios            integer not null default 0,
  enviado_em        timestamptz,
  envio_erro        text check (envio_erro is null or char_length(envio_erro) <= 200),
  aceito_em         timestamptz,
  participante_id   uuid references public.participantes(id) on delete set null,
  unique (operacao_id, email)
);
create index if not exists convites_participante_operacao_idx on public.convites_participante (operacao_id);

alter table public.convites_participante enable row level security;
drop policy if exists convites_participante_ler on public.convites_participante;
create policy convites_participante_ler on public.convites_participante for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.convites_participante from anon;
revoke insert, update, delete, truncate on public.convites_participante from authenticated;
grant select on public.convites_participante to authenticated;
drop trigger if exists convites_participante_encerrada on public.convites_participante;
create trigger convites_participante_encerrada before insert or update or delete on public.convites_participante
  for each row execute function public.bloquear_escrita_encerrada();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'convites_participante') then
    execute 'alter publication supabase_realtime add table public.convites_participante';
  end if;
end;
$$;

-- Fim da retenção: os e-mails dos convidados são apagados junto com os demais dados pessoais.
create or replace function public.apagar_convites_da_operacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.convites_participante where operacao_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists operacoes_apagar_convites on public.operacoes;
create trigger operacoes_apagar_convites after update of dados_apagados_em on public.operacoes
  for each row execute function public.apagar_convites_da_operacao();

-- Cria o convite (ou devolve o que já existe para o mesmo e-mail na operação, atualizando o nome).
create or replace function public.criar_convite_participante(p_operacao uuid, p_nome text, p_email text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_resp text := public.nome_responsavel_atual();
  v_status text;
  v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  v_email text := lower(btrim(coalesce(p_email, '')));
  c public.convites_participante%rowtype;
begin
  if v_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status is distinct from 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if char_length(v_nome) not between 2 and 40 then
    raise exception 'nome_convite_invalido';
  end if;
  if char_length(v_email) > 200 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
    raise exception 'email_convite_invalido';
  end if;
  select * into c from public.convites_participante where operacao_id = p_operacao and email = v_email for update;
  if found then
    update public.convites_participante set nome = v_nome where id = c.id returning * into c;
    return row_to_json(c);
  end if;
  if (select count(*) from public.convites_participante where operacao_id = p_operacao) >= 200 then
    raise exception 'convites_limite';
  end if;
  insert into public.convites_participante (operacao_id, nome, email, criado_por_nome)
  values (p_operacao, v_nome, v_email, v_resp) returning * into c;
  perform public.diario_auto(p_operacao, now(), 'pessoa', 'convite_criado', 'Convite por e-mail: ' || v_nome, '',
    'convite:' || c.id, 'info', null, null, c.id::text, v_resp);
  return row_to_json(c);
end;
$$;

-- Dados para o servidor enviar o e-mail (o servidor chama com o login do responsável). Confere o limite de envios.
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
  return json_build_object('id', c.id, 'nome', c.nome, 'email', c.email, 'codigo', c.codigo, 'operacao', o.codigo, 'token_civil', o.token_civil,
                           'envios', c.envios, 'responsavel', public.nome_responsavel_atual());
end;
$$;

-- Resultado do envio (p_erro nulo = enviado).
create or replace function public.convite_registrar_envio(p_convite uuid, p_erro text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  c public.convites_participante%rowtype;
begin
  select * into c from public.convites_participante where id = p_convite for update;
  if not found or not public.dono_operacao(c.operacao_id) or public.nome_responsavel_atual() is null then
    raise exception 'sem_permissao';
  end if;
  if p_erro is null then
    update public.convites_participante set envios = envios + 1, enviado_em = now(), envio_erro = null where id = c.id returning * into c;
    perform public.diario_auto(c.operacao_id, now(), 'pessoa', 'convite_enviado', 'Convite enviado por e-mail a ' || c.nome, 'envio ' || c.envios,
      'convite_envio:' || c.id || ':' || c.envios, 'info', null, null, c.id::text, public.nome_responsavel_atual());
  else
    update public.convites_participante set envio_erro = left(btrim(p_erro), 200) where id = c.id returning * into c;
  end if;
  return row_to_json(c);
end;
$$;

-- Revoga o convite (o link do e-mail deixa de pré-preencher o nome; o link da operação continua valendo).
create or replace function public.cancelar_convite_participante(p_convite uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  c public.convites_participante%rowtype;
begin
  select * into c from public.convites_participante where id = p_convite for update;
  if not found or not public.dono_operacao(c.operacao_id) or public.nome_responsavel_atual() is null then
    raise exception 'sem_permissao';
  end if;
  delete from public.convites_participante where id = c.id;
  return json_build_object('id', c.id, 'cancelado', true);
end;
$$;

-- Página do participante: o nome convidado (só o nome, nada mais). Código inválido: nulo.
create or replace function public.convite_ler(p_codigo text)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  c public.convites_participante%rowtype;
begin
  if p_codigo is null or p_codigo !~ '^[0-9a-f]{24}$' then
    return null;
  end if;
  select * into c from public.convites_participante where codigo = p_codigo;
  if not found then
    return null;
  end if;
  return json_build_object('nome', c.nome, 'aceito', c.aceito_em is not null);
end;
$$;

-- Depois de entrar na operação: liga o convite ao participante (só quem entrou, e uma vez).
create or replace function public.convite_aceitar(p_codigo text, p_participante uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  c public.convites_participante%rowtype;
  p public.participantes%rowtype;
begin
  if p_codigo is null or p_codigo !~ '^[0-9a-f]{24}$' then
    return null;
  end if;
  select * into c from public.convites_participante where codigo = p_codigo for update;
  if not found then
    return null;
  end if;
  select * into p from public.participantes where id = p_participante and operacao_id = c.operacao_id and user_id = auth.uid();
  if not found then
    raise exception 'sem_permissao';
  end if;
  if c.aceito_em is null then
    update public.convites_participante set aceito_em = now(), participante_id = p.id where id = c.id returning * into c;
    perform public.diario_auto(c.operacao_id, now(), 'pessoa', 'convite_aceito', c.nome || ' entrou pelo convite por e-mail', '',
      'convite_aceito:' || c.id, 'info', null, null, c.id::text, p.nome);
  end if;
  return json_build_object('aceito', true);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array['criar_convite_participante(uuid, text, text)', 'convite_dados_envio(uuid)', 'convite_registrar_envio(uuid, text)',
                           'cancelar_convite_participante(uuid)', 'convite_ler(text)', 'convite_aceitar(text, uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
