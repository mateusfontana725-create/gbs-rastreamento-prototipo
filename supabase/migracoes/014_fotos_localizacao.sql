-- =====================================================================
-- 21. FOTOS: SETOR, LOCALIZAÇÃO PENDENTE E ATUALIZAÇÃO PELO GPS
--     (migração 014 — idempotente; exige a 013)
--
--  Cada foto já guarda: horário da captura no aparelho (capturada_em),
--  latitude, longitude e precisão, horário da posição (posicao_em), operação
--  e quem tirou (participante). Esta migração acrescenta:
--
--  setor_id / setor_nome   setor onde a foto foi tirada (calculado no banco
--                          pela posição; o nome fica guardado mesmo se o
--                          setor for apagado depois)
--  origem_posicao          + 'pendente': foto tirada sem GPS; o local é
--                            completado depois
--                          + 'trilha': local tirado da trilha GPS da pessoa
--                            (ponto até 2 min antes/depois da captura)
--  local_atualizado_em     quando o local pendente foi completado
--
--  Local pendente é completado:
--    1) pelo celular, quando o GPS responder (atualizar_local_foto): só uma
--       leitura de até 2 min antes a 10 min depois da captura;
--    2) pelo servidor, pela trilha GPS (ao registrar a foto e a cada lote de
--       posições que chega).
--  Leitura: só quem tem acesso à operação (RLS da tabela fotos, sem mudança:
--  responsáveis da operação e o próprio autor).
-- =====================================================================

alter table public.fotos add column if not exists setor_id uuid references public.setores(id) on delete set null;
alter table public.fotos add column if not exists setor_nome text;
alter table public.fotos add column if not exists local_atualizado_em timestamptz;
alter table public.fotos drop constraint if exists fotos_origem_posicao_check;
alter table public.fotos add constraint fotos_origem_posicao_check
  check (origem_posicao in ('gps', 'exif', 'nenhuma', 'pendente', 'trilha'));
create index if not exists fotos_pendentes_idx on public.fotos (participante_id) where origem_posicao = 'pendente';

-- Setor da foto: calculado sempre que a posição muda (qualquer caminho de gravação)
create or replace function public.foto_definir_setor()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_s public.setores%rowtype;
begin
  if tg_op = 'UPDATE' and new.lat is not distinct from old.lat and new.lng is not distinct from old.lng then
    return new;
  end if;
  new.setor_id := null;
  new.setor_nome := null;
  if new.lat is not null and new.lng is not null then
    select s.* into v_s from public.setores s
     where s.operacao_id = new.operacao_id and public.ponto_no_setor(s, new.lat, new.lng)
     order by s.criado_em
     limit 1;
    if found then
      new.setor_id := v_s.id;
      new.setor_nome := v_s.nome;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists fotos_definir_setor on public.fotos;
create trigger fotos_definir_setor before insert or update of lat, lng on public.fotos
  for each row execute function public.foto_definir_setor();

-- Fotos que já existiam: preenche o setor
update public.fotos f set setor_id = s.id, setor_nome = s.nome
  from public.setores s
 where f.setor_id is null and f.lat is not null and s.operacao_id = f.operacao_id
   and public.ponto_no_setor(s, f.lat, f.lng)
   and s.id = (select s2.id from public.setores s2
                where s2.operacao_id = f.operacao_id and public.ponto_no_setor(s2, f.lat, f.lng)
                order by s2.criado_em limit 1);

