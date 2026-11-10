-- Migração 074: exclusão pelos responsáveis da operação e edição de ponto pelo militar.
--
--  1. pode_excluir_registro: quem é responsável da operação (administrador, criador ou responsável adicionado)
--     exclui QUALQUER registro dela: pontos de interesse, setores, trilhas, grupos, áreas e vítimas.
--     Antes também exigia ser quem criou o item, e o responsável adicionado não conseguia excluir.
--     A assinatura continua a mesma (quem chama não muda).
--  2. participante_editar_ponto: o militar edita o ponto de interesse que ele mesmo marcou (categoria, título e
--     descrição). Não edita ponto de outro militar nem de responsável. Trilhas não são editadas pelo militar.
--     Setores: participante_salvar_setor (migração 072) já deixa o militar editar só o que ele criou.

create or replace function public.pode_excluir_registro(p_operacao uuid, p_criado_por uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.dono_operacao(p_operacao);
$$;

create or replace function public.participante_editar_ponto(p_participante uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_p public.pontos_interesse%rowtype;
begin
  v_part := public.militar_em_campo(p_participante);
  if not public.permissao_militar(v_part.operacao_id, 'pontos') then
    raise exception 'funcao_nao_liberada';
  end if;
  select * into v_p from public.pontos_interesse where id = p_id and operacao_id = v_part.operacao_id for update;
  if not found or v_p.criado_por is distinct from auth.uid() then
    raise exception 'funcao_nao_liberada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);
  if jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados_invalidos';
  end if;
  if p_dados ? 'categoria' then
    v_p.categoria := p_dados->>'categoria';
    if v_p.categoria not in ('POSSIVEL_LOCALIZACAO', 'VESTIGIO', 'RISCO', 'ENCONTRO', 'BASE', 'OUTRO') then
      raise exception 'dados_invalidos';
    end if;
  end if;
  if p_dados ? 'titulo' then
    v_p.titulo := btrim(coalesce(p_dados->>'titulo', ''));
    if char_length(v_p.titulo) not between 1 and 80 then
      raise exception 'nome_invalido';
    end if;
  end if;
  if p_dados ? 'descricao' then
    v_p.descricao := left(btrim(coalesce(p_dados->>'descricao', '')), 1000);
  end if;
  v_p.atualizado_em := now();
  v_p.atualizado_por_nome := v_part.nome || ' (militar)';
  update public.pontos_interesse
     set categoria = v_p.categoria, titulo = v_p.titulo, descricao = v_p.descricao,
         atualizado_em = v_p.atualizado_em, atualizado_por_nome = v_p.atualizado_por_nome
   where id = v_p.id;
  return row_to_json(v_p);
end;
$$;
revoke execute on function public.participante_editar_ponto(uuid, uuid, jsonb) from public, anon;
grant execute on function public.participante_editar_ponto(uuid, uuid, jsonb) to authenticated;
