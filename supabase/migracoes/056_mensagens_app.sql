-- =====================================================================
-- 056 — Mensagens dos bombeiros no aplicativo Android com a tela apagada.
--
--  O serviço do aplicativo (o mesmo que envia a localização, sem a página aberta) busca a cada sinal de vida as
--  mensagens ainda não confirmadas e mostra a notificação do Android (som e vibração, como um aplicativo de
--  mensagens). Autoriza pelo segredo do aparelho (migração 051), como app_enviar_posicoes e app_sinal_vida.
--
--   app_mensagens_pendentes(dispositivo, segredo) → [{ id, tipo, texto, remetente_nome, criada_em }]
--     - só mensagens dos bombeiros para este participante (direcao 'saida'), não confirmadas, das últimas 12 h;
--     - marca como entregues (entregue_em) as que ainda não tinham chegado ao aparelho, como marcar_entregues.
-- =====================================================================

create or replace function public.app_mensagens_pendentes(p_dispositivo uuid, p_segredo text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part uuid;
  v_lista json;
begin
  perform public.app_dono_do_dispositivo(p_dispositivo, p_segredo);
  select participante_id into v_part from public.app_dispositivos where id = p_dispositivo;
  select coalesce(json_agg(json_build_object('id', x.id, 'tipo', x.tipo, 'texto', x.texto, 'remetente_nome', x.remetente_nome,
                                             'criada_em', x.criada_em) order by x.criada_em), '[]'::json)
    into v_lista
    from (select m.id, m.tipo, m.texto, m.remetente_nome, m.criada_em
            from public.mensagens m
           where m.participante_id = v_part and m.direcao = 'saida' and m.confirmada_em is null
             and m.criada_em > now() - interval '12 hours'
           order by m.criada_em desc
           limit 20) x;
  -- chegou ao aparelho: o painel mostra "entregue" (operação encerrada recusa a escrita; a lista vai do mesmo jeito)
  begin
    update public.mensagens m
       set entregue_em = now()
     where m.participante_id = v_part and m.direcao = 'saida' and m.entregue_em is null
       and m.criada_em > now() - interval '12 hours';
  exception when others then null;
  end;
  return v_lista;
end;
$$;

revoke execute on function public.app_mensagens_pendentes(uuid, text) from public;
grant execute on function public.app_mensagens_pendentes(uuid, text) to anon, authenticated;

notify pgrst, 'reload schema';
