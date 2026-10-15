-- =====================================================================
-- 22. GRUPOS NO MAPA DO CIVIL (migração 015 — idempotente; exige a 008)
--
--  Antes, o mapa do participante mostrava só militares e responsáveis da
--  operação (nunca civis). Agora mostra também os INTEGRANTES DOS GRUPOS EM
--  COMUM com quem consulta: civis, militares ou responsáveis do mesmo grupo,
--  com a última posição, o nome e a cor do grupo. Não entram CPF, telefone,
--  trilha, nem grupos que a pessoa não compartilha.
--
--  Militares e responsáveis SEM grupo continuam visíveis, como antes.
--  Quem está num grupo só aparece para os membros desse grupo.
-- =====================================================================
create or replace function public.equipe_no_mapa(p_participante uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
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
  return coalesce((
    select json_agg(x order by x.idade_s)
      from (
        select p.id,
               p.tipo,
               p.ultima_lat as lat,
               p.ultima_lng as lng,
               p.ultima_precisao as precisao,
               greatest(0, floor(extract(epoch from now() - p.ultima_posicao_em)))::integer as idade_s,
               -- nome e grupo só para quem está no mesmo grupo que quem consulta
               case when g.grupo_id is not null then p.nome end as nome,
               g.grupo_id,
               g.grupo_nome,
               g.grupo_cor,
               g.grupo_papel
          from public.participantes p
          left join lateral (
            select gr.id as grupo_id, gr.nome as grupo_nome, gr.cor as grupo_cor, theirs.papel as grupo_papel
              from public.grupo_membros mine
              join public.grupo_membros theirs on theirs.grupo_id = mine.grupo_id and theirs.participante_id = p.id
              join public.grupos gr on gr.id = mine.grupo_id
             where mine.participante_id = v_part.id
             order by gr.nome
             limit 1
          ) g on true
         where p.operacao_id = v_part.operacao_id
           and p.id <> v_part.id
           and not p.removido
           and p.liberado_em is null
           and p.ultima_lat is not null and p.ultima_lng is not null
           and p.ultima_posicao_em > now() - interval '15 minutes'
           and (
             -- integrante de um grupo em comum: precisa estar compartilhando a posição
             (g.grupo_id is not null and p.rastreando)
             or (
               -- militar ou responsável SEM grupo: continua visível, como antes
               p.tipo in ('militar', 'responsavel')
               and (p.tipo <> 'responsavel' or p.rastreando)
               and not exists (select 1 from public.grupo_membros x where x.participante_id = p.id)
             )
           )
      ) x
  ), '[]'::json);
end;
$$;

revoke execute on function public.equipe_no_mapa(uuid) from public, anon;
grant execute on function public.equipe_no_mapa(uuid) to authenticated;

notify pgrst, 'reload schema';
