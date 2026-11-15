-- =====================================================================
-- 080_sci_recursos.sql — Modo SCI: recursos avulsos da ocorrência (só acréscimos; idempotente; exige a 057)
--
-- No SCI, recurso não é só gente: é a ambulância, o caminhão, a embarcação, a motosserra, o gerador. Até aqui o
-- painel só conhecia as equipes (grupos). Esta migração cria o cadastro dos demais recursos, com a situação de cada
-- um como a Unidade de Recursos acompanha:
--   a_caminho      solicitado ou em deslocamento para a ocorrência (ainda não chegou)
--   disponivel     chegou (check-in) e aguarda designação na Área de Espera
--   designado      empregado num setor, com uma equipe ou num local
--   indisponivel   fora de serviço (manutenção, abastecimento, avaria, descanso)
--   desmobilizado  liberado da ocorrência
-- Leitura pelos responsáveis da operação; escrita só pela função sci2_recurso. Nada do que existe muda.
-- =====================================================================

create table if not exists public.sci2_recursos (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  nome                text not null check (char_length(btrim(nome)) between 1 and 80),
  categoria           text not null default 'equipamento'
                        check (categoria in ('pessoal', 'viatura', 'ambulancia', 'embarcacao', 'aeronave', 'equipamento', 'material', 'outro')),
  quantidade          integer not null default 1 check (quantidade between 1 and 9999),
  instituicao         text not null default '' check (char_length(instituicao) <= 60),
  situacao            text not null default 'disponivel'
                        check (situacao in ('a_caminho', 'disponivel', 'designado', 'indisponivel', 'desmobilizado')),
  destino             text not null default '' check (char_length(destino) <= 200),
  setor_id            uuid references public.setores(id) on delete set null,
  grupo_id            uuid references public.grupos(id) on delete set null,
  observacao          text not null default '' check (char_length(observacao) <= 500),
  checkin_em          timestamptz,
  designado_em        timestamptz,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text
);
create index if not exists sci2_recursos_op_idx on public.sci2_recursos (operacao_id, situacao);

alter table public.sci2_recursos enable row level security;
drop policy if exists sci2_recursos_ler on public.sci2_recursos;
create policy sci2_recursos_ler on public.sci2_recursos for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.sci2_recursos from anon;
revoke insert, update, delete, truncate on public.sci2_recursos from authenticated;
grant select on public.sci2_recursos to authenticated;
-- operação encerrada: só leitura (a mesma trava das outras tabelas da operação)
drop trigger if exists sci2_recursos_encerrada on public.sci2_recursos;
create trigger sci2_recursos_encerrada before insert or update or delete on public.sci2_recursos
  for each row execute function public.bloquear_escrita_encerrada();
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'sci2_recursos') then
    alter publication supabase_realtime add table public.sci2_recursos;
  end if;
end $$;

