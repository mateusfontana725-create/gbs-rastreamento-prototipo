# Rastreamento GBS — GPS para operações de busca e salvamento

Aplicativo web para o Corpo de Bombeiros Militar acompanhar, em tempo real, a posição e a trilha de
civis voluntários e militares durante operações de busca e salvamento, e enviar orientações direto
ao celular de cada participante.

- **`/militar.html`**: painel do bombeiro responsável (login obrigatório). Mapa, lista, trilhas, fichas,
  mensagens nos dois sentidos, relatos de campo, fotos georreferenciadas, equipe de responsáveis e a
  posição de cada responsável. Funciona no computador, no tablet e no celular.
- **`/civil.html#t=…`**: página do participante. Só abre com o link (ou QR Code) gerado pelo painel.
  O participante informa nome, CPF e celular, conversa com a equipe, relata pistas e envia fotos;
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
- A **ficha** do participante é enxuta: no topo, tipo e situação; logo abaixo "Posição há X s · ±Y m",
  **Ver no mapa**, **Trilha** e **📞 Ligar**; depois **Mensagens** e as fotos. CPF,
  coordenadas, GPS, histórico de posições e "Remover participante" ficam em **Mais detalhes**.
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

- **+ Nova operação** (no topo de "Minhas operações") abre o cadastro num modal: nome (obrigatório), **tipo** (Aquática, Terrestre, Aérea ou Outras — em "Outras" um
  campo "Qual?" com texto livre) e **data e hora do acionamento** (já vem com a hora atual; não pode estar
  no futuro) são obrigatórios. **Endereço**, **ponto no mapa** (📍 Escolher no mapa, Usar minha posição ou
  digitar a coordenada em qualquer formato) e **descrição** são opcionais e podem ser completados depois.
  O mapa para escolher o ponto abre por cima do formulário, sem perder o que já foi preenchido.
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
- **Ferramentas → Vítimas (fichas)**: uma ou mais fichas por operação, com **foto**, **nome** (ou "Não
  identificada"), **idade**, **características físicas**, **roupas** e **observações**.
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
- **Paleta dos grupos** (novos grupos): rosa, laranja, índigo, lima, branco e ocre, escolhidas para não
  se confundir com o vermelho dos militares e responsáveis, o verde dos civis, o amarelo de
  pedido de ajuda, o âmbar da seleção e as trilhas roxas e azuis. Grupos que já existiam mantêm a cor salva.
- **Legenda**: começa **recolhida** (um toque em **▤ Legenda** abre e fecha). Mostra só os tipos presentes
  na operação, o distintivo do responsável do grupo, a lista **Grupos ativos** (gerada dos grupos cadastrados,
  com a cor e a quantidade de integrantes) e os símbolos do mapa.
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
  aberto; sem `pg_cron`, o painel aberto faz essa verificação a cada 30 s.
- Ao finalizar a busca, todos recebem o destino **"Volte para a base"** no celular. **Prorrogar +15 min** e
  **Encerrar** ficam em **Ferramentas → Deslocamentos de grupos**, com a linha do tempo e a situação de
  cada membro. Uma missão nova do mesmo grupo substitui a anterior.

### Setores de busca (áreas)

- **Criar** (menu **Ferramentas → Setores de busca**):
  - **Novo setor por raio**: toque no centro do setor no mapa, informe o raio em metros (5 m a 50 km);
    o círculo aparece na hora e a área aproximada é calculada.
  - **Novo setor desenhando a área**: toque nos cantos da área (mínimo 3; há **Desfazer**) e em
    **Concluir**; o contorno é fechado e preenchido com cor semitransparente.
- Cada setor tem **nome/número/código**, **cor** (8 opções bem distintas entre si e das trilhas),
  **responsável** (um participante da operação) e/ou **equipe** (texto livre, ex.: "Equipe Alfa"),
  **situação** (**Pendente** — contorno tracejado, **Em andamento**, **Concluído** — preenchimento mais
  claro), observações, **área aproximada** (m², hectares ou km²), quem criou e quando, quem alterou e quando.
- **Editar**: tocar no setor (ou em **Lista de setores e pontos**) abre os detalhes: botões de situação,
  **Editar** (nome, cor, responsável, equipe, observações, raio), **Ajustar limites** (arrastar os cantos;
  ◇ cria um canto novo; tocar num canto remove; no círculo, arrastar o centro e mudar o raio),
  **Excluir** (com confirmação) e **Enviar o centro como destino**.
- Os setores ficam **abaixo** das trilhas e dos marcadores (não escondem participantes nem trilhas) e
  podem ser ocultados no painel **Camadas → Setores**.
- **Área delimitada × área percorrida**: criar um setor ou alguém passar perto dele **não** o marca como
  vasculhado. Os detalhes mostram, separado, **"Percorrido (estimativa pelos rastros GPS)"**: a parte do
  setor que ficou a até 25 m de algum rastro (rastros com precisão pior que 100 m não contam). É só uma
  estimativa; o setor só fica **Concluído** quando um responsável marca.
- O participante atribuído vê o contorno do **seu** setor no mapa do celular ("Seu setor: A-1").
- Ficam salvos no Supabase (tabela `setores`) e aparecem em tempo real para os outros responsáveis.

### Pontos de interesse

- **Ferramentas → Marcar ponto de interesse**: toque no local (ou **Usar minha posição**), escolha a
  categoria e dê um nome. Categorias e ícones (placa com letra):
  **U** Última localização conhecida · **?** Possível localização da vítima · **V** Vestígio ou objeto
  encontrado · **!** Área de risco/perigo · **E** Ponto de encontro · **+** Vítima encontrada · **•** Outro.
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

- **Remover** (ficha → Mais detalhes → Remover) **não apaga nada**: o cadastro, a trilha, as mensagens e as
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
| Guardado no aparelho | todo ponto aceito é gravado **primeiro no IndexedDB** (sem ele, localStorage) com id único (UUID do aparelho), latitude, longitude, precisão, hora do GPS, usuário, operação e o **indicador de envio**; vale também para a "Minha posição" do responsável. A fila antiga (localStorage) é migrada sozinha |
| Saltos | só é "salto" o que for incoerente com o movimento recente (> 12 m/s sem histórico, ou > 2,5 × a velocidade recente; nunca acima de 252 km/h). Um pico isolado é descartado; se a leitura seguinte confirmar o novo local (ex.: entrou num carro), **as duas entram** — nada de pontos intermediários perdidos |
| Precisão | até 150 m entra na trilha (com as regras acima); pior que 150 m vira "posição aproximada" (no máximo 1 a cada 30 s), fora da linha da trilha |
| Leituras ruins | antiga (> 30 s), repetida, fora de ordem ou inválida (0,0, NaN): descartada. Relógio do GPS diferente do celular: corrigido. Relógio do celular errado: o horário dos pontos é convertido para o do servidor antes do envio (o servidor recusaria pontos "do futuro") |
| Envio | separado da captura: envio em lote **~1,5 s** após o ponto a pé e **~1 s** em veículo (o 1º na hora); sem internet, tenta de novo com espera crescente e envia tudo na ordem quando volta. `enviar_posicoes_lote` devolve **quais ids o servidor gravou**: só esses são marcados como enviados (o resto continua pendente); os recusados (horário fora da operação) ficam marcados com o motivo e aparecem no diagnóstico. O id único torna o reenvio idempotente (não duplica) |
| Painel | recebe cada ponto pelo tempo real (com conferência periódica de reserva), insere na **ordem do horário do GPS** (empate: pelo id) e redesenha no quadro seguinte da tela. **Todos os pontos viram vértices** (nada é escondido). Quando dois pontos seguidos estão separados por mais que o **limite de falha** da operação (padrão **60 s**, configurável), ou há salto impossível, o trecho é desenhado **tracejado em cinza**, com **○ início** e **● fim** da falha marcados ("Falha: sem posições registradas de 10:02 a 10:21 — o percurso real é desconhecido"). Pontos de pessoas diferentes nunca se ligam |
| Medição | o histórico da ficha mostra, para cada ponto, **quanto tempo levou da captura até chegar ao servidor** (coluna "Chegou") |

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
- O menu **Ferramentas** é organizado em grupos recolhíveis (o aberto/fechado fica lembrado no aparelho):
  - **Operação**: Dados da operação, Diário, Relatório final (PDF), Equipe de responsáveis;
  - **Participantes e equipes**: Convidar participantes, Grupos, Deslocamentos de grupos, Enviar destino
    a participantes;
  - **Registros e ocorrências**: Vítimas (fichas), Registrar foto, Marcar ponto de interesse;
  - **Setores de busca**: Novo setor por raio, Novo setor desenhando a área, Lista de setores e pontos;
  - **Mapa e navegação**: Ir para coordenada, Medir distância e área, Exportar, Importar (o **⤢** do mapa
    enquadra todos);
  - **Configurações e manutenção**: Formato das coordenadas, **Tema** (Escuro ou Claro; o padrão é o escuro e a escolha fica no aparelho), Diagnóstico do GPS;
  - **Encerrar ou excluir · ações definitivas** — sempre **no fim**, separado por uma linha vermelha:
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
- **Celular deitado**: mapa e lista lado a lado; a faixa de alerta crítico ocupa uma linha só.
- No celular a **faixa de alerta crítico** é compacta (texto à esquerda, **Ver no mapa** e **Ciente** à
  direita) e as abas que não cabem quebram linha em vez de sair da tela.

### Ferramentas de mapa (inspiradas no AlpineQuest)

Recursos de aplicativos de navegação em campo, adaptados à operação. Ficam no menu **Ferramentas →
Ferramentas de mapa**, no **toque longo** (ou botão direito) sobre o mapa e na ficha do participante.

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
- **Exportar**: trilhas (de um participante ou de todos), pontos de interesse e setores em **GPX**
  (Garmin, AlpineQuest, OsmAnd, Locus), **KML** (Google Earth), **GeoJSON** (QGIS/ArcGIS) ou **CSV**
  (planilha, separador `;`). As trilhas saem com horário e precisão de cada ponto e as **lacunas** do sinal
  ficam como segmentos separados. Bom para relatórios e para levar a busca para outro aplicativo.
- **Importar**: **GPX, KML, KMZ, GeoJSON ou CSV** (até 8 MB) — por exemplo, trilhas conhecidas da região,
  limites de parque ou pontos levantados por outra equipe. O conteúdo aparece como **camada de referência**
  (verde-limão) apenas **neste aparelho** e fica lembrado nele. Cada item pode ser **transformado em ponto
  de interesse** ou **setor de busca** da operação (aí sim, visível a todos); "Transformar pontos" converte
  até 100 de uma vez. Nada é enviado ao servidor sem essa escolha.
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
- **Gerar PDF** monta, no navegador: capa com resultado e números, sumário, dados do cadastro e fichas das
  vítimas, pessoas e grupos (CPF e celular parcialmente ocultos), setores varridos (mapa geral, mapa de cada
  setor, início, fim, duração, área, deslocamentos e fotos tiradas dentro do setor), pontos e encontros,
  diário consolidado por dia e resultado com campos de assinatura. Cabeçalho e rodapé em todas as páginas
  ("DOCUMENTO RESTRITO", página X de Y).
- O PDF é baixado e **uma cópia fica guardada** no bucket privado `relatorios` (sem exclusão pelo app); a lista
  **Relatórios já gerados** permite baixar de novo.
- Ao **encerrar** a operação ou **apagar os dados**, se ainda não houver relatório, o painel oferece gerar antes
  (depois da retenção o relatório sai só com cadastro, diário e resultado).
- Biblioteca: **pdfmake 0.2.23** (`public/vendor/pdfmake/`, licença MIT), carregada só ao gerar. Os mapas são
  desenhados em canvas com o OpenStreetMap de fundo; sem acesso ao fundo, o mapa sai sem ele (com escala).

### Excluir uma operação

- Só operações **sem atividade registrada** (criadas por engano) podem ser excluídas. Com atividade no diário
  (pessoas, setores iniciados, deslocamentos, relatos, observações, resultado ou relatório), o banco recusa:
  o diário e os relatórios são o documento da operação, e os dados pessoais saem pela retenção.
- Disponível para **quem criou a operação** e para **administradores** (que alcançam **todas** as operações, inclusive para excluir): na lista de
  operações (botão **Excluir operação**) e em **Ferramentas → Excluir operação**. Os demais nem veem o
  botão, e o banco recusa a exclusão se alguém tentar por fora. Participantes nunca podem excluir.
- A janela de confirmação lista tudo o que será apagado e exige **digitar o nome da operação**.
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
│   ├── sw.js                   service worker mínimo (notificações no Android)
│   ├── versao.json             versão publicada (páginas abertas há muito tempo avisam que há versão nova)
│   ├── css/estilos.css         estilos (alto contraste, botões grandes, responsivo)
│   └── js/
│       ├── comunicacao.js      cliente Supabase, chamadas ao servidor, erros, relógio, formatação
│       ├── interface.js        avisos e caixas de confirmação
│       ├── fotos.js            fotos: leitura de EXIF, redução, prévia, envio ao Storage privado
│       ├── gps.js              filtro das leituras do GPS, montagem das trilhas, permissão e diagnóstico
│       ├── rotas.js            rota por caminhos: pede a /api/rota, desenha e acompanha o progresso
│       ├── coords.js           formatos de coordenadas (decimal, GMS, UTM, MGRS), rumo, nascer/pôr do sol
│       ├── arquivos.js         exportar e importar GPX, KML/KMZ, GeoJSON e CSV
│       ├── ferramentas.js      ferramentas de mapa do painel (medir, ir para coordenada, estatísticas…)
│       ├── trilha-local.js     fila offline dos pontos (IndexedDB) e envio com confirmação por ponto
│       ├── cadastro.js         cadastro da operação, escolha de ponto no mapa e fichas das vítimas
│       ├── relatorio.js        diário da operação, resultado, mapas em canvas e geração do relatório final
│       ├── relatorio-pdf.js    monta o documento do relatório final (pdfmake), sem rede nem tela
│       ├── militar.js          lógica do painel (inclui grupos, filtro do mapa, deslocamentos e alertas)
│       └── civil.js            lógica do participante (GPS, fila offline, mensagens, relatos, fotos)
│   └── vendor/pdfmake/         pdfmake 0.2.23 (MIT), carregado só ao gerar o relatório
├── api/
│   ├── config.js               entrega ao navegador só a URL e a chave PÚBLICA (de variáveis de ambiente)
│   ├── limpeza.js              limpeza diária dos dados vencidos (usa a chave SECRETA, só no servidor)
│   ├── responsaveis.js         cria login e redefine senha de responsáveis (só administradores; chave SECRETA)
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
   O `schema.sql` completo já inclui da 003 à 016 (seções 10 a 23).
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
   | `ORS_URL` | (opcional) endereço de um openrouteservice próprio; padrão `https://api.openrouteservice.org` |

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
2. **Link do participante**: é gerado **por operação**, em **Ferramentas → Convidar participantes**. Há duas abas:
   - **Link para CIVIS** — `https://rastreamento-sar.vercel.app/civil.html#t=<token de 64 caracteres>`
     Quem entra por ele sempre aparece como **civil**.
   - **Link para MILITARES** — outro token; permite escolher **militar** (ou civil). Compartilhe só com militares.

   Cada aba tem **Copiar**, **Compartilhar** (WhatsApp etc., no celular) e **QR Code** para leitura na base.

Os links de participante **não dão acesso ao painel**, deixam de funcionar quando a operação é
encerrada, e o token fica após o `#` (não é enviado aos servidores nem aparece em registros de acesso).

---

## 6. Uso em campo

**Cadastro de responsáveis (administrador)**: na tela de operações, botão **Responsáveis**. O cadastro abre num modal (como o de nova operação); clicar numa linha da lista abre os detalhes da pessoa.
- **+ Cadastrar responsável** (modal): nome/posto, e-mail (será o login) e senha provisória (o botão **Gerar** cria uma
  senha aleatória). O login é criado na hora, sem e-mail de confirmação. O painel mostra os dados de
  acesso para copiar e repassar ao colega. Marque **Também é administrador** se ele puder cadastrar outros.
- Cada linha tem um botão **⋮** que abre o menu com as funções (redefinir senha, tornar/tirar administrador, desativar/reativar acesso, renomear); clicar na linha abre os detalhes com as mesmas ações. **Redefinir senha** (quem esqueceu), **Desativar/Reativar acesso** (corta ou devolve o acesso na
  hora; o histórico das operações é mantido), **Tornar/Tirar administrador** e **Renomear**.
- Um administrador não consegue desativar nem tirar o próprio acesso de administrador (evita
  ficar sem nenhum administrador).
- **Minha conta** (todos os responsáveis): trocar a própria senha.


**Responsável**: login → **Nova operação** (nome/código e política de retenção) → **Convidar** →
acompanhar o mapa. Na lista: **◎** centraliza o participante, **Trilha** mostra/oculta a trilha dele.
O botão único **Ocultar trilhas / Mostrar trilhas** (o texto diz o que o toque faz) atua em todos. Toque no nome ou no marcador para abrir a
**ficha** (dados, precisão, conversa, fotos, histórico de posições, comandos e estado das mensagens). Os comandos
RETORNE, ATENÇÃO, MUDE A ROTA e PARE pedem confirmação antes do envio, e o texto pode ser complementado
(ex.: "Retorne ao PC 2"). No mapa, **⤢** enquadra todos e a legenda abre/fecha nela mesma; nomes,
camadas (Mapa, Topográfico, Satélite), fotos e relatos ficam em **Ferramentas** (seção 1); a lista
de participantes tem os próprios botões de ocultar/mostrar.

**Participante**: abre o link → digita nome, **CPF** e **celular** → **INICIAR RASTREAMENTO** → permite
a localização. CPF e celular são obrigatórios para civis e opcionais para militares (link de
militares); o CPF é conferido pelos dígitos verificadores. Deve manter a página aberta e a tela
ligada (a opção "Manter a tela ligada" já vem marcada). Para sair, toca em **Solicitar encerramento**.

**Na ficha do participante**, o CPF aparece mascarado (`***.456.789-**`, com o botão "mostrar") e
o celular tem link para **ligar** direto.

**Participante — mensagens e fotos**: na mesma página, **Comunicação com a equipe** (escrever ou
relatar pista/vestígio/objeto/obstáculo) e **Fotos** (**TIRAR FOTO** ou **Escolher da galeria**).

**Encerrar**: **Ferramentas → Encerrar operação** → os celulares param de enviar e mostram "Operação encerrada".
Os dados são apagados conforme a retenção escolhida:

| Retenção escolhida | O que acontece |
|---|---|
| Ao encerrar | participantes, posições, trilhas, mensagens e fotos são apagados **no mesmo instante** |
| 24 h / 3 / 7 / 30 dias | os dados ficam disponíveis para consulta e são apagados pela limpeza diária após o prazo |
| Qualquer uma | a opção **Apagar dados agora** (menu **⋮** da linha) apaga antecipadamente |
| Excluir operação | apaga tudo **e a própria operação** (some da lista), na hora — ver seção 1 |

Salvaguardas: operações esquecidas abertas por mais de 30 dias são encerradas automaticamente, e
identidades anônimas sem participação há mais de 7 dias são removidas. A limpeza roda todo dia às
07:00 UTC (04:00 de Brasília) pelo Vercel Cron, que chama `/api/limpeza` com o `CRON_SECRET`.

---

## 7. Segurança e privacidade

| Requisito | Como foi implementado |
|---|---|
| Consentimento explícito | o GPS só é solicitado depois do toque em INICIAR, com aviso claro sobre localização, CPF e celular; o encerramento é pedido ao responsável, que libera a saída |
| Dados pessoais (LGPD) | CPF e celular são vistos **só pelos responsáveis da operação**, validados no servidor, guardados só com dígitos, exibidos mascarados por padrão e **apagados junto com a operação** pela política de retenção. Recomenda-se registrar a finalidade (identificação e contato em operação de busca) no controle de tratamento de dados da corporação |
| Cadastro de responsáveis | só administradores ativos; a criação do login e a troca de senha passam pela função de servidor `/api/responsaveis`, que confere o administrador com o login dele e só então usa a chave secreta (que nunca vai ao navegador). Desativar um responsável corta o acesso a todas as operações na hora |
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
| Rota por caminhos | a chave do openrouteservice fica só na variável `ORS_API_KEY` da Vercel; `/api/rota` exige login (participante ativo, só para si; ou responsável ativo), limita a 20 cálculos/min por pessoa, valida coordenadas e distância e não grava nada |
| Fichas de vítimas | tabela `vitimas` e bucket privado `vitimas`: leitura, envio e visualização da foto **só pelos responsáveis da operação** (RLS no banco e regras no Storage); participantes não têm política de leitura; gravação só por `salvar_vitima`/`definir_foto_vitima` (confere que o arquivo existe na pasta da própria ficha); apagadas com a retenção ou a exclusão da operação |
| Cadastro da operação | só responsáveis da operação editam (`atualizar_operacao`); tipo, acionamento (não pode estar no futuro), coordenadas e tamanhos validados no servidor; `info_operacao` continua entregando ao participante só o nome |
| Grupos no mapa do civil | migração 015: `equipe_no_mapa` cruza só os grupos em comum com quem consulta; nenhum colega de outro grupo sai na resposta, e a resposta não tem CPF, telefone nem trilha |
| Grupos | RLS: responsáveis da operação leem grupos, membros e links; o participante lê **só os grupos de que é membro ativo** e a própria linha de membro (função `eh_membro_grupo`, security definer, sem recursão); os links ficam em `grupo_convites`, que só os responsáveis leem; o link do grupo nunca concede o papel de responsável; chaves compostas garantem que grupo e pessoa são da mesma operação |
| Deslocamentos e alertas | `missoes`, `missao_membros` e `alertas`: leitura só pelos responsáveis da operação; eventos calculados no servidor a partir das posições gravadas (o celular não informa "cheguei"); finalizar a busca: só o responsável da operação ou o responsável do grupo da missão; cada evento gera um alerta só (chave única); `verificar_retornos` sem operação só roda pelo agendador (`pg_cron`) |
| Fila offline | o celular só marca um ponto como enviado quando o servidor confirma o id; usuário e operação de cada ponto vêm sempre da sessão no servidor (os ids guardados no aparelho são só para diagnóstico) |
| Remover e reincluir | remover não apaga dados; reincluir só por responsável da operação ativa (`reincluir_participante`), reativando o mesmo registro; histórico em `participacao_eventos` (só responsáveis leem); participante não remove nem reinclui ninguém |
| Exclusão de operação | só o criador ou um administrador da equipe (`excluir_operacao`, verificado no banco); transação única; arquivos removidos do Storage com fila de pendências e limpeza diária; tokens invalidados na hora |
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
| 6 | Tocar em **Trilha** na lista; depois no botão **Ocultar trilhas** (vira **Mostrar trilhas**) e de novo | a trilha some/volta; o marcador continua andando e o histórico da ficha continua crescendo |
| 7 | Tocar no nome ou no marcador | abre a ficha com coordenadas, precisão, horários e histórico |
| 8 | Na ficha, enviar **PARE** | o operador confirma o envio; o painel mostra "Enviada" |
| 9 | No celular do civil | alerta em tela cheia com vibração; ao tocar **CONFIRMAR**, o painel mostra "Recebida pelo aparelho" e depois "Confirmada às …" |
| 10 | Pôr o celular do civil em modo avião por 1–2 min, andando | o civil vê "Sem internet · N posições guardadas"; o painel passa a "Sinal instável" e depois "Sem atualização", com o marcador desbotado |
| 11 | Desligar o modo avião | os pontos guardados chegam, a trilha é completada sem duplicar e o estado volta a "Conectado" |
| 12 | No celular do civil, abrir `/militar.html` | pede login; com a sessão do civil não há acesso ao painel nem às posições |
| 13 | Encerrar a operação | o celular mostra "Operação encerrada"; com retenção "Ao encerrar", os dados somem na hora; com prazo, somem após a limpeza diária |
| 14 | No celular do civil, tocar em **Solicitar encerramento** | o painel toca alarme e mostra "Pediu para sair"; o rastreamento continua; ao **Liberar saída**, o celular mostra "Saída liberada" |
| 15 | Adicionar um segundo responsável em **Equipe** e abrir a operação nos dois painéis (**Minha posição** liga sozinha) | cada um vê o outro no mapa (losango vermelho com R); mensagem de um para o outro chega como alerta |
| 16 | Abrir o painel no celular (em pé e deitado) e no tablet | mapa, lista e ficha ficam utilizáveis, sem rolagem lateral |
| 17 | No celular do civil, tocar **ENCONTREI ALGO → Possível pista**, escrever e enviar | o painel avisa com som, o botão **Mensagens** mostra 1, o marcador laranja aparece no mapa; ao abrir, o civil vê "Lida por …" |
| 18 | Responder pela ficha (**Conversa**) | o civil recebe o alerta em tela cheia e confirma |
| 19 | No civil, **TIRAR FOTO** → conferir → **SALVAR FOTO** | a câmera aparece no mapa no ponto; tocar abre a foto com autor, horários e coordenadas; **Ampliar** mostra em tela cheia |
| 20 | Repetir com o celular em modo avião | a foto fica "Na fila"; ao voltar a internet, é enviada sozinha |
| 21 | **Ferramentas**: trocar camada, ocultar nomes, ocultar a lista | cada opção funciona e o menu fecha; com a lista oculta, o mapa ocupa a tela e **« Participantes** reabre |
| 23 | **Ferramentas → Novo setor por raio**: tocar no centro, raio 300 m, atribuir a um civil; depois desenhar outro setor por cantos | os dois aparecem com nome e situação; o civil vê "Seu setor" no celular; recarregar a página não os perde |
| 24 | Marcar um **Ponto de encontro** e **Enviar como destino** ao civil; ele anda em direção ao ponto | o celular mostra distância e direção que diminuem/atualizam; testar com o GPS desligado (aviso "Sem GPS") |
| 25 | Trocar para **Topográfico** e abrir **Relevo em 3D** numa região com morros | curvas de nível visíveis com trilhas e setores por cima; o 3D mostra os morros e a altitude ao tocar |
| 22a | No celular do civil, olhar o mapa com um militar andando e o responsável com "Minha posição" ligada | aparecem o ponto azul (você), o **M** vermelho e o **R** vermelhoo; outros civis não aparecem |
| 22b | No civil, tocar **FALAR COM OS BOMBEIROS**, escrever e enviar; responder pelo painel (ficha → Mensagens) | a conversa abre só ao tocar; a resposta chega como "Bombeiros" e o botão mostra o número de novas |
| 22 | Criar uma operação de teste, registrar dados e **Excluir operação** (digitando o nome) | some da lista; o link/QR do participante para de funcionar; no Supabase, **Storage → fotos** não tem mais a pasta da operação |
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
| 41 | Pôr o celular do civil em modo avião por 3 min andando, recarregar a página ainda sem internet e depois religar | os pontos continuam guardados (diagnóstico `&diag=1`: "guardados em: indexeddb"); ao voltar a internet, chegam todos, na ordem, sem duplicar |

### Testes já realizados no desenvolvimento

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
