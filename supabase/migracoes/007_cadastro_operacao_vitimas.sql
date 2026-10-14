-- =====================================================================
-- 14. CADASTRO COMPLETO DA OPERAÇÃO E FICHA DA VÍTIMA
--     (migração 007 — idempotente; exige a 006)
--
--  operacoes: tipo (aquática, terrestre, aérea ou outras + texto livre),
--    data e hora do acionamento, local (endereço e ponto no mapa) e
--    descrição. Todas as colunas novas são OPCIONAIS: as operações antigas,
--    que só têm o nome (codigo), continuam válidas e podem ser completadas
--    depois. O nome continua na coluna "codigo" (nada foi renomeado).
--    O participante continua vendo só o nome (info_operacao não muda).
--
--  vitimas: ficha da vítima (foto, nome, idade, características físicas,
--    roupas e observações), várias por operação. Leitura SOMENTE pelos
--    responsáveis da operação (RLS); civis e militares de campo nunca leem.
--    A foto fica no bucket PRIVADO "vitimas", no caminho
--    <operacao_id>/<vitima_id>/<uuid>.jpg (links assinados e temporários).
--
--  Retenção: quando os dados da operação são apagados, as fichas (e as
--  fotos, pela fila arquivos_pendentes) também são. Os campos do cadastro
--  da operação continuam, como o nome já continuava.
-- =====================================================================

alter table public.operacoes add column if not exists tipo text;
alter table public.operacoes add column if not exists tipo_outro text;
alter table public.operacoes add column if not exists acionado_em timestamptz;
alter table public.operacoes add column if not exists local_endereco text;
alter table public.operacoes add column if not exists local_lat double precision;
alter table public.operacoes add column if not exists local_lng double precision;
alter table public.operacoes add column if not exists descricao text not null default '';
alter table public.operacoes add column if not exists atualizado_em timestamptz;
alter table public.operacoes add column if not exists atualizado_por_nome text;

alter table public.operacoes drop constraint if exists operacoes_tipo_check;
alter table public.operacoes add constraint operacoes_tipo_check check (
  (tipo is null and tipo_outro is null)
  or (tipo in ('aquatica', 'terrestre', 'aerea') and tipo_outro is null)
  or (tipo = 'outras' and char_length(btrim(coalesce(tipo_outro, ''))) between 1 and 60));
alter table public.operacoes drop constraint if exists operacoes_local_check;
alter table public.operacoes add constraint operacoes_local_check check (
  (local_lat is null) = (local_lng is null)
  and (local_lat is null or (local_lat between -90 and 90 and local_lng between -180 and 180)));
alter table public.operacoes drop constraint if exists operacoes_textos_check;
alter table public.operacoes add constraint operacoes_textos_check check (
  char_length(coalesce(local_endereco, '')) <= 300 and char_length(descricao) <= 2000);

-- Aplica (e valida) os campos do cadastro enviados em p_dados sobre a operação.
-- Só os campos presentes em p_dados mudam. Uso interno das funções abaixo.
create or replace function public.aplicar_cadastro_operacao(p_op public.operacoes, p_dados jsonb)
returns public.operacoes
language plpgsql
set search_path = public
as $$
declare
  v public.operacoes := p_op;
  v_txt text;
