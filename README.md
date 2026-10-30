# Rastreamento GBS — GPS para operações de busca e salvamento

Aplicativo web para o Corpo de Bombeiros Militar acompanhar, em tempo real, a posição e a trilha de
civis voluntários e militares durante operações de busca e salvamento, e enviar orientações direto
ao celular de cada participante.

- **`/militar.html`**: painel do bombeiro responsável (login obrigatório). Mapa, lista, trilhas, fichas,
  mensagens nos dois sentidos, relatos de campo, fotos georreferenciadas, equipe de responsáveis e a
  posição de cada responsável. Funciona no computador, no tablet e no celular.
- **`/civil.html#t=…`**: página do participante. Só abre com o link (ou QR Code) gerado pelo painel.
  O participante informa nome, celular e (opcionalmente) CPF, conversa com a equipe, relata pistas e envia fotos;
  o encerramento do rastreamento é feito pelo responsável.

Tecnologias: HTML/CSS/JavaScript puros, Leaflet + OpenStreetMap, **Supabase** (Postgres, Auth,
Realtime, Storage privado para as fotos) e **Vercel** (hospedagem e três funções de servidor). Não há etapa de compilação.

---

## 1. Como funciona

```
 Celular do participante                Supabase                         Painel do militar
 ───────────────────────                ────────                         ─────────────────
 GPS (watchPosition)                                                     
   → fila local (localStorage)  ──RPC enviar_posicoes──►  posicoes   ──Realtime──►  mapa + trilhas
   ← alerta em tela cheia      ◄──Realtime / consulta──  mensagens  ◄──RPC enviar_mensagem──  comandos
   → confirmar_mensagem        ──────────────────────►  mensagens   ──Realtime──►  "confirmada"
   → sinal_vida (a cada 15 s)  ──────────────────────►  participantes ─Realtime──►  conectado / instável
   → participante_enviar_mensagem ───────────────────►  mensagens   ──Realtime──►  central + aviso
   → foto (Storage privado) + registrar_foto ────────►  fotos       ──Realtime──►  câmera no mapa
```

- **Tempo real**: o painel recebe as mudanças pelo Supabase Realtime. Se o tempo real cair, o painel
  avisa ("Atualizando a cada 8 s") e passa a conferir o servidor periodicamente, buscando só as
  posições novas. Nada se perde.
- **Sem internet no celular**: as posições ficam guardadas no aparelho e são enviadas quando a
  conexão volta. Cada ponto tem um identificador único, então o reenvio **não duplica** pontos.
- **Trilhas**: os pontos são ordenados pelo horário do GPS (mesmo os que chegam atrasados). Intervalos
  maiores que 5 minutos sem pontos **não são ligados por uma reta** (para não sugerir que a área foi
  percorrida) e pontos com precisão pior que 100 m não entram na trilha.

### Estados mostrados no painel

| Indicador | Significado |
|---|---|
| ● verde **Conectado** | contato do celular nos últimos 45 s |
| ● amarelo **Sinal instável** | último contato entre 45 s e 2 min |
| ● vermelho **Sem atualização** | sem contato há mais de 2 min (a última posição continua no mapa, marcada como antiga) |
| Selo âmbar **Pediu para sair** | o participante solicitou o encerramento; o rastreamento continua até o responsável decidir |
| **Saída liberada às …** | o responsável liberou; o celular parou de enviar |
| Marcador tracejado e desbotado | posição com mais de 2 min: **não é a localização atual** |
| Militar = quadrado **M** vermelho, trilha contínua · Civil = círculo **C** verde, trilha tracejada · Responsável da operação = losango **R** vermelho, trilha pontilhada | a informação não depende só da cor |
| Anel amarelo | o participante respondeu "Preciso de ajuda" |

### Estados das mensagens

**Enviada** (gravada no servidor) → **Recebida pelo aparelho** (o celular do participante recebeu) →
**Confirmada** (o participante tocou em confirmar; no comando CONFIRME ele responde "Estou bem" ou
"Preciso de ajuda"). Se o participante estiver sem conexão, o painel avisa que a mensagem só será
entregue quando ele reconectar. Um pedido de ajuda destaca o participante em amarelo na lista e no
mapa e toca um alarme no painel.

### Vários responsáveis na mesma operação

- Quem cria a operação pode adicionar outros responsáveis pelo e-mail, em **Ferramentas → Equipe de responsáveis** (só quem
  já tem acesso ao painel). Qualquer responsável da operação também pode adicionar; **só o criador remove**.
- Todos veem o mesmo mapa, os mesmos participantes e mensagens, e podem enviar orientações (a
  mensagem mostra ao participante quem a enviou).
- **Localização do responsável**: é **sempre compartilhada** durante a operação, sem liga/desliga no menu.
  Os outros responsáveis a veem como um losango vermelho **R**; civis e militares de campo **não** veem.
  Só aparece um aviso (no menu **Ferramentas** e com um ponto vermelho no botão) quando a localização
  está bloqueada no navegador ou o aparelho não tem GPS.
- Pela ficha de outro responsável é possível mandar ATENÇÃO, CONFIRME ou mensagem livre; ela chega
  como alerta no painel dele, com confirmação de leitura.

### Página do participante (feita para quem não conhece o aplicativo)

A tela do civil é propositalmente simples, para quem está nervoso procurando alguém:

- **Um único aviso de situação**, em linguagem comum: "Os bombeiros estão vendo onde você está"
  (verde), "Procurando o sinal de GPS…", "Sem internet agora — sua localização está sendo guardada"
  (amarelo) ou "O GPS do celular está desligado" (vermelho). Sem horários, precisão ou contadores técnicos.
- **Mapa**: mostra **você** (ponto azul, com o círculo de precisão) e os **bombeiros** da operação —
  militares de campo (quadrado vermelho **M**) e o **responsável da operação** (losango vermelho **R**, só quando ele
  está compartilhando). Civis de outros grupos **não** aparecem; quem está no **seu grupo** aparece com a
  cor do grupo, com nome, sem CPF nem telefone (ver "Grupos no mapa do participante"). A posição de um
  bombeiro com mais de 2 minutos aparece apagada e com "há X min"; com mais de 15 minutos, some do
  mapa (nunca é mostrada como atual). Atualiza a cada 15 s. O botão **📍 Onde estou** volta para a
  sua posição.
- **Três botões grandes**: **TIRAR FOTO**, **ENCONTREI ALGO** (escolhe Possível pista, Objeto,
  Vestígio, Obstáculo ou Outra coisa, escreve se quiser e envia — a localização vai junto
  automaticamente; dá para enviar e já tirar a foto) e **FALAR COM OS BOMBEIROS**.
- **Falar com os bombeiros** abre a conversa numa tela própria (e só quando a pessoa toca): as
  mensagens recebidas aparecem como **"Bombeiros"** (à esquerda) e as enviadas à direita, com o texto
  e a hora; embaixo, o campo para escrever. O botão mostra um número quando chegam mensagens novas.
  Mensagens escritas sem internet são enviadas depois, sozinhas. Orientações dos bombeiros (PARE,
  RETORNE etc.) continuam abrindo o alerta em tela cheia na hora.
- Fotos: prévia "A foto ficou boa?" sem coordenadas; "Suas fotos" mostra só miniaturas com
  "✓ Enviada" ou "Esperando internet".
- Sair: o link discreto **Quero sair da busca** (os bombeiros liberam a saída pelo painel).

### Comunicação com os participantes (no painel)

- No painel, o botão **Mensagens** mostra quantas não foram lidas; a aba do navegador mostra o número
  entre parênteses; um aviso (com som) aparece a cada mensagem nova e, ao tocar, abre a conversa. O
  participante ganha o selo "Mensagem nova" na lista e um ✉ no marcador.
- **Central de comunicação** (botão **Mensagens**): todas as mensagens e relatos, com filtros
  (Todas / Relatos / Mensagens), **Ver no mapa** e **Responder**. Abrir a central ou a conversa marca
  como lidas, e o participante vê "Lida por Sgt Fulano às 10:32".
- **Relatos com localização** aparecem no mapa como marcadores laranja (P = pista, V = vestígio,
  O = objeto, ! = obstáculo…); tocar abre o texto, o autor, o horário e as coordenadas. Mensagens
  comuns não viram marcador (para não poluir o mapa), mas têm **Ver no mapa**.
- O participante pode pedir ajuda respondendo **PRECISO DE AJUDA** ao comando CONFIRME (alarme,
  destaque na lista e no mapa, **Marcar como atendido** na ficha).
- Na aba **Dados** da ficha, cada participante mostra a **última posição** (coordenadas, horário e há quanto tempo) e a
  **distância percorrida em km**, somada dos rastros GPS válidos (as falhas sem registro não contam). Os detalhes (tempo em
  movimento, velocidades e altitude) ficam em **Trilha de…**, e o total por pessoa no dashboard (**Percorrido**).
- A **ficha** do participante (menu lateral) é enxuta: no topo, em texto simples, **nome** (✎ renomeia), **tipo · grupo**,
  a **situação** e "Posição há X · ±Y m", com **✕** para fechar. Abaixo, o que pede atenção (pedido de ajuda, pedido de
  saída, destino em andamento), **Ver no mapa** e **⋮ Mais** (enviar destino, rota até a pessoa, trilha, encontrou a
  vítima, ligar) e duas abas: **Conversa** (mensagens, orientações rápidas em botões neutros — só **Pare** em
  vermelho — e o campo de mensagem) e **Dados** (celular, CPF, coordenadas com a precisão, última posição, último
  contato, rastreamento/GPS, ingresso; grupos; fotos; histórico de posições recolhido; estatísticas e exportar a trilha;
  "Remover participante"). A ficha abre sempre na **Conversa**. Em **Grupos** a ficha só mostra a lista e o botão
  **＋ Adicionar a um grupo**, que abre a escolha do grupo e do papel (membro ou responsável); trocar o papel ou tirar
  do grupo fica em Ferramentas → Grupos. O menu **⋮ Mais** da ficha sempre abre dentro da tela (com a lista lateral
  oculta, inclusive).
- Na **ficha**, a seção única **Mensagens** reúne tudo: o histórico completo nos dois sentidos (o que
  o participante escreveu e as orientações enviadas, com o estado de entrega/confirmação), as
  **orientações rápidas** (RETORNE, ATENÇÃO, MUDE A ROTA, PARE, CONFIRME — com confirmação antes do
  envio, como antes) e o campo para escrever uma mensagem livre.

### Fotografias georreferenciadas

- **Quem pode registrar**: participantes (civis e militares, pelo link) e responsáveis (**Ferramentas →
  Registrar foto**). Dá para **tirar a foto** com a câmera ou **escolher da galeria/arquivo**.
- **Prévia antes de salvar**: a pessoa vê a foto, o local e pode escrever uma descrição; **Salvar** ou **Cancelar**.
- **Registrado no banco (tabela `fotos`)**, não só no arquivo: horário da captura no aparelho, latitude,
  longitude, precisão, horário da posição, operação, **setor** (calculado pelo banco pela posição; o nome
  fica guardado mesmo se o setor for apagado) e quem tirou. Metadados visíveis só para os responsáveis da
  operação e para o próprio autor (RLS).
- **Localização**: foto da câmera usa o GPS do momento do registro; foto da galeria permite escolher entre
  o local gravado na própria foto (EXIF), a posição atual ou **sem localização**. Com precisão pior que
  ±500 m (localização aproximada pela rede) a leitura não é usada — **o sistema nunca inventa coordenadas**.
- **Sem GPS na hora da foto da câmera**: a foto é registrada mesmo assim, com o local **pendente**. O
  aparelho continua esperando o GPS e completa o local com a primeira leitura útil de até **10 min depois da
  captura** (se a foto ainda estiver na fila, já sai com o local; se já foi enviada, o local é atualizado no
  servidor). O servidor também completa pela **trilha GPS** da pessoa (ponto até 2 min antes ou depois da
  foto), inclusive quando a trilha chega depois. Sem nenhuma leitura no prazo, fica "sem localização". O
  marcador aparece no mapa do painel na hora em que o local é completado (tempo real).
- **Horários**: guarda o horário da captura (câmera ou EXIF) e o horário em que chegou ao sistema; quando
  a foto foi enviada bem depois (falta de internet), o painel mostra a diferença.
- **Conexões ruins**: a imagem é reduzida no aparelho (máx. 1600 px, JPEG — em geral 200–600 KB). No
  participante, a foto fica guardada no celular (IndexedDB) até conseguir enviar, com **Tentar agora** e
  **Descartar** em caso de falha; mensagens claras para sem internet, envio lento (> 90 s), arquivo
  grande demais ou operação encerrada.
- **No mapa**: ícone de **câmera** (violeta) no local de cada foto. Fotos e relatos próximos se agrupam
  num círculo com o número; ao aproximar eles se separam, e vários no mesmo ponto se abrem em leque.
  Os participantes ficam sempre por cima.
- **Janela da foto** (ao tocar na câmera do mapa): **data e hora da captura e o setor em destaque**, imagem,
  autor (e se é civil, militar ou responsável), horário do recebimento, latitude, longitude, precisão,
  origem da posição (GPS, EXIF, trilha GPS ou pendente), quando o local foi completado e descrição; **Ampliar** (tela cheia;
  tocar na imagem mostra o tamanho real), **Anterior/Próxima**, **Ver no mapa** e **Ficha** do autor.
  Também há a aba **Fotos** na central (galeria) e a seção **Fotos** na ficha de cada participante.
- A foto é **um registro de uma posição**: não entra no histórico nem altera a trilha.

### Cadastro completo da operação

- **+ Nova operação** (no topo de "Minhas operações") abre o cadastro num modal. Só o **nome** é obrigatório; o
  **início das operações** é automático (a hora em que a operação for criada). Vítimas, local, solicitante, natureza
  e observação são opcionais e podem ser completados depois. O mapa para escolher o ponto abre por cima do
  formulário, sem perder o que já foi preenchido.
- **Local: um modo de cada vez.** Ou **Marcar no mapa** (📍 Escolher no mapa, Usar minha posição ou a coordenada
  digitada em qualquer formato), ou **Só endereço (sem ponto)**. O ponto aparece num mapa pequeno ao lado dos
  botões, para conferir. Escolhido o endereço, o ponto não é gravado; salvo com o ponto, o endereço escrito é
  retirado (um aviso aparece quando um cadastro antigo tinha os dois). O app não consulta serviço de busca de
  endereços, então o endereço não vira ponto sozinho. Sem ponto, a operação não aparece no mapa e não entra nos
  cálculos de distância (ULV).
- **Ferramentas → Dados da operação**: ver e editar tudo (inclusive o nome) e o **intervalo do GPS** (ver
  "Trilhas GPS"). O local aparece no mapa como **◎ laranja** ("Local da operação", camada própria em
  no painel **Camadas**); tocar nele abre os dados.
- **Operações antigas** (criadas só com o nome) continuam válidas: a lista mostra o selo **Cadastro
  incompleto** e a opção **Completar cadastro** no menu **⋮** da linha. Nada é preenchido sozinho.
- O participante continua vendo só o **nome** da operação (endereço e descrição não vão ao celular).

### Ficha da vítima

- **Na criação da operação**: a seção recolhível **Vítimas (opcional)** do modal **+ Nova operação**
  aceita uma ou mais fichas (**+ Adicionar vítima**), com os mesmos campos e a mesma validação da ficha.
  Tudo é conferido **antes** de criar a operação; cancelar não grava nada. Criada a operação, as fichas são
  salvas uma a uma; se alguma falhar, o modal continua aberto só para elas (**Tentar salvar de novo** ou
  **Seguir sem elas**) — a operação não é criada de novo, ficha salva não é reenviada e, antes de repetir,
  o painel confere no servidor se a tentativa anterior já tinha gravado (sem duplicar). A foto é
  adicionada depois, na ficha.
- **Cadastro rápido** (migração 044): **Ferramentas → Cadastro rápido de vítima** (ou **⚡ Cadastro rápido** na lista de
  vítimas) pede só o essencial, com botões grandes: **nome** (em branco = "Não identificada"), **faixa etária** (criança,
  adolescente, adulto, idoso — criança, adolescente e idoso já preenchem o perfil), **idade** aproximada (fica "estimada"),
  **sexo** e **roupa e aparência**. **Salvar e novo** deixa o formulário limpo para a próxima pessoa; Enter salva. A ficha
  fica marcada **completar** na lista e na ficha (aviso e botão **Completar a ficha**); salvar o formulário completo tira a
  marca, a menos que se marque "Ainda falta completar". A vítima criada só com o nome em **Vítima encontrada** também nasce
  como cadastro rápido.
