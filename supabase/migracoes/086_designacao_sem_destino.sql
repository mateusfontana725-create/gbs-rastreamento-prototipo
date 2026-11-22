-- =====================================================================
-- 086 — Designação sem destino no mapa (migração 086 — idempotente; exige a 036)
--
--  O app não é só para busca: num vendaval (árvores para cortar), numa ocorrência com múltiplas vítimas (IMV) ou em
--  qualquer operação de grande escala, a equipe é DESIGNADA para uma tarefa que nem sempre é um ponto no mapa
--  ("corte de árvores na Rua X", "triagem na área amarela", "apoio na ACV"). Até aqui, "designado" no SCI só existia
--  com um deslocamento (missão com destino no mapa).
--  Agora grupos.disponibilidade aceita também 'designado': a tarefa (e o local, se houver) vai em disponibilidade_obs
--  (até 200 caracteres). salvar_recursos_grupo aceita o valor novo e o diário registra "DESIGNADA".
--  Nada é apagado; equipes já cadastradas seguem iguais.
-- =====================================================================
alter table public.grupos drop constraint if exists grupos_disponibilidade_ok;
alter table public.grupos add constraint grupos_disponibilidade_ok check (
  disponibilidade in ('disponivel', 'em_descanso', 'indisponivel', 'designado')
  and char_length(disponibilidade_obs) <= 200 and char_length(capacidades) <= 300);

do $$
declare
  def text;
begin
  def := pg_get_functiondef('public.salvar_recursos_grupo(uuid, jsonb)'::regprocedure);
  def := replace(def, $q$if v_disp not in ('disponivel', 'em_descanso', 'indisponivel') then$q$,
                      $q$if v_disp not in ('disponivel', 'em_descanso', 'indisponivel', 'designado') then$q$);
  def := replace(def, $q$when 'em_descanso' then 'em descanso' else 'INDISPONÍVEL' end$q$,
                      $q$when 'em_descanso' then 'em descanso' when 'designado' then 'DESIGNADA' else 'INDISPONÍVEL' end$q$);
  execute def;
end;
$$;

notify pgrst, 'reload schema';
