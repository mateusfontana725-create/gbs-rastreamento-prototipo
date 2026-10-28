-- =====================================================================
-- 46. Criar operação: aceita a retenção de 90 dias (2160 h) que o painel já envia
--     (migração 040 — idempotente; exige a 022 e a 027)
--
--  O painel passou a enviar 2160 h (dados guardados até a exclusão, migração 027), mas a função
--  criar_operacao ainda aceitava só 0, 24, 72, 168 e 720. Resultado: "Política de retenção inválida"
--  ao criar qualquer operação. Esta versão aceita 2160 também; o resto da função não muda.
-- =====================================================================
create or replace function public.criar_operacao(p_codigo text, p_retencao_horas integer default 0, p_dados jsonb default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
  v_ipo jsonb;
begin
  if not public.eh_responsavel() then
    raise exception 'sem_permissao';
  end if;
  if p_retencao_horas is null or p_retencao_horas not in (0, 24, 72, 168, 720, 2160) then
    raise exception 'retencao_invalida';
  end if;
  v_op.codigo := btrim(regexp_replace(coalesce(p_codigo, ''), '\s+', ' ', 'g'));
  if char_length(v_op.codigo) < 2 or char_length(v_op.codigo) > 80 then
    raise exception 'codigo_invalido';
  end if;
  v_op.descricao := '';
  v_ipo := public.ipo_validar(p_dados->'ipo');
  if p_dados is not null then
    v_op := public.aplicar_cadastro_operacao(v_op, p_dados - 'codigo');
  end if;
  -- cadastro inicial: o tipo fica para depois, e o início das operações é automático (a hora da criação)
  v_op.acionado_em := coalesce(v_op.acionado_em, now());

  insert into public.operacoes (codigo, responsavel_id, token_civil, token_militar, retencao_horas,
                                tipo, tipo_outro, acionado_em, local_endereco, local_lat, local_lng, descricao, ipo)
  values (v_op.codigo, auth.uid(), public.gerar_token(), public.gerar_token(), p_retencao_horas,
          v_op.tipo, v_op.tipo_outro, v_op.acionado_em, v_op.local_endereco, v_op.local_lat, v_op.local_lng,
          coalesce(v_op.descricao, ''), v_ipo)
  returning * into v_op;

  return row_to_json(v_op);
end;
$$;

notify pgrst, 'reload schema';