- **Vítimas (fichas)** ficam em **Dados da operação → Editar** (e na criação da operação): uma ou mais fichas por operação, com **foto**, **nome** (ou "Não
  identificada"), **idade**, **características físicas**, **roupas** e **observações**.
- **Idade informada ou estimada** (migração 042): ao lado da idade, a caixa **estimada** marca que ela veio da
  aparência ou de um palpite ("cerca de 70 anos (estimada)"). Em branco é **não informada** — nunca vira zero, e os
  estudos contam à parte as fichas sem idade e com idade estimada.
- A foto é reduzida no aparelho (máx. 1600 px, JPEG) e guardada no bucket **privado `vitimas`** do
  Supabase Storage; só aparece por link temporário assinado. Trocar ou tirar a foto apaga o arquivo antigo.
- **Somente os responsáveis da operação** veem as fichas (RLS no banco e no Storage). Civis e militares de
  campo não têm acesso de nenhuma forma (nem pela API, nem pelo tempo real).
- Quando os dados da operação são apagados (retenção) ou a operação é excluída, as fichas e as fotos
  também são.

### Grupos

- **Ferramentas → Grupos**: criar grupos com **nome livre** (ex.: Polícia Civil, Polícia Militar,
  Bombeiros) e cor; uma pessoa pode estar em mais de um grupo.
- **Membros**: adicionar pessoas pelo painel (marcar várias e **Adicionar marcados**) e definir o
  **papel**: **Membro** ou **★ Responsável** do grupo. Também na ficha do participante (seção **Grupos**).
- **Link do grupo** (com QR Code, Copiar, Compartilhar): quem entra por ele entra na operação **e** no
  grupo, sempre como **membro**; como civil, a não ser que o grupo permita militares. **Gerar novo link**
  invalida o anterior na hora. O papel de responsável só é dado pelo painel.
- **No mapa, controle "Grupos"** (canto superior direito): cada grupo tem um **ícone de olho 👁**. Tocar
  mostra **só as pessoas (marcador e trilha) e os destinos do grupo**. **Vários olhos podem ficar ligados
  ao mesmo tempo**: o mapa mostra a união dos grupos ligados (ex.: dois grupos na tela). Tocar de novo
  desliga um grupo; **Mostrar todos** restaura a visualização completa. O olho ligado fica destacado e o
  título do controle mostra **· filtrado** (ou **· N filtrados**); não aparece nenhum aviso nem faixa no mapa.
  Setores, pontos de interesse, fotos e relatos continuam visíveis; **pedidos de ajuda, pedidos de saída e
  alertas de quem está fora do grupo continuam tocando** e avisam "fora do grupo mostrado". O filtro não
  fica lembrado ao recarregar.
- Na lista, cada pessoa tem o selo dos grupos (★ = responsável do grupo); no mapa, o responsável do grupo
  tem uma ★ no marcador.
- **Cor do grupo no mapa**: quem está num grupo tem o **marcador** e a **trilha** na cor do grupo (o
  primeiro grupo, por nome, se houver mais de um). A forma continua dizendo o tipo: **quadrado** = militar,
  **círculo** = civil, **losango vermelho com R** = responsável da operação (diferenciado do militar pela forma e pela letra). O **responsável do grupo** recebe um
  **distintivo branco com ★** no canto do marcador, que não depende da cor. O **responsável da operação**
  nunca recebe a cor de um grupo.
- **Cor livre** (grupos e setores): além das amostras prontas, o botão **＋** abre o painel de cor com **tom,
  intensidade e claridade** (deslizantes), o **código #rrggbb** e o seletor do sistema. **Guardar em "Minhas cores"**
  mantém até 12 cores neste aparelho para reaproveitar em outros grupos e setores (`js/cores.js`; o servidor aceita
  qualquer #rrggbb). Dá para criar quantos grupos quiser, cada um na sua cor.
- **Paleta dos grupos** (novos grupos): rosa, laranja, índigo, lima, branco e ocre, escolhidas para não
  se confundir com o vermelho dos militares e responsáveis, o verde dos civis, o amarelo de
  pedido de ajuda, o âmbar da seleção e as trilhas roxas e azuis. Grupos que já existiam mantêm a cor salva.
- **Legenda**: começa **recolhida** (um toque em **▤ Legenda** abre e fecha). Mostra só os tipos presentes
  na operação, o distintivo do responsável do grupo, a lista **Grupos ativos** (gerada dos grupos cadastrados,
  com a cor e a quantidade de integrantes) e os símbolos do mapa. **✎ Editar legenda** troca o texto de cada
  item (ex.: "Militar" → "Bombeiro") ou tira o item da legenda; **Restaurar padrão** desfaz. Muda só os textos
  da legenda e fica guardado neste aparelho; os nomes dos grupos se mudam em **Grupos**.
- **Mapa limpo (padrão)**: o mapa **não mostra nomes** (pessoas, pontos, setores, local da operação, arquivos
  importados). **Um clique** num item abre um **balão** pequeno preso a ele (nome e o essencial: tipo e grupo,
  hora da posição, pedido de ajuda, destino; nos setores a situação; nos pontos e relatos o começo do texto) com o
  botão **Detalhes ›**. A **ficha** ou os **detalhes** abrem com **dois cliques**, **clicar e segurar** (mouse ou dedo)
  ou o botão do balão; arrastar o mapa a partir de um símbolo não abre nada. **Na lista lateral um clique abre direto.**
  Os símbolos ficam **translúcidos** (quem pede ajuda, quer sair ou está selecionado fica opaco) e **diminuem ao
  afastar o zoom** (até ~metade do tamanho, agrupamentos inclusive) **e também de muito perto**: do zoom 17 (escala de 100 m)
  em diante cada nível diminui um pouco (90% no zoom 16, 80% no 17, 68% no 18, 58% no 19 e 50% do 20 em diante); vítima localizada e pedido
  de ajuda nunca ficam abaixo de 80%; trilhas finas (2,5 px de perto, ~1 px de longe;
  com alguém selecionado, as outras ficam apagadas), setores e círculos de base/risco com traço e preenchimento
  discretos. **Camadas → Nomes no mapa** volta a mostrar os nomes como abaixo.
- **Fileiras de botões** viram **"⋮ Mais"**: na ficha ficam **Ver no mapa** e **⋮ Mais** (enviar destino, rota até a
  pessoa, trilha, encontrou a vítima, ligar); nos detalhes de setor, ponto, trilha, relato e foto, nos grupos, nos
  deslocamentos e nos arquivos importados fica a ação principal, o menu e **Fechar**.
- **Nomes no mapa** (quando ligados em Camadas): os participantes aparecem com o nome **abreviado** ("Lucas F.", "João S."; com posto ou
  graduação, posto + nome de guerra: "Sgt. Oliveira"). Se dois nomes ficariam iguais, ganham o sobrenome
  ("João Pereira", "João Pinto"). O nome **completo** aparece ao passar o cursor no marcador, ao focar pelo
  teclado, no participante selecionado e na ficha. "Há X min" só aparece para quem está com a posição antiga,
  pede atenção ou está selecionado; o rótulo do setor mostra só o nome (a situação fica no estilo e nos detalhes);
  nomes de pontos muito longos são encurtados e aparecem inteiros ao passar o cursor.
- **Renomear**: o **✎** ao lado do nome na **ficha do participante** dá um nome de exibição no painel (ex.:
  "Lucas – Drone"); a ficha mostra também o nome que a pessoa digitou, que não muda, e **Voltar ao nome original**
  desfaz. Vale para todos os responsáveis (migração 029). O **✎** nos detalhes de um **ponto de interesse** renomeia o ponto.
- **Grupos no mapa do participante**: cada civil vê, além de si mesmo, os **integrantes dos grupos em comum**
  (civis, militares ou responsáveis), na cor do grupo, com o nome, a última posição e a atualização a cada
  15 s. Ele **não** vê quem está só em outro grupo; militares e responsáveis **sem grupo** continuam visíveis
  como antes, sem nome. Quem não está compartilhando a posição some do mapa dos colegas. A própria trilha
  do participante aparece no mapa (últimos 300 pontos desta sessão), na cor do grupo.
- **Quem vê o quê (RLS)**: os responsáveis da operação veem todos os grupos e links; cada participante vê
  **somente os grupos de que faz parte** e o próprio papel (no celular: "Grupo X (responsável)"). Ninguém
  em campo lê os links nem a lista de membros.

### Deslocamento de grupos, alertas e controle de retorno

- **Enviar destino → Grupo** (Ferramentas → Enviar destino, "Enviar o centro como destino" num setor, ou
  Grupos → 🧭 Enviar destino): escolha o grupo e **quem recebe** — **todos os membros** ou **só o
  responsável do grupo** —, a **base** (ponto de interesse do tipo **Base da operação**, com o raio de
  chegada) e o **prazo de retorno** (padrão 30 min). Todos os membros de campo ativos são acompanhados.
- **Alertas automáticos ao responsável da operação**, em tempo real (Supabase Realtime, com conferência
  periódica de reserva), na aba **Alertas** da central:
  - **início do deslocamento** — primeiro ponto a ≥ 100 m de onde a pessoa estava no envio (ou fora do
    raio da base, para quem estava na base);
  - **chegada ao setor** — 2 pontos seguidos dentro do setor (círculo ou polígono); destino sem setor: a até 30 m;
  - **finalização da busca** — pelo **responsável do grupo** no celular (**BUSCA NO SETOR CONCLUÍDA**) ou
    por um responsável da operação (**Deslocamentos de grupos → Finalizar busca**). O setor não vira
    "Concluído" sozinho;
  - **chegada à base** — quando **todos** os acompanhados ativos estão dentro do raio da base (com GPS
    preciso o suficiente);
  - **retorno atrasado (crítico)** — se o prazo passar sem todos na base: faixa vermelha fixa, alarme
    repetido até alguém tocar em **Ciente**, com quem falta e há quanto tempo foi a última posição de cada um
    ("a equipe pode estar perdida").
- Tudo é calculado **no servidor, pela trilha GPS** (hora do GPS; pontos com precisão pior que 150 m não
  contam; pontos que chegam atrasados da fila offline contam com o horário real). O atraso é verificado
  **por tempo** pelo `pg_cron` do Supabase (a cada minuto), mesmo com os celulares sem sinal e sem painel
  aberto; sem `pg_cron`, o painel aberto faz essa verificação (a cada 30 s na volta à base, 60 s nas demais fases).
- Ao finalizar a busca, todos recebem o destino **"Volte para a base"** no celular. **Prorrogar +15 min** e
  **Encerrar** ficam em **Ferramentas → Deslocamentos de grupos**, com a linha do tempo e a situação de
  cada membro. Uma missão nova do mesmo grupo substitui a anterior.

#### Controle de tempo e comunicação (migração 032)

- **Horários combinados**: no envio ao grupo, o bloco **Horários combinados (opcional)** tem **Sair até** e
  **Estar de volta até** (atalhos agora / +15 / +30 min e +1 / +2 / +4 h; uma hora já passada há mais de 6 h é
  de amanhã). Em **Alertas e combinados** (fechado por padrão, 10 min e 10 min) ficam o **atraso** que dispara o
  aviso (depois do horário), a **falta de contato** (tempo sem nenhuma notícia do celular) e o que foi combinado
  (ex.: rádio a cada 30 min no canal 3).
- **Retorno à base** (no mesmo formulário): a base, o raio em que a chegada conta ("Na base quando estiver a até")
  e **Voltar em até (min) depois da busca**, que começa a contar ao clicar em **Finalizar busca**. O horário de volta
  e esse tempo são verificados os dois; o alerta de retorno atrasado vale para quem ultrapassar qualquer um.
- **Ferramentas → Deslocamentos de grupos**: um cartão por deslocamento, com as etapas (enviado, saiu, no setor,
  busca encerrada, todos na base), o quadro **Horários combinados** (quanto falta ou o que já aconteceu, em
  vermelho quando atrasou), a situação de cada membro e a última notícia dele (**📵** em vermelho quando passa do
  limite). Ações: **Finalizar busca**, **Mais 15 min para voltar**, **⏱ Horários** (muda os horários, a
  tolerância e os alertas; cada alteração vai ao **diário** com quem definiu), **Ver no mapa** e **Encerrar**.
  Se a gravação dos horários falhar, o destino continua enviado (não é repetido) e o painel avisa para tentar de novo.
- **Alertas gerados pelo servidor** (`verificar_prazos`, chamada junto com `verificar_retornos` pelo `pg_cron` a
  cada minuto ou pelo painel aberto — mesmo com os celulares sem internet):
  - **INÍCIO ATRASADO** (crítico) — ninguém do grupo começou o deslocamento até o horário + tolerância;
  - **RETORNO ATRASADO** (crítico) — passou o horário de retorno + tolerância e há quem não voltou (com base:
    quem não chegou à base; sem base: o deslocamento ainda aberto), com o último contato de cada um;
  - **SEM COMUNICAÇÃO** (crítico) — um membro de deslocamento ativo ficou sem nenhum contato com o servidor
    (posição ou sinal de vida) além do limite: pode estar sem internet, sem bateria ou com o celular desligado.
    Mostra o último contato e a **última posição conhecida** (Ver no mapa);
  - **Comunicação restabelecida** (informativo) — quando o celular volta a falar com o servidor: quanto tempo
    ficou sem contato e **quantas posições gravadas sem internet chegaram depois** (e de que horário a que
    horário), pela diferença entre a hora do GPS e a hora de chegada ao servidor.
  Cada alerta sai uma vez por horário combinado / episódio (não repete a cada verificação) e entra no diário.

### Pedidos de ajuda (migração 035)

O pedido de ajuda (botão **Preciso de ajuda** do participante ou resposta **PRECISO DE AJUDA** a um comando) vira um
**pedido com estados**, controlado pelo servidor (`pedidos_ajuda`). Ler a mensagem ou dar ciente **não resolve**:
só **Resolver**, com a justificativa.

- **Estados**: recebido → assumido (por um responsável) → equipe enviada → em atendimento → resolvido. Cada passo
  grava **quem fez e quando** no histórico (`pedido_ajuda_eventos`), que é só de acréscimo: não se edita nem se apaga.
- **Tempo sem atendimento**: enquanto ninguém assume, o cartão mostra **SEM ATENDIMENTO há X** e a pílula **🆘** do
  topo (vermelha e pulsante) conta quantos pedidos estão abertos e há quanto tempo o mais antigo espera.
- **Escalonamento**: se ninguém assume, o servidor (`verificar_pedidos_ajuda`, pelo `pg_cron` a cada minuto e pelo
  painel aberto) gera o alerta crítico **ajuda sem atendimento**, que toca o alarme e se repete em níveis (prazo base
  por prioridade: crítica 2 min, alta 3, média 8, baixa 15; o prazo cresce depois que alguém assume ou envia equipe).
- **Prioridade** (crítica, alta, média, baixa; padrão alta). **Baixar** a prioridade exige justificativa.
- **Encerrar** exige **como terminou** (atendido, sem necessidade, falso alarme, encaminhado, outro) e a
  **justificativa** (mín. 5 caracteres). **Reabrir** exige motivo e guarda a resolução anterior no histórico.
- **Participante**: `meu_pedido_ajuda` devolve só o estado do pedido dele (nunca os dados de outros).
- Telas: **Ferramentas → Pedidos de ajuda**, a pílula do topo e o bloco da **ficha** do participante (que antes tinha
  "Marcar como atendido", só local). Sem a migração 035, o painel continua com o aviso antigo.

### Recursos e segurança das equipes (migração 036)

Cada equipe (grupo) tem **disponibilidade** (disponível, em descanso, indisponível, com observação e hora de volta;
**em missão** aparece sozinho quando há deslocamento ativo), **capacidades** (texto livre, ex.: mergulho, APH) e
**recursos**: embarcação, viatura, drone, cão de busca, equipamento de comunicação, primeiros socorros e outro
(identificação, quantidade, situação operacional/limitada/indisponível). Em **Ferramentas → Grupos**, cada equipe
mostra os chips e o botão **Recursos**.

- **Aviso de segurança**: equipe com recursos informados mas **sem comunicação** ou **sem primeiros socorros**.
  Sem nada informado, não se acusa falta.
- **Enviar destino** a uma equipe em descanso, indisponível ou já em missão pede confirmação (a decisão é do comando).
- Alterações vão ao **diário** (`equipe_recursos`) e entram no briefing. Gravação só por `salvar_recursos_grupo`.

### Briefing e passagem de comando (migração 037)

**Ferramentas → Briefing e passagem de comando** abre uma página curta montada pelo servidor
(`briefing_operacao_dados`) com o que **já está cadastrado**, sem redigitar: objetivo, vítimas e **último local
visto**, hipóteses (último cenário POA aprovado de cada vítima), riscos (pontos de risco, pedidos de ajuda abertos,
alertas críticos sem ciente), equipes (disponibilidade, recursos, avisos), tarefas (deslocamentos e setores
pendentes), comunicações e **decisões pendentes** (as anotadas e as que o sistema vê esperando alguém).
Só objetivo, riscos, comunicações, observações e decisões são digitados aqui. **Copiar texto** gera um resumo para rádio ou mensagem.

- **Quem comanda** aparece no topo (chip ★). **Passar o comando**: o comandante (ou administrador) escolhe outro
  responsável da operação; o servidor guarda uma **foto do briefing** naquele momento. O comando **só muda quando a
  outra pessoa aceita** (com o horário do aceite); ela pode **recusar com motivo**. Quem passou pode cancelar.
- **Assumir o comando** sem aceite (comandante sem resposta): exige motivo (mín. 10 caracteres) e entra no diário em destaque.
- O histórico de passagens é **imutável** (aceite, recusa, cancelamento, assunção) e a foto de cada uma pode ser revista.

**Migrações 035, 036 e 037**: rode no Supabase em ordem (035 → 036 → 037). Cada módulo do painel avisa se a sua migração
ainda não foi aplicada; o resto do painel segue normal. Detalhes e erros de cada função estão nos próprios arquivos `.sql`.

### Painel de comando SCI (migrações 045 e 046)

**SCI** no topo do painel abre o **painel de comando** do Sistema de Comando em Incidentes, atualizado em tempo real.
**⋯ Mais → ↗ Outra janela** abre só o painel (`sci.html?op=…`): é o link do **comando remoto** (ex.: Comandante do Batalhão)
acompanhar pelo celular — pede o login de responsável e se atualiza sozinho. Com a operação encerrada, fica só para consulta.

**Integrado ao que o app já tem (não pede de novo):**

- **Vítimas**: as **fichas** do cadastro aparecem em **Procuradas**. O **"Vítima encontrada"** do app — no celular de campo, no
  mapa ou pelo próprio SCI — põe a vítima em **Localizadas** sozinha (migração 046, gatilho no banco), ligada à ficha (nome, idade,
  sexo), com a hora e o local; óbito já entra como cinza. Arrastar uma ficha de Procuradas para Localizadas abre o mesmo formulário
  do app (ponto no mapa, quem encontrou, condição, estado) e, ao registrar, volta ao SCI. No mapa, o marcador da vítima mostra o número
  e o quadro do SCI e tem **Abrir no SCI**. **+ Sem identificação** é para vítimas ainda sem ficha (ex.: várias ilhadas); depois dá para
  ligar à ficha. **⚡ Nova ficha** abre o cadastro rápido.
- **Comandante do Incidente** = quem está **no comando da operação** (Briefing → Passar o comando); só muda pela passagem de comando
  (ou se o SCI disser outro nome). **Objetivo**, **riscos** e **comunicações** são os do **briefing** (uma fonte só).
- **Equipes** = os **grupos** do app: membros e quantos com sinal, ★ responsável do grupo, disponibilidade, **deslocamento ativo**
  (status e setor) e **recursos** (embarcação, viatura, drone, cão…). O SCI acrescenta a **missão** e o **órgão** de cada grupo e as
  **equipes fora do app** (sem celular rastreado). Atalhos para abrir o grupo e os recursos.
- **Instalações** apontam para **pontos do mapa** (a base cadastrada vira o PC com um toque); as coordenadas vêm do ponto.
- **Alertas do comando** incluem os do app: **pedido de ajuda** (sem atendimento é crítico), **retorno atrasado**, **sem comunicação**,
  **passagem de comando** aguardando aceite, **decisões pendentes** (prazo vencido), indicações do **cão** em análise e **focos térmicos**
  a verificar — além dos do SCI (segurança primeiro, vítima vermelha, rio subindo, contagem, o que falta).
- **Linha do tempo única**: os registros do SCI e todo o **diário** do app (deslocamentos, chegadas, setores, pessoas, alertas, vítimas
  encontradas), com filtro por assunto. Os **marcos** que o app já sabe aparecem para **confirmar** (acionamento do cadastro, primeiro
  militar no app, primeira vítima encontrada, encerramento). Tudo o que o SCI registra entra no diário e no relatório final.
- **Mapa do comando** (Visão geral): local, instalações, vítimas encontradas na cor da triagem, setores e pontos de risco.
- **Órgãos**: mostra também quantos estão **rastreados pelo app** (militares, civis, com sinal), ao lado do efetivo informado ao PC.
- **Setores** de operação são os do mapa.

**Abas**: **Visão geral** (números — vítimas, procuradas, localizadas, óbitos, equipes em missão, rastreados, órgãos —, alertas,
comando e situação, mapa, últimos registros) · **Vítimas** (Procuradas → Localizadas → Removidas para a ACV → Transportadas, triagem
verde/amarelo/vermelho/cinza só depois da ACV, total informado e NÃO CONFIRMADO) · **Comando** (funções SCI, instalações, setores,
comunicações, organograma, acompanhamento remoto) · **Equipes e órgãos** · **Linha do tempo** · **Recursos** (recursos das equipes do
app, outros recursos e pedidos, logística, nível do rio) · **Local e danos** (imagens de satélite, coordenadas, links de mapa e rota,
aeronave, relatório de danos). As abas mostram quantos alertas cada uma tem.

**Registrar por frase ou voz** (🎤 no Chrome do celular): "despacho 7h15", "PC estabelecido", "V-03 na ACV, amarela", "V-01 e V-02
transportadas ao hospital", "SAMU no local com 5 pessoas", "segurança: Sgt Dinardi", "total de vítimas 14", "rio estável segundo o drone".
O painel mostra o que entendeu e as **divergências** antes de gravar; informação de terceiros entra como **NÃO CONFIRMADA**.
**Entender com IA** (opcional, `api/sci-ia.js`, mesma chave do POA/POD) lê frases longas; as ações passam pela mesma validação e nomes de
vítimas não vão para a IA. **O que falta?** lista as pendências em ordem de prioridade.

**Copiar resumo** (WhatsApp, com fichas procuradas e quem está em campo), **Texto para a imprensa** (sem nomes de vítimas),
**Imprimir / PDF** e **Modo teste** (testar o quadro antes da ocorrência; ao sair, zera vítimas, linha do tempo, marcos e total de teste,
sem nada no diário).

Banco: migração **045** (`sci_estado`, `sci_vitimas`, `sci_eventos`, `sci_itens`, funções `sci_*`, bucket privado `sci`) e **046**
(vínculo com a vítima encontrada — o gatilho nunca impede o registro —, `sci_contexto` com o que o SCI lê do app, instalação ligada a
ponto do mapa). Leitura só pelos responsáveis da operação; escrita só pelas funções; encerrada somente leitura.

### Verificação: relatos, binômio, drone e água (migrações 042 e 043)

Regra de leitura em todos: **indicação não é confirmação**. Cada registro guarda **quem, quando e de onde veio** o dado,
e os estados finais (confirmado, descartado, inconclusivo, contestado) **exigem justificativa**.

- **Revisão de relatos** (pista, vestígio, objeto, obstáculo…): no relato (Mensagens → relato → **Detalhes e revisão**),
  **Revisar** escolhe o estado — pendente, em análise, confirmado, descartado, inconclusivo ou contestado. Cada revisão
  é uma **versão nova** (as anteriores ficam em "Versões da revisão"). O relato mostra **três horários separados**:
  **Fato** (quando aconteceu: informado, estimado, pelo GPS ou desconhecido — em branco é "não informado", não a hora do
  envio), **Recebido** (quando chegou) e **Revisado** (quem e quando). A hora da posição GPS aparece à parte. O selo do
  estado aparece no feed de mensagens. Só os responsáveis veem as revisões; o participante continua vendo só a mensagem.
- **Binômio (cão e condutor)** — Ferramentas → **Binômio**: sessão ligada a um **setor**, com o **condutor**
  (participante do app ou só o nome), o **cão**, se o cão tem GPS (normalmente **sem dispositivo**: o mapa mostra a
  **trilha do GPS do condutor** durante a sessão, sem as pausas, e diz isso), o **artigo de odor** (o quê, origem,
  manipulação) e as **condições**. **Iniciar, Pausar, Retomar, Finalizar** guardam a hora de cada passo; o cartão mostra
  o tempo efetivo de busca. **⚑ Indicação** registra I1, I2… "em análise" na posição do condutor (ou minha posição, ou
  tocando no mapa). **Confirmar por outro meio** cria C1… ligada à indicação, com **método independente obrigatório**
  (equipe no local, busca visual, drone…), "pendente" até alguém registrar o **Resultado** com justificativa. I e C
  aparecem no mapa; tudo vai para o diário.
- **Drone e água** — Ferramentas → **Drone e água**, abas Drone e Água:
  - **Plano de voo** (linha ou área desenhada; sensor e altura): fica "planejado" — **plano não prova voo**;
  - **Telemetria**: o arquivo do voo (GPX, KML/KMZ, GeoJSON ou CSV) vira o trajeto voado, com início e fim lidos do arquivo;
  - **Área observada** (área desenhada; sensor, altura e qualidade: boa, parcial, ruim): é o que conta como visto;
  - **Foco térmico** (ponto; temperatura e imagem): fica "a verificar" — **térmico não é vítima** — até alguém verificar ou descartar;
  - **Indicação na água**: posição, **possível área de origem** (área desenhada), **corrente** (desconhecida, estimada ou
    medida — **desconhecida é um valor válido**, os campos de direção e velocidade só aparecem quando há valor), **vento com a
    fonte do dado** (medido, previsão, estimado, desconhecido) e condições.
  Cada registro tem título, fonte, hora observada e estado; tocar no mapa abre o registro.
- **Dashboard da operação → Verificação**: relatos sem revisão, em análise, confirmados, descartados, inconclusivos;
  indicações do cão em análise e confirmadas; focos térmicos a verificar; indicações na água; área observada por drone.

**Migrações 042 e 043**: rode no Supabase em ordem. Sem elas, cada janela avisa qual migração falta e o resto do painel segue normal.

### Convidar por WhatsApp ou e-mail, por categoria (migrações 044 e 047)

**Convidar** tem as abas **● Link para CIVIS**, **■ Link para BOMBEIROS**, **☎ WhatsApp** e **✉ E-mail**. Nas duas últimas, o
responsável escolhe a **categoria** do convidado — **Civil**, **Bombeiro** ou **Responsável** — e o link enviado corresponde a ela:
civil recebe o link dos civis, bombeiro o link dos bombeiros (pode escolher militar) e responsável o endereço do **painel da operação**
(entra com a própria conta; precisa estar na Equipe de responsáveis).

- **WhatsApp**: nome + celular com DDD → **Enviar pelo WhatsApp** abre a conversa direto com o número (`wa.me`), **sem salvar o
  contato**, com a mensagem e o link prontos; é só tocar em enviar. Celular com 10 ou 11 dígitos ganha o 55 do Brasil.
- **E-mail**: como abaixo, agora com a categoria. O mesmo celular + categoria (ou o mesmo e-mail) na mesma operação reaproveita o convite.
- Banco: `criar_convite` (categoria, canal, e-mail ou telefone), erros `telefone_convite_invalido` e `nome_convite_invalido`.


**Convidar → ✉ Convidar por e-mail**: o responsável digita o **nome** e o **e-mail** do participante e toca **Enviar convite**. O
participante recebe um e-mail com o botão **Abrir e começar** (o link do `civil.html` da operação). Ao abrir no celular, o
**nome já vem preenchido** e basta tocar em COMEÇAR e permitir a localização.

- A lista **Convidados** mostra a situação de cada convite: **Não enviado**, **Enviado** (hora e número de envios), **Falha no envio**
  (com o motivo) e **Entrou** (hora em que a pessoa começou o rastreamento). Cada linha tem **Reenviar** (até 5 envios por convite),
  **Copiar link** e **Cancelar**. O mesmo e-mail na mesma operação reaproveita o convite (não duplica). Limite de 200 convites por operação.
- **Quem envia é o servidor** (`api/convidar.js`): o navegador manda só o identificador do convite. O servidor confere o login do
  responsável, lê do banco o e-mail e o token da operação, monta o link e envia pelo provedor **Resend** (<https://resend.com>).
  Variáveis na Vercel: `RESEND_API_KEY` (chave do provedor), `EMAIL_REMETENTE` (ex.: `Rastreamento GBS <convite@seudominio.com.br>`,
  com o domínio verificado no provedor) e, opcionalmente, `SITE_URL` (endereço público do site; sem ela usa o da requisição).
  **Sem essas variáveis**, o painel avisa que o envio não está configurado e oferece **Abrir no meu e-mail** (mensagem pronta no
  seu programa de e-mail) e **Copiar link** — o convite fica cadastrado do mesmo jeito.
- O **código do convite** (`#t=…&c=…`) só preenche o nome e marca o convite como aceito; o acesso à operação continua sendo o token
  do link. O e-mail do convidado é dado pessoal: só os responsáveis da operação o leem, a página do participante nunca o recebe, e ele é
  apagado junto com a operação (exclusão ou fim da retenção). Convite, envio e aceite entram no diário.

### Rota até um participante (ir até a pessoa ou mandar apoio)

- Na ficha de um participante, **📍 Rota até ela**: escolha **de onde sai** — a **sua localização** (GPS do
  aparelho do painel), uma **base** ou a **posição atual de outro participante** — e **como vai** (a pé, trilha,
  carro). A rota por caminhos (mesmo serviço do celular) aparece no mapa até a última posição da pessoa, com a
  barra embaixo: distância, tempo, desnível, hora da posição dela (⚠ se tiver mais de 5 min: pode estar sem
  sinal), **Ver**, **Google Maps** e **Parar**.
- Enquanto ligada, a rota **acompanha**: recalcula quando a pessoa ou a origem anda mais de 60 m (no máximo a
  cada 30 s). Sem internet para calcular, mostra a **linha reta** tracejada com a distância.
- **Mandar alguém até ela**: abre o envio de destino com a posição atual da pessoa ("Apoio a …"), para outra
  pessoa ou um grupo seguirem pelo celular.

### Setores de busca (áreas)

- **Criar**: botão **Setor** no topo da tela (ou **＋ Novo setor** na lista de setores), que pergunta como:
  - **Por raio**: toque no centro do setor no mapa, informe o raio em metros (5 m a 50 km);
    o círculo aparece na hora e a área aproximada é calculada.
  - **Desenhar a área**: toque nos cantos da área (mínimo 3; há **Desfazer**) e em
    **Concluir**; o contorno é fechado e preenchido com cor semitransparente.
- Cada setor tem **nome/número/código**, **cor** (8 opções bem distintas entre si e das trilhas),
  **responsável** (um participante da operação) e/ou **equipe** (texto livre, ex.: "Equipe Alfa"),
  **situação** (**Pendente** — contorno tracejado, **Em andamento**, **Concluído** — preenchimento mais
  claro), observações, **área aproximada** (m², hectares ou km²), quem criou e quando, quem alterou e quando.
- **Editar**: tocar no setor (ou em **Lista de setores, trilhas e pontos**) abre os detalhes: botões de situação,
  **Editar** (nome, cor, responsável, equipe, observações, raio), **Ajustar limites** (arrastar os cantos;
  ◇ cria um canto novo; tocar num canto remove; no círculo, arrastar o centro e mudar o raio),
  **Excluir** (com confirmação) e **Enviar o centro como destino**.
- Os setores ficam **abaixo** das trilhas e dos marcadores (não escondem participantes nem trilhas) e
  podem ser ocultados no painel **Camadas → Setores**.
- **Área delimitada × área percorrida**: criar um setor ou alguém passar perto dele **não** o marca como
  vasculhado. Os detalhes mostram, separado, **"Percorrido (estimativa pelos rastros GPS)"**: a parte do
  setor que ficou a até 25 m de algum rastro (rastros com precisão pior que 100 m não contam). É só uma
  estimativa; o setor só fica **Concluído** quando um responsável marca.
- **Probabilidades de busca (POA, POD e POS)** — botão **POA/POD** no topo da operação (o único acesso; clicar num setor
  só mostra as informações dele, sem editar). O painel tem as abas **POA** (lista de setores com o percentual e uma
  justificativa curta, a linha fixa **Fora da área** e a **soma em destaque**: só publica quando dá exatamente 100%, em
  décimos de ponto percentual), **Buscas** e **Versões**; detalhes extras ficam em "Mais detalhes" e as explicações atrás
  de um (i). Violeta é a cor de probabilidade (fora das cores de emergência e risco). (migrações **033** e **034**; cálculo em `public/js/pod.js`, telas em `public/js/busca-cenario.js`). Segue o guia
  "POA e POD no GBS": o app organiza decisões documentadas do comando e nunca inventa percentuais.
  - **POA** = probabilidade de a pessoa estar em cada setor. É **decisão do responsável**, por vítima, num **cenário**:
    POA por setor mais **Fora da área** (a soma dos dois dá 100%; "fora" são os trechos sem setor desenhado, sem busca), justificativa geral e por setor,
    **horário de referência**, **hipóteses**, **limitações**, **sustentação dos dados** (baixa/média/alta, julgamento e não
    intervalo estatístico), **origem do POA**, **último ponto confiável** (referência a um ponto de interesse, com cópia dos
    dados) e **evidências** (pontos do mapa e anotações livres, cada uma "confirmada" ou "não confirmada"). O editor começa
    vazio; "Dividir pela área" é só uma hipótese uniforme opcional, que você ajusta e justifica.
  - **Setores do cenário não se sobrepõem**: a mesma área seria contada duas vezes. A tela avisa na hora e **o servidor
    recusa aprovar** (mais de 2% do menor setor em comum; rascunho pode). A geometria e a área de cada setor ficam
    **copiadas na versão**: editar ou excluir o setor depois não altera a versão aprovada. A tela mostra a **densidade**
    (% por km²) só como apoio ao planejamento, nunca como ordem automática.
  - **Versões**: cada versão nasce como **rascunho** (um por vítima, editável) e vira **aprovada** depois de justificada
    (mín. 10 caracteres, ao menos um setor com POA). **Versão aprovada não muda nem se apaga** (o servidor garante). Rever
    cria a próxima versão, e o histórico fica visível. A aprovação confere a **revisão esperada** (outro responsável mexeu
    no rascunho: recusa) e usa uma **chave de idempotência** (reenviar não duplica). Entra no diário.
  - **Vítima localizada**: o cenário dela fica **encerrado** (só consulta); os das demais vítimas seguem.
  - **Publicar** (migração **038**): o servidor guarda o **"Fora da área"** da versão e só aceita publicar quando **setores +
    fora = exatamente 100%** (tolerância de 0,05 ponto, o arredondamento de uma casa). Versões antigas, sem esse campo,
    seguem como estão ("fora" = o que sobra). Cada valor guarda sua **origem**: manual, **sugerido por IA e revisado por <nome>**
    ou cálculo pós-busca. Se a versão vigente mudou depois do rascunho, publicar o rascunho é recusado até você revisá-lo e
    salvá-lo de novo; a numeração das versões nunca volta atrás.
  - **POD** = probabilidade de a busca achar a pessoa, **se ela estiver na área coberta**. Vem da estimativa da equipe,
    **nunca do GPS**, e **pertence à missão de busca** (migração **039**), não ao setor. Aba **Missões** → **Nova missão**:
    setor, vítima (ou todas), **equipe**, **método**, **área atribuída** (% do setor, com descrição), **POD estimada** (opcional;
    vazio = **"POD não estimada"**, nunca zero) e em que ela se baseia (obrigatório quando há POD). Depois do retorno da equipe,
    **Registrar resultado**: **localizado / não localizado / não concluído**, a **execução real** (cobertura real, horários), o
    POD final e observações. O resultado entra uma vez só; missão concluída não se edita nem se apaga; planejada pode ser
    cancelada (com motivo, fica no histórico). Reenviar a mesma missão (mesma chave) não duplica.
  - **Cálculo pós-busca** (feito no servidor, `busca_missao_resultado`; o mesmo cálculo existe em `public/js/pod.js` e os dois são
    conferidos nos testes). Só **busca negativa** (não localizado; ou não concluído com cobertura real informada): `q = POD ×
    cobertura` no setor pesquisado e `q = 0` nos demais (inclusive "Fora da área"); `r_j = p_j × (1 − q_j)`; `Z = Σ r_k`;
    `p'_j = r_j ÷ Z`. **Cada cálculo gera uma nova versão aprovada** (origem "cálculo pós-busca"); as anteriores não mudam.
    - **POD desconhecido**: não recalcula; a missão fica **pendente de POD** até alguém informá-lo (uma vez, com a base).
    - **Z = 0 ou valores inválidos**: a missão fica **inconsistente**, com o motivo, e **nada é alterado**.
    - **Nunca soma PODs de missões diferentes**: cada missão atualiza a versão vigente, uma depois da outra.
    - **POS da missão = POA do setor × POD da missão**, mostrado como **"chance de localizar nesta busca"** (nunca como chance
      de sobrevivência); fica guardado por vítima com a versão antes e depois.
    - Localizado: não recalcula (registre o encontro em "Vítima encontrada"). A tela mostra a **prévia** do novo POA antes de confirmar.
    - Os **registros antigos** (por setor) continuam guardados e aparecem em "Registros anteriores", mas **não entram mais no
      cálculo**. O servidor ainda aceita `busca_registrar` (para telas antigas em cache), que a tela nova não usa mais.
    - O exemplo do capítulo 13 do guia (A 45%, B 25%, C 20%, externo 10%; M1 em A com POD 60%, M2 em B com POD 50%) segue como teste
      automático (`calcular`): 24,66% / 34,25% / 27,40% / 13,70% e depois 29,75% / 20,66% / 33,06% / 16,53%, cumulativo 39,5%.
  - **Sugerir com IA** (opcional, etapa de revisão humana; `api/poa-ia.js`): no editor de POA, o botão **Sugerir com IA** analisa a
    descrição da operação, a ficha da vítima, o último ponto conhecido, as observações, os relatos e as evidências marcadas, e
    preenche valor e **uma frase de justificativa** por setor (e "Fora da área") como **sugestão**: borda tracejada e rótulo
    "sugerido por IA". **A IA não publica nada**: você revisa, ajusta e publica. Sem dados suficientes ela responde
    **"informação insuficiente"** e o campo fica vazio (não inventa percentual). O que você digitou não é sobrescrito; editar um
    valor sugerido devolve-o ao modo manual. Ao salvar, cada valor guarda a origem (**manual** ou **sugerido por IA, revisado por
    <usuário>**, com o modelo) e a publicação registra isso no diário. Na **Nova missão**, o botão **Sugerir POD com IA** faz o mesmo
    com o método, a área e as observações do setor (mesma marcação, sempre revisável). Se a IA falhar (sem chave, cota, rede ou
    resposta inválida), aparece uma mensagem simples e o fluxo manual continua igual. A chave só existe no servidor (`ANTHROPIC_API_KEY` ou `GEMINI_API_KEY`). **Privacidade:** a ficha vai para um serviço externo (sem nome, CPF e telefone); em planos gratuitos, alguns provedores podem usar o conteúdo para melhorar produtos: confira a política antes de usar em operação real.
  - **Mapa**: "Ver no mapa" pinta os setores da versão vigente numa escala própria (violeta, que não se confunde com
    as cores de emergência), com legenda (vítima, versão, horário de referência e "prévia"), separada da passagem GPS.
  - **Relatório final**: seção "Probabilidades de busca" com as versões aprovadas (hipóteses, limitações, evidências, origem
    de cada valor, inclusive as calculadas) e as missões de busca (POD, resultado, execução real, POA recalculado).
  - Referências: Koopman, *Search and Screening* (1980); manual IAMSAR, vol. II; Guarda Costeira dos EUA, *The Theory of
    Search*. O modelo estima, não prova: o setor só fica **Concluído** quando um responsável marca.
  - Banco: `busca_cenarios`, `busca_cenario_setores`, `busca_cenario_evidencias` e `busca_registros` (só leitura pelos
    responsáveis da operação; escrita só pelas funções `cenario_salvar_rascunho`, `cenario_aprovar`,
    `cenario_descartar_rascunho`, `busca_registrar` e `busca_anular`). Operação encerrada: somente leitura. **Antes de usar,
    rode `033_cenario_busca_pod_poa.sql` e depois `034_poa_pod_guia.sql` no Supabase** (não rode a 033 sozinha depois da 034).
  - Ainda fora do escopo: líder de campo registrando pelo celular, catálogo de modelos de detecção validados, deriva de alvo
    móvel (aquático) e propagação automática do POA.
- O participante atribuído vê o contorno do **seu** setor no mapa do celular ("Seu setor: A-1").
- Ficam salvos no Supabase (tabela `setores`) e aparecem em tempo real para os outros responsáveis.

### Trilhas desenhadas à mão (planejadas ou percorridas)

Ferramenta separada do desenho de setores (setor = área; trilha desenhada = **linha**, um caminho). Exige a
**migração 028**; sem ela, a lista avisa e o botão não aparece (o resto do painel segue normal).

- **Desenhar à mão livre**: **Ferramentas → Desenhar trilha / trajeto** (ou **Lista de setores, trilhas e pontos → ＋
  Desenhar trilha / trajeto**) — uma ferramenta só para trilhas e trajetos. Segure e arraste o dedo (ou o mouse) sobre o mapa, como uma caneta: a linha segue o
  movimento (não liga pontos com retas; o traço é suavizado sem perder a forma). Ao soltar, continue
  arrastando a partir do **círculo branco** (fim) — ou do verde (início) — para emendar na mesma linha; um
  traço começado longe das pontas é recusado com aviso. Tocar sem arrastar não marca nada. Enquanto desenha,
  o mapa fica parado; **dois dedos** dão zoom, a roda do mouse também, e **✋ Mover mapa** libera o arrasto do
  mapa (toque em **✎ Desenhar** para voltar). A barra mostra o comprimento e tem **Desfazer traço** (desfaz o
  último traço inteiro), **Limpar** (pede confirmação), **Concluir…** e **Cancelar** (pede confirmação).
- **Concluir…** pergunta o que é o desenho: **✔ Trilha já percorrida**, **📋 Trilha planejada** ou **➝ Enviar para
  alguém percorrer** (abre o envio de destino com o trajeto; **Guardar também no mapa como trilha planejada** vem
  marcado e registra a trilha com o nome do destino e quem recebeu). **Voltar ao desenho** não perde nada.
- As duas primeiras abrem o formulário: **nome** (único na operação), **situação** (já marcada pela escolha),
  grupo, responsável pelo trajeto (participante), equipe e observações. Origem: "desenhada à mão no mapa".
- **Falha ao salvar** (sem internet, nome repetido…): o erro aparece no formulário e o desenho **não se perde**
  — fica na tela e guardado no aparelho; **Tentar de novo** reenvia. Se a página fechar, ao desenhar de novo o
  painel oferece **Retomar o desenho não salvo**. Cada desenho tem um identificador próprio: repetir o envio
  ou recarregar a página **não cria trilha duplicada**.
- **No mapa**: planejada = **tracejado amarelo**; percorrida = **linha branca contínua**; as duas com contorno
  escuro e marcas de início/fim — diferentes do **rastro de GPS** (fino, na cor da pessoa, gravado pelo
  aparelho). Ficam acima dos setores e abaixo dos rastros de GPS e dos marcadores.
- **Consultar e gerenciar**: tocar na linha (ou na lista) abre os detalhes (situação, comprimento, equipe,
  quem criou/alterou e quando) com **Ver no mapa**, **Ocultar/Mostrar**, **Informar como percorrida**,
  **Editar dados**, **Editar traçado** (a linha volta para o modo de desenho: dá para estender a partir das pontas ou
  **Limpar** e redesenhar; Cancelar devolve o traçado salvo) e **Excluir** (com confirmação; quem desenhou, quem criou a operação ou um administrador).
- **Ocultar**: uma a uma (👁 na lista; vale só neste aparelho) ou por categoria em **Camadas → Trilhas
  desenhadas · planejadas / · percorridas**. Os modos **Tudo** e **Cobertura** mostram as trilhas desenhadas.
- **Não é cobertura**: uma trilha (mesmo percorrida) **não** conclui setor nem entra em cálculo de área
  vasculhada. O diário registra quando um trajeto é informado como percorrido e quando uma trilha é excluída.
- Banco: tabela `trilhas_manuais` (leitura só pelos responsáveis da operação; gravação só pelas funções
  `salvar_trilha_manual` e `excluir_trilha_manual`, que conferem a permissão). Operação encerrada: só leitura.
  Tempo real entre os responsáveis.
- **Percursos de equipes e drones** (migração 030): cada trilha registra **quem fez o percurso** — 🚶 equipe a pé,
  🛸 drone, 🚒 viatura, 🚤 embarcação, 🚁 aeronave, 🐕 cão de busca ou outro —, uma **cor própria** opcional
  (sem ela: amarelo planejada / branco percorrida) e a **origem** (desenhada no mapa ou **importada de arquivo**,
  com o nome do arquivo). O voo de um drone ou o GPS de outra equipe entra por **Importar arquivo** → tocar na
  linha → **Registrar como trilha**: o formulário já vem com o nome, a cor e o horário do arquivo, e "drone"
  quando o nome ou o tipo indicam voo. O diário registra o meio no percurso percorrido.

### Trajeto desenhado enviado como destino

- **Ferramentas → Desenhar trilha / trajeto** → **Concluir…** → **Enviar para alguém percorrer** (ou **🧭 Enviar
  destino** na ficha → **✎ Desenhar o trajeto**, que vai direto ao envio): desenhe à mão o caminho que a equipe deve
  fazer (arrastar, emendar pelas pontas, Desfazer traço, Mover mapa). Escolha **pessoas** ou um **grupo** (com o mesmo controle de
  missão, base e prazo de retorno dos deslocamentos de grupo) e como vão percorrer (a pé, trilha, carro — só para
  estimar o tempo). Fechar a janela sem enviar volta ao desenho.
- Uma **linha importada** também pode ser enviada: tocar nela → **Enviar como trajeto**.
- No celular do participante, a **linha azul** é o caminho a seguir, com o **início em verde**, distância pelo
  trajeto, tempo estimado e **instruções geradas da forma da linha** ("Vire à direita", "Faça o retorno",
  "Chegada"). Não troca a pé/trilha/carro e **não recalcula** por caminhos: se a pessoa se afasta, o aviso pede
  para voltar ao trajeto. Funciona sem internet depois de recebido. O destino é o fim da linha.
- No painel, a ficha mostra o trajeto como a rota da pessoa; com o filtro de grupo, a linha aparece na cor do grupo.
- **Geração de rotas num lugar só** (`public/js/rotas.js`): rota por caminhos (openrouteservice) e rota desenhada
  (`Rotas.deTracado`) têm o mesmo formato; `Rotas.paraDestino` escolhe sozinho (com trajeto segue o traçado, sem
  trajeto calcula); `progresso`, `desenhar` e `resumo` servem para as duas; `simplificar` reduz linhas desenhadas
  ou importadas (até 2000 pontos) sem perder a forma. O painel, o celular e as trilhas usam essas funções.
- Banco (migração 030): `destinos.trajeto` e `missoes.trajeto`; funções `definir_destino_trajeto` (uma pessoa) e
  `enviar_trajeto_grupo` (grupo), que usam as regras de `definir_destino` e `enviar_destino_grupo`; `meu_destino`
  e `mapa_do_participante` devolvem o trajeto.

### Pontos de interesse

- **Ferramentas → Marcar ponto de interesse**: toque no local (ou **Usar minha posição**), escolha a
  categoria e dê um nome. Categorias fixas (têm regras próprias: alarme de risco, raio da base, vítima) e ícones:
  **U** Última localização conhecida · **?** Possível localização da vítima · **V** Vestígio ou objeto
  encontrado · **!** Área de risco/perigo · **E** Ponto de encontro · **+** Vítima encontrada · **•** Outro.
- **Tipos de ponto criados pelos usuários (migração 047)**: no formulário, **＋ Novo tipo** cria um tipo com **nome**, **ícone**
  (letra, número ou emoji, com sugestões prontas) e **cor** (amostras ou cor personalizada). O tipo fica disponível para todos os
  responsáveis, em qualquer operação, e aparece junto das categorias fixas. **Editar tipos** muda o ícone/cor (os pontos já marcados
  acompanham) ou **deixa de usar** o tipo (some da lista; os pontos continuam). Só quem criou ou um administrador altera. Mapa, listas,
  3D, relatório (mapa e tabela) e exportações usam o ícone, a cor e o nome do tipo.
- Cada ponto guarda título, categoria, coordenadas (editáveis no formulário), descrição, data e hora, quem
  registrou e, se veio de um relato, **quem relatou** (botão **Registrar como ponto de interesse** na janela
  do relato). Os detalhes mostram a **altitude aproximada** (modelo digital de terreno).
- **Foto**: **Anexar foto** nos detalhes do ponto (câmera ou arquivo, com o mesmo fluxo e as mesmas
  regras das fotos: armazenamento privado, local real da foto).
- Editar: qualquer responsável da operação. **Excluir** (com confirmação): quem marcou, quem criou a
  operação ou um administrador — a mesma regra vale para setores; o banco confere.
- Participantes **não** veem a lista de pontos. No celular deles aparecem **somente** os **pontos de
  encontro** e as **áreas de risco** (nunca "última localização" ou dados sobre a vítima).

### Navegação até um destino

1. O responsável escolhe o destino: **Enviar como destino** nos detalhes de um ponto, **🧭 Destino** na
   ficha do participante (ponto de interesse ou **Escolher no mapa**), **Enviar o centro como destino**
   num setor, ou **Ferramentas → Enviar destino a participantes**; marca para quem (ou **Marcar todos**).
   Escolhe também **como ir**: **A pé** (ruas, calçadas e caminhos), **Trilha** (prioriza trilhas e
   caminhos de terra — para mata) ou **Carro**.
2. No celular do participante aparece o cartão **🧭 IR ATÉ** (com vibração e aviso) e o destino no mapa.
   O celular calcula a **rota por ruas, caminhos e trilhas reais** (ver "Rota por caminhos" abaixo) e
   desenha em **azul**; a linha amarela fina em linha reta fica só como referência de direção. O
   participante pode trocar o modo (🚶 A pé · 🥾 Trilha · 🚗 Carro) no próprio cartão.
3. O cartão mostra o **nome**, a **distância que falta pela rota** (e a distância em linha reta), o
   **tempo estimado**, **subida e descida**, a **próxima instrução** ("Em 200 m: vire à direita na
   Rua X"), a lista de instruções, os avisos do terreno, as **coordenadas** e uma seta que aponta para a
   rota à frente (ou para o destino, se a pessoa estiver longe da rota). Atualiza a cada leitura do GPS.
   Se a pessoa sair da rota (mais de 50 m por 3 leituras), a rota é **recalculada** a partir de onde ela
   está (no máximo 1 vez a cada 30 s). Sem rota (serviço fora, sem internet, sem caminho mapeado), volta
   a mostrar a distância e a direção em linha reta e diz o motivo.
   - **Bússola**: no Android (Chrome) a seta gira com o celular ("siga a seta"). No iPhone aparece o botão
     **Usar a bússola do celular** (o iOS exige permissão). Sem bússola confiável, a seta aponta em
     relação ao **Norte (N)** — e o texto diz isso.
   - **Sem GPS**: mostra "Sem GPS" e não calcula nada. **GPS impreciso** (± 50 m ou pior): avisa que a
     distância e a direção são aproximadas. Ao chegar (a até 15 m ou dentro da precisão): "Você chegou".
   - Sempre avisa: **linha reta não é caminho** — conferir o terreno e seguir os bombeiros.
4. **Rota no app de mapas ↗**: continua disponível como alternativa (Google Maps, a pé ou de carro,
   conforme o modo escolhido).
5. **Encerrar navegação**: pelo participante (botão no cartão) ou pelo responsável (ficha → **Encerrar**).
   A ficha mostra o destino ativo, a **rota** da posição do participante até ele (distância, tempo,
   subida, avisos) e a desenha no mapa. Um novo destino substitui o anterior.
6. **Como o destino chega ao celular** (sem recarregar a página):
   - **na hora**, pelo Supabase Realtime: o celular assina as mudanças da tabela `destinos` filtradas pelo
     próprio participante; o RLS só entrega o destino **dele** (política `destinos_ler_participante`);
   - **recuperação**: o celular também consulta o destino (`meu_destino`) ao entrar, ao reconectar o tempo
     real, ao voltar para a página, quando a internet volta e a cada 15 s — funciona mesmo sem tempo real e
     mesmo se o mapa não carregar;
   - **confirmação**: ao mostrar o destino, o celular avisa o servidor (`confirmar_destino`). Na ficha, o
     responsável vê **"✓ recebido no celular às HH:MM"** ou **"aguardando o celular receber"**;
   - se a verificação falhar, o celular mostra um aviso em vez de ficar em silêncio. Se o servidor ainda não
     tiver a migração 004, a página usa a consulta antiga (`mapa_do_participante`) e continua recebendo.

### Meteorologia: radar, previsão e alertas

Botão **☂ Meteorologia** no mapa, logo acima da **Legenda** (liga/desliga); o painel abre logo acima do botão, com o aviso no mapa.
Nenhum dado é simulado no aplicativo: tudo vem de `/api/meteo` (servidor). Quando uma fonte falha, o painel diz qual,
e o mapa e o rastreamento continuam funcionando.

> **Estado da integração:** o código foi testado com respostas de exemplo no formato documentado das fontes. Ainda
> **não foi verificado contra as APIs reais** (o ambiente de desenvolvimento não tinha acesso a elas). Confirme a
> resposta real de cada fonte depois de publicar, em Preview, antes de usar em operação.

- **Radar de precipitação** (RainViewer): **desligado por padrão**, porque a licença do RainViewer é só pessoal e
  educacional. Liga-se com `METEO_RADAR=rainviewer` (só para testes). Não há radar gratuito com licença comercial que cubra
  o Brasil; a alternativa profissional é um provedor pago (ver a seção de licenças).
- **Vento e temperatura no mapa** (estilo dos mapas de vento): partículas animadas seguindo a direção e a velocidade
  do vento, e um campo colorido de temperatura, sobre uma região de 240 km (120 km para cada lado da operação). Não há seletor de área: afaste o mapa para ver o radar de regiões maiores.
  Vêm de uma grade de 49 pontos (7 × 7, MET Norway; 169 pontos com o Open-Meteo pago), atualizada junto com a previsão. Mostram a **previsão de modelo** (vento e temperatura
  atuais), não observação. Ligue em **Vento** e **Temperatura** dentro da camada Meteorologia.
- **Chuva na região**: a grade mostra a chuva em cada ponto. O alerta indica a distância e a direção (cardeal) do ponto
  molhado mais próximo do centro. **Se aproximando**: a cada leitura nova da grade (a cada ~15 min) o painel guarda essa
  distância; com duas ou mais leituras (≥ 10 min entre a 1ª e a última, queda de pelo menos 5 km, velocidade entre 3 e
  100 km/h) estima a velocidade de avanço e a **chegada** ("Chuva se aproximando: ~40 km O, chega em ~43 min"), e o nível
  sobe (alerta se chega em até 1 h, atenção em até 3 h, para chuva moderada ou intensa). Um "sem chuva" na grade zera a
  série. É **estimativa grosseira** pela mudança entre leituras do modelo (pontos a ~40 km), **não é radar**; o texto do
  alerta diz isso. A série fica só na memória: some ao recarregar a página e leva ~15 min para a 1ª estimativa.
- **Previsão** (MET Norway; Open-Meteo se houver chave) para o centro da operação: temperatura, vento e chuva agora, e a
  chegada prevista da chuva com **incerteza** (±30 min na 1ª hora, ±60 min depois). A fonte MET não informa rajadas nem
  probabilidade de chuva: esses campos ficam em branco e não geram alerta de rajada. É previsão de modelo, não extrapolação do radar.
- **Vento pela escala Beaufort**: o painel usa o maior vento médio previsto agora e nas próximas 3 h e o classifica em
  força 0–12 (km/h: 1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103 e 118 marcam as forças 1 a 12). O cartão de vento mostra "Bf n".
  Alerta pelo efeito na equipe: força 5 informativo; **6 atenção** (progressão difícil, drones e embarcações pequenas em
  risco); **7 e 8 alerta** (difícil caminhar contra o vento; suspender drones, embarcações e helicóptero; queda de galhos);
  **9 a 12 crítico** (queda de árvores e estruturas; considerar suspender deslocamentos). Quando o pico é daqui a algumas
  horas, o alerta traz o horário previsto. É previsão de modelo, não medição.
- **Alertas**: níveis Informativo, Atenção, Alerta e Crítico, com fonte, horário, validade e estado (novo, atualizado,
  ativo, expirado). Alertas oficiais do INMET (formato CAP) têm prioridade. Os indicativos calculados (chuva, rajada,
  tempestade e granizo a partir do código do modelo) são rotulados como tal. O som toca só para Alerta e Crítico,
  com no máximo um toque a cada 10 min por alerta, e precisa de um toque da pessoa (regra do navegador).
- **Não são usados**: raios (a política da rede Blitzortung proíbe usar os dados para sistemas de aviso) e medições
  de granizo ou frente fria. Estas fontes não medem isso.
- **Quando consulta**: assim que a operação carrega, sempre que a operação ou o local dela mudam, e a cada 5 min (só com a
  aba visível). Se uma consulta falha, tenta de novo em 30 s, sem esperar o ciclo. "Defina o local da operação" só aparece
  quando a operação realmente não tem coordenada.
- **Legendas**: cada camada tem a sua, com título e unidade (Radar · intensidade da chuva; Vento · velocidade em km/h;
  Temperatura em °C). A lista de **fontes** mostra, para cada uma, o horário do dado e a idade (ex.: "Previsão · MET
  Norway: dado de 19:53 (há 4 min)"); se uma fonte falhar, mostra o último dado bom e quando foi obtido.
- **Chuva prevista**: a previsão é por hora. Se a hora com chuva já começou, o painel diz "chuva prevista desde 19:00
  (período já iniciado)"; só uma hora futura aparece como "chegada prevista por volta de…". Os avisos de incerteza foram mantidos.
- **Monitoramento**: Ocultar o aviso
  não para o monitoramento. O endpoint exige o login de um responsável e tem cache de 5 a 15 min por fonte.

**Licenças (confirme antes do uso operacional):** a previsão padrão vem do **MET Norway** (Meteorologisk institutt): sem chave,
cobre o Brasil e exige atribuição ("MET Norway") e identificação do aplicativo (`METEO_USER_AGENT`). O Open-Meteo gratuito é
apenas não comercial; com `OPEN_METEO_API_KEY` ele passa a usar o plano comercial. O RainViewer, quando ligado, é só pessoal
e educacional. Confira os termos do MET Norway antes da operação real. O endpoint inclui esses avisos na resposta.

**Variáveis de ambiente (Vercel → Settings → Environment Variables, em Production e Preview):**

| Nome | Obrigatória? | Para quê |
|---|---|---|
| `METEO_ALERTAS_URL` | não | URL do feed de alertas do INMET no formato CAP (JSON). Sem ela, o painel mostra "alertas oficiais não configurados". O endereço ainda não foi verificado: confirme no catálogo WIS2 do INMET antes de definir |
| `OPEN_METEO_API_KEY` | não | chave do plano comercial do Open-Meteo. Se definida, a previsão passa a vir dele (no lugar do MET Norway) |
| `METEO_USER_AGENT` | não | identificação do aplicativo enviada ao MET Norway (nome e contato). Há um valor padrão |
| `METEO_RADAR` | não | `rainviewer` liga o radar (uso pessoal e educacional apenas). Sem a variável, o radar fica desligado |

O MET Norway não exige chave. Nada disso aparece no navegador: as chaves ficam só no servidor.
A política de conteúdo (`vercel.json`) libera as imagens do radar em `*.rainviewer.com`.

### Rota por caminhos (serviço de roteamento)

- **Serviço escolhido: openrouteservice** (HeiGIT/Universidade de Heidelberg), sobre dados do
  OpenStreetMap: tem perfis **a pé** (`foot-walking`), **trilha** (`foot-hiking`, que usa trilhas e
  caminhos de terra) e **carro** (`driving-car`), instruções em português, **altitude** em cada ponto da
  rota (subida/descida) e informações de **inclinação**, **tipo de via** e **dificuldade de trilha**
  (escala SAC). Tem conta gratuita com cota diária e pode ser **instalado no próprio servidor** do órgão
  (variável `ORS_URL`), o que elimina a dependência de um serviço público para operação crítica.
- **Como foi integrado**: o navegador chama `/api/rota` (função da Vercel). A função confere o login
  (participante ativo — só para si mesmo — ou responsável ativo), limita a 20 cálculos por minuto por
  pessoa e só então chama o openrouteservice com a chave **ORS_API_KEY, que fica só no servidor**.
  Nenhuma coordenada da rota é gravada. Não foi preciso mudar a CSP (a chamada é para o próprio site).
- **Relevo e terreno**: a rota evita **vaus** (travessia de rio sem ponte) e **balsas**; se não houver
  outro caminho, aceita e **avisa**. Os trechos com **inclinação de 10% ou mais** aparecem em laranja/
  vermelho no mapa e no resumo, com a porcentagem do trajeto. O perfil Trilha informa a **dificuldade da
  trilha** quando mapeada. A distância até o caminho mapeado mais próximo (no começo e no fim) aparece
  como trecho cinza tracejado, com aviso de que **não há caminho conhecido** ali.
- **Limites (sempre mostrados na tela)**: a rota segue só o que está mapeado no OpenStreetMap; **não é
  uma análise de segurança** — não conhece mata fechada, rio cheio, área alagada, deslizamento, cerca ou
  trilha não mapeada; a altitude vem de modelo de terreno (resolução de dezenas de metros); em áreas
  pouco mapeadas a rota pode dar voltas grandes ou não existir. Na mata sem trilhas, vale a direção em
  linha reta e a orientação dos bombeiros.
- **Sem a chave configurada**, o celular mostra "Rota por caminhos indisponível: o serviço de rotas não
  está configurado" e continua com a navegação em linha reta.

### Remover e reincluir participante

- **Remover** (ficha → aba Dados → Remover) **não apaga nada**: o cadastro, a trilha, as mensagens e as
  fotos continuam. O participante sai da lista principal e vai para **Fora da operação** (no fim da lista),
  com "Removido às HH:MM por Fulano". O destino ativo dele é encerrado. O celular para o GPS e mostra
  "Participação encerrada".
- **Reincluir**: botão **Reincluir** no item da lista "Fora da operação" ou na ficha (bloco no topo). Só um
  responsável da operação, com a operação ativa. Vale também para quem teve a **saída liberada**. O
  **mesmo registro** volta a ficar ativo (nada é duplicado) e fica registrado quem reincluiu e quando
  (tabela `participacao_eventos`).
- O celular que ficou na tela "Participação encerrada" verifica a cada 20 s e, ao ser reincluído, mostra
  **"Os bombeiros chamaram você de volta" → VOLTAR PARA A BUSCA**: com um toque volta a enviar a
  localização, receber mensagens e destinos. Se a pessoa fechou a página, basta abrir o **mesmo link no
  mesmo celular** (a identidade anônima do aparelho é a mesma). Até o celular voltar, o painel mostra
  **"Reincluído · aguardando o celular voltar"**.
- Sem reinclusão, quem foi removido não consegue voltar sozinho pelo link.

### Localização do responsável (sempre ligada)

- Ao abrir ou criar uma operação ativa, **Minha posição liga automaticamente** — usando a permissão de
  localização do navegador (se ela ainda não foi dada, o navegador pergunta).
- O **estado** da localização não tem item no menu. Só aparece um aviso quando há problema real: *bloqueada no navegador* (o aviso traz **Como liberar**) ou *sem GPS neste aparelho*. O estado real continua o mesmo: *ligando…*, **ligada** (só depois de a
  permissão ser concedida **e** chegar coordenada), *ligada · procurando sinal*, *bloqueada no navegador*
  (tocar mostra como liberar) ou *sem envio · toque para tentar* (falha de conexão).
- **Não existe desligar**: o item não é uma chave. Tocar nele com a posição ligada só confirma o estado;
  com o envio parado (bloqueio ou falha), o aviso do menu oferece **Tentar de novo**. Escolhas
  "desligada" guardadas por versões antigas do painel são ignoradas. Nunca há dois observadores de GPS nem
  envios duplicados.
- Se o mesmo responsável está com o painel aberto em **dois aparelhos** e um deles já compartilha, o
  outro mostra *enviada por outro aparelho seu* e não liga sozinho (a trilha não "pula" entre os dois);
  o aviso do menu **Ferramentas** oferece **Usar este aparelho**, que passa o envio para este aparelho.
- Limite: funciona com o painel **aberto e a tela ligada**. Em segundo plano ou com a tela bloqueada o
  navegador pode pausar o GPS (seção 8).

### Permissão de localização no celular do participante

- A página consulta o estado da permissão (Permissions API, quando o navegador tem):
  **concedida** → segue direto; **ainda não perguntada** → explica e pede pelo aviso oficial do navegador ao
  tocar em COMEÇAR; **negada** → mostra "A localização está bloqueada para este site" com os **passos para o
  navegador e o aparelho em uso** (Chrome, Samsung Internet, Firefox no Android; Safari e Chrome no iPhone;
  computador) e o botão **VERIFICAR DE NOVO**.
- Não existe forma padronizada de um site abrir as configurações do celular, por isso **não há botão
  "Abrir configurações"** — só os passos. Quando a pessoa libera, a página percebe sozinha (ou ao tocar em
  VERIFICAR DE NOVO) e continua **sem pedir o cadastro de novo**. No iPhone pode ser preciso recarregar
  a página (a participação retoma sozinha).
- São mostrados separadamente: **permissão do navegador bloqueada**, **localização do celular desligada**
  e **sem sinal de GPS** — cada um com o botão **Como resolver**. Nesses casos a tela diz claramente
  "Os bombeiros NÃO estão vendo onde você está"; "estão vendo" só aparece depois de uma posição enviada.
- Ao recarregar a página (ou reabrir o link) com a permissão já concedida, a participação **retoma
  sozinha**, com o mesmo cadastro e o destino ativo.

### Trilhas GPS: captura, envio e desenho

O mesmo código (`public/js/gps.js`) é usado no celular do participante (civil ou militar) e na "Minha
posição" do responsável. **Nenhuma posição é inventada nem suavizada**: cada ponto gravado é uma leitura
real do aparelho; o filtro só decide quais leituras entram na trilha.

**Revisão desta versão (por que a trilha "demorava" e "quase não pegava")**: a versão anterior a esta
correção (v2) tinha três problemas, verificados no código e nos testes:
1. **Parado/andando muito rígido**: exigia afastamento de até 1,5 × a precisão (até 40 m) para registrar
   movimento — com precisão de 20–30 m (comum em mata e cidade), a pessoa andava dezenas de metros sem
   novo ponto;
2. **Envio em lote a cada 10 s**: mesmo com ponto novo, ele só saía do celular até 10 s depois;
3. **Carro bloqueado**: qualquer velocidade acima de 43 km/h era tratada como "salto impossível"; de
   carro, praticamente nenhum ponto entrava.
A primeira versão (v1) aceitava todo ponto a cada 5 m/5 s, o que respondia rápido mas desenhava
zigue-zague com a pessoa parada. A versão atual junta as duas coisas:

| Etapa | Como funciona agora (valores em `GPS.PADRAO`) |
|---|---|
| Captura | `watchPosition` com alta precisão, `maximumAge: 0`, `timeout: 30 s`, usando os **eventos reais do GPS** (não um temporizador). Um único observador; parado, pede leitura nova a cada 45 s; sem leituras por 90 s com a tela aberta, reinicia o observador |
| A pé | ponto quando o afastamento sai do círculo de precisão, ou com a velocidade medida pelo GPS (≥ 0,7 m/s), ou quando o afastamento se mantém por 3 leituras **na mesma direção**; no máximo 1 ponto a cada 2 s. Na prática: ~1 ponto a cada 3 s andando (com velocidade do GPS) ou a cada ~5 s (sem ela) |
| Veículo | acima de 18 km/h (velocidade do GPS, ou deslocamento rápido e em linha): **até 1 ponto por segundo**, a cada 8 m |
| Parado | oscilação menor que 0,6 × a precisão (de 3 a 25 m) não vira trilha; com o GPS informando velocidade 0, só um afastamento claro conta; confirma a posição a cada **15 s** (o **intervalo máximo sem ponto**, configurável por operação em Dados da operação: 5 a 300 s) |
| Guardado no aparelho | todo ponto aceito é gravado **primeiro no IndexedDB** (durabilidade `strict`; se falhar, no localStorage como reserva) com id único (UUID do aparelho), latitude, longitude, precisão, hora do GPS, usuário, operação e o estado (pendente, enviado ou recusado); vale também para a "Minha posição" do responsável. **Só é "salvo" quando o aparelho confirma a gravação**: sem confirmação (sem espaço, banco indisponível, só memória) o ponto fica marcado como **não gravado**, é regravado a cada tentativa e o usuário é avisado para não fechar a página. O app pede ao navegador **armazenamento persistente** e monitora o espaço. **Não há limite de pendentes nem descarte dos mais antigos.** A fila antiga (localStorage e a versão 1 do banco) é migrada sozinha |
| Saltos | só é "salto" o que for incoerente com o movimento recente (> 12 m/s sem histórico, ou > 2,5 × a velocidade recente; nunca acima de 252 km/h). Um pico isolado é descartado; se a leitura seguinte confirmar o novo local (ex.: entrou num carro), **as duas entram** — nada de pontos intermediários perdidos |
| Precisão | até 150 m entra na trilha (com as regras acima); pior que 150 m vira "posição aproximada" (no máximo 1 a cada 30 s), fora da linha da trilha |
| Leituras ruins | antiga (> 30 s), repetida, fora de ordem ou inválida (0,0, NaN): descartada. Relógio do GPS diferente do celular: corrigido. Relógio do celular errado: o horário dos pontos é convertido para o do servidor antes do envio (o servidor recusaria pontos "do futuro") |
| Envio | separado da captura: envio em lote **~1,5 s** após o ponto a pé e **~1 s** em veículo (o 1º na hora); sem internet, tenta de novo com espera crescente e envia tudo na ordem quando volta. `enviar_posicoes_lote` devolve **quais ids o servidor gravou**: só esses são marcados como enviados (o resto continua pendente); os recusados (horário fora da operação) ficam marcados com o motivo e aparecem no diagnóstico. O id único torna o reenvio idempotente (não duplica) |
| Painel | recebe cada ponto pelo tempo real (com conferência periódica de reserva), insere na **ordem do horário do GPS** (empate: pelo id) e redesenha no quadro seguinte da tela. **Todos os pontos viram vértices** (nada é escondido). Quando dois pontos seguidos estão separados por mais que o **limite de falha** da operação (padrão **60 s**, configurável), ou há salto impossível, o trecho é desenhado **tracejado em cinza**, com **○ início** e **● fim** da falha marcados ("Falha: sem posições registradas de 10:02 a 10:21 — o percurso real é desconhecido"). Pontos de pessoas diferentes nunca se ligam |
| Medição | o histórico da ficha mostra, para cada ponto, **quanto tempo levou da captura até chegar ao servidor** (coluna "Chegou") |

- **Fila offline: garantias e transparência** (`public/js/trilha-local.js`, `public/js/fila-estado.js`):
  - **Regra de ouro**: nenhum ponto é dado como *salvo* sem confirmação de gravação no aparelho, nem como *sincronizado*
    sem confirmação do servidor (`enviar_posicoes_lote` devolve os ids que existem no servidor; só esses saem da fila de
    pendentes). Resposta sem a lista de confirmados, ponto não citado e erro do servidor deixam o ponto **pendente**.
    Reenviar é seguro: o servidor ignora o id repetido e o confirma de novo.
  - **Servidor antigo** (sem a migração 009): os pontos são entregues por `enviar_posicoes`, mas **continuam pendentes**
    ("entregues sem confirmação") e só saem da fila quando o servidor atualizado os confirmar; o aviso fica visível.
  - **Nada é descartado em silêncio**: sem limite de 5.000; pontos recusados pelo servidor ficam guardados com o motivo
    (e contam como perda no resumo); só enviados e confirmados são apagados do aparelho, 48 h depois.
  - **O que a tela mostra** (bloco "Detalhes do envio" na página do participante e no menu Ferramentas do responsável):
    quantidade de pontos **pendentes** e a **idade do mais antigo**, **estado da gravação local** (segura, reserva,
    só memória, falha), **última sincronização confirmada**, recusados, intervalos sem registro, se o armazenamento é
    persistente e quanto do espaço está usado. Se há ponto fora do armazenamento, aparece um alerta fixo e o navegador
    pergunta antes de fechar a página.
  - **Registro de falhas** (guardado no aparelho, só a mudança de estado, sem repetir a cada tentativa): GPS que parou e
    voltou, falha ao gravar (com o motivo: sem espaço ou outro), armazenamento reserva em uso, falha e retorno do envio,
    pontos recusados, pontos sem confirmação e **intervalos sem ponto** (início, fim e duração). A trilha não liga os
    dois lados de um intervalo: o painel a mostra **interrompida/tracejada** (limite de falha da operação).
  - **Desempenho**: só os pendentes ficam na memória (os enviados só são contados); lotes de 200, ou de 500 quando há
    mais de 1.000 acumulados (limite do servidor); tentativas não são gravadas a cada ponto. Medido no navegador com
    IndexedDB real: 50.000 pontos gravados em ~7 s, enviados e confirmados em ~8 s (103 lotes), reabrir leva ~1,7 s.
  - Testes: `node testes/trilha_local.test.js` (sem internet, recarregar, sem espaço, servidor com erro e antigo, 60.000
    pontos) e `node testes/fila_estado.test.js` (resumo na interface). Os testes com IndexedDB real (reabrir a página,
    migrar o banco antigo, cota, durabilidade) rodam no navegador, fora do repositório.
- **Diagnóstico**: **Ferramentas → Diagnóstico do GPS** (responsável) e, no participante, abrindo o link com
  `&diag=1` no fim. Mostra cada leitura: hora, aceita/descartada e o **motivo**, precisão, distância,
  idade e coordenadas arredondadas. Fica **só no aparelho**.
- Trilha civil continua **roxa #A020F0 com contorno claro**.
- Teste do filtro: `npm test` (ou `node testes/filtro_gps.test.js`) — parado, andando, devagar, mata, carro,
  arrancada, picos, precisão ruim, leituras antigas, relógio, lacunas.

### Mapa topográfico e relevo em 3D

- **Camadas → Tipo de mapa → Topográfico** (curvas de nível): OpenTopoMap, com curvas de nível, cotas de altitude
  e sombreamento do relevo. Trilhas, marcadores, setores, pontos, fotos e relatos continuam por cima, e o
  zoom vai até 19 (acima de 17 o servidor não tem ladrilhos e eles são ampliados).
- **Camadas → Visualização → Relevo 3D**: abre uma tela com **relevo 3D real**, calculado a partir de um **modelo
  digital de terreno** (Terrain Tiles da AWS — SRTM e outras fontes; resolução de cerca de 30 m no
  Brasil), com **exagero vertical de 1,5×** (informado na tela). Inclina e gira com dois dedos (ou botão
  direito do mouse); tocar no terreno mostra a **altitude aproximada**. Mostra setores, trilhas,
  participantes e pontos **do momento em que foi aberto** (botão **Atualizar posições**). É carregado só
  quando aberto (biblioteca MapLibre GL, ~800 KB) e precisa de WebGL: sem suporte, o botão **Relevo 3D**
  fica desativado com o aviso "indisponível neste aparelho"; se a biblioteca não carregar (sem internet),
  a tela do 3D explica e o mapa normal continua funcionando. **Plano 2D** fica marcado enquanto o 3D está
  fechado. O mapa principal (Leaflet) não foi trocado.

### Organização do painel

- **Identidade visual** do painel do responsável (`public/css/militar.css`, só na página militar):
  tipografia **IBM Plex** (Sans, Sans Condensed e Mono, arquivos locais em `public/vendor/fontes`, licença
  OFL — sem CDN de fontes), cantos retos, sombras discretas, vermelho só para o crítico e âmbar para o que
  está selecionado/ligado. A página do participante não muda.
- A barra superior tem só **Mensagens** e **Ferramentas** (☰).
- **Brasão** do Corpo de Bombeiros Militar do Paraná no cabeçalho do painel (login, operações e responsáveis), no lugar da antiga marca "GBS" (`public/img/brasao-cbmpr.png`). A página do participante não muda.
- **Filtros nas listas** (muito dado, então dá para reduzir a tela): em **operações**, busca por nome, local ou descrição (sem acento), situação (ativas ou encerradas), criador (**criadas por mim** ou **por outros**; só aparece para administrador, que enxerga todas) e período do acionamento, com **Limpar**; em **responsáveis**, busca por nome ou e-mail, situação (com acesso ou desativados), papel (administradores ou responsáveis comuns) e **Limpar**. O contador mostra quantos itens aparecem.
- **Painel Camadas** (botão sobre o mapa, canto superior direito, ao lado da lista): separa
  **Tipo de mapa** (Mapa · Topográfico · Satélite), **Visualização** (Plano 2D · Relevo 3D) e **Camadas
  operacionais** (Trilhas, Setores, Pontos de interesse, Relatos, Fotos, Local da operação, Nomes no mapa),
  cada uma com sinal próprio e chave liga/desliga. O botão mostra o resumo (ex.: "Satélite · 2 ocultas").
  Escolher uma opção **não fecha** o painel. No celular e no tablet ele abre como folha compacta (camadas
  em duas colunas) e fecha ao tocar no mapa, em ✕ ou com Esc; no computador fica aberto enquanto se usa o
  mapa. As preferências continuam gravadas no aparelho, como antes.
- **Mapa adaptativo** (operações grandes sem poluição; `public/js/mapa-rotulos.js`):
  - **Detalhe pelo zoom**: de longe (zoom ≤ 14) só os símbolos; aparecem os nomes apenas de quem pede atenção
    (ajuda, pedido de saída, selecionado, você) e da vítima encontrada. No zoom 15–16 os nomes aparecem curtos, sem o
    "há X min" e sem a situação do setor. De perto (17+) aparece tudo. A fonte dos rótulos é menor e acompanha o zoom.
  - **Sem nome sobre nome**: os rótulos são colocados do mais importante para o menos (quem pede atenção, pontos
    críticos como vítima, risco, base e última localização, pessoas, demais pontos, setores). Se o lado direito estiver
    ocupado, o nome tenta a esquerda, em cima ou embaixo; sem espaço, some até aproximar. Passar o mouse (ou focar) no
    marcador mostra o nome escondido. O nome do setor fica abaixo das pessoas e dos pontos, sem cobri-los.
  - **Pessoas próximas agrupadas** (até o zoom 18, ou seja, já na escala de **200 m** e de **100 m**; só de muito perto, 25 m ou
    menos, ficam soltas): um círculo com o número de pessoas e um anel com as cores dos
    grupos; passar o mouse lista os nomes e tocar aproxima. Quem pede ajuda, pediu saída, está selecionado ou é você
    nunca entra no agrupamento. Fica **sempre ligado** (não há opção para desligar).
- **Topo do painel**: as ações mais usadas ficam à vista — **Marcar ponto**, **Foto**, **Setor** (pergunta: desenhar a
  área ou por raio), **Trilha** (desenhar trilha/trajeto) e **Dashboard**. No notebook aparecem só os ícones (o nome
  vem ao passar o mouse); no celular e no tablet em pé, numa faixa logo abaixo do título, dividindo a largura.
- O menu **Ferramentas** é **uma lista só, sem subgrupos**: Vítima encontrada, Enviar destino, Setores, trilhas e
  pontos, Grupos, Deslocamentos de grupos, Dados da operação, Diário, Relatório final (PDF), Equipe de responsáveis,
  Ir para coordenada, Medir distância e área, Importar arquivo, Exportar, Diagnóstico do GPS, Formato das
  coordenadas e **Tema**;
  - **Ações definitivas** — sempre **no fim**, separado por uma linha vermelha:
    **Encerrar operação** (pede confirmação) e, com espaço entre os dois, **Excluir operação** (só para
    quem pode; confirmação reforçada: lista o que será apagado e exige **digitar o nome da operação**).
  - O menu fecha só por ação intencional: ao escolher uma **ação** (abre janela, inicia desenho…), em
    **Fechar**, com Esc ou tocando fora. Abrir/fechar um grupo e o seletor de
    coordenadas **não** fecham o menu.
  - "Legenda" e "Lista de participantes" saíram do menu: a **legenda** fica sempre no mapa e abre/fecha
    tocando nela; a **lista** tem os botões **» Ocultar** e **« Participantes**.
- **Trilhas**: militares em azul (contínua), responsáveis da operação em vermelho (pontilhada) e **civis em roxo**
  (tracejada, com contorno claro por baixo para aparecer sobre mata, satélite e topográfico). Cada civil
  tem um tom de roxo/magenta diferente, e a trilha de quem está com a ficha aberta fica mais grossa. O
  marcador do civil continua sendo o círculo verde **C**.
  Fecha ao escolher uma opção, ao tocar fora, no **Fechar** ou com **Esc**. No celular, abre como uma
  folha na parte de baixo da tela. As preferências do mapa ficam lembradas no aparelho.
- Ficam sempre no mapa: **zoom (+/−)**, **⤢ enquadrar todos** e a escala.
- **Ocultar a lista de participantes**: botão **» Ocultar** no topo da lista. O mapa ocupa toda a área
  (transição suave) e aparece o botão discreto **« Participantes N** para reabrir — com um ponto amarelo
  piscando se houver pedido de ajuda, pedido de saída ou mensagem nova. O rastreamento, o tempo real
  e as fichas continuam funcionando normalmente; a escolha fica lembrada no aparelho.
- **Celular e tablet em pé**: o mapa ocupa a tela toda e a lista de participantes vira uma **gaveta** que
  sobe por cima, com três alturas — **recolhida** (só o cabeçalho e o resumo), **meio** e **tela cheia**.
  Tocar na alça (traço no topo da lista) alterna; arrastar ajusta e encaixa na altura mais próxima (um gesto
  rápido vai para a próxima). Pelo teclado: seta para cima/baixo. A legenda e a escala sobem junto com a
  gaveta. Ao desenhar um setor ou marcar um ponto, a gaveta recolhe sozinha. A altura escolhida fica
  lembrada. O botão de trilhas fica no painel **Camadas → Trilhas**, sobre o mapa.
- **Painel enxuto** (operações grandes sem tela poluída):
  - **Lista em uma linha por pessoa**: símbolo (forma, letra e cor do grupo já dizem tipo e grupo), ★ para responsável
    do grupo, nome, avisos só quando existem (**SOS** pedido de ajuda, **Saída**, **✉** mensagem nova), a bolinha da
    conexão, **GPS** riscado quando o GPS está sem sinal e a idade da última posição ("26 min"). Os selos
    CIVIL/MILITAR e de grupo, o texto "Sem atualização há…", o horário da posição e os botões ◎/Trilha saíram da
    lista: o detalhe aparece ao passar o mouse e, completo, na **ficha** (tocar na linha), que agora também mostra
    o grupo. A lista ficou mais estreita (320 px no computador, 290 px no tablet).
  - **Resumo clicável**: as bolinhas com o número de conectados, instáveis e sem atualização filtram a lista (tocar
    de novo mostra todos); ao lado, o total de militares (M) e civis (C). O botão "Ocultar trilhas" saiu da lista
    (fica em **Camadas → Trilhas**).
  - **Letras e botões menores** no painel do responsável (a página do participante continua com botões grandes);
    em telas de toque os botões mantêm pelo menos 36–40 px.
  - **Cabeçalho mais baixo**: "Tempo real ativo" virou **Ao vivo** (no tablet, só a bolinha; o texto completo
    aparece ao passar o mouse).
  - **Faixa de alerta crítico em uma linha**: título e começo do texto; tocar no texto (▾) mostra o alerta inteiro,
    com horário e quantos outros alertas críticos há. **Ver no mapa** e **Ciente** continuam à direita.
  - **Mensagem de outro responsável** (CONFIRME, ATENÇÃO…): cartão pequeno no canto do mapa (também no celular,
    sem ocupar a tela toda), com as respostas em botões normais e **×** (ou Esc) para **responder depois**. A
    mensagem continua pendente: aparece no topo o botão **✉ N para você**, que reabre o cartão; uma mensagem nova
    também reabre. Os avisos rápidos do rodapé ficaram menores (com o × de sempre).
  - **Pontos, relatos e fotos agrupados juntos**: tudo que é ponto no mapa (pontos de interesse, relatos e fotos) entra
    no mesmo agrupamento quando está perto. O grupo é um **quadrado arredondado** (as pessoas agrupadas são
    círculos) com o número e um anel com a cor de cada tipo (azul-claro pontos de interesse, laranja relatos, roxo
    fotos); um **!** vermelho avisa que há área de risco ou pedido de ajuda dentro. Passar o mouse diz quantos de
    cada; tocar aproxima; vários no mesmo lugar abrem em leque. O agrupamento já funciona na escala de 200 m e de 100 m (raio de
    40 a 50 px) e só diminui de muito perto (zoom 19+).
    **Vítima encontrada** (ponto ou relato) nunca entra no grupo, e os círculos das áreas de risco e da base
    continuam sempre visíveis. **Ver no mapa** de um ponto agrupado aproxima até ele aparecer e pisca. As camadas
    e os modos (Pontos, Relatos, Fotos) continuam ligando e desligando cada tipo. A legenda mostra os dois
    agrupamentos.
  - **Trilhas finas de longe**: a espessura (e o tracejado dos civis, o contorno claro e as marcas de falha)
    acompanha o zoom — de perto como antes (4 px; 6 px a da pessoa selecionada) e, afastando, afina até 1,5 px,
    para não cobrir o mapa.
  - **Camadas → Mostrar no mapa**: **um botão por camada** (aceso = aparece; apagado = riscado), agrupados em
    **Equipes** (Pessoas, Trilhas de GPS, Nomes), **Planejamento da busca** (Setores, Trilhas
    planejadas, Trilhas percorridas, Pontos de interesse, Local da operação) e **Registros do campo** (Relatos,
    Fotos), mais **Mostrar tudo**. Acima ficam **Tipo de mapa** e **Visualização (2D/3D)**. O botão **Camadas** mostra
    "personalizado" enquanto algo estiver escondido. A escolha fica lembrada no aparelho; esconder **Pessoas** não
    para o rastreamento.
- **Personalizar tela** (Ferramentas → ✎ Personalizar tela; vale só no aparelho, não muda nada para os outros):
  - **arrastar** um botão do topo muda a ordem; arrastar para fora do topo (ou tocar no ×) manda para **Ferramentas**;
  - **Mensagens** e **Convidar** também podem sair do topo (vão para Ferramentas) e voltar, como os outros botões;
  - **qualquer função das Ferramentas** (Grupos, Diário, Enviar destino, Vítima encontrada, Exportar…) pode ir para o
    topo: arraste da bandeja **Em Ferramentas** até o lugar desejado, ou toque nela para pôr no fim;
  - o painel **Grupos** do mapa pode ser arrastado para qualquer canto (ou escolhido no quadradinho);
  - **tamanho do texto** (Menor, Normal, Maior, Grande) muda o painel todo na hora;
  - **Padrão** volta tudo como era; **Concluir** (ou Esc) sai do modo. No teclado: ← → mudam a ordem do botão em foco e
    Delete tira do topo. No modo de edição os botões não executam a ação, só se movem.
- **Modais e formulários** (padrão único, `UI.abrirModal` em `js/interface.js`): cabeçalho fixo com o título, o **i**
  (explicação, em vez de parágrafos de texto) e o **×**; corpo que rola; rodapé com as ações sempre à vista. Campos
  agrupados em cartões (`UI.secao`), lado a lado no computador; no celular o modal vira uma folha que sobe de baixo
  e ocupa quase a tela toda. Campos opcionais trazem "opcional" no rótulo.
- **Celular deitado**: mapa e lista lado a lado; a faixa de alerta crítico ocupa uma linha só.
- No celular a **faixa de alerta crítico** é compacta (texto à esquerda, **Ver no mapa** e **Ciente** à
  direita) e as abas que não cabem quebram linha em vez de sair da tela.

### Ferramentas de mapa (inspiradas no AlpineQuest)

Recursos de aplicativos de navegação em campo, adaptados à operação. Ficam no menu **Ferramentas →
Ferramentas de mapa**, no **toque longo** (ou botão direito) sobre o mapa e na ficha do participante.

- **Régua circular**: botão **◎ Régua** no topo (ou Ferramentas → Régua circular). Uma régua graduada no centro da
  tela: eixos com marcas e **vários números** (distância até o centro, em m ou km); o **raio** aparece na ponta de
  cada lado e a legenda mostra o diâmetro (2 × raio). Acompanha o zoom e não grava nada.
- **Formato das coordenadas**: decimal, graus-minutos-segundos (GMS), graus e minutos decimais, **UTM**
  (WGS 84) ou **MGRS**. A escolha vale para a ficha, os popups e o medidor e fica lembrada no aparelho.
  Para passar por rádio, use UTM ou MGRS (mesmo sistema das cartas militares e da maioria dos GPS).
- **Toque longo no mapa** (ou botão direito): coordenadas do ponto **em todos os formatos** (com botão
  copiar), **altitude aproximada** (modelo de terreno), **distância e rumo** a partir da sua posição e
  atalhos: **Marcar ponto aqui**, **Enviar como destino**, **Medir daqui** e **Anéis aqui**, e a seção
  **Setor de busca**: **Setor por raio aqui** (o ponto vira o centro; abre o formulário com o raio e a
  prévia do círculo) e **Desenhar setor daqui** (o ponto vira o 1º canto; continue tocando nos outros e
  em **Concluir**). Só aparece enquanto a operação ainda tem os dados. No celular a lista recolhe e os
  controles do mapa somem enquanto a janela está aberta, para ela caber inteira.
- **Ir para coordenada**: digite em qualquer formato (ex.: `23K 708263 7515869`, `23K QR 08262 15869`,
  `22°27'02,9"S 42°58'34,3"O`, `-22.4508, -42.9762` — o mesmo ponto). Mostra a prévia nos outros formatos antes de ir e marca o
  alvo no mapa. Texto inválido não é aceito.
- **Medir distância e área**: toque nos pontos; mostra cada trecho com **distância e rumo** (graus e
  direção), o total, e — ao fechar o polígono — **área (ha / km²) e perímetro**. O polígono medido pode
  virar **setor de busca** com um toque. Botões Desfazer e Sair.
- **Exportar**: escolhe-se item a item (cada trilha, cada ponto de interesse, cada setor, com "Marcar todos") e o formato. Sai em **GPX**
  (Garmin, AlpineQuest, OsmAnd, Locus), **KML** (Google Earth), **GeoJSON** (QGIS/ArcGIS) ou **CSV**
  (planilha, separador `;`). As trilhas saem com horário e precisão de cada ponto e as **lacunas** do sinal
  ficam como segmentos separados. Bom para relatórios e para levar a busca para outro aplicativo.
- **Importar**: **GPX, KML, KMZ, GeoJSON ou CSV** (até 8 MB) — por exemplo, trilhas conhecidas da região,
  limites de parque ou pontos levantados por outra equipe. O conteúdo aparece como **camada de referência**
  apenas **neste aparelho** e fica lembrado nele, **com as propriedades do arquivo**: KML/KMZ (cor, espessura e
  opacidade do estilo, inclusive `StyleMap`, descrição e horários de `gx:Track`), GeoJSON ("simplestyle":
  `stroke`, `stroke-width`, `stroke-opacity`, `fill`, `description`, `coordTimes`), GPX (descrição, tipo, horários
  e cor das extensões Garmin `DisplayColor` ou OsmAnd `color`); sem cor no arquivo, verde-limão.
  **✎ Editar** (na lista de camadas ou tocando no item) muda o nome e a cor padrão da camada e, item a item,
  **nome, cor, espessura, opacidade, descrição** e se aparece no mapa (os horários e o tipo do arquivo ficam à
  vista). Cada item pode virar **ponto de interesse**, **setor de busca**, **trilha da operação** (equipe, drone…)
  ou **trajeto enviado** (aí sim, visível a todos); "Transformar pontos" converte até 100 de uma vez. Nada é
  enviado ao servidor sem essa escolha.
- **Estatísticas da trilha** (ficha → Estatísticas): distância, período, **tempo em movimento**, velocidade
  média e máxima (sem contar picos isolados), **subida e descida acumuladas**, altitude mínima/máxima e o
  **perfil de altitude** — passar o dedo/mouse no gráfico mostra a distância, a altitude e o ponto no mapa.
  A altitude vem do GPS quando disponível; senão, do modelo de terreno (indicado na tela).
- **Alarmes de proximidade**: o painel toca o alarme e mostra um aviso quando um participante **sai do
  setor atribuído** a ele ou **entra numa área de risco** (ponto de interesse "Risco"). Cada área de risco
  tem um **raio de alarme** (padrão 100 m; ajustável de 10 m a 5 km no formulário do ponto), desenhado como
  círculo no painel e no celular. O **participante** também recebe o alerta no celular (vibração, som e
  faixa vermelha "Você está numa ÁREA DE RISCO") ao entrar no raio. Só considera posições recentes e com precisão
  de até 150 m, para não alarmar por erro de GPS.
- **Anéis de distância**: círculos concêntricos (padrão 0,5 / 1 / 2 / 5 km, editável) a partir de um ponto
  — útil para o **raio de busca a partir da última localização conhecida**. Ficam lembrados por operação.
- **Sol**: o menu Operação mostra **nascer do sol, pôr do sol e quando escurece** (fim do crepúsculo civil)
  para o local da operação; o painel avisa **60 e 30 minutos antes de escurecer**.
- **Participante — "Onde estou"**: tocar no botão (ou no próprio marcador "Você") mostra suas coordenadas
  em decimal e **UTM**, com precisão e botão copiar — para informar por telefone ou rádio se a internet cair.

**Não incluído: mapas offline.** O AlpineQuest baixa mapas para uso sem internet, mas a política de uso dos
servidores de ladrilhos do OpenStreetMap e do OpenTopoMap **proíbe o download em massa e o uso offline**.
Implementar isso com esses servidores violaria os termos e poderia bloquear o acesso de todos. Alternativas,
se for necessário: (1) gerar e hospedar os próprios ladrilhos/arquivo PMTiles da região (ex.: com dados do
OSM e do IBGE) ou (2) contratar um provedor que permita cache offline (ex.: MapTiler, Thunderforest, com
chave própria).

### Tempo de permanência em setor

- Quando uma pessoa ou um grupo fica no **mesmo setor** mais tempo do que o limite da operação (padrão
  **1 h**), o responsável recebe um alerta para **avaliar a troca da equipe** (som + aviso clicável que leva
  ao mapa; fica também na aba **Alertas** da Comunicação e no diário).
- O tempo é calculado **no servidor, pela trilha GPS** (horário do GPS), a cada lote de posições recebido:
  começa no 1º de **2 pontos seguidos dentro** do setor e termina no 1º de **3 pontos seguidos fora**. Voltar
  ao setor até 5 min depois de sair continua a mesma permanência (a oscilação do GPS na borda não zera o
  tempo). Pontos com precisão pior que 150 m não contam.
- **Um alerta por limite atingido** (1×, 2×, 3× o limite), nunca a cada ponto. Membros do mesmo grupo no
  mesmo setor geram **um alerta do grupo**, listando quem está lá e há quanto tempo.
- **Configurar**: **Ferramentas → Dados da operação → Editar → Tempo de permanência em setor** (30 min a 4 h,
  ou **Desligado**; o banco aceita de 10 min a 12 h). A mudança fica registrada no diário.
- A ficha do participante mostra **"No setor X há Y"** (em amarelo acima do limite) e a lista de setores
  mostra quantas pessoas estão em cada setor e há quanto tempo. Tudo em tempo real.

### Vítima localizada ("Encontrei a vítima")

- No celular de campo, **ENCONTREI ALGO → Encontrei a vítima** (em destaque): escolhe **Viva** ou **Morta**,
  confirma e envia com a localização. Depois do envio o celular mostra apenas **"Localizada, ver protocolo"**.
- A condição fica só na tabela `vitima_localizacoes`, que **só os responsáveis da operação** leem (RLS, também
  no tempo real). A mensagem e o alerta que o participante consegue ver são neutros. A condição vai no corpo
  da chamada, nunca na URL, e não aparece em notificações.
- No painel: faixa de alerta própria (magenta; roxo escuro para óbito) com alarme, selo com a condição no
  relato, na ficha, na central e nos alertas, e marcador no mapa.
- **Tocar no marcador da vítima** mostra o balão com o **nome da vítima** (e a idade, "~" se estimada), a condição, **quem
  encontrou**, o local e o aviso "falta completar a ficha". **O que aconteceu ›** (ou dois toques, ou a mensagem "Detalhes" na
  central) abre a janela completa: vítima, hora (e há quanto tempo), quem encontrou e quem registrou, local, coordenadas, **setor**,
  distância do último local visto, tempo depois do início, estado e encaminhamento, e os **participantes**: quem encontrou e quem estava
  **a até 300 m** (pela última posição, com grupo, distância e idade da posição, e atalho para a ficha). Daí abre a ficha da
  vítima (ou **Completar a ficha**) e **Ver no mapa**.
- **O responsável também registra** (quando a notícia chega por rádio, telefone ou pessoalmente), por três
  caminhos: **Ferramentas → Vítima encontrada**, **toque longo / botão direito no mapa → ✚ Vítima encontrada
  aqui** e, na ficha de um participante, **✚ Encontrou a vítima**. O formulário pede a **condição** (com vida ou
  óbito), **quem encontrou** (opcional) e **onde**: ponto no mapa (com **Escolher no mapa**, que volta ao
  formulário sem perder o que foi preenchido), a localização deste aparelho, a última posição de quem encontrou
  ou sem localização. Gera o mesmo registro do campo (alerta crítico aos responsáveis, diário, dashboard,
  relatório e o ✚ no mapa), com "registrado por *responsável* (encontrada por *pessoa*)". Função
  `responsavel_registrar_vitima` (migração **025**).
- **Detalhes do registro** (migração **031**, função `registrar_vitima_encontrada`): o mesmo formulário também
  pede **qual vítima** (a ficha já cadastrada — com uma só, ela já vem escolhida — ou **＋ Nova vítima**, que cria
  a ficha só com o nome), **estado da vítima e encaminhamento** (lesões, SAMU, hospital), **quem encontrou** fora
  do sistema (**Outra pessoa…**: morador, PM, SAMU) e a **descrição do local** (margem do rio, fundo de vale…). Tudo
  vai para o alerta, o diário e, por ele, o relatório final. Sem a 031 no banco, registra o essencial e avisa que
  os detalhes não foram salvos.
- **Encerramento com o resultado**: **Ferramentas → Encerrar operação** abre o **resultado da busca** — **Vítima
  localizada** (já registrada vem marcada, com a condição; senão abre o **mesmo formulário de vítima encontrada** e,
  ao registrar, segue o encerramento; "Registrar outra vítima encontrada agora" para mais de uma), **Vítima não
  localizada**, **Outro desfecho** (com descrição obrigatória) ou **Encerrar sem informar o resultado** — e a
  descrição do desfecho. O resultado é o mesmo do **Relatório final** (localizada com vida / em óbito / não
  localizada / outro) e é gravado antes de encerrar; se a gravação falhar, a operação não é encerrada. **Voltar** no
  formulário da vítima retorna ao encerramento sem perder o texto.

### Operação encerrada: painel só para visualização

- Os responsáveis da operação e os administradores continuam abrindo o painel depois de encerrar
  (lista de operações → clicar na linha ou **⋮ → Ver painel (só leitura)**), inclusive depois que a retenção apagou
  os dados pessoais (aí ficam o cadastro, o local, o diário, o dashboard e os relatórios).
- Mapa, trilhas, setores, pontos, relatos, fotos, ficha dos participantes, conversa, central, grupos,
  deslocamentos, dashboard e diário aparecem normalmente. A faixa do topo diz **Somente visualização** e a
  pílula **Encerrada · só leitura**; não há faixa vermelha nem alarme de alertas antigos.
- Somem os botões de alteração: convidar, marcar ponto, novo setor, editar/ajustar/excluir setor e ponto, enviar
  destino, registrar foto ou vítima, grupos (novo/editar/excluir/link/membros), editar dados da operação e fichas
  de vítima, equipe de responsáveis, novo registro/editar no diário, ciente, liberar saída, remover/reincluir,
  orientações e mensagens. O **servidor também recusa** essas alterações (migração 026).
- Continuam: **Relatório final (PDF)** e o resultado da operação e **Excluir operação** (para quem pode).
  Os dados não são apagados ao encerrar (migração 027).

### Diário da operação

- **Ferramentas → Diário da operação** (ou **Diário da operação** no menu **⋮** da linha na lista de operações): registro cronológico agrupado
  por dia, com filtros (setores, deslocamentos e chegadas, encontros, alertas, pessoas, observações, operação).
- **Eventos automáticos** são gravados pelo **próprio banco** (gatilhos) a partir dos outros módulos: criação e
  acionamento, início e fim da varredura de cada setor (mudança de situação), deslocamentos, chegadas ao setor
  e à base, busca finalizada, retorno atrasado, relatos de campo, pedidos de ajuda, vítima localizada (com a
  condição), pontos de interesse, entrada/saída/remoção de pessoas, grupos, encerramento, resultado e
  relatórios gerados. Não podem ser editados nem apagados.
- **+ Observação**: o responsável escreve uma observação livre com **data e hora do fato**. Qualquer responsável
  da operação pode **editar**; ninguém exclui. Cada edição guarda a versão anterior (**Histórico**).
- Só responsáveis da operação leem o diário. Ele **não é apagado** pela retenção nem pelo app.

### Relatório final (PDF)

- **Capa e cabeçalho**: a **logo do Corpo de Bombeiros Militar do Paraná** aparece no topo da capa e, a partir da segunda página, no cabeçalho (`public/img/logo-cbmpr.png`, carregada no navegador e embutida no PDF) fica à esquerda, com o código da operação e a marca "DOCUMENTO RESTRITO" à direita. A **mesma logo** aparece no topo da capa, acima do título.
- **Ferramentas → Relatório final (PDF)** (ou **Relatório final (PDF)** no menu **⋮** da linha na lista de operações). Só responsáveis da operação
  (o banco confere em `relatorio_operacao`).
- Registre o **resultado** (vítima localizada com vida / em óbito / não localizada / outro, com descrição).
- **Gerar PDF** monta, no navegador: capa com natureza, números e datas, sumário, a ocorrência (o IPO, com cada dado
  uma só vez: tipo não aparece, a natureza diz o tipo), pessoas e grupos (CPF e celular parcialmente ocultos), setores varridos (mapa geral, mapa de cada
  setor, início, fim, duração, área, deslocamentos e fotos tiradas dentro do setor), pontos e encontros,
  **mapa geral da operação** com todos os elementos registrados (trilhas GPS, trilhas desenhadas, pontos com o ícone do tipo,
  relatos, vítimas, fotos e o local) — **também quando não há setores cadastrados**,
  diário consolidado por dia (sem repetir os registros do IPO) e resultado (sem campos de assinatura). Cabeçalho e rodapé em todas as páginas
  ("DOCUMENTO RESTRITO", página X de Y).
- O PDF é baixado e **uma cópia fica guardada** no bucket privado `relatorios` (sem exclusão pelo app); a lista
  **Relatórios já gerados** permite baixar de novo.
- Ao **encerrar** a operação ou **apagar os dados**, se ainda não houver relatório, o painel oferece gerar antes
  (depois da retenção o relatório sai só com cadastro, diário e resultado).
- Biblioteca: **pdfmake 0.2.23** (`public/vendor/pdfmake/`, licença MIT), carregada só ao gerar. Os mapas são
  desenhados em canvas com o OpenStreetMap de fundo; sem acesso ao fundo, o mapa sai sem ele (com escala).

### Estatísticas e estudos (dashboards)

Objetivo: juntar, operação a operação, dados para estudar o comportamento da vítima e a distância em que ela é
encontrada em relação ao **ULV** (último local visto). Os painéis mostram **só números**: nenhum nome, documento ou
dado de participante sai do banco nesses painéis.

- **Tela inicial, alternador "▦ Dashboard" / "☰ Operações"** (botões na própria tela): o Dashboard mostra cartões de números, leitura em texto e
  gráficos desenhados em SVG e em grade (sem bibliotecas externas), cada um com o tamanho da amostra (n): operações por mês (12 meses, **duas colunas por mês: aquática e terrestre**; as de outros tipos são avisadas abaixo), operações por tipo (**Aquática, Terrestre e Outros**, que junta aérea, outras e sem tipo),
  distância do ULV à localização (faixas de 1 km), distância e tempo (mediana, metade central, média, tempo até localizar),
  perfis das vítimas e condição (com vida / em óbito). Vale para todas as operações a que o responsável tem acesso
  (administrador: todas). A escolha fica salva neste navegador.
- **Mapa do Paraná** (logo abaixo dos cartões de números): limites do estado, das 10 mesorregiões (com nome)
  e, de perto (zoom 9+), dos 399 municípios (IBGE, simplificados, em `js/parana-geo.js`, baixado só quando o
  mapa abre). Cada operação aparece no **local cadastrado** (`local_lat`/`local_lng`) — nunca na posição de um
  participante. Bolinha só com a cor da situação (**verde = ativa**, **vermelha = encerrada**), sem letra
  (o tipo aparece ao passar o cursor e no popup); a legenda só mostra as situações que existem. Os nomes das
  mesorregiões ficam pequenos e translúcidos. Operações próximas são agrupadas (o anel
  mostra a proporção ativas/encerradas). Tocar num marcador mostra nome, tipo/natureza, município e
  mesorregião (calculados pelos limites; perto da divisa podem cair no vizinho), data e hora do acionamento,
  situação, responsável (pela função `listar_responsaveis`), número de participantes, resumo da descrição e
  **Abrir operação** (o mapa só mostra operações que o responsável já pode abrir — RLS). Operações sem
  coordenadas são contadas abaixo do mapa (**Ver quais**). Atualiza em tempo real (com a migração 028) e a
  cada minuto; falha do Supabase mostra aviso com **Tentar de novo** e mantém o último estado. A roda do
  mouse só dá zoom depois de clicar no mapa (rolar a página não mexe nele).
- **Cabeçalho:** um único botão **☰ Menu** abre a lista de ações (Responsáveis, Minha conta, Sair). A troca
  entre Dashboard e Operações fica só nos botões da tela.
- **Interativo (tocar abre os detalhes, por cima; Fechar volta ao dashboard):**
  - Dashboard: os números abrem a lista das operações (todas, abertas, encerradas, com vítima localizada); uma coluna
    do mês ou um tipo abre as operações daquele mês ou tipo; perfil, faixa de distância e condição abrem os números
    e o que significam; "Distância e tempo" explica como ler. Tocar numa operação abre a operação. Números com
    menos de 5 casos continuam "oculto".
  - Dashboard da operação: os números abrem as pessoas (efetivo, km e horas por pessoa), os setores e a duração;
    uma coluna do gráfico mostra quem estava em campo naquele intervalo; um grupo, os integrantes; um setor, a
    cobertura, quem passou e **Ver setor no mapa**. Tocar numa pessoa mostra a pessoa no mapa e abre a ficha.
    Pedidos de ajuda, relatos e ordens abrem as mensagens; retornos atrasados, os alertas; o diário, o diário.
- **Operação → Dashboard da operação** (janela larga; no celular, uma coluna):
  - seis números: duração, efetivo (e quantos em campo agora), km percorridos, esforço em pessoa·hora,
    setores (com a % da área coberta) e se a vítima foi localizada;
  - **pessoas em campo** ao longo do tempo (uma coluna por intervalo de 15 min a 1 dia), com a hora da
    localização da vítima marcada;
  - **vítima**: condição, hora, tempo após o início, distância do ULV e perfis das fichas;
  - **esforço por grupo** (pessoas, km e horas com GPS) e **cobertura dos setores** (% da área por onde passou
    alguma trilha, em quadrados de ~30 m, e a última passagem; os menos cobertos primeiro);
  - **ocorrências**: pedidos de ajuda, pistas, vestígios, objetos, obstáculos, fotos, pontos marcados, ordens
    enviadas, retornos atrasados e registros no diário.
  Esforço, setores e ocorrências são calculados no navegador com o que o painel já carregou (trilhas filtradas
  pelo mesmo critério do mapa). Só a parte da vítima vem do banco (`estudo_operacao`, migração 023); sem ela, o
  restante aparece mesmo assim.
- **ULV** = o ponto do cadastro da operação (coordenadas do último avistamento). **Localização da vítima** = o primeiro
  registro de vítima localizada da operação (`vitima_localizacoes`). **Distância** = Haversine entre os dois.
- **Perfil da vítima** = uma lista de seleção na ficha ("Perfil da vítima (para estudos)"), sem digitação. Os valores vêm de uma só lista (`PERFIS_VITIMA`, em `ipo.js`), usada pelo formulário e pelos gráficos, e o banco aceita só esses valores. Não é calculado pela idade.
  Alzheimer/demência, autismo, deficiência intelectual, transtorno mental, outro). Não é calculado pela idade.
- **Qualidade dos dados** (cartão no fim do Dashboard, migração 043, função `estudo_qualidade`): diz **sobre o que** os
  números foram calculados. Unidade de análise: a **operação** (primeira localização com posição). Casos elegíveis,
  com localização, **válidos para distância** (ULV e posição) e **para tempo** (início e hora, sem tempo negativo);
  **ausentes** contados à parte (sem ULV, localização sem posição, sem hora de início) — **ausente nunca vira zero**;
  **não localizados** (encerradas sem localização: ficam fora das medianas, censurados); abertas sem localização;
  **possíveis duplicatas** (mesmo tipo, ULV a menos de 1 km e início a menos de 48 h); fichas sem idade, com idade
  estimada e sem perfil (com o mesmo sigilo de 5 casos). A proporção "com vida / em óbito" usa todas as localizadas
  como denominador (a oculta não conta como zero).
- **Sigilo dos números:** grupos com **menos de 5 casos** chegam ocultos ("oculto (menos de 5 casos)"), no banco
  (`estudo_geral`, `estudo_operacao`), não só na tela.
- **Limitação conhecida:** a localização não está ligada a uma ficha específica. Com duas vítimas na mesma operação,
  a distância conta para as duas. Ligar a localização à ficha é o próximo passo, se o estudo precisar disso.
- Exportar os dados para pesquisa **não está implementado**: depende de decisão sobre dados de saúde (LGPD) e de
  aprovação ética, antes de qualquer conjunto de dados sair do sistema.

### Avisos na tela

Os avisos (ex.: "Dados salvos", pedidos de ajuda) têm um **×** para fechar e somem sozinhos em até **5 s**
(**8 s** para erros e alertas). Com o mouse em cima, o aviso espera; ao tirar o mouse, some em 2 s. Pedidos de
ajuda continuam também na faixa de alerta. A exceção são **"saiu do setor"** e **"entrou na área de risco"**:
como só aparecem no aviso, ficam na tela até você fechar no ×.

### IPO (Informe Padrão de Ocorrência) — é o próprio cadastro da operação

Não existe formulário separado: o IPO **é** o cadastro. Os campos ficam num só formulário, em `operacoes`
(colunas próprias e `operacoes.ipo` para os campos do IPO).

- **Criação (+ Nova operação), o mínimo que se informa de imediato:** nome da operação (obrigatório), vítima(s)
  (nome e idade, nas fichas), coordenadas (ponto no mapa), **início das operações** (automático: a hora da criação),
  nome do solicitante, natureza e uma observação com a breve descrição da ocorrência. O tipo não é pedido agora.
- **Painel da operação → Dados da operação → Editar:** o cadastro completo, no mesmo formulário: início das operações,
  local (ponto no mapa ou só endereço), solicitante (nome e documento), natureza, destinatários, data e hora do último momento
  visto, nº de pessoas perdidas, buscas preliminares, possibilidade de vida ("Não apurado" quando não se sabe), BMs
  diretamente envolvidos, imagens anexas, responsável pelas informações, a observação e as vítimas.
  Abaixo da hora do último momento visto, a **origem da hora**: informado (testemunha, câmera, registro), estimado
  ou **desconhecido** (apurado e ninguém sabe). Em branco fica "não informado"; com hora e sem origem, vale "informado".
  Os Dados da operação e o PDF mostram "(estimado)" ao lado da hora.
  Em celular, o formulário tem uma coluna só; em tablet e PC (a partir de 760 px) as seções ficam lado a lado
  (Ocorrência | Solicitante, Busca | Observação) e a janela é mais larga. Na criação, Local | Ocorrência e
  nome da operação e retenção na mesma linha.
- **Natureza**: **BUSCA AQUÁTICA – PESSOA**, **BUSCA TERRESTRE – PESSOA** ou **Outro (descrever)**, que abre um campo
  para a descrição. Operações antigas com outra natureza aparecem como "Outro" com o texto gravado.
- **Tipo da operação** não é escolhido à parte: vem da **natureza** (aquática → aquática; terrestre → terrestre;
  "Outro" → "outras", com a própria descrição). O **meio líquido** só aparece para busca aquática.
  As coordenadas do cadastro são as do último avistamento: não há um segundo campo de coordenadas.
- **Vítimas do IPO = fichas de vítima.** A ficha tem nome, idade, nascimento, sexo, origem, perfil e **foto** (migração 021).
  O mesmo formulário da ficha aparece na criação da operação e em Dados da operação → Editar.
- **Procedimentos de busca, recursos do CB e desdobramentos** são registros do **diário** (categoria operação):
  **+ Novo registro** → tipo "Procedimento de busca sendo realizado" (com a lista de procedimentos), "Recurso empregado"
  ou "Desdobramento do dia". Cada um tem data e hora do fato e pode ser editado (fica no histórico).
- O relatório final começa, depois da capa, com a ocorrência no formato do IPO (é a única seção de cadastro, sem repetir
  dados) e na mesma ordem do modelo ("IPO: 2 CRBM / 3 BBM",
  "ATENÇÃO: uso exclusivo nos grupos do CBMPR", opções com "(X)" marcada e "( )" não marcada). Os procedimentos
  marcados vêm do diário, com a hora de cada um; recursos e desdobramentos também saem com data e hora.
- **Retenção:** hoje o IPO **não** é apagado pela limpeza de dados da operação. Ele tem nome, documento e dados da vítima, então isso precisa de decisão: apagar junto com os dados pessoais, ou manter como registro oficial.
- Operações salvas com o formulário separado de IPO (só de teste) não são convertidas: os campos novos começam vazios.

### Excluir uma operação

- **Quem criou a operação** e **administradores** excluem a operação com tudo o que é dela, **com ou sem atividade**
  (diário, observações, deslocamentos, relatórios gerados…) — migração 041. Antes, quem não era administrador só
  conseguia excluir operação sem atividade (erro "operacao_com_registros"). Os PDFs e as fotos saem do Storage pela
  fila de limpeza.
- Disponível para **quem criou a operação** e para **administradores** (que alcançam **todas** as operações, inclusive para excluir): na lista de
  operações (botão **Excluir operação**) e em **Ferramentas → Excluir operação**. Os demais nem veem o
  botão, e o banco recusa a exclusão se alguém tentar por fora. Participantes nunca podem excluir.
- Uma **confirmação simples** (Excluir / Cancelar) diz o que será apagado; não é preciso digitar o nome.
- Numa **única transação** no banco são apagados a operação, participantes, posições/trilhas,
  mensagens e relatos, registros de fotos, equipe de responsáveis e os **tokens dos links** (o QR Code
  deixa de funcionar na hora). Os arquivos das fotos entram numa fila (`arquivos_pendentes`) e o painel
  os apaga do Storage em seguida. Se a remoção de algum arquivo falhar, ele fica registrado na fila e a
  **limpeza diária** (`/api/limpeza`) apaga depois — nenhum arquivo fica esquecido. O painel informa
  o resultado (sucesso, ou quantos arquivos ficaram para a limpeza).
- Quem estiver com o link aberto para de enviar localização, mensagens e fotos e vê
  "A operação foi excluída…". Outras operações e os cadastros de responsáveis não são afetados.

### Encerramento da participação

O participante **não tem botão para parar** o rastreamento. Ele toca em **Solicitar encerramento**
(pode informar o motivo); o painel toca um alarme e destaca "Pediu para sair". Na ficha, o
responsável escolhe **Liberar saída** (o celular para de enviar e mostra "Saída liberada") ou
**Pedir para continuar** (o pedido é cancelado e o participante recebe uma mensagem). Enquanto
aguarda, a localização continua sendo enviada. Quem teve a saída liberada pode ser **reincluído**
(ver "Remover e reincluir participante").

> Nenhum site consegue impedir que alguém feche o navegador ou desligue o GPS do próprio celular.
> Se isso acontecer, o painel mostra "Sinal instável" e depois "Sem atualização" com a última
> posição marcada como antiga, e a página avisa antes de ser fechada.

---

## 2. Estrutura dos arquivos

```
rastreamento-sar/
├── public/                     ← site publicado pelo Vercel
│   ├── militar.html            painel do responsável
│   ├── civil.html              página do participante
│   ├── sci.html                painel de comando SCI em janela própria (comando remoto, segundo monitor, impressão)
│   ├── sw.js                   service worker: notificações no Android, página e mapa guardados para abrir sem internet
│   ├── versao.json             versão publicada (páginas abertas há muito tempo avisam que há versão nova)
│   ├── css/estilos.css         estilos (alto contraste, botões grandes, responsivo)
│   └── js/
│       ├── comunicacao.js      cliente Supabase, chamadas ao servidor, erros, relógio, formatação
│       ├── interface.js        avisos e caixas de confirmação
│       ├── fotos.js            fotos: leitura de EXIF, redução, prévia, envio ao Storage privado
│       ├── gps.js              filtro das leituras do GPS, montagem das trilhas, permissão e diagnóstico
│       ├── rotas.js            geração de rotas: por caminhos (/api/rota) e desenhada (trajeto), progresso e simplificação
│       ├── coords.js           formatos de coordenadas (decimal, GMS, UTM, MGRS), rumo, nascer/pôr do sol
│       ├── arquivos.js         exportar e importar GPX, KML/KMZ, GeoJSON e CSV
│       ├── ferramentas.js      ferramentas de mapa do painel (medir, ir para coordenada, estatísticas…)
│       ├── trilha-local.js     fila offline dos pontos (IndexedDB) e envio com confirmação por ponto
│       ├── cadastro.js         cadastro da operação, escolha de ponto no mapa e fichas das vítimas
│       ├── relatorio.js        diário da operação, resultado, mapas em canvas e geração do relatório final
│       ├── relatorio-pdf.js    monta o documento do relatório final (pdfmake), sem rede nem tela
│       ├── ajuda-pedidos.js    pedidos de ajuda: estados, tempo sem atendimento, escalonamento e histórico
│       ├── recursos-equipe.js  disponibilidade, capacidades e recursos das equipes
│       ├── briefing.js         briefing da operação e passagem de comando com aceite
│       ├── sci-core.js         regras do SCI sem tela: totais, alertas, resumo, imprensa, leitura das frases (também no servidor)
│       ├── sci.js              painel de comando SCI (blocos, quadro de vítimas, linha do tempo, formulários, tempo real)
│       ├── sci-janela.js       abre o SCI em sci.html (com login quando não há sessão)
│       ├── convites.js         convite por e-mail: cadastro, envio, situação e link
│       ├── cores.js            cor livre (tom, intensidade, claridade, minhas cores) e conversões
│       ├── relatos-revisao.js  revisão dos relatos (estado, justificativa, versões, hora do fato)
│       ├── binomio.js          sessão do binômio cão e condutor: indicações e confirmações independentes
│       ├── observacoes-campo.js drone (plano, telemetria, área observada, foco térmico) e indicação na água
│       ├── personalizar.js     Personalizar tela: botões do topo e Ferramentas (arrastar), grupos e texto
│       ├── mapa-offline.js     mapa guardado no aparelho do participante (áreas do OSM, limite da política)
│       ├── militar.js          lógica do painel (inclui grupos, filtro do mapa, deslocamentos e alertas)
│       └── civil.js            lógica do participante (GPS, fila offline, mensagens, relatos, fotos)
│   └── vendor/pdfmake/         pdfmake 0.2.23 (MIT), carregado só ao gerar o relatório
├── api/
│   ├── config.js               entrega ao navegador só a URL e a chave PÚBLICA (de variáveis de ambiente)
│   ├── limpeza.js              limpeza diária dos dados vencidos (usa a chave SECRETA, só no servidor)
│   ├── responsaveis.js         cria login e redefine senha de responsáveis (só administradores; chave SECRETA)
│   ├── meteo.js                meteorologia: radar, previsão e alertas (só responsáveis; chaves só no servidor)
│   ├── sci-ia.js               assistente opcional do Posto de Comando: frase → ações para conferir (mesma chave do POA/POD)
│   ├── convidar.js             envio do convite de participante por e-mail (chave RESEND_API_KEY só no servidor)
│   ├── poa-ia.js               sugestão opcional de POA/POD por IA (chave ANTHROPIC_API_KEY só no servidor)
│   └── rota.js                 rota por caminhos (openrouteservice; chave ORS_API_KEY só no servidor)
├── supabase/
│   ├── schema.sql              instalação completa e idempotente (inclui todas as migrações)
│   └── migracoes/
│       ├── 003_setores_pontos_navegacao.sql   setores, pontos de interesse e destinos
│       ├── 004_destinos_reinclusao.sql        destino recebido pelo participante e reinclusão
│       ├── 005_modo_destino.sql               modo do destino (a pé, trilha, carro)
│       ├── 006_raio_alerta.sql                raio do alarme de proximidade nas áreas de risco
│       ├── 007_cadastro_operacao_vitimas.sql  cadastro completo da operação e fichas das vítimas
│       ├── 008_grupos.sql                     grupos, membros, papéis e link por grupo
│       ├── 009_trilha_offline.sql             envio em lote com confirmação e intervalo do GPS
│       ├── 010_missoes_alertas.sql            destino para grupos, alertas e controle de retorno
│       ├── 011_vitima_localizada.sql          "Encontrei a vítima" (condição só para responsáveis)
│       ├── 025_responsavel_registra_vitima.sql o responsável registra a vítima encontrada pelo painel
│       ├── 026_operacao_encerrada_somente_leitura.sql operação encerrada: só leitura (servidor)
│       ├── 027_dados_so_saem_ao_excluir.sql   encerrar não apaga: dados só saem ao excluir a operação
│       ├── 028_trilhas_manuais.sql            trilhas desenhadas à mão (planejadas/percorridas); operações no Realtime
│       ├── 029_nomes_painel_cpf_opcional.sql  CPF opcional para civis; nome de exibição do participante no painel
│       ├── 030_percursos_trajetos.sql         meio/cor/origem das trilhas; trajeto desenhado como destino
│       ├── 031_vitima_encontrada_detalhes.sql ficha, estado, local e quem encontrou no registro da vítima
│       ├── 032_controle_tempo_missoes.sql     horários combinados, alertas de atraso e de falta de comunicação
│       ├── 038_poa_fora_origem.sql / 039_missoes_busca_pos.sql   Fora da área, origem dos valores, missões de busca e cálculo pós-busca
│       ├── 033_cenario_busca_pod_poa.sql / 034_poa_pod_guia.sql   POA/POD: cenários, versões, registros de busca
│       ├── 035_pedidos_ajuda.sql              pedidos de ajuda com estados, prioridade, escalonamento e histórico
│       ├── 036_recursos_equipes.sql           disponibilidade, capacidades e recursos das equipes
│       └── 037_briefing_comando.sql           briefing, decisões pendentes e passagem de comando
│       ├── 012_diario_relatorio.sql           diário, observações, resultado e relatórios guardados
│       ├── 013_permanencia_setor.sql          alerta de tempo de permanência em setor (pela trilha GPS)
│       └── 014_fotos_localizacao.sql          fotos: setor, localização pendente e atualização pelo GPS
├── testes/
│   ├── filtro_gps.test.js      teste do filtro de GPS e do desenho das falhas (node, sem dependências)
│   ├── coords.test.js          teste das conversões de coordenadas (UTM, MGRS, GMS, rumo, sol)
│   ├── trilha_local.test.js    teste da fila offline (pendentes, confirmação, reenvio sem duplicar)
│   └── banco_migracoes.test.mjs  schema e migrações num PostgreSQL real (PGlite): RLS e fluxos (npm run test:banco)
├── vercel.json                 diretório publicado, agendamento da limpeza e cabeçalhos de segurança
├── .env.example                nomes das variáveis de ambiente
└── package.json
```

---

## 3. Configurar o Supabase (≈ 10 minutos)

1. Crie uma conta em <https://supabase.com> e clique em **New project**. Escolha a região
   **South America (São Paulo)** para menor latência. Guarde a senha do banco.
2. Abra **SQL Editor → New query**, cole **todo** o conteúdo de `supabase/schema.sql` e clique em
   **Run**. Deve terminar sem erros.
   **Já tinha publicado uma versão anterior?** Execute o `schema.sql` novo do mesmo jeito: ele
   atualiza tabelas, funções e regras **sem apagar** operações nem dados existentes.
   Para aplicar **só** a parte nova de setores, pontos de interesse e navegação, use
   `supabase/migracoes/003_setores_pontos_navegacao.sql` (também idempotente). O que ela cria:
   - tabelas `setores`, `pontos_interesse` e `destinos` (ligadas à operação, apagadas junto com ela);
   - RLS: só os responsáveis da operação leem; ninguém grava direto pelo navegador;
   - funções: `salvar_setor`, `excluir_setor`, `salvar_ponto`, `excluir_ponto`, `definir_destino`,
     `encerrar_destino`, `mapa_do_participante` (+ auxiliares `pode_excluir_registro`,
     `nome_responsavel_atual`, `vertices_validos`);
   - gatilho que apaga setores, pontos e destinos quando os dados da operação são apagados (retenção);
   - publicação das três tabelas no Realtime.
   Nenhuma tabela existente é alterada.
   **Migração 004** (`supabase/migracoes/004_destinos_reinclusao.sql`, idempotente, exige a 003): é
   **necessária para as correções de destino e de reinclusão**. Ela:
   - acrescenta colunas em `participantes` (`removido_em`, `removido_por_nome`, `reincluido_em`,
     `reincluido_por_nome`) e `destinos.recebido_em` — sem apagar nada;
   - cria a tabela `participacao_eventos` (histórico de remoções, liberações e reinclusões; leitura só
     pelos responsáveis da operação);
   - cria a política RLS `destinos_ler_participante` (o participante lê **só o próprio** destino — base do
     tempo real); nenhuma outra política é alterada;
   - substitui `remover_participante` e `liberar_participante` (registram quem/quando e encerram o destino
     ativo) e cria `reincluir_participante`, `confirmar_destino` e `meu_destino`;
   - termina com `notify pgrst, 'reload schema'` para a API reconhecer as funções novas na hora.
   **Migração 005** (`supabase/migracoes/005_modo_destino.sql`, idempotente, exige a 004): acrescenta
   `destinos.modo` ('a_pe', 'trilha', 'carro'; padrão 'a_pe'), o parâmetro opcional `p_modo` em
   `definir_destino` e o modo na resposta de `meu_destino` e `mapa_do_participante`. Sem ela, o destino
   continua funcionando (o painel envia sem o modo e o celular usa "a pé").
   **Migração 006** (`supabase/migracoes/006_raio_alerta.sql`, idempotente, exige a 003): acrescenta
   `pontos_interesse.raio_m` (raio do alarme de proximidade, de 10 m a 5 km, opcional), aceita o raio em
   `salvar_ponto` e o devolve em `mapa_do_participante`. Nenhuma política RLS é alterada. Sem ela, os
   pontos continuam sendo salvos e o alarme usa o raio padrão de 100 m.
   **Migrações 007 a 010** (idempotentes, nesta ordem; cada uma exige a anterior):
   - **007** (`007_cadastro_operacao_vitimas.sql`): colunas **opcionais** do cadastro em `operacoes` (as
     operações antigas continuam válidas), `criar_operacao` com `p_dados` (chamadas antigas continuam
     funcionando), `atualizar_operacao`, tabela `vitimas` (RLS: só responsáveis), bucket privado
     **`vitimas`** com as regras `gbs_vitimas_enviar/ver/apagar`, `salvar_vitima`, `excluir_vitima`,
     `definir_foto_vitima`, `meus_arquivos_pendentes_v2`;
   - **008** (`008_grupos.sql`): `grupos`, `grupo_convites` (links), `grupo_membros` (papel), RLS (cada
     participante só vê os próprios grupos), `salvar_grupo`, `definir_membro`, `remover_membro`,
     `link_do_grupo`, `gerar_novo_link_grupo`, `meus_grupos`; `info_operacao` e `ingressar` aceitam o link do grupo;
   - **009** (`009_trilha_offline.sql`): `operacoes.gps_intervalo_s` (15 s) e `gps_lacuna_s` (60 s),
     `configurar_gps_operacao`, `enviar_posicoes_lote` (confirmação por ponto); `enviar_posicoes` continua;
   - **010** (`010_missoes_alertas.sql`): categoria **BASE**, `missoes`, `missao_membros`, `alertas`,
     `destinos.missao_id`, `enviar_destino_grupo`, `finalizar_busca`, `prorrogar_retorno`, `encerrar_missao`,
     `verificar_retornos`, `reconhecer_alerta`; avaliação dos eventos pela trilha GPS no servidor; agenda o
     `pg_cron` se ele estiver ativo.
   - **011** (`011_vitima_localizada.sql`): `vitima_localizacoes` (RLS: só responsáveis), `participante_registrar_vitima`,
     categoria `VITIMA` e alerta `vitima_localizada`;
   - **012** (`012_diario_relatorio.sql`): `diario`, `diario_versoes`, `relatorios` (sem exclusão), gatilhos que
     alimentam o diário, `diario_adicionar`, `diario_editar`, `definir_resultado`, `relatorio_operacao`,
     `registrar_relatorio`, bucket privado **`relatorios`** (PDF; sem regra de exclusão) e `excluir_operacao`
     só para operações sem atividade; preenche o diário das operações existentes.
   - **013** (`013_permanencia_setor.sql`): `operacoes.permanencia_limite_min` (padrão 60), `setor_permanencias`
     (RLS: só responsáveis; Realtime), `configurar_permanencia`, alerta `permanencia_setor`; o gancho
     `apos_posicoes` passa a chamar os deslocamentos (`apos_posicoes_missoes`) e a permanência.
   - **014** (`014_fotos_localizacao.sql`): `fotos.setor_id`/`setor_nome` (calculado por gatilho),
     `local_atualizado_em`, origens `pendente` e `trilha`, `registrar_foto` aceita local pendente,
     `atualizar_local_foto`, e o gancho `apos_posicoes` completa fotos pendentes pela trilha.
   - **Alerta de retorno atrasado sem painel aberto**: ative **Database → Extensions → pg_cron** e rode a
     migração 010 (ou o `schema.sql`) de novo — ela agenda `select public.verificar_retornos()` a cada minuto
     (job `gbs-verificar-retornos`). Sem `pg_cron`, o alerta só é verificado com algum painel aberto.
   O painel e a página do participante funcionam com o banco ainda sem essas migrações (as funções novas
   ficam indisponíveis, com aviso).
   - **015** (`015_grupos_no_mapa_civil.sql`): `equipe_no_mapa` passa a incluir os **integrantes dos grupos em
     comum** de quem consulta (com nome, grupo e papel, sem CPF, telefone ou trilha). Militares e responsáveis
     **sem grupo** continuam visíveis; quem está em outro grupo só aparece para o próprio grupo.
   - **016** (`016_admin_todas_operacoes.sql`): o **administrador** (`responsaveis.admin` ativo) passa a acessar **todas**
     as operações, não só as que criou ou das quais foi adicionado; a regra fica em `dono_operacao`, usada pelas
     políticas e pelas funções do painel. Os demais responsáveis seguem como antes. Na lista de operações, o
     administrador vê o título **Operações (todas)** e o nome de quem criou cada operação de outro responsável.
   - **017** (`017_excluir_responsavel.sql`): nova função `admin_excluir_responsavel` (só administradores). Exclui o
     cadastro do responsável, mas **recusa** quem não pode ser apagado: você mesmo e quem já tem histórico (operação
     criada, mensagem enviada ou localização de vítima registrada). Nesses casos, use **Desativar acesso**. O login
     é apagado logo depois pela função de servidor `/api/responsaveis` (ação `excluir`).
   - **018** (`018_pedido_acesso_responsavel.sql`): tabela `solicitacoes_responsavel` e as funções do **pedido de acesso**
     (`meu_status_acesso`, `admin_listar_solicitacoes`, `admin_decidir_solicitacao`). Só o administrador decide.
     A tabela não tem acesso direto: o pedido entra pela função de servidor `/api/responsaveis` (ação `solicitar`).
   - **019** (`019_ipo_operacao.sql`): coluna `ipo` na operação e a função `salvar_ipo_operacao`. O relatório
     (`relatorio_operacao`) passa a devolver os dados do IPO. Ver a seção "IPO" abaixo.
   - **021** (`021_ipo_no_cadastro.sql`): o IPO entra no cadastro (`criar_operacao` e `atualizar_operacao` gravam
     `ipo`); fichas de vítima ganham `nascimento`, `sexo` e `origem`; nova função `diario_registrar_ipo` (procedimento,
     recurso e desdobramento no diário). Ver a seção "IPO" abaixo.
   - **023** (`023_estudos_perfil_distancia.sql`): perfil da vítima na ficha; `distancia_km`, `estudo_operacao` e
     `estudo_geral` (agregados, grupos com menos de 5 casos ocultos). Ver "Estatísticas e estudos".
   - **022** (`022_cadastro_inicial.sql`): criar a operação não exige mais o tipo, e o início das operações é a hora
     da criação quando o formulário não manda outra.
   - **020** (`020_admin_excluir_sem_restricao.sql`): `excluir_operacao` deixa o administrador excluir operação com
     atividade (diário e relatórios). Criador sem ser administrador segue com a regra de operação sem atividade.
   - **024** (`024_admin_excluir_relatorio.sql`): nova função `excluir_relatorio` (só administrador). O PDF vai para a fila
     de limpeza do Storage e a exclusão fica no diário (evento "Relatório excluído").
   - **025** (`025_responsavel_registra_vitima.sql`): nova função `responsavel_registrar_vitima` — o responsável
     registra a vítima encontrada pelo painel (condição, quem encontrou e local), com o mesmo alerta e diário do campo.
   - **026** (`026_operacao_encerrada_somente_leitura.sql`): operação encerrada fica **só para leitura** no servidor.
     Gatilhos recusam (`operacao_encerrada`) alterações feitas pelo app em setores, pontos, grupos e membros, fichas
     de vítima, destinos, equipe de responsáveis, remoção/liberação/reinclusão de participantes, anotações do diário e
     no cadastro da operação. Seguem permitidos: resultado, relatório e excluir a operação.
   - **027** (`027_dados_so_saem_ao_excluir.sql`): **encerrar não apaga nada**. `encerrar_operacao` e a limpeza diária
     (`purgar_expiradas`) deixam de apagar dados de operação e `apagar_dados_operacao` fica desativada
     (`apagar_dados_desativado`). Os dados só saem ao **excluir** a operação. Prazos pendentes são anulados.
   - **028** (`028_trilhas_manuais.sql`): tabela `trilhas_manuais` (trilhas desenhadas à mão, planejadas ou
     percorridas) com RLS de leitura para os responsáveis da operação, funções `salvar_trilha_manual` /
     `excluir_trilha_manual`, gatilhos (operação encerrada só leitura, diário) e inclusão de `trilhas_manuais`
     e `operacoes` no Realtime (mapa do dashboard). Só cria objetos novos; não apaga nada.
   - **029** (`029_nomes_painel_cpf_opcional.sql`): `ingressar` aceita civil **sem CPF** (CPF informado continua
     conferido; celular segue obrigatório para civis); coluna `participantes.nome_painel` e função
     `renomear_participante` (só responsáveis da operação; encerrada: só leitura; um novo ingresso da pessoa não
     apaga o nome dado no painel). Não apaga nada.
   - **030** (`030_percursos_trajetos.sql`): `trilhas_manuais` ganha `meio`, `cor`, `origem` e `arquivo`;
     `destinos` e `missoes` ganham `trajeto`; funções `definir_destino_trajeto` e `enviar_trajeto_grupo`;
     `meu_destino` e `mapa_do_participante` devolvem o trajeto. Exige a 028. Não apaga nada.
   - **031** (`031_vitima_encontrada_detalhes.sql`): `vitima_localizacoes` ganha `vitima_id`, `encontrada_por_texto`,
     `local_descricao` e `observacoes`; função `registrar_vitima_encontrada` (formulário completo numa transação, cria
     a ficha só com o nome se preciso); o diário da vítima localizada leva esses detalhes. Não apaga nada.
   - **032** (`032_controle_tempo_missoes.sql`): `missoes` ganha `inicio_combinado_em`, `retorno_combinado_em`,
     `tolerancia_min`, `sem_sinal_min`, `combinado_texto` e quem/quando definiu; alertas `inicio_atrasado`,
     `prazo_atrasado`, `sem_comunicacao` e `comunicacao_restabelecida`; funções `definir_prazos_missao` e
     `verificar_prazos`; `verificar_retornos` (o agendamento do `pg_cron` que já existe) passa a chamar a
     `verificar_prazos`. Exige a 010. Não apaga nada.
   O `schema.sql` completo já inclui da 003 à 032.
3. Ative o ingresso dos participantes: **Authentication → Sign In / Providers** (ou **Providers**) →
   ligue **Allow anonymous sign-ins** → **Save**.
   *Cada celular recebe uma identidade anônima; ela só serve para ingressar com o token do link.*
4. **Aumente o limite de ingressos anônimos**: em **Authentication → Rate Limits**, o padrão é
   **30 por hora por endereço IP**. Numa base de operações, muitos voluntários usam a mesma rede
   (Wi-Fi ou operadora com IP compartilhado), então aumente para, por exemplo, 300.
5. **Só na primeira instalação** — crie o **primeiro** responsável (ele será o administrador):
   **Authentication → Users → Add user → Create new user**, informe e-mail e senha forte e marque
   **Auto Confirm User**.
6. **Autorize** esse primeiro usuário. No **SQL Editor**, troque o e-mail e o nome e execute:

   ```sql
   insert into public.responsaveis (user_id, nome)
   select id, 'Sgt BM Fulano de Tal' from auth.users where email = 'fulano@cbm.exemplo.gov.br';
   ```

   O primeiro responsável cadastrado vira **administrador** automaticamente. **Todos os outros
   responsáveis são cadastrados pelo próprio painel** (tela **Responsáveis**, seção 6), sem
   voltar ao Supabase. Se o banco já existia, o responsável mais antigo vira administrador.
7. Copie as chaves em **Project Settings → API Keys** (ou **Data API**):
   - **Project URL** (ex.: `https://abcd1234.supabase.co`);
   - **Publishable key** (`sb_publishable_…`) — ou, em projetos antigos, a **anon key**;
   - **Secret key** (`sb_secret_…`) — ou, em projetos antigos, a **service_role key**. **Nunca** coloque esta em arquivos do site.
8. (Conferência) Em **Database → Publications → supabase_realtime**, as tabelas `participantes`,
   `posicoes`, `mensagens`, `fotos`, `setores`, `pontos_interesse`, `destinos`, `vitimas`, `grupos`,
   `grupo_membros`, `missoes`, `missao_membros` e `alertas` devem aparecer marcadas.
   O `schema.sql` (e as migrações) já fazem isso.
9. (Conferência) Em **Storage**, devem existir os buckets **`fotos`** e **`vitimas`**, **privados** (não
   públicos), com limite de 10 MB e só `image/jpeg`. O `schema.sql` cria os buckets e as regras de acesso
   (`gbs_fotos_*` e `gbs_vitimas_*`). Se o SQL Editor recusar a parte do Storage por permissão, crie os
   buckets manualmente como **privados** e rode o `schema.sql` de novo.

> O cadastro aberto de usuários por e-mail pode ficar como está: o acesso ao painel depende
> **exclusivamente** da tabela `responsaveis`, que só um administrador altera (pelo painel).

---

## 4. Publicar no Vercel (≈ 5 minutos)

### Opção A — pelo site (recomendada)

1. Envie a pasta `rastreamento-sar` para um repositório no GitHub (pode ser privado).
2. Em <https://vercel.com/new>, importe o repositório.
   - **Framework Preset**: `Other` · **Root Directory**: a pasta do projeto · sem comando de build.
3. Em **Environment Variables**, cadastre (valores do passo 3.7):

   | Nome | Valor |
   |---|---|
   | `SUPABASE_URL` | Project URL |
   | `SUPABASE_PUBLISHABLE_KEY` | chave publishable (ou anon) |
   | `SUPABASE_SECRET_KEY` | chave secret (ou service_role) — usada na limpeza diária e no cadastro de responsáveis |
   | `CRON_SECRET` | um texto aleatório longo — gere com `openssl rand -hex 32` |
   | `ORS_API_KEY` | token do openrouteservice (rota por caminhos) — crie em <https://openrouteservice.org> (Sign up → API Keys). Sem ele, o destino funciona só em linha reta |
   | `RESEND_API_KEY` | (opcional) chave do provedor de e-mail <https://resend.com> (API Keys), usada só por `/api/convidar` para o convite por e-mail. Sem ela o painel oferece abrir no seu e-mail ou copiar o link |
   | `EMAIL_REMETENTE` | (com a chave acima) remetente do convite, com domínio verificado no provedor. Ex.: `Rastreamento GBS <convite@seudominio.com.br>` |
   | `SITE_URL` | (opcional) endereço público do site, ex.: `https://busca.seudominio.com.br`. Sem ela, o link do e-mail usa o endereço da requisição |
   | `ORS_URL` | (opcional) endereço de um openrouteservice próprio; padrão `https://api.openrouteservice.org` |
   | `ANTHROPIC_API_KEY` | (opcional) chave da API de IA, usada por `/api/poa-ia` (botão "Sugerir com IA" do POA/POD) e por `/api/sci-ia` (botão "Entender com IA" do SCI). Sem ela, os botões avisam e o preenchimento manual (e a leitura de frases do próprio SCI) segue normal |
   | `GEMINI_API_KEY` | (opcional) chave do Google Gemini (<https://aistudio.google.com> → Get API key), alternativa à da Anthropic para o botão "Sugerir com IA". Modelo padrão `gemini-3.8-flash` |
   | `POA_IA_PROVEDOR` | (opcional) `anthropic` ou `gemini`. Sem ela, usa o provedor que tiver chave (Anthropic primeiro) |
   | `POA_IA_MODELO` | (opcional) troca o modelo do provedor escolhido. Padrões: `claude-haiku-5-5` (Anthropic, o mais barato) e `gemini-3.8-flash` |

4. Clique em **Deploy**.

### Opção B — pela linha de comando

```bash
npm i -g vercel
cd rastreamento-sar
vercel                      # cria o projeto (aceite os padrões)
vercel env add SUPABASE_URL production
vercel env add SUPABASE_PUBLISHABLE_KEY production
vercel env add SUPABASE_SECRET_KEY production
vercel env add CRON_SECRET production
vercel --prod
```

> Ao mudar uma variável de ambiente, faça um novo deploy (**Deployments → Redeploy**).

---

## 5. Os dois links finais

Depois do deploy, o Vercel mostra o domínio do projeto, por exemplo `https://rastreamento-sar.vercel.app`.

1. **Painel do militar**: `https://rastreamento-sar.vercel.app/militar.html`
   (o endereço raiz `/` também redireciona para ele). Faça login e crie a operação.
2. **Link do participante**: é gerado **por operação**, no botão **Convidar** do cabeçalho da operação. Há duas abas:
   - **Link para CIVIS** — `https://rastreamento-sar.vercel.app/civil.html#t=<token de 64 caracteres>`
     Quem entra por ele sempre aparece como **civil**.
   - **Link para BOMBEIROS** — outro token; permite escolher **militar** (ou civil). Compartilhe só com bombeiros.

   Cada aba tem **Copiar**, **Compartilhar** (WhatsApp etc., no celular) e **QR Code** para leitura na base.

Os links de participante **não dão acesso ao painel**, deixam de funcionar quando a operação é
encerrada, e o token fica após o `#` (não é enviado aos servidores nem aparece em registros de acesso).

---

## 6. Uso em campo

**Cadastro de responsáveis (administrador)**: na tela de operações, botão **Responsáveis**. O cadastro abre num modal (como o de nova operação); clicar numa linha da lista abre os detalhes da pessoa.
- **+ Cadastrar responsável** (modal): nome/posto, e-mail (será o login) e senha provisória (o botão **Gerar** cria uma
  senha aleatória). O login é criado na hora, sem e-mail de confirmação. O painel mostra os dados de
  acesso para copiar e repassar ao colega. Marque **Também é administrador** se ele puder cadastrar outros.
- Cada linha tem um botão **⋮** que abre o menu com as funções (redefinir senha, tornar/tirar administrador, desativar/reativar acesso, renomear, excluir); clicar na linha abre os detalhes com as mesmas ações. **Redefinir senha** (quem esqueceu), **Desativar/Reativar acesso** (corta ou devolve o acesso na
  hora; o histórico das operações é mantido), **Tornar/Tirar administrador** e **Renomear**.
- **Excluir responsável** (vermelho, pede confirmação): apaga o login e o acesso de forma definitiva. Não é
  permitido excluir a si mesmo nem quem já tem **histórico** (operação criada, mensagem enviada ou localização de
  vítima registrada), para não apagar registros da operação; a tela mostra o motivo e sugere desativar. Para quem
  só entrou por engano ou não deve mais ter acesso e não tem histórico, excluir é a opção.
- Um administrador não consegue desativar nem tirar o próprio acesso de administrador (evita
  ficar sem nenhum administrador).
- **Pedir acesso** (tela de login, link **Pedir acesso**): quem ainda não tem acesso preenche nome, e-mail e senha
  num modal. O servidor cria o login **sem acesso** e registra o pedido como pendente. Enquanto isso, quem tenta
  entrar vê "aguardando a aprovação de um administrador". Na tela **Responsáveis**, o administrador vê a seção
  **Pedidos de acesso** e clica em **Aprovar** (vira responsável comum, sem administrador) ou **Recusar**. Um
  pedido recusado pode ser aprovado depois. Quem já tem login (mesmo e-mail) não pode pedir de novo: a tela avisa.
  Não há limite de pedidos por IP; os pedidos pendentes ficam visíveis ao administrador para recusar.
- **Minha conta** (todos os responsáveis): trocar a própria senha.


**Responsável**: login → **Nova operação** (nome/código) → **Convidar** →
acompanhar o mapa. Na lista (uma linha por pessoa), tocar na linha abre a ficha e leva o mapa até a pessoa; a
**Trilha** dela fica na ficha e a de todos em **Camadas → Trilhas**. Toque no nome ou no marcador para abrir a
**ficha** (dados, precisão, conversa, fotos, histórico de posições, comandos e estado das mensagens). Os comandos
RETORNE, ATENÇÃO, MUDE A ROTA e PARE pedem confirmação antes do envio, e o texto pode ser complementado
(ex.: "Retorne ao PC 2"). No mapa, **⤢** enquadra todos e a legenda abre/fecha nela mesma; nomes,
camadas (Mapa, Topográfico, Satélite), fotos e relatos ficam em **Ferramentas** (seção 1); a lista
de participantes tem os próprios botões de ocultar/mostrar.

**Participante**: abre o link → digita nome, **CPF** (opcional) e **celular** → **INICIAR RASTREAMENTO** → permite
a localização. O **CPF é opcional** para todos (migração 029); se informado, é conferido pelos dígitos
verificadores. O celular é obrigatório para civis e opcional para militares (link dos bombeiros). Deve manter a página aberta e a tela
ligada (a opção "Manter a tela ligada" já vem marcada). Para sair, toca em **Solicitar encerramento**.

**Na ficha do participante**, o CPF aparece mascarado (`***.456.789-**`, com o botão "mostrar") e
o celular tem link para **ligar** direto.

**Participante — mensagens e fotos**: na mesma página, **Comunicação com a equipe** (escrever ou
relatar pista/vestígio/objeto/obstáculo) e **Fotos** (**TIRAR FOTO** ou **Escolher da galeria**).

**Encerrar**: **Ferramentas → Encerrar operação** → os celulares param de enviar e mostram "Operação encerrada".
**Nada é apagado** (migração 027): participantes, posições, trilhas, mensagens, fotos, setores, pontos, grupos,
fichas e registros continuam guardados para consulta e análise, e o painel abre só para visualização.

| Situação | O que acontece com os dados |
|---|---|
| Encerrar a operação | ficam guardados (painel só leitura) |
| Limpeza diária | não apaga dados de operação |
| Excluir operação | apaga tudo **e a própria operação** (some da lista), na hora — ver seção 1. É o único jeito de apagar |

A antiga escolha "Apagar dados pessoais" (ao encerrar, 24 h, 3/7/30 dias) saiu da criação da operação, e o
**Apagar dados agora** foi desativado (no painel e no servidor). Operações cujos dados já tinham sido apagados pela
regra antiga continuam abrindo com o cadastro, o diário e os relatórios.

Salvaguardas: operações esquecidas abertas por mais de 30 dias são encerradas automaticamente (sem apagar nada),
e identidades anônimas que não participam de nenhuma operação guardada há mais de 7 dias são removidas. A limpeza
roda todo dia às 07:00 UTC (04:00 de Brasília) pelo Vercel Cron, que chama `/api/limpeza` com o `CRON_SECRET`
(também apaga do Storage os arquivos de operações excluídas).

---

## 7. Segurança e privacidade

| Requisito | Como foi implementado |
|---|---|
| Consentimento explícito | o GPS só é solicitado depois do toque em INICIAR, com aviso claro sobre localização, CPF e celular; o encerramento é pedido ao responsável, que libera a saída |
| Dados pessoais (LGPD) | CPF e celular são vistos **só pelos responsáveis da operação**, validados no servidor, guardados só com dígitos, exibidos mascarados por padrão e **apagados quando a operação é excluída** (encerrar não apaga, migração 027). Recomenda-se registrar a finalidade (identificação e contato em operação de busca) no controle de tratamento de dados da corporação |
| Cadastro de responsáveis | só administradores ativos; excluir só quem não tem histórico (migração 017); a criação do login e a troca de senha passam pela função de servidor `/api/responsaveis`, que confere o administrador com o login dele e só então usa a chave secreta (que nunca vai ao navegador). Desativar um responsável corta o acesso a todas as operações na hora |
| Vários responsáveis | o acesso a cada operação vale para o criador e para quem ele (ou a equipe) adicionar; todos precisam continuar cadastrados em `responsaveis`. Remover alguém da equipe corta o acesso na hora |
| Acesso restrito ao painel | login por e-mail/senha **e** cadastro na tabela `responsaveis`; o link público não concede acesso |
| Ingresso seguro | tokens aleatórios de 64 caracteres hexadecimais (244 bits), separados para civis e militares |
| Tipo civil/militar | decidido **no servidor** pelo token usado; alterar o navegador não transforma um civil em militar |
| Autorização no backend | nenhuma tabela aceita gravação direta do navegador; toda escrita passa por funções que validam dono, operação ativa e dados |
| Separação entre operações | RLS: o responsável só lê as operações em que está na equipe; o participante só lê o próprio cadastro e as próprias mensagens |
| Coordenadas não públicas | participantes **não leem** posições nem trilhas pela base de dados. O mapa do participante usa só a função `equipe_no_mapa`, que devolve a **última posição** dos militares e responsáveis **sem grupo** da mesma operação (sem nome, CPF, telefone ou trilha) e dos **integrantes dos grupos em comum** de quem consulta (com nome e grupo, sem CPF ou telefone); posições com mais de 15 min não vão, e quem não está compartilhando some; nunca a de civis de outros grupos |
| Mensagens e relatos | o participante só lê a própria conversa; os responsáveis leem as da operação. Envio só pela função `participante_enviar_mensagem` (valida participante, operação ativa, tipo, texto ≤ 1000 caracteres, coordenadas; limite de 20 por minuto; reenvio sem duplicar) |
| Fotos | bucket **privado**: não existe link público. A imagem só é vista por **link temporário assinado (1 h)**, gerado apenas para os responsáveis da operação ou para o próprio autor. O envio só é aceito na pasta `operação/participante/` do próprio participante, com a operação ativa, JPEG até 10 MB; o registro (`registrar_foto`) confere que o arquivo existe e valida as coordenadas |
| Setores, pontos e destinos | leitura só pelos responsáveis da operação (RLS); gravação só pelas funções, que conferem a equipe da operação; excluir só por quem criou o registro, quem criou a operação ou um administrador; participantes recebem só o próprio setor, pontos de encontro/risco e o próprio destino (`mapa_do_participante`, `meu_destino` e a política `destinos_ler_participante`, que só libera a linha do próprio participante — inclusive no tempo real); um destino só é enviado a participante da mesma operação |
| IA do POA/POD | a chave da IA (`ANTHROPIC_API_KEY` ou `GEMINI_API_KEY`) fica só em variável do servidor; `/api/poa-ia` exige login e que o banco confirme (com o token da própria pessoa) que ela é responsável **da operação**; limita a 6 pedidos por minuto por usuário; **nome, CPF e telefone da vítima não são enviados** (só idade, sexo, perfil, características, roupas e o que a ficha tem de descrição) e os textos são truncados. A IA só **sugere**; nada é publicado nem gravado pela função |
| Rota por caminhos | a chave do openrouteservice fica só na variável `ORS_API_KEY` da Vercel; `/api/rota` exige login (participante ativo, só para si; ou responsável ativo), limita a 20 cálculos/min por pessoa, valida coordenadas e distância e não grava nada |
| Fichas de vítimas | tabela `vitimas` e bucket privado `vitimas`: leitura, envio e visualização da foto **só pelos responsáveis da operação** (RLS no banco e regras no Storage); participantes não têm política de leitura; gravação só por `salvar_vitima`/`definir_foto_vitima` (confere que o arquivo existe na pasta da própria ficha); apagadas com a retenção ou a exclusão da operação |
| Cadastro da operação | só responsáveis da operação editam (`atualizar_operacao`); tipo, acionamento (não pode estar no futuro), coordenadas e tamanhos validados no servidor; `info_operacao` continua entregando ao participante só o nome |
| Grupos no mapa do civil | migração 015: `equipe_no_mapa` cruza só os grupos em comum com quem consulta; nenhum colega de outro grupo sai na resposta, e a resposta não tem CPF, telefone nem trilha |
| Grupos | RLS: responsáveis da operação leem grupos, membros e links; o participante lê **só os grupos de que é membro ativo** e a própria linha de membro (função `eh_membro_grupo`, security definer, sem recursão); os links ficam em `grupo_convites`, que só os responsáveis leem; o link do grupo nunca concede o papel de responsável; chaves compostas garantem que grupo e pessoa são da mesma operação |
| Deslocamentos e alertas | `missoes`, `missao_membros` e `alertas`: leitura só pelos responsáveis da operação; eventos calculados no servidor a partir das posições gravadas (o celular não informa "cheguei"); finalizar a busca: só o responsável da operação ou o responsável do grupo da missão; cada evento gera um alerta só (chave única); `verificar_retornos` sem operação só roda pelo agendador (`pg_cron`) |
| Fila offline | o celular só marca um ponto como enviado quando o servidor confirma o id; usuário e operação de cada ponto vêm sempre da sessão no servidor (os ids guardados no aparelho são só para diagnóstico) |
| Remover e reincluir | remover não apaga dados; reincluir só por responsável da operação ativa (`reincluir_participante`), reativando o mesmo registro; histórico em `participacao_eventos` (só responsáveis leem); participante não remove nem reinclui ninguém |
| Exclusão de operação | o criador ou um administrador da equipe (`excluir_operacao`, verificado no banco); só o administrador exclui operação com atividade (migração 020); transação única; arquivos removidos do Storage com fila de pendências e limpeza diária; tokens invalidados na hora |
| Validação de dados | latitude/longitude/precisão/horário validados no servidor; lote máximo de 500 pontos; orientação até 500 caracteres; limite de 60 orientações por minuto e de 300 participantes por operação |
| Segredos | só a chave **pública** chega ao navegador (via `/api/config`, lida de variável de ambiente). A chave secreta fica no servidor (`/api/limpeza`) |
| Cabeçalhos | CSP restritiva, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` (envia só o domínio do site, exigido pelo OpenStreetMap; o token do link fica após o `#` e nunca é enviado), `Permissions-Policy` (geolocalização só no próprio site) |
| Bibliotecas externas | carregadas com versão fixa e verificação de integridade (SRI) |

**Domínio próprio no Supabase**: se usar um domínio personalizado no Supabase, acrescente-o ao
`connect-src` **e ao `img-src`** (links assinados das fotos) da política CSP em `vercel.json`.

**CSP e o relevo 3D**: o 3D carrega os ladrilhos por `fetch` e usa um *web worker* criado pela própria
biblioteca; por isso a CSP permite `connect-src` aos servidores de mapa/terreno e `worker-src blob:`.
Os scripts continuam restritos aos CDNs com SRI (a biblioteca 3D também tem verificação de integridade).

---

## 8. Limitações dos navegadores e alternativas

Estas limitações são da plataforma web móvel, não do código, e estão comunicadas na própria página do participante.

1. **Tela apagada / outro aplicativo aberto — não é possível com uma página web.** Quando a página
   sai da tela, o Chrome do Android (e o Safari do iPhone) **param de entregar o GPS** para ela, e
   não existe permissão que um site possa pedir para mudar isso. Por isso o rastreamento contínuo
   em segundo plano **exige um aplicativo instalado** (ver a proposta abaixo). Na versão web:
   - a página pede para **manter a tela ligada** (Screen Wake Lock API, suportada no Chrome para Android);
   - ao voltar para a página, a posição é retomada, a fila é enviada e o participante vê um aviso
     informando por quanto tempo a página ficou pausada;
   - o painel nunca apresenta uma posição antiga como atual: mostra o horário e marca o participante
     como instável ou sem atualização.
2. **Gravação offline** só acontece enquanto a página estiver aberta e ativa; não há gravação com a página fechada.
   Mas a página **reabre sem internet**: quem já estava na busca neste aparelho e recarrega (ou fecha e abre de novo o
   link) sem sinal volta direto ao rastreamento, com a sessão e a fila guardadas; o servidor confere a participação
   quando o sinal voltar.
3. **Mapa sem internet** (página do participante): ao ter a primeira posição boa, a página guarda no aparelho o mapa
   (OpenStreetMap) num raio de ~3 km, em zoom 10 a 16, e guarda outra área quando a pessoa se afasta mais de 1,5 km das
   já guardadas ou recebe um destino (até 4 áreas; uma nova apaga a mais antiga). Respeita a política de uso do
   tile.openstreetmap.org: no máximo 250 quadros por área em zoom ≥ 13 (aqui ≤ 240), baixados um por vez. Embaixo do
   mapa aparece "Mapa guardado no aparelho: N área(s)…" com a conferência de quantas partes estão de fato guardadas.
   Fora dessas áreas, sem internet, o mapa fica em branco; a posição continua sendo registrada normalmente.
3. **Mensagens com a página fechada** não chegam. Com a página aberta em segundo plano, o celular
   vibra, toca um alerta e, se o participante tocou em **Ativar alertas de mensagem**, mostra uma
   notificação, desde que o navegador ainda esteja executando a página. Para entrega garantida com a
   página fechada seria necessário **Web Push** (servidor com chaves VAPID e assinatura de push),
   e mesmo assim o rastreamento continuaria limitado.
4. **iPhone (Safari)**: a localização com a tela bloqueada é ainda mais restrita, e as notificações
   web só funcionam com o site instalado na tela inicial (iOS 16.4+).
5. **Precisão**: depende do aparelho e do céu aberto. Em mata fechada ou entre prédios, ±20–50 m é comum.
   Isso vale também para a **distância e a direção** da navegação e para a **cobertura estimada** dos setores.
6. **Bússola** (navegação): depende do sensor do celular; perto de metal ou de veículos pode errar. No
   iPhone exige permissão. Sem bússola, a seta aponta em relação ao Norte.
7. **Altitude** (pontos e 3D): é a do **modelo de terreno** (≈ 30 m de resolução), não a medida pelo
   GPS; em encostas e vales estreitos pode diferir dezenas de metros.
6. **Fotos e mensagens com a página fechada**: na página do participante, ficam guardadas no aparelho e
   são enviadas quando ele voltar à página. No painel do responsável, a fila de fotos fica só na memória:
   o painel avisa antes de ser fechado com foto pendente.
7. **Câmera**: "TIRAR FOTO" abre o aplicativo de câmera do próprio celular. No computador, o botão abre
   a escolha de arquivo. Fotos HEIC muito grandes podem não abrir em navegadores antigos (a pessoa é avisada).
8. **Lida por**: indica que algum responsável abriu a central ou a conversa; não garante que a
   pessoa leu com atenção.

### Solução para segundo plano: aplicativo Android (rastreamento com a tela apagada)

Para o rastreamento continuar com a tela apagada ou com outro aplicativo aberto, o caminho é um
aplicativo Android instalado no celular do participante, **reaproveitando todo este backend**
(mesmas tabelas, funções, regras de segurança e o mesmo painel; o participante entra pelo mesmo
link/QR Code e informa nome, CPF e celular):

- **Foreground Service** do tipo `location` com notificação permanente ("Rastreamento GBS ativo"),
  que o Android não encerra em segundo plano;
- **FusedLocationProviderClient** (Google Play Services), com intervalo de 5–10 s e prioridade de alta precisão;
- fila local em **Room/SQLite** e envio com **WorkManager** quando houver rede (mesma RPC `enviar_posicoes`, com o mesmo identificador por ponto para não duplicar);
- **Firebase Cloud Messaging** (prioridade alta) para entregar os comandos mesmo com o app fechado,
  disparado por um gatilho no banco ao inserir em `mensagens`;
- permissões `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE_LOCATION` e
  `POST_NOTIFICATIONS`, além de orientação para retirar o app da otimização de bateria.
  Para publicar na Play Store, o uso de localização em segundo plano passa por declaração e revisão do Google. Para uso interno, o app também pode ser distribuído direto (APK ou gerenciamento de dispositivos).

---

## 9. Roteiro de teste com celulares reais (critérios de conclusão)

Use dois celulares Android com Chrome atualizado e dados móveis (de preferência um em Wi-Fi e outro em 4G).

| # | Teste | Resultado esperado |
|---|---|---|
| 1 | Militar faz login e cria a operação | painel abre e mostra o convite com QR Code |
| 2 | Civil lê o QR Code em outro celular, digita o nome e toca INICIAR | o celular pede permissão; após aceitar, mostra "RASTREAMENTO ATIVO" |
| 3 | Aguardar até 20 s | o marcador verde **C** aparece no mapa, na posição real |
| 4 | Civil caminha por 2–3 minutos | a trilha tracejada verde é desenhada |
| 5 | Observar o painel | horário "há X s" e posição atualizam sozinhos |
| 6 | Tocar na pessoa na lista e em **Trilha** na ficha; depois em **Camadas → Trilhas** (desliga todas) e de novo | a trilha some/volta; o marcador continua andando e o histórico da ficha continua crescendo |
| 7 | Tocar no nome ou no marcador | abre a ficha com coordenadas, precisão, horários e histórico |
| 8 | Na ficha, enviar **PARE** | o operador confirma o envio; o painel mostra "Enviada" |
| 9 | No celular do civil | alerta em tela cheia com vibração; ao tocar **CONFIRMAR**, o painel mostra "Recebida pelo aparelho" e depois "Confirmada às …" |
| 10 | Pôr o celular do civil em modo avião por 1–2 min, andando | o civil vê "Sem internet · N posições guardadas"; o painel passa a "Sinal instável" e depois "Sem atualização", com o marcador desbotado |
| 11 | Desligar o modo avião | os pontos guardados chegam, a trilha é completada sem duplicar e o estado volta a "Conectado" |
| 12 | No celular do civil, abrir `/militar.html` | pede login; com a sessão do civil não há acesso ao painel nem às posições |
| 13 | Encerrar a operação | o celular mostra "Operação encerrada"; no painel a operação abre só para consulta e todos os dados continuam (só saem ao excluir) |
| 14 | No celular do civil, tocar em **Solicitar encerramento** | o painel toca alarme e mostra "Pediu para sair"; o rastreamento continua; ao **Liberar saída**, o celular mostra "Saída liberada" |
| 15 | Adicionar um segundo responsável em **Equipe** e abrir a operação nos dois painéis (**Minha posição** liga sozinha) | cada um vê o outro no mapa (losango vermelho com R); mensagem de um para o outro chega como alerta |
| 16 | Abrir o painel no celular (em pé e deitado) e no tablet | mapa, lista e ficha ficam utilizáveis, sem rolagem lateral |
| 17 | No celular do civil, tocar **ENCONTREI ALGO → Possível pista**, escrever e enviar | o painel avisa com som, o botão **Mensagens** mostra 1, o marcador laranja aparece no mapa; ao abrir, o civil vê "Lida por …" |
| 18 | Responder pela ficha (**Conversa**) | o civil recebe o alerta em tela cheia e confirma |
| 19 | No civil, **TIRAR FOTO** → conferir → **SALVAR FOTO** | a câmera aparece no mapa no ponto; tocar abre a foto com autor, horários e coordenadas; **Ampliar** mostra em tela cheia |
| 20 | Repetir com o celular em modo avião | a foto fica "Na fila"; ao voltar a internet, é enviada sozinha |
| 21 | **Ferramentas**: trocar camada, ocultar nomes, ocultar a lista | cada opção funciona e o menu fecha; com a lista oculta, o mapa ocupa a tela e **« Participantes** reabre |
| 23 | **Setor** (topo) **→ Por raio**: tocar no centro, raio 300 m, atribuir a um civil; depois desenhar outro setor por cantos | os dois aparecem com nome e situação; o civil vê "Seu setor" no celular; recarregar a página não os perde |
| 24 | Marcar um **Ponto de encontro** e **Enviar como destino** ao civil; ele anda em direção ao ponto | o celular mostra distância e direção que diminuem/atualizam; testar com o GPS desligado (aviso "Sem GPS") |
| 25 | Trocar para **Topográfico** e abrir **Relevo em 3D** numa região com morros | curvas de nível visíveis com trilhas e setores por cima; o 3D mostra os morros e a altitude ao tocar |
| 22a | No celular do civil, olhar o mapa com um militar andando e o responsável com "Minha posição" ligada | aparecem o ponto azul (você), o **M** vermelho e o **R** vermelhoo; outros civis não aparecem |
| 22b | No civil, tocar **FALAR COM OS BOMBEIROS**, escrever e enviar; responder pelo painel (ficha → Mensagens) | a conversa abre só ao tocar; a resposta chega como "Bombeiros" e o botão mostra o número de novas |
| 22 | Criar uma operação de teste, registrar dados (diário, relatório) e **Excluir operação** (confirmar) | some da lista; o link/QR do participante para de funcionar; no Supabase, **Storage → fotos** não tem mais a pasta da operação |
| 26 | Celular parado sobre uma mesa por 5 min | a trilha não vira um "novelo"; no diagnóstico (`&diag=1`) aparecem leituras descartadas como "oscilação parado" |
| 27 | Enviar um destino a um civil com a página dele aberta | o cartão **IR ATÉ** aparece em poucos segundos, sem recarregar; a ficha mostra "✓ recebido no celular" |
| 28 | Remover um civil e depois tocar em **Reincluir** | o celular dele mostra "Os bombeiros chamaram você de volta"; ao tocar, volta ao mesmo registro e a trilha continua |
| 29 | No celular do civil, negar a localização e depois liberar pelas configurações | a página explica os passos e continua sozinha ao liberar (ou em VERIFICAR DE NOVO), sem novo cadastro |
| 30 | Abrir uma operação nova no painel do celular | "Minha posição" liga sozinha (depois da permissão) e não tem opção de desligar; tocar nela não duplica o envio |
| 31 | Andar 5 min em rua e 5 min em mata, com o painel aberto | a trilha acompanha (pontos a cada poucos segundos); na ficha, coluna "Chegou" com poucos segundos |
| 32 | Ir de carro por 2–3 km com a página do civil aberta | a trilha segue o percurso do carro quase em tempo real, sem "saltos" descartados |
| 33 | Enviar um destino "A pé" e depois trocar para "Carro" no celular | rota azul por ruas, com tempo e instruções; ao trocar, recalcula pelas vias de carro; ao sair da rota, recalcula |
| 34 | Ficar 2 min sem sinal de GPS andando (ex.: túnel/mata densa) | a trilha mostra o trecho sem dados **tracejado em cinza**, com ○ início e ● fim da falha (tocar mostra os horários), não como linha contínua |
| 35 | Criar uma operação nova preenchendo tipo "Outras" (com o texto), acionamento, endereço, ponto no mapa e descrição | o painel abre com o ◎ do local no mapa; **Dados da operação** mostra tudo; uma operação antiga aparece com "Cadastro incompleto" e pode ser completada |
| 36 | **Vítimas → Nova ficha** com foto; abrir o mesmo painel com outro responsável e, num celular de participante, tentar ler `vitimas` | o outro responsável vê a ficha (tempo real); o participante não recebe nenhuma linha nem consegue abrir a foto |
| 37 | Criar os grupos "Polícia Civil" e "Bombeiros", adicionar pessoas, marcar um responsável ★ e enviar o link do grupo a um celular novo | quem entra pelo link aparece no grupo (selo na lista); no celular, "Grupo Polícia Civil"; ele não vê o outro grupo |
| 38 | No controle **Grupos** do mapa, tocar no 👁 de um grupo e depois de novo | só as pessoas, trilhas e destinos do grupo ficam visíveis, sem aviso no mapa, com o olho destacado e o título "· filtrado"; um pedido de ajuda de fora do grupo continua tocando; o segundo toque restaura tudo |
| 39 | Marcar uma **Base**, enviar o centro de um setor ao grupo (só o responsável), andar até o setor, tocar **BUSCA NO SETOR CONCLUÍDA** no celular do responsável do grupo e voltar à base | alertas: início do deslocamento, chegada ao setor, busca finalizada e equipe na base, em tempo real; o celular passa a mostrar "Volte para a base" |
| 40 | Repetir com prazo de retorno de 5 min e um membro que não volta (ou com o celular em modo avião) | ao vencer o prazo, faixa vermelha "EQUIPE PODE ESTAR PERDIDA" com o alarme repetindo até **Ciente**, mesmo com o painel fechado durante o prazo (com `pg_cron` ativo) |
| 40a | Enviar destino a um grupo com **retornar até** daqui a 5 min, tolerância 0, e deixar um membro longe da base; noutro celular do grupo, ligar o modo avião por 12 min | no horário, faixa "RETORNO ATRASADO" com quem falta; após 10 min sem contato, "SEM COMUNICAÇÃO — nome" com a última posição; ao religar, aviso "Comunicação restabelecida" com as posições gravadas sem internet |
| 40b | Na ficha de um participante, **📍 Rota até ela** saindo da base, e ele andar 100 m | a rota aparece com a barra embaixo e se refaz sozinha; **Parar** apaga |
| 40c | **Ferramentas → Personalizar tela**: arrastar **Foto** para fora do topo, arrastar **Grupos** da bandeja para o 2º lugar, arrastar o painel de grupos para o canto inferior esquerdo, texto **Maior**, **Concluir** e recarregar | Foto passa a ficar em Ferramentas e funciona de lá; Grupos aparece no topo e abre a lista de grupos; o painel de grupos fica no canto escolhido; tudo continua igual depois de recarregar; **Padrão** desfaz |
| 40d | Abrir os modais (Encerrar, Vítima encontrada, Marcar ponto, Enviar destino, Relatório final) no computador e no celular | título com **i** e **×** no topo; ações sempre visíveis embaixo; no celular, folha de baixo sem rolagem lateral |
| 40e | Civil entra na busca com internet e espera aparecer "Mapa guardado no aparelho"; liga o modo avião, **recarrega a página** e anda 2 min; desliga o modo avião | a página reabre direto no rastreamento, o mapa da área aparece, os pontos ficam na fila e chegam ao painel quando o sinal volta |
| 40f | Num relato de vestígio: **Detalhes e revisão → Revisar**, escolher **Confirmado** sem justificativa; depois com justificativa e hora do fato estimada | sem justificativa não salva; salvo, o relato mostra Fato (estimado), Recebido e Revisado, "Versões da revisão (1)" e o selo **Confirmado** no feed |
| 40g | **Ferramentas → Binômio → + Nova sessão** (cão, condutor participante, setor, artigo de odor), **Iniciar**, andar 2 min com o condutor, **⚑ Indicação**, **Confirmar por outro meio** sem método e depois com "Equipe no local" | a trilha roxa do condutor aparece no mapa só durante a sessão; I1 "em análise" no mapa; sem método não confirma; C1 "pendente" até o **Resultado** |
| 40h | **Ferramentas → Drone e água**: importar o GPX do voo em **+ Telemetria**, marcar um **+ Foco térmico** no mapa e descartá-lo com justificativa; na aba Água, **+ Indicação na água** sem mexer na corrente | a linha do voo aparece; o foco começa "a verificar" e fica riscado ao descartar; a indicação mostra "Corrente: desconhecida" e a fonte do vento |
| 40i | Ficha da vítima com idade 70 e **estimada**; IPO com o último momento visto **estimado**; abrir o Dashboard geral | a ficha mostra "cerca de 70 anos (estimada)", os Dados da operação "(estimado)"; o cartão **Qualidade dos dados** mostra unidade, válidos, ausentes, não localizados e duplicatas |
| 40j | Tocar no marcador da vítima localizada; depois **O que aconteceu ›** | o balão mostra o nome da vítima, a condição, quem encontrou e o local; a janela mostra setor, distância do ULV, quem encontrou e quem estava a até 300 m |
| 40k | **Ferramentas → Cadastro rápido de vítima**: só **Idoso**, **Feminino** e a roupa → **Salvar e novo**; depois só o nome → Enter | duas fichas "completar" na lista de vítimas; abrir uma e tocar em **Completar a ficha** tira a marca ao salvar |
| 40l | **Novo grupo**: tocar em **＋**, escolher uma cor pelo tom/claridade, **Guardar em "Minhas cores"**, criar outro grupo e reutilizá-la; repetir no **Setor** | a cor escolhida aparece no marcador, na trilha e na lista; "Minhas cores" aparece nos dois formulários |
| 40m | Aproximar o mapa de uma equipe de 3 pessoas a ~15 m uma da outra, do zoom 16 até o 20 | até o zoom 18 ficam num círculo com o número; a partir do 19 se separam; os ícones diminuem do 17 em diante e a vítima localizada continua grande |
| 40n | **Convidar → ✉ Convidar por e-mail** com nome e e-mail reais; abrir o e-mail no celular e o link | o e-mail chega com o botão; a página abre com o nome preenchido; ao começar, o convite passa a **Entrou**; sem `RESEND_API_KEY`, aparecem **Abrir no meu e-mail** e **Copiar link** |
| 40n2 | Com uma ficha de vítima cadastrada, abrir **SCI → Vítimas**; no celular de campo, **Encontrei a vítima** | a ficha aparece em Procuradas e passa sozinha para Localizadas (com o nome) em poucos segundos; o marcador no mapa tem **Abrir no SCI** |
| 40n3 | Com um grupo em deslocamento e um pedido de ajuda aberto, abrir o SCI | Visão geral: equipe em missão, alerta crítico do pedido de ajuda; aba Equipes: grupo com ★, deslocamento e recursos; linha do tempo com o diário |
| 40o | **SCI → Modo teste**, registrar 2 vítimas e "despacho 7h15", **Sair do modo teste (zerar)** | quadro vazio, total [PENDENTE], linha do tempo vazia; o diário não tem os registros de teste |
| 40p | No SCI: "duas vítimas localizadas na água", arrastar V-01 para a ACV, tocar e triar amarela; "V-02 na ACV, vermelha"; "segurança: Sgt Dinardi" | quadrados nos quadros certos, cor só depois da ACV, alerta crítico da V-02 vermelha e o de segurança some ao designar |
| 40q | Abrir **↗ Outra janela** no celular de outro responsável, sem estar logado | pede o login; depois mostra o painel e se atualiza sozinho quando o PC registra algo |
| 40r | Falar no 🎤 "SAMU no local com 5 pessoas" e conferir | órgão SAMU no local com 5 pessoas e hora de chegada; faixa de órgãos atualizada; entra na linha do tempo e no diário |
| 40s | **Convidar → ☎ WhatsApp**, categoria **Bombeiro**, nome e celular de alguém que não está nos contatos → **Enviar pelo WhatsApp** | o WhatsApp abre a conversa com o número, com a mensagem e o link dos bombeiros; quem abre pode escolher militar; repetir com **Responsável** manda o endereço do painel |
| 40t | **Marcar ponto → ＋ Novo tipo** "Pouso de helicóptero", ícone 🚁, cor roxa → **Criar tipo** → **Marcar ponto**; depois **Editar tipos** e trocar a cor | o ponto aparece com 🚁 roxo; outro responsável vê o tipo na lista; ao trocar a cor, o ponto já marcado muda junto |
| 40u | Operação **sem setores**, com trilhas e pontos → **Relatório final (PDF)** | a seção de setores mostra "Mapa geral da operação" com trilhas, pontos (com os ícones dos tipos), relatos e fotos |
| 41 | Pôr o celular do civil em modo avião por 3 min andando, recarregar a página ainda sem internet e depois religar | os pontos continuam guardados (diagnóstico `&diag=1`: "guardados em: indexeddb"); ao voltar a internet, chegam todos, na ordem, sem duplicar |

### Testes já realizados no desenvolvimento

- **Convites por categoria/WhatsApp e tipos de ponto (migração 047)**: banco — 889 verificações (convite por WhatsApp com telefone normalizado, link por categoria, tipos de ponto com permissão de edição, pontos acompanhando o tipo, relatório com nome/ícone/cor do tipo); navegador — convites por WhatsApp/e-mail com categoria e tipos de ponto (criar, marcar, voltar à categoria fixa) a 1280 e 390 px.
- **SCI integrado (migração 046)**: banco — 868 verificações (vítima encontrada entra sozinha no quadro, com os dados da ficha, completando
  a que já estava lançada, óbito como cinza, sem duplicar no diário; `sci_contexto` com comando, briefing, fichas, localizações, equipes,
  participantes, pontos, setores, alertas, decisões, verificação e diário, só para os responsáveis; instalação ligada a ponto); unitários —
  procuradas pelas fichas e alertas do app no SCI. Navegador (1280 px e 390 px): CI do comando, números do app, mapa, diário nos últimos
  registros, ficha arrastada para "Localizadas" abrindo o "Vítima encontrada" do app e voltando ao SCI, PC ligado à base do mapa, equipes
  dos grupos com missão no SCI, linha do tempo única com filtro e marcos sugeridos, objetivo salvo no briefing, pedido de ajuda como
  alerta crítico; janela própria registrando a vítima encontrada pelo mesmo fluxo.
- **Painel de comando SCI (migração 045)**: banco — 852 verificações (migrações 007–045: funções e total com eventos automáticos, marcos com
  correção e retirada, vítimas numeradas com horários de cada passo e correção de fase, óbito como segurança, registro manual, confirmação,
  correção com histórico, anulação com motivo, espelho no diário, itens validados por tipo, imagens no bucket privado, acesso só dos
  responsáveis, modo teste sem diário e zerar, encerrada, retenção e exclusão); unitários — regras do SCI com os dados e as frases do
  simulado Três Bocas (totais, alertas, resumo, imprensa, 14 frases, divergências, normalização) e o endpoint `/api/sci-ia` com a rede
  simulada. Navegador (Playwright, 1280 px e 390 px): abrir o SCI, marco por frase com hora, vítimas (nova, arrastar para a ACV, ficha,
  triagem com cor), frase de vítima com alerta crítico, funções e acompanhamento remoto, órgão por frase, total não confirmado, rio
  subindo, registro não confirmado e confirmação, "O que falta"; janela própria com sessão, encerrada (só consulta) e com login.

- **Cadastro rápido, vítima no mapa, cor livre, agrupamento e convite por e-mail (migração 044)**: banco — 800 verificações
  (migrações 007–044: ficha rápida, completar tira a marca, vítima só com o nome nasce rápida; convite com e-mail normalizado,
  reaproveitado, limite de envios, só o nome pelo código, aceite só do próprio participante, e-mails apagados na retenção);
  unitários — conversão de cor, cor livre e escala dos ícones por zoom, e o endpoint `/api/convidar` com a rede simulada
  (login, link montado no servidor, HTML escapado, provedor ausente ou recusando). Navegador (Playwright, 1280 px e 390 px): balão
  e janela da vítima localizada, cadastro rápido (Salvar e novo, Enter), seletor de cor em grupo e setor (código, tom, minhas cores),
  aba de convite por e-mail (e-mail inválido, sem provedor, envio) e agrupamento/tamanho por zoom 12–20; página do participante
  com convite válido, desconhecido, malformado e sem convite.

- **Verificação e qualidade dos dados (migrações 042–043)**: banco — 770 verificações (migrações 007–043: revisão de
  relatos com versões, justificativa e hora do fato; idade estimada sem zero; binômio com transições, I/C numerados,
  método obrigatório e pausas; drone e água com estado inicial pelo tipo e geometria validada; somente leitura na
  operação encerrada; denominadores do estudo com ausentes, censurados e duplicatas). Navegador (Playwright, painel com
  Supabase falso, 1280 px e 390 px): revisar relato (justificativa obrigatória, três horários, versão e selo no feed),
  sessão do binômio completa (criar, iniciar, indicação na posição do condutor, confirmação com método, pausar, marcadores
  no mapa), drone e água (foco marcado no mapa voltando ao formulário, telemetria lida de GPX, descarte com justificativa,
  corrente desconhecida), idade estimada, hora do último momento visto estimada e cartão de qualidade do Dashboard.

- **Pedidos de ajuda, recursos e briefing (migrações 035–037)**: banco — 638 verificações (migrações 007–037: pedido
  criado pela mensagem de ajuda, máquina de estados no servidor, ciente não resolve, baixar prioridade e encerrar exigem
  justificativa, reabrir, histórico imutável, escalonamento sem repetir, participante só vê o próprio pedido, recursos e
  disponibilidade só por RPC, briefing com os dados existentes, passagem só do comandante, aceite muda o comando,
  recusa com motivo, assunção com motivo, passagem imutável, encerrada só leitura). Navegador (banco simulado — 38):
  pílula e tempo sem atendimento, fluxo completo do pedido, justificativas, recursos e avisos, confirmação de envio a
  equipe em descanso, briefing, decisões, texto copiável, passagem, aceite e assunção. **Não testado**: Supabase real
  com 035–037 aplicadas e celulares físicos.
- **Cadastro, vítimas, grupos, trilha offline e deslocamentos (versão 2026-10-13)**: `npm test` passa —
  filtro de GPS com o intervalo de 15 s e a falha por tempo (39 verificações), coordenadas (45) e a
  **fila offline** (20: pendentes em ordem do GPS, campos de cada ponto, sem conexão, recarregar, confirmação
  só do que o servidor gravou, recusados, reenvio sem duplicar, servidor sem a migração 009, migração da
  fila antiga, limpeza). **Banco (77 verificações)**: `npm run test:banco` executa o `schema.sql` num
  **PostgreSQL real** (PGlite, no Node) com o Supabase simulado (papéis, `auth.uid()`, Storage com RLS,
  publicação do Realtime): instalação nova, reexecução idempotente do `schema.sql` e das migrações
  007–010, RLS das tabelas novas (participante não lê vítimas, links nem alertas; vê só os próprios
  grupos), regras do bucket `vitimas`, ingresso pelo link do grupo, lote com confirmação por ponto e o
  fluxo completo do deslocamento (início, chegada ao setor, finalização pelo responsável do grupo,
  retorno atrasado e chegada à base), retenção e exclusão. **Ainda não executados**: o Supabase real
  (Realtime, API do Storage, `pg_cron` agendado) e as telas novas num navegador e em celulares — faça os
  testes 35 a 41 do roteiro acima antes do uso operacional.

- **Backend (318 verificações)**: o `schema.sql` foi executado num PostgreSQL 16 com PostgREST, usando o
  supabase-js real, inclusive por cima de um banco da versão anterior (sem perda); as migrações 004 e 005
  foram aplicadas duas vezes seguidas (idempotentes). Cobre RLS e permissões, posições, mensagens,
  responsáveis, retenção e limpeza, fotos, exclusão, setores/pontos/destinos, remover/reincluir, destino do
  participante e, agora, o **modo do destino** e a **função `/api/rota`** (quem pode pedir, participante só
  para si, coordenadas e distâncias inválidas, serviço fora do ar, sem chave configurada, perfis a pé/
  trilha/carro, altitude, inclinação, instruções em português, chave nunca exposta) e o **raio do alarme**
  das áreas de risco (limites, edição, entregue ao participante, civil não cria área de risco).
- **Navegador (104 verificações)**, com **Realtime simulado que aplica o RLS**, simulador de GPS/permissão e
  **openrouteservice simulado** (mesmo formato de resposta da API real): localização do responsável,
  permissões, parado, **andando (~1 ponto a cada 3 s)**, **atraso medido: nova posição no painel em ~1,5 s
  (mediana) e captura → servidor em ~1,5 s**, **carro a 72 km/h: 29 pontos em 30 s**, salto descartado,
  **lacuna desenhada à parte**, precisão ruim, GPS desligado, destino em < 1 s (tempo real) e ~15 s (sem),
  **rota a pé com tempo, subida, trechos íngremes e instruções**, **troca para carro/trilha com o perfil
  certo**, **recálculo ao sair da rota**, rota na ficha do painel, isolamento entre participantes,
  recarregar a página, remover/reincluir, menu e aviso de versão nova.
- **Filtro de GPS (31) e coordenadas (45 verificações)**: `npm test` — conversões UTM/MGRS/GMS conferidas
  com valores de referência, ida e volta, zonas e hemisférios, rumo e horários do sol.
- **Ferramentas de mapa (46 verificações)**: formatos de coordenada, toque longo (coordenadas, altitude,
  distância/rumo), ir para coordenada (UTM, MGRS, GMS), medir distância/rumo/área e salvar como setor,
  exportar GPX/KML/GeoJSON/CSV (e reimportar o GPX), importar GPX/KML/KMZ/GeoJSON/CSV, transformar em
  pontos e setores, estatísticas e perfil de altitude, alarmes de proximidade (saída do setor, entrada em
  área de risco, no painel e no celular), anéis de distância e "Onde estou" do participante.
- **Setores, pontos, navegação, topográfico e 3D (42)**, **ponta a ponta (143)** — sem tempo real, com
  movimento realista e queda de internet — e **administração (20)**: todos passando.
- **Topo, menu em lista e ficha (versão 2026-10-24)**: navegador (t29 — 16): 5 ações no topo (computador) e numa faixa
  (celular, sem rolagem lateral), Dashboard pelo topo, Setor pergunta desenhar/raio e cada opção inicia o desenho certo,
  Camadas sem "Agrupar" e o agrupamento ligado mesmo com a preferência antiga desligada, ficha sem selos e com ✕, abas
  Conversa/Dados (abre na Conversa), pedido de ajuda e orientações sem cores fortes, Dados sem coordenadas repetidas;
  t21 ajustado (menu em lista, sem subgrupos).
- **Formulários e modais horizontais (versão 2026-10-23)**: no computador e no tablet deitado, modais com formulário
  ficam largos (até 940 px) com os campos em **duas colunas** (textos de ajuda, abas, listas de opções grandes e botões
  na linha toda; opções como "A pé / Trilha / Carro" lado a lado) e fichas de dados com dois pares por linha. Celular e
  tablet em pé continuam em uma coluna. Navegador (t28 — 23): camadas agrupadas sem repetição, Mostrar tudo, meteorologia
  acima da legenda (liga/desliga, painel sem cobrir o botão), modais em 2 colunas sem rolagem no computador e em 1
  coluna no celular/tablet em pé, natureza com 3 opções, gráfico por mês com aquática × terrestre, por tipo com Outros,
  **↗ Abrir em outra janela** no Dashboard (geral ou da operação): abre `dashboard.html`, uma janela só com o
  dashboard, sem o mapa nem o painel. Abrir de novo reaproveita a mesma janela. A janela usa a mesma sessão do
  painel (`data-pagina="militar"` no `dashboard.html`: a sessão é guardada por página); quem já entrou não entra de novo.
- **Mapa limpo (versão 2026-10-23)**: navegador (banco simulado, t27 — 23): nenhum nome no mapa, balão no clique
  (preso ao ponto) sem abrir a ficha, ficha por dois cliques (sem zoom), por clicar e segurar e pelo toque longo, arrastar
  não abre, lista abre direto, ficha com "⋮ Mais", símbolos e agrupamentos menores de longe, translúcidos (quem pede
  ajuda opaco), trilhas finas, setor com balão e detalhes compactados; regressão t9–t26 ajustada e passando.
- **Rota até um participante e controle de tempo (versão 2026-10-23)**: banco — 415 verificações (migrações
  007–032: prazos gravados só pelos responsáveis da operação, horários inválidos recusados, início atrasado uma vez
  por horário combinado, retorno atrasado com quem falta, sem comunicação com a última posição, restabelecida com
  as posições que chegaram atrasadas, sem repetição pelo `pg_cron`, nada depois da base ou do encerramento, diário).
  Navegador (banco simulado, t26 — 31): rota da base, de outro participante e do GPS (sem GPS explica), linha reta
  sem internet, Parar, Mandar alguém até ela, prazos no envio ao grupo (validação, sem duplicar o envio, banco sem a
  032), lista com situação dos horários e coluna de contato, edição, faixa e aviso de comunicação.
- **Vítima encontrada e encerramento com resultado (versão 2026-10-23)**: banco — 379 verificações (migrações
  007–031: ficha escolhida ou criada, estado, local, quem encontrou fora do sistema, alerta e diário com os detalhes,
  permissões, participante não lê, resultado + encerramento, encerrada recusa). Navegador (banco simulado): formulário
  completo pelo botão, encerramento com vítima já registrada, sem registro (abre o mesmo formulário, Voltar sem
  perder o texto, óbito), não localizada, outro desfecho, sem resultado, banco sem a 031 (18).
- **Trilhas de equipes e drones, arquivos e trajetos (versão 2026-10-23)**: `npm test` inclui as rotas desenhadas
  (18: distância, tempo, curvas com tremor de mão ignorado, progresso, simplificação até 2000 pontos, escolha
  traçado × cálculo). Banco — 365 verificações (migrações 007–030: meio/cor/origem, trajeto para pessoa e grupo,
  o participante recebe o trajeto, permissões, encerrada). Navegador (banco simulado): desenhar e enviar trajeto a
  pessoa e grupo, cancelar sem perder, ficha com o trajeto, KML com estilos, edição de nome e cor, registrar como
  trilha de drone, linha importada como trajeto (40, computador e celular), e o celular seguindo o trajeto com
  instruções e aviso ao sair da linha, mais GPX/GeoJSON (10).
- **Menu, nomes no mapa, renomear, legenda e CPF opcional (versão 2026-10-22)**: banco — 347 verificações
  (migrações 007–029: civil sem CPF, CPF inválido recusado, celular continua obrigatório, nome de exibição,
  novo ingresso não apaga o nome, outro responsável/participante não renomeia, gravação direta recusada,
  encerrada só leitura). Navegador (banco simulado, computador e celular): menu (atalhos, grupos), nomes
  abreviados e sem colisão, nome completo ao passar o cursor, renomear participante e ponto, legenda
  editada/ocultada/restaurada e lembrada após recarregar (38), e página do participante entrando sem CPF (5).
- **Mapa do dashboard e trilhas desenhadas (versão 2026-10-21)**: banco — `npm run test:banco` (334
  verificações, migrações 007–028: criar planejada/percorrida, ordem dos pontos, sem duplicar pelo client_id,
  nome repetido, geometria inválida, outro responsável não lê/altera/exclui, gravação direta recusada,
  encerrada só leitura, diário, setores intocados, exclusão em cascata). Navegador (Chromium, banco simulado):
  fluxo completo de desenho à mão livre (92 com mouse e 6 com toque real — um dedo desenha, dois dão zoom, a página não rola: desfazer traço, emendar no fim, traço longe recusado, mover mapa, limpar, cancelar, falha ao salvar sem perder o desenho e sem
  duplicar, recarregar, percorrida, editar traçado, ocultar, camadas, excluir; computador e celular),
  retomada do rascunho, encerrada só leitura, banco sem a 028, e o mapa do Paraná (30: posição logo abaixo
  dos cartões, marcadores, agrupamento, legenda, popup, sem coordenadas, atualização, erro do Supabase,
  abrir operação; computador e celular). **Não testado**: Supabase real com a 028 aplicada e celulares físicos.
- **Não testado**: o **openrouteservice real** (não há chave neste ambiente e a rede de testes não chega
  ao serviço; foi usado um simulador com o mesmo formato), o **Supabase Realtime real** e **celulares
  físicos** (GPS real em mata/cidade/carro, tela bloqueada, economia de bateria, cada navegador). Faça o
  roteiro acima antes do uso operacional, anotando a coluna "Chegou" do histórico.

---

## 10. Custos e cuidados operacionais

- **Supabase Free** e **Vercel Hobby** atendem testes e operações pequenas. Cada participante gera
  cerca de 1 ponto a cada 5–30 s (~100 bytes): 50 pessoas por 8 h somam cerca de 150 mil pontos (~30 MB).
- **Atenção**: projetos no plano gratuito do Supabase são **pausados após uma semana sem uso**. Para
  uso operacional, confira no painel do Supabase se o projeto está ativo antes de cada operação,
  ou considere o plano Pro, que não pausa.
- O plano Hobby do Vercel é para uso não comercial; para uso institucional, avalie o plano Pro.
- Os mapas usam servidores públicos com **políticas de uso justo**, sem chave de API:
  - **OpenStreetMap** (mapa padrão) — <https://operations.osmfoundation.org/policies/tiles/>;
  - **OpenTopoMap** (topográfico, CC-BY-SA) — uso leve, sem garantia de disponibilidade;
  - **Esri World Imagery** (satélite) — os termos da Esri pedem conta ArcGIS para uso em produção;
  - **Terrain Tiles / AWS Open Data** (relevo 3D e altitude) — gratuito, atribuição exigida (já exibida no 3D);
  - **Google Maps** (botão "Rota no app de mapas") — só abre o app/site do usuário; nenhuma chave é usada.
  - **openrouteservice** (rota por caminhos) — exige conta e token (gratuito com cota diária e por minuto,
    mostradas no painel da conta HeiGIT). Cada cálculo de rota conta 1 pedido (ao receber o destino, ao
    trocar o modo, ao sair da rota — no máximo 1 a cada 30 s por pessoa — e na ficha do painel, a cada
    5 min ou 100 m). Para operações grandes ou críticas, use um plano maior ou instale o openrouteservice
    num servidor próprio (`ORS_URL`).
  Para uso intenso ou institucional, contrate um provedor de mapas (ex.: MapTiler, Stadia, Esri) e troque
  as URLs em `public/js/militar.js` (`criarMapa` e `BASES_3D`) e na CSP do `vercel.json`. Nenhuma chave
  ou cadastro é necessário para o que foi implementado.
- Sem sinal de celular não há rastreamento ao vivo, e nenhuma tecnologia web contorna isso. Em áreas
  remotas, a fila offline completa a trilha quando o participante volta a ter sinal.

### Confirmações e ações definitivas

Toda ação que apaga um dado ou desativa algo pede confirmação em uma janela própria: tirar participante de grupo,
remover responsável da operação, excluir ficha, setor, ponto ou grupo, desativar acesso, apagar foto ou mensagem ainda
não enviada, remover arquivo importado, descartar ficha de vítima em rascunho, excluir relatório e excluir operação.