-- p_dados (criar: nome obrigatório): { nome, categoria, quantidade, instituicao, situacao, destino, setor_id, grupo_id, observacao }
-- Só o que vier muda. { excluir: true } apaga o cadastro (erro de digitação); para tirar da ocorrência use "desmobilizado".
create or replace function public.sci2_recurso(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := public.sci2_conferir(p_operacao);
  r public.sci2_recursos%rowtype;
  v_antes text;
  v_ref uuid;
  v_onde text;
begin
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then raise exception 'dados_invalidos'; end if;
  if p_id is null then
    if char_length(btrim(coalesce(p_dados->>'nome', ''))) not between 1 and 80 then raise exception 'recurso_sem_nome'; end if;
    r.operacao_id := p_operacao; r.nome := btrim(regexp_replace(p_dados->>'nome', '\s+', ' ', 'g'));
    r.categoria := 'equipamento'; r.quantidade := 1; r.instituicao := ''; r.situacao := 'disponivel';
    r.destino := ''; r.observacao := ''; r.criado_por_nome := v_nome;
  else
    select * into r from public.sci2_recursos where id = p_id and operacao_id = p_operacao for update;
    if not found then raise exception 'dados_invalidos'; end if;
    if coalesce((p_dados->>'excluir')::boolean, false) then
      delete from public.sci2_recursos where id = p_id;
      perform public.sci2_diario(p_operacao, 'Recurso excluído do cadastro', r.nome, v_nome);
      return json_build_object('id', p_id, 'excluido', true);
    end if;
    if p_dados ? 'nome' then
      if char_length(btrim(coalesce(p_dados->>'nome', ''))) not between 1 and 80 then raise exception 'recurso_sem_nome'; end if;
      r.nome := btrim(regexp_replace(p_dados->>'nome', '\s+', ' ', 'g'));
    end if;
  end if;
  v_antes := case when p_id is null then null else r.situacao end;
  if p_dados ? 'categoria' then
    if coalesce(p_dados->>'categoria', '') not in ('pessoal', 'viatura', 'ambulancia', 'embarcacao', 'aeronave', 'equipamento', 'material', 'outro') then
      raise exception 'dados_invalidos';
    end if;
    r.categoria := p_dados->>'categoria';
  end if;
  if p_dados ? 'quantidade' then
    begin
      r.quantidade := (p_dados->>'quantidade')::integer;
    exception when others then
      raise exception 'dados_invalidos';
    end;
    if r.quantidade is null or r.quantidade not between 1 and 9999 then raise exception 'dados_invalidos'; end if;
  end if;
  if p_dados ? 'instituicao' then r.instituicao := left(btrim(coalesce(p_dados->>'instituicao', '')), 60); end if;
  if p_dados ? 'observacao' then r.observacao := left(btrim(coalesce(p_dados->>'observacao', '')), 500); end if;
  if p_dados ? 'destino' then r.destino := left(btrim(coalesce(p_dados->>'destino', '')), 200); end if;
  if p_dados ? 'setor_id' then
    begin
      v_ref := nullif(p_dados->>'setor_id', '')::uuid;
    exception when invalid_text_representation then
      raise exception 'dados_invalidos';
    end;
    if v_ref is not null and not exists (select 1 from public.setores s where s.id = v_ref and s.operacao_id = p_operacao) then
      raise exception 'dados_invalidos';
    end if;
    r.setor_id := v_ref;
  end if;
  if p_dados ? 'grupo_id' then
    begin
      v_ref := nullif(p_dados->>'grupo_id', '')::uuid;
    exception when invalid_text_representation then
      raise exception 'dados_invalidos';
    end;
    if v_ref is not null and not exists (select 1 from public.grupos g where g.id = v_ref and g.operacao_id = p_operacao) then
      raise exception 'dados_invalidos';
    end if;
    r.grupo_id := v_ref;
  end if;
  if p_dados ? 'situacao' then
    if coalesce(p_dados->>'situacao', '') not in ('a_caminho', 'disponivel', 'designado', 'indisponivel', 'desmobilizado') then
      raise exception 'dados_invalidos';
    end if;
    r.situacao := p_dados->>'situacao';
  end if;
  -- a situação dita os carimbos e o destino: só o designado tem destino
  if r.situacao = 'designado' then
    if r.setor_id is null and r.grupo_id is null and r.destino = '' then raise exception 'recurso_sem_destino'; end if;
    if v_antes is distinct from 'designado' then r.designado_em := now(); end if;
  else
    r.setor_id := null; r.grupo_id := null; r.destino := ''; r.designado_em := null;
  end if;
  if r.situacao <> 'a_caminho' and r.checkin_em is null then r.checkin_em := now(); end if;
  if r.situacao = 'a_caminho' then r.checkin_em := null; end if;

  if p_id is null then
    insert into public.sci2_recursos (operacao_id, nome, categoria, quantidade, instituicao, situacao, destino, setor_id, grupo_id, observacao,
                                      checkin_em, designado_em, criado_por_nome)
    values (r.operacao_id, r.nome, r.categoria, r.quantidade, r.instituicao, r.situacao, r.destino, r.setor_id, r.grupo_id, r.observacao,
            r.checkin_em, r.designado_em, r.criado_por_nome)
    returning * into r;
  else
    update public.sci2_recursos
       set nome = r.nome, categoria = r.categoria, quantidade = r.quantidade, instituicao = r.instituicao, situacao = r.situacao,
           destino = r.destino, setor_id = r.setor_id, grupo_id = r.grupo_id, observacao = r.observacao,
           checkin_em = r.checkin_em, designado_em = r.designado_em, atualizado_em = now(), atualizado_por_nome = v_nome
     where id = p_id
    returning * into r;
  end if;

  -- diário: cadastro e cada mudança de situação
  if v_antes is distinct from r.situacao then
    v_onde := concat_ws(' · ',
      (select 'setor ' || s.nome from public.setores s where s.id = r.setor_id),
      (select 'equipe ' || g.nome from public.grupos g where g.id = r.grupo_id),
      nullif(r.destino, ''));
    perform public.sci2_diario(p_operacao,
      case r.situacao when 'a_caminho' then 'Recurso a caminho' when 'disponivel' then 'Recurso disponível na Área de Espera'
        when 'designado' then 'Recurso designado' when 'indisponivel' then 'Recurso fora de serviço' else 'Recurso desmobilizado' end,
      r.nome || case when r.quantidade > 1 then ' ×' || r.quantidade else '' end
        || case when r.instituicao <> '' then ' (' || r.instituicao || ')' else '' end
        || case when r.situacao = 'designado' and v_onde <> '' then ' → ' || v_onde else '' end
        || case when r.situacao = 'indisponivel' and r.observacao <> '' then ' — ' || r.observacao else '' end,
      v_nome);
  end if;
  return row_to_json(r);
end;
$$;
revoke execute on function public.sci2_recurso(uuid, uuid, jsonb) from public, anon;
grant execute on function public.sci2_recurso(uuid, uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