begin
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;

  if p_dados ? 'codigo' then
    v.codigo := btrim(regexp_replace(coalesce(p_dados->>'codigo', ''), '\s+', ' ', 'g'));
    if char_length(v.codigo) < 2 or char_length(v.codigo) > 80 then
      raise exception 'codigo_invalido';
    end if;
  end if;

  if p_dados ? 'tipo' or p_dados ? 'tipo_outro' then
    if p_dados ? 'tipo' then
      v.tipo := nullif(btrim(coalesce(p_dados->>'tipo', '')), '');
    end if;
    if v.tipo is not null and v.tipo not in ('aquatica', 'terrestre', 'aerea', 'outras') then
      raise exception 'tipo_operacao_invalido';
    end if;
    if v.tipo = 'outras' then
      if p_dados ? 'tipo_outro' then
        v.tipo_outro := btrim(regexp_replace(coalesce(p_dados->>'tipo_outro', ''), '\s+', ' ', 'g'));
      end if;
      if char_length(coalesce(v.tipo_outro, '')) not between 1 and 60 then
        raise exception 'tipo_operacao_invalido';
      end if;
    else
      v.tipo_outro := null;
    end if;
  end if;

  if p_dados ? 'acionado_em' then
    v_txt := nullif(btrim(coalesce(p_dados->>'acionado_em', '')), '');
    if v_txt is null then
      v.acionado_em := null;
    else
      begin
        v.acionado_em := v_txt::timestamptz;
      exception when others then
        raise exception 'acionamento_invalido';
      end;
      if v.acionado_em > now() + interval '5 minutes' or v.acionado_em < '2000-01-01'::timestamptz then
        raise exception 'acionamento_invalido';
      end if;
    end if;
  end if;

  if p_dados ? 'local_endereco' then
    v.local_endereco := nullif(btrim(regexp_replace(coalesce(p_dados->>'local_endereco', ''), '\s+', ' ', 'g')), '');
    if char_length(coalesce(v.local_endereco, '')) > 300 then
      raise exception 'dados_invalidos';
    end if;
  end if;

  if p_dados ? 'local_lat' or p_dados ? 'local_lng' then
    if jsonb_typeof(p_dados->'local_lat') = 'number' and jsonb_typeof(p_dados->'local_lng') = 'number' then
      v.local_lat := (p_dados->>'local_lat')::double precision;
      v.local_lng := (p_dados->>'local_lng')::double precision;
      if v.local_lat not between -90 and 90 or v.local_lng not between -180 and 180 or (v.local_lat = 0 and v.local_lng = 0) then
        raise exception 'posicao_invalida';
      end if;
    elsif coalesce(jsonb_typeof(p_dados->'local_lat'), 'null') = 'null' and coalesce(jsonb_typeof(p_dados->'local_lng'), 'null') = 'null' then
      v.local_lat := null;
      v.local_lng := null;
    else
      raise exception 'posicao_invalida';
    end if;
  end if;

  if p_dados ? 'descricao' then
    v.descricao := btrim(coalesce(p_dados->>'descricao', ''));
    if char_length(v.descricao) > 2000 then
      raise exception 'dados_invalidos';
    end if;
  end if;
  return v;
end;
$$;

-- Criação: a versão de 2 parâmetros é substituída. Chamadas antigas (sem
-- p_dados) continuam funcionando e criam a operação só com o nome. Com
-- p_dados (painel novo), tipo e data/hora do acionamento são obrigatórios.
drop function if exists public.criar_operacao(text, integer);

