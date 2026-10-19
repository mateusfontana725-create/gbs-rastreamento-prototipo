# Mudanças do v1 que ainda não foram para o v2

O `v2` (com o app Android) saiu do `v1` no commit `20d1bd2`. Tudo o que entrar no `v1`/`main` depois disso
e ainda não estiver no `v2` fica listado aqui, para levar quando for a hora. Ao levar, apague a linha.

| Commit | O que muda | Arquivos | Cuidado ao levar |
|---|---|---|---|
| `64d2822` | Tela do responsável: a troca entre Dashboard e Operações fica só nos botões da tela (saem do menu ☰ os itens "Painel de estatísticas" e "Lista de operações"); o botão e o título "Painel" / "Estatísticas e estudos" passam a se chamar **Dashboard**. | `public/militar.html`, `public/js/militar.js`, `public/js/dashboard.js`, `README.md` | `README.md` também mudou no `v2`: pode dar conflito só nele (o resto aplica direto). |
| `53b3a7d` | Dashboards interativos: Tocar nos números, colunas, linhas e contadores dos dois dashboards abre uma janela de detalhes (listas de operações, pessoas, setores; ver no mapa, abrir central e diário). | `public/js/dashboard.js`, `public/js/militar.js`, `public/js/interface.js`, `public/css/militar.css`, `README.md` | No `v2` o `militar.js` e o `README.md` também mudaram (app Android): conferir os trechos de `resumoOperacao` e `abrirDashboardOperacao`. |
| `da098ae` | Mapa do responsável menos poluído: nomes pelo zoom (longe só símbolos, médio nomes curtos, perto tudo), rótulos sem sobreposição (mudam de lado ou somem), pessoas próximas agrupadas de longe (quem pede atenção nunca agrupa), opção Camadas → Agrupar pessoas próximas. | `public/js/mapa-rotulos.js` (novo), `public/js/militar.js`, `public/css/militar.css`, `public/militar.html`, `testes/mapa_rotulos.test.js` (novo), `package.json`, `README.md` | No `v2` o `militar.js`, o `militar.html` e o `README.md` também mudaram: conferir `atualizarMarcador`, `limparDadosDoMapa` e a lista de scripts do `militar.html`. |
| `7bec4a8` | Painel enxuto: lista em uma linha por pessoa (detalhes na ficha), resumo que filtra a lista, letras e botões menores, cabeçalho e faixa de alerta compactos, modos "Mostrar no mapa" (Tudo, Equipes, Cobertura, Setores, Pontos, Fotos, Relatos) e camada Pessoas. | `public/js/militar.js`, `public/js/mapa-rotulos.js`, `public/css/militar.css`, `public/militar.html`, `README.md` | Depende do commit anterior (mapa-rotulos.js). No `v2` o `militar.js` mudou: conferir `criarItemLista`/`atualizarItemLista` e `renderizarLista`. |

## Como levar

No branch `v2`, aplicar os commits da tabela, do mais antigo para o mais novo:

```
git checkout v2
git cherry-pick 64d2822 53b3a7d da098ae 7bec4a8
```

Se o `cherry-pick` parar por conflito no `README.md`, mantenha as duas partes do texto e continue com
`git cherry-pick --continue`. Para conferir o que ainda falta: `git log --oneline v2..v1`.
