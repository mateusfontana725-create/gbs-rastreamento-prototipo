# CLAUDE.md

App de rastreamento GPS de equipes em buscas (Bombeiros). Sem build: HTML/JS/CSS estáticos + funções em `api/`, banco Supabase (Postgres).

## Estrutura
- `public/` páginas (`militar.html` painel do responsável, `civil.html` página do participante, `sci.html` painel de comando SCI, `index.html`), `js/` (lógica, sem bundler), `css/` (`estilos.css` base, `militar.css` painel).
- `api/` endpoints serverless (`rota.js`, `meteo.js`, `poa-ia.js`, `sci-ia.js`, `convidar.js`, `responsaveis.js`, `config.js`, `limpeza.js`).
- `supabase/schema.sql` instalação completa e idempotente; `supabase/migracoes/NNN_*.sql` migrações numeradas (a última é a 050).
- `testes/` testes unitários e `banco_migracoes.test.mjs` (banco real em PGlite).
- `README.md` documenta funcionalidades e o roteiro de testes manuais.

## Testes
- `npm test`: unitários (Node puro, sem dependências).
- `npm run test:banco`: schema e migrações num PostgreSQL real (PGlite). Precisa das dependências do `/tmp/.../pglite-check`; ver README.
- Testes de navegador (Playwright) ficam fora do repositório, no scratchpad da sessão. Rodar só os afetados pela mudança.

## Convenções
- Português em textos, comentários e mensagens de erro para o usuário. Código com nomes em português.
- Erros do banco chegam com código (`.codigo`); mapear em `comunicacao.js` (`ERROS`). Código novo: mensagem nova, sem reaproveitar substring de outra.
- Mudança de banco = nova migração numerada + atualizar `schema.sql` (sem o `notify` da migração) + testes em `banco_migracoes.test.mjs`.
- Nunca desativar RLS nem apagar dados reais. Escrita só por RPC `SECURITY DEFINER`.
- Interface: sem frameworks; usar `UI.el`, `UI.abrirModal`, `C.rpc`, `C.consultar`. Modais: título em `h2#modal-titulo` (vai para o cabeçalho com ×), explicação no `UI.dica`, campos com `UI.campo`/`UI.secao`/`UI.grade`, ações no `UI.rodape`.
- Commit e push na branch `v1` a cada mudança; não mexer em `main` nem `v2` sem pedido.
- Não incluir nome de modelo em commits, PRs ou código.