-- Completa o local de uma foto pendente pela trilha GPS (ponto mais próximo da
-- captura, até 2 min antes ou depois, com precisão até 100 m). Uso interno.
create or replace function public.resolver_local_foto(p_foto uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v public.fotos%rowtype;
  pt record;
begin
  select * into v from public.fotos where id = p_foto for update;
  if not found or v.origem_posicao <> 'pendente' or v.capturada_em is null then
    return false;
  end if;
  select lat, lng, precisao, registrado_em into pt from public.posicoes
   where participante_id = v.participante_id
     and registrado_em between v.capturada_em - interval '2 minutes' and v.capturada_em + interval '2 minutes'
     and (precisao is null or precisao <= 100)
   order by abs(extract(epoch from (registrado_em - v.capturada_em))), precisao nulls last
   limit 1;
  if not found then
    return false;
  end if;
  update public.fotos
     set lat = pt.lat, lng = pt.lng, precisao = pt.precisao, posicao_em = pt.registrado_em,
         origem_posicao = 'trilha', local_atualizado_em = now()
   where id = v.id;
  return true;
end;
$$;

create or replace function public.resolver_fotos_pendentes(p_participante uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_qtd integer := 0;
  r record;
begin
  for r in select id from public.fotos where participante_id = p_participante and origem_posicao = 'pendente' loop
    if public.resolver_local_foto(r.id) then
      v_qtd := v_qtd + 1;
    end if;
  end loop;
  return v_qtd;
end;
$$;

-- ---------------------------------------------------------------------
-- Registro da foto: aceita "pendente" (foto da câmera sem GPS no momento)
-- ---------------------------------------------------------------------
create or replace function public.registrar_foto(
  p_participante uuid, p_client_id uuid, p_origem text,
  p_lat double precision default null, p_lng double precision default null, p_precisao real default null,
  p_posicao_em timestamptz default null, p_capturada_em timestamptz default null, p_legenda text default '',
  p_bytes integer default null, p_largura integer default null, p_altura integer default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_caminho text;
  v_foto public.fotos%rowtype;
  v_captura timestamptz := p_capturada_em;
  v_origem text := p_origem;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found then
    raise exception 'participante_invalido';
  end if;
  if v_part.liberado_em is not null then
    raise exception 'participante_liberado';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_client_id is null then
    raise exception 'foto_invalida';
  end if;

  select * into v_foto from public.fotos where participante_id = v_part.id and client_id = p_client_id;
  if found then
    return row_to_json(v_foto);   -- reenvio: já estava registrada
  end if;

  v_caminho := v_part.operacao_id || '/' || v_part.id || '/' || p_client_id || '.jpg';
  if not exists (select 1 from storage.objects where bucket_id = 'fotos' and name = v_caminho) then
    raise exception 'foto_nao_enviada';
  end if;

  if v_origem is null or v_origem not in ('gps', 'exif', 'nenhuma', 'pendente') then
    raise exception 'foto_invalida';
  end if;
  if v_origem in ('nenhuma', 'pendente') and (p_lat is not null or p_lng is not null) then
    raise exception 'posicao_invalida';
  end if;
  if v_origem in ('gps', 'exif') and (p_lat is null or p_lng is null or p_lat not between -90 and 90
       or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0)) then
    raise exception 'posicao_invalida';
  end if;
  if v_captura is not null and (v_captura > now() + interval '2 minutes' or v_captura < '2000-01-01') then
    v_captura := null;
  end if;
  -- pendente precisa do horário da captura (é por ele que o local é completado)
  if v_origem = 'pendente' and v_captura is null then
    v_origem := 'nenhuma';
  end if;

  insert into public.fotos (operacao_id, participante_id, autor_nome, autor_tipo, client_id, caminho,
                            lat, lng, precisao, posicao_em, origem_posicao, capturada_em, legenda,
                            bytes, largura, altura)
  values (v_part.operacao_id, v_part.id, v_part.nome, v_part.tipo, p_client_id, v_caminho,
          p_lat, p_lng, case when p_precisao between 0 and 100000 then p_precisao end,
          case when p_lat is not null then least(coalesce(p_posicao_em, now()), now()) end,
          v_origem, v_captura, left(btrim(coalesce(p_legenda, '')), 300),
          case when p_bytes between 0 and 20000000 then p_bytes end,
          case when p_largura between 1 and 20000 then p_largura end,
          case when p_altura between 1 and 20000 then p_altura end)
  returning * into v_foto;

  -- pendente: a trilha GPS pode já ter um ponto do momento da foto
  if v_origem = 'pendente' and public.resolver_local_foto(v_foto.id) then
    select * into v_foto from public.fotos where id = v_foto.id;
  end if;

  update public.participantes set ultimo_contato_em = now() where id = v_part.id;
  return row_to_json(v_foto);
end;
$$;

-- O celular completa o local quando o GPS responder (ou desiste: p_lat nulo).
-- Só o autor, só foto pendente, só leitura de até 2 min antes a 10 min depois da captura.
create or replace function public.atualizar_local_foto(
  p_participante uuid, p_client_id uuid,
  p_lat double precision default null, p_lng double precision default null,
  p_precisao real default null, p_posicao_em timestamptz default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v public.fotos%rowtype;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found or v_part.removido then
    raise exception 'participante_invalido';
  end if;
  select * into v from public.fotos where participante_id = v_part.id and client_id = p_client_id for update;
  if not found then
    raise exception 'foto_nao_encontrada';
  end if;
  if v.origem_posicao <> 'pendente' then
    return row_to_json(v);   -- já resolvida (pela trilha ou por um envio anterior)
  end if;
  if p_lat is null and p_lng is null then
    update public.fotos set origem_posicao = 'nenhuma', local_atualizado_em = now() where id = v.id returning * into v;
    return row_to_json(v);
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180
     or (p_lat = 0 and p_lng = 0) or p_posicao_em is null then
    raise exception 'posicao_invalida';
  end if;
  if p_precisao is not null and (p_precisao < 0 or p_precisao > 500) then
    raise exception 'posicao_invalida';
  end if;
  if p_posicao_em < v.capturada_em - interval '2 minutes' or p_posicao_em > v.capturada_em + interval '10 minutes'
     or p_posicao_em > now() + interval '2 minutes' then
    raise exception 'local_fora_do_prazo';
  end if;
  update public.fotos
     set lat = p_lat, lng = p_lng, precisao = p_precisao, posicao_em = p_posicao_em,
         origem_posicao = 'gps', local_atualizado_em = now()
   where id = v.id
  returning * into v;
  return row_to_json(v);
end;
$$;

-- ---------------------------------------------------------------------
-- Gancho apos_posicoes: deslocamentos + permanência (013) + fotos pendentes
-- ---------------------------------------------------------------------
create or replace function public.apos_posicoes(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  begin
    perform public.apos_posicoes_missoes(p_participante);
  exception when others then
    raise warning 'apos_posicoes (deslocamentos): %', sqlerrm;
  end;
  begin
    perform public.avaliar_permanencia(p_participante);
  exception when others then
    raise warning 'apos_posicoes (permanência): %', sqlerrm;   -- nunca impede a gravação das posições
  end;
  begin
    perform public.resolver_fotos_pendentes(p_participante);
  exception when others then
    raise warning 'apos_posicoes (fotos pendentes): %', sqlerrm;
  end;
end;
$$;

revoke execute on function public.foto_definir_setor(), public.resolver_local_foto(uuid), public.resolver_fotos_pendentes(uuid),
  public.apos_posicoes(uuid) from public, anon, authenticated;
revoke execute on function public.atualizar_local_foto(uuid, uuid, double precision, double precision, real, timestamptz),
  public.registrar_foto(uuid, uuid, text, double precision, double precision, real, timestamptz, timestamptz, text, integer, integer, integer)
  from public, anon;
grant execute on function public.atualizar_local_foto(uuid, uuid, double precision, double precision, real, timestamptz),
  public.registrar_foto(uuid, uuid, text, double precision, double precision, real, timestamptz, timestamptz, text, integer, integer, integer)
  to authenticated;

notify pgrst, 'reload schema';
