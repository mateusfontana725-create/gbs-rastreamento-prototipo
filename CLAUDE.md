# CLAUDE.md

App de rastreamento GPS de equipes em buscas (Bombeiros). Sem build: HTML/JS/CSS estáticos + funções em `api/`, banco Supabase (Postgres).

## Estrutura
- `public/` páginas (`comando.html` Comando (painel dos responsáveis), `participante.html` página do participante, `index.html`), `js/` (lógica, sem bundler), `css/` (`estilos.css` base, `comando.css` painel).
- `api/` endpoints serverless (`rota.js`, `meteo.js`, `poa-ia.js`, `convidar.js`, `responsaveis.js`, `config.js`, `limpeza.js`, `app.js`, `convidar-responsavel.js`, `arquivar.js`).
- `android/` aplicativo Android do participante (Java, sem Kotlin): WebView da `participante.html` + serviço de GPS em primeiro plano (`FiltroGps` é porta do `gps.js`; ao mudar o `gps.js`, rodar `node android/ferramentas/gerar-casos-filtro.js`). Ponte com a página em `public/js/app-nativo.js` (`window.GBSApp`, só existe dentro do app). APK gerado por `.github/workflows/apk.yml`.
- `supabase/schema.sql` instalação completa e idempotente; `supabase/migracoes/NNN_*.sql` migrações numeradas (a última é a 068).
- Operação arquivada (migração 055): dados num arquivo gzip no Storage, lidos por `public/js/arquivo-local.js`, que `comunicacao.js` consulta antes do servidor. Tabela nova com `operacao_id` entra no arquivo sozinha; se tiver gatilho de exclusão, ele precisa respeitar `gbs.arquivando_operacao`.
- Mapa do painel: de longe (zoom ≤ 14) `public/js/mapa-resumo.js` agrupa pessoas e pontos juntos num selo só por região, escondendo por CSS os agrupamentos de sempre (`.mapa-resumo`). Marcador novo no mapa precisa entrar em `coletarParaResumo` (`comando.js`) para aparecer no resumo.
- Modo SCI (migração 057, tabelas `sci2_*`, só acréscimos): seletor OPERAÇÃO | SCI no topo do painel (ao lado do título, em `comando.html`) troca a interface; `public/js/sci-modo.js` (tela, usa `window.Painel`) e `public/js/sci-dados.js` (regras sem tela, catálogo de funções igual ao da 057). As tabelas `sci_*` do SCI antigo ficam no banco intactas (outras versões usam); não alterar nem apagar.
- Segurança (migração 068): `enviar_posicoes_lote` também confere cada ponto (ao vivo ou de trilha gravada sem internet) contra áreas de RISCO e proibidas e gera os alertas `zona_perigo`/`zona_proibida` (`alertar_zona_participante`; um por pessoa, zona e janela de 30 min), e abre/fecha `descansos` ao entrar e sair do raio de uma BASE. A fadiga (verde/amarelo/vermelho) é calculada no painel por `public/js/fadiga.js` (limites em `LIMITES`).
- Trilhas (migração 066): `enviar_posicoes_lote` não grava a trilha dentro do raio de uma BASE (só o ponto de entrada, `posicoes.na_base`, que não entra na linha desenhada) nem de quem está com `participantes.gravar_trilha = false`; os pontos descartados continuam sendo confirmados ao aparelho. Áreas que só ocultam trilhas no desenho: `areas_sem_trilha`. Geometria (recorte, borracha) em `public/js/trilha-geo.js`.
- `testes/` testes unitários e `banco_migracoes.test.mjs` (banco real em PGlite).
- `README.md` documenta funcionalidades e o roteiro de testes manuais.

## Testes
- `npm test`: unitários (Node puro, sem dependências).
- `npm run test:banco`: schema e migrações num PostgreSQL real (PGlite). Precisa das dependências do `/tmp/.../pglite-check`; ver README.
- Testes de navegador (Playwright) ficam fora do repositório, no scratchpad da sessão. Rodar só os afetados pela mudança.
- App Android: em `android/`, `./gradlew testReleaseUnitTest lintRelease assembleRelease` (precisa do Android SDK e JDK 17+).

## Convenções
- Português em textos, comentários e mensagens de erro para o usuário. Código com nomes em português.
- Erros do banco chegam com código (`.codigo`); mapear em `comunicacao.js` (`ERROS`). Código novo: mensagem nova, sem reaproveitar substring de outra.
- Mudança de banco = nova migração numerada + atualizar `schema.sql` (sem o `notify` da migração) + testes em `banco_migracoes.test.mjs`.
- Nunca desativar RLS nem apagar dados reais. Escrita só por RPC `SECURITY DEFINER`.
- Interface: sem frameworks; usar `UI.el`, `UI.abrirModal`, `C.rpc`, `C.consultar`. Modais: título em `h2#modal-titulo` (vai para o cabeçalho com ×), explicação no `UI.dica`, campos com `UI.campo`/`UI.secao`/`UI.grade`, ações no `UI.rodape`.
- Commit e push na branch `v1` a cada mudança; não mexer em `main` nem `v2` sem pedido.
- Não incluir nome de modelo em commits, PRs ou código.
