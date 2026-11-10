-- Migração 075: o participante recebe o local (endereço) da operação, para o app escolher o pacote de mapa offline
-- (raio de 10 km em volta do endereço; sem endereço, o app usa a primeira posição boa do próprio participante).
-- Só quem está na operação (participante ativo, ligado a esta conta) lê. Não devolve nada além do local.

create or replace function public.local_da_operacao(p_participante uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
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
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  return json_build_object('lat', v_op.local_lat, 'lng', v_op.local_lng, 'endereco', v_op.local_endereco);
end;
$$;
revoke execute on function public.local_da_operacao(uuid) from public, anon;
grant execute on function public.local_da_operacao(uuid) to authenticated;
