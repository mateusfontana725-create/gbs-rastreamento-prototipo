-- =====================================================================
-- 18. "ENCONTREI A VÍTIMA" (migração 011 — idempotente; exige a 010)
--
--  O participante de campo informa que encontrou a vítima e a condição
--  (viva ou óbito). A CONDIÇÃO É SENSÍVEL: só os responsáveis da operação
--  podem vê-la. A separação é feita no SERVIDOR:
--
--  vitima_localizacoes  ÚNICA tabela que guarda a condição. RLS: leitura só
--                       por dono_operacao() (criador ou responsável da
--                       operação). Participantes — inclusive quem registrou —
--                       não leem nenhuma linha, nem pelo Realtime.
--  mensagens            recebe uma linha NEUTRA (categoria VITIMA, texto fixo
--                       "Localizada, ver protocolo"), que o participante lê
--                       na própria conversa. Nunca contém a condição.
--  alertas              alerta CRÍTICO para os responsáveis, também neutro
--                       (o painel busca a condição em vitima_localizacoes).
--
--  Escrita só pela função participante_registrar_vitima (sem texto livre, para
--  ninguém escrever a condição numa mensagem que o participante consegue ler).
--  A condição vai no corpo da chamada (POST), nunca na URL.
-- =====================================================================

-- Categoria nova de relato e tipo novo de alerta
alter table public.mensagens drop constraint if exists mensagens_categoria_check;
alter table public.mensagens add constraint mensagens_categoria_check
  check (categoria is null or categoria in ('MENSAGEM', 'OBJETO', 'VESTIGIO', 'PISTA', 'OBSTACULO', 'OUTRO', 'AJUDA', 'VITIMA'));

alter table public.alertas drop constraint if exists alertas_tipo_check;
alter table public.alertas add constraint alertas_tipo_check
  check (tipo in ('deslocamento_iniciado', 'chegou_setor', 'busca_finalizada', 'chegou_base', 'retorno_atrasado', 'vitima_localizada'));

-- ---------------------------------------------------------------------
-- Registro da vítima localizada (condição só para os responsáveis)
-- ---------------------------------------------------------------------
create table if not exists public.vitima_localizacoes (
  id                   uuid primary key default gen_random_uuid(),
  operacao_id          uuid not null references public.operacoes(id) on delete cascade,
  participante_id      uuid not null references public.participantes(id) on delete cascade,
  mensagem_id          uuid not null unique references public.mensagens(id) on delete cascade,
  condicao             text not null check (condicao in ('viva', 'obito')),
  lat                  double precision check (lat between -90 and 90),
  lng                  double precision check (lng between -180 and 180),
  precisao             real check (precisao >= 0),
  posicao_em           timestamptz,             -- horário do GPS
  registrado_em        timestamptz not null default now(),   -- horário do servidor
  registrado_por       uuid not null references auth.users(id) on delete cascade,
  registrado_por_nome  text not null,
  registrado_por_tipo  text not null,
  check ((lat is null) = (lng is null))
);
create index if not exists vitima_localizacoes_operacao_idx on public.vitima_localizacoes (operacao_id, registrado_em);

alter table public.vitima_localizacoes enable row level security;
drop policy if exists vitima_localizacoes_ler on public.vitima_localizacoes;
create policy vitima_localizacoes_ler on public.vitima_localizacoes
  for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.vitima_localizacoes from anon;
revoke insert, update, delete, truncate on public.vitima_localizacoes from authenticated;
grant select on public.vitima_localizacoes to authenticated;

-- O participante registra. Devolve SÓ a mensagem neutra (sem a condição).
-- client_id torna o reenvio (após falta de internet) seguro: não duplica.
create or replace function public.participante_registrar_vitima(
  p_participante uuid, p_condicao text,
  p_lat double precision default null, p_lng double precision default null,
  p_precisao real default null, p_posicao_em timestamptz default null, p_client_id uuid default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_msg public.mensagens%rowtype;
  v_reg public.vitima_localizacoes%rowtype;
  v_recentes integer;
  v_prec real := case when p_precisao between 0 and 100000 then p_precisao end;
  v_pos_em timestamptz := case when p_lat is not null then least(coalesce(p_posicao_em, now()), now()) end;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found or v_part.tipo = 'responsavel' then
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
  if p_condicao is null or p_condicao not in ('viva', 'obito') then
    raise exception 'dados_invalidos';
  end if;
  -- Localização: só a que o aparelho informou; nunca é inventada.
  if (p_lat is null) <> (p_lng is null)
     or (p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0))) then
    raise exception 'posicao_invalida';
  end if;

  if p_client_id is not null then
    select * into v_msg from public.mensagens where participante_id = v_part.id and client_id = p_client_id;
    if found then
      if v_msg.categoria <> 'VITIMA' then
        raise exception 'dados_invalidos';
      end if;
      return row_to_json(v_msg);   -- reenvio: já estava gravado
    end if;
  end if;

  select count(*) into v_recentes from public.mensagens
   where participante_id = v_part.id and direcao = 'entrada' and criada_em > now() - interval '1 minute';
  if v_recentes >= 20 then
    raise exception 'muitas_mensagens';
  end if;

  insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto,
                                direcao, categoria, lat, lng, precisao, posicao_em, client_id, entregue_em)
  values (v_part.operacao_id, v_part.id, auth.uid(), v_part.nome, 'PARTICIPANTE', 'Localizada, ver protocolo',
          'entrada', 'VITIMA', p_lat, p_lng, v_prec, v_pos_em, p_client_id, now())
  returning * into v_msg;

  insert into public.vitima_localizacoes (operacao_id, participante_id, mensagem_id, condicao, lat, lng, precisao,
                                          posicao_em, registrado_em, registrado_por, registrado_por_nome, registrado_por_tipo)
  values (v_part.operacao_id, v_part.id, v_msg.id, p_condicao, p_lat, p_lng, v_prec,
          v_pos_em, v_msg.criada_em, auth.uid(), v_part.nome, v_part.tipo)
  returning * into v_reg;

  -- Alerta crítico aos responsáveis (texto neutro; a condição fica só na tabela protegida)
  perform public.criar_alerta(v_part.operacao_id, 'vitima_localizada', 'critico',
    'VÍTIMA LOCALIZADA',
    'Registrado por ' || v_part.nome || ' (' || v_part.tipo || ')' ||
      case when p_lat is null then ' · sem localização do GPS' else '' end || '. Veja a condição no painel.',
    'vitima:' || v_reg.id, null, null, v_part.id, p_lat, p_lng, v_pos_em);

  update public.participantes set ultimo_contato_em = now() where id = v_part.id;
  return row_to_json(v_msg);
end;
$$;

revoke execute on function public.participante_registrar_vitima(uuid, text, double precision, double precision, real, timestamptz, uuid)
  from public, anon;
grant execute on function public.participante_registrar_vitima(uuid, text, double precision, double precision, real, timestamptz, uuid)
  to authenticated;

-- Tempo real: o painel recebe o registro na hora (o Realtime respeita a RLS:
-- celulares de campo não recebem estas linhas).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.vitima_localizacoes';
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

notify pgrst, 'reload schema';
