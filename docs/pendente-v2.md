# Mudanças do v1 que ainda não foram para o v2

O `v2` (com o app Android) saiu do `v1` no commit `20d1bd2`. Tudo o que entrar no `v1`/`main` depois disso
e ainda não estiver no `v2` fica listado aqui, para levar quando for a hora. Ao levar, apague a linha.

| Commit | O que muda | Arquivos | Cuidado ao levar |
|---|---|---|---|
| `64d2822` | Tela do responsável: a troca entre Dashboard e Operações fica só nos botões da tela (saem do menu ☰ os itens "Painel de estatísticas" e "Lista de operações"); o botão e o título "Painel" / "Estatísticas e estudos" passam a se chamar **Dashboard**. | `public/militar.html`, `public/js/militar.js`, `public/js/dashboard.js`, `README.md` | `README.md` também mudou no `v2`: pode dar conflito só nele (o resto aplica direto). |

## Como levar

No branch `v2`, aplicar os commits da tabela, do mais antigo para o mais novo:

```
git checkout v2
git cherry-pick 64d2822
```

Se o `cherry-pick` parar por conflito no `README.md`, mantenha as duas partes do texto e continue com
`git cherry-pick --continue`. Para conferir o que ainda falta: `git log --oneline v2..v1`.