create or replace function public.criar_operacao(p_codigo text, p_retencao_horas integer default 0, p_dados jsonb default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
begin
  if not public.eh_responsavel() then
    raise exception 'sem_permissao';
  end if;
  if p_retencao_horas is null or p_retencao_horas not in (0, 24, 72, 168, 720) then
    raise exception 'retencao_invalida';
  end if;
  v_op.codigo := btrim(regexp_replace(coalesce(p_codigo, ''), '\s+', ' ', 'g'));
  if char_length(v_op.codigo) < 2 or char_length(v_op.codigo) > 80 then
    raise exception 'codigo_invalido';
  end if;
  v_op.descricao := '';
  if p_dados is not null then
    v_op := public.aplicar_cadastro_operacao(v_op, p_dados - 'codigo');
    if v_op.tipo is null then
      raise exception 'tipo_operacao_invalido';
    end if;
    if v_op.acionado_em is null then
      raise exception 'acionamento_invalido';
    end if;
  end if;

  insert into public.operacoes (codigo, responsavel_id, token_civil, token_militar, retencao_horas,
                                tipo, tipo_outro, acionado_em, local_endereco, local_lat, local_lng, descricao)
  values (v_op.codigo, auth.uid(), public.gerar_token(), public.gerar_token(), p_retencao_horas,
          v_op.tipo, v_op.tipo_outro, v_op.acionado_em, v_op.local_endereco, v_op.local_lat, v_op.local_lng,
          coalesce(v_op.descricao, ''))
  returning * into v_op;

  return row_to_json(v_op);
end;
$$;

-- Edição do cadastro (nome, tipo, acionamento, local, descrição): qualquer
-- responsável da operação. Só os campos enviados mudam.
create or replace function public.atualizar_operacao(p_operacao uuid, p_dados jsonb)
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
  select * into v_op from public.operacoes where id = p_operacao for update;
  if not found then
    raise exception 'sem_permissao';
  end if;
  v_op := public.aplicar_cadastro_operacao(v_op, p_dados);
  update public.operacoes
     set codigo = v_op.codigo, tipo = v_op.tipo, tipo_outro = v_op.tipo_outro, acionado_em = v_op.acionado_em,
         local_endereco = v_op.local_endereco, local_lat = v_op.local_lat, local_lng = v_op.local_lng,
         descricao = coalesce(v_op.descricao, ''), atualizado_em = now(), atualizado_por_nome = v_nome
   where id = p_operacao
  returning * into v_op;
  return row_to_json(v_op);
end;
$$;

-- ---------------------------------------------------------------------
-- Ficha da vítima
-- ---------------------------------------------------------------------
create table if not exists public.vitimas (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  nome                text not null check (char_length(btrim(nome)) between 1 and 80),
  idade               smallint check (idade between 0 and 130),
  caracteristicas     text not null default '' check (char_length(caracteristicas) <= 1000),
  roupas              text not null default '' check (char_length(roupas) <= 1000),
  observacoes         text not null default '' check (char_length(observacoes) <= 2000),
  foto_caminho        text unique,
  foto_atualizada_em  timestamptz,
  criado_por          uuid references auth.users(id) on delete set null,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text
);
create index if not exists vitimas_operacao_idx on public.vitimas (operacao_id, criado_em);

alter table public.vitimas enable row level security;
drop policy if exists vitimas_ler on public.vitimas;
create policy vitimas_ler on public.vitimas
  for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.vitimas from anon;
revoke insert, update, delete, truncate on public.vitimas from authenticated;
grant select on public.vitimas to authenticated;

-- Cria (p_id nulo) ou altera uma ficha. Na alteração, só os campos enviados mudam.
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

  if v.nome is null or char_length(v.nome) not between 1 and 80 then
    raise exception 'nome_vitima_invalido';
  end if;
  if char_length(v.caracteristicas) > 1000 or char_length(v.roupas) > 1000 or char_length(v.observacoes) > 2000 then
    raise exception 'dados_invalidos';
  end if;

  v.atualizado_em := now();
  v.atualizado_por_nome := v_nome_resp;
  if p_id is null then
    insert into public.vitimas select v.*;
  else
    update public.vitimas set nome = v.nome, idade = v.idade, caracteristicas = v.caracteristicas, roupas = v.roupas,
           observacoes = v.observacoes, atualizado_em = v.atualizado_em, atualizado_por_nome = v.atualizado_por_nome
     where id = v.id;
  end if;
  return row_to_json(v);
end;
$$;

-- Excluir: quem criou a ficha, quem criou a operação ou um administrador da equipe.
create or replace function public.excluir_vitima(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.vitimas%rowtype;
begin
  select * into v from public.vitimas where id = p_id;
  if not found or not public.pode_excluir_registro(v.operacao_id, v.criado_por) then
    raise exception 'sem_permissao';
  end if;
  delete from public.vitimas where id = p_id;   -- a foto entra na fila de arquivos a apagar (gatilho)
end;
$$;

-- Caminho válido da foto: <operacao_id>/<vitima_id>/<uuid>.jpg  → {operacao, vitima, arquivo}
create or replace function public.caminho_vitima_partes(p_nome text)
returns uuid[]
language plpgsql immutable
as $$
begin
  if coalesce(p_nome, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$' then
    return null;
  end if;
  return array[split_part(p_nome, '/', 1)::uuid, split_part(p_nome, '/', 2)::uuid,
               replace(split_part(p_nome, '/', 3), '.jpg', '')::uuid];
end;
$$;

-- Depois de enviar o arquivo ao Storage, o painel registra a foto na ficha.
-- p_caminho nulo tira a foto (o arquivo vai para a fila de remoção).
create or replace function public.definir_foto_vitima(p_vitima uuid, p_caminho text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v public.vitimas%rowtype;
  v_partes uuid[];
begin
  select * into v from public.vitimas where id = p_vitima for update;
  if not found or v_nome_resp is null or not public.dono_operacao(v.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if exists (select 1 from public.operacoes where id = v.operacao_id and dados_apagados_em is not null) then
    raise exception 'operacao_encerrada';
  end if;
  if p_caminho is not null then
    v_partes := public.caminho_vitima_partes(p_caminho);
    if v_partes is null or v_partes[1] <> v.operacao_id or v_partes[2] <> v.id then
      raise exception 'dados_invalidos';
    end if;
    if not exists (select 1 from storage.objects where bucket_id = 'vitimas' and name = p_caminho) then
      raise exception 'foto_nao_enviada';
    end if;
  end if;
  update public.vitimas
     set foto_caminho = p_caminho,
         foto_atualizada_em = case when p_caminho is null then null else now() end,
         atualizado_em = now(), atualizado_por_nome = v_nome_resp
   where id = v.id
  returning * into v;
  return row_to_json(v);
end;
$$;

-- Foto trocada ou ficha excluída: o arquivo antigo entra na fila de remoção do Storage.
create or replace function public.fila_apagar_foto_vitima()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.foto_caminho is not null then
      insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
      values (old.foto_caminho, 'vitimas', old.operacao_id, auth.uid())
      on conflict (caminho) do nothing;
    end if;
    return old;
  end if;
  if old.foto_caminho is not null and old.foto_caminho is distinct from new.foto_caminho then
    insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
    values (old.foto_caminho, 'vitimas', old.operacao_id, auth.uid())
    on conflict (caminho) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists vitimas_apagar_foto on public.vitimas;
create trigger vitimas_apagar_foto after delete or update of foto_caminho on public.vitimas
  for each row execute function public.fila_apagar_foto_vitima();

-- Regras do Storage (bucket "vitimas"):
--   enviar: só responsáveis da operação, na pasta de uma ficha existente;
--   ver: só responsáveis da operação (ou quem excluiu e precisa apagar o arquivo);
--   apagar: só arquivos cujo registro já saiu (fila arquivos_pendentes).
create or replace function public.pode_enviar_foto_vitima(p_nome text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v uuid[] := public.caminho_vitima_partes(p_nome);
begin
  if v is null then
    return false;
  end if;
  return public.dono_operacao(v[1]) and exists (
    select 1 from public.vitimas t join public.operacoes o on o.id = t.operacao_id
     where t.id = v[2] and t.operacao_id = v[1] and o.dados_apagados_em is null);
end;
$$;

create or replace function public.pode_ver_foto_vitima(p_nome text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v uuid[] := public.caminho_vitima_partes(p_nome);
begin
  if v is null then
    return false;
  end if;
  return public.dono_operacao(v[1])
      or exists (select 1 from public.arquivos_pendentes a where a.caminho = p_nome and a.bucket = 'vitimas' and a.excluido_por = auth.uid());
end;
$$;

create or replace function public.pode_apagar_foto_vitima(p_nome text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  return exists (
    select 1 from public.arquivos_pendentes a
     where a.caminho = p_nome and a.bucket = 'vitimas'
       and (a.excluido_por = auth.uid() or (a.operacao_id is not null and public.dono_operacao(a.operacao_id))));
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vitimas', 'vitimas', false, 10485760, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists gbs_vitimas_enviar on storage.objects;
create policy gbs_vitimas_enviar on storage.objects
  for insert to authenticated
  with check (bucket_id = 'vitimas' and public.pode_enviar_foto_vitima(name));

drop policy if exists gbs_vitimas_ver on storage.objects;
create policy gbs_vitimas_ver on storage.objects
  for select to authenticated
  using (bucket_id = 'vitimas' and public.pode_ver_foto_vitima(name));

drop policy if exists gbs_vitimas_apagar on storage.objects;
create policy gbs_vitimas_apagar on storage.objects
  for delete to authenticated
  using (bucket_id = 'vitimas' and public.pode_apagar_foto_vitima(name));

-- Arquivos a apagar deste responsável, com o bucket (fotos de campo ou fotos de vítimas).
create or replace function public.meus_arquivos_pendentes_v2()
returns json
language sql stable security definer set search_path = public
as $$
  select coalesce(json_agg(json_build_object('caminho', caminho, 'bucket', bucket)), '[]'::json)
    from (select caminho, bucket from public.arquivos_pendentes
           where excluido_por = auth.uid() order by criado_em limit 1000) x;
$$;

-- Retenção: dados apagados → fichas apagadas (as fotos entram na fila).
create or replace function public.apagar_vitimas_da_operacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.vitimas where operacao_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists operacoes_apagar_vitimas on public.operacoes;
create trigger operacoes_apagar_vitimas after update of dados_apagados_em on public.operacoes
  for each row execute function public.apagar_vitimas_da_operacao();

-- Exclusão definitiva: informa também quantas fichas de vítima foram apagadas.
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
  select count(*) into v_fotos from public.fotos where operacao_id = p_operacao;
  select count(*) into v_participantes from public.participantes where operacao_id = p_operacao and tipo <> 'responsavel';
  select count(*) into v_vitimas from public.vitimas where operacao_id = p_operacao;

  delete from public.operacoes where id = p_operacao;   -- apaga em cascata tudo o que é da operação

  return json_build_object('operacao', v_codigo, 'fotos', v_fotos, 'participantes', v_participantes, 'vitimas', v_vitimas);
end;
$$;

revoke execute on function public.aplicar_cadastro_operacao(public.operacoes, jsonb) from public, anon, authenticated;
revoke execute on function public.apagar_vitimas_da_operacao(), public.fila_apagar_foto_vitima() from public, anon, authenticated;
revoke execute on function
  public.criar_operacao(text, integer, jsonb), public.atualizar_operacao(uuid, jsonb),
  public.salvar_vitima(uuid, uuid, jsonb), public.excluir_vitima(uuid), public.definir_foto_vitima(uuid, text),
  public.caminho_vitima_partes(text), public.pode_enviar_foto_vitima(text), public.pode_ver_foto_vitima(text),
  public.pode_apagar_foto_vitima(text), public.meus_arquivos_pendentes_v2(), public.excluir_operacao(uuid)
  from public, anon;
grant execute on function
  public.criar_operacao(text, integer, jsonb), public.atualizar_operacao(uuid, jsonb),
  public.salvar_vitima(uuid, uuid, jsonb), public.excluir_vitima(uuid), public.definir_foto_vitima(uuid, text),
  public.caminho_vitima_partes(text), public.pode_enviar_foto_vitima(text), public.pode_ver_foto_vitima(text),
  public.pode_apagar_foto_vitima(text), public.meus_arquivos_pendentes_v2(), public.excluir_operacao(uuid)
  to authenticated;

-- Tempo real: fichas aparecem para os outros responsáveis sem recarregar.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.vitimas';
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

notify pgrst, 'reload schema';
